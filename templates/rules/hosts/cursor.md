target: .cursorrules
blocks: all
---
# Vodou - Cursor Integration

**Context:** `sessionStart` runs `vodou-hook-bin cursor-session` → JSON `additional_context` with the workspace bootstrap (USER, IDENTITY, MEMORY, SOUL, TOOLS) **once per Agent session**, ending with a `### context budget` line. Each prompt may refresh `.vodou/workspace/.cursor_context.json` via `sock prompt`. Before replying, read **`.cursor_context.json`** when you need prompt-targeted memories.

See **`AGENTS.md`** for the full Vodou operating manual. It is **not** inlined into your session (it never fit the bootstrap budget); read it with your file tool when a pointer sends you there. This file covers **Cursor-specific integration and the shared project policy** — the policy below is the same text Claude Code and every other host receives, generated from one source.
<!-- TAIL -->
## Cursor Memory Integration

1. **Session start**: `./vodou-hook-bin cursor-session` returns the workspace bootstrap as JSON `additional_context`.
2. **Each prompt**: the hook runs `./vodou-hook-bin sock prompt`. The daemon buffers the prompt, searches memories, **overwrites** `.vodou/workspace/.cursor_context.json` with lean per-prompt content (~1–3KB).
3. **Session end**: `sock flush` triggers full session memory extraction. Daily logs land in `.vodou/workspace/memory/YYYY-MM-DD.md`.
4. Base context (MEMORY, SOUL, etc.) comes from the bootstrap — not duplicated in `.cursor_context.json`.

- At start of first response, read `.vodou/workspace/.cursor_context.json` for prompt-targeted memories + agent insights. On first prompt the file may be empty or stale; proceed without it if missing.
- Auto-memory for this host persists at `.vodou/workspace/MEMORY.md` (rendered from memory.db).
