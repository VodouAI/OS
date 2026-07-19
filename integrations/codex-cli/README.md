# Codex CLI integration

Wires OpenAI's Codex CLI into Vodou continuity. After install, every Codex
prompt records to `gateway_messages` with `Surface::Codex`, and `Surface::Codex`-tagged
chunks become recallable from any other Vodou surface.

## Prerequisites

- Codex CLI installed (`brew install openai/codex/codex` or per OpenAI docs)
- `vodou-hook-bin` on PATH (run `which vodou-hook-bin` to confirm)
- Vodou daemon running (`./vodou-core daemon ensure` from project root)

## Install — two paths

### Path A: Auto-discover from repo root (zero install)

The Vodou repo root already contains `.codex/config.toml` with these hooks.
Per [OpenAI's Codex hooks docs](https://developers.openai.com/codex/hooks),
Codex walks up from cwd to .git root and merges every `.codex/config.toml` it
finds. So:

```bash
cd /path/to/vodou       # the repo root with .codex/config.toml
codex                   # accept the "trust this project" prompt → hooks fire
```

Every Codex prompt run from the Vodou repo (or any subdirectory) now records
to gateway.db with `Surface::Codex`. Done.

### Path B: User-global install (works in every project)

```bash
mkdir -p ~/.codex
cat /path/to/vodou/.codex/config.toml >> ~/.codex/config.toml
```

Codex now invokes Vodou hooks for every project, not just Vodou.

### Verify

```bash
sqlite3 /path/to/vodou/MCP-servers/Vodou-Console/gateway.db \
  "SELECT id, conversation_id, substr(content,1,40) FROM gateway_messages \
   WHERE conversation_id = 'workbench:surface:codex' \
   ORDER BY id DESC LIMIT 5;"
```

## How it works

| Codex hook event | Vodou action |
|---|---|
| `SessionStart` | `vodou-hook-bin codex-session` returns workspace bootstrap context (MEMORY.md, AGENTS.md, etc.) which Codex injects into the LLM context |
| `UserPromptSubmit` | `vodou-hook-bin sock prompt` records the turn via `record_turn(Surface::Codex)` and returns relevant memory chunks for context injection |

The daemon detects `Surface::Codex` from `transcript_path` containing `/.codex/`
(per `src/daemon.rs` surface heuristic). No additional configuration needed.

## Verify it's working

```bash
# After running a Codex session:
./vodou-core hosts --host=codex-cli
# Expected: status=stable, prompt=pass, recall=pass, record_turn=pass, surface_seen=true

# Recall something Codex told you, from any other surface:
TOKEN=$(cat /path/to/vodou/.vodou/console.token)
curl -s -X POST http://127.0.0.1:8766/api/v2/memory/recall \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"<keywords from your Codex session>","k":5,"provenance":true}' | jq
```

## Uninstall

Remove the `[[hooks.SessionStart]]` and `[[hooks.UserPromptSubmit]]` blocks
from `~/.codex/config.toml`. Existing recorded turns stay in `gateway.db` —
Vodou recall continues to surface them.

## Source

OpenAI Codex hooks docs: https://developers.openai.com/codex/hooks
