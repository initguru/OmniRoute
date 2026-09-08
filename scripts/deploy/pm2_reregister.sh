#!/usr/bin/env bash
set -euo pipefail

if [[ -f "${HOME}/.bashrc" ]]; then
  # shellcheck source=/dev/null
  source "${HOME}/.bashrc"
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
STANDALONE_ROOT="${PROJECT_ROOT}/.build/next/standalone"
SERVER_ENTRY="${STANDALONE_ROOT}/dev/run-standalone.mjs"

command -v node >/dev/null 2>&1 || {
  printf 'error: node is not available in PATH\n' >&2
  exit 1
}
command -v pm2 >/dev/null 2>&1 || {
  printf 'error: pm2 is not available in PATH\n' >&2
  exit 1
}
[[ -f "${SERVER_ENTRY}" ]] || {
  printf 'error: standalone entry not found: %s\n' "${SERVER_ENTRY}" >&2
  exit 1
}

NODE_BIN="$(node -p 'process.execPath')"

pm2 delete omniroute-server >/dev/null 2>&1 || true
pm2 start "${SERVER_ENTRY}" \
  --name omniroute-server \
  --cwd "${STANDALONE_ROOT}" \
  --interpreter "${NODE_BIN}"
pm2 save
