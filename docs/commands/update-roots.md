# update-roots - Manage Allowed Directories

Add or remove allowed directories (filesystem roots) for a specific server.

## Syntax

```bash
vodou-core update-roots <server-name> [OPTIONS]
```

## Description

The `update-roots` command provides fine-grained control over filesystem permissions by allowing you to add or remove allowed directories for filesystem servers without reconnecting.

This command enables:
- **Dynamic permission management** - Modify filesystem access without server restart
- **Security adjustments** - Grant or revoke access to specific directories
- **Project onboarding** - Add new project directories as needed
- **Access cleanup** - Remove no-longer-needed directory permissions

## Arguments

- `<server-name>` - Name of the server to update roots for

## Options

| Option | Description | Example |
|--------|-------------|---------|
| `--add <dir>...` | Add one or more directories to allowed list | `--add /tmp /home/user/new-project` |
| `--remove <dir>...` | Remove one or more directories from allowed list | `--remove /tmp /old-project` |
| `--clear` | Remove all allowed directories (same as clear-roots) | `--clear` |

## Examples

### Adding Directories

#### Add Single Directory
```bash
# Add a new project directory
vodou-core update-roots dev-fs --add /home/user/new-project

# Add system temp directory
vodou-core update-roots fs-server --add /tmp
```

#### Add Multiple Directories
```bash
# Add multiple project directories at once
vodou-core update-roots project-fs --add /home/user/project-a /home/user/project-b /home/user/shared

# Add common development directories
vodou-core update-roots dev-server --add ~/Downloads ~/Documents/work ~/tmp
```

### Removing Directories

#### Remove Single Directory
```bash
# Remove access to completed project
vodou-core update-roots dev-fs --remove /home/user/old-project

# Remove temporary access
vodou-core update-roots fs-server --remove /tmp
```

#### Remove Multiple Directories
```bash
# Clean up multiple old project directories
vodou-core update-roots project-fs --remove /home/user/project-a /home/user/project-b

# Remove development directories for production deployment
vodou-core update-roots prod-fs --remove ~/Downloads ~/tmp ~/test-data
```

### Combined Operations
```bash
# Add new directory and remove old one in single command
vodou-core update-roots project-fs \
  --add /home/user/current-project \
  --remove /home/user/old-project

# Restructure permissions for new development workflow
vodou-core update-roots dev-fs \
  --add /home/user/workspace/active /home/user/workspace/staging \
  --remove /home/user/old-workspace /tmp/old-builds
```

### Clear All Directories
```bash
# Remove all filesystem permissions (same as clear-roots command)
vodou-core update-roots fs-server --clear

# Equivalent to:
vodou-core clear-roots fs-server
```

## Example Output

### Adding Directories
```bash
$ vodou-core update-roots dev-fs --add /home/user/new-project
📁 Updating roots for server 'dev-fs'...

✅ Added directories:
  📂 file:///home/user/new-project
     Name: /home/user/new-project

📊 Server 'dev-fs' now has 3 allowed directories
💡 Use 'vodou-core roots dev-fs' to see all directories
```

### Removing Directories
```bash
$ vodou-core update-roots dev-fs --remove /tmp
📁 Updating roots for server 'dev-fs'...

✅ Removed directories:
  📂 file:///tmp
     Name: /tmp

📊 Server 'dev-fs' now has 2 allowed directories
```

### Combined Operations
```bash
$ vodou-core update-roots project-fs --add /home/user/active --remove /home/user/archive
📁 Updating roots for server 'project-fs'...

✅ Added directories:
  📂 file:///home/user/active
     Name: /home/user/active

✅ Removed directories:
  📂 file:///home/user/archive
     Name: /home/user/archive

📊 Server 'project-fs' now has 4 allowed directories
```

### Clearing All Directories
```bash
$ vodou-core update-roots fs-server --clear
📁 Updating roots for server 'fs-server'...

✅ Cleared all allowed directories

⚠️  Server 'fs-server' now has no filesystem access
💡 Add directories with: vodou-core update-roots fs-server --add <directory>
```

## Error Handling

### Directory Validation Errors
```bash
$ vodou-core update-roots dev-fs --add /nonexistent/path
❌ Error: Directory '/nonexistent/path' does not exist or is not accessible
💡 Create the directory first or check path spelling
💡 Use absolute paths only (no relative paths like ./dir)
```

### Server Not Found
```bash
$ vodou-core update-roots nonexistent-server --add /tmp
❌ Error: Server 'nonexistent-server' not found
💡 Use 'vodou-core list' to see available servers
```

### Permission Denied
```bash
$ vodou-core update-roots fs-server --add /root/private
❌ Error: Directory '/root/private' exists but is not accessible
💡 Check file system permissions
💡 Run as appropriate user or choose accessible directory
```

### Duplicate Directory
```bash
$ vodou-core update-roots dev-fs --add /tmp
⚠️  Directory '/tmp' is already in the allowed list
📊 No changes made - server still has 3 allowed directories
```

### Remove Non-Existent Directory
```bash
$ vodou-core update-roots dev-fs --remove /not/in/list
⚠️  Directory '/not/in/list' was not in the allowed list
📊 No changes made - server still has 3 allowed directories
```

## Security Considerations

### Path Validation
- **Absolute Paths Only** - Relative paths are rejected for security
- **Directory Resolution** - Symbolic links are resolved to actual paths  
- **Existence Check** - Directories must exist and be accessible
- **Permission Verification** - User must have read access to directory

### Security Best Practices
```bash
# ✅ Good: Specific project directories
vodou-core update-roots dev-fs --add /home/user/projects/current

# ❌ Bad: Root filesystem access
vodou-core update-roots dev-fs --add /

# ✅ Good: Application data directory
vodou-core update-roots app-fs --add /app/data

# ❌ Bad: System configuration access
vodou-core update-roots app-fs --add /etc
```

### Principle of Least Privilege
- **Minimal Access** - Grant only necessary directory permissions
- **Regular Cleanup** - Remove access to completed/archived projects
- **Environment Separation** - Different permissions for dev/staging/production
- **Audit Trail** - Changes are logged for security review

## Development Workflows

### New Project Onboarding
```bash
# 1. Create project directory
mkdir -p /home/user/projects/new-app

# 2. Grant filesystem server access
vodou-core update-roots dev-fs --add /home/user/projects/new-app

# 3. Verify access
vodou-core roots dev-fs

# 4. Test file operations
vodou-core call-tool list_directory --args '{"path":"/home/user/projects/new-app"}'
```

### Project Completion Cleanup
```bash
# 1. Archive project data
mv /home/user/projects/completed-app /home/user/archive/

# 2. Remove filesystem access
vodou-core update-roots dev-fs --remove /home/user/projects/completed-app

# 3. Verify cleanup
vodou-core roots dev-fs
```

### Environment Promotion
```bash
# Moving from development to production

# 1. Remove development directories
vodou-core update-roots prod-fs \
  --remove ~/tmp ~/Downloads ~/test-data

# 2. Add production directories only
vodou-core update-roots prod-fs \
  --add /app/data /var/log/app

# 3. Verify production restrictions
vodou-core roots prod-fs
```

## Integration Examples

### CI/CD Pipeline Integration
```bash
#!/bin/bash
# deploy.sh - Update filesystem permissions during deployment

# Add new release directory
vodou-core update-roots app-fs --add /app/releases/v2.1.0

# Remove old release directory  
vodou-core update-roots app-fs --remove /app/releases/v2.0.0

# Verify current permissions
vodou-core roots app-fs
```

### Development Environment Setup
```bash
#!/bin/bash  
# setup-dev-env.sh - Configure development filesystem access

# Add standard development directories
vodou-core update-roots dev-fs --add \
  ~/projects/current \
  ~/projects/libraries \
  ~/tmp/builds \
  ~/Documents/specs

echo "Development environment configured"
vodou-core roots dev-fs
```

## Related Commands

- [`roots`](roots.md) - View current allowed directories
- [`clear-roots`](clear-roots.md) - Remove all allowed directories (equivalent to --clear)
- [`connect`](connect.md) - Set initial allowed directories with `--allowed-dirs`
- [`call-tool`](call-tool.md) - Use filesystem tools with updated permissions

## See Also

- [Filesystem Security Guide](../security.md#filesystem-permissions) - Security best practices
- [Connect Command](connect.md#filesystem-servers-enhanced-configuration) - Initial setup
- [Troubleshooting](../troubleshooting.md#filesystem-permissions) - Permission issues