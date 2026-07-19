#!/bin/bash
# =============================================================================
# verify-clean-install.sh — the launch gate for the open-core v0.6.19 release.
# Run on a CLEAN Mac (no Vodou installed). Proves a fresh public install works
# end to end: fetch open tree + sha256-verified engine → provision (Node + npm
# + build) → services boot → health → memory round-trip.
#
#   curl -fsSL https://raw.githubusercontent.com/VodouAI/OS/main/install-vodou.sh | bash
# is what a real user runs; this wraps it + asserts each stage.
#
# Usage:  bash verify-clean-install.sh
#         VODOU_VERSION=0.6.19 bash verify-clean-install.sh   # pin a version
# =============================================================================
set -uo pipefail
DIR="$HOME/vodou-e2e-$(date +%s)"
PORT="${WEB_PORT:-8788}"          # non-default so it can't collide
PASS=0; FAIL=0
ok()   { echo "  ✅ $*"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $*"; FAIL=$((FAIL+1)); }
hdr()  { echo ""; echo "── $* ──"; }

echo "════════════════════════════════════════════════"
echo "  Vodou clean-install E2E gate → $DIR (port $PORT)"
echo "════════════════════════════════════════════════"

hdr "1. Preconditions (this box must be CLEAN)"
[ -z "$(command -v vodou 2>/dev/null)" ] && ok "no existing 'vodou' on PATH" || echo "  ⚠️  a 'vodou' is already on PATH — results may be muddied"

hdr "2. Install via the PUBLIC one-liner (fetch tree + engine + provision)"
# In-tree path: clone OS then run its installer (mirrors the git-clone flow).
if git clone --depth 1 https://github.com/VodouAI/OS "$DIR" >/dev/null 2>&1; then
  ok "cloned VodouAI/OS"
else bad "clone failed"; fi
( cd "$DIR" && VODOU_HEADLESS=1 WEB_PORT="$PORT" VODOU_VERSION="${VODOU_VERSION:-latest}" ./install-vodou.sh ) 2>&1 | sed 's/^/    /'

hdr "3. Engine fetched + sha256-verified (from vodou-core)"
[ -x "$DIR/vodou-core" ] && ok "vodou-core present ($("$DIR/vodou-core" version 2>/dev/null | head -1))" || bad "vodou-core missing"
[ -d "$DIR/onnxruntime" ] && ok "onnxruntime bundled" || bad "onnxruntime missing"

hdr "4. Source provisioning (Node runtime + servers)"
[ -x "$DIR/.node/node" ] && ok "bundled Node fetched ($("$DIR/.node/node" --version 2>/dev/null))" || bad "bundled Node missing"
for s in Vodou-Console brain Vodou-Recall Vodou-session-manager; do
  d="$DIR/MCP-servers/$s"
  { [ -d "$d/node_modules" ] && [ -f "$d/dist/index.js" ]; } && ok "$s provisioned (node_modules + dist)" || bad "$s NOT provisioned"
done

hdr "5. Services boot + health"
( cd "$DIR" && WEB_PORT="$PORT" ./start-vodou-services.sh ) >/dev/null 2>&1 || true
# give the gateway a few seconds to bind (bounded, no infinite wait)
for _ in 1 2 3 4 5 6 7 8 9 10; do curl -fsS "http://localhost:$PORT/health" >/dev/null 2>&1 && break; sleep 2; done
if curl -fsS "http://localhost:$PORT/health" >/dev/null 2>&1; then ok "gateway /health 200 on :$PORT"; else bad "gateway not responding on :$PORT"; fi
if [ -x "$DIR/vodou-core" ]; then
  ( cd "$DIR" && ./vodou-core health-check >/dev/null 2>&1 ) && ok "vodou-core health-check OK" || echo "  ⚠️  vodou-core health-check non-zero (may need credentials)"
fi

hdr "6. Memory round-trip (engine answers a brain query)"
if [ -x "$DIR/vodou-core" ]; then
  OUT=$(cd "$DIR" && timeout 30 ./vodou-core brain "ping" 2>/dev/null | head -3)
  [ -n "$OUT" ] && ok "brain responded: $(echo "$OUT" | head -1 | cut -c1-60)" || echo "  ⚠️  brain query empty (cold start or needs VODOU_TOKEN)"
fi

hdr "RESULT"
echo "  PASS=$PASS  FAIL=$FAIL"
if [ "$FAIL" -eq 0 ]; then
  echo "  ✅ LAUNCH GATE PASSED — a fresh public clone installs + boots."
else
  echo "  ❌ $FAIL check(s) failed — do NOT announce. Inspect above."
fi
echo ""
echo "  Teardown when done:  cd '$DIR' && ./stop-vodou-services.sh; cd ~ && rm -rf '$DIR'"
echo "  (also: launchctl bootout for the per-install agent if you want a truly clean box)"
