# roots - View Allowed Directories

Show allowed directories (filesystem roots) for a specific server.

## Syntax

```bash
vodou-core roots <server-name>
```

## Description

The `roots` command displays all allowed directories configured for a filesystem server. These directories define which paths the server is permitted to access during file operations.

This command is essential for:
- **Security verification** - Confirm filesystem servers can only access intended directories
- **Configuration review** - Check directory permissions before file operations
- **Troubleshooting** - Verify filesystem access issues aren't due to missing permissions

## Arguments

- `<server-name>` - Name of the server to show roots for

## Examples

### View Filesystem Roots
```bash
# Show roots for development filesystem server
vodou-core roots dev-fs

# Show roots for production filesystem server  
vodou-core roots prod-fs

# Check filesystem permissions for specific server
vodou-core roots project-filesystem
```

## Example Output

### Server with Multiple Roots
```bash
$ vodou-core roots dev-fs
📁 Allowed directories for server 'dev-fs':
  📂 file:///Users/you/projects
     Name: /Users/you/projects
  
  📂 file:///Users/you/documents  
     Name: /Users/you/documents
  
  📂 file:///tmp
     Name: /tmp

📊 Summary: 3 allowed directories configured
```

### Server with Single Root
```bash
$ vodou-core roots prod-fs
📁 Allowed directories for server 'prod-fs':
  📂 file:///app/data
     Name: /app/data

📊 Summary: 1 allowed directory configured
```

### Server with No Roots Configured
```bash
$ vodou-core roots basic-server
📁 Allowed directories for server 'basic-server':
  (No directories configured)

⚠️  This server has no filesystem access permissions.
💡 Add directories with: vodou-core update-roots basic-server --add <directory>
```

### Non-Filesystem Server
```bash
$ vodou-core roots weather-api
📁 Allowed directories for server 'weather-api':
  (Not applicable - server does not use filesystem roots)

💡 This server doesn't require filesystem access permissions.
```

## Error Handling

### Server Not Found
```bash
$ vodou-core roots nonexistent-server
❌ Error: Server 'nonexistent-server' not found
💡 Use 'vodou-core list' to see available servers
```

### Database Connection Error
```bash
$ vodou-core roots my-server
❌ Error: Unable to access server configuration database
💡 Check database file permissions and try again
```

## Security Notes

### Directory Validation
- **Absolute Paths** - All roots are stored as absolute filesystem paths
- **URI Format** - Displayed in `file://` URI format for MCP compatibility
- **Path Resolution** - Symbolic links are resolved to actual paths
- **Security Boundaries** - Servers cannot access paths outside configured roots

### Permission Model
- **Default Deny** - Servers have no filesystem access by default
- **Explicit Allow** - Only explicitly configured directories are accessible
- **No Traversal** - Path traversal attacks (../) are prevented
- **Per-Server Isolation** - Each server has independent filesystem permissions

## Use Cases

### Development Workflow
```bash
# 1. Check current permissions
vodou-core roots dev-server

# 2. Verify project directory is accessible
# Should show: /Users/you/projects

# 3. Test file operation
vodou-core call-tool read_file --args '{"path":"/Users/you/projects/README.md"}'
```

### Security Audit
```bash
# Review all filesystem server permissions
for server in $(vodou-core list | grep -E "(filesystem|fs)" | awk '{print $2}'); do
  echo "=== $server ==="
  vodou-core roots $server
  echo
done
```

### Production Verification
```bash
# Verify production servers have minimal permissions
vodou-core roots prod-api-server
vodou-core roots prod-file-server

# Should only show necessary directories like:
# - /app/data
# - /var/log/app
# Not sensitive paths like /etc, /home, /root
```

## Integration with Other Commands

### Related Workflow
```bash
# 1. Connect server with directories
vodou-core connect fs-server npx @modelcontextprotocol/server-filesystem \
  --allowed-dirs /tmp /home/user/projects

# 2. Verify configuration
vodou-core roots fs-server

# 3. Test file operations
vodou-core call-tool list_directory --args '{"path":"/tmp"}'

# 4. Update permissions if needed
vodou-core update-roots fs-server --add /home/user/downloads
```

## Output Format Details

### URI Display
- **Format**: `file:///absolute/path`
- **Purpose**: MCP protocol compatibility
- **Security**: Prevents relative path confusion

### Directory Information
- **URI**: Full filesystem URI as sent to server
- **Name**: Human-readable directory path
- **Validation**: All paths validated during display

## Related Commands

- [`connect`](connect.md) - Set initial allowed directories with `--allowed-dirs`
- [`update-roots`](update-roots.md) - Add or remove allowed directories
- [`clear-roots`](clear-roots.md) - Remove all allowed directories
- [`list`](list.md) - View all servers (identify filesystem servers)
- [`call-tool`](call-tool.md) - Use filesystem tools with configured permissions

## See Also

- [Filesystem Security Guide](../security.md#filesystem-permissions) - Security best practices
- [Connect Command](connect.md#filesystem-servers-enhanced-configuration) - Initial setup
- [Troubleshooting](../troubleshooting.md#filesystem-permissions) - Permission issues