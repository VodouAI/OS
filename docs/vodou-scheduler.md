# Vodou Scheduler

The Vodou scheduler is a lightweight, single-process cron-like task runner embedded in the worker. It dispatches recurring memory maintenance, heartbeats, and consolidation tasks without spawning subprocesses for in-process work.

## Where it lives

| File | Purpose |
|---|---|
| `src/scheduler.rs` | Core dispatch loop, schedule parsing, in-process branch |
| `src/worker.rs` | Spawns the scheduler tick task; auto-registers default tasks at startup |
| `vodou-core.db` (`scheduled_tasks` table) | Persisted task list |

**Skill Consoles:** user-defined cron from **`vc_skills_create`** / **`/cron`** registers tasks with **`payload_type = skill_run`**. The worker POSTs to the gateway **`POST /chat/skill-fire`** (auth: **`VODOU_GATEWAY_SCHEDULER_SECRET`** / **`X-Scheduler-Secret`**). See **[skill-console.md](skill-console.md)**.

The scheduler ticks every `VODOU_WORKER_SCHEDULER_INTERVAL_SECS` seconds (default 60) inside the worker's tokio runtime. On each tick it queries `scheduled_tasks` for rows where `next_run_at <= now`, dispatches up to 2 tasks per tick, and updates `last_run_at` / `next_run_at`.

## Default scheduled tasks

The worker auto-registers these tasks at startup based on env-var feature flags:

| ID | Name | Schedule | Payload | Enabled by |
|---:|---|---|---|---|
| 1 | `memory-promote` | `@weekly` | `mem promote` | **RETIRED 2026-08-16** — no longer seeded; an existing row disables itself on its next due tick |
| 2 | `memory-micro-promote` | `5m` | `mem promote-micro` | **RETIRED 2026-08-16** — same |
| 3 | `memory-compact` | `1d` | `mem compact` | **RETIRED 2026-08-16** — same |
| 4 | `vodou-heartbeat` | `every 2h` | `heartbeat` | `VODOU_HEARTBEAT_ENABLED=1` |
| 5 | `memory-janitor` | `0 2 * * *` | `mem janitor` | `VODOU_JANITOR_ENABLED=1` |

The exact rows in your project can be inspected at any time:

```bash
sqlite3 vodou-core.db "SELECT id, name, schedule, payload, enabled FROM scheduled_tasks;"
```

## In-process dispatch (zero-subprocess path)

Memory maintenance tasks (`mem janitor`, and historically `mem promote` / `mem promote-micro` / `mem compact`) are dispatched **in-process** instead of spawning a subprocess. The three promote/compact payloads are now refused *before* dispatch and their row is disabled — only `mem janitor` still runs this path. In-process dispatch avoids:

- macOS UE (uninterruptible sleep) zombies that accumulate when many short-lived processes hit the same SQLite WAL
- DB contention from concurrent connection pools
- Process startup overhead (60+ subprocess spawns/day for `promote-micro`)

The dispatch logic lives in `scheduler.rs` and routes any payload starting with `mem ` to the appropriate Rust function:

```rust
if lower_payload == "mem promote" || lower_payload == "mem promote-micro"
    || lower_payload == "mem compact" || lower_payload == "mem janitor" {
    // run in-process via crate::memory_flush::* or crate::memory_janitor::run_janitor
}
```

Heartbeats (`vodou-heartbeat`) and gateway-driven tasks still spawn a subprocess because they need to talk to external services and benefit from process isolation.

## Schedule formats

The scheduler accepts three schedule formats:

| Format | Example | Use case |
|---|---|---|
| `every <duration>` | `every 2h`, `every 5m` | Simple intervals |
| Bare duration | `5m`, `1d`, `7d` | Shorthand for `every X` |
| 5-field cron | `0 2 * * *` (daily 2am) | Specific time of day/week |
| Common aliases | `@weekly`, `@daily`, `@hourly` | Cron shortcuts |

The schedule is parsed by `infer_schedule_type()` in `scheduler.rs`, which dispatches to either `every`-style interval handling or full cron parsing.

## Worker startup registration pattern

When the worker starts, it checks each feature flag and creates the corresponding scheduled task **only if** it doesn't already exist. If the task exists but the schedule in `.env` differs from the DB, the worker syncs the DB to match `.env` (single source of truth).

Example for the janitor (`worker.rs:148`):

```rust
let janitor_enabled = std::env::var("VODOU_JANITOR_ENABLED")
    .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
    .unwrap_or(false);
if janitor_enabled {
    let schedule = std::env::var("VODOU_JANITOR_SCHEDULE")
        .unwrap_or_else(|_| "0 2 * * *".to_string());
    let exists = state.db.schedule_task_exists_by_name("memory-janitor").unwrap_or(false);
    if !exists {
        crate::scheduler::add_task(&state.db, "memory-janitor", &schedule, "mem janitor", "query", false)?;
    } else {
        // Sync DB schedule from env if different
    }
}
```

This pattern means:
- **Enabling** a feature: set the env var, restart the worker → task gets registered
- **Disabling**: set env var to `0`, the existing DB row stays but the worker won't re-register (manually delete via `scheduled_tasks` if needed)
- **Changing schedule**: edit `.env`, restart worker → DB schedule auto-syncs
- **Adding a new task type**: add a new env-gated block to `worker.rs` following the pattern above

## Manual task management

```bash
# List all scheduled tasks
vodou-core schedule list

# Add a one-shot task
vodou-core schedule add --name "weekly-promote" --schedule "0 0 * * 0" --command "mem promote"

# Remove a task
vodou-core schedule remove --name "weekly-promote"

# Manually trigger a task (bypasses schedule)
vodou-core schedule run --name "memory-janitor"
```

## Rate limiting and safety

The scheduler enforces:

- **Max 2 task spawns per tick** — prevents thundering herd if multiple tasks become due simultaneously
- **Process limit** — defers tasks if `vodou-core_process_count() > 80% of max_procs`
- **Per-task timeout** — `VODOU_SCHEDULER_TASK_TIMEOUT_SECS` (default 300s), kills any task that runs longer
- **Heartbeat-specific** — `VODOU_HEARTBEAT_MAX_PER_HOUR` (default 10), `VODOU_HEARTBEAT_ACTIVE_HOURS` (e.g. `9-17`)

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `VODOU_WORKER_SCHEDULER` | `1` | Master enable for scheduler tick loop |
| `VODOU_WORKER_SCHEDULER_INTERVAL_SECS` | `60` | Tick interval in seconds (min 10) |
| `VODOU_SCHEDULER_TASK_TIMEOUT_SECS` | `300` | Per-task hard timeout |
| `VODOU_SCHEDULER_MAX_RUNS_PER_DAY` | `100` | Daily run cap (across all tasks) |
| `VODOU_SCHEDULER_USE_PLANNING` | `0` | Enable autonomous planning agent (experimental) |
| `VODOU_HEARTBEAT_ENABLED` | `0` | Auto-register `vodou-heartbeat` task |
| `VODOU_HEARTBEAT_INTERVAL` | `15m` | Heartbeat cadence |
| `VODOU_HEARTBEAT_MAX_PER_HOUR` | `10` | Heartbeat rate limit |
| `VODOU_HEARTBEAT_ACTIVE_HOURS` | `""` (always) | Hours-of-day window (e.g. `9-17`) |
| `VODOU_ENABLE_MEMORY_COMPACT_SCHEDULE` | `1` | Auto-register `memory-compact` task |
| `VODOU_MEMORY_COMPACT_SCHEDULE` | `every 1d` | Compact cadence |
| `VODOU_JANITOR_ENABLED` | `1` (in `.env.example`) | Auto-register `memory-janitor` task |
| `VODOU_JANITOR_SCHEDULE` | `0 2 * * *` | Janitor cadence (cron) — daily by default |

## Adding a new scheduled task type

Follow this pattern (same structure as `vodou-heartbeat` and `memory-janitor`):

1. **Create the work function** — either an in-process Rust function (no subprocess) or a subprocess command.
2. **Add an env-gated registration block** to `worker.rs` near the existing blocks. Mirror the structure: check enabled flag → check exists → `add_task()` → else sync schedule.
3. **Add dispatch** to `scheduler.rs:513` if it's an in-process task. Otherwise the existing subprocess path handles it.
4. **Document** the env var in `.env.example` and add the task row to the table at the top of this doc.

## Scheduling an MCP tool call (`mcp_tool` payload type)

In addition to the built-in memory maintenance payloads, the scheduler supports calling any tool on any connected integration directly as a recurring task.

**Payload shape:**

```json
{
  "server": "notion",
  "tool": "notion-search",
  "args": { "query": "weekly review" },
  "notify_on_result": "https://hooks.slack.com/services/…"
}
```

- `server` — integration id (matches the id in your preset JSON, e.g. `notion`, `linear`, `stripe`).
- `tool` — tool name as exposed by that integration.
- `args` — the JSON object the tool expects (whatever its `input_schema` defines).
- `notify_on_result` *(optional)* — any incoming webhook URL (Slack, Discord, Zapier, etc.). After the run completes the scheduler POSTs this JSON to it:
  ```json
  {
    "task_name": "notion-weekly",
    "server": "notion",
    "tool": "notion-search",
    "success": true,
    "outcome": "ok (mcp_tool notion.notion-search, 4,132 chars)",
    "result": "<first 2000 chars of stdout>",
    "text": ":white_check_mark: *notion-weekly* — `notion.notion-search` succeeded",
    "timestamp": "2026-04-18T22:30:00Z"
  }
  ```
  The `text` field is Slack/Discord-compatible. Webhook failures are non-fatal — logged but don't stop the scheduled run.

**Create via the UI:** Activity → Scheduled → **+ Add Scheduled Task** → pick **`mcp_tool`** as payload type. An Integration → Tool picker appears, followed by a form auto-rendered from the tool's `input_schema` and an optional Notify webhook URL field.

**Create via API:**

```bash
curl -sX POST http://localhost:8765/api/scheduler \
  -H "Content-Type: application/json" \
  -d '{
    "name": "notion-weekly-check",
    "schedule": "0 9 * * 1",
    "schedule_type": "cron",
    "payload_type": "mcp_tool",
    "payload": "{\"server\":\"notion\",\"tool\":\"notion-search\",\"args\":{\"query\":\"weekly review\"}}",
    "enabled": 1
  }'
```

**Execution path:** the scheduler dispatcher (`src/scheduler.rs`, the `mcp_tool` branch) shells out to `./vodou-core call <server> <tool> '<json-args>'`, captures stdout, writes the outcome to `work_log_scheduler_run`, and — if `notify_on_result` is set — POSTs the summary JSON with a 10s timeout.

For event-triggered flows (run when *something changes* in an integration) rather than time-triggered tasks, see [vodou-automations.md](./vodou-automations.md).

## Surfacing a task as a dock tab

By default, a `query` task runs `vodou-core brain "<payload>"` headlessly and **discards the output** — only the exit code is recorded. That makes a working task look dead (it ran, but you never see results).

To fix this, the **+ Add Scheduled Task** form has a **"Show as dock tab"** checkbox (default **on** for `query` tasks). When checked, `POST /api/scheduler` routes the task through **`vc_skills_create`** instead of a bare insert, so it becomes a [Skill Console](./skill-console.md):

- a tab appears in the **first dock group** (alongside Heartbeat and Board), and
- each scheduled run is a `payload_type = skill_run` task whose output **renders into that tab** (and can be redirected to a channel via `delivery_mode`).

This is the same machinery the **Automated Skills** wizard uses — the checkbox just lets a plain scheduled task opt into it. Mechanics:

- Only applies to `payload_type = query` on a `cron` schedule. Other payload types (`mcp_tool`, `health_check`, …) ignore the flag and stay headless.
- The task `name` is slugified to a skill name (`^[a-z][a-z0-9-]{2,40}$`); the payload becomes the skill's `prompt_template` (a `{{user_message}}` placeholder is appended if absent).
- If `vc_skills_create` fails (e.g. name collision, payload < 20 chars), creation **falls back** to a plain headless task so it never silently breaks.
- Uncheck the box (or send `surface: false` to the API) to get the old headless behavior.

**Turning a surfaced task off** — it's now a Skill Console, so manage it like one (see [skill-console.md](./skill-console.md)):

- **Pause the schedule, keep the tab:** toggle it off in the Scheduler view, or type `/cron off` in its tab.
- **Disable the skill:** `/disable` in the tab (`/enable` to restore).
- **Delete entirely:** delete it from the Scheduler view, or close the tab (×, which soft-deletes the conversation).

```bash
# API: create a surfaced job (default), or set "surface": false to stay headless
curl -sX POST http://localhost:8765/api/scheduler \
  -H "Content-Type: application/json" \
  -d '{
    "name": "daily-job-search",
    "schedule": "0 13 * * *",
    "schedule_type": "cron",
    "payload_type": "query",
    "payload": "Search for remote Senior Engineer roles posted in the last 24h…",
    "surface": true
  }'
```

## Related docs

- [vodou-memory.md](./vodou-memory.md) — memory pipeline + janitor details
- [vodou-automations.md](./vodou-automations.md) — event-driven automations (different from time-triggered `mcp_tool`)
- [cli-reference.md](./cli-reference.md#schedule) — `schedule` subcommand reference
- [WORKER_MODE_OUTLINE.md](../docs-DEV/WORKER_MODE_OUTLINE.md) (internal) — worker process architecture
- [database-schema.md](../docs-DEV/database-schema.md) (internal) — `scheduled_tasks` table schema
