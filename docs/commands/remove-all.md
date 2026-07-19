# remove-all Command

Remove all connected servers with safety confirmation prompt.

## Syntax

```bash
vodou-core remove-all
```

## Parameters

None - operates on all connected servers.

## Description

The `remove-all` command safely removes all connected MCP servers from Brain Trust 4. This is a **destructive operation** with built-in safety features:

- **Confirmation prompt** - Requires explicit user confirmation
- **Progress tracking** - Shows removal progress for each server
- **Complete cleanup** - Removes all database entries (servers, tools, prompts, resources)
- **Error resilience** - Continues even if individual removals fail
- **Clear feedback** - Reports success/failure for each server

This command is useful for:
- **Environment reset** - Clean slate before importing new configuration
- **System maintenance** - Remove all servers during major updates
- **Development cleanup** - Clear test servers from development environment

## Examples

### Basic Usage with Confirmation

```bash
vodou-core remove-all
```

**Interactive Output:**
```
⚠️  This will remove ALL 3 servers. Continue? (y/N)
```

**User types 'y' and presses Enter:**
```
🗑️  Removing 3 servers...
  ✅ Removed: chrome-devtools (1/3)
  ✅ Removed: mcp-monitor (2/3)
  ✅ Removed: mcpadvisor (3/3)
✅ All servers removed successfully
```

### Cancellation

```bash
vodou-core remove-all
```

**Interactive Output:**
```
⚠️  This will remove ALL 3 servers. Continue? (y/N)
```

**User presses Enter (default N) or types 'n':**
```
Operation cancelled
```

### No Servers to Remove

```bash
vodou-core remove-all
```

**Output:**
```
No servers to remove
```

## Confirmation Behavior

### Accepted Confirmations
- `y` - Proceed with removal
- `Y` - Proceed with removal

### Rejected Confirmations  
- `n` - Cancel operation
- `N` - Cancel operation
- **Empty/Enter** - Cancel operation (default)
- Any other input - Cancel operation

### Case Sensitivity
The confirmation is **case-insensitive**:
- `y`, `Y`, `yes`, `YES` all work
- Everything else cancels the operation

## Safety Features

### Confirmation Prompt
- **Clear warning** - Shows exact number of servers to be removed
- **Default to safe** - Pressing Enter cancels (doesn't remove)
- **Explicit confirmation** - Must type 'y' to proceed
- **No bypassing** - No command-line flag to skip confirmation

### Progress Tracking
- **Server count** - Shows current/total progress (1/3, 2/3, etc.)
- **Individual status** - Success/failure for each server
- **Error continuation** - Doesn't stop on individual failures
- **Final summary** - Reports overall operation status

## Use Cases

### Environment Reset

```bash
# Clear all servers before importing new configuration
vodou-core remove-all
# User confirms with 'y'
vodou-core import-servers < new-config.json
```

### Development Cleanup

```bash
# Clear test servers from development environment
vodou-core list  # See what servers exist
vodou-core remove-all  # Remove them all
# User confirms removal
```

### System Maintenance

```bash
# Before major Brain Trust 4 update
vodou-core export-servers > backup-before-update.json
vodou-core remove-all
# User confirms
# Perform Brain Trust 4 update
vodou-core import-servers < backup-before-update.json
```

### Migration Preparation

```bash
# Prepare system for configuration migration
vodou-core export-servers > pre-migration-backup.json
vodou-core remove-all  # Clear current servers
# User confirms
# Import new configuration from different source
```

## Scripting and Automation

### Non-Interactive Use

For scripted usage, pipe the confirmation:

```bash
# Automatic confirmation (use with caution!)
echo "y" | vodou-core remove-all

# Or use here-document
vodou-core remove-all <<< "y"
```

**⚠️ Warning:** Automated confirmation bypasses the safety prompt. Use only in controlled environments.

### Conditional Removal

```bash
#!/bin/bash
# Script that removes servers only if user explicitly agrees

echo "This will remove all MCP servers from Brain Trust 4"
echo "Current servers:"
vodou-core list

echo ""
read -p "Are you sure you want to remove ALL servers? (type 'yes' to confirm): " confirm

if [ "$confirm" = "yes" ]; then
  vodou-core remove-all <<< "y"
  echo "All servers removed"
else
  echo "Operation cancelled - servers preserved"
fi
```

## Error Handling

### Individual Server Failures

If some servers cannot be removed:

```bash
vodou-core remove-all
```

**Sample Output:**
```
⚠️  This will remove ALL 3 servers. Continue? (y/N)
y
🗑️  Removing 3 servers...
  ✅ Removed: server1 (1/3)
  ❌ Failed to remove server2: Database error
  ✅ Removed: server3 (3/3)
⚠️  Some servers could not be removed
```

The operation continues and reports both successes and failures.

### Database Issues

If database errors occur, the command:
- **Reports specific errors** - Shows what went wrong
- **Continues processing** - Attempts to remove remaining servers  
- **Returns error code** - Script-friendly failure indication

## Comparison with `remove`

| Aspect | `remove` | `remove-all` |
|--------|----------|--------------|
| **Scope** | Single server | All servers |
| **Confirmation** | None | Required |
| **Progress** | Immediate | Progress tracking |
| **Use case** | Remove specific server | Environment reset |
| **Safety** | Low risk | High risk |

## Recovery

If you accidentally remove all servers:

1. **Check for backups** - Look for recent export files
2. **Restore from backup** - Use `import-servers` with backup file
3. **Recreate manually** - Use `connect` to re-add servers individually
4. **Verify restoration** - Use `health-check` to confirm all servers working

## Related Commands

- [`remove`](remove.md) - Remove a single specific server
- [`export-servers`](export-servers.md) - Create backup before removal
- [`import-servers`](import-servers.md) - Restore servers after removal
- [`list`](list.md) - See what servers exist before removal

## Best Practices

- **Export first** - Always backup with `export-servers` before removing all
- **Double-check** - Use `list` to see exactly what will be removed
- **Controlled environment** - Prefer using in development rather than production
- **Script carefully** - If automating, include multiple safety checks
- **Verify restoration** - After importing backup, confirm all servers work

---

**Next:** [`reconnect-all`](reconnect-all.md) - Reconnect all servers with progress tracking