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
APP_NAME="omniroute-gate-20129"
PROD_DATA_DIR="${DATA_DIR:-${HOME}/.omniroute}"
GATE_DATA_DIR="${PROJECT_ROOT}/_artifacts/gate_20129_data"

ensure_dependencies() {
  command -v node >/dev/null 2>&1 || {
    printf 'error: node is not available in PATH\n' >&2
    exit 1
  }
  command -v pm2 >/dev/null 2>&1 || {
    printf 'error: pm2 is not available in PATH\n' >&2
    exit 1
  }
  command -v sqlite3 >/dev/null 2>&1 || {
    printf 'error: sqlite3 is not available in PATH\n' >&2
    exit 1
  }
}

check_port_20129() {
  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids="$(lsof -ti :20129 2>/dev/null || true)"
    if [[ -n "${pids}" ]]; then
      local gate_pid=""
      if command -v pm2 >/dev/null 2>&1; then
        gate_pid="$(pm2 jlist 2>/dev/null | node -e '
          const fs = require("fs");
          try {
            const list = JSON.parse(fs.readFileSync(0, "utf-8"));
            const app = list.find(p => p.name === "omniroute-gate-20129");
            if (app && app.pid) console.log(app.pid);
          } catch {}
        ' 2>/dev/null || true)"
      fi
      for pid in ${pids}; do
        if [[ -n "${gate_pid}" && "${pid}" == "${gate_pid}" ]]; then
          continue
        fi
        printf 'error: port 20129 is already in use by alien process PID %s\n' "${pid}" >&2
        lsof -i :20129 >&2 || true
        exit 1
      done
    fi
  fi
}

prepare_gate_data() {
  mkdir -p "${GATE_DATA_DIR}"

  # Snapshot SQLite DB if exists
  if [[ -f "${PROD_DATA_DIR}/storage.sqlite" ]]; then
    printf 'Creating atomic SQLite backup from %s to %s...\n' "${PROD_DATA_DIR}/storage.sqlite" "${GATE_DATA_DIR}/storage.sqlite"
    sqlite3 "${PROD_DATA_DIR}/storage.sqlite" ".backup '${GATE_DATA_DIR}/storage.sqlite'"
  else
    printf 'Notice: Production database not found at %s/storage.sqlite, starting with fresh DB\n' "${PROD_DATA_DIR}"
  fi

  # Copy server.env to preserve STORAGE_ENCRYPTION_KEY, JWT_SECRET, etc.
  if [[ -f "${PROD_DATA_DIR}/server.env" ]]; then
    cp -f "${PROD_DATA_DIR}/server.env" "${GATE_DATA_DIR}/server.env"
    printf 'Copied server.env into %s\n' "${GATE_DATA_DIR}"
  fi

  # Copy .env configuration
  if [[ -f "${PROD_DATA_DIR}/.env" ]]; then
    cp -f "${PROD_DATA_DIR}/.env" "${GATE_DATA_DIR}/.env"
    printf 'Copied .env from %s into %s\n' "${PROD_DATA_DIR}" "${GATE_DATA_DIR}"
  elif [[ -f "${PROJECT_ROOT}/.env" ]]; then
    cp -f "${PROJECT_ROOT}/.env" "${GATE_DATA_DIR}/.env"
    printf 'Copied .env from %s into %s\n' "${PROJECT_ROOT}" "${GATE_DATA_DIR}"
  fi
}

cmd_start() {
  ensure_dependencies

  [[ -f "${SERVER_ENTRY}" ]] || {
    printf 'error: standalone entry not found: %s\n' "${SERVER_ENTRY}" >&2
    printf 'hint: run "npm run build" first to build the standalone bundle\n' >&2
    exit 1
  }

  check_port_20129

  local node_bin
  node_bin="$(node -p 'process.execPath')"

  prepare_gate_data

  printf 'Restarting %s in PM2...\n' "${APP_NAME}"
  pm2 delete "${APP_NAME}" >/dev/null 2>&1 || true

  DATA_DIR="${GATE_DATA_DIR}" \
  PORT=20129 \
  DASHBOARD_PORT=20129 \
  API_PORT=20129 \
  OMNIROUTE_PORT=20129 \
  OMNIROUTE_PUBLIC_BASE_URL="http://127.0.0.1:20129" \
  LIVE_WS_PORT=20133 \
  OMNIROUTE_ENABLE_LIVE_WS=0 \
  OMNIROUTE_DISABLE_BACKGROUND_SERVICES=1 \
  OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK=true \
  DISABLE_SQLITE_AUTO_BACKUP=true \
  OMNIROUTE_WAL_TRUNCATE_INTERVAL_MS=0 \
  PROXY_HEALTH_ENABLED=false \
  pm2 start "${SERVER_ENTRY}" \
    --name "${APP_NAME}" \
    --cwd "${STANDALONE_ROOT}" \
    --interpreter "${node_bin}" \
    --node-args="--max-http-header-size=65536" \
    --update-env

  printf 'Waiting for %s to become healthy on http://127.0.0.1:20129/api/health...\n' "${APP_NAME}"
  local healthy=0
  for _ in $(seq 1 30); do
    local status_code
    status_code="$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:20129/api/health" 2>/dev/null || true)"
    if [[ "${status_code}" == "200" ]]; then
      healthy=1
      break
    fi
    sleep 1
  done

  if [[ "${healthy}" -eq 1 ]]; then
    local gate_pid=""
    gate_pid="$(pm2 jlist 2>/dev/null | node -e '
      const fs = require("fs");
      try {
        const list = JSON.parse(fs.readFileSync(0, "utf-8"));
        const app = list.find(p => p.name === "omniroute-gate-20129");
        if (app && app.pid) console.log(app.pid);
      } catch {}
    ' 2>/dev/null || true)"
    printf 'Successfully started %s! PID: %s, URL: http://127.0.0.1:20129\n' "${APP_NAME}" "${gate_pid:-unknown}"
  else
    printf 'error: %s failed to become healthy within 30s\n' "${APP_NAME}" >&2
    pm2 logs "${APP_NAME}" --lines 30 --nostream >&2 || true
    exit 1
  fi
}

cmd_stop() {
  command -v pm2 >/dev/null 2>&1 || {
    printf 'error: pm2 is not available in PATH\n' >&2
    exit 1
  }

  printf 'Stopping %s...\n' "${APP_NAME}"
  pm2 delete "${APP_NAME}" >/dev/null 2>&1 || true

  local clean=0
  for arg in "$@"; do
    if [[ "${arg}" == "--clean" ]]; then
      clean=1
    fi
  done

  if [[ "${clean}" -eq 1 ]]; then
    if [[ -d "${GATE_DATA_DIR}" ]]; then
      rm -rf "${GATE_DATA_DIR}"
      printf 'Cleaned gate data directory: %s\n' "${GATE_DATA_DIR}"
    fi
  fi

  printf '%s stopped.\n' "${APP_NAME}"
}

cmd_status() {
  command -v pm2 >/dev/null 2>&1 || {
    printf 'error: pm2 is not available in PATH\n' >&2
    exit 1
  }

  pm2 status "${APP_NAME}" || true

  printf '\nChecking health on http://127.0.0.1:20129/api/health:\n'
  if curl -s -i "http://127.0.0.1:20129/api/health" 2>/dev/null; then
    printf '\n'
  else
    printf 'Health endpoint unreachable.\n'
  fi
}

cmd_logs() {
  command -v pm2 >/dev/null 2>&1 || {
    printf 'error: pm2 is not available in PATH\n' >&2
    exit 1
  }

  pm2 logs "${APP_NAME}" --lines 50 "$@"
}

usage() {
  cat <<'EOF'
Usage: scripts/deploy/pm2_gate_20129.sh [command] [options]

Commands:
  start          Prepare snapshot DATA_DIR, start omniroute-gate-20129 on port 20129 (default)
  stop [--clean] Stop and remove omniroute-gate-20129 from PM2. Optionally delete gate DATA_DIR with --clean
  status         Show PM2 status and query http://127.0.0.1:20129/api/health
  logs [args]    Show omniroute-gate-20129 logs (default: --lines 50)
  --help, -h     Show this help message
EOF
}

case "${1:-start}" in
  start)
    cmd_start
    ;;
  stop)
    shift
    cmd_stop "$@"
    ;;
  status)
    cmd_status
    ;;
  logs)
    shift
    cmd_logs "$@"
    ;;
  --help|-h|help)
    usage
    exit 0
    ;;
  *)
    printf 'error: unknown command: %s\n\n' "$1" >&2
    usage >&2
    exit 1
    ;;
esac
