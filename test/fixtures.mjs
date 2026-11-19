/**
 * Synthetic DSH homes for the test suite.
 *
 * Every fixture is created under the OS temp directory and contains no real
 * session data: header and event lines are generated here.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSegment, projectKey } from '../lib/paths.mjs'
import { encodeFrame } from '../lib/zstd-frame.mjs'

/**
 * Build the JSON text of a session header.
 * @param fields - header fields to override.
 * @returns one header line, newline-terminated.
 */
export function headerLine(fields) {
  return `${JSON.stringify({
    type: 'session',
    version: 4,
    id: fields.id,
    createdAt: fields.createdAt ?? 1_700_000_000_000,
    cwd: fields.cwd,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  })}\n`
}

/**
 * Build `count` event lines.
 * @param count - number of events.
 * @param offset - first seq.
 * @returns concatenated JSONL.
 */
export function eventLines(count, offset = 0) {
  let out = ''
  for (let i = 0; i < count; i++) {
    out += `${JSON.stringify({
      type: 'user/message',
      seq: offset + i,
      time: 1_700_000_000_000 + i,
      data: { content: [{ type: 'text', text: `event ${offset + i}` }], source: { kind: 'user' } },
    })}\n`
  }
  return out
}

/**
 * Create an empty DSH home plus a project directory to point sessions at.
 * @returns fixture paths.
 */
export async function createHome() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-repair-'))
  const dshHome = join(root, 'dsh')
  const cwd = join(root, 'project')
  await mkdir(join(dshHome, 'sessions'), { recursive: true })
  await mkdir(join(dshHome, 'storages'), { recursive: true })
  await mkdir(cwd, { recursive: true })
  return {
    root,
    dshHome,
    cwd,
    sessionsRoot: join(dshHome, 'sessions'),
    workspaceFile: join(dshHome, 'storages', 'workspace.json'),
  }
}

/**
 * Write one session artifact.
 * @param home - fixture from {@link createHome}.
 * @param spec - session shape.
 * @returns `{dirPath, logPath, plaintext}`.
 */
export async function addSession(home, spec) {
  const cwd = spec.cwd ?? home.cwd
  const projectDir = spec.projectDir ?? projectKey(cwd)
  const sessionDirName = spec.sessionDirName ?? encodeSegment(spec.id)
  const dirPath = join(home.sessionsRoot, projectDir, sessionDirName)
  await mkdir(dirPath, { recursive: true })

  const header = headerLine({
    id: spec.id,
    cwd,
    createdAt: spec.createdAt ?? 1_700_000_000_000,
  })
  const body = eventLines(spec.events ?? 3)
  const plaintext = Buffer.from(header + body, 'utf8')

  let bytes
  switch (spec.frames ?? 'proper') {
    case 'single':
      bytes = await encodeFrame(plaintext)
      break
    case 'proper':
      bytes = Buffer.concat([await encodeFrame(Buffer.from(header, 'utf8')), await encodeFrame(Buffer.from(body, 'utf8'))])
      break
    case 'broken-boundary': {
      const split = Buffer.from(header + body, 'utf8')
      bytes = Buffer.concat([
        await encodeFrame(Buffer.from(header, 'utf8')),
        await encodeFrame(split.subarray(header.length, split.length - 5)),
      ])
      break
    }
    default:
      throw new Error(`unknown frame layout: ${spec.frames}`)
  }

  if (spec.tornTail === true) {
    const tail = await encodeFrame(Buffer.from(eventLines(1, 99), 'utf8'))
    bytes = Buffer.concat([bytes, tail.subarray(0, Math.floor(tail.length / 2))])
  }

  const logPath = join(dirPath, 'session.v4.jsonl.zstd')
  await writeFile(logPath, bytes)
  return { dirPath, logPath, plaintext }
}

/**
 * Write `storages/workspace.json`.
 * @param home - fixture from {@link createHome}.
 * @param spec - workspace records and global sets.
 */
export async function writeWorkspace(home, spec) {
  const state = {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: spec.workspaces.map(workspace => workspace.id),
      archivedSessionIds: spec.archived ?? [],
      pinnedSessionIds: spec.pinned ?? [],
    },
    tables: {
      workspaces: Object.fromEntries(spec.workspaces.map(workspace => [workspace.id, {
        path: workspace.path,
        title: workspace.title,
        sessionIds: workspace.sessionIds,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }])),
    },
  }
  await writeFile(home.workspaceFile, `${JSON.stringify(state, null, 2)}\n`)
  return state
}
