/**
 * The durable workspace account: `storages/workspace.json`.
 *
 * The sidebar renders a project's sessions from an ordered `sessionIds` array,
 * and every workspace mutation prunes entries whose session header does not
 * validate at that moment. A migration that makes sessions momentarily
 * unreadable therefore destroys the account permanently, even after the logs are
 * repaired. This module rebuilds the account from the headers that exist now.
 */

import { chmod, copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** Domain identity this tool expects in the file. */
export const WORKSPACE_DOMAIN = { name: 'workspace', version: 2 }

/** Raised when the domain file was rewritten between planning and applying. */
export class WorkspaceBusyError extends Error {
  /** @param file - the domain file that changed. */
  constructor(file) {
    super(`${file} changed while it was being repaired; is DeepSeek Harness running?`)
    this.name = 'WorkspaceBusyError'
  }
}

/**
 * Read and validate the workspace domain file.
 * @param file - absolute path to `storages/workspace.json`.
 * @returns the parsed state.
 * @throws when the file is missing or not a workspace domain.
 */
export async function loadWorkspaceState(file) {
  const text = await readFile(file, 'utf8')
  const state = JSON.parse(text)
  if (state === null || typeof state !== 'object') throw new Error(`${file}: not a JSON object`)
  const unit = state.unit
  if (unit === undefined || unit?.name !== WORKSPACE_DOMAIN.name) {
    throw new Error(`${file}: not a "${WORKSPACE_DOMAIN.name}" domain file`)
  }
  if (!Array.isArray(state.global?.workspaceIds)) throw new Error(`${file}: missing global.workspaceIds`)
  if (state.tables?.workspaces === undefined || typeof state.tables.workspaces !== 'object') {
    throw new Error(`${file}: missing tables.workspaces`)
  }
  return state
}

/**
 * Resolve a stored path to its canonical form, or undefined when it is unusable.
 * @param path - stored absolute path.
 * @returns canonical path, or undefined.
 */
async function canonical(path) {
  try {
    return await realpath(path)
  } catch {
    return undefined
  }
}

/**
 * Group scanned sessions by the canonical directory their header records.
 * @param sessions - scanned records.
 * @returns `{byCwd, missingCwd}`.
 */
async function groupSessions(sessions) {
  const byCwd = new Map()
  const missingCwd = []
  for (const session of sessions) {
    if (session.headerId === undefined) continue
    if (session.cwd === undefined) {
      missingCwd.push(session)
      continue
    }
    const key = (await canonical(session.cwd)) ?? session.cwd
    const group = byCwd.get(key)
    if (group === undefined) byCwd.set(key, [session])
    else group.push(session)
  }
  for (const group of byCwd.values()) {
    group.sort((a, b) => b.createdAt - a.createdAt || String(a.headerId).localeCompare(String(b.headerId)))
  }
  return { byCwd, missingCwd }
}

/**
 * Plan the account repair without writing anything.
 * @param state - parsed workspace domain.
 * @param sessions - scanned session records.
 * @param options - `{ unarchive }`.
 * @returns plan with per-workspace changes, archive removals and the next state.
 */
export async function planWorkspaceRepair(state, sessions, options) {
  const { byCwd } = await groupSessions(sessions)
  const workspaces = state.tables.workspaces
  const changes = []
  const skipped = []

  for (const workspaceId of state.global.workspaceIds) {
    const record = workspaces[workspaceId]
    if (record === undefined) continue
    const canonicalPath = await canonical(record.path)
    if (canonicalPath === undefined) {
      skipped.push({ workspaceId, path: record.path, reason: 'directory does not exist' })
      continue
    }
    const group = byCwd.get(canonicalPath) ?? []
    const before = Array.isArray(record.sessionIds) ? [...record.sessionIds] : []
    const known = new Set(group.map(session => session.headerId))
    const rebuilt = [...known]
    const after = rebuilt.concat(before.filter(id => !known.has(id)))
    const added = after.filter(id => !before.includes(id))
    if (after.length === before.length && after.every((id, index) => id === before[index])) continue
    changes.push({
      workspaceId,
      path: record.path,
      title: typeof record.title === 'string' ? record.title : basename(record.path),
      before,
      after,
      added,
      restored: group.filter(session => added.includes(session.headerId)),
    })
  }

  const archived = Array.isArray(state.global.archivedSessionIds) ? [...state.global.archivedSessionIds] : []
  const restoredIds = new Set(changes.flatMap(change => change.added))
  const unarchived = options.unarchive ? archived.filter(id => restoredIds.has(id)) : []

  const next = structuredClone(state)
  for (const change of changes) {
    const record = next.tables.workspaces[change.workspaceId]
    record.sessionIds = change.after
    if (typeof record.updatedAt === 'string') record.updatedAt = new Date().toISOString()
  }
  if (unarchived.length > 0) {
    const removed = new Set(unarchived)
    next.global.archivedSessionIds = archived.filter(id => !removed.has(id))
  }

  return { changes, skipped, unarchived, next, changed: changes.length > 0 || unarchived.length > 0 }
}

/**
 * Write the repaired domain durably, keeping a copy of the previous file.
 * @param file - absolute path to `storages/workspace.json`.
 * @param state - the next state.
 * @param options - `{ backupDir? }`.
 * @returns the backup path, when one was written.
 */
export async function writeWorkspaceState(file, state, options = {}) {
  const before = await stat(file)
  if (options.expectedMtimeMs !== undefined && before.mtimeMs !== options.expectedMtimeMs) {
    throw new WorkspaceBusyError(file)
  }
  let backupPath
  if (options.backupDir !== undefined) {
    const target = join(options.backupDir, 'storages')
    await mkdir(target, { recursive: true })
    backupPath = join(target, basename(file))
    await copyFile(file, backupPath)
  }
  const info = await stat(file)
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.repair-tmp`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`)
  await chmod(tmp, info.mode & 0o7777)
  await rename(tmp, file)
  return backupPath
}
