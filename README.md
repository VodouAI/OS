<!-- Destination: VodouAI/OS → README.md. TODO(Chad): product voice pass + real demo GIF + confirmed links. -->

# Vodou

**Your memory, in every AI you use.** Ask ChatGPT "what's my dog's name" and it just
knows — because Vodou carries your own memory into any AI, so you never re-explain
yourself again.

<!-- TODO: demo GIF here — the "typed a question in ChatGPT, it answered with your context" moment -->

- 🧠 **Own your memory** — captured locally, on your machine, in your control
- ↔️ **Follows you everywhere** — ChatGPT, Claude, Gemini, Cursor, VS Code, Claude Desktop, and more
- 🔒 **Local-first & private** — your memory lives on-device; you decide what travels
- ⚙️ **Governed** — a config you control decides what's shared and what never leaves

## Open-core — what's open vs. proprietary (read this first)

Vodou is **open-core**, and we'd rather be upfront than have you find out later. The line
is simple: **everything except the engine is open.**

| | License | Where |
|---|---|---|
| **The whole client + orchestration stack** — gateway, all MCP servers, browser extension, skills, installers, docs | **MIT (open)** | this repo |
| **The engine** — the memory brain + retrieval (`vodou-core`), source **and** compiled binary | Proprietary, EULA | fetched as a signed binary from [`VodouAI/vodou-core`](https://github.com/VodouAI/vodou-core) |
| **Hosted cloud** (optional) | Commercial | app.vodou.ai |

**Why:** your memory pipeline runs **locally and free**; the engine binary + the hosted
layer are how we keep the lights on. Everything you can read and run around the engine is
genuinely open — yours to fork, extend, and contribute to.

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

Full docs: [docs/](docs/) · **Memory Follows You**: [docs/memory-follows-you.md](docs/memory-follows-you.md)

## Contributing

We'd love your help on the open surface — new capture adapters, skills, client fixes, docs.
See **[CONTRIBUTING.md](CONTRIBUTING.md)** (we use DCO sign-off, not a CLA) and the
**[good first issues](https://github.com/VodouAI/OS/labels/good%20first%20issue)**.

## Community

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md) — please report vulnerabilities privately
- Questions → GitHub Discussions

## License

This repo is **MIT** — see [LICENSE](LICENSE). The Vodou engine binary is proprietary and
governed by its [EULA](https://github.com/VodouAI/vodou-core/blob/main/EULA.md).
