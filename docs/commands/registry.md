# registry

Comprehensive server registry with filtering, metadata, and real-time status information.

## Syntax

```bash
vodou-core registry [OPTIONS]
```

## Description

The `registry` command provides a comprehensive view of all registered MCP servers with enhanced metadata, real-time status checking, server classification, and filtering capabilities. It serves as the central hub for server management and overview.

## Options

- `--detailed` - Show detailed server information including capabilities and metadata
- `--filter <TYPE>` - Filter servers by type: `all`, `manual`, `installed`, `connected` (default: `all`)

## Features

### Server Classification
- **🤖 Auto-installed** - Servers installed via `vodou-core install`
- **📦 NPM packages** - Global NPM package installations
- **🟢 Node.js servers** - Manual Node.js server setups
- **🐍 Python servers** - Manual Python server setups  
- **⚙️ Manual setup** - Other manual configurations

### Real-time Status
- **✅ Available** - Server responding and healthy
- **⚠️ Degraded** - Server responding but with performance issues
- **❌ Unavailable** - Server not responding or unreachable
- **🔄 Connecting** - Server connection in progress
- **❓ Unknown** - Status not yet determined

## Examples

### Basic Registry View
```bash
# Show all registered servers
vodou-core registry

# Show detailed information
vodou-core registry --detailed
```

### Filtered Views
```bash
# Show only auto-installed servers
vodou-core registry --filter installed

# Show only manually configured servers
vodou-core registry --filter manual

# Show only currently connected servers
vodou-core registry --filter connected
```

## Example Output

### Basic Registry View
```bash
$ vodou-core registry
📋 Brain Trust 4 Server Registry
============================================================
📊 Registry Overview:
   Total Servers: 4
   Filtered View: 4 servers
   Filter: all

📦 Server List:
   1. 🟢 ✅ Available browser-tools-stdio - node
      Command: node MCP-servers/browser-tools-mcp/browser-tools-mcp/dist/mcp-server.js
      Type: 🟢 Node.js server

   2. 🟢 ✅ Available chrome-devtools - npx  
      Command: npx -y chrome-devtools-mcp@latest
      Type: 🟢 Node.js server

   3. 🤖 ✅ Available mcp-monitor - ./MCP-servers/mcp-monitor/bin/mcp-monitor
      Command: ./MCP-servers/mcp-monitor/bin/mcp-monitor
      Type: 🤖 Auto-installed server

   4. 🟢 ✅ Available mcpadvisor - node
      Command: node ./MCP-servers/mcpadvisor/build/index.js  
      Type: 🟢 Node.js server

📈 Registry Statistics:
   🤖 Auto-installed: 1
   📦 NPM packages: 0
   ⚙️ Manual setup: 3
   ✅ Available: 4 (100%)
   ❌ Unavailable: 0 (0%)

💡 Use --detailed for complete server information
💡 Use --filter to narrow results (manual, installed, connected)
```

### Detailed Registry View
```bash
$ vodou-core registry --detailed
📋 Brain Trust 4 Server Registry (Detailed View)
============================================================
📊 Registry Overview:
   Total Servers: 4
   Filtered View: 4 servers  
   Filter: all

🖥️ Detailed Server Information:

1. 📦 Server: browser-tools-stdio
   Command: node
   Arguments: ["MCP-servers/browser-tools-mcp/browser-tools-mcp/dist/mcp-server.js"]
   📊 Capabilities:
      🔧 Tools: 14 available
      📝 Prompts: 0 available
      📄 Resources: 0 available
   🏥 Health: ✅ Available (80ms response time)
   📈 Performance: 98% success rate, used 23 times
   🔄 Last Used: 2 minutes ago
   Type: 🟢 Node.js server
   📅 Added: 2025-09-10 14:32:15
   🔧 Connection Type: STDIO

2. 📦 Server: chrome-devtools
   Command: node
   Arguments: ["-y", "chrome-devtools-mcp@latest"]
   📊 Capabilities:
      🔧 Tools: 17 available
      📝 Prompts: 0 available  
      📄 Resources: 0 available
   🏥 Health: ✅ Available (150ms response time)
   📈 Performance: 97% success rate, used 45 times
   🔄 Last Used: 5 minutes ago
   Type: 🟢 Node.js server
   📅 Added: 2025-09-08 09:15:42
   🔧 Connection Type: STDIO

3. 📦 Server: mcp-monitor  
   Command: ./MCP-servers/mcp-monitor/bin/mcp-monitor
   Arguments: []
   📊 Capabilities:
      🔧 Tools: 6 available
      📝 Prompts: 0 available
      📄 Resources: 0 available  
   🏥 Health: ✅ Available (8ms response time)
   📈 Performance: 100% success rate, used 67 times
   🔄 Last Used: 30 seconds ago
   Type: 🤖 Auto-installed server
   📅 Added: 2025-09-10 16:45:23 (via auto-install)
   🔧 Connection Type: STDIO
   📦 Installation: Auto-installed from external registry

4. 📦 Server: mcpadvisor
   Command: node  
   Arguments: ["./MCP-servers/mcpadvisor/build/index.js"]
   📊 Capabilities:
      🔧 Tools: 2 available
      📝 Prompts: 0 available
      📄 Resources: 10 available
   🏥 Health: ✅ Available (456ms response time)  
   📈 Performance: 95% success rate, used 12 times
   🔄 Last Used: 15 minutes ago
   Type: 🟢 Node.js server
   📅 Added: 2025-09-09 11:22:07
   🔧 Connection Type: STDIO

📈 Aggregated Statistics:
   Total Tools: 39 across all servers
   Total Prompts: 0 across all servers  
   Total Resources: 10 across all servers
   Average Response Time: 173ms
   Overall Success Rate: 97.5%
   Total Usage: 147 tool calls
```

### Filtered Views
```bash
$ vodou-core registry --filter installed
📋 Brain Trust 4 Server Registry
============================================================
📊 Registry Overview:
   Total Servers: 4
   Filtered View: 1 servers
   Filter: installed

📦 Server List:
   1. 🤖 ✅ Available mcp-monitor - ./MCP-servers/mcp-monitor/bin/mcp-monitor
      Command: ./MCP-servers/mcp-monitor/bin/mcp-monitor
      Type: 🤖 Auto-installed server

📈 Registry Statistics:
   🤖 Auto-installed: 1
   ✅ Available: 1 (100%)

💡 Use --filter all to see all servers
💡 Use --detailed for complete server information
```

## Server Type Detection

### Automatic Classification
The registry automatically classifies servers based on:

- **Installation Method** - How the server was added (manual vs auto-install)
- **Command Pattern** - Command structure and executable type
- **Path Analysis** - Installation directory and file structure
- **Metadata** - Server metadata and configuration

### Type Categories
```bash
🤖 Auto-installed    # Via vodou-core install command
📦 NPM packages      # Global npm installations (npx commands)
🟢 Node.js servers   # Manual Node.js setups (node command)
🐍 Python servers    # Manual Python setups (python command)  
⚙️ Manual setup      # Other manual configurations
```

## Real-time Status Checking

### Live Availability Check
The registry performs real-time status checks using the connection pool:
- **Connection Test** - Attempts to establish connection
- **Health Verification** - Basic health check via MCP protocol
- **Response Time** - Measures connection and response latency
- **Capability Count** - Verifies tools/prompts/resources availability

### Performance Metrics
- **Success Rate** - Percentage of successful operations over time
- **Response Time** - Average response time for server operations
- **Usage Count** - Number of times server has been used
- **Last Used** - Time since server was last accessed

## Filtering Options

### Filter Types
- **`all`** (default) - Show all registered servers
- **`manual`** - Show manually configured servers only
- **`installed`** - Show auto-installed servers only  
- **`connected`** - Show currently connected/available servers only

### Filter Examples
```bash
# View only manual servers
vodou-core registry --filter manual --detailed

# Check which servers are currently connected
vodou-core registry --filter connected

# See all auto-installed servers
vodou-core registry --filter installed
```

## Integration with Other Commands

### Server Management Workflow
```bash
# 1. View all servers
vodou-core registry

# 2. Check detailed information for specific issues
vodou-core registry --detailed

# 3. Filter to specific types
vodou-core registry --filter manual

# 4. Take action on specific servers
vodou-core reconnect problematic-server
vodou-core remove old-server
```

### Discovery and Installation Workflow
```bash
# 1. Search for new servers
vodou-core search "database operations"

# 2. Install discovered servers
vodou-core install postgres

# 3. View updated registry  
vodou-core registry --filter installed

# 4. Test new servers
vodou-core tools postgres
```

## Performance and Caching

### Connection Pool Integration
- **Real-time Status** - Uses connection pool for fast status checks
- **Cached Results** - Leverages existing connections for performance
- **Background Updates** - Health status updated by background monitoring

### Refresh Behavior
- **Automatic Refresh** - Status updated on each registry call
- **Cache Utilization** - Uses cached capability data when available
- **Health Integration** - Incorporates health monitoring data

## Related Commands

- [`list`](list.md) - Simple server listing
- [`search`](search.md) - Find new servers to install
- [`install`](install.md) - Install servers from registries
- [`health-dashboard`](health-dashboard.md) - Comprehensive health monitoring

## Troubleshooting

### Server Not Showing
1. **Check Connection** - `vodou-core list` to verify server registration
2. **Refresh Registry** - `vodou-core registry` updates status
3. **Check Health** - `vodou-core health-check` for connectivity issues

### Status Issues
1. **Connection Problems** - `vodou-core reconnect server-name`
2. **Health Monitoring** - `vodou-core health-dashboard`
3. **Detailed Analysis** - `vodou-core registry --detailed`

### Performance Problems
1. **Server Response** - Check response times in detailed view
2. **Success Rates** - Monitor success rates for problematic servers
3. **Usage Patterns** - Review usage statistics for optimization

## See Also

- [Server Discovery Guide](../../docs-DEV/server-discovery.md) (internal)
- [List Command](list.md)
- [Install Command](install.md)
- [Health Monitoring Guide](../../docs-DEV/health-monitoring.md) (internal)