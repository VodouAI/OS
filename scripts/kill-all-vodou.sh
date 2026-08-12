#!/usr/bin/env bash
# kill-all-vodou.sh — machine-wide sweep of every Vodou process, from every install dir.
#
# WHY THIS EXISTS: ./stop-vodou-services.sh resolves everything relative to a single
# $VODOU_DIR (PID files, sockets, pkill patterns). A test machine accumulates several
# installs — old versions, "copy 2" dirs, per-install launchd agents — so the per-dir
# stop script leaves the others running and the next build talks to stale code.
# This is the blunt instrument for that situation.
#
#   bash scripts/kill-all-vodou.sh          # DRY RUN — prints what it would kill
#   bash scripts/kill-all-vodou.sh --yes    # actually kills
#   REMOVE_PLISTS=1 bash scripts/kill-all-vodou.sh --yes   # also delete LaunchAgent plists
#
# NOT a replacement for ./stop-vodou-services.sh on a working machine: this skips the
# active-turn guard, so it WILL drop a live chat/thinking session mid-stream.
#
# Deliberately does NOT touch `claude` CLI processes — the gateway spawns one per turn,
# and a broad match would also kill the tester's own Claude Code session.
set -uo pipefail

DRY=1
[[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]] && DRY=0
SELF=$$

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then say "  DRY: $*"; else eval "$@"; fi; }

[ "$DRY" = 1 ] && say "*** DRY RUN — nothing will be killed. Re-run with --yes to execute. ***" && say ""

# ---------------------------------------------------------------- 1. launchd
# KeepAlive agents respawn anything we kill, so these go first.
say "== launchd agents =="
if [[ "$(uname -s)" == "Darwin" ]] && command -v launchctl >/dev/null 2>&1; then
  uid="$(id -u)"
  found_plist=0
  for plist in "$HOME/Library/LaunchAgents/"com.vodou.*.plist \
               "$HOME/Library/LaunchAgents/"com.oios.*.plist; do
    [[ -e "$plist" ]] || continue
    found_plist=1
    label="$(basename "${plist%.plist}")"
    say "  $label"
    run "launchctl bootout gui/$uid/$label 2>/dev/null || true"
    run "launchctl bootout gui/$uid '$plist' 2>/dev/null || true"
    run "launchctl unload '$plist' 2>/dev/null || true"
    [ "${REMOVE_PLISTS:-0}" = "1" ] && run "rm -f '$plist'"
  done
  [ "$found_plist" = 0 ] && say "  none found"
else
  say "  skipped (not macOS)"
fi

# ------------------------------------------------------------- 2. processes
# Patterns anchored on things ONLY Vodou runs. `claude` is intentionally absent.
PATTERNS=(
  'vodou-core daemon'
  'vodou-core worker'
  'vodou-core mcp-server'
  'Vodou-Console/dist/index.js'
  'MCP-servers/.*/dist/index.js'
  'MCP-servers/brain/dist/serve.js'
  'one/web/server.mjs'
  'llama-server'
  'vodou-hook-bin'
  'browser-connector'
)

say ""
say "== processes =="
PIDS=()
for pat in "${PATTERNS[@]}"; do
  while read -r pid; do
    [[ -z "$pid" || "$pid" == "$SELF" ]] && continue
    PIDS+=("$pid")
  done < <(pgrep -f "$pat" 2>/dev/null)
done
PIDS=($(printf '%s\n' "${PIDS[@]:-}" | sort -un))

if [ "${#PIDS[@]}" -eq 0 ] || [ -z "${PIDS[0]:-}" ]; then
  say "  none found"
else
  for pid in "${PIDS[@]}"; do
    say "  $(ps -p "$pid" -o pid=,etime=,args= 2>/dev/null | cut -c1-160)"
  done
  say ""
  say "  -> SIGTERM, wait 3s, SIGKILL survivors"
  run "kill ${PIDS[*]} 2>/dev/null || true"
  if [ "$DRY" = 0 ]; then
    sleep 3
    for pid in "${PIDS[@]}"; do
      kill -0 "$pid" 2>/dev/null && { say "  SIGKILL $pid"; kill -9 "$pid" 2>/dev/null || true; }
    done
  fi
fi

# ------------------------------------------------------------------ 3. ports
# 8765 gateway · 8766 daemon · 8767 brain · 8770 vodou-one web
say ""
say "== port listeners =="
found_port=0
for port in 8765 8766 8767 8770; do
  # -sTCP:LISTEN is load-bearing: without it lsof also returns every process holding
  # a *client* connection to the port — Chrome (the extension talks to the gateway),
  # curl, the CLI — and we would kill the tester's browser.
  for pid in $(lsof -ti ":$port" -sTCP:LISTEN 2>/dev/null || true); do
    [[ "$pid" == "$SELF" ]] && continue
    found_port=1
    say "  :$port -> $(ps -p "$pid" -o pid=,args= 2>/dev/null | cut -c1-140)"
    run "kill -9 $pid 2>/dev/null || true"
  done
done
[ "$found_port" = 0 ] && say "  none listening"

# ------------------------------------------------- 4. stale sockets/pidfiles
# A leftover daemon.sock makes the next start think a daemon is already up.
say ""
say "== stale sockets / pid files =="
found_dir=0
while read -r d; do
  found_dir=1
  say "  $d"
  run "rm -f '$d'/daemon.sock '$d'/worker.sock '$d'/daemon.pid '$d'/run/llama-server.pid"
done < <(find "$HOME" -maxdepth 5 -type d -name .vodou -not -path '*/node_modules/*' 2>/dev/null)
[ "$found_dir" = 0 ] && say "  none found"

say ""
if [ "$DRY" = 1 ]; then
  say "== done (DRY RUN — re-run with --yes to execute) =="
else
  say "== done — machine is clean. Start fresh with ./start-vodou-services.sh =="
fi
