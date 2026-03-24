<h1 align="center">Vodou</h1>
<p align="center"><strong>Your AI. Your rules. Your machine.</strong></p>
<p align="center">
<a href="#install">Install</a> · <a href="https://app.oios.io">Get Credentials</a> · <a href="https://github.com/VodouAI/OS/issues">Report Issues</a>
</p>

---

AI assistants remember things now. They all do. But remembering isn't the same as understanding how you work.

Cowork remembers your project context. OpenClaw stores daily logs. But when you ask for a deployment — do they know to check staging first, run your test suite, then wait for you to choose between a rolling deploy and blue-green? Do they run five monitoring tools in parallel and hand you structured results in under a second? Do they enforce the safety checks your team agreed on, even when the AI wants to skip ahead?

**Vodou is an AI orchestration system.** It doesn't just remember — it executes structured workflows, runs tools in parallel, and keeps humans in control at every decision point. It runs locally, works with 10+ LLM providers, and you build it into whatever you need.

> **Alpha release** — early software, small team. Rough edges exist. We ship fast and fix fast.

---

## What Makes It Different

### Parallel Execution

```
oi "cpu memory disk"
```

Three MCP tool servers fire **simultaneously**. In under a second: CPU at 21% across 10 cores. RAM at 80%, 12.8GB of 16GB. Disk at 78%, 199GB free. Real system calls returning structured data — not one tool at a time.

### Engine-Enforced Workflows

```
oi "debug my app"
```

A structured debugging skill loads. It walks you through systematic isolation — logs, resources, recent changes. At each step, **you** decide what to investigate next. Not the AI. The skill engine enforces stopping points — the AI can't skip ahead, can't guess your choice, can't shortcut the process your team designed.

### Compound Memory

Week one, you mention your project uses Rust with SQLite. You prefer short PRs. You never delete a database without a backup.

Week two, you ask for help with a migration. Vodou writes Rust — not Python. Keeps the PR small. Warns you before touching the database. You didn't repeat yourself once.

Memory runs as a background daemon — extracting, curating, promoting important decisions, filtering noise. Hybrid search (FTS5 + 384-dim vector embeddings) finds the right memory whether you remember the exact words or not.

---

## You Shape It

That debugging checklist you explain to every new hire? That deployment runbook? **Write it in markdown.** Add stopping points where humans make decisions. Vodou turns it into an interactive workflow with automated tool calls behind each option.

```
oi "code review"     → structured security + quality audit with decisions at every step
oi "plan"            → implementation planning with architecture trade-offs
oi "deep think"      → extended multi-model analysis on any topic
```

No SDK. No API integration. A markdown file + an actions.json becomes a live, repeatable, engine-enforced workflow. **Your expertise, automated.**

Connect any MCP tool server from the growing ecosystem — thousands exist. Plug in Slack, GitHub, databases, monitoring, anything with an API. Use any AI model — Claude, GPT-4, Gemini, Groq, DeepSeek, Grok, Mistral, Ollama running locally. Your skills work with all of them because **the skill is the workflow, not the model.**

---

## How It Compares

Every tool in this space has memory now. Here's what they don't have:

| | **Claude Cowork** | **OpenClaw** | **Vodou** |
|---|---|---|---|
| **Workflows** | LLM decides the steps | AgentSkills — community-contributed, no enforcement | Engine-enforced stopping points with automated tool sequences |
| **Execution** | Sequential | Sequential | Parallel — 5-10 tools simultaneously |
| **Models** | Claude only | Multi-model | 10 providers — Claude, OpenAI, Gemini, Groq, DeepSeek, Grok, Mistral, Ollama, any OpenAI-compatible |
| **Where it lives** | Desktop app | WhatsApp, Discord, Telegram | Any IDE with a terminal + web dashboard |
| **Skill security** | N/A | Cisco found data exfiltration through third-party skills | Skills are local markdown files you audit and control |
| **Programmable** | No API | Limited | Full REST API — execute tools, route queries, run workflows programmatically |
| **Cost** | $20-200/mo | Free | Free. Bring your own API key |

Cowork is polished but closed — you can't change how it works. OpenClaw is open but chaotic — community skills with no safety rails. Vodou gives you the engine: deterministic workflows, parallel execution, and a REST API to build on top of.

---

## How It Works

Vodou is a **triple-layer intelligence system** built in Rust:

```
┌─────────────────────────────────────────────┐
│  Your IDE / Terminal / Web Dashboard         │
├─────────────────────────────────────────────┤
│  Layer 1: Skills                            │
│  Expert workflows in markdown with          │
│  stopping points for human decisions        │
├─────────────────────────────────────────────┤
│  Layer 2: MCP Tools                         │
│  Unlimited servers & tools, parallel        │
│  execution (system, Slack, GitHub, etc.)    │
├─────────────────────────────────────────────┤
│  Layer 3: Background Automation             │
│  Scheduled tasks, memory curation,          │
│  file watchers — runs while you don't       │
├─────────────────────────────────────────────┤
│  brain-trust4 (Rust core, ~49K lines)       │
│  Intent routing · Parameter extraction      │
│  Connection pool · Hybrid memory (FTS5 +    │
│  384-dim vector embeddings) · Daemon        │
└─────────────────────────────────────────────┘
```

When you type a query, the **BrainLoader** routes it: matching intents to skills or tools, extracting parameters, executing in parallel, and returning structured results. All in milliseconds.

---

## Requirements

| Requirement | Details |
|---|---|
| **OS** | macOS (Apple Silicon or Intel). Linux coming soon. |
| **Editor** | Any IDE with a terminal. Deep integration (auto-memory, hooks) for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [Cursor](https://cursor.sh) |
| **Node.js** | v20+ (installer will install v22 if missing) |
| **AI Provider** | 10 supported: Claude CLI, Anthropic API, OpenAI, Google Gemini, Groq, DeepSeek, xAI (Grok), Mistral, Ollama, or any OpenAI-compatible endpoint |
| **Credentials** | Free Vodou token from [app.oios.io](https://app.oios.io) |

Vodou itself is free. You bring your own AI provider — use what you already have.

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/VodouAI/OS/main/install-vodou.sh | bash
```

60 seconds. Works on Apple Silicon and Intel. Everything ships pre-built — no compilation, no npm install.

<details>
<summary><strong>Manual install</strong></summary>

Download for your Mac:
- **Apple Silicon** (M1/M2/M3/M4): [Download](https://github.com/VodouAI/OS/releases/download/v0.5.35/OI-v0.5.35-prebuilt-arm64.tar.gz)
- **Intel**: [Download](https://github.com/VodouAI/OS/releases/download/v0.5.35/OI-v0.5.35-prebuilt-intel.tar.gz)

```bash
tar -xzf OI-v0.5.35-prebuilt-*.tar.gz
cd OI-v0.5.35-*
./install-prebuilt.sh
```

Not sure which Mac? → Apple menu → "About This Mac." M1/M2/M3/M4 = Apple Silicon.
</details>

<details>
<summary><strong>Custom install location</strong></summary>

```bash
VODOU_INSTALL_DIR=~/my-vodou curl -fsSL https://raw.githubusercontent.com/VodouAI/OS/main/install-vodou.sh | bash
```

Default location is `~/vodou`.
</details>

---

## Getting Started

**1. Add your credentials**

```bash
cd ~/vodou && nano .env
```

Add `OI_TOKEN` and `OI_USER_ID` from [app.oios.io](https://app.oios.io). Optionally add your `ANTHROPIC_API_KEY` — or use Claude CLI if you have a Max subscription (no extra cost).

**2. Open your editor**

Open `~/vodou` in your IDE. Works from any terminal. Claude Code and Cursor get automatic memory hooks — other editors work via the CLI and web dashboard.

**3. Try it**

```bash
oi "hello"                    # Introduction and system check
oi "cpu memory disk"          # Parallel system monitoring
oi "deep think about X"       # Extended reasoning on any topic
oi "list skills"              # See all available skills
```

**4. Open the dashboard**

[localhost:8765](http://localhost:8765) — chat interface with conversation tabs, voice input, skill execution, drag-and-drop files, and MCP tool forms. All running locally.

---

## What's Inside

### Memory
Hybrid search combining full-text (BM25) and 384-dimensional vector embeddings. Background daemon extracts, curates, and promotes knowledge automatically. Cross-session recall means you explain things once.

### Skills
Expert workflows in markdown with interactive stopping points. Debugging, code review, security audits, TDD, implementation planning, deep thinking — dozens ship built-in. Create your own in minutes. There's no limit.

### MCP Tools
System monitoring, Slack, diagrams, browser automation, file management, image generation, script execution — ships with a full toolkit and connects to thousands more. All execute in parallel through a connection pool.

### Web Dashboard
PWA at `localhost:8765`. Installable as a standalone app with Dock icon. Chat tabs that survive restarts, inline tool rendering, voice input, command palette (Cmd+K), memory viewer with mind map.

### Multi-Model
10 providers out of the box: Claude, OpenAI, Gemini, Groq, DeepSeek, Grok, Mistral, Ollama, and any OpenAI-compatible endpoint. Skills work across all of them because the skill controls the workflow — not the model.

### REST API
Full orchestration API — execute tools, route queries, run workflows, manage servers, search memory. All programmatically via HTTP. Build integrations, dashboards, or chain Vodou into your CI/CD pipeline.

### Automation
Cron-based scheduler, background memory curation, file watchers. Vodou works while you don't.

---

## Build Your Own Skills

A skill is a markdown file that defines the workflow, plus an optional `actions.json` that wires choices to real tool calls:

**SKILL.md** — the workflow:
```markdown
---
name: code-review
description: AI-powered code review with deep thinking
version: 1.0.0
required_tools: ["OI-Enhanced-Thinking"]
---

# Code Review

## Overview
Structured code review using deep thinking for thorough analysis.

## Stopping Point 1: Review Depth
1. **Quick Review** (3 steps) — scan for obvious issues
2. **Thorough Review** (8 steps) — architecture, bugs, security
3. **Deep Audit** (15 steps) — comprehensive security and quality audit
```

**actions.json** — the automation:
```json
{
  "stopping_points": [{
    "id": 1,
    "title": "Review Depth",
    "options": {
      "1": {
        "label": "Quick Review",
        "vars": {"DEPTH": "3"},
        "steps": [
          {"server": "OI-Enhanced-Thinking", "tool": "start_thinking_session",
           "args": {"topic": "Code review of {{TOPIC}}", "depth": "{{DEPTH}}"},
           "capture": {"SESSION_ID": "session_id"}},
          {"server": "OI-Enhanced-Thinking", "tool": "add_thought",
           "args": {"session_id": "{{SESSION_ID}}", "thought": "Summarize findings",
                    "nextThoughtNeeded": false}}
        ]
      }
    }
  }]
}
```

When a user picks "Quick Review," Vodou doesn't ask the AI what to do — it executes the exact tool sequence you defined. Variables like `{{TOPIC}}` are extracted from the user's query. Results chain through `capture`. Loops, parallel steps, and streaming are all supported.

Drop it in `skills/my-skills/`, register it, and it's live. Templates for common patterns (research, system checks, code review) ship built-in.

---

## Connect Any Tool

Vodou speaks [MCP](https://modelcontextprotocol.io/) (Model Context Protocol). Thousands of servers exist:

```bash
# From the built-in registry
./brain-trust4 install server-name

# Any npm package
./brain-trust4 connect my-server "npx -y @some/mcp-server"

# Any command
./brain-trust4 connect local-tool "python3 my_server.py"
```

Databases, APIs, cloud services, dev tools — connect anything. Vodou handles intent routing, parameter extraction, and parallel execution automatically.

---

## Troubleshooting

**Installer hangs?** Debug mode shows exactly where:
```bash
DEBUG=1 ./install-prebuilt.sh
```

**Services not running?**
```bash
./start-OI-services.sh
```

**Health check:**
```bash
./brain-trust4 health-check
```

**Memory search feels off?** Check that `ORT_DYLIB_PATH` is set in `.env`. Without it, memory uses full-text search only — still works, just less semantic.

**macOS security warning?**
```bash
xattr -dr com.apple.quarantine ~/vodou
```

---

## Where This Is Going

Vodou is **alpha** — and already 49,000 lines of Rust powering compound memory, parallel tool execution, a skill engine, 10 LLM providers, a REST API, and a web dashboard. That's the foundation.

What's already here:
- **Memory UI** — timeline view, interactive mind map, search, and live editing in the web dashboard.
- **REST API** — full orchestration API with 17 router groups. Execute tools, route queries, run workflows, manage servers, search memory — all programmatically via HTTP.
- **Workflow execution** — trigger any skill's actions.json via REST with variable injection, async polling, and step-by-step results.

What's coming:
- **Linux and Windows** — macOS first, everywhere next.
- **Team mode** — shared skills, shared memory, multiplayer workflows.
- **Skill marketplace** — publish and install skills from the community.

This is an alpha you can build on today and grow with tomorrow.

---

<p align="center">
<em>They have the budget and the polish.</em><br>
<em>We have the engine.</em>
</p>

<p align="center">
<a href="https://app.oios.io">Get Credentials</a> · <a href="https://github.com/VodouAI/OS/issues">Report Issues</a> · <a href="https://github.com/VodouAI/OS/releases">Releases</a>
</p>
