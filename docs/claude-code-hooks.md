# Claude Code Hooks — Vodou Memory Integration

Vodou memory injects workspace context and prompt-targeted memories into Claude Code via hooks. Hooks require manual configuration.

**Reference**: [Claude Code Hooks](https://code.claude.com/docs/en/hooks)

## Quick Setup

The `install.sh` script automatically creates hook configs for both Claude Code and Cursor. To set up manually:

```bash
vodou-core mem setup              # Project: .claude/settings.json
vodou-core mem setup --global     # User: ~/.claude/settings.json
```

Cursor hooks live in `.cursor/hooks.json` (created automatically by install.sh).

## Hook Overview

| Hook | Purpose | Sync/Async |
|------|---------|------------|
| **SessionStart** | Load base memory (workspace bootstrap + presence) | Sync |
| **UserPromptSubmit** | Inject base + prompt-targeted chunks before each prompt | Sync |
| **PostToolUse** | NUL-byte write guard — blocks (exit 2) if an Edit/Write leaves a `\0` in the file | Sync |
| **SessionEnd** | Extract memories from transcript, append to memory/ | Async |

> The **PostToolUse** guard (`.claude/hooks/nul-guard.py`, matcher `Edit\|Write\|MultiEdit\|NotebookEdit`) catches a stray U+0000 written to disk before it silently breaks `grep`/`tsc`. It reads only the just-written file and exits 0 on anything clean, so it adds no cost to normal edits.

## Manual Config

Create `.claude/settings.json` (project) or `~/.claude/settings.json` (global):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "cd \"/path/to/vodou\" && ./vodou-hook-bin ensure && ./vodou-hook-bin context 2>/dev/null",
            "timeout": 15
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "cd \"/path/to/vodou\" && ./vodou-hook-bin sock prompt 2>/dev/null",
            "timeout": 15
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "cd \"/path/to/vodou\" && python3 .claude/hooks/nul-guard.py",
            "timeout": 10
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "cd \"/path/to/vodou\" && ./vodou-hook-bin sock flush 2>/dev/null",
            "async": true,
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

> **Note:** Replace `/path/to/vodou` with your Vodou install directory (the value of `VODOU_PROJECT_PATH` in `.env`). The `install.sh` script creates this file automatically with the correct path.

## IDE Requirements

| IDE | Requirements |
|-----|---------------|
| **Claude Code** | Config file only |
| **VS Code** | Install `anthropic.claude-code` extension |
| **Cursor** | Enable **Third-party skills** in Settings → Features, then restart |

## Cursor vs Claude Code: beforeSubmitPrompt / UserPromptSubmit

**Why context injection works in Claude Code but not in Cursor**

- **Claude Code** `UserPromptSubmit`: The IDE uses the hook’s **stdout as additional context** and injects it into the conversation before the prompt is sent. So `./do context --stdin` output is injected every turn.
- **Cursor** `beforeSubmitPrompt`: The hook output is used only for **allow/block**. The [Cursor Hooks schema](https://cursor.com/docs/agent/hooks) allows `continue` and `user_message` only — there is no `additional_context` (or equivalent) field. So Cursor runs the hook but **does not inject** its output into the model context.

So in Cursor today:

- **sessionStart** can inject context (Cursor supports `additional_context` in the hook JSON output). Vodou would need to output JSON for that (see below).
- **beforeSubmitPrompt** runs (e.g. `vodou-hook-bin sock prompt`) but **Cursor ignores the hook stdout for injection**. Prompt buffering still works; only per-prompt context injection does not.
- **sessionEnd** works (fire-and-forget; `./vodou-hook-bin sock flush` sends flush to daemon).

**Feature request:** [Allow beforeSubmitPrompt hook to inject additional context](https://forum.cursor.com/t/hooks-allow-beforesubmitprompt-hook-to-inject-additional-context/150707) — upvoting may help get this supported.

**Both IDEs now use `vodou-hook-bin`:** (1) **Cursor sessionStart** runs `./vodou-hook-bin cursor-session` — ensure + bootstrap markdown as JSON `additional_context` (Cursor contract). **Claude / TTY session start** may use `./vodou-hook-bin startup` or `./vodou-hook-bin context` (markdown on stdout). (2) **Per-turn context:** beforeSubmitPrompt / UserPromptSubmit runs `./vodou-hook-bin sock prompt`. The IDE sends hook JSON (with `prompt`) on stdin; vodou-hook-bin forwards it to the daemon over a Unix socket. The **daemon** buffers the prompt, searches memories, and **writes** `.vodou/workspace/.cursor_context.json`. In Cursor, rules tell the agent when to read `.cursor_context.json`. In Claude Code, stdout is injected as `additionalContext`.

## How It Works

### SessionStart
- Runs when session starts
- **Cursor:** `./vodou-hook-bin cursor-session` — stdout is JSON `{"additional_context":"<markdown>"}` (workspace bootstrap; Cursor injects into session system context).
- **Claude Code / TTY:** `./vodou-hook-bin ensure && ./vodou-hook-bin context` (or `./vodou-hook-bin startup`) — markdown on stdout; Claude injects as `additionalContext`.

### UserPromptSubmit / beforeSubmitPrompt (Cursor)
- Runs before each prompt
- **Both Claude Code and Cursor:** `./vodou-hook-bin sock prompt` — reads hook JSON from stdin, sends to daemon via Unix socket. Daemon buffers prompt, searches memories, writes `.vodou/workspace/.cursor_context.json`.
- Claude Code injects stdout as additional context. Cursor agents read `.cursor_context.json` at turn start (see `.cursor/rules/read-context.mdc`).

### SessionEnd
- Runs when session ends (async)
- Claude Code sends `transcript_path` in hook input
- `./vodou-hook-bin sock flush` sends flush command to daemon via Unix socket; daemon reads transcript, extracts bullets, appends to `memory/YYYY-MM-DD.md`, runs sync
- **Note:** `./do mem flush --stdin` is the low-level equivalent but opens the DB directly. Prefer `vodou-hook-bin sock flush` to avoid UE zombie accumulation on macOS.

## Extraction Config (memory.toml)

By default Vodou uses heuristic extraction. For LLM or script extraction, add `memory.toml` in workspace root or `~/.vodou/`:

```toml
[extraction]
provider = "script"

[extraction.script]
command = "~/.vodou/extract-memories.sh"
```

Script receives JSON on stdin: `{"messages": [...]}`. Output: one bullet per line on stdout.

## Optional: Memory Daemon

For warm cache and faster `./do context` (< 50ms target), run the daemon:

```bash
./do daemon start              # Watch default workspace (~/.vodou/workspace)
./do daemon start --workspace /path/to/.vodou/workspace
```

Daemon watches MEMORY.md and memory/ for changes, re-indexes after 1.5s debounce.

## Troubleshooting

- **Hooks not running**: Ensure config file exists and IDE requirements are met
- **Cursor**: Enable Third-party skills, restart after config change
- **./do not found**: Add Vodou to PATH or use full path in `command`

### SessionStart:startup hook error / Claude seems hung

The SessionStart hook runs **synchronously**; Claude waits for it. If the hook fails or hangs, the IDE can appear stuck.

1. **Use `cd` to the Vodou directory** — Hooks run with the IDE’s working directory, which may not be the Vodou project root. All hooks should use `cd "/path/to/vodou" && ./vodou-hook-bin ...` so `vodou-hook-bin` can find the daemon socket and workspace files. The `install.sh` script creates hooks with the correct absolute path automatically.
2. **vodou-hook-bin location** — The hook binary lives in the Vodou project root (not in `target/`). It’s a standalone ~400KB binary with no DB access.
3. **Timeout** — SessionStart has a 5s timeout. If context loading is slow (cold DB, many files), increase the hook `timeout` or run `./do daemon start` for a warmer cache.

### Slow or “nothing happens” (Claude Code / Cursor)

If the IDE sometimes freezes, new windows do nothing, or responses get much slower over time, the cause was the **beforeSubmitPrompt** hook blocking on memory flush:

1. **Flush ran in the critical path** — The hook ran `vodou-core mem flush` then `context` sequentially. When it was time to extract (every 15 prompts), flush called the **claude** CLI or Anthropic API. That could take up to 60s or hang indefinitely (e.g. `claude` CLI waiting on the same IDE), so the IDE waited and appeared frozen.
2. **Extraction provider** — With `provider = "claude"` in `memory.toml`, extraction uses the `claude` CLI with no timeout, which could deadlock when run from inside Claude Code/Cursor.

**Fixes applied:**

- **Cursor:** beforeSubmitPrompt runs **`vodou-hook-bin sock prompt`** only (no shell script). The hook sends the prompt to the daemon and exits; the daemon writes `.cursor_context.json`. Flush runs at session end (`sock flush`) or periodically inside the daemon — the IDE never blocks on extraction.
- **claude CLI** extraction now has a **60s timeout**; on timeout the process is killed and extraction falls back to heuristic so the hook doesn’t hang.

If you still see freezes, set `provider = "heuristic"` in `memory.toml` to disable LLM extraction entirely, or use `anthropic` (direct API with 60s timeout) instead of `claude` (CLI).
