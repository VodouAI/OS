# Brain Trust 4 Examples

Real-world usage patterns and workflows for Brain Trust 4 Enhanced MCP Orchestration - practical examples demonstrating the production-ready platform with 25-50x performance improvements.

## 🚀 Enhanced MCP Orchestration Examples

### Example 1: Docker Server Synchronization and Usage

Sync Docker Desktop MCP servers and use them through the **`./do`** launcher (see **[cli-entrypoints.md](cli-entrypoints.md)** for optional copy filenames).

```bash
# Sync Docker Desktop MCP servers with BT4
./do sync-docker

# Output:
# 🐳 Syncing Docker Desktop MCP servers with BT4...
#    ✅ docker-context7 (already exists)
#    ✅ Added: docker-memory
#    🔧 Auto-discovered 9 tools
#    🎯 Auto-generated 9 parameter rules
# 🎯 Sync complete: 10 servers processed, 1 new servers added

# Use Docker servers with natural language
./do "search for rust programming"
# ✅ Routes to docker-duckduckgo::search

./do "fetch https://github.com"
# ✅ Routes to docker-fetch::fetch

./do "transcript https://youtube.com/watch?v=dQw4w9WgXcQ"
# ✅ Routes to docker-youtube_transcript::get_transcript
```

**Expected Output for Search:**
```
📊 **DOCKER-DUCKDUCKGO**
Found 10 search results:

1. Rust Programming Language
   URL: https://rust-lang.org/
   Summary: Performance Rust is blazingly fast and memory-efficient...

2. Profiling Rust: Find Hidden Bottlenecks in Your Code!
   URL: https://www.youtube.com/watch?v=re8ORa72_y8
   Summary: In this video, we dive into instrumentation and profiling in Rust...
```

### Example 2: Parallel Execution with Multiple Tools

Execute multiple tools simultaneously for maximum efficiency.

```bash
# 3-way parallel execution
./do "cpu memory disk"

# 5-way parallel execution
./do "search for rust programming fetch https://rust-lang.org cpu memory"
```

**Expected Output:**
```
🚀 **Vodou COMMAND TRIGGERED**
Query: search for rust programming fetch https://rust-lang.org cpu memory

🚀 Parameter engine created with 5 rules
   • docker-duckduckgo::search
   • mcp-monitor::get_cpu_info
   • mcp-monitor::get_memory_info
   • docker-fetch::fetch
   • stackoverflow-mcp::search_by_tags

📊 **DOCKER-DUCKDUCKGO**
Found 10 search results: [Rust programming results...]

🖥️ **CPU INFORMATION**
{
  "core_count": 10,
  "modelName": "Apple M1 Pro",
  "usage_percent": [28.5]
}

📊 **SYSTEM INFO**
{
  "virtual": {
    "total": 17179869184,
    "used_percent": 80.09
  }
}

📊 **DOCKER-FETCH**
Contents of https://rust-lang.org/: [Full website content...]

⏱️ **System Overhead**: 7372.82ms
```

### Example 3: Chaining MCP Servers

Extract data from one MCP server and use it as input to another server.

```bash
# Get CPU usage from mcp-monitor and log it to Vodou memory
CPU_USAGE=$(./do -c performance 2>/dev/null | tail -n +3 | jq '.usage_percent[0]')
./do "add log entry CPU usage is ${CPU_USAGE}%"

# Complete system health monitoring script
#!/bin/bash
CPU=$(./do -c cpu 2>/dev/null | tail -n +3 | jq '.usage_percent[0]')
MEM=$(./do -c memory 2>/dev/null | tail -n +3 | jq '.virtual.used_percent')
DISK=$(./do -c disk 2>/dev/null | tail -n +3 | jq '.usage.usedPercent')
TIMESTAMP=$(date +%Y-%m-%d)
./do "add log entry ${TIMESTAMP}-System-Health-CPU:${CPU}% Memory:${MEM}% Disk:${DISK}%"
```

**Expected Output:**
```
✅ Log entry created in session 'default'
Memory ID: f950cb2b-17d1-42b1-80b8-001e0bde64e6
Content: "2025-12-28-System-Health-CPU:25.87% Memory:78.19% Disk:79.08%"
```

**Benefits:**
- ✅ **Automated**: No manual copying of values
- ✅ **Accurate**: No typos or mistakes
- ✅ **Scalable**: Works in scripts and cron jobs
- ✅ **Flexible**: Chain any servers together

See [Chaining MCP Servers](../cli-reference.md#chaining-mcp-servers) in CLI Reference for complete documentation.

### Example 4: Auto-Discovery and Parameter Generation

New Docker servers automatically get tools discovered and parameter rules generated.

```bash
# When a new Docker server is added via sync-docker:
./do sync-docker

# Output shows auto-discovery in action:
#    ✅ Added: docker-memory
#    🔧 Auto-discovered 9 tools
#    🎯 Auto-generated 9 parameter rules

# The tools are immediately available:
./do "graph search for machine learning"
# ✅ Routes to docker-memory::search_nodes with auto-generated parameters
```

### Example 4: Intelligent CLI with Auto-Parameter Generation
Use the enhanced CLI with intelligent parameter generation for seamless tool calling.

```bash
# Automatic parameter generation - no manual JSON needed!
vodou-core call memory-orchestrator store_conversation_messages
# ✅ Automatically generates: agent_id, messages, session_id

# Query-aware parameter generation
vodou-core call memory-orchestrator store_conversation_messages --query="test message from CLI"
# ✅ Generates: messages with "test message from CLI" content

# Context-aware parameter generation
vodou-core call github-test create_issue
# ✅ Generates: owner, repo, title from command context

# Explicit query for better parameters
vodou-core call github-test create_issue --query="fix authentication bug"
# ✅ Generates: title="fix authentication bug" automatically
```

**Expected Output:**
```
⚡ Calling tool store_conversation_messages on memory-orchestrator (using connection pool)...
🔧 Generated parameters: {
  "agent_id": "cline",
  "messages": "[{\"sender\": \"cline\", \"message_content\": \"test message from CLI\", \"message_type\": \"text\"}]",
  "session_id": "d7601182-0738-43b5-b8d8-04a7c5ac39a1"
}
🔧 Parameter Engine: Generating for memory-orchestrator::store_conversation_messages
   Available rules: 270
   Query: "test message from CLI"
   Intent: general_query
   ✅ Rule found for memory-orchestrator::store_conversation_messages
   📤 FromQuery extraction: message_content -> "[{"sender": "cline", "message_content": "test message from CLI", "message_type": "text"}]"
   Generated parameters: {
     "agent_id": "cline",
     "messages": "[{\"sender\": \"cline\", \"message_content\": \"test message from CLI\", \"message_type\": \"text\"}]",
     "session_id": "d7601182-0738-43b5-b8d8-04a7c5ac39a1"
   }
📦 Result: Successfully stored conversation message
```

### Example 2: Server Discovery and Auto-Installation
Discover and install MCP servers automatically using intelligent discovery.

```bash
# Search for file operation servers
vodou-core search "file operations"

# Install discovered filesystem server
vodou-core install filesystem

# Search for database servers with keywords
vodou-core search "database" --keywords "postgres,sql"

# Install with custom name
vodou-core install postgres --as-name database

# View all registered servers
vodou-core registry --detailed
```

**Expected Output:**
```
🔍 Searching for servers: file operations
✅ Found 1 servers (showing top 1):

1. 📦 filesystem
   📝 File system operations and file management
   🏷️  Tags: filesystem, files, storage
   ⭐ Rating: 4.8/5.0
   📊 Downloads: 50000
   🔧 Install: NPM: @modelcontextprotocol/server-filesystem

📦 Installing MCP server: filesystem
✅ Installation validated for: filesystem
🎉 Successfully installed and configured: filesystem
```

### Example 2: GitHub Direct Installation
Install MCP servers directly from GitHub repositories with automatic detection and setup.

```bash
# Install from GitHub repository (auto-detects package manager)
vodou-core install https://github.com/rashee1997/orchestrator

# Install with custom name
vodou-core install https://github.com/Rathesh2727/devcontext.git --as-name devcontext

# Install from any GitHub MCP server
vodou-core install https://github.com/user/custom-mcp-server --as-name my-server
```

**Expected Output:**
```
🔍 Installing from GitHub repository: https://github.com/rashee1997/orchestrator
📦 Installing MCP server: orchestrator
📥 Cloning git repository...
📦 Installing npm dependencies...
✅ Validating installation...
✅ Installation validated for: orchestrator
🔍 Discovering capabilities...
📊 Discovered capabilities:
  🔧 Tools: 43
  📝 Prompts: 0
  📄 Resources: 0
✅ Successfully installed and connected: orchestrator
💡 Use 'vodou-core tools orchestrator' to see available tools
```

**Features:**
- **Automatic Detection**: Detects Node.js, Python, Rust, or binary projects
- **Dependency Installation**: Runs appropriate package manager automatically
- **Auto-Connection**: Connects and discovers capabilities immediately
- **Custom Naming**: Use `--as-name` for custom server names

### Example 3: Universal Tool Routing (25-50x Performance)
Call tools by name with automatic server routing and connection pooling.

```bash
# Discover all available tools across servers
vodou-core all-tools

# Call tools by name (auto-routes to correct server)
vodou-core call-tool get_cpu_info
vodou-core call-tool write_file --args '{"path":"test.txt","content":"Hello World"}'
vodou-core call-tool read_file --args '{"path":"test.txt"}'

# Find which servers provide specific tools
vodou-core find-tool database_query

# Show input schema for any tool
vodou-core tool-schema take_snapshot
vodou-core tool-schema get_process_info

# View routing statistics and performance
vodou-core routing-stats
```

**Performance Benefits:**
```
⚡ Tool call performance with connection pooling:
- First call: ~2-3 seconds (connection setup)
- Subsequent calls: ~200ms (25-50x faster!)
- Traditional method: 5-10 seconds per call

📊 Tool Routing Statistics:
🔧 Total unique tools: 39
📦 Active servers: 4
⚡ Average routing time: 15ms
🎯 Cache hit rate: 87%
```

### Example 3.1: Tool Schema Discovery
Discover tool parameters and requirements for proper tool usage.

```bash
# Show schema for a simple tool
vodou-core tool-schema take_snapshot

# Show schema for a complex tool with multiple parameters
vodou-core tool-schema get_process_info

# Show schema for a tool with array parameters
vodou-core tool-schema search_files
```

**Expected Output for take_snapshot:**
```
🔍 Looking up schema for tool: take_snapshot
✅ Found tool 'take_snapshot' on server: chrome-devtools

📝 Description: Capture an accessibility-oriented snapshot of the active browser tab (Chrome DevTools MCP).

📋 Input Schema:
```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": true
}
```
```

**Expected Output for get_process_info:**
```
🔍 Looking up schema for tool: get_process_info
✅ Found tool 'get_process_info' on server: mcp-monitor

📝 Description: Get process information

📋 Input Schema:
```json
{
  "properties": {
    "limit": {
      "default": 10,
      "description": "Limit the number of processes returned",
      "type": "number"
    },
    "pid": {
      "description": "Process ID. If not specified, returns summary information for all processes",
      "type": "number"
    },
    "sort_by": {
      "default": "cpu",
      "description": "Sort field (cpu, memory, pid, name)",
      "type": "string"
    }
  },
  "type": "object"
}
```
```

### Example 3.2: Fast Database Tool Discovery
Use the database-based tool discovery for instant access to all tools without MCP connections.

```bash
# List all tools from database (instant, no connections)
vodou-core list-tools-db

# Filter by specific server
vodou-core list-tools-db --server context7

# Search for tools by name pattern
vodou-core list-tools-db --filter "search"

# Show tool schemas
vodou-core list-tools-db --schema

# JSON output for scripting
vodou-core list-tools-db --format json

# Markdown output for documentation
vodou-core list-tools-db --format markdown
```

**Expected Output (Table Format):**
```
🔍 Querying tools from database...
✅ Found 2 tools in database:

📦 context7:
  🔧 get-library-docs - Fetches up-to-date documentation for a library
  🔧 resolve-library-id - Resolves a package/product name to a library ID
```

**Expected Output (JSON Format):**
```json
[
  {
    "server": "context7",
    "tool": "get-library-docs",
    "description": "Fetches up-to-date documentation for a library",
    "schema": "{\"$schema\":\"http://json-schema.org/draft-07/schema#\"...}"
  },
  {
    "server": "context7", 
    "tool": "resolve-library-id",
    "description": "Resolves a package/product name to a library ID",
    "schema": "{\"$schema\":\"http://json-schema.org/draft-07/schema#\"...}"
  }
]
```

**Performance Comparison:**
```bash
# Database query (instant)
time vodou-core list-tools-db
# ~50ms (no MCP connections)

# Traditional discovery (slower)
time vodou-core all-tools
# ~2-3 seconds (connects to all servers)
```

**Use Cases:**
- **Scripting**: Use JSON output for automated tool discovery
- **Documentation**: Use Markdown output for generating docs
- **Debugging**: Quick tool lookup without server connections
- **Performance**: Instant tool discovery for large setups

### Example 4: Real-time Health Monitoring with Auto-Recovery
Monitor server health with background monitoring and automatic recovery.

```bash
# Start background health monitoring with auto-recovery
vodou-core start-monitoring --auto-recovery

# View real-time health dashboard
vodou-core health-dashboard

# Check detailed health status
vodou-core health-check-detailed --detailed

# View comprehensive health statistics
vodou-core health-stats

# Stop monitoring when done
vodou-core stop-monitoring
```

**Expected Health Dashboard:**
```
🏥 Health Dashboard
================================================================================
📊 Overall Health Statistics:
   Servers: 4 total (✅ 3 healthy, ⚠️ 1 degraded, ❌ 0 unhealthy)
   Monitoring Service: 🟢 Active (background monitoring enabled)
   Connection Pool: 🟢 Optimal (3/4 servers pooled, avg 145ms response)

🖥️  Server Health Details:
   ✅ Healthy mcp-monitor (100% success, 8ms avg)
   ✅ Healthy filesystem (97% success, 45ms avg)
   ✅ Healthy browser-tools (95% success, 78ms avg)
   ⚠️ Degraded database-server (89% success, 234ms avg)
```

### Example 4: Complete MCP Orchestration Workflow
End-to-end workflow demonstrating all enhanced features.

```bash
# 1. Discovery Phase
echo "🔍 Phase 1: Server Discovery"
vodou-core search "monitoring" --limit 3
vodou-core install mcp-monitor

# 2. Universal Tool Routing Phase
echo "🎯 Phase 2: Universal Tool Routing"
vodou-core all-tools --by-server
vodou-core call-tool get_cpu_info --verbose
vodou-core call-tool get_memory_info

# 3. Health Monitoring Phase
echo "🏥 Phase 3: Health Monitoring"
vodou-core start-monitoring --interval 30 --auto-recovery
vodou-core health-dashboard --refresh 10

# 4. Registry Management Phase
echo "📋 Phase 4: Registry Management"
vodou-core registry --filter installed --detailed
```

## 🌐 Universal MCP Architecture Examples

### Example 5: Remote HTTP Server Connection ⭐ **New!**

Connect to cloud-hosted MCP servers via HTTP/HTTPS with authentication.

```bash
# 1. Connect to remote server with validation
vodou-core connect gusto --url https://mcp.api.gusto.com/anthropic --validate

# Output:
# 🔍 Validating server before connection...
# ✅ Server connection successful
# ✅ MCP protocol initialized
# 🔍 Discovering server capabilities...
#
# 📊 Server capabilities preview:
#    🔧 Tools: 12
#    📝 Prompts: 3
#    📄 Resources: 5
#
# 🔧 Available tools:
#    - get_employee_info: Get employee information
#    - list_employees: List all employees
#    - create_employee: Create new employee
#    ... and 9 more
#
# ❓ Add this server to Vodou? (y/n): y
# ✅ Proceeding with connection...
# ✅ Connected! Discovered:
#    🔧 Tools: 12
#    📝 Prompts: 3
#    📄 Resources: 5

# 2. Add credentials (using environment variable - recommended)
vodou-core credentials gusto add --cred-type api_key --from-env "GUSTO_API_KEY" --header "X-API-Key"

# 3. Add API key to .env file
echo "GUSTO_API_KEY=sk-xxx" >> .env

# 4. Test credentials
vodou-core credentials gusto test
# ✅ Credentials valid - server responded successfully

# 5. Use the server
vodou-core call gusto get_employee_info
```

### Example 5.1: Complete Remote Server Workflow

Full workflow from connection to usage with intent mapping.

```bash
# Step 1: Connect with validation
vodou-core connect gusto --url https://mcp.api.gusto.com/anthropic --validate

# Step 2: Add credentials from environment variable
vodou-core credentials gusto add --cred-type api_key --from-env "GUSTO_API_KEY" --header "X-API-Key"

# Step 3: Configure environment
echo "GUSTO_API_KEY=sk-xxx" >> .env

# Step 4: Add intent mapping for natural language queries
vodou-core intent add "gusto employee" gusto get_employee_info 10
vodou-core intent add "list gusto employees" gusto list_employees 10

# Step 5: Use natural language queries
vodou-core brain "get gusto employee info"
vodou-core brain "list gusto employees"
```

### Example 5.2: Multiple Credential Types

Some servers require multiple authentication headers.

```bash
# Connect to server
vodou-core connect api-server --url https://api.example.com/mcp

# Add API key
vodou-core credentials api-server add --cred-type api_key --from-env "API_KEY" --header "X-API-Key"

# Add bearer token
vodou-core credentials api-server add --cred-type bearer_token --from-env "BEARER_TOKEN" --header "Authorization" --format "Bearer {token}"

# Configure environment
echo "API_KEY=key-xxx" >> .env
echo "BEARER_TOKEN=token-xxx" >> .env

# Both credentials will be sent in requests
vodou-core call api-server some_tool
```

### Example 5.3: Custom API Server Integration

Connect to a custom MCP server with custom headers.

```bash
# Connect with custom headers (temporary for testing)
vodou-core connect custom-api --url https://api.example.com/mcp \
  --headers "Authorization:Bearer token,X-Custom-Header:value"

# Or add credentials properly
vodou-core credentials custom-api add --cred-type bearer_token "token-xxx" \
  --header "Authorization" --format "Bearer {token}"

# Use the server
vodou-core call custom-api custom_tool
```

### Example 6: STDIO and HTTP Server Support
Demonstrate universal compatibility with different server types.

```bash
# Connect STDIO-based server (traditional)
vodou-core connect node-server node ./path/to/server.js --validate

# Connect HTTP-based server (service-based)
vodou-core connect http-server http://localhost:3000/mcp --validate

# View both in registry with connection types
vodou-core registry --detailed

# Use tools from both types seamlessly
vodou-core call-tool stdio_tool     # Routes to STDIO server
vodou-core call-tool http_tool      # Routes to HTTP server
```

**Expected Registry Output:**
```
📦 Server: node-server
   🔧 Connection Type: STDIO
   Type: 🟢 Node.js server
   
📦 Server: http-server  
   🔧 Connection Type: HTTP
   Type: 🌐 HTTP service server
```

### Example 6: Mixed Environment Management
Handle both STDIO and HTTP servers simultaneously.

```bash
# Connect multiple server types
vodou-core connect filesystem node ./MCP-servers/filesystem/server.js
vodou-core connect browser-tools http://localhost:8080/mcp
vodou-core connect native-monitor ./bin/monitor

# View all connection types
vodou-core registry --detailed

# Universal tool routing works across all types
vodou-core all-tools --by-server
vodou-core call-tool read_file      # STDIO server
vodou-core call-tool take_screenshot # HTTP server  
vodou-core call-tool get_cpu_info   # Native binary
```

## 📊 Performance Optimization Examples

### Example 7: Connection Pooling Benefits
Demonstrate 25-50x performance improvement through connection pooling.

```bash
# Time traditional tool discovery (without pooling)
echo "⏱️ Testing performance improvements..."

# With connection pooling (Brain Trust 4)
time vodou-core tools filesystem
# Result: 0.133 seconds (25-50x improvement!)

# Multiple calls demonstrate pooling benefits
time vodou-core call-tool get_cpu_info
time vodou-core call-tool get_memory_info  
time vodou-core call-tool get_disk_info
# Each subsequent call: ~200ms (vs 5-10 seconds without pooling)

# View connection pool statistics
vodou-core health-check --metrics
vodou-core routing-stats
```

### Example 8: Intelligent Caching and Performance
Leverage 5-minute tool cache and intelligent routing.

```bash
# First tool discovery (builds cache)
time vodou-core all-tools
# ~1 second (initial discovery)

# Subsequent discoveries (uses cache)
time vodou-core all-tools
# ~100ms (cache hit)

# View cache performance
vodou-core routing-stats
# Shows cache hit rate and routing performance

# Cache automatically refreshes every 5 minutes
# Background monitoring keeps health data fresh
```

## 🧠 Brain Trust Integration Examples

### Example 9: Work Logging and Pattern Tracking
Comprehensive audit trail and pattern recognition.

```bash
# All operations are automatically logged to Brain Trust
vodou-core install filesystem          # Logged: server installation
vodou-core call-tool read_file         # Logged: tool routing
vodou-core health-check                # Logged: health monitoring

# Work logging provides:
# - Complete audit trail of all operations
# - Pattern recognition for usage optimization
# - Performance tracking and analysis
# - Graceful fallback when Brain Trust unavailable

# Example log entries (when Brain Trust available):
# 🧠 [Brain Trust]: Installed MCP server 'filesystem' via auto-install
# 🧠 [Brain Trust]: Routed tool 'read_file' to server 'filesystem'
# 🧠 [Brain Trust]: Started health monitoring with 4 connected servers
```

### Example 10: Production Deployment Pattern
Complete production-ready deployment workflow.

```bash
#!/bin/bash
# Production deployment script

echo "🚀 Deploying Brain Trust 4 Enhanced MCP Orchestration"

# 1. Server Discovery and Installation
vodou-core search "database" --keywords "postgres"
vodou-core install postgres --as-name production-db

vodou-core search "monitoring" --keywords "system,performance"  
vodou-core install mcp-monitor --as-name system-monitor

# 2. Health Monitoring Setup
vodou-core start-monitoring --interval 30 --auto-recovery

# 3. Configuration Generation

# 4. Validation Testing
vodou-core health-check-detailed --detailed
vodou-core all-tools
vodou-core routing-stats

# 5. Production Readiness Check
echo "✅ Production readiness verification:"
echo "   - Connection pooling: $(vodou-core health-check --metrics | grep pooled)"
echo "   - Tool routing: $(vodou-core routing-stats | grep 'Total unique tools')"
echo "   - Health monitoring: $(vodou-core health-dashboard | grep 'Monitoring Service')"

echo "🎉 Brain Trust 4 deployment complete!"
```

## 🔧 Advanced Integration Examples

### Example 11: Inspecting Installed Servers
Installed servers live in `vodou-core.db` (the `mcp_servers` table). Inspect and
validate them with the built-in commands — no generated config file is involved.

```bash
# List installed servers and their tools
vodou-core list
vodou-core all-tools

# Probe a single server (spins up the MCP Inspector CLI against a temp config)
vodou-core inspect mcp-monitor
vodou-core validate mcp-monitor

# Query the registry directly
sqlite3 vodou-core.db "SELECT name FROM mcp_servers ORDER BY name"
```

### Example 12: Enterprise Health Monitoring
Comprehensive health monitoring for production environments.

```bash
# Enterprise monitoring setup
vodou-core start-monitoring --interval 15 --auto-recovery

# Continuous monitoring dashboard
vodou-core health-dashboard --refresh 30 &

# Health alerts and notifications (example integration)
while true; do
  STATUS=$(vodou-core health-stats | grep "Unhealthy: 0" || echo "ALERT")
  if [[ "$STATUS" == "ALERT" ]]; then
    vodou-core health-check-detailed --detailed > health-report.txt
    echo "🚨 Health alert generated: health-report.txt"
  fi
  sleep 300  # Check every 5 minutes
done
```

## 📈 Performance Benchmarking Examples

### Example 13: Performance Testing and Optimization
Benchmark and optimize Brain Trust 4 performance.

```bash
#!/bin/bash
# Performance benchmarking script

echo "📊 Brain Trust 4 Performance Benchmarks"

# 1. Tool Discovery Performance
echo "🔍 Tool Discovery Benchmark:"
time vodou-core all-tools > /dev/null
echo "Expected: ~600ms for 39 tools across 4 servers"

# 2. Health Check Performance  
echo "🏥 Health Check Benchmark:"
time vodou-core health-check-detailed > /dev/null
echo "Expected: ~600ms for 4 servers with capabilities"

# 3. Registry Performance
echo "📋 Registry Performance:"
time vodou-core registry --detailed > /dev/null
echo "Expected: ~16ms with caching"

# 4. Tool Routing Performance
echo "⚡ Tool Routing Benchmark:"
time vodou-core call-tool get_cpu_info > /dev/null
echo "Expected: ~200ms with connection pooling"

# 5. Connection Pool Efficiency
echo "🔄 Connection Pool Efficiency:"
vodou-core routing-stats | grep "Cache hit rate"
echo "Target: >80% cache hit rate"

echo "✅ Performance benchmarking complete!"
```

## 🎯 Use Case Examples

### Example 14: Development Workflow Optimization
Optimize development workflows with enhanced MCP orchestration.

```bash
# Development setup
vodou-core search "code analysis" --keywords "lint,format,test"
vodou-core install code-analyzer

vodou-core search "file management" --keywords "read,write,search"
vodou-core install filesystem

# Daily development tasks
vodou-core call-tool analyze_code --args '{"path":"./src"}'
vodou-core call-tool format_code --args '{"path":"./src","style":"rust"}'
vodou-core call-tool run_tests --args '{"path":"./tests"}'

# Monitor development server health
vodou-core health-dashboard --refresh 60
```

### Example 15: Multi-Environment Server Management
Manage servers across different environments.

```bash
# Development environment
vodou-core connect dev-db node ./dev-database-server.js
vodou-core connect dev-api http://localhost:3000/mcp

# Staging environment  
vodou-core connect staging-db node ./staging-database-server.js
vodou-core connect staging-api http://staging.example.com/mcp

# Production environment
vodou-core connect prod-db node ./prod-database-server.js  
vodou-core connect prod-api https://api.example.com/mcp

# View environment-specific registry
vodou-core registry --filter connected --detailed

# Environment-specific tool routing
vodou-core call-tool db_query --args '{"env":"dev","query":"SELECT 1"}'
vodou-core call-tool api_call --args '{"env":"prod","endpoint":"/health"}'
```

## 🔍 Troubleshooting Examples

### Example 16: Common Issue Resolution
Resolve common issues with Brain Trust 4.

```bash
# Issue: Tool not found
vodou-core call-tool missing_tool
# Solution: Check available tools and install missing servers
vodou-core all-tools
vodou-core search "tool functionality"
vodou-core install appropriate-server

# Issue: Server health degraded
vodou-core health-dashboard  # Shows degraded server
# Solution: Reconnect and monitor
vodou-core reconnect degraded-server
vodou-core health-check-detailed --server degraded-server

# Issue: Poor performance
vodou-core routing-stats  # Shows low cache hit rate
# Solution: Check connection pool and restart monitoring
vodou-core stop-monitoring
vodou-core start-monitoring --auto-recovery
```

## 💡 Pro Tips and Best Practices

### Example 17: Optimization Best Practices
Maximize Brain Trust 4 performance and reliability.

```bash
# 1. Enable background monitoring for optimal performance
vodou-core start-monitoring --auto-recovery --interval 30

# 2. Use universal tool routing for best performance
vodou-core call-tool tool_name  # Instead of vodou-core call server tool_name

# 3. Monitor health regularly
vodou-core health-dashboard --refresh 300  # 5-minute refresh

# 4. Keep tool cache fresh
vodou-core all-tools  # Refreshes cache when needed

# 5. Use registry filtering for large setups
vodou-core registry --filter connected --detailed

# 6. Generate enhanced configs for Inspector integration

# 7. Regular performance monitoring
vodou-core routing-stats
vodou-core health-stats
```

---

## 📁 Filesystem Server Examples

### Example 12: Filesystem Server Setup with Security Management
Complete setup of filesystem server with directory permissions and approval policies.

```bash
# 1. Install filesystem server
vodou-core search "file operations"
vodou-core install @modelcontextprotocol/server-filesystem --as-name dev-fs

# 2. Connect with enhanced configuration
vodou-core connect dev-fs npx @modelcontextprotocol/server-filesystem \
  --allowed-dirs ~/dev/project ~/dev/configs \
  --approval-policy "strict" \
  --progress-tracking
```

**Expected Output:**
```
🔌 Connecting to MCP server: dev-fs (npx)
🔧 Setting up enhanced configuration...
  📁 Allowed directories: 2
    - ~/dev/project -> file:///Users/user/dev/project
    - ~/dev/configs -> file:///Users/user/dev/configs
  🔐 Approval policy: strict (all operations require approval)
  📊 Progress tracking: enabled

🤝 Initializing MCP protocol...
🔍 Discovering capabilities...
✅ Connected! Discovered:
   🔧 Tools: 8
   📝 Prompts: 0
   📄 Resources: 0

🔧 Tools:
  - read_file: Read file content from allowed directories
  - write_file: Write content to files in allowed directories  
  - list_directory: List files and directories
  - delete_file: Delete files from allowed directories
  - create_directory: Create directories in allowed paths
  - file_exists: Check if file exists
  - get_file_stats: Get file metadata and statistics
  - watch_directory: Monitor directory changes
```

### Example 13: Managing Filesystem Permissions and Roots
Dynamic management of filesystem server access permissions.

```bash
# View current allowed directories
vodou-core roots dev-fs

# Add more allowed directories
vodou-core update-roots dev-fs --add "/tmp" --add "/Users/user/Documents"

# Remove specific directory access
vodou-core update-roots dev-fs --remove "/tmp"

# View updated permissions
vodou-core roots dev-fs --detailed
```

**Expected Output:**
```
📁 Filesystem Roots for server 'dev-fs':
  
🔓 Allowed Directories (3):
  1. file:///Users/user/dev/project
     📍 Path: ~/dev/project
     📊 Status: accessible, 247 files, 15 subdirectories
     🕒 Added: 2025-01-12 10:30:00
  
  2. file:///Users/user/dev/configs  
     📍 Path: ~/dev/configs
     📊 Status: accessible, 12 files, 3 subdirectories
     🕒 Added: 2025-01-12 10:30:00
  
  3. file:///Users/user/Documents
     📍 Path: ~/Documents
     📊 Status: accessible, 89 files, 8 subdirectories
     🕒 Added: 2025-01-12 10:45:00

🔒 Security: All file operations require approval (strict policy)
💡 Use 'vodou-core approval-policy dev-fs relaxed' to allow safe operations automatically
```

### Example 14: Filesystem Operations with Approval System
Using the approval system for filesystem operations.

```bash
# Configure approval policy for development workflow
vodou-core approval-policy dev-fs relaxed

# Set up auto-approval for safe read operations
vodou-core auto-approve dev-fs --operations "read_file,list_directory,file_exists"

# View current approval configuration  
vodou-core approvals dev-fs --configuration

# Perform filesystem operations
vodou-core call-tool read_file --args '{"path": "~/dev/project/README.md"}'
vodou-core call-tool write_file --args '{"path": "~/dev/project/test.txt", "content": "Hello World"}'
```

**Approval System in Action:**
```
🔧 Calling tool 'read_file' on server 'dev-fs'...
✅ Auto-approved: read_file (safe operation, relaxed policy)
📦 Result: File content retrieved successfully

🔧 Calling tool 'write_file' on server 'dev-fs'...
⏳ Approval required for write_file operation
📋 Operation Details:
  Server: dev-fs
  Tool: write_file
  Path: ~/dev/project/test.txt
  Size: 11 bytes
  Policy: relaxed (write operations require approval)

❓ Approve this file write operation? (y/N): y
✅ Approved by user
📦 Result: File written successfully

📊 Approval logged:
  Decision: approved
  Reason: User approved file write  
  Time: 2025-01-12 10:55:30
```

### Example 15: Progress Tracking for Large File Operations
Monitor progress of long-running filesystem operations.

```bash
# Start a large file processing operation
vodou-core call-tool process_directory --args '{
  "path": "~/dev/project", 
  "operation": "analyze_code",
  "recursive": true
}'

# Monitor operation progress in real-time
vodou-core progress dev-fs

# View detailed progress information  
vodou-core progress dev-fs --operation analyze_abc123 --detailed

# Cancel operation if needed
vodou-core cancel dev-fs --operation analyze_abc123
```

**Progress Tracking Output:**
```
📊 Active Operations for server 'dev-fs':

[analyze_abc123] Code Analysis (67.8% complete)
  📁 Processing: ~/dev/project/src/components/
  📈 Progress: 2,033 of 3,000 files processed
  ⏱️  Runtime: 3 minutes 45 seconds
  💾 Memory: 245MB used
  📊 Rate: 15.2 files/second

[backup_def456] File Backup (23.1% complete)  
  📁 Processing: ~/dev/project/assets/
  📈 Progress: 156 of 675 files processed
  ⏱️  Runtime: 1 minute 12 seconds
  💾 Memory: 89MB used
  📊 Rate: 2.3 files/second

💡 Use 'vodou-core cancel dev-fs --operation <id>' to stop operations
💡 Use 'vodou-core progress dev-fs --all' to see completed operations
```

### Example 16: Advanced Filesystem Server Configuration
Complete advanced setup with sampling, notifications, and auto-approval.

```bash
# Connect with comprehensive configuration
vodou-core connect advanced-fs npx @modelcontextprotocol/server-filesystem \
  --allowed-dirs ~/dev ~/Downloads ~/Documents \
  --sampling-config "data:{\"interval\":5000,\"types\":[\"file_changes\"]}" \
  --notification-config "roots/listChanged:true:{\"auto_update\":true}" \
  --approval-policy "relaxed" \
  --progress-tracking \
  --auto-approve "read_operations,list_operations"

# Configure detailed auto-approval rules
vodou-core auto-approve advanced-fs \
  --operations "read_file,list_directory,file_exists,get_file_stats" \
  --conditions '{"max_file_size": 10485760, "allowed_extensions": [".txt", ".md", ".json", ".yaml"]}'

# Set up notification preferences
vodou-core approval-policy advanced-fs relaxed \
  --notify-on-approval \
  --log-all-operations

# View complete server configuration
vodou-core config advanced-fs --detailed
```

**Advanced Configuration Output:**
```
📋 Advanced Configuration for 'advanced-fs':

🔧 Server Details:
  Command: npx @modelcontextprotocol/server-filesystem
  Connection: STDIO (process-based)
  Status: ✅ Healthy (98.7% uptime)

📁 Filesystem Permissions (3 directories):
  - ~/dev (file:///Users/user/dev)
  - ~/Downloads (file:///Users/user/Downloads)  
  - ~/Documents (file:///Users/user/Documents)

🔐 Approval System:
  Policy: relaxed (safe operations auto-approved)
  Auto-approval rules: 4 operations
  - read_file: auto (max 10MB, specific extensions)
  - list_directory: auto (no conditions)
  - file_exists: auto (no conditions)
  - get_file_stats: auto (no conditions)

📊 Sampling Configuration:
  Data sampling: enabled (5 second interval)
  Types: file_changes
  Status: collecting filesystem change events

🔔 Notification Settings:
  roots/listChanged: enabled (auto_update: true)
  File change notifications: enabled
  Approval notifications: enabled

📈 Progress Tracking:
  Enabled: yes
  Active operations: 0
  Completed operations: 15
  Average operation time: 2.3 seconds
```

### Example 17: Filesystem Server Troubleshooting and Maintenance
Common maintenance and troubleshooting workflows.

```bash
# Check filesystem server health
vodou-core health-check advanced-fs --detailed

# Test filesystem permissions
vodou-core call-tool list_directory --args '{"path": "~/dev"}'

# Clear completed progress entries
vodou-core clear-progress advanced-fs

# View approval history for audit
vodou-core approvals advanced-fs --history 50

# Reconnect if server becomes unresponsive
vodou-core reconnect advanced-fs

# Emergency: clear all filesystem permissions
vodou-core clear-roots advanced-fs
```

**Troubleshooting Output:**
```
🏥 Health Check - server 'advanced-fs':
✅ Connection: healthy (200ms response time)
✅ Filesystem access: all 3 directories accessible
✅ Tools: 8 tools responding correctly
✅ Approval system: 4 auto-approval rules active
✅ Progress tracking: database accessible
⚠️  Notification: 2 pending notifications (minor)

🔍 Filesystem Permission Test:
📁 ~/dev: ✅ accessible (247 files, 15 directories)
📁 ~/Downloads: ✅ accessible (89 files, 8 directories) 
📁 ~/Documents: ✅ accessible (156 files, 12 directories)

📊 Approval History (last 10 decisions):
  2025-01-12 11:30:00: approved - write_file (~/dev/test.txt)
  2025-01-12 11:25:15: auto-approved - read_file (~/dev/README.md)
  2025-01-12 11:20:45: approved - delete_file (~/dev/old.txt)
  2025-01-12 11:15:30: auto-approved - list_directory (~/dev)
  ...

💡 Server is healthy and performing optimally
💡 Consider clearing old progress entries for better performance
```

### Example 18: Multi-Environment Filesystem Setup
Production-ready filesystem server setup for different environments.

```bash
#!/bin/bash
# multi-env-filesystem-setup.sh - Setup filesystem servers for different environments

# Development environment - permissive for productivity
vodou-core connect dev-fs npx @modelcontextprotocol/server-filesystem \
  --allowed-dirs ~/dev ~/tmp ~/Downloads \
  --approval-policy "relaxed" \
  --auto-approve "read_operations,list_operations,safe_write_operations"

# Staging environment - balanced security and functionality  
vodou-core connect staging-fs npx @modelcontextprotocol/server-filesystem \
  --allowed-dirs /app/staging /tmp/staging \
  --approval-policy "strict" \
  --progress-tracking \
  --notification-config "all:true"

# Production environment - maximum security
vodou-core connect prod-fs npx @modelcontextprotocol/server-filesystem \
  --allowed-dirs /app/production \
  --approval-policy "strict" \
  --progress-tracking \
  --auto-approve "read_operations" \
  --notification-config "all:true:{\"alert_on_write\":true}"

echo "✅ Multi-environment filesystem setup complete:"
vodou-core list
vodou-core registry --filter connected
```

### Example 8: Natural Language Intent Management

Discover, add, and remove intent mappings through natural language commands.

```bash
# Discover all available intent mappings
./do "show me all intent mappings"
# Output: Lists all 83+ intent mappings with server::tool and priority

# Filter intent mappings by category
./do "show me intent mappings for docker"
# Output: Shows only docker-related intent mappings

./do "show me intent mappings for browser"
# Output: Shows only browser-related intent mappings

# Add new intent mappings
# Format: keyword → MCP-server-name::tool-name priority X
#
# Format Breakdown:
#   keyword         = The trigger phrase you'll type (e.g., "performance")
#   MCP-server-name = The MCP server providing the tool (e.g., "mcp-monitor")
#   tool-name       = The specific tool to execute (e.g., "get_cpu_info")
#   priority        = Higher number = preferred when multiple match (1-15+)
#
# Visual:
#   ./do "add intent mapping: health → mcp-monitor::get_cpu_info priority 15"
#                             ^^^^^^   ^^^^^^^^^^^  ^^^^^^^^^^^^  ^^^^^^^^^^
#                             keyword  MCP server   tool name     priority

./do "add intent mapping: performance → mcp-monitor::get_cpu_info priority 10"
# Output: ✅ ADDED INTENT MAPPING: performance → mcp-monitor::get_cpu_info (priority: 10)

./do "add intent mapping: speed → mcp-monitor::get_cpu_info priority 5"
# Output: ✅ ADDED INTENT MAPPING: speed → mcp-monitor::get_cpu_info (priority: 5)

# Test new intent mappings
./do "performance"
# Output: CPU information with intent visibility showing which mapping was used

./do "speed"
# Output: CPU information with intent visibility

# Remove intent mappings
./do "remove intent mapping: performance"
# Output: ✅ REMOVED INTENT MAPPING: 'performance'

./do "remove intent mapping: speed"
# Output: ✅ REMOVED INTENT MAPPING: 'speed'
```

**Expected Output for Intent Discovery:**
```
📋 **INTENT MAPPINGS** (83 total)
• accessibility → browser-tools-stdio::runAccessibilityAudit (priority: 10)
• analyze → context7::resolve_library_id (example; codebase context is memory + local tools) (priority: 10)
• audit → browser-tools-stdio::runAuditMode (priority: 10)
• browser → browser-tools-stdio::navigate (priority: 10)
• chrome → chrome-devtools::list_pages (priority: 10)
• clear → browser-tools-stdio::wipeLogs (priority: 10)
• console → browser-tools-stdio::getConsoleErrors (priority: 10)
• cpu → mcp-monitor::get_cpu_info (priority: 10)
• debugger → browser-tools-stdio::runDebuggerMode (priority: 10)
• disk → mcp-monitor::get_disk_info (priority: 10)
• docker → dockerhub::search (priority: 10)
...

💡 **USAGE EXAMPLES**:
• ./do "cpu" → uses cpu intent mapping
• ./do "console errors" → uses console/error intent mappings
• ./do "docker search" → uses docker intent mappings
```

**Expected Output for Intent Visibility:**
```bash
./do "cpu"
# Output includes:
# 📋 **INTENT MAPPING USED**: cpu → mcp-monitor::get_cpu_info (priority: 10)
# 🔧 **AVAILABLE INTENTS**: accessibility, analyze, audit, browser, chrome, clear, console, cpu, debugger, disk
```

**Features Demonstrated:**
- **Intent Discovery** - Natural language queries to explore available intents
- **Intent Management** - Add/remove intent mappings through natural language
- **Intent Visibility** - See which intent mapping was used in responses
- **Category Filtering** - Filter intents by docker, browser, system, etc.
- **Immediate Effect** - New mappings work instantly with existing queries

---

## 📚 Complete Example Workflows

These examples demonstrate the full power of Brain Trust 4 Enhanced MCP Orchestration Platform, showcasing:

- **25-50x Performance Improvement** through connection pooling
- **Universal MCP Architecture** supporting STDIO and HTTP servers
- **Intelligent Server Discovery** with auto-installation
- **Real-time Health Monitoring** with auto-recovery
- **Universal Tool Routing** with smart server selection
- **Natural Language Intent Management** for AI agent control
- **Brain Trust Integration** for complete work logging
- **Production-Ready Reliability** with comprehensive error handling

For more detailed information, see the [CLI Reference](cli-reference.md) and the [Architecture Guide](../docs-DEV/architecture.md) (internal doc).