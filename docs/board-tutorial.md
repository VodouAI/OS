# Kanban Board — Tutorial

A 4-story walkthrough of the multi-agent task board. Each story is self-contained; run them in order on a fresh install or jump to whichever matches your use case.

**Pre-req:** Phase 1 board shipped (`./vodou-core board --help` lists 22 verbs). Run `./do board migrate --init` once if `board.db` doesn't exist yet.

---

## Story 1 — The solo dev: capture an idea, watch it ship

You have a one-line idea: "research ICP funding 2024-2026 NA angle." Three commands to go from idea → finished research brief.

### 1.1 Drop it into Triage

```bash
./do board create "research ICP funding 2024-2026 NA" --triage
```

The `--triage` flag puts it in the Triage column (raw 1-liner stage). The librarian skill — `board-triage-specifier` — picks it up via the scheduled-task pattern and fleshes it out with `goal`, `approach`, `acceptance criteria` from your memory + USER.md context.

### 1.2 Assign + watch

```bash
./do board specify --all                  # runs the librarian on every triage card
./do board assign t_<id> researcher       # pick the assignee
./do board list --status ready            # see what's queued
```

Within 30 seconds the embedded dispatcher (running inside the gateway) claims the task and spawns a `claude -p` worker with the worker_context pre-loaded — memory chunks, parent handoffs, role history, the BOARD_GUIDANCE block.

### 1.3 Complete + auto-write to memory

When the worker calls `board_complete(summary, metadata)`, the dispatcher writes a `task_handoff` memory chunk so future similar tasks auto-load this run's summary. Compounding institutional knowledge — Hermes can't do this.

```bash
./do board show t_<id>
# Run History section shows the worker's full summary + token cost + duration
```

---

## Story 2 — The orchestrator: decompose a project into 8 parallel children

You have a 1-paragraph plan. You want it sliced into 8 child tasks across 4 subagents.

### 2.1 Paste the plan into Triage, run the orchestrator

```bash
./do board create "Ship v0.5.78 launch announcement" --triage --body "$(cat plan.md)"
./do board orchestrate <id>      # board-orchestrator skill runs board_assignees() first
```

The orchestrator skill follows its anti-temptation rules (decompose, don't execute). Step 0 calls `board_assignees()` so it only assigns to subagents that actually exist. Then `board_create(...)` + `board_link(parent, child)` for each leaf node. Cycles refused at the DB layer (DFS check in `add_link`).

### 2.2 Watch the dependency graph resolve

```bash
./do board show <parent_id>      # shows the spec + the 8 children chips
./do board dispatch              # one tick: ready→running for parentless children
```

The dispatcher's per-tick logic (`src/board/dispatcher.rs`):
1. Reclaims stale claims (TTL expired)
2. Detects crashed PIDs (zombie-aware via /proc on Linux, kill(0) on macOS)
3. Enforces max_runtime (SIGTERM → 5s → SIGKILL on process group)
4. Promotes `todo → ready` when all parents are `done`
5. Atomic CAS claim (BEGIN IMMEDIATE + single UPDATE)
6. Spawns worker with build_worker_context → claude CLI
7. Circuit-breaks after N consecutive `spawn_failed`
8. Health telemetry

---

## Story 3 — The fleet operator: 8 boards, one screen

You run 8 customer tenants. Each gets its own board (`atm10-server`, `acme-corp`, etc.). You want one dashboard.

(Phase 3 multi-board ships this UX. Phase 1 has the `tenant_id` field on every task and the schema is multi-board-ready via `board_id` — but the per-tenant board switcher in the dashboard is Phase 3 work.)

For Phase 1 you can already filter by tenant:

```bash
./do board list --tenant acme --json
curl -s http://127.0.0.1:8765/api/board?tenant=acme | jq
```

---

## Story 4 — The night owl: agents work while you sleep

You go to bed at 11pm with 4 tasks in Triage. You want them specified, assigned, executed, and reported on by 7am.

### 4.1 Set up the cron

Phase 1 ships the scheduled-task pattern via the existing `scheduled_tasks` table:

```bash
sqlite3 vodou-core.db "
  INSERT INTO scheduled_tasks (name, schedule, schedule_type, payload_type, payload)
  VALUES ('nightly-triage-sweep', '*/10 * * * *', 'cron', 'board_specify_all',
          json_object('board', 'default'));
"
```

(This integrates with the existing `src/scheduler.rs::run_due_tasks` loop. The Day-11 `board_specify_all` payload type lands in a future session; today, you can run `./do board specify --all` manually as a one-shot.)

### 4.2 Subscribe a channel for terminal events

```bash
./do board notify-subscribe t_<id> channel:telegram:<chat_id>
./do board notify-subscribe t_<id> webhook:https://my-monitoring-endpoint.example.com
./do board notify-subscribe t_<id> inapp:principal:<your-principal-id>
```

The embedded notifier (running every 5s inside the gateway) polls `task_events`, formats per-platform messages, and dispatches:
- `channel:slack:*` → standalone `slack` MCP server
- `channel:<other>:*` → `Vodou-channels::send_message`
- `inapp:principal:*` → row in `gateway_in_app_inbox` (dashboard bell-icon)
- `webhook:<url>` → POST event payload to URL

Failure counter per sub; auto-prune after 3 consecutive failures.

### 4.3 Wake up to a finished board

```bash
./do board list --status done                       # what shipped overnight
./do board stats --since 12h                        # cycle time + cost (Phase 3)
sqlite3 board.db "SELECT body FROM gateway_in_app_inbox ORDER BY id DESC LIMIT 5"
```

---

## Story 5 — The builder: plan against a real codebase, workers build there

You have a project (a Vodou-registered project, or any folder). You want Vodou
to read the actual code, plan the next steps, and have workers implement them
**in that repo**.

### 5.1 Plan against the codebase

1. Open the board → click **🧭 Plan**.
2. In **Plan against:**, pick your project (or **Custom folder…** and drop/paste
   any path — e.g. `/Users/you/Desktop/myapp`).
3. Type the goal: *"What are the next things to build or wire up here? Give an
   ordered plan of concrete tasks, each naming real files/modules."*
4. Click **Plan ↵**.

The log shows `reading project: <name>` → `inspecting <name> codebase…` →
`composing the plan`. The planner actually reads the repo (README, manifest,
`src/`, PLAN docs) — so you get tasks like *"Wire identify() into the canonical
id path (identity/musicbrainz.ts)"*, not generic advice. Takes a couple minutes;
you can navigate away and come back — the run keeps going and re-attaches.

> Refine by typing a follow-up; start a different plan with **＋ New plan**.

### 5.2 Commit + dispatch one task

1. **Commit** the draft → the tasks land in the **Plan** column, each stamped
   `workspace = dir:<yourRepo>`.
2. **Commit the target repo first** (`git add -A && git commit`) — workers edit
   in place; this is your undo baseline.
3. Drag ONE card into **Ready**, then click **Dispatch tick** (or
   `./vodou-core board dispatch`). The worker spawns **inside your repo**.

### 5.3 Watch it build, then keep or revert

```bash
cd /path/to/your/repo
git status --short && git diff --stat     # files the worker changed, live
npm test                                   # verify (a good worker leaves it green)
git restore .                              # …or throw the changes away
```

The task card's summary is a real handoff ("Changed: src/… ; 133 tests pass;
build clean"). Verified end-to-end: an MTVai plan → committed → dispatched → a
worker wired `identify()` across 4 files, all 133 tests green, `tsc` clean.

---

## Reference

| Verb | Purpose |
|---|---|
| `migrate` | Apply pending board.db migrations |
| `create` | Create a task (with `--parent`/`--status`/`--triage`/`--assignee`/`--priority`/`--workspace`/`--max-runtime`/`--skill`/`--model`) |
| `list` | List tasks with filters (`--status`, `--assignee`, `--tenant`, `--archived`, `--limit`, `--json`) |
| `show` | Show one task in full (meta + body + runs + comments + events + parents/children) |
| `assign` | Set or clear assignee |
| `link` / `unlink` | Manage parent → child dependencies |
| `comment` | Append a comment (with optional `--reply-to`) |
| `complete` | Close task as `done` (with `--summary` + `--metadata`) |
| `block` / `unblock` | Block (with reason) or restore to ready |
| `archive` | Soft-delete (status → archived) |
| `heartbeat` | Bump `last_heartbeat_at` |
| `runs` | List run history |
| `dispatch` | Run one dispatcher tick (`--dry-run`, `--max`, `--json`) |
| `assignees` | List active subagents with in-flight counts |
| `search` | FTS5 search across title + body |
| `notify-subscribe` / `notify-list` / `notify-unsubscribe` | Manage channel subs |
| `notifier` | Run one notifier tick |

Every read verb supports `--json`. `migrate`, `create`, `complete`, `runs`, `dispatch`, `assignees`, `search`, `notify-list`, `notifier` all return clean machine-readable JSON for scripting.

---

## Three surfaces, one kernel

The board is reachable from three places — all hitting the same `board.db`:

| Surface | Endpoint | Use case |
|---|---|---|
| **CLI** | `./do board <verb>` | scripts, terminal users, cron |
| **REST** | `POST /api/board/tasks`, `GET /api/board`, etc. (15 endpoints) | external integrations (n8n, Zapier, GitHub Actions) |
| **MCP** | `board_show` / `board_complete` / etc. (14 tools, env-gated on `VODOU_BOARD_TASK`) | LLM workers (claude CLI invoked by the dispatcher) |
| **Dashboard** | `http://localhost:8765/#/board` | drag-drop UI, drawer, live event polling |

The dashboard polls `/api/board/events?since=<last_id>` every 3 seconds and refreshes on state-change events. WebSocket upgrade is Phase 2.

---

## Differentiators over Hermes Kanban

Phase 1 shipped parity. 5 of 7 Phase-2 cuts are live (see [kanban-board.md](kanban-board.md) for the full status table):

| Hermes | Kanban Board | Status |
|---|---|:---:|
| Worker fetches user context manually | **Memory-injected `worker_context.memory[]`** (dispatcher pre-runs hybrid FTS + embedding + rerank against `memory.db`) | ✅ §3.1 |
| Workers see no tools | **Per-task `.mcp.json`** — 8 of 11 curated Vodou MCP servers ✓ Connected when `claude` spawns | ✅ §3.2 |
| Text-only channel notifications | **Interactive Slack Block Kit + Discord buttons** routed through `/api/board/channel-action` | ✅ §3.4 |
| No workflow templates | **`board_templates`** with auto-advance on stage complete | ✅ §3.5 |
| Cost per call only | **Per-task budget caps** — USD/tokens/runtime, soft + hard, dispatcher terminates on `BudgetExceeded` | ✅ §3.6 |
| Approval gates "out of scope" | **First-class governance** — `requires_approval_on` gates, `suspended→approved/denied` state machine, full audit trail | ✅ §3.4 |
| No semantic Q&A | **`board ask`** — natural-language Q&A over board state (8 intent classifiers) | ✅ Day 11 |
| Single-host | **Multi-host federation** | ⏭️ Phase 4 |
| Worker logs (tail 100KB) | **AI Replay panel** — replay the worker's full thought chain inline | ⏭️ Phase 3 UX |

---

## Health checks

```bash
./scripts/smoke-board.sh                            # 8-stage end-to-end smoke (~2s)
VODOU_BOARD_REAL_SPAWN=1 ./scripts/smoke-board.sh   # adds real claude spawn verification
cargo test --lib board::                            # 48 Rust unit tests
cd MCP-servers/Vodou-Board && npm test              # 32 vitest tests
```

If any test fails, check `.vodou/system.log` and `BUILD-PHASE-1-CHECKLIST.md` §6 gotcha list.
