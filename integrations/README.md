# Vodou host integrations

Per-host wiring artifacts that activate Vodou's continuity primitive across LLM
surfaces. The Vodou daemon (`vodou-core`) and the universal hook binary
(`vodou-hook-bin`) are already built and shipped — this directory contains the
**host-side configs, wrappers, and channel adapters** that tell each host to
actually call them.

## Three layers

| Layer | What it is | Status |
|---|---|---|
| **1. Contract** | `record_turn` + `recall` chokepoints in `vodou-core`; `POST /api/v2/channels/turns` HTTP boundary; `vodou-hook-bin <host>-session` subcommands; `Surface` enum + daemon transcript_path heuristics | ✅ shipped (per `PLANS/0.5.73/PLAN-HOST-ADAPTER-UNIFICATION.md`) |
| **2. Host wiring** | Each host's own settings file telling it to invoke `vodou-hook-bin` at session-start / pre-prompt | this directory, per host |
| **3. Channel pollers** | For non-IDE surfaces (email/calendar/zoho), external scripts that poll the source and call `POST /api/v2/channels/turns` | this directory, per channel |

## Per-host status

| Host | Layer 1 | Layer 2 (host wiring) | Notes |
|---|---|---|---|
| Claude Code | ✅ | ✅ already wired in `.claude/settings.json` | Reference implementation |
| Cursor | ✅ | ✅ already wired in `.cursor/hooks.json` | Reference implementation |
| **Codex CLI** | ✅ | ✅ `codex-cli/config.toml.snippet` | Native hooks confirmed |
| **Gemini CLI** | ✅ | ✅ `gemini-cli/settings.json.snippet` | Native hooks confirmed |
| **Aider** | ✅ | ✅ `aider/aider-with-vodou.sh` | Wrapper script (no native hook surface) |
| **Continue.dev** | ✅ | ✅ `continue-dev/config.yaml.snippet` | customCommand approach (no direct pre-prompt hook) |
| **Open Interpreter** | ✅ | ✅ `open-interpreter/oi-with-vodou.sh` | Wrapper using `--custom_instructions` |
| **Zed** | ✅ | ⏳ `zed/README.md` | MCP context server approach — see README; future Rust extension is a larger build |
| **JetBrains AI** | ✅ | ⏳ `jetbrains/README.md` | Needs Kotlin plugin — future work, scope documented |

## Per-channel status

| Channel | Layer 1 | Layer 3 (poller) | Notes |
|---|---|---|---|
| **Email** | ✅ | ✅ `channel-email/poll.mjs` | Node.js poller, runs via cron/launchd |
| **Calendar** | ✅ | ✅ `channel-calendar/poll.mjs` | Node.js poller |
| **Voice** | ✅ | ⏳ external transcription required | HTTP endpoint accepts `surface=voice`; bring your own transcription source |
| **Zoho** | ✅ | ✅ `channel-zoho/poll.mjs` | Node.js poller, builds on v0.5.74 ExecDesk Zoho auth |

## Install pattern — two modes

Most hosts support **project-local config auto-discovery**, just like
Claude Code's `.claude/settings.json`. We've taken advantage of this where
possible — the Vodou repo root contains actual working dotfiles that
auto-fire when you run those CLIs from this directory.

### Mode 1 — Repo-local (works automatically when running from Vodou)

| Host | Auto-discovered file | Behavior |
|---|---|---|
| Codex CLI | `.codex/config.toml` (this repo) | First run: accept Codex's "trust this project" prompt → hooks fire automatically |
| Gemini CLI | `.gemini/settings.json` (this repo) | Auto-discovered; project settings override user settings |
| Continue.dev | `.continue/config.yaml` (this repo) | Auto-discovered when this directory is your VS Code/JetBrains workspace |
| Claude Code | `.claude/settings.json` (this repo) | Reference: this is the original auto-discovery pattern |
| Cursor | `.cursor/hooks.json` (this repo) | Reference |
| Aider | n/a — no hook surface | Use the wrapper script (`integrations/aider/aider-with-vodou.sh`) |

**What this means in practice:** if you `cd` to the Vodou repo root and run
`codex` / `gemini` / open VS Code with Continue, the hooks fire immediately.
No manual install. Vodou records every prompt you type while working in the
Vodou repo, with the correct surface tag.

### Mode 2 — User-global (works in every project)

For Vodou to record what you do in *non-Vodou* projects too, copy the
auto-discovered files to your user-level config dir:

```bash
# Codex (works in every project after this)
mkdir -p ~/.codex
cat .codex/config.toml >> ~/.codex/config.toml

# Gemini (replace or hand-merge)
mkdir -p ~/.gemini
cp .gemini/settings.json ~/.gemini/settings.json

# Continue.dev
mkdir -p ~/.continue
cp .continue/config.yaml ~/.continue/config.yaml
```

User-level configs are **merged with** any project-local configs, so the
combination is: "Vodou records everywhere, with project-specific overrides
where you've placed them."

### Verification

```bash
./vodou-core hosts --host=<name>           # matrix grading per host
./vodou-core hosts --json | jq             # structured for CI
```

## Verifying after install

```bash
# Confirm a host's surface is round-tripping correctly
./vodou-core hosts --host=<name>

# Look for fresh rows in gateway.db with the host's surface scope
sqlite3 MCP-servers/Vodou-Console/gateway.db \
  "SELECT id, conversation_id, substr(content,1,40) FROM gateway_messages \
   WHERE conversation_id LIKE 'workbench:surface:<surface>%' \
   ORDER BY id DESC LIMIT 5;"

# Recall something the host wrote, from any other surface
TOKEN=$(cat .vodou/console.token)
curl -s -X POST http://127.0.0.1:8766/api/v2/memory/recall \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"<something the host said>","k":5,"provenance":true}' | jq
```
