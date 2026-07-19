# validate

Validate MCP server configuration before adding to database.

## Syntax
```bash
vodou-core validate [OPTIONS] <COMMAND> [ARGS]...
```

## Parameters
- **`<COMMAND>`** - Executable command to validate
- **`[ARGS]...`** - Command arguments

## Options
- **`--detailed`** - Show detailed validation results including capability counts

## Description

The `validate` command tests MCP server configuration using the Inspector before adding it to the database. This prevents broken or misconfigured servers from polluting your server database.

Validation checks:
- **Server Startup** - Can the server process start successfully?
- **MCP Protocol** - Does the server respond to MCP initialization?
- **Capability Discovery** - Can tools, prompts, and resources be discovered?
- **Basic Functionality** - Do core MCP methods work?

## Examples

### Basic Validation
```bash
# Validate a Node.js server
vodou-core validate node ./server.js

# Validate Python server
vodou-core validate python -m my_mcp.server

# Validate native binary
vodou-core validate ./bin/mcp-server --config config.json
```

### Detailed Validation
```bash
# Show detailed capability counts and information
vodou-core validate node ./server.js --detailed
```

### Sample Output

**Successful Validation:**
```
🔍 Validating server...
  Command: node
  Args: ./server.js
✅ Server validation successful!
  Ready to add with: vodou-core connect my-server node ./server.js
```

**Detailed Validation:**
```
🔍 Validating server...
  Command: node
  Args: ./server.js
✅ Server validation successful!
  🔧 Tools: 5
  📝 Prompts: 2
  📄 Resources: 3
  Ready to add with: vodou-core connect my-server node ./server.js
```

**Failed Validation:**
```
🔍 Validating server...
  Command: node
  Args: ./broken-server.js
❌ Server validation failed!
  Error: Server failed to respond to initialization
```

## Professional Workflow

```bash
# 1. Validate before connecting (recommended)
vodou-core validate node ./new-server.js --detailed

# 2. If validation passes, connect safely
vodou-core connect my-server node ./new-server.js

# 3. Alternative: Use integrated validation
vodou-core connect my-server node ./new-server.js --validate
```

## Use Cases

**Development:**
- Test new MCP servers before deployment
- Verify server configuration changes
- Debug server initialization issues

**Production:**
- Ensure reliability before adding to production database
- Validate servers in CI/CD pipelines
- Prevent deployment of broken servers

## Related Commands

- [`connect`](connect.md) - Connect with optional validation (`--validate`)
- [`inspect`](inspect.md) - Visual debugging after validation
- [`test`](test.md) - Comprehensive testing of connected servers
- [`debug`](debug.md) - Method-level debugging

## Requirements

- **MCP Inspector** - Uses Inspector for validation
- **Node.js** - Required for Inspector functionality
- **Valid Server** - Server must implement MCP protocol

## Troubleshooting

**Validation always fails:**
- Check server implements MCP protocol correctly
- Verify command and arguments are correct
- Test server manually first
- Check Inspector installation: `npx @modelcontextprotocol/inspector --help`

**Timeout issues:**
- Increase timeout if server takes time to start
- Check server logs for startup errors
- Verify dependencies are installed