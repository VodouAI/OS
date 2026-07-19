#!/usr/bin/env bash
# Smoke-test memory recall via the daemon socket.
# Pure bash + tools that ship with macOS (no python3 needed) — works on
# minimal VMs that don't have Xcode CLI tools installed.

set -u

QUERIES=(
  "how did we fix the reranker returning zero memories"
  "integration setup panel manage button for connected servers"
  "Linear automation firing every minute bug"
  "UE zombie processes from binary swap"
  "refs resolver project root workspace promotion"
  "sigmoid normalize cross-encoder logit RRF score"
  "gateway UI channels card credentials standalone"
  "skill Layer 1 priority never bypass"
  "cosine floor threshold memory relevance tuning"
  "vodou-core daemon socket worker-ensure fix"
)

HOOK_BIN="${VODOU_HOOK_BIN:-./vodou-hook-bin}"
if [ ! -x "$HOOK_BIN" ]; then
  HOOK_BIN="$(command -v vodou-hook-bin 2>/dev/null || echo vodou-hook-bin)"
fi

# Probe perl: on macOS, /usr/bin/perl is a stub that triggers the
# "Install Developer Tools" dialog when Xcode CLT isn't installed.
# `command -v perl` succeeds but running it errors silently or hangs.
# Resolve once at startup so we don't pay the dialog cost per query.
PERL_OK=0
if command -v perl >/dev/null 2>&1; then
  if perl -e 'print 1' 2>/dev/null | grep -q '^1$'; then
    PERL_OK=1
  fi
fi

# JSON-escape: handles the chars that actually appear in QUERIES (no embedded
# quotes, backslashes, or control chars). Falls through to jq when present.
json_escape() {
  local s="$1"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$s" | jq -Rs .
    return
  fi
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//	/\\t}
  s=${s//$'\n'/\\n}
  printf '"%s"' "$s"
}

# Millisecond clock without python. Perl is preferred when it's actually
# usable (PERL_OK probed at startup). Otherwise fall back to GNU date or
# second-resolution date * 1000 — never returns empty.
ms_now() {
  if [ "$PERL_OK" = "1" ]; then
    perl -MTime::HiRes=time -e 'printf "%d", time()*1000' 2>/dev/null
  elif command -v gdate >/dev/null 2>&1; then
    gdate +%s%3N 2>/dev/null
  else
    echo "$(( $(date +%s) * 1000 ))"
  fi
}

total=0; hits=0; refs_hits=0; total_ms=0

echo "=== memory smoke test ==="
for q in "${QUERIES[@]}"; do
  total=$((total+1))
  body="{\"prompt\":$(json_escape "$q")}"
  start=$(ms_now); start=${start:-0}
  resp=$(printf '%s' "$body" | "$HOOK_BIN" sock prompt 2>/dev/null)
  end=$(ms_now); end=${end:-0}
  ms=$((end - start))
  [ "$ms" -lt 0 ] && ms=0
  total_ms=$((total_ms + ms))

  # Count "- [memory/" bullets in additionalContext. The literal pattern
  # doesn't appear elsewhere in the response so grep on the raw JSON works.
  n=$(printf '%s' "$resp" | grep -o '\- \[memory/' | wc -l | tr -d ' ')
  n=${n:-0}
  has_refs="no"
  printf '%s' "$resp" | grep -q "References mentioned above" && has_refs="yes"

  [ "${n:-0}" -gt 0 ] 2>/dev/null && hits=$((hits + 1))
  [ "$has_refs" = "yes" ] && refs_hits=$((refs_hits + 1))
  printf "  %4dms  mem=%d refs=%-3s  %s\n" "$ms" "$n" "$has_refs" "$q"
done

echo ""
echo "=== summary ==="
[ "$total" -gt 0 ] && pct=$((hits*100/total)) || pct=0
echo "queries with >=1 memory: $hits/$total (${pct}%)"
echo "queries with refs footer: $refs_hits/$total"
[ "$total" -gt 0 ] && avg=$((total_ms/total)) || avg=0
echo "avg latency: ${avg}ms"
