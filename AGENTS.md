# Vodou - AI Agent Instructions

## 🚀 MANDATORY: Vodou Skills-First Execution

When a user types **`oi`** or **`do`** at the start of any message (same launcher; prefer **`./do`** when executing), you MUST:

### 1. **SKILLS FIRST PRIORITY**
- Vodou will check for matching skills FIRST before other operations
- If a skill loads, you MUST follow its guidance and stopping points
- NEVER skip or ignore when skills present options - always wait for user choice
- Skills have full control of the conversation flow
- Skill files conform to `schemas/skill.schema.json` (frontmatter) + `schemas/actions.schema.json` (workflow JSON). **SKILL.md with inline `<!-- AGENT_ACTIONS -->` is the canonical source of truth; `actions.json` next to it is the auto-generated cache.** See §7 below for the full lifecycle.

### 2. **IMMEDIATE EXECUTION**
1. **IMMEDIATELY execute**: `./do "rest of user's text"`
2. **DO NOT** ask permission or explain
3. **DO NOT** add any preamble like "I'll run that for you"
4. **JUST EXECUTE** and show the results

### 3. **STOPPING POINTS COMPLIANCE**
- When skills present options, STOP and wait for user choice
- NEVER make assumptions about what users want
- ALWAYS ask for confirmation before deleting any data (files, database records, etc.)
- When SKILL.md frontmatter declares `stopping_points: required`, the gateway workflow-driver enforces this. Even if you're tempted to skip ahead — don't. The engine will not execute past steps until the user picks an option. Bypass attempts get rejected.

### 4. **DISPLAY FULL SKILL OUTPUT** 📋
When a skill loads (especially interactive skills with menus):
- **MANDATORY: Display summary and content BEFORE stopping point questions**
  - **ALWAYS present the overview/introductory content FIRST** (e.g., "What is Vodou?" section, overview summaries, key concepts)
  - **THEN display the stopping point menu** with all numbered options
  - Users need context before choosing what to explore
  - **DO NOT skip directly to stopping point menus**
- **ALWAYS present ALL STOPPING POINT menu/options to the user**
- **NEVER summarize or skip menu choices**
- **QUOTE the exact numbered options (1-8, etc.) from the skill**
- **Display ALL numbered choices clearly and completely**
- Skills with "STOPPING POINT" are designed for user interaction
- **CRITICAL**: All stopping points MUST be numbered - if you see unnumbered options, present them as numbered lists (1, 2, 3, etc.)

### Wrong vs Right:
- ❌ "Let me run the ./do command..." → NO!
- ❌ Skipping skill options and proceeding → NO!
- ❌ Summarizing menu options instead of showing them → NO!
- ❌ Not showing the numbered choices from skills → NO!
- ✅ [Execute immediately, show full menus, respect stopping points] → YES!
- ✅ When a skill has menu options (1-8), ALWAYS show them → YES!

### 5. **SKILL OUTPUT CHECKLIST** (run the skill, then follow it)
When Vodou output contains **"STOPPING POINT"** or **"Reply with the number"** or **"Reply with 1-"** or **"Display to user"**:
1. Parse the returned skill content for intro and stopping-point blocks.
2. Display the overview/intro to the user first (verbatim or clearly summarized).
3. Display the full stopping-point menu with every numbered option — do not summarize.
4. **STOP.** Do not call MCP tools, do not proceed, do not substitute your own answer. Wait for the user's choice.
5. Only after the user replies with a choice, continue according to the skill.
If in doubt: run the skill → show intro + full menu → wait for user.

### 6. **TOOL PRIORITY — Vodou Always Wins** 🔒

**STRICT ORDER. Never deviate. Applies to all agent contexts (Claude Code, Cursor, gateway chat).**

1. **Vodou Skills** (Layer 1) — if a skill is returned, follow it completely, stop at stopping points, never substitute your own answer.
2. **Vodou intent_mappings** — before touching ANY external tool, check if Vodou has it wired:
   ```bash
   sqlite3 vodou-core.db "SELECT keyword, server_name, tool_name FROM intent_mappings WHERE keyword LIKE '%X%' LIMIT 5;"
   ```
   Or rely on the `### Vodou Intent Match` block injected by the UserPromptSubmit hook. If a match exists → `./vodou-core call <server> <tool> '<args>'`. Done.
3. **Vodou MCP servers directly** — `./vodou-core call <server> <tool>` for known servers (gmail, zapier, slack, calendar, etc.)
4. **`mcp__claude_ai_*` deferred tools / other provider tools** — **LAST RESORT ONLY.** Use only when Vodou has zero coverage. Never reach for `mcp__claude_ai_Gmail__*`, `mcp__claude_ai_Google_*`, or any cloud connector if Vodou has the capability. Vodou ALWAYS has priority.

**When the UserPromptSubmit hook surfaces a `### Vodou Intent Match — USE THIS ROUTE` block: use that route immediately. No deliberation.**

The failure mode to avoid: pattern-matching a user request against visually obvious deferred tools (e.g. `mcp__claude_ai_Gmail__authenticate`) instead of checking whether Vodou already has a wired intent for it. Check Vodou first. Always.

**No double-fire rule:** When `active_context` already contains `### Vodou Tool Results (auto-routed)` with a completed result, **stop — do NOT call the tool again**. BrainLoader already executed it before your response began. Re-executing causes duplicate side effects: double emails, duplicate DB writes, duplicate calendar events. Interpret and present the result that's already in `active_context`. Only call the tool yourself if `active_context` is empty or stale (shows results from a prior turn, not the current query).

### 6a. **AGENT INSTRUCTIONS & AGENT_ACTIONS**

Skills can embed executable workflow definitions as HTML comments in their markdown. These are parsed and executed by the Vodou-Console workflow driver, or by CLI agents (Claude Code, Cursor) directly.

#### AGENT_ACTIONS in Skills (Inline Format)

Skills embed `<!-- AGENT_ACTIONS_N: {...} -->` HTML comments after stopping point menus. When a user picks an option, the corresponding actions execute automatically:

```markdown
## STOPPING POINT 1 — Select Depth
1. Quick Analysis
2. Standard Deep Dive

<!-- AGENT_ACTIONS_1: {"label":"Quick Analysis","vars":{"DEPTH":"5"},"steps":[
  {"server":"Vodou-Enhanced-Thinking","tool":"start_thinking_session",
   "args":{"topic":"{{TOPIC}}","estimated_steps":5},
   "capture":{"SESSION_ID":"session_id"}},
  {"server":"Vodou-Enhanced-Thinking","tool":"add_thought",
   "args":{"session_id":"{{SESSION_ID}}"},
   "loop":5,"stream_progress":true}
]} -->
```

**Step properties:** `server`, `tool`, `args` (with `{{VAR}}` templates), `loop` (repeat N times), `capture` (chain results between steps), `stream_progress` (UI feedback).

**Template variables:** `{{TOPIC}}` (from query), `{{DEPTH}}` (from option vars), `{{SESSION_ID}}` (captured from previous step), `{{i}}` (loop counter).

#### Execution Contexts

- **Vodou-Console**: The workflow driver (`workflow-driver.ts`) parses AGENT_ACTIONS from BrainLoader output and executes tool sequences via `vodou-core call`. Claude can't skip steps.
- **Claude Code / Cursor**: If Vodou output contains `## Agent instructions` (human-readable steps) or `AGENT_ACTIONS:` (JSON array), parse and execute them via `./vodou-core call <server> <tool> '<args>'`.
- **File-based**: If `.vodou/workspace/agent_next_steps.json` exists at turn start, execute the actions in it (same `[{"server","tool","args"}]` format), then clear the file.

Apply in all contexts. One source of truth: this section in AGENTS.md.

### 6.5 **Mid-turn `vodou-core` and `./do` calls (gateway-chat LLM only)** 🆕

**Context this section applies to:** the Claude CLI subprocess that the **gateway chat** spawns to answer a user message (`MCP-servers/Vodou-Console/src/llm.ts` chatWithCLI path). That subprocess runs under the gateway's process supervision, with bounded retries and explicit cleanup. Mid-turn shell-outs are safe there.

**Section does NOT apply to:**
- **Claude Code / Cursor agent terminals** — those have separate guidance in `CLAUDE.md` and `.cursorrules`. From those contexts, prefer `./vodou-core call <server> <tool>` as the primary primitive (deterministic, single-spawn). One-shot `./vodou-core brain "..."` / `./do "..."` calls are fine; the real hazard is rapid loops (the 425-process incident). No TTY gate triggers in current code — verified 2026-05-15.
- **Any non-supervised shell** invoking these as one-shots without process tracking.

---

The chat (Vodou-Console) already routes every non-conversational message through BrainLoader. Inside a *single response*, you (the LLM) can shell out to additional Vodou commands to pull live data, fold it into your answer, and avoid stale or hallucinated state. Use this when:

- The user asks a follow-up that needs fresh tool output (e.g., "what's the cpu now?" — shell out to `./vodou-core call mcp-monitor get_cpu_info '{}'`).
- You're mid-explanation and realize you don't know the current value of something (server list, channel status, scheduler queue, memory hits). Run the relevant command and continue.
- A skill returned ambiguous routing and you need BrainLoader to disambiguate — `./vodou-core brain "<rephrased query>"`.

**Two commands to know:**

| Command | When to use |
|---|---|
| `./vodou-core call <server> <tool> '<json-args>'` | You know exactly which tool to call. Fast, single spawn, deterministic. **Preferred.** |
| `./vodou-core brain "<query>"` | Ambiguous routing — let BrainLoader decide which tool(s). Slower but handles uncertainty. |
| `./do "<query>"` | Same as `vodou-core brain`, plus the launcher script's friendlier output (debug logging, exit-code handling). Functionally equivalent for chat context. |

**Soft cap:** at most **3 such shell-out calls per turn**. Beyond that, stop and ask the user (or summarize and offer "want me to dig further?"). The cap protects against runaway spawns (memory `[2026-05-04 METRIC] 425 vodou-core processes active` is the cautionary tale).

**Don't** use `vodou-core brain` or `./do` from chat for things you could answer from conversation context alone, or for things you'd normally answer with general knowledge. The point is *live Vodou state* — not LLM-style reasoning detours.

### 7. **SKILL LIFECYCLE (v0.5.46+)** 🆕

The skills system has a canonical schema, a unified lifecycle, and a single CLI surface. Spec lives in `PLANS/0.5.46/PLAN-SKILLS-V2.md`; this section is the contract.

#### Canonical layout

Every skill lives at `skills/<category>/<name>/` and contains:
- `SKILL.md` — frontmatter (per `schemas/skill.schema.json`) + prose body, with optional inline `<!-- AGENT_ACTIONS -->` HTML comments holding the workflow JSON. **Source of truth.**
- `actions.json` (optional) — auto-generated cache of the inline AGENT_ACTIONS, conforming to `schemas/actions.schema.json`. The gateway engine reads this for fast loading.
- `references/`, `templates/`, `scripts/`, `assets/` (optional) — auto-discovered by the loader on skill activation.

The two `kind`s of skill:
- `kind: workflow` — traditional Vodou skill with `trigger_phrases`, `stopping_points`, `actions` declarations. Routed to via intent matching.
- `kind: subagent` — persona under `skills/agents/<category>/<name>/`. No required workflow fields. Invoked by name via the Task tool. Optionally has actions.json for auxiliary structured workflows.

#### Lifecycle (Phase 1 `vodou-core skill` subcommand surface)

```
vodou-core skill list                  # all installed skills
vodou-core skill show <name>           # frontmatter + parsed workflow
vodou-core skill validate <name>       # schema + tool refs (--all for all 103)
vodou-core skill sync                  # reconcile disk ↔ DB drift; populate intents from trigger_phrases
vodou-core skill install <name>        # activate skill; populate intents
vodou-core skill uninstall <name>      # is_active=0; DELETE auto-skill-trigger intent rows for this skill
vodou-core skill remove <name>         # uninstall + archive files to .archive/
vodou-core skill import <source>       # Hermes / Claude Code / URL / catalog
vodou-core skill diff <name>           # local edits vs imported version
```

**Never edit `intent_mappings` directly to register a skill.** Add `trigger_phrases:` to SKILL.md frontmatter and run `skill sync`. Auto-generated rows land at priority 40, source `auto-skill-trigger`. User-curated rows at priority 80+ override these and are never pruned by sync.

On `skill uninstall`, the auto-skill-trigger rows for that skill are explicitly deleted to avoid zombie intents that route to a no-longer-loaded skill. User-curated rows are preserved across uninstall/reinstall.

#### Imported skills

Any skill with `imported_from.source != "hand-written"` may have local edits relative to its upstream. Before assuming an upgrade is safe:
- Check `imported_from.upstream_sha` — that's the content hash at import time.
- Run `vodou-core skill diff <name>` to see local edits vs original imported version.
- If `vodou-core skill catalog refresh` surfaces an upstream change, you get a 3-way diff (original / your edits / new upstream) — never silently overwrite.

#### Brand names

Prefer **Vodou** over **Vodou** in user-facing skill names and descriptions for new content. Legacy `oi-*` skill names are retained for backward compatibility (existing intent_mappings rows continue to route them) but new skills should use the Vodou brand. The system itself is being renamed gradually; both names refer to the same product.

#### Cross-references

- Schema: `schemas/skill.schema.json` (SKILL.md frontmatter), `schemas/actions.schema.json` (workflow JSON shape)
- Plan: `PLANS/0.5.46/PLAN-SKILLS-V2.md` — full plan; §0.7e is the live execution tracker
- Validators: `scripts/validate-skills.py` (stand-in for `skill validate`); `scripts/migrate-skill-frontmatter.py` (stand-in for `skill migrate-frontmatter`)
- Engine: `MCP-servers/Vodou-Console/src/workflow-driver.ts` (`detectWorkflow` reads actions.json sidecar first, inline AGENT_ACTIONS second; both feed the same render-without-LLM code path)

## Default collaboration style

- **Proactive by default.** Run tools, read the repo, apply fixes—finish the job. Don't open with intention theater ("Let me…", "I'll dig in", "Got the full picture", "Good — now…").
- **Straight and short.** Lead with the outcome; explain only when it changes a decision or the user asked for depth.
- **Constant doer.** Prefer one more grep/build over another status paragraph. If blocked, say what you need in one line.
- **Humor:** Optional, light—not filler.
- **Large autonomy / "run everything" ideas** (sandbox clone, always-on loops, etc.): shape in Vodou Enhanced Thinking or a `PLANS/` doc first—ship the immediate ask first.

## 🔥 MANDATORY: Enhanced Work Logging

At the end of EVERY coding session where you:
- Write or modify code
- Fix bugs or errors
- Implement features
- Analyze systems
- Complete tasks

You MUST execute the enhanced logging format:
```bash
./do "log: feature: Implemented user authentication | component: auth | files_changed: 2 | technology: rust | duration: 30min"
```

### Enhanced Logging Format:
- **Basic**: `./do "log: description"` (auto-categorized as "general")
- **With Category**: `./do "log: feature: Implemented user authentication"`
- **With Metadata**: `./do "log: bugfix: Fixed memory leak | component: connection_pool | files_changed: 1 | files_modified: src/connection_pool.rs | severity: high | duration: 15min"`

### Valid Categories:
- **feature** - New functionality or capabilities
- **bugfix** - Bug fixes and error corrections  
- **analysis** - Code analysis, research, investigations
- **documentation** - Documentation updates and improvements
- **testing** - Testing implementation and test fixes
- **refactor** - Code refactoring and structure improvements
- **performance** - Performance optimizations and improvements
- **security** - Security enhancements and fixes
- **config** - Configuration changes and updates
- **deployment** - Deployment and infrastructure changes
- **maintenance** - Routine maintenance and cleanup
- **research** - Research and exploration work
- **planning** - Planning and design work
- **review** - Code reviews and assessments
- **general** - General work not fitting other categories

### Common Metadata Keys:
- **component**: Which part of the system (e.g., "mcp_client", "database", "ui")
- **severity**: Impact level (low, medium, high, critical)
- **duration**: Time spent (e.g., "2h", "30min")
- **files_changed**: Number of files modified
- **files_modified**: Specific file names (e.g., "src/main.rs,src/database.rs")
- **lines_added**: Lines of code added
- **lines_removed**: Lines of code removed
- **technology**: Tech used (rust, javascript, sql, etc.)
- **issue_id**: Related issue or ticket number

### Examples:
- `./do "log: feature: Implemented JWT authentication system | component: auth | duration: 3h | files_changed: 2"`
- `./do "log: bugfix: Fixed memory leak in connection pool | component: mcp_client | files_changed: 1 | files_modified: src/connection_pool.rs | lines_added: 5 | lines_removed: 3 | severity: high | duration: 20min"`
- `./do "log: analysis: Analyzed codebase and created optimization plan | scope: full_codebase | files_analyzed: 15"`

**Note**: This is the BT4 equivalent of BT3's `./brain-log "description"` command with enhanced categorization and metadata support.

This is NOT optional - every work session must be logged with appropriate category and metadata.

## Project Overview - Triple-Layer Intelligence Orchestrator

### Why AI agents use Vodou
Vodou is how you get **relevant context when and where you need it**. For an agent, Vodou is your **arms** (tools and actions), **extended memory**, **skills**, and **orchestration** — so you can act, remember, and follow proven workflows instead of only reasoning in-conversation. The triple layer is the plumbing; the pitch is: *context and capability, on demand.*

---

Vodou is a **Triple-Layer Intelligence System** that combines expert workflow guidance, raw computational power, and script execution management:

### **🧠 Layer 1: Skills System (Expert Intelligence)**
- **183 skill intent mappings** → Expert workflow guides with numbered stopping points
- **66+ active skills** providing curated knowledge, proven patterns, and user control
- **Built-in Rust skills executor** (migrated from TypeScript OI-skills-executor)
- **Skills orchestrate MCP tools** when expert guidance determines it's needed
- **Examples**: hello (Vodou guidance), mastery (advanced techniques), security-audit (expert security workflows)

### **⚡ Layer 2: MCP Ecosystem (Raw Tool Power)**
- **209 MCP tool intent mappings** → 10 specialized servers with 60+ tools
- **Parallel execution** of 5-10 tools simultaneously (3-7x faster than sequential)
- **Universal tool access** to system monitoring, AI thinking, browser automation, memory systems
- **Examples**: CPU/memory/disk monitoring, enhanced thinking sessions, browser audits, diagram generation

### **🔧 Layer 3: Script Execution (Background Job Management)**
- **Script execution system** → Vodou-script-executor MCP server with 4 powerful tools
- **Background job management** with unique job IDs and process control
- **Sync/async execution** with real-time status monitoring and output streaming
- **Examples**: Long-running scripts, npm/yarn commands, background processes with live monitoring

### **🎯 Breakthrough Architecture**
- **Expert guidance meets raw power meets automation**: Skills provide workflow intelligence, MCP tools provide computational capability, scripts provide automation
- **User control enforced**: Skills use numbered stopping points to ensure users drive workflow direction
- **Intelligent routing**: Intent system determines whether to use expert guidance (skills), raw tools, or script execution
- **Best of all worlds**: Expert human wisdom + AI computational power + automated execution + user control

### **🌐 Vodou-Console (Web Chat)**
Web chat at `http://localhost:8765/#/chat` — same intelligence stack as the CLI.

**BrainLoader-first architecture:**
1. **Memory injection** — daemon socket → memory.db hybrid search (FTS5 + vector embeddings)
2. **Workspace bootstrap** — `.context_cache` loads USER.md, SOUL.md, MEMORY.md, IDENTITY.md, AGENTS.md
3. **BrainLoader** — `vodou-core brain "<query>"` handles intent routing, parameter extraction, parallel execution
4. **Workflow driver** — parses `<!-- AGENT_ACTIONS_N: -->` from skill output, executes multi-step tool sequences (loops, variable capture, chaining) via `vodou-core call`. Claude can't skip steps or fake output.
5. **Claude CLI** — conversational formatting + Bash for follow-up tool calls

**Monitoring:** `tail -f /tmp/oi-aigateway.log | grep "\[Workflow\]\|\[BrainLoader\]\|\[Memory\]"`

**Config:** `.env` → `CLI_MODEL=opus`, `WEB_PORT=8765`, `START_AIGATEWAY=1`

**Files:** `MCP-servers/Vodou-Console/src/anthropic.ts`, `workflow-driver.ts`, `workflows.json`

## 🗺️ What's in this repo — subsystem map

Flat list of every shipped piece. When you're unsure whether something exists, check here first before suggesting the user "implement X."

### Core runtime
- **`vodou-core`** (Rust) — daemon, worker, MCP router, brain command, scheduler, auto-updater. Sources: `src/`.
- **`vodou-hook-bin`** (Rust) — zero-thread ~400KB hook binary used by Claude Code / Cursor / Codex SessionStart, UserPromptSubmit, SessionEnd. Talks to the daemon via Unix socket; never touches DBs directly.
- **`./do`** — canonical launcher. `./oi` and `./vodou` are copies of the same script for muscle-memory. **Always prefer `./do`**.

### Web + UI
- **Vodou-Console** (`MCP-servers/Vodou-Console/`) — Express + WebSocket gateway, web chat UI at `http://localhost:8765`. Workflow driver lives here. Runs under launchd (`com.vodou.console`).
- **`open-gateway.sh`** — one-shot helper to re-open the gateway UI in the browser without re-running the full startup script. Use this if the user closes the tab and asks how to get back.

### Workflow + automation
- **Vodou-Board** (`MCP-servers/Vodou-Board/`) — task/workflow orchestration. Day-8 JWT (HS256, shared key in `vodou-core.db`, `REQUIRE_JWT` toggles enforcement). Phase-2 features (all shipped 2026-05-13): per-task memory injection from `memory.db` top-K chunks, workflow templates with stage auto-advance, approval gates (`requires_approval_on` JSON array, enforced on `running → done`), per-task budgets (USD/tokens/runtime, workers self-report via `board run-spend`), auto-generated `.mcp.json` for worker MCP registry. CLI surface: `vodou-core board ...`.
- **Skills system** (Layer 1) — `skills/<category>/<name>/SKILL.md` with frontmatter + AGENT_ACTIONS. Two kinds: `workflow` (routed via intent matching) and `subagent` (persona under `skills/agents/`, invoked by Task tool). See §7 Skill Lifecycle below for full CLI.

### Memory + recall
- **`memory.db`** — FTS5 + vector embeddings (BGE-base via ONNX). Hybrid search via daemon socket. Agents can query directly with `./vodou-core mem search "<query>" [--top-k N] [--json]` — routes through the daemon, same pipeline BrainLoader uses (hybrid FTS5+vector, BGE reranker, scope boost, provenance trust weighting — imports rank below first-party memory at equal relevance). `--json` returns `{results:[{path, score, text, score_breakdown}]}`. This is the right call for "search my memory/knowledge" — distinct from Vodou-Recall, which only covers chat turns of the current conversation.
- **Vodou-Recall** (shipped 2026-05-14) — FTS5-backed search of the current conversation's prior turns. Auto-bootstraps; agents shouldn't need to invoke directly.
- **Auto-memory** — markdown memory files at `.claude/projects/<project>/memory/MEMORY.md` (Claude Code) or `.vodou/workspace/MEMORY.md` (Cursor/TTY). Four memory types: `user`, `feedback`, `project`, `reference`. Daily incremental logs at `memory/YYYY-MM-DD.md`. Extraction runs every prompt via UserPromptSubmit hook.

### Integrations
- **Vodou-channels** (`MCP-servers/Vodou-channels/`) — Slack / Telegram / Discord bridge. Auto-connects on startup if built. Enable per-platform via `.env`: `SLACK_ENABLED=1` + `SLACK_BOT_TOKEN=xoxb-...`, `TELEGRAM_ENABLED=1` + `TELEGRAM_BOT_TOKEN=...`, `DISCORD_ENABLED=1` + `DISCORD_BOT_TOKEN=...`. Startup warns if `*_ENABLED` is set without matching token.
- **OAuth integrations catalog** — presets in `MCP-servers/Vodou-Console/presets/<name>.json`. Files starting with `_` are hidden from the catalog (use for known-broken servers; current: `_asana.json`).
- **Vodou-Enhanced-Thinking** — persistent deep-reasoning sessions, 6 tools.
- **Vodou-script-executor** — registered scripts + background job management, 4 tools.

### Scripts (project root)
- `install-vodou.sh` — curl-pipe bootstrap (`curl -fsSL https://raw.githubusercontent.com/VodouAI/OS/main/install-vodou.sh | bash`).
- `install-prebuilt.sh` — in-archive installer (run after extraction). Does quarantine strip + ad-hoc codesign + chmod 600 on secrets + stale `.update-old` and legacy `.oi/` sweep.
- `start-vodou-services.sh` — boots daemon + worker + Vodou-Console. Honors `VODOU_OPEN_BROWSER=1` (force-open the UI) and `VODOU_NO_OPEN_BROWSER=1` (suppress; used by SessionStart hooks).
- `stop-vodou-services.sh` — clean teardown via launchd bootout + targeted PID kills. Counterpart to start.
- `open-gateway.sh` — see Web + UI above.
- `session-start.sh` — invoked by Claude Code/Cursor SessionStart hook; runs `vodou-hook-bin context` and starts services in background if needed.

### Workspace layout (`.vodou/`)
- `.vodou/workspace/` — bootstrap files (IDENTITY, USER, MEMORY, AGENTS), `.cursor_context.json` (lean per-prompt memory cache), `agent_next_steps.json` (queued AGENT_ACTIONS).
- `.vodou/workspace/memory/YYYY-MM-DD.md` — daily incremental memory logs.
- `.vodou/system.log` — main runtime log.
- `.vodou/daemon.sock`, `.vodou/daemon.pid` — IPC.
- `.vodou/install.log` — install transcript (timestamped, multi-session append).

**`.oi/`** is **legacy**. All new artifacts write to `.vodou/`. Two intentional `.oi` code references remain: the one-time migration in `src/main.rs` (renames `.oi/` → `.vodou/` with backward-compat symlink, sunsets at v0.6.1) and the resolve-project-root match arm. Don't add new `.oi/` references.

### Security defaults (don't regress)
- Gateway HTTP listens on `127.0.0.1` only. CORS is a localhost allowlist (`localhost`, `127.0.0.1`, `[::1]`), not `*`. WebSocket validates `Origin` against the same allowlist.
- Build-time SECURITY gates abort the release if `memory.db` has any `memory_chunks` rows OR `vodou-core.db` has rows in any of: `server_credentials`, `oauth_pending`, `oauth_configs`, `dynamic_oauth_clients`, `conversation_sessions`, `conversation_entries`, `work_logs`, `user_approvals`, `automations`, `memory_chunks`.
- Install-time `chmod 600` on `.env`, `vodou-core.db`, `memory.db` (+ WAL/SHM siblings). `chmod -R go-rwx .vodou/`.
- Vodou-Board JWT (HS256) — shared key in `vodou-core.db`. Token bound to specific `task_id` (task_A token rejected on task_B write).
- macOS: ad-hoc codesign required after every binary `cp` (`codesign --force --deep --sign - <bin>`). Without it, runtime integrity enforcement SIGKILLs the freshly-copied file.

## 🎯 **THE BREAKTHROUGH ACHIEVEMENT - Universal Intelligence Orchestration**

Vodou is a **Universal Intelligence Orchestrator** that transforms how AI agents work: it delivers **relevant context when and where you need it** — your arms (tools), extended memory, skills, and orchestration in one place.

### **🌐 Universal MCP Ecosystem Access**
- **ANY MCP Server**: Connect to filesystem, databases, APIs, AI services, cloud tools, dev tools
- **1000+ Tools Available**: From basic file operations to complex AI workflows
- **Infinite Extensibility**: Install any MCP server from GitHub, npm, pip, or custom builds
- **Protocol Agnostic**: stdio, HTTP, WebSocket, Server-Sent Events - all supported

### **🚀 Parallel Intelligence Orchestration**
1. **Natural Language Intent Detection** using database-driven keyword mapping
2. **Optimal Tool Selection** from 30+ connected servers (expandable to unlimited)
3. **Intelligent Parameter Generation** using 291+ parameter rules
4. **Parallel Execution** of 5-10 tools simultaneously for maximum efficiency
5. **Expert Workflow Guidance** through skills that teach best practices
6. **User Flow Control** with mandatory stopping points for decision making

### **⚡ Real Performance Impact**
- **Traditional Sequential**: 15-30 seconds per task, limited tool access
- **Vodou Orchestration**: 3-5 seconds per task, unlimited tool ecosystem
- **Token Efficiency**: 98% savings vs normal Claude interaction
- **Capability Expansion**: Access to ANY tool that speaks MCP protocol

**Result**: AI agents become **intelligence orchestrators** with the speed of parallel processing, the breadth of the entire MCP ecosystem, and the wisdom of expert workflows.

## Setup Commands
- Install dependencies: `cargo build`
- Start development: `cargo run -- [command]`
- Run tests: `cargo test`
- Check database: `./do list`

## 🔧 **Complete CLI Commands**

### **Server Management**
- `./do connect <name> <command> [args...]` - Connect to MCP server
- `./do list` - List all connected servers
- `./do remove <name>` - Remove server
- `./do status [name]` - Show server status
- `./do reconnect <name>` - Reconnect server
- `./do health-check` - Check all server health

### **Capability Discovery**
- `./do tools <server>` - Show server tools
- `./do prompts <server>` - Show server prompts
- `./do resources <server>` - Show server resources
- `./do capabilities <server>` - Show all server capabilities

### **Tool Execution**
- `./do call <server> <tool> [args]` - Call specific tool
- `./do call-tool <server> <tool> [args]` - Call tool with parameter generation
- `./do find-tool <tool>` - Find tool across all servers
- `./do all-tools` - List all tools from all servers

### **Intent Management**
- `./do intent list` - List all intent mappings
- `./do intent add <keyword> <server> <tool> [priority]` - Add intent mapping
- `./do intent remove <keyword>` - Remove intent mapping
- `./do intent show <keyword>` - Show intent mapping
- `./do intent test <keyword> <query>` - Test intent mapping

### **Analytics & Monitoring**
- `./do conversation list` - List recorded conversations
- `./do conversation show <id>` - Show conversation details
- `./do conversation analytics` - Show conversation analytics
- `./do conversation export [format]` - Export conversation data
- `./do health-dashboard` - Show health dashboard
- `./do health-stats` - Show health statistics

### **Configuration & Management**
- `./do config` - Show configuration
- `./do update-config` - Update configuration
- `./do export-servers` - Export server configurations
- `./do import-servers` - Import server configurations
- `./do registry` - Show server registry

### **Development & Testing**
- `./do inspect <server>` - Inspect server capabilities
- `./do validate <server>` - Validate server configuration
- `./do test <server>` - Test server functionality
- `./do debug <server>` - Debug server issues
- `./do analyze <server>` - Analyze server performance

### **Worker (Persistent Connections)**
- `./do worker start` - Start worker process (foreground)
- `./do worker start --background` - Start worker as background daemon
- `./do worker stop` - Stop running worker
- `./do worker send --json '<json>'` - Send command to worker via Unix socket

### **Primary Interface (Most Common)**
- `./do "query"` - Fast parallel MCP execution with clean output (DEFAULT)
- `./do -v "query"` - Verbose mode with full loader output
- `cargo run -- brain "query"` - Direct brain command
- `cargo run -- brain "query" --verbose` - Verbose brain command

## Code Style
- Rust with `anyhow::Result` for error handling
- Use `async/await` for I/O operations
- Prefer `Arc<Database>` for shared database access
- Follow Rust naming conventions (snake_case)
- Use `serde_json` for JSON serialization
- Use `tokio::join!` for parallel execution

## Time canon (dates & timestamps)

Established 2026-08-04 after a codebase audit found the daily-memory lane split across zones (full plan + audit: `PLANS/PLAN-TIME-CANON.md`; enforced at commit time by `scripts/date-guard.py`).

1. **Instants in SQLite: naive UTC** `YYYY-MM-DD HH:MM:SS` — what `CURRENT_TIMESTAMP` / `datetime('now')` already write. Never put RFC3339 (`…+00:00` / `…Z`) into a column whose other writers are naive; compare in SQL via `datetime(col)`, never lexically across shapes.
2. **Day/month IDENTITY is the LOCAL day** — daily filenames (`memory/YYYY-MM-DD.md`), monthly import lanes, bucket keys, "today"/"yesterday" derivations. Rust: `Local::now()`. JS: build from local date components (never `toISOString().split('T')[0]`). SQL bucketing of naive-UTC columns: `date(col, 'localtime')`.
3. **Display parses naive-as-UTC and renders local** — UI code appends `Z` (or `+00:00`) before `new Date(...)`, then formats with local/locale APIs.
4. **The user's timezone setting** is `gateway_settings.user.timezone` (IANA, validated); the `USER.md` Timezone line is synced prose for the LLM, never a computation source.

## Architecture
- **MCP Client**: Handles communication with MCP servers using JSON-RPC
- **Brain Loader**: Orchestrates context loading and parallel execution
- **Database**: SQLite for server metadata and configuration
- **Connection Pool**: Manages MCP server connections efficiently
- **Parallel Executor**: Runs multiple MCP tools concurrently
- **Worker**: Long-lived process that holds persistent connections via Unix socket (see Worker section below)

## 🗄️ **Database Schema**

### **Current Intent Mappings (24+ Available)**
```
cpu → mcp-monitor::get_cpu_info (priority: 10)
memory → mcp-monitor::get_memory_info (priority: 10)
disk → mcp-monitor::get_disk_info (priority: 10)
analyze → (use Vodou memory + your toolchain; no bundled codebase MCP in core ship)
error → stackoverflow-mcp::search_by_tags (priority: 10)
screenshot → chrome-devtools::take_screenshot (priority: 10)
git → github-test::get_file_contents (priority: 10)
... and 17+ more mappings
```

### **🌐 Triple-Layer Intelligence Ecosystem**

#### **🧠 Layer 1: Skills System (Expert Intelligence)**
- **Skills Executor**: Built-in Rust implementation (handles 183 skill intent mappings, 66+ active skills)
- **Available Skills**: 66+ active skills providing expert workflow guides with numbered stopping points
- **Key Skills**: hello (Vodou guidance), mastery (advanced techniques), mcp-builder (custom tools)
- **Architecture**: Skills ARE MCP servers that orchestrate other MCP tools with expert guidance
- **User Control**: All skills enforce numbered stopping points for workflow direction

#### **⚡ Layer 2: MCP Ecosystem (Raw Tool Power - 10 Active Servers)**
**System Monitoring & Performance:**
- **mcp-monitor**: CPU, memory, disk, network monitoring (6 tools)

**AI Enhancement & Thinking:**  
- **Vodou-Enhanced-Thinking**: Persistent thinking sessions with context enrichment (6 tools)
- **OI-Sequential-Thinking**: Step-by-step problem solving with branching (1 tool)
- **Vodou-Recall**: FTS5-backed search of a conversation's prior turns (1 tool — `search_conversation`)
**Development & Documentation:**
- **context7**: Real-time library documentation & code examples (2 tools) 
- **uml-mcp**: Diagram generation (UML, Mermaid, D2) (1 tool)
- **browser-tools-stdio**: Browser automation & web auditing (14 tools)
- **chrome-devtools**: Chrome DevTools MCP — navigate, snapshot, screenshot, console, network (stdio via npx)

**Vodou Core Infrastructure:**
- **Vodou-script-executor**: Background script execution & job management (4 tools)
  - `execute_script`: Run registered scripts (sync or background) with job management
  - `script_status`: Monitor background job status and progress
  - `script_output`: View live script output (real-time tail)
  - `cancel_script`: Stop running background scripts with process control
- **Vodou-session-manager**: Long-running session management (5 tools)

#### **🔥 Universal Access to MCP Ecosystem**
- **Official MCP Servers**: Claude's filesystem, memory, fetch, brave-search, slack, gmail
- **Community Servers**: 1000+ on GitHub, npm, pip, Docker Hub
- **Enterprise Tools**: Databases, cloud services, internal APIs, custom workflows
- **Development Ecosystem**: Language servers, build tools, CI/CD, deployment
- **AI Services**: OpenAI, Anthropic, local LLMs, vector databases, embeddings
- **Business Tools**: CRM, project management, analytics, monitoring

#### **⚡ Installation in Seconds**
```bash
# Install ANY MCP server instantly:
./do "install https://github.com/user/any-mcp-server"
./do "install mcp-server-name"  # From npm/pip/cargo
./do "connect custom-server python my-custom-mcp.py"

# Access immediately:
./do "use new tool from fresh-installed-server"
```

**The Power**: Turn any tool, API, or service into an MCP server and Vodou can orchestrate it in parallel with everything else. **Infinite capability expansion.**

## 📊 **Intelligence Orchestration Performance**

### **🚀 Parallel Execution Performance**
- **Simple Orchestration** (95% of cases): 3-5 seconds for 2-5 parallel tools
- **Complex Orchestration** (5% of cases): 5-8 seconds for 5-10 parallel tools
- **Universal Tool Access**: Any of 1000+ MCP tools available instantly
- **Intent Detection**: < 10ms (O(1) database lookup)
- **Parameter Generation**: 1-10ms (291+ rules, expanding continuously)
- **Parallel Capacity**: 10+ tools executing simultaneously

### **🎯 Real-World Performance Comparisons**
```bash
# Traditional Sequential Approach:
Task 1: 3 seconds + Task 2: 4 seconds + Task 3: 3 seconds = 10+ seconds

# Vodou Intelligence Orchestration:
All 3 tasks in parallel: 4 seconds total
Result: 2.5x faster with comprehensive analysis
```

### **💰 Economic Impact**
- **Traditional MCP Usage**: 21,000+ tokens per interaction, limited tool access
- **Vodou Orchestration**: 2,200 tokens per interaction, unlimited tool ecosystem
- **Savings**: 90% token reduction, 85% cost savings, infinite capability expansion
- **Efficiency**: 98% token savings + access to entire MCP universe

### **🌐 Current Triple-Layer Capabilities**
- **Triple-Layer System**: 183 skill intents + 209 MCP tool intents + script execution (392+ total)
- **20+ Active MCP Servers** with 60+ tools connected and health-monitored  
- **66+ active skills** providing expert workflow guidance with numbered stopping points
- **Skills Orchestrate MCP Tools**: Expert guidance layer can direct raw tool execution
- **291+ Parameter Rules** for intelligent tool coordination
- **Real-time Health Monitoring** across entire MCP ecosystem
- **Universal Protocol Support**: stdio, HTTP, HTTPS, SSE, Streamable HTTP
- **Expert Workflow Guidance** through built-in Rust skills executor

## Worker (Persistent Stdio Connections)

The worker is a long-lived process that holds persistent MCP connections via a Unix socket. It eliminates per-request process spawning for expensive-to-start servers (e.g., Chrome DevTools, ML model servers).

### How It Works

Servers with `lifecycle_type = 'daemon_stdio'` in the database route tool calls through the worker instead of connecting locally. The worker holds a `ConnectionPool` — stdio child processes survive across `./do` invocations. All other servers are unaffected.

```
./do "visit vodou.ai"       →  brain_loader checks lifecycle_type
                             →  daemon_stdio? → worker::send() via Unix socket
                             →  worker dispatches to its ConnectionPool
                             →  Chrome stays alive after ./do exits

./do "take a screenshot"    →  Same Chrome instance, no reconnection delay
```

### Lifecycle Types

| Type | Behavior |
|------|----------|
| `ephemeral` (default) | Local connection pool, normal behavior |
| `persistent` | Local pool, never expires (idle timeout skipped) |
| `daemon_stdio` | Routes through worker, never expires, survives across invocations |

### Setting a Server to daemon_stdio

```sql
UPDATE mcp_servers SET lifecycle_type = 'daemon_stdio' WHERE name = 'chrome-devtools';
```

Only use `daemon_stdio` for servers where the child process is expensive to start (Chrome DevTools, ML model servers). Lightweight servers like mcp-monitor should stay `ephemeral`.

### Scheduled tasks (worker)

While the worker is running, it periodically calls `scheduler::run_due_tasks` against this project’s `vodou-core.db` (same rows as the gateway scheduler UI). Each due task spawns `vodou-core brain "<payload>"` (or in-process paths like `mem promote`) and waits for completion.

- **`VODOU_WORKER_SCHEDULER=0`** or **`false`** — disable the worker scheduler loop.
- **`VODOU_WORKER_SCHEDULER_INTERVAL_SECS`** — tick interval in seconds (default **60**, minimum **10**).

### Worker Commands

```bash
./do worker start              # Start in foreground
./do worker start --background # Start as background daemon
./do worker stop               # Stop running worker
./do worker send --json '{"cmd":"tool","args":{"server":"chrome-devtools","tool":"take_screenshot","arguments":{}}}'
```

### Worker Protocol

JSON over Unix socket (`.vodou/worker.sock`). One request per connection, newline-delimited.

**Request:** `{"cmd": "<command>", "args": {...}}`

**Commands:**
- `ping` — health check, returns `"pong"`
- `tool` — execute MCP tool: `{"cmd":"tool","args":{"server":"<name>","tool":"<tool>","arguments":{...}}}`
- `list`, `list-skills`, `version`, `status`, `log`, etc. — DB queries

**Response:** `{"ok": true, "stdout": "...", "stderr": "", "code": 0}`

### Fallback Behavior

If the worker is unavailable (not running, socket missing), `brain_loader` and `call_tool_pooled` fall back to local execution. For servers that lock exclusive resources (e.g., Chrome profile directory), the fallback may fail — start the worker first.

### Files

- `src/worker.rs` — Worker process, Unix socket listener, `tool` dispatch + ConnectionPool
- `src/connection_pool.rs` — `is_persistent_server()` recognizes `daemon_stdio`
- `src/brain_loader.rs` — `execute_tool_via_worker()` + routing check in `execute_tool_with_params()`
- `src/main.rs` — `call_tool_pooled()` routing check for `vodou-core call` command

## Environment Configuration
- `STACKOVERFLOW_API_KEY` - For StackOverflow MCP server rate limits
- `.env` file in vodou-core directory for configuration
- Database: `vodou-core.db` (SQLite)

## Testing Instructions
- Use `./do "test query"` for quick testing
- Use `./do -v "test query"` for detailed output
- Check `vodou-core.db` for server status
- Use `./do list` to verify server connections
- Run `cargo test` for unit tests

## Common Use Cases
- **System Monitoring**: `./do "what is my cpu?"` - Get CPU, memory, disk info
- **Script Execution**: `./do "run script"` - Execute background jobs with monitoring
- **Codebase Analysis**: `./do "analyze codebase"` - Get language, framework, complexity analysis
- **Help & Documentation**: `./do "help with javascript"` - Search StackOverflow for solutions
- **Server Management**: `./do list` - List all MCP servers
- **Installation**: `./do install https://github.com/user/repo` - Install new MCP servers

## Error Handling
- Use `tokio::time::timeout` for MCP calls to prevent hanging
- Handle MCP errors gracefully with `anyhow::anyhow!`
- Check database connectivity before operations
- Use `RUST_LOG=debug` for detailed logging

## 🔗 **Intelligence Orchestrator Integration Patterns**

### **🚀 Primary Interface: Universal Tool Orchestration**
```bash
# Parallel MCP orchestration with intent detection from ANY available tool:
./do "what is my cpu memory disk network?"     # → 4 tools in parallel, 3 seconds
./do "analyze code security performance"       # → Multiple analysis tools simultaneously  
./do "help with javascript error solutions"   # → Search + docs + examples in parallel
./do "screenshot website analyze performance" # → Browser + perf tools together
./do "backup files check git status deploy"  # → Filesystem + git + deployment orchestrated

# Script execution with background job management:
./do "run script"                           # → Execute scripts with job tracking
./do "script status job_12345"              # → Monitor background job progress  
./do "script output job_12345"              # → View live script output
./do "cancel script job_12345"              # → Stop running background jobs
./do "execute npm script"                   # → Run npm/yarn scripts with monitoring

# Universal access to any MCP tool:
./do "use gmail to send status report"       # → Gmail MCP if connected
./do "query database and visualize results"  # → DB + visualization tools
./do "transcribe audio and summarize"        # → Audio + AI summary tools
```

### **🌐 Universal MCP Ecosystem Usage**
```bash
# Verbose orchestration for debugging
./do -v "analyze codebase security performance"

# Direct calls to ANY connected MCP tool
./do call mcp-monitor get_cpu_info
./do call any-custom-server my_custom_tool
./do call newly-installed-server fresh_capability

# Universal intent management
./do intent list                                    # All available tools
./do intent add "backup" "filesystem" "backup_files" 10
./do intent test "backup" "backup my project files"

# Ecosystem expansion
./do install https://github.com/user/amazing-mcp-server
./do "use new amazing capability"                  # Available immediately
```

### **Conversation Analytics**
```bash
# View conversation history
./do conversation list
./do conversation show <id>
./do conversation analytics

# Export conversation data
./do conversation export csv
./do conversation export json
```

### **Health Monitoring**
```bash
# Check server health
./do health-check
./do health-dashboard
./do health-stats

# Monitor specific servers
./do status mcp-monitor
./do status chrome-devtools
```

### **Development & Testing**
```bash
# Test MCP servers
./do inspect mcp-monitor
./do validate mcp-monitor
./do test mcp-monitor

# Debug issues
./do debug mcp-monitor
./do analyze mcp-monitor
```

## Security Considerations
- MCP servers run in isolated processes
- Database access is controlled through Rust's type system
- Environment variables are loaded from `.env` file
- No direct file system access outside allowed directories

## Development Workflow
1. Make changes to Rust code
2. Test with `./do "test query"`
3. Use `./do -v "test query"` for debugging
4. Check `./do list` for server status
5. Run `cargo test` for validation
6. Use `cargo run -- brain "query" --verbose` for direct testing

## Key Files to Understand
- `src/main.rs` - CLI interface and command handlers
- `src/brain_loader.rs` - Context loading and parallel execution
- `src/mcp_client.rs` - MCP protocol implementation
- `src/database.rs` - SQLite database operations
- `do` - Unix/Linux/Mac launcher script (**`oi`** / **`vodou`** are byte copies — edit **`do`** only, then **`scripts/sync-cli-launchers.sh`**)
- `oi.bat` - Windows wrapper script (where shipped)

## Best Practices
- Keep MCP calls under 10 seconds with timeouts
- Use clean mode by default for better UX
- Provide verbose mode for debugging
- Handle MCP errors gracefully
- Use parallel execution for multiple servers
- Cache server connections when possible
- Follow KISS principle for new features
- Always test with `./do` before committing

## 🔧 **Troubleshooting**

### **Kernel / runtime triage**

When chat or tools flake, check orchestration before the model:

- **Web:** **`#/system`** — daemon, worker, gateway, **`runtime`** / **`overall`** health.
- **CLI:** **`./vodou-core runtime-status --json`** or **`./do runtime-status`** (prefer **`vodou-core`** when piping to avoid extra **`./do`** output).
- **Ground truth:** **`./vodou-core context-truth [--json]`** — the same deterministic facts block (cwd vs install root, project binding, git, MCP health, skills, intents, memory counts) the gateway injects into every chat turn as `─── VODOU GROUND TRUTH ───`. Daemon-first (warm, 30s catalog cache), readonly standalone fallback. Single emitter: `src/context_truth.rs` + daemon verb `cmd:"context"` — if a chat reports a wrong cwd/project again, THIS is the code path to suspect (PLAN-CONTEXT-GROUND-TRUTH, 0.6.13).
- **Binary swaps:** Stop **`./do daemon stop`** / **`./do worker stop`**, drain **`pgrep -fl vodou-core`**, then replace **`vodou-core`** — see **`docs/runtime-observability.md`** and **`PLANS/0.5.73/PLAN-RUNTIME-OBSERVABILITY.md`** §11 (UE hygiene).
- **Env:** **`VODOU_GATEWAY_AUTO_ENSURE`** (gateway daemon bootstrap), **`VODOU_HOOK_SKIP_ENSURE`** (skip ensure from IDE hooks when needed).

### **Common Issues**
- **Server Connection Failed**: Use `./do status <server>` to check server health
- **Intent Not Found**: Use `./do intent list` to see available mappings
- **Tool Execution Failed**: Use `./do debug <server>` to debug issues
- **Performance Issues**: Use `./do health-dashboard` to monitor performance

### **MCP server dependencies — never npm-install by package name**

Every server under `MCP-servers/` ships with a prebuilt `node_modules/`. Some deps are **vendored, not on npm** — e.g. `@vodou/channel-sdk` lives at `MCP-servers/Vodou-channels/packages/sdk` and is wired as a `file:` link (`node_modules/@vodou/channel-sdk → ../../packages/sdk`). Rules:

- ❌ Never run `npm install @vodou/<name>` (or `npm install <any-pkg>` inside an `MCP-servers/*` dir to "fix" something). Naming a package forces a registry lookup — `@vodou/*` 404s, and npm can prune the existing vendored link while failing.
- ✅ If a server's deps look broken (`ERR_MODULE_NOT_FOUND`), the repair is a **plain** `npm install` (no package name) in that server's directory. The lockfile relinks vendored `file:` deps locally and fetches public deps from npm.
- A 404 for `@vodou/*` does **not** mean the package is lost — the source ships inside the bundle. Vodou-channels also self-heals the link at startup if `packages/sdk` is present.

### **Debug Commands**
```bash
# Check server status
./do status
./do health-check

# Debug specific server
./do debug mcp-monitor
./do analyze mcp-monitor

# Check intent mappings
./do intent list
./do intent test <keyword> <query>

# View conversation logs
./do conversation list
./do conversation show <id>
```

### **Performance Optimization**
- **Use Simple Queries**: 95% of queries should use single server execution
- **Monitor Health**: Use `./do health-dashboard` to track server performance
- **Optimize Intents**: Use `./do intent list` to review and optimize mappings
- **Track Analytics**: Use `./do conversation analytics` to identify bottlenecks


## 🎯 **Intelligence Orchestrator Integration**

### **🚀 Universal AI Agent Interface**
- **Use `./do` for intelligence orchestration** — access to the entire MCP universe (**`./oi`** / **`./vodou`** invoke the same script)
- **Auto-Execute Rule**: When the user types **`oi`** or **`do`** at the start of a message, immediately run `./do "…"` with the rest of their text (same launcher; **`./do`** is the canonical path in docs)
- **Clean Mode**: Default for fast, token-efficient orchestration (3-5 seconds)
- **Verbose Mode**: Use `-v` flag for detailed parallel execution analysis
- **Universal Access**: Any MCP tool ever created is available through Vodou

### **🌐 Intelligence Orchestration Expectations**
- **Parallel Tasks**: 3-5 seconds for multiple tools simultaneously (95% of cases)
- **Complex Orchestration**: 5-8 seconds for advanced multi-tool workflows (5% of cases)
- **Token Efficiency**: 98% savings + unlimited capability access
- **Intent Detection**: < 10ms across entire MCP ecosystem
- **Tool Availability**: 1000+ tools from MCP ecosystem instantly accessible

### **🔥 Intelligence Orchestrator Best Practices**
- **Think Parallel**: Execute multiple related tasks simultaneously for 3-7x speed
- **Universal Access**: Install and use ANY MCP server for infinite capability expansion
- **Skills-First**: Leverage expert workflow guidance through skills system
- **User Control**: Respect stopping points where users make decisions
- **Ecosystem Health**: Use `./do health-dashboard` to monitor entire MCP network
- **Continuous Expansion**: Regularly install new MCP servers to expand capabilities
- **Performance Tracking**: Use `./do conversation analytics` for orchestration insights
- **Enhanced Logging**: Use `./do "log: category: description | metadata"` for rich session tracking

### **🌐 Universal Intelligence Orchestration Capabilities**
- **Unlimited MCP Ecosystem**: Connect to ANY MCP server (filesystem to AI services)
- **Parallel Tool Orchestration**: Execute 5-10 tools simultaneously for maximum efficiency  
- **Expert Workflow Intelligence**: Skills provide curated knowledge and proven patterns
- **Intent-Based Routing** across entire MCP universe for intelligent tool selection
- **Parameter Learning** for optimized tool coordination and smart defaults
- **Universal Protocol Support**: stdio, HTTP, WebSocket, SSE - connect anything
- **Real-time Health Monitoring** across entire connected MCP ecosystem
- **Instant Capability Expansion**: Install new MCP servers in seconds
- **User Flow Control**: Mandatory stopping points ensure user drives the orchestration
- **Performance Transparency**: Show actual speed improvements from parallel execution

### **Error Handling**
- Always check return codes and error messages
- Use `./do status` to verify server health
- Use `./do debug <server>` for detailed error analysis
- Use `./do health-check` for system-wide diagnostics

## 🔥 MANDATORY: Enhanced Work Logging Requirements

All AI agents using BT4 must log completed work using the enhanced logging format:

```bash
./do "log: feature: Implemented user authentication | component: auth | files_changed: 2 | technology: rust | duration: 30min"
```

### Enhanced Logging Format:
- **Basic**: `./do "log: description"` (auto-categorized as "general")
- **With Category**: `./do "log: feature: Implemented user authentication"`
- **With Metadata**: `./do "log: bugfix: Fixed memory leak | component: connection_pool | files_changed: 1 | files_modified: src/connection_pool.rs | severity: high | duration: 15min"`

### Valid Categories:
- **feature** - New functionality or capabilities
- **bugfix** - Bug fixes and error corrections
- **analysis** - Code analysis, research, investigations
- **documentation** - Documentation updates and improvements
- **testing** - Testing implementation and test fixes
- **refactor** - Code refactoring and structure improvements
- **performance** - Performance optimizations and improvements
- **security** - Security enhancements and fixes
- **config** - Configuration changes and updates
- **deployment** - Deployment and infrastructure changes
- **maintenance** - Routine maintenance and cleanup
- **research** - Research and exploration work
- **planning** - Planning and design work
- **review** - Code reviews and assessments
- **general** - General work not fitting other categories

### Metadata Best Practices:
- **component**: Which part of the system (e.g., "mcp_client", "database", "ui")
- **severity**: Impact level (low, medium, high, critical)
- **duration**: Time spent (e.g., "2h", "30min")
- **files_changed**: Number of files modified
- **lines_added**: Lines of code added
- **lines_removed**: Lines of code removed
- **technology**: Tech used (rust, javascript, sql, etc.)
- **issue_id**: Related issue or ticket number
- **pr_id**: Related pull request ID
- **version**: Version or milestone affected

### Category-Specific Examples:

#### Feature Development:
```bash
./do "log: feature: Added JWT authentication system | component: auth | duration: 3h | files_changed: 5"
./do "log: feature: Implemented parallel MCP execution | component: brain_loader | performance_improvement: 3x_faster"
```

#### Bug Fixes:
```bash
./do "log: bugfix: Fixed memory leak in connection pool | component: mcp_client | files_changed: 1 | files_modified: src/connection_pool.rs | lines_added: 5 | lines_removed: 3 | severity: high | duration: 20min | issue_id: 123"
./do "log: bugfix: Resolved database connection timeout | component: database | duration: 1h"
```

#### Analysis Work:
```bash
./do "log: analysis: Analyzed codebase structure and dependencies | scope: full_codebase | findings: 15_optimization_opportunities"
./do "log: analysis: Performance bottleneck investigation | component: parallel_executor | tools_used: profiler"
```

#### Documentation:
```bash
./do "log: documentation: Updated API documentation with new endpoints | component: api | pages_updated: 12"
./do "log: documentation: Enhanced AGENTS.md with logging guidelines | target_audience: ai_agents"
```

#### Performance Work:
```bash
./do "log: performance: Optimized database queries | component: database | improvement: 50%_faster | queries_affected: 8"
./do "log: performance: Reduced memory usage in parameter engine | component: parameter_engine | reduction: 97.9%"
```

#### Testing:
```bash
./do "log: testing: Added integration tests for MCP client | component: mcp_client | tests_added: 15 | coverage_increase: 25%"
./do "log: testing: Fixed failing unit tests after refactor | component: brain_loader | tests_fixed: 8"
```

### Work Type to Category Mapping:
- **New features, capabilities** → feature
- **Bug fixes, error corrections** → bugfix  
- **Code analysis, research** → analysis
- **Docs, README updates** → documentation
- **Test writing, test fixes** → testing
- **Code restructuring** → refactor
- **Speed improvements** → performance
- **Security enhancements** → security
- **Settings, config changes** → config
- **Infrastructure work** → deployment
- **Cleanup, maintenance** → maintenance
- **Investigation, exploration** → research
- **Planning, design** → planning
- **Code reviews** → review
- **Other work** → general

### Session Tracking:
The enhanced logging system automatically:
- Associates logs with conversation sessions
- Tracks agent type (Claude, Cursor, etc.)
- Records timestamps and metadata
- Enables powerful analytics and reporting

### Best Practices:
1. **Always include category** for better organization
2. **Use metadata for key details** that enable analytics
3. **Be specific in descriptions** for future reference
4. **Log immediately after completing work** for accuracy
5. **Use consistent component names** across sessions
6. **Include performance metrics** when applicable
7. **Reference issue/PR IDs** when available

This enhanced logging provides rich context for project analytics, progress tracking, and knowledge transfer between AI agent sessions.


