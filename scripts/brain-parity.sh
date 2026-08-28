#!/bin/bash
# PLAN-BRAIN-INTO-CONSOLE R2 — byte parity of the gateway's /api/brain/* against
# the standalone brain console. Runs the Console's brainRouter on a scratch port
# (no gateway restart, no index.ts) and diffs every route against :8767.
#   scripts/brain-parity.sh            # standalone at 127.0.0.1:8767
#   BRAIN_PORT=9000 scripts/brain-parity.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONSOLE="$ROOT/MCP-servers/Vodou-Console"
# CONSOLE_DIST lets a scratch `tsc --outDir` be tested without touching dist/
# (parallel sessions build dist/; don't interleave).
DIST="${CONSOLE_DIST:-$CONSOLE/dist}"
BRAIN="http://127.0.0.1:${BRAIN_PORT:-8767}"
PORT="${PARITY_PORT:-18765}"
[ -f "$DIST/api/brain.js" ] || { echo "build the Console first (npm run build) — looked in $DIST" >&2; exit 2; }
curl -fsS -m 3 "$BRAIN/api/brain/overview" >/dev/null || { echo "standalone brain not answering at $BRAIN" >&2; exit 2; }

node --input-type=module -e "
import express from '$CONSOLE/node_modules/express/index.js';
import { brainRouter } from '$DIST/api/brain.js';
const a = express(); a.use('/api/brain', brainRouter);
a.listen($PORT, '127.0.0.1', () => console.log('parity server on $PORT'));
" & SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 1.5

# A real chunk id / entity id / file path from the standalone so detail routes are exercised.
NODE=$(curl -s "$BRAIN/api/brain/latest-id" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
ENT=$(curl -s "$BRAIN/api/brain/entities" | sed -n 's/.*"id":\([0-9]*\).*/\1/p' | head -1)
FILE=$(curl -s "$BRAIN/api/brain/graph?max_files=5" | sed -n 's/.*"path":"\([^"]*\)".*/\1/p' | head -1)

ROUTES="overview scopes graph graph?sim=1&max_files=80 latest-id latest latest?sim=1 \
local?id=$NODE similar?id=$NODE node?id=$NODE file?path=$FILE entity?id=$ENT \
entity-net entity-net?by=file&min=2&kinds=all entity-ego?id=$ENT&depth=2 entity-pair?a=$ENT&b=$ENT \
entities projects hosts search?q=vodou search?q=lucy&archived=1&limit=5 timeline timeline?days=30&archived=1 \
conflicts conflicts?status=open node local entity?id=x nope"
fail=0; n=0
for r in $ROUTES; do
  n=$((n+1))
  a=$(curl -s -o /tmp/parity-a.$$ -w '%{http_code}' "$BRAIN/api/brain/$r")
  b=$(curl -s -o /tmp/parity-b.$$ -w '%{http_code}' "http://127.0.0.1:$PORT/api/brain/$r")
  if [ "$a" = "$b" ] && cmp -s /tmp/parity-a.$$ /tmp/parity-b.$$; then
    printf 'ok   %s (%s, %s bytes)\n' "$r" "$a" "$(wc -c < /tmp/parity-a.$$ | tr -d ' ')"
  else
    fail=$((fail+1)); printf 'DIFF %s  standalone=%s gateway=%s\n' "$r" "$a" "$b"
    diff <(head -c 600 /tmp/parity-a.$$) <(head -c 600 /tmp/parity-b.$$) | head -8
  fi
done
rm -f /tmp/parity-a.$$ /tmp/parity-b.$$
echo "$((n-fail))/$n routes identical"
[ "$fail" -eq 0 ]
