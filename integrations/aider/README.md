# Aider integration

Aider has no native session-start hook in its config — `.aider.conf.yml`
covers model/lint/test/git options but not pre-prompt hooks. This integration
uses a wrapper script + Aider's natural chat history file as the recording
substrate.

## Prerequisites

- Aider installed (`pip install aider-chat` or per Aider docs)
- `vodou-hook-bin` on PATH
- Vodou daemon running

## Install

```bash
# Symlink the wrapper as `aider` in a directory that's earlier on your PATH
# than the real aider binary, OR alias it in your shell rc:
alias aider='/path/to/vodou/integrations/aider/aider-with-vodou.sh'

# Or copy somewhere on PATH:
cp /path/to/vodou/integrations/aider/aider-with-vodou.sh ~/bin/aider-vodou
chmod +x ~/bin/aider-vodou
```

## How it works

The wrapper is a 30-line shell script that:

1. **Fetches Vodou workspace context** via `vodou-hook-bin context` (the
   universal markdown bootstrap blob — MEMORY.md, AGENTS.md, etc.)
2. **Writes context to a temp file** and launches Aider with `--read <tempfile>`
   so the context is part of Aider's prompt context from turn 1
3. **Flushes Vodou** after Aider exits to trigger a memory extraction cycle

Per-prompt recording happens via Aider's natural chat history file:
`.aider.chat.history.md` in cwd. The gateway extractor reads this file on its
5-min cycle, and our daemon's surface heuristic detects `Surface::Aider` from
the `.aider.chat.history` substring in the path.

## What you get vs Claude Code's hook

| Feature | Claude Code hook | Aider wrapper |
|---|---|---|
| Workspace bootstrap | ✅ on every session start | ✅ via `--read` injected at launch |
| Per-prompt recording | ✅ immediate via UserPromptSubmit | ⏳ batched via gateway extractor (5 min cycle) |
| Per-prompt recall | ✅ immediate via UserPromptSubmit | ⏳ batched (only what bootstrap provided + chat history file) |

The wrapper covers ~70% of the value with no Aider modifications. For the
remaining 30%, Aider would need a native pre-prompt hook (request open at
[Aider GitHub](https://github.com/Aider-AI/aider/issues)).

## Verify it's working

```bash
# Run a quick aider session via the wrapper
aider-with-vodou.sh --no-git --message "what is 2+2"

# Check that Vodou injected context
# (look for "[aider-with-vodou] injecting N bytes of Vodou context" in stderr)

# After 5 min (next gateway extractor cycle), look for surface=aider chunks:
sqlite3 /path/to/vodou/MCP-servers/Vodou-Console/gateway.db \
  "SELECT id, conversation_id, substr(content,1,40) FROM gateway_messages \
   WHERE conversation_id = 'workbench:surface:aider' \
   ORDER BY id DESC LIMIT 5;"

./vodou-core hosts --host=aider
# Expected: status=stable, prompt=pass, record_turn=pass
```

## Future work

If Aider ships a `pre_prompt_hook` config option, replace the wrapper with a
direct `vodou-hook-bin sock prompt` invocation in `.aider.conf.yml`. The
daemon side is already correct — only the host-side wiring would change.
