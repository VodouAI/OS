## Auto-memory

Four memory types: **user** (preferences, role), **feedback** (rules with Why + How to apply), **project** (in-flight work), **reference** (external system pointers). Daily incremental logs: `memory/YYYY-MM-DD.md`. Extraction runs every prompt via the prompt hook.

**Don't save** code patterns, git history, ephemeral task state, or anything already in `AGENTS.md`. `MEMORY.md` is **rendered from memory.db** each session — edits to the rendered file are overwritten; pin a memory instead (`vodou-core mem pin`).
