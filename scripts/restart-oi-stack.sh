#!/usr/bin/env bash
# Kill gateway (WEB_PORT), Vodou daemon, and worker; then run start-vodou-services.sh.
# Invoked detached from the gateway (HTTP 202 is returned before this runs).
set -uo pipefail

VODOU_DIR="${1:-}"
if [ -z "$VODOU_DIR" ] || [ ! -d "$VODOU_DIR" ]; then
  echo "[restart-vodou-stack] Invalid VODOU_DIR" >&2
  exit 1
fi

mkdir -p "$VODOU_DIR/.oi"
STLOG="$VODOU_DIR/.vodou/system.log"
exec >>"$STLOG" 2>&1
echo "--- [$(date -u +%Y-%m-%dT%H:%M:%SZ)] restart-vodou-stack start ---"

sleep 2

WEB_PORT=8765
strip_env_val() {
  local v="$1"
  v="${v#\"}"
  v="${v%\"}"
  v="${v#\'}"
  v="${v%\'}"
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

# Active-turn guard (same contract as stop-vodou-services.sh): refuse to kill
# a gateway that is mid-chat. /health reports turns in flight; killing then
# drops a live conversation mid-stream (2026-07-16 incident). Force with
# VODOU_FORCE_STOP=1.
#
# 2026-08-17: fails CLOSED. A silent/slow /health used to mean "proceed", but a
# gateway busy serving a turn is exactly the one that answers slowly — so no
# answer while the port is still held = refuse. A gateway that is truly gone
# (nothing listening) is still restartable with no flag.
if [ "${VODOU_FORCE_STOP:-0}" != "1" ] && command -v curl >/dev/null 2>&1; then
  health="$(curl -fsS -m 10 "http://127.0.0.1:$WEB_PORT/health" 2>/dev/null || true)"
  listening=""
  command -v lsof >/dev/null 2>&1 && listening="$(lsof -tiTCP:"$WEB_PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$health" ]; then
    pending=$(printf '%s' "$health" | grep -o '"pendingSessions":[0-9]*' | grep -o '[0-9]*$' || echo 0)
    queued=$(printf '%s' "$health" | grep -o '"queuedTurns":[0-9]*' | grep -o '[0-9]*$' || echo 0)
    if [ "${pending:-0}" -gt 0 ] || [ "${queued:-0}" -gt 0 ]; then
      echo "[restart-vodou-stack] REFUSING: gateway has $pending active + $queued queued turn(s) in flight."
      echo "[restart-vodou-stack] Wait for the turn to finish, or force with VODOU_FORCE_STOP=1."
      exit 2
    fi
  elif [ -n "$listening" ]; then
    echo "[restart-vodou-stack] REFUSING: :$WEB_PORT is listening but /health did not answer in 10s —"
    echo "[restart-vodou-stack] cannot tell a wedged gateway from one busy streaming a turn."
    echo "[restart-vodou-stack] Force with VODOU_FORCE_STOP=1."
    exit 2
  fi
fi

echo "[restart-vodou-stack] stop gateway :$WEB_PORT"
if command -v lsof >/dev/null 2>&1; then
  for pid in $(lsof -ti ":$WEB_PORT" 2>/dev/null || true); do
    echo "[restart-vodou-stack] kill PID $pid (listener on $WEB_PORT)"
    kill "$pid" 2>/dev/null || true
  done
fi
sleep 1

echo "[restart-vodou-stack] stop daemon"
if [ -f "$VODOU_DIR/.vodou/daemon.pid" ]; then
  dp=$(tr -d ' \n\r' < "$VODOU_DIR/.vodou/daemon.pid" || true)
  if [ -n "${dp:-}" ] && kill -0 "$dp" 2>/dev/null; then
    echo "[restart-vodou-stack] kill PID $dp (daemon.pid)"
    kill "$dp" 2>/dev/null || true
  fi
fi
sleep 1
pkill -f "$VODOU_DIR/vodou-core daemon" 2>/dev/null || true
sleep 1

echo "[restart-vodou-stack] worker stop"
if [ -x "$VODOU_DIR/vodou-core" ]; then
  "$VODOU_DIR/vodou-core" worker stop 2>/dev/null || echo "[restart-vodou-stack] worker stop skipped or failed (ok)"
fi
sleep 1

START_SCRIPT="$VODOU_DIR/start-vodou-services.sh"
if [ -f "$START_SCRIPT" ]; then
  echo "[restart-vodou-stack] $START_SCRIPT"
  export VODOU_PROJECT_PATH="$VODOU_DIR"
  bash "$START_SCRIPT" || echo "[restart-vodou-stack] start-vodou-services.sh exit $?"
else
  echo "[restart-vodou-stack] ERROR: start-vodou-services.sh not found at $START_SCRIPT"
fi

echo "--- [$(date -u +%Y-%m-%dT%H:%M:%SZ)] restart-vodou-stack done ---"
