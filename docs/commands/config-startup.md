# config-startup

Configure server startup arguments using the Universal MCP Startup Configuration system.

## Usage

```bash
vodou-core config-startup <server-name> --set <key>=<value>
```

## Description

The `config-startup` command allows you to configure startup arguments for any MCP server using Brain Trust 4's Universal MCP Startup Configuration system. These arguments are stored in the database and automatically injected when the server connects.

## Features

- **Universal Design**: Works with all MCP servers without code changes
- **Database-Driven**: Configuration stored in existing database structure
- **Automatic Injection**: Startup arguments injected dynamically on connection
- **KISS Approach**: Simple and fast configuration management

## Arguments

- `<server-name>`: Name of the MCP server to configure
- `--set <key>=<value>`: Set a startup configuration key-value pair

## Examples

### Configure Filesystem Server

```bash
# Set allowed directories for filesystem server
vodou-core config-startup filesystem --set allowed-directories=/Users/you/Projects

# Multiple configuration options
vodou-core config-startup filesystem --set allowed-directories=/Users/you/Projects --set max-file-size=10MB
```

### Configure Custom Server

```bash
# Configure any MCP server with startup arguments
vodou-core config-startup my-custom-server --set api-key=secret --set debug=true
```

## How It Works

1. **Store Configuration**: Startup arguments are stored in the `mcp_servers.metadata` table
2. **Automatic Injection**: When a server connects, Brain Trust 4 automatically injects the stored arguments
3. **Special Handling**: Filesystem servers also use the `server_roots` table for directory configuration
4. **No Restarts Needed**: Configuration takes effect on next server connection

## Database Storage

Configuration is stored in two ways:

### Generic Configuration (metadata)
```json
{
  "startup_config": {
    "allowed-directories": "/Users/you/Projects",
    "max-file-size": "10MB"
  }
}
```

### Filesystem-Specific (server_roots)
For filesystem servers, allowed directories are also stored in the `server_roots` table for compatibility.

## Supported Servers

The Universal MCP Startup Configuration system works with **any MCP server** including:

- **Filesystem servers**: `@modelcontextprotocol/server-filesystem`
- **Memory servers**: `@modelcontextprotocol/server-memory`
- **Custom servers**: Any server that accepts CLI arguments
- **Third-party servers**: All MCP-compliant servers

## Related Commands

- [`connect`](connect.md) - Connect to MCP servers (uses startup configuration)
- [`reconnect`](reconnect.md) - Reconnect servers (applies new configuration)
- [`list`](list.md) - List configured servers
- [`remove`](remove.md) - Remove server configuration

## Example Workflow

```bash
# 1. Configure filesystem server
vodou-core config-startup filesystem --set allowed-directories=/Users/you/Projects

# 2. Connect or reconnect the server
vodou-core reconnect filesystem

# 3. Test file reading with new configuration
vodou-core call filesystem read_multiple_files '{"paths": ["/Users/you/Projects/README.md"]}'
```

## Notes

- Configuration is persistent and survives server restarts
- Multiple `--set` flags can be used in a single command
- Configuration takes effect on next server connection
- For filesystem servers, paths are automatically stripped of `file://` prefixes
- The system is designed for maximum compatibility with existing MCP servers