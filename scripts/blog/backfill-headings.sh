#!/usr/bin/env bash
# Re-head posts that are ALREADY published.
#
# The scheduled writers now run this check on every new draft, but the flag
# only ever covers the post its own slot wrote. Four posts shipped before the
# check existed and share a byte-identical H2 skeleton (What we built / The
# struggle / The general lesson / Where the standard approach falls short /
# What is still not solved). They are invisible to the schedule forever, so
# the backlog needs a command. This is that command, and it is the same shape
# as backfill-syndication.sh for the same reason.
#
# Everything here goes through headings.py: check, prompt, parse, apply. One
# owner, three callers.
#
# SAFETY: the model never sees the body, only the headings and a 260-char
# preview of each section. apply is positional and refuses a count mismatch,
# and this script diffs everything outside the H2 lines afterwards and reverts
# the file if a single byte moved. A backfill that silently edits eleven
# published posts is a much worse outcome than four bad headings.
#
#   scripts/blog/backfill-headings.sh            # dry run, prints what it would do
#   scripts/blog/backfill-headings.sh --live
#   scripts/blog/backfill-headings.sh --live path/to/one-post.md
set -uo pipefail
cd "$(dirname "$0")/../.."
. scripts/blog/lib.sh
DIR="content/blog"
LIVE=0; TARGETS=()
for a in "$@"; do
  case "$a" in
    --live) LIVE=1 ;;
    *.md)   TARGETS+=("$a") ;;
    *)      echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done
[[ ${#TARGETS[@]} -eq 0 ]] && while IFS= read -r f; do TARGETS+=("$f"); done < <(ls "$DIR"/*.md 2>/dev/null)
SECS="${BLOG_REHEAD_TIMEOUT:-180}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
log() { printf '[%s] [backfill-headings] %s\n' "$(date '+%H:%M:%S')" "$*" >&2; }
(( LIVE )) || log "DRY RUN. Pass --live to write."

CLEAN=0; FIXED=0; SKIPPED=0; FAILED=0
for f in "${TARGETS[@]}"; do
  name="$(basename "$f")"
  if python3 scripts/blog/headings.py --check "$f" "$DIR" >"$TMP/chk" 2>&1; then
    log "ok       $name"; CLEAN=$((CLEAN+1)); continue
  fi
  log "flagged  $name"
  sed 's/^/             /' "$TMP/chk" >&2
  if ! (( LIVE )); then SKIPPED=$((SKIPPED+1)); continue; fi

  python3 scripts/blog/headings.py --prompt "$f" "$DIR" > "$TMP/prompt" || { log "  prompt failed"; FAILED=$((FAILED+1)); continue; }
  # Same auth doctrine as the writers: an ANTHROPIC_API_KEY in .env silently
  # turns `claude` from a subscription client into a metered API client, and a
  # no-credit key returns a five-word refusal on stdout with exit 0.
  if ! ( unset ANTHROPIC_API_KEY; bt_timeout "$SECS" claude -p "$(cat "$TMP/prompt")" ) > "$TMP/raw" 2>"$TMP/err"; then
    log "  LLM call failed (rc=$?)"; FAILED=$((FAILED+1)); continue
  fi
  if grep -qiE 'credit balance is too low|usage limit|invalid.{0,12}api key' "$TMP/raw"; then
    log "  FATAL: the LLM refused. This is an ACCOUNT problem, not a writing problem."; FAILED=$((FAILED+1)); continue
  fi
  python3 scripts/blog/headings.py --parse "$TMP/raw" > "$TMP/new" || true
  cp "$f" "$TMP/orig.md"
  # One retry. Measured: 1 of 9 posts came back with 8 lines for 5 headings and
  # a plain retry returned a clean 5. The count guard makes a bad retry free.
  if ! python3 scripts/blog/headings.py --apply "$f" "$TMP/new" 2>/dev/null; then
    log "  count mismatch, retrying once"
    ( unset ANTHROPIC_API_KEY; bt_timeout "$SECS" claude -p "$(cat "$TMP/prompt")" ) > "$TMP/raw" 2>/dev/null || true
    python3 scripts/blog/headings.py --parse "$TMP/raw" > "$TMP/new" || true
    if ! python3 scripts/blog/headings.py --apply "$f" "$TMP/new" 2>&1 | sed 's/^/             /' >&2; then
      log "  apply refused twice, file untouched"; FAILED=$((FAILED+1)); continue
    fi
  fi
  python3 scripts/blog/dedash.py "$f" >/dev/null 2>&1 || true
  # The load-bearing assertion. Anything outside the H2 lines that moved means
  # something rewrote prose it was never asked to touch: revert, do not ship.
  if ! diff -q <(grep -v '^## ' "$TMP/orig.md") <(grep -v '^## ' "$f") >/dev/null; then
    cp "$TMP/orig.md" "$f"
    log "  REVERTED: the body changed outside the headings"; FAILED=$((FAILED+1)); continue
  fi
  if python3 scripts/blog/headings.py --check "$f" "$DIR" >/dev/null 2>&1; then
    log "  fixed, now clean"
  else
    log "  fixed, some findings remain"
  fi
  while IFS= read -r h; do log "    H2: $h"; done < <(grep '^## ' "$f" | sed 's/^## //')
  FIXED=$((FIXED+1))
done

log "clean=$CLEAN fixed=$FIXED skipped=$SKIPPED failed=$FAILED"
[[ $FAILED -eq 0 ]]
