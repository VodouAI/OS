# status Command

Show health status and capability summary for MCP servers with optional detailed testing.

## Syntax

```bash
vodou-core status [OPTIONS] [NAME]
```

## Parameters

- **`[NAME]`** - Optional server name. If omitted, shows status for all servers

## Options

- **`--detailed`** - Show detailed status with Inspector test results (single server only)

## Description

The `status` command checks the health and connectivity of MCP servers. It provides:

- **Connection testing** - Verifies server can be reached
- **Initialization check** - Tests MCP protocol handshake
- **Capability summary** - Shows counts of tools, prompts, and resources
- **Real-time status** - Current server state, not cached data

## Examples

### Check All Servers

```bash
# Show status of all connected servers
vodou-core status
```

**Output:**
```
🔍 Testing 3 servers...

  ✅ chrome-devtools - Online
  ✅ mcp-monitor - Online
  ✅ mcpadvisor - Online
```

### Check Specific Server

```bash
# Check detailed status of one server
vodou-core status mcp-monitor
```

**Output:**
```
🔍 Testing server: mcp-monitor
  ✅ mcp-monitor - Online and responding
    🔧 Tools: 6
    📝 Prompts: 0
    📄 Resources: 0
```

## Status Indicators

| Icon | Status | Meaning |
|------|--------|---------|
| ✅ | Online | Server is running and responding correctly |
| ❌ | Failed | Server cannot be reached or failed to initialize |
| ⚠️ | Warning | Server responded but with issues |

## Use Cases

### Development Workflow
```bash
# Check if servers are ready before development
vodou-core status

# Verify specific server after configuration changes
vodou-core status my-server
```

### Debugging
```bash
# Check server status when tools aren't working
vodou-core status problematic-server

# Compare working vs non-working servers
vodou-core status working-server
vodou-core status broken-server
```

### Monitoring
```bash
# Quick health check in scripts
if vodou-core status my-server > /dev/null 2>&1; then
  echo "Server is healthy"
else
  echo "Server has issues"
fi
```

### Professional Development with Detailed Testing
```bash
# Enhanced status with Inspector test results
vodou-core status chrome-devtools --detailed
```

**Enhanced Output:**
```
🔍 Testing server: chrome-devtools
  ✅ chrome-devtools - Online and responding
    🔧 Tools: 5
    📝 Prompts: 2
    📄 Resources: 3
🧪 Quick Test Results:
  ✅ tools/list (18ms)
  ✅ prompts/list (25ms)
  ✅ resources/list (28ms)
```

## Status Modes

### Summary Mode (All Servers)
- Shows basic online/offline status
- Quick overview of all servers
- Minimal output for scripting

### Standard Mode (Single Server)
- Full connection testing
- Capability counts from database
- Detailed error information
- Comprehensive server information

### Detailed Mode (Single Server with --detailed)
- All standard mode information
- Inspector test results with response times
- Method-level verification
- Performance insights

## Error Scenarios

### Server Not Found
```bash
vodou-core status nonexistent-server
```
```
❌ Server not found: nonexistent-server
```

### Connection Failed
```
🔍 Testing server: broken-server
  ❌ broken-server - Cannot start process: No such file or directory
```

### Initialization Failed
```
🔍 Testing server: misconfigured-server
  ❌ misconfigured-server - Connection failed during initialization
```

## Related Commands

- [`health-check`](health-check.md) - Quick health check of all servers
- [`reconnect`](reconnect.md) - Fix connection issues by reconnecting
- [`list`](list.md) - See all connected servers
- [`capabilities`](capabilities.md) - Detailed capability analysis

## Performance Notes

- **Real-time testing**: Each status check connects to the server
- **Network dependent**: Requires server to be accessible
- **Quick operation**: Designed for fast health checking
- **Resource efficient**: Minimal resource usage per check

---

**Next:** [`health-check`](health-check.md) - Quick health check of all servers