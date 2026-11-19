/**
 * The host-detection classifier decides whether `--apply` may write, so it must
 * not match shells, editors, or the repair tool itself.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyHostLines } from '../lib/platform.mjs'

const HOST_LINES = [
  '  412 /opt/DeepSeek Harness/deepseek-harness --type=renderer --user-data-dir=/home/u/.config/@deepseek-ai/dsh-desktop',
  '  350 /opt/DeepSeek Harness/deepseek-harness --expose-internals /opt/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js',
  '  700 /usr/bin/node /usr/local/lib/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js --profile web',
]

const NOISE_LINES = [
  '  900 bash -c cd repo && python3 - <<PY # patch bin/dsh-session-repair.mjs "DeepSeek Harness appears to be running" PY',
  '  901 node bin/dsh-session-repair.mjs --verify',
  '  902 pgrep -af deepseek-harness',
  '  903 ps -A -o pid=,command=',
  '  904 vim README.md',
  '  905 grep -rn deepseek-harness docs/',
  '  906 /usr/bin/git commit -m "deepseek-harness repair"',
]

test('a running host is detected from its process lines', () => {
  const found = classifyHostLines(HOST_LINES)
  assert.equal(found.length, HOST_LINES.length)
})

test('the repair tool, probes, shells and editors never match', () => {
  assert.deepEqual(classifyHostLines(NOISE_LINES), [])
})

test('this process tree is excluded even when it names the host', () => {
  const lines = ['  42 /opt/DeepSeek Harness/deepseek-harness --type=renderer']
  assert.deepEqual(classifyHostLines(lines, new Set(['42'])), [])
})

test('duplicate pids are reported once', () => {
  const lines = [HOST_LINES[0], HOST_LINES[0]]
  assert.equal(classifyHostLines(lines).length, 1)
})
