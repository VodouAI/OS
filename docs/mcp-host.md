# Vodou as an MCP Host

Vodou (vodou-core) can expose itself as an MCP server, allowing any MCP-compatible client — Cursor, Claude Desktop, Windsurf, or your own tooling — to connect and use all of Vodou's capabilities directly.

---

## How It Works

Vodou runs as a **STDIO MCP server** using the standard JSON-RPC newline protocol. Your MCP client launches `vodou-core mcp-server` as a subprocess and communicates over stdin/stdout — no ports, no networking, no auth needed.

```
Your MCP Client  ←──STDIO JSON-RPC──→  vodou-core mcp-server  ←──→  All connected MCP servers + skills + memory
```

Vodou acts as a **gateway**: the client gets one clean set of `vc_*` tools, and Vodou handles the parallel MCP execution under the hood.

---

## Quick Setup

### Cursor

Add to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "./do": {
      "command": "/path/to/vodou-core",
      "args": ["mcp-server"]
    }
  }
}
```

Replace `/path/to/vodou-core` with the actual binary path (find it with `which vodou-core` or use the absolute path from your Vodou install).

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "./do": {
      "command": "/path/to/vodou-core",
      "args": ["mcp-server"]
    }
  }
}
```

### Any MCP Client

```json
{
  "command": "/path/to/vodou-core",
  "args": ["mcp-server"]
}
```

Transport: `stdio`  
Protocol: MCP `2024-11-05` / `2025-11-25` (auto-negotiated)

---

## Expose a Single Tool (Optional)

To expose only one specific tool — useful for lightweight integrations:

```json
{
  "command": "/path/to/vodou-core",
  "args": ["mcp-server", "--tool", "vc_intelligent_query"]
}
```

---

## Available Tools

All tools are prefixed `vc_` and exposed automatically once connected.

| Tool | Description |
|------|-------------|
| `vc_intelligent_query` | Natural language query → parallel MCP execution |
| `vc_system_analysis` | CPU, memory, disk analysis in parallel |
| `vc_code_analysis` | Codebase structure, issues, research — simultaneously |
| `vc_error_debugging` | Error → parallel system state + solution search |
| `vc_comprehensive_analysis` | Full system + code + research in one call |
| `vc_server_tool` | Direct access to any tool on any connected MCP server |
| `vc_server_status` | Status of all connected MCP servers |
| `vc_load_skill` | Load an Vodou skill by name or file path |
| `vc_list_skills` | List all available Vodou skills |
| `vc_search_skills` | Search skills by keyword |
| `vc_skills_create` | Create a **Skill Console** (gateway tab + optional cron); see [skill-console.md](skill-console.md) |
| `vc_schedule_add` | Schedule a task (cron, every Nh, at HH:MM, in Nh) |
| `vc_schedule_list` | List all scheduled tasks |
| `vc_workspace_read_file` | Read a workspace file |
| `vc_workspace_write_file` | Write a workspace file |
| `vc_workspace_append_file` | Append to a workspace file |
| `vc_workspace_run_command` | Run a shell command in the workspace |
| `vc_workspace_list_dir` | List a workspace directory |

> **Recommended starting points**: `vc_intelligent_query` for general use, `vc_comprehensive_analysis` for deep dives.

---

## Why Use Vodou as a Host?

- **One connection, all tools** — your client gets access to every MCP server Vodou has connected, without configuring each one individually
- **Parallel execution** — Vodou runs 5-10 MCP tools simultaneously; your client gets results in 3-5s instead of 30s+
- **Skills access** — expert workflow guidance (stopping points, curated patterns) available directly from Cursor or Claude Desktop
- **Memory** — Vodou's memory system is available to any connected client via `vc_intelligent_query`

---

## Verify the Connection

After configuring, test from your client:

```
vc_server_status → should list all connected MCP servers
vc_list_skills   → should return your installed skills
```

Or from the CLI:
```bash
vodou-core mcp-server --help
```

---

## Settings → Servers

The **Settings → Servers** page in the Vodou web UI manages which MCP servers Vodou connects **to** (Vodou as client). That's separate from this — here we're configuring external clients connecting **to Vodou** (Vodou as host).

See [mcp-protocol.md](mcp-protocol.md) for Vodou's client-side MCP implementation details.
