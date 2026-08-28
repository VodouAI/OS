#!/usr/bin/env bash
# Smoke-test memory recall via the daemon socket.
# Pure bash + tools that ship with macOS (no python3 needed) — works on
# minimal VMs that don't have Xcode CLI tools installed.
#
# ── EXIT CODES (added 2026-08-27) ────────────────────────────────────────────
#
# This script used to end on an `echo`, so it ALWAYS exited 0. Two nightly runs
# proved what that costs:
#
#   20260826-231022  0/10 queries returned a memory, avg latency 17ms  → PASS
#   20260827-122130  4/10 queries returned a memory, avg latency 1480ms → PASS
#                    (an uncontaminated run the board scored 89%)
#
# Seven other nights: 10/10, every one. So a total memory blackout and a 60%
# recall collapse both scored green on a board whose whole job is to notice.
# "Absence-shaped metrics are satisfied by total failure" — a step that cannot
# go red is worse than no step, because it also occupies the slot where a real
# check would have gone.
#
#   0  recall at or above the floor
#   1  BELOW the floor — a real regression in retrieval
#   2  UNKNOWN — the daemon is not reachable, so nothing here was measured.
#      Not a retrieval verdict: a grader with no evidence answers `unknown`,
#      never `ok` (and never `fail` either — that would blame the wrong thing).
#
# VODOU_SMOKE_MEMORY_FLOOR_PCT overrides the floor (default 80: history says
# healthy is 100%, and the two broken nights were 40% and 0%).

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

FLOOR_PCT="${VODOU_SMOKE_MEMORY_FLOOR_PCT:-80}"

# Is the daemon even there? Ask the component that OWNS that answer
# (runtime-status prints this exact hint) instead of opening a second probe of
# our own that could disagree with the row above it on the same board.
VC="${VODOU_CORE_BIN:-./vodou-core}"
daemon_reachable="unknown"
if [ -x "$VC" ] || command -v "$VC" >/dev/null 2>&1; then
  if "$VC" runtime-status 2>/dev/null | grep -q "Daemon not reachable"; then
    daemon_reachable="no"
  else
    daemon_reachable="yes"
  fi
fi

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
# Informational, deliberately NOT graded: the refs footer only appears when a
# retrieved memory cites a source, which these ten queries mostly don't. It has
# read 0/10 on every healthy night too, so gating on it would fail every run.
echo "queries with refs footer: $refs_hits/$total (not graded — see script header)"
[ "$total" -gt 0 ] && avg=$((total_ms/total)) || avg=0
echo "avg latency: ${avg}ms"
echo "floor: ${FLOOR_PCT}%   daemon reachable: ${daemon_reachable}"

echo ""
if [ "$daemon_reachable" = "no" ]; then
  echo "UNKNOWN: the daemon is not reachable, so this measured nothing."
  echo "  Every query above was answered by the hook's fallback, not by retrieval."
  echo "  Fix the daemon (\`vodou-core daemon ensure\`) and re-run; do NOT read this"
  echo "  as a retrieval regression — that is a different row on this board."
  exit 2
fi
if [ "$pct" -lt "$FLOOR_PCT" ]; then
  echo "FAIL: recall ${pct}% is below the ${FLOOR_PCT}% floor (healthy nights: 100%)."
  exit 1
fi
echo "OK: recall ${pct}% >= ${FLOOR_PCT}% floor."
exit 0
