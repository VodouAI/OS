#!/usr/bin/env bash
#
# verify-onboarding-seed.sh — prove the 11a guarantee: facts typed at minute one
# are injectable into ChatGPT at minute three.
#
# The two defaults this guards (both found by source-reading, deep-think
# `a909d28b`, and both of which would have shipped a broken first-run demo):
#   1. `mem context --vault` HARD-ERRORS on a missing vault, and the inject lane
#      defaults to vault 'portable' — so a fresh install without the vault kills
#      every inject. The endpoint must ensure-create it.
#   2. Pins must ride along on UNRELATED queries (the anti-dog's-name property)
#      or the ambient act three silently loses its facts.
#
# Reversible on a live machine: pins a marker fact, asserts, unpins, asserts
# gone. Nothing else is written. The live-endpoint section runs only when the
# gateway is up AND carries the new route.
#
# Usage: bash scripts/verify-onboarding-seed.sh

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
pass=0; fail=0; skip=0
ok()   { printf "  ok   %s\n" "$1"; pass=$((pass+1)); }
bad()  { printf "NOT OK %s\n" "$1"; fail=$((fail+1)); }
skip() { printf "  ..   SKIPPED %s\n" "$1"; skip=$((skip+1)); }

MARK="VERIFY-11A-$(date +%s)"
PIN_ID=""

echo "── 1. the pin path: instant, no extraction cycle ──"
OUT="$(./vodou-core mem pin --text "$MARK: my go-to drink order is a triple lime rickey" --section Preferences 2>&1)"
PIN_ID="$(printf '%s' "$OUT" | grep -oE 'pin-[0-9a-f]+' | head -1)"
if [ -n "$PIN_ID" ]; then ok "pinned instantly ($PIN_ID)"; else bad "pin failed: $OUT"; fi

echo
echo "── 2. the vault: exists, right shape, duplicate-create is tolerated ──"
VJSON="$(./vodou-core mem vault list --json 2>/dev/null)"
if printf '%s' "$VJSON" | python3 -c "
import sys, json
vs = json.load(sys.stdin).get('vaults', [])
p = next((v for v in vs if v.get('name') == 'portable'), None)
assert p, 'no portable vault'
r = p.get('rules', {})
assert r.get('include_profile') is True, 'include_profile is not true'
tags = set(r.get('tags', []))
assert {'PREF','IDENTITY'} <= tags, f'tags wrong: {tags}'
" 2>/dev/null; then
  ok "vault 'portable' present with PREF+IDENTITY and include_profile"
else
  bad "vault 'portable' missing or wrong shape — fresh-install injects would hard-error"
fi
DUP="$(./vodou-core mem vault create portable --tags PREF,IDENTITY --include-profile 2>&1)"
if printf '%s' "$DUP" | grep -qi "already exists"; then
  ok "duplicate create errors loudly (endpoint treats this as success)"
else
  bad "duplicate create did not say 'already exists': $DUP"
fi

echo
echo "── 3. the demo query — and the anti-dog's-name property ──"
DIRECT="$(./vodou-core mem context "what is my drink order" --vault portable --top-k 8 --json 2>/dev/null)"
if printf '%s' "$DIRECT" | grep -q "$MARK"; then
  ok "direct question surfaces the pin through the demo vault"
else
  bad "direct question did NOT surface the pin — beat 2 would die on stage"
fi
# The property that actually matters for act three: the pin must ride along on a
# query that has NOTHING to do with it. This is the exact failure mode of the
# 2026-08-01 dog's-name bug (inject scoping dropped facts the query didn't name).
UNREL="$(./vodou-core mem context "help me plan a website redesign" --vault portable --top-k 8 --json 2>/dev/null)"
if printf '%s' "$UNREL" | grep -q "$MARK"; then
  ok "pin rides along on an UNRELATED query (anti-dog's-name holds)"
else
  bad "pin dropped on an unrelated query — ambient act three loses its facts"
fi

echo
echo "── 4. the endpoint (live, only if the gateway carries it) ──"
if curl -fsS -m 3 http://127.0.0.1:8765/health >/dev/null 2>&1; then
  # -f swallows the 404 body, so probe the status code separately: an old
  # gateway build without the route must read as SKIP, not failure.
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 60 -X POST http://127.0.0.1:8765/api/onboarding/pin-facts \
        -H 'Content-Type: application/json' -d '{"facts":[]}' 2>/dev/null)"
  R=""
  if [ "$CODE" != "404" ]; then
    R="$(curl -fsS -m 60 -X POST http://127.0.0.1:8765/api/onboarding/pin-facts \
        -H 'Content-Type: application/json' \
        -d "{\"facts\":[{\"text\":\"$MARK-EP: my usual takeout is dumplings\",\"section\":\"Preferences\"}],\"usualKind\":\"takeout\"}" 2>&1)"
  fi
  if printf '%s' "$R" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d.get('ok') is True, d
assert d.get('verified') is True, 'endpoint pinned but could not verify retrieval'
assert d.get('demoQuestion'), 'no demo question generated'
assert len(d.get('pinned', [])) == 1
" 2>/dev/null; then
    ok "endpoint pins, verifies retrieval, and returns the demo question"
    EP_PIN="$(printf '%s' "$R" | python3 -c "import sys,json; print(json.load(sys.stdin)['pinned'][0])" 2>/dev/null)"
    [ -n "$EP_PIN" ] && ./vodou-core mem unpin "$EP_PIN" >/dev/null 2>&1
    # G2 observables land in gateway_settings
    UK="$(sqlite3 MCP-servers/Vodou-Console/gateway.db "SELECT value FROM gateway_settings WHERE key='onboarding.usual_kind';" 2>/dev/null)"
    if [ "$UK" = "takeout" ]; then ok "G2 observable: onboarding.usual_kind stored"; else bad "usual_kind not stored (got '$UK')"; fi
    # The verifier must not leave test state where real onboarding will read it.
    sqlite3 MCP-servers/Vodou-Console/gateway.db "DELETE FROM gateway_settings WHERE key IN ('onboarding.usual_kind','onboarding.seed_pins','onboarding.seed_pinned_at');" 2>/dev/null
  elif [ "$CODE" = "404" ]; then
    skip "gateway is running an older build without /pin-facts (restart to test live)"
  else
    bad "endpoint call failed: $(printf '%s' "$R" | head -c 200)"
  fi
else
  skip "gateway not running — endpoint not exercised"
fi

echo
echo "── 5. cleanup round-trips ──"
if [ -n "$PIN_ID" ]; then
  ./vodou-core mem unpin "$PIN_ID" >/dev/null 2>&1
  GONE="$(./vodou-core mem context "what is my drink order" --vault portable --top-k 8 --json 2>/dev/null)"
  if printf '%s' "$GONE" | grep -q "$MARK:"; then
    bad "marker still present after unpin"
  else
    ok "unpin removes the fact (round-trip clean)"
  fi
fi

echo
if [ -n "${VODOU_VERIFY_MIN_CHECKS:-}" ] && [ "$pass" -lt "$VODOU_VERIFY_MIN_CHECKS" ]; then
  echo "NOT OK only $pass check(s) ran; VODOU_VERIFY_MIN_CHECKS=$VODOU_VERIFY_MIN_CHECKS required"
  fail=$((fail+1))
fi
if [ "$fail" -eq 0 ]; then
  echo "✅ onboarding-seed chain intact ($pass checks$([ "$skip" -gt 0 ] && echo ", $skip skipped"))"
  exit 0
fi
echo "❌ onboarding-seed chain BROKEN ($fail failed, $pass passed, $skip skipped)"
exit 1
