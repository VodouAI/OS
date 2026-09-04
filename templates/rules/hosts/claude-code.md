target: CLAUDE.md
blocks: all
---
# Vodou - Claude Code Integration

See **`AGENTS.md`** for the full Vodou operating manual: subsystem map (Vodou-Console, Vodou-Board, Vodou-channels, Vodou-Recall, Vodou-Enhanced-Thinking, etc.), Layer 1/2/3 architecture, memory model, scheduler, work logging format, security defaults, and boundaries. It is **not** inlined into your session context (44 KB against a 24 KB budget — it never was, and the bootstrap now says so); read it with your file tool when you need it. This file covers **Claude Code-specific integration and the shared project policy**.

## Scope of this file

**This file applies to Claude Code** — the developer CLI running in a user's terminal/IDE alongside their code. It does **not** apply to the Claude CLI subprocess that the gateway spawns to answer web-chat messages. That subprocess follows `AGENTS.md` §6.5 (mid-turn shell-outs allowed, 3 per turn cap, supervised path). If you are the gateway-chat LLM, read this file as context but defer to AGENTS.md §6.5 for tool-execution behavior.
<!-- TAIL -->
## Claude Code Hooks

Hooks use `vodou-hook-bin` — a zero-thread, ~400KB binary that talks to the daemon via Unix socket; never opens the DB directly.

- **SessionStart**: `./vodou-hook-bin startup` (TTY) or `./vodou-hook-bin cursor-session` (JSON `{"additional_context":"…"}` for IDE hooks). Returns the workspace bootstrap, ending with a `### context budget` line that names anything evicted.
- **UserPromptSubmit**: `./vodou-hook-bin sock prompt` — sends prompt to daemon for memory search, falls back to buffering if daemon is down.
- **SessionEnd**: `./vodou-hook-bin sock flush` — triggers full session memory extraction via daemon.

## Claude Code Memory (auto-memory)

Project-local memory path: `.claude/projects/<project-hash>/memory/MEMORY.md`. MEMORY.md is dual-injected: once via Vodou workspace bootstrap (AGENTS.md context), once via Claude Code's own auto-memory system — that's intentional. See the system prompt's `# auto memory` block for the full rules.
