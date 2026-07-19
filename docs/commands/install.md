# install

Auto-install MCP servers from external registries with validation and rollback.

## Syntax

```bash
vodou-core install <name> [OPTIONS]
```

## Description

The `install` command automatically installs MCP servers from external registries using multiple installation methods (NPM, Git, Binary). It includes comprehensive validation, dependency checking, and automatic rollback on failure.

## Arguments

- `<name>` - Server name to install from registry

## Options

- `--as-name <NAME>` - Custom name for the installed server (default: auto-generated from repository name for GitHub URLs)
- `--force` - Force reinstall if server already exists

## Installation Methods

### NPM Package Installation
```bash
# Install from NPM registry
vodou-core install filesystem
vodou-core install postgres --as-name database
```

### Git Repository Installation  
```bash
# Install from Git repository (auto-detected)
vodou-core install github-mcp
vodou-core install custom-server --force

# Install from GitHub URL (auto-generates name from repository)
vodou-core install https://github.com/owner/repo
# Server will be named "repo" (not the full URL)

# Install from GitHub URL with custom name
vodou-core install https://github.com/owner/repo --as-name my-custom-name
```

### Binary Download Installation
```bash
# Install binary servers (auto-detected)
vodou-core install monitor-binary
vodou-core install native-tools --as-name tools
```

## Examples

### Basic Installation
```bash
# Install filesystem server from NPM
vodou-core install filesystem

# Install with custom name
vodou-core install brave-search --as-name web-search

# Force reinstall existing server
vodou-core install postgres --force
```

### Installation Workflow
```bash
# 1. Search for servers
vodou-core search "database operations"

# 2. Install discovered server
vodou-core install postgres

# 3. Verify installation
vodou-core list

# 4. Test capabilities
vodou-core tools postgres
```

## Installation Process

### 1. Pre-Installation Validation
```bash
🔍 Searching for server: filesystem
📦 Found: filesystem - File system operations and file management
🔧 Installation method: NPM: @modelcontextprotocol/server-filesystem

🧪 Validating dependencies...
✅ npm found (8.19.2)
✅ Node.js found (18.17.0)
✅ Internet connectivity verified
✅ Disk space available (1.2GB free)
✅ Write permissions verified
```

### 2. Installation Execution
```bash
📦 Installing MCP server: filesystem
📦 Installing npm package: @modelcontextprotocol/server-filesystem
[npm install output...]
✅ Installation completed successfully
```

### 3. Post-Installation Validation
```bash
🧪 Testing server startup...
✅ Server starts successfully
🧪 Testing MCP handshake...
✅ MCP protocol handshake successful
🧪 Testing basic capabilities...
✅ Basic capabilities discovered
```

### 4. Capability Discovery
```bash
🔍 Discovering capabilities...
📊 Discovered capabilities:
  🔧 Tools: 12 available
  📝 Prompts: 0 available  
  📄 Resources: 3 available

🎉 Successfully installed and configured: filesystem
💡 Use 'vodou-core tools filesystem' to see available tools
```

## Dependency Validation

### NPM Servers
- **Node.js** - Required for NPM package installation
- **npm** - Package manager for installing packages
- **Internet** - Network connectivity for package download

### Git Servers  
- **Git** - Version control system for repository cloning
- **Build Tools** - Language-specific build tools (npm, cargo, etc.)
- **Internet** - Network connectivity for repository access

### Binary Servers
- **Download Tools** - curl or wget for binary download
- **Permissions** - Execute permissions for binary files
- **Internet** - Network connectivity for binary download

## Error Handling & Rollback

### Installation Failure
```bash
$ vodou-core install broken-server
🔍 Searching for server: broken-server
📦 Found: broken-server - Example broken server
🔧 Installation method: NPM: broken-mcp-server

🧪 Validating dependencies...
✅ Dependencies validated

📦 Installing MCP server: broken-server
❌ Installation failed: npm install returned error code 1
🔄 Rolling back installation...
🧹 Cleaning up ./MCP-servers/broken-server directory
🗄️  Removing server from database
✅ Rollback completed successfully

❌ Installation failed for: broken-server
💡 Check the error above and try again
💡 Use --force to retry installation
```

### Dependency Missing
```bash
$ vodou-core install node-server
🧪 Validating dependencies...
❌ npm not available. Install Node.js to use npm-based MCP servers.
   Download from: https://nodejs.org/
   Or use package manager:
   Ubuntu/Debian: sudo apt install nodejs npm
   macOS: brew install node
   Windows: Download from nodejs.org

❌ Pre-installation validation failed
```

### Permission Issues
```bash
$ vodou-core install filesystem
🧪 Validating dependencies...
❌ Cannot create MCP servers directory: Permission denied
   Check file permissions in current directory
   
💡 Try running with appropriate permissions:
   sudo vodou-core install filesystem
   # OR create directory first:
   mkdir -p ./MCP-servers && vodou-core install filesystem
```

## Installation Validation

### Startup Testing
- **Command Execution** - Tests if server command runs
- **Process Spawn** - Verifies process can be spawned
- **Basic Response** - Checks for any response from server

### MCP Protocol Testing  
- **Handshake** - Tests MCP protocol initialization
- **Method Support** - Verifies supported MCP methods
- **Capability Discovery** - Tests basic capability discovery

### Configuration Validation
- **Database Registration** - Verifies server stored in database
- **Path Resolution** - Checks installation paths are correct
- **Metadata Storage** - Validates server metadata

## Server Types

### Auto-Detected Installation
The system automatically detects installation method based on server metadata:

```bash
📦 filesystem
   🔧 Install: NPM: @modelcontextprotocol/server-filesystem
   → Detected: NPM package installation

📦 github-tools  
   🔧 Install: Git: https://github.com/example/mcp-github
   → Detected: Git repository installation
   
📦 monitor-native
   🔧 Install: Binary: https://releases.com/monitor.tar.gz
   → Detected: Binary download installation
```

## Installation Paths

```bash
# Installation directory structure
./MCP-servers/
├── filesystem/                 # NPM-based server
│   └── node_modules/
├── github-tools/              # Git-based server  
│   ├── src/
│   └── package.json
└── monitor-native/            # Binary server
    └── monitor-binary
```

## Performance

- **NPM Installation**: 10-30 seconds (depending on package size)
- **Git Installation**: 5-60 seconds (depending on repository size)  
- **Binary Installation**: 2-10 seconds (depending on binary size)
- **Validation**: 2-5 seconds per server
- **Rollback**: 1-3 seconds for cleanup

## Related Commands

- [`search`](search.md) - Find servers to install
- [`list`](list.md) - View installed servers
- [`remove`](remove.md) - Remove installed servers
- [`registry`](registry.md) - View server registry with installation types

## Troubleshooting

### Common Issues

**Server Not Found**
```bash
$ vodou-core install nonexistent-server
🔍 Searching for server: nonexistent-server
❌ Server 'nonexistent-server' not found in any registry
💡 Use 'vodou-core search' to find available servers
💡 Check server name spelling
```

**Already Exists**
```bash
$ vodou-core install filesystem
❌ Server 'filesystem' already exists
💡 Use --force to reinstall
💡 Use --as-name to install with different name
💡 Use 'vodou-core remove filesystem' to remove first
```

**Network Issues**
```bash
$ vodou-core install filesystem
🔍 Searching for server: filesystem
❌ Network error: Failed to connect to registry
💡 Check internet connection
💡 Try again later
💡 Use cached results if available
```

## See Also

- [Server Discovery Guide](../../docs-DEV/server-discovery.md) (internal)
- [Search Command](search.md)
- [Registry Management](registry.md)
- [Troubleshooting Guide](../troubleshooting.md)