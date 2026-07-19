# export-servers Command

Export all server configurations to JSON format for backup and portability.

## Syntax

```bash
vodou-core export-servers
```

## Parameters

None - exports all connected servers automatically.

## Description

The `export-servers` command creates a JSON representation of all connected MCP server configurations. This includes:

- **Server names** - All configured server identifiers
- **Commands** - Executable commands for each server
- **Arguments** - Command-line arguments for each server
- **Portable format** - JSON that can be imported on other systems

The output is designed for:
- **Backup and recovery** - Save server configurations
- **Environment replication** - Move configurations between systems
- **Version control** - Track configuration changes over time
- **Deployment automation** - Scripted server setup

## Examples

### Export to File

```bash
# Export all servers to backup file
vodou-core export-servers > servers-backup.json
```

### View Current Configuration

```bash
# See current server configurations
vodou-core export-servers
```

**Sample Output:**
```json
[
  [
    "chrome-devtools",
    "npx",
    "[\"-y\", \"chrome-devtools-mcp@latest\"]"
  ],
  [
    "mcp-monitor", 
    "./MCP-servers/mcp-monitor/bin/mcp-monitor",
    "[]"
  ],
  [
    "mcpadvisor",
    "node",
    "[\"./MCP-servers/mcpadvisor/build/index.js\"]"
  ]
]
```

### Export with Timestamp

```bash
# Create timestamped backup
vodou-core export-servers > "servers-backup-$(date +%Y%m%d-%H%M%S).json"
```

## Output Format

The export format is a JSON array where each server is represented as:

```json
[
  "server-name",
  "command", 
  "json-encoded-arguments-array"
]
```

### Format Details

- **Array structure** - Top-level array contains all servers
- **Server tuple** - Each server is a 3-element array
- **Name field** - Server identifier (string)
- **Command field** - Executable command (string)  
- **Arguments field** - JSON-encoded array of arguments (string)

### Example Breakdown

```json
[
  "weather-server",           // Server name
  "python",                   // Command to run
  "[\"-m\", \"weather.server\"]"  // Arguments as JSON string
]
```

## Use Cases

### Backup and Recovery

```bash
# Create backup before major changes
vodou-core export-servers > pre-update-backup.json

# Make changes...

# Restore if needed
vodou-core import-servers < pre-update-backup.json
```

### Environment Replication

```bash
# Export from development environment
vodou-core export-servers > dev-servers.json

# Copy file to production system
scp dev-servers.json prod-server:/tmp/

# Import on production
ssh prod-server "vodou-core import-servers < /tmp/dev-servers.json"
```

### Configuration Management

```bash
# Version control server configurations
vodou-core export-servers > config/servers.json
git add config/servers.json
git commit -m "Update server configurations"

# Deploy to multiple environments
for env in staging prod; do
  scp config/servers.json $env:/tmp/
  ssh $env "vodou-core import-servers < /tmp/servers.json"
done
```

### Migration and Deployment

```bash
# Create deployment package
mkdir vodou-core-deploy
vodou-core export-servers > vodou-core-deploy/servers.json
cp -r MCP-servers vodou-core-deploy/
tar -czf vodou-core-deploy.tar.gz vodou-core-deploy/

# Deploy package
scp vodou-core-deploy.tar.gz target-server:
ssh target-server "tar -xzf vodou-core-deploy.tar.gz"
ssh target-server "cd vodou-core-deploy && vodou-core import-servers < servers.json"
```

## Integration with Tools

### Shell Scripts

```bash
#!/bin/bash
# Backup script
BACKUP_DIR="/backups/vodou-core"
mkdir -p "$BACKUP_DIR"
vodou-core export-servers > "$BACKUP_DIR/servers-$(date +%Y%m%d).json"
echo "Backup created: $BACKUP_DIR/servers-$(date +%Y%m%d).json"
```

### JSON Processing

```bash
# Extract server names using jq
vodou-core export-servers | jq -r '.[][0]'

# Filter specific server types
vodou-core export-servers | jq '.[] | select(.[1] == "node")'

# Count servers by command type
vodou-core export-servers | jq 'group_by(.[1]) | .[] | {command: .[0][1], count: length}'
```

## Error Handling

### No Servers Connected

```bash
vodou-core export-servers
```

**Output:**
```
No servers to export
```

### Empty Configuration

If no servers are connected, the command outputs a message rather than empty JSON, making it clear that the empty state is intentional rather than an error.

## Security Considerations

- **Path information** - Exported configurations contain full paths that may expose system structure
- **No credentials** - Export does not include any authentication information
- **File permissions** - Backup files should have appropriate read permissions
- **Audit trail** - Consider logging export operations for security auditing

## Related Commands

- [`import-servers`](import-servers.md) - Import server configurations from JSON
- [`list`](list.md) - View current server list before export
- [`remove-all`](remove-all.md) - Clear all servers before importing new configuration

## Best Practices

- **Regular backups** - Export configurations before major changes
- **Descriptive filenames** - Use timestamps and environment names in backup files
- **Version control** - Track configuration changes in git repositories
- **Test imports** - Verify exported configurations work correctly when imported
- **Secure storage** - Store backup files in secure, accessible locations

---

**Next:** [`import-servers`](import-servers.md) - Import server configurations from JSON