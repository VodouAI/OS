#!/usr/bin/env bash
# remote-spike-probe.sh — the OTHER end of PLAN-MCP-EGRESS Phase 4 (§9.4).
#
# Runs on a machine that is NOT the laptop (the AWS spike box) and knocks on the
# tunnel every 5 minutes. Each knock is one CSV row: reachable or not, and why not.
# The laptop cannot measure its own sleep — a prober that sleeps with the patient
# reports perfect health — which is why this file exists at all.
#
# The knock is /health: unauthenticated, no memory touched, so the probe log is
# pure availability with zero disclosure. (A probe that searched memory every 5
# minutes would also spam the audit log with 288 rows a day of noise.)
#
#   ./remote-spike-probe.sh https://xxxx.trycloudflare.com   # foreground
#   nohup ./remote-spike-probe.sh https://xxxx... &          # leave it running
#
# After a day or three:
#   awk -F, '{t++; if ($2=="up") u++} END {printf "%d probes, %.1f%% reachable\n", t, u*100/t}' spike-availability.csv
#
# That percentage IS the phase's deliverable. It decides §9.4: high → the honest
# "laptop unreachable" error is enough and Phase 5's relay may not be worth building;
# low → the relay (or push-wake) is load-bearing and Phase 5 has its justification.

set -u
URL="${1:?usage: remote-spike-probe.sh <tunnel-url>}"
OUT="${2:-spike-availability.csv}"
INTERVAL="${PROBE_INTERVAL:-300}"

[ -f "$OUT" ] || echo "utc,status,http_code,ms" >> "$OUT"
echo "[probe] knocking on $URL/health every ${INTERVAL}s → $OUT"

while true; do
  TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  START=$(date +%s%N 2>/dev/null || echo 0)
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$URL/health" 2>/dev/null)"
  END=$(date +%s%N 2>/dev/null || echo 0)
  MS=$(( (END - START) / 1000000 ))
  if [ "$CODE" = "200" ]; then
    echo "$TS,up,$CODE,$MS" >> "$OUT"
  else
    # 000 = no connection (laptop asleep, tunnel dead, or DNS gone); anything else
    # is the edge answering while the origin does not — different failure, same
    # user-facing outcome: the brain did not answer.
    echo "$TS,down,${CODE:-000},$MS" >> "$OUT"
  fi
  sleep "$INTERVAL"
done
