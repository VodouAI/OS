# Vodou Automations

Event-driven flows that chain MCP tool calls across connected apps. **If IFTTT and Zapier had a self-hosted cousin that spoke MCP, this would be it** — "if this happens, then do that," except the *this* and the *that* are tools on your own connected servers. IFTTT-simple to think about (trigger → action), Zapier-capable in practice (multi-step action chains with data passed between steps). Polling-based, with `{{trigger.X}}` template substitution so each new event flows through an ordered action chain.

> **Naming note:** the feature is called **Automations**, not "IFTTT." IFTTT/Zapier are other companies' products — we use them only as a familiar analogy. Don't relabel the UI or docs with their trademarks.

## When to use this vs. scheduler

| Need | Use |
|---|---|
| Run a tool every hour / at 9am Monday | [scheduler `mcp_tool`](./vodou-scheduler.md#scheduling-an-mcp-tool-call-mcp_tool-payload-type) |
| Run a tool and react only when its output **changes** | **automations** (this doc) |
| One trigger → chained actions (each action can reference prior outputs) | **automations** |

Both paths ultimately shell out to `vodou-core call <server> <tool>`; the difference is whether the cadence is time-based (scheduler) or event-delta-based (automations).

## Architecture

```
   ┌──────────────────────────────────────────┐
   │ Trigger: polls an MCP tool on a schedule │
   │  e.g. linear.search_issues { closed }    │
   └──────────────┬───────────────────────────┘
                  │ full result returned
                  ▼
   ┌──────────────────────────────────────────┐
   │ Event extraction                         │
   │  - Use trigger.event_id_path if set      │
   │  - Else probe items/results/issues/data/ │
   │    rows/records for an array + id field  │
   │  - Fallback: hash the whole result       │
   └──────────────┬───────────────────────────┘
                  │ events = [(id, event_json), ...]
                  ▼
   ┌──────────────────────────────────────────┐
   │ Diff against state.last_seen_ids         │
   │  - First run: seed state, no actions     │
   │  - Subsequent: fire actions per NEW id   │
   └──────────────┬───────────────────────────┘
                  │ for each new event:
                  ▼
   ┌──────────────────────────────────────────┐
   │ Action chain (sequential)                │
   │  Action 1: template-subst args against   │
   │            { trigger: event_json }       │
   │  Action 2: args can reference            │
   │            {{trigger.X}} AND {{action1.Y}} │
   │  ...                                     │
   └──────────────┬───────────────────────────┘
                  │
                  ▼
   ┌──────────────────────────────────────────┐
   │ Notify webhook (optional)                │
   │  POST {automation, events_matched, text} │
   └──────────────┬───────────────────────────┘
                  ▼
   ┌──────────────────────────────────────────┐
   │ Persist automation_runs row +            │
   │ advance last_seen_ids (capped at 500) +  │
   │ set next_run_at = now + interval_minutes │
   └──────────────────────────────────────────┘
```

Tick cadence is the same 60s as the scheduler; each automation's own `interval_minutes` gates whether it's due.

## Where it lives

| File | Purpose |
|---|---|
| `src/automations.rs` | Engine: tick, extract, diff, substitute, dispatch, notify |
| `src/worker.rs` | Spawns the automations tick task alongside the scheduler tick |
| `MCP-servers/Vodou-Console/src/api/automations.ts` | REST CRUD API |
| `MCP-servers/Vodou-Console/public/js/views/automations.js` | UI (Activity → Automations tab) |
| `vodou-core.db` (`automations` + `automation_runs`) | Persisted definitions + run history |

## The Automations tab

**Where:** Sidebar → **Activity** → **Automations** (`#/activity?tab=automations`).

This is the console for your "if this, then that" flows. The page is a single list of every automation you've defined, plus the button to make a new one.

**What each row shows:**

| Column | Meaning |
|---|---|
| **Name** | The automation's unique name (also its dedup key) |
| **Trigger** | The integration + tool being polled, e.g. `linear · search_issues` |
| **Actions** | The action chain summary — how many steps and where they fire (e.g. `notion · notion-search → slack`) |
| **Enabled** | Toggle switch; off = paused, keeps its `last_seen_ids` state |

**Per-row controls** (an automation is an "if this → then that" rule you manage in place):

| Control | What it does |
|---|---|
| **Enable toggle** | Turn the automation on/off without deleting it (`PATCH /api/automations/:id`) |
| **Run now** | Fire on the next tick (≤60s) instead of waiting for the interval — advances `next_run_at` to now |
| **Reset state** | Clear `last_seen_ids` so the next run is treated as a "first run" (re-seeds, fires no actions) |
| **Expand row** | Open the run-history drill-down — recent `automation_runs` with per-event, per-step results |
| **Delete** | Remove the automation and cascade its run history |

**Empty state:** with nothing defined yet, the tab shows a short primer and the **+ New automation** button — that's your entry point.

**How this differs from the neighboring tabs** (all under Activity):

| Tab | Fires on | Runs |
|---|---|---|
| **Automations** (this one) | a **new event** in a polled tool | a deterministic MCP action chain — the IFTTT/Zapier lane |
| **Scheduled** | the **clock** (cron / interval / one-shot) | any payload: skill prompt, script, query, webhook… |
| **History** | — | a read-only log of what already ran |

If you're thinking "when X happens, do Y," you want this tab. If you're thinking "every day at 9am, do Y," you want **Scheduled**.

## Creating an automation in the UI

1. Sidebar → **Activity** → **Automations** tab
2. Click **+ New automation**
3. Fill in:
   - **Name** (unique, used as dedup key)
   - **Description** (optional)
   - **Interval** in minutes (default 15)
   - **Trigger**: pick integration → pick tool → fill in the input form (auto-rendered from tool's `input_schema`)
   - **Event ID path** (optional advanced): dotted path to the id field inside each event, e.g. `issues.id` or `data.items.id`. Leave blank to auto-detect.
   - **Actions**: click **+ Add action** for each step. Each action is another integration → tool → args form. In string args you can reference prior output:
     - `{{trigger.title}}` — the current event's `title` field
     - `{{trigger.issue.id}}` — nested field access
     - `{{action1.pages.0.id}}` — first page id from Action 1's result
   - **Notify webhook URL** (optional): Slack/Discord/Zapier incoming webhook
   - **Notify text template** (optional): the webhook payload's `text` field; supports `{{trigger.X}}` substitution (resolves against the first new event)
4. Click **Create automation** → it appears in the list with toggle / run-now / delete controls

## Concrete example

**Goal:** when a Linear issue closes, search Notion for a page with that title and post a Slack message.

- **Name:** `linear-close-notify`
- **Interval:** 15
- **Trigger:**
  - Integration: `linear`
  - Tool: `search_issues`
  - Args: `{"filter": {"state": {"name": {"eq": "Done"}}}}`
  - Event ID path: `issues.id` (or leave blank to auto-detect)
- **Action 1:**
  - Integration: `notion`
  - Tool: `notion-search`
  - Args: `{"query": "{{trigger.title}}"}`
- **Notify URL:** `https://hooks.slack.com/services/YOUR/WEBHOOK/URL`
- **Notify template:** `:ballot_box_with_check: Linear closed: *{{trigger.title}}* ({{trigger.identifier}})`

**First run:** seeds `last_seen_ids` with whatever closed issues already exist — no actions fire, no Slack message. This is intentional so you don't get blasted with a month of history.

**Subsequent runs:** only brand-new closed issues trigger the action + notify.

## API

All endpoints are under `/api/automations`.

| Method + Path | Purpose |
|---|---|
| `GET /api/automations` | List all — returns `{count, automations: [...]}` |
| `GET /api/automations/:id` | Detail + last 50 `automation_runs` rows |
| `POST /api/automations` | Create — body `{name, trigger, actions?, notify?, interval_minutes?, enabled?, description?}` |
| `PATCH /api/automations/:id` | Partial update — any of the above fields |
| `DELETE /api/automations/:id` | Delete — cascades run history |
| `POST /api/automations/:id/run` | Manual trigger — advances `next_run_at` to now so the next tick (≤60s) fires it |

**Create via curl:**

```bash
curl -sX POST http://localhost:8765/api/automations \
  -H "Content-Type: application/json" \
  -d '{
    "name": "linear-close-notify",
    "interval_minutes": 15,
    "trigger": {
      "integration": "linear",
      "tool": "search_issues",
      "args": { "filter": { "state": { "name": { "eq": "Done" } } } },
      "event_id_path": "issues.id"
    },
    "actions": [
      {
        "integration": "notion",
        "tool": "notion-search",
        "args": { "query": "{{trigger.title}}" }
      }
    ],
    "notify": {
      "url": "https://hooks.slack.com/services/…",
      "template": "Linear closed: {{trigger.title}}"
    }
  }'
```

## Template substitution reference

Tokens are `{{path.to.field}}` — double braces, dotted path, resolves against the run's context.

| Source | When available | Example |
|---|---|---|
| `{{trigger}}` | Always | Full event JSON as a string |
| `{{trigger.X}}` | Always | Top-level field on the current event |
| `{{trigger.X.Y}}` | Always | Nested field |
| `{{action1}}` | During Action 2+ | Full Action 1 output as JSON |
| `{{action1.X}}` | During Action 2+ | Field on Action 1 result |
| `{{action1.items.0.id}}` | During Action 2+ | Array index access |

**Missing paths resolve to empty string.** No conditionals, no loops — if you need branching, either (a) create multiple automations with more specific triggers, or (b) invoke an Vodou skill as an action (richer logic, still called via MCP).

## State management

Per-automation state is stored in `automations.state_json`:

```json
{
  "last_seen_ids": ["evt_abc", "evt_def", ...]
}
```

**Capped at 500 most recent ids** to bound the table. If your trigger returns more than 500 events at once, older ones may re-fire after being evicted — use a tighter filter in the trigger args or shorten the interval.

**Reset seen events:** use the **Reset state** row action in the UI (or `PATCH /api/automations/:id` with `{state: {last_seen_ids: []}}`) to force the next run to be a "first run" again and re-seed without firing actions.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `VODOU_WORKER_AUTOMATIONS` | `1` | Master enable for the automations tick. Set to `0` to pause all automations without disabling each. |
| `VODOU_WORKER_SCHEDULER_INTERVAL_SECS` | `60` | Shared tick cadence. The scheduler and automations both run on this interval; each automation's `interval_minutes` gates whether it's due. |

## Run history

Every run writes a row to `automation_runs`:

| Column | Meaning |
|---|---|
| `started_at` / `finished_at` | ISO timestamps |
| `trigger_result` | First 4000 chars of trigger stdout |
| `actions_result` | JSON array: `[{event, steps: [{step, integration, tool, ok, result_chars|error}]}]` |
| `events_matched` | How many new events this run saw |
| `success` | 1 if all actions succeeded; 0 if any failed (or trigger bad) |
| `error` | Short error string on failure |

Drill-down view in the UI: click an automation row → recent runs list with expandable rows.

## Troubleshooting

**Automation never fires:**
- Confirm `enabled = 1` (toggle in the UI).
- Confirm the worker is running: `ps | grep "vodou-core worker"` should show one process with `.vodou/worker.sock` bound (`lsof -U -p <pid>`).
- Check `next_run_at` — if it's in the future, wait or click **Run now**.

**First run showed events but no Slack message arrived:**
- Expected. First run seeds `last_seen_ids` without firing actions. Wait for the second run, or reset state to re-seed.

**Trigger returns data but `events_matched = 0`:**
- Your trigger's output shape might not match the auto-detection heuristics. Set `event_id_path` explicitly (e.g. `data.items.id` for Notion), or if the whole result IS the single event you care about, leave blank — the engine will hash the full result as one event id.

**Action fails with a template error:**
- `{{trigger.X}}` where X doesn't exist renders as empty string — not an error. If the resulting tool call rejects empty args, that's a downstream failure. Use the run history to see the substituted args.

**Provider rate-limits your trigger:**
- Increase `interval_minutes`.
- Future enhancement (Phase 3.4+): per-provider rate-limit awareness — not in today's build.

## Related docs

- [vodou-scheduler.md](./vodou-scheduler.md) — time-triggered tasks, including `mcp_tool`
- [mcp-host.md](./mcp-host.md) — how MCP servers (apps) are connected
- [cli-reference.md](./cli-reference.md) — `vodou-core call` command used under the hood
