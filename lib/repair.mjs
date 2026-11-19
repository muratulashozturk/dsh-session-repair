/**
 * Repair orchestration: inspect a DSH home, plan the fix, apply it, verify it.
 *
 * The three faults a Windows-to-Linux (or any recompressed) migration leaves
 * behind are independent, and fixing only some of them leaves sessions
 * invisible:
 *
 *   container   the log's first Zstandard frame is not exactly the header line,
 *               so `sessionPersistence.list()` silently drops the session;
 *   placement   the session directory is not under `projectKey(header.cwd)`, so
 *               `assertStoredIdentity` throws and the whole listing fails;
 *   account     `storages/workspace.json` no longer lists the session, so the
 *               project has no row for it even once the log is readable.
 */

import { stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  WorkspaceBusyError,
  loadWorkspaceState,
  planWorkspaceRepair,
  writeWorkspaceState,
} from './workspace.mjs'
import { SessionBusyError, needsReframe, reframeArtifact, relocateSession, scanSessions } from './sessions.mjs'
import { timestamp } from './platform.mjs'

/** Raised when the selected directory is not a DSH home at all. */
export class NotDshHomeError extends Error {
  /** @param dshRoot - the directory that was probed. */
  constructor(dshRoot) {
    super(`${dshRoot} does not look like a DeepSeek Harness home (no sessions/ and no storages/workspace.json)`)
    this.name = 'NotDshHomeError'
  }
}

/** Backup and scratch directory names created inside the DSH home. */
export const BACKUP_PREFIX = '.dsh-session-repair-backup-'
export const TMP_DIR = '.dsh-session-repair-tmp'

/**
 * Inspect and optionally repair one DSH home.
 * @param options - `{ dshRoot, apply, unarchive, fixMisplaced }`.
 * @returns the full result used by the CLI and by tests.
 */
export async function repairHome(options) {
  const dshRoot = options.dshRoot
  const sessionsRoot = join(dshRoot, 'sessions')
  const workspaceFile = join(dshRoot, 'storages', 'workspace.json')
  const backupDir = options.apply ? join(dshRoot, `${BACKUP_PREFIX}${timestamp()}`) : undefined
  const tmpDir = join(dshRoot, TMP_DIR)

  if (!existsSync(sessionsRoot) && !existsSync(workspaceFile)) throw new NotDshHomeError(dshRoot)

  const sessions = await scanSessions(sessionsRoot)
  const reframes = []
  const relocations = []

  for (const record of sessions) {
    if (!needsReframe(record)) continue
    const item = {
      record,
      headerId: record.headerId,
      title: record.header?.title,
      framesBefore: record.container.frames,
      headerFrameLines: record.container.headerFrameLines,
      torn: record.container.torn,
    }
    // Also runs (and verifies) the rebuild on a dry run, so the planned frame
    // count is real and a failure surfaces before anything is written.
    try {
      item.framesAfter = await reframeArtifact(record, { apply: options.apply, backupDir, tmpDir })
      item.written = options.apply
    } catch (error) {
      if (!(error instanceof SessionBusyError)) throw error
      item.busy = error.message
    }
    record.plaintext = undefined
    reframes.push(item)
  }

  for (const record of sessions) {
    if (record.container.unreadable !== undefined) continue
    if (record.expectedProjectDir === undefined || record.expectedProjectDir === record.projectDir) continue
    const relocation = {
      record,
      headerId: record.headerId,
      from: record.dirPath,
      to: join(sessionsRoot, record.expectedProjectDir, record.sessionDirName),
    }
    if (options.apply && options.fixMisplaced) {
      relocation.to = await relocateSession(record, { apply: true })
      relocation.done = true
    }
    relocations.push(relocation)
  }

  let workspace = { changes: [], skipped: [], unarchived: [], changed: false }
  let workspaceMtimeMs
  try {
    workspaceMtimeMs = (await stat(workspaceFile)).mtimeMs
    const state = await loadWorkspaceState(workspaceFile)
    workspace = await planWorkspaceRepair(state, sessions, { unarchive: options.unarchive })
  } catch (error) {
    workspace = { changes: [], skipped: [], unarchived: [], changed: false, error: error.message }
  }

  if (options.apply && workspace.changed) {
    try {
      workspace.backupPath = await writeWorkspaceState(workspaceFile, workspace.next, {
        backupDir,
        expectedMtimeMs: workspaceMtimeMs,
      })
      workspace.written = true
    } catch (error) {
      if (!(error instanceof WorkspaceBusyError)) throw error
      workspace.busy = error.message
    }
  }

  return summarize({
    dshRoot,
    sessionsRoot,
    workspaceFile,
    apply: options.apply,
    fixMisplaced: options.fixMisplaced,
    backupDir,
    sessions,
    reframes,
    relocations,
    workspace,
  })
}

/**
 * Fold raw scan/plan data into the public result shape.
 * @param input - intermediate values.
 * @returns the result consumed by the CLI.
 */
function summarize(input) {
  const { sessions, reframes, relocations, workspace } = input
  const unreadable = sessions.filter(record => record.container.unreadable !== undefined)
  const empty = sessions.filter(record => record.empty)
  const noCwd = sessions.filter(record => record.cwd === undefined && !record.empty)
  const applied = input.apply

  const problems =
    unreadable.length
    + reframes.length
    + relocations.length
    + workspace.changes.length
    + (workspace.error === undefined ? 0 : 1)
    + (workspace.busy === undefined ? 0 : 1)
  const busy = reframes.filter(item => item.busy !== undefined).length + (workspace.busy === undefined ? 0 : 1)

  const counts = {
    stored: sessions.length,
    empty: empty.length,
    unreadable: unreadable.length,
    reframes: reframes.length,
    relocations: relocations.length,
    noCwd: noCwd.length,
    workspaceChanges: workspace.changes.length,
    unarchived: workspace.unarchived.length,
    busy,
    problems,
  }

  return {
    ...input,
    counts,
    /** Healthy only when nothing needed changing and nothing was busy. */
    healthy: problems === 0 && busy === 0,
    applied,
  }
}
