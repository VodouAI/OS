# Vodou-Board MCP Server

Multi-agent task board MCP server. Workers connect via stdio and call `board_*` tools to drive their task lifecycle. Reads `board.db` directly (READONLY mode + ATTACHed `vodou-core.db` / `memory.db`); writes route through the gateway HTTP API for canonical event emission + notifier fan-out.

## Phase 1 status

| Component | Status |
|---|---|
| Server boilerplate + manifest | ✅ shipped |
| Tool listing + gating (VODOU_BOARD_TASK) | ✅ shipped |
| Read connection (board.db + ATTACH core + mem) | ✅ shipped |
| Gateway HTTP write client + offline fallback | ✅ shipped |
| TypeScript types mirroring board.db rows | ✅ shipped |
| 14 tool handlers (show/list/complete/block/heartbeat/comment/create/link/unblock/search/artifact/request_approval/assignees/ask) | 🚧 stubs only — land Day 5-6 of build checklist |
| Tests | 🚧 Day 5-6 |

## Build

```bash
cd MCP-servers/Vodou-Board
npm install
npm run build
```

## Run (standalone, for debugging)

```bash
# In a worker session:
VODOU_BOARD_TASK=t_test001 \
VODOU_BOARD_WORKSPACE=/tmp/test-workspace \
VODOU_BOARD_DB=/abs/path/to/board.db \
VODOU_PROJECT_PATH=/abs/path/to/project \
  node dist/index.js
```

The server listens on stdio; an MCP client (typically the Claude CLI spawned by the dispatcher) connects and lists/calls tools.

## Tool gating

- **Worker session** (env `VODOU_BOARD_TASK=<id>` present): all 14 tools visible.
- **Chat session** (env not set): zero tools advertised. The LLM's schema stays clean.

This is the Hermes Kanban `check_fn` pattern, ported to TypeScript.

## Database access

- **Read path** — `src/db.ts::getReadDb()` returns a memoized read-only `better-sqlite3` handle to `board.db`. `vodou-core.db` is ATTACHed as `core`; `memory.db` as `mem` (when present).
- **Write path** — `src/gateway-client.ts::gatewayCall()` POSTs to `http://127.0.0.1:8765/api/board/...` with `Authorization: Bearer ${VODOU_BOARD_WRITE_TOKEN}`. On gateway unreachable / 5xx, falls back to writing `_orphan` events into `task_events` for the dispatcher to reconcile.

## Reading order for new contributors

1. `vodou-manifest.json` — server identity + tool list
2. `src/gating.ts` — the VODOU_BOARD_TASK check
3. `src/db.ts` — read connection setup
4. `src/gateway-client.ts` — write path + offline fallback
5. `src/types.ts` — row shape contracts
6. `src/index.ts` — server boilerplate + tool registry
7. `src/tools/*.ts` — individual handlers (Day 5-6)

## Companion docs

- `PLANS/0.5.78/BUILD-PHASE-1-CHECKLIST.md` — day-by-day build plan
- `PLANS/0.5.78/SPIKE-DAY-0-WORKER-PROCESS-MODEL.md` — worker process model
- `PLANS/0.5.78/PLAN-VODOU-BOARD-MULTI-AGENT-KANBAN.md` — full architecture plan
