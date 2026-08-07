#!/usr/bin/env bash
# remote-spike.sh — PLAN-MCP-EGRESS Phase 4: the remote spike, dogfood only.
#
# Opens a cloudflared quick tunnel to the loopback MCP egress port (8787), pinned to
# the `remote-spike` client (memory profile, 30/min ceiling, own revocable token —
# minted 2026-08-06), smoke-tests the full path a remote client would use, and prints
# what the availability probe needs.
#
# THE PHASE'S REAL DELIVERABLE IS A NUMBER (§9.4): how often the laptop is asleep or
# offline when a remote caller knocks. That cannot be measured from the laptop — a
# prober that sleeps with the patient reports perfect health. scripts/remote-spike-probe.sh
# runs on the AWS box and does the measuring; this script's job is the tunnel end.
#
# Kill switch, in order of severity:
#   Ctrl-C here                      — tunnel gone, nothing remote remains
#   vodou-core mcp revoke remote-spike — token dead even if a tunnel lingers
#
# Quick tunnels get a random *.trycloudflare.com hostname, need no Cloudflare account,
# and die with the process. Deliberate: nothing persistent, nothing configured, nothing
# to forget to tear down. (§9.5's relay-sees-traffic tension applies to cloudflared too
# — it terminates TLS, so treat the spike as "Cloudflare can see dogfood traffic", which
# is acceptable for a measurement and NOT the product posture. The product picks E2E.)

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${SPIKE_PORT:-8787}"
LOG="$ROOT/.vodou/logs/remote-spike.log"
URL_FILE="$ROOT/.vodou/remote-spike.url"
mkdir -p "$ROOT/.vodou/logs"

# shellcheck disable=SC1091
source "$ROOT/.vodou/remote-spike.env"   # SPIKE_TOKEN= (mode 600; regenerate by re-minting)

command -v cloudflared >/dev/null || { echo "cloudflared not installed (brew install cloudflared)"; exit 1; }
curl -sf -m 3 "http://127.0.0.1:$PORT/health" >/dev/null \
  || { echo "nothing on :$PORT — start it: ./vodou-core mcp-server --http --port $PORT"; exit 1; }

echo "[spike] opening quick tunnel → 127.0.0.1:$PORT ..."
cloudflared tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate >"$LOG" 2>&1 &
CF_PID=$!
trap 'kill $CF_PID 2>/dev/null; rm -f "$URL_FILE"; echo; echo "[spike] tunnel closed — nothing remote remains (token still valid; revoke with: vodou-core mcp revoke remote-spike)"' EXIT

# Three separate waits, because the URL being PRINTED means none of the things that
# matter. Learned the hard way 2026-08-06: the first version treated "hostname appeared
# in the log" as ready and every smoke check failed with a bare curl 000 — which reads
# like the server is broken and is actually "this hostname does not exist in DNS yet."
#
#   1. hostname printed        (cloudflared has picked a name)
#   2. connection REGISTERED   (an edge datacenter will actually route to us)
#   3. hostname RESOLVES       (Cloudflare has published the DNS record)
# and only then the health check, which is the real readiness signal.
TUNNEL_URL=""
for _ in $(seq 1 30); do
  TUNNEL_URL="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$TUNNEL_URL" ] && break
  sleep 1
done
[ -n "$TUNNEL_URL" ] || { echo "[spike] no tunnel URL after 30s — see $LOG"; exit 1; }
echo "$TUNNEL_URL" > "$URL_FILE"
echo "[spike] hostname assigned: $TUNNEL_URL"

for _ in $(seq 1 45); do
  grep -q "Registered tunnel connection" "$LOG" && break
  sleep 1
done
grep -q "Registered tunnel connection" "$LOG" \
  || { echo "[spike] cloudflared never registered a connection — see $LOG"; exit 1; }
echo "[spike] edge connection registered"

HOSTNAME_ONLY="${TUNNEL_URL#https://}"
for _ in $(seq 1 60); do
  host "$HOSTNAME_ONLY" >/dev/null 2>&1 && break
  sleep 2
done
host "$HOSTNAME_ONLY" >/dev/null 2>&1 \
  || { echo "[spike] $HOSTNAME_ONLY still does not resolve after 2min"; exit 1; }
echo "[spike] DNS published"

for _ in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$TUNNEL_URL/health")" = "200" ] && break
  sleep 3
done
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$TUNNEL_URL/health")" = "200" ] \
  || { echo "[spike] health never answered through the tunnel — see $LOG"; exit 1; }
echo "[spike] tunnel up and routing: $TUNNEL_URL"

# ── Smoke: the exact three calls a remote client makes ────────────────────────
# Cloudflare's edge can take a few seconds to route a fresh quick tunnel; retry briefly.
mcp() { curl -s -m 30 "$TUNNEL_URL/mcp" \
          -H "Authorization: Bearer $SPIKE_TOKEN" -H "Content-Type: application/json" -d "$1"; }

echo "[spike] smoke-testing through the tunnel..."
for _ in $(seq 1 10); do
  INIT="$(mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"remote-spike","version":"1"}}}' || true)"
  echo "$INIT" | grep -q protocolVersion && break
  sleep 2
done
echo "$INIT" | grep -q protocolVersion || { echo "[spike] FAIL: initialize never answered through the tunnel"; exit 1; }
echo "  PASS initialize"

TOOLS="$(mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')"
COUNT="$(echo "$TOOLS" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["result"]["tools"]))')"
[ "$COUNT" -le 5 ] || { echo "[spike] FAIL: remote catalog has $COUNT tools — profile not pinned?"; exit 1; }
echo "  PASS catalog is profile-scoped ($COUNT tools)"

ANSWER="$(mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"vc_memory_search","arguments":{"query":"what is my dog named","top_k":2}}}')"
# The expected token is OPERATOR DATA (a fact from your own vault, e.g. your
# pet's name) — parameterized so the literal never ships in public source.
: "${VODOU_SPIKE_EXPECT:?set VODOU_SPIKE_EXPECT to a word from a vault fact (e.g. your pet's name)}"
echo "$ANSWER" | grep -q "$VODOU_SPIKE_EXPECT" || { echo "[spike] FAIL: memory did not answer through the tunnel"; exit 1; }
echo "  PASS vc_memory_search answered from the vault, remotely"

DENIED="$(mcp '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"vc_workspace_run_command","arguments":{"command":"echo owned"}}}')"
echo "$DENIED" | grep -q 'not available' || { echo "[spike] FAIL: shell was NOT refused remotely"; exit 1; }
echo "  PASS shell refused through the tunnel"

# Wrong token must die at the door.
BAD="$(curl -s -o /dev/null -w '%{http_code}' -m 30 "$TUNNEL_URL/mcp" \
        -H "Authorization: Bearer 0000000000000000000000000000000000000000000000000000000000000000" \
        -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":5,"method":"tools/list"}')"
[ "$BAD" = "401" ] || { echo "[spike] FAIL: bad token got HTTP $BAD, expected 401"; exit 1; }
echo "  PASS unknown token refused (401)"

echo
echo "[spike] ALL SMOKE CHECKS PASSED. The brain is reachable, scoped, and locked."
echo
echo "  Availability probe (run on the AWS box, 52.87.164.1):"
echo "    scp scripts/remote-spike-probe.sh ec2:  &&  nohup ./remote-spike-probe.sh '$TUNNEL_URL' &"
echo
echo "[spike] Tunnel stays open until Ctrl-C. Every remote call lands in: vodou-core mcp audit --client remote-spike"
wait $CF_PID
