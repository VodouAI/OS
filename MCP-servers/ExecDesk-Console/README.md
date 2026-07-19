# ExecDesk-Console — Standalone build

Standalone copy of `Vodou-Console` for the ExecDesk SMB product surface. Runs on its own port (default **8767**) so it doesn't conflict with the main Vodou-Console on 8765. Auto-enables `body.execdesk-mode` — no `?execdesk=1` flag needed.

**Two consoles can run side-by-side:**
- `MCP-servers/Vodou-Console/` — main developer-grade Vodou stays at port 8765 with full power-user UI
- `MCP-servers/ExecDesk-Console/` — SMB-positioned ExecDesk surface at port 8767

## Run

```bash
# Default port 8767
cd MCP-servers/ExecDesk-Console
npm run build           # compile TS
WEB_PORT=8767 node dist/index.js

# Or override port
WEB_PORT=9000 node dist/index.js
```

Then open `http://localhost:8767/` — lands on `/#/execdesk` with execdesk-mode active.

## What's different from the main Vodou-Console

| Setting | Vodou-Console | ExecDesk-Console |
|---|---|---|
| Default port | 8765 | 8767 |
| Default route | `/#/chat` | `/#/execdesk` |
| Body class | none (or `execdesk-mode` via `?execdesk=1`) | `execdesk-mode` always |
| Sidebar entries | All Vodou views | ExecDesk + Approvals shown by default; non-execdesk views hidden until `?pro=1` |
| Skill registry | Shows all skills | Filters to execdesk-* by default |

## What's currently shared (intentional for dev — split before production)

> ⚠️ **Tonight's state is a chrome/UX fork, not a data fork.** Both consoles share all backing storage. Production deployment requires a data split — see [Data isolation gap](#data-isolation-gap-phase-2-day-10-11) below.

| Layer | Location | Status |
|---|---|---|
| `memory.db` (vodou-core scope-tagged memory_chunks) | project root | ✅ shared |
| `gateway.db` (settings, conversations, MCP creds) | project root | ✅ shared |
| `skills_registry.db` | `skills/` | ✅ shared |
| `vodou-core.db` (scheduler, intents, daemon state) | project root | ✅ shared |
| `.vodou/workspace/` (transcript, prompt buffer) | project root | ✅ shared |
| `.vodou/execdesk/team-consult-audit.jsonl` | project root | ✅ shared |
| `node_modules/` | symlinked to `Vodou-Console/node_modules/` | ✅ shared |
| Skills filesystem | `<project-root>/skills/catalog/` | ✅ shared |
| MCP servers | `vodou-core list` | ✅ shared |

## Data isolation gap (Phase 2 day 10–11)

Why it matters in production:

1. **Multi-tenant SaaS** — when ExecDesk has paying customers, each tenant needs isolated memory. Shared `memory.db` with scope-tagging is half-isolation, not real isolation.
2. **ExecDesk customers shouldn't see Vodou power-user context** — a D2C founder running ExecDesk doesn't need memory chunks about Vodou's daemon socket internals.
3. **Different settings per product** — ExecDesk customers may use Anthropic API direct + their own key (per `EXECDESK-PRICING-BENCHMARK.md`); main Vodou stays on claude-cli OAuth. Different providers + creds means different `gateway.db`.
4. **Clean reset** — wipe ExecDesk's memory to retest onboarding without touching personal Vodou memory.
5. **Independent scheduler** — ExecDesk crons shouldn't pollute main Vodou's scheduler.

**The right path (~3–5 hrs):**

1. Add `--workspace-root <path>` CLI arg to `vodou-core` so memory.db / vodou-core.db / .prompt_buffer paths are workspace-relative.
2. ExecDesk-Console boots with `cwd: MCP-servers/ExecDesk-Console/.execdesk/` and invokes vodou-core with that workspace root.
3. ExecDesk-Console's `gateway.db` lives at `ExecDesk-Console/.execdesk/gateway.db` (per-instance).
4. Skills filesystem stays shared (intentional — `category: execdesk` filter already hides them in Vodou view; skill catalog updates benefit both products).

Until that lands, **both consoles share all backing data**. This is fine for solo dev. NOT fine for paying customers.

## Scheduler isolation — Phase 2 deliverable (not yet shipped)

The vodou-core scheduler DB is shared. ExecDesk crons registered via `vodou-core schedule add` would still appear in the main Vodou scheduler list and run via the same daemon.

**Current state (2026-05-04):** ExecDesk crons were removed from the shared scheduler. They are not yet running anywhere.

**Phase 2 fix paths:**
1. **Node-side cron in ExecDesk-Console process** (~1 hr) — small in-process scheduler reads `.execdesk/schedules.json`, fires each minute on cron match, calls local `/api/exec/team-consult`. Crons live entirely inside ExecDesk-Console; never touch shared vodou-core DB.
2. **`scope`/`namespace` field on vodou-core schedule entries** (~3 hrs) — modify Rust scheduler to support filtering by tag. Each console only sees and runs its own scope.

Path (1) is faster and gives true isolation. Recommended.

## Building / deploying as a separate domain

The plan (PLAN-SMB-EXEC-CONSOLE.md §0.10.6) is to deploy this artifact at `execdesk.vodou.ai` while the main Vodou stays at `app.vodou.ai`. Same source tree, two build targets, two domains, two artifacts.

For local dev, just run both side-by-side as documented above.

## Sync from main console

When you ship a fix in `Vodou-Console/src` or `Vodou-Console/public`, port it to `ExecDesk-Console/src` and `ExecDesk-Console/public` as well. The two trees are not auto-synced. Aim for shared `src/` modules where possible (Phase 2 candidate: factor out the shared subset into a sibling package).
