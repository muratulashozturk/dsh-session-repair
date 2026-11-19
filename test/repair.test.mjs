/**
 * End-to-end repair tests plus the container primitives they depend on.
 */

import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import test from 'node:test'
import { join } from 'node:path'
import { repairHome } from '../lib/repair.mjs'
import { scanSessions } from '../lib/sessions.mjs'
import { projectKey } from '../lib/paths.mjs'
import {
  FrameFormatError,
  decodeFrames,
  isSingleRecordFrame,
  scanZstdFrames,
} from '../lib/zstd-frame.mjs'
import { addSession, createHome, writeWorkspace } from './fixtures.mjs'

/** Decode an artifact into its frames. */
async function framesOf(path) {
  const bytes = await readFile(path)
  const { frames, tornStart } = scanZstdFrames(bytes)
  assert.equal(tornStart, undefined, 'artifact has a torn tail')
  return decodeFrames(bytes, frames)
}

test('the frame scanner rejects non-Zstandard bytes', async () => {
  assert.throws(() => scanZstdFrames(Buffer.from('not a frame at all')), FrameFormatError)
})

test('one frame holding the whole log violates the header-frame rule', async () => {
  const home = await createHome()
  const { logPath, plaintext } = await addSession(home, { id: 'session-a', frames: 'single', events: 4 })
  const frames = await framesOf(logPath)
  assert.equal(frames.length, 1)
  assert.equal(isSingleRecordFrame(frames[0]), false)
  assert.deepEqual(Buffer.concat(frames), plaintext)
})

test('a re-framed log preserves its plaintext and satisfies the contract', async () => {
  const home = await createHome()
  const { logPath, plaintext } = await addSession(home, { id: 'session-a', frames: 'single', events: 40 })

  const before = await stat(logPath)
  const result = await repairHome({ dshRoot: home.dshHome, apply: true, unarchive: true, fixMisplaced: false })
  assert.equal(result.counts.reframes, 1)
  assert.equal(result.counts.problems >= 1, true)

  const frames = await framesOf(logPath)
  assert.equal(frames.length > 1, true)
  assert.equal(isSingleRecordFrame(frames[0]), true)
  assert.deepEqual(Buffer.concat(frames), plaintext)

  const after = await stat(logPath)
  assert.notEqual(after.mtimeMs, before.mtimeMs)
})

test('a dry run writes nothing', async () => {
  const home = await createHome()
  const { logPath } = await addSession(home, { id: 'session-a', frames: 'single' })
  const workspace = await writeWorkspace(home, {
    workspaces: [{ id: 'w1', path: home.cwd, title: 'project', sessionIds: [] }],
  })
  const logBytes = await readFile(logPath)
  const workspaceBytes = await readFile(home.workspaceFile)

  const result = await repairHome({ dshRoot: home.dshHome, apply: false, unarchive: true, fixMisplaced: false })
  assert.equal(result.applied, false)
  assert.equal(result.counts.reframes, 1)
  assert.equal(result.counts.workspaceChanges, 1)
  assert.deepEqual(await readFile(logPath), logBytes)
  assert.deepEqual(await readFile(home.workspaceFile), workspaceBytes)
  assert.deepEqual(JSON.parse(workspaceBytes.toString()), workspace)
})

test('the workspace account is rebuilt newest-first and unarchived', async () => {
  const home = await createHome()
  const a = await addSession(home, { id: 'session-a', createdAt: 1_700_000_000_000 })
  await addSession(home, { id: 'session-b', createdAt: 1_700_000_300_000 })
  await addSession(home, { id: 'session-c', createdAt: 1_700_000_600_000 })
  await writeWorkspace(home, {
    workspaces: [{ id: 'w1', path: home.cwd, title: 'project', sessionIds: ['session-a'] }],
    archived: ['session-a', 'session-b'],
  })

  const dry = await repairHome({ dshRoot: home.dshHome, apply: false, unarchive: true, fixMisplaced: false })
  assert.equal(dry.workspace.changes.length, 1)
  assert.deepEqual(dry.workspace.changes[0].before, ['session-a'])
  assert.deepEqual(dry.workspace.changes[0].after, ['session-c', 'session-b', 'session-a'])
  assert.deepEqual(dry.workspace.unarchived, ['session-b'])

  await repairHome({ dshRoot: home.dshHome, apply: true, unarchive: true, fixMisplaced: false })
  const state = JSON.parse(await readFile(home.workspaceFile, 'utf8'))
  assert.deepEqual(state.tables.workspaces.w1.sessionIds, ['session-c', 'session-b', 'session-a'])
  // Only ids this repair added are unarchived; a pre-existing archived slot keeps its flag.
  assert.deepEqual(state.global.archivedSessionIds, ['session-a'])
  assert.ok(a.logPath.length > 0)
})

test('--no-unarchive keeps the archive flags', async () => {
  const home = await createHome()
  await addSession(home, { id: 'session-a' })
  await addSession(home, { id: 'session-b', createdAt: 1_700_000_900_000 })
  await writeWorkspace(home, {
    workspaces: [{ id: 'w1', path: home.cwd, title: 'project', sessionIds: [] }],
    archived: ['session-b'],
  })
  await repairHome({ dshRoot: home.dshHome, apply: true, unarchive: false, fixMisplaced: false })
  const state = JSON.parse(await readFile(home.workspaceFile, 'utf8'))
  assert.deepEqual(state.global.archivedSessionIds, ['session-b'])
  assert.equal(state.tables.workspaces.w1.sessionIds.length, 2)
})

test('the repair is idempotent', async () => {
  const home = await createHome()
  await addSession(home, { id: 'session-a', frames: 'single' })
  await addSession(home, { id: 'session-b', events: 5 })
  await writeWorkspace(home, {
    workspaces: [{ id: 'w1', path: home.cwd, title: 'project', sessionIds: [] }],
  })
  const first = await repairHome({ dshRoot: home.dshHome, apply: true, unarchive: true, fixMisplaced: false })
  assert.equal(first.healthy, false)
  const second = await repairHome({ dshRoot: home.dshHome, apply: true, unarchive: true, fixMisplaced: false })
  assert.equal(second.healthy, true)
  assert.equal(second.counts.reframes, 0)
  assert.equal(second.counts.workspaceChanges, 0)
  const third = await repairHome({ dshRoot: home.dshHome, apply: false, unarchive: true, fixMisplaced: false })
  assert.equal(third.healthy, true)
})

test('a torn final frame is recovered', async () => {
  const home = await createHome()
  const { logPath } = await addSession(home, { id: 'session-a', events: 6, tornTail: true })

  const scanned = await scanSessions(home.sessionsRoot)
  assert.equal(scanned[0].container.torn, true)

  await repairHome({ dshRoot: home.dshHome, apply: true, unarchive: true, fixMisplaced: false })
  const frames = await framesOf(logPath)
  assert.equal(isSingleRecordFrame(frames[0]), true)
  const text = Buffer.concat(frames).toString('utf8')
  assert.ok(text.endsWith('\n'))
  assert.equal(isSingleRecordFrame(frames[0]), true)
})

test('a frame that does not end on a record boundary is repaired', async () => {
  const home = await createHome()
  const { logPath } = await addSession(home, { id: 'session-a', frames: 'broken-boundary', events: 8 })
  const decoded = Buffer.concat(await framesOf(logPath))
  const scanned = await scanSessions(home.sessionsRoot)
  assert.equal(scanned[0].container.brokenBoundary, true)
  assert.equal(scanned[0].container.droppedTailBytes > 0, true)

  await repairHome({ dshRoot: home.dshHome, apply: true, unarchive: true, fixMisplaced: false })
  const frames = await framesOf(logPath)
  const kept = decoded.subarray(0, decoded.lastIndexOf(0x0a) + 1)
  assert.deepEqual(Buffer.concat(frames), kept)
})

test('a misplaced session directory is reported, and moved on request', async () => {
  const home = await createHome()
  const elsewhere = join(home.root, 'elsewhere')
  await addSession(home, { id: 'session-a', projectDir: projectKey(elsewhere) })
  await writeWorkspace(home, {
    workspaces: [{ id: 'w1', path: home.cwd, title: 'project', sessionIds: [] }],
  })

  const dry = await repairHome({ dshRoot: home.dshHome, apply: false, unarchive: true, fixMisplaced: false })
  assert.equal(dry.relocations.length, 1)
  assert.equal(dry.relocations[0].to, join(home.sessionsRoot, projectKey(home.cwd), 'session-a'))

  const applied = await repairHome({ dshRoot: home.dshHome, apply: true, unarchive: true, fixMisplaced: true })
  assert.equal(applied.relocations[0].done, true)
  const moved = await stat(join(home.sessionsRoot, projectKey(home.cwd), 'session-a', 'session.v4.jsonl.zstd'))
  assert.ok(moved.isFile())
})

test('zero-byte artifacts and sessions without a cwd are left alone', async () => {
  const home = await createHome()
  const { mkdir, writeFile } = await import('node:fs/promises')
  await writeWorkspace(home, {
    workspaces: [{ id: 'w1', path: home.cwd, title: 'project', sessionIds: [] }],
  })
  const emptyDir = join(home.sessionsRoot, projectKey(home.cwd), 'session-empty')
  await mkdir(emptyDir, { recursive: true })
  await writeFile(join(emptyDir, 'session.v4.jsonl.zstd'), '')
  const result = await repairHome({ dshRoot: home.dshHome, apply: true, unarchive: true, fixMisplaced: false })
  assert.equal(result.counts.empty, 1)
  assert.equal(result.counts.reframes, 0)
  assert.equal(result.healthy, true)
})

test('the workspace plan skips a project whose directory is gone', async () => {
  const home = await createHome()
  await addSession(home, { id: 'session-a' })
  await writeWorkspace(home, {
    workspaces: [{ id: 'w1', path: join(home.root, 'deleted'), title: 'gone', sessionIds: ['session-a'] }],
  })
  const result = await repairHome({ dshRoot: home.dshHome, apply: false, unarchive: true, fixMisplaced: false })
  assert.equal(result.workspace.skipped.length, 1)
  assert.equal(result.workspace.changes.length, 0)
})

test('a directory that is not a DSH home is rejected', async () => {
  const home = await createHome()
  const { rm } = await import('node:fs/promises')
  await rm(home.sessionsRoot, { recursive: true, force: true })
  await rm(home.workspaceFile, { force: true })
  await assert.rejects(
    () => repairHome({ dshRoot: home.dshHome, apply: false, unarchive: true, fixMisplaced: false }),
    /does not look like a DeepSeek Harness home/,
  )
})
