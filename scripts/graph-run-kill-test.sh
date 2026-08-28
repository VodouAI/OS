#!/usr/bin/env bash
# =============================================================================
# graph-run-kill-test.sh — prove H20 (durable execution) with a REAL kill.
#
# PLAN-GRAPH-SKILLS P0 exit criterion: "kill the gateway mid-fan, restart, and
# the run either resumes or reports exactly which branches settled before the
# kill."
#
# The unit test in graph-runs.test.ts SIMULATES the kill by simply not calling
# finishRun. That proves the reconcile logic. It does not prove the thing that
# actually worries you about an ungraceful death: whether rows written moments
# before a SIGKILL are still there afterwards, in a DIFFERENT process. WAL, a
# half-flushed page, and an unreleased lock are all real and none of them show
# up when the "kill" is a function you chose not to call.
#
# So this kills a real Node process with SIGKILL, mid-fan, and then reads the
# database back from a fresh process.
#
# ISOLATION — the live stack is never touched (same rule as broken-lab.sh):
# its own gateway.db under a temp dir via GATEWAY_DB_PATH, its own processes,
# and it kills only the pid it spawned. No service is started or stopped.
#
# Usage:  scripts/graph-run-kill-test.sh          KEEP=1 to keep the temp dir
# =============================================================================
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONSOLE="$ROOT/MCP-servers/Vodou-Console"
LAB="$(mktemp -d "${TMPDIR:-/tmp}/vodou-graph-kill.XXXXXX")"
export GATEWAY_DB_PATH="$LAB/gateway.db"

cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then echo "KEEP=1 — lab left at $LAB"; else rm -rf "$LAB"; fi
}
trap cleanup EXIT

echo "== lab: $LAB"
echo "== isolated GATEWAY_DB_PATH=$GATEWAY_DB_PATH"
echo

# Compile the module under test into the lab. ESM (db.ts uses import.meta.url)
# with packages left external, and node_modules symlinked in so those externals
# resolve — the lab borrows the console's deps without copying them.
ln -s "$CONSOLE/node_modules" "$LAB/node_modules"
"$CONSOLE/node_modules/.bin/esbuild" "$CONSOLE/src/graph-runs.ts" \
  --bundle --platform=node --format=esm --packages=external \
  --outfile="$LAB/graph-runs.mjs" --log-level=warning || { echo "BUILD FAILED"; exit 1; }

# ---- Phase 1: a run is in flight; two of three branches have come back -------
cat > "$LAB/mid-fan.mjs" <<'JS'
import { startRun, recordBranches } from './graph-runs.mjs';
const runId = startRun({ skill: 'kill-test-briefing', surface: 'test',
  steps: [{ id: 'calendar', parallel_group: 'sources' },
          { id: 'mail', parallel_group: 'sources' },
          { id: 'slack', parallel_group: 'sources' }] });
recordBranches(runId, [
  { id: 'calendar', group: 'sources', state: 'running' },
  { id: 'mail', group: 'sources', state: 'running' },
  { id: 'slack', group: 'sources', state: 'running' },
]);
recordBranches(runId, [
  { id: 'calendar', group: 'sources', state: 'ok', elapsed_ms: 2517 },
  { id: 'mail', group: 'sources', state: 'ok', elapsed_ms: 684 },
]);
console.log('RUNID=' + runId);
// Slack never comes back. Hold the process open so the kill lands mid-fan,
// with the run still marked `running` — exactly the state a crash leaves.
setInterval(() => {}, 1000);
JS

echo "-- phase 1: start a run, settle 2 of 3, then hold"
node "$LAB/mid-fan.mjs" > "$LAB/out1.txt" 2>"$LAB/err1.txt" &
CHILD=$!
for _ in $(seq 1 60); do grep -q RUNID= "$LAB/out1.txt" 2>/dev/null && break; sleep 0.1; done
RUNID="$(grep -m1 RUNID= "$LAB/out1.txt" | cut -d= -f2)"
if [ -z "$RUNID" ]; then echo "FAIL: child never reported a run id"; cat "$LAB/err1.txt"; exit 1; fi
echo "   run: $RUNID (pid $CHILD)"

echo "-- SIGKILL (no flush, no cleanup, no finishRun)"
kill -9 "$CHILD" 2>/dev/null
wait "$CHILD" 2>/dev/null
sleep 0.3
if kill -0 "$CHILD" 2>/dev/null; then echo "FAIL: child survived SIGKILL"; exit 1; fi
echo "   child $CHILD is gone"

# ---- Phase 2: a fresh process boots and reconciles ---------------------------
cat > "$LAB/reboot.mjs" <<'JS'
import { reconcileInterruptedRuns, getRun } from './graph-runs.mjs';
const runId = process.argv[2];
const before = getRun(runId);
if (!before) { console.log('VERDICT=FAIL reason=row_missing_after_sigkill'); process.exit(1); }
console.log('   survived the kill as: outcome=' + before.outcome);
const n = reconcileInterruptedRuns();
const after = getRun(runId);
const branches = JSON.parse(after.node_states_json || '[]');
const counts = JSON.parse(after.counts_json || '{}');
const byId = Object.fromEntries(branches.map(b => [b.id, b.state]));
console.log('   reconciled ' + n + ' run(s)');
console.log('   outcome=' + after.outcome + ' cancelled_by=' + after.cancelled_by);
console.log('   branches: ' + JSON.stringify(byId));
console.log('   counts:   ' + JSON.stringify(counts));
const ok =
  after.outcome === 'failed' &&
  after.cancelled_by === 'interrupted' &&
  after.ended_at &&
  byId.calendar === 'ok' && byId.mail === 'ok' && byId.slack === 'running' &&
  counts.settled === 2 && counts.expected === 3;
console.log(ok ? 'VERDICT=PASS' : 'VERDICT=FAIL');
process.exit(ok ? 0 : 1);
JS

echo "-- phase 2: fresh process reads the database back and reconciles"
node "$LAB/reboot.mjs" "$RUNID"
RC=$?
echo
if [ $RC -eq 0 ]; then
  echo "H20 PROVEN: a SIGKILLed run keeps its settled branches, is not left"
  echo "            'running', and never reads as complete."
else
  echo "H20 FAILED — see above."
fi
exit $RC
