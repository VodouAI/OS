<!-- Destination: VodouAI/OS → README.md. TODO(Chad): real demo GIF. -->

# Vodou

**Your memory, in every AI you use.** Ask ChatGPT "what's my dog's name" and it just
knows — because Vodou carries your own memory into any AI, so you never re-explain
yourself again.

<!-- TODO: demo GIF here — the "typed a question in ChatGPT, it answered with your context" moment -->

- 🧠 **Own your memory** — captured locally, on your machine, in your control
- ↔️ **Follows you everywhere** — ChatGPT, Claude, Gemini, Cursor, VS Code, Claude Desktop, and more
- 🔒 **Local-first & private** — your memory lives on-device; you decide what travels
- ⚙️ **Governed** — a config you control decides what's shared and what never leaves

## And memory is the foundation, not the whole thing

Once your machine holds the context, the useful part is what it can *do* with it. Vodou is
also the runtime around that memory: your models, your tools, your automations — all reading
from the same brain, all running locally.

### 🧠 Memory that actually knows you
Captured from the AI chats you already have, plus a **Document Library** — add a PDF,
contract, spec, spreadsheet or folder and Vodou reads it, remembers it, and can tell you
*which* document answers a question. Contradictions get flagged instead of silently
averaged. Memory is scoped per project, and vaults keep work and personal separate.

### 🔌 Every AI client can adopt your brain
Vodou is an **MCP host**: Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Zed or a
script you wrote this morning can attach and inherit your memory, your skills, and every
tool you've connected — with **per-client identity, scoped permissions, an audit log, and a
kill switch**. There's also an **OpenAI-compatible endpoint** (`POST /v1/chat/completions`),
so anything that speaks OpenAI can use Vodou as its backend and get your context for free.

### 🧩 Connect the apps you already use
Notion, Linear, Gmail, Slack, Microsoft 365, Stripe, Figma, Cloudflare and more attach over
MCP. Their tools become callable from chat, from a scoped workbench, from scheduled tasks —
anywhere in Vodou.

### ⚡ Automations — trigger → action, on your own tools
Event-driven flows that chain tool calls across connected apps. *If IFTTT and Zapier had a
self-hosted cousin that spoke MCP, this would be it* — except the trigger and the actions
are tools on **your** servers, running on **your** machine.

### 💬 Reach it from anywhere
Slack, Telegram, Discord, WhatsApp, Signal, iMessage, Teams, Google Chat, voice, or the
local web console. Same brain, same tools, whichever surface you're on.

### 🤖 Skills and a task board
Reusable procedures Vodou follows step by step, and a multi-agent board where workers pick
up tasks, report progress, and hand results back.

### 🔀 Bring your own model — or run it locally
OpenAI, Anthropic, Google, Groq, Mistral, DeepSeek, Together, xAI, Fireworks, OpenRouter,
Kimi and more via your own keys — or **no key at all**: llama.cpp ships with Vodou, and
LM Studio and Ollama are one setting away. Routing is per-task, so a cheap local model can
do the janitorial work while a frontier model handles the hard question.

## Open-core — what's open vs. proprietary (read this first)

Vodou is **open-core**, and we'd rather be upfront than have you find out later. The line
is simple: **everything except the engine is open.**

| | License | Where |
|---|---|---|
| **The whole client + orchestration stack** — gateway, all MCP servers, browser extension, skills, installers, docs | **Apache-2.0 (open)** | this repo |
| **The engine** — the memory brain + retrieval (`vodou-core`), source **and** compiled binary | Proprietary, EULA | fetched as a signed binary from [`VodouAI/vodou-core`](https://github.com/VodouAI/vodou-core) |
| **Hosted cloud** (optional) | Commercial | app.vodou.ai |

**Why:** your memory pipeline runs **locally and free**; the engine binary + the hosted
layer are how we keep the lights on. Everything you can read and run around the engine is
genuinely open — yours to fork, extend, and contribute to. Preserve `NOTICE` when you
redistribute.

## Quickstart (~10 minutes)

**macOS (Apple Silicon or Intel) · Linux (x64 or arm64):**
```bash
curl -fsSL https://raw.githubusercontent.com/VodouAI/OS/main/install-vodou.sh | bash
```

**Windows (x64, beta):**
```powershell
irm https://raw.githubusercontent.com/VodouAI/OS/main/install-vodou.ps1 | iex
```

The installer clones this open tree, then downloads the **matching engine binary for your
platform** from [`VodouAI/vodou-core`](https://github.com/VodouAI/vodou-core/releases),
**verifies its SHA-256** against the release manifest (and refuses to run on a mismatch),
provisions the runtime, and starts Vodou. Then install the browser extension and try it:
open ChatGPT and ask it something about yourself.

> **Platform notes.** macOS + Linux are the primary targets. Windows is **beta** — the
> engine is unsigned (SmartScreen will warn) and the installer is still being hardened; if
> you hit a snag, please open an issue. Pin a version with `VODOU_VERSION=x.y.z` (bash) or
> `$env:VODOU_VERSION="x.y.z"` (PowerShell).

> **Alpha.** Vodou is under active development and moving fast. Expect rough edges, and
> please report them — issues from real use are the most valuable thing you can send us.

## Where to go next

| If you want to… | Read |
|---|---|
| Understand memory across tools | [docs/memory-follows-you.md](docs/memory-follows-you.md) |
| Attach Claude Desktop / Cursor / VS Code | [docs/mcp-host.md](docs/mcp-host.md) |
| Use Vodou as an OpenAI-compatible backend | [docs/openai-compatible-api.md](docs/openai-compatible-api.md) |
| Connect Notion, Linear, Stripe, … | [docs/vodou-apps.md](docs/vodou-apps.md) |
| Build trigger → action flows | [docs/vodou-automations.md](docs/vodou-automations.md) |
| Reach Vodou from Slack, Telegram, … | [docs/messaging.md](docs/messaging.md) |
| Write a skill | [docs/skills.md](docs/skills.md) |
| Run the multi-agent board | [docs/board-tutorial.md](docs/board-tutorial.md) |
| Use the CLI | [docs/vodou-cli.md](docs/vodou-cli.md) |
| Everything else | [docs/](docs/) · [CHANGELOG.md](CHANGELOG.md) |

## Contributing

We'd love your help on the open surface — new capture adapters, skills, client fixes, docs.
See **[CONTRIBUTING.md](CONTRIBUTING.md)** (we use a lightweight **CLA**, not DCO) and the
**[good first issues](https://github.com/VodouAI/OS/labels/good%20first%20issue)**.

## Community

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md) — please report vulnerabilities privately
- Questions → GitHub Discussions

## License

This repo is **Apache License 2.0** — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
The Vodou engine binary is proprietary and governed by its
[EULA](https://github.com/VodouAI/vodou-core/blob/main/EULA.md).
