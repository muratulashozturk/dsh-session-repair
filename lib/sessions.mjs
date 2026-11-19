/**
 * Session-log scanning and re-framing.
 *
 * Scanning is read-only. It reports, per stored session, whether the artifact
 * satisfies DSH's container contract (`[header frame][event frames...]`) and
 * whether its directory still matches the identity recorded in its own header.
 *
 * Re-framing rewrites one artifact, preserving its plaintext byte for byte, and
 * verifies the result before publishing it.
 */

import { chmod, copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { encodeSegment, parseArtifact, projectDirFor } from './paths.mjs'
import {
  FrameFormatError,
  decodeFrames,
  encodeFrame,
  endsOnRecordBoundary,
  isSingleRecordFrame,
  recoverPartialFrame,
  scanZstdFrames,
} from './zstd-frame.mjs'

/** Events per emitted frame when rebuilding a log. */
export const MAX_FRAME_LINES = 256

/** Byte ceiling per emitted frame, applied to whole lines. */
export const MAX_FRAME_BYTES = 64 * 1024

/** Refuse to buffer artifacts above this size. */
export const MAX_LOG_BYTES = 256 * 1024 * 1024

/** Session format generation this tool can re-frame. */
export const SUPPORTED_MAJOR_VERSION = 4

/**
 * Raised when an artifact changed between scanning and rewriting it, which means
 * something is still writing to it - normally a running DSH host.
 */
export class SessionBusyError extends Error {
  /** @param logPath - the artifact that changed. */
  constructor(logPath) {
    super(`${logPath} changed while it was being repaired; is DeepSeek Harness running?`)
    this.name = 'SessionBusyError'
  }
}

/**
 * Walk `<root>/<project>/<session>/session.v<N>.jsonl[.zstd]`.
 * @param root - the DSH `sessions` directory.
 * @returns one record per stored session generation, in stable order.
 */
export async function scanSessions(root) {
  const records = []
  let projects
  try {
    projects = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory())
  } catch (error) {
    if (error?.code === 'ENOENT') return records
    throw error
  }

  for (const project of projects.sort((a, b) => a.name.localeCompare(b.name))) {
    const projectPath = join(root, project.name)
    let sessions
    try {
      sessions = (await readdir(projectPath, { withFileTypes: true })).filter(entry => entry.isDirectory())
    } catch {
      continue
    }
    for (const session of sessions.sort((a, b) => a.name.localeCompare(b.name))) {
      const dirPath = join(projectPath, session.name)
      let names
      try {
        names = (await readdir(dirPath))
          .map(name => ({ name, ...parseArtifact(name) }))
          .filter(entry => entry.version !== undefined)
          .sort((a, b) => a.version - b.version)
      } catch {
        continue
      }
      const artifact = names.at(-1)
      if (artifact === undefined) continue
      records.push(await inspectArtifact(root, project.name, session.name, dirPath, artifact))
    }
  }
  return records
}

/** Empty container-fault accumulator shared by the inspect path. */
function emptyContainer() {
  return {
    /** Complete frames in the artifact. */
    frames: 0,
    /** Lines inside the first frame (must be 1). */
    headerFrameLines: 0,
    /** A frame whose plaintext does not end on a record boundary. */
    brokenBoundary: false,
    /** An incomplete final frame (crash), regardless of recovery. */
    torn: false,
    /** Bytes recovered from a torn tail. */
    recoveredBytes: 0,
    /** Bytes of an unterminated final record dropped by the repair. */
    droppedTailBytes: 0,
    /** Why the artifact could not be read at all. */
    unreadable: undefined,
  }
}

/**
 * Inspect one artifact without modifying it.
 * @param sessionsRoot - the DSH `sessions` directory.
 * @param projectDir - project directory name.
 * @param sessionDirName - session directory name.
 * @param dirPath - absolute session directory.
 * @param artifact - chosen generation `{name, version, compression}`.
 * @returns the inspection record.
 */
async function inspectArtifact(sessionsRoot, projectDir, sessionDirName, dirPath, artifact) {
  const logPath = join(dirPath, artifact.name)
  const info = await stat(logPath)
  const record = {
    sessionsRoot,
    projectDir,
    sessionDirName,
    dirPath,
    logPath,
    fileName: artifact.name,
    version: artifact.version,
    compression: artifact.compression,
    size: Number(info.size),
    mtimeMs: info.mtimeMs,
    mode: info.mode & 0o7777,
    empty: Number(info.size) === 0,
    bytes: undefined,
    plaintext: undefined,
    header: undefined,
    headerId: undefined,
    cwd: undefined,
    createdAt: 0,
    container: emptyContainer(),
    expectedProjectDir: undefined,
    expectedSessionDir: undefined,
    identityFaults: [],
  }
  if (record.empty) return record

  if (record.version !== SUPPORTED_MAJOR_VERSION) {
    record.container.unreadable = `unsupported session format v${record.version} (this tool handles v${SUPPORTED_MAJOR_VERSION})`
    return record
  }
  if (record.size > MAX_LOG_BYTES) {
    record.container.unreadable = `artifact is larger than ${MAX_LOG_BYTES} bytes; not loaded`
    return record
  }

  const bytes = await readFile(logPath)
  record.bytes = bytes

  try {
    record.plaintext = await decodeArtifact(record, bytes)
  } catch (error) {
    record.container.unreadable = error instanceof FrameFormatError
      ? error.message
      : `cannot decode artifact: ${error.message}`
    return record
  }

  const firstNewline = record.plaintext.indexOf(0x0a)
  if (firstNewline < 0) {
    record.container.unreadable = 'log holds no header line'
    return record
  }
  try {
    const header = JSON.parse(record.plaintext.subarray(0, firstNewline).toString('utf8'))
    if (header === null || typeof header !== 'object' || header.type !== 'session') {
      record.container.unreadable = 'first line is not a session header'
      return record
    }
    record.header = header
    record.headerId = typeof header.id === 'string' ? header.id : undefined
    record.cwd = typeof header.cwd === 'string' ? header.cwd : undefined
    record.createdAt = typeof header.createdAt === 'number' ? header.createdAt : 0
  } catch {
    record.container.unreadable = 'header line is not valid JSON'
    return record
  }

  if (record.headerId === undefined) {
    record.container.unreadable = 'header carries no session id'
    return record
  }

  if (record.cwd !== undefined) {
    record.expectedProjectDir = projectDirFor(record.cwd)
    if (record.expectedProjectDir !== record.projectDir) {
      record.identityFaults.push(
        `header cwd "${record.cwd}" belongs under "${record.expectedProjectDir}"`,
      )
    }
  }
  record.expectedSessionDir = encodeSegment(record.headerId)
  if (record.expectedSessionDir !== record.sessionDirName) {
    record.identityFaults.push(`expected session directory "${record.expectedSessionDir}"`)
  }
  return record
}

/**
 * Decode an artifact into its plaintext, recording container faults.
 * @param record - inspection record, mutated with frame facts.
 * @param bytes - artifact bytes.
 * @returns the complete JSONL plaintext.
 */
async function decodeArtifact(record, bytes) {
  if (record.compression === 'none') {
    record.container.frames = 0
    return bytes
  }

  const { frames, tornStart } = scanZstdFrames(bytes)
  record.container.frames = frames.length
  if (frames.length === 0) throw new FrameFormatError('artifact holds no complete Zstandard frame')

  const plaintexts = await decodeFrames(bytes, frames)
  record.container.headerFrameLines = countLines(plaintexts[0])
  for (const chunk of plaintexts) {
    if (!endsOnRecordBoundary(chunk)) record.container.brokenBoundary = true
  }

  let recovered = Buffer.alloc(0)
  if (tornStart !== undefined) {
    record.container.torn = true
    const partial = await recoverPartialFrame(bytes.subarray(tornStart))
    const lastNewline = partial.lastIndexOf(0x0a)
    if (lastNewline >= 0) recovered = partial.subarray(0, lastNewline + 1)
    record.container.recoveredBytes = recovered.length
  }

  // A partial record cannot be kept: the reader would treat it as a torn tail.
  // Drop it and record how much went, so the repair stays explainable.
  const complete = Buffer.concat([...plaintexts, recovered])
  if (!endsOnRecordBoundary(complete)) {
    const lastNewline = complete.lastIndexOf(0x0a)
    record.container.brokenBoundary = true
    record.container.droppedTailBytes = complete.length - (lastNewline + 1)
    return lastNewline >= 0 ? complete.subarray(0, lastNewline + 1) : Buffer.alloc(0)
  }
  return complete
}

/**
 * Whether the container must be rewritten.
 * @param record - inspection record.
 * @returns true when re-framing is needed.
 */
export function needsReframe(record) {
  if (record.empty || record.container.unreadable !== undefined) return false
  if (record.compression === 'none') return false
  return record.container.headerFrameLines !== 1
    || record.container.brokenBoundary
    || record.container.torn
}

/**
 * Count newline-terminated lines; a trailing partial line counts once.
 * @param buffer - plaintext.
 * @returns line count.
 */
export function countLines(buffer) {
  if (buffer.length === 0) return 0
  let lines = 0
  for (let i = 0; i < buffer.length; i++) if (buffer[i] === 0x0a) lines++
  return buffer[buffer.length - 1] === 0x0a ? lines : lines + 1
}

/**
 * Build a correctly framed artifact from a log's plaintext.
 * @param plaintext - complete JSONL ending with a newline.
 * @returns encoded frames.
 */
export async function buildFrames(plaintext) {
  if (plaintext.length === 0 || plaintext[plaintext.length - 1] !== 0x0a) {
    throw new Error('refusing to re-frame a log whose plaintext does not end on a record boundary')
  }
  const headerEnd = plaintext.indexOf(0x0a)
  const header = plaintext.subarray(0, headerEnd + 1)
  const body = plaintext.subarray(headerEnd + 1)

  const frames = [await encodeFrame(header)]
  let cursor = 0
  while (cursor < body.length) {
    let end = cursor
    let lines = 0
    while (end < body.length && lines < MAX_FRAME_LINES && end - cursor < MAX_FRAME_BYTES) {
      const newline = body.indexOf(0x0a, end)
      if (newline < 0) {
        end = body.length
        break
      }
      end = newline + 1
      lines++
    }
    frames.push(await encodeFrame(body.subarray(cursor, end)))
    cursor = end
  }
  return Buffer.concat(frames)
}

/**
 * Verify that bytes satisfy the container contract and carry exactly `plaintext`.
 * @param bytes - candidate artifact.
 * @param plaintext - the plaintext it must reproduce.
 * @returns frame count.
 * @throws when any rule fails.
 */
export async function verifyFrames(bytes, plaintext) {
  const { frames, tornStart } = scanZstdFrames(bytes)
  if (tornStart !== undefined) throw new Error('verification: rebuilt artifact has a torn tail')
  if (frames.length === 0) throw new Error('verification: rebuilt artifact holds no frame')
  const decoded = await decodeFrames(bytes, frames)
  if (!isSingleRecordFrame(decoded[0])) throw new Error('verification: first frame is not exactly the header line')
  for (const chunk of decoded) {
    if (!endsOnRecordBoundary(chunk)) throw new Error('verification: a frame does not end on a record boundary')
  }
  if (!Buffer.concat(decoded).equals(plaintext)) {
    throw new Error('verification: rebuilt plaintext differs from the original log')
  }
  return frames.length
}

/**
 * Rewrite one artifact with the correct frame layout.
 * @param record - scanned record carrying `plaintext`.
 * @param options - `{ apply, backupDir?, tmpDir }`.
 * @returns the number of frames written.
 */
export async function reframeArtifact(record, options) {
  const plaintext = record.plaintext
  const encoded = await buildFrames(plaintext)
  const frameCount = await verifyFrames(encoded, plaintext)
  if (!options.apply) return frameCount

  // Refuse to overwrite an artifact that moved under us: a live host appending
  // to this session would be corrupted by a rewrite.
  const current = await stat(record.logPath)
  if (Number(current.size) !== record.size || current.mtimeMs !== record.mtimeMs) {
    throw new SessionBusyError(record.logPath)
  }

  if (options.backupDir !== undefined) {
    const target = join(options.backupDir, record.projectDir, record.sessionDirName)
    await mkdir(target, { recursive: true })
    await copyFile(record.logPath, join(target, record.fileName))
  }
  await mkdir(options.tmpDir, { recursive: true })
  const tmp = join(options.tmpDir, `${record.sessionDirName}-${record.fileName}`)
  await writeFile(tmp, encoded)
  await chmod(tmp, record.mode)
  await rename(tmp, record.logPath)
  return frameCount
}

/**
 * Move a session directory under the project directory its header demands.
 * @param record - scanned record with `expectedProjectDir`.
 * @param options - `{ apply }`.
 * @returns the target directory path.
 */
export async function relocateSession(record, options) {
  if (record.cwd === undefined) throw new Error('cannot relocate a session without a recorded cwd')
  const targetDir = join(record.sessionsRoot, record.expectedProjectDir, record.sessionDirName)
  if (options.apply) {
    await mkdir(dirname(targetDir), { recursive: true })
    await rename(record.dirPath, targetDir)
  }
  return targetDir
}
