#!/usr/bin/env bash

# P4 — this entrypoint declares its stack (stacks.toml). Read by
# `vodou-core stacks`, the exec-world seam, and the receipt, so a lane
# that is off in this composition renders `off (stack)` rather than
# absent — indistinguishable from a lane that failed.
export VODOU_STACK="${VODOU_STACK:-web}"
# Stop Vodou gateway, daemon, and worker — counterpart to start-vodou-services.sh.
# Order matters: (macOS) launchd bootout for plist-managed jobs → gateway → daemon → worker.
#
# Usage:
#   ./stop-vodou-services.sh                    # stops services in current dir
#   ./stop-vodou-services.sh /path/to/install   # stops services in given install dir
set -uo pipefail

VODOU_DIR="${1:-$(pwd)}"
if [ ! -d "$VODOU_DIR" ]; then
  echo "[stop-vodou-services] ERROR: '$VODOU_DIR' is not a directory" >&2
  exit 1
fi
VODOU_DIR="$(cd "$VODOU_DIR" && pwd)"

mkdir -p "$VODOU_DIR/.vodou"
STLOG="$VODOU_DIR/.vodou/system.log"
TS() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(TS)] [stop] $*" | tee -a "$STLOG"; }

log "stop-vodou-services start ($VODOU_DIR)"

# macOS: unload LaunchAgents that use KeepAlive — otherwise launchd respawns
# gateway (com.vodou.console) and daemon (com.vodou.daemon) as soon as we kill PIDs.
unload_vodou_launchd() {
  [[ "$(uname -s)" == "Darwin" ]] || return 0
  command -v launchctl >/dev/null 2>&1 || return 0
  local uid plist label
  uid="$(id -u)"
  # Per-install gateway plists are com.vodou.console.<hash>; glob them all,
  # plus the legacy fixed-label jobs (daemon + pre-rename console/oi-daemon).
  local plists=()
  for p in "$HOME/Library/LaunchAgents/"com.vodou.console*.plist; do
    [[ -e "$p" ]] && plists+=("$p")
  done
  # com.vodou.one.web is the Vodou One shell (one/services/install.sh), and it
  # is KeepAlive=true — SIGTERMing its PID in section 1b below would just make
  # launchd respawn it, so it has to be booted out here like the others.
  # start-vodou-services.sh 5.9 bootstraps it back when the plist exists.
  for label in com.vodou.daemon com.oios.oi-daemon com.vodou.one.web; do
    plists+=("$HOME/Library/LaunchAgents/${label}.plist")
  done
  for plist in "${plists[@]}"; do
    label="$(basename "${plist%.plist}")"
    log "launchd bootout ${label}"
    # Ventura+: bootout by plist path; Sonoma+: domain-target gui/UID/Label if plist missing
    launchctl bootout "gui/${uid}/${label}" 2>/dev/null || true
    if [[ -f "$plist" ]]; then
      launchctl bootout "gui/${uid}" "$plist" 2>/dev/null || true
      launchctl unload "$plist" 2>/dev/null || true
    fi
  done
}

# Absolute cwd of a running PID — proves whether a listener belongs to THIS
# install. Same probe start-vodou-services.sh uses for its port-takeover guard;
# duplicated rather than shared because these two scripts are standalone and
# neither sources the other. Empty output means "could not determine", which
# callers must treat as "not provably ours" and leave alone.
pid_cwd() {
  local pid="$1" d=""
  [ -n "$pid" ] || return 0
  if [ -r "/proc/$pid/cwd" ]; then
    d=$(readlink -f "/proc/$pid/cwd" 2>/dev/null)                              # Linux
  elif command -v lsof >/dev/null 2>&1; then
    d=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1) # macOS
  fi
  [ -n "$d" ] || return 0
  (cd "$d" 2>/dev/null && pwd -P) || true
}

# Stop a listener on an aux port, but ONLY when it is provably this install's.
# Never SIGTERM a port owner we cannot identify: 8767/8768 are ordinary ports
# and someone else's dev server can legitimately hold them.
stop_aux_port() {
  local port="$1" label="$2" pid got killed=""
  [ -n "$port" ] || return 0
  [ "$port" = "$WEB_PORT" ] && return 0   # section 1 already handled this one
  command -v lsof >/dev/null 2>&1 || return 0
  for pid in $(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true); do
    got=$(pid_cwd "$pid")
    case "${got:-}" in
      "$VODOU_DIR"|"$VODOU_DIR"/*)
        log "  kill PID $pid ($label listener on :$port)"
        kill "$pid" 2>/dev/null || true
        killed="$killed $pid"
        ;;
      "")
        log "  skip PID $pid on :$port ($label) — cwd unreadable, not provably ours"
        ;;
      *)
        log "  skip PID $pid on :$port ($label) — belongs to another install ($got)"
        ;;
    esac
  done
  # Escalate only against the PIDs we already proved were ours. A half-dead
  # server that survives SIGTERM keeps the port and makes the next start print
  # "already running" for a corpse — the exact bug this section exists to stop.
  if [ -n "$killed" ]; then
    sleep 2
    for pid in $killed; do
      if kill -0 "$pid" 2>/dev/null; then
        log "  SIGKILL PID $pid ($label still alive)"
        kill -9 "$pid" 2>/dev/null || true
      fi
    done
  fi
}

# Resolve WEB_PORT (default 8765) from .env files
strip_env_val() { local v="$1"; v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"; echo "$v"; }
WEB_PORT=8765
for envf in "$VODOU_DIR/.env" "$VODOU_DIR/MCP-servers/Vodou-Console/.env"; do
  [ -f "$envf" ] || continue
  v=$(grep -m1 '^WEB_PORT=' "$envf" 2>/dev/null | cut -d= -f2- || true)
  v=$(strip_env_val "$v")
  [ -n "${v:-}" ] && WEB_PORT="$v"
done

# 0. Active-turn guard — refuse to kill a gateway that is mid-chat.
# Incident 2026-07-16: a parallel dev session ran stop+start while a deep
# thinking session was streaming in the web UI; the SIGTERM dropped the turn
# and the user lost everything on screen. /health already reports how many
# CLI-pool sessions have a turn in flight (pendingSessions) and how many
# turns are queued behind them (queuedTurns) — if either is nonzero, someone
# is mid-conversation. Skip with VODOU_FORCE_STOP=1.
#
# 2026-08-17: fails CLOSED now. A silent/slow /health used to mean "proceed",
# but a gateway busy serving a turn is exactly the one that answers slowly —
# so no answer while the port is still held = refuse. Nothing listening on the
# port is still stoppable with no flag.
if [ "${VODOU_FORCE_STOP:-0}" != "1" ] && command -v curl >/dev/null 2>&1; then
  health="$(curl -fsS -m 10 "http://127.0.0.1:$WEB_PORT/health" 2>/dev/null || true)"
  listening=""
  command -v lsof >/dev/null 2>&1 && listening="$(lsof -tiTCP:"$WEB_PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$health" ]; then
    pending=$(printf '%s' "$health" | grep -o '"pendingSessions":[0-9]*' | grep -o '[0-9]*$' || echo 0)
    queued=$(printf '%s' "$health" | grep -o '"queuedTurns":[0-9]*' | grep -o '[0-9]*$' || echo 0)
    if [ "${pending:-0}" -gt 0 ] || [ "${queued:-0}" -gt 0 ]; then
      log "REFUSING to stop: gateway has $pending active turn(s) + $queued queued turn(s) in flight."
      log "  Killing it now would drop a live chat/thinking session mid-stream."
      log "  Wait for the turn to finish, or force with: VODOU_FORCE_STOP=1 $0"
      exit 2
    fi
  elif [ -n "$listening" ]; then
    log "REFUSING to stop: :$WEB_PORT is listening but /health did not answer in 10s —"
    log "  cannot tell a wedged gateway from one busy streaming a turn."
    log "  Force with: VODOU_FORCE_STOP=1 $0"
    exit 2
  fi
fi

# launchd bootout AFTER the guard — bootout itself terminates plist-managed
# jobs, so running it first would kill the gateway before we could refuse.
unload_vodou_launchd
sleep 1

# 1. Gateway — kill listener on WEB_PORT
log "stopping gateway on :$WEB_PORT"
if command -v lsof >/dev/null 2>&1; then
  # -sTCP:LISTEN is load-bearing: without it lsof also returns every process
  # holding a *client* connection to :$WEB_PORT — Chrome (the extension talks
  # to the gateway), curl, the CLI — and we would SIGTERM the user's browser.
  for pid in $(lsof -ti ":$WEB_PORT" -sTCP:LISTEN 2>/dev/null || true); do
    log "  kill PID $pid (gateway listener)"
    kill "$pid" 2>/dev/null || true
  done
fi
sleep 1

# 1b. Aux surfaces — brain console (BRAIN_PORT, default 8767) and Vodou One
# (VODOU_ONE_PORT, default 8768). start-vodou-services.sh starts both and this
# script used to stop neither, so they outlived every stop/start cycle.
#
# That is not cosmetic. An install that once ran WEB_PORT=8767 leaves a gateway
# bound to 8767 forever after WEB_PORT moves back to 8765 — section 1 only ever
# kills the WEB_PORT listener, so nothing targets 8767 again — and the start
# path then reports "brain console already running" for that squatter while the
# real brain never starts. One install sat that way for seven weeks.
#
# Ports resolve from the environment only, exactly as start-vodou-services.sh
# resolves them, so the two scripts cannot disagree about which port to touch.
BRAIN_PORT_R="${BRAIN_PORT:-8767}"
ONE_PORT_R="${VODOU_ONE_PORT:-8768}"
log "stopping aux surfaces (brain :$BRAIN_PORT_R, vodou-one :$ONE_PORT_R)"
stop_aux_port "$BRAIN_PORT_R" "brain console"
stop_aux_port "$ONE_PORT_R" "vodou one"
sleep 1

# 2. Daemon — via PID file, then targeted pkill as belt
log "stopping daemon"
if [ -f "$VODOU_DIR/.vodou/daemon.pid" ]; then
  dp=$(tr -d ' \n\r' < "$VODOU_DIR/.vodou/daemon.pid" || true)
  if [ -n "${dp:-}" ] && kill -0 "$dp" 2>/dev/null; then
    log "  kill PID $dp (daemon.pid)"
    kill "$dp" 2>/dev/null || true
  fi
fi
sleep 1
pkill -f "$VODOU_DIR/vodou-core daemon" 2>/dev/null || true

# 3. Worker — graceful via vodou-core, then targeted pkill as belt
log "stopping worker"
if [ -x "$VODOU_DIR/vodou-core" ]; then
  "$VODOU_DIR/vodou-core" worker stop 2>/dev/null || true
fi
sleep 1
pkill -f "$VODOU_DIR/vodou-core worker" 2>/dev/null || true

# 4. llama.cpp server (bundled local runtime) — via PID file written by src/api/llamacpp.ts.
# llama-server frees the port on SIGTERM but can linger seconds while flushing →
# escalate to SIGKILL, same discipline as the gateway teardown.
if [ -f "$VODOU_DIR/.vodou/run/llama-server.pid" ]; then
  lp=$(tr -d ' \n\r' < "$VODOU_DIR/.vodou/run/llama-server.pid" || true)
  if [ -n "${lp:-}" ] && kill -0 "$lp" 2>/dev/null; then
    log "  kill PID $lp (llama-server.pid)"
    kill "$lp" 2>/dev/null || true
    sleep 2
    if kill -0 "$lp" 2>/dev/null; then
      log "  SIGKILL PID $lp (llama-server still alive)"
      kill -9 "$lp" 2>/dev/null || true
    fi
  fi
  rm -f "$VODOU_DIR/.vodou/run/llama-server.pid" 2>/dev/null || true
fi

log "stopping footprint watch"
if [ -f "$VODOU_DIR/.vodou/footprint-watch.pid" ]; then
  fp=$(tr -d ' \n\r' < "$VODOU_DIR/.vodou/footprint-watch.pid" || true)
  if [ -n "$fp" ] && kill -0 "$fp" 2>/dev/null; then
    log "  kill PID $fp (footprint-watch.pid)"
    kill "$fp" 2>/dev/null || true
  fi
  rm -f "$VODOU_DIR/.vodou/footprint-watch.pid"
fi

log "all services stopped"
log "stop-vodou-services done"
