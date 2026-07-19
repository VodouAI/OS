# call - Execute Tools on MCP Servers

Call a tool on a specific MCP server with optional JSON parameters. This is the traditional server-specific method - for enhanced universal routing, see [`call-tool`](call-tool.md) which routes automatically across servers.

## Syntax

```bash
vodou-core call <SERVER> <TOOL> [ARGS]
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `<SERVER>` | Yes | Server name (from `list` command) |
| `<TOOL>` | Yes | Tool name (from `tools` command) |
| `[ARGS]` | No | JSON arguments for the tool |

## Examples

### Tools Without Parameters
```bash
# Get system CPU information
vodou-core call mcp-monitor get_cpu_info

# Get server status
vodou-core call my-server get_status

# Get project structure
vodou-core call codebase-ai get_project_structure
```

### Tools With Simple Parameters
```bash
# Get weather for specific location
vodou-core call weather-mcp get_weather '{"location": "San Francisco"}'

# List console messages from the active browser tab
vodou-core call chrome-devtools list_console_messages '{}'

# Get system info with specific format
vodou-core call monitor get_system_info '{"format": "json"}'
```

### Tools With Complex Parameters
```bash
# Open a URL in the browser attached to Chrome DevTools MCP
vodou-core call chrome-devtools navigate_page '{
  "type": "url",
  "url": "https://example.com"
}'

# Search with multiple filters
vodou-core call search-server search '{
  "query": "authentication",
  "filters": {
    "type": "code",
    "language": "rust",
    "modified_after": "2024-01-01"
  },
  "options": {
    "include_tests": false,
    "max_results": 50
  }
}'

# Batch processing with array parameters
vodou-core call processor batch_process '{
  "items": [
    {"path": "./file1.txt", "type": "text"},
    {"path": "./file2.json", "type": "json"}
  ],
  "config": {
    "parallel": true,
    "timeout": 300
  }
}'
```

## Output Examples

### Successful Tool Call (System Monitor)
```bash
$ vodou-core call mcp-monitor get_cpu_info

🎯 Calling tool 'get_cpu_info' on server 'mcp-monitor'...
📦 Result:
{
  "usage_percent": 23.4,
  "cores": 8,
  "threads": 16,
  "temperature": 62.0,
  "frequency_mhz": 2400,
  "load_average": [1.2, 1.4, 1.6],
  "processes": 342
}
```

### Successful Tool Call (Chrome DevTools — page snapshot)
```bash
$ vodou-core call chrome-devtools take_snapshot '{}'

🎯 Calling tool 'take_snapshot' on server 'chrome-devtools'...
📦 Result:
{
  "snapshot": "(accessibility tree / DOM summary from the active tab)"
}
```

### Tool Call with Array Result
```bash
$ vodou-core call mcp-monitor get_process_info

🎯 Calling tool 'get_process_info' on server 'mcp-monitor'...
📦 Result:
[
  {
    "pid": 1234,
    "name": "rust-analyzer",
    "cpu_percent": 5.2,
    "memory_mb": 128,
    "status": "running"
  },
  {
    "pid": 5678,
    "name": "cargo",
    "cpu_percent": 12.8,
    "memory_mb": 64,
    "status": "running"
  }
]
```

## Error Examples

### Tool Not Found
```bash
$ vodou-core call mcp-monitor unknown_tool

❌ Error: Tool 'unknown_tool' not found on server 'mcp-monitor'

Available tools:
  - get_cpu_info: Get CPU information and usage
  - get_disk_info: Get disk usage information  
  - get_host_info: Get host system information
  - get_memory_info: Get system memory usage information
  - get_network_info: Get network interface and traffic information
  - get_process_info: Get process information
```

### Server Not Found
```bash
$ vodou-core call unknown-server some-tool

❌ Error: Server 'unknown-server' not found

Connected servers:
  - mcp-monitor: /usr/local/bin/mcp-monitor
  - chrome-devtools: npx -y chrome-devtools-mcp@latest
  - mcpadvisor: node ./modules/mcpadvisor/build/index.js
```

### Invalid JSON Arguments
```bash
$ vodou-core call weather-mcp get_weather '{invalid json'

❌ Error: Invalid JSON arguments
Expected valid JSON string, got: {invalid json
```

### Server Connection Error
```bash
$ vodou-core call offline-server get_status

❌ Error: Could not connect to server 'offline-server'
Server may be offline or configuration may have changed.
Try reconnecting: vodou-core connect offline-server <command> <args...>
```

### Tool Execution Error
```bash
$ vodou-core call weather-mcp get_weather '{"location": "InvalidLocation"}'

🎯 Calling tool 'get_weather' on server 'weather-mcp'...
❌ MCP Error: {
  "code": -32602,
  "message": "Invalid location: InvalidLocation",
  "data": {
    "valid_locations": ["San Francisco", "New York", "London"]
  }
}
```

## JSON Parameter Guidelines

### Parameter Validation
Always validate JSON before calling:
```bash
# Test JSON validity
JSON_PARAMS='{"location": "San Francisco", "units": "metric"}'
if echo "$JSON_PARAMS" | jq empty 2>/dev/null; then
    vodou-core call weather-mcp get_weather "$JSON_PARAMS"
else
    echo "❌ Invalid JSON parameters"
fi
```

### Common Parameter Patterns

**String parameters:**
```bash
vodou-core call server tool '{"name": "value"}'
vodou-core call server search '{"query": "search term"}'
```

**Numeric parameters:**
```bash
vodou-core call server analyze '{"depth": 5, "timeout": 30}'
vodou-core call server paginate '{"page": 1, "limit": 100}'
```

**Boolean parameters:**
```bash
vodou-core call server process '{"verbose": true, "dry_run": false}'
```

**Array parameters:**
```bash
vodou-core call server filter '{"types": ["rust", "javascript", "python"]}'
vodou-core call server process '{"files": ["./file1.txt", "./file2.txt"]}'
```

**Nested object parameters:**
```bash
vodou-core call server configure '{
  "database": {
    "host": "localhost",
    "port": 5432,
    "ssl": true
  },
  "cache": {
    "enabled": true,
    "ttl": 3600
  }
}'
```

### Empty Parameters
If no parameters needed:
```bash
# These are equivalent:
vodou-core call server tool
vodou-core call server tool '{}'
```

## Advanced Usage

### Using Environment Variables
```bash
# Set parameters from environment
LOCATION="San Francisco" vodou-core call weather-mcp get_weather "{\"location\": \"$LOCATION\"}"

# Complex parameter building
API_KEY="secret123"
PARAMS=$(cat << EOF
{
  "api_key": "$API_KEY",
  "query": "weather data",
  "options": {
    "format": "json",
    "units": "metric"
  }
}
EOF
)
vodou-core call api-server fetch_data "$PARAMS"
```

### File-based Parameters
```bash
# Store complex parameters in file
cat > params.json << 'EOF'
{
  "analysis": {
    "path": "./src",
    "include_patterns": ["*.rs", "*.toml"],
    "exclude_patterns": ["target/*"],
    "options": {
      "semantic_analysis": true,
      "performance_check": true,
      "security_scan": false
    }
  },
  "output": {
    "format": "detailed",
    "include_metrics": true
  }
}
EOF

# Use file contents as parameters
vodou-core call analyzer comprehensive_analysis "$(cat params.json)"
```

### Streaming and Large Results
```bash
# Some tools may return large results - pipe to file
vodou-core call big-data-server export_all > large_dataset.json

# Or process with jq
vodou-core call analytics-server get_report | jq '.summary'

# Paginate large results
for page in {1..5}; do
    vodou-core call server get_data "{\"page\": $page, \"limit\": 100}" >> all_data.json
done
```

## Tool Discovery Integration

### Find Available Tools
```bash
# List all tools for a server
vodou-core tools mcp-monitor

# Find tools matching pattern (using grep)
vodou-core tools chrome-devtools | grep -i "snapshot"

# Get tool parameter information
vodou-core tools weather-server | grep -A 5 "get_weather"
```

### Test Tool Parameters
```bash
# Start with simple parameters
vodou-core call server tool '{}'

# Add parameters gradually
vodou-core call server tool '{"basic_param": "value"}'
vodou-core call server tool '{"basic_param": "value", "advanced_param": true}'
```

## Performance Considerations

### Connection Overhead
Each `call` command:
1. **Connects** to the server process (100-500ms)
2. **Initializes** MCP protocol (50-200ms)
3. **Executes** the tool (varies by tool)
4. **Closes** connection (10-50ms)

**Total overhead**: ~200-800ms per call

### Optimization Strategies

**Batch multiple calls:**
```bash
# Instead of multiple individual calls:
# vodou-core call server tool1
# vodou-core call server tool2
# vodou-core call server tool3

# Consider servers that support batch operations:
vodou-core call server batch_tools '{
  "tools": [
    {"name": "tool1", "params": {}},
    {"name": "tool2", "params": {"arg": "value"}},
    {"name": "tool3", "params": {}}
  ]
}'
```

**Use appropriate timeouts:**
```bash
# For slow operations, use timeout
timeout 300 vodou-core call slow-server long_running_analysis

# Or check if server supports progress monitoring
vodou-core call server start_analysis '{"task_id": "abc123"}'
# ... later check progress
vodou-core call server get_progress '{"task_id": "abc123"}'
```

## Error Handling in Scripts

### Basic Error Checking
```bash
# Check command success
if vodou-core call server tool '{"param": "value"}'; then
    echo "✅ Tool executed successfully"
else
    echo "❌ Tool execution failed"
    exit 1
fi
```

### Advanced Error Handling
```bash
#!/bin/bash
# robust_call.sh - Robust tool calling with retry

SERVER="$1"
TOOL="$2" 
PARAMS="$3"
MAX_RETRIES=3
RETRY_DELAY=5

for attempt in $(seq 1 $MAX_RETRIES); do
    echo "Attempt $attempt of $MAX_RETRIES..."
    
    if result=$(vodou-core call "$SERVER" "$TOOL" "$PARAMS" 2>&1); then
        echo "✅ Success on attempt $attempt"
        echo "$result"
        exit 0
    else
        echo "❌ Attempt $attempt failed: $result"
        
        if [ $attempt -lt $MAX_RETRIES ]; then
            echo "Retrying in ${RETRY_DELAY}s..."
            sleep $RETRY_DELAY
        fi
    fi
done

echo "❌ All attempts failed"
exit 1
```

### Parameter Validation
```bash
#!/bin/bash
# validate_and_call.sh - Validate parameters before calling

SERVER="$1"
TOOL="$2"
PARAMS="$3"

# Validate JSON
if ! echo "$PARAMS" | jq empty 2>/dev/null; then
    echo "❌ Invalid JSON parameters: $PARAMS"
    exit 1
fi

# Validate server exists
if ! vodou-core list | grep -q "^  - $SERVER:"; then
    echo "❌ Server '$SERVER' not found"
    vodou-core list
    exit 1
fi

# Validate tool exists  
if ! vodou-core tools "$SERVER" | grep -q "^  - $TOOL:"; then
    echo "❌ Tool '$TOOL' not found on server '$SERVER'"
    vodou-core tools "$SERVER"
    exit 1
fi

# Execute call
vodou-core call "$SERVER" "$TOOL" "$PARAMS"
```

## Related Commands

- [`tools`](tools.md) - List available tools and their parameters
- [`capabilities`](capabilities.md) - Check server capabilities before calling
- [`connect`](connect.md) - Connect to servers to make tools available  
- [`list`](list.md) - Find server names for the call command
- [`call-tool`](call-tool.md) - **Recommended**: Universal tool routing (no server specification needed)
- [`find-tool`](find-tool.md) - Find which servers provide specific tools
- [`all-tools`](all-tools.md) - View all tools across all servers

## See Also

- [Examples](../examples.md#tool-calling) - Real-world tool calling examples
- [Troubleshooting](../troubleshooting.md#tool-calling-issues) - Tool calling troubleshooting
- [Architecture](../../docs-DEV/architecture.md#tool-execution) (internal) — how tool execution works internally