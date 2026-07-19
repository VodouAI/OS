# search

Find MCP servers by task description or keywords using intelligent discovery.

## Syntax

```bash
vodou-core search <query> [OPTIONS]
```

## Description

The `search` command uses intelligent server discovery to find MCP servers based on task descriptions or keywords. It searches both the built-in server registry and external registries when available, providing ranked results based on relevance.

## Arguments

- `<query>` - Task description or search terms (e.g., "file operations", "database queries", "web search")

## Options

- `--keywords <KEYWORDS>` - Additional keywords to refine search (comma-separated)
- `--limit <LIMIT>` - Maximum number of results to show (default: 10)

## Examples

### Basic Task Search
```bash
# Find servers for file operations
vodou-core search "file operations"

# Find database-related servers
vodou-core search "database queries"

# Find web search servers
vodou-core search "web search"
```

### Keyword Refinement
```bash
# Search for file servers with specific keywords
vodou-core search "file management" --keywords "filesystem,storage,files"

# Search for database servers with SQL keywords
vodou-core search "database" --keywords "postgres,sql,queries"

# Search for API servers
vodou-core search "external api" --keywords "http,rest,api"
```

### Limited Results
```bash
# Show only top 3 results
vodou-core search "monitoring" --limit 3

# Show top 5 file-related servers
vodou-core search "files" --limit 5 --keywords "read,write,manage"
```

## Example Output

```bash
$ vodou-core search "file operations"
🔍 Searching for servers: file operations
✅ Found 2 servers (showing top 2):

1. 📦 filesystem
   📝 File system operations and file management
   🏷️  Tags: filesystem, files, storage, read, write
   ⭐ Rating: 4.8/5.0
   📊 Downloads: 50000
   🔧 Install: NPM: @modelcontextprotocol/server-filesystem
   💡 Use: vodou-core install filesystem

2. 📦 file-manager
   📝 Advanced file management with search and organization
   🏷️  Tags: files, search, organization, metadata
   ⭐ Rating: 4.2/5.0  
   📊 Downloads: 15000
   🔧 Install: Git: https://github.com/example/file-manager-mcp
   💡 Use: vodou-core install file-manager
```

## Search Sources

The search command queries multiple sources:

1. **Built-in Registry** - Pre-configured common MCP servers
2. **External Registries** - getmcp.io, mcphub.io when available
3. **Cached Results** - Previous search results (24-hour TTL)

## Search Algorithm

Results are ranked by:
- **Keyword Matching** - Exact and partial matches in name/description
- **Tag Relevance** - Matching server tags and categories
- **Popularity Score** - Download count and usage statistics
- **Rating Score** - Community ratings and reviews
- **Recency** - Recently updated or published servers

## Installation Integration

After finding servers, use the [`install`](install.md) command:

```bash
# Search and install in sequence
vodou-core search "filesystem"
vodou-core install filesystem

# Search with custom name
vodou-core search "postgres database"
vodou-core install postgres --as-name db-server
```

## Offline Mode

When external registries are unavailable:
- Falls back to built-in registry
- Uses cached results from previous searches
- Displays warning about limited results

## Performance

- **Search Speed**: ~1-2 seconds for external registry queries
- **Caching**: 24-hour cache for external results
- **Fallback**: Instant response from built-in registry

## Related Commands

- [`install`](install.md) - Install discovered servers
- [`registry`](registry.md) - View all registered servers
- [`list`](list.md) - List currently connected servers

## Troubleshooting

### No Results Found
```bash
$ vodou-core search "nonexistent-service"
🔍 Searching for servers: nonexistent-service
⚠️  No servers found for query: 'nonexistent-service'
💡 Try broader search terms or check spelling
💡 Available categories: filesystem, database, web, monitoring, api
```

### External Registry Unavailable
```bash
$ vodou-core search "database"
🔍 Searching for servers: database
⚠️  External registries unavailable, using local cache
✅ Found 1 servers from cache (showing top 1):
[...results from cache...]
```

### Network Timeout
```bash
$ vodou-core search "api servers"
🔍 Searching for servers: api servers  
⚠️  Network timeout, falling back to built-in registry
✅ Found 0 servers from built-in registry
💡 Check internet connection and try again
```

## See Also

- [Server Discovery Guide](../../docs-DEV/server-discovery.md) (internal)
- [Installation Guide](install.md)
- [Registry Management](registry.md)