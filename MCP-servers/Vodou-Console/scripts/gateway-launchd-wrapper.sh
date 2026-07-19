#!/usr/bin/env bash
# LaunchAgent entrypoint: start the gateway only when nothing healthy is on WEB_PORT.
# Prevents KeepAlive respawn storms and EADDRINUSE crashes when a peer already listens.
set -euo pipefail

GATEWAY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VODOU_DIR="$(cd "${GATEWAY_DIR}/../.." && pwd)"
WEB_PORT="${WEB_PORT:-8765}"

strip_env_val() { local v="$1"; v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"; echo "$v"; }
for envf in "$VODOU_DIR/.env" "$GATEWAY_DIR/.env"; do
  [ -f "$envf" ] || continue
  v=$(grep -m1 '^WEB_PORT=' "$envf" 2>/dev/null | cut -d= -f2- || true)
  v=$(strip_env_val "$v")
  [ -n "${v:-}" ] && WEB_PORT="$v"
done

if curl -fsS -m 5 "http://127.0.0.1:${WEB_PORT}/health" 2>/dev/null | grep -q '"status"'; then
  exit 0
fi

cd "$GATEWAY_DIR"
export VODOU_PROJECT_PATH="$VODOU_DIR"
GW_NODE="$VODOU_DIR/.node/node"
if [ ! -x "$GW_NODE" ]; then
  GW_NODE="$(command -v node || true)"
fi
if [ -z "$GW_NODE" ]; then
  echo "[gateway-launchd-wrapper] node not found" >&2
  exit 1
fi
exec "$GW_NODE" dist/index.js
