#!/usr/bin/env bash
#
# verify-run-outcome.sh — prove that a scheduled run can be WRONG and say so.
#
# The defect this guards (D1/D2): a run's entire record was one free-text line,
# and `ok (skill_id=7, 0 chars)` was indistinguishable from `ok (…, 4539 chars)`.
# vodou-channel-finder failed four consecutive runs while logging `ok`, and it
# surfaced only because the LLM in a chat tab volunteered that it had done the
# work by hand. Lateness was worse than unmeasured: it was *unmeasurable*,
# because the scheduler overwrites `next_run_at` with the following slot the
# moment a run finishes, destroying the only record of what the run was due for.
#
# Four things are checked, and each is a different failure mode:
#   1. the migration applies to a real (copied) database, not just a blank one
#   2. `lateness_s` computes correctly from an RFC3339 next_run_at against a
#      naive-UTC started_at — the two formats really are mixed in this tree
#   3. the verdict logic (derive_run_status) maps the real observed strings
#   4. the wiring exists: the scheduler opens a row BEFORE firing, so a killed
#      run stays visible as `running`
#
# Hermetic: temp copies only. Nothing here touches the live databases.
#
# Usage: bash scripts/verify-run-outcome.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0; skip=0
ok()   { printf "  ok   %s\n" "$1"; pass=$((pass+1)); }
bad()  { printf "NOT OK %s\n" "$1"; fail=$((fail+1)); }
# A skipped check is NOT a passing one. Counted and reported in the summary
# because a verifier that quietly skips its real work and exits 0 is CI theatre —
# the build goes green and nobody learns that nothing was proved.
skip() { printf "  ..   SKIPPED %s\n" "$1"; skip=$((skip+1)); }
need(){ command -v "$1" >/dev/null 2>&1 || { echo "missing prerequisite: $1" >&2; exit 2; }; }
need sqlite3

echo "── 1. migration 086 applies to a copy of the live schema ──"
if [ -f vodou-core.db ]; then
  cp vodou-core.db "$TMP/core.db"
  before="$(sqlite3 "$TMP/core.db" 'SELECT COALESCE(MAX(version),0) FROM schema_version;' 2>/dev/null || echo 0)"
else
  sqlite3 "$TMP/core.db" "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT);"
  before=0
fi
if sqlite3 "$TMP/core.db" < migrations/086_run_outcomes.sql 2>"$TMP/mig.err"; then
  ok "migration applies (live schema was v$before)"
else
  bad "migration failed: $(head -2 "$TMP/mig.err")"
fi

for t in scheduled_task_runs turn_receipts; do
  if [ "$(sqlite3 "$TMP/core.db" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='$t';")" = "1" ]; then
    ok "table $t exists"
  else
    bad "table $t missing"
  fi
done

# Idempotence: migrations get re-run on upgrade paths and must not explode.
if sqlite3 "$TMP/core.db" < migrations/086_run_outcomes.sql 2>/dev/null; then
  ok "migration is idempotent (CREATE IF NOT EXISTS)"
else
  bad "second application failed — not idempotent"
fi

echo
echo "── 2. lateness_s: RFC3339 schedule vs naive-UTC start ──"
# The real drift observed 2026-08-18: morning-briefing cron 5 13 * * *,
# next_run_at stored as RFC3339, actually started 15:24:13. Expect ~2h19m.
LATE="$(sqlite3 "$TMP/core.db" "
  SELECT CAST((julianday('2026-08-18 15:24:13')
             - julianday(replace(replace('2026-08-19T13:05:00.000Z','T',' '),'Z','')))
             * 86400 AS INTEGER);" 2>/dev/null)"
# (using the same-day slot for the arithmetic check)
LATE="$(sqlite3 "$TMP/core.db" "
  SELECT CAST((julianday('2026-08-18 15:24:13')
             - julianday(replace(replace('2026-08-18T13:05:00.000Z','T',' '),'Z','')))
             * 86400 AS INTEGER);")"
if [ "$LATE" -ge 8300 ] && [ "$LATE" -le 8400 ]; then
  ok "2h19m drift computes as ${LATE}s (expected ~8352)"
else
  bad "lateness math wrong: got ${LATE}s, expected ~8352"
fi

# A run that fired early or on time must not report negative-as-late nonsense.
ONTIME="$(sqlite3 "$TMP/core.db" "
  SELECT CAST((julianday('2026-08-18 13:05:02')
             - julianday(replace(replace('2026-08-18T13:05:00.000Z','T',' '),'Z','')))
             * 86400 AS INTEGER);")"
if [ "$ONTIME" -le 5 ]; then ok "on-time run reads ${ONTIME}s"; else bad "on-time run reads ${ONTIME}s"; fi

echo
echo "── 3. the verdict logic (Rust unit tests) ──"
if command -v cargo >/dev/null 2>&1; then
  if cargo test --quiet --bin vodou-core run_status_tests >"$TMP/cargo.out" 2>&1; then
    n="$(grep -oE '[0-9]+ passed' "$TMP/cargo.out" | head -1 | cut -d' ' -f1)"
    ok "derive_run_status: ${n:-?} tests pass (incl. the real 0-chars line)"
  else
    bad "derive_run_status tests failed"; tail -15 "$TMP/cargo.out"
  fi
else
  skip "the verdict tests (cargo not on PATH)"
fi

echo
echo "── 4. the wiring: a row is opened BEFORE the work ──"
# Grep is weak evidence in general, but here the ORDER is the property under
# test and it cannot be observed from the schema: run_start must be called
# before the HTTP POST, or a killed run leaves no trace at all.
# Anchors must be scoped to the skill_run arm and must match CODE, not comments.
# The first version compared against a comment mentioning /chat/skill-fire and
# against a schedule_update_last_run in an unrelated task arm, and reported two
# false failures. The property under test is an ORDER, so a wrong anchor inverts
# the answer — precision matters more than brevity here.
ARM_START="$(grep -n 'if _payload_type == "skill_run"' src/scheduler.rs | head -1 | cut -d: -f1)"
arm_line() { awk -v s="$ARM_START" -v pat="$1" 'NR>=s && $0 ~ pat {print NR; exit}' src/scheduler.rs; }
START_LINE="$(arm_line 'db\\.run_start\\(')"
POST_LINE="$(arm_line '\\.post\\(format!')"
FINISH_LINE="$(arm_line 'db\\.run_finish\\(')"
SF_LINE="$(arm_line 'schedule_get_scheduled_for\\(')"
UPD_LINE="$(arm_line 'schedule_update_last_run\\(')"

if [ -n "$START_LINE" ] && [ -n "$POST_LINE" ] && [ "$START_LINE" -lt "$POST_LINE" ]; then
  ok "run_start (:$START_LINE) precedes the fire (:$POST_LINE)"
else
  bad "run_start (:${START_LINE:-none}) does not precede the fire (:${POST_LINE:-none})"
fi
if [ -n "$FINISH_LINE" ] && [ -n "$POST_LINE" ] && [ "$FINISH_LINE" -gt "$POST_LINE" ]; then
  ok "run_finish (:$FINISH_LINE) follows the fire"
else
  bad "run_finish is not after the fire"
fi
if [ -n "$SF_LINE" ] && [ -n "$UPD_LINE" ] && [ "$SF_LINE" -lt "$UPD_LINE" ]; then
  ok "scheduled_for read (:$SF_LINE) before next_run_at overwritten (:$UPD_LINE)"
else
  bad "scheduled_for (:${SF_LINE:-none}) not read before the overwrite (:${UPD_LINE:-none})"
fi

echo
echo "── 5. receipts: the gateway writes one per turn ──"
if grep -q "INSERT INTO turn_receipts" MCP-servers/Vodou-Console/src/llm.ts; then
  ok "llm.ts writes turn_receipts"
else
  bad "no turn_receipts writer in llm.ts"
fi

echo
echo "── 6. the process valve cannot silently starve a due task ──"
# Measured 2026-08-19: vodou-channel-finder ran 219s late, three ticks skipped.
# `VODOU_MAX_PROCESSES=5` was set in 2026-04 against a *vodou-core* leak, with
# "healthy steady state is 2". The counter was later widened to include the
# gateway's claude pool without re-tuning the threshold, so 2 core + 3 pool = 5
# exceeded a limit of 4 and every due task was skipped — invisibly, because the
# skip was debug-only and left no row.
if command -v cargo >/dev/null 2>&1; then
  if cargo test --quiet --bin vodou-core defer_valve >"$TMP/valve.out" 2>&1; then
    n="$(grep -oE '[0-9]+ passed' "$TMP/valve.out" | head -1 | cut -d' ' -f1)"
    ok "defer_reason: ${n:-?} tests pass (incl. the 2-core/3-pool false trip)"
  else
    bad "defer_reason tests failed"; tail -15 "$TMP/valve.out"
  fi
else
  skip "the valve tests (cargo not on PATH)"
fi

# The two limits must stay separate. Re-merging them re-creates the starvation,
# and raising VODOU_MAX_PROCESSES to compensate would loosen the leak guard
# instead — the wrong knob, which is how this got missed the first time.
if grep -q "crate::total_managed_process_count()" src/scheduler.rs; then
  bad "scheduler is back on the COMBINED count — the pool can starve the scheduler again"
else
  ok "scheduler reads vodou-core and claude-pool against separate limits"
fi

# A deferral must leave a row. Log-only was the original invisibility.
if grep -q "record_task_deferral" src/scheduler.rs && grep -q "'deferred'" src/database.rs; then
  ok "a deferred task writes a durable row"
else
  bad "deferral is not recorded — a skipped task would be invisible again"
fi

echo
echo "── 7. required_tools is a contract, not decoration ──"
GW="MCP-servers/Vodou-Console"
# It was advisory metadata nothing read at run time: a skill could declare six
# tools, call none, and report `ok`. Three properties, each a separate failure.

# (a) resolved BEFORE the turn — otherwise a broken declaration burns minutes
#     of LLM time and fails in prose.
if grep -q "resolveRequiredTools(getDb(), skill.required_tools)" "$GW/src/index.ts"; then
  ok "declaration resolved before chat() is called"
else
  bad "nothing resolves required_tools pre-flight — a broken skill still spends a turn"
fi

# (b) the bound is enforced at the executor choke point, not in the prompt.
#     A prompt-level restriction is a request; this is a bound.
if grep -q "toolCallRefusal(server, tool)" "$GW/src/executor.ts"; then
  ok "allowlist enforced in runVodouCore (every MCP call passes through it)"
else
  bad "no enforcement at the executor — the allowlist would be advisory again"
fi

# (c) declaring nothing must stay unrestricted. 2 of the 4 live agents declare
#     nothing, and a deny-by-default reading would silently disable them.
if grep -q "if (!allow || allow.length === 0) return null;" "$GW/src/project-context.ts"; then
  ok "an absent/empty declaration fails OPEN (undeclared skills unaffected)"
else
  bad "allowlist may not fail open — undeclared skills could be disabled"
fi

if command -v cargo >/dev/null 2>&1; then
  if cargo test --quiet --bin vodou-core tool_contract >"$TMP/contract.out" 2>&1; then
    n="$(grep -oE '[0-9]+ passed' "$TMP/contract.out" | head -1 | cut -d' ' -f1)"
    ok "run-status interaction: ${n:-?} tests pass (downgrade never upgrades)"
  else
    bad "tool-contract status tests failed"; tail -12 "$TMP/contract.out"
  fi
else
  skip "the run-status interaction tests (cargo not on PATH)"
fi

echo
echo "── 8. every scheduler arm that RUNS writes a run row ──"
# The heartbeat arm was the last one without a row — found by the heartbeat
# itself on 2026-08-19, after step 3 shipped run rows for skill_run only. An arm
# that fires real work with no row is exactly the blindness step 3 removed,
# surviving in one lane. Order matters here too: opened before the fire, so a
# killed run stays visible as `running`.
HB_START="$(grep -n 'let is_heartbeat' src/scheduler.rs | head -1 | cut -d: -f1)"
SF_START="$(grep -n 'if _payload_type == "skill_run"' src/scheduler.rs | head -1 | cut -d: -f1)"
# index(), not a regex: `awk -v` processes escape sequences in the assignment,
# so `db\.run_start\(` reached the matcher as `db.run_start(` — an unescaped
# paren, which is an illegal primary. A literal substring is what is wanted here
# anyway, and it cannot be mangled.
hb_line() { awk -v s="$HB_START" -v e="$SF_START" -v pat="$1" 'NR>=s && NR<=e && index($0, pat) > 0 {print NR; exit}' src/scheduler.rs; }
HB_OPEN="$(hb_line 'db.run_start(')"
HB_FIRE="$(hb_line 'fire_heartbeat_to_gateway(')"
HB_CLOSE="$(hb_line 'db.run_finish(')"
if [ -n "$HB_OPEN" ] && [ -n "$HB_FIRE" ] && [ "$HB_OPEN" -lt "$HB_FIRE" ]; then
  ok "heartbeat run_start (:$HB_OPEN) precedes its fire (:$HB_FIRE)"
else
  bad "heartbeat opens no run row before firing (open=${HB_OPEN:-none} fire=${HB_FIRE:-none})"
fi
if [ -n "$HB_CLOSE" ] && [ -n "$HB_FIRE" ] && [ "$HB_CLOSE" -gt "$HB_FIRE" ]; then
  ok "heartbeat run_finish (:$HB_CLOSE) follows its fire"
else
  bad "heartbeat never closes its run row"
fi
# The budget: a client timeout is ignorance, not failure. Both LLM arms must be
# configurable, or one silently keeps filing long successes as failures.
if grep -q "VODOU_HEARTBEAT_TIMEOUT_SECS" src/scheduler.rs; then
  ok "heartbeat budget is configurable (was a hardcoded 600s)"
else
  bad "heartbeat still has a hardcoded timeout"
fi
if command -v cargo >/dev/null 2>&1; then
  if cargo test --quiet --bin vodou-core heartbeat_run_row >"$TMP/hb.out" 2>&1; then
    n="$(grep -oE '[0-9]+ passed' "$TMP/hb.out" | head -1 | cut -d' ' -f1)"
    ok "heartbeat verdict mapping: ${n:-?} tests pass"
  else
    bad "heartbeat run-row tests failed"; tail -12 "$TMP/hb.out"
  fi
else
  skip "the heartbeat run-row tests (cargo not on PATH)"
fi

echo
echo "── 9. skill creation is verified, previewed, and visible ──"
GW2="MCP-servers/Vodou-Console"
# (a) One verifier, both skill systems. skills_registry had verify() since it was
#     written; skills_meta — where all four live standing agents are — had none.
if grep -q "verify_tool_refs(&self.database" src/mcp_server.rs; then
  ok "handle_skills_create resolves required_tools before INSERT"
else
  bad "skill creation still writes a row without checking its declared tools"
fi
# (b) Creation must not be MORE PERMISSIVE than firing, or a skill is accepted
#     here and then refuses to run on its schedule days later.
if grep -q "COALESCE(active, 1) = 1" src/database.rs; then
  ok "creation-time resolution honours mcp_servers.active, like the fire gate"
else
  bad "creation-time check ignores active servers — it would disagree with F3"
fi
# (c) The dry run must be read-only. Chad chose "arm the cron anyway", which is
#     what makes this load-bearing: the skill WILL be scheduled, so the preview
#     must not already have sent anything on his behalf.
if grep -q "DRY RUN: " "$GW2/src/project-context.ts"; then
  ok "dry run refuses write-shaped tools"
else
  bad "dry run is not read-only — a preview could send/delete for real"
fi
# (d) A dry run must not satisfy the alpha gate. Marking first_automation here
#     would make it reachable by creating a skill, which is the thing it proves.
if grep -q "!isDryRun && sfText" "$GW2/src/index.ts"; then
  ok "a dry run does not fire funnel.first_automation"
else
  bad "a dry run could fire the alpha gate milestone"
fi
# (e) The four standing agents must be visible somewhere a stranger would look.
if grep -q "skill-console/list" "$GW2/public/js/views/skills.js"; then
  ok "Skills view renders skills_meta rows (Standing agents)"
else
  bad "the running agents are still invisible in the Skills view"
fi
if command -v cargo >/dev/null 2>&1; then
  if cargo test --quiet --bin vodou-core verify_tool_refs >"$TMP/vtr.out" 2>&1; then
    n="$(grep -oE '[0-9]+ passed' "$TMP/vtr.out" | head -1 | cut -d' ' -f1)"
    ok "verify_tool_refs: ${n:-?} tests pass"
  else
    bad "verify_tool_refs tests failed"; tail -12 "$TMP/vtr.out"
  fi
else
  skip "the verify_tool_refs tests (cargo not on PATH)"
fi

echo
echo "── 10. the proposer learns from user text, not packaging ──"
GW3="MCP-servers/Vodou-Console"
# The skill-proposer clusters prompt_excerpt to find what the user does
# repeatedly. It was clustering on wrappers: its top recurring "intent" was XML.
# No real intent could then reach OPT_MIN_DECIDED=3, which is why skill_metrics
# stayed empty (D11) — this is that bug's root cause.
if grep -q "stripPromptWrappers" "$GW3/src/trajectory-capture.ts"; then
  ok "wrappers stripped before storage, at the flush choke point"
else
  bad "trajectories still store the wrapper instead of what the user typed"
fi
# Stripping must happen BEFORE the 280-char truncation in db.ts, or the user's
# words are cut off and only the wrapper survives.
if grep -q "stripPromptWrappers(promptExcerpt)" "$GW3/src/trajectory-capture.ts"; then
  ok "stripping precedes the 280-char truncation at insert"
else
  bad "stripping does not run before storage"
fi
# BOTH wrappers. The plan named only the '<' envelope; the '[Vodou CLI' preamble
# was the larger polluter, and a filter catching one looks like it worked.
if grep -q '\[vodou' src/skill_proposer.rs; then
  ok "proposer filter covers the CLI preamble, not just the XML envelope"
else
  bad "proposer filter misses the '[Vodou CLI' preamble (the larger polluter)"
fi
if command -v cargo >/dev/null 2>&1; then
  if cargo test --quiet --bin vodou-core structural_wrapper >"$TMP/sw.out" 2>&1; then
    n="$(grep -oE '[0-9]+ passed' "$TMP/sw.out" | head -1 | cut -d' ' -f1)"
    ok "is_structural_wrapper: ${n:-?} tests pass"
  else
    bad "structural wrapper tests failed"; tail -12 "$TMP/sw.out"
  fi
else
  skip "the structural-wrapper tests (cargo not on PATH)"
fi

echo
# A verifier that degrades to almost no checks and exits 0 is worse than no
# verifier: the build goes green and the absence of coverage is invisible. CI
# sets a floor so "everything skipped" fails loudly instead.
if [ -n "${VODOU_VERIFY_MIN_CHECKS:-}" ] && [ "$pass" -lt "$VODOU_VERIFY_MIN_CHECKS" ]; then
  echo "NOT OK only $pass check(s) ran; VODOU_VERIFY_MIN_CHECKS=$VODOU_VERIFY_MIN_CHECKS required"
  echo "       (${skip} skipped — a missing prerequisite usually means the CI image lacks a tool)"
  fail=$((fail+1))
fi

if [ "$fail" -eq 0 ]; then
  echo "✅ run-outcome chain intact ($pass checks$([ "$skip" -gt 0 ] && echo ", $skip SKIPPED"))"
  exit 0
fi
echo "❌ run-outcome chain BROKEN ($fail failed, $pass passed, $skip skipped)"
exit 1
