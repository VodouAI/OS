target: .github/copilot-instructions.md
blocks: 10,50,60,70
---
# Vodou - GitHub Copilot Integration

Copilot injects this file into **every** chat request, so it carries the resident subset of the project policy (tool priority, the parallel-session commit rules, the vendored-deps rule, the lane canon) rather than all nine blocks. The full set is in `CLAUDE.md` / `.cursorrules`; the manual is **`AGENTS.md`** — read it with your file tool, it is not inlined. Several agents share this ONE worktree concurrently; the commit rules below are why.
