# tools - Server Tools Discovery

Show all available tools for a specific MCP server with detailed information including descriptions, parameters, and enhanced Brain Trust 4 universal routing integration.

## Syntax

```bash
vodou-core tools <NAME>
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `<NAME>` | Yes | Server name (from `list` command) |

## Examples

```bash
# Show tools for system monitor
vodou-core tools mcp-monitor

# Show tools for codebase analyzer
vodou-core tools chrome-devtools

# Show tools for MCP advisor
vodou-core tools mcpadvisor
```

## Output Examples

### Enhanced System Monitor Tools (Brain Trust 4)
```
🔧 Tools for mcp-monitor (Enhanced with Universal Routing):
  ⚡ get_cpu_info: Get CPU information and usage
    Parameters: interval, detailed
    🎯 Universal Routing: Available via 'vodou-core call-tool get_cpu_info'
    📊 Usage: Called 45 times via universal routing (primary provider)

  ⚡ get_disk_info: Get disk usage information
    🎯 Universal Routing: Available via 'vodou-core call-tool get_disk_info'

  ⚡ get_host_info: Get host system information
    Parameters: format, include_hardware
    🎯 Universal Routing: Available via 'vodou-core call-tool get_host_info'

  ⚡ get_memory_info: Get system memory usage information
    🎯 Universal Routing: Available via 'vodou-core call-tool get_memory_info'

  ⚡ get_network_info: Get network interface and traffic information
    Parameters:
      - interface
      - detailed

  - get_process_info: Get process information
    Parameters:
      - filter
      - sort_by
```

### Chrome DevTools MCP (example tool listing)
```
🔧 Tools for chrome-devtools:
  - navigate_page: Open a URL or navigate within the attached browser
  - take_snapshot: Accessibility-oriented snapshot of the active tab
  - take_screenshot: Viewport screenshot
  - list_console_messages: Recent console output
  - list_network_requests: Recent network requests
```

### MCP Advisor Tools
```
🔧 Tools for mcpadvisor:
  - recommend-mcp-servers: Find suitable MCP servers for specific needs
    Parameters:
      - domain
      - type
      - requirements

  - install-mcp-server: Install and configure MCP servers
    Parameters:
      - name
      - source
      - config_path
```

### No Tools Available
```
No tools found for server: empty-server
Try connecting first: vodou-core connect empty-server <command> <args...>
```

## Tool Information Structure

Each tool entry shows:

### Basic Information
- **Tool name** - Used with `call` command
- **Description** - What the tool does
- **Parameters** (if available) - Input parameters the tool accepts

### Parameter Information
When available from the tool's input schema:
- **Parameter names** - Names of accepted parameters
- **Required vs optional** - Which parameters are mandatory
- **Data types** - Expected parameter types (when schema is detailed)

## Tool Discovery Process

Tools are discovered during the `connect` operation:

1. **Connection established** with MCP server
2. **Protocol initialized** following MCP specification
3. **Tools listed** via `tools/list` MCP method
4. **Schema extracted** from tool definitions
5. **Database stored** for persistent access

## Usage with `call` Command

The tool names from this command are used directly with [`call`](call.md):

```bash
# First, discover available tools
vodou-core tools mcp-monitor

# Then call a specific tool
vodou-core call mcp-monitor get_cpu_info

# Or with parameters
vodou-core call mcp-monitor get_cpu_info '{"detailed": true, "interval": 1}'
```

## Parameter Schema Information

### When Available
If the server provides detailed input schemas, you'll see:

```
🔧 Tools for advanced-server:
  - complex_analysis: Perform complex data analysis
    Parameters:
      - data_path (required, string)
      - analysis_type (optional, enum: ["fast", "thorough", "custom"])
      - options (optional, object)
      - timeout (optional, integer, default: 300)
```

### Limited Schema Information
Many servers provide minimal schema information:

```
🔧 Tools for basic-server:
  - simple_tool: Does something useful
    Parameters:
      - config
      - mode
```

### No Schema Information
Some servers provide no parameter information:

```
🔧 Tools for minimal-server:
  - mystery_tool: Performs an operation
```

## Tool Categories by Server Type

### System Monitoring Tools
Common patterns in system monitoring servers:
- **Status tools**: `get_*_info`, `get_*_status`
- **Metric tools**: `get_*_metrics`, `monitor_*`
- **Health tools**: `health_check`, `system_status`

### Codebase Analysis Tools
Common patterns in code analysis servers:
- **Analysis tools**: `analyze_*`, `scan_*`, `review_*`
- **Search tools**: `search_*`, `find_*`, `query_*`  
- **Generation tools**: `generate_*`, `create_*`, `build_*`
- **Intelligence tools**: `learn_*`, `understand_*`, `predict_*`

### Data Processing Tools
Common patterns in data processing servers:
- **Transform tools**: `convert_*`, `transform_*`, `process_*`
- **Extract tools**: `extract_*`, `parse_*`, `read_*`
- **Export tools**: `export_*`, `save_*`, `write_*`

### API Integration Tools  
Common patterns in API integration servers:
- **Fetch tools**: `get_*`, `fetch_*`, `retrieve_*`
- **Update tools**: `update_*`, `modify_*`, `set_*`
- **Search tools**: `search_*`, `find_*`, `list_*`

## Error Scenarios

### Server Not Found
```
No tools found for server: unknown-server
Try connecting first: vodou-core connect unknown-server <command> <args...>
```

**Solution**: Check server name with `vodou-core list` or connect the server.

### Server Connected but No Tools
```
No tools found for server: resource-only-server
Try connecting first: vodou-core connect resource-only-server <command> <args...>
```

**Note**: This can happen if:
- Server provides only prompts/resources (no tools)
- Server discovery failed during connection
- Server tools were not properly stored

**Solution**: Reconnect the server to refresh capabilities.

### Database Issues
If the command fails entirely, check:
```bash
# Verify database connectivity
vodou-core list

# Check database schema
sqlite3 vodou-core.db ".tables" | grep tools

# Test server connectivity
vodou-core capabilities server-name
```

## Tool Parameter Discovery

### Using Tools Information for `call`

1. **Find the tool**:
   ```bash
   vodou-core tools my-server | grep "target-tool"
   ```

2. **Check parameters**:
   ```bash
   vodou-core tools my-server | grep -A 10 "target-tool"
   ```

3. **Call with appropriate parameters**:
   ```bash
   # No parameters
   vodou-core call my-server target-tool
   
   # With parameters
   vodou-core call my-server target-tool '{"param1": "value1", "param2": true}'
   ```

### Parameter Experimentation

```bash
# Start with empty parameters
vodou-core call server tool '{}'

# Add parameters gradually based on tool description
vodou-core call server tool '{"basic_param": "value"}'

# Use server error messages to understand required parameters
vodou-core call server tool '{"wrong_param": "value"}'
# Error message may indicate correct parameter names
```

## Integration with Other Commands

### Workflow Integration
```bash
# 1. Discover servers
vodou-core list

# 2. Check capabilities overview  
vodou-core capabilities server-name

# 3. Get detailed tool information
vodou-core tools server-name

# 4. Execute specific tools
vodou-core call server-name tool-name '{"param": "value"}'
```

### Scripting Integration
```bash
#!/bin/bash
# Find servers that have a specific tool

TARGET_TOOL="get_status"

vodou-core list | grep "^  -" | cut -d: -f1 | sed 's/^  - //' | while read server; do
    if vodou-core tools "$server" | grep -q "$TARGET_TOOL"; then
        echo "✅ $server has $TARGET_TOOL"
    else
        echo "❌ $server missing $TARGET_TOOL"
    fi
done
```

### Tool Inventory
```bash
#!/bin/bash
# Create complete tool inventory

echo "=== MCP Tool Inventory ==="
vodou-core list | grep "^  -" | cut -d: -f1 | sed 's/^  - //' | while read server; do
    echo ""
    echo "Server: $server"
    echo "--------------------"
    TOOL_COUNT=$(vodou-core tools "$server" | grep -c "^  -")
    echo "Tool count: $TOOL_COUNT"
    
    if [ "$TOOL_COUNT" -gt 0 ]; then
        echo "Tools:"
        vodou-core tools "$server" | grep "^  -" | head -5 | sed 's/^  -/  •/'
        if [ "$TOOL_COUNT" -gt 5 ]; then
            echo "  ... and $(($TOOL_COUNT - 5)) more"
        fi
    fi
done
```

## Performance Considerations

### Database Performance
- **Tool queries are fast** (sub-millisecond for typical datasets)
- **No network calls** - all data from local database
- **Cached results** - data persisted from connection time

### Large Tool Sets
For servers with many tools (50+ tools):
- **Pagination may be helpful** for display (not currently implemented)
- **Filtering by name** using `grep` or similar tools
- **Categorization** by tool name patterns

```bash
# Filter tools by category
vodou-core tools large-server | grep "get_.*_info"
vodou-core tools large-server | grep "analyze_"
vodou-core tools large-server | grep "generate_"
```

## Related Commands

- [`capabilities`](capabilities.md) - High-level server capability overview
- [`call`](call.md) - Execute the discovered tools (traditional server-specific)
- [`call-tool`](call-tool.md) - Universal tool routing (recommended)
- [`all-tools`](all-tools.md) - View tools across all servers
- [`find-tool`](find-tool.md) - Find which servers provide specific tools
- [`connect`](connect.md) - Discover and store tools during connection
- [`list`](list.md) - Find server names to use with tools command

## See Also

- [Examples](../examples.md#tool-discovery) - Tool discovery and usage examples
- [CLI Reference](../cli-reference.md#tools) - Complete command reference
- [Call Command](call.md) - Using discovered tools