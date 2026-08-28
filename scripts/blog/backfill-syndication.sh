#!/usr/bin/env bash
#
# Syndicate posts that are LIVE on the site but were never pushed to a target.
#
# Why this exists: blog-run.sh only ever syndicates the ONE post its slot just
# wrote. Anything already on disk when BLOG_AUTOPUBLISH was flipped on -- or
# anything whose slot published while a target credential was missing -- is
# invisible to the schedule forever. That backlog needed a command, not a
# reminder.
#
# Two things it deliberately does NOT do itself:
#   - decide what is publishable. publish.mjs owns the redirect gate, the
#     canonical assertion and the ledger. This only chooses WHICH files to hand
#     it, and lets it refuse.
#   - run unlocked. It takes .vodou/blog/.run.lock, the same lock the scheduled
#     runs take. The ledger is read-modify-write, so a backfill racing a slot
#     silently drops one of their two entries.
#
# Usage: scripts/blog/backfill-syndication.sh [--live] [--stagger SECONDS] [--refresh]
#
#   (default)   posts with NO dev.to id yet — the first push
#   --refresh   posts that ALREADY have an id — re-PUT the current body,
#               for when the twin changed (new figures, a payload fix) and
#               the live copies are behind the site.
# Exit:  0 all attempted posts succeeded (or were correctly refused), 1 otherwise.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
# shellcheck source=lib.sh
. ./scripts/blog/lib.sh

# 45s was the first guess and it was wrong: on 2026-08-26 a 9-post backfill at
# 40s spacing got a dev.to 429 on the SIXTH create, costing a 300s backoff --
# slower than just spacing them out. 120s is the measured-safe interval, not a
# guess. publish.mjs still retries a 429 on its own; this only avoids earning one.
LIVE=""; STAGGER=""; MODE=new
while [[ $# -gt 0 ]]; do
  case "$1" in
    --live) LIVE="--live"; shift ;;
    --stagger) STAGGER="${2:?--stagger needs a value}"; shift 2 ;;
    --refresh) MODE=refresh; shift ;;
    *) echo "unknown arg: $1" >&2; exit 64 ;;
  esac
done

if [[ -z "$STAGGER" ]]; then
  # dev.to: 10 creates / 30s, 30 updates / 30s. A create on a young account
  # also trips the spam heuristic (measured: 429 on the sixth at 40s apart),
  # which an update does not.
  if [[ $MODE == refresh ]]; then STAGGER=20; else STAGGER=120; fi
fi

LOG=".vodou/blog/runs.log"
say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [backfill] $*" | tee -a "$LOG"; }

LOCK=".vodou/blog/.run.lock"
if ! bt_lock_acquire "$LOCK" 1800; then
  say "another blog run holds the lock (pid $(cat "$LOCK/pid" 2>/dev/null)) — exiting"
  exit 0
fi
trap 'bt_lock_release "$LOCK"' EXIT

# Which files have no dev.to id in the ledger? The ledger is the only record of
# what was pushed; the file system cannot tell you.
# Portable read loop, not `mapfile`: /bin/bash on macOS is 3.2 and has no such
# builtin, and a scheduled run does not necessarily inherit a PATH with the
# homebrew bash 5 that an interactive shell finds.
TODO=()
while IFS= read -r _f; do [[ -n "$_f" ]] && TODO+=("$_f"); done < <(MODE="$MODE" python3 - <<'PY'
import json, glob, os
mode = os.environ.get('MODE', 'new')
led = {}
if os.path.exists('.vodou/blog/ledger.json'):
    led = {p['file']: p for p in json.load(open('.vodou/blog/ledger.json'))['published']}
for f in sorted(glob.glob('content/blog/*.md')):
    has_id = bool((led.get(f, {}).get('targets') or {}).get('devto'))
    if has_id == (mode == 'refresh'):
        print(f)
PY
)

if [[ ${#TODO[@]} -eq 0 ]]; then
  say "nothing to do in mode=$MODE"
  exit 0
fi

say "${#TODO[@]} post(s) [mode=$MODE] ${LIVE:-(dry run)}, ${STAGGER}s apart"

RC=0; N=0
for f in "${TODO[@]}"; do
  N=$((N + 1))
  say "[$N/${#TODO[@]}] $f"
  # publish.mjs exit 4 == "correctly refused" (retired slug). That is the gate
  # doing its job, not a backfill failure, so it must not poison the exit code.
  node scripts/blog/publish.mjs "$f" $LIVE >>"$LOG" 2>&1
  rc=$?
  case $rc in
    0) say "[$N] ok" ;;
    4) say "[$N] refused by the redirect gate — expected for a retired slug" ;;
    *) say "[$N] FAILED rc=$rc — see $LOG"; RC=1 ;;
  esac
  # Stagger: a day-old account posting N articles in seconds is the exact shape
  # dev.to's spam heuristics look for.
  if [[ $N -lt ${#TODO[@]} && -n "$LIVE" ]]; then sleep "$STAGGER"; fi
done

say "backfill done (rc=$RC)"
exit $RC
