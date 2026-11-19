# Anatomy of the failure

This document is the long form of the README's *Why it happens*: the exact
contracts a migrated DeepSeek Harness home can violate, the code that enforces
them, and how the fault was isolated in a real Windows → Linux migration. It is
written for someone debugging a home directory they cannot afford to lose.

Everything below refers to packages shipped inside the DeepSeek Harness
application (`resources/app.asar`, `node_modules/@deepseek-ai/…`). Paths are
relative to that bundle.

---

## 1. The session artifact is a frame container

`@deepseek-ai/dsh-session-persistence-jsonl` stores one session as a file whose
name encodes its format generation:

```text
<dshHome>/sessions/<projectKey(cwd)>/<encodeSegment(sessionId)>/session.v4.jsonl.zstd
```

`session.v4.jsonl.zstd` is **a concatenation of independent Zstandard frames**.
`src/zstd.ts` owns the primitives:

```ts
export async function compressZstdFrame(input: Buffer | string): Promise<Buffer> {
  return zstdCompressAsync(input, { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
}
```

and `src/index.ts` owns the layout, writing the header as its own frame:

```ts
// encodeMaterialization
const header = JSON.stringify(toHeaderLine(meta, …)) + '\n'
const headerFrame = await compressZstdFrame(header)
const eventFrame  = await compressZstdFrame(eventLines(events) + '\n')
return Buffer.concat([headerFrame, eventFrame])
// encodeEventBatch
return this.compression === 'zstd' ? compressZstdFrame(eventLines(events) + '\n') : body
```

Two invariants come out of that, and both are checked when a header is read for
the session list:

```ts
// src/index.ts — readFirstZstdLine
const first = scanZstdFrames(content, 1).frames[0]
const plaintext = await decompressZstdFrame(content.subarray(first.start, first.end))
assertZstdHeaderFrame(plaintext)
return plaintext.subarray(0, -1).toString('utf8')

function assertZstdHeaderFrame(plaintext: Buffer): void {
  if (plaintext.length === 0 || plaintext.indexOf(0x0A) !== plaintext.length - 1)
    throw new Error('corrupt Zstandard session log: first frame is not exactly one header line')
}
```

- **frame 0 must contain exactly one line, ending in `\n`**;
- later frames are decoded in order and must end on a record boundary.

`zstd file.jsonl -o file.jsonl.zstd`, `tar --zstd`, or any script that does
`decompress → edit → recompress` produces **one frame containing the whole log**.
It decompresses perfectly. It just does not satisfy the first invariant.

### Why nothing is reported

The listing path treats an unreadable generation as "not a stored session" rather
than as an error:

```ts
// src/index.ts
private async readListedHeader(selected, signal) {
  try {
    return await this.readGenerationHeader(selected, undefined, signal)
  } catch (error) {
    if (error instanceof SessionFormatUnsupportedError
      || error instanceof SessionPersistenceCorruptionError) return undefined
    throw error
  }
}
```

`readFirstZstdLine` wraps its failure in `SessionPersistenceCorruptionError`, so
the session is silently dropped from `SessionPersistence.list()`. No warning is
emitted, and the client never learns the session exists.

### Downstream consequence

`@deepseek-ai/dsh-workspace` builds its membership index from exactly that
listing:

```ts
// dsh-workspace/src/index.ts
private async [Service.init]() {
  …
  await this.replaceHeaderIndex(await this.listStoredHeaders())   // sessionPersistence.list()
  …
}
private host = {
  candidateMatches: (id, path) => this.sessionPaths.get(id) === path || this.missingSessionPaths.has(id),
}
```

A session that was dropped by the listing has no entry in `sessionPaths`, so
`candidateMatches` is false for it, and `Workspace.sessionIds` filters it out:

```ts
// dsh-workspace/src/entity.ts
get sessionIds(): readonly SessionId[] {
  return this.record.sessionIds.filter(id => this.host.candidateMatches(id, this.record.path))
}
```

---

## 2. The directory must match the header

The provider also verifies that a log is stored where its own header says it
belongs:

```ts
// dsh-session-persistence-jsonl/src/index.ts
private async assertStoredIdentity(path, storedVersion, meta, expectedId, signal) {
  …
  expectedPath = generationLogPath(this.root, meta.cwd, meta.id, storedVersion, this.compression)
  if (path !== expectedPath && !await this.sameFile(path, expectedPath, signal)) {
    throw new Error(`corrupt session log "${path}": header id "${meta.id}" and cwd identify "${expectedPath}"`)
  }
}
```

This throws a **plain `Error`**, which `readListedHeader` does *not* swallow. It
propagates out of `listArtifacts`, `persistence.list()` rejects, and every
consumer that lists sessions fails — in practice the sidebar shows nothing at
all.

The path grammar is in `src/format.ts` and is the part that must be reproduced
when a `cwd` is rewritten:

```ts
export function encodeSegment(raw: string): string {
  // '.' → '~002E', '..' → '~002E~002E'
  // [A-Za-z0-9._-] kept, everything else → '~' + hex4
}

export function projectKey(cwd: string): string {
  // '/', '\' and ':' collapse to a single '-'
  // unsafe code units → '~' + hex4
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}
```

So `C:\codesseum\portavize\automation\rea` becomes
`--C-codesseum-portavize-automation-rea--`, and after migrating to
`/home/me/codesseum/portavize/automation/rea` the correct directory is
`--home-me-codesseum-portavize-automation-rea--`. Rewriting only the header
`cwd` and not the directory leaves the store in the loud failure mode.

---

## 3. The workspace account is pruned on every mutation

`~/.dsh/storages/workspace.json` is a `workspace` domain (version 2):

```jsonc
{
  "unit":   { "name": "workspace", "version": 2 },
  "global": { "initialized": true, "workspaceIds": ["…"],
              "archivedSessionIds": [], "pinnedSessionIds": [] },
  "tables": { "workspaces": { "…": { "path": "/home/me/project", "title": "project",
                                     "sessionIds": ["session-a", "session-b"] } } }
}
```

Every entity write funnels through one method that re-validates the account:

```ts
// dsh-workspace/src/entity.ts
private async mutate(fn) {
  next = await this.host.table().update(this.id, (current) => {
    const changed = fn(current)
    const sessionIds = changed.sessionIds.filter(id => this.host.candidateMatches(id, changed.path))
    …
  })
}
```

`candidateMatches` is a lookup in the index built at startup from the header
listing. While the container fault is present, that index is missing the
sessions, so the **first attach, rename, archive, or create in that project
deletes their ids from the durable file**. The logs are still on disk; the
pointer is gone. Re-adding ids by hand appears to work until the next mutation,
when the same prune runs again.

The registry only rebuilds the account from headers during the one-time
bootstrap, gated by `initialized`:

```ts
if (!this.state.initialized) {
  const headers = await this.listStoredHeaders()
  await this.replaceHeaderIndex(headers)
  await this.bootstrap(headers)          // groups sessions by canonical cwd, newest first
} else if (this.table.size > 0) {
  await this.replaceHeaderIndex(await this.listStoredHeaders())
}
```

Once `initialized: true` is in the file — which it is in every migrated home —
there is no second chance. That is why the repair has to rewrite the account
itself.

---

## 4. Archived ids are hidden, not deleted

`global.archivedSessionIds` is a plain array of session ids. The sidebar's
default filter is *hide archived*:

```ts
// dsh-client-ui-workspace/src/client/tree.ts
function sessionVisible(session, current, archived, archivedFilter) {
  if (session.origin === 'subagent') return false
  if (session.blank && session.id !== current) return false
  switch (archivedFilter) {
    case 'default': return !archived.has(session.id)
    case 'show':    return true
    case 'only':    return archived.has(session.id)
  }
}
```

A migrated home inherits whatever was archived on the old machine. Restoring
membership without touching this array restores sessions you still cannot see.
`--no-unarchive` keeps the flags for people who archived deliberately; the
sidebar filter is the alternative.

---

## How this was isolated

The failing home had 10 sessions of a known project. The provider's own answers
settled it, in this order.

**1. Does the host list them?** Calling the running host directly
(`POST /api/session/list` with the instance's auth cookie) returned **4** items.
A copy of the same home with each log rebuilt as `[header frame][event frames]`
returned **11**. Same data, same host, same code — only the framing changed.

**2. Is the header itself readable?** Decoding frame 0 of a "missing" log with
the shipped `sessionFormatCatalog` gave `status: current` for every session, so
the JSON, the format version and the identity were fine; only the frame layout
was not.

**3. Frame census.** A one-liner is enough to see it:

```bash
python3 - <<'PY'
import glob
MAGIC = b'\x28\xb5\x2f\xfd'
for p in sorted(glob.glob('/path/to/.dsh/sessions/*/*/session.v4.jsonl.zstd')):
    data = open(p, 'rb').read()
    print(data.count(MAGIC), 'frame(s)', p.split('/')[-2])
PY
```

A healthy log shows one frame per header/batch (2, 3, 8, 928 …). A recompressed
log shows exactly **1**. That single number explains the missing sessions.

**4. Why were the ids pruned from `workspace.json`?** The registry index is built
at startup; the logs were rewritten while the host was running. The first new
session created afterwards triggered `mutate()`, which filtered the account down
to the sessions the stale index knew about. The file's `updatedAt` matched the
moment the new session was created, not the migration.

---

## Reproducing it safely

`test/fixtures.mjs` builds the exact broken shape — one frame holding header plus
events — and the suite asserts the reader-visible consequences:

```bash
npm test
```

A minimal hand build, if you want to see it with your own eyes:

```js
import { zstdCompress } from 'node:zlib'
import { promisify } from 'node:util'
import { writeFile } from 'node:fs/promises'

const z = promisify(zstdCompress)
const header = JSON.stringify({ type: 'session', version: 4, id: 'session-demo',
  createdAt: Date.now(), cwd: '/tmp/demo', isSeeded: false, delegationDepth: 0 }) + '\n'
const body = JSON.stringify({ type: 'user/message', seq: 0, time: Date.now(),
  data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } }) + '\n'

// broken: everything in one frame
await writeFile('/tmp/.dsh/sessions/--tmp-demo--/session-demo/session.v4.jsonl.zstd',
  await z(header + body))
```

DeepSeek Harness will show no session for `/tmp/demo`. Re-frame it with this tool
and the row appears.

---

## The three invariants, in one place

| Layer | Invariant | Violation looks like |
|---|---|---|
| Container | frame 0 is exactly `header + '\n'`; every later frame ends on a record boundary; each frame checksummed | session silently absent from the list |
| Placement | log path equals `generationLogPath(root, header.cwd, header.id, version, compression)` | `persistence.list()` throws; no sessions shown at all |
| Account | id present in `workspace.json` `sessionIds`, and not in `archivedSessionIds` (default filter) | project shown, sessions absent or hidden |

If all three hold, the sidebar renders the session. No fourth gate exists.
