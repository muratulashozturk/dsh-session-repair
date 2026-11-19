/**
 * Zstandard frame primitives for DeepSeek Harness' JSONL session-log container.
 *
 * A session log is a CONCATENATION of independent Zstandard frames, not one
 * stream. The reader (dsh-session-persistence-jsonl) requires:
 *
 *   - frame 0 contains exactly one line: the session header, newline-terminated;
 *   - every later frame ends on a record boundary (its plaintext ends with \n);
 *   - each frame carries its own checksum.
 *
 * These helpers mirror that reader so a repair can detect and rebuild the
 * container without the reader installed.
 */

import { constants, zstdCompress, zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'

/** Zstandard frame magic, little-endian on disk. */
export const ZSTD_MAGIC = 0xfd2fb528

/** Human-readable runtime requirement, quoted by both the CLI and the launcher. */
export const RUNTIME_REQUIREMENT = 'Node.js with node:zlib Zstandard support (22.15+, 23.8+ or 24+)'

if (typeof zstdCompress !== 'function' || typeof zstdDecompress !== 'function') {
  throw new Error(`this Node runtime has no Zstandard support in node:zlib; ${RUNTIME_REQUIREMENT} is required`)
}

const compressFrameAsync = promisify(zstdCompress)
const decompressFrameAsync = promisify(zstdDecompress)

/** DSH encodes every frame with a checksum (ZSTD_c_checksumFlag = 1). */
const CHECKSUMMED = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

/** Decode a partial frame the way DSH recovers a torn tail: flush, do not finalize. */
const FLUSH_ONLY = { finishFlush: constants.ZSTD_e_flush }

/** Raised when bytes are not a structurally valid sequence of Zstandard frames. */
export class FrameFormatError extends Error {
  /** @param message - which structural rule failed and where. */
  constructor(message) {
    super(message)
    this.name = 'FrameFormatError'
  }
}

/**
 * Walk the concatenated frame structure without decompressing.
 * Mirrors dsh-session-persistence-jsonl's `scanZstdFrames`.
 *
 * @param buffer - complete artifact bytes.
 * @param maxFrames - optional limit; stops after this many complete frames.
 * @returns `frames` (byte ranges of complete frames, in order) and `tornStart`
 *   (offset of an incomplete final frame, when EOF interrupts one).
 * @throws {FrameFormatError} when complete structure is invalid.
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0

  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new FrameFormatError(`invalid frame magic at byte ${offset}`)
    }
    offset += 4

    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new FrameFormatError(`reserved frame-header bit at byte ${offset - 1}`)
    }

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new FrameFormatError(`reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }

  return { frames }
}

/**
 * Decompress every given frame range into its plaintext.
 * @param buffer - artifact bytes.
 * @param frames - ranges from {@link scanZstdFrames}.
 * @returns one plaintext buffer per frame, in order.
 */
export async function decodeFrames(buffer, frames) {
  const out = []
  for (const frame of frames) {
    out.push(await decompressFrameAsync(buffer.subarray(frame.start, frame.end)))
  }
  return out
}

/**
 * Compress one independently decodable, checksummed frame.
 * @param input - JSONL bytes for a header or an event batch.
 * @returns the complete encoded frame.
 */
export function encodeFrame(input) {
  return compressFrameAsync(input, CHECKSUMMED)
}

/**
 * Recover whatever plaintext a torn final frame produced.
 * @param bytes - the incomplete frame and everything after its magic.
 * @returns recovered plaintext; empty when nothing decodes.
 */
export async function recoverPartialFrame(bytes) {
  try {
    return await decompressFrameAsync(bytes, FLUSH_ONLY)
  } catch {
    return Buffer.alloc(0)
  }
}

/**
 * Whether this plaintext satisfies DSH's header-frame rule: exactly one line.
 * @param plaintext - a decoded frame.
 * @returns true when the only newline is the final byte.
 */
export function isSingleRecordFrame(plaintext) {
  return plaintext.length > 0 && plaintext.indexOf(0x0a) === plaintext.length - 1
}

/**
 * Whether this plaintext ends on a record boundary.
 * @param plaintext - a decoded frame.
 * @returns true when it is empty or its last byte is a newline.
 */
export function endsOnRecordBoundary(plaintext) {
  return plaintext.length === 0 || plaintext[plaintext.length - 1] === 0x0a
}
