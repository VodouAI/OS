# clear-roots - Remove All Allowed Directories

Remove all allowed directories (filesystem roots) for a specific server.

## Syntax

```bash
vodou-core clear-roots <server-name>
```

## Description

The `clear-roots` command removes all filesystem permissions for a server, effectively disabling all file system access. This is a destructive operation that requires confirmation.

This command is useful for:
- **Security lockdown** - Completely remove filesystem access
- **Server decommission** - Clean up permissions before server removal
- **Permission reset** - Start fresh with filesystem permissions
- **Emergency access revocation** - Quickly disable all file access

## Arguments

- `<server-name>` - Name of the server to clear all roots for

## Examples

### Clear All Roots
```bash
# Remove all filesystem permissions from development server
vodou-core clear-roots dev-fs

# Disable filesystem access for production server
vodou-core clear-roots prod-filesystem

# Reset permissions for project server
vodou-core clear-roots project-server
```

## Example Output

### Successful Clear Operation
```bash
$ vodou-core clear-roots dev-fs
⚠️  This will remove ALL filesystem permissions for server 'dev-fs'
📊 Current permissions: 4 allowed directories

🔍 Directories that will be removed:
  📂 file:///home/user/projects
  📂 file:///home/user/documents  
  📂 file:///tmp
  📂 file:///home/user/workspace

❓ Are you sure you want to clear all roots for 'dev-fs'? (y/N): y

✅ Cleared all allowed directories for server 'dev-fs'
⚠️  Server 'dev-fs' now has no filesystem access

💡 Add directories with: vodou-core update-roots dev-fs --add <directory>
```

### User Cancellation
```bash
$ vodou-core clear-roots important-server
⚠️  This will remove ALL filesystem permissions for server 'important-server'
📊 Current permissions: 6 allowed directories

❓ Are you sure you want to clear all roots for 'important-server'? (y/N): n

❌ Operation cancelled - no changes made
📊 Server 'important-server' still has 6 allowed directories
```

### Server with No Roots
```bash
$ vodou-core clear-roots empty-server
📁 Server 'empty-server' has no filesystem roots configured
📊 No changes needed - server already has no filesystem access
```

## Safety Features

### Confirmation Prompt
- **Interactive confirmation** required before clearing roots
- **Directory listing** shown before confirmation
- **Count display** of directories that will be removed
- **Cancellation support** with 'n' or just Enter

### Non-Destructive Preview
```bash
# Preview what will be cleared without making changes
vodou-core roots server-name  # Shows current directories

# Then decide whether to clear
vodou-core clear-roots server-name
```

### Batch Operations Prevention
- **No --force flag** - Interactive confirmation always required
- **Single server only** - Cannot clear multiple servers at once
- **Explicit server name** - Must specify exact server name

## Error Handling

### Server Not Found
```bash
$ vodou-core clear-roots nonexistent-server
❌ Error: Server 'nonexistent-server' not found
💡 Use 'vodou-core list' to see available servers
💡 Check server name spelling
```

### Database Access Error
```bash
$ vodou-core clear-roots my-server
❌ Error: Unable to access server configuration database
💡 Check database file permissions and try again
💡 Ensure no other instances of vodou-core are running
```

### Non-Filesystem Server
```bash
$ vodou-core clear-roots weather-api
📁 Server 'weather-api' is not a filesystem server
💡 This server doesn't use filesystem roots
💡 No action needed - server doesn't have filesystem access
```

## Use Cases

### Security Incident Response
```bash
# Emergency: Disable all filesystem access immediately
vodou-core clear-roots compromised-server

# Verify access removed
vodou-core roots compromised-server

# Should show: (No directories configured)
```

### Development Environment Reset
```bash
# Clean slate for development server
vodou-core clear-roots dev-fs

# Add only necessary directories for new project
vodou-core update-roots dev-fs --add /home/user/current-project
```

### Server Decommission
```bash
# Prepare server for removal
vodou-core clear-roots old-filesystem-server

# Remove server entirely
vodou-core remove old-filesystem-server
```

### Permission Audit Cleanup
```bash
# After security audit, remove excessive permissions
vodou-core clear-roots over-privileged-server

# Add back only necessary directories
vodou-core update-roots over-privileged-server --add /app/data
```

## Workflow Integration

### Safe Permission Updates
```bash
# Safe way to completely change filesystem permissions

# 1. Review current permissions
vodou-core roots server-name

# 2. Clear all permissions
vodou-core clear-roots server-name

# 3. Add new permissions from scratch
vodou-core update-roots server-name --add /new/required/path
```

### Environment Migration
```bash
# Moving server from development to production

# 1. Clear development permissions
vodou-core clear-roots app-server

# 2. Add production permissions only
vodou-core update-roots app-server --add /app/data /var/log/app

# 3. Verify clean configuration
vodou-core roots app-server
```

### Regular Security Maintenance
```bash
#!/bin/bash
# quarterly-security-audit.sh

echo "=== Quarterly Filesystem Permission Audit ==="

# Review all filesystem servers
for server in $(vodou-core list | grep -E "(filesystem|fs)" | awk '{print $2}'); do
    echo "=== $server ==="
    echo "Current permissions:"
    vodou-core roots $server
    echo
    
    # Prompt for cleanup if needed
    read -p "Clear permissions for $server? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        vodou-core clear-roots $server
    fi
done
```

## Comparison with Similar Commands

### clear-roots vs update-roots --clear
Both commands achieve the same result:
```bash
# These are equivalent:
vodou-core clear-roots server-name
vodou-core update-roots server-name --clear

# clear-roots is more explicit for complete removal
# update-roots --clear is part of a more general update command
```

### clear-roots vs remove
Different scope of operation:
```bash
# clear-roots: Remove filesystem permissions only
vodou-core clear-roots server-name  # Server remains connected

# remove: Remove entire server
vodou-core remove server-name  # Server completely removed
```

## Recovery After Clear

### Restore Access
```bash
# After accidentally clearing roots, restore access:

# 1. Check what was cleared (will show empty)
vodou-core roots server-name

# 2. Add back required directories
vodou-core update-roots server-name --add /required/directory

# 3. Test filesystem access
vodou-core call-tool list_directory --args '{"path":"/required/directory"}'
```

### Re-connect with Original Configuration
```bash
# If you have the original connect command, re-run it:
vodou-core connect server-name npx @modelcontextprotocol/server-filesystem \
  --allowed-dirs /original/path1 /original/path2
```

## Related Commands

- [`roots`](roots.md) - View current allowed directories before clearing
- [`update-roots`](update-roots.md) - Add directories back after clearing
- [`connect`](connect.md) - Re-establish server with filesystem permissions
- [`remove`](remove.md) - Remove entire server (more destructive than clear-roots)

## See Also

- [Security Best Practices](../security.md#filesystem-permissions) - Safe filesystem management
- [Troubleshooting](../troubleshooting.md#filesystem-permissions) - Recovery procedures
- [Database Schema](../../docs-DEV/database-schema.md#server-roots) (internal) — how roots are stored