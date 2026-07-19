#!/usr/bin/env bash
# verify-server-enforcement.sh — proves the MOAT is enforced server-side, fail-closed.
#
# A reverse-engineered binary can patch out the LOCAL auth gates — so the real
# protection has to live on the server. This asserts that the value-bearing
# endpoints (the billing/auth trust anchor on app.vodou.ai and the managed LLM
# proxy on llm.vodou.ai) REJECT a well-formed-but-bogus token. If any of them
# returns 200/a completion for a bogus token, that's a fail-OPEN server bug = a
# hole in the moat, and this script exits non-zero.
#
# Read-only: bogus probes can't do anything; the one valid-token call is a GET.
# Usage: bash scripts/verify-server-enforcement.sh
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

FAIL=0
APP="https://app.vodou.ai"

# Well-formed but invalid creds (64-hex token, UUID user_id) — passes the binary's
# LOCAL format check, so this tests the SERVER, not the format validator.
BOGUS_TOK=$(printf 'b%.0s' {1..64})
BOGUS_UID="11111111-1111-1111-1111-111111111111"

# Valid creds (control) from .env — never printed.
VALID_TOK=$(grep -E '^VODOU_TOKEN=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d ' ')
VALID_UID=$(grep -E '^VODOU_USER_ID=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d ' ')
PROXY_URL=$(grep -E '^VODOU_LLM_PROXY_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d ' ')

probe() { # $1=label $2=method $3=url $4=auth $5=expect_reject(1)|expect_ok(0) [$6=data]
  local label="$1" method="$2" url="$3" auth="$4" want="$5" data="${6:-}"
  local code
  if [ "$method" = "POST" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 -X POST "$url" \
      -H "Authorization: Bearer ${auth}" -H "Content-Type: application/json" --data "$data" 2>/dev/null)
  else
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$url" \
      -H "Authorization: Bearer ${auth}" 2>/dev/null)
  fi
  if [ "$want" = "1" ]; then        # expect REJECT (security property: NO value delivered)
    case "$code" in
      401|403) echo "  ✅ $label → HTTP $code (rejected — fail-closed)" ;;
      2*)      echo "  ❌ CRITICAL: $label → HTTP $code (delivered value for a bogus token — fail-OPEN; moat hole)"; FAIL=1 ;;
      4*|5*)   echo "  ✅ $label → HTTP $code (no value delivered; reject — note: not the canonical 401/403)" ;;
      *)       echo "  ⚠️  $label → HTTP $code (unexpected; investigate)"; FAIL=1 ;;
    esac
  else                              # expect OK (control)
    if [ "$code" = "200" ]; then echo "  ✅ $label → HTTP 200 (valid token works — control)";
    else echo "  ⚠️  $label → HTTP $code (control failed; endpoint down or creds stale?)"; fi
  fi
}

echo "════════════════════════════════════════════════════════════════"
echo " Server-side enforcement check (moat fail-closed)"
echo "════════════════════════════════════════════════════════════════"

echo "── Trust anchor (app.vodou.ai billing/auth) ───────────────────"
probe "usage/stats  [bogus token]" GET "${APP}/api/usage/stats?days=1"  "${BOGUS_TOK}:${BOGUS_UID}" 1
probe "usage/limits [bogus token]" GET "${APP}/api/usage/limits"        "${BOGUS_TOK}:${BOGUS_UID}" 1
if [ -n "$VALID_TOK" ] && [ -n "$VALID_UID" ]; then
  probe "usage/stats  [VALID token]" GET "${APP}/api/usage/stats?days=1" "${VALID_TOK}:${VALID_UID}" 0
else
  echo "  ⏭  no valid creds in .env — skipping control"
fi

echo ""
echo "── Managed LLM proxy (llm.vodou.ai) ───────────────────────────"
if [ -n "$PROXY_URL" ]; then
  BODY='{"model":"accounts/fireworks/models/llama-v3p1-8b-instruct","messages":[{"role":"user","content":"x"}],"max_tokens":1}'
  probe "proxy completion [bogus token]" POST "$PROXY_URL" "${BOGUS_TOK}:${BOGUS_UID}" 1 "$BODY"
else
  echo "  ⏭  VODOU_LLM_PROXY_URL unset — skipping proxy probe"
fi

echo ""
echo "════════════════════════════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then
  echo "✅ PASS — value endpoints reject bogus tokens (moat enforced server-side)"
  exit 0
else
  echo "❌ FAIL — a value endpoint accepted a bogus token (fail-OPEN). Fix the server before relying on it as the moat boundary."
  exit 1
fi
