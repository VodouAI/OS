<h1 align="center">Vodou OS</h1>
<p align="center"><strong>Stop renting AI. Build your own.</strong></p>

---

Every AI assistant you use belongs to someone else.

Claude works the way Anthropic designed it. ChatGPT works the way OpenAI designed it. You can't change how they think, what they remember, or how they work. And every time you close the window — gone. Start over. Re-explain everything. Again.

**Vodou is the first AI assistant you actually own.** It runs on your machine. It remembers everything. And you customize it exactly how you want — your workflows, your tools, your rules.

---

## It Remembers

Week one, you mention your project uses Rust with SQLite. You prefer short PRs. You never delete a database without a backup.

Week two, you ask for help with a migration. Vodou writes Rust — not Python. Keeps the PR small. Warns you before touching the database.

**You didn't repeat yourself once.**

Vodou's memory runs continuously in the background. It watches, extracts what matters, and curates it automatically — promoting important decisions, filtering noise, compounding knowledge. While you sleep, it's organizing everything from yesterday so it's ready for tomorrow.

No other AI tool does this. Claude Cowork explicitly says "Memory doesn't work with Cowork yet." OpenClaw has no curation. Vodou's memory is the reason switching back to generic AI feels like going from a smartphone to a sticky note.

---

## It Does Real Work

Type `oi debug`.

A structured debugging workflow loads. It asks you to describe the symptom. Then it walks you through systematic isolation — checking logs, checking system resources, checking recent changes. At each step, **you** decide what to investigate next. Not the AI. You.

It calls real tools to get real data. Not screenshots. Not guessing. Structured results in milliseconds.

Type `oi cpu memory disk`.

Three tool servers fire **simultaneously**. In 800ms you see: CPU at 21% across 10 cores. RAM at 80%, 12.8GB of 16GB. Disk at 78%, 199GB free. Real numbers. Instant. While other tools spend 30 seconds screenshotting Activity Monitor and trying to read the text.

This isn't faster. It's a fundamentally different way of working.

---

## You Shape It

Here's where it gets interesting.

You know that debugging checklist you explain to every new hire? That deployment runbook? That code review guide? **Write it in markdown.** Add stopping points where humans make decisions. Vodou turns it into an interactive expert workflow that anyone on your team can run.

```
oi code-review     → structured security + quality audit with decisions at every step
oi plan            → implementation planning with architecture trade-offs
oi deep-think      → extended multi-model analysis on any topic
```

No code. No SDK. No API. Just a markdown file that becomes a live, repeatable workflow.

**Your expertise, scaled infinitely.**

And it doesn't stop at skills. Connect any MCP tool server from the growing ecosystem — thousands exist. Plug in Slack, GitHub, databases, monitoring, anything with an API. Use any AI model — Claude for deep reasoning, GPT-4 for speed, Ollama running locally when you're on a plane. Switch mid-conversation. Your skills work with all of them because **the skill is the workflow, not the model.**

Your Vodou doesn't look like anyone else's. That's the point.

---

## No Limits. No Fees. No Lock-In.

No monthly token budget. No credit system. No pay-per-query. No $200/month subscription.

Install it. It's yours. Build as many skills as you want. Connect as many tools as you want. Use it as much as you want. The only cost is your own API key — which you're already paying for.

The big players charge you to rent their AI. Vodou is free because **you** are the platform.

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/VodouAI/OS/main/install-vodou.sh | bash
```

60 seconds. Works on Apple Silicon and Intel. Everything ships pre-built.

<details>
<summary>Manual install</summary>

Download for your Mac:
- **Apple Silicon** (M1/M2/M3/M4): [Download](https://github.com/VodouAI/OS/releases/download/v0.5.35/OI-v0.5.35-arm64.tar.gz)
- **Intel**: [Download](https://github.com/VodouAI/OS/releases/download/v0.5.35/OI-v0.5.35-intel.tar.gz)

```bash
tar -xzf OI-v0.5.35-*.tar.gz && cd OI-v0.5.35-* && ./install-prebuilt.sh
```

Add credentials from [app.oios.io](https://app.oios.io):
```bash
nano .env  # Add OI_TOKEN and OI_USER_ID
```

**Which Mac?** Apple menu > "About This Mac." M1/M2/M3/M4 = Apple Silicon.
</details>

---

## What's Inside

**Memory** — compound intelligence that grows daily. Cross-session recall, preference learning, automatic curation while you sleep.

**Skills** — expert workflows you build in markdown. Code review, debugging, TDD, security audits, implementation planning — built in. Build your own in minutes.

**Tools** — parallel execution across system monitoring, Slack, diagrams, web browsing, file management, scripts, image generation, and more. All at once.

**Dashboard** — web UI at `localhost:8765`. Chat, skills, tools, drag-and-drop files, voice input, conversation tabs that survive restarts. Like ChatGPT but local and with superpowers.

**Automation** — scheduled tasks, file watchers, memory curation. Vodou works while you don't.

**IDE Integration** — hooks into Claude Code and Cursor automatically. Memory follows you between tools.

---

## Troubleshooting

Installer hangs? Debug mode shows exactly where:
```bash
DEBUG=1 ./install-prebuilt.sh
```

---

<p align="center">
<em>Built by one person competing against billion-dollar companies.</em><br>
<em>They have the budget. We have the memory.</em><br>
<em>And you can build yours too.</em>
</p>

<p align="center">
<a href="https://app.oios.io">Get Credentials</a> · <a href="https://github.com/VodouAI/OS/issues">Report Issues</a>
</p>
