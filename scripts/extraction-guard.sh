#!/bin/bash
# extraction-guard.sh — wake someone when memory is quietly getting worse.
#
# The failure this watches has no other symptom. When LLM extraction fails,
# `memory_flush` falls back to `heuristic_extract`: nothing errors, no request
# fails, no user-visible log line — memory just fills with untagged bullets that
# pollute ranking. By the time it is noticeable it has compounded.
#
# HISTORY, because it explains the shape. This began as
# `scripts/bridge/bridge-guard.sh`, watching the 2026-08-22 AWS-bridge cutover,
# and it was wrong twice over:
#
#   * It owned its own SQL predicate, copied into two sibling scripts. Four
#     rewrites later, fixing one left the other two reporting the old number —
#     the trend line said 81 while the guard said 11.
#   * It was gated on the extraction provider being `custom`, i.e. the bridge.
#     But `memory_flush.rs:740` fires on ANY provider, so the gate made it watch
#     the lane that could not fail and ignore `claude-cli`, which could.
#
# Both are fixed by not deciding anything here. `vodou-core flows --flow 11`
# owns what counts as damage; this file owns exactly one question a grader
# should not answer: does a human need to be interrupted?
#
# Source of truth: scripts/extraction-guard.sh (versioned).
# Runs from:      ~/.config/vodou/extraction-guard.sh
set -uo pipefail

# launchd hands over a minimal PATH; python3/sqlite3 live outside it.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

ROOT="/Users/chad/Desktop/_vodou/OI-v0.5.34"
LOG="$ROOT/.vodou/system.log"
STATEDIR="$HOME/.config/vodou"
ALERTS="$STATEDIR/extraction-alerts.log"
LAST="$STATEDIR/extraction-last-verdict.txt"
mkdir -p "$STATEDIR"

now() { date '+%Y-%m-%d %H:%M:%S'; }
note() { echo "$(now) $*" >> "$ALERTS"; }
# A notification is the ONE side effect that escapes a test harness. On
# 2026-08-25 this file was proved against a fixture database with $HOME and
# VODOU_PROJECT_PATH redirected — and the operator still got two real "extraction
# is degrading" alerts on their desktop, because osascript addresses the login
# session, not $HOME. A harness that can page a human is not a harness.
#
# So: notifications are suppressed whenever this run is not grading the real
# install. Explicit opt-out for a deliberate test, and automatic whenever
# VODOU_PROJECT_PATH points somewhere other than $ROOT.
notify_ok() {
  [ "${VODOU_GUARD_NO_NOTIFY:-0}" = "1" ] && return 1
  case "${VODOU_PROJECT_PATH:-$ROOT}" in
    "$ROOT") return 0 ;;
    *) return 1 ;;
  esac
}
alert() {
  note "ALERT: $*"
  # A log nobody reads is not a guard.
  if notify_ok; then
    osascript -e "display notification \"$*\" with title \"Vodou extraction guard\"" 2>/dev/null || true
  else
    note "(notification suppressed: grading ${VODOU_PROJECT_PATH:-$ROOT}, not the live install)"
  fi
}

# TCC PREFLIGHT — a launchd agent cannot read a Desktop-resident repo without
# Full Disk Access. Under launchd that read comes back BLOCKED and every check
# below would quietly report zero. Fail loudly: a monitor that cannot see is
# worse than none, because it is trusted.
if ! head -c 1 "$LOG" >/dev/null 2>&1; then
  note "BLIND: cannot read the repo (macOS TCC). Grant Full Disk Access to /bin/bash in System Settings > Privacy & Security, then reload the agent."
  notify_ok && osascript -e 'display notification "Extraction monitoring is BLIND - cannot read the repo (TCC). Grant Full Disk Access to /bin/bash." with title "Vodou extraction guard"' 2>/dev/null || true
  exit 0
fi

# NOTE: $ROOT selects the BINARY here, not the data. `flows` resolves its own
# project root (VODOU_PROJECT_PATH, then cwd, then exe-relative), so pointing
# this at another checkout's vodou-core would grade THAT install's databases —
# the F44 trap, where runtime-status reported the health of a different
# installation. In production both are this repo, which is why it is invisible.
FLOW=$("$ROOT/vodou-core" flows --json --flow 11 2>/dev/null)
READ=$(printf '%s' "$FLOW" | python3 -c '
import json,sys
try:
    rows = json.load(sys.stdin).get("rows", [])
except Exception:
    print("parse-error 0 0 "); sys.exit(0)
r = next((r for r in rows if r.get("flow") == 11), None)
if r is None:
    print("absent 0 0 "); sys.exit(0)
n = r.get("numbers", {})
print(r.get("verdict","parse-error"), n.get("heuristic_24h",0),
      n.get("untagged_daily_24h",0), r.get("evidence",""))
' 2>/dev/null)

VERDICT=$(printf '%s' "$READ" | awk '{print $1}')
HEUR=$(printf '%s' "$READ" | awk '{print $2}')
UNTAGGED=$(printf '%s' "$READ" | awk '{print $3}')
EVIDENCE=$(printf '%s' "$READ" | cut -d' ' -f4-)

# Transition-only for the states that persist. A nag every 600s is how a guard
# gets ignored, and an ignored guard is the one that fails to reach you.
say_once() {
  [ "$(cat "$LAST" 2>/dev/null)" = "$1" ] && return 1
  printf '%s\n' "$1" > "$LAST"
  return 0
}

case "${VERDICT:-}" in
  absent)
    say_once "absent" && note "cannot measure: this vodou-core predates Flow 11. Swap the build (scripts/swap-binary.sh) — until then extraction degradation is UNWATCHED."
    ;;
  ""|parse-error)
    say_once "parse-error" && note "cannot measure: vodou-core flows returned nothing readable — extraction degradation is UNWATCHED."
    ;;
  unknown)
    # A quiet day and a dead extractor look identical from here. Flow 11 says
    # `unknown` rather than guessing, and so does this.
    say_once "unknown" && note "nothing to grade: no memory chunk written in 24h. Normal on a quiet day, and indistinguishable from extraction being dead — which is why it is not recorded as ok."
    ;;
  red)
    # Every tick, not once: this one is actively compounding.
    printf 'red\n' > "$LAST"
    alert "extraction is degrading: ${HEUR} heuristic chunk(s) and ${UNTAGGED} untagged bullet(s) in 24h. ${EVIDENCE}"
    ;;
  warn)
    say_once "warn" && alert "extraction warning: ${EVIDENCE}"
    ;;
  ok)
    say_once "ok" && note "ok: ${EVIDENCE}"
    ;;
esac
