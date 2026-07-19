# Kanban Board

**Multi-agent durable Kanban with memory-injected workers, workflow templates, per-task budgets, approval gates, and channel-native notifications.**

Built against the v0.5.78 → v0.5.82 release lane. Phase 1 + 5 of 7 Phase-2 differentiator cuts are live. See [`board-tutorial.md`](board-tutorial.md) for a 4-story walkthrough; this doc is the reference.

---

## At a glance

| Surface | Where | Use case |
|---|---|---|
| **CLI** | `./do board <verb>` (22 verbs) | scripts, terminal, cron |
| **REST** | `http://127.0.0.1:8765/api/board/*` (15+ endpoints) | external integrations, n8n, GitHub Actions |
| **MCP** | 14 tools, env-gated on `VODOU_BOARD_TASK` | LLM workers spawned by the dispatcher |
| **Dashboard** | `http://localhost:8765/#/board` | drag-drop UI, drawer, live event polling (3s), **🧭 Plan drawer** (goal → ordered plan, project-scoped) |

All four surfaces hit the same `board.db` (standalone, Option B architecture).

---

## What ships today (v0.5.82 + post-tag commits)

### Phase 1 — foundation (sessions 1–9, tagged v0.5.82)

- **Schema** — `board.db` with tasks, runs, links, comments, events, subscriptions, FTS5 search index
- **Kernel** — Rust state machine with atomic CAS claims (`BEGIN IMMEDIATE` + single UPDATE), DFS cycle detection on links, stale-claim TTL reclaim
- **Dispatcher** — Embedded 30s tick inside the gateway. Per tick: reclaim stale → detect crashed PIDs (zombie-aware) → enforce `max_runtime` (SIGTERM → 5s → SIGKILL on process group) → promote `todo→ready` when parents `done` → **enforce the concurrency ceiling** (claim at most `max_concurrent − tasks_running`, default 3) → atomic claim → spawn worker → circuit-break after N spawn failures → health telemetry
- **Real worker spawn** — `VODOU_BOARD_REAL_SPAWN=1` shells `claude -p` per task with full `worker_context` env (workspace resolution, `pid_alive_strict` zombie detection, graceful terminate)
- **CLI** — 22 verbs (see Reference below)
- **REST** — 15 endpoints (CRUD, list, dispatch, search, events SSE-style polling, notify-subscribe, runs)
- **MCP server** — `MCP-servers/Vodou-Board/` with 14 tools that workers call back (`board_show`, `board_complete`, `board_link`, etc.)
- **Dashboard** — `#/board` SPA with drawer, drag-drop, polling every 3s on `/api/board/events?since=<last_id>`
- **Channel notifier** — Embedded 5s tick. Routes per-platform: `channel:slack:*` → standalone slack MCP; `channel:<other>:*` → `Vodou-channels::send_message`; `inapp:principal:*` → `gateway_in_app_inbox`; `webhook:<url>` → POST. Auto-prune subs after 3 consecutive failures.
- **Day-8 JWT auth** — HS256 with shared key in `vodou-core.db`; toggled via `VODOU_BOARD_REQUIRE_JWT=1` (default-off). 5/5 smoke tests cross-validate Rust signer → Node verifier.
- **`board_ask` semantic Q&A** — 10 tests, 8 intent classifiers; natural-language queries over board state.

### Phase 2 — differentiator cuts (sessions 11–18, post-RC1 commit chain → v0.5.83)

| § | Cut | Status | Headline |
|---|---|:---:|---|
| 3.1 | **Memory-injected workers** | ✅ | `worker_context.memory[]` pre-loaded via hybrid FTS + embedding + reranker against `memory.db`. Top-K relevant chunks land in the worker's prompt before it runs. **The Hermes-beating headline.** |
| 3.2 | **Native MCP tool ecosystem** | ✅ | Audit found this was aspirational; fixed in session 18. Per-task `.mcp.json` auto-generated with absolute paths; 8 of 11 curated Vodou MCP servers ✓ Connected when claude spawns. |
| 3.3 | **Channel-native notifications** | ✅ | 8 platforms via `Vodou-channels` + Slack-via-standalone-MCP. Phase 1 baseline + Phase 2 rich-cards. |
| 3.4 | **Approval gates** | ✅ | `requires_approval_on` JSON gate; `running→done` enforced via `suspended→approved/denied` state machine with full audit trail. Slack Block Kit + Discord components with Approve/Deny buttons. Receiver at `/api/board/channel-action` — Slack HMAC + Discord Ed25519 (`DISCORD_PUBLIC_KEY`) both verified; unset = accept-all (dev mode). |
| 3.5 | **Workflow templates** | ✅ | `board_templates` table (migration 002); auto-advance `current_step_key` on stage complete; CLI verbs `board templates {list, show, create, archive}`. |
| 3.6 | **Per-task budgets** | ✅ | Soft + hard caps on USD, tokens, runtime_secs. Dispatcher terminates with `RunOutcome::BudgetExceeded`. Worker self-reports via `board run-spend`. REST `/budget` GET+POST + budget-at-birth flags on `board create`. |
| 3.7 | **Multi-host federation** | ⏭️ | Deferred to Phase 4. |

**Tests:** 84 board:: + 13 continuity::recall:: + 32 vitest = **129 passing**.

---

## Planner (🧭) — goal → ordered plan → your codebase

The **🧭 Plan** button (board header) opens a drawer that turns a plain-language
goal into an ordered set of board tasks. Flow: describe a goal → the planner
enumerates your connected capabilities, optionally researches the web, inspects
a target codebase, and deep-thinks → it drafts an ordered plan you can **refine**
(type a follow-up) and **Commit** into the `plan` column as a dependency-chained
task sequence. Backed by `POST /api/board/plan/draft` (SSE), `GET
/api/board/plan/:sessionId/status`, `POST /api/board/plan/commit`; orchestrator
in `src/plan-orchestrator.ts`.

### Project-scoped planning — "Plan against:"

The drawer's **Plan against:** selector decides what codebase (if any) the
planner reads:

- **General — sandboxed (no files)** — the default. The planner reasons from the
  goal + your capabilities only; its LLM subprocess runs in a temp dir with **no
  file access**.
- **A registered project** (from `/api/projects`) — the planner runs **inside
  that project's root** and reads the real code before planning, so tasks
  reference actual files/modules/gaps, not guesses.
- **Custom folder…** — point the planner at **any directory on the machine**
  (type, paste, or drag-drop a folder — a Finder drag carries the path via
  `file://`). Not limited to registered projects. Validated as an existing dir;
  a bad path silently falls back to sandboxed.

How it reads a codebase without derailing into prose: planning is **two-phase**.
Phase A (`exploreProject`) runs `claude -p` with file tools **in** the project
and writes a findings brief; Phase B (`synthesize`) turns that brief into the
JSON plan **without** file tools — a tool-less completion reliably emits the
multi-task JSON, where a single agentic run would narrate and collapse to one
task. The JSON parser is drift-tolerant (finds the task array at any nesting,
maps `title|name|step` + `body|why|description`), so a valid plan is never
salvaged down to one task.

### Project-scoped execution — tasks run where they were planned

When a plan was scoped to a codebase, **Commit** stamps every created task with
`workspace = "dir:<projectRoot>"` (the tasks.workspace `dir:/…` form). The
dispatcher's `resolve_workspace` then spawns that task's worker **in that
codebase** (in-place), so the worker edits the real project — not a scratch dir
under the Vodou root. Without this, a plan generated against project X produced
tasks whose workers ran in Vodou and couldn't find what they were told to build.

> **In-place edits, no isolation.** `dir:` workers edit the target repo directly.
> Commit the target project first so `git diff` / `git restore` are your undo.
> A git-worktree isolation mode is a planned follow-on.

### Reliability

- **Survives navigation.** A running plan is decoupled from the request and runs
  server-side; leaving the board no longer kills it. Returning re-attaches and
  replays the log + draft (mirrors the chat-tab pattern). **＋ New plan** resets
  the drawer to start a fresh plan instead of refining the last one.
- **Timeouts (config).** Large plans + codebase reads need minutes. The inner
  `claude -p` wall is `VODOU_RAWLLM_TIMEOUT_MS` (default **300000**, was a
  hardcoded 90s); the overall plan budget is `VODOU_PLAN_TIMEOUT_MS` (default
  **600000**, ceiling **1800000** / 30 min).

---

## What's left

1. **v0.5.83 tag cut** — `Cargo.toml` bumped to `0.5.83`. Remaining: release build (`./.build/scripts/build-release.sh`), `codesign --force --deep --sign - vodou-core`, then `git tag v0.5.83`.

2. **Phase 3 UX (deferred but not blocked)**
   - Multi-board tenant switcher in dashboard (schema is multi-board-ready via `board_id`; UI is Phase 3)
   - `board stats` cycle-time + cost rollup verb
   - WebSocket upgrade (replace 3s polling on `/api/board/events`)
   - `board_specify_all` scheduled-task payload type (today: manual one-shot via `./do board specify --all`)

4. **§3.7 Multi-host federation** — Phase 4 scope.

---

## CLI reference

```
board migrate                    Apply pending board.db migrations
board create <title>             Create task (--parent, --status, --triage,
                                   --assignee, --priority, --workspace,
                                   --max-runtime, --skill, --model,
                                   --budget-usd, --budget-tokens,
                                   --budget-runtime, --template <id>)
board list                       List tasks (--status, --assignee, --tenant,
                                   --archived, --limit, --json)
board show <id>                  Full meta + body + runs + comments + events
                                   + parents/children
board assign <id> <assignee>     Set or clear assignee
board link <parent> <child>      Add dependency
board unlink <parent> <child>    Remove dependency
board comment <id> <text>        Append (--reply-to)
board complete <id>              Close as done (--summary, --metadata)
board block <id> <reason>        Block
board unblock <id>               Restore to ready
board archive <id>               Soft-delete
board heartbeat <id>             Bump last_heartbeat_at
board runs <id>                  List run history
board dispatch                   Run one dispatcher tick (--dry-run, --max, --json)
board assignees                  List active subagents with in-flight counts
board search <query>             FTS5 search across title + body
board notify-subscribe <id> <target>
board notify-list <id>
board notify-unsubscribe <id> <target>
board notifier                   Run one notifier tick
board context <id>               Print memory chunks that WILL be injected (§3.1)
board templates {list|show|create|archive}   Workflow templates (§3.5)
board pending                    Tasks waiting on approval (§3.4)
board approve <id> | deny <id> <reason>      Resolve a suspended task (§3.4)
board budget <id>                Get/set caps (§3.6)
board budget report <id>         Caps + spend rollup (§3.6)
board run-spend <run_id>         Worker self-report token/USD/runtime (§3.6)
board ask "<question>"           Semantic Q&A over board state (Day 11)
```

Every read verb supports `--json`.

---

## REST surface (selected)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/board/tasks` | create |
| GET  | `/api/board?status=&assignee=&tenant=` | list |
| GET  | `/api/board/tasks/:id` | show |
| POST | `/api/board/tasks/:id/complete` | close (now shells through Rust state machine) |
| POST | `/api/board/tasks/:id/approve` | §3.4 |
| POST | `/api/board/tasks/:id/deny` | §3.4 |
| GET  | `/api/board/pending` | §3.4 list |
| GET  | `/api/board/tasks/:id/budget` | §3.6 |
| POST | `/api/board/tasks/:id/budget` | §3.6 set caps |
| POST | `/api/board/runs/:run/spend` | §3.6 worker self-report |
| POST | `/api/board/channel-action` | §3.4 Slack/Discord button receiver |
| GET  | `/api/board/events?since=<id>` | dashboard polling |
| POST | `/api/board/plan/draft` | Planner — SSE draft; body `{prompt, planSessionId?, project_id?, project_dir?}` |
| GET  | `/api/board/plan/:sessionId/status` | Planner — re-attach: buffered log + draft + status |
| POST | `/api/board/plan/commit` | Planner — materialize the draft into `plan`-column tasks (stamps `workspace=dir:` when project-scoped) |

JWT auth on writes when `VODOU_BOARD_REQUIRE_JWT=1`.

---

## Memory injection (§3.1) — the differentiator

```bash
./vodou-core board context <task_id>
```

Prints the exact memory chunks the dispatcher will pre-load into `worker_context.memory[]` before `claude -p` spawns. Uses the same hybrid FTS + embedding + BGE reranker pipeline that powers `/api/v2/memory/recall`. Top-K relevant chunks land in the worker's prompt — Hermes Kanban makes workers fetch this themselves.

Every `task_runs` row with `outcome='completed' AND length(summary) > 80` is also an extraction source for the upcoming Vodou Skill Forge.

---

## Health checks

```bash
./scripts/smoke-board.sh                            # 8-stage end-to-end (~2s)
VODOU_BOARD_REAL_SPAWN=1 ./scripts/smoke-board.sh   # adds real claude spawn
cargo test --lib board::                            # 84 Rust unit tests
cd MCP-servers/Vodou-Board && npm test              # 32 vitest tests
cargo run --release --example probe_mcp_config     # §3.2 inspect generated .mcp.json
```

If anything fails, check `.vodou/system.log` and `PLANS/0.5.78/BUILD-PHASE-1-CHECKLIST.md` §6 gotcha list.

---

## End-to-end automation — yes, just like Hermes

The system **does** auto-execute tasks the way `nousresearch/hermes-agent` does (their v0.13.0 "Tenacity Release"). The full loop, verified 2026-05-14 with `VODOU_BOARD_REAL_SPAWN=1 ./scripts/smoke-board.sh` (8/8 stages green):

1. **Gateway boots** → `setInterval` every 30s shells `vodou-core board dispatch --max 5 --json` (`MCP-servers/Vodou-Console/src/index.ts:3244-3281`).
2. **Dispatcher tick** (`src/board/dispatcher.rs`): reclaim stale → detect crashed PIDs → enforce `max_runtime` (SIGTERM → 5s → SIGKILL on process group) → promote `todo→ready` when parents `done` → atomic CAS claim → spawn worker → circuit-break after N spawn failures.
3. **Worker spawn** (`src/board/spawn.rs:214`): fresh `claude -p --model <X> --append-system-prompt <board_guidance> --mcp-config <per-task .mcp.json> <bootstrap_prompt>`. Detached process group, stdout/stderr to `.vodou/board/logs/<task_id>.log`. Env: `VODOU_BOARD_TASK`, `VODOU_BOARD_WORKSPACE`, `VODOU_BOARD_DB`, `VODOU_PROFILE`, `VODOU_TENANT`, `VODOU_GATEWAY_URL`, `VODOU_BOARD_WRITE_TOKEN`.
4. **Worker thinks** with the curated tool surface (`board_show`, `board_complete`, `board_comment`, `board_link`, exec, channels, enhanced-thinking, context7, gmail, slack, youtube — 8 of 11 ✓ Connected on a fresh checkout).
5. **Worker closes itself** via `board_complete` MCP tool → POSTs `/api/board/tasks/:id/complete` → shells through to the Rust state machine → emits `task_completed` event, advances workflow template stage, writes `task_handoff` memory chunk for future related tasks.
6. **Notifier tick** (5s) picks up the terminal event, fires per-platform notifications.
7. **Next dispatcher tick** promotes any children blocked on this task to `ready` → loop repeats until the whole graph is `done`.

### Vs Hermes Kanban (v0.13.0, `nousresearch/hermes-agent`)

Same architectural shape; ours has a couple of structural edges.

| Dimension | Hermes (`kanban_db.py:3666` `dispatch_once`) | Kanban Board |
|---|---|---|
| Dispatcher loop | Embedded in gateway, asyncio task, **60s** | Embedded in gateway, setInterval, **30s** |
| Atomic claim | `claim_task` CAS | CAS claim (`BEGIN IMMEDIATE` + single UPDATE) |
| Worker spawn | `hermes -p <profile> --skills kanban-worker chat -q "work kanban task <id>"` | `claude -p --model … --append-system-prompt … --mcp-config <per-task>` |
| Tool/MCP config | Profile-level `config.yaml` (shared across all that profile's workers) | **Per-task `.mcp.json`** (workers can have different tool surfaces) |
| Context loading | **Lazy** — worker calls `hermes kanban context <id>` mid-run | **Eager** — top-K hybrid memory chunks pre-injected in `worker_context.memory[]` |
| Crash detection | PID liveness + protocol-violation (rc=0 but still `running` → immediate auto-block) | PID liveness + `consecutive_failures` counter |
| Approval gates | (recently added) | Slack Block Kit + Discord Ed25519 buttons → `/api/board/channel-action` |
| Workflow templates | Skills-based | `board_templates` table + auto-advance `current_step_key` |
| Per-task budgets | Cost log per call | Hard + soft caps on USD / tokens / runtime; dispatcher terminates on `BudgetExceeded` |
| Semantic Q&A | No | `board ask "<question>"` |

**Borrowed from Hermes (shipped 2026-05-14):** protocol-violation gate. When the dispatcher detects a dead PID, it tails the worker's `.vodou/board/logs/<task_id>.log` for claude's terminal `{"type":"result"}` stream-json line. Found = the worker exited cleanly without calling `board_complete` → immediate auto-block + `protocol_violation` event (no retry counter — burning the budget on a worker that explicitly chose to end its turn is pointless). Not found = real crash, falls through to the existing `consecutive_failures` counter path. Implementation: `src/board/dispatcher.rs::log_indicates_clean_exit`. Sharpens our crash semantics to match `kanban_db.py:3292`.

## Spawn governance (#7)

Two controls bound what the dispatcher spawns and what each worker may touch:

- **Concurrency ceiling** — each tick counts live workers (`tasks_running`) and claims at most `max_concurrent − running` tasks, making "≤ `max_concurrent` live workers" a structural invariant (not just a per-tick `--max`). Default **3** (matches Hermes `max_concurrent`); override with **`VODOU_BOARD_MAX_CONCURRENT`**. This is the backstop against the runaway-spawn / orphan-process incident: a slow tick can never stack workers past the ceiling. (`src/board/dispatcher.rs::max_concurrent_from_env`.)
- **Per-task tool allowlist (persona)** — a task's skill persona can scope the worker's tool surface. The dispatcher resolves the task's skill(s) (`skills_registry` → SKILL.md → `allowed_tools`/`disallowed_tools` frontmatter), **UNION-composes** them with the board-worker baseline, and passes the result to `claude -p` as `--allowed-tools`/`--disallowed-tools`. OFF by default. **Footgun:** an allow-list must include the kernel callbacks (`board_complete`, `board_comment`, `board_link`, …) or the worker can't close itself. See [skills.md](skills.md) and [managed-chat-tools.md](managed-chat-tools.md) for the frontmatter.

## Architecture notes

- **DB separation:** Board lives in standalone `board.db`. Auth key + JWT shared secret live in `vodou-core.db`. Memory chunks come from `memory.db`. No migration runner on `gateway.db`.
- **Embedded loops:** Dispatcher (30s) and notifier (5s) run inside the `Vodou-Console` tokio runtime — same process as the gateway.
- **Worker spawn:** Fresh `claude -p` CLI per task (decided in `SPIKE-DAY-0-WORKER-PROCESS-MODEL.md`). Argv + env mirror the gateway pattern at `MCP-servers/Vodou-Console/src/llm.ts`. Worker is told its task via `VODOU_BOARD_TASK` env; `.mcp.json` is generated per-task with absolute paths.
- **Codesign note:** After every `vodou-core` binary swap, run `codesign --force --deep --sign - vodou-core` — macOS Gatekeeper otherwise hangs the first exec.

---

## Design pack

The deep-design plans live in [`PLANS/0.5.78/`](../PLANS/0.5.78/):

- `PLAN-VODOU-BOARD-MULTI-AGENT-KANBAN.md` — main plan, data model, dispatcher, phased rollout
- `PLAN-STANDALONE-MCP-ARCHITECTURE.md` — why standalone `board.db` (Option B)
- `PLAN-DASHBOARD-FRONTEND.md` — frontend spec (Cmd+K, five view modes, Agent Activity sidebar, drop-anything Triage)
- `AUDIT-AND-UX-ADDENDUM-2026-05-12.md` — deep-review record + 7 correctness fixes + 5 UX wins
- `BUILD-PHASE-1-CHECKLIST.md` — day-by-day executor doc with code skeletons
- `SPIKE-DAY-0-WORKER-PROCESS-MODEL.md` — worker-spawn integration spike
- `NEXT-PHASE-2-KICKOFF.md` — rolling log of Phase 2 cuts + remaining items
- `RESEARCH-HERMES-KANBAN.md` — Hermes parity receipts + the 20 audit bugs we sidestep

For a 4-story walkthrough see [`board-tutorial.md`](board-tutorial.md).
