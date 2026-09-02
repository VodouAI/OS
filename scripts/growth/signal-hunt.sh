#!/usr/bin/env bash
# signal-hunt.sh — the LISTEN organ of the growth machine.
#
# Finds people publicly describing the problem Vodou solves, dedups them against
# a persistent ledger, and writes a ranked digest. Produces TARGETS, not content.
#
# Costs nothing: exa is a keyless hosted MCP server, HN Algolia is public.
# X search is deliberately NOT here -- it starts at $200/mo (Basic tier), which
# is 2x the entire marketing budget. Read by free API, write by human.
#
# Exit codes (the verdict -- do not soften them):
#   0  ran, found new leads          -> digest written
#   0  ran, no NEW leads             -> quiet day, ledger already had them
#   3  every search failed           -> the LANE is broken, NOT "no leads".
#                                       Absence-shaped metrics are satisfied by
#                                       total failure; this code exists so a dead
#                                       exa server can never report a quiet day.
#   1  bad usage / lock held
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1
source scripts/blog/lib.sh   # bt_timeout, bt_lock_acquire, bt_lock_release

OUT_DIR=".vodou/growth"
LEDGER="$OUT_DIR/leads.json"
RUNLOG="$OUT_DIR/runs.log"
LOCK="$OUT_DIR/.hunt.lock"
RAW="$(mktemp -d)"
TODAY="$(date +%F)"
DIGEST="$OUT_DIR/digest-$TODAY.md"
LIMIT="${SIGNAL_HUNT_LIMIT:-5}"
CALL_TIMEOUT="${SIGNAL_HUNT_TIMEOUT:-90}"

mkdir -p "$OUT_DIR"
trap 'rm -rf "$RAW"' EXIT

log() { printf '[%s] %s\n' "$(date +%FT%TZ)" "$*" | tee -a "$RUNLOG" >&2; }

bt_lock_acquire "$LOCK" 1800 || { log "another hunt holds the lock; exiting"; exit 1; }
trap 'bt_lock_release "$LOCK"; rm -rf "$RAW"' EXIT

attempted=0; succeeded=0

# ---- exa ---------------------------------------------------------------------
n=0
while IFS='|' read -r lane query; do
  [[ -z "${lane:-}" || "$lane" == \#* ]] && continue
  n=$((n+1)); attempted=$((attempted+1))
  log "exa[$lane] $query"
  if bt_timeout "$CALL_TIMEOUT" ./vodou-core call exa web_search_exa \
        "$(python3 -c 'import json,sys;print(json.dumps({"query":sys.argv[1],"numResults":int(sys.argv[2])}))' "$query" "$LIMIT")" \
        > "$RAW/exa-$n.out" 2>"$RAW/exa-$n.err"; then
    grep -q '"text"' "$RAW/exa-$n.out" && { succeeded=$((succeeded+1)); echo "$lane" > "$RAW/exa-$n.lane"; } \
      || log "exa[$lane] returned no text block"
  else
    log "exa[$lane] FAILED rc=$? $(tail -1 "$RAW/exa-$n.err" 2>/dev/null)"
  fi
done < scripts/growth/phrases.txt

# ---- hacker news -------------------------------------------------------------
m=0
while IFS='|' read -r lane query tags; do
  [[ -z "${lane:-}" || "$lane" == \#* ]] && continue
  m=$((m+1)); attempted=$((attempted+1))
  log "hn[$lane] $query"
  if bt_timeout "$CALL_TIMEOUT" ./vodou-core call hackernews search-posts \
        "$(python3 -c 'import json,sys;print(json.dumps({"query":sys.argv[1],"tags":[sys.argv[2]],"hitsPerPage":int(sys.argv[3])}))' "$query" "${tags:-comment}" "$LIMIT")" \
        > "$RAW/hn-$m.out" 2>"$RAW/hn-$m.err"; then
    grep -q '"hits"' "$RAW/hn-$m.out" && { succeeded=$((succeeded+1)); echo "$lane" > "$RAW/hn-$m.lane"; } \
      || log "hn[$lane] returned no hits block"
  else
    log "hn[$lane] FAILED rc=$? $(tail -1 "$RAW/hn-$m.err" 2>/dev/null)"
  fi
done < scripts/growth/hn-phrases.txt

# ---- discourse forums --------------------------------------------------------
# Public /search.json, no key, no MCP hop. This is the freshness source: exa
# returns articles and HN phrase-search skews months old, so without this the
# reply lane has nothing open to reply to.
DISC_AFTER="${SIGNAL_HUNT_AFTER:-$(date -v-45d +%F 2>/dev/null || date -d '45 days ago' +%F)}"
d=0
while IFS='|' read -r lane query base; do
  [[ -z "${lane:-}" || "$lane" == \#* ]] && continue
  d=$((d+1)); attempted=$((attempted+1))
  q="$query after:$DISC_AFTER order:latest"
  log "disc[$lane] $base :: $q"
  url="$base/search.json?q=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$q")"
  if bt_timeout "$CALL_TIMEOUT" curl -sS -m 30 -A "vodou-growth/0.1 (+https://vodou.ai; research)" \
        "$url" > "$RAW/disc-$d.raw" 2>"$RAW/disc-$d.err"; then
    if python3 -c '
import json,sys
raw,base,out=sys.argv[1],sys.argv[2],sys.argv[3]
d=json.load(open(raw))
if not isinstance(d,dict) or "topics" not in d: raise SystemExit(1)
d["_base"]=base
json.dump(d,open(out,"w"))
' "$RAW/disc-$d.raw" "$base" "$RAW/disc-$d.out" 2>/dev/null; then
      succeeded=$((succeeded+1)); echo "$lane" > "$RAW/disc-$d.lane"
    else
      log "disc[$lane] returned no topics block (blocked or empty)"
    fi
  else
    log "disc[$lane] FAILED rc=$? $(tail -1 "$RAW/disc-$d.err" 2>/dev/null)"
  fi
done < scripts/growth/discourse-phrases.txt

if [[ $succeeded -eq 0 ]]; then
  log "VERDICT: 0/$attempted searches returned data -- the listening lane is BROKEN, not quiet."
  exit 3
fi

# ---- parse, dedup, rank ------------------------------------------------------
python3 scripts/growth/parse-signals.py \
  --raw "$RAW" --ledger "$LEDGER" --digest "$DIGEST" \
  --attempted "$attempted" --succeeded "$succeeded"
rc=$?
log "VERDICT: $succeeded/$attempted searches ok; parser rc=$rc; digest=$DIGEST"
exit 0
