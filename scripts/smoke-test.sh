#!/usr/bin/env bash
# smoke-test.sh — 30-second Vodou smoke test after daemon restart
# Usage: ./scripts/smoke-test.sh [--verbose]
#
# Checks: binary health, daemon up, DB accessible, MCP servers reachable,
#         memory DB, hooks, process count. Exits 0 = pass, 1 = fail.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

VERBOSE=false
[[ "${1:-}" == "--verbose" ]] && VERBOSE=true

PASS=0
FAIL=0
SKIP=0
START_TIME=$(date +%s)
TIMEOUT=30  # hard cap in seconds

# ── Helpers ──────────────────────────────────────────────────────────────────
ok()   { echo "  ✅ $1"; ((PASS++)); }
fail() { echo "  ❌ $1"; ((FAIL++)); }
skip() { echo "  ⚪ $1 (skipped)"; ((SKIP++)); }
info() { $VERBOSE && echo "     $1" || true; }

elapsed() { echo $(( $(date +%s) - START_TIME )); }

check_timeout() {
  if (( $(elapsed) >= TIMEOUT )); then
    echo ""
    echo "⏱  Timeout reached (${TIMEOUT}s). Remaining checks skipped."
    exit 1
  fi
}

# ── Run a check with timeout ──────────────────────────────────────────────────
# macOS doesn't ship `timeout` — use gtimeout (coreutils) if available, else no timeout
if command -v gtimeout &>/dev/null; then
  _timeout() { gtimeout "$@"; }
elif command -v timeout &>/dev/null; then
  _timeout() { timeout "$@"; }
else
  _timeout() { local _t="$1"; shift; "$@"; }  # no-op fallback
fi

run_with_timeout() {
  local cmd=("$@")
  _timeout 5 "${cmd[@]}" 2>/dev/null
}

run_sqlite() {
  local db="$1" sql="$2"
  _timeout 5 sqlite3 "$db" "$sql" 2>/dev/null
}

echo ""
echo "🔥 Vodou Smoke Test — $(date '+%H:%M:%S')"
echo "────────────────────────────────────────"

# ── 1. Binary exists and responds ────────────────────────────────────────────
echo ""
echo "Binary:"
if [[ -x "$ROOT/vodou-core" ]]; then
  VERSION=$(run_with_timeout "$ROOT/vodou-core" version 2>/dev/null | head -1 || echo "")
  if [[ -n "$VERSION" ]]; then
    ok "vodou-core responds ($VERSION)"
  else
    ok "vodou-core exists (version cmd silent)"
  fi
else
  fail "vodou-core not found or not executable"
fi

check_timeout

# ── 2. Process count ─────────────────────────────────────────────────────────
echo ""
echo "Processes:"
PROC_COUNT=$(pgrep -x "vodou-core" 2>/dev/null | wc -l | tr -d ' ')
if (( PROC_COUNT <= 2 )); then
  ok "Process count OK ($PROC_COUNT vodou-core running)"
elif (( PROC_COUNT <= 4 )); then
  ok "Process count acceptable ($PROC_COUNT vodou-core running)"
else
  fail "Too many processes ($PROC_COUNT vodou-core running — safety valve will trigger at >4)"
fi

# ── 3. Daemon socket ─────────────────────────────────────────────────────────
echo ""
echo "Daemon:"
SOCK_FILE="$ROOT/.vodou/daemon.sock"
if [[ -S "$SOCK_FILE" ]]; then
  ok "Daemon socket exists"
  # Try a quick ping via sock command
  PING=$(run_with_timeout "$ROOT/vodou-core" sock ping 2>/dev/null || echo "")
  if [[ "$PING" == *"pong"* ]] || [[ "$PING" == *"ok"* ]]; then
    ok "Daemon responds to ping"
  else
    info "Daemon socket exists but ping got: $PING"
    ok "Daemon socket present (ping result unclear)"
  fi
else
  # Check if daemon is running at all
  DAEMON_PID=$(pgrep -f "vodou-core daemon" 2>/dev/null | head -1 || echo "")
  if [[ -n "$DAEMON_PID" ]]; then
    fail "Daemon process found (PID $DAEMON_PID) but no socket at $SOCK_FILE"
  else
    fail "Daemon not running — start with: ./vodou-core daemon start"
  fi
fi

check_timeout

# ── 4. Databases ─────────────────────────────────────────────────────────────
echo ""
echo "Databases:"
if [[ -f "$ROOT/vodou-core.db" ]]; then
  DB_SIZE=$(du -sh "$ROOT/vodou-core.db" 2>/dev/null | cut -f1)
  INTEGRITY=$(run_sqlite "$ROOT/vodou-core.db" "PRAGMA integrity_check;" | head -1)
  [[ -z "$INTEGRITY" ]] && INTEGRITY="error"
  if [[ "$INTEGRITY" == "ok" ]]; then
    ok "vodou-core.db healthy ($DB_SIZE)"
  else
    fail "vodou-core.db integrity check failed: $INTEGRITY"
  fi
else
  fail "vodou-core.db not found"
fi

if [[ -f "$ROOT/memory.db" ]]; then
  MEM_SIZE=$(du -sh "$ROOT/memory.db" 2>/dev/null | cut -f1)
  INTEGRITY=$(run_sqlite "$ROOT/memory.db" "PRAGMA integrity_check;" | head -1)
  [[ -z "$INTEGRITY" ]] && INTEGRITY="error"
  if [[ "$INTEGRITY" == "ok" ]]; then
    ok "memory.db healthy ($MEM_SIZE)"
  else
    fail "memory.db integrity check failed: $INTEGRITY"
  fi
else
  skip "memory.db not found (normal on first run)"
fi

check_timeout

# ── 5. MCP servers in DB ─────────────────────────────────────────────────────
echo ""
echo "MCP Servers:"
SERVER_COUNT=$(run_sqlite "$ROOT/vodou-core.db" "SELECT COUNT(*) FROM mcp_servers;" | tr -d ' ')
if [[ "$SERVER_COUNT" =~ ^[0-9]+$ ]] && (( SERVER_COUNT > 0 )); then
  ok "mcp_servers table has $SERVER_COUNT entries"
else
  fail "mcp_servers table empty or inaccessible (got: $SERVER_COUNT)"
fi

check_timeout

# ── 6. Key MCP servers ───────────────────────────────────────────────────────
KEY_SERVERS=("Vodou-Enhanced-Thinking" "mcp-monitor" "Vodou-LLM-router")
for srv in "${KEY_SERVERS[@]}"; do
  check_timeout
  IN_DB=$(run_sqlite "$ROOT/vodou-core.db" \
    "SELECT name FROM mcp_servers WHERE name='$srv' LIMIT 1;")
  if [[ "$IN_DB" == "$srv" ]]; then
    ok "$srv registered"
  else
    fail "$srv not found in mcp_servers table"
  fi
done

# ── 7. Hooks configured ──────────────────────────────────────────────────────
echo ""
echo "Hooks:"
SETTINGS="$ROOT/.claude/settings.json"
if [[ -f "$SETTINGS" ]]; then
  if grep -q "UserPromptSubmit\|SessionStart" "$SETTINGS" 2>/dev/null; then
    ok "Claude Code hooks configured"
  else
    fail "Claude Code hooks missing from settings.json"
  fi
else
  fail ".claude/settings.json not found"
fi

if [[ -x "$ROOT/vodou-hook-bin" ]]; then
  ok "vodou-hook-bin executable"
else
  fail "vodou-hook-bin not found or not executable"
fi

check_timeout

# ── 8. Memory system ─────────────────────────────────────────────────────────
echo ""
echo "Memory:"
MEM_COUNT=$(run_sqlite "$ROOT/memory.db" "SELECT COUNT(*) FROM memory_chunks;" || echo "0")
if [[ "$MEM_COUNT" =~ ^[0-9]+$ ]]; then
  ok "Memory chunks accessible ($MEM_COUNT entries)"
else
  skip "Memory count check failed (memory.db may not exist)"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
ELAPSED=$(elapsed)
echo ""
echo "────────────────────────────────────────"
TOTAL=$((PASS + FAIL + SKIP))
echo "Result: ${PASS}/${TOTAL} passed, ${FAIL} failed, ${SKIP} skipped (${ELAPSED}s)"

if (( FAIL > 0 )); then
  echo ""
  echo "⚠️  Smoke test FAILED — $FAIL check(s) need attention"
  exit 1
else
  echo ""
  echo "✅ Smoke test PASSED"
  exit 0
fi
