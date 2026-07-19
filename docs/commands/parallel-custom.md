# parallel-custom Command

Execute specific tools in parallel across multiple servers with manual specification for maximum control.

## Overview

The `parallel-custom` command provides full control over which tools to execute in parallel by allowing manual specification of server:tool pairs. This is ideal for custom workflows, specific tool combinations, or when you need precise control over parallel execution.

## Usage

```bash
vodou-core parallel-custom <TOOLS> [--args <JSON>]
```

## Arguments

- **`TOOLS`** - Comma-separated list of server:tool pairs in format "server1:tool1,server2:tool2"
- **`--args <JSON>`** - Optional arguments in JSON format that will be passed to all tools

## Tool Specification Format

Each tool is specified as `server_name:tool_name`:
- **`server_name`** - The name of the MCP server (as shown in `vodou-core list`)
- **`tool_name`** - The name of the tool on that server (as shown in `vodou-core tools server_name`)

## Examples

### Basic Parallel Execution
```bash
# Execute tools on different servers
vodou-core parallel-custom "mcp-monitor:get_cpu_info,mcp-monitor:get_memory_info"

# Mix servers and tools
vodou-core parallel-custom "mcp-monitor:get_cpu_info,filesystem:list_directory,chrome-devtools:take_snapshot"
```

### With Arguments
```bash
# Pass arguments to all tools
vodou-core parallel-custom "filesystem:list_directory,filesystem-docs:list_directory" --args '{"path": "."}'

# System monitoring with specific parameters
vodou-core parallel-custom "mcp-monitor:get_cpu_info,mcp-monitor:get_process_info" --args '{"limit": 10}'
```

### Complex Workflows
```bash
# Comprehensive system analysis
vodou-core parallel-custom "mcp-monitor:get_cpu_info,mcp-monitor:get_memory_info,mcp-monitor:get_disk_info,filesystem:list_directory,chrome-devtools:take_snapshot"

# Multi-server filesystem operations
vodou-core parallel-custom "filesystem:list_directory,filesystem-docs:search_files,filesystem-test:get_file_info" --args '{"path": "/tmp"}'
```

## Sample Output

```
📊 Parallel Execution Results:
═══════════════════════════════════════════════════════════════════
⏱️  Total execution time: 45ms (parallel)
⏱️  Would have taken: 120ms (sequential)
🚀 Speed improvement: 167% faster

📋 Individual Results:
───────────────────────────────────────────────────────────────────

✅ mcp-monitor:get_cpu_info
   Time: 32ms
   Result: {
     "core_count": 10,
     "usage_percent": [24.8],
     "info": [
       {
         "modelName": "Apple M1 Pro",
         "mhz": 3228,
         "cores": 10
       }
     ]
   }

✅ filesystem:list_directory
   Time: 45ms
   Result: {
     "content": [
       {
         "text": "[DIR] src\n[FILE] README.md\n[FILE] Cargo.toml",
         "type": "text"
       }
     ]
   }

❌ broken-server:invalid_tool
   Error: Server connection failed: Server 'broken-server' not found
   Time: 5ms

📊 Summary:
───────────────────────────────────────────────────────────────────
   Total tools: 3
   Successful: 2 ✅
   Failed: 1 ❌
   Success rate: 67%
═══════════════════════════════════════════════════════════════════
```

## Performance Benefits

- **True Parallel Execution**: All tools run simultaneously using futures
- **Connection Pool Efficiency**: Reuses existing connections for optimal performance
- **Resource Optimization**: Minimal overhead through smart connection management
- **Scalable Design**: Supports unlimited parallel tools (within system limits)

## Error Handling

- **Error Isolation**: Failed tools don't affect successful ones
- **Detailed Error Reporting**: Clear indication of what went wrong for each tool
- **Graceful Degradation**: Returns successful results even if some tools fail
- **Connection Resilience**: Automatically handles connection issues

## Use Cases

### Development & Testing
```bash
# Test multiple environments simultaneously
vodou-core parallel-custom "dev-server:health_check,staging-server:health_check,prod-server:health_check"

# Compare tool outputs across servers
vodou-core parallel-custom "server-v1:analyze_data,server-v2:analyze_data" --args '{"dataset": "test"}'
```

### System Monitoring
```bash
# Comprehensive system overview
vodou-core parallel-custom "monitor:get_cpu_info,monitor:get_memory_info,monitor:get_disk_info,monitor:get_network_info"

# Multi-host monitoring
vodou-core parallel-custom "host1-monitor:get_cpu_info,host2-monitor:get_cpu_info,host3-monitor:get_cpu_info"
```

### Data Collection
```bash
# Gather data from multiple sources
vodou-core parallel-custom "db-server:query_metrics,api-server:get_stats,file-server:scan_logs"

# Research and analysis
vodou-core parallel-custom "stackoverflow-mcp:search_by_tags,github-test:search_repos,chrome-devtools:list_console_messages" --args '{"query": "rust async"}'
```

## Best Practices

1. **Group Related Tools**: Execute related tools together for coherent results
2. **Consider Dependencies**: Don't run tools that depend on each other in parallel
3. **Monitor Performance**: Use the performance metrics to optimize tool selection
4. **Handle Failures**: Design workflows that can handle partial failures gracefully
5. **Use Appropriate Arguments**: Pass arguments that make sense for all specified tools

## Comparison with Related Commands

| Command | Use Case | Control | Performance |
|---------|----------|---------|-------------|
| `parallel-custom` | Manual tool selection | Full control | Optimal for specific workflows |
| [`parallel`](parallel.md) | Intent-based execution | Automatic | Best for common patterns |
| [`call-tool`](call-tool.md) | Single tool with routing | Semi-automatic | Best for single operations |
| [`call`](call.md) | Traditional single tool | Manual server selection | Baseline performance |

## Technical Implementation

- **Concurrent Execution**: Uses `futures::join_all` for true parallelism
- **Connection Pooling**: Leverages existing connection infrastructure
- **Error Resilience**: Comprehensive error handling and reporting
- **Memory Efficient**: Minimal overhead with smart resource management
- **Protocol Compatible**: Works with all MCP protocol versions through fallback system

## Troubleshooting

### Common Issues

**"Server not found" errors:**
- Verify server names with `vodou-core list`
- Check server connectivity with `vodou-core status server_name`

**"Tool not found" errors:**
- Verify tool names with `vodou-core tools server_name`
- Check server capabilities with `vodou-core capabilities server_name`

**Poor performance:**
- Check server health with `vodou-core health-check`
- Monitor connection pool status
- Consider reducing number of concurrent tools

## Related Commands

- [`parallel`](parallel.md) - Intent-based parallel execution
- [`call-tool`](call-tool.md) - Single tool execution with automatic routing
- [`find-tool`](find-tool.md) - Find servers that provide specific tools
- [`all-tools`](all-tools.md) - List all available tools across servers
- [`routing-stats`](routing-stats.md) - Tool routing statistics and metrics