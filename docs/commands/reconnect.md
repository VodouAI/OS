# reconnect Command

Reconnect to an MCP server and rediscover all its capabilities.

## Syntax

```bash
vodou-core reconnect <NAME>
```

## Parameters

- **`<NAME>`** - Name of the server to reconnect (must exist in database)

## Description

The `reconnect` command re-establishes connection to an MCP server and refreshes all stored capability information. This is useful when:

- Server has been updated with new capabilities
- Connection was lost or became stale  
- Database entries are out of sync with server
- Server configuration changed but command/args stayed the same

The reconnect process:
1. **Retrieves** stored server configuration (command and arguments)
2. **Connects** to the server using stored configuration
3. **Rediscovers** all capabilities (tools, prompts, resources)
4. **Updates** database with latest information
5. **Reports** discovered capabilities

## Examples

### Basic Reconnection

```bash
# Reconnect to a server
vodou-core reconnect my-server
```

**Output:**
```
🔄 Reconnecting to server: my-server
🔌 Connecting to MCP server: my-server (node ./server.js)
🤝 Initializing MCP protocol...
🔍 Discovering capabilities...
✅ Connected! Discovered:
   🔧 Tools: 5
   📝 Prompts: 2
   📄 Resources: 1

🔧 Tools:
  - get_status: Check server status
  - process_data: Process input data
  - get_config: Get configuration
  - set_config: Update configuration  
  - health_check: Server health check

✅ Reconnected and updated: my-server
```

### Common Use Cases

```bash
# After server software update
vodou-core reconnect weather-mcp

# When server seems out of sync
vodou-core reconnect analyzer

# After fixing server configuration
vodou-core reconnect monitoring-server
```

## When to Use Reconnect

### Server Updates
```bash
# Server maintainer released new version with additional tools
vodou-core reconnect updated-server

# Verify new capabilities are discovered
vodou-core tools updated-server
```

### Connection Issues  
```bash
# Server was temporarily unavailable
vodou-core status problematic-server  # Shows offline
vodou-core reconnect problematic-server  # Re-establish connection
```

### Database Sync Issues
```bash
# Database may be stale compared to server
vodou-core capabilities server-name  # Shows old info
vodou-core reconnect server-name      # Refresh from server
vodou-core capabilities server-name   # Shows updated info
```

## Error Handling

### Server Not Found
```bash
vodou-core reconnect nonexistent-server
```
```
❌ Server not found: nonexistent-server
Error: Server not found: nonexistent-server
```

### Connection Failure
```bash
vodou-core reconnect broken-server
```
```
🔄 Reconnecting to server: broken-server
❌ Failed to connect to server: broken-server
Error: Connection failed: No such file or directory
```

### Partial Success
If connection succeeds but capability discovery fails partially, reconnect continues and reports what was successfully discovered.

## Reconnect vs Connect

| Aspect | `connect` | `reconnect` |
|--------|-----------|-------------|
| **Purpose** | Add new server | Refresh existing server |
| **Requirements** | Command and args needed | Uses stored configuration |
| **Database** | Creates new entry | Updates existing entry |
| **Use case** | Initial setup | Maintenance and refresh |

## Workflow Integration

### Development Cycle
```bash
# 1. Initial connection
vodou-core connect dev-server node ./dev-server.js

# 2. Work with server...

# 3. Server updated with new features
vodou-core reconnect dev-server

# 4. Use new capabilities
vodou-core tools dev-server
```

### Troubleshooting
```bash
# 1. Identify issue
vodou-core status server-name

# 2. Attempt reconnection  
vodou-core reconnect server-name

# 3. Verify resolution
vodou-core status server-name
```

### Maintenance
```bash
# Regular refresh of all servers
vodou-core reconnect-all

# Or selective refresh
vodou-core reconnect frequently-updated-server
```

## Performance Notes

- **Full rediscovery**: Completely refreshes capability information
- **Network dependent**: Requires server to be accessible
- **Database updates**: May involve significant database writes
- **Atomic operation**: Either succeeds completely or fails cleanly

## Related Commands

- [`reconnect-all`](reconnect-all.md) - Reconnect all servers with progress tracking
- [`connect`](connect.md) - Initial server connection and setup
- [`status`](status.md) - Check server health before reconnecting
- [`update-config`](update-config.md) - Change server configuration and reconnect

## Best Practices

- **Check status first** - Use `status` to confirm server is accessible
- **Reconnect after updates** - Always reconnect when server software changes
- **Monitor output** - Review discovered capabilities to confirm expected changes
- **Use reconnect-all sparingly** - Individual reconnection is more targeted

---

**Next:** [`reconnect-all`](reconnect-all.md) - Bulk reconnection with progress tracking