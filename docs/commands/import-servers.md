# import-servers Command

Import server configurations from JSON format and connect to all servers.

## Syntax

```bash
vodou-core import-servers
```

## Parameters

None - reads JSON data from standard input (stdin).

## Description

The `import-servers` command reads server configurations in JSON format and connects to each server, discovering their capabilities. This command:

- **Reads from stdin** - Accepts JSON data via pipe or file redirection
- **Validates format** - Ensures JSON structure is correct
- **Connects to servers** - Establishes MCP connections for each server
- **Discovers capabilities** - Finds tools, prompts, and resources
- **Progress tracking** - Shows status for each server during import
- **Error resilience** - Continues processing even if some servers fail

The import process fully replicates servers on a new system or restores from backup.

## Examples

### Import from File

```bash
# Import servers from backup file
vodou-core import-servers < servers-backup.json
```

### Import via Pipe

```bash
# Import from command output
cat servers-config.json | vodou-core import-servers

# Import from curl/wget
curl -s https://example.com/servers.json | vodou-core import-servers
```

### Import with Progress

```bash
vodou-core import-servers < servers.json
```

**Sample Output:**
```
📥 Importing 3 servers...

  📥 Importing 1/3: chrome-devtools
🔌 Connecting to MCP server: chrome-devtools (node)
🤝 Initializing MCP protocol...  
🔍 Discovering capabilities...
✅ Connected! Discovered:
   🔧 Tools: 17
   📝 Prompts: 0
   📄 Resources: 0
    ✅ Imported: chrome-devtools

  📥 Importing 2/3: mcp-monitor
🔌 Connecting to MCP server: mcp-monitor (./MCP-servers/mcp-monitor/bin/mcp-monitor)
🤝 Initializing MCP protocol...
🔍 Discovering capabilities...
✅ Connected! Discovered:
   🔧 Tools: 6
   📝 Prompts: 0
   📄 Resources: 0
    ✅ Imported: mcp-monitor

  📥 Importing 3/3: mcpadvisor  
🔌 Connecting to MCP server: mcpadvisor (node)
🤝 Initializing MCP protocol...
🔍 Discovering capabilities...
✅ Connected! Discovered:
   🔧 Tools: 2
   📝 Prompts: 0
   📄 Resources: 10
    ✅ Imported: mcpadvisor

📥 Import process completed
```

## Input Format

The import command expects JSON in the same format as [`export-servers`](export-servers.md):

```json
[
  [
    "server-name",
    "command",
    "json-encoded-arguments"
  ]
]
```

### Example Input

```json
[
  [
    "weather-api", 
    "python",
    "[\"-m\", \"weather.server\", \"--port\", \"8080\"]"
  ],
  [
    "file-manager",
    "node", 
    "[\"./file-server.js\", \"--directory\", \"/data\"]"
  ]
]
```

## Error Handling

### Invalid JSON Format

```bash
echo "invalid json" | vodou-core import-servers
```

**Output:**
```
Error: expected value at line 1 column 1
```

### No Input Provided

```bash
echo "" | vodou-core import-servers
```

**Output:**
```
No input provided for import
```

### Server Connection Failures

```bash
# If some servers fail to connect
vodou-core import-servers < servers-with-issues.json
```

**Output:**
```
📥 Importing 3 servers...

  📥 Importing 1/3: working-server
    ✅ Imported: working-server

  📥 Importing 2/3: broken-server
    ❌ Failed to import broken-server: No such file or directory

  📥 Importing 3/3: another-server
    ✅ Imported: another-server

📥 Import process completed
```

## Use Cases

### System Deployment

```bash
# Deploy to new environment
scp servers-config.json target-server:
ssh target-server "vodou-core import-servers < servers-config.json"
```

### Disaster Recovery

```bash
# Restore from backup after system failure
vodou-core remove-all  # Clear any existing servers
vodou-core import-servers < latest-backup.json
vodou-core health-check  # Verify all servers working
```

### Development Environment Setup

```bash
# New developer setup
git clone project-repo
cd project-repo
vodou-core import-servers < config/dev-servers.json
vodou-core status  # Verify development environment ready
```

### Configuration Migration

```bash
# Migrate from old system to new system
# On old system:
vodou-core export-servers > migration-export.json

# Transfer file and import on new system:
vodou-core import-servers < migration-export.json
```

## Advanced Usage

### Selective Import with jq

```bash
# Import only Node.js servers
vodou-core export-servers | jq '.[] | select(.[1] == "node")' | vodou-core import-servers

# Import servers with specific naming pattern
vodou-core export-servers | jq '.[] | select(.[0] | test("^prod-"))' | vodou-core import-servers
```

### Batch Processing

```bash
# Import multiple configuration files
for config in configs/*.json; do
  echo "Importing $config..."
  vodou-core import-servers < "$config"
done
```

### Automated Deployment

```bash
#!/bin/bash
# deployment-script.sh

# Clear existing servers
vodou-core remove-all <<< "y"

# Import new configuration  
vodou-core import-servers < "$1"

# Verify deployment
if vodou-core health-check > /dev/null 2>&1; then
  echo "Deployment successful"
  exit 0
else
  echo "Deployment failed - some servers unhealthy"
  vodou-core status
  exit 1
fi
```

## Performance Notes

- **Sequential processing** - Servers are imported one at a time
- **Full capability discovery** - Each import includes complete MCP handshake
- **Progress feedback** - Real-time status updates during long imports
- **Memory efficient** - Streams JSON input rather than loading entirely

## Error Recovery

### Partial Import Failure

If some servers fail during import:

1. **Review errors** - Check which servers failed and why
2. **Fix issues** - Correct paths, permissions, or server configurations  
3. **Selective retry** - Extract failed servers and retry import
4. **Verify results** - Use `health-check` to confirm successful imports

### Format Validation

```bash
# Validate JSON before import
if jq empty < servers.json 2>/dev/null; then
  vodou-core import-servers < servers.json
else
  echo "Invalid JSON format in servers.json"
fi
```

## Related Commands

- [`export-servers`](export-servers.md) - Create JSON configurations for import
- [`remove-all`](remove-all.md) - Clear existing servers before import
- [`health-check`](health-check.md) - Verify imported servers are working
- [`list`](list.md) - View successfully imported servers

## Best Practices

- **Validate input** - Check JSON format before importing
- **Clear state** - Remove existing servers if doing full replacement
- **Monitor progress** - Watch import output for failures
- **Verify results** - Run health check after import
- **Handle failures** - Have procedures for addressing import errors
- **Backup first** - Export current configuration before importing new one

---

**Next:** [`config`](config.md) - View server configuration details