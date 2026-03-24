# Vodou OS

**Your AI that actually remembers you.**

Vodou is a local AI system that runs on your Mac. It connects to any AI model (Claude, GPT, Ollama, etc.), remembers everything across sessions, and gets smarter the more you use it.

No cloud. No subscriptions. Your data stays on your machine.

---

## What Makes Vodou Different

**It remembers.** Other AI tools start fresh every conversation. Vodou remembers your preferences, your projects, your decisions — and uses them automatically next time.

**It's fast.** Vodou calls tools via API, not by clicking your screen. 4 system checks in 800ms, not 30 seconds of screenshot-and-guess.

**It's yours.** Pick any AI model. Switch anytime. Your data never leaves your laptop.

**It's composable.** 40+ built-in skills, 10 MCP tool servers, background automation. Build your own skills in markdown — no code required.

---

## Install (macOS)

### Option 1: One-liner

```bash
curl -fsSL https://raw.githubusercontent.com/VodouAI/OS/main/install-vodou.sh | bash
```

### Option 2: Manual download

1. Download the right version for your Mac:
   - **Apple Silicon** (M1/M2/M3/M4): [OI-v0.5.35-arm64.tar.gz](https://github.com/VodouAI/OS/releases/download/v0.5.35/OI-v0.5.35-arm64.tar.gz)
   - **Intel Mac**: [OI-v0.5.35-intel.tar.gz](https://github.com/VodouAI/OS/releases/download/v0.5.35/OI-v0.5.35-intel.tar.gz)

2. Extract and install:
```bash
tar -xzf OI-v0.5.35-*.tar.gz
cd OI-v0.5.35-*
./install.sh
```

3. Add your credentials:
```bash
nano .env
# Add your OI_TOKEN and OI_USER_ID from https://app.oios.io
```

4. Test it:
```bash
./oi "hello"
```

**Not sure which Mac you have?** Click the Apple menu > "About This Mac". If it says M1, M2, M3, or M4 — download **Apple Silicon**. If it says Intel — download **Intel**.

---

## What You Get

| Feature | What It Does |
|---------|-------------|
| **Memory** | Remembers your preferences, decisions, and context across every session |
| **40+ Skills** | Pre-built workflows for coding, debugging, testing, planning, and more |
| **10 Tool Servers** | System monitoring, file management, web browsing, Slack, diagrams, and more |
| **Web Dashboard** | Chat UI at `http://localhost:8765` — works like ChatGPT but local |
| **Multi-Model** | Works with Claude, GPT-4, Ollama, or any OpenAI-compatible API |
| **Background Automation** | Scheduled tasks, file watchers, automatic memory curation |

---

## Quick Start

After installing, try these:

```bash
# Get system info (CPU, memory, disk — all at once)
./oi "cpu memory disk"

# Ask for help
./oi "hello"

# Open the web dashboard
open http://localhost:8765
```

---

## Works With

- **Claude Code** (Anthropic) — hooks integrate automatically
- **Cursor** — hooks integrate automatically
- **Any terminal** — `./oi "your question"`
- **Web browser** — dashboard at `http://localhost:8765`

---

## Requirements

- macOS 13+ (Ventura or newer)
- Node.js 20+ (installer will set this up if you don't have it)
- ~500MB disk space

---

## Troubleshooting

**Installer freezes?** Run with debug mode:
```bash
DEBUG=1 ./install.sh
```

**Architecture mismatch error?** You downloaded the wrong version. Check Apple menu > "About This Mac" to see if you have Apple Silicon or Intel.

**Services won't start?** Run with debug mode:
```bash
DEBUG=1 ./start-OI-services.sh
```

---

## Links

- **Get credentials:** https://app.oios.io
- **Issues:** https://github.com/VodouAI/OS/issues

---

*Built by one person who got tired of AI that forgets everything.*
