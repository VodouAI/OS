# Continue.dev integration

Continue.dev (the VS Code + JetBrains extension at continue.dev) doesn't
expose a direct pre-prompt hook in `config.yaml`. This integration uses
three indirect mechanisms:

1. **`systemMessage`** — tells the model about Vodou's recall capability
2. **`/vodou` and `/vodou-recall` custom commands** — manual recall triggers
3. **Background recording** — Continue writes chat history to
   `~/.continue/sessions/`; daemon detects `Surface::ContinueDev` via the
   `/.continue/` path heuristic and the gateway extractor picks it up

## Prerequisites

- Continue.dev installed (VS Code or JetBrains extension)
- `vodou-hook-bin` on PATH
- Vodou daemon running

## Install — two paths

### Path A: Auto-discover (workspace-local, zero install)

The Vodou repo root contains `.continue/config.yaml`. Per
[Continue docs](https://docs.continue.dev/customize/deep-dives/configuration),
project-level config overrides user-level when this directory is your VS Code
or JetBrains workspace.

```bash
# Open the Vodou repo in VS Code or JetBrains
# Continue picks up .continue/config.yaml automatically
# Type `/vodou` in the Continue chat to confirm the customCommand is present
```

### Path B: User-global install

```bash
mkdir -p ~/.continue
# If you don't have one:
cp /path/to/vodou/.continue/config.yaml ~/.continue/config.yaml
# If you already have one: hand-merge systemMessage and customCommands.
```

### Verify

Type `/vodou` in the Continue chat — should appear as a command suggestion.

## How it works

| Continue surface | Vodou action |
|---|---|
| Every chat (`systemMessage`) | Model is told to suggest `/vodou` when prior context might help |
| `/vodou <query>` | Custom command fetches Vodou bootstrap context + summarizes for the query |
| `/vodou-recall <query>` | Custom command hits `/api/v2/memory/recall` directly with structured output |
| Background | Continue's session files in `/.continue/` are detected by daemon as `Surface::ContinueDev`; gateway extractor records turns on its 5-min cycle |

## Vs Claude Code's hook

| Feature | Claude Code | Continue.dev |
|---|---|---|
| Pre-prompt context | ✅ automatic | ⏳ via `/vodou` on demand |
| Per-prompt recording | ✅ immediate | ⏳ batched via gateway extractor |
| Cross-surface recall | ✅ automatic | ✅ via `/vodou-recall` (direct API) |

The user has to invoke `/vodou` manually — there's no implicit pre-prompt
injection like Claude Code's hook. **Once Continue ships a `pre_prompt_hook`
config option, this integration becomes ~10 LOC of automatic injection
identical to Claude Code.**

## Verify it's working

```bash
# After running a Continue chat session:
sqlite3 /path/to/vodou/MCP-servers/Vodou-Console/gateway.db \
  "SELECT id, conversation_id, substr(content,1,40) FROM gateway_messages \
   WHERE conversation_id = 'workbench:surface:continue-dev' \
   ORDER BY id DESC LIMIT 5;"

./vodou-core hosts --host=continue-dev
# Expected: status=stable, prompt=pass, recall=pass, record_turn=pass
```

## Source

- Continue.dev config reference: https://docs.continue.dev/reference
- customCommands: https://docs.continue.dev/customize/deep-dives/configuration
