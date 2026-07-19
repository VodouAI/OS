#!/usr/bin/env bash
# Vodou Board — Phase 1 smoke test
#
# 30-second end-to-end check that the board kernel, CLI, REST, and notifier
# all wire correctly. Runs against /tmp isolation so it doesn't touch your
# real project's board.db.
#
# Usage:
#   ./scripts/smoke-board.sh                       # run all 8 stages
#   VODOU_BOARD_REAL_SPAWN=1 ./scripts/smoke-board.sh   # also test real claude spawn
#
# Exit codes:
#   0 — all stages passed
#   1 — a stage failed (see stderr for which)
#   2 — environmental pre-req missing (vodou-core binary, sqlite3, jq)

set -euo pipefail

# ─── pre-reqs ────────────────────────────────────────────────────
PROJECT_ROOT="${VODOU_PROJECT_PATH:-$(pwd)}"
BIN="${VODOU_CORE_BIN:-$PROJECT_ROOT/vodou-core}"
[[ -x "$BIN" ]] || { echo "❌ vodou-core not found at $BIN" >&2; exit 2; }
command -v sqlite3 >/dev/null || { echo "❌ sqlite3 not on PATH" >&2; exit 2; }
command -v jq >/dev/null     || { echo "❌ jq not on PATH" >&2; exit 2; }

# Isolated test root
SMOKE_ROOT="$(mktemp -d -t vodou-board-smoke-XXXXXX)"
trap 'rm -rf "$SMOKE_ROOT"' EXIT

# Copy a fresh vodou-core.db (need it to exist for Database::new() to work)
cp "$PROJECT_ROOT/vodou-core.db" "$SMOKE_ROOT/vodou-core.db"

export VODOU_PROJECT_PATH="$SMOKE_ROOT"
export VODOU_BOARD_DB="$SMOKE_ROOT/board.db"

pass() { printf "  ✓ %s\n" "$1"; }
fail() { printf "  ✗ %s — %s\n" "$1" "$2" >&2; exit 1; }
hdr()  { printf "\n==> %s\n" "$1"; }

# ─── 1. migrate --init ────────────────────────────────────────────
hdr "Stage 1: migrate --init"
out=$("$BIN" board migrate --init 2>&1)
echo "$out" | grep -qE "schema_version: 00[12]" || fail "migrate" "did not apply migrations ($out)"
[[ -f "$VODOU_BOARD_DB" ]] || fail "migrate" "board.db not created"
pass "board.db created at version 001"

# ─── 2. schema sanity ─────────────────────────────────────────────
hdr "Stage 2: schema sanity"
tables=$(sqlite3 "$VODOU_BOARD_DB" ".tables" | tr -s ' \n' ' ')
for t in tasks task_runs task_events task_comments task_links boards \
         board_notify_subs task_usage board_approvals gateway_in_app_inbox \
         board_metadata tasks_fts; do
  echo "$tables" | grep -q "$t" || fail "schema" "missing table $t"
done
pass "all 12 expected tables present"

# ─── 3. create + list ─────────────────────────────────────────────
hdr "Stage 3: create + list"
# Parse ID via grep — robust against jq-output-empty edge case + set -e.
create_out=$("$BIN" board create "smoke parent" --priority 80 --json 2>&1)
T_PARENT=$(echo "$create_out" | jq -r '.id // empty' 2>/dev/null || echo "")
if [[ -z "$T_PARENT" ]]; then
  fail "create" "could not parse task id from: $create_out"
fi
pass "created parent task: $T_PARENT"

create_out=$("$BIN" board create "smoke child" --status todo --parent "$T_PARENT" \
  --assignee writer --priority 70 --json 2>&1)
T_CHILD=$(echo "$create_out" | jq -r '.id // empty' 2>/dev/null || echo "")
if [[ -z "$T_CHILD" ]]; then
  fail "create child" "could not parse child id from: $create_out"
fi
pass "created child task: $T_CHILD (depends on parent)"

count=$("$BIN" board list --json 2>&1 | jq 'length // 0' 2>/dev/null || echo 0)
[[ "$count" -ge 2 ]] || fail "list" "expected ≥2 tasks, got $count"
pass "list returned $count tasks"

# ─── 4. CAS claim ─────────────────────────────────────────────────
hdr "Stage 4: CAS claim atomicity"
out=$("$BIN" board dispatch --max 1 --json 2>&1)
spawned=$(echo "$out" | jq -r '.spawned // 0')
[[ "$spawned" -ge 1 ]] || fail "dispatch" "no task spawned ($out)"
parent_status=$(sqlite3 "$VODOU_BOARD_DB" "SELECT status FROM tasks WHERE id='$T_PARENT'")
[[ "$parent_status" == "running" ]] || fail "claim" "parent expected running, got $parent_status"
pass "parent CAS-claimed → running"

# ─── 5. complete + promote chain ──────────────────────────────────
hdr "Stage 5: complete + dependent promote"
"$BIN" board complete "$T_PARENT" --summary "smoke parent done" >/dev/null 2>&1
"$BIN" board dispatch --dry-run --json >/dev/null 2>&1
child_status=$(sqlite3 "$VODOU_BOARD_DB" "SELECT status FROM tasks WHERE id='$T_CHILD'")
[[ "$child_status" == "ready" ]] || fail "promote" "child expected ready after parent done, got $child_status"
pass "child promoted todo → ready after parent complete"

# ─── 6. notify subscribe + notifier tick ──────────────────────────
hdr "Stage 6: notifier"
"$BIN" board notify-subscribe "$T_PARENT" "inapp:principal:smoke-test" >/dev/null
"$BIN" board notifier --json >/dev/null
inbox=$(sqlite3 "$VODOU_BOARD_DB" "SELECT COUNT(*) FROM gateway_in_app_inbox WHERE task_id='$T_PARENT'")
[[ "$inbox" -ge 1 ]] || fail "notifier" "no in-app inbox row written, got count=$inbox"
pass "notifier wrote in-app inbox row for terminal event"

# ─── 7. FTS5 search ───────────────────────────────────────────────
hdr "Stage 7: FTS5 search"
out=$("$BIN" board search "smoke" --json 2>&1 | tail -50)
matches=$(echo "$out" | jq 'length // 0' 2>/dev/null || echo 0)
[[ "$matches" -ge 1 ]] || fail "search" "FTS5 returned $matches matches (expected ≥1)"
pass "FTS5 returned $matches matches for 'smoke'"

# ─── 8. real spawn (optional, gated) ──────────────────────────────
if [[ "${VODOU_BOARD_REAL_SPAWN:-}" == "1" ]]; then
  hdr "Stage 8: real claude spawn"
  command -v claude >/dev/null || fail "spawn" "claude CLI not on PATH"
  # Reset child to ready, claim it for real
  sqlite3 "$VODOU_BOARD_DB" "UPDATE tasks SET status='ready', claim_lock=NULL, claim_expires_at=NULL, current_run_id=NULL WHERE id='$T_CHILD'"
  sqlite3 "$VODOU_BOARD_DB" "DELETE FROM task_runs WHERE task_id='$T_CHILD'"
  out=$(VODOU_BOARD_REAL_SPAWN=1 "$BIN" board dispatch --max 1 --json 2>&1)
  spawned=$(echo "$out" | jq -r '.spawned // 0')
  [[ "$spawned" -ge 1 ]] || fail "real spawn" "dispatch report shows no spawns"
  log_path="$SMOKE_ROOT/.vodou/board/logs/${T_CHILD}.log"
  # Wait up to 10s for the spawned worker to write *something* to its log
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [[ -s "$log_path" ]] && break
    sleep 1
  done
  [[ -s "$log_path" ]] || fail "real spawn" "no log file at $log_path"
  grep -q '"type":"system"' "$log_path" || fail "real spawn" "no claude session init in log"
  pass "real claude spawn wrote session init to $log_path"
else
  printf "\n==> Stage 8: real claude spawn — SKIPPED (set VODOU_BOARD_REAL_SPAWN=1 to enable)\n"
fi

# ─── done ─────────────────────────────────────────────────────────
echo
echo "✅ smoke-board.sh — all stages passed"
echo "    smoke-root: $SMOKE_ROOT (will be deleted)"
exit 0
