# Vodou - Claude Code Integration

See **`AGENTS.md`** (loaded via workspace bootstrap) for the full Vodou operating manual: subsystem map (Vodou-Console, Vodou-Board, Vodou-channels, Vodou-Recall, Vodou-Enhanced-Thinking, etc.), Layer 1/2/3 architecture, memory model, scheduler, work logging format, security defaults, and boundaries. This file covers **Claude Code-specific integration only** — for everything else, read `AGENTS.md`.

## Scope of this file

**This file applies to Claude Code** — the developer CLI running in a user's terminal/IDE alongside their code. It does **not** apply to the Claude CLI subprocess that the gateway spawns to answer web-chat messages. That subprocess follows `AGENTS.md` §6.5 (mid-turn shell-outs allowed, 3 per turn cap, supervised path). If you are the gateway-chat LLM, read this file as context but defer to AGENTS.md §6.5 for tool-execution behavior.

## Vodou Execution from Claude Code

`./do` is Vodou's user-facing launcher. **Prefer `./vodou-core call <server> <tool> '<json-args>'` from Claude Code** — it's deterministic, single-spawn, returns clean JSON, and is the right primitive for an agent helping you code.

`./do` and `./vodou-core brain "..."` DO work headlessly (no TTY gate triggers in current code, verified 2026-05-15). The real concern is **process accumulation during rapid loops**: if Claude Code spawns brain/do dozens of times in a debug session, you can hit the 425-process incident in memory. Single calls are fine. Loops are not.

If the user types `do "<text>"` in chat expecting the launcher to run:
- For a known tool: `./vodou-core call <server> <tool> '<json-args>'` — same effect, no spawn-loop hazard.
- For an ambiguous query needing BrainLoader routing: it's safe to run `./do "..."` once. If you're tempted to run it three or more times in a turn to test/verify/refine, stop and either ask the user to run it interactively or use targeted `vodou-core call` instead.
- For a question *about* a command (not a request to run it): just answer.

`./oi` and `./vodou` are copies of `./do`. Same rules apply.

## Tool Priority — Vodou Always Wins

**STRICT ORDER. Never deviate.**

1. **Vodou Skills** (Layer 1) — if a skill is returned, follow it completely
2. **Vodou intent_mappings** — before touching ANY other tool, check if Vodou has it:
   ```bash
   sqlite3 vodou-core.db "SELECT keyword, server_name, tool_name FROM intent_mappings WHERE keyword LIKE '%X%' LIMIT 5;"
   ```
   If a match exists → `./vodou-core call <server> <tool> '<args>'`. Done.
3. **Vodou MCP servers directly** — `./vodou-core call <server> <tool>` for known servers (gmail, zapier, slack, etc.)
4. **`mcp__claude_ai_*` deferred tools** — **LAST RESORT ONLY.** Only use these when Vodou has zero coverage. Never reach for `mcp__claude_ai_Gmail__*`, `mcp__claude_ai_Google_*`, or any other claude.ai connector if Vodou has the capability. Vodou ALWAYS has priority.

If the UserPromptSubmit hook surfaces a `### Vodou Intent Match` block, **use that route immediately** — no deliberation needed.

## Skills Are Layer 1 — They Always Come First

When Vodou routes a query to a skill, the skill takes absolute priority. You are its **executor**, not a substitute. Canonical rules and the full stopping-point checklist live in `AGENTS.md` under "Skills Are Layer 1". Short version:

- If a skill is returned, **follow it** — don't answer the question yourself.
- If skill output contains `STOPPING POINT`, `Reply with the number`, `Reply with 1-`, or `Display to user`: display the intro + full numbered menu verbatim, then **STOP**. Wait for the user's choice. Never assume.
- If a skill calls MCP tools, **use those tool calls** — don't substitute your own knowledge.
- Execute steps in order, never skip or combine.

## Agent Instructions & AGENT_ACTIONS

Skills can embed executable tool sequences as `<!-- AGENT_ACTIONS_N: {...} -->` HTML comments. Full spec (template variables, `loop`, `capture`, `stream_progress`) lives in `AGENTS.md` §6. Short form:

1. **Vodou-Console web chat**: the gateway's workflow driver handles execution automatically — you just format results.
2. **Claude Code / Cursor**: parse the AGENT_ACTIONS JSON and execute each step via `./vodou-core call <server> <tool> '<args>'`.

If Vodou output contains `## Agent instructions` (human-readable) or `AGENT_ACTIONS:` (inline JSON), execute those steps before replying. If `.vodou/workspace/agent_next_steps.json` exists at turn start, run those actions, then respond.

### MCP Tool Calls Are Mandatory — Never Fake Data

When AGENT_ACTIONS or a skill says to call MCP tools, you MUST execute ALL of them via `./vodou-core call <server> <tool>` BEFORE responding. Never substitute LLM knowledge for live data. Users need real numbers, not approximations.

### Running Vodou commands from Claude Code (this terminal)

**The right primitive is `./vodou-core call <server> <tool> '<json-args>'`** — deterministic, single-spawn, no subprocess tree, returns clean JSON. Use this for every tool execution you'd otherwise reach for brain/do.

`./vodou-core brain "..."` and `./do "..."` will work headlessly (the older TTY-gate doesn't trigger in current code, verified 2026-05-15 with `echo "" | ./vodou-core brain "test"`), but **they spawn the full BrainLoader subprocess tree**, and in rapid loops have historically built up to 100s of orphan processes requiring a reboot. So:

- ✅ One-shot brain/do calls are fine.
- ❌ Don't loop them, don't poll them, don't use them inside retry logic.
- ❌ Don't run `--version` to check the binary — read `Cargo.toml` `[package].version` instead.
- ❌ Don't poke the worker from here — ask the user to run it interactively.

(The `AGENTS.md` §6.5 mid-turn shell-outs apply to the LLM running *inside the gateway chat* — a different process context with its own supervision and a 3-call cap. The guidance above is the Claude-Code-specific version of the same idea: occasional brain/do is fine, loops are not.)

## Claude Code Hooks

Hooks use `vodou-hook-bin` — a zero-thread, ~400KB binary that talks to the daemon via Unix socket; never opens the DB directly.

- **SessionStart**: `./vodou-hook-bin startup` (TTY) or `./vodou-hook-bin cursor-session` (JSON `{"additional_context":"…"}` for IDE hooks). Returns the workspace bootstrap.
- **UserPromptSubmit**: `./vodou-hook-bin sock prompt` — sends prompt to daemon for memory search, falls back to buffering if daemon is down.
- **SessionEnd**: `./vodou-hook-bin sock flush` — triggers full session memory extraction via daemon.

## Claude Code Memory (auto-memory)

Project-local memory path: `.claude/projects/<project-hash>/memory/MEMORY.md`. MEMORY.md is dual-injected: once via Vodou workspace bootstrap (AGENTS.md context), once via Claude Code's own auto-memory system — that's intentional.

Four memory types (see system prompt's `# auto memory` block for full rules): **user** (preferences, role), **feedback** (rules with Why + How to apply), **project** (in-flight work), **reference** (external system pointers). Daily incremental logs: `memory/YYYY-MM-DD.md`. Extraction runs every prompt via UserPromptSubmit.

**Don't save** code patterns, git history, ephemeral task state, or anything already in `AGENTS.md`.

## Helper scripts you should know about

- `./do "<query>"` — primary entry point for any task.
- `./vodou-core call <server> <tool> '<json-args>'` — direct MCP tool call when you need headless execution.
- `./vodou-core mem search "<query>" [--top-k N] [--json]` — hybrid FTS5+vector search over `memory.db` chunks via the daemon socket (same pipeline BrainLoader uses). Use this instead of raw `sqlite3 memory.db "... MATCH ..."` — raw FTS5 skips the reranker and scope boost. Distinct from Vodou-Recall (which searches chat turns, not memory chunks).
- `./open-gateway.sh` — re-open the web UI in the browser without restarting services. Tell the user this when they close the tab.
- `./start-vodou-services.sh` — boots daemon + worker + Vodou-Console. Honors `VODOU_OPEN_BROWSER=1` (force-open) and `VODOU_NO_OPEN_BROWSER=1` (suppress; used by SessionStart hooks).
- `./stop-vodou-services.sh` — clean teardown via launchd bootout + targeted PID kills.

## MCP server dependencies — never npm-install by package name

Servers under `MCP-servers/` ship prebuilt `node_modules/`. Some deps are **vendored, not on npm**: `@vodou/*` packages (e.g. `@vodou/channel-sdk`) are `file:` links into a `packages/` dir inside the same server — a registry 404 for them is expected, not evidence they're lost. Never run `npm install <package-name>` inside an `MCP-servers/*` dir; naming a package forces a registry lookup and npm can prune the vendored link while failing. To repair `ERR_MODULE_NOT_FOUND`: a **plain** `npm install` (no name) in that server's directory — the lockfile relinks vendored deps locally. Full rules: `AGENTS.md` §Troubleshooting.

## Committing from parallel sessions

Multiple agent sessions work in this ONE worktree concurrently. Two incidents on 2026-07-04: a commit swept another session's edited `src/main.rs` (with a `mod` pointing at a not-yet-committed file — HEAD didn't compile from a fresh checkout), and a hot file was rewritten under a session mid-edit. Rules:

1. **Stage explicit paths only.** Never `git add -A`, `git add -u`, or `git add .` — you WILL sweep another session's in-flight work.
2. **Before staging a shared hot file** (`src/main.rs`, `src/daemon.rs`, `MCP-servers/Vodou-Console/src/llm.ts`, `vodou-hook/src/main.rs`), run `git diff <file>` and look for hunks you didn't author. If you find any, stage only your hunks (write a filtered patch → `git apply --cached`), and say so in the commit message.
3. **A `pre-commit` guard blocks self-inconsistent commits** (staged `mod foo;` / relative TS import whose target file isn't in the index). If it fires, the fix is almost always "stage the missing file too" or "your staged copy contains someone else's declaration — unstage that hunk." Source: `scripts/commit-guard.py`; bypass only for genuine emergencies with `VODOU_SKIP_COMMIT_GUARD=1`. If `.git/hooks/pre-commit` is ever missing, reinstall BOTH guards — `.git/hooks/` is not versioned, so a fresh clone has neither, and reinstalling only the first silently drops secret-guard:
```sh
printf '#!/bin/sh\nROOT="$(git rev-parse --show-toplevel)"\npython3 "$ROOT/scripts/commit-guard.py" && python3 "$ROOT/scripts/secret-guard.py"\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```

4. **A `secret-guard` blocks staging a credential VALUE** (`scripts/secret-guard.py`, added 2026-08-01 after a real Figma token was found sitting in `.build/templates/config.json.example` since the initial commit). It scans `git diff --cached` added lines against the credential patterns in `.build/release-pii-patterns.txt` — the same file `scripts/verify-release.sh` reads, so a new key shape is added in ONE place and both layers get it. Bypass `VODOU_SKIP_SECRET_GUARD=1`, but prefer fixing the string: if it is a test fixture, make it not key-shaped; if it was ever real, revoke it.
4. **New module + its declaration commit together.** If you add `mod x;` or an import of a new file, that file goes in the SAME commit.

## Work Logging

Log at end of every coding session. Full format, categories, and metadata keys: `AGENTS.md` §"Enhanced Work Logging".
```bash
./do "log: category: description | key: value"
```
