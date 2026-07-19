# connect - Server Connection and Discovery

Connect to an MCP server and discover all its capabilities (tools, prompts, and resources) with enhanced Brain Trust 4 integration including connection pooling and universal routing support.

## Syntax

```bash
# STDIO connection (local process)
vodou-core connect [OPTIONS] <NAME> <COMMAND> [ARGS]...

# HTTP connection (remote server)
vodou-core connect [OPTIONS] <NAME> --url <URL> [--api-key <KEY>] [--headers <HEADERS>]
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `<NAME>` | Yes | Unique server name for future references |
| `<COMMAND>` | Yes (STDIO) | Executable command (e.g., "node", "python", "./binary") |
| `[ARGS]...` | No (STDIO) | Command arguments (space-separated) |
| `--url <URL>` | Yes (HTTP) | HTTP/HTTPS URL for remote servers |

## Options

| Option | Description | Example |
|--------|-------------|---------|
| `--validate` | Validate server and preview capabilities before adding to database | `--validate` |
| `--url <URL>` | HTTP/HTTPS URL for remote servers (auto-detects HTTP connection) | `--url https://mcp.api.gusto.com/anthropic` |
| `--api-key <KEY>` | API key for quick testing (temporary, use `credentials` command for persistent storage) | `--api-key "sk-xxx"` |
| `--headers <HEADERS>` | Custom headers in format `"Header1:Value1,Header2:Value2"` or JSON | `--headers "Authorization:Bearer token"` |
| `--allowed-dirs <dir>...` | Allowed directories for filesystem servers (multiple directories supported) | `--allowed-dirs /tmp /home/user/projects` |
| `--sampling-config <type:config>` | Sampling configuration in format "type:json_config" | `--sampling-config "data:{\"interval\":5000}"` |
| `--notification-config <type:enabled:config>` | Notification configuration in format "type:enabled:json_config" | `--notification-config "roots/listChanged:true:{\"auto_update\":true}"` |
| `--approval-policy <policy>` | User approval policy for sensitive operations | `--approval-policy strict` (strict, relaxed, auto) |
| `--progress-tracking` | Enable progress tracking for long-running operations | `--progress-tracking` |
| `--auto-approve <operations>` | Auto-approve specific operation types (comma-separated) | `--auto-approve "read_operations,list_operations"` |
| `--transport <TYPE>` | Transport type override ("http", "sse", "streamable-http", or "auto" for auto-detection) | `--transport sse` |

## Examples

### Node.js Servers
```bash
# Chrome DevTools MCP (browser automation)
vodou-core connect chrome-devtools npx -y chrome-devtools-mcp@latest

# Custom Node.js MCP server
vodou-core connect api-server node ./api/server.js --port 8080

# NPX package server  
vodou-core connect weather-server npx @weather/mcp-server
```

### Python Servers
```bash
# Python module server
vodou-core connect weather-mcp python -m mcp_weather.server

# Python script with arguments
vodou-core connect data-processor python ./scripts/processor.py --config ./config.json

# Virtual environment Python server
vodou-core connect ml-server ./venv/bin/python -m ml_mcp.server
```

### Native Binary Servers
```bash
# Local binary
vodou-core connect system-monitor ./bin/mcp-monitor

# System-installed binary
vodou-core connect monitor /usr/local/bin/monitor

# Binary with configuration
vodou-core connect database-server ./db-server --config ./db.conf
```

### Filesystem Servers (Enhanced Configuration)

#### Basic Filesystem Server
```bash
# Single directory access
vodou-core connect filesystem npx @modelcontextprotocol/server-filesystem \
  --allowed-dirs /tmp

# Multiple directory access
vodou-core connect project-fs npx @modelcontextprotocol/server-filesystem \
  --allowed-dirs /Users/you/projects /Users/you/documents /tmp
```

#### Advanced Filesystem Server Configuration
```bash
# Development environment with comprehensive setup
vodou-core connect dev-fs npx @modelcontextprotocol/server-filesystem \
  --allowed-dirs ~/dev/project ~/dev/configs \
  --sampling-config "data:{\"interval\":5000,\"types\":[\"file_changes\"]}" \
  --notification-config "roots/listChanged:true:{\"auto_update\":true}" \
  --approval-policy "relaxed" \
  --progress-tracking \
  --auto-approve "read_operations,list_operations"

# Production environment (restricted access)
vodou-core connect prod-fs npx @modelcontextprotocol/server-filesystem \
  --allowed-dirs /app/data \
  --approval-policy "strict" \
  --progress-tracking

# Advanced configuration with performance monitoring
vodou-core connect advanced-fs npx @modelcontextprotocol/server-filesystem \
  --allowed-dirs ~/dev/project /tmp \
  --sampling-config "performance:{\"metrics\":[\"cpu\",\"memory\"],\"interval\":10000}" \
  --notification-config "roots/listChanged:true:{\"auto_update\":true,\"log_changes\":true}" \
  --approval-policy "auto" \
  --progress-tracking \
  --auto-approve "sampling,read_operations"
```

### Remote HTTP Servers ⭐ **New!**

```bash
# Connect to remote HTTP server (auto-detects transport from URL)
vodou-core connect gusto --url https://mcp.api.gusto.com/anthropic

# Connect with validation (preview capabilities first)
vodou-core connect gusto --url https://mcp.api.gusto.com/anthropic --validate

# Connect with API key (temporary, for testing)
vodou-core connect gusto --url https://mcp.api.gusto.com/anthropic --api-key "sk-xxx"

# Connect with custom headers
vodou-core connect custom-api --url https://api.example.com/mcp --headers "Authorization:Bearer token"

# Connect with multiple headers (JSON format)
vodou-core connect api-server --url https://api.example.com/mcp \
  --headers '{"Authorization":"Bearer token","X-API-Key":"key-xxx"}'
```

### SSE Transport Servers ⭐ **New!**

```bash
# Auto-detect SSE from URL (ends with /sse)
vodou-core connect asana https://mcp.asana.com/sse

# Explicitly specify SSE transport
vodou-core connect notion https://mcp.notion.com/api --transport sse

# Connect with OAuth (automatic OAuth flow)
vodou-core connect linear https://mcp.linear.app/sse
# OAuth flow will trigger automatically on first request
```

### Streamable HTTP Transport Servers ⭐ **New!**

```bash
# Auto-detect Streamable HTTP from URL (ends with /mcp)
vodou-core connect modern-server https://api.example.com/mcp

# Explicitly specify Streamable HTTP transport
vodou-core connect streamable-server https://api.example.com/api --transport streamable-http

# Use auto-detection mode
vodou-core connect auto-server https://api.example.com/mcp --transport auto
```

### Professional Development Workflow
```bash
# Validate server before adding to database (recommended)
vodou-core connect my-server node ./server.js --validate

# Development server with relaxed policies
vodou-core connect dev-server node ./dev-server.js \
  --approval-policy "relaxed" \
  --auto-approve "read_operations,sampling" \
  --progress-tracking

# Production server with strict security
vodou-core connect prod-server ./bin/prod-server \
  --approval-policy "strict" \
  --progress-tracking
```

## Connection Process

The `connect` command performs these steps:

1. **🔧 Configuration Setup** - Processes and validates all command-line options:
   - **Connection Type Detection** - Automatically detects STDIO, HTTP, or Docker Gateway
   - **Directory Validation** - Verifies allowed directories exist and are accessible (STDIO only)
   - **Policy Configuration** - Sets up user approval policies and auto-approval rules
   - **Sampling Setup** - Configures data sampling parameters if specified
   - **Notification Setup** - Configures server notification preferences
2. **🔌 Connection** - Establishes connection based on type:
   - **STDIO** - Launches the MCP server process with stdin/stdout communication
   - **HTTP** - Creates HTTP client connection to remote server (stateless)
   - **Docker Gateway** - Connects to Docker container servers
3. **🔐 Authentication** - Loads credentials in priority order (HTTP only):
   - **Database credentials** (highest - explicit configuration)
   - **Environment variables** (automatic fallback)
   - **CLI flags** (lowest - temporary for testing)
4. **🤝 Protocol Initialization** - Performs MCP protocol handshake with bidirectional support
5. **🔍 Capability Discovery** - Discovers all available capabilities:
   - **Tools** - Interactive functions that can be called
   - **Prompts** - Reusable templates for LLM interactions
   - **Resources** - Read-only data sources (files, APIs, databases)
6. **🏗️ Context Setup** - Establishes server context for enhanced features:
   - **Filesystem Roots** - Saves allowed directories to database (STDIO only)
   - **Approval Policies** - Stores user approval preferences
   - **Sampling Configuration** - Saves sampling settings
   - **Progress Tracking** - Enables operation monitoring if requested
7. **💾 Storage** - Saves all discovered capabilities and configuration to SQLite database
8. **✅ Verification** - Confirms successful connection, capability storage, and context setup

## Connection Types

Brain Trust 4 automatically detects the connection type:

1. **STDIO** - If command is a local executable (default)
2. **HTTP** - If `--url` flag is provided or command starts with `http://`/`https://`
3. **Docker Gateway** - If using Docker container servers

### HTTP Transport Types

For HTTP connections, Brain Trust 4 supports three transport modes:

1. **Standard HTTP** (default) - Request/response pattern
   - Each request is independent
   - Stateless connections
   - Example: `https://api.example.com/mcp`

2. **SSE Transport** - Server-Sent Events (unidirectional streaming)
   - Long-lived connection for receiving events
   - POST to `/message` for requests
   - Auto-detected from URLs ending with `/sse`
   - Example: `https://mcp.asana.com/sse`

3. **Streamable HTTP** - Bidirectional HTTP streaming (modern standard)
   - Persistent bidirectional connection
   - Single `/mcp` endpoint for all communication
   - Auto-detected from URLs ending with `/mcp`
   - Example: `https://api.example.com/mcp`

**Auto-Detection**: Transport type is automatically detected from the URL path:
- URLs ending with `/sse` → SSE transport
- URLs ending with `/mcp` → Streamable HTTP transport
- Other URLs → Standard HTTP transport

**Manual Override**: Use `--transport` flag to explicitly specify:
- `--transport http` - Force standard HTTP
- `--transport sse` - Force SSE transport
- `--transport streamable-http` - Force Streamable HTTP
- `--transport auto` - Enable auto-detection (default)

### HTTP Connection Behavior

- **Standard HTTP**: Stateless, on-demand connections
- **SSE/Streamable HTTP**: Long-lived connections with automatic reconnection
- **Credential Loading** - Credentials loaded using priority system (database → env → CLI)
- **Timeout** - 30 seconds default (configurable)
- **OAuth Integration** - Automatic OAuth flow for servers requiring authentication

## Remote Server Authentication

For remote HTTP servers, authentication credentials are managed separately using the [`credentials`](credentials.md) command.

### Credential Priority

When connecting to a remote server, credentials are loaded in this order:

1. **Database credentials** (highest - explicit configuration via `credentials` command)
2. **Environment variables** (automatic fallback - checks common patterns)
3. **CLI flags** (lowest - temporary for testing with `--api-key` or `--headers`)

### Adding Credentials

```bash
# Add credential from environment variable (recommended)
vodou-core credentials gusto add --cred-type api_key --from-env "GUSTO_API_KEY" --header "X-API-Key"

# Add credential with stored value
vodou-core credentials gusto add --cred-type api_key "sk-xxx" --header "X-API-Key"
```

See [Credentials Command](credentials.md) for complete authentication management.

## Output Examples

### Successful Connection (Multiple Capabilities)
```
🔌 Connecting to MCP server: mcpadvisor (node)
🤝 Initializing MCP protocol...
🔍 Discovering capabilities...
✅ Connected! Discovered:
   🔧 Tools: 2
   📝 Prompts: 0
   📄 Resources: 10

🔧 Tools:
  - recommend-mcp-servers: Find suitable MCP servers for specific needs
  - install-mcp-server: Install and configure MCP servers

📄 Resources:
  - file:///var/log/system.log: Log: system.log
  - file:///var/log/install.log: Log: install.log
  - file:///tmp/adobegc.log: Log: adobegc.log
  ...
```

### Tools-Only Server
```
🔌 Connecting to MCP server: mcp-monitor (/usr/local/bin/mcp-monitor)
🤝 Initializing MCP protocol...
🔍 Discovering capabilities...
✅ Connected! Discovered:
   🔧 Tools: 6
   📝 Prompts: 0
   📄 Resources: 0

🔧 Tools:
  - get_cpu_info: Get CPU information and usage
  - get_disk_info: Get disk usage information
  - get_host_info: Get host system information
  - get_memory_info: Get system memory usage information
  - get_network_info: Get network interface and traffic information
  - get_process_info: Get process information
```

## Error Handling

### Connection Errors
```bash
# Command not found
vodou-core connect bad-server /nonexistent/binary
# Error: No such file or directory (os error 2)

# Invalid arguments
vodou-core connect py-server python -m nonexistent.module  
# Error: ModuleNotFoundError: No module named 'nonexistent'

# Server startup failure
vodou-core connect broken-server node ./broken-server.js
# Error: Server failed to initialize MCP protocol
```

### Protocol Errors
```
🔌 Connecting to MCP server: old-server (node)
🤝 Initializing MCP protocol...
❌ Protocol initialization failed: Unsupported MCP version

# Or timeout error:
❌ Connection timeout: Server did not respond within 30 seconds
```

## Behavior Notes

### Server Replacement
- **Overwrites existing** servers with the same name
- **Preserves database integrity** by clearing old capabilities first
- **Updates connection details** (command and arguments)

```bash
# First connection
vodou-core connect my-server node ./server-v1.js
# ✅ Connected! Tools: 5

# Update to new version (same name)  
vodou-core connect my-server node ./server-v2.js --new-flag
# ✅ Connected! Tools: 8 (replaces previous connection)
```

### Graceful Fallbacks
- **Prompts discovery failure** → Continue with tools and resources
- **Resources discovery failure** → Continue with tools and prompts  
- **Partial capability support** → Store what's available, continue normally

```
🔍 Discovering capabilities...
⚠️  Server does not support prompts (graceful fallback)
✅ Connected! Discovered:
   🔧 Tools: 12
   📝 Prompts: 0
   📄 Resources: 3
```

### Database Integration
- **Foreign key management** → Properly handles server ID relationships
- **Schema validation** → Ensures all data fits database schema
- **Migration support** → Works with database migrations and schema updates

## Advanced Usage

### Environment Variables
```bash
# Set environment for server process
NODE_ENV=production vodou-core connect prod-server node ./server.js

# Custom paths
PATH="/custom/bin:$PATH" vodou-core connect custom-server my-binary

# Server-specific configuration
CONFIG_FILE=./prod.conf vodou-core connect configured-server ./server
```

### Complex Command Lines
```bash
# Multiple arguments with spaces (use quotes)
vodou-core connect complex-server python -m server.main --config "./path with spaces/config.json" --verbose

# Shell expansion
vodou-core connect local-server ./bin/server-$(uname -m)

# Pipe and redirection (not recommended - use native server logging)
# ❌ vodou-core connect logged-server ./server 2>./error.log
# ✅ Configure logging within the server instead
```

### Testing Connections
```bash
# Test connection without permanent storage (conceptual)
vodou-core connect test-server ./server --test-mode

# Verify connection worked
vodou-core capabilities test-server
vodou-core list | grep test-server
```

## Troubleshooting

### Common Issues

**Command not found**
```bash
# Problem: Server executable not in PATH
vodou-core connect server my-server-binary
# Error: No such file or directory

# Solution: Use absolute path or add to PATH  
vodou-core connect server ./bin/my-server-binary
# or
vodou-core connect server /full/path/to/my-server-binary
```

**Permission denied**
```bash  
# Problem: Binary not executable
vodou-core connect server ./server-binary
# Error: Permission denied

# Solution: Make binary executable
chmod +x ./server-binary
vodou-core connect server ./server-binary
```

**Module not found (Python)**
```bash
# Problem: Python module not installed  
vodou-core connect py-server python -m missing_module.server
# Error: ModuleNotFoundError: No module named 'missing_module'

# Solution: Install module or use correct path
pip install missing_module
# or
vodou-core connect py-server python ./path/to/server.py
```

**Node.js module issues**
```bash
# Problem: Node.js dependencies not installed
vodou-core connect node-server node ./server.js  
# Error: Cannot find module 'express'

# Solution: Install dependencies
npm install
vodou-core connect node-server node ./server.js
```

### Debugging Connection Issues

**Verbose connection testing**
```bash
# Test server manually first
node ./server.js
# Should show MCP server startup messages

# Test with simple JSON-RPC
echo '{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}' | node ./server.js

# Then connect with vodou-core
vodou-core connect debug-server node ./server.js
```

**Check server logs**
- Most MCP servers log to stderr
- Check server documentation for log locations
- Use server's native debugging options

## Related Commands

### Core Server Management
- [`list`](list.md) - View all connected servers
- [`capabilities`](capabilities.md) - Check server capabilities  
- [`tools`](tools.md) - View discovered tools
- [`prompts`](prompts.md) - View discovered prompts
- [`resources`](resources.md) - View discovered resources
- [`health-check`](health-check.md) - Verify server connectivity after connection
- [`call-tool`](call-tool.md) - Use tools via universal routing

### Filesystem Roots Management
- [`roots`](roots.md) - View allowed directories for filesystem servers
- [`update-roots`](update-roots.md) - Add or remove allowed directories
- [`clear-roots`](clear-roots.md) - Clear all allowed directories

### User Approval System
- [`approvals`](approvals.md) - View approval history and pending requests
- [`approval-policy`](approval-policy.md) - Configure approval policies
- [`auto-approve`](auto-approve.md) - Set up auto-approval rules

### Progress Tracking
- [`progress`](progress.md) - Monitor operation progress
- [`cancel`](cancel.md) - Cancel running operations
- [`clear-progress`](clear-progress.md) - Clean up completed progress entries

### Alternative Connection Methods
- [`install`](install.md) - Auto-install servers from registries (alternative to manual connect)
- [`registry`](registry.md) - View connected servers with enhanced metadata
- [`validate`](validate.md) - Pre-validate servers before connecting

## See Also

- [Examples](../examples.md#connection-examples) - Real-world connection examples
- [Troubleshooting](../troubleshooting.md#connection-issues) - Connection troubleshooting
- [Architecture](../../docs-DEV/architecture.md#mcp-client-architecture) (internal) — how connections work internally
- [Database Schema](../../docs-DEV/database-schema.md#server-configuration) (internal) — configuration storage details