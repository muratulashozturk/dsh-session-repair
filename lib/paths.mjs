/**
 * DSH session-store path grammar.
 *
 * Layout: `<dshHome>/sessions/<projectKey(cwd)>/<encodeSegment(sessionId)>/session.v<N>.jsonl.zstd`
 *
 * The provider validates that a log's stored path matches the path derived from
 * its own header (`assertStoredIdentity`), so a session whose directory name no
 * longer matches its recorded cwd is not merely misplaced: it makes the whole
 * `sessionPersistence.list()` throw.
 *
 * Both encoders are copied from dsh-session-persistence-jsonl/src/format.ts.
 */

/** Matches one generation artifact name. */
export const GENERATION_ARTIFACT = /^session\.v(\d+)\.jsonl(\.zstd)?$/

/**
 * Encode one path segment (session id) into a safe directory name.
 * @param raw - the segment to encode.
 * @returns the encoded segment.
 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * Build the human-readable project directory key for a project path.
 * Separators (`/`, `\`, `:`) collapse to one `-`, unsafe code units use the
 * `~XXXX` escape, leading separators are dropped, and the slug is capped at
 * 251 characters so the whole name fits a filesystem component.
 * @param cwd - the session's recorded project directory.
 * @returns the single path segment DSH uses for that project.
 */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * The project directory DSH expects for a recorded cwd.
 * @param cwd - recorded project directory.
 * @returns the project directory segment.
 */
export function projectDirFor(cwd) {
  return projectKey(cwd)
}

/**
 * Parse a generation artifact name.
 * @param name - file name inside a session directory.
 * @returns `{version, compression}` or undefined when the name is not an artifact.
 */
export function parseArtifact(name) {
  const match = GENERATION_ARTIFACT.exec(name)
  if (match === null) return undefined
  return {
    version: Number(match[1]),
    compression: match[2] === '.zstd' ? 'zstd' : 'none',
  }
}

/**
 * The current generation file name.
 * @param version - session format version.
 * @param compression - physical encoding.
 * @returns the file name.
 */
export function generationFileName(version, compression = 'zstd') {
  return `session.v${version}.jsonl${compression === 'zstd' ? '.zstd' : ''}`
}
