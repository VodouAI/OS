# sync-mappings

Auto-discover ID mappings for a server to enable natural language queries.

## Usage

```bash
./do sync-mappings <server-name> [--verbose]
vodou-core sync-mappings <server-name> [--verbose]
```

## Description

The `sync-mappings` command attempts to auto-discover name-to-ID mappings for a specific MCP server. This is an optional bootstrap command that can speed up initial setup, but is not required since the system automatically learns mappings from usage.

## Arguments

- `<server-name>` - Name of the MCP server to sync mappings for

## Options

- `--verbose` - Show detailed output including discovered mappings

## How It Works

1. **Checks** if the specified server exists in the database
2. **Attempts** to call common discovery tools on the server:
   - `list_workspaces`, `list_projects`, `list_channels`, `list_users`
   - `search_projects`, `search_channels`, `search_users`  
   - `get_workspaces`, `get_projects`, `get_channels`, `get_users`
   - `workspaces_list`, `projects_list`, `channels_list`, `users_list`
3. **Parses** responses from successful tool calls
4. **Extracts** name→ID mappings from the response data
5. **Stores** mappings in the `id_mappings` database table
6. **Reports** results and shows discovered mappings (if verbose)

## Examples

### Basic Usage
```bash
# Auto-discover mappings for Asana server
./do sync-mappings mcp-server-asana
```

Output:
```
🔍 Auto-discovering mappings for server: mcp-server-asana
   Trying tool: list_workspaces
✅ Auto-discovered 3 mappings via list_workspaces
✅ Discovered 3 mappings for mcp-server-asana
```

### Verbose Mode
```bash
# Show detailed output with discovered mappings
./do sync-mappings mcp-server-asana --verbose
```

Output:
```
🔍 Auto-discovering mappings for server: mcp-server-asana
   Trying tool: list_workspaces
✅ Auto-discovered 3 mappings via list_workspaces
✅ Discovered 3 mappings for mcp-server-asana

📋 Discovered mappings:
   workspaces::My Workspace → 1234567890123
   projects::Vodou → 1211709902166635
   projects::Brain Trust → 9876543210987
```

### No Mappings Found
```bash
./do sync-mappings my-custom-server
```

Output:
```
🔍 Auto-discovering mappings for server: my-custom-server
⚠️  No mappings discovered for my-custom-server
   The server may not have discovery tools, or mappings will be learned from usage.
```

## When to Use

### ✅ Good Use Cases
- **New server setup** - Bootstrap mappings for faster initial use
- **Server with many entities** - Discover all available projects, workspaces, etc. at once
- **Documentation/exploration** - See what entities are available on a server
- **Testing** - Verify that a server supports auto-discovery

### ⚠️ Not Required For
- **Normal usage** - The system automatically learns from regular interactions
- **Servers without list tools** - Many servers don't have discovery endpoints
- **Ongoing operation** - Auto-learning handles mapping updates automatically

## Error Handling

### Server Not Found
```bash
./do sync-mappings non-existent-server
```
Output:
```
❌ Auto-discovery failed: Server 'non-existent-server' not found
```

### Connection Failure
```bash
./do sync-mappings offline-server
```
Output:
```
❌ Auto-discovery failed: Connection failed: <error details>
```

### No Discovery Tools Available
This is not an error - many servers don't have discovery endpoints:
```
⚠️  No mappings discovered for custom-server
   The server may not have discovery tools, or mappings will be learned from usage.
```

## Technical Details

### Discovery Algorithm
1. Get list of available tools from database for the server
2. Check if any tools match common discovery patterns
3. For each matching tool:
   - Call tool with empty parameters `{}`
   - If successful, parse response for name/ID pairs
   - Store any discovered mappings
   - Return count of learned mappings
4. Stop after first successful discovery tool

### Parsed Entity Types
The system looks for these patterns in API responses:
- Objects with `gid`/`id` and `name` fields
- Automatic entity type detection based on:
  - JSON path context (e.g., `projects[0]` → "projects")
  - Object structure hints (e.g., contains "workspace" field → "workspaces")

### Database Storage
Discovered mappings are stored in the `id_mappings` table:
```sql
INSERT OR REPLACE INTO id_mappings 
(server_name, entity_type, name, mapped_id, updated_at) 
VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
```

## Integration with Natural Language

After running `sync-mappings`, you can immediately use natural language:

```bash
# Discover mappings first
./do sync-mappings mcp-server-asana

# Then use natural language immediately
./do "asana create task in Vodou project"
./do "asana list tasks in My Workspace"
./do "asana update task 123 set project Brain Trust"
```

Without `sync-mappings`, these would still work after the first successful API call that returns the entity data.

## Performance

- **Execution time**: Varies by server (usually 1-10 seconds)
- **Network calls**: One per discovery tool until successful
- **Database impact**: Minimal (uses INSERT OR REPLACE for upserts)
- **Memory usage**: Low (processes responses stream-wise)

## Related Commands

- [`brain`](brain.md) - Execute natural language queries (uses discovered mappings)
- [`tools`](tools.md) - List available tools on a server
- [`call`](call.md) - Call specific tools directly
- [`status`](status.md) - Check server connection status

## See Also

- [ID Mapping System](../../docs-DEV/id-mapping.md) (internal) — complete guide to ID mapping functionality
- [Database Schema](../../docs-DEV/database-schema.md) (internal) — database table structures
- [Natural Language Queries](../examples.md) - Example queries using discovered mappings