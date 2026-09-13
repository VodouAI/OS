# Vodou for Claude Code

**Memory that follows you between AIs.** Tell Claude Code something once; it's there next session — and in Cursor, ChatGPT, Claude.ai, Codex and every other AI attached to the same Vodou engine. Local (Rust + SQLite on your machine), open source (Apache-2.0), and it shows its receipts.

## What the plugin does

| Piece | What it gives Claude Code |
|---|---|
| MCP server `vodou` | `vc_memory_context`, `vc_memory_search`, `vc_remember`, `vc_load_skill`, `vc_list_skills` — the `memory` profile, scoped to the `portable` vault |
| Session hooks | Session start: injects the memory relevant to this project. Prompt submit: recalls per message. Session end: extracts what's worth keeping |
| Skills | `vodou-memory` (how and when Claude should recall/save), `vodou-setup` (install and connect the engine) |

## Requirements

The Vodou engine must be installed on the machine. The plugin finds it in `$VODOU_HOME`, `$VODOU_PROJECT_PATH`, any parent of the working directory, or `~/vodou`.

```bash
curl -fsSL https://raw.githubusercontent.com/VodouAI/OS/main/install-vodou.sh | bash
```

If it isn't installed, the plugin says so once at session start and otherwise stays out of the way. `/vodou-setup` walks through it.

## Install the plugin

```bash
claude plugin marketplace add anthropics/claude-plugins-community
claude plugin install vodou@claude-community
```

Or, before it's in the catalog: clone https://github.com/VodouAI/OS and run `claude --plugin-dir ./OS/integrations/claude-code-plugin`.

## Privacy

Memory is written to a SQLite database inside the Vodou install directory and never leaves the machine through this plugin. The MCP server runs over stdio (one process per Claude Code session, no port). The `memory` profile exposes read + `vc_remember` only — no file, shell or scheduler tools. Full policy: https://app.vodou.ai/privacy

## Source

Engine + open tree: https://github.com/VodouAI/OS · this plugin: `integrations/claude-code-plugin/`
