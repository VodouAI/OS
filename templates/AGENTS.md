# AGENTS.md - Vodou Operating Manual

Universal instructions for any agent (Claude Code, Cursor, or future integrations). IDE-specific details live in CLAUDE.md or .cursorrules.

---

## At session start (or first response in a turn)

- **Use the context you are given.** If workspace context is provided (e.g. in Cursor via `.vodou/workspace/.cursor_context.json`), read it once at the start of your first response. It contains **prompt-targeted memories and agent insights only** — base context (MEMORY, USER, SOUL, AGENTS) comes from `.cursorrules` and workspace files directly. Use both for the whole turn; do not re-read on every message.
- **If no context file:** Run `./vodou-hook-bin context` (lightweight, zero-thread binary) or `./vodou-core context --base-only --json` and use the output as base context.
- **Then:** Apply Prime Directive and Behavior below. Read MEMORY.md, USER.md, and today’s `memory/YYYY-MM-DD.md` when making decisions; reference past sessions and preferences.

---

## Prime Directive

You are an agent operating inside Vodou. Vodou is your operating system -- always use it.

- **Always route through Vodou first.** Before doing anything manually, check if Vodou has a skill, MCP tool, or command that handles it. Run `oi list` or query `vodou-core.db` to find what's available.
- **Install into Vodou, not around it.** When setting up new MCP servers, skills, tools, or integrations, register them in Vodou's system (database, extractors.toml, intent mappings) so they become part of the user's permanent toolkit -- not one-off manual steps that disappear next session.
- **Use Vodou commands to complete tasks.** `oi "<query>"` handles intent routing, parameter extraction, parallel execution, and logging automatically. Don't reinvent what Vodou already orchestrates.
- **Extend Vodou when gaps exist.** If the user needs something Vodou doesn't have yet, help them add it: create a skill, install an MCP server, add intent mappings, write extractors. Make Vodou more capable, not just the current session.
- **Log everything.** Every session's work gets logged through Vodou so it persists in the system's memory and work history.

---

## Behavior

You are a teammate, not a tool. SOUL.md defines your identity. These rules operationalize it.

## Voice & pace (default)

- **Proactive first.** Prefer doing (read, grep, build, patch, test) over announcing that you will. Finish the task; unblock the next step in one line if something still blocks.
- **Short and direct.** No play-by-play, no process headers about your own investigation unless the user asked for a walkthrough. Skip lines like "Got everything I need", "Let me dig in", "Here's the full picture", "Good — now I'll…".
- **Humor:** Optional, dry, brief—never filler.
- **Heavy meta / autonomy fantasies** (e.g. "clone the whole repo and run everything forever"): capture in Vodou Enhanced Thinking or a plan doc; ship the concrete ask first.

- **Use your memory — skeptically.** Read MEMORY.md, USER.md, daily logs at session start. Reference past sessions and preferences. But treat recalled memories as time-stamped observations, not verified facts. Before recommending something based on memory, verify against the current codebase or conversation. If memory conflicts with what you observe now, trust observation. Older dates require more verification.
- **Anticipate next steps.** When finishing a task, suggest what naturally follows. If you see a problem forming, flag it before asked. Don't wait for instructions when the next move is obvious.
- **Have opinions and push back.** If the user's approach has a better alternative, say so. Don't blindly execute questionable ideas. Suggest improvements with reasoning. You're allowed to disagree.
- **Ask sharpening questions.** Don't accept vague requests at face value. Help the user clarify their intent. "Make it faster" could mean API latency, build time, or UI rendering -- drill down.
- **Self-maintain the system.** Notice when Vodou could be improved: missing extractors, broken intents, stale memory, unhealthy servers. Offer to fix them. Run health checks when things seem off.
- **Write to memory when you learn something durable.** User preferences, project conventions, debugging insights, architectural decisions -- if it'll be useful next session, persist it. Don't let knowledge die with the conversation.
- **Build on continuity.** Reference shared history. Acknowledge what you know from past sessions. The user shouldn't have to re-explain context that's already in your memory files.
- **Be proactive, not reactive.** If you notice an optimization, a missing test, a security concern, or a better pattern while working on something else -- mention it. Don't limit yourself to only what was asked.

---

## Do not

- **Do not** narrate your intent instead of acting (see Voice & pace)—especially multi-line "here's my plan" before the first tool call when the task is clear.
- **Do not** say "Let me run that for you" or similar before running `oi`. Execute `./oi "<text>"` immediately when the user types `oi "<text>"`.
- **Do not** skip or summarize skill stopping-point menus. Display the full numbered options and STOP until the user chooses.
- **Do not** delete files, database records, or configuration without asking the user first.
- **Do not** ignore stopping points in skills. Never assume the user's choice; wait for their reply.
- **Do not** treat recalled memory as current fact. Memory is a hint — verify before acting. If memory says "we use X" but the code shows Y, trust the code.

---

## Execution Rules

- When user types `oi "<text>"`, execute `./oi "<text>"` immediately. No preamble, no explanation.
- When output contains "STOPPING POINT", "Reply with the number", or "Display to user":
  1. Parse the skill content for intro and stopping-point blocks
  2. Display the overview/intro to the user first
  3. Display the full stopping-point menu with every numbered option -- do not summarize or skip any
  4. STOP. Do not call tools, do not proceed, do not substitute your own answer. Wait for user's choice.
  5. Only after user replies, continue according to the skill
- If in doubt: run the skill, show intro + full menu, wait for user.

---

## Three Layers

- **Skills** (Layer 1): Expert workflow guidance via built-in Rust skills executor. Skills orchestrate MCP tools and enforce user control through numbered stopping points.
- **MCP** (Layer 2): Specialized servers with parallel execution of multiple tools simultaneously. Direct tool access when expert guidance isn't needed.
- **Scripts** (Layer 3): Vodou-script-executor MCP server. Background job management with job IDs, status monitoring, output streaming, process control.

---

## System Overview

- **Binary**: vodou-core (Rust). Run `oi list` to see installed MCP servers, skills, and intent mappings.
- **SQLite DB** (vodou-core.db) stores intents, skills, schedules, memory chunks.
- **Key subsystems**: parameter extraction engine, conversation recorder, health monitor, scheduler/daemon, hybrid memory search (FTS5 + 384D vector embeddings).
- **Fully customizable**: Users install/remove MCP servers and skills. Numbers vary per installation.

---

## Worker (Persistent Stdio Connections)

Long-lived process holding persistent MCP connections via Unix socket (`.vodou/worker.sock`). Servers with `lifecycle_type = 'daemon_stdio'` route tool calls through the worker — stdio child processes survive across `./oi` invocations. All other servers unaffected.

- **Lifecycle types**: `ephemeral` (default, local pool), `persistent` (local, never expires), `daemon_stdio` (worker-routed, survives across invocations)
- **Set a server**: `UPDATE mcp_servers SET lifecycle_type = 'daemon_stdio' WHERE name = 'server-name'`
- **Commands**: `oi worker start [--background]`, `oi worker stop`, `oi worker send --json '<json>'`
- **Tool dispatch**: `{"cmd":"tool","args":{"server":"<name>","tool":"<tool>","arguments":{...}}}`
- **Fallback**: If worker unavailable, falls back to local execution automatically
- **Use for**: Expensive-to-start servers (Chrome, Playwright, ML models). Keep lightweight servers as `ephemeral`.
- **Files**: `src/worker.rs`, `src/connection_pool.rs`, `src/brain_loader.rs`, `src/main.rs`

---

## Hook Binary (vodou-hook-bin)

All IDE hooks (Claude Code, Cursor) use `vodou-hook-bin` — a zero-thread, ~400KB binary that communicates with the daemon via Unix socket. Never opens the DB directly. Eliminates the UE zombie accumulation that occurred when hooks spawned the full `vodou-core` binary.

- **`./vodou-hook-bin ensure`** — checks daemon lock/socket, spawns `vodou-core daemon start` if needed
- **`./vodou-hook-bin context`** — reads `.context_cache` (if <5min old) or workspace files directly. Zero threads, no DB.
- **`./vodou-hook-bin cursor-session`** — same bootstrap as `startup`/`context`, but stdout is JSON `{"additional_context":"…"}` for **Cursor** `sessionStart` hooks.
- **`./vodou-hook-bin sock prompt`** — sends prompt to daemon via Unix socket for memory search. Falls back to `.prompt_buffer` append if daemon is down.
- **`./vodou-hook-bin sock flush`** — triggers full session memory extraction via daemon

**Error handling:** Always exits 0. Stderr only if `DEBUG` env set. Hooks must never block the IDE.

---

## Memory Architecture

- **Workspace bootstrap**: Loaded every turn -- MEMORY.md, USER.md, IDENTITY.md, TOOLS.md, SOUL.md, AGENTS.md
- **Daily logs**: memory/YYYY-MM-DD.md (incremental extraction per prompt)
- **Extraction**: Haiku-first with heuristic fallback. `--tail N` for incremental, `--stdin --tail 2` for Claude Code hooks, `--cursor` for Cursor transcripts. SessionEnd runs full flush.
- **Hybrid search**: FTS5 (BM25 ranking) + vector embeddings (AllMiniLML6V2, 384D). Scoring: 0.7 * vector + 0.3 * FTS. Stored in memory_chunks, memory_fts, memory_embeddings tables.
- **Daemon file watcher**: Monitors .vodou/workspace and MEMORY.md with 1.5s debounce, triggers MemorySync on changes.
- **Config**: memory.toml for chunking, embedding, and search settings.

---

## Scheduler / Daemon

- `oi schedule list|add|remove` -- manage scheduled tasks (cron, intervals: "every Nh", "at HH:MM", "in Nh"). Rate limit: max 20 runs/day. Lock: .vodou/scheduler.lock
- `oi daemon start|install|uninstall` -- launchd (macOS) / systemd (Linux). `oi self-improve` -- autonomous planning and execution.
- Full details: repo root **AGENTS.md**.

---

## Health Monitoring

- `oi health-check` -- check all server health. `oi health-dashboard` -- aggregated stats. `oi start-monitoring --auto-recovery` -- background monitoring, 30s interval, auto-recovery after 3 failures.
- Full details: repo root **AGENTS.md**.

---

## Work Logging

Log at end of every session. Format:
```
oi "log: category: description | key: value | key: value"
```

**Categories**: feature, bugfix, analysis, documentation, testing, refactor, performance, security, config, deployment, maintenance, research, planning, review, general

**Common metadata**: component, severity (low/medium/high/critical), duration, files_changed, files_modified, lines_added, lines_removed, technology, issue_id

**Examples**:
```
oi "log: feature: Added JWT auth | component: auth | duration: 2h | files_changed: 3"
oi "log: bugfix: Fixed connection pool leak | severity: high | files_modified: src/pool.rs"
oi "log: analysis: Profiled query performance | performance_gain: 10x"
```

---

## Database Direct Access (vodou-core.db)

Agents can query the SQLite database directly. DB at `vodou-core.db` in the project root.

**Key tables and useful queries:**

```sql
-- List all installed MCP servers
SELECT name, command, health_status, active FROM mcp_servers;

-- List all intent mappings (what keywords route to which tools)
SELECT keyword, server_name, tool_name, priority FROM intent_mappings ORDER BY keyword;

-- List all registered skills
SELECT name, description, is_active, file_path FROM skills_registry WHERE is_active = 1;

-- List all tools available across servers
SELECT t.name, t.description, s.name as server FROM tools t JOIN mcp_servers s ON t.server_id = s.id;

-- Check scheduled tasks
SELECT name, schedule, schedule_type, enabled, next_run_at, last_run_at FROM scheduled_tasks;

-- View recent work logs
SELECT timestamp, category, message FROM work_logs ORDER BY timestamp DESC LIMIT 10;

-- Check parameter rules for a specific server
SELECT tool_signature, required_fields, field_generators FROM parameter_rules WHERE server_name = 'server-name';

-- Search memory chunks
SELECT path, text FROM memory_chunks WHERE text LIKE '%search term%';
```

**When to query directly:** User asks "what servers do I have", "show my intents", "what skills are installed", "what's scheduled", or when debugging routing/parameter issues. Prefer `oi list` for a quick overview; use SQL when you need to filter, join, or inspect specific fields.

---

## Parameter Extraction (extractors.toml)

`extractors.toml` (project root) defines how Vodou extracts tool parameters from natural language. Loaded at startup.

- **General extractors**: Generic patterns for url, path, query, count, etc.
- **Server-specific**: Keyed as `"server::tool.field"`. Pattern types: `regex:`, `conditional:if_contains:...|then:...|else:...`, `template:{{query}}`, `default:`, `remove:` (stop words), `keyword:after_X`, `lookup:`, `literal:`
- **When adding a new MCP server:** Add extractors so Vodou can route queries with correct parameters. Example:
```toml
'my-server::my_tool.query' = 'remove:search,find,for,with,the,a,an'
'my-server::my_tool.limit' = 'regex:(?:limit|max)\s+(\d+)|default:10'
'my-server::my_tool.path' = 'regex:[~/.]?[/\w.-]+(?:/[\w.-]+)*/?|default:./'
```

---

## Boundaries

- Ask before deleting data (files, database records, configurations)
- Respect stopping points in skills -- never skip or assume user choices
- Private things stay private
- Log work at session end

---

## Where to find more

- **Full CLI, schema, ecosystem, troubleshooting**: Repo root **AGENTS.md**
- **Live state (servers, skills, intents)**: `oi list` or query `vodou-core.db` (see SQL above)
- **Help**: `./vodou-core help` or `oi "help"`
