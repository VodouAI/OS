# Zed editor integration

Zed extensions are Rust modules compiled to WebAssembly with a versioned WIT
contract (per [Life of a Zed Extension](https://zed.dev/blog/zed-decoded-extensions)).
Two integration paths:

## Path 1: MCP context server (recommended, no extension needed)

Zed's AI assistant supports MCP servers as context providers. Vodou is already
exposed as an MCP server (`Surface::McpHost`). Configure Zed to add Vodou as
a context server in `~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "vodou": {
      "command": {
        "path": "vodou-core",
        "args": ["mcp-server"]
      }
    }
  }
}
```

Then in Zed's Agent Panel, `@vodou` becomes available for context injection.
Per-turn writes happen via the daemon's MCP host path (`Surface::McpHost`),
NOT `Surface::Zed` — so the matrix shows zed as `surface_seen=false` but
mcp-host as the actual recording path. This is correct: Zed is using Vodou
through its MCP boundary, not through a Vodou-specific integration.

## Path 2: Native Zed extension (future work, larger build)

To get `Surface::Zed` recording (rather than `Surface::McpHost`), build a Zed
extension in Rust:

```
zed-vodou/                       (new repo or this directory's `zed-vodou/`)
├── extension.toml
├── Cargo.toml
└── src/
    └── lib.rs                   — implements zed_extension_api traits
```

The extension would use `zed_extension_api::Worktree` + `language_server` /
`slash_command` traits to call `vodou-hook-bin sock prompt` on agent
interactions. Compiles to wasm32-wasip2. Distribution via Zed's extension
registry.

Estimated cost: 1-2 days. Out of scope for the host-adapter unification plan
(which targeted "edit a config file"). Tracked as future work.

## Verify Path 1 is working

```bash
# After installing the MCP server entry and restarting Zed:
sqlite3 /path/to/vodou/MCP-servers/Vodou-Console/gateway.db \
  "SELECT id, conversation_id, substr(content,1,40) FROM gateway_messages \
   WHERE conversation_id LIKE 'workbench:surface:mcp-host%' \
   ORDER BY id DESC LIMIT 5;"

./vodou-core hosts --host=mcp-host
# Expected: at least prompt=pass, surface_seen=true
```

## Source

- Zed extensions: https://zed.dev/docs/extensions/developing-extensions
- Zed AI overview: https://zed.dev/docs/ai/overview
- zed_extension_api: https://docs.rs/zed_extension_api
