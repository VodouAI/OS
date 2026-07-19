#!/usr/bin/env bash
# Safe gateway restart: unload launchd duplicate, stop listener, rebuild dist, fix worker, start once.
# Usage: ./scripts/restart-gateway.sh
set -euo pipefail

VODOU_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$VODOU_DIR"
GW_DIR="$VODOU_DIR/MCP-servers/Vodou-Console"
STLOG="$VODOU_DIR/.vodou/system.log"
mkdir -p "$VODOU_DIR/.vodou" "$GW_DIR/logs"

WEB_PORT="${WEB_PORT:-8765}"
strip_env_val() { local v="$1"; v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"; echo "$v"; }
for envf in "$VODOU_DIR/.env" "$GW_DIR/.env"; do
  [ -f "$envf" ] || continue
  v=$(grep -m1 '^WEB_PORT=' "$envf" 2>/dev/null | cut -d= -f2- || true)
  v=$(strip_env_val "$v")
  [ -n "${v:-}" ] && WEB_PORT="$v"
done

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [restart-gateway] $*" | tee -a "$STLOG"; }

log "start (WEB_PORT=$WEB_PORT)"

# Active-turn guard (same contract as stop-vodou-services.sh): refuse to kill
# a gateway that is mid-chat unless VODOU_FORCE_STOP=1. Killing a streaming
# gateway drops the user's live conversation (2026-07-16 incident). An
# unreachable gateway is still restartable — that is what this script is for.
if [ "${VODOU_FORCE_STOP:-0}" != "1" ] && command -v curl >/dev/null 2>&1; then
  health="$(curl -fsS -m 5 "http://127.0.0.1:$WEB_PORT/health" 2>/dev/null || true)"
  if [ -n "$health" ]; then
    pending=$(printf '%s' "$health" | grep -o '"pendingSessions":[0-9]*' | grep -o '[0-9]*$' || echo 0)
    queued=$(printf '%s' "$health" | grep -o '"queuedTurns":[0-9]*' | grep -o '[0-9]*$' || echo 0)
    if [ "${pending:-0}" -gt 0 ] || [ "${queued:-0}" -gt 0 ]; then
      log "REFUSING to restart: gateway has $pending active + $queued queued turn(s) in flight."
      log "  Wait for the turn to finish, or force with: VODOU_FORCE_STOP=1 $0"
      exit 2
    fi
  fi
fi

# Prefer no launchd fight while we manage the process manually
if command -v launchctl >/dev/null 2>&1; then
  uid="$(id -u)"
  launchctl bootout "gui/${uid}/com.vodou.console" 2>/dev/null || true
  plist="$HOME/Library/LaunchAgents/com.vodou.console.plist"
  [ -f "$plist" ] && launchctl bootout "gui/${uid}" "$plist" 2>/dev/null || true
fi

# Graceful stop: let in-flight chats drain unless caller overrides.
# NOTE: the SIGKILL fallback must wait OUT the grace window — the old
# `sleep 3` here SIGKILLed the gateway 3s into its own 45s drain, defeating
# the grace period it just configured.
export VODOU_GATEWAY_SHUTDOWN_GRACE_MS="${VODOU_GATEWAY_SHUTDOWN_GRACE_MS:-45000}"
if command -v lsof >/dev/null 2>&1; then
  for pid in $(lsof -tiTCP:"$WEB_PORT" -sTCP:LISTEN 2>/dev/null || true); do
    log "SIGTERM gateway listener PID $pid"
    kill "$pid" 2>/dev/null || true
  done
fi
GRACE_SECS=$(( (${VODOU_GATEWAY_SHUTDOWN_GRACE_MS:-45000} / 1000) + 10 ))
waited=0
while [ "$waited" -lt "$GRACE_SECS" ]; do
  [ -z "$(lsof -tiTCP:"$WEB_PORT" -sTCP:LISTEN 2>/dev/null || true)" ] && break
  sleep 2
  waited=$((waited + 2))
done
if command -v lsof >/dev/null 2>&1; then
  for pid in $(lsof -tiTCP:"$WEB_PORT" -sTCP:LISTEN 2>/dev/null || true); do
    log "SIGKILL gateway listener PID $pid (still alive after ${waited}s grace)"
    kill -9 "$pid" 2>/dev/null || true
  done
fi
sleep 1

# Rotate huge stderr log (keeps last 2000 lines)
ERR_LOG="$GW_DIR/logs/gateway-stderr.log"
if [ -f "$ERR_LOG" ]; then
  lines=$(wc -l < "$ERR_LOG" | tr -d ' ')
  if [ "${lines:-0}" -gt 50000 ]; then
    log "rotating $ERR_LOG ($lines lines)"
    tail -n 2000 "$ERR_LOG" > "${ERR_LOG}.tmp" && mv "${ERR_LOG}.tmp" "$ERR_LOG"
  fi
fi

log "npm run build (Vodou-Console)"
(cd "$GW_DIR" && npm run build)

log "worker stop + cleanup"
if [ -x "$VODOU_DIR/vodou-core" ]; then
  VODOU_GATEWAY_SHUTDOWN_GRACE_MS=0 "$VODOU_DIR/vodou-core" worker stop 2>/dev/null || true
  pkill -f "$VODOU_DIR/vodou-core worker" 2>/dev/null || true
  sleep 1
  rm -f "$VODOU_DIR/.vodou/worker.sock" "$VODOU_DIR/.vodou/worker.lock" 2>/dev/null || true
  if "$VODOU_DIR/vodou-core" worker start --background 2>>"$STLOG"; then
    log "worker start --background OK"
  else
    log "worker start failed — see $STLOG"
  fi
  sleep 2
fi

log "daemon ensure"
if [ -x "$VODOU_DIR/vodou-core" ]; then
  "$VODOU_DIR/vodou-core" daemon ensure 2>/dev/null || true
fi

log "start gateway (single instance)"
export VODOU_PROJECT_PATH="$VODOU_DIR"
export VODOU_NO_OPEN_BROWSER=1
export START_AIGATEWAY=1
# Do not run full start-vodou-services (avoids duplicate gateway kill/start races)
GW_NODE="$VODOU_DIR/.node/node"
[ ! -x "$GW_NODE" ] && GW_NODE="$(command -v node)"
(cd "$GW_DIR" && nohup env VODOU_PROJECT_PATH="$VODOU_DIR" "$GW_NODE" dist/index.js >>"$STLOG" 2>&1 &)

for _ in 1 2 3 4 5 6 7 8 9 10 12 14 16 18 20; do
  sleep 1
  if curl -fsS -m 2 "http://127.0.0.1:${WEB_PORT}/health" 2>/dev/null | grep -q '"status"'; then
    log "health OK"
    curl -fsS -m 2 "http://127.0.0.1:${WEB_PORT}/health" | head -c 240
    echo ""
    log "done — http://localhost:${WEB_PORT}/"
    exit 0
  fi
done

log "ERROR: /health failed after 20s — see $STLOG and $GW_DIR/logs/gateway-stderr.log"
exit 1
