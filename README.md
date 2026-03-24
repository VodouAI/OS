<h1 align="center">Vodou</h1>
<p align="center"><strong>Stop renting AI. Build your own.</strong></p>
<p align="center">
<a href="#install">Install</a> · <a href="https://app.oios.io">Get Credentials</a> · <a href="https://github.com/VodouAI/OS/issues">Report Issues</a>
</p>

---

Every AI assistant you use belongs to someone else.

Claude Cowork works the way Anthropic designed it. OpenClaw works the way its community happens to push it. You can't change how they think, what they remember, or how they work. And when the window closes — gone. Start over. Re-explain everything. Again.

**Vodou is the first AI assistant you actually own.** It runs on your machine. It remembers everything. And you shape it exactly how you want — your workflows, your tools, your rules.

> **Alpha release** — early software, small team. Rough edges exist. We ship fast and fix fast.

---

## It Remembers

Week one, you mention your project uses Rust with SQLite. You prefer short PRs. You never delete a database without a backup.

Week two, you ask for help with a migration. Vodou writes Rust — not Python. Keeps the PR small. Warns you before touching the database.

**You didn't repeat yourself once.**

Vodou's memory runs continuously in the background — a daemon that watches, extracts what matters, and curates automatically. It promotes important decisions, filters noise, and compounds knowledge while you sleep. Hybrid search (full-text + vector embeddings) means it finds the right memory whether you remember the exact words or not.

Claude Cowork explicitly says "Memory doesn't work with Cowork yet." OpenClaw has no curation — it dumps everything and hopes for the best. Vodou's memory is the reason switching back to generic AI feels like going from a smartphone to a sticky note.

---

## It Does Real Work

```
oi "cpu memory disk"
```

Three MCP tool servers fire **simultaneously**. In under a second: CPU at 21% across 10 cores. RAM at 80%, 12.8GB of 16GB. Disk at 78%, 199GB free. Real system calls returning real data — not an LLM guessing from a screenshot.

```
oi "debug my app"
```

A structured debugging skill loads. It walks you through systematic isolation — logs, resources, recent changes. At each step, **you** decide what to investigate next. Not the AI. You. It calls real tools to get real data, and you stay in control at every decision point.

This isn't faster. It's a fundamentally different way of working.

---

## You Shape It

That debugging checklist you explain to every new hire? That deployment runbook? That code review guide? **Write it in markdown.** Add stopping points where humans make decisions. Vodou turns it into an interactive expert workflow that anyone can run.

```
oi "code review"     → structured security + quality audit with decisions at every step
oi "plan"            → implementation planning with architecture trade-offs
oi "deep think"      → extended multi-model analysis on any topic
```

No code. No SDK. No API. Just a markdown file that becomes a live, repeatable workflow. **Your expertise, scaled infinitely.**

Connect any MCP tool server from the growing ecosystem — thousands exist. Plug in Slack, GitHub, databases, monitoring, anything with an API. Use any AI model — Claude, GPT-4, Ollama running locally when you're on a plane. Switch mid-conversation. Your skills work with all of them because **the skill is the workflow, not the model.**

Your Vodou doesn't look like anyone else's. That's the point.

---

## Why Not Cowork or OpenClaw?

| | **Claude Cowork** | **OpenClaw** | **Vodou** |
|---|---|---|---|
| **Memory** | "Doesn't work with Cowork yet" | No curation — raw dump | Compound memory with automatic curation, hybrid search |
| **Who owns it** | Anthropic | Community (you hope) | You |
| **Security** | Enterprise-grade but cloud-dependent | Cisco found data exfiltration through third-party skills | Local-first. Skills are markdown files you control |
| **Workflows** | Whatever the model decides | AgentSkills with no safety rails | Engine-enforced stopping points — AI executes, you decide |
| **Models** | Claude only | Multi-model | Multi-model — Claude, GPT-4, Ollama, any OpenAI-compatible |
| **Execution** | Sequential | Sequential | Parallel — 5-10 tools simultaneously |
| **Where it lives** | Desktop app | WhatsApp, Discord, Telegram | Your code editor (Claude Code / Cursor) + web dashboard |
| **Cost** | $20-200/mo subscription | Free (but you're the product) | Free. Bring your own API key |

Cowork has Anthropic's resources. OpenClaw has 100K GitHub stars. We have compound memory and workflows that actually stay under your control.

---

## How It Works

Vodou is a **triple-layer intelligence system** built in Rust:

```
┌─────────────────────────────────────────────┐
│  Your Editor (Claude Code / Cursor)         │
├─────────────────────────────────────────────┤
│  Layer 1: Skills                            │
│  Expert workflows in markdown with          │
│  stopping points for human decisions        │
├─────────────────────────────────────────────┤
│  Layer 2: MCP Tools                         │
│  15+ servers, 60+ tools, parallel           │
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
| **Editor** | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Cursor](https://cursor.sh) |
| **Node.js** | v20+ (installer will install v22 if missing) |
| **AI Provider** | Anthropic API key, Claude CLI (free with Max subscription), OpenAI, or Ollama for local models |
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

Open `~/vodou` in Claude Code or Cursor. Vodou hooks in automatically — memory, skills, and tools start working immediately.

**3. Try it**

```bash
oi "hello"                    # Introduction and system check
oi "cpu memory disk"          # Parallel system monitoring
oi "deep think about X"       # Extended reasoning on any topic
oi "list skills"              # See all 40+ available skills
```

**4. Open the dashboard**

[localhost:8765](http://localhost:8765) — chat interface with conversation tabs, voice input, skill execution, drag-and-drop files, and MCP tool forms. Like ChatGPT but local, with your memory and your tools.

---

## What's Inside

### Memory
Hybrid search combining full-text (BM25) and 384-dimensional vector embeddings. Background daemon extracts, curates, and promotes knowledge automatically. Cross-session recall means you explain things once.

### Skills (40+)
Expert workflows in markdown with interactive stopping points. Debugging, code review, security audits, TDD, implementation planning, deep thinking — built in. Create your own in minutes.

### MCP Tools (60+)
System monitoring, Slack, diagrams, browser automation, file management, image generation, script execution, and more. All execute in parallel through a connection pool — 3-7x faster than sequential.

### Web Dashboard
PWA at `localhost:8765`. Installable as a standalone app with Dock icon. Chat tabs that survive restarts, inline tool rendering, voice input, command palette (Cmd+K).

### Multi-Model
Claude, GPT-4, Ollama, or any OpenAI-compatible provider. Switch mid-conversation. Skills work across all of them because the skill controls the workflow — not the model.

### Automation
Cron-based scheduler, background memory curation, file watchers. Vodou works while you don't.

---

## Build Your Own Skills

A skill is a markdown file:

```markdown
---
name: my-runbook
description: Production deployment checklist
version: 1.0.0
required_tools:
  - OI-script-executor
---

# Production Deploy

## Overview
Step-by-step deployment with safety checks at every stage.

## STOPPING POINT 1 — Pre-deploy checks
1. Run full test suite
2. Check staging environment
3. Skip to deploy (I already verified)

## STOPPING POINT 2 — Deploy strategy
1. Rolling deploy (zero downtime)
2. Blue-green switch
3. Canary (10% traffic first)
```

Drop it in `skills/my-skills/`, register it, and it's live. The AI executes — but at every stopping point, **you** decide.

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

## Project Status

Vodou is in **alpha**. The core is ~49,000 lines of Rust with 60+ database migrations, 15+ MCP servers, 40+ skills, and a hybrid memory system. It works. It's also early.

- Things will break. We fix fast.
- Skill formats and APIs may change between versions.
- Linux and Windows support are on the roadmap.
- We'd rather ship something real than polish something theoretical.

---

<p align="center">
<em>They have the budget. We have the memory.</em>
</p>

<p align="center">
<a href="https://app.oios.io">Get Credentials</a> · <a href="https://github.com/VodouAI/OS/issues">Report Issues</a> · <a href="https://github.com/VodouAI/OS/releases">Releases</a>
</p>
