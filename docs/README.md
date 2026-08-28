# Vodou — AI Operating System

**Product / release version** may differ from the Rust crate; see **`Cargo.toml`** (`[package].version`) for the current **`vodou-core`** crate. **arm64** is a common release target; other platforms may be supported via your install bundle.

**Vodou** is a local-first orchestration stack: natural language and CLI access to **MCP tools**, **skills** (guided workflows), **scripts**, **memory**, and optional **web chat**—with parallel tool execution where configured.

## 🎯 What is Vodou?

Vodou is a complete AI operating system that provides instant access to system information, codebase analysis, and external knowledge through parallel MCP server execution. But it's much more than that - it's a fully customizable intelligence orchestration platform.

### The Triple-Layer Intelligence System

**🧠 Layer 1: Expert Workflow Intelligence (Skills)**
- Skills system provides curated knowledge and proven patterns
- Interactive guidance with stopping points for user control
- Best practices built-in for every workflow
- Dozens of bundled skills (plus your own under `skills/`) for guided workflows
- **Fully customizable** - create your own skills for your domain

**⚡ Layer 2: Parallel Intelligence Orchestration (MCP Tools)**
- Execute 5-10 MCP tools simultaneously in 3-5 seconds
- Automatic result correlation and context sharing
- **3-7x faster** than sequential execution (15-30 seconds vs 3-5 seconds)
- Connect to **ANY MCP server** (1000+ tools available)
- **Fully customizable** - install any MCP server, create custom intents

**🔧 Layer 3: Background Script Execution (Automation)**
- Execute long-running scripts with background job management
- Real-time status monitoring and output streaming
- Process control with unique job IDs and cancellation
- Sync/async execution with npm/yarn integration
- **Fully customizable** - register your own scripts and automation

### What Makes Vodou Unique

**No other platform combines all three layers with full customization:**
- Traditional tools: Sequential only, limited access, no background execution, no customization
- Other MCP platforms: Limited tool access, no expert guidance, no script management, limited customization
- Generic AI: No parallel execution, no expert workflows, no automation layer, no customization

**Vodou = Expert Intelligence + Parallel Speed + Background Automation + Infinite Extensibility + Full Customization**

### Key Benefits

- **🚀 Speed**: 3-7x faster than sequential execution
- **🧠 Intelligence**: Expert guidance through skills
- **🌐 Extensibility**: Access to 1000+ tools
- **💰 Efficiency**: 90% token reduction, 85% cost savings
- **🎯 Control**: You stay in control with stopping points
- **🔧 Customization**: Fully customizable - create custom skills, connect custom MCP servers, automate custom scripts

## Recent capabilities (high level)

- **Web gateway** — Chat UI, capabilities/settings, and workflow-style skill steps when using the bundled gateway (`WEB_PORT`, typically **8765**). See [setup.md](setup.md).
- **Messaging** — Slack, Telegram, Discord, WhatsApp, and iMessage (1:1 rules apply for WhatsApp). See [messaging.md](messaging.md).
- **OpenAI-compatible HTTP API** — Local `v1/chat/completions` for IDEs and tools. See [openai-compatible-api.md](openai-compatible-api.md).
- **Vodou Core HTTP API** — Typed REST API on port **8766** with full OpenAPI spec (servers, tools, OAuth, automations, hooks, schedule, memory, **continuity v2** added v0.5.74). Generated TypeScript SDK for Console-side code. See [core-http-api.md](core-http-api.md). New v2 endpoints `/api/v2/memory/recall` and `/api/v2/channels/turns` are the canonical principal-aware surface; legacy `/api/memory/search` ships with `Deprecation` + `Sunset` headers.
- **MCP host mode** — any local MCP client (Claude Desktop, Claude Code, Cursor, VS Code, Zed, a local runner, your own script) can attach to Vodou and adopt its memory, skills and connected tools. `vodou-core mcp install <client>` writes the config; stdio or loopback HTTP, with per-client profiles for what each may reach. See [mcp-host.md](mcp-host.md).
- **Pluggable channels** — Messaging connectors are npm packages under `~/.vodou/channels/`; install via Console UI or `POST /api/channels/install`. See [messaging.md](messaging.md).
- **Workflows (graph skills)** — describe multi-step work in a sentence (or `/workflow …`) and get a **plan** before anything runs: resolved `server·tool` per step, parallel blocks that actually run in parallel, a join that counts from recorded state, fresh-context verifiers, and an approval gate on anything that sends. The plan, the live run and the approval question reach **every surface** — Console chat, the browser side panel, messaging channels (answer with a number), the Board drawer and the CLI — and the skills catalog shows each skill's shape (`chain`/`fan`/`fan+check`/`cycle`) with a `wide · with checks · scheduled` filter. See [workflows.md](workflows.md).
- **Skills** — Markdown skills with optional interactive steps; registry synced from `skills/`. **Skill Consoles** — LLM-created scheduled skills with their own gateway tab; see [skill-console.md](skill-console.md).
- **Managed web-chat file tools** — Claude-Code-style `read_file`/`write_file`/`edit_file`/`search_files` for API-provider web chat, confined to a per-conversation workspace, behind a category-based permission engine (`auto`/`ask`/`deny` profiles). Off by default (`VODOU_FS_TOOLS_ENABLED`). See [managed-chat-tools.md](managed-chat-tools.md).
- **Gateway state layer (prompt caching + bounded context)** — makes stateless API models behave like the warm `claude -p`: a byte-stable cacheable prefix, session affinity, out-of-band big-tool-result handles (`expand_result`), rolling-summary compaction, and a hard per-turn token ceiling. On for the managed tier; ~86% live cache hits on warm turns. See [gateway-state-layer.md](gateway-state-layer.md).
- **Kanban Board** — Multi-agent durable Kanban with memory-injected workers, workflow templates, per-task budgets, approval gates, and channel-native notifications. Phase 1 + 5 of 7 Phase-2 differentiator cuts live. See [kanban-board.md](kanban-board.md) and [board-tutorial.md](board-tutorial.md).
- **Vodou CLI (agentic terminal)** — A Claude-Code-style interactive TUI (`vodou`) you launch from any directory: the full agentic loop (configured LLM, memory, BrainLoader routing, skills, tools, streaming) with cwd file access, markdown + clickable links, native scrollback, and slash commands (`/skills`, `/server`, `/tools`, `/search`, `/compress`, `/model`, …). Embeds `chat()` in-process — no gateway needed. See [vodou-cli.md](vodou-cli.md).
- **Gateway Projects (multi-workspace)** — Point the gateway at multiple working directories; each project gets its own chats, file root, and instructions (a per-dir `CLAUDE.md`), while servers/credentials/daemon/memory stay shared. Adding a project writes nothing into its directory. See [gateway-projects.md](gateway-projects.md).
- **Memory + scheduler** — Project memory, janitor, optional heartbeat and scheduled tasks (configure via `.env`; see `.env.example`).
- **Extraction reliability + benchmarks** — Claim-queue extraction with an honest ledger (`mem extract-status`), clean fact shape with write-time retrieval keys, recovery drains (`mem reembed`, `mem reextract`), benchmark gates (`mem bench-extract --recall [--backends …]`, `mem health --runs N`, `mem retrieval-bench`), and API-enforced structured LLM output with hot-swappable schemas (`.vodou/schemas/`). See [memory-extraction-pipeline.md](memory-extraction-pipeline.md) and [structured-output.md](structured-output.md).
- **Universal Memory (own your data)** — Import your ChatGPT / Claude / Obsidian / Letta history (`mem import`, or one-click or automatic browser capture via the **Vodou Bridge** Chrome extension — which also inserts your memory into any AI chat with Ctrl+B, shows what you already know about the page you're on, and takes notes on any page), export portable memory packs (`mem export`), and let Vodou *reconcile* what it ingests: imported chunks are provenance-ranked below first-party memory (`VODOU_MEMORY_W_TRUST`), and a contradiction review queue surfaces where your history disagrees with current memory (`mem contradictions`, Memory → Imports tab). Share a *subset* with **memory vaults** (`mem vault`, `mem export --vault` — "share the family vault, not the bank vault") and *see* the whole brain in **Memory → Map** (http://127.0.0.1:8765/#/memory?tab=map — Obsidian-style constellation with provenance-as-luminosity). See [vodou-memory.md](vodou-memory.md), [vodou-brain.md](vodou-brain.md), and [vodou-bridge.md](vodou-bridge.md).

## 📦 Installation Guide

### **Step 1: Run the Installation Script**

```bash
./install.sh
```

### **Step 2: Configure Your Credentials**

Edit `.env` and add your VODOU_TOKEN and VODOU_USER_ID from https://app.vodou.ai

### **Step 3: Start Vodou Services**

```bash
./start-vodou-services.sh
```

### **Step 4: Test Vodou**

```bash
./do "hello"
```

## 🚀 Quick Start Examples

### System Monitoring (Parallel Execution)
```bash
./do "cpu memory disk network"
# All execute simultaneously in 3-5 seconds
```

### Script Execution (Background Jobs)
```bash
./do "run script"
./do "script status job_12345"
```

### Code Analysis (Enhanced Thinking)
```bash
./do "deep think about my codebase structure"
```

### Web Auditing (Browser Automation)
```bash
./do "run seo audit on my website"
```

### Development Workflows (Skills Orchestration)
```bash
./do "implement feature with testing"
```

### Custom Skills & MCP Servers
```bash
./do "create vodou skill"                    # Build custom skills
./do "install https://github.com/user/custom-mcp-server"  # Add new capabilities
```

## 📚 Documentation

User-facing documentation is in the `docs/` directory. Highlights: **[setup.md](setup.md)**, **[cli-entrypoints.md](cli-entrypoints.md)** (canonical **`./do`** — launcher copies such as **`vodou`** are byte-identical to **`do`**), **[vodou-cli.md](vodou-cli.md)** (the interactive agentic **`vodou`** TUI — distinct from the `./do` launcher), **[cli-reference.md](cli-reference.md)**, **[messaging.md](messaging.md)**, **[openai-compatible-api.md](openai-compatible-api.md)**, **[skills.md](skills.md)**, **[skill-console.md](skill-console.md)** (LLM-created Skill Consoles + `vc_skills_create`), **[managed-chat-tools.md](managed-chat-tools.md)** (web-chat filesystem tools + permission engine), **[vodou-brain.md](vodou-brain.md)** (visual memory navigation + vault sharing), **[vodou-bridge.md](vodou-bridge.md)** (the Chrome extension: capture your AI chats, Ctrl+B memory insert, memory on the page you're on, tasks), **[memory-follows-you.md](memory-follows-you.md)** (auto-inject + IDE/MCP setup), **[troubleshooting.md](troubleshooting.md)**, **[runtime-observability.md](runtime-observability.md)** (kernel health, `/api/system`, CLI `runtime-status`). Implementation-only material is not kept here; see **[INTERNAL-DEVELOPER-DOCS.md](INTERNAL-DEVELOPER-DOCS.md)**.

### Getting Help

- **Help Center**: `./do "hello"` — comprehensive guide (other launcher filenames are byte-identical; see [cli-entrypoints.md](cli-entrypoints.md))
- **Skills Guide**: `./do "vodou mastery"` — advanced techniques
- **MCP Servers**: `./do list` — see all connected MCP servers
- **Available Skills**: `./do list skills` — browse all available skills

### What You Can Do with Vodou

- **System Monitoring**: Parallel execution of CPU, memory, disk, network monitoring
- **Script Execution**: Background job management with real-time monitoring
- **Code Analysis**: Enhanced AI thinking with persistent sessions
- **Web Auditing**: Browser automation and SEO analysis
- **Development Workflows**: Skills orchestration for complex workflows
- **Browser Automation**: Screenshot capture, page interaction, console access
- **Deep Thinking**: Persistent thinking sessions with quality analysis
- **Job Monitoring**: Track background processes with unique job IDs
- **Session Management**: Long-running operations with persistent MCP server sessions
- **Multi-Step Workflows**: Complex operations spanning multiple tool calls
- **Messaging**: Same assistant over Slack, Telegram, Discord, or WhatsApp (see [messaging.md](messaging.md))

**And more** — depends on which MCP servers you connect (`./do list`). **Customize** with your own skills, servers, and scripts.

---

**Vodou** — see your install or `Cargo.toml` for version labels; **arm64** is typical for macOS release bundles.
