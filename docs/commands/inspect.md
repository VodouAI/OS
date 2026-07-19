# inspect

Launch visual MCP Inspector for interactive server debugging and exploration.

## Syntax
```bash
vodou-core inspect [OPTIONS] <NAME>
```

## Parameters
- **`<NAME>`** - Server name to inspect

## Options
- **`--mode <MODE>`** - Inspector mode (default: ui)
  - `ui` - Launch visual Inspector interface
  - `cli` - Launch CLI Inspector mode

## Description

The `inspect` command launches the MCP Inspector for visual debugging and interactive exploration of MCP servers. This provides a professional development environment for:

- **Interactive Testing** - Test tools, prompts, and resources in real-time
- **Visual Debugging** - See exactly what capabilities a server provides
- **Request History** - Complete audit trail of all interactions
- **Error Visualization** - Rich error reporting and debugging information

## Examples

### Visual Inspector (Default)
```bash
# Launch visual Inspector UI for server debugging
vodou-core inspect chrome-devtools

# Same as above (ui is default mode)
vodou-core inspect chrome-devtools --mode ui
```

### CLI Inspector Mode
```bash
# Launch CLI Inspector for automation/scripting
vodou-core inspect mcp-monitor --mode cli
```

## Requirements

- **Node.js** - Required for MCP Inspector
- **Connected Server** - Server must be in the database
- **Valid Configuration** - Server must be properly configured

## Related Commands

- [`validate`](validate.md) - Validate server before connecting
- [`test`](test.md) - Run comprehensive tests
- [`debug`](debug.md) - CLI debugging with specific methods
- [`analyze`](analyze.md) - Performance analysis

## Professional Workflow

```bash
# 1. Validate server first
vodou-core validate node ./server.js

# 2. Connect with validation
vodou-core connect my-server node ./server.js --validate

# 3. Inspect visually for development
vodou-core inspect my-server

# 4. Test comprehensively
vodou-core test my-server
```

## Troubleshooting

**Inspector won't launch:**
- Check if Node.js is installed
- Verify server exists: `vodou-core list`
- Check server status: `vodou-core status my-server`

**UI doesn't open:**
- Verify port availability (usually localhost:6274)
- Check firewall/network settings
- Try CLI mode instead: `--mode cli`