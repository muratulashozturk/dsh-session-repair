/**
 * Host facts the repair needs: where the DSH home is, and whether a DSH process
 * is currently holding that home in memory.
 *
 * The running-process check is best effort. It exists because `workspace.json`
 * is rewritten from memory on every workspace mutation, so a repair written
 * underneath a live host is silently undone later.
 */

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * A DSH host runs either the Electron binary by path (`/.../deepseek-harness`)
 * or the desktop host entry point (`/dsh-desktop-host/lib/...`). Matching the
 * path form, not the bare word, keeps `grep deepseek-harness`, editors, shells
 * and this tool itself from being mistaken for a running host.
 */
export const HOST_EXECUTABLE = /\/deepseek-harness(?=\s|$)|\/dsh-desktop-host\//

/** Processes that mention this tool (or the probe itself) and must never match. */
const NOT_A_HOST = /dsh-session-repair|DSH_SESSION_REPAIR|\bpgrep\b|\bps -A\b/

/**
 * Resolve the DSH home directory.
 * @param explicit - `--dsh-root` value, when given.
 * @returns absolute DSH home path.
 */
export function resolveDshHome(explicit) {
  const fromEnv = process.env.DSH_HOME
  const candidates = [explicit, fromEnv].filter(value => typeof value === 'string' && value.trim() !== '')
  return resolve(candidates[0] ?? `${homedir()}/.dsh`)
}

/**
 * Best-effort list of running DSH hosts.
 * @returns one `pid command` line per match; empty when none are found.
 */
export async function detectRunningDsh() {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 5000 })
      return stdout
        .split(/\r?\n/)
        .filter(line => /deepseek-harness|DeepSeek Harness|dsh/i.test(line))
    } catch {
      return []
    }
  }

  // `ps` is the portable source (Linux and macOS); every line carries a pid so
  // the caller can show what matched.
  const self = new Set([String(process.pid), String(process.ppid)])
  try {
    const { stdout } = await execFileAsync('ps', ['-A', '-ww', '-o', 'pid=,command='], { timeout: 5000 })
    return classifyHostLines(stdout.split('\n'), self)
  } catch {
    return []
  }
}

/**
 * Keep the `ps` lines that really name a running DSH host.
 * @param lines - `pid command` lines from `ps`.
 * @param selfPids - pids that belong to this process tree.
 * @returns matching lines, first per pid.
 */
export function classifyHostLines(lines, selfPids = new Set()) {
  const found = []
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue
    const pid = line.split(/\s+/, 1)[0]
    if (selfPids.has(pid)) continue
    if (!/^\d+$/.test(pid)) continue
    if (NOT_A_HOST.test(line)) continue
    if (!HOST_EXECUTABLE.test(line)) continue
    found.push(line)
  }
  return dedupeByPid(found)
}

/**
 * Keep the first line per pid.
 * @param lines - `pid command` lines.
 * @returns deduplicated lines.
 */
function dedupeByPid(lines) {
  const seen = new Set()
  const out = []
  for (const line of lines) {
    const pid = line.split(/\s+/, 1)[0]
    if (seen.has(pid)) continue
    seen.add(pid)
    out.push(line)
  }
  return out
}

/**
 * A filesystem-safe local timestamp for backup directories.
 * @returns `YYYYMMDD-HHMMSS`.
 */
export function timestamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}
