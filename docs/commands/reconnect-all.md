# reconnect-all Command

Reconnect all servers and rediscover their capabilities with progress tracking.

## Syntax

```bash
vodou-core reconnect-all
```

## Parameters

None - operates on all connected servers automatically.

## Description

The `reconnect-all` command reconnects to every configured MCP server and rediscovers their capabilities. This bulk operation:

- **Processes all servers** - Works with every server in the database
- **Progress tracking** - Shows detailed progress for each server
- **Error resilience** - Continues processing even if some servers fail
- **Complete rediscovery** - Fully refreshes capability information
- **Detailed reporting** - Shows connection details and discovered capabilities

This is useful for:
- **System maintenance** - Refresh all servers after updates
- **Environment synchronization** - Ensure all servers have latest capabilities  
- **Troubleshooting** - Reset all connections when issues occur
- **Post-deployment verification** - Confirm all servers working after changes

## Examples

### Basic Reconnect All

```bash
vodou-core reconnect-all
```

**Sample Output:**
```
🔄 Reconnecting 3 servers...

  🔄 Reconnecting 1/3: chrome-devtools
🔌 Connecting to MCP server: chrome-devtools (node)
🤝 Initializing MCP protocol...
🔍 Discovering capabilities...
✅ Connected! Discovered:
   🔧 Tools: 17
   📝 Prompts: 0
   📄 Resources: 0

🔧 Tools:
  - navigate_page: Open URLs in the attached browser
  - take_snapshot: Page accessibility snapshot
  - take_screenshot: Viewport screenshot
  - [... additional tools listed ...]
    ✅ Reconnected: chrome-devtools

  🔄 Reconnecting 2/3: mcp-monitor  
🔌 Connecting to MCP server: mcp-monitor (./MCP-servers/mcp-monitor/bin/mcp-monitor)
🤝 Initializing MCP protocol...
🔍 Discovering capabilities...
✅ Connected! Discovered:
   🔧 Tools: 6
   📝 Prompts: 0
   📄 Resources: 0

🔧 Tools:
  - get_cpu_info: Get CPU information and usage
  - get_disk_info: Get disk usage information
  - get_host_info: Get host system information
  - get_memory_info: Get system memory usage information
  - get_network_info: Get network interface and traffic information
  - get_process_info: Get process information
    ✅ Reconnected: mcp-monitor

  🔄 Reconnecting 3/3: mcpadvisor
🔌 Connecting to MCP server: mcpadvisor (node)
🤝 Initializing MCP protocol...
🔍 Discovering capabilities...
✅ Connected! Discovered:
   🔧 Tools: 2
   📝 Prompts: 0
   📄 Resources: 10

🔧 Tools:
  - recommend-mcp-servers: Find suitable MCP servers
  - install-mcp-server: Install MCP servers

📄 Resources:
  - file:///var/log/system.log: Log: system.log
  - file:///var/log/wifi.log: Log: wifi.log
  - [... additional resources listed ...]
    ✅ Reconnected: mcpadvisor

🔄 Reconnection process completed
```

### No Servers to Reconnect

```bash
vodou-core reconnect-all
```

**Output:**
```
🔄 No servers to reconnect
```

### Mixed Success and Failures

```bash
vodou-core reconnect-all
```

**Sample Output:**
```
🔄 Reconnecting 3 servers...

  🔄 Reconnecting 1/3: working-server
    ✅ Reconnected: working-server

  🔄 Reconnecting 2/3: broken-server
    ❌ Failed to reconnect broken-server: No such file or directory

  🔄 Reconnecting 3/3: another-server
    ✅ Reconnected: another-server

🔄 Reconnection process completed
```

## Use Cases

### System Maintenance

```bash
# After updating multiple MCP servers
vodou-core reconnect-all

# Verify all servers have latest capabilities
vodou-core health-check
```

### Post-Deployment Verification

```bash
# After deploying new server versions
vodou-core reconnect-all

# Check that all expected capabilities are available
vodou-core status
```

### Environment Synchronization

```bash
# Ensure development environment matches production
vodou-core export-servers > current-config.json
# ... update server software ...
vodou-core reconnect-all
vodou-core export-servers > updated-config.json

# Compare configurations to verify updates
diff current-config.json updated-config.json
```

### Troubleshooting Workflow

```bash
# When multiple servers seem to have issues
vodou-core health-check  # Identify problems
vodou-core reconnect-all  # Attempt to fix
vodou-core health-check  # Verify resolution
```

## Progress Tracking Features

### Sequential Processing
- **One at a time** - Processes servers sequentially for clear output
- **Progress indicators** - Shows X/Y progress for each server
- **Detailed output** - Full connection and discovery details per server

### Error Resilience
- **Continue on failure** - Doesn't stop if one server fails
- **Individual reporting** - Success/failure reported per server
- **Final summary** - Overall process completion status

### Output Organization
- **Clear sections** - Each server gets its own section
- **Capability details** - Shows discovered tools, prompts, resources
- **Visual separation** - Empty lines between servers for readability

## Performance Characteristics

### Processing Time
- **Sequential execution** - Servers processed one after another
- **Full discovery** - Complete MCP handshake and capability discovery per server
- **Network dependent** - Speed depends on server response times
- **Proportional duration** - More servers = longer total time

### Resource Usage
- **Memory efficient** - Processes one server at a time
- **Network intensive** - Multiple server connections
- **CPU moderate** - JSON processing and database updates
- **Storage writes** - Database updates for each server

## Comparison with Individual Commands

| Aspect | `reconnect` | `reconnect-all` |
|--------|-------------|-----------------|
| **Scope** | Single server | All servers |
| **Progress** | Simple | Detailed progress tracking |
| **Error handling** | Immediate failure | Continue on individual failures |
| **Use case** | Specific server issues | System-wide refresh |
| **Output detail** | Moderate | Comprehensive |

## Error Scenarios and Recovery

### Partial Failures

When some servers fail to reconnect:

1. **Review failed servers** - Note which servers had issues
2. **Check server status** - Use `status <server>` to diagnose
3. **Fix individual issues** - Address specific server problems
4. **Retry individually** - Use `reconnect <server>` for failed servers

### Complete Failures

If no servers can be reconnected:

1. **Check network connectivity** - Verify basic network access
2. **Verify server processes** - Ensure servers are running
3. **Check configurations** - Use `config` to verify server settings
4. **Individual diagnosis** - Test servers one by one

### Recovery Strategies

```bash
# After reconnect-all with failures, identify and fix issues
vodou-core reconnect-all | tee reconnect-log.txt

# Extract failed servers
grep "❌ Failed" reconnect-log.txt

# Fix issues and retry individual servers
vodou-core reconnect failed-server-name

# Verify final state
vodou-core health-check
```

## Integration with Workflows

### Automated Maintenance

```bash
#!/bin/bash
# Weekly server maintenance script

echo "$(date): Starting weekly MCP server maintenance"

# Backup current state
vodou-core export-servers > "backup-$(date +%Y%m%d).json"

# Reconnect all servers to refresh capabilities
vodou-core reconnect-all

# Verify all servers healthy
if vodou-core health-check > /dev/null 2>&1; then
  echo "$(date): All servers healthy after maintenance"
else
  echo "$(date): Some servers failed health check"
  vodou-core health-check
fi
```

### Deployment Pipeline

```bash
# In deployment script
deploy_servers() {
  # ... server deployment steps ...
  
  echo "Reconnecting to all servers to discover new capabilities..."
  vodou-core reconnect-all
  
  echo "Verifying deployment success..."
  if vodou-core health-check > /dev/null 2>&1; then
    echo "✅ Deployment successful - all servers operational"
    return 0
  else
    echo "❌ Deployment issues detected"
    vodou-core health-check
    return 1
  fi
}
```

## Related Commands

- [`reconnect`](reconnect.md) - Reconnect individual server
- [`health-check`](health-check.md) - Verify servers after reconnection  
- [`status`](status.md) - Check individual server status
- [`export-servers`](export-servers.md) - Backup before bulk operations

## Best Practices

- **Backup first** - Export server configurations before bulk reconnection
- **Monitor output** - Watch for individual server failures during process
- **Verify results** - Use `health-check` after reconnect-all completes
- **Handle failures** - Address individual server issues before retrying
- **Schedule appropriately** - Run during maintenance windows for production
- **Log operations** - Keep records of bulk reconnection operations

---

**Next:** [Examples](../examples.md) - Real-world usage patterns and workflows