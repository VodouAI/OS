#!/bin/bash
# qa.sh — the VODOU QA truth layer. Tiered runner over EXISTING suites/verifiers/benches.
# Usage: scripts/qa/qa.sh <fast|full|nightly> [--json]
#
# Orchestrates, never reimplements. Continue-on-fail: every step runs, every result is
# recorded, exit is non-zero if anything failed. Scorecards land in .vodou/qa/ and a
# summary row lands in qa_health_history (vodou-core.db) — the table the gateway's
# home-state / #/system tile reads, mirroring memory_health_history.
#
# Sequential by design: VODOU_MAX_PROCESSES on this machine is tight (core_limit 4)
# and rapid vodou-core spawn loops are a known incident class. One step at a time.
#
# Plan: PLANS/0.6.28/VODOU-QA/PLAN-VODOU-QA.md

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TIER="${1:-}"
JSON_OUT=0
[ "${2:-}" = "--json" ] && JSON_OUT=1
case "$TIER" in
  fast|full|nightly) ;;
  *) echo "usage: scripts/qa/qa.sh <fast|full|nightly> [--json]" >&2; exit 64 ;;
esac

STAMP="$(date +%Y%m%d-%H%M%S)"   # local day identity per time canon
QA_DIR="$ROOT/.vodou/qa"
LOG_DIR="$QA_DIR/logs/$STAMP-$TIER"
mkdir -p "$LOG_DIR"
RESULTS_TSV="$LOG_DIR/results.tsv"
: > "$RESULTS_TSV"

# Per-step wall clock cap (seconds). A hung suite must not wedge the nightly.
STEP_TIMEOUT="${VODOU_QA_STEP_TIMEOUT_SECS:-1800}"

# ── run fingerprint (2026-08-27) ───────────────────────────────────────────────
# The 2026-08-26 nightly scored 61%: 4 of its 7 reds (retrieval-bench,
# inject-bench, runtime-status, library-e2e) were one event — the engine binary
# was rebuilt at 22:58 and the daemon restarted at 23:19, inside the run. The
# scorecard reported them as four product defects. A run during which the
# daemon, the binary, or the tree changed is not a measurement of the product;
# it is marked CONTAMINATED and says what moved, so nobody chases four ghosts.
run_fingerprint() {
  local dpid; dpid=$(cat "$ROOT/.vodou/daemon.pid" 2>/dev/null || echo none)
  local bin_mtime; bin_mtime=$(stat -f %m "$ROOT/vodou-core" 2>/dev/null || stat -c %Y "$ROOT/vodou-core" 2>/dev/null || echo 0)
  local head; head=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo none)
  printf 'daemon_pid=%s binary_mtime=%s head=%s' "$dpid" "$bin_mtime" "$head"
}
FP_START="$(run_fingerprint)"

run_step() {
  # run_step <name> <workdir> <command...>
  local name="$1"; shift
  local workdir="$1"; shift
  local log="$LOG_DIR/$name.log"
  local start end rc
  echo "── [$TIER] $name"
  start=$(date +%s)
  (
    cd "$workdir" && exec "$@"
  ) > "$log" 2>&1 &
  local pid=$!
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep 2
    waited=$((waited + 2))
    if [ "$waited" -ge "$STEP_TIMEOUT" ]; then
      echo "[qa] TIMEOUT after ${STEP_TIMEOUT}s — killing $name (pid $pid)" | tee -a "$log" >&2
      pkill -TERM -P "$pid" 2>/dev/null; kill -TERM "$pid" 2>/dev/null
      sleep 3
      pkill -KILL -P "$pid" 2>/dev/null; kill -KILL "$pid" 2>/dev/null
      break
    fi
  done
  wait "$pid" 2>/dev/null; rc=$?
  [ "$waited" -ge "$STEP_TIMEOUT" ] && rc=124
  end=$(date +%s)
  local secs=$((end - start))
  # tail: last 6 lines, tabs/newlines flattened so the TSV stays one row per step
  local tail_txt
  tail_txt=$(tail -6 "$log" 2>/dev/null | tr '\t' ' ' | tr '\n' '¶')
  printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$rc" "$secs" "$log" "$tail_txt" >> "$RESULTS_TSV"
  if [ "$rc" -eq 0 ]; then echo "   ok (${secs}s)"; else echo "   FAIL rc=$rc (${secs}s) → $log"; fi
  return 0
}

# ── fast tier ──────────────────────────────────────────────────────────────────
run_step console-test "$ROOT/MCP-servers/Vodou-Console" npm test
run_step rust-test    "$ROOT" cargo test --bin vodou-core
run_step ext-test     "$ROOT/extension/Store-vodou-bridge" bash -c 'node --test test/*.test.mjs'

# ── full tier ──────────────────────────────────────────────────────────────────
if [ "$TIER" = "full" ] || [ "$TIER" = "nightly" ]; then
  run_step board-test      "$ROOT/MCP-servers/Vodou-Board" npm test
  run_step brain-test      "$ROOT/MCP-servers/brain" npm test
  run_step clippy          "$ROOT" cargo clippy --bin vodou-core
  run_step lint-continuity "$ROOT" bash scripts/lint-continuity-boundary.sh
  run_step sqlite-binds    "$ROOT" python3 scripts/audit-sqlite-binds.py
  run_step validate-skills "$ROOT" python3 scripts/validate-skills.py
  run_step node-pin        "$ROOT" bash scripts/check-node-pin.sh
  run_step builds-drift    "$ROOT" ./vodou-core builds --json
fi

# ── nightly tier (needs live services; benches use the SOCKET path — F36) ─────
if [ "$TIER" = "nightly" ]; then
  run_step retrieval-bench "$ROOT" ./vodou-core mem retrieval-bench --passes 2 --json
  run_step inject-bench    "$ROOT" ./vodou-core mem inject-bench --json
  run_step runtime-status  "$ROOT" ./vodou-core runtime-status
  run_step smoke           "$ROOT" bash scripts/smoke-test.sh
  run_step smoke-memory    "$ROOT" bash scripts/smoke-memory.sh
  run_step system-test     "$ROOT" bash scripts/system-test.sh
  run_step doctor          "$ROOT" bash scripts/vodou-doctor.sh
fi

# ── expected step counts per tier: a runner that silently skipped steps must not
#    report green (the release-playbook lesson: read the COUNTS, not the exit code)
case "$TIER" in
  fast)    EXPECTED=3 ;;
  full)    EXPECTED=11 ;;
  nightly) EXPECTED=18 ;;
esac
ACTUAL=$(wc -l < "$RESULTS_TSV" | tr -d ' ')
COUNT_OK=1
if [ "$ACTUAL" -ne "$EXPECTED" ]; then
  COUNT_OK=0
  echo "[qa] COUNT MISMATCH: expected $EXPECTED steps for tier $TIER, ran $ACTUAL" >&2
fi

# ── contamination check ────────────────────────────────────────────────────────
FP_END="$(run_fingerprint)"
CONTAMINATED=""
if [ "$FP_START" != "$FP_END" ]; then
  CONTAMINATED="run fingerprint changed: [$FP_START] → [$FP_END]"
  echo "[qa] CONTAMINATED — $CONTAMINATED" >&2
fi

# ── scorecard ──────────────────────────────────────────────────────────────────
SCORECARD="$QA_DIR/scorecard-$STAMP-$TIER.json"
export QA_TIER="$TIER" QA_STAMP="$STAMP" QA_RESULTS="$RESULTS_TSV" QA_SCORECARD="$SCORECARD" QA_COUNT_OK="$COUNT_OK" QA_EXPECTED="$EXPECTED" QA_CONTAMINATED="$CONTAMINATED"
python3 - <<'PYEOF'
import json, os, datetime

steps = []
with open(os.environ["QA_RESULTS"]) as f:
    for line in f:
        parts = line.rstrip("\n").split("\t")
        if len(parts) < 5:
            continue
        name, rc, secs, log, tail = parts[0], int(parts[1]), int(parts[2]), parts[3], parts[4]
        steps.append({"name": name, "exit": rc, "seconds": secs, "log": log,
                      "tail": tail.replace("¶", "\n").strip()})

passed = sum(1 for s in steps if s["exit"] == 0)
failed = len(steps) - passed
pct = round(100 * passed / len(steps)) if steps else 0
card = {
    "tier": os.environ["QA_TIER"],
    "stamp": os.environ["QA_STAMP"],
    # instant in naive UTC per time canon; the stamp above is the local-day identity
    "recorded_at_utc": datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
    "expected_steps": int(os.environ["QA_EXPECTED"]),
    "steps_run": len(steps),
    "count_ok": os.environ["QA_COUNT_OK"] == "1",
    # a daemon restart / binary swap / commit landed mid-run: the numbers below
    # describe a moving target, not the product. Empty string = clean run.
    "contaminated": os.environ.get("QA_CONTAMINATED", ""),
    "passed": passed,
    "failed": failed,
    "pct": pct,
    "duration_s": sum(s["seconds"] for s in steps),
    "steps": steps,
}
path = os.environ["QA_SCORECARD"]
with open(path, "w") as f:
    json.dump(card, f, indent=2)
latest = os.path.join(os.path.dirname(path), "latest.json")
with open(latest, "w") as f:
    json.dump(card, f, indent=2)

# markdown summary next to the json
md = [f"# QA scorecard — {card['tier']} — {card['stamp']}",
      "",
      f"**{pct}%** — {passed} passed / {failed} failed of {len(steps)} steps"
      + ("" if card["count_ok"] else f" — ⚠ COUNT MISMATCH (expected {card['expected_steps']})")
      + (f"\n\n**⚠ CONTAMINATED — not a product reading.** {card['contaminated']}" if card["contaminated"] else ""),
      "",
      "| step | result | secs |",
      "|---|---|---|"]
for s in steps:
    result = "ok" if s["exit"] == 0 else "FAIL rc=%d" % s["exit"]
    md.append(f"| {s['name']} | {result} | {s['seconds']} |")
md.append("")
for s in steps:
    if s["exit"] != 0:
        md.append(f"## {s['name']} (rc={s['exit']})\n```\n{s['tail']}\n```\n(log: {s['log']})\n")
md_text = "\n".join(md) + "\n"
with open(path.replace(".json", ".md"), "w") as f:
    f.write(md_text)
# human-readable twin of latest.json — the chat/console surfaces read this one
with open(os.path.join(os.path.dirname(path), "latest.md"), "w") as f:
    f.write(md_text)
PYEOF

# ── history row (vodou-core.db); naive UTC instant via datetime('now') ─────────
PASSED=$(python3 -c "import json;print(json.load(open('$SCORECARD'))['passed'])")
FAILED=$(python3 -c "import json;print(json.load(open('$SCORECARD'))['failed'])")
PCT=$(python3 -c "import json;print(json.load(open('$SCORECARD'))['pct'])")
DUR=$(python3 -c "import json;print(json.load(open('$SCORECARD'))['duration_s'])")
sqlite3 "$ROOT/vodou-core.db" <<SQLEOF
CREATE TABLE IF NOT EXISTS qa_health_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  tier TEXT NOT NULL,
  pct INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  duration_s INTEGER NOT NULL,
  scorecard_path TEXT
);
SQLEOF
# contaminated column: added 2026-08-27; ALTER is not idempotent, so probe first
if ! sqlite3 "$ROOT/vodou-core.db" "PRAGMA table_info(qa_health_history);" | grep -q '|contaminated|'; then
  sqlite3 "$ROOT/vodou-core.db" "ALTER TABLE qa_health_history ADD COLUMN contaminated TEXT;"
fi
CONTAM_SQL=$(printf '%s' "$CONTAMINATED" | sed "s/'/''/g")
sqlite3 "$ROOT/vodou-core.db" <<SQLEOF
INSERT INTO qa_health_history (tier, pct, passed, failed, duration_s, scorecard_path, contaminated)
VALUES ('$TIER', $PCT, $PASSED, $FAILED, $DUR, '$SCORECARD', '$CONTAM_SQL');
SQLEOF

echo ""
echo "════════════════════════════════════════"
if [ "$JSON_OUT" -eq 1 ]; then
  cat "$SCORECARD"
else
  cat "${SCORECARD%.json}.md"
fi

# exit contract: 0 all green AND counts match; 1 otherwise
[ "$FAILED" -eq 0 ] && [ "$COUNT_OK" -eq 1 ] && exit 0
exit 1
