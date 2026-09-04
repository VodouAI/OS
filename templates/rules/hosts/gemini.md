target: GEMINI.md
blocks: all
---
# Vodou - Gemini CLI Integration

See **`AGENTS.md`** for the full Vodou operating manual: subsystem map, Layer 1/2/3 architecture, memory model, scheduler, work logging format, security defaults, and boundaries. Read it with your file tool when you need it; it is not inlined. This file carries the shared project policy every agent in this worktree follows.

## Scope of this file

**This file applies to Gemini CLI** working in this repository. The `./vodou-core call <server> <tool>` primitive, the commit rules and the lane canon below apply exactly as they do for every other host — several agents share this ONE worktree concurrently.
