#!/usr/bin/env bash
# Does the smoke detector detect smoke — and stay quiet in a kitchen?
#
# loop-guard's value is the same as entrypoint-guard's: precision. It runs on
# every commit in a tree where almost no commit touches a loop, so a guard that
# fires on the ordinary case gets VODOU_SKIP_-ed within a week and then
# enforces nothing. The negative cases below matter as much as the positive
# ones.
#
# There is a second reason this harness exists. The rule loop-guard enforces IS
# "every loop must carry a must-not-fire fixture" — so a guard shipped without
# its own must-not-fire test would be the exact defect it was written against.
#
# Each case stages real content in a THROWAWAY repo and asserts the exit code,
# so this never touches the working tree's index. The guard runs from the real
# repo (its registry is the real loops.toml) against the sandbox's index.
#
# Run: scripts/test-loop-guard.sh
set -u
GUARD="$(cd "$(dirname "$0")" && pwd)/loop-guard.py"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
pass=0; fail=0

# run_case NAME EXIT [PATH CONTENT]...
run_case() {
  local name="$1" want="$2"; shift 2
  local tmp; tmp="$(mktemp -d)"
  git -C "$tmp" init -q 2>/dev/null
  while [ "$#" -gt 0 ]; do
    local path="$1" content="$2"; shift 2
    mkdir -p "$tmp/$(dirname "$path")"
    printf '%s\n' "$content" > "$tmp/$path"
    git -C "$tmp" add -f "$path" 2>/dev/null
  done
  local out rc
  out="$(cd "$REPO" && GIT_DIR="$tmp/.git" GIT_WORK_TREE="$tmp" python3 "$GUARD" 2>&1)"; rc=$?
  if [ "$rc" -eq "$want" ]; then
    printf '  ok    %s\n' "$name"; pass=$((pass+1))
  else
    printf '  FAIL  %s (exit %s, wanted %s)\n%s\n' "$name" "$rc" "$want" "$out"; fail=$((fail+1))
  fi
  rm -rf "$tmp"
}

# A registry entry that is complete EXCEPT for the fixtures existing. The
# fixture paths point at the real repo's files so the "it is satisfied" case
# can actually be satisfied without inventing a tree.
complete_entry() {
  cat <<TOML
schema_version = 1

[loops.capture-gap]
implementation        = "module"
trigger               = "idle"
owner                 = "src/loops/capture_gap.rs"
reads                 = ["gateway.db:gateway_conversations"]
emits                 = "loop_findings"
drain                 = ["briefing"]
audience              = "user"
budget_secs           = 60
llm_calls             = 0
rate_ceiling_per_hour = 4
severity_max          = "warn"
kill_switch           = "VODOU_LOOP_CAPTURE_GAP"
fixture_fires         = "$1"
fixture_quiet         = "$2"
fixture_fresh         = "$3"
TOML
}

REAL_A="loops.toml"
REAL_B="scripts/loop-guard.py"
REAL_C="scripts/test-loop-guard.sh"

echo "loop-guard:"

# ── it fires ────────────────────────────────────────────────────────────────
# Uses a name no real loop has, on purpose: `capture_gap` was the example here
# until it became a registered loop, and the case then passed for the wrong
# reason (the guard was right; the fixture had gone stale).
run_case "blocks a loop module with no registry entry" 1 \
  "src/loops/unregistered_probe.rs" 'pub fn run() {}'

run_case "blocks an entry missing mandatory fields" 1 \
  "loops.toml" 'schema_version = 1

[loops.capture-gap]
owner = "src/loops/capture_gap.rs"'

run_case "blocks an entry whose fixture does not exist" 1 \
  "loops.toml" "$(complete_entry "$REAL_A" "tests/loops/fixtures/nope.json" "$REAL_C")"

run_case "blocks a loop that invents its own drain" 1 \
  "loops.toml" "$(complete_entry "$REAL_A" "$REAL_B" "$REAL_C" | sed 's/emits                 = "loop_findings"/emits                 = "my_own_table"/')"

run_case "blocks a loop that escalates itself to critical" 1 \
  "loops.toml" "$(complete_entry "$REAL_A" "$REAL_B" "$REAL_C" | sed 's/severity_max          = "warn"/severity_max          = "critical"/')"

run_case "blocks an unknown trigger kind" 1 \
  "loops.toml" "$(complete_entry "$REAL_A" "$REAL_B" "$REAL_C" | sed 's/trigger               = "idle"/trigger               = "whenever"/')"

run_case "blocks a malformed registry rather than passing it" 1 \
  "loops.toml" 'schema_version = 1
[loops.capture-gap'

# ── it stays quiet, which is the harder half ────────────────────────────────
run_case "allows a loop module WITH a complete entry" 0 \
  "src/loops/capture_gap.rs" 'pub fn run() {}' \
  "loops.toml" "$(complete_entry "$REAL_A" "$REAL_B" "$REAL_C")"

run_case "allows mod.rs — it declares the tree, it is not a loop" 0 \
  "src/loops/mod.rs" 'pub mod capture_gap;'

# The drain is machinery every loop writes into, not a thing that runs on a
# trigger. Demanding a stanza would mean inventing a fake implementation, a
# fake trigger and three fake fixtures for a writer that observes nothing.
run_case "allows findings.rs — the shared drain is not a loop" 0 \
  "src/loops/findings.rs" 'pub fn observe() {}'

run_case "allows watches.rs and dispatcher.rs — the trigger platform and the tick" 0 \
  "src/loops/watches.rs" 'pub fn due() {}' \
  "src/loops/dispatcher.rs" 'pub fn tick() {}'

# And the exemption is a list, not a licence: anything else still needs a stanza.
run_case "still blocks a NEW loop module hiding beside the drain" 1 \
  "src/loops/findings.rs" 'pub fn observe() {}' \
  "src/loops/quiet_surfaces.rs" 'pub fn run() {}'

run_case "allows a loop's test module" 0 \
  "src/loops/capture_gap_test.rs" '#[test] fn t() {}'

# The ordinary commit in this tree: nothing to do with loops. This is the case
# that decides whether the guard survives contact with a working repo.
run_case "silent on a commit that touches neither loops.toml nor src/loops" 0 \
  "src/scheduler.rs" 'fn main() {}' \
  "MCP-servers/Vodou-Console/src/index.ts" 'export const x = 1;'

run_case "silent on a docs-only commit" 0 \
  "docs/vodou-automations.md" '# Automations'

# A repo with no loops needs no registry — the guard must not demand one from
# a tree that has never had a loop.
run_case "silent when neither the registry nor a loop is staged, even absent" 0 \
  "README.md" 'hello'

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
