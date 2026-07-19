 done? # find-tool

Find which servers provide a specific tool across all connected servers.

## Syntax

```bash
vodou-core find-tool <tool>
```

## Description

The `find-tool` command searches across all connected servers to find which ones provide a specific tool. This is useful for understanding tool availability, server redundancy, and routing options before calling tools.

## Arguments

- `<tool>` - Name of the tool to search for

## Features

- **Cross-Server Search** - Searches all connected servers simultaneously
- **Tool Redundancy** - Shows all servers that provide the same tool
- **Health Status** - Displays current health status of each server
- **Routing Information** - Shows which server would be selected for routing
- **Performance Data** - Includes server response times and usage statistics

## Examples

### Basic Tool Search
```bash
# Find servers providing a specific tool
vodou-core find-tool get_cpu_info

# Search for file operations tools
vodou-core find-tool read_file

# Look for database tools
vodou-core find-tool execute_query
```

## Example Output

### Single Provider
```bash
$ vodou-core find-tool get_cpu_info
🔍 Searching for tool: get_cpu_info

✅ Found tool 'get_cpu_info' on 1 server:

📦 mcp-monitor
   🏥 Status: ✅ Healthy (8ms response time)
   📊 Usage: Used 15 times, last used 2 minutes ago
   🎯 Routing: ⭐ Would be selected (only provider)
   📝 Description: System monitoring and performance metrics
   🔧 Tool Type: system-info
```

### Multiple Providers  
```bash
$ vodou-core find-tool read_file
🔍 Searching for tool: read_file

✅ Found tool 'read_file' on 3 servers:

📦 filesystem ⭐ Primary Choice
   🏥 Status: ✅ Healthy (45ms response time)  
   📊 Usage: Used 23 times, last used 30 seconds ago
   🎯 Routing: ⭐ Would be selected (healthy, recently used)
   📝 Description: File system operations and management
   🔧 Tool Type: file-operations

📦 file-manager
   🏥 Status: ✅ Healthy (78ms response time)
   📊 Usage: Used 8 times, last used 5 minutes ago  
   🎯 Routing: Alternative option
   📝 Description: Advanced file management with metadata
   🔧 Tool Type: file-operations

📦 backup-tools
   🏥 Status: ⚠️ Degraded (156ms response time)
   📊 Usage: Used 3 times, last used 2 hours ago
   🎯 Routing: Fallback option
   📝 Description: Backup and restore file operations
   🔧 Tool Type: backup

💡 Primary choice: filesystem (best health + recent usage)
💡 Use 'vodou-core call-tool read_file' for automatic routing
```

### Tool Not Found
```bash
$ vodou-core find-tool nonexistent_tool
🔍 Searching for tool: nonexistent_tool

❌ Tool 'nonexistent_tool' not found on any connected server

📊 Searched across 4 servers:
   ✅ mcp-monitor (6 tools available)
   ✅ filesystem (12 tools available)  
   ✅ browser-tools (14 tools available)
   ✅ database-server (8 tools available)

💡 Use 'vodou-core all-tools' to see all available tools
💡 Use 'vodou-core search' to find and install more servers
💡 Check tool name spelling and try again
```

## Tool Information Details

### Health Status Indicators
- **✅ Healthy** - Server responding normally (< 100ms)
- **⚠️ Degraded** - Server responding slowly (100ms - 1s)  
- **❌ Unhealthy** - Server not responding or errors
- **🔄 Recovering** - Server recovering from failure
- **❓ Unknown** - Health status not yet determined

### Routing Selection Criteria
The system shows which server would be selected for automatic routing based on:

1. **Health Score** (100 points) - Healthy servers preferred
2. **Recent Usage** (50 points) - Recently used servers for cache locality
3. **Tool Match** (10 points) - Exact tool name matches
4. **Response Time** - Faster servers preferred for ties

### Usage Statistics
- **Usage Count** - Total number of times tool was called on this server
- **Last Used** - Time since tool was last called on this server
- **Response Time** - Average response time for this server

## Integration with Other Commands

### Tool Discovery Workflow
```bash
# 1. See all tools across servers
vodou-core all-tools

# 2. Find specific tool providers
vodou-core find-tool database_query

# 3. Call tool (uses same routing logic)
vodou-core call-tool database_query --args '{"sql":"SELECT 1"}'
```

### Server Management Workflow
```bash
# 1. Find which servers provide a tool
vodou-core find-tool file_search

# 2. Check health of specific servers
vodou-core health-check-detailed --server filesystem

# 3. View server details
vodou-core tools filesystem
```

## Performance Information

### Search Performance
- **Cross-Server Search**: ~50-200ms across all servers
- **Cache Utilization**: Uses 5-minute tool discovery cache
- **Connection Reuse**: Leverages connection pooling for speed

### Routing Prediction
The routing prediction shown matches the actual selection algorithm used by [`call-tool`](call-tool.md), providing accurate information about which server would handle the tool call.

## Error Handling

### Server Connectivity Issues
```bash
$ vodou-core find-tool get_status
🔍 Searching for tool: get_status
⚠️ Failed to search server 'offline-server': Connection timeout

✅ Found tool 'get_status' on 2 servers:
[...available servers...]

⚠️ 1 server unavailable (offline-server)
💡 Use 'vodou-core health-check' to diagnose connectivity issues
```

### Cache Refresh
```bash
$ vodou-core find-tool new_tool
🔍 Searching for tool: new_tool
🔄 Tool cache expired, refreshing...
[...search results...]
```

## Related Commands

- [`call-tool`](call-tool.md) - Call tools with automatic routing
- [`all-tools`](all-tools.md) - List all tools across all servers  
- [`routing-stats`](routing-stats.md) - View routing statistics
- [`tools`](tools.md) - View tools for specific server

## Troubleshooting

### Tool Not Found
1. **Check Tool Name** - Verify spelling and case sensitivity
2. **Refresh Cache** - Run `vodou-core all-tools` to refresh tool cache
3. **Check Server Health** - Use `vodou-core health-check` to verify server connectivity
4. **Install More Servers** - Use `vodou-core search` to find additional servers

### Server Health Issues
1. **Check Connectivity** - Use `vodou-core health-check-detailed`
2. **Reconnect Servers** - Try `vodou-core reconnect-all`
3. **View Health Dashboard** - Use `vodou-core health-dashboard`

### Performance Issues
1. **Cache Status** - Check `vodou-core routing-stats` for cache hit rates
2. **Connection Health** - Monitor server response times
3. **Server Load** - Check if servers are overloaded

## See Also

- [Universal Tool Routing Guide](../../docs-DEV/universal-tool-routing.md) (internal)
- [Call Tool Command](call-tool.md)
- [All Tools Command](all-tools.md)
- [Health Monitoring Guide](../../docs-DEV/health-monitoring.md) (internal)