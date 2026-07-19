# list - Connected Servers Overview

List all connected MCP servers with their connection details, command information, and enhanced status from Brain Trust 4's Universal MCP Architecture.

## Syntax

```bash
vodou-core list
```

## Parameters

None. This command takes no arguments.

## Examples

```bash
# List all connected servers
vodou-core list

# Use in scripts to get server names
vodou-core list | grep "^  -" | cut -d: -f1 | sed 's/^  - //'

# Check if specific server is connected
vodou-core list | grep "my-server"
```

## Output Examples

### Enhanced Server List (Brain Trust 4)
```
📋 Connected MCP servers (Enhanced MCP Orchestration):
  - chrome-devtools: npx -y chrome-devtools-mcp@latest
    🏥 Status: ✅ Healthy | 🔧 Tools: 17 | ⚡ Pool: Active | 🎯 Routing: Optimal
  - mcp-monitor: /path/to/vodou/modules/mcp-monitor/bin/mcp-monitor
    🏥 Status: ✅ Healthy | 🔧 Tools: 6 | ⚡ Pool: Active | 🎯 Routing: Optimal
  - mcpadvisor: node ../brain-trust3/modules/mcpadvisor/build/index.js
    🏥 Status: ✅ Healthy | 🔧 Tools: 2 | ⚡ Pool: Active | 🎯 Routing: Good
  - weather-service: python -m mcp_weather.server --port 8080
    🏥 Status: ⚠️ Degraded | 🔧 Tools: 5 | ⚡ Pool: Inactive | 🎯 Routing: Limited
```

### No Connected Servers
```
No MCP servers connected yet.
Use: vodou-core connect <name> <command> <args...>
```

### Single Server
```
📋 Connected MCP servers:
  - system-monitor: ./bin/monitor --config ./monitor.conf
```

## Output Format

Each server is displayed in the format:
```
  - <SERVER_NAME>: <COMMAND> <ARGUMENTS>
```

Where:
- **SERVER_NAME** - The name used in other commands (`tools`, `call`, etc.)
- **COMMAND** - The executable command used to start the server
- **ARGUMENTS** - Space-separated arguments passed to the command

## Use Cases

### 1. Server Discovery
Find what servers are available for use:
```bash
# Quick check of available servers
vodou-core list

# Get just the server names
vodou-core list | grep "^  -" | cut -d: -f1 | sed 's/^  - //'
```

### 2. Script Integration
Use in scripts to work with all servers:
```bash
#!/bin/bash
# Check health of all connected servers

echo "🔍 Checking server health..."
vodou-core list | grep "^  -" | while IFS=: read -r server rest; do
    server_name=$(echo "$server" | sed 's/^  - //')
    echo -n "Checking $server_name... "
    
    if vodou-core capabilities "$server_name" >/dev/null 2>&1; then
        echo "✅ Healthy"
    else
        echo "❌ Unhealthy"
    fi
done
```

### 3. Environment Validation
Verify expected servers are connected:
```bash
#!/bin/bash
# Validate development environment

REQUIRED_SERVERS=("monitor" "analyzer" "weather")
MISSING_SERVERS=()

for server in "${REQUIRED_SERVERS[@]}"; do
    if ! vodou-core list | grep -q "^  - $server:"; then
        MISSING_SERVERS+=("$server")
    fi
done

if [ ${#MISSING_SERVERS[@]} -eq 0 ]; then
    echo "✅ All required servers connected"
else
    echo "❌ Missing servers: ${MISSING_SERVERS[*]}"
    echo "Connect them with:"
    for server in "${MISSING_SERVERS[@]}"; do
        echo "  vodou-core connect $server <command> <args...>"
    done
fi
```

### 4. Server Information Extraction
Extract specific information about servers:
```bash
# Get all Python-based servers
vodou-core list | grep "python"

# Get all Node.js servers
vodou-core list | grep "node"

# Get all native binary servers (no interpreter)
vodou-core list | grep -v "node\|python\|npx"

# Count total servers
vodou-core list | grep -c "^  -"
```

## Server Name Usage

The server names from `list` are used in other commands:

```bash
# If list shows:
#   - weather-api: python -m weather.server

# Then you can use "weather-api" in:
vodou-core capabilities weather-api
vodou-core tools weather-api
vodou-core call weather-api get_weather '{"location": "NYC"}'
```

## Connection Status

The `list` command shows **configured** servers, not necessarily **active** servers. A server appearing in `list` means:

✅ **Server was connected** at some point using `connect`  
✅ **Connection details are stored** in the database  
❓ **Server may or may not be currently running**

To check if a server is currently active, use:
```bash
# Test server responsiveness
vodou-core capabilities server-name

# This will show:
# ✅ Server supports: ... (if active)
# ⚠️ Could not test live capabilities (if inactive)
```

## Server Information Details

### Command Reconstruction
The `list` output shows exactly how to recreate the server connection:

```bash
# List shows:
#   - my-server: node ./server.js --port 3000 --verbose

# This means it was connected with:
vodou-core connect my-server node ./server.js --port 3000 --verbose

# And can be reconnected the same way:
vodou-core connect my-server node ./server.js --port 3000 --verbose
```

### Path Information
- **Relative paths** are shown as originally provided
- **Absolute paths** are shown in full
- **Environment variables** are not expanded in the display

```bash
# Original connection:
vodou-core connect monitor ./bin/monitor

# List shows:
#   - monitor: ./bin/monitor

# Original with absolute path:
vodou-core connect monitor /usr/local/bin/monitor

# List shows:
#   - monitor: /usr/local/bin/monitor
```

## Sorting and Ordering

Servers are displayed in **alphabetical order** by server name:

```bash
# Servers will appear as:
#   - analyzer: ...
#   - monitor: ...
#   - weather: ...
#   - zookeeper: ...
```

## Empty State Guidance

When no servers are connected, the command provides helpful guidance:

```
No MCP servers connected yet.
Use: vodou-core connect <name> <command> <args...>
```

This reminds users of the basic command needed to start adding servers.

## Integration Examples

### With Other Commands

**Get capabilities for all servers:**
```bash
vodou-core list | grep "^  -" | cut -d: -f1 | sed 's/^  - //' | while read server; do
    echo "=== $server ==="
    vodou-core capabilities "$server"
    echo
done
```

**Call same tool on all servers that support it:**
```bash
#!/bin/bash
TOOL="get_status"

vodou-core list | grep "^  -" | cut -d: -f1 | sed 's/^  - //' | while read server; do
    if vodou-core tools "$server" | grep -q "$TOOL"; then
        echo "=== $server.$TOOL ==="
        vodou-core call "$server" "$TOOL"
        echo
    fi
done
```

### With JSON Processing
```bash
# Create JSON list of all servers (conceptual - would need JSON output feature)
vodou-core list | grep "^  -" | while IFS=: read -r server command; do
    server_name=$(echo "$server" | sed 's/^  - //')
    echo "{\"name\": \"$server_name\", \"command\": \"$command\"}"
done | jq -s '.'
```

### With Monitoring Tools
```bash
# Create Prometheus-style metrics
vodou-core list | grep "^  -" | cut -d: -f1 | sed 's/^  - //' | while read server; do
    if vodou-core capabilities "$server" >/dev/null 2>&1; then
        echo "mcp_server_status{server=\"$server\"} 1"
    else
        echo "mcp_server_status{server=\"$server\"} 0" 
    fi
done
```

## Troubleshooting

### No Output
If `list` produces no output, check:

```bash
# Verify database exists and is readable
ls -la vodou-core.db

# Check database permissions
file vodou-core.db

# Test database connectivity
sqlite3 vodou-core.db "SELECT COUNT(*) FROM mcp_servers;"
```

### Unexpected Servers
If servers appear that you don't recognize:

```bash
# Check all server details
sqlite3 vodou-core.db "SELECT name, command, args FROM mcp_servers;"

# Remove unwanted server (this removes all its data)
# Note: No direct "remove" command exists - would need manual database operation
# or reconnect with updated information
```

### Stale Server Information
If servers shown in `list` are no longer valid:

```bash
# Test each server
vodou-core list | grep "^  -" | cut -d: -f1 | sed 's/^  - //' | while read server; do
    echo -n "$server: "
    if vodou-core capabilities "$server" >/dev/null 2>&1; then
        echo "✅ Active"
    else
        echo "❌ Inactive - consider reconnecting"
    fi
done

# Reconnect inactive servers
vodou-core connect inactive-server node ./new-path/server.js
```

## Related Commands

- [`connect`](connect.md) - Add servers to the list
- [`capabilities`](capabilities.md) - Check if listed servers are active
- [`tools`](tools.md) - Use server names from list to view tools
- [`call`](call.md) - Use server names from list to call tools
- [`registry`](registry.md) - Enhanced server registry with filtering and metadata
- [`health-dashboard`](health-dashboard.md) - Real-time health monitoring for listed servers
- [`call-tool`](call-tool.md) - Universal tool routing across all listed servers

## See Also

- [Examples](../examples.md#server-management) - Server management workflows
- [CLI Reference](../cli-reference.md#list) - Complete command reference