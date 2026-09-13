# Vodou Automations

Event-driven flows that chain MCP tool calls across connected apps. **If IFTTT and Zapier had a self-hosted cousin that spoke MCP, this would be it** — "if this happens, then do that," except the *this* and the *that* are tools on your own connected servers. IFTTT-simple to think about (trigger → action), Zapier-capable in practice (multi-step action chains with data passed between steps). Polling-based, with `{{trigger.X}}` template substitution so each new event flows through an ordered action chain.

> **Naming note:** the feature is called **Automations**, not "IFTTT." IFTTT/Zapier are other companies' products — we use them only as a familiar analogy. Don't relabel the UI or docs with their trademarks.

## When to use this vs. scheduler

| Need | Use |
|---|---|
| Run a tool every hour / at 9am Monday | [scheduler `mcp_tool`](./vodou-scheduler.md#scheduling-an-mcp-tool-call-mcp_tool-payload-type) |
| Run a tool and react only when its output **changes** | **automations** (this doc) |
| One trigger → chained actions (each action can reference prior outputs) | **automations** |

**The trigger is always a polled MCP tool call** (SW-12). `trigger` must name an
`integration`, a `tool` and its `args`; Vodou calls it on the interval, diffs the
event ids against what it saw last time, and runs the actions for anything new.
There is **no webhook receiver, no file watcher, and no time-only trigger** — if
you want something to run at 9am rather than when an event appears, that is a
**scheduled task**, not an automation. The IFTTT/Zapier comparison above is about
the shape of the thinking, not about how the trigger arrives.

Both paths ultimately shell out to `vodou-core call <server> <tool>`; the difference is whether the cadence is time-based (scheduler) or event-delta-based (automations).

## Vodou's own feeds (Vodou-Recall `feed_*`)

Any MCP tool can be a trigger, but four tools on the `Vodou-Recall` server exist *for* triggers. They answer "what is new since X" over Vodou's own tables and return the shape the engine reads natively:

```jsonc
{ "feed": "captures", "count": 2, "cursor": "2026-09-09 23:16:26|ide:claude-code:1669…",
  "items": [ { "id": "…", "at": "YYYY-MM-DD HH:MM:SS", /* feed-specific fields */ } ] }
```

| Tool | New … | Filters | Item fields |
|---|---|---|---|
| `feed_captures` | captured conversations (ChatGPT, Claude, Claude Code, channels) | `source_glob` (default `capture:*`) | `title, source, source_url, message_count` |
| `feed_memories` | durable memory chunks | `tag`, `scope_glob`, `min_importance`, `pinned_only` | `tag, scope, text, importance, pinned, source_url` |
| `feed_contradictions` | open contradictions (two values for one slot) | `slot_glob` | `slot, import_value, native_value, import_scope, native_scope, cosine, status` |
| `feed_json_file` | items in a JSON file a script maintains (a ledger, a results file); path relative to the project root and locked inside it | `path` (required), `items_path` (dotted, e.g. `leads`), `id_field` (default `id`), `at_field` (default `at`), `where` (equality filters, e.g. `{"status":"new"}`) | the item's own fields |
| `feed_extraction_failures` | extraction-queue spans that failed — **about Vodou, not the user**; route it to an operator channel, not a briefing | — | `source, conversation_id, span_start, span_end, state, attempts, last_error` |

All four take `since_cursor` and `limit` (default 25, max 100). **You never pass the cursor yourself.** When a trigger returns one, the engine stores it in `state.cursor` and sends it back as `since_cursor` on the next run, so a feed-triggered automation never depends on the 500-id `last_seen_ids` cap described below. Without a cursor a feed returns the newest items (the first run seeds from them and fires nothing); with one it returns the oldest items after it, so a backlog drains in order. **Reset state** clears the cursor too.

Try one by hand:

```bash
./vodou-core call Vodou-Recall feed_memories '{"tag":"DECISION","scope_glob":"capture:web:*","min_importance":7,"limit":3}'
```

Cost: each feed is one range query on the owner's file, opened read-only. `feed_memories` with no filter orders 58k chunks by `created_at` (no index on that column yet — ~0.3 s measured 2026-09-09); a `tag` or `scope_glob` filter brings it to milliseconds.

**Examples that only Vodou can run:**

- *When I decide something in ChatGPT or Claude.ai, file it.* Trigger `Vodou-Recall.feed_memories {tag:"DECISION", scope_glob:"capture:web:*", min_importance:7}` → action `linear.save_issue {title:"Decision: {{trigger.text}}"}`.
- *When a new web capture lands, summarise it to my console.* Trigger `Vodou-Recall.feed_captures {source_glob:"capture:web:*"}`, no actions, **post to chat** on.
- *When a client contradiction opens, tell me.* Trigger `Vodou-Recall.feed_contradictions {slot_glob:"client.*"}` → notify webhook or post to chat.

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
| `src/api_http/routes/automations.rs` | REST CRUD API — the **one writer** (vodou-core HTTP API, port 8766, OpenAPI source) |
| `MCP-servers/Vodou-Console/src/api/automations.ts` | The console's `/api/automations` — validates the body and forwards to the Rust routes via `core-client.ts`; owns no SQL |
| `MCP-servers/Vodou-Recall/src/feeds.ts` | The four `feed_*` trigger tools |
| `MCP-servers/Vodou-Console/public/js/views/automations.js` | UI (Activity → Automations tab) |
| `vodou-core.db` (`automations` + `automation_runs`) | Persisted definitions + run history |

## Where automations live in the console

**Where:** Sidebar → **Activity** → **Scheduled** (`#/activity?tab=scheduled`). Since 2026-09-10 there is no separate Automations tab: scheduled tasks and event-driven automations share one table, and the **Event-driven** chip (`&filter=event`) narrows it. An automation row reads *when linear · list_issues has new items* in the Schedule column, an **event** badge in Type, and *every 15m → skill growth-signal* in Payload. **+ New task** asks *On a schedule* or *When new items appear in…* and opens the matching form. A row's **Runs** opens the run-history detail (the old automations table, at `#/activity?tab=automations&focus=<id>`), which also carries Reset state, Pin to chat and the expandable per-event action results.

An automation that posts to chat and is pinned appears in the sidebar's Vodou group with its last run at the right edge — *2 new · 14 m*, *0 new · 3 h*, *paused*, *off* — the way a scheduled skill console shows its next run.

The detail table below is what **Runs** opens.

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
| **Run now** | Fire on the next tick (≤60s) instead of waiting for the interval — advances `next_run_at` to now. Typing `/run` in the automation's console does exactly this and nothing else: the engine is the only executor, so a Slack post or an issue is created once, not once by the engine and once by the chat model |
| **Reset state** | Clear `last_seen_ids` so the next run is treated as a "first run" (re-seeds, fires no actions) |
| **Expand row** | Open the run-history drill-down — recent `automation_runs` with per-event, per-step results |
| **Delete** | Remove the automation and cascade its run history |

**Empty state:** with nothing defined yet, the tab shows a short primer and the **+ New automation** button — that's your entry point.

**How this differs from the neighboring tabs** (all under Activity):

| Tab | Fires on | Runs |
|---|---|---|
| **Automations** (this one) | a **new event** in a polled tool | a deterministic MCP action chain — the IFTTT/Zapier lane |
| **Scheduled** | the **clock** (cron / interval / one-shot) | one of four payloads: `query` (a brain query), `skill_run` (a Skill Console skill), `mcp_tool` (one tool call), `gateway_chat` (the heartbeat) |
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

## A skill as an action

An action can be a tool call or a skill:

```jsonc
{ "kind": "skill", "skill": "growth-signal", "prompt_template": "New signal: {{trigger.title}} — {{trigger.url}}" }
```

The rendered template is handed to the skill as context. The gateway resolves which kind of skill it is (`skill-kind.ts`):

| Kind | Where it runs | Where the output lands |
|---|---|---|
| **Console skill** (Skill Console, `skills_meta`) | its own bound console — one console per skill | that console, exactly as a scheduled fire |
| **File skill** with `actions.json` (`skills_registry`) | headless in the automation's console | the automation's console |

A draft file skill is refused (*promote it first*); a file skill without `actions.json` is refused; a console skill with no console yet is refused. When a skill action ran, the automation's own summary post stands down — the skill's output is the console content.

**Cap.** `max_events_per_run` (default 5) bounds how many events a run acts on; the rest are **deferred** to the next run — kept out of `last_seen_ids`, with a feed's cursor held at the last processed item — never dropped. The run row says `N event(s) deferred`.

**Worked example — the growth pair.** `growth-signal-hunt` (a script at 11:00) and `skill:growth-signal` (a skill at 11:30, whether or not the hunt found anything) become: the hunt stays on its clock, and `growth-signal-watch` — trigger `Vodou-Recall.feed_json_file {path:".vodou/growth/leads.json", items_path:"leads", at_field:"found_at", where:{status:"new"}}` every 60 min, action `kind:"skill", skill:"growth-signal"` — runs the skill **only for new leads**, in the Growth console. The trigger is the ledger the hunt writes, not the hunt's tool call: `execute_script` runs the hunt as a background job and returns a job handle, which is why the file is the feed. (The hunt also prints its new leads as a JSON line last; the engine reads a script's last line when the whole output is not JSON.)

## Proposed automations (the skill proposer writes them)

The nightly skill proposer mines your repeated tool chains and drafts skills from them. When such a chain **starts with a list-shaped call** (`messages_list`, `list-events`, `web_search_exa`, any `feed_*`…), it is a trigger followed by actions — so the proposer also writes an **automation**, disabled: the list call as the trigger, the remaining steps as tool actions (or, for a lone list call, *summarize to the console*). Template variables the engine cannot resolve (`{{TODAY_START}}`) are dropped from the args. The row shows **Proposed · from N of your chats**; the toggle is the Enable. Nothing runs until you flip it.

Drafts written before this existed are covered by a one-off:

```bash
./vodou-core skill propose --from-drafts            # offer them (disabled)
./vodou-core skill propose --from-drafts --dry-run  # just list what would be offered
```

## What posts to chat, and when

`post_to_chat` (the *Post to pinned chat tab* toggle in the create modal) binds an automation to the console `workbench:automation:<id>`. **A run that finds nothing posts nothing** — `last_run_at` records the tick and the row shows it. A run with new events posts one summary turn whose prompt carries every new event (up to 5, each cut at 800 chars), so a run that matched five things is summarised as five things. The workflow-offer front door (a sentence becoming a plan card) is switched off inside an automation console — the engine asked for prose, and nobody is there to press **run**. Before 2026-09-09 the engine also posted a "✓ Ran — no new events" system bubble on every idle tick; one console had 357 of those against 6 real summaries, which is why that branch is gone.

## Paused automations (the circuit breaker)

After `VODOU_AUTOMATION_BREAKER_LIMIT` consecutive failed runs (default 10) the engine sets `enabled = 0` and stamps `auto_disabled_at`. The row shows **⏸ Paused after N failed runs — <last error>** with a **Resume** control and a link to re-authorize the trigger's integration; an automation that posts to chat also gets one system bubble saying the same. Resume re-enables and clears the counters. `last_error` names the reason — since 2026-09-09 a failed `vodou-core call` is reported from its own output (`exit 1: Error: Server not found: linear`), not as a bare `exit 1:`. Re-enable from the toggle or `PATCH {enabled:true}`; fix the cause first (an expired token is the usual one — re-authorize the integration under Integrations).

## API

All endpoints are under `/api/automations`.

| Method + Path | Purpose |
|---|---|
| `GET /api/automations` | List all — returns `{count, automations: [...]}`; each row carries `consecutive_failures`, `auto_disabled_at`, `max_events_per_run` |
| `GET /api/automations/:id` | Detail + last 50 `automation_runs` rows |
| `POST /api/automations` | Create — body `{name, trigger, actions?, notify?, interval_minutes?, enabled?, description?}` |
| `PATCH /api/automations/:id` | Partial update — any of the above fields plus `max_events_per_run`; `{enabled:true}` also clears the breaker (Resume) |
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

Feed-triggered automations also carry `"cursor": "<opaque>"`, handed back to the feed as `since_cursor`; for those the id list is a belt over the cursor's braces and the cap below does not cause refires.

**Capped at 500 most recent ids** to bound the table. If your trigger returns more than 500 events at once, older ones may re-fire after being evicted — use a tighter filter in the trigger args or shorten the interval.

**Reset seen events:** use the **Reset state** row action in the UI (or `PATCH /api/automations/:id` with `{state: {last_seen_ids: []}}`) to force the next run to be a "first run" again and re-seed without firing actions.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `VODOU_WORKER_AUTOMATIONS` | `1` | Master enable for the automations tick. Set to `0` to pause all automations without disabling each. |
| `VODOU_AUTOMATION_BREAKER_LIMIT` | `10` | Consecutive failed runs before an automation pauses itself (see *Paused automations*). |
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
