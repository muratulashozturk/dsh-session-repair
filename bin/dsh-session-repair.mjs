#!/usr/bin/env node
/**
 * dsh-session-repair — restore DeepSeek Harness sessions that vanished from the
 * sidebar after a home-directory migration.
 *
 * Default is a read-only dry run. `--apply` writes; it refuses while a DSH host
 * is running unless `--force` is given.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NotDshHomeError, repairHome } from '../lib/repair.mjs'
import { detectRunningDsh, resolveDshHome } from '../lib/platform.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE = JSON.parse(await readFile(join(HERE, '..', 'package.json'), 'utf8'))

const USAGE = `dsh-session-repair ${PACKAGE.version}

Restore DeepSeek Harness sessions that stopped appearing after a migration
that recompressed ~/.dsh session logs or rearranged the cwd of a project.

Usage
  dsh-session-repair [options]

Options
  --dsh-root <dir>    DSH home to repair (default: $DSH_HOME or ~/.dsh)
  --apply             write the repair (default: dry run)
  --verify            report health only; exit 1 when anything needs repair
  --json              machine-readable result
  --force             proceed even when a DSH host appears to be running
  --no-unarchive      keep archive flags on restored sessions
  --fix-misplaced     also move session directories under the project their
                      header cwd demands
  -h, --help          show this help
  --version           print the version

Exit codes
  0  healthy, or the repair was written
  1  --verify found work to do
  2  usage error
  3  refused: a DSH host is running
  4  the repair failed

Notes
  Quit DeepSeek Harness before --apply. The workspace account is rewritten from
  memory on every workspace mutation, so a repair written under a running host
  is lost at the next change.
`

/** Raised for a usage error. */
class UsageError extends Error {}

/**
 * Parse process arguments.
 * @param argv - `process.argv.slice(2)`.
 * @returns parsed options.
 */
function parseArgs(argv) {
  const options = {
    dshRoot: undefined,
    apply: false,
    verify: false,
    json: false,
    force: false,
    unarchive: true,
    fixMisplaced: false,
    help: false,
    version: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--dsh-root': {
        const value = argv[++i]
        if (value === undefined) throw new UsageError('--dsh-root needs a directory')
        options.dshRoot = value
        break
      }
      case '--apply': options.apply = true; break
      case '--verify': options.verify = true; break
      case '--json': options.json = true; break
      case '--force': options.force = true; break
      case '--no-unarchive': options.unarchive = false; break
      case '--fix-misplaced': options.fixMisplaced = true; break
      case '-h':
      case '--help': options.help = true; break
      case '--version': options.version = true; break
      default: throw new UsageError(`unknown argument: ${arg}`)
    }
  }
  if (options.apply && options.verify) throw new UsageError('--apply and --verify are mutually exclusive')
  return options
}

/**
 * Short, monospace-friendly label for a session.
 * @param record - scanned session record.
 * @returns label text.
 */
function label(record) {
  const id = record.headerId ?? record.sessionDirName
  return id.length > 30 ? `${id.slice(0, 29)}…` : id
}

/**
 * Human-readable report.
 * @param result - result from repairHome.
 * @returns report text.
 */
function formatReport(result) {
  const lines = []
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`
  lines.push(`DSH home   ${result.dshRoot}`)
  lines.push(`sessions   ${result.sessionsRoot}`)
  lines.push('')

  const { counts } = result
  const detail = []
  if (counts.empty > 0) detail.push(`${counts.empty} empty`)
  if (counts.unreadable > 0) detail.push(`${counts.unreadable} unreadable`)
  if (counts.noCwd > 0) detail.push(`${counts.noCwd} without cwd`)
  lines.push(`Stored sessions: ${counts.stored}${detail.length > 0 ? ` (${detail.join(', ')})` : ''}`)
  lines.push('')

  lines.push('Container (Zstandard frame layout)')
  if (result.reframes.length === 0) {
    lines.push('  nothing to repair')
  } else {
    for (const item of result.reframes) {
      const torn = item.torn ? ', torn tail recovered' : ''
      lines.push(
        `  reframe  ${label(item.record).padEnd(30)} `
        + `${plural(item.framesBefore, 'frame')}, header frame holds ${plural(item.headerFrameLines, 'line')}`
        + ` -> ${item.framesAfter ?? '?'} frames${torn}`,
      )
      const title = typeof item.record.header?.title === 'string' ? item.record.header.title : undefined
      if (title !== undefined && title !== '') lines.push(`           ${JSON.stringify(title)}`)
    }
  }
  lines.push('')

  lines.push('Directory placement')
  if (result.relocations.length === 0) {
    lines.push('  nothing to repair')
  } else {
    for (const item of result.relocations) {
      lines.push(`  relocate ${label(item.record)}`)
      lines.push(`           ${item.from}`)
      lines.push(`        -> ${item.to}`)
      if (item.done !== true) lines.push('           (re-run with --fix-misplaced to move it)')
    }
  }
  lines.push('')

  lines.push(`Workspace account (${result.workspaceFile})`)
  if (result.workspace.error !== undefined) {
    lines.push(`  cannot read: ${result.workspace.error}`)
  } else if (result.workspace.changes.length === 0 && result.workspace.unarchived.length === 0) {
    lines.push('  nothing to repair')
  } else {
    for (const change of result.workspace.changes) {
      lines.push(`  ${change.title}: ${change.before.length} -> ${change.after.length} session ids`)
      for (const session of change.restored) {
        const title = typeof session.header?.title === 'string' ? session.header.title : ''
        lines.push(`    + ${label(session)}${title === '' ? '' : `  ${JSON.stringify(title)}`}`)
      }
    }
    if (result.workspace.unarchived.length > 0) {
      const count = result.workspace.unarchived.length
      lines.push(`  unarchive: ${count} ${count === 1 ? 'session leaves' : 'sessions leave'} the archive set`)
    }
  }
  for (const skip of result.workspace.skipped) {
    lines.push(`  skipped ${skip.path}: ${skip.reason}`)
  }
  lines.push('')

  const busy = result.reframes.filter(item => item.busy !== undefined)
  if (busy.length > 0 || result.workspace.busy !== undefined) {
    lines.push('Changed while scanning')
    for (const item of busy) lines.push(`  ${label(item.record)}  ${item.busy}`)
    if (result.workspace.busy !== undefined) lines.push(`  workspace account  ${result.workspace.busy}`)
    lines.push('')
  }

  lines.push('Unreadable')
  const unreadable = result.sessions.filter(record => record.container.unreadable !== undefined)
  if (unreadable.length === 0) {
    lines.push('  none')
  } else {
    for (const record of unreadable) {
      lines.push(`  ${label(record)}  ${record.container.unreadable}`)
    }
  }
  lines.push('')

  if (result.applied) {
    if (result.backupDir !== undefined) lines.push(`backup   ${result.backupDir}`)
    const wrote = []
    if (result.reframes.length > 0) wrote.push(plural(result.reframes.length, 'session log'))
    if (result.relocations.some(item => item.done === true)) {
      wrote.push(plural(result.relocations.filter(item => item.done === true).length, 'session directory'))
    }
    if (result.workspace.changed) wrote.push('storages/workspace.json')
    lines.push(`wrote    ${wrote.length === 0 ? 'nothing (already healthy)' : wrote.join(', ')}`)
    if (wrote.length > 0) {
      lines.push('')
      lines.push('Start DeepSeek Harness again; the sidebar rebuilds from what is on disk.')
    }
  } else if (result.healthy) {
    lines.push('Healthy: nothing needs repair.')
  } else {
    const count = result.counts.problems
    lines.push(`dry run: ${count} ${count === 1 ? 'item needs' : 'items need'} repair. Re-run with --apply to write.`)
  }
  if (result.counts.busy > 0) {
    lines.push('')
    lines.push('Some artifacts changed while they were read. Quit DeepSeek Harness and run again.')
  }
  return lines.join('\n')
}

/**
 * Run the CLI.
 * @param argv - arguments.
 * @returns process exit code.
 */
async function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`error: ${error.message}\n\n${USAGE}`)
      return 2
    }
    throw error
  }

  if (options.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${PACKAGE.version}\n`)
    return 0
  }

  const dshRoot = resolveDshHome(options.dshRoot)
  if (options.apply && !options.force) {
    const running = await detectRunningDsh()
    if (running.length > 0) {
      process.stderr.write('error: DeepSeek Harness appears to be running:\n')
      for (const line of running) process.stderr.write(`  ${line}\n`)
      process.stderr.write('quit it, then run this again (or pass --force to repair anyway)\n')
      return 3
    }
  }

  let result
  try {
    result = await repairHome({
    dshRoot,
      apply: options.apply,
      unarchive: options.unarchive,
      fixMisplaced: options.fixMisplaced,
    })
  } catch (error) {
    if (error instanceof NotDshHomeError) {
      process.stderr.write(`error: ${error.message}\n`)
      process.stderr.write('pass --dsh-root with the directory that contains sessions/ and storages/\n')
      return 2
    }
    throw error
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(toJson(result), null, 2)}\n`)
  } else {
    process.stdout.write(`${formatReport(result)}\n`)
  }

  if (options.verify) return result.healthy ? 0 : 1
  return 0
}

/**
 * Strip buffers from a result so it serialises.
 * @param result - repair result.
 * @returns JSON-safe projection.
 */
function toJson(result) {
  return {
    dshRoot: result.dshRoot,
    sessionsRoot: result.sessionsRoot,
    workspaceFile: result.workspaceFile,
    applied: result.applied,
    healthy: result.healthy,
    counts: result.counts,
    backupDir: result.backupDir,
    reframes: result.reframes.map(item => ({
      sessionId: item.record.headerId,
      title: item.record.header?.title,
      framesBefore: item.framesBefore,
      framesAfter: item.framesAfter,
      headerFrameLines: item.headerFrameLines,
      torn: item.torn,
      logPath: item.record.logPath,
    })),
    relocations: result.relocations.map(item => ({
      sessionId: item.record.headerId,
      from: item.from,
      to: item.to,
      done: item.done === true,
    })),
    workspace: {
      changes: result.workspace.changes.map(change => ({
        workspaceId: change.workspaceId,
        title: change.title,
        path: change.path,
        before: change.before.length,
        after: change.after.length,
        added: change.added,
      })),
      unarchived: result.workspace.unarchived,
      skipped: result.workspace.skipped,
      error: result.workspace.error,
    },
    unreadable: result.sessions
      .filter(record => record.container.unreadable !== undefined)
      .map(record => ({ sessionId: record.headerId, path: record.logPath, reason: record.container.unreadable })),
  }
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`error: ${message}\n`)
    if (process.env.DSH_SESSION_REPAIR_DEBUG === '1' && error instanceof Error) {
      process.stderr.write(`${error.stack ?? ''}\n`)
    } else {
      process.stderr.write('set DSH_SESSION_REPAIR_DEBUG=1 for a stack trace\n')
    }
    process.exitCode = 4
  })
