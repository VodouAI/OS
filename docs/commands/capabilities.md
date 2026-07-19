# capabilities - Server Capability Overview

Show complete capabilities overview for a specific MCP server, including live testing of what the server currently supports.

## Syntax

```bash
vodou-core capabilities <NAME>
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `<NAME>` | Yes | Server name (from `list` command) |

## Examples

```bash
# Check capabilities for system monitor
vodou-core capabilities mcp-monitor

# Check capabilities for codebase analyzer  
vodou-core capabilities chrome-devtools

# Check capabilities for MCP advisor
vodou-core capabilities mcpadvisor
```

## Output Examples

### Server with Multiple Capability Types
```
⚙️ Capabilities for mcpadvisor:
  🔧 Tools: 2
  📝 Prompts: 0
  📄 Resources: 10

🔍 Testing live capabilities...
  ✅ Server supports:
    🔧 Tools (2)
    📄 Resources (10)
```

### Tools-Only Server
```  
⚙️ Capabilities for mcp-monitor:
  🔧 Tools: 6
  📝 Prompts: 0
  📄 Resources: 0

🔍 Testing live capabilities...
  ✅ Server supports:
    🔧 Tools (6)
```

### Large Server (Codebase Analyzer)
```
⚙️ Capabilities for chrome-devtools:
  🔧 Tools: 17
  📝 Prompts: 0
  📄 Resources: 0

🔍 Testing live capabilities...
  ✅ Server supports:
    🔧 Tools (17)
```

### Server Not Found
```
No capabilities found for server: unknown-server
Try connecting first: vodou-core connect unknown-server <command> <args...>
```

## Capability Types

### 🔧 Tools
Interactive functions that can be called with parameters.

**Examples from real servers:**
- **System Monitor**: `get_cpu_info`, `get_memory_info`, `get_disk_info`
- **Chrome DevTools MCP** (example): `navigate_page`, `take_snapshot`, `take_screenshot`, `list_console_messages`
- **MCP Advisor**: `recommend-mcp-servers`, `install-mcp-server`

### 📝 Prompts  
Reusable templates for LLM interactions with defined arguments.

**Typical examples:**
- Code review prompts with code and language parameters
- Documentation generation prompts with source path parameters
- Analysis prompts with configuration parameters

**Note**: Most current MCP servers don't provide prompts (graceful fallback to 0).

### 📄 Resources
Read-only data sources that can be accessed by AI agents.

**Examples from real servers:**
- **Log Files**: `/var/log/system.log`, `/var/log/install.log`
- **Configuration Files**: Application configs, system settings
- **Data Sources**: APIs, databases, document repositories
- **Temporary Files**: Cache files, processing outputs

## Live Testing

The `capabilities` command performs **live testing** by:

1. **Database Query** - Gets stored capability counts from database
2. **Connection Test** - Attempts to connect to the live server
3. **Protocol Test** - Tests MCP protocol initialization  
4. **Capability Test** - Tests each capability type (tools, prompts, resources)
5. **Report Results** - Shows what the server currently supports

### Live Testing Benefits
- **Real-time Status** - Shows current server health
- **Capability Verification** - Confirms server still supports advertised capabilities
- **Connection Health** - Indicates if server is responsive
- **Protocol Compliance** - Verifies MCP protocol compatibility

### Live Testing Limitations
```
⚙️ Capabilities for offline-server:
  🔧 Tools: 5
  📝 Prompts: 0  
  📄 Resources: 2

🔍 Testing live capabilities...
  ⚠️ Could not test live capabilities (connection failed)
```

This indicates the server was previously connected but is currently unavailable.

## Use Cases

### 1. Server Health Monitoring
```bash
#!/bin/bash
# Check health of all servers
for server in $(vodou-core list | grep "^  -" | cut -d: -f1 | sed 's/^  - //'); do
    echo "Checking $server..."
    vodou-core capabilities "$server" | grep -E "✅|⚠️|❌"
done
```

### 2. Capability Audit
```bash
# Get comprehensive capability overview
echo "=== MCP Server Capability Audit ==="
vodou-core list | grep "^  -" | while IFS=: read -r server rest; do
    server=$(echo "$server" | sed 's/^  - //')
    echo ""
    echo "Server: $server"
    vodou-core capabilities "$server" | grep -E "🔧|📝|📄"
done
```

### 3. Pre-execution Validation
```bash
# Check server capabilities before running workflow
if vodou-core capabilities my-server | grep -q "🔧 Tools: [1-9]"; then
    echo "✅ Server has tools - proceeding with workflow"
    vodou-core call my-server my-tool '{"param": "value"}'
else
    echo "❌ Server has no tools available"
    exit 1
fi
```

### 4. Development Environment Check
```bash
# Verify development environment is ready
REQUIRED_SERVERS=("monitor" "analyzer" "advisor")
ALL_READY=true

for server in "${REQUIRED_SERVERS[@]}"; do
    if ! vodou-core capabilities "$server" | grep -q "✅ Server supports:"; then
        echo "❌ $server not ready"
        ALL_READY=false
    fi
done

if $ALL_READY; then
    echo "✅ All servers ready for development"
else
    echo "⚠️ Some servers need attention"
fi
```

## Comparison with Other Commands

### vs `tools`, `prompts`, `resources`
- **`capabilities`** - High-level overview with live testing
- **`tools`** - Detailed tool list with descriptions and parameters
- **`prompts`** - Detailed prompt list with arguments
- **`resources`** - Detailed resource list with URIs and metadata

### vs `list`
- **`capabilities`** - Focus on what one server can do
- **`list`** - Overview of all connected servers

### vs `call`  
- **`capabilities`** - Discovery and status checking
- **`call`** - Actual execution of server functionality

## Performance Considerations

### Database vs Live Testing
- **Database queries** are fast (< 1ms)
- **Live testing** requires server connection (100ms - 5s)
- **Failed connections** may timeout (up to 30s)

### Batch Capability Checking
```bash
# Sequential (slow for many servers)
for server in server1 server2 server3; do
    vodou-core capabilities "$server"
done

# Better: Check critical servers first
vodou-core capabilities primary-server
if [ $? -eq 0 ]; then
    # Check secondary servers in background
    vodou-core capabilities secondary-server &
    vodou-core capabilities tertiary-server &
    wait
fi
```

## Error Handling

### Server Connection Failures
```
⚙️ Capabilities for broken-server:
  🔧 Tools: 3
  📝 Prompts: 0
  📄 Resources: 1

🔍 Testing live capabilities...
  ⚠️ Could not test live capabilities (connection failed)
```

**Common causes:**
- Server process not running
- Server crashed or became unresponsive  
- Network connectivity issues (for remote servers)
- Server configuration changes

### Protocol Failures
```
⚙️ Capabilities for outdated-server:
  🔧 Tools: 2
  📝 Prompts: 0
  📄 Resources: 0

🔍 Testing live capabilities...
  ⚠️ Could not test live capabilities (initialization failed)
```

**Common causes:**
- Server using incompatible MCP protocol version
- Server not implementing required MCP methods
- Server hanging during initialization

## Troubleshooting

### Server Shows Capabilities but Live Testing Fails
```bash
# 1. Check if server process is running
ps aux | grep server-name

# 2. Test server manually
node ./path/to/server.js
# Should show MCP initialization

# 3. Check server logs
# (varies by server - check server documentation)

# 4. Reconnect server
vodou-core connect server-name node ./path/to/server.js
vodou-core capabilities server-name
```

### Live Testing Timeout
```bash
# Server responds slowly - wait longer
timeout 60 vodou-core capabilities slow-server

# Or check server performance
time vodou-core capabilities server-name
```

### Inconsistent Results
```bash
# Clear and reconnect server
vodou-core connect server-name node ./server.js
vodou-core capabilities server-name

# Compare database vs live results
echo "Database says:"
vodou-core tools server-name | wc -l
echo "Live test says:" 
vodou-core capabilities server-name | grep "🔧 Tools:"
```

## Related Commands

- [`connect`](connect.md) - Connect servers and discover capabilities
- [`list`](list.md) - List all connected servers  
- [`tools`](tools.md) - Detailed tool information
- [`prompts`](prompts.md) - Detailed prompt information
- [`resources`](resources.md) - Detailed resource information

## See Also

- [Examples](../examples.md#capability-discovery) - Capability discovery workflows
- [Troubleshooting](../troubleshooting.md#capability-issues) - Capability troubleshooting
- [Architecture](../../docs-DEV/architecture.md#capability-discovery) (internal) — how capability discovery works