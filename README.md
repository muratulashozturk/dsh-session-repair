# dsh-session-repair

Restore **DeepSeek Harness** sessions that disappeared from the sidebar after the
`~/.dsh` directory was migrated between machines, home directories, or operating
systems.

The conversation logs are almost always intact. What breaks is the *container*
they live in, the *directory* they live under, and the *account* that tells the
sidebar where to draw them. This tool detects all three, explains them, and
repairs them in place — dry-run first, with backups.

```console
$ ./bin/fix-dsh-sessions.sh
DSH home   /home/me/.dsh
sessions   /home/me/.dsh/sessions

Stored sessions: 10

Container (Zstandard frame layout)
  reframe  session-30c882e3-376a-4b9b-a4… 1 frame, header frame holds 1623 lines -> 58 frames
  reframe  session-3812e98c-62f1-4df3-a0… 1 frame, header frame holds 1787 lines -> 61 frames
  …

dry run: 7 items need repair. Re-run with --apply to write.
```

After `--apply` and one restart of DeepSeek Harness, the project lists every
session again.

---

## The symptom

- You copied `~/.dsh` (or `C:\Users\…\.dsh`) to a new machine.
- DeepSeek Harness starts, the **project** is still in the sidebar, but its
  sessions are missing — often only the sessions you created *after* the move
  are listed.
- Sometimes the project lists a couple of old sessions and hides the rest.
- You re-add the session ids to `~/.dsh/storages/workspace.json`; they work for a
  moment and then vanish again.
- Nothing is logged. No error, no toast, no warning.

## Why it happens

Three independent faults are enough to hide a session. A naive migration —
unpack the log, rewrite a path, repack it — causes at least the first, and often
all three.

### 1. The log's Zstandard frame container (the silent one)

A DSH session log is **not** one compressed JSONL file. It is a concatenation of
independent Zstandard frames:

```text
┌─────────────────────────┬──────────────────────┬──────────────────────┐
│ frame 0                 │ frame 1              │ frame 2              │
│ 1 line: the SessionHeader│ event batch          │ event batch          │
│ … ends with \n          │ ends on a record     │ ends on a record     │
│ checksummed             │ checksummed          │ checksummed          │
└─────────────────────────┴──────────────────────┴──────────────────────┘
```

The reader enforces this in `dsh-session-persistence-jsonl`:

```ts
// src/index.ts
function assertZstdHeaderFrame(plaintext: Buffer): void {
  if (plaintext.length === 0 || plaintext.indexOf(0x0A) !== plaintext.length - 1)
    throw new Error('corrupt Zstandard session log: first frame is not exactly one header line')
}
```

A log recompressed by `zstd`, `tar --zstd`, or any "decompress, edit, recompress"
script is **one frame holding the whole log**, so frame 0 holds every line and
the check throws. That throw is a `SessionPersistenceCorruptionError`, and the
listing path deliberately swallows it:

```ts
private async readListedHeader(selected, signal) {
  try { return await this.readGenerationHeader(selected, undefined, signal) }
  catch (error) {
    if (error instanceof SessionFormatUnsupportedError
      || error instanceof SessionPersistenceCorruptionError) return undefined   // ← session disappears
    throw error
  }
}
```

`sessionPersistence.list()` therefore omits the session, the workspace header
index never learns its `cwd`, and the sidebar never receives a row. The log
itself is perfectly readable — only its framing is wrong.

### 2. The session directory (the loud one)

The provider validates that a log sits exactly where its own header says it
should (`assertStoredIdentity`), building the path from the recorded `cwd`:

```text
<dshHome>/sessions/<projectKey(cwd)>/<encodeSegment(sessionId)>/session.v<N>.jsonl.zstd
```

If you changed a session's `cwd` without renaming its project directory, that
validation throws a plain `Error` — which is *not* swallowed — and the entire
`sessionPersistence.list()` fails. The whole sidebar empties.

### 3. The workspace account (the one that keeps coming back)

The sidebar groups sessions from an ordered array in
`~/.dsh/storages/workspace.json`:

```jsonc
{ "tables": { "workspaces": {
  "…": { "path": "/home/me/project", "title": "project",
         "sessionIds": ["session-8caaddc6…", "session-f361f819…"] } } },
  "global": { "archivedSessionIds": [] } }
```

Every workspace mutation calls `mutate()`, which **permanently prunes** any id
whose session header does not validate in that process's index:

```ts
// dsh-workspace/src/entity.ts
const sessionIds = changed.sessionIds.filter(id => this.host.candidateMatches(id, changed.path))
```

So while fault 1 (or 2) is active, the first time you create a session or open a
project, the old ids are deleted from the durable file. Repairing the logs
afterwards does not bring them back — which is exactly why "I fixed the paths,
but the sessions are still gone" keeps happening. The registry only rebuilds the
account from headers during the one-time bootstrap, and that bootstrap is skipped
once `initialized: true` is stored.

A fourth, softer fault: ids in `archivedSessionIds` are hidden by the default
sidebar filter, so restorations look inert until the archive flag is cleared.

---

## Requirements

- **Node.js with `node:zlib` Zstandard support** — Node 22.15+, 23.8+ or 24+.
  The launcher probes the capability, not just the version number.
- Nothing else: no Python, no `zstd` binary, no network, no build step.
- Linux, macOS, or any POSIX shell for the launcher. On Windows run the Node CLI
  directly (see [Windows](#windows)).

## Install

```bash
git clone https://github.com/muratulashozturk/dsh-session-repair.git
cd dsh-session-repair
npm test          # optional: 16 tests, synthetic fixtures, no real data touched
```

## Usage

```bash
# 1. Quit DeepSeek Harness completely.
# 2. Look before you leap:
./bin/fix-dsh-sessions.sh

# 3. Write the repair:
./bin/fix-dsh-sessions.sh --apply

# 4. Start DeepSeek Harness again.
```

### Options

| Option | Meaning |
|---|---|
| `--dsh-root <dir>` | DSH home to repair. Default `$DSH_HOME`, else `~/.dsh`. |
| `--apply` | Write the repair. Without it the run is read-only. |
| `--verify` | Report only; exit `1` when anything still needs repair. |
| `--json` | Machine-readable result (good for cron/CI). |
| `--force` | Proceed even when a DSH host appears to be running. |
| `--no-unarchive` | Keep archive flags on sessions the repair re-accounts. |
| `--fix-misplaced` | Also move session directories under the project their header `cwd` demands. |
| `-h`, `--help` | Full help. |
| `--version` | Version. |

Interpreter override, when Node is somewhere unusual:

```bash
DSH_SESSION_REPAIR_NODE=/opt/node-v24/bin/node ./bin/fix-dsh-sessions.sh --verify
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Healthy, or the repair was written. |
| `1` | `--verify` found work to do. |
| `2` | Usage error. |
| `3` | Refused: a DSH host is running (`--force` overrides). |
| `4` | The repair failed. |

## What it changes

Only inside the selected DSH home:

| Path | Change |
|---|---|
| `sessions/<project>/<session>/session.v4.jsonl.zstd` | Rewritten with the correct frame layout. Plaintext is preserved byte for byte and verified before publishing. |
| `sessions/<project>/<session>/` | Moved (only with `--fix-misplaced`) when the recorded `cwd` demands another project directory. |
| `storages/workspace.json` | `sessionIds` rebuilt from the headers that exist now, newest first; restored ids leave `archivedSessionIds` unless `--no-unarchive`. |
| `.dsh-session-repair-backup-<stamp>/` | Created once per `--apply` run that writes something. |

It does **not** touch your projects, your wallet of credentials, your settings, or
session *content*: only the container, the directory, and the account.

## Safety

- **Dry run by default.** Nothing is written without `--apply`.
- **Backups first.** The original logs and `workspace.json` are copied into
  `.dsh-session-repair-backup-<stamp>/` before the first write.
- **Verify before publish.** Each rebuilt log is decoded again and compared with
  the original plaintext; a mismatch aborts before the file is replaced.
- **Atomic publish.** The new artifact is written to a scratch file, restored to
  the original mode, then `rename(2)`d into place.
- **Refuses under a running host.** The account is rewritten from memory on every
  workspace mutation, so a repair written under a live host would be undone.
  Detection is best effort; `--force` exists for unusual setups.
- **Refuses to touch a file that moved.** Every artifact is re-`stat`ed
  immediately before it is rewritten; if its size or mtime changed, that session
  is skipped as busy instead of being corrupted. The same check guards
  `workspace.json`.

## How it works

1. **Scan** `sessions/*/*/session.v*.jsonl[.zstd]` read-only, decode every frame,
   and classify: container fault (`headerFrameLines != 1`, a frame that does not
   end on a record boundary, a torn tail), identity fault (directory does not
   match `projectKey(cwd)` / `encodeSegment(id)`), or unreadable.
2. **Plan** the rebuild. A dry run really builds and verifies every replacement
   in memory, so the reported frame counts and any failure are real.
3. **Apply**: relocate (optional) → reframe → repair the workspace account.
4. **Report** what changed and where the backups are.

## Verify it worked

```bash
./bin/fix-dsh-sessions.sh --verify     # exit 0 == healthy
```

Then start DeepSeek Harness and open the project. A session that is still hidden
usually means it is archived: switch the sidebar to **All conversations (show
archived)** or unarchive it from its row menu.

Programmatic check against the running host (advanced): the host exposes
`POST /api/session/list`, and the number of `items` is what the sidebar receives.

## Troubleshooting

**`no usable Node.js found`** — install Node 22.15+ or 24+, or point
`DSH_SESSION_REPAIR_NODE` at an interpreter. The launcher prints why each
candidate was rejected (too old, or built without Zstandard).

**`refused: a DSH host is running`** — quit DeepSeek Harness, including tray
processes, and retry. `--force` is available but the repair can be undone by the
running host.

**`Some artifacts changed while they were read`** — something is still writing to
the session log. Quit DSH fully, then re-run.

**Sessions are listed but a click shows nothing** — the log survived the container
fix but its events were damaged earlier. The original file is in the backup
directory; the repair never edits event content.

**Migrating again later:** copy `~/.dsh` with DeepSeek Harness closed, and never
recompress the session logs. If you must rewrite a header, keep the frame layout:
frame 0 = header line only, later frames = complete records.

## Windows

There is no `.sh` launcher on Windows; call the CLI with Node:

```powershell
node bin\dsh-session-repair.mjs --dsh-root "$env:USERPROFILE\.dsh"
node bin\dsh-session-repair.mjs --dsh-root "$env:USERPROFILE\.dsh" --apply
```

The same rules apply: quit DeepSeek Harness first, dry run before `--apply`.

## Scope and limits

- Handles session format **v4** (current) with `zstd` compression. Other
  generations are reported, never rewritten.
- Repairs the three faults above. It does not reconstruct deleted sessions, merge
  forks, or rewrite event content.
- Does not create projects for directories that never had one; it repairs the
  account of projects that already exist.
- The running-host check is advisory, by design (it must work on containers,
  remote shells, and minimal systems).

## See also

- [`docs/root-cause.md`](docs/root-cause.md) — the full anatomy, with the exact
  DSH code paths, how the failure was isolated, and how to reproduce it.
- [`test/`](test/) — 16 tests covering the container rules, the account rebuild,
  torn tails, misplaced directories, busy files and host detection.

## License

MIT — see [LICENSE](LICENSE).
