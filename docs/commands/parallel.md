# parallel Command

Execute multiple tools in parallel based on intent patterns for dramatic performance improvements.

## Overview

The `parallel` command uses intent-based patterns to automatically select and execute multiple tools simultaneously across different MCP servers. This provides significant performance improvements (up to 275% efficiency) while intelligently aggregating results.

## Usage

```bash
vodou-core parallel <INTENT> [--context <JSON>]
```

## Arguments

- **`INTENT`** - Intent pattern that determines which tools to execute in parallel
- **`--context <JSON>`** - Optional context parameters in JSON format to customize tool arguments

## Available Intent Patterns

### system_performance
Execute system monitoring tools in parallel:
- CPU information and usage
- Memory usage and statistics  
- Disk usage information
- Network interface data (if available)
- Process information (if available)

### codebase_analysis
Execute code analysis tools in parallel:
- Codebase analysis and metrics
- Project structure discovery
- Semantic insights (if available)
- Search results (if available)

### filesystem_scan
Execute filesystem tools in parallel:
- Directory listing
- File information
- File search (if available)

## Examples

### Basic Intent Execution
```bash
# System performance monitoring
vodou-core parallel system_performance

# Codebase analysis
vodou-core parallel codebase_analysis

# Filesystem scanning
vodou-core parallel filesystem_scan
```

### Intent with Context Parameters
```bash
# Codebase analysis with custom path
vodou-core parallel codebase_analysis --context '{"path": "./src"}'

# Filesystem scan with specific directory
vodou-core parallel filesystem_scan --context '{"path": "/Users/project"}'

# System performance with CPU-specific options
vodou-core parallel system_performance --context '{"cpu_args": {"per_cpu": true}}'
```

## Sample Output

```
🎯 Parallel Execution Summary:
═══════════════════════════════════════════════════════════════════
📝 System Performance: 3 tools in 8.412208ms

⚡ Performance Metrics:
   Total execution time: 8.412208ms
   Tools executed: 3
   Success rate: 100.0%
   Parallel efficiency: 275.0%
   Average tool time: 7ms

🎯 Primary Results:
───────────────────────────────────────────────────────────────────

   📊 cpu_info:
      {
        "core_count": 10,
        "usage_percent": [24.8],
        "model": "Apple M1 Pro"
      }

   📊 memory_info:
      {
        "virtual": {
          "used_percent": 84.8,
          "total": 17179869184
        }
      }

   📊 disk_info:
      {
        "usage_percent": 45.2,
        "free": 500000000000
      }
═══════════════════════════════════════════════════════════════════
```

## Performance Benefits

- **Parallel Execution**: Tools run simultaneously instead of sequentially
- **Efficiency Gains**: Typically 200-300% faster than sequential execution
- **Smart Aggregation**: Results are intelligently categorized and summarized
- **Resource Optimization**: Efficient use of system resources through connection pooling

## Error Handling

- **Graceful Degradation**: If some tools fail, successful results are still returned
- **Error Isolation**: Failed tools don't affect successful ones
- **Detailed Reporting**: Clear indication of which tools succeeded or failed
- **Fallback**: Falls back to raw results if aggregation fails

## Intent Extensibility

The intent system is designed to be easily extensible. Future intents can be added by:
1. Adding new patterns to the `analyze_intent_for_tools` function
2. Updating the context aggregator to handle new result types
3. Adding intent-specific summary generation

## Related Commands

- [`parallel-custom`](parallel-custom.md) - Manual tool specification for parallel execution
- [`call-tool`](call-tool.md) - Single tool execution with automatic routing
- [`find-tool`](find-tool.md) - Find servers that provide specific tools
- [`all-tools`](all-tools.md) - List all available tools across servers

## Technical Details

- Uses `futures::join_all` for true concurrent execution
- Leverages existing connection pooling for efficiency
- Implements smart protocol version fallback
- Provides comprehensive performance metrics and timing
- Maintains full backward compatibility with existing functionality