# update-config Command

Update a server's configuration and rediscover its capabilities.

## Syntax

```bash
vodou-core update-config <NAME> <COMMAND> [ARGS]...
```

## Parameters

- **`<NAME>`** - Name of the server to update (must exist)
- **`<COMMAND>`** - New command to execute the server
- **`[ARGS]...`** - New command-line arguments for the server

## Description

The `update-config` command modifies an existing server's configuration and rediscovers its capabilities. This process:

1. **Validates** server exists in database
2. **Updates** server configuration with new command and arguments
3. **Connects** to server with new configuration
4. **Rediscovers** all capabilities (tools, prompts, resources)
5. **Updates** database with new capability information

This is useful when:
- Server location or command changes
- Server arguments need modification  
- Server has been updated and path changed
- Development vs production server differences

## Examples

### Update Server Command

```bash
# Change from development to production server
vodou-core update-config weather-api python -m weather.production_server
```

**Output:**
```
🔧 Updating configuration for server: weather-api
  New command: python
  New arguments: -m weather.production_server
🔌 Connecting to MCP server: weather-api (python)
🤝 Initializing MCP protocol...
🔍 Discovering capabilities...
✅ Connected! Discovered:
   🔧 Tools: 15
   📝 Prompts: 4
   📄 Resources: 3

✅ Updated configuration and rediscovered capabilities for: weather-api
```

### Update Server Path

```bash
# Update server path after moving binary
vodou-core update-config monitor /usr/local/bin/monitor-server --verbose
```

### Update Node.js Server

```bash
# Switch to different JavaScript server file
vodou-core update-config file-manager node ./new-file-server.js --port 3000
```

### Update Arguments Only

```bash
# Same command, different arguments
vodou-core update-config api-server python -m api.server --production --port 8443
```

## Configuration Changes

### Command Updates
- **Executable change** - Switch between different programs (node → python)
- **Path updates** - New location of same executable
- **Version changes** - Different version of same program

### Argument Updates  
- **Environment flags** - Add --production, --debug, --development
- **Port changes** - Modify listening ports
- **Configuration files** - Point to different config files
- **Feature flags** - Enable/disable server features

## Use Cases

### Environment Promotion

```bash
# Promote from development to staging configuration
vodou-core update-config api-server python -m api.staging_server --config staging.json

# Later promote to production
vodou-core update-config api-server python -m api.production_server --config prod.json
```

### Server Migration

```bash
# Before migration - check current config
vodou-core config old-server

# Update to new server location
vodou-core update-config old-server ./new-location/server-binary --new-args

# Verify migration worked
vodou-core status old-server
```

### Development Workflow

```bash
# Switch between development versions
vodou-core update-config dev-api node ./dev-server.js --debug --hot-reload

# Switch to testing version
vodou-core update-config dev-api node ./test-server.js --test-mode

# Back to development
vodou-core update-config dev-api node ./dev-server.js --debug
```

### Configuration Standardization

```bash
# Standardize server configurations across environment
servers=("api-1" "api-2" "api-3")
for server in "${servers[@]}"; do
  vodou-core update-config $server python -m api.server --config standard.json
done
```

## Validation and Safety

### Pre-Update Validation
- **Server existence** - Confirms server exists before updating
- **Clear feedback** - Shows exactly what will be changed
- **Capability rediscovery** - Verifies new configuration works

### Error Handling
- **Server not found** - Clear error if server doesn't exist
- **Connection failure** - Reports if new configuration doesn't work
- **Partial success** - Handles cases where update succeeds but discovery fails

## Error Scenarios

### Server Not Found

```bash
vodou-core update-config nonexistent-server python server.py
```

**Output:**
```
❌ Server not found: nonexistent-server
Error: Server not found: nonexistent-server
```

### Invalid New Configuration

```bash
vodou-core update-config my-server /nonexistent/path/server
```

**Output:**
```
🔧 Updating configuration for server: my-server
  New command: /nonexistent/path/server
  New arguments: 
❌ Failed to connect to server: my-server
Error: Connection failed: No such file or directory
```

### Capability Discovery Issues

If server starts but capability discovery fails, the configuration is still updated, but warnings are shown about incomplete capability information.

## Comparison with Related Commands

| Command | Purpose | When to Use |
|---------|---------|-------------|
| `update-config` | Change configuration + rediscover | Server location/args changed |
| `reconnect` | Rediscover with same config | Server updated, same location |
| `connect` | Add new server | Initial server setup |
| `remove` + `connect` | Complete replacement | Major server changes |

## Best Practices

### Pre-Update Checks

```bash
# Before updating, document current state
vodou-core config my-server > before-update.txt

# Update configuration
vodou-core update-config my-server new-command new-args

# Verify update was successful
vodou-core config my-server > after-update.txt
vodou-core status my-server
```

### Backup and Recovery

```bash
# Export configuration before major updates
vodou-core export-servers > backup-before-config-update.json

# Update server configurations
vodou-core update-config server1 new-command
vodou-core update-config server2 new-command

# Verify all updates successful
vodou-core health-check

# If issues, restore from backup
# vodou-core import-servers < backup-before-config-update.json
```

### Gradual Updates

```bash
# Update servers one at a time, verify each
servers=("server1" "server2" "server3")
for server in "${servers[@]}"; do
  echo "Updating $server..."
  vodou-core update-config $server python -m new.server
  
  if vodou-core status $server > /dev/null 2>&1; then
    echo "✅ $server updated successfully"
  else
    echo "❌ $server update failed"
    break
  fi
done
```

## Related Commands

- [`config`](config.md) - View current server configuration
- [`reconnect`](reconnect.md) - Rediscover capabilities with same configuration
- [`status`](status.md) - Verify server health after configuration update
- [`export-servers`](export-servers.md) - Backup configurations before updates

## Recovery Procedures

If `update-config` breaks a server:

1. **Check error messages** - Understand what went wrong
2. **Verify paths** - Ensure new command/arguments are correct
3. **Test manually** - Try running the command outside Brain Trust 4
4. **Restore from backup** - Use previous export if available
5. **Remove and re-add** - Last resort: remove server and connect with correct config

---

**Next:** [Examples](../examples.md) - Real-world usage patterns and workflows