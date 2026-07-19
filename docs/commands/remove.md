# remove Command

Remove a connected MCP server and clean up all associated data from the database.

## Syntax

```bash
vodou-core remove <NAME>
```

## Parameters

- **`<NAME>`** - Name of the server to remove (must match exactly)

## Description

The `remove` command safely removes a connected MCP server from Brain Trust 4. This includes:

- Removing the server entry from the database
- Cleaning up all associated tools, prompts, and resources
- Providing clear feedback about the operation

## Examples

### Basic Usage

```bash
# Remove a specific server
vodou-core remove old-server
```

### Common Scenarios

```bash
# Remove a test server
vodou-core remove test-mcp

# Remove a server that's no longer needed
vodou-core remove deprecated-service

# Remove a misconfigured server
vodou-core remove broken-server
```

## Output

### Successful Removal
```
✅ Removed server: old-server
```

### Server Not Found
```
❌ Server not found: nonexistent-server
Error: Server 'nonexistent-server' does not exist
```

## Error Handling

- **Server doesn't exist**: Shows clear error message and exits with error code
- **Database cleanup**: Automatically removes all related entries (foreign key constraints)
- **Confirmation**: Operation completes immediately without confirmation (use `remove-all` for bulk removal with confirmation)

## Related Commands

- [`remove-all`](remove-all.md) - Remove all servers with confirmation prompt
- [`list`](list.md) - See all connected servers before removal
- [`status`](status.md) - Check server status before removal

## Safety Notes

- **Permanent operation**: Removed servers must be re-added with `connect`
- **Data loss**: All discovered capabilities are removed from database
- **No confirmation**: Single server removal happens immediately

---

**Next:** [`status`](status.md) - Check server health and status