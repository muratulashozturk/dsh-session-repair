#!/usr/bin/env bash
#
# fix-dsh-sessions.sh - launcher for dsh-session-repair.
#
# Restores DeepSeek Harness sessions that disappeared from the sidebar after a
# migration recompressed their logs or moved their project directory.
#
# Requires Node.js with node:zlib Zstandard support (22.15+, 23.8+ or 24+).
# Nothing else: no Python, no zstd(1) binary, no network, no build step.
#
#   ./fix-dsh-sessions.sh                  # dry run against ~/.dsh
#   ./fix-dsh-sessions.sh --apply          # write (quit DeepSeek Harness first)
#   ./fix-dsh-sessions.sh --verify         # health check, exit 1 if work remains
#   ./fix-dsh-sessions.sh --help           # every option
#
# Override the interpreter with DSH_SESSION_REPAIR_NODE=/path/to/node.
#
set -u

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
cli="$repo_dir/bin/dsh-session-repair.mjs"

if [ ! -f "$cli" ]; then
  printf 'error: %s is missing; run this script from the repository checkout\n' "$cli" >&2
  exit 2
fi

# Probe one candidate: any Node with Zstandard support in node:zlib.
# The capability decides; the version floor only keeps ancient runtimes out.
# Exit codes: 0 ok, 3 no Zstandard, 4 too old.
check_node() {
  [ -n "${1:-}" ] || return 1
  [ -x "$1" ] || return 1
  "$1" -e 'const z=require("node:zlib");
    if (Number(process.versions.node.split(".")[0])<20) process.exit(4);
    if (typeof z.zstdCompress!=="function"||typeof z.zstdDecompress!=="function") process.exit(3)' \
    >/dev/null 2>&1
}

describe_node_failure() {
  version=$("$1" -p 'process.versions.node' 2>/dev/null) || version='?'
  "$1" -e 'const z=require("node:zlib");
    process.exit(typeof z.zstdCompress==="function"&&typeof z.zstdDecompress==="function"?0:3)' \
    >/dev/null 2>&1
  status=$?
  printf '  %s (Node %s): ' "$1" "$version" >&2
  case $status in
    0) printf 'too old - Node 22.15+ or 24+ is required\n' >&2 ;;
    3) printf 'no node:zlib Zstandard support - Node 22.15+ or 24+ is required\n' >&2 ;;
    *) printf 'not executable or not Node\n' >&2 ;;
  esac
}

# Candidates are probed in order and each is validated, so a stale PATH entry is
# skipped rather than failing the repair.
find_node() {
  if [ -n "${DSH_SESSION_REPAIR_NODE:-}" ]; then
    if check_node "$DSH_SESSION_REPAIR_NODE"; then
      printf '%s\n' "$DSH_SESSION_REPAIR_NODE"
      return 0
    fi
    printf 'error: DSH_SESSION_REPAIR_NODE lacks node:zlib Zstandard support\n' >&2
    describe_node_failure "$DSH_SESSION_REPAIR_NODE"
    return 1
  fi

  on_path=$(command -v node 2>/dev/null || true)
  if check_node "${on_path:-}"; then
    printf '%s\n' "$on_path"
    return 0
  fi

  for candidate in \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
    "$HOME"/Library/Application\ Support/fnm/node-versions/*/installation/bin/node \
    "$HOME"/.volta/bin/node \
    "$HOME"/.asdf/shims/node \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node
  do
    if check_node "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  printf 'error: no usable Node.js found.\n\n' >&2
  printf 'Install Node 22.15+ or 24+, then re-run. If Node lives somewhere unusual:\n' >&2
  printf '  DSH_SESSION_REPAIR_NODE=/path/to/node %s --verify\n\n' "$0" >&2
  printf 'checked:\n' >&2
  if [ -n "${on_path:-}" ]; then describe_node_failure "$on_path"; fi
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -e "$candidate" ]; then describe_node_failure "$candidate"; fi
  done
  return 1
}

node_bin=$(find_node) || exit 2

exec "$node_bin" "$cli" "$@"
