---
name: vodou-setup
description: Install or connect the Vodou engine so this plugin's memory tools and hooks work. Use when the session-start hook reported "engine not found", when the vodou MCP server fails to start, or when the user asks how to set up Vodou.
---

# Set up Vodou

This plugin is the Claude Code half. The engine (`vodou-core`, Rust + SQLite) runs on the user's machine and holds the memory. Without it the MCP server can't start and the hooks stay quiet.

## 1. Is it already installed?

Look for a directory containing both `vodou-core` and `vodou-hook-bin`. Common places: `$VODOU_HOME`, `~/vodou`, the current project's parents. If found, skip to step 3.

## 2. Install

```bash
curl -fsSL https://raw.githubusercontent.com/VodouAI/OS/main/install-vodou.sh | bash
```

Installs into `./vodou` (override with `VODOU_INSTALL_DIR=~/vodou`). Mac and Linux; Windows uses `install-vodou.ps1` from the same repo. Then sign up at https://app.vodou.ai and put the two values it shows into `vodou/.env`:

```env
VODOU_TOKEN=...
VODOU_USER_ID=...
```

and start the services:

```bash
cd vodou && ./start-vodou-services.sh
```

That opens the Vodou Console in the browser.

## 3. Tell the plugin where it is

The plugin finds the engine automatically in `$VODOU_HOME`, `$VODOU_PROJECT_PATH`, any parent of the current directory, or `~/vodou`. If it's somewhere else, set once in the shell profile:

```bash
export VODOU_HOME=/path/to/vodou
```

Then restart Claude Code. The `vodou` MCP server should list `vc_memory_context`, `vc_memory_search`, `vc_remember`, `vc_load_skill`, `vc_list_skills`.

## 4. Prove it

Tell Claude one fact ("my dog's name is Pepper"), end the session, start a new one, ask. Then open Cursor or ChatGPT with the Vodou Bridge attached and ask there. Same answer, same memory.

## If it still fails

- `./vodou-core builds` — which engine is running.
- `./vodou-core flows` — four end-to-end health rows; a red row names the broken piece.
- Docs: https://github.com/VodouAI/OS/tree/main/docs — `mcp-host.md` covers every client.
