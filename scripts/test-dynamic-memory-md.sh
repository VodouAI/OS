#!/usr/bin/env bash
# PLAN-DYNAMIC-MEMORY-MD (0.6.26) — automated QA for the runtime-rendered MEMORY.md.
#
# Two layers:
#   1. UNIT  — cargo tests for the renderer, sync purge safety, compact, capture_ide, hook splice.
#   2. LIVE  — end-to-end against the RUNNING daemon + hook + memory.db:
#              CLI render (global + project), daemon `memory_render` verb (cwd → project),
#              hook SessionStart splice, disk snapshot, pin round-trip, budget, tier order,
#              restored corpus intact, single embedding model, promote/compact disabled.
#
# Usage:  bash scripts/test-dynamic-memory-md.sh            # both layers
#         bash scripts/test-dynamic-memory-md.sh --live-only
#         bash scripts/test-dynamic-memory-md.sh --unit-only
# Exit code = number of failed checks (0 = all green).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
SOCK="$ROOT/.vodou/daemon.sock"
WS="$ROOT/.vodou/workspace"
MEMDB="$ROOT/memory.db"
COREDB="$ROOT/vodou-core.db"
GWDB="$ROOT/MCP-servers/Vodou-Console/gateway.db"
LEGAL_CWD="${VODOU_QA_PROJECT_CWD:-/Users/chad/Desktop/_vodou/LEGAL}"
LEGAL_ID="${VODOU_QA_PROJECT_ID:-proj_12f1836f}"

RUN_UNIT=1; RUN_LIVE=1
for a in "$@"; do
  case "$a" in
    --live-only) RUN_UNIT=0 ;;
    --unit-only) RUN_LIVE=0 ;;
  esac
done

# .env carries VODOU_MEMORY_RENDER_BUDGET / ORT_DYLIB_PATH etc. — same env the hooks get.
set -a; . ./.env 2>/dev/null; set +a
BUDGET="${VODOU_MEMORY_RENDER_BUDGET:-6000}"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
check(){ if [ "$1" = "0" ]; then ok "$2"; else bad "$2${3:+ — $3}"; fi; }

# JSON helper: json_get '<json>' '<python expr over d>'
jget() { python3 -c "import sys,json; d=json.loads(sys.argv[1]); print(eval(sys.argv[2]))" "$1" "$2" 2>/dev/null; }
sock() { printf '%s\n' "$1" | nc -U "$SOCK" 2>/dev/null | head -1; }

echo "=================================================="
echo " PLAN-DYNAMIC-MEMORY-MD — automated QA"
echo " root=$ROOT budget=$BUDGET"
echo "=================================================="

# ─────────────────────────────────────────────────────────────────────────────
if [ "$RUN_UNIT" = "1" ]; then
echo
echo "[UNIT] cargo tests"
OUT=$(cargo test --bin vodou-core -- memory::render memory::sync::tests::test_sync_purge memory_flush::memory_file_tests::compact memory::capture_ide 2>&1 | grep -E "^test result")
echo "  $OUT"
echo "$OUT" | grep -q " 0 failed" && ! echo "$OUT" | grep -q " 0 passed"; check $? "vodou-core unit tests (render, sync purge, compact, capture_ide)"
OUT=$(cd vodou-hook && cargo test -- splice 2>&1 | grep -E "^test result")
echo "  $OUT"
echo "$OUT" | grep -q " 0 failed" && ! echo "$OUT" | grep -q " 0 passed"; check $? "vodou-hook unit tests (splice_memory_section)"
fi

# ─────────────────────────────────────────────────────────────────────────────
if [ "$RUN_LIVE" = "1" ]; then
echo
echo "[LIVE 1] preconditions"
[ -S "$SOCK" ]; check $? "daemon socket present ($SOCK)"
[ -x ./vodou-core ] && [ -x ./vodou-hook-bin ]; check $? "binaries present"
./vodou-core mem render --help 2>&1 | grep -q -- "--project"; check $? "deployed vodou-core has \`mem render\` (new binary)"

echo
echo "[LIVE 2] CLI render — global"
G=$(./vodou-core mem render --json 2>/dev/null)
[ -n "$G" ]; check $? "mem render --json returned output"
GMD=$(jget "$G" "d['markdown']")
GP=$(jget "$G" "d['pinned']"); GG=$(jget "$G" "d['global']"); GC=$(jget "$G" "d['chars']")
[ "${GP:-0}" -gt 0 ]; check $? "pinned tier non-empty (pinned=$GP)"
[ "${GG:-0}" -gt 0 ]; check $? "global tier non-empty (global=$GG)"
[ "${GC:-99999}" -le "$BUDGET" ]; check $? "chars ($GC) within budget ($BUDGET)"
printf '%s' "$GMD" | head -1 | grep -q "^# MEMORY.md — rendered from memory.db"; check $? "rendered header line"
printf '%s' "$GMD" | grep -q "^<!-- rendered by vodou-core memory_render"; check $? "snapshot notice present"
! printf '%s' "$GMD" | grep -q "^### "; check $? "renderer never emits '### ' (hook splice delimiter)"
python3 - "$GMD" <<'PY'; check $? "tier order Identity < Preferences < Decisions < Notes < Recent"
import sys; md=sys.argv[1]
idx=[md.find(h) for h in ("## Identity","## Preferences","## Decisions","## Notes","## Recent & important (live)")]
present=[i for i in idx if i>=0]
sys.exit(0 if present==sorted(present) and len(present)>=3 else 1)
PY
! printf '%s' "$GMD" | grep -q "## Project:"; check $? "global render has no project tier"
! printf '%s' "$GMD" | grep -qE "^- [^ ]*\*\*"; check $? "no bold-marker stubs in bullets"
! printf '%s' "$GMD" | grep -q "\[SUPERSEDED\]"; check $? "no [SUPERSEDED] bullets rendered"
! printf '%s' "$GMD" | grep -qE "^- \[(DONE|PLANNED|ISSUE)\]"; check $? "no session-log tags (DONE/PLANNED/ISSUE) in ranked tiers"

echo
echo "[LIVE 3] CLI render — project ($LEGAL_ID)"
P=$(./vodou-core mem render --project "$LEGAL_ID" --json 2>/dev/null)
PMD=$(jget "$P" "d['markdown']"); PP=$(jget "$P" "d['project']"); PC=$(jget "$P" "d['chars']")
[ "${PP:-0}" -gt 0 ]; check $? "project tier non-empty (project=$PP)"
[ "${PC:-99999}" -le "$BUDGET" ]; check $? "project render within budget ($PC)"
python3 - "$PMD" <<'PY'; check $? "project tier sits between Notes/pins and Recent"
import sys; md=sys.argv[1]
p=md.find("## Project:"); r=md.find("## Recent & important (live)"); i=md.find("## Identity")
sys.exit(0 if p>0 and i>=0 and i<p and (r<0 or p<r) else 1)
PY
printf '%s' "$PMD" | grep -q "^<!-- rendered by .*scope: $LEGAL_ID"; check $? "header names the project scope"

echo
echo "[LIVE 4] budget knob"
B=$(./vodou-core mem render --budget 3000 --json 2>/dev/null); BC=$(jget "$B" "d['chars']")
[ "${BC:-99999}" -le 3000 ]; check $? "--budget 3000 honored (chars=$BC)"

echo
echo "[LIVE 5] daemon verb memory_render (cwd → project)"
R1=$(sock "{\"cmd\":\"memory_render\",\"payload\":{\"cwd\":\"$LEGAL_CWD\"}}")
[ "$(jget "$R1" "d['ok']")" = "True" ]; check $? "verb answers ok for project cwd"
[ "$(jget "$R1" "d['data']['project_id']")" = "$LEGAL_ID" ]; check $? "cwd $LEGAL_CWD → $LEGAL_ID"
[ "$(jget "$R1" "d['data']['project']")" -gt 0 ] 2>/dev/null; check $? "daemon project tier non-empty ($(jget "$R1" "d['data']['project']"))"
R2=$(sock "{\"cmd\":\"memory_render\",\"payload\":{\"cwd\":\"$ROOT\"}}")
[ "$(jget "$R2" "d['data']['project_id']")" = "None" ]; check $? "install root → global (project_id null)"
[ "$(jget "$R2" "d['data']['chars']")" -le "$BUDGET" ] 2>/dev/null; check $? "daemon render within budget"
R3=$(sock "{\"cmd\":\"memory_render\",\"payload\":{\"cwd\":\"$ROOT\",\"budget_chars\":2500}}")
[ "$(jget "$R3" "d['data']['chars']")" -le 2500 ] 2>/dev/null; check $? "verb honors budget_chars"

echo
echo "[LIVE 6] hook SessionStart splice"
HG=$(CLAUDE_PROJECT_DIR="$ROOT" ./vodou-hook-bin context 2>/dev/null)
printf '%s' "$HG" | grep -q "^### MEMORY.md"; check $? "hook context has ### MEMORY.md section"
printf '%s' "$HG" | grep -q "^# MEMORY.md — rendered from memory.db"; check $? "hook section is the rendered card"
! printf '%s' "$HG" | grep -q "^## Project:"; check $? "install-root session gets no project tier"
printf '%s' "$HG" | grep -q "^### Ground truth (live)"; check $? "ground-truth block still present after splice"
printf '%s' "$HG" | grep -qE "^### (BOOTSTRAP|HEARTBEAT|USER|IDENTITY|TOOLS|SOUL|AGENTS)\.md"; check $? "other workspace sections survive the splice"
python3 - "$HG" <<'PY'; check $? "hook: MEMORY.md section is contiguous (one header, ends at next ### file)"
import sys,re; c=sys.argv[1]
assert c.count("### MEMORY.md\n")==1
i=c.index("### MEMORY.md\n"); j=c.find("\n### ",i+5)
sec=c[i:j if j>0 else len(c)]
sys.exit(0 if "## Identity" in sec and "rendered from memory.db" in sec else 1)
PY
HL=$(CLAUDE_PROJECT_DIR="$LEGAL_CWD" ./vodou-hook-bin context 2>/dev/null)
printf '%s' "$HL" | grep -q "^## Project:"; check $? "LEGAL-cwd session gets the project tier"
printf '%s' "$HL" | grep -q "scope: $LEGAL_ID"; check $? "LEGAL-cwd card is scoped to $LEGAL_ID"

echo
echo "[LIVE 7] disk snapshot"
[ -f "$WS/MEMORY.md" ]; check $? "snapshot file exists"
head -1 "$WS/MEMORY.md" | grep -q "^# MEMORY.md — rendered from memory.db"; check $? "snapshot is a rendered card"
grep -q "scope: global" "$WS/MEMORY.md"; check $? "snapshot is the GLOBAL rendering"
python3 - "$WS/MEMORY.md" "$GMD" <<'PY'; check $? "snapshot == CLI global render (modulo timestamp line)"
import sys
strip=lambda s:"\n".join(l for l in s.splitlines() if not l.startswith("<!-- rendered by"))
a=strip(open(sys.argv[1]).read()); b=strip(sys.argv[2])
sys.exit(0 if a.strip()==b.strip() else 1)
PY
! grep -q "Vodou:auto-memory:begin" "$WS/MEMORY.md"; check $? "no legacy sentinels in snapshot"

echo
echo "[LIVE 8] pin round-trip"
PROBE="QA-PROBE-$(date +%s) — automated pin round-trip marker, safe to delete"
PIN_OUT=$(./vodou-core mem pin --text "$PROBE" --section Notes 2>&1)
PIN_ID=$(printf '%s' "$PIN_OUT" | grep -o "pin-[0-9a-f]\{16\}" | head -1)
[ -n "$PIN_ID" ]; check $? "mem pin --text created $PIN_ID"
./vodou-core mem pin --list 2>/dev/null | grep -q "$PIN_ID"; check $? "mem pin --list shows it immediately (WAL-aware read — was immutable=1 and blind to fresh writes)"
./vodou-core mem render 2>/dev/null | grep -q "QA-PROBE-"; check $? "pinned probe renders under Notes"
sqlite3 "$MEMDB" "select count(*) from memory_chunks where id='$PIN_ID' and pinned=1 and path like 'pinned:%';" | grep -q "^1$"; check $? "pin stored as pinned:* chunk"
./vodou-core mem unpin "$PIN_ID" >/dev/null 2>&1; check $? "mem unpin"
! ./vodou-core mem render 2>/dev/null | grep -q "QA-PROBE-"; check $? "probe gone from render after unpin"
sqlite3 "$MEMDB" "select count(*) from memory_chunks where id='$PIN_ID';" | grep -q "^0$"; check $? "pinned:* chunk deleted on unpin"

echo
echo "[LIVE 8b] gateway W15 — per-project bootstrap (dist module against the live daemon)"
GWOUT=$(cd MCP-servers/Vodou-Console && node --input-type=module -e "
import { readFileSync } from 'fs';
const { bootstrapForProject } = await import('./dist/memory-render.js');
const base = readFileSync('../../.vodou/workspace/.context_cache','utf-8');
const out = await bootstrapForProject(base, '$LEGAL_ID', 'qa');
const i = out.indexOf('### MEMORY.md'); const j = out.indexOf('\\n### ', i+5);
const sec = out.slice(i, j>0?j:out.length);
console.log(JSON.stringify({changed: out!==base, tier: sec.includes('## Project:'), scoped: sec.includes('scope: $LEGAL_ID'), intact: /### Presence/.test(out) && /### HEARTBEAT\\.md/.test(out), dflt: (await bootstrapForProject(base,'proj_default'))===base}));
process.exit(0);" 2>/dev/null | tail -1)
[ "$(jget "$GWOUT" "d['changed'] and d['tier'] and d['scoped']")" = "True" ]; check $? "gateway bootstrapForProject swaps in the $LEGAL_ID rendering ($GWOUT)"
[ "$(jget "$GWOUT" "d['intact']")" = "True" ]; check $? "gateway splice leaves other bootstrap sections intact"
[ "$(jget "$GWOUT" "d['dflt']")" = "True" ]; check $? "proj_default / no project → global bootstrap unchanged"
grep -q "await getWorkspaceBootstrapForTurn()" MCP-servers/Vodou-Console/dist/llm.js; check $? "deployed dist/llm.js uses the per-turn bootstrap"

echo
echo "[LIVE 9] corpus + config invariants"
N=$(sqlite3 "$MEMDB" "select count(*) from memory_chunks;")
[ "${N:-0}" -ge 42000 ]; check $? "memory_chunks >= 42,000 (restored corpus intact: $N)"
M=$(sqlite3 "$MEMDB" "select count(*) from memory_chunks where path like 'memory/2026-05-%';")
[ "${M:-0}" -gt 1000 ]; check $? "archived-log chunks present (May 2026: $M)"
MODELS=$(sqlite3 "$MEMDB" "select count(distinct model) from memory_embeddings;")
[ "$MODELS" = "1" ]; check $? "single embedding model across memory_embeddings"
ORPH=$(sqlite3 "$MEMDB" "select count(*) from memory_embeddings e where not exists (select 1 from memory_chunks c where c.id=e.chunk_id);")
[ "$ORPH" = "0" ]; check $? "no orphan embeddings"
FTS=$(sqlite3 "$MEMDB" "select (select count(*) from memory_fts) = (select count(*) from memory_chunks);")
[ "$FTS" = "1" ]; check $? "FTS row count == chunk count"
EN=$(sqlite3 "$COREDB" "select count(*) from scheduled_tasks where payload in ('mem promote','mem promote-micro','mem compact') and enabled=1;")
[ "${EN:-1}" = "0" ]; check $? "no ENABLED promote/promote-micro/compact task (found $EN — the seeder used to re-create memory-compact on every DB open)"
# The seeder must respect a disabled row: opening the main DB with the env unset must NOT add an enabled twin.
BEFORE=$(sqlite3 "$COREDB" "select count(*) from scheduled_tasks where name='memory-compact';")
env -u VODOU_ENABLE_MEMORY_COMPACT_SCHEDULE ./vodou-core health-check >/dev/null 2>&1
AFTER=$(sqlite3 "$COREDB" "select count(*) from scheduled_tasks where name='memory-compact';")
[ "$BEFORE" = "$AFTER" ]; check $? "seeder does not re-create memory-compact when a disabled row exists ($BEFORE → $AFTER)"
IDE=$(sqlite3 "$GWDB" "select count(*) from gateway_conversations where id like 'ide:%' and project_id is not null;")
[ "${IDE:-0}" -ge 1 ]; check $? "W9: at least one IDE conversation carries a project_id ($IDE)"
./vodou-core mem capture-ide --backfill-projects --dry-run 2>&1 | grep -q "DRY RUN"; check $? "W9 backfill dry-run runs"
fi

echo
echo "=================================================="
echo " RESULT: $PASS passed, $FAIL failed"
echo "=================================================="
exit "$FAIL"
