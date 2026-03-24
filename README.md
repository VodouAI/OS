<p align="center">
  <h1 align="center">Vodou OS</h1>
  <p align="center"><strong>The AI that gets smarter every day you use it.</strong></p>
  <p align="center">Local-first AI operating system with compound memory, deterministic skills, and parallel tool execution.<br>No cloud. No lock-in. No forgetting.</p>
</p>

---

Every AI tool you've used has the same problem: **it forgets everything.**

You explain your project. Your preferences. Your stack. Your team. Then you close the window and it's all gone. Next session? Start over. Every. Single. Time.

Claude Cowork? No memory between sessions. OpenClaw? Basic memory, no curation. Perplexity? Your data lives on their cloud.

**Vodou doesn't forget. And it runs entirely on your machine.**

---

## Why Vodou Wins

### Compound Memory
No one else has this. Vodou's memory system runs continuously — watching, extracting, curating. Important decisions get promoted automatically. After a week, it knows your coding style, your architecture preferences, your team conventions. After a month, it's a teammate who's been on the project since day one.

On **Monday** you mention your project uses Rust with SQLite and you never delete databases without backups. On **Thursday** you ask for help refactoring — Vodou writes Rust (not Python), keeps the PR small, and warns you before touching the database. **You didn't repeat yourself once.**

### 40+ Deterministic Skills
Other tools let an LLM guess what to do. Vodou's skills are **real workflows** — step-by-step pipelines with user control at every decision point. Code review, debugging, test-driven development, security audits, implementation planning — all built in, all repeatable. The AI is the voice. The skill is the brain.

Build your own skills in markdown. No code required. Share them with your team.

### 10 Parallel Tool Servers
While Claude Cowork screenshots your screen and guesses (72% accuracy, 30 seconds per action), Vodou calls tools directly via API — **99% accuracy, milliseconds.** CPU, memory, disk, and network — four checks in 800ms, all running in parallel.

Built-in servers for system monitoring, Slack integration, diagram generation, web browsing, file management, script execution, session management, and more. All running simultaneously.

### Your Virtual Assistant — That Actually Assists
Vodou isn't a chatbot you visit. It's an **AI operating system** that runs alongside your work:

- **Skills** are programs — reusable, shareable, version-controlled workflows
- **Tool servers** are like device drivers — connect to anything
- **Memory** is your filesystem — persistent, searchable, compounding
- **The scheduler** runs tasks in the background while you work
- **The web dashboard** at `localhost:8765` is your command center — chat, tools, skills, all in one place

It integrates with **Claude Code** and **Cursor** automatically via hooks. Your memory follows you between tools.

### Any Model. No Lock-In.
Claude, GPT-4, Ollama running locally, any OpenAI-compatible API. Switch anytime. Your data never leaves your machine. No $200/month cloud subscriptions. No vendor lock-in.

The big players lock you into their ecosystem. Vodou is the **Switzerland of AI** — neutral, local, yours.

---

## Install (macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/VodouAI/OS/main/install-vodou.sh | bash
```

60 seconds. Apple Silicon and Intel. Everything ships pre-built — no npm, no build steps.

<details>
<summary>Manual install</summary>

1. Download for your Mac:
   - **Apple Silicon** (M1/M2/M3/M4): [Download](https://github.com/VodouAI/OS/releases/download/v0.5.35/OI-v0.5.35-arm64.tar.gz)
   - **Intel**: [Download](https://github.com/VodouAI/OS/releases/download/v0.5.35/OI-v0.5.35-intel.tar.gz)

2. Extract and run:
   ```bash
   tar -xzf OI-v0.5.35-*.tar.gz && cd OI-v0.5.35-* && ./install-prebuilt.sh
   ```

3. Add credentials from [app.oios.io](https://app.oios.io):
   ```bash
   nano .env  # Add OI_TOKEN and OI_USER_ID
   ```

**Which Mac do I have?** Apple menu > "About This Mac". M1/M2/M3/M4 = Apple Silicon.
</details>

---

## Quick Start

```bash
./oi "hello"                  # meet vodou — the help center skill loads automatically
./oi "cpu memory disk"        # 4 tools fire in parallel, results in 800ms
./oi "deep think about X"     # extended reasoning with multi-model analysis
open http://localhost:8765     # web dashboard — chat, skills, tools, all in one
```

---

## The Stack

| Layer | What It Does | Examples |
|-------|-------------|----------|
| **Memory** | Compound intelligence that grows daily | Cross-session recall, preference learning, auto-curation |
| **Skills** | Deterministic expert workflows | Code review, TDD, debugging, security audit, implementation planning |
| **Tool Servers** | Parallel API execution | System monitor, Slack, diagrams, web browser, file ops, scripts |
| **Gateway** | Web dashboard + API | Chat UI, skill runner, tool forms, conversation history |
| **Router** | Intent matching + parameter extraction | Natural language in, structured tool calls out |

---

## How Vodou Compares

| | Vodou | Claude Cowork | OpenClaw | Perplexity Computer |
|---|---|---|---|---|
| **Memory** | Compound, cross-session, auto-curated | None | Basic, no curation | None |
| **Execution** | API-first, 800ms parallel | Screen clicking, 30s per action | Generic agent loop | Cloud-only |
| **Your data** | Never leaves your machine | On Anthropic's servers | Local but no memory | On their cloud |
| **Model lock-in** | Any model, switch anytime | Anthropic only | Any model | Perplexity only |
| **Workflows** | 40+ deterministic skills | LLM guessing | Generic nodes | No custom workflows |
| **Price** | Free + your API key | $200/mo | Free + API key | $200/mo |

---

## Troubleshooting

Installer hangs? Debug mode shows exactly where:
```bash
DEBUG=1 ./install-prebuilt.sh
```

---

<p align="center">
  <em>Built by one person competing against billion-dollar companies.</em><br>
  <em>They have the budget. We have the memory.</em>
</p>

<p align="center">
  <a href="https://app.oios.io">Get Credentials</a> · <a href="https://github.com/VodouAI/OS/issues">Report Issues</a>
</p>
