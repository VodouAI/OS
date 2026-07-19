# Gemini CLI integration

Wires Google's Gemini CLI into Vodou continuity. After install, every Gemini
prompt records to `gateway_messages` with `Surface::Gemini`, and Gemini-tagged
chunks become recallable from any other Vodou surface.

## Prerequisites

- Gemini CLI installed (`brew install gemini-cli` or per Google docs)
- `vodou-hook-bin` on PATH
- Vodou daemon running (`./vodou-core daemon ensure`)

## Install — two paths

### Path A: Auto-discover from repo root (zero install)

The Vodou repo root contains `.gemini/settings.json` with the hook config.
Per [Gemini CLI docs](https://geminicli.com/docs/reference/configuration/),
project settings (`.gemini/settings.json` in cwd) override user settings.

```bash
cd /path/to/vodou
gemini                  # hooks auto-fire, no manual install
```

### Path B: User-global install

```bash
mkdir -p ~/.gemini
# If you don't have one:
cp /path/to/vodou/.gemini/settings.json ~/.gemini/settings.json
# If you already have one: hand-merge the `hooks` block.
```

### Verify

```bash
sqlite3 /path/to/vodou/MCP-servers/Vodou-Console/gateway.db \
  "SELECT id, conversation_id, substr(content,1,40) FROM gateway_messages \
   WHERE conversation_id = 'workbench:surface:gemini' \
   ORDER BY id DESC LIMIT 5;"
```

## How it works

| Gemini hook event | Vodou action |
|---|---|
| `SessionStart` | `vodou-hook-bin gemini-session` returns workspace bootstrap as `{additional_context: "..."}` JSON. Gemini's hook contract requires JSON-only stdout — the subcommand satisfies this. |
| `BeforeAgent` | `vodou-hook-bin sock prompt` records the turn via `record_turn(Surface::Gemini)` and returns relevant memory chunks. |

The daemon detects `Surface::Gemini` from `transcript_path` containing `/.gemini/`
(per `src/daemon.rs` surface heuristic).

## Critical: JSON-only stdout

Per [Gemini CLI hooks reference](https://geminicli.com/docs/hooks/reference/),
hook scripts MUST output ONLY valid JSON to stdout. Even a single `echo`
before the JSON breaks parsing.

`vodou-hook-bin` follows this contract — all stdout is JSON, all logs go to
stderr. If you wrap Vodou in another script, ensure that wrapper also keeps
stdout clean.

## Verify it's working

```bash
./vodou-core hosts --host=gemini-cli
# Expected: status=stable, prompt=pass, recall=pass, record_turn=pass

# Cross-surface recall test:
TOKEN=$(cat /path/to/vodou/.vodou/console.token)
curl -s -X POST http://127.0.0.1:8766/api/v2/memory/recall \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"<keywords from Gemini session>","k":5,"provenance":true}' | jq
```

## Uninstall

Remove the `hooks.SessionStart` and `hooks.BeforeAgent` entries from
`~/.gemini/settings.json`. Existing recorded turns stay in `gateway.db`.

## Source

- Gemini CLI hooks docs: https://geminicli.com/docs/hooks/
- Hooks reference: https://geminicli.com/docs/hooks/reference/
- Writing hooks: https://geminicli.com/docs/hooks/writing-hooks/
