# all-tools

List all tools across all connected servers.

## Syntax

```bash
vodou-core all-tools [OPTIONS]
```

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `--by-server` | Group tools by server | false |
| `--detailed` | Show tool descriptions | false |

## Description

The `all-tools` command provides a comprehensive view of all available tools across all connected MCP servers. It can display tools in two modes:

1. **Alphabetical by tool name** (default): Shows all unique tools with their server locations
2. **Grouped by server** (`--by-server`): Shows tools organized by the server that provides them

## Examples

### List all tools alphabetically

```bash
vodou-core all-tools
```

**Output:**
```
🔍 Discovering all tools across servers...
✅ Found 210 unique tools:

🔧 take_snapshot (chrome-devtools)
🔧 get_cpu_info (mcp-monitor)
🔧 get_disk_info (mcp-monitor)
🔧 get_memory_info (mcp-monitor)
🔧 get_process_info (mcp-monitor)
🔧 navigate_page (chrome-devtools)
...
🚀 Use 'vodou-core call-tool <tool-name>' to call any tool with automatic routing
```

### List tools with descriptions

```bash
vodou-core all-tools --detailed
```

**Output:**
```
🔍 Discovering all tools across servers...
✅ Found 210 unique tools:

🔧 take_snapshot - Capture accessibility snapshot of the active browser tab (chrome-devtools)
🔧 get_cpu_info - Get CPU information and usage statistics (mcp-monitor)
🔧 get_disk_info - Get disk usage and partition information (mcp-monitor)
...
```

### Group tools by server

```bash
vodou-core all-tools --by-server
```

**Output:**
```
🔍 Discovering all tools across servers...
✅ Found 210 tools across 27 servers:

📦 chrome-devtools (example tools):
  🔧 navigate_page
  🔧 take_snapshot
  🔧 take_screenshot
  🔧 list_console_messages
  🔧 list_network_requests
  ...

📦 mcp-monitor (6 tools):
  🔧 get_cpu_info
  🔧 get_disk_info
  🔧 get_memory_info
  🔧 get_network_info
  🔧 get_process_info
  🔧 get_host_info
  ...
```

### Group tools by server with descriptions

```bash
vodou-core all-tools --by-server --detailed
```

**Output:**
```
🔍 Discovering all tools across servers...
✅ Found 210 tools across 27 servers:

📦 chrome-devtools (example tools):
  🔧 navigate_page - Open a URL or navigate history in the attached browser
  🔧 take_snapshot - Accessibility / DOM-oriented page snapshot
  🔧 take_screenshot - Screenshot of the visible viewport
  🔧 list_console_messages - Recent console output from the page
  🔧 list_network_requests - Recent network activity
  ...

📦 mcp-monitor (6 tools):
  🔧 get_cpu_info - Get CPU information and usage statistics
  🔧 get_disk_info - Get disk usage and partition information
  🔧 get_memory_info - Get memory usage and statistics
  🔧 get_network_info - Get network interface information and statistics
  🔧 get_process_info - Get process information
  🔧 get_host_info - Get host system information
  ...
```

## Use Cases

1. **Tool Discovery**: Find all available tools across your MCP infrastructure
2. **Server Overview**: Understand what capabilities each server provides
3. **Tool Planning**: Plan which tools to use for specific tasks
4. **Infrastructure Audit**: Review your MCP server capabilities
5. **Documentation**: Generate lists of available tools for documentation

## Related Commands

- [`find-tool`](find-tool.md) - Find which servers provide a specific tool
- [`tool-schema`](tool-schema.md) - Show input schema for a specific tool
- [`call-tool`](call-tool.md) - Call a tool by name with automatic routing
- [`tools`](tools.md) - Show tools for a specific server

## Technical Details

- **Tool Discovery**: Uses the ToolRouter to discover tools across all servers
- **Deduplication**: Shows each unique tool name only once in alphabetical mode
- **Server Grouping**: Groups tools by server in `--by-server` mode
- **Connection Pooling**: Uses connection pooling for efficient server communication
- **Caching**: Leverages cached tool information when available

## Performance

- **Fast Discovery**: Uses connection pooling for efficient server queries
- **Cached Results**: Leverages existing tool metadata from server discovery
- **Parallel Processing**: Can query multiple servers simultaneously
- **Memory Efficient**: Streams results without loading all tools into memory


