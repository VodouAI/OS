#!/bin/bash
# Vodou System Test — Deterministic, no LLM involved
# Usage: bash scripts/system-test.sh

set -o pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"
[ -f ".env" ] && set -a && . ./.env 2>/dev/null && set +a
[ -d ".node" ] && export PATH="$SCRIPT_DIR/.node:$PATH"
for P in "$HOME/.local/bin" "/opt/homebrew/bin" "/usr/local/bin"; do [ -d "$P" ] && export PATH="$P:$PATH"; done

PASS=0; FAIL=0; SKIP=0; WARN=0; TOTAL=0; RESULTS=""
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); RESULTS+="  ✅ $1\n"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); RESULTS+="  ❌ $1\n"; }
skip() { SKIP=$((SKIP+1)); TOTAL=$((TOTAL+1)); RESULTS+="  ⏭️  $1\n"; }
warn() { WARN=$((WARN+1)); TOTAL=$((TOTAL+1)); RESULTS+="  ⚠️  $1\n"; }
section() { RESULTS+="\n━━ $1 ━━\n"; }

echo ""; echo "🔮 Vodou System Test"; echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📁 Install: $SCRIPT_DIR"; echo "📅 $(date)"; echo ""

# ── S1: BINARIES ──
section "S1: Binaries & Architecture"
SYSTEM_ARCH=$(uname -m)
if [ -f "vodou-core" ] && [ -x "vodou-core" ]; then pass "vodou-core executable"; else fail "vodou-core missing/not executable"; fi
if file vodou-core 2>/dev/null | grep -q "$SYSTEM_ARCH"; then pass "vodou-core arch: $SYSTEM_ARCH"; else fail "vodou-core arch mismatch"; fi
VERSION=$(./vodou-core version 2>/dev/null | head -1); [ -n "$VERSION" ] && pass "Version: $VERSION" || fail "version command failed"
[ -f "oi" ] && [ -x "oi" ] && pass "oi script" || fail "oi script missing"
[ -f "vodou-hook-bin" ] && [ -x "vodou-hook-bin" ] && pass "vodou-hook-bin" || warn "vodou-hook-bin missing"
if command -v node &>/dev/null; then pass "Node.js $(node --version)"; elif [ -x ".node/node" ]; then pass "Bundled Node $(.node/node --version)"; else fail "Node.js not found"; fi
[ -f "MCP-servers/mcp-monitor/bin/mcp-monitor" ] && pass "mcp-monitor binary" || warn "mcp-monitor missing"
[ -f "MCP-servers/vodou-mac-control/bin/vodou-ax-$SYSTEM_ARCH" ] && pass "vodou-ax ($SYSTEM_ARCH)" || warn "vodou-ax missing"

# ── S2: DATABASE ──
section "S2: Database"
if [ -f "vodou-core.db" ]; then
    pass "vodou-core.db exists"
    SRV=$(sqlite3 vodou-core.db "SELECT count(*) FROM mcp_servers" 2>/dev/null); [ "$SRV" -ge 10 ] 2>/dev/null && pass "Servers: $SRV" || fail "Servers: $SRV (need 10+)"
    TOOLS=$(sqlite3 vodou-core.db "SELECT count(*) FROM tools" 2>/dev/null); [ "$TOOLS" -ge 50 ] 2>/dev/null && pass "Tools: $TOOLS" || fail "Tools: $TOOLS (need 50+)"
    INTENTS=$(sqlite3 vodou-core.db "SELECT count(*) FROM intent_mappings" 2>/dev/null); [ "$INTENTS" -ge 100 ] 2>/dev/null && pass "Intents: $INTENTS" || fail "Intents: $INTENTS (need 100+)"
    BAD=$(sqlite3 vodou-core.db "SELECT count(*) FROM mcp_servers WHERE args LIKE '%/Users/%'" 2>/dev/null); [ "$BAD" = "0" ] && pass "No hardcoded paths" || fail "$BAD servers have hardcoded paths"
    SKILLS_DB=$(sqlite3 vodou-core.db "SELECT count(*) FROM skills_registry" 2>/dev/null); [ "$SKILLS_DB" -ge 20 ] 2>/dev/null && pass "Skills in DB: $SKILLS_DB" || fail "Skills: $SKILLS_DB (need 20+)"
else fail "vodou-core.db missing"; fi
[ -f "memory.db" ] && pass "memory.db exists" || warn "memory.db not yet created (first extraction creates it)"

# ── S3: SERVER REGISTRATION ──
section "S3: MCP Server Registration"
for SRV in Vodou-Enhanced-Thinking Vodou-Recall Vodou-LLM-router Vodou-channels context7 Vodou-script-executor Vodou-session-manager uml-mcp mcp-monitor chrome-devtools vodou-mac-control; do
    [ -f "vodou-core.db" ] && E=$(sqlite3 vodou-core.db "SELECT count(*) FROM mcp_servers WHERE name='$SRV'" 2>/dev/null) && [ "$E" = "1" ] && pass "Registered: $SRV" || fail "NOT registered: $SRV"
done

# ── S4: SERVER FILES ──
section "S4: MCP Server Files"
for SRV in Vodou-Console Vodou-Enhanced-Thinking Vodou-Recall Vodou-LLM-router Vodou-channels Vodou-script-executor Vodou-session-manager uml-mcp dalle vodou-mac-control; do
    D="MCP-servers/$SRV"
    [ -d "$D" ] && [ -f "$D/dist/index.js" ] && [ -d "$D/node_modules" ] && pass "$SRV: ready" || fail "$SRV: dist or node_modules missing"
done

# ── S5: CONFIGURATION ──
section "S5: Configuration"
if [ -f ".env" ]; then
    pass ".env exists"
    grep -q "^VODOU_TOKEN=.\+" .env 2>/dev/null && pass "VODOU_TOKEN set" || fail "VODOU_TOKEN empty/missing"
    grep -q "^VODOU_USER_ID=.\+" .env 2>/dev/null && pass "VODOU_USER_ID set" || fail "VODOU_USER_ID empty/missing"
    grep -q "^VODOU_PROJECT_PATH=" .env 2>/dev/null && pass "VODOU_PROJECT_PATH set" || warn "VODOU_PROJECT_PATH not in .env"
    grep -q "^START_AIGATEWAY=1" .env 2>/dev/null && pass "START_AIGATEWAY=1" || warn "Gateway won't auto-start"
else fail ".env missing"; fi
# Installed MCP servers live in vodou-core.db (mcp_servers); the LLM router reads
# them directly. config.json is no longer generated.
if [ -f "vodou-core.db" ] && command -v sqlite3 >/dev/null 2>&1; then
    SRV_COUNT=$(sqlite3 vodou-core.db "SELECT COUNT(*) FROM mcp_servers" 2>/dev/null || echo 0)
    [ "${SRV_COUNT:-0}" -gt 0 ] && pass "mcp_servers registry populated ($SRV_COUNT servers)" \
        || fail "mcp_servers registry empty"
else
    warn "mcp_servers registry not checked (no vodou-core.db or sqlite3)"
fi
[ -f "extractors.toml" ] && pass "extractors.toml" || fail "extractors.toml missing"
[ -f "memory.toml" ] && pass "memory.toml exists" || warn "memory.toml missing (memory extraction uses defaults)"

# ── S6: ONNX ──
section "S6: ONNX Runtime"
ORT="${ORT_DYLIB_PATH:-}"; [ -z "$ORT" ] && [ -f ".env" ] && ORT=$(grep "^ORT_DYLIB_PATH=" .env 2>/dev/null | cut -d= -f2-)
if [ -n "$ORT" ] && [ -f "$ORT" ]; then pass "ONNX: $ORT"; file "$ORT" 2>/dev/null | grep -q "$SYSTEM_ARCH" && pass "ONNX arch matches" || fail "ONNX arch mismatch"
elif find onnxruntime -name "libonnxruntime.dylib" 2>/dev/null | grep -q .; then pass "ONNX found in onnxruntime/"
else warn "ONNX not found (keyword-only routing)"; fi

# ── S7: WORKSPACE ──
section "S7: Workspace & Templates"
[ -d ".vodou/workspace" ] && pass ".vodou/workspace/ exists" || fail ".vodou/workspace/ missing"
for T in SOUL.md USER.md IDENTITY.md MEMORY.md AGENTS.md TOOLS.md; do
    [ -f ".vodou/workspace/$T" ] && pass "$T present" || fail "$T missing"
done
[ -d ".vodou/workspace/memory" ] && pass "Daily memory dir ($(ls .vodou/workspace/memory/*.md 2>/dev/null | wc -l | tr -d ' ') logs)" || fail "Daily memory dir missing"

# ── S8: SKILLS ──
section "S8: Skills"
if [ -d "skills" ]; then
    SF=$(find skills -name "SKILL.md" 2>/dev/null | wc -l | tr -d ' '); [ "$SF" -ge 20 ] 2>/dev/null && pass "$SF skills" || fail "$SF skills (need 20+)"
    AF=$(find skills -name "actions.json" 2>/dev/null | wc -l | tr -d ' '); [ "$AF" -ge 5 ] 2>/dev/null && pass "$AF workflows" || warn "$AF workflows"
else fail "skills/ missing"; fi

# ── S9: GATEWAY ──
section "S9: Gateway"
[ -f "MCP-servers/Vodou-Console/dist/index.js" ] && pass "Gateway built" || fail "Gateway not built"
if command -v lsof &>/dev/null && lsof -ti :8765 &>/dev/null; then
    pass "Gateway running (port 8765)"
    H=$(curl -s --max-time 5 http://localhost:8765/health 2>/dev/null)
    echo "$H" | grep -q "status" && pass "Health check OK" || fail "Health check failed"
    # Tool-count probe — prefer bundled node, fall back to python3, fall back
    # to a grep/sed parse so we still report something on minimal VMs.
    TOOLS_JSON=$(curl -s --max-time 5 http://localhost:8765/api/tools 2>/dev/null)
    NODE_BIN="${NODE_BIN:-./.node/node}"
    [ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node 2>/dev/null || true)"
    if [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ]; then
        T=$(printf '%s' "$TOOLS_JSON" | "$NODE_BIN" -e \
            "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{console.log(JSON.parse(s).count||0)}catch{console.log(0)}})" 2>/dev/null)
    elif command -v python3 >/dev/null 2>&1; then
        T=$(printf '%s' "$TOOLS_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin).get('count',0))" 2>/dev/null)
    else
        # Last-resort regex: pull the first numeric "count": value
        T=$(printf '%s' "$TOOLS_JSON" | sed -n 's/.*"count"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' | head -1)
    fi
    T="${T:-0}"
    [ "$T" -ge 50 ] 2>/dev/null && pass "API: $T tools" || warn "API: $T tools"
else warn "Gateway not running"; fi

# ── S10: HOOKS ──
section "S10: IDE Hooks"
[ -f ".claude/settings.json" ] && grep -q "set -a" .claude/settings.json 2>/dev/null && pass "Claude Code hooks (.env sourcing)" || warn "Claude Code hooks not configured"
[ -f ".cursor/hooks.json" ] && grep -q "set -a" .cursor/hooks.json 2>/dev/null && pass "Cursor hooks (.env sourcing)" || warn "Cursor hooks not configured"

# ── S11: LIVE CALLS ──
section "S11: Live Tool Calls"
if [ -x "vodou-core" ]; then
    R=$(perl -e 'alarm 30; exec @ARGV' ./vodou-core call mcp-monitor get_cpu_info '{}' 2>&1 || ./vodou-core call mcp-monitor get_cpu_info '{}' 2>&1)
    echo "$R" | grep -q "core_count" && pass "mcp-monitor get_cpu_info" || fail "mcp-monitor get_cpu_info failed"
    C=$(perl -e 'alarm 15; exec @ARGV' ./vodou-core credentials 2>&1 || ./vodou-core credentials 2>&1)
    echo "$C" | grep -qi "connected\|valid\|pong\|SET" && pass "Vodou credentials valid" || (echo "$C" | grep -qi "NOT SET\|invalid" && fail "Credentials invalid" || warn "Credentials: could not verify")
else skip "vodou-core not executable"; fi

# ── S12: SHELL ──
section "S12: Shell Integration"
SP=""; [ -f "$HOME/.zshrc" ] && SP="$HOME/.zshrc"; [ -z "$SP" ] && [ -f "$HOME/.bashrc" ] && SP="$HOME/.bashrc"
[ -n "$SP" ] && grep -q "VODOU_PROJECT_PATH\|vodou" "$SP" 2>/dev/null && pass "Vodou in $SP" || warn "Vodou not in shell profile"
[ -n "$SP" ] && grep -q "\.env" "$SP" 2>/dev/null && pass ".env auto-loading in profile" || warn ".env not auto-loaded"
[ -n "$VODOU_PROJECT_PATH" ] && pass "VODOU_PROJECT_PATH: $VODOU_PROJECT_PATH" || warn "VODOU_PROJECT_PATH not set"

# ── REPORT ──
echo ""; echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"; echo ""
printf "$RESULTS"
echo ""; echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"; echo ""
echo "📊 Summary: $TOTAL Tests | ✅ $PASS Pass | ❌ $FAIL Fail | ⚠️  $WARN Warn | ⏭️  $SKIP Skip"
echo ""
[ "$FAIL" -eq 0 ] && echo "🎉 All tests passed!" || ([ "$FAIL" -le 3 ] && echo "🟡 Minor issues." || echo "🔴 Multiple failures.")
echo ""; exit $FAIL
