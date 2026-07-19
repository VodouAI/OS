---
name: regression-test
description: Comprehensive regression test suite for Vodou fresh installations - validates binaries, database, MCP servers, intent routing, skills, memory, daemon, workspace, config, CLI, and performance
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - "regression test"
  - "oi regression test"
  - "vodou regression test"
  - "test fresh install"
  - "system regression"
  - "full system test"
  - "oi system test"
  - "vodou system test"
  - "test oi"
  - "--"
stopping_points: required
actions: none
imported_from:
  source: hand-written
---

# Vodou Regression Test Suite

## AI Agent Instructions

**You ARE the test runner.** When this skill loads:

1. Display the overview and STOPPING POINT 1 menu. STOP and wait for user selection.
2. After user selects scope, execute every test in the selected suite(s) sequentially.
3. For each test, run the exact command shown. Check exit code and output against the expected result.
4. Track results: maintain a running count of PASS, WARN, FAIL per suite.
5. After all selected suites complete, display the Results Report using the template at the bottom.
6. Display STOPPING POINT 2 with post-results options. STOP and wait.

**Result classification:**
- **PASS**: Command exits 0 AND output matches expected pattern
- **WARN**: Command works but output is degraded (e.g., empty table, optional file missing, slow but functional)
- **FAIL**: Command exits non-zero OR output contradicts expected pattern

**Timing**: Measure wall-clock time for every command. Include in performance summary.

**Important**: Run all commands from the Vodou installation root directory. All paths are relative to that root. Use `cd` to the Vodou root before starting if needed.

**Compatibility**: macOS ships with Bash 3.2. Do NOT use Bash 4+ features like `declare -A` (associative arrays), `${var,,}` (lowercase), `|&` (pipe stderr), or `&>>` (append both). Use simple variables, arrays (`declare -a` is OK), and POSIX-compatible constructs. If you need structured tracking, use Python or individual counter variables.

---

## Overview

This skill runs a comprehensive regression test against a fresh (or existing) Vodou installation. It systematically validates all 11 subsystems: binaries, database, MCP servers, intent routing, skills, memory, daemon/hooks, workspace, configuration, CLI commands, and performance.

Tests are split into two tiers:
- **Tier A (No API Key)**: File checks, database queries, daemon ops -- works on fresh installs before configuring .env
- **Tier B (API Key Required)**: MCP tool calls that connect to live servers

Total: ~81 tests across 11 suites.

---

## STOPPING POINT 1: Select Test Scope

Choose what to test:

1. **Run ALL Suites** (Tier A + B) -- Full regression, requires API keys and running daemon
2. **Run Tier A Only** (No API Key) -- Offline tests: binaries, database, workspace, config, daemon
3. **Suite 1: Binary & Architecture** -- vodou-core, vodou-hook-bin, arch validation
4. **Suite 2: Database & Migrations** -- Tables, FTS5, schema
5. **Suite 3: MCP Servers** -- Server list, health-check, tool calls [Tier B]
6. **Suite 4: Intent Routing** -- Mapping count, critical intents [Partial Tier B]
7. **Suite 5: Skills System** -- Skill files, registry, loading via vodou-core [Partial Tier B]
8. **Suite 6: Memory System** -- Files, memory.db, daily logs, FTS5, embeddings, hybrid search, flush
9. **Suite 7: Daemon & Hooks** -- vodou-hook-bin ensure, daemon.sock, context
10. **Suite 8: Workspace Bootstrap** -- All workspace files, memory dir
11. **Suite 9: Configuration** -- .env, extractors.toml, config.json
12. **Suite 10: Core CLI Commands** -- list, tools, context, version [Partial Tier B]
13. **Suite 11: Performance** -- Timing benchmarks [Tier B]
14. **Add/Change a test** -- Add a new test, modify an existing one, or add a new suite to this skill

Reply with a number (1-14):

---

## Suite 1: Binary & Architecture (Tier A)

**Test 1.1: vodou-core exists and is executable**
```bash
test -x ./vodou-core && echo "PASS" || echo "FAIL"
```
Expected: PASS

**Test 1.2: vodou-hook-bin exists and is executable**
```bash
test -x ./vodou-hook-bin && echo "PASS" || echo "FAIL"
```
Expected: PASS

**Test 1.3: oi wrapper script exists and is executable**
```bash
test -x ./do && echo "PASS" || echo "FAIL"
```
Expected: PASS

**Test 1.4: vodou-core correct architecture**
```bash
EXPECTED_ARCH=$(uname -m); file ./vodou-core | grep -qi "$(echo $EXPECTED_ARCH | sed 's/x86_64/x86.64/')" && echo "PASS: $EXPECTED_ARCH" || echo "FAIL: wrong arch for $EXPECTED_ARCH"
```
Expected: PASS matching host architecture (arm64 or x86_64)

**Test 1.5: vodou-hook-bin correct architecture**
```bash
EXPECTED_ARCH=$(uname -m); file ./vodou-hook-bin | grep -qi "$(echo $EXPECTED_ARCH | sed 's/x86_64/x86.64/')" && echo "PASS: $EXPECTED_ARCH" || echo "FAIL: wrong arch for $EXPECTED_ARCH"
```
Expected: PASS matching host architecture

**Test 1.6: vodou-core version returns valid output**
```bash
./vodou-core version
```
Expected: Exit code 0, output contains a version string

---

## Suite 2: Database & Migrations (Tier A)

**Test 2.1: vodou-core.db exists**
```bash
test -f vodou-core.db && echo "PASS" || echo "FAIL"
```

**Test 2.2: Core tables present**
```bash
sqlite3 vodou-core.db ".tables" 2>/dev/null
```
Verify output contains ALL of these: `mcp_servers`, `tools`, `intent_mappings`, `skills_registry`, `work_logs`, `scheduled_tasks`, `schema_version`. PASS if all present, FAIL if any missing (list which ones). Note: memory tables live in memory.db, NOT vodou-core.db.

**Test 2.3: MCP servers populated**
```bash
sqlite3 vodou-core.db "SELECT COUNT(*) FROM mcp_servers"
```
Expected: >= 10. WARN if < 10, FAIL if 0.

**Test 2.4: Tools populated**
```bash
sqlite3 vodou-core.db "SELECT COUNT(*) FROM tools"
```
Expected: >= 30. WARN if < 30.

**Test 2.5: memory.db exists**
```bash
test -f memory.db && echo "PASS" || echo "WARN: memory.db not found (created by daemon on first run)"
```
Expected: PASS if daemon has run, WARN on fresh install (this is expected).

---

## Suite 3: MCP Servers (Tier B)

**Test 3.1: vodou-core list shows servers**
```bash
./vodou-core list
```
Expected: Exit 0, output shows table with server names

**Test 3.2: health-check**
```bash
./vodou-core health-check
```
Expected: Exit 0. Count pass/fail. PASS if all pass, WARN if some fail, FAIL if all fail.

**Test 3.3: Tool call - mcp-monitor get_cpu_info**
```bash
./vodou-core call mcp-monitor get_cpu_info
```
Expected: Exit 0, returns CPU information

**Test 3.4: Tool call - mcp-monitor get_memory_info**
```bash
./vodou-core call mcp-monitor get_memory_info
```
Expected: Exit 0, returns memory information

**Test 3.5: Node server dist/index.js files exist**
```bash
for srv in Vodou-Enhanced-Thinking Vodou-script-executor Vodou-session-manager Vodou-channels Vodou-LLM-router; do
  test -f "MCP-servers/$srv/dist/index.js" && echo "PASS: $srv" || echo "FAIL: $srv missing dist/index.js"
done
```

**Test 3.6: Python server entry points exist**
```bash
test -f MCP-servers/uml-mcp/mcp_server.py && echo "PASS: UML" || echo "WARN: UML missing (optional)"
```

**Test 3.7: Go binary exists (mcp-monitor)**
```bash
test -x MCP-servers/mcp-monitor/bin/mcp-monitor && echo "PASS" || echo "FAIL: mcp-monitor binary missing"
```

---

## Suite 4: Intent Routing (Tier A + Partial B)

**Test 4.1: Intent mapping count** (Tier A)
```bash
sqlite3 vodou-core.db "SELECT COUNT(*) FROM intent_mappings"
```
Expected: >= 400. WARN if 200-399, FAIL if < 200.

**Test 4.2: Critical intents exist** (Tier A)
```bash
sqlite3 vodou-core.db "SELECT keyword, server_name, tool_name FROM intent_mappings WHERE keyword='cpu'"
sqlite3 vodou-core.db "SELECT keyword, server_name, tool_name FROM intent_mappings WHERE keyword='disk'"
sqlite3 vodou-core.db "SELECT keyword, server_name, tool_name FROM intent_mappings WHERE keyword IN ('hello','oi hello') LIMIT 2"
```
Expected: cpu -> mcp-monitor::get_cpu_info, disk -> mcp-monitor::get_disk_info, hello -> vodou-core::vc_load_skill

**Test 4.3: Skill intents have tool_parameters** (Tier A)
```bash
sqlite3 vodou-core.db "SELECT keyword, tool_parameters FROM intent_mappings WHERE server_name='vodou-core' AND tool_name='vc_load_skill' AND tool_parameters IS NOT NULL LIMIT 3"
```
Expected: Results show skill_name in tool_parameters JSON

**Test 4.4: brain command routes correctly** (Tier B)
```bash
./vodou-core brain "cpu"
```
Expected: Exit 0, output shows CPU info routed through mcp-monitor

---

## Suite 5: Skills System (Tier A + Partial B)

**Test 5.1: Skills directory has SKILL.md files** (Tier A)
```bash
find skills/ -name "SKILL.md" -not -path "*/.build/*" 2>/dev/null | wc -l
```
Expected: >= 40. WARN if 20-39, FAIL if < 20.

**Test 5.2: skills_registry populated** (Tier A)
```bash
sqlite3 vodou-core.db "SELECT COUNT(*) FROM skills_registry"
```
Expected: >= 40. WARN if < 40.

**Test 5.3: hello skill loads via vodou-core** (Tier B)
```bash
./vodou-core brain "hello"
```
Expected: Exit 0, output contains skill content for hello

**Test 5.4: Skill intent mappings exist** (Tier A)
```bash
sqlite3 vodou-core.db "SELECT COUNT(*) FROM intent_mappings WHERE server_name='vodou-core' AND tool_name='vc_load_skill'"
```
Expected: >= 20. WARN if < 20.

**Test 5.5: Key skill intents have tool_parameters** (Tier A)
```bash
sqlite3 vodou-core.db "SELECT keyword, tool_parameters FROM intent_mappings WHERE keyword IN ('hello','regression test','deep think') AND tool_parameters IS NOT NULL"
```
Expected: All three return rows with skill_name in tool_parameters JSON

---

## Suite 6: Memory System (Tier A)

### 6A: Memory Files & Configuration

**Test 6.1: MEMORY.md exists**
```bash
test -f .vodou/workspace/MEMORY.md && echo "PASS" || echo "FAIL"
```

**Test 6.2: memory.toml exists and has valid config**
```bash
test -s .vodou/workspace/memory.toml && echo "PASS" || echo "FAIL"
```

**Test 6.3: memory.toml has extraction provider set**
```bash
grep -q '^\[extraction\]' .vodou/workspace/memory.toml && grep -q 'provider' .vodou/workspace/memory.toml && echo "PASS" || echo "WARN: extraction config missing"
```

**Test 6.4: Daily memory log directory exists**
```bash
test -d .vodou/workspace/memory && echo "PASS" || echo "FAIL"
```

**Test 6.5: Daily memory logs present**
```bash
COUNT=$(ls .vodou/workspace/memory/????-??-??.md 2>/dev/null | wc -l | tr -d ' '); echo "PASS: $COUNT daily logs"; [ "$COUNT" -eq 0 ] && echo "(WARN: no daily logs yet, expected on fresh install)"
```
Expected: PASS with count. WARN if 0 (fresh install).

**Test 6.6: Today's daily log exists**
```bash
TODAY=$(date +%Y-%m-%d); test -f ".vodou/workspace/memory/$TODAY.md" && echo "PASS: $TODAY.md exists" || echo "WARN: no log for today (normal if no prompts yet)"
```

### 6B: Memory Database (memory.db)

**Test 6.7: memory.db exists**
```bash
test -f memory.db && echo "PASS" || echo "WARN: memory.db not found (created by daemon on first run)"
```
Expected: PASS if daemon has run. WARN on fresh install.

**Test 6.8: memory.db has expected tables**
```bash
if test -f memory.db; then TABLES=$(sqlite3 memory.db ".tables" 2>/dev/null); for t in memory_chunks memory_embeddings memory_fts memory_cache; do echo "$TABLES" | grep -q "$t" && echo "PASS: $t" || echo "FAIL: $t missing from memory.db"; done; else echo "SKIP: memory.db not present"; fi
```

**Test 6.9: memory.db chunk count**
```bash
if test -f memory.db; then COUNT=$(sqlite3 memory.db "SELECT COUNT(*) FROM memory_chunks" 2>/dev/null); echo "PASS: $COUNT chunks in memory.db"; [ "$COUNT" -eq 0 ] && echo "(WARN: empty)"; else echo "SKIP: memory.db not present"; fi
```

**Test 6.10: vodou-core.db has NO memory tables (cleaned up)**
```bash
TABLES=$(sqlite3 vodou-core.db ".tables" 2>/dev/null); FOUND=0; for t in memory_chunks memory_embeddings memory_fts; do echo "$TABLES" | grep -q "$t" && { echo "FAIL: $t still in vodou-core.db (should be in memory.db only)"; FOUND=1; }; done; [ "$FOUND" -eq 0 ] && echo "PASS: no memory tables in vodou-core.db"
```

### 6C: FTS5 Full-Text Search (memory.db)

**Test 6.11: FTS5 vtable functional (memory.db)**
```bash
if test -f memory.db; then sqlite3 memory.db "SELECT COUNT(*) FROM memory_fts LIMIT 1" 2>/dev/null && echo "PASS" || echo "FAIL: FTS5 vtable broken"; else echo "SKIP: memory.db not present"; fi
```

**Test 6.12: FTS5 search query executes**
```bash
if test -f memory.db; then sqlite3 memory.db "SELECT COUNT(*) FROM memory_fts WHERE memory_fts MATCH 'test'" 2>/dev/null && echo "PASS" || echo "FAIL: FTS5 MATCH query failed"; else echo "SKIP: memory.db not present"; fi
```
Expected: Exit 0 (count can be 0 on fresh install)

**Test 6.13: FTS5 index consistent with chunks**
```bash
if test -f memory.db; then CHUNKS=$(sqlite3 memory.db "SELECT COUNT(*) FROM memory_chunks" 2>/dev/null); FTS=$(sqlite3 memory.db "SELECT COUNT(*) FROM memory_fts" 2>/dev/null); echo "Chunks: $CHUNKS, FTS rows: $FTS"; [ "$CHUNKS" = "$FTS" ] && echo "PASS: consistent" || echo "WARN: mismatch (chunks=$CHUNKS, fts=$FTS)"; else echo "SKIP: memory.db not present"; fi
```

### 6D: Vector Embeddings (memory.db)

**Test 6.14: memory_embeddings table accessible**
```bash
if test -f memory.db; then COUNT=$(sqlite3 memory.db "SELECT COUNT(*) FROM memory_embeddings" 2>/dev/null); echo "PASS: $COUNT embeddings in memory.db"; [ "$COUNT" -eq 0 ] && echo "(WARN: no embeddings yet)"; else echo "SKIP: memory.db not present"; fi
```

**Test 6.15: Embeddings match chunk count**
```bash
if test -f memory.db; then CHUNKS=$(sqlite3 memory.db "SELECT COUNT(*) FROM memory_chunks" 2>/dev/null); EMBEDS=$(sqlite3 memory.db "SELECT COUNT(*) FROM memory_embeddings" 2>/dev/null); echo "Chunks: $CHUNKS, Embeddings: $EMBEDS"; [ "$CHUNKS" = "$EMBEDS" ] && echo "PASS: 1:1 mapping" || echo "WARN: mismatch (some chunks may lack embeddings)"; else echo "SKIP: memory.db not present"; fi
```

**Test 6.16: Embedding dimensions correct (384D AllMiniLML6V2)**
```bash
if test -f memory.db && [ "$(sqlite3 memory.db "SELECT COUNT(*) FROM memory_embeddings" 2>/dev/null)" -gt 0 ]; then DIM=$(sqlite3 memory.db "SELECT LENGTH(embedding) FROM memory_embeddings LIMIT 1" 2>/dev/null); echo "Embedding blob size: $DIM bytes"; [ "$DIM" -gt 0 ] && echo "PASS: embeddings present" || echo "FAIL: empty embedding"; else echo "SKIP: no embeddings to check"; fi
```

### 6E: Memory CLI & Pipeline

**Test 6.17: mem config returns valid configuration**
```bash
OUTPUT=$(./vodou-core mem config 2>/dev/null); echo "$OUTPUT" | grep -q "memory_db" && echo "$OUTPUT" | grep -q "extraction_provider" && echo "PASS: config valid" || echo "FAIL: mem config missing expected fields"
```
Expected: Shows memory_db path, extraction_provider, workspace_root

**Test 6.18: mem prompt accepts input and exits cleanly**
```bash
echo "test memory recall" | ./vodou-core mem prompt 2>/dev/null; EXIT=$?; [ $EXIT -eq 0 ] && echo "PASS: mem prompt exit 0" || echo "FAIL: mem prompt exit $EXIT"
```
Expected: Exit 0. Memory recall is hook-driven — prompt is buffered and memories returned via daemon socket, not stdout.

**Test 6.19: mem flush exits cleanly**
```bash
./vodou-core mem flush 2>/dev/null; EXIT=$?; [ $EXIT -eq 0 ] && echo "PASS: mem flush exit 0" || echo "WARN: flush exit $EXIT (daemon may not be running, falls back to buffer)"
```
Expected: Exit 0 if daemon is running. Non-zero is WARN.

**Test 6.20: vodou-hook-bin context returns memory data**
```bash
OUTPUT=$(./vodou-hook-bin context 2>/dev/null); echo "$OUTPUT" | grep -qi "memory\|MEMORY\|workspace" && echo "PASS" || echo "WARN: context returned but no memory references"
```
Expected: Exit 0, output references memory or workspace files

**Test 6.21: mem subcommands all present**
```bash
HELP=$(./vodou-core mem --help 2>&1); PASS=0; TOTAL=0; for cmd in prompt flush setup promote promote-micro archive config test-extract; do TOTAL=$((TOTAL+1)); echo "$HELP" | grep -q "$cmd" && PASS=$((PASS+1)) || echo "FAIL: missing subcommand '$cmd'"; done; echo "PASS: $PASS/$TOTAL subcommands present"
```
Expected: 8/8 subcommands

**Test 6.22: memory migration marker**
```bash
test -f .vodou/.memory_migrated && echo "PASS: migration marker present" || echo "WARN: .memory_migrated not found (daemon may not have run migration yet)"
```

**Test 6.23: Memory recall pipeline (end-to-end)**
```bash
# Verify that memory chunks exist AND FTS can find them — proving the recall pipeline has data to work with
if test -f memory.db; then CHUNKS=$(sqlite3 memory.db "SELECT COUNT(*) FROM memory_chunks" 2>/dev/null); FTS_HIT=$(sqlite3 memory.db "SELECT COUNT(*) FROM memory_fts WHERE memory_fts MATCH 'memory OR test OR system'" 2>/dev/null); echo "Chunks: $CHUNKS, FTS hits: $FTS_HIT"; [ "$CHUNKS" -gt 0 ] && [ "$FTS_HIT" -gt 0 ] && echo "PASS: memory recall pipeline has searchable data" || echo "WARN: chunks=$CHUNKS, fts_hits=$FTS_HIT (may need more prompts)"; else echo "SKIP: memory.db not present"; fi
```
Expected: PASS with chunks > 0 and FTS hits > 0. This proves the full loop: prompts → extraction → storage → FTS indexing → searchable recall.

---

## Suite 7: Daemon & Hooks (Tier A)

**Test 7.1: vodou-hook-bin ensure starts daemon**
```bash
./vodou-hook-bin ensure 2>/dev/null && echo "PASS" || echo "FAIL"
```
Expected: Exit 0

**Test 7.2: daemon.sock exists**
```bash
sleep 2 && test -S .vodou/daemon.sock && echo "PASS" || echo "FAIL: daemon.sock not found"
```

**Test 7.3: daemon.pid valid**
```bash
test -f .vodou/daemon.pid && kill -0 $(cat .vodou/daemon.pid) 2>/dev/null && echo "PASS: PID $(cat .vodou/daemon.pid)" || echo "FAIL: daemon not running"
```

**Test 7.4: vodou-hook-bin context returns data**
```bash
OUTPUT=$(./vodou-hook-bin context 2>/dev/null); [ -n "$OUTPUT" ] && echo "PASS" || echo "WARN: empty context (may be normal)"
```

**Test 7.5: vodou-core daemon ensure**
```bash
./vodou-core daemon ensure 2>&1 && echo "PASS" || echo "FAIL"
```
Expected: Exit 0

---

## Suite 8: Workspace Bootstrap (Tier A)

**Test 8.1-8.6: All workspace files exist**
```bash
for f in MEMORY.md AGENTS.md USER.md IDENTITY.md SOUL.md TOOLS.md; do
  test -f ".vodou/workspace/$f" && echo "PASS: $f" || echo "FAIL: $f missing"
done
```

**Test 8.7: memory directory exists**
```bash
test -d .vodou/workspace/memory && echo "PASS" || echo "FAIL"
```

**Test 8.8: memory.toml exists**
```bash
test -f .vodou/workspace/memory.toml && echo "PASS" || echo "FAIL"
```

---

## Suite 9: Configuration (Tier A)

**Test 9.1: .env file exists**
```bash
test -f .env && echo "PASS" || echo "FAIL"
```

**Test 9.2: extractors.toml exists and not empty**
```bash
test -s extractors.toml && echo "PASS" || echo "FAIL"
```

**Test 9.3: mcp_servers registry exists in vodou-core.db**
```bash
sqlite3 vodou-core.db "SELECT name FROM mcp_servers LIMIT 1" >/dev/null 2>&1 && echo "PASS" || echo "FAIL"
```

**Test 9.4: mcp_servers has servers registered**
```bash
sqlite3 vodou-core.db "SELECT 'PASS: ' || COUNT(*) || ' servers' FROM mcp_servers" 2>/dev/null || echo "FAIL"
```
Expected: >= 10 servers (this is the source of truth the LLM router reads; config.json is no longer generated)

**Test 9.5: vodou-core.db schema version present**
```bash
VER=$(sqlite3 vodou-core.db "SELECT MAX(version) FROM schema_version" 2>/dev/null); [ -n "$VER" ] && echo "PASS: schema version $VER" || echo "WARN: no schema_version table"
```
Expected: PASS with a version number. Pre-built DB should have schema_version seeded.

---

## Suite 10: Core CLI Commands (Tier A + Partial B)

**Test 10.1: list exits 0** (Tier B)
```bash
./vodou-core list 2>&1 && echo "PASS" || echo "FAIL"
```

**Test 10.2: tools for mcp-monitor** (Tier B)
```bash
./vodou-core tools mcp-monitor 2>&1 && echo "PASS" || echo "FAIL"
```

**Test 10.3: context --base-only --json returns valid JSON** (Tier A)
```bash
./vodou-core context --base-only --json 2>/dev/null | python3 -c "import sys,json; json.load(sys.stdin)" && echo "PASS" || echo "FAIL"
```

**Test 10.4: version exits 0** (Tier A)
```bash
./vodou-core version 2>&1 && echo "PASS" || echo "FAIL"
```

**Test 10.5: schedule list exits 0** (Tier A)
```bash
./vodou-core schedule list 2>&1 && echo "PASS" || echo "FAIL"
```

**Test 10.6: list-tools-db exits 0** (Tier A)
```bash
./vodou-core list-tools-db 2>/dev/null && echo "PASS" || echo "FAIL"
```

**Test 10.7: all-tools lists tools** (Tier B)
```bash
./vodou-core all-tools 2>/dev/null && echo "PASS" || echo "FAIL"
```

---

## Suite 11: Performance (Tier B)

For each test, measure wall-clock time and compare against the threshold.

**Test 11.1: vodou-core version < 1 second**
```bash
time ./vodou-core version 2>&1
```
Threshold: < 1s PASS, 1-3s WARN, > 3s FAIL

**Test 11.2: vodou-hook-bin ensure < 3 seconds**
```bash
time ./vodou-hook-bin ensure 2>&1
```
Threshold: < 3s PASS, 3-5s WARN, > 5s FAIL

**Test 11.3: vodou-core list < 5 seconds**
```bash
time ./vodou-core list 2>&1
```
Threshold: < 5s PASS, 5-10s WARN, > 10s FAIL

**Test 11.4: Tool call < 10 seconds**
```bash
time ./vodou-core call mcp-monitor get_cpu_info 2>&1
```
Threshold: < 10s PASS, 10-15s WARN, > 15s FAIL

**Test 11.5: vodou-hook-bin context < 2 seconds**
```bash
time ./vodou-hook-bin context 2>&1
```
Threshold: < 2s PASS, 2-5s WARN, > 5s FAIL

---

## Results Report Template

After completing all selected suites, display results in this exact format:

```
====================================================
  Vodou REGRESSION TEST REPORT
====================================================
Date:         [YYYY-MM-DD HH:MM:SS TZ]
Vodou Version:   [from vodou-core version]
Architecture: [uname -m]
Test Scope:   [user's selection]
Vodou Root:      [pwd]

RESULTS BY SUITE
----------------------------------------------------
Suite 1: Binary & Architecture     [X/Y]  [PASS|WARN|FAIL]
Suite 2: Database & Migrations     [X/Y]  [PASS|WARN|FAIL]
Suite 3: MCP Servers               [X/Y]  [PASS|WARN|FAIL]
Suite 4: Intent Routing            [X/Y]  [PASS|WARN|FAIL]
Suite 5: Skills System             [X/Y]  [PASS|WARN|FAIL]
Suite 6: Memory System             [X/19]  [PASS|WARN|FAIL]
Suite 7: Daemon & Hooks            [X/Y]  [PASS|WARN|FAIL]
Suite 8: Workspace Bootstrap       [X/Y]  [PASS|WARN|FAIL]
Suite 9: Configuration             [X/Y]  [PASS|WARN|FAIL]
Suite 10: Core CLI Commands        [X/Y]  [PASS|WARN|FAIL]
Suite 11: Performance              [X/Y]  [PASS|WARN|FAIL]

MEMORY SYSTEM DETAIL
----------------------------------------------------
  Files & Config (6A)
    6.1  MEMORY.md exists              [PASS|FAIL]
    6.2  memory.toml valid             [PASS|FAIL]
    6.3  extraction provider set       [PASS|WARN]
    6.4  daily log directory           [PASS|FAIL]
    6.5  daily log count               [N logs] [PASS|WARN]
    6.6  today's daily log             [PASS|WARN]
  Memory Database (6B)
    6.7  memory.db exists              [PASS|WARN]
    6.8  memory.db tables              [PASS|FAIL|SKIP]
    6.9  memory.db chunk count         [N] [PASS|WARN|SKIP]
    6.10 no memory tables in bt4.db    [PASS|FAIL]
  FTS5 Full-Text Search (6C)
    6.11 FTS5 vtable functional        [PASS|FAIL|SKIP]
    6.12 FTS5 MATCH query              [PASS|FAIL|SKIP]
    6.13 FTS5/chunk consistency        [PASS|WARN|SKIP]
  Vector Embeddings (6D)
    6.14 embeddings accessible         [N] [PASS|WARN|SKIP]
    6.15 embeddings/chunk parity       [PASS|WARN|SKIP]
    6.16 embedding dimensions          [PASS|FAIL|SKIP]
  CLI & Pipeline (6E)
    6.17 mem config valid              [PASS|FAIL]
    6.18 mem prompt accepts input      [PASS|FAIL]
    6.19 mem flush exits cleanly       [PASS|WARN]
    6.20 vodou-hook-bin context (memory)  [PASS|WARN]
    6.21 mem subcommands present       [PASS|FAIL]
    6.22 migration marker              [PASS|WARN]
    6.23 memory recall pipeline (e2e)  [PASS|WARN|SKIP]

FAILURES (if any)
----------------------------------------------------
[Suite X] Test X.Y: [description]
  Command: [command that failed]
  Expected: [what was expected]
  Actual: [what happened]
  Fix: [how to fix]

WARNINGS (if any)
----------------------------------------------------
[Suite X] Test X.Y: [description]
  Note: [what was degraded and why it might be ok]

PERFORMANCE SUMMARY
----------------------------------------------------
vodou-core version:  [X.Xs]  [PASS|WARN|FAIL]
vodou-hook-bin ensure:    [X.Xs]  [PASS|WARN|FAIL]
vodou-core list:     [X.Xs]  [PASS|WARN|FAIL]
Tool call (cpu):       [X.Xs]  [PASS|WARN|FAIL]
vodou-hook-bin context:   [X.Xs]  [PASS|WARN|FAIL]

TOTALS
----------------------------------------------------
Passed:   [N]
Warnings: [N]
Failed:   [N]
Total:    [N]

STATUS: [OPERATIONAL | OPERATIONAL WITH WARNINGS | DEGRADED | BROKEN]
====================================================
```

**Status determination:**
- **OPERATIONAL**: 0 failures, 0 warnings
- **OPERATIONAL WITH WARNINGS**: 0 failures, >= 1 warning
- **DEGRADED**: 1-3 failures
- **BROKEN**: > 3 failures

---

## STOPPING POINT 2: Post-Results Actions

What would you like to do next?

1. **Re-run failed tests only** -- Retry just the failures to see if they're intermittent
2. **Run a different suite** -- Go back to suite selection
3. **Export results to file** -- Save report to `regression-test-results-[date].md` in the Vodou root
4. **Diagnose failures** -- Get detailed troubleshooting for each failure
5. **Auto-fix issues** -- Attempt to automatically repair all failures and warnings
6. **Run full suite again** -- Complete re-run of all tests
7. **Done** -- Exit regression testing

Reply with a number (1-7):

---

## Option 5 (Post-Results): Auto-Fix Issues

When the user selects option 5 from STOPPING POINT 2, the agent attempts to repair every FAIL and WARN from the test results.

**Agent instructions for auto-fix:**

1. Loop through all failures and warnings from the test results, in suite order.
2. For each issue, apply the appropriate fix from the table below.
3. Show a live log as you go: `Fixing [Test X.Y]: [description]... [FIXED|SKIPPED|MANUAL]`
4. After all fixes attempted, re-run only the previously failed/warned tests to verify.
5. Display a summary of what was fixed, what still needs attention, and return to STOPPING POINT 2.

**Auto-fix actions by test:**

| Test | Fix Action |
|------|------------|
| 1.1-1.3 | MANUAL -- Binary missing/not executable requires re-download or `chmod +x` |
| 1.4-1.5 | MANUAL -- Wrong architecture requires downloading correct platform binary |
| 2.1 | Run `./vodou-core list` to trigger DB initialization |
| 2.2 | Run `./vodou-core list` to trigger schema migrations |
| 2.3-2.4 | Run `./vodou-core list` then `./vodou-core health-check` to populate servers/tools |
| 2.5 | Start daemon: `./vodou-hook-bin ensure` (daemon creates memory.db on first run) |
| 3.1-3.4 | Run `./start-vodou-services.sh` if available, otherwise `./vodou-core daemon ensure` |
| 3.5 | Run `cd MCP-servers/[server] && npm run build` for missing dist/index.js |
| 3.7 | MANUAL -- Go binary missing requires rebuild (`cd MCP-servers/mcp-monitor && go build`) |
| 4.1 | Run `./vodou-core list` to trigger intent seeding |
| 4.2-4.3 | Insert missing critical intents via `sqlite3 vodou-core.db "INSERT INTO intent_mappings ..."` |
| 5.1-5.2 | Run `./vodou-core list` to trigger skill scan and registry population |
| 5.3 | Ensure daemon running: `./vodou-hook-bin ensure`, then retry `./vodou-core brain "hello"` |
| 5.4-5.5 | Check intent seeding: re-run `create-clean-db.sh` or insert missing intents manually |
| 6.1 | Create file: `touch .vodou/workspace/MEMORY.md` |
| 6.2-6.3 | Copy default: `cp .vodou/workspace/memory.toml.example .vodou/workspace/memory.toml` or create minimal config |
| 6.4 | Create dir: `mkdir -p .vodou/workspace/memory` |
| 6.7-6.9 | Start daemon: `./vodou-hook-bin ensure` (daemon creates and populates memory.db) |
| 6.10 | Drop legacy memory tables from vodou-core.db: `sqlite3 vodou-core.db "DROP TABLE IF EXISTS memory_fts; DROP TABLE IF EXISTS memory_chunks; DROP TABLE IF EXISTS memory_embeddings;"` |
| 6.11-6.13 | Restart daemon to trigger `ensure_fts_healthy()` auto-repair in memory.db |
| 6.14-6.16 | WARN only -- embeddings populate over time as daemon processes chunks |
| 6.17 | Run `./vodou-core mem config` — if fails, check binary and memory.toml |
| 6.18-6.19 | Ensure daemon running: `./vodou-hook-bin ensure` (prompt, flush, and context require daemon socket) |
| 6.20 | Ensure daemon running: `./vodou-hook-bin ensure` (context requires daemon socket) |
| 6.22 | Start daemon: `./vodou-hook-bin ensure` (migration runs on first daemon start) |
| 6.23 | Run prompts to generate chunks, then `./vodou-core mem flush` to index them |
| 7.1-7.5 | Run `./vodou-hook-bin ensure` then wait 2s for daemon socket |
| 8.1-8.8 | Run `./vodou-core bootstrap` to recreate workspace files |
| 9.1 | MANUAL -- `.env` requires user credentials from app.vodou.ai |
| 9.2 | MANUAL if missing -- extractors.toml ships with install |
| 9.3-9.4 | If empty, reconnect servers: `./vodou-core reconnect-all` (populates mcp_servers) |
| 9.5 | Run `./vodou-core list` to trigger schema initialization if schema_version missing |
| 10.x | Most CLI failures are downstream of daemon/DB -- fix those first |
| 11.x | Performance issues are typically symptoms of other failures -- fix root causes first |

**Important:**
- Always ask before running destructive fixes (deleting/recreating files that may have user data)
- MANUAL items: explain what the user needs to do and why it can't be automated
- If a fix fails, log it and move on -- don't retry in a loop
- After auto-fix, always re-run the affected tests to confirm the fix worked

---

## Option 14: Add/Change a Test

When the user selects option 14, ask them:

```
What would you like to do?

1. Add a new test to an existing suite (1-11)
2. Modify an existing test (change command, expected result, or tier)
3. Remove a test
4. Add an entirely new suite (Suite 12+)

Reply with a number (1-4) and describe what you want:
```

**Agent instructions for option 14:**
- After the user describes the change, read this SKILL.md file, make the edit directly, and confirm what changed.
- For new tests: follow the existing format (`**Test X.Y: description**` + bash code block + Expected line). Number sequentially within the suite.
- For new suites: add a new `## Suite N:` section, add it to STOPPING POINT 1 menu (increment option count), and add a line to the report template.
- Update the total test count in the Overview section.
- After editing, show the user the diff of what changed.

---

## Troubleshooting Guide

### Common Failures and Fixes

**vodou-core wrong architecture:**
- Re-download the correct binary for your platform (arm64 vs intel)
- Check: `file ./vodou-core` and compare with `uname -m`

**Database tables missing:**
- Run `./vodou-core list` to trigger schema initialization
- Pre-built DB should have all tables; if missing, the build may be corrupt

**MCP servers not responding:**
- Run `./vodou-core health-check` for per-server diagnostics
- Ensure daemon is running: `./vodou-hook-bin ensure`
- Restart services: `./start-vodou-services.sh`
- Check Node.js: `node --version` (must be >= 20)

**FTS5 vtable broken (memory.db):**
- Daemon auto-repairs on startup via `ensure_fts_healthy()`
- Force repair: restart daemon with `./vodou-core daemon ensure`

**memory.db missing or empty:**
- Daemon creates memory.db on first run. Start daemon: `./vodou-hook-bin ensure`
- All memory data lives exclusively in memory.db (not vodou-core.db)

**FTS5/chunk count mismatch (memory.db):**
- FTS index can drift from chunks after crashes or interrupted writes
- Fix: restart daemon (`./vodou-core daemon ensure`) -- `ensure_fts_healthy()` auto-repairs
- Nuclear option: `sqlite3 memory.db "DELETE FROM memory_fts"` then restart daemon

**Embeddings missing or mismatched:**
- Embeddings are generated by daemon during memory sync (AllMiniLML6V2, 384D)
- If chunks exist but embeddings don't: daemon hasn't processed them yet. Restart and wait.
- Check embedding model: `grep -i embed .vodou/workspace/memory.toml`

**Legacy memory tables in vodou-core.db:**
- If regression test 6.10 fails, legacy memory tables still exist in vodou-core.db
- Safe to drop: `sqlite3 vodou-core.db "DROP TABLE IF EXISTS memory_fts; DROP TABLE IF EXISTS memory_chunks; DROP TABLE IF EXISTS memory_embeddings;"`
- Note: migration 021 may recreate them on fresh installs; this is a known issue pending code cleanup

**No daily memory logs:**
- Daily logs are created by incremental extraction on each prompt (UserPromptSubmit hook)
- Verify hook is configured: check `.claude/settings.json` for `vodou-hook-bin sock prompt`
- Manual flush: `./vodou-hook-bin sock flush`

**vodou-hook-bin sock flush fails:**
- Requires daemon to be running. Start with: `./vodou-hook-bin ensure`
- If daemon is down, flush falls back to `.prompt_buffer` append (non-fatal)
- Check daemon status: `test -S .vodou/daemon.sock && echo "running" || echo "down"`

**Workspace files missing:**
- Run `./vodou-core bootstrap` to recreate workspace files
- Check `.vodou/workspace/` directory exists

**mcp_servers registry empty (LLM router sees no servers):**
- The router reads installed servers directly from `vodou-core.db` (`mcp_servers` table); config.json is no longer generated.
- Repopulate by reconnecting: `./vodou-core reconnect-all`
- Verify: `sqlite3 vodou-core.db "SELECT name FROM mcp_servers ORDER BY name"`

**Daemon won't start:**
- Check for stale PID: `cat .vodou/daemon.pid` then `ps aux | grep vodou-core`
- Remove stale files: `rm .vodou/daemon.pid .vodou/daemon.sock` then retry
- Check logs: `cat .vodou/daemon.log`

**better-sqlite3 ABI mismatch (Node servers fail):**
- Run: `./scripts/rebuild-native-deps.sh`
- Or per-server: `cd MCP-servers/[server] && npm rebuild better-sqlite3`
