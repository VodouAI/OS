# Brain Command

**Execute brain command with frontend foundation**

## Syntax

```bash
vodou-core brain <QUERY> [OPTIONS]
```

## Options

- **`--verbose`** - Show detailed output with full context loading information
- **`--test-params`** - Test parameter generation without executing tools
- **`--clean`**, **`-c`** - Output only raw JSON from tool results (no formatting)

## Description

The `brain` command is the entry point to Brain Trust 4's frontend foundation, providing intelligent context loading and analysis capabilities. It represents the integration of Brain Trust 3's proven frontend concepts with Brain Trust 4's robust MCP backend infrastructure.

## Arguments

- `<QUERY>` - The query or request to analyze (required)

## Features

### 🧠 **Frontend Foundation**
- **Context Loading**: Loads intelligent context based on the query
- **MCP Integration**: Shows real-time status of connected MCP servers
- **Performance Metrics**: Displays connection pool and execution statistics
- **Development Roadmap**: Provides guidance on next development steps

### 🔍 **Parameter Testing Mode** (`--test-params`)
The `--test-params` flag allows you to debug parameter generation without executing tools. This is especially useful when:
- Testing how queries are parsed and mapped to intents
- Debugging parameter generation issues
- Understanding which rules are used for parameter extraction
- Verifying parameter values before execution

### 🧹 **Clean Mode** (`--clean`, `-c`)
The `--clean` flag outputs only raw JSON from tool results without any formatting, reminders, or metadata. This mode:
- Suppresses all formatting (emojis, headers, section dividers)
- Removes work log reminders and AI agent guidance
- Omits execution time and system overhead metrics
- Skips intent mapping information and available intents
- Outputs only the raw JSON response from MCP tools
- Shows debug output only when `DEBUG=1` environment variable is set
- **Includes intelligence system data in error responses** (working examples, failure patterns, success rates)
- **Still records to database** for intelligence system tracking

**Use cases:**
- Scripting and automation pipelines
- JSON parsing and processing
- Integration with external tools requiring clean JSON
- Minimal output requirements
- AI agent integration with structured error intelligence

**What it shows:**
- Query analysis and intent mappings found
- Input schema for each tool
- Parameter generation details (rule used, generated parameters, timing)
- Rule details (required fields, field generators)
- Execution preview (what would be executed)
- Direct call syntax for manual testing

**Example output:**
```
🔍 **PARAMETER TEST MODE**

📋 **Query**: "cpu"

📋 **Intent Mappings Found**:
   ✅ cpu → mcp-monitor::get_cpu_info (priority: 10)

🔧 **Testing**: mcp-monitor::get_cpu_info
   📋 **Input Schema**: {...}
   🔧 **Parameter Generation**:
      Rule Used: ✅ Yes
      Generated: {}
      Time: 1.93ms
   📋 **Rule Details**: {...}
   📊 **Would Execute**: {...}
   💡 **Direct Call Syntax**: vodou-core call mcp-monitor get_cpu_info '{}'
```

### 📋 **Context Sections**
The brain command provides three main context sections:

1. **HELLO WORLD CONTEXT**
   - Query reception and acknowledgment
   - Brain Trust 4 status overview
   - Frontend development status

2. **MCP BACKEND STATUS** 
   - Real server count from database
   - List of available MCP servers and their capabilities
   - Performance metrics (execution time, connection pooling)

3. **GUIDANCE & NEXT STEPS**
   - Development roadmap (Phase 1-5)
   - Immediate actionable items
   - Integration recommendations

## Examples

### Basic Query Analysis
```bash
vodou-core brain "analyze my system performance"
```

### Development Planning
```bash
vodou-core brain "what's the next development phase"
```

### General Context Loading
```bash
vodou-core brain "help me understand the current state"
```

### Test Parameter Generation
```bash
# Test how parameters are generated for a query without executing
vodou-core brain "cpu" --test-params

# Test complex query parameter generation
vodou-core brain "analyze codebase" --test-params
```

### Verbose Mode
```bash
# Show detailed output
vodou-core brain "cpu" --verbose

# Combine verbose with test mode
vodou-core brain "cpu" --test-params --verbose
```

### Clean Mode
```bash
# Output only raw JSON (no formatting)
vodou-core brain "cpu" --clean

# Using ./do wrapper
./do --clean cpu
./do -c cpu
```

**Clean mode output (success):**
```json
Query: cpu
AI Agent Instruction: Analyze the JSON output below using the original query above. Reason about the data and provide a clear, helpful response to the user based on both the query intent and the tool results.
{
  "core_count": 10,
  "info": [
    {
      "cpu": 0,
      "modelName": "Apple M1 Pro",
      "cores": 10,
      "mhz": 3228
    }
  ],
  "usage_percent": [25.9]
}
```

**Clean mode output (error with intelligence):**
```json
Query: cpu memory disk
AI Agent Instruction: Analyze the JSON output below using the original query above. Reason about the data and provide a clear, helpful response to the user based on both the query intent and the tool results.
{
  "error": true,
  "intelligence": {
    "failed_attempts": 4,
    "failure_patterns": [
      {
        "error": "Failed to get disk usage information: no such file or dir...",
        "failure_count": 4,
        "latest_failure": "2025-12-27 23:05:16",
        "query": "cpu memory disk"
      }
    ],
    "is_troublesome": true,
    "success_rate": 0.0,
    "successful_attempts": 0,
    "total_attempts": 4,
    "working_examples": []
  },
  "message": "Failed to get disk usage information: no such file or directory",
  "server": "mcp-monitor",
  "tool": "get_disk_info"
}
```

**Intelligence system features in clean mode:**
- **Success rate tracking**: Shows tool reliability percentage
- **Working examples**: Queries that successfully executed this tool
- **Failure patterns**: Common queries that failed with this error
- **Troublesome tool flag**: Identifies tools with <70% success rate
- **Database recording**: All clean mode executions are recorded for intelligence tracking

## Sample Output

```
🧠 **BRAIN TRUST 4**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Query: analyze my system performance

📋 **CONTEXT LOADED**
🔍 **HELLO WORLD CONTEXT**
🎯 **QUERY RECEIVED**: analyze my system performance

🧠 **BRAIN TRUST 4 STATUS**:
• MCP Backend: ✅ Active (27 servers)
• Tool Execution: ✅ Fast (9ms)
• Connection Pool: ✅ Optimized
• Frontend: 🚧 In Development

🔍 **MCP BACKEND STATUS**
🔌 **MCP SERVERS AVAILABLE** (27 servers):
• mcp-monitor: System monitoring tools
• chrome-devtools: Chrome DevTools MCP (browser automation)
• memory-orchestrator: Conversation management
• devcontext: Development context tracking
• filesystem: File operations
• ... and 22 more servers

⚡ **PERFORMANCE**:
• Tool execution: ~9ms average
• Connection pooling: 25-50x improvement
• Parallel execution: Ready for integration

🔍 **GUIDANCE & NEXT STEPS**
🎯 **FRONTEND DEVELOPMENT ROADMAP**:

**Phase 1**: ✅ Basic brain command (current)
**Phase 2**: ✅ Hello world loader (current)
**Phase 3**: Query analysis and intent detection
**Phase 4**: MCP tool integration and parallel execution
**Phase 5**: Advanced context aggregation

⚡ **Brain Trust 4 Frontend Foundation Active**
```

## Technical Implementation

### Architecture
- **Brain Loader**: `src/brain_loader.rs` - Context loading and aggregation
- **Command Handler**: `src/main.rs` - CLI integration and output formatting
- **Database Integration**: Real-time server count and status from `vodou-core.db`

### Database Dependencies
- **intents table**: For future query analysis and intent detection
- **tools table**: Enhanced with `required_intents` column for intelligent routing

### Performance
- **Fast Execution**: Leverages existing connection pooling (25-50x improvement)
- **Memory Efficient**: Uses `Arc<Database>` for shared access
- **Scalable**: Ready for expansion to advanced features

## Development Status

**Current Phase**: ✅ **Foundation Complete**
- Phase 1: Basic brain command ✅
- Phase 2: Hello world loader ✅
- Phase 3: Test and validate ✅

**Next Phase**: Query analysis and intent detection

## Integration Notes

### Brain Trust 3 Concepts Integrated
- **Brain Loader Pattern**: Adapted from BT3's context loading system
- **Context Sections**: Three-section format with priorities and token estimation
- **Modular Architecture**: Ready for expansion with advanced features

### Brain Trust 4 Infrastructure Leveraged
- **Connection Pooling**: 25-50x performance improvement
- **Database Schema**: Enhanced with intents system
- **MCP Backend**: 27+ connected servers ready for integration
- **Parallel Execution**: Ready for future MCP tool orchestration

## Future Expansion

The brain command is designed as a foundation for:
1. **Query Analysis**: Intent detection and natural language processing
2. **MCP Tool Integration**: Automatic tool selection based on query analysis
3. **Parallel Execution**: Concurrent tool execution with result aggregation
4. **Advanced Context**: Work history, pattern intelligence, and enhanced summaries

## See Also

- [parallel](parallel.md) - Execute multiple tools in parallel
- [parallel-custom](parallel-custom.md) - Custom parallel tool execution
- [call-tool](call-tool.md) - Direct tool execution
- [find-tool](find-tool.md) - Find tools across servers