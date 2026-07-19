# call-tool

Call tools by name with automatic server routing - no need to specify which server provides the tool.

## Syntax

```bash
vodou-core call-tool <tool> [OPTIONS]
```

## Description

The `call-tool` command implements universal tool routing - call any tool by name and the system automatically finds the correct server, routes the request, and executes the tool. This eliminates the need to know which server provides which tool.

## Arguments

- `<tool>` - Name of the tool to call

## Options

- `--args <JSON>` - Tool arguments as JSON string (optional)
- `--verbose` - Show detailed routing information

## Features

### Automatic Server Discovery
- **Tool Search** - Finds all servers providing the specified tool
- **Intelligent Routing** - Selects best server based on health and performance
- **Connection Pooling** - Reuses existing connections for 25-50x performance improvement
- **Error Recovery** - Graceful fallback with helpful suggestions

### Smart Server Selection
The routing algorithm considers:
- **Health Status** (100 points) - Prioritize healthy servers
- **Recent Usage** (50 points) - Prefer recently used servers for cache locality  
- **Tool Match** (10 points) - Boost for exact tool name matches
- **Load Balancing** - Distribute across multiple providers

## Examples

### Basic Tool Calls
```bash
# Call a tool without arguments
vodou-core call-tool get_cpu_info

# Call a tool with arguments
vodou-core call-tool write_file --args '{"path":"test.txt","content":"Hello World"}'

# Call with verbose routing information
vodou-core call-tool get_memory_info --verbose
```

### Complex Tool Calls
```bash
# Database query
vodou-core call-tool execute_query --args '{"sql":"SELECT * FROM users LIMIT 5"}'

# File operations
vodou-core call-tool read_file --args '{"path":"/etc/hosts"}'

# Web requests
vodou-core call-tool http_get --args '{"url":"https://api.example.com/data"}'
```

### Tool Discovery Workflow
```bash
# 1. See all available tools
vodou-core all-tools

# 2. Find which servers provide a specific tool
vodou-core find-tool database_query

# 3. Call the tool (auto-routes to best server)
vodou-core call-tool database_query --args '{"query":"SELECT 1"}'
```

## Example Output

### Successful Tool Call
```bash
$ vodou-core call-tool get_cpu_info --verbose
🚀 Calling tool: get_cpu_info (with auto-routing)
⚡ Auto-routing tool call: get_cpu_info
🔍 Finding server for tool: get_cpu_info
📡 Routing to server: mcp-monitor (healthy server)
📋 Alternative servers: system-info, hardware-monitor
⚡ Using pooled connection (200ms vs 5-10s without pooling)

✅ Tool call result:
{
  "cpu_usage": 23.5,
  "cores": 8,
  "architecture": "x86_64",
  "model": "Intel Core i7-9750H",
  "frequency": 2.6
}
```

### Tool with Arguments
```bash
$ vodou-core call-tool write_file --args '{"path":"hello.txt","content":"Hello, World!"}'
🚀 Calling tool: write_file (with auto-routing)
📡 Routing to server: filesystem (healthy server)

✅ Tool call result:
{
  "success": true,
  "path": "hello.txt",
  "bytes_written": 13,
  "message": "File written successfully"
}
```

### Multiple Server Options
```bash
$ vodou-core call-tool read_file --args '{"path":"config.json"}' --verbose
🚀 Calling tool: read_file (with auto-routing)
🔍 Finding server for tool: read_file
📡 Routing to server: filesystem (healthy, recently used server)
📋 Alternative servers: file-manager, advanced-files
🎯 Selection reasoning: healthy, recently used server

✅ Tool call result:
{
  "content": "{ \"name\": \"example\", \"version\": \"1.0\" }",
  "size": 34,
  "encoding": "utf-8"
}
```

## Error Handling

### Tool Not Found
```bash
$ vodou-core call-tool nonexistent_tool
❌ Tool call failed: Tool 'nonexistent_tool' not found on any connected server

💡 Try 'vodou-core all-tools' to see all available tools
💡 Check tool name spelling
💡 Use 'vodou-core search' to find and install more servers
```

### Server Unavailable
```bash
$ vodou-core call-tool database_query --args '{"sql":"SELECT 1"}'
🚀 Calling tool: database_query (with auto-routing)
📡 Routing to server: postgres-server (healthy server)
❌ Tool call failed: Connection failed to postgres-server

🔄 Attempting automatic recovery...
📡 Retrying with alternative server: mysql-server
✅ Tool call successful on alternative server
```

### Invalid Arguments
```bash
$ vodou-core call-tool write_file --args '{"invalid":"structure"}'
🚀 Calling tool: write_file (with auto-routing)  
📡 Routing to server: filesystem (healthy server)
❌ Tool call failed: Missing required argument 'path'

💡 Check tool documentation for required arguments
💡 Use 'vodou-core tools filesystem' to see tool details
```

## Performance Benefits

### Connection Pooling
- **First Call**: ~2-3 seconds (connection setup + tool call)
- **Subsequent Calls**: ~100-500ms (reuse existing connection)
- **Performance Improvement**: 25-50x faster than traditional method

### Intelligent Caching
- **Tool Discovery Cache**: 5-minute TTL with automatic refresh
- **Server Health Cache**: Real-time updates with performance tracking
- **Connection Cache**: Persistent connections with automatic cleanup

### Routing Optimization
- **Smart Selection**: Health + usage + recency scoring
- **Load Balancing**: Automatic distribution across multiple servers
- **Failure Recovery**: Automatic failover to alternative servers

## Routing Statistics

View routing performance and statistics:
```bash
# Show routing statistics
vodou-core routing-stats

# Output example:
📊 Tool Routing Statistics
🔧 Total unique tools: 39
📦 Active servers: 4  
🔄 Tools with multiple providers: 8
📈 Redundancy ratio: 20.5% (higher = more failover options)
⚡ Average routing time: 15ms
🎯 Cache hit rate: 87%
```

## Integration with Traditional Commands

Universal tool routing complements traditional commands:

```bash
# Traditional approach (specify server)
vodou-core call mcp-monitor get_cpu_info

# Universal approach (auto-route)  
vodou-core call-tool get_cpu_info

# Both work, but call-tool provides:
# - No need to remember which server has which tool
# - Automatic server selection and load balancing
# - Built-in failover and error recovery
```

## Related Commands

- [`find-tool`](find-tool.md) - Find which servers provide specific tools
- [`all-tools`](all-tools.md) - List all tools across all servers
- [`routing-stats`](routing-stats.md) - View routing statistics and performance
- [`tools`](tools.md) - Traditional server-specific tool listing

## Troubleshooting

### Tool Discovery Issues
```bash
# Refresh tool cache if tools seem missing
vodou-core all-tools

# Check specific tool availability
vodou-core find-tool your_tool_name

# View routing statistics for cache status
vodou-core routing-stats
```

### Performance Issues
```bash
# Check connection pool status
vodou-core health-check-detailed --detailed

# Monitor server health
vodou-core health-dashboard

# Check for server connectivity issues
vodou-core health-stats
```

### Routing Failures
```bash
# Check server health
vodou-core health-check --metrics

# Verify server connectivity
vodou-core reconnect-all

# Check tool availability
vodou-core tools server-name
```

## See Also

- [Universal Tool Routing Guide](../../docs-DEV/universal-tool-routing.md) (internal)
- [Find Tool Command](find-tool.md)
- [All Tools Command](all-tools.md)
- [Performance Guide](../../docs-DEV/performance.md) (internal)