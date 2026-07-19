# config Command

Show configuration details and capability summary for a connected server.

## Syntax

```bash
vodou-core config <NAME>
```

## Parameters

- **`<NAME>`** - Name of the server to show configuration for

## Description

The `config` command displays comprehensive configuration information for a connected MCP server, including:

- **Command details** - The executable command used to start the server
- **Arguments** - Command-line arguments passed to the server
- **Capability summary** - Count of discovered tools, prompts, and resources
- **Connection info** - How Brain Trust 4 connects to this server

This information is useful for:
- **Troubleshooting** - Understanding how a server is configured
- **Documentation** - Recording server configurations
- **Debugging** - Verifying server setup matches expectations
- **Auditing** - Reviewing which servers are configured and how

## Examples

### Basic Configuration Display

```bash
vodou-core config mcp-monitor
```

**Output:**
```
📋 Configuration for mcp-monitor:
  Command: ./MCP-servers/mcp-monitor/bin/mcp-monitor
  Arguments: 
  Capabilities:
    🔧 Tools: 6
    📝 Prompts: 0
    📄 Resources: 0
```

### Server with Arguments

```bash
vodou-core config weather-api
```

**Output:**
```
📋 Configuration for weather-api:
  Command: python
  Arguments: -m weather.server --port 8080 --debug
  Capabilities:
    🔧 Tools: 12
    📝 Prompts: 3
    📄 Resources: 2
```

### Node.js Server Configuration

```bash  
vodou-core config mcpadvisor
```

**Output:**
```
📋 Configuration for mcpadvisor:
  Command: node
  Arguments: ./MCP-servers/mcpadvisor/build/index.js
  Capabilities:
    🔧 Tools: 2
    📝 Prompts: 0
    📄 Resources: 10
```

## Configuration Details

### Command Field
- **Executable path** - Full or relative path to server executable
- **Binary type** - Could be `node`, `python`, native binary, etc.
- **Path resolution** - Relative to Brain Trust 4 working directory

### Arguments Field  
- **Space-separated** - Arguments as they would appear on command line
- **Empty indication** - Shows empty line if no arguments
- **Special characters** - Properly handles quotes, spaces, etc.

### Capabilities Summary
- **Current counts** - Shows discovered capabilities from database
- **Static information** - Based on last connection/reconnection
- **Real-time accuracy** - May differ from server if capabilities changed

## Use Cases

### Troubleshooting Connection Issues

```bash
# Check how server is configured
vodou-core config problematic-server

# Verify command and arguments are correct
# Compare with expected configuration
```

### Documentation and Auditing

```bash
# Document all server configurations
for server in $(vodou-core list | grep -o '^\s*-\s*\w\+' | awk '{print $2}'); do
  echo "=== $server ==="
  vodou-core config $server
  echo
done
```

### Configuration Verification

```bash
# Check server configuration before modification
vodou-core config my-server

# Make changes with update-config...

# Verify changes took effect
vodou-core config my-server
```

### Development Workflow

```bash
# Verify development server setup
vodou-core config dev-server

# Check if configuration matches expected development setup
# Troubleshoot if capabilities don't match expectations
```

## Error Handling

### Server Not Found

```bash
vodou-core config nonexistent-server
```

**Output:**
```
❌ Server not found: nonexistent-server
Error: Server not found: nonexistent-server
```

### Database Issues

If database cannot be accessed or server data is corrupted, the command will show appropriate error messages.

## Information Accuracy

### Capability Counts
- **Database-based** - Shows counts from local database
- **Last discovery** - Reflects state from last connect/reconnect
- **May be stale** - Server capabilities might have changed

### Command Information
- **Always current** - Shows exactly how server will be started
- **Database stored** - Reflects configuration in Brain Trust 4 database
- **Modification tracking** - Shows current configuration, not historical

## Comparison with Related Commands

| Command | Information Shown | Data Source |
|---------|------------------|-------------|
| `config` | Configuration + capability counts | Database |
| `status` | Health + capability counts | Live server + database |
| `capabilities` | Detailed capabilities | Live server test |
| `list` | Name + command only | Database |

## Integration Examples

### Configuration Export

```bash
# Create readable configuration report
echo "# Server Configurations" > config-report.md
echo "Generated: $(date)" >> config-report.md
echo >> config-report.md

for server in $(vodou-core list | awk '{print $2}'); do
  echo "## $server" >> config-report.md
  echo '```' >> config-report.md
  vodou-core config $server >> config-report.md
  echo '```' >> config-report.md
  echo >> config-report.md
done
```

### Configuration Validation

```bash
#!/bin/bash
# Validate server configurations match requirements

declare -A expected_tools=(
  ["weather-api"]=5
  ["file-manager"]=8
  ["monitor"]=6
)

for server in "${!expected_tools[@]}"; do
  actual=$(vodou-core config $server | grep "🔧 Tools:" | awk '{print $3}')
  expected=${expected_tools[$server]}
  
  if [ "$actual" = "$expected" ]; then
    echo "✅ $server: $actual tools (expected $expected)"
  else
    echo "❌ $server: $actual tools (expected $expected)"
  fi
done
```

## Related Commands

- [`update-config`](update-config.md) - Modify server configuration
- [`status`](status.md) - Check server health and live capabilities
- [`list`](list.md) - See all configured servers
- [`capabilities`](capabilities.md) - Detailed capability analysis

## Best Practices

- **Verify before changes** - Check current config before updating
- **Document configurations** - Use config output in documentation
- **Compare environments** - Ensure consistent configuration across environments
- **Troubleshoot systematically** - Check config first when servers misbehave
- **Audit regularly** - Review configurations for compliance and security

---

**Next:** [`update-config`](update-config.md) - Update server configuration