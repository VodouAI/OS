#!/usr/bin/env bash

# P4 — this entrypoint declares its stack (stacks.toml). Read by
# `vodou-core stacks`, the exec-world seam, and the receipt, so a lane
# that is off in this composition renders `off (stack)` rather than
# absent — indistinguishable from a lane that failed.
export VODOU_STACK="${VODOU_STACK:-web}"
# Safe gateway restart: unload launchd duplicate, stop listener, rebuild dist, fix worker, start once.
# Usage: ./scripts/restart-gateway.sh
set -euo pipefail

VODOU_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$VODOU_DIR"
GW_DIR="$VODOU_DIR/MCP-servers/Vodou-Console"
STLOG="$VODOU_DIR/.vodou/system.log"
# The gateway gets its OWN log, like brain-console and vodou-one already do.
#
# It used to append to system.log, which every short-lived `vodou-core`
# invocation also writes to — and with DEBUG=1 in .env each of those dumps its
# credential-loading and DB-open lines. The board notifier alone runs every 5s,
# so ~23% of system.log was that spam (462 of 2000 lines measured 2026-08-24)
# and a gateway turn could not be read out of it. Diagnosing the gateway is
# exactly when you need its log to be legible.
GWLOG="$VODOU_DIR/.vodou/logs/gateway.log"
mkdir -p "$VODOU_DIR/.vodou" "$VODOU_DIR/.vodou/logs" "$GW_DIR/logs"

WEB_PORT="${WEB_PORT:-8765}"
strip_env_val() { local v="$1"; v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"; echo "$v"; }
for envf in "$VODOU_DIR/.env" "$GW_DIR/.env"; do
  [ -f "$envf" ] || continue
  v=$(grep -m1 '^WEB_PORT=' "$envf" 2>/dev/null | cut -d= -f2- || true)
  v=$(strip_env_val "$v")
  [ -n "${v:-}" ] && WEB_PORT="$v"
  v=$(grep -m1 '^VODOU_BRAIN_STANDALONE=' "$envf" 2>/dev/null | cut -d= -f2- || true)
  v=$(strip_env_val "$v")
  [ -n "${v:-}" ] && VODOU_BRAIN_STANDALONE="$v"
done
# PLAN-BRAIN-INTO-CONSOLE: the graph is in the gateway (#/memory?tab=map); the
# standalone :8767 twin is opt-in.
VODOU_BRAIN_STANDALONE="${VODOU_BRAIN_STANDALONE:-0}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [restart-gateway] $*" | tee -a "$STLOG"; }

# ── Aux surfaces: ensure-only ────────────────────────────────────────────────
# stop-vodou-services.sh §1b STOPS the brain console (:8767) and Vodou One
# (:8768); start-vodou-services.sh §5.8/5.9 START them. This script sat between
# the two and did neither, so a stop (or a silent death) followed by a
# restart-gateway left them down with nothing reporting it: the gateway is
# healthy, the console works, and 8767 just refuses connections until someone
# visits it. Found 2026-08-20 with the brain console down since the previous
# morning — restart-gateway had run in between and could not have brought it
# back.
#
# ENSURE-ONLY, deliberately. We probe identity and start ONLY when the port is
# free. The reclaim / stale-build / kill half of probe_aux_port stays in
# start-vodou-services.sh, which owns port-ownership decisions: a gateway-repair
# tool must never fight for a port it does not own, and never restart a server
# that is answering. Worst case here is a no-op plus a log line.
#
# Never fatal: an aux surface that will not start must not fail the gateway
# restart this script exists to perform, so every path returns 0.

# Node good enough for the aux surfaces. Mirrors aux_node() in
# start-vodou-services.sh: both surfaces are ESM and the brain opens memory.db
# through `node:sqlite`, which only exists in 22.13+/24+. An older node dies on
# import while the spawn still looks like it worked, so gate before spawning.
# Empty output = no usable node; callers report, they do not spawn.
aux_node() {
  local n="$VODOU_DIR/.node/node" v major rest minor
  [ -x "$n" ] && { echo "$n"; return 0; }
  n="$(command -v node 2>/dev/null || true)"
  [ -n "$n" ] || return 0
  v="$("$n" --version 2>/dev/null | sed 's/^v//')"
  major="${v%%.*}"; rest="${v#*.}"; minor="${rest%%.*}"
  [ -n "$major" ] || return 0
  if [ "$major" -gt 22 ] 2>/dev/null; then echo "$n"; return 0; fi
  if [ "$major" = "22" ] && [ "${minor:-0}" -ge 13 ] 2>/dev/null; then echo "$n"; fi
  return 0
}

# ensure_aux_surface <name> <port> <probe_url> <probe_match> <spawn_fn> <log_file>
# spawn_fn is a shell function name so each surface keeps its own env/launchd
# rules instead of this helper growing a string it has to eval.
ensure_aux_surface() {
  local name="$1" port="$2" probe_url="$3" probe_match="$4" spawn_fn="$5" log_file="$6"
  local holders=""

  # Identity, not presence: the real server answers THIS route with THIS text.
  # A squatting gateway 404s here, so it cannot pass (the seven-week squatter
  # incident behind start-vodou-services.sh's port guard).
  if curl -fsS -m 3 "$probe_url" 2>/dev/null | grep -q "$probe_match"; then
    log "$name already running ($probe_url)"
    return 0
  fi

  command -v lsof >/dev/null 2>&1 && holders="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$holders" ]; then
    log "$name NOT started — :$port is held by something that failed its identity probe:"
    # `|| true`: lsof exits 1 when it matches nothing, and under `set -o pipefail`
    # that would abort the whole restart if the holder exits in the window
    # between the two lsof calls.
    lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | sed -n '2,3p' | sed 's/^/        /' | tee -a "$STLOG" || true
    log "  Left alone on purpose. Reclaiming a port belongs to ./start-vodou-services.sh"
    return 0
  fi

  if [ -z "$(aux_node)" ]; then
    log "$name NOT started — needs Node 22.13+ (found: $(node --version 2>/dev/null || echo 'no node on PATH'))"
    return 0
  fi

  mkdir -p "$VODOU_DIR/.vodou/logs"
  "$spawn_fn" || true

  # Probe, don't assume: a server that dies on import looks exactly like a
  # healthy one to the spawning shell.
  local i
  for i in 1 2 3 4 5; do
    sleep 1
    if curl -fsS -m 1 "$probe_url" 2>/dev/null | grep -q "$probe_match"; then
      log "$name started ($probe_url)"
      return 0
    fi
  done
  log "$name FAILED to answer on :$port within 5s"
  if [ -s "$log_file" ]; then
    log "  ── last 10 lines of $log_file ──"
    tail -n 10 "$log_file" 2>/dev/null | sed 's/^/        /' | tee -a "$STLOG" || true
  fi
  return 0
}

# Spawns use `</dev/null` + `disown`, not `( … & )`: the subshell form outlived
# this script with node as its child (2026-08-16), so a caller reaping the
# process group could take the service down with it. Same idiom as the gateway
# spawn at the bottom of this file.
spawn_brain_console() {
  local node; node="$(aux_node)"
  pushd "$VODOU_DIR" >/dev/null
  nohup env BRAIN_PORT="$BRAIN_PORT" "$node" "$VODOU_DIR/MCP-servers/brain/dist/serve.js" \
    </dev/null >>"$VODOU_DIR/.vodou/logs/brain-console.log" 2>&1 &
  disown
  popd >/dev/null
}

spawn_vodou_one() {
  local node; node="$(aux_node)"
  # If One is launchd-managed (one/services/install.sh, com.vodou.one.web,
  # KeepAlive=true), hand it back to launchd rather than starting a second
  # ad-hoc copy — stop-vodou-services.sh boots that job out, so spawning here
  # would silently downgrade an always-on install to a process that dies with
  # its parent. Same rule as start-vodou-services.sh §5.9.
  local plist="$HOME/Library/LaunchAgents/com.vodou.one.web.plist"
  if [ "$(uname -s)" = "Darwin" ] && [ -f "$plist" ] && command -v launchctl >/dev/null 2>&1; then
    if launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null; then
      log "Vodou One handed back to launchd (com.vodou.one.web)"
      return 0
    fi
  fi
  # WEB_PORT/BRAIN_PORT ride along because server.mjs proxies /api,/chat,/v1 →
  # gateway and /brain-api → brain, reading both from its own env: without them
  # the proxy defaults to 8765/8767 on an install that moved either port.
  pushd "$VODOU_DIR" >/dev/null
  nohup env VODOU_ONE_PORT="$ONE_PORT" WEB_PORT="$WEB_PORT" BRAIN_PORT="$BRAIN_PORT" \
    "$node" "$VODOU_DIR/one/web/server.mjs" \
    </dev/null >>"$VODOU_DIR/.vodou/logs/vodou-one.log" 2>&1 &
  disown
  popd >/dev/null
}

ensure_aux_surfaces() {
  if [ "$VODOU_BRAIN_STANDALONE" != "1" ]; then
    log "Brain console: embedded in the gateway (#/memory?tab=map); standalone :$BRAIN_PORT is opt-in (VODOU_BRAIN_STANDALONE=1)"
  elif [ -f "$VODOU_DIR/MCP-servers/brain/dist/serve.js" ]; then
    ensure_aux_surface "Brain console" "$BRAIN_PORT" \
      "http://127.0.0.1:$BRAIN_PORT/api/brain/overview" '"chunks_live"' \
      spawn_brain_console "$VODOU_DIR/.vodou/logs/brain-console.log"
  else
    log "Brain console skipped — MCP-servers/brain/dist/serve.js missing (cd MCP-servers/brain && npm run build)"
  fi

  if [ "${VODOU_ONE_DISABLE:-0}" != "1" ] && [ -f "$VODOU_DIR/one/web/server.mjs" ]; then
    ensure_aux_surface "Vodou One" "$ONE_PORT" \
      "http://127.0.0.1:$ONE_PORT/health" 'vodou-one' \
      spawn_vodou_one "$VODOU_DIR/.vodou/logs/vodou-one.log"
  fi
  return 0
}

BRAIN_PORT="${BRAIN_PORT:-8767}"
ONE_PORT="${VODOU_ONE_PORT:-8768}"

log "start (WEB_PORT=$WEB_PORT)"

# Active-turn guard (same contract as stop-vodou-services.sh): refuse to kill
# a gateway that is mid-chat unless VODOU_FORCE_STOP=1. Killing a streaming
# gateway drops the user's live conversation (2026-07-16 incident).
#
# 2026-08-17: the guard fired but did not save the turn — a silent/slow /health
# used to mean "proceed", and a gateway whose event loop is busy serving a turn
# is exactly the one that answers slowly. Now it fails CLOSED: no answer while
# the port is still held = refuse. A gateway that is truly gone (nothing
# listening) is still restartable with no flag, which is the recovery case this
# script exists for.
if [ "${VODOU_FORCE_STOP:-0}" != "1" ] && command -v curl >/dev/null 2>&1; then
  health="$(curl -fsS -m 10 "http://127.0.0.1:$WEB_PORT/health" 2>/dev/null || true)"
  listening=""
  command -v lsof >/dev/null 2>&1 && listening="$(lsof -tiTCP:"$WEB_PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$health" ]; then
    pending=$(printf '%s' "$health" | grep -o '"pendingSessions":[0-9]*' | grep -o '[0-9]*$' || echo 0)
    queued=$(printf '%s' "$health" | grep -o '"queuedTurns":[0-9]*' | grep -o '[0-9]*$' || echo 0)
    if [ "${pending:-0}" -gt 0 ] || [ "${queued:-0}" -gt 0 ]; then
      log "REFUSING to restart: gateway has $pending active + $queued queued turn(s) in flight."
      log "  Wait for the turn to finish, or force with: VODOU_FORCE_STOP=1 $0"
      exit 2
    fi
  elif [ -n "$listening" ]; then
    log "REFUSING to restart: :$WEB_PORT is listening but /health did not answer in 10s —"
    log "  cannot tell a wedged gateway from one busy streaming a turn."
    log "  Force with: VODOU_FORCE_STOP=1 $0"
    exit 2
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

# The instant this restart began. The check at the bottom compares the LISTENER's
# start time against it — see "did the restart actually take" there.
RESTART_EPOCH="$(date +%s)"

log "start gateway (single instance)"
export VODOU_PROJECT_PATH="$VODOU_DIR"
export VODOU_NO_OPEN_BROWSER=1
export START_AIGATEWAY=1
# Do not run full start-vodou-services (avoids duplicate gateway kill/start races)
GW_NODE="$VODOU_DIR/.node/node"
[ ! -x "$GW_NODE" ] && GW_NODE="$(command -v node)"
# Spawn fully detached: stdin from /dev/null and `disown`, so the spawning shell
# never lingers as the gateway's parent holding a caller's pipe open (observed
# 2026-08-16: the `( … & )` subshell outlived the script with node as its child,
# and a caller that reaped the process group would have taken the gateway down).
pushd "$GW_DIR" >/dev/null
nohup env VODOU_PROJECT_PATH="$VODOU_DIR" "$GW_NODE" dist/index.js </dev/null >>"$GWLOG" 2>&1 &
disown
popd >/dev/null

GW_OK=0
for _ in 1 2 3 4 5 6 7 8 9 10 12 14 16 18 20; do
  sleep 1
  if curl -fsS -m 2 "http://127.0.0.1:${WEB_PORT}/health" 2>/dev/null | grep -q '"status"'; then
    log "health OK"
    curl -fsS -m 2 "http://127.0.0.1:${WEB_PORT}/health" | head -c 240
    echo ""
    GW_OK=1
    break
  fi
done

# Aux surfaces last, and on BOTH paths: the brain console reads memory.db
# directly and does not depend on the gateway, so a gateway that failed to come
# up is no reason to leave :8767 dead. Never fatal — the exit code below still
# reports the gateway, which is what callers of this script act on.
log "ensuring aux surfaces (brain :$BRAIN_PORT, vodou-one :$ONE_PORT)"
ensure_aux_surfaces

# ── Did the restart actually TAKE? ───────────────────────────────────────────
#
# `/health` answering proves SOMETHING healthy is listening. It does not prove it
# is the process this script just started — and when it is not, this printed
# "done" over a gateway still running the old build. That cost two debugging
# rounds on 2026-08-25, both spent chasing a code change that was never loaded;
# the tell was a listener whose start time predated the build.
#
# So: compare the listener's start time to when this run began. Older means the
# old process survived (a refused kill, a launchd respawn, a second instance) and
# the caller is about to test code that is not running.
if [ "$GW_OK" = "1" ] && command -v lsof >/dev/null 2>&1; then
  listener="$(lsof -tiTCP:"$WEB_PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  if [ -n "$listener" ]; then
    # `ps -o lstart=` is portable here (macOS + Linux) where `--start-time` is not.
    started_at="$(ps -o lstart= -p "$listener" 2>/dev/null | sed 's/^ *//')"
    started_epoch="$(date -j -f "%a %b %d %T %Y" "$started_at" +%s 2>/dev/null \
                     || date -d "$started_at" +%s 2>/dev/null || echo 0)"
    # Compared against the BUILD, not against this script's start time.
    #
    # The first cut compared to when the run began and answered "did THIS run
    # start the listener" — which is not the question. A second restart then
    # flagged a listener the FIRST restart had correctly started, because it
    # predated the second run. What actually matters is whether the process is
    # running the current bytes.
    build_epoch=0
    if [ -f "$GW_DIR/dist/index.js" ]; then
      build_epoch="$(stat -f %m "$GW_DIR/dist/index.js" 2>/dev/null \
                     || stat -c %Y "$GW_DIR/dist/index.js" 2>/dev/null || echo 0)"
    fi
    if [ "${started_epoch:-0}" -gt 0 ] && [ "${build_epoch:-0}" -gt 0 ] \
       && [ "$started_epoch" -lt "$build_epoch" ]; then
      log "ERROR: :$WEB_PORT is healthy but the listener (pid $listener) predates the BUILD."
      log "  It started $started_at; dist/index.js is newer. The old gateway survived,"
      log "  so what you just built is NOT what is serving. Reported as a failure rather"
      log "  than 'done', because a green line here is what sends someone debugging code"
      log "  that never loaded."
      log "  Try: VODOU_FORCE_STOP=1 $0"
      exit 3
    fi
    log "listener pid $listener started $started_at (newer than dist/index.js)"
  fi
fi

if [ "$GW_OK" = "1" ]; then
  log "gateway log: $GWLOG"
  log "done — http://localhost:${WEB_PORT}/"
  exit 0
fi

log "ERROR: /health failed after 20s — see $GWLOG (the gateway's own output)"
exit 1
