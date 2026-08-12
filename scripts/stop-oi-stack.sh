#!/usr/bin/env bash
# Stop gateway, daemon, and worker — in order, without restarting.
# Extracted from restart-vodou-stack.sh. Used by the updater before binary replacement.
# Usage: bash scripts/stop-vodou-stack.sh /path/to/vodou-project-root
set -uo pipefail

VODOU_DIR="${1:-}"
if [ -z "$VODOU_DIR" ] || [ ! -d "$VODOU_DIR" ]; then
  echo "[stop-vodou-stack] ERROR: VODOU_DIR required. Usage: $0 /path/to/project-root" >&2
  exit 1
fi

mkdir -p "$VODOU_DIR/.oi"
STLOG="$VODOU_DIR/.vodou/system.log"
exec >>"$STLOG" 2>&1
echo "--- [$(date -u +%Y-%m-%dT%H:%M:%SZ)] stop-vodou-stack start ---"

# Read WEB_PORT from .env (default 8765)
WEB_PORT=8765
strip_env_val() {
  local v="$1"
  v="${v#\"}" ; v="${v%\"}" ; v="${v#\'}" ; v="${v%\'}"
  echo "$v"
}
if [ -f "$VODOU_DIR/.env" ]; then
  v=$(grep -m1 '^WEB_PORT=' "$VODOU_DIR/.env" 2>/dev/null | cut -d= -f2- || true)
  v=$(strip_env_val "$v")
  [ -n "${v:-}" ] && WEB_PORT="$v"
fi
if [ -f "$VODOU_DIR/MCP-servers/Vodou-Console/.env" ]; then
  v=$(grep -m1 '^WEB_PORT=' "$VODOU_DIR/MCP-servers/Vodou-Console/.env" 2>/dev/null | cut -d= -f2- || true)
  v=$(strip_env_val "$v")
  [ -n "${v:-}" ] && WEB_PORT="$v"
fi

# 1. Stop gateway — kill by port
echo "[stop-vodou-stack] stopping gateway on :$WEB_PORT"
if command -v lsof >/dev/null 2>&1; then
  # -sTCP:LISTEN is load-bearing: without it lsof also returns processes holding
  # a *client* connection to :$WEB_PORT (Chrome/extension, curl) and we'd kill them.
  for pid in $(lsof -ti ":$WEB_PORT" -sTCP:LISTEN 2>/dev/null || true); do
    echo "[stop-vodou-stack] kill PID $pid (listener on :$WEB_PORT)"
    kill "$pid" 2>/dev/null || true
  done
fi
sleep 1

# 2. Stop daemon — via PID file
echo "[stop-vodou-stack] stopping daemon"
if [ -f "$VODOU_DIR/.vodou/daemon.pid" ]; then
  dp=$(tr -d ' \n\r' < "$VODOU_DIR/.vodou/daemon.pid" || true)
  if [ -n "${dp:-}" ] && kill -0 "$dp" 2>/dev/null; then
    echo "[stop-vodou-stack] kill PID $dp (daemon.pid)"
    kill "$dp" 2>/dev/null || true
  fi
fi
sleep 1
pkill -f '[b]rain-trust4.*daemon' 2>/dev/null || true
sleep 1

# 3. Stop worker — via vodou-core worker stop
echo "[stop-vodou-stack] stopping worker"
if [ -x "$VODOU_DIR/vodou-core" ]; then
  "$VODOU_DIR/vodou-core" worker stop 2>/dev/null \
    || echo "[stop-vodou-stack] worker stop skipped or failed (ok)"
fi
sleep 1

echo "[stop-vodou-stack] all services stopped"
echo "--- [$(date -u +%Y-%m-%dT%H:%M:%SZ)] stop-vodou-stack done ---"
