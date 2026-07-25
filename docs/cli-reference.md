# Vodou CLI Reference

Complete command-line reference for Vodou - an MCP orchestration platform with system integration and AI agent workflow capabilities.

## Overview

Vodou provides multiple commands organized into categories, offering MCP server orchestration with Universal MCP Architecture, Docker Gateway Integration, AI Agent Conversation Recording, connection pooling, intelligent server discovery, parallel MCP execution, natural language intent management, ID mapping for natural language queries, and approval management.

### Universal Vodou Command Interface

The **Universal Vodou Command Router** provides a single interface for all Vodou operations:

```bash
# Universal Interface - Commands through single entry point
./do <COMMAND> [OPTIONS] [ARGS]

# Examples:
./do list                      # CLI command
./do "check system status"     # Intent query  
./do --verbose cpu             # Verbose mode
./do "cpu memory disk"         # Parallel execution
```

**Key Benefits:**
- **Single command interface** - Just remember `./do`
- **CLI commands** work directly
- **Natural language queries** supported
- **Parallel execution** built-in
- **Verbose mode** for both command types

### Legacy CLI Access (Optional)

```bash
# Direct access still available (not recommended for new usage)
vodou-core <COMMAND> [OPTIONS] [ARGS]
```

## Command Overview

| Command | Purpose | Status |
|---------|---------|--------|
| **🔍 Server Discovery & Installation (4)** | | |
| [`search`](#search) | Find servers by task description or keywords | 🆕 **New!** |
| [`install`](#install) | Auto-install servers from registries or GitHub | 🆕 **New!** |
| [`sync-docker`](#sync-docker) | Sync Docker Desktop MCP servers with BT4 database | 🆕 **New!** |
| [`sync-mappings`](#sync-mappings) | Auto-discover ID mappings for natural language queries | 🆕 **New!** |
| **🎯 Universal Tool Routing (6)** | | |
| [`call-tool`](commands/call-tool.md) | Call tool by name with automatic server routing | 🆕 **New!** |
| [`find-tool`](commands/find-tool.md) | Find which servers provide specific tools | 🆕 **New!** |
| [`all-tools`](commands/all-tools.md) | List all tools across all connected servers | 🆕 **New!** |
| [`list-tools-db`](#list-tools-db) | List all tools from database (fast, no MCP connections) | 🆕 **New!** |
| [`tool-schema`](commands/tool-schema.md) | Show input schema for a specific tool | 🆕 **New!** |
| [`routing-stats`](#routing-stats) | Show tool routing statistics and metrics | 🆕 **New!** |
| **🚀 Parallel MCP Execution (2)** | | |
| [`parallel`](#parallel) | Execute multiple tools in parallel based on intent | 🆕 **New!** |
| [`parallel-custom`](#parallel-custom) | Execute specific tools in parallel with manual specification | 🆕 **New!** |
| **🔗 Chaining MCP Servers (1)** | | |
| [`Chaining MCP Servers`](#chaining-mcp-servers) | Extract data from one server and use it with another | 🆕 **New!** |
| **🧠 Brain Trust Frontend Foundation (1)** | | |
| [`brain`](#brain) | Execute brain command with frontend foundation | 🆕 **New!** |
| **🎯 Natural Language Intent Management (3)** | | |
| [`show me all intent mappings`](#intent-discovery) | Discover all available intent mappings | 🆕 **New!** |
| [`add intent mapping: keyword → server::tool priority X`](#intent-add) | Add new intent mapping through natural language | 🆕 **New!** |
| [`remove intent mapping: keyword`](#intent-remove) | Remove intent mapping through natural language | 🆕 **New!** |
| **📝 Work Logging (1)** | | |
| [`log:`](#log) | Log completed work with enhanced categorization | 🆕 **New!** |
| **💬 AI Agent Conversation Recording (8)** | | |
| [`conversation list`](#conversation-list) | List recorded conversation sessions | 🆕 **New!** |
| [`conversation show`](#conversation-show) | Show detailed conversation information | 🆕 **New!** |
| [`conversation analytics`](#conversation-analytics) | Display comprehensive conversation analytics | 🆕 **New!** |
| [`conversation bottlenecks`](#conversation-bottlenecks) | Identify performance bottlenecks | 🆕 **New!** |
| [`conversation export`](#conversation-export) | Export conversation data to JSON/CSV | 🆕 **New!** |
| [`conversation cleanup`](#conversation-cleanup) | Clean up old conversation data | 🆕 **New!** |
| [`conversation metrics`](#conversation-metrics) | Display detailed performance metrics | 🆕 **New!** |
| [`conversation context`](#conversation-context) | Show context analysis and insights | 🆕 **New!** |
| [`conversation insights`](#conversation-insights) | Performance insights from context analysis | 🆕 **New!** |
| [`conversation session-metrics`](#conversation-session-metrics) | Detailed metrics for specific sessions | 🆕 **New!** |
| **🏥 Real-time Health Monitoring (5)** | | |
| [`start-monitoring`](#start-monitoring) | Start background health monitoring service | 🆕 **New!** |
| [`stop-monitoring`](#stop-monitoring) | Stop background health monitoring | 🆕 **New!** |
| [`health-check-detailed`](#health-check-detailed) | Comprehensive health check with metrics | 🆕 **New!** |
| [`health-dashboard`](commands/health-dashboard.md) | Real-time health dashboard with recommendations | 🆕 **New!** |
| [`health-stats`](#health-stats) | Health statistics and performance metrics | 🆕 **New!** |
| **📋 Enhanced Registry Management (1)** | | |
| [`registry`](commands/registry.md) | Comprehensive server registry with filtering | 🆕 **New!** |
| **📁 Filesystem Roots Management (3)** | | |
| [`roots`](commands/roots.md) | View allowed directories for filesystem servers | 🆕 **New!** |
| [`update-roots`](commands/update-roots.md) | Add or remove allowed directories | 🆕 **New!** |
| [`clear-roots`](commands/clear-roots.md) | Remove all allowed directories | 🆕 **New!** |
| **🔐 User Approval System (6)** | | |
| [`approvals`](commands/approvals.md) | View approval history and pending requests | 🆕 **New!** |
| [`approval-policy`](commands/approval-policy.md) | Configure approval policies | 🆕 **New!** |
| [`auto-approve`](commands/auto-approve.md) | Set up auto-approval rules | 🆕 **New!** |
| [`progress`](commands/progress.md) | Monitor operation progress | 🆕 **New!** |
| [`cancel`](commands/cancel.md) | Cancel running operations | 🆕 **New!** |
| [`clear-progress`](commands/clear-progress.md) | Clean up completed progress entries | 🆕 **New!** |
| **Core Operations (9)** | | |
| [`connect`](#connect) | Universal MCP connection (STDIO + HTTP + Remote) | ✅ Enhanced |
| [`list`](#list) | List servers with connection pooling | ✅ Enhanced |
| [`remove`](#remove) | Remove server with cleanup | ✅ Enhanced |
| [`remove-all`](#remove-all) | Remove all servers with confirmation | ✅ Enhanced |
| [`version`](#version) | Show current version information | 🆕 **New!** |
| [`update`](#update) | Check for updates and install if available | 🆕 **New!** |
| [`help`](#help) | Show help for commands | ✅ |
| [`enable`](#enable) | Enable a disabled MCP server | 🆕 **New!** |
| [`disable`](#disable) | Disable an MCP server without removing it | 🆕 **New!** |
| **🔐 Remote Server Authentication (1)** | | |
| [`credentials`](#credentials) | Manage authentication credentials for remote servers | 🆕 **New!** |
| **🧠 Memory System (1)** | | |
| [`mem`](#mem) | Memory system commands (flush, setup, promote, archive, config) | 🆕 **New!** |
| **🆔 Continuity (4 subcommands)** | | |
| [`continuity init`](#continuity) | Seed self-principal from `VODOU_USER_EMAIL` / `VODOU_USER_NAME` and backfill `principal_id` columns | 🆕 **v0.5.74** |
| [`continuity list-principals`](#continuity) | List principals in `vodou-core.db` (self + assistant + future multi-principal rows) | 🆕 **v0.5.74** |
| [`continuity update-self`](#continuity) | Update the self-principal's `display_name` / `email` (`--name`, `--email`) | 🆕 **v0.5.74** |
| [`continuity reassign`](#continuity) | Soft-merge two principals (sets `merged_into`); recoverable within the unmerge window | 🆕 **v0.5.74** |
| [`runtime-status`](#runtime-status) | JSON kernel health; includes `components.continuity` with SLO + resolver cache metrics (v0.5.74+) | ✅ Enhanced |
| **📋 Context (1)** | | |
| [`context`](#context) | Return context for IDE hooks (workspace bootstrap + prompt-targeted memories) | 🆕 **New!** |
| **🔌 Daemon & Socket (2)** | | |
| [`daemon`](#daemon) | Memory daemon (file watcher, re-index, scheduler) | 🆕 **New!** |
| [`sock`](#sock) | Socket relay — send commands to daemon via Unix socket | 🆕 **New!** |
| **⏰ Scheduler (1)** | | |
| [`schedule`](#schedule) | Manage scheduled tasks (cron, intervals, one-shot) | 🆕 **New!** |
| **🪝 Hooks (1)** | | |
| [`hook`](#hook) | Manage lifecycle hooks (PreToolUse, PostToolUse, etc.) | 🆕 **New!** |
| **Health & Status (2)** | | |
| [`status`](#status) | Server status with performance metrics | ✅ Enhanced |
| [`health-check`](#health-check) | Quick health check with enhanced metrics | ✅ Enhanced |
| **Server Management (4)** | | |
| [`reconnect`](#reconnect) | Reconnect with connection pooling | ✅ Enhanced |
| [`reconnect-all`](#reconnect-all) | Bulk reconnection with progress tracking | ✅ Enhanced |
| [`config`](#config) | Enhanced server configuration details | ✅ Enhanced |
| [`update-config`](#update-config) | Update configuration with validation | ✅ Enhanced |
| **Configuration & Integration (2)** | | |
| [`config-startup`](#config-startup) | Configure server startup arguments with Universal MCP Configuration | 🆕 **New!** |
| **Capability Discovery (5)** | | |
| [`capabilities`](#capabilities) | Server capabilities with connection pooling | ✅ Enhanced |
| [`tools`](#tools) | Tools discovery with caching (25-50x faster) | ✅ Enhanced |
| [`prompts`](#prompts) | Prompts discovery with pooling | ✅ Enhanced |
| [`resources`](#resources) | Resources discovery with optimization | ✅ Enhanced |
| [`call`](#call) | **Intelligent tool calling** with auto-parameter generation | 🧠 **Enhanced!** |
| **Backup & Restore (2)** | | |
| [`export-servers`](#export-servers) | Export with enhanced metadata | ✅ Enhanced |
| [`import-servers`](#import-servers) | Import with validation | ✅ Enhanced |
| **📝 Work Logging (1)** | | |
| [`log`](#log) | Log work directly via CLI | 🆕 **New!** |
| **🤖 Self-Improvement (2)** | | |
| [`self-improve-run`](#self-improve-run) | Run headless self-improve (scheduler or manual) | 🆕 **New!** |
| [`self-improve-dashboard`](#self-improve-dashboard) | Open local dashboard with live log and controls | 🆕 **New!** |
| **🔧 Development & Debugging (9)** | | |
| [`inspect`](commands/inspect.md) | Visual Inspector with enhanced configs | ✅ Enhanced |
| [`validate`](commands/validate.md) | Pre-connection validation with rollback | ✅ Enhanced |
| [`test`](commands/test.md) | Comprehensive testing with metrics | ✅ Enhanced |
| [`debug`](commands/debug.md) | CLI debugging with connection pooling | ✅ Enhanced |
| [`analyze`](commands/analyze.md) | Performance analysis with benchmarks | ✅ Enhanced |
| [`backfill-metadata`](#backfill-metadata) | Backfill servers with Enhanced MCP Orchestration metadata | 🆕 **New!** |
| [`migrate-rules`](#migrate-rules) | Migrate parameter rules from JSON to database | 🆕 **New!** |
| [`auto-generate-rules`](#auto-generate-rules) | Auto-generate parameter rules from MCP server schemas | 🆕 **New!** |
| **🚀 Setup & Integration (4)** | | |
| [`bootstrap`](#bootstrap) | First-run workspace setup and template seeding | 🆕 **New!** |
| [`scan`](#scan) | Scan a GitHub repo for MCP server info without installing | 🆕 **New!** |
| [`mcp-server`](#mcp-server) | Run Vodou as an MCP server for Cursor integration | 🆕 **New!** |
| [`test-tracking`](#test-tracking) | Test EC2 tracking endpoint connectivity | 🆕 **New!** |
| **🗑️ Cache Management (1)** | | |
| [`clear-cache`](#clear-cache) | Clear parameter cache | 🆕 **New!** |

## Enhanced MCP Orchestration Features

Brain Trust 4 includes **production-ready MCP orchestration** providing:

### 🌐 Universal MCP Architecture
- **STDIO Server Support** - Traditional process-based MCP servers (Node.js, Python, binaries)
- **HTTP Server Support** - Service-based servers (browser-tools-mcp, API-based servers)
- **Remote HTTP Servers** - Connect to cloud-hosted MCP servers via HTTP/HTTPS ⭐ **New!**
- **Mixed Environment Management** - Handle all types simultaneously with automatic detection

### 🔐 Remote MCP Server Support ⭐ **New!**
- **HTTP/HTTPS Connections** - Connect to remote MCP servers via URLs
- **Credential Management** - Secure authentication with database and environment variable support
- **Validation & Preview** - Preview server capabilities before connecting
- **Automatic Detection** - URLs starting with `http://` or `https://` are automatically detected
- **Priority-Based Credentials** - Database → Environment Variables → CLI flags
- **Stateless Connections** - Efficient cloud service integration

### ⚡ High-Performance Features
- **Connection Pooling** - 25-50x faster tool calls (200ms vs 5-10 seconds)
- **Intelligent Caching** - 5-minute tool cache with automatic refresh
- **Background Health Monitoring** - Real-time server health with auto-recovery

### 🔍 Intelligent Server Discovery
- **Task-based Search** - Find servers by describing what you want to do
- **Auto-Installation** - NPM, Git, and binary installation with validation
- **GitHub Direct Installation** - Install any MCP server directly from GitHub repositories
- **Official MCP Registry Integration** - Search 500+ servers from registry.modelcontextprotocol.io with graceful fallbacks

### 🎯 Universal Tool Routing
- **Smart Routing** - Call tools by name with automatic server selection
- **Conflict Resolution** - Handle tools available on multiple servers
- **Performance Optimization** - Score-based server selection

### 🏥 Production Monitoring
- **Real-time Health Checks** - Background monitoring with auto-recovery
- **Health Dashboard** - Interactive monitoring with recommendations
- **Performance Metrics** - Success rates, response times, capability tracking

### 📁 Filesystem Security Management
- **Directory Permissions** - Granular control over filesystem server access
- **Roots Management** - Add, remove, and monitor allowed directories
- **Security Boundaries** - Prevent unauthorized file system access

### 🔐 User Approval System
- **Approval Policies** - Configurable security levels (strict, relaxed, auto)
- **Auto-Approval Rules** - Fine-grained operation-specific automation
- **Progress Tracking** - Monitor long-running operations with cancellation support
- **Audit Trail** - Complete history of approval decisions and operation tracking

### ⚙️ Universal MCP Startup Configuration
- **Universal Design** - Works with any MCP server without code changes
- **Database-Driven** - Configuration stored in existing database structure
- **Automatic Injection** - Startup arguments injected dynamically on connection
- **KISS Approach** - Simple and fast configuration management
- **Persistent Configuration** - Survives server restarts and reconnections

### 🧠 Brain Trust Integration
- **Frontend Foundation** - Intelligent context loading with Brain Trust 3 patterns
- **Complete Work Logging** - Audit trail of all operations
- **Pattern Recognition** - Track usage patterns and performance
- **Graceful Fallback** - Continues operation when Brain Trust unavailable
- **Context Aggregation** - Real-time MCP status and development guidance

### 💬 AI Agent Conversation Recording
- **Complete Conversation Tracking** - Every AI agent interaction recorded with full context
- **Advanced Analytics** - Performance metrics, quality analysis, and usage patterns  
- **Context Intelligence** - Query analysis, tool selection reasoning, and performance bottlenecks
- **Real-time Insights** - Live performance monitoring and optimization recommendations
- **Flexible Export** - JSON and CSV export for external analysis
- **Data Management** - Automated cleanup and retention policies

### 🔗 Chaining MCP Servers ⭐ **New!**
- **Data Extraction** - Extract data from one MCP server using clean mode (`-c`) and `jq`
- **Cross-Server Integration** - Pass extracted data to another MCP server as input
- **Shell Scripting** - Use shell variables to chain operations between servers
- **Automation Workflows** - Create powerful automation scripts combining multiple servers
- **JSON Processing** - Leverage `jq` for complex data extraction and transformation

**Basic Pattern:**
```bash
# Extract data from Server 1
DATA=$(./do -c server1-tool 2>/dev/null | tail -n +3 | jq '.field')

# Use that data with Server 2
./do "server2-tool with ${DATA}"
```

**Real-World Example:**
```bash
# Get CPU usage and log it to Vodou memory
CPU_USAGE=$(./do -c performance 2>/dev/null | tail -n +3 | jq '.usage_percent[0]')
./do "add log entry CPU usage is ${CPU_USAGE}%"
```

See [Chaining MCP Servers](#chaining-mcp-servers) section below for complete documentation.

---

## connect

Connect to an MCP server and discover all its capabilities (tools, prompts, and resources). Supports STDIO (local processes), HTTP (remote servers), and Docker Gateway connections.

### Syntax
```bash
# STDIO connection (local process)
vodou-core connect [OPTIONS] <NAME> <COMMAND> [ARGS]...

# HTTP connection (remote server)
vodou-core connect [OPTIONS] <NAME> --url <URL> [--api-key <KEY>] [--headers <HEADERS>]
```

### Parameters
- **`<NAME>`** - Unique server name (used for future references)
- **`<COMMAND>`** - Executable command for STDIO servers (e.g., "node", "python", "./binary")
- **`[ARGS]...`** - Command arguments for STDIO servers (space-separated)

### Options
- **`--validate`** - Validate server and preview capabilities before adding to database
- **`--url <URL>`** - HTTP/HTTPS URL for remote servers (e.g., `https://mcp.api.gusto.com/anthropic`)
- **`--api-key <KEY>`** - API key for quick testing (temporary, use `credentials` command for persistent storage)
- **`--headers <HEADERS>`** - Custom headers in format `"Header1:Value1,Header2:Value2"` or JSON

### Examples

#### Node.js MCP Server
```bash
# Connect to Chrome DevTools MCP (npx)
vodou-core connect chrome-devtools npx -y chrome-devtools-mcp@latest

# Connect to a custom Node.js server
vodou-core connect my-server node ./path/to/server.js
```

#### Python MCP Server
```bash
# Connect to Python weather MCP
vodou-core connect weather-mcp python -m mcp_weather.server

# Connect to Python MCP with specific module path
vodou-core connect data-mcp python ./scripts/data_server.py --port 8080
```

#### Native Binary MCP Server
```bash
# Connect to native monitor binary
vodou-core connect mcp-monitor ./bin/mcp-monitor
```

#### Remote HTTP Servers ⭐ **New!**
```bash
# Connect to remote HTTP server
vodou-core connect gusto --url https://mcp.api.gusto.com/anthropic

# Connect with validation (preview capabilities first)
vodou-core connect gusto --url https://mcp.api.gusto.com/anthropic --validate

# Connect with API key (temporary, for testing)
vodou-core connect gusto --url https://mcp.api.gusto.com/anthropic --api-key "sk-xxx"

# Connect with custom headers
vodou-core connect custom-api --url https://api.example.com/mcp --headers "Authorization:Bearer token"
```

#### Professional Development with Validation
```bash
# Validate server before adding to database (recommended)
vodou-core connect my-server node ./server.js --validate

# Regular connection (validation is optional)
vodou-core connect my-server node ./server.js

# Connect to monitor with absolute path
vodou-core connect system-monitor /usr/local/bin/system-monitor
```

### Connection Types

Brain Trust 4 automatically detects the connection type:

1. **STDIO** - If command is a local executable (default)
2. **HTTP** - If `--url` flag is provided or command starts with `http://`/`https://`
3. **Docker Gateway** - If using Docker container servers

### Remote Server Authentication

For remote servers, credentials are loaded in priority order:
1. **Database credentials** (highest - use `credentials` command)
2. **Environment variables** (automatic fallback)
3. **CLI flags** (lowest - temporary for testing)

See [`credentials`](#credentials) command for managing persistent authentication.

### Output
```
🔌 Connecting to MCP server: chrome-devtools (node)
🤝 Initializing MCP protocol...
🔍 Discovering capabilities...
✅ Connected! Discovered:
   🔧 Tools: 17
   📝 Prompts: 0
   📄 Resources: 0

🔧 Tools:
  - navigate_page: Open URLs in the attached browser
  - take_snapshot: Accessibility snapshot of the active tab
  - take_screenshot: Viewport screenshot
  ...
```

### Notes
- **Overwrites existing servers** with the same name
- **Discovers all capabilities** automatically (tools, prompts, resources)
- **Graceful fallbacks** if server doesn't support some capability types
- **Stores permanently** in SQLite database for future use

---

## credentials

Manage authentication credentials for remote MCP servers. Supports API keys, bearer tokens, OAuth tokens, and environment variable references.

### Syntax
```bash
vodou-core credentials <SERVER> <COMMAND> [OPTIONS]
```

### Commands

#### `add` - Add Credential
```bash
vodou-core credentials <SERVER> add [OPTIONS] [VALUE]
```

**Options:**
- `--cred-type <TYPE>` - Credential type: `api_key`, `bearer_token`, `oauth_token` (default: `api_key`)
- `--from-env <VAR>` - Use environment variable instead of storing value (recommended)
- `--header <NAME>` - HTTP header name (default: `Authorization` for bearer/oauth, `X-API-Key` for api_key)
- `--format <FORMAT>` - Header format template (e.g., `Bearer {token}`, `{key}`)

**Examples:**
```bash
# Add API key from environment variable (recommended)
vodou-core credentials gusto add --cred-type api_key --from-env "GUSTO_API_KEY" --header "X-API-Key"

# Add API key with stored value
vodou-core credentials gusto add --cred-type api_key "sk-xxx" --header "X-API-Key"

# Add bearer token
vodou-core credentials api-server add --cred-type bearer_token "token-xxx" --header "Authorization" --format "Bearer {token}"
```

#### `list` - List Credentials
```bash
vodou-core credentials <SERVER> list
```

Shows all configured credentials with type, source, header, and format information.

#### `remove` - Remove Credential
```bash
vodou-core credentials <SERVER> remove --cred-type <TYPE>
```

Removes a specific credential type for the server.

#### `test` - Test Credentials
```bash
vodou-core credentials <SERVER> test
```

Tests if credentials work by attempting to connect to the server.

### Credential Priority

When connecting to a server, credentials are loaded in this order:
1. **Database credentials** (highest - explicit configuration)
2. **Environment variables** (automatic fallback)
3. **CLI flags** (lowest - temporary for testing)

### Security Best Practices

- ✅ **Use `--from-env`** to store credential references instead of values
- ✅ **Keep `.env` files secure** (already in `.gitignore`)
- ✅ **Rotate credentials regularly**
- ✅ **Use server-specific credentials** when possible

### Related Documentation

- [Remote Servers Guide](../docs-DEV/remote-servers.md) (internal) — complete remote server guide
- [Credentials Command Details](./commands/credentials.md) - Detailed command reference

---

## search

Find MCP servers by task description or keywords using the Official MCP Registry and community registries.

### Syntax
```bash
vodou-core search <TASK> [OPTIONS]
```

### Parameters
- `<TASK>` - Task description or keywords to search for

### Options
- `--keywords <KEYWORDS>` - Additional keywords to refine search
- `--limit <NUMBER>` - Limit number of results (default: 10)

### Examples
```bash
# Search for filesystem servers
vodou-core search "filesystem"

# Search with keywords
vodou-core search "database" --keywords "postgres,sql"

# Limit results
vodou-core search "monitoring" --limit 5
```

### Output
```
🔍 Searching for MCP servers: "filesystem"
🔍 Searching for MCP servers for task: filesystem
✅ Found 21 servers from Official MCP Registry
✅ Found 21 servers from external registries

✅ Found 21 servers (showing top 10):

1. 📦 io.github.bytedance/mcp-server-filesystem
   📝 MCP server for filesystem operations
   🏷️  Tags: official, active
   ⭐ Rating: 5.0/5.0
   🔧 Install: NPM: @agent-infra/mcp-server-filesystem
```

### Notes
- **Primary Source**: Official MCP Registry (registry.modelcontextprotocol.io)
- **Fallback**: Community registries (getmcp.io, etc.)
- **Auto-Installation**: Use `vodou-core install <server-name>` to install
- **Quality**: Official registry servers are curated and validated

---

## install

Auto-install MCP servers from the Official MCP Registry or directly from GitHub repositories with automatic package detection.

### Syntax
```bash
vodou-core install <SERVER_NAME_OR_GITHUB_URL> [OPTIONS]
```

### Parameters
- `<SERVER_NAME_OR_GITHUB_URL>` - Name of the server from registry or direct GitHub URL

### Options
- `--as-name <NAME>` - Custom name for the installed server (default: auto-generated from URL)

### Examples

#### Install from Official MCP Registry
```bash
# Install a filesystem server from registry
vodou-core install "io.github.bytedance/mcp-server-filesystem"

# Install a Google Sheets server from registry
vodou-core install "io.github.henilcalagiya/google-sheets-mcp"
```

#### Install from GitHub Repository
```bash
# Install directly from GitHub repository
vodou-core install https://github.com/rashee1997/orchestrator

# Install with custom name
vodou-core install https://github.com/Rathesh2727/devcontext.git --as-name devcontext

# Install from GitHub with .git extension
vodou-core install https://github.com/user/repo.git --as-name my-server
```

### Output (Registry Installation)
```
🔍 Installing server: io.github.bytedance/mcp-server-filesystem
📦 Detected package: @agent-infra/mcp-server-filesystem
⚡ Installing via NPM...
✅ Installation completed successfully
🔗 Server ready for connection
```

### Output (GitHub Installation)
```
🔍 Installing from GitHub repository: https://github.com/rashee1997/orchestrator
📦 Installing MCP server: orchestrator
📥 Cloning git repository...
📦 Installing npm dependencies...
✅ Validating installation...
✅ Installation validated for: orchestrator
🔍 Discovering capabilities...
🔌 Trying MCP protocol version: 2025-06-18
✅ Connected using default protocol version: 2025-06-18
📊 Discovered capabilities:
  🔧 Tools: 43
  📝 Prompts: 0
  📄 Resources: 0
✅ Successfully installed and connected: orchestrator
💡 Use 'vodou-core tools orchestrator' to see available tools
```

### Installation Methods

#### Registry Installation
- **Auto-Detection**: Automatically detects installation method (NPM, PyPI, NuGet, etc.)
- **Validation**: Validates installation before completion
- **Connection Ready**: Installed servers are ready for `vodou-core connect`

#### GitHub Installation
- **Repository Cloning**: Downloads code from GitHub repository
- **Package Manager Detection**: Automatically detects Node.js, Python, Rust, or other projects
- **Dependency Installation**: Runs appropriate package manager (npm install, pip install, cargo build)
- **Executable Discovery**: Finds the actual MCP server command to run
- **Auto-Connection**: Automatically connects and discovers capabilities
- **Database Storage**: Saves server configuration for future use

### Supported GitHub Repository Types
- **Node.js Projects** - Detects `package.json` and runs `npm install`
- **Python Projects** - Detects `requirements.txt` and runs `pip install`
- **Rust Projects** - Detects `Cargo.toml` and runs `cargo build`
- **Binary Projects** - Downloads and installs pre-built binaries
- **Mixed Projects** - Handles projects with multiple package managers

### Notes
- **Universal Support**: Works with any GitHub repository containing an MCP server
- **Automatic Detection**: No manual configuration required
- **Error Handling**: Graceful fallback if installation fails
- **Custom Naming**: Use `--as-name` to specify custom server names
- **Connection Ready**: GitHub installations are automatically connected and ready to use

---

## sync-docker

Sync Docker Desktop MCP servers with BT4 database using the KISS method. Automatically discovers and adds Docker servers from the Docker Desktop registry with auto-discovery of tools and auto-generation of parameter rules.

### Syntax
```bash
./do sync-docker
```

### Description

The `sync-docker` command reads the Docker Desktop MCP registry (`~/.docker/mcp/registry.yaml`) and automatically:

1. **Discovers Docker servers** from the registry
2. **Adds new servers** to the BT4 database with Docker Gateway connection type
3. **Auto-discovers tools** for each new server
4. **Auto-generates parameter rules** from tool schemas
5. **Reports progress** with detailed logging

### Examples

```bash
# Sync all Docker Desktop MCP servers
./do sync-docker

# Output example:
# 🐳 Syncing Docker Desktop MCP servers with BT4...
#    ✅ docker-context7 (already exists)
#    ✅ Added: docker-memory
#    🔧 Auto-discovered 9 tools
#    🎯 Auto-generated 9 parameter rules
# 🎯 Sync complete: 10 servers processed, 1 new servers added
```

### Features

- **KISS Method**: Ultra-simple sync with minimal configuration
- **Auto-Discovery**: Automatically discovers tools and capabilities
- **Auto-Parameter Generation**: Creates parameter rules from tool schemas
- **Individual Docker Gateway**: Each Docker server gets its own connection
- **Progress Reporting**: Detailed logging of sync operations
- **Duplicate Prevention**: Skips servers that already exist

### Requirements

- **Docker Desktop**: Must be installed and running
- **Docker MCP Registry**: `~/.docker/mcp/registry.yaml` must exist
- **Docker Gateway**: `./docker-mcp` binary must be available

### Notes

- **Registry Location**: Reads from `~/.docker/mcp/registry.yaml`
- **Connection Type**: All synced servers use Docker Gateway connection
- **Auto-Discovery**: Tools are automatically discovered and stored in database
- **Parameter Rules**: Auto-generated from tool schemas with 291+ rules
- **Individual Connections**: Each Docker server gets its own Docker Gateway connection

---

## sync-mappings

Auto-discover ID mappings for a server to enable natural language queries with human-friendly names instead of numeric IDs.

### Syntax
```bash
./do sync-mappings <server-name> [--verbose]
vodou-core sync-mappings <server-name> [--verbose]
```

### Description

The `sync-mappings` command attempts to auto-discover name-to-ID mappings for a specific MCP server by calling common discovery tools and parsing their responses. This enables natural language queries like "create task in Vodou project" instead of requiring numeric project IDs.

### Features

- **Auto-Discovery**: Attempts common discovery tools (list_workspaces, list_projects, etc.)
- **Response Parsing**: Extracts name→ID mappings from API responses
- **Database Storage**: Stores mappings in `id_mappings` table for fast lookups
- **Verbose Output**: Shows discovered mappings with `--verbose` flag
- **Graceful Failure**: Handles servers without discovery tools appropriately
- **Entity Detection**: Automatically detects entity types (projects, workspaces, etc.)

### Examples

```bash
# Auto-discover mappings for Asana server
./do sync-mappings mcp-server-asana

# Verbose mode shows discovered mappings
./do sync-mappings mcp-server-asana --verbose

# Output example:
# 🔍 Auto-discovering mappings for server: mcp-server-asana
# ✅ Discovered 3 mappings for mcp-server-asana
# 
# 📋 Discovered mappings:
#    workspaces::My Workspace → 1234567890123
#    projects::Vodou → 1211709902166635
#    projects::Brain Trust → 9876543210987
```

### How It Works

1. **Server Validation**: Checks if the specified server exists in the database
2. **Discovery Tools**: Attempts common discovery tools (list_workspaces, list_projects, etc.)
3. **Response Parsing**: Extracts name/ID pairs from successful API responses
4. **Entity Detection**: Automatically determines entity types (projects, workspaces, etc.)
5. **Database Storage**: Stores mappings in the `id_mappings` table
6. **Results Reporting**: Shows count of discovered mappings

### Discovery Tools Attempted

- **Workspaces**: `list_workspaces`, `get_workspaces`, `workspaces_list`
- **Projects**: `list_projects`, `get_projects`, `projects_list`, `search_projects`
- **Channels**: `list_channels`, `get_channels`, `channels_list`, `search_channels`
- **Users**: `list_users`, `get_users`, `users_list`, `search_users`
- **Tasks**: `list_tasks`, `get_tasks`, `tasks_list`
- **Teams**: `list_teams`, `get_teams`, `teams_list`

### Benefits

- **Natural Language Queries**: Enables "create task in Vodou project" instead of numeric IDs
- **Automatic Learning**: System also learns from regular usage without discovery
- **Optional Bootstrap**: Faster initial setup for servers with many entities
- **Zero Config**: ID resolution works automatically once mappings exist

### Requirements

- **Server Connection**: Target server must be connected and accessible
- **Discovery Tools**: Server should have at least one supported discovery tool
- **Database Access**: Requires write access to BT4 database

### Usage After Discovery

Once mappings are discovered, use natural language immediately:
```bash
# After sync-mappings, these work automatically:
./do "asana create task in Vodou project"
./do "slack send message to #development channel"
./do "github create issue in Brain-Trust repository"
```

### Notes

- **Optional Command**: Not required - system learns from usage automatically
- **Per-Server**: Must specify server name, doesn't sync all servers at once
- **Discovery vs Learning**: Discovery is proactive, learning is reactive
- **Graceful Failure**: Safe to run on servers without discovery tools

### Related Commands

- [`./do "query"`](../README.md#daily-usage) - Use natural language queries with generated mappings
- [`connect`](#connect) - Connect MCP servers before running sync-mappings
- [`list-tools-db`](#list-tools-db) - View all available tools across servers
- Natural Language Intent Management - Manage mappings manually

---

## list

List all connected MCP servers with their connection details.

### Syntax
```bash
vodou-core list
```

### Parameters
None.

### Examples
```bash
# List all connected servers
vodou-core list
```

### Output
```
📋 Connected MCP servers:
  - chrome-devtools: npx -y chrome-devtools-mcp@latest
  - mcp-monitor: /usr/local/bin/mcp-monitor 
  - mcpadvisor: node ../modules/mcpadvisor/build/index.js
  - weather-mcp: python -m mcp_weather.server
```

### Output (No Servers)
```
No MCP servers connected yet.
Use: vodou-core connect <name> <command> <args...>
```

### Notes
- Shows **server name**, **command**, and **arguments** used for connection
- Servers are listed in **alphabetical order** by name

---

## capabilities

Show complete capabilities overview for a specific MCP server, including live testing.

### Syntax
```bash
vodou-core capabilities <NAME>
```

### Parameters
- **`<NAME>`** - Server name (from `list` command)

### Examples
```bash
# Show capabilities for Chrome DevTools MCP server
vodou-core capabilities chrome-devtools

# Show capabilities for monitor server
vodou-core capabilities mcp-monitor
```

### Output (Server with Multiple Capabilities)
```
⚙️ Capabilities for mcpadvisor:
  🔧 Tools: 2
  📝 Prompts: 0
  📄 Resources: 10

🔍 Testing live capabilities...
  ✅ Server supports:
    🔧 Tools (2)
    📄 Resources (10)
```

### Output (Tools Only)
```
⚙️ Capabilities for mcp-monitor:
  🔧 Tools: 6
  📝 Prompts: 0
  📄 Resources: 0

🔍 Testing live capabilities...
  ✅ Server supports:
    🔧 Tools (6)
```

### Output (No Server)
```
No capabilities found for server: unknown-server
Try connecting first: vodou-core connect unknown-server <command> <args...>
```

### Notes
- Shows **counts** for each capability type
- Performs **live testing** to verify current server capabilities
- **Graceful handling** if server is temporarily unavailable

---

## tools

Show all available tools for a specific MCP server with detailed information.

### Syntax
```bash
vodou-core tools <NAME>
```

### Parameters
- **`<NAME>`** - Server name (from `list` command)

### Examples
```bash
# Show tools for Chrome DevTools MCP server
vodou-core tools chrome-devtools

# Show tools for monitor server  
vodou-core tools mcp-monitor
```

### Output (With Tools)
```
🔧 Tools for mcp-monitor:
  - get_cpu_info: Get CPU information and usage
    Parameters:
      - interval
      - detailed

  - get_disk_info: Get disk usage information

  - get_memory_info: Get system memory usage information
    Parameters:
      - format
```

### Output (No Tools)
```
No tools found for server: my-server
Try connecting first: vodou-core connect my-server <command> <args...>
```

### Notes
- Shows **tool name** and **description**
- Lists **parameters** if available in the tool schema
- Tools are listed as discovered during the `connect` operation

---

## list-tools-db

List all tools from the database (fast, no MCP connections required). This command provides instant access to all discovered tools without the overhead of connecting to MCP servers.

### Syntax
```bash
vodou-core list-tools-db [OPTIONS]
```

### Options
- `--server <SERVER>` - Filter by server name
- `--schema` - Show tool schemas
- `--filter <FILTER>` - Search tools by name pattern
- `--format <FORMAT>` - Output format: table, json, markdown (default: table)

### Examples
```bash
# List all tools from database
vodou-core list-tools-db

# Filter by server
vodou-core list-tools-db --server context7

# Show schemas
vodou-core list-tools-db --schema

# Search for specific tools
vodou-core list-tools-db --filter "search"

# JSON output
vodou-core list-tools-db --format json

# Markdown output
vodou-core list-tools-db --format markdown
```

### Output (Table Format)
```
🔍 Querying tools from database...
✅ Found 2 tools in database:

📦 context7:
  🔧 get-library-docs - Fetches up-to-date documentation for a library
  🔧 resolve-library-id - Resolves a package/product name to a library ID
```

### Output (JSON Format)
```json
[
  {
    "server": "context7",
    "tool": "get-library-docs",
    "description": "Fetches up-to-date documentation for a library",
    "schema": "{\"$schema\":\"http://json-schema.org/draft-07/schema#\"...}"
  }
]
```

### Output (Markdown Format)
```markdown
# Tools from Database

Found 2 tools:

## context7

### get-library-docs

**Description:** Fetches up-to-date documentation for a library

**Schema:**
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  ...
}
```
```

### Notes
- **Instant Access**: No MCP server connections required
- **Always Available**: Works even if servers are down
- **Fast Performance**: Direct SQLite database queries
- **Complete Coverage**: Shows all discovered tools
- **Multiple Formats**: Table, JSON, and Markdown output options
- **Filtering**: Search by server name or tool name pattern
- **Schema Support**: Optional tool schema display

---

## prompts

Show all available prompt templates for a specific MCP server.

### Syntax
```bash
vodou-core prompts <NAME>
```

### Parameters
- **`<NAME>`** - Server name (from `list` command)

### Examples
```bash
# Show prompts for a server
vodou-core prompts my-server

# Show prompts for code analysis server
vodou-core prompts code-analyzer
```

### Output (With Prompts)
```
📝 Prompts for code-analyzer:
  - code_review: Review code for issues and improvements
    Arguments:
      - code (required)
      - language
      - style_guide

  - generate_docs: Generate documentation from code
    Arguments:
      - source_path (required)
      - format
```

### Output (No Prompts)
```
No prompts found for server: mcp-monitor
Try connecting first: vodou-core connect mcp-monitor <command> <args...>
```

### Notes
- Shows **prompt name** and **description**
- Lists **required and optional arguments**
- Many servers don't provide prompts (graceful fallback)

---

## resources

Show all available resources (data sources) for a specific MCP server.

### Syntax
```bash
vodou-core resources <NAME>
```

### Parameters
- **`<NAME>`** - Server name (from `list` command)

### Examples
```bash
# Show resources for advisor server
vodou-core resources mcpadvisor

# Show resources for data server
vodou-core resources data-server
```

### Output (With Resources)
```
📄 Resources for mcpadvisor:
  - file:///var/log/system.log
    Name: Log: system.log
    Description: Log file from /var/log
    Type: text/plain

  - file:///tmp/adobegc.log
    Name: Log: adobegc.log
    Description: Log file from /tmp
    Type: text/plain

  - https://api.example.com/data
    Name: API Data Source
    Description: Live data from external API
    Type: application/json
```

### Output (No Resources)
```
No resources found for server: mcp-monitor
Try connecting first: vodou-core connect mcp-monitor <command> <args...>
```

### Notes
- Shows **URI**, **name**, **description**, and **MIME type**
- Supports **file://** URLs for local files and **https://** for APIs
- Many servers don't provide resources (graceful fallback)

---

## call

Call a tool on a specific MCP server with **intelligent parameter generation** and optional JSON parameters.

### Syntax
```bash
vodou-core call <SERVER> <TOOL> [ARGS] [--query <QUERY>]
```

### Parameters
- **`<SERVER>`** - Server name (from `list` command)
- **`<TOOL>`** - Tool name (from `tools` command)
- **`[ARGS]`** - Optional JSON arguments
- **`--query <QUERY>`** - Query context for intelligent parameter generation

### 🧠 Intelligent Parameter Generation

The `call` command now features **automatic parameter generation** using the same intelligent system as the `./do` launcher:

- **✅ Smart Defaults**: Automatically generates appropriate parameters when none provided
- **✅ Query-Aware**: Uses command context or explicit `--query` for better parameter generation
- **✅ 270+ Rules**: Leverages the same Parameter Engine with 270+ hardcoded rules
- **✅ Schema Fallback**: Falls back to schema-based generation for unknown tools
- **✅ Context Extraction**: Automatically extracts query from command line arguments

### Examples

#### 🧠 Intelligent Auto-Parameters (New!)
```bash
# Automatic parameter generation - no args needed!
vodou-core call memory-orchestrator store_conversation_messages
# ✅ Generates: agent_id, messages, session_id automatically

vodou-core call github-test create_issue
# ✅ Generates: owner, repo, title from command context

vodou-core call filesystem read_text_file
# ✅ Generates: path="./" automatically
```

#### 🎯 Query-Aware Parameters
```bash
# Use explicit query for better parameter generation
vodou-core call memory-orchestrator store_conversation_messages --query="test message from CLI"
# ✅ Generates: messages with "test message from CLI" content

vodou-core call github-test create_issue --query="fix authentication bug"
# ✅ Generates: title="fix authentication bug" automatically
```

#### 📝 Manual Parameters (Traditional)
```bash
# Get system information (no parameters needed)
vodou-core call mcp-monitor get_cpu_info

# Get server status (no parameters needed)
vodou-core call my-server get_status

# Manual JSON parameters (when needed)
vodou-core call weather-mcp get_weather '{"location": "San Francisco"}'

# Complex parameters
vodou-core call search-server search '{
  "query": "authentication",
  "filters": {"type": "code", "language": "rust"},
  "limit": 10
}'
```

### Output (Success)

#### With Intelligent Parameter Generation
```
⚡ Calling tool store_conversation_messages on memory-orchestrator (using connection pool)...
🔧 Generated parameters: {
  "agent_id": "cline",
  "messages": "[{\"sender\": \"cline\", \"message_content\": \"test message from CLI\", \"message_type\": \"text\"}]",
  "session_id": "d7601182-0738-43b5-b8d8-04a7c5ac39a1"
}
🔧 Parameter Engine: Generating for memory-orchestrator::store_conversation_messages
   Available rules: 270
   Query: "test message from CLI"
   Intent: general_query
   ✅ Rule found for memory-orchestrator::store_conversation_messages
   📤 FromQuery extraction: message_content -> "[{"sender": "cline", "message_content": "test message from CLI", "message_type": "text"}]"
   Generated parameters: {
     "agent_id": "cline",
     "messages": "[{\"sender\": \"cline\", \"message_content\": \"test message from CLI\", \"message_type\": \"text\"}]",
     "session_id": "d7601182-0738-43b5-b8d8-04a7c5ac39a1"
   }
📦 Result: Successfully stored conversation message
```

#### Traditional Output
```
⚡ Calling tool get_cpu_info on mcp-monitor (using connection pool)...
📦 Result:
{
  "cpu_usage": 45.2,
  "cores": 8,
  "temperature": 65.0,
  "processes": 312
}
```

### Output (Error)
```
Error: Tool 'unknown_tool' not found on server 'mcp-monitor'
Available tools: get_cpu_info, get_disk_info, get_memory_info, ...
```

### Notes
- **🧠 Intelligent Parameters**: Automatically generates parameters when none provided
- **🎯 Query Context**: Uses command context or `--query` flag for better parameter generation
- **📋 270+ Rules**: Leverages comprehensive Parameter Engine with hardcoded rules
- **🔄 Schema Fallback**: Falls back to schema-based generation for unknown tools
- **⚡ Connection Pooling**: Uses connection pooling for 25-50x faster execution
- **📝 JSON Arguments**: Manual JSON arguments must be valid JSON strings
- **🔍 Error Reporting**: Full error reporting with suggestions for available tools

---

## help

Show help information for Brain Trust 4 or specific commands.

### Syntax
```bash
vodou-core help [COMMAND]
```

### Parameters
- **`[COMMAND]`** - Optional specific command to get help for

### Examples
```bash
# General help
vodou-core help
vodou-core --help

# Command-specific help
vodou-core help connect
vodou-core connect --help
```

### Notes
- Run `vodou-core help` for the full list of 80+ commands
- Run `vodou-core help <COMMAND>` for detailed usage of any specific command
- Subcommands also support `--help` (e.g., `vodou-core mem --help`)

---

## Global Options

### Help
```bash
-h, --help    Show help information
```

Available for all commands and the main program.

### Examples
```bash
# Main program help
vodou-core --help

# Command-specific help
vodou-core connect --help
vodou-core call --help
```

---

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | General error (connection failed, invalid arguments) |
| `2` | Server not found |
| `3` | Tool not found |
| `4` | Invalid JSON arguments |

---

## remove

Remove a connected MCP server and clean up all associated data.

### Syntax
```bash
vodou-core remove <NAME>
```

### Parameters
- **`<NAME>`** - Server name to remove

### Examples
```bash
# Remove a specific server
vodou-core remove old-server

# Remove server no longer needed
vodou-core remove test-server
```

### Output
```
✅ Removed server: old-server
```

**Error Handling:**
- Shows clear error message if server doesn't exist
- Automatically cleans up database entries (tools, prompts, resources)

---

## status

Show health status and capability summary for servers.

### Syntax
```bash
vodou-core status [NAME]
```

### Parameters
- **`[NAME]`** - Optional server name (shows all if omitted)

### Examples
```bash
# Check status of all servers
vodou-core status

# Check specific server status
vodou-core status mcp-monitor
```

### Output
```
🔍 Testing server: mcp-monitor
  ✅ mcp-monitor - Online and responding
    🔧 Tools: 6
    📝 Prompts: 0
    📄 Resources: 0
```

---

## reconnect

Reconnect to a server and rediscover all its capabilities.

### Syntax
```bash
vodou-core reconnect <NAME>
```

### Parameters
- **`<NAME>`** - Server name to reconnect

### Examples
```bash
# Reconnect after server updates
vodou-core reconnect my-server

# Refresh capabilities
vodou-core reconnect weather-mcp
```

### Use Cases
- Server was updated with new capabilities
- Connection was lost and needs refresh
- Database became out of sync with server

---

## health-check

Check the health status of all connected servers quickly.

### Syntax
```bash
vodou-core health-check
```

### Examples
```bash
# Quick health check of all servers
vodou-core health-check
```

### Output
```
🏥 Health Check - Testing 3 servers...

  Testing chrome-devtools: ✅ Healthy
  Testing mcp-monitor: ✅ Healthy
  Testing mcpadvisor: ✅ Healthy
```

---

## remove-all

Remove all connected servers with safety confirmation.

### Syntax
```bash
vodou-core remove-all
```

### Examples
```bash
# Remove all servers (will prompt for confirmation)
vodou-core remove-all
```

### Safety Features
- **Confirmation prompt** before deletion
- **Progress tracking** during removal
- **Complete cleanup** of all database entries

### Output
```
⚠️  This will remove ALL 3 servers. Continue? (y/N)
y
🗑️  Removing 3 servers...
  ✅ Removed: server1 (1/3)
  ✅ Removed: server2 (2/3)  
  ✅ Removed: server3 (3/3)
✅ All servers removed successfully
```

---

## reconnect-all

Reconnect all servers and refresh their capabilities with progress tracking.

### Syntax
```bash
vodou-core reconnect-all
```

### Examples
```bash
# Refresh all server connections
vodou-core reconnect-all
```

### Features
- **Progress indicators** for each server
- **Error resilience** - continues even if some servers fail
- **Detailed output** for each reconnection

### Output
```
🔄 Reconnecting 3 servers...

  🔄 Reconnecting 1/3: chrome-devtools
    ✅ Reconnected: chrome-devtools

  🔄 Reconnecting 2/3: mcp-monitor  
    ✅ Reconnected: mcp-monitor

  🔄 Reconnecting 3/3: mcpadvisor
    ✅ Reconnected: mcpadvisor

🔄 Reconnection process completed
```

---

## config

Show the configuration details for a connected server.

### Syntax
```bash
vodou-core config <NAME>
```

### Parameters
- **`<NAME>`** - Server name

### Examples
```bash
# View server configuration
vodou-core config mcp-monitor

# Check how a server is configured
vodou-core config my-server
```

### Output
```
📋 Configuration for mcp-monitor:
  Command: ./MCP-servers/mcp-monitor/bin/mcp-monitor
  Arguments: 
  Capabilities:
    🔧 Tools: 6
    📝 Prompts: 0
    📄 Resources: 0
```

---

## update-config

Update a server's configuration and rediscover capabilities.

### Syntax
```bash
vodou-core update-config <NAME> <COMMAND> [ARGS]...
```

### Parameters
- **`<NAME>`** - Server name
- **`<COMMAND>`** - New command to run
- **`[ARGS]...`** - New command arguments

### Examples
```bash
# Update server command
vodou-core update-config my-server node ./new-server.js

# Change server arguments
vodou-core update-config weather-mcp python -m weather.new_server
```

### Features
- **Validates** server exists before update
- **Rediscovers** capabilities after configuration change
- **Updates** database with new information

---

## export-servers

Export all server configurations to JSON format for backup.

### Syntax
```bash
vodou-core export-servers
```

### Examples
```bash
# Export to file
vodou-core export-servers > servers-backup.json

# View current server configs
vodou-core export-servers
```

### Output Format
```json
[
  [
    "server-name",
    "command",
    "[\"arg1\", \"arg2\"]"
  ]
]
```

---

## import-servers

Import server configurations from JSON format and connect to all servers.

### Syntax
```bash
vodou-core import-servers
```

### Examples
```bash
# Import from file
vodou-core import-servers < servers-backup.json

# Import from pipe
cat servers.json | vodou-core import-servers
```

### Features
- **Progress tracking** for each imported server
- **Error resilience** - continues even if some imports fail
- **Capability discovery** for each imported server

### Output
```
📥 Importing 3 servers...

  📥 Importing 1/3: server1
    ✅ Imported: server1

  📥 Importing 2/3: server2
    ✅ Imported: server2

  📥 Importing 3/3: server3
    ✅ Imported: server3

📥 Import process completed
```

---

## config-startup

Configure server startup arguments using the Universal MCP Startup Configuration system.

### Syntax
```bash
vodou-core config-startup <SERVER_NAME> --set <KEY>=<VALUE>
```

### Parameters
- **`<SERVER_NAME>`** - Name of the MCP server to configure
- **`--set <KEY>=<VALUE>`** - Set a startup configuration key-value pair (can be used multiple times)

### Examples

#### Configure Filesystem Server
```bash
# Set allowed directories for filesystem server
vodou-core config-startup filesystem --set allowed-directories=/Users/you/Projects

# Multiple configuration options
vodou-core config-startup filesystem --set allowed-directories=/Users/you/Projects --set max-file-size=10MB
```

#### Configure Custom Server
```bash
# Configure any MCP server with startup arguments
vodou-core config-startup my-server --set api-key=secret --set debug=true

# Configure memory server
vodou-core config-startup memory-server --set storage-path=/data --set max-memory=1GB
```

### Features

- **🌐 Universal Design**: Works with all MCP servers without code changes
- **💾 Database-Driven**: Configuration stored in existing database structure  
- **⚡ Automatic Injection**: Startup arguments injected dynamically on connection
- **🚀 KISS Approach**: Simple and fast configuration management
- **🔄 Persistent**: Configuration survives server restarts and reconnections

### How It Works

1. **Store Configuration**: Arguments stored in `mcp_servers.metadata` table
2. **Automatic Injection**: Brain Trust 4 injects stored arguments when server connects
3. **Special Handling**: Filesystem servers also use `server_roots` table for compatibility
4. **No Restarts Needed**: Configuration applies on next server connection

### Output
```bash
✅ Startup configuration updated for server: filesystem
   🔧 allowed-directories: /Users/you/Projects
   📝 Configuration will apply on next connection
```

### Related Commands
- [`connect`](#connect) - Connect servers (uses startup configuration)
- [`reconnect`](#reconnect) - Reconnect servers (applies new configuration)  
- [`list`](#list) - List configured servers
- [`config`](#config) - View server configuration

### Notes
- Configuration is **persistent** across restarts
- Multiple `--set` flags can be used in one command
- Takes effect on next server connection or reconnection
- Works with **any MCP server** that accepts CLI arguments

---

## parallel

Execute multiple tools in parallel based on intent patterns for dramatic performance improvements.

**Usage:**
```bash
vodou-core parallel <INTENT> [--context <JSON>]
```

**Arguments:**
- `INTENT` - Intent pattern for parallel execution (e.g., "system_performance", "codebase_analysis", "filesystem_scan")
- `--context <JSON>` - Optional context parameters in JSON format

**Examples:**
```bash
# System performance monitoring (parallel CPU, memory, disk checks)
vodou-core parallel system_performance

# Codebase analysis with custom path
vodou-core parallel codebase_analysis --context '{"path": "./src"}'

# Filesystem scanning
vodou-core parallel filesystem_scan --context '{"path": "/Users/project"}'
```

**Features:**
- **275% Parallel Efficiency**: Dramatically faster than sequential execution
- **Intent-Based Tool Selection**: Automatically selects appropriate tools
- **Smart Context Aggregation**: Intelligently combines and summarizes results
- **Performance Metrics**: Shows execution time, efficiency gains, and success rates
- **Graceful Degradation**: Falls back gracefully if some tools fail

**Sample Output:**
```
🎯 Parallel Execution Summary:
═══════════════════════════════════════════════════════════════════
📝 System Performance: 3 tools in 8.412208ms

⚡ Performance Metrics:
   Total execution time: 8.412208ms
   Tools executed: 3
   Success rate: 100.0%
   Parallel efficiency: 275.0%

🎯 Primary Results:
   📊 cpu_info: Apple M1 Pro, 10 cores, 24.8% usage
   📊 memory_info: 84.8% used (14GB/17GB)
   📊 disk_info: System disk usage data
═══════════════════════════════════════════════════════════════════
```

---

## parallel-custom

Execute specific tools in parallel across multiple servers with manual specification for maximum control.

**Usage:**
```bash
vodou-core parallel-custom <TOOLS> [--args <JSON>]
```

**Arguments:**
- `TOOLS` - Comma-separated list of server:tool pairs (e.g., "server1:tool1,server2:tool2")
- `--args <JSON>` - Optional arguments for all tools in JSON format

**Examples:**
```bash
# Execute specific tools across different servers
vodou-core parallel-custom "mcp-monitor:get_cpu_info,mcp-monitor:get_memory_info,filesystem:list_directory"

# Include arguments for all tools
vodou-core parallel-custom "mcp-monitor:get_cpu_info,filesystem:list_directory" --args '{"path": "."}'

# Mix system monitoring and codebase analysis
vodou-core parallel-custom "mcp-monitor:get_cpu_info,chrome-devtools:take_snapshot,filesystem:get_file_info"
```

**Features:**
- **Manual Tool Selection**: Full control over which servers and tools to execute
- **Cross-Server Execution**: Execute tools from different servers simultaneously
- **Unified Argument Passing**: Pass the same arguments to multiple tools
- **Real Performance Metrics**: Detailed timing and efficiency analysis
- **Error Isolation**: Failed tools don't stop successful ones

**Sample Output:**
```
📊 Parallel Execution Results:
═══════════════════════════════════════════════════════════════════
⏱️  Total execution time: 45ms (parallel)
⏱️  Would have taken: 120ms (sequential)
🚀 Speed improvement: 167% faster

📋 Individual Results:
───────────────────────────────────────────────────────────────────
✅ mcp-monitor:get_cpu_info
   Time: 32ms
   Result: {"core_count": 10, "usage_percent": [24.8]}

✅ filesystem:list_directory
   Time: 45ms
   Result: {"files": ["file1.txt", "file2.md"], "total": 2}

📊 Summary:
   Total tools: 2
   Successful: 2 ✅
   Success rate: 100%
═══════════════════════════════════════════════════════════════════
```

---

## brain

Execute brain command with frontend foundation for intelligent context loading and analysis.

### Syntax
```bash
vodou-core brain <QUERY> [OPTIONS]
```

### Parameters
- **`<QUERY>`** - The query or request to analyze (required)

### Options
- **`--verbose`** - Show detailed output with full context loading information
- **`--test-params`** - Test parameter generation without executing tools (useful for debugging)
- **`--clean`**, **`-c`** - Output only raw JSON from tool results (no formatting, reminders, or metadata)

### Examples
```bash
# Analyze system performance
vodou-core brain "analyze my system performance"

# Development planning
vodou-core brain "what's the next development phase"

# General context loading  
vodou-core brain "help me understand the current state"

# Test parameter generation (no execution)
vodou-core brain "cpu" --test-params

# Verbose mode with parameter testing
vodou-core brain "analyze codebase" --test-params --verbose

# Clean mode: output only raw JSON
vodou-core brain "cpu" --clean
./do --clean cpu
```

### Features

#### 🧠 **Frontend Foundation**
- **Context Loading**: Loads intelligent context based on the query
- **MCP Integration**: Shows real-time status of connected MCP servers  
- **Performance Metrics**: Displays connection pool and execution statistics
- **Development Roadmap**: Provides guidance on next development steps

#### 🔍 **Parameter Testing Mode** (`--test-params`)
Test parameter generation without executing tools. Shows:
- Query analysis and intent mappings
- Input schema for each tool
- Parameter generation details (rule used, generated parameters, timing)
- Rule details (required fields, field generators)
- Execution preview and direct call syntax

#### 🧹 **Clean Mode** (`--clean`, `-c`)
Output only raw JSON from tool results without formatting, reminders, or metadata. This mode:
- Suppresses all formatting (emojis, headers, section dividers)
- Removes work log reminders and AI agent guidance
- Omits execution time and system overhead metrics
- Skips intent mapping information and available intents
- Outputs only the raw JSON response from MCP tools
- Shows debug output only when `DEBUG=1` environment variable is set
- **Includes intelligence system data in error responses** (working examples, failure patterns, success rates)
- **Still records to database** for intelligence system tracking

**Use cases:**
- Scripting and automation pipelines
- JSON parsing and processing
- Integration with external tools requiring clean JSON
- Minimal output requirements
- AI agent integration with structured error intelligence

**Example output (success):**
```json
Query: cpu
AI Agent Instruction: Analyze the JSON output below using the original query above. Reason about the data and provide a clear, helpful response to the user based on both the query intent and the tool results.
{
  "core_count": 10,
  "info": [{"cpu": 0, "modelName": "Apple M1 Pro", "cores": 10, "mhz": 3228}],
  "usage_percent": [25.9]
}
```

**Example output (error with intelligence):**
```json
Query: cpu memory disk
AI Agent Instruction: Analyze the JSON output below using the original query above. Reason about the data and provide a clear, helpful response to the user based on both the query intent and the tool results.
{
  "error": true,
  "intelligence": {
    "failed_attempts": 4,
    "failure_patterns": [{
      "error": "Failed to get disk usage information: no such file or dir...",
      "failure_count": 4,
      "latest_failure": "2025-12-27 23:05:16",
      "query": "cpu memory disk"
    }],
    "is_troublesome": true,
    "success_rate": 0.0,
    "successful_attempts": 0,
    "total_attempts": 4
  },
  "message": "Failed to get disk usage information: no such file or directory",
  "server": "mcp-monitor",
  "tool": "get_disk_info"
}
```

**Intelligence system features:**
- **Success rate tracking**: Shows tool reliability percentage
- **Working examples**: Queries that successfully executed this tool
- **Failure patterns**: Common queries that failed with this error
- **Troublesome tool flag**: Identifies tools with <70% success rate
- **Database recording**: All clean mode executions are recorded for intelligence tracking
Output only raw JSON from tool results without any formatting, reminders, or metadata. Useful for:
- Scripting and automation
- JSON parsing pipelines
- Minimal output requirements
- Integration with external tools

**Clean mode behavior:**
- Suppresses all formatting (emojis, headers, section dividers)
- Removes work log reminders and AI agent guidance
- Omits execution time and system overhead metrics
- Skips intent mapping information and available intents
- Outputs only the raw JSON response from MCP tools
- Debug output only shown when `DEBUG=1` environment variable is set

#### 📋 **Context Sections**
1. **HELLO WORLD CONTEXT** - Query reception and Brain Trust 4 status overview
2. **MCP BACKEND STATUS** - Real server count, available servers, and performance metrics
3. **GUIDANCE & NEXT STEPS** - Development roadmap and actionable items

### Sample Output
```
🧠 **BRAIN TRUST 4**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Query: analyze my system performance

📋 **CONTEXT LOADED**
🔍 **HELLO WORLD CONTEXT**
🎯 **QUERY RECEIVED**: analyze my system performance

🧠 **BRAIN TRUST 4 STATUS**:
• MCP Backend: ✅ Active (27 servers)
• Tool Execution: ✅ Fast (9ms)
• Connection Pool: ✅ Optimized
• Frontend: 🚧 In Development

🔍 **MCP BACKEND STATUS**
🔌 **MCP SERVERS AVAILABLE** (27 servers):
• mcp-monitor: System monitoring tools
• chrome-devtools: Chrome DevTools MCP — browser automation (navigate, snapshot, screenshot, console, network)
• memory-orchestrator: Conversation management
• devcontext: Development context tracking
• filesystem: File operations
• ... and 22 more servers

⚡ **PERFORMANCE**:
• Tool execution: ~9ms average
• Connection pooling: 25-50x improvement
• Parallel execution: Ready for integration

🔍 **GUIDANCE & NEXT STEPS**
🎯 **FRONTEND DEVELOPMENT ROADMAP**:

**Phase 1**: ✅ Basic brain command (current)
**Phase 2**: ✅ Hello world loader (current)
**Phase 3**: Query analysis and intent detection
**Phase 4**: MCP tool integration and parallel execution
**Phase 5**: Advanced context aggregation

⚡ **Brain Trust 4 Frontend Foundation Active**
```

### Technical Implementation
- **Brain Loader**: Context loading and aggregation via `src/brain_loader.rs`
- **Database Integration**: Real-time server count from `vodou-core.db`
- **Performance**: Leverages connection pooling for 25-50x improvement
- **Scalable Architecture**: Ready for expansion to advanced features

### Development Status
- **Phase 1**: ✅ Basic brain command 
- **Phase 2**: ✅ Hello world loader
- **Phase 3**: ✅ Test and validate
- **Next Phase**: Query analysis and intent detection

### Future Expansion
The brain command provides the foundation for:
1. **Query Analysis**: Intent detection and natural language processing
2. **MCP Tool Integration**: Automatic tool selection based on query analysis  
3. **Parallel Execution**: Concurrent tool execution with result aggregation
4. **Advanced Context**: Work history, pattern intelligence, and enhanced summaries

### See Also
- [parallel](#parallel) - Execute multiple tools in parallel based on intent
- [parallel-custom](#parallel-custom) - Custom parallel tool execution
- [call-tool](commands/call-tool.md) - Direct tool execution
- [find-tool](commands/find-tool.md) - Find tools across servers

---

## Common Usage Patterns

### 1. Discovery Workflow
```bash
# 1. Connect to server
vodou-core connect my-server node ./server.js

# 2. Explore capabilities
vodou-core capabilities my-server

# 3. Check specific capability types
vodou-core tools my-server
vodou-core resources my-server

# 4. Use the capabilities
vodou-core call my-server some-tool '{"arg": "value"}'
```

### 2. Multi-Server Management
```bash
# Connect multiple servers
vodou-core connect weather python -m weather_mcp.server
vodou-core connect monitor ./bin/system-monitor  
vodou-core connect analyzer node ./analyzer.js

# List all servers
vodou-core list

# Compare capabilities
vodou-core capabilities weather
vodou-core capabilities monitor
vodou-core capabilities analyzer
```

### 3. Server Health Checking
```bash
# Check if servers are responding
vodou-core capabilities server1
vodou-core capabilities server2

# Test specific tools
vodou-core call server1 health_check
vodou-core call server2 get_status
```

---

## AI Agent Conversation Recording Commands

Brain Trust 4 includes a **comprehensive conversation recording system** that automatically captures all AI agent interactions, tool executions, and system performance data. These commands provide deep insights into AI agent behavior, usage patterns, and system optimization opportunities.

### Key Features
- **🔍 Complete Conversation Tracking**: Every AI agent interaction recorded with full context
- **📊 Advanced Analytics**: Performance metrics, quality analysis, and usage patterns
- **🧠 Context Intelligence**: Query analysis, tool selection reasoning, and performance bottlenecks
- **📈 Real-time Insights**: Live performance monitoring and optimization recommendations
- **📋 Flexible Export**: JSON and CSV export for external analysis
- **🔄 Data Management**: Automated cleanup and retention policies

---

## conversation list

List recorded conversation sessions with filtering options.

### Syntax
```bash
vodou-core conversation list [OPTIONS]
```

### Options
- `--days <DAYS>` - Show conversations from last N days (default: 7)
- `--session-type <TYPE>` - Filter by session type (oi_command, direct_call, etc.)
- `--limit <LIMIT>` - Limit number of results (default: 20)

### Examples
```bash
# List recent conversations
vodou-core conversation list

# Show conversations from last 30 days
vodou-core conversation list --days 30

# Filter by session type
vodou-core conversation list --session-type oi_command

# Limit results
vodou-core conversation list --limit 10 --days 1
```

### Output
```
📋 **Conversation Sessions** (last 7 days)

🔍 Session: vc_d7601182-0738-43b5-b8d8-04a7c5ac39a1
   ⏰ Started: 2025-09-25 01:25:16 UTC
   📊 Type: oi_command
   🔄 Status: ✅ Complete
   📈 Stats: 1 interactions, 13.1s execution time

🔍 Session: vc_a8b2c3d4-1234-5678-9abc-def012345678
   ⏰ Started: 2025-09-24 15:30:22 UTC
   📊 Type: direct_call
   🔄 Status: ✅ Complete
   📈 Stats: 3 interactions, 5.2s execution time
```

---

## conversation show

Show detailed information for a specific conversation session.

### Syntax
```bash
vodou-core conversation show <SESSION_ID>
```

### Parameters
- `<SESSION_ID>` - Session ID to display (from `conversation list`)

### Examples
```bash
# Show details for specific session
vodou-core conversation show vc_d7601182-0738-43b5-b8d8-04a7c5ac39a1

# Show session with full tool execution details
vodou-core conversation show vc_session_123
```

### Output
```
🔍 **Conversation Details** - vc_d7601182-0738-43b5-b8d8-04a7c5ac39a1

📋 **Session Info**:
   🕐 Start: 2025-09-25 01:25:16 UTC
   ⏰ End: 2025-09-25 01:25:29 UTC
   📊 Type: oi_command
   👤 User: -
   ⚡ Total Execution: 13091.50ms

📝 **Conversation Entries** (1):

🔹 **Entry** entry_73c1ec27-880c-4aff-9caa-b45ae261d273
   ⏰ Time: 2025-09-25 01:25:16
   🎯 Type: direct_tool_call
   ❓ Query: test recording
   🔧 Tools: 3 executed
   ⚡ Time: 13064ms

   **Tool Executions**:
   1. ✅ puppeteer::puppeteer_navigate (8678ms)
   2. ✅ memory-test::create_relations (2265ms)
   3. ❌ memory-orchestrator::store_conversation_messages (2058ms)
      Error: MCP error -32602: Tool requires 'agent_id'
```

---

## conversation analytics

Display comprehensive conversation analytics with usage patterns and performance metrics.

### Syntax
```bash
vodou-core conversation analytics [OPTIONS]
```

### Options
- `--days <DAYS>` - Analyze conversations from last N days (default: 30)
- `--server <SERVER>` - Filter by server name

### Examples
```bash
# General analytics
vodou-core conversation analytics

# Last 7 days only
vodou-core conversation analytics --days 7

# Filter by server
vodou-core conversation analytics --server mcp-monitor
```

### Output
```
📊 **Conversation Analytics** (last 30 days)

📈 **Usage Patterns**:
   Most common query type: 'direct_tool_call' (100.0% of all queries)

📊 **Tool Performance**:
   Average execution time: 4.3s
   Most used servers:
     • puppeteer (1 calls)
     • memory-test (1 calls)
     • memory-orchestrator (1 calls)

🎯 **Performance Metrics**:
   Total sessions: 1
   Total interactions: 1
   Average session duration: 13.1s
   Average interactions per session: 1.0

💡 **Insights**:
   • 1 tools are performing slower than 5s threshold
   • Slowest tool: puppeteer::puppeteer_navigate (avg 8.7s)
   • Average session has 1.0 interactions and takes 13.1s
   • Most used server: puppeteer (1 calls)
```

---

## conversation bottlenecks

Identify performance bottlenecks in conversations with detailed analysis.

### Syntax
```bash
vodou-core conversation bottlenecks [OPTIONS]
```

### Options
- `--days <DAYS>` - Analyze last N days (default: 30)
- `--threshold <MS>` - Minimum execution time threshold in ms (default: 5000)

### Examples
```bash
# Find performance bottlenecks
vodou-core conversation bottlenecks

# Lower threshold for more sensitivity
vodou-core conversation bottlenecks --threshold 1000

# Analyze recent data only
vodou-core conversation bottlenecks --days 7
```

### Output
```
⚡ **Performance Bottlenecks** (last 30 days, >5000ms threshold)

🔍 Found 1 performance bottleneck:

🐌 **puppeteer::puppeteer_navigate**
   ⏱️  Average: 8678.0ms
   ⏱️  Maximum: 8678.0ms (estimated)
   ⏱️  95th percentile: 8678.0ms (estimated)
   
   💡 **Recommendations**:
   • Consider adding a timeout to prevent hanging
   • Cache results if the data doesn't change frequently
   • Apify operations are inherently slow. Consider running async or in background

📈 **Summary**: 1 tools need optimization (>5s threshold)
```

---

## conversation export

Export conversation data to JSON or CSV format for external analysis.

### Syntax
```bash
vodou-core conversation export [OPTIONS]
```

### Options
- `--days <DAYS>` - Export conversations from last N days (default: 7)
- `--format <FORMAT>` - Export format: json, csv (default: json)
- `--output <FILE>` - Output file path (default: conversations_export)

### Examples
```bash
# Export to JSON
vodou-core conversation export

# Export to CSV
vodou-core conversation export --format csv --output my_conversations.csv

# Export last 30 days
vodou-core conversation export --days 30 --output monthly_data.json
```

### Output
```
📤 **Exporting Conversations** (last 7 days to JSON)

📊 **Export Summary**:
   Sessions: 1
   Interactions: 1
   Tool executions: 3
   Time range: 2025-09-25 to 2025-09-25

✅ **Export completed**: conversations_export.json
   File size: 2.1 KB
   Records: 1 sessions, 1 interactions, 3 tool executions
```

---

## conversation cleanup

Clean up old conversation data with safety controls.

### Syntax
```bash
vodou-core conversation cleanup [OPTIONS]
```

### Options
- `--keep-days <DAYS>` - Keep conversations newer than N days (default: 90)
- `--dry-run` - Perform dry run without deleting data

### Examples
```bash
# Clean up data older than 90 days (dry run)
vodou-core conversation cleanup --dry-run

# Actually clean up old data
vodou-core conversation cleanup

# Keep only last 30 days
vodou-core conversation cleanup --keep-days 30
```

### Output
```
🧹 **Conversation Cleanup** (keeping last 90 days)

📊 **Cleanup Analysis**:
   Total sessions: 1
   Sessions to remove: 0 (newer than 90 days)
   Total entries: 1
   Entries to remove: 0
   Total tool executions: 3
   Tool executions to remove: 0

✅ **Result**: No data to clean up (all conversations are recent)
```

---

## conversation metrics

Display detailed performance, quality, and usage metrics.

### Syntax
```bash
vodou-core conversation metrics [OPTIONS]
```

### Options
- `--session <SESSION>` - Session ID to analyze (optional)
- `--days <DAYS>` - Analyze metrics from last N days (default: 7)
- `--metric-type <TYPE>` - Metric type: performance, quality, usage, all (default: all)

### Examples
```bash
# All metrics for last 7 days
vodou-core conversation metrics

# Performance metrics only
vodou-core conversation metrics --metric-type performance

# Metrics for specific session
vodou-core conversation metrics --session vc_session_123

# Last 30 days, quality metrics
vodou-core conversation metrics --days 30 --metric-type quality
```

### Output
```
📊 **Conversation Metrics** (last 7 days)
   📈 Type: all

🚀 **Performance Metrics**:
   execution_time - Avg: 13064.00, Max: 13064.00, Min: 13064.00 (samples: 1)
   tool_latency_0_puppeteer::puppeteer_navigate - Avg: 8678.00, Max: 8678.00, Min: 8678.00 (samples: 1)
   avg_tool_execution_time - Avg: 4333.67, Max: 4333.67, Min: 4333.67 (samples: 1)
   context_size - Avg: 89.00, Max: 89.00, Min: 89.00 (samples: 1)

✅ **Quality Metrics**:
   tool_success_rate - Avg: 66.67 (samples: 1)
   failed_tools_count - Avg: 1.00 (samples: 1)
   error_count - Avg: 1.00 (samples: 1)

📈 **Usage Metrics**:
   query_length - Total: 14, Avg: 14.00 (samples: 1)
   tool_count - Total: 3, Avg: 3.00 (samples: 1)
   server_diversity - Total: 3, Avg: 3.00 (samples: 1)
   interaction_type_direct_tool_call - Total: 1, Avg: 1.00 (samples: 1)

Generated at: 2025-09-25 01:57:47 UTC
```

---

## conversation context

Show context analysis and insights for conversations.

### Syntax
```bash
vodou-core conversation context [OPTIONS]
```

### Options
- `--entry <ENTRY_ID>` - Entry ID to show context for (optional)
- `--limit <LIMIT>` - Limit number of results (default: 10)
- `--context-type <TYPE>` - Context type filter: query_analysis, tool_selection, performance

### Examples
```bash
# Show recent context insights
vodou-core conversation context

# Show context for specific entry
vodou-core conversation context --entry entry_73c1ec27-880c-4aff-9caa-b45ae261d273

# Filter by context type
vodou-core conversation context --context-type performance --limit 5
```

### Output
```
🧠 **Context Insights** (limit: 10)

📋 **query_analysis** (entry_73c1ec27-880c-4aff-9caa-b45ae261d273)
   ⏰ Created: 2025-09-25 01:25:16
   🎯 Intent: general_query
   📊 Confidence: 0.50
   🔤 Keywords: []
   📏 Query length: 14 chars
   📈 Complexity: 0.1

📋 **tool_selection** (entry_73c1ec27-880c-4aff-9caa-b45ae261d273)
   ⏰ Created: 2025-09-25 01:25:16
   🔧 Tools: puppeteer::puppeteer_navigate, memory-test::create_relations, memory-orchestrator::store_conversation_messages
   📊 Tool count: 3
   🌐 Unique servers: 3
   🎯 Strategy: parallel

📋 **performance** (entry_73c1ec27-880c-4aff-9caa-b45ae261d273)
   ⏰ Created: 2025-09-25 01:25:16
   ⚡ Performance score: 65.0/100
   ⚠️  Bottleneck: Slow tool: puppeteer::puppeteer_navigate (8678ms)
   ⚠️  Bottleneck: Failed tools: memory-orchestrator::store_conversation_messages
   ⚠️  Bottleneck: Long total execution time: 13064ms
   💡 Suggestion: Consider timeout or optimization for puppeteer_navigate
   💡 Suggestion: Review tool parameters and error handling
   💡 Suggestion: Consider parallelization or caching strategies
```

---

## conversation insights

Show performance insights and bottlenecks from context analysis.

### Syntax
```bash
vodou-core conversation insights [OPTIONS]
```

### Options
- `--days <DAYS>` - Analyze insights from last N days (default: 30)

### Examples
```bash
# Show performance insights
vodou-core conversation insights

# Analyze recent insights only
vodou-core conversation insights --days 7
```

### Output
```
💡 **Performance Insights** (last 30 days)

🔍 **Detected Performance Issues**:

⚡ **Performance Score: 65.0/100**
   📅 Detected: 2025-09-25 01:25:16

   🚩 **Bottlenecks Identified**:
   • Slow tool: puppeteer::puppeteer_navigate (8678ms)
   • Failed tools: memory-orchestrator::store_conversation_messages  
   • Long total execution time: 13064ms

   🛠️  **Optimization Suggestions**:
   • Consider timeout or optimization for puppeteer_navigate
   • Review tool parameters and error handling
   • Consider parallelization or caching strategies

📊 **Summary**: 1 performance issues detected across 1 conversations
```

---

## conversation session-metrics

Get detailed session metrics for a specific conversation session.

### Syntax
```bash
vodou-core conversation session-metrics <SESSION_ID>
```

### Parameters
- `<SESSION_ID>` - Session ID to analyze

### Examples
```bash
# Detailed metrics for specific session
vodou-core conversation session-metrics vc_d7601182-0738-43b5-b8d8-04a7c5ac39a1

# Get comprehensive session analysis
vodou-core conversation session-metrics vc_session_123
```

### Output
```
📊 **Session Metrics** - vc_d7601182-0738-43b5-b8d8-04a7c5ac39a1

🎯 **Session Overview**:
   📅 Session: vc_d7601182-0738-43b5-b8d8-04a7c5ac39a1
   💬 Total interactions: 1
   ⏱️  Total execution time: 13064ms

🚀 **Performance Metrics**:
   execution_time - Avg: 13064.00, Max: 13064.00, Min: 13064.00 (samples: 1)
   tool_latency_0_puppeteer::puppeteer_navigate - Avg: 8678.00, Max: 8678.00, Min: 8678.00 (samples: 1)

✅ **Quality Metrics**:
   tool_success_rate: 66.67%
   error_count: 1.00
   failed_tools_count: 1.00

📈 **Performance Analysis**: Generated at 2025-09-25 01:57:48 UTC
```

---

### Conversation Recording Use Cases

#### 1. Performance Monitoring
```bash
# Monitor system performance
vodou-core conversation metrics --metric-type performance
vodou-core conversation bottlenecks --threshold 2000

# Track quality trends
vodou-core conversation metrics --metric-type quality --days 30
```

#### 2. Development Analysis
```bash
# Analyze usage patterns
vodou-core conversation analytics --days 7

# Find optimization opportunities
vodou-core conversation insights
vodou-core conversation context --context-type performance
```

#### 3. Data Export and Analysis
```bash
# Export for spreadsheet analysis
vodou-core conversation export --format csv --days 30

# Backup conversation data
vodou-core conversation export --output backup_$(date +%Y%m%d).json
```

#### 4. System Maintenance
```bash
# Clean up old data
vodou-core conversation cleanup --keep-days 60 --dry-run
vodou-core conversation cleanup --keep-days 60

# Monitor specific sessions
vodou-core conversation show session_id
vodou-core conversation session-metrics session_id
```

---

## log:

**Log completed work with enhanced categorization and metadata.**

```bash
# Basic format
./do "log: message"

# Enhanced format with category
./do "log: category: message"

# Enhanced format with metadata
./do "log: category: message | key1: value1 | key2: value2"
```

### Enhanced Logging Format

- **Basic**: `./do "log: description"` (auto-categorized as "general")
- **With Category**: `./do "log: feature: Implemented user authentication"`
- **With Metadata**: `./do "log: bugfix: Fixed memory leak | component: connection_pool | files_changed: 1 | files_modified: src/connection_pool.rs | severity: high | duration: 15min"`

### Valid Categories

- `feature` - New functionality or capabilities
- `bugfix` - Bug fixes and error corrections
- `analysis` - Code analysis, research, investigations
- `documentation` - Documentation updates and improvements
- `testing` - Testing implementation and test fixes
- `refactor` - Code refactoring and structure improvements
- `performance` - Performance optimizations and improvements
- `security` - Security enhancements and fixes
- `config` - Configuration changes and updates
- `deployment` - Deployment and infrastructure changes
- `maintenance` - Routine maintenance and cleanup
- `research` - Research and exploration work
- `planning` - Planning and design work
- `review` - Code reviews and assessments
- `general` - General work not fitting other categories

### Common Metadata Keys

- `component` - Which part of the system (e.g., "mcp_client", "database", "ui")
- `severity` - Impact level (low, medium, high, critical)
- `duration` - Time spent (e.g., "2h", "30min")
- `files_changed` - Number of files modified
- `files_modified` - Specific file names (e.g., "src/main.rs,src/database.rs")
- `lines_added` - Lines of code added
- `lines_removed` - Lines of code removed
- `technology` - Tech used (rust, javascript, sql, etc.)
- `issue_id` - Related issue or ticket number
- `pr_id` - Related pull request ID
- `version` - Version or milestone affected

### Examples

```bash
# Feature development
./do "log: feature: Added JWT authentication system | component: auth | duration: 3h | files_changed: 5"

# Bug fixes
./do "log: bugfix: Fixed memory leak in connection pool | component: mcp_client | files_changed: 1 | files_modified: src/connection_pool.rs | lines_added: 5 | lines_removed: 3 | severity: high | duration: 20min"

# Analysis work
./do "log: analysis: Analyzed codebase structure and dependencies | scope: full_codebase | findings: 15_optimization_opportunities"

# Documentation
./do "log: documentation: Updated CLI reference with logging commands | component: documentation | files_modified: docs/cli-reference.md"

# Performance improvements
./do "log: performance: Optimized database queries | component: database | improvement: 50%_faster | queries_affected: 8"
```

### Features

- **Session Tracking** - Automatically links logs to conversation sessions
- **Agent Detection** - Detects AI agent type (Claude Code, Cursor, etc.)
- **JSON Metadata** - Structured storage for rich context
- **Category Parsing** - Automatic parsing with fallback to "general"
- **Database Storage** - Fast querying and analytics
- **Backward Compatibility** - Basic format still works

---

## Natural Language Intent Management

Brain Trust 4 provides natural language commands for discovering, adding, and removing intent mappings. These commands work through the `./do` launcher (see **[cli-entrypoints.md](cli-entrypoints.md)** for optional copy filenames) and provide AI agents with full control over the intent system.

### intent-discovery

Discover all available intent mappings through natural language queries.

**Usage:**
```bash
# Show all intent mappings
./do "show me all intent mappings"

# Show intent mappings for specific categories
./do "show me intent mappings for docker"
./do "show me intent mappings for browser"
./do "show me intent mappings for system"
```

**Examples:**
```bash
# Discover all available intents
./do "show me all intent mappings"
# Output: Lists all 83+ intent mappings with server::tool and priority

# Filter by category
./do "show me intent mappings for docker"
# Output: Shows only docker-related intent mappings
```

**Features:**
- **Complete Discovery** - Shows all available intent mappings
- **Category Filtering** - Filter by docker, browser, system, etc.
- **Usage Examples** - Provides examples of how to use intents
- **Priority Information** - Shows priority levels for each mapping

### intent-add

Add new intent mappings through natural language commands.

**Usage:**
```bash
./do "add intent mapping: keyword → server::tool priority X"
```

**Examples:**
```bash
# Add new intent mapping
./do "add intent mapping: performance → mcp-monitor::get_cpu_info priority 10"
# Output: ✅ ADDED INTENT MAPPING: performance → mcp-monitor::get_cpu_info (priority: 10)

# Add mapping with different priority
./do "add intent mapping: speed → mcp-monitor::get_cpu_info priority 5"
# Output: ✅ ADDED INTENT MAPPING: speed → mcp-monitor::get_cpu_info (priority: 5)
```

**Format:**
- **keyword** - The natural language keyword to trigger the intent
- **server::tool** - The server name and tool name (separated by ::)
- **priority** - Priority level (higher numbers = higher priority)

**Features:**
- **Natural Language** - Use human-readable commands
- **Immediate Effect** - New mappings work instantly
- **Priority Control** - Set priority levels for intent ordering
- **Error Handling** - Clear error messages for invalid formats

### intent-remove

Remove intent mappings through natural language commands.

**Usage:**
```bash
./do "remove intent mapping: keyword"
```

**Examples:**
```bash
# Remove intent mapping
./do "remove intent mapping: performance"
# Output: ✅ REMOVED INTENT MAPPING: 'performance'

# Remove with confirmation
./do "remove intent mapping: old_keyword"
# Output: ✅ REMOVED INTENT MAPPING: 'old_keyword'
```

**Features:**
- **Simple Syntax** - Just specify the keyword to remove
- **Immediate Effect** - Mappings are removed instantly
- **Confirmation** - Shows confirmation of successful removal
- **Error Handling** - Clear messages for non-existent mappings

### Intent Visibility

All intent-based queries now show which intent mapping was used and provide context about available intents.

**Example Output:**
```bash
./do "cpu"
# Output includes:
# 📋 INTENT MAPPING USED: cpu → mcp-monitor::get_cpu_info (priority: 10)
# 🔧 AVAILABLE INTENTS: accessibility, analyze, audit, browser, chrome, clear, console, cpu, debugger, disk
```

**Features:**
- **Intent Transparency** - See exactly which mapping was used
- **Available Context** - Sample of other available intents
- **Priority Information** - Shows priority levels
- **Learning Aid** - Helps understand the intent system

---

## Version Control Commands

### `version`

Show current version information embedded in the binary.

**Usage:**
```bash
./do version
# or
cargo run -- version
```

**Output:**
```
vodou-core v0.7.0
```

**Features:**
- **Embedded Version** - Version comes directly from `Cargo.toml`
- **Binary Integrity** - Version cannot be modified without recompilation
- **Fast Execution** - No database or network calls required

### `update`

Check for, install, or rollback updates safely. All updates take a full DB snapshot first so nothing can be lost.

**Usage:**
```bash
./do update [FLAGS]
```

**Flags:**

| Flag | Purpose |
|---|---|
| (no flag) | Install the latest binary update (with DB snapshot + rollback lock) |
| `--check` | Check only — print what's available, install nothing |
| `--dry-run` | Simulate the update, print what would change, write nothing |
| `--components` | Interactive menu for updating MCP servers, skills, docs, scripts |
| `--all` | Non-interactive: update everything (use with `--components`) |
| `--select=1,2,3` | Non-interactive: update specific components by index |
| `--json` | With `--components --dry-run`: output component list as JSON (for scripting/gateway) |
| `--yes` / `-y` | Skip confirmation prompts |
| `--rollback` | Full rollback to most recent backup (binaries + databases) |
| `--rollback-db` | Restore only database files, keep new binaries |
| `--rollback-binaries` | Restore only binaries, keep new databases |
| `--rollback-from BACKUP_ID` | Rollback to a specific backup |
| `--list-backups` | Show all backups with versions and sizes |
| `--pin-backup BACKUP_ID` | Prevent a backup from auto-pruning |
| `--clean-backups` | Delete unpinned backups (keeps pinned + last 1) |
| `--force` | Bypass `VODOU_AUTO_UPDATE` policy, always run the update |

**Output when up to date:**
```
✅ You're running the latest version: 0.5.38
```

**Output when update available:**
```
🔄 Update available: 0.5.37 → 0.5.38
📝 Release notes:
  • Memory relevance V2 (stopword filter, MMR diversification)
  • Gateway chat redesign with streaming
  • WhatsApp channel support
📸 Taking DB snapshot...
✓ Snapshot saved to backups/pre-update-0.5.37-to-0.5.38-20260410T143000/
⬇️  Downloading update...
✓ Downloaded 248 MB
✓ Checksum verified (SHA256)
🛑 Stopping services...
🔄 Replacing binaries...
✓ Quarantine attributes stripped
🚀 Restarting services...
✓ Update installed successfully!
✨ You're now running v0.5.38.
```

**Safety guarantees:**
- Your databases (`vodou-core.db`, `memory.db`, `gateway.db`, `thinking.db`, `skills_registry.db`) are **never** overwritten by file copy
- Your `.env`, `memory.toml`, `extractors.toml` are **never** replaced
- Your `skills/my-skills/` and `skills/community/` are **never** touched
- The entire `.vodou/workspace/` is **never** modified
- User-added MCP servers (not in the release archive) are **never** deleted
- A full DB snapshot is taken before every update — rollback available via `--rollback`

**Environment Variables:**
- `VODOU_AUTO_UPDATE` — Auto-update policy: `off`, `notify` (default), `on`, or `forced-only`
- `VODOU_USER_ID` — User ID for update tracking
- `VODOU_BACKUP_MEMORY_VECTORS` — Set to `false` to skip vector backup for huge memory.db (schema still backed up)

**Remote endpoints:**
- Calls `https://app.vodou.ai/api/version/check` for version metadata
- Downloads archives from `https://github.com/VodouAI/OS/releases`
- Pinned to `github.com/VodouAI/` domain — other download URLs refused

**See also:** [`docs/version-control.md`](version-control.md) for the full updating guide and FAQ.

---

## context

Return context for IDE hooks (workspace bootstrap + prompt-targeted memories). Used by Claude Code and Cursor hooks to inject Vodou context into every conversation turn.

### Syntax
```bash
vodou-core context [OPTIONS]
```

### Options
- `--base-only` - Workspace bootstrap only (MEMORY, USER, SOUL, AGENTS, etc.) — used by SessionStart hooks
- `--memories-only` - Return only relevant memories + file pointers (lightweight per-prompt mode)
- `--prompt <PROMPT>` - Prompt text for targeted memory lookup
- `--stdin` - Read JSON with prompt from stdin (hook passes through)
- `--json` - Output JSON `{"additional_context": "..."}` format (for Cursor sessionStart)

### Examples
```bash
# Full context (base + memories)
vodou-core context

# SessionStart hook — workspace bootstrap only
vodou-core context --base-only --json

# Per-prompt memory injection
vodou-core context --memories-only --json

# Targeted memory lookup
vodou-core context --memories-only --prompt "how does the scheduler work"

# Stdin mode for hooks
echo '{"prompt":"test"}' | vodou-core context --stdin --memories-only
```

### Notes
- `--memories-only` uses a lightweight DB path (3 PRAGMAs, zero DDL) for fast injection without full `Database::new()`
- `--base-only` reads workspace files directly, no DB required
- Designed for hook performance — exits before heavy initialization when possible

---

## mem

Memory system commands for managing Vodou's memory pipeline.

### Syntax
```bash
vodou-core mem <COMMAND>
```

### Subcommands
| Subcommand | Description |
|------------|-------------|
| `prompt` | Buffer a prompt and optionally return relevant memories (UserPromptSubmit hook) |
| `search` | Hybrid FTS5+vector search of `memory.db` chunks via the daemon socket. Same pipeline BrainLoader uses internally (BGE reranker, scope boost, provenance trust weighting). Flags: `--top-k N` (1-50, default 10), `--json` |
| `flush` | Flush conversation to memory (SessionEnd hook or manual) |
| `setup` | Create workspace, seed templates, or configure Claude Code hooks |
| `promote` | Promote high-value items from last 7 days to MEMORY.md |
| `promote-micro` | Micro-promote: LLM-curate new items from today's daily log to MEMORY.md (runs frequently) |
| `compact` | Compact MEMORY.md (dedupe + weighted rank + cap) |
| `extract-gateway` | Run the gateway memory extractor — pulls new `gateway_messages` rows past the watermark, batches by conversation, writes bullets to today's daily log + indexes to `memory.db`. Auto-runs every 5 min via daemon; this CLI is for backfill / manual cycles. Flags: `--batches N` (default 1), `--sleep-secs N` (default 30, only used when batches > 1) |
| `archive` | Archive daily memory files older than 30 days |
| `janitor` | Run autoDream consolidation pass (orient → signal → consolidate → prune). Use `--force-live` to skip auto dry-run window |
| `config` | Show memory config (extraction provider, flush interval) |
| `test-extract` | Run extraction on transcript from stdin; print bullets only |
| `import` | Universal Memory Lane B — import an export (obsidian/chatgpt/claude/letta/openclaw/pack dir or ZIP), or a single captured conversation via `--stdin-json`. Idempotent per conversation |
| `extract-import` | Foreground-drain an import job's memory extraction: `--job <id> --batches N` |
| `import-undo` | Remove an import job's conversations + memory (coarse per-source) |
| `export` | Export memory as a portable pack (`--format pack` ZIP with embeddings) or markdown digest (`--format digest`). Default-excludes `import:%`. `--vault <name>` exports exactly one vault's members (pack format only) |
| `store` | Write one memory line directly (MCP `memory_store` path): `mem store "<text>" [--tag TAG] [--project ID]`. Scope `import:mcp`. For *correcting* a false fact use `mem correct`, not store alone |
| `correct` | Soft-correct a wrong memory (0.6.19): `mem correct "<right>" --wrong "<snippet>" \| --chunk-id <id> [--tag TAG] [--json]`. Stores the right fact, supersedes loser(s) via `fact_groups::record_supersession` (`invalid_at` hides them from recall). Import/capture losers also get source-line strip + DB delete. Works on **any** scope. See `docs/vodou-memory.md` §Correct / forget / pin |
| `get` | Read memory back by chunk id, path, or path prefix (MCP memory-read path) |
| `similar` | Top-K embedding-similarity neighbors of a chunk ("more like this" by meaning): `mem similar --chunk <id> [--top-k N] [--min-cos τ] [--same-scope-only] [--include-same-file] [--project ID] [--json]`. Read-only; backs the Brain graph's similarity overlay. See `docs/vodou-brain.md` §Similarity edges |
| `reject` | Forget import/capture chunk(s): `mem reject <snippet> \| --chunk-id <id> [--json]`. Hard-delete + strip source markdown. Scoped to `import:%` / `capture:%` — can never delete native memory. MCP: `memory_reject` |
| `pin` / `unpin` | Set or clear `memory_chunks.pinned` (same as POST/DELETE `/api/memory/pin`): `mem pin <chunk-id> [--json]`, `mem unpin <chunk-id> [--json]`. Elevates retrieval via `VODOU_MEMORY_PIN_BOOST`. MCP: `memory_pin` / `memory_unpin` |
| `contradictions` | Review queue for imported-history vs current-memory conflicts: `scan` (LLM-judged, `--max-judgements N` caps spend, judged pairs cache), `list [--all]`, `resolve <id> --keep import\|native` (loser is superseded — demoted, reversible). See `docs/vodou-memory.md` §Contradiction review queue |
| `dedup` | Fact groups (Phase B): `scan` clusters near-duplicates (cosine + lexical gates) and elects canonicals — near-dups with conflicting numbers/dates queue to the review queue instead of grouping; `list` shows groups, `clear [--chunk <id>]` reverses demotions. No LLM. See `docs/vodou-memory.md` §Fact groups |
| `entities` | Entity alias collapse (Phase B #4): `scan` extracts orgs/@handles/name-bigrams and merges aliases (capped LLM pass over co-occurring pairs), `list`, `clear`. Queries mentioning one alias also retrieve chunks using another (FTS-leg expansion, `VODOU_MEMORY_ENTITY_EXPANSION=0` disables). See `docs/vodou-memory.md` §Entity resolution |
| `capture-ide` | Capture local IDE assistant sessions (Phase C W1c): `--source cursor\|claude-code\|all` reads Cursor `state.vscdb` (prompts + generations) / Claude Code JSONL (recent-only, `--since-hours`), lands them `capture:ide:<app>`. `--extract` distils now. Watermarked per store; schedulable via `vodou-core schedule` |
| `vault` | Named, rule-based memory selections for segmented sharing (PLAN-MEMORY-VAULTS): `create|update <name> --scopes a,b --tags X,Y [--project ID] [--since-days N] [--include-imports]`, `list`, `show`, `delete`, `preview` (totals + exact member ids), `include|exclude <name> <chunk-id>` (per-chunk overrides), `clear-override`. Export with `mem export --vault <name>`. See `docs/vodou-memory.md` §Memory vaults |
| `context` | Emit the fenced context block / selected facts for a prompt (the browser-inject path). `mem context "<prompt>" --vault portable [--all-memory] [--top-k N] [--json]`. `--all-memory` searches everything and returns the decomposed, selected facts in `selected` (governed by `.vodou/inject-config.json`). See `docs/memory-follows-you.md` |
| `keygen` | Generate retrieval keys (first-person questions + topic phrases) for unkeyed facts: `mem keygen [--batches N] [--regen-misses]`. `--regen-misses` re-keys still-failing targets with a discriminating prompt |
| `health` | Vault self-test — sample facts, generate fresh natural questions, run the real search pipeline: `mem health [--facts N] [--runs N] [--json]`. Never trust a single draw (`--runs` aggregates). Misses persist to `.vodou/health-regressions.json` |
| `retrieval-bench` | Golden-query retrieval harness (`.vodou/retrieval-golden.json`): recall@1/5, MRR, above-floor. `--init` seeds; `--json` |
| `inject-bench` | **External-LLM inject release gate** (`.vodou/inject-golden.json`): grades `must_inject` / `must_be_silent` / `must_not_leak` against the real inject selection. `--init` seeds. Exit-code gated. See `docs/memory-follows-you.md` §5 |
| `reembed` / `reextract` | Bounded, resumable drains — see [memory-extraction-pipeline.md](memory-extraction-pipeline.md) §Drains |

### Examples
```bash
# Hybrid search of memory.db chunks (routes through daemon)
vodou-core mem search "fundraising narrative" --top-k 5
vodou-core mem search "fundraising" --json | jq '.results[].path'

# Project-filtered recall (PLAN-PROJECT-SCOPED-MEMORY) — other projects' chunks
# are excluded; global (NULL-project) chunks always surface
vodou-core mem search "client pricing" --project proj_abc123 --json

# Show memory configuration
vodou-core mem config

# Test extraction pipeline (diagnostic — reads stdin, prints to stdout, no DB)
echo "Decision: use Rust for performance" | vodou-core mem test-extract

# Flush session memories (preferred: use vodou-hook-bin)
./vodou-hook-bin sock flush

# Promote high-value memories to MEMORY.md
vodou-core mem promote

# Correct a false fact (store winner + soft-supersede loser; prefer over bare store)
vodou-core mem correct "Dr. Patel is Chad's sleep apnea doctor, not Lucy's vet." \
  --wrong "Lucy's eval vet" --tag CORRECTION --json

# Forget an import/capture chunk (native → use correct, not reject)
vodou-core mem reject --chunk-id 'memory/imports/mcp/store-2026-07.md:7:abc123' --json

# Pin / unpin (same as Memory UI toggle)
vodou-core mem pin 'memory/2026-07-17.md:851:731d114c' --json
vodou-core mem unpin 'memory/2026-07-17.md:851:731d114c' --json

# Archive old daily logs (>30 days)
vodou-core mem archive

# Run memory janitor (auto dry-run for first 3 invocations, then live)
vodou-core mem janitor

# Force live janitor run (skips the 3-run dry-run safeguard — DESTRUCTIVE)
vodou-core mem janitor --force-live

# Create workspace and seed templates
vodou-core mem setup

# Single gateway extractor cycle (catches up since last watermark)
vodou-core mem extract-gateway --batches 1

# Backfill historical gateway content — 25 cycles × 30s sleep ≈ 13 min
vodou-core mem extract-gateway --batches 25 --sleep-secs 30

# Find conflicts between imported history and current memory (LLM-judged, capped;
# already-judged pairs are skipped, so re-scans only spend on new pairs)
vodou-core mem contradictions scan --max-judgements 25

# Review and resolve ("history says X, memory says Y — keep which?")
vodou-core mem contradictions list
vodou-core mem contradictions resolve 31 --keep native   # memory wins: import chunk superseded (demoted, reversible)
vodou-core mem contradictions resolve 31 --keep import   # history wins: memory chunk superseded (demoted, reversible)

# Cluster duplicate facts (re-extracted across daily logs / imports) — canonical
# copy keeps its rank, the rest are demoted (reversible, nothing deleted)
vodou-core mem dedup scan
vodou-core mem dedup list --limit 10
vodou-core mem dedup clear --chunk 'memory/2026-06-17.md:104:7ca71f3c'

# Entity alias collapse — "Jim Abraham" / "abraham" / "@handle" become one entity;
# queries via any spelling retrieve chunks that use another
vodou-core mem entities scan
vodou-core mem entities list --limit 10

# Memory vaults — share a named subset, not everything ("family vault, not bank vault")
vodou-core mem vault create work --scopes web,capture:ide --tags DECISION,PATTERN
vodou-core mem vault preview work                # exact membership before sharing
vodou-core mem vault exclude work 'memory/2026-07-01.md:12:ab34cd56'
vodou-core mem export --vault work               # pack ZIP of exactly those chunks
```

### Notes
- **Preferred entry points for hooks:** `./vodou-hook-bin sock prompt` (UserPromptSubmit) and `./vodou-hook-bin sock flush` (SessionEnd). These talk to the daemon via Unix socket — no direct DB access, no UE zombie risk on macOS.
- `vodou-core mem flush` and `mem prompt` are the low-level equivalents. They open the DB directly and can cause UE zombie accumulation under concurrent hook load. Use only for diagnostics.
- `vodou-core mem search` does **not** open `memory.db` in the CLI process — it sends the query to the daemon's `cmd:"search"` socket (the same path BrainLoader uses) and prints the response. Requires a running daemon. This is the right call for agents/LLMs that want hybrid search; prefer it over raw `sqlite3 memory.db "... MATCH ..."`, which skips the BGE reranker, scope boost, provenance trust weighting, and project filter. `--project <id>` scopes recall to one gateway Project (see `docs/vodou-memory.md` §Project axis). Note: distinct from **Vodou-Recall**'s `search_conversation` tool, which searches gateway chat turns (`gateway.db`), not memory chunks.
- `vodou-core mem test-extract` is safe (no DB, reads stdin, prints to stdout) — use for testing extraction pipelines.
- `mem promote`, `mem compact`, `mem archive`, and `mem janitor` are typically scheduled via `vodou-core schedule` (the worker auto-registers them when their corresponding env vars are enabled).
- `mem extract-gateway` runs **automatically every 5 min** via a tokio task in the daemon (not via the scheduler). The CLI is for one-off / backfill use. Channel content is opt-in — toggle from the **Memory Extraction Sources** card on `/#/system` or directly: `sqlite3 MCP-servers/Vodou-Console/gateway.db "INSERT OR REPLACE INTO gateway_settings (key, value) VALUES ('gateway_extractor_channels_enabled', 'true');"`
- `mem janitor` runs the four-phase consolidation pipeline: orient → gather signal → consolidate → prune. **First 3 invocations are auto dry-run** for safety (writes a report to `memory/janitor-YYYY-MM-DD.md` but makes no DB changes). After 3 dry runs, the next run is live. See [vodou-memory.md](./vodou-memory.md) for full details.
- Memory data lives in `memory.db` (separate from `vodou-core.db`)

---

## continuity

Manage the cross-surface user-identity primitive (added v0.5.74). The principal table lives in `vodou-core.db`; `principal_id` columns on `memory_chunks`, `gateway_messages`, and `gateway_conversations` carry attribution. See [vodou-memory.md § Continuity primitive](./vodou-memory.md#continuity-primitive-added-v0574) for the conceptual overview.

### Syntax

```bash
vodou-core continuity <SUBCOMMAND> [OPTIONS]
```

### Subcommands

#### `init`
Idempotent. Seeds the install-owner principal from `VODOU_USER_EMAIL` / `VODOU_USER_NAME` env vars (if set) and backfills `principal_id` on legacy `memory_chunks` and `gateway_messages` rows. Safe to re-run.

```bash
vodou-core continuity init
# ✅ Seeded self-principal: principal:self:1770000000000000
# ✅ Backfilled 8756 memory_chunks rows
# ✅ Backfilled 4419 gateway_messages + 138 gateway_conversations rows
```

#### `list-principals`
Prints all principals in `vodou-core.db`. Today: `self` + `assistant`. Future (Phase 3 multi-principal): one row per resolved alias.

```bash
vodou-core continuity list-principals
# principal:self:1770000000000000 | Alex           | user@example.com | self
# principal:assistant            | Vodou Assistant | (none)          | assistant
```

#### `update-self [--name <NAME>] [--email <EMAIL>]`
Updates the install-owner principal's display fields. At least one flag required. No daemon restart needed.

```bash
vodou-core continuity update-self --name Alex --email user@example.com
# ✅ self-principal updated: id=principal:self:1770000000000000, display_name=Alex, email=user@example.com
```

#### `reassign --from <ID> --to <ID>`
Soft-merges two principals — sets `merged_into = <to>` on the source, preserving the row for an unmerge window. Rejects assistant-principal participation and self-merges. Phase 3 (multi-principal) feature; not commonly needed in single-principal installs.

### Notes

- All four subcommands are idempotent / non-destructive. Reassign is *recoverable* (soft-delete pattern) within the unmerge window.
- For SLO + resolver-cache health, see `runtime-status --json` field `components.continuity` (documented in [runtime-observability.md](./runtime-observability.md)).
- Lint enforcement: `scripts/lint-continuity-boundary.sh` bans direct `INSERT INTO gateway_messages` and direct `MemorySearch::search_*` calls outside the `record_turn` / `recall` chokepoints.

---

## daemon

Memory daemon for file watching, re-indexing, and scheduled task execution.

### Syntax
```bash
vodou-core daemon <COMMAND>
```

### Subcommands
| Subcommand | Description |
|------------|-------------|
| `start` | Start memory daemon (watches MEMORY.md and memory/ for changes) |
| `ensure` | Ensure daemon is running (start if not, no-op if already running) |
| `install` | Install daemon for 24/7 operation (launchd on macOS, systemd on Linux) |
| `uninstall` | Remove installed daemon service |

### Examples
```bash
# Start daemon in foreground
vodou-core daemon start

# Ensure daemon is running (safe to call repeatedly)
vodou-core daemon ensure

# Install as macOS launchd agent (auto-start on login)
vodou-core daemon install

# Remove installed daemon
vodou-core daemon uninstall
```

### Notes
- Daemon owns `memory.db` — handles file watching, memory sync, prompt buffering, and scheduled tasks
- Communicates with hooks and CLI via Unix socket (`.vodou/daemon.sock`)
- WAL checkpoints every 10 minutes
- Scheduler ticks every 60 seconds to fire overdue tasks
- Installed as `com.oios.oi-daemon` launchd agent on macOS

---

## sock

Socket relay — send commands to the daemon via Unix socket without opening the database.

### Syntax
```bash
vodou-core sock [OPTIONS] <CMD>
```

### Arguments
- `<CMD>` - Command to send: `prompt`, `flush`, `status`

### Options
- `--stdin` - Read hook JSON from stdin

### Examples
```bash
# Check daemon status
vodou-core sock status

# Send prompt for memory search
echo '{"prompt":"test query"}' | vodou-core sock prompt

# Trigger session flush
vodou-core sock flush
```

### Notes
- Zero DB contention — communicates via Unix socket only
- Used internally by `vodou-hook-bin` for hook operations
- Falls back gracefully if daemon is not running

---

## schedule

Manage scheduled tasks for the autonomous scheduler.

### Syntax
```bash
vodou-core schedule <COMMAND>
```

### Subcommands
| Subcommand | Description |
|------------|-------------|
| `list` | List all scheduled tasks |
| `add` | Add a scheduled task |
| `remove` | Remove a scheduled task by ID |
| `approve-autonomous` | Allow autonomous tasks to run (creates `.vodou/autonomous_approved`) |

### Examples
```bash
# List all scheduled tasks
vodou-core schedule list

# Add a task with cron schedule
vodou-core schedule add --name "weekly-promote" --schedule "0 0 * * 0" --command "mem promote"

# Add a task with interval
vodou-core schedule add --name "hourly-health" --schedule "every 1h" --command "health-check"

# Remove a scheduled task
vodou-core schedule remove 3

# Allow autonomous tasks
vodou-core schedule approve-autonomous
```

### Notes
- Schedule formats: cron (`"0 0 * * 0"`), intervals (`"every Nh"`), time-based (`"at HH:MM"`), one-shot (`"in Nh"`)
- Rate limit: max 20 runs per day per task
- Lock file: `.vodou/scheduler.lock`
- Requires running daemon to execute tasks

---

## hook

Manage lifecycle hooks (PreToolUse, PostToolUse, etc.).

### Syntax
```bash
vodou-core hook <COMMAND>
```

### Subcommands
| Subcommand | Description |
|------------|-------------|
| `list` | List all registered hooks |
| `add` | Add a new hook |
| `remove` | Remove a hook by ID |
| `enable` | Enable a hook |
| `disable` | Disable a hook |
| `test` | Test a hook by ID |

### Examples
```bash
# List all hooks
vodou-core hook list

# Add a new hook
vodou-core hook add --name "pre-call" --event PreToolUse --command "echo pre-call"

# Remove a hook
vodou-core hook remove 1

# Test a hook
vodou-core hook test 1
```

---

## log

Log work directly to Brain Trust via CLI.

### Syntax
```bash
vodou-core log <MESSAGE>
```

### Arguments
- `<MESSAGE>` - Log message in format `"category: description | key: value"`

### Examples
```bash
# Basic log
vodou-core log "Updated CLI documentation"

# With category
vodou-core log "feature: Added JWT authentication"

# With metadata
vodou-core log "bugfix: Fixed memory leak | component: connection_pool | severity: high"
```

### Notes
- Direct CLI access to the work logging system (see also [`log:`](#log) for the `./do` launcher format)
- Stores in `work_logs` table with session tracking and agent detection

---

## enable

Enable a previously disabled MCP server.

### Syntax
```bash
vodou-core enable <NAME>
```

### Arguments
- `<NAME>` - Server name to enable

### Examples
```bash
# Enable a server
vodou-core enable mcp-monitor
```

### Output
```
✅ Server 'mcp-monitor' enabled successfully
```

---

## disable

Disable an MCP server without removing it. Disabled servers are skipped during health checks and tool routing.

### Syntax
```bash
vodou-core disable <NAME>
```

### Arguments
- `<NAME>` - Server name to disable

### Examples
```bash
# Disable a server
vodou-core disable mcp-monitor
```

### Output
```
✅ Server 'mcp-monitor' disabled successfully
```

---

## clear-cache

Clear the parameter cache used for tool call parameter extraction.

### Syntax
```bash
vodou-core clear-cache
```

### Examples
```bash
vodou-core clear-cache
```

### Output
```
✅ Parameter cache cleared successfully
```

---

## bootstrap

First-run workspace setup: create `.vodou/workspace/` directory structure, seed template files (MEMORY.md, USER.md, SOUL.md, IDENTITY.md, TOOLS.md, AGENTS.md), and configure hooks.

### Syntax
```bash
vodou-core bootstrap [OPTIONS]
```

### Options
- `--workspace <WORKSPACE>` - Custom workspace path

### Examples
```bash
# Bootstrap with defaults
vodou-core bootstrap

# Bootstrap with custom workspace
vodou-core bootstrap --workspace /path/to/project
```

### Notes
- Safe to run only once — intended for first-run setup
- Creates the `.vodou/workspace/` directory with all template files
- Sets up the memory system directory structure

---

## scan

Scan a GitHub repository for MCP server information without installing it.

### Syntax
```bash
vodou-core scan [OPTIONS] <URL>
```

### Arguments
- `<URL>` - GitHub repository URL to scan

### Options
- `--detailed` - Show detailed analysis including README and package files
- `--format <FORMAT>` - Output format: `text`, `json` (default: `text`)

### Examples
```bash
# Quick scan
vodou-core scan https://github.com/user/mcp-server

# Detailed scan with README analysis
vodou-core scan --detailed https://github.com/user/mcp-server

# JSON output
vodou-core scan --format json https://github.com/user/mcp-server
```

---

## mcp-server

Run Vodou as an MCP server itself, enabling Cursor and other MCP clients to connect to Vodou's tools.

### Syntax
```bash
vodou-core mcp-server [OPTIONS]
```

### Options
- `--tool <TOOL>` - Specific tool to expose (optional; exposes all if omitted)

### Examples
```bash
# Run as MCP server (exposes all tools)
vodou-core mcp-server

# Expose only a specific tool
vodou-core mcp-server --tool context
```

### Notes
- Enables Cursor integration — Cursor connects to Vodou as an MCP server
- Runs in STDIO mode for direct process communication

---

## backfill-metadata

Backfill existing servers with Enhanced MCP Orchestration metadata (connection type, health status, capabilities hash, etc.).

### Syntax
```bash
vodou-core backfill-metadata [OPTIONS]
```

### Options
- `--force` - Force update all servers (overwrite existing metadata)

### Examples
```bash
# Backfill missing metadata
vodou-core backfill-metadata

# Force re-backfill all servers
vodou-core backfill-metadata --force
```

---

## migrate-rules

Migrate parameter extraction rules from JSON files to the database (KISS Phase 2).

### Syntax
```bash
vodou-core migrate-rules [OPTIONS]
```

### Options
- `--verify` - Verify migration integrity after completion
- `--performance-test` - Run performance test comparing database vs JSON

### Examples
```bash
# Migrate rules
vodou-core migrate-rules

# Migrate with verification
vodou-core migrate-rules --verify

# Run performance comparison
vodou-core migrate-rules --performance-test
```

---

## auto-generate-rules

Auto-generate parameter extraction rules from MCP server schemas (KISS Phase 3).

### Syntax
```bash
vodou-core auto-generate-rules [OPTIONS] [SERVER_NAME]
```

### Arguments
- `[SERVER_NAME]` - Server name to generate rules for (optional; generates for all if omitted)

### Options
- `--verbose` - Show verbose output during generation
- `--test` - Test the generated rules immediately

### Examples
```bash
# Generate rules for all servers
vodou-core auto-generate-rules

# Generate for specific server
vodou-core auto-generate-rules mcp-monitor

# Generate with testing
vodou-core auto-generate-rules --test --verbose mcp-monitor
```

---

## self-improve-run

Run headless self-improve agent (for scheduler or manual invocation). Uses `scripts/self_improve_run.py`.

### Syntax
```bash
vodou-core self-improve-run
```

### Examples
```bash
vodou-core self-improve-run
```

### Notes
- Autonomous planning and execution agent
- Typically scheduled via `vodou-core schedule`
- Requires `scripts/self_improve_run.py` to be present

---

## self-improve-dashboard

Open local dashboard with live log, history, and Start/Stop controls. Uses `scripts/self_improve_dashboard.py`.

### Syntax
```bash
vodou-core self-improve-dashboard
```

### Examples
```bash
vodou-core self-improve-dashboard
```

### Notes
- Launches a local web UI for monitoring self-improvement runs
- Shows live execution log, run history, and manual controls

---

## test-tracking

Test EC2 tracking endpoint connectivity and authentication.

### Syntax
```bash
vodou-core test-tracking
```

### Examples
```bash
vodou-core test-tracking
```

### Notes
- Verifies connectivity to the Vodou usage tracking endpoint
- Tests authentication credentials

---

## conversation

Parent command for managing conversation recordings and analytics.

### Syntax
```bash
vodou-core conversation <COMMAND>
```

See individual subcommand sections: [`conversation list`](#conversation-list), [`conversation show`](#conversation-show), [`conversation analytics`](#conversation-analytics), [`conversation bottlenecks`](#conversation-bottlenecks), [`conversation export`](#conversation-export), [`conversation cleanup`](#conversation-cleanup), [`conversation metrics`](#conversation-metrics), [`conversation context`](#conversation-context), [`conversation insights`](#conversation-insights), [`conversation session-metrics`](#conversation-session-metrics).

---

## Chaining MCP Servers

**One of Vodou's most powerful features**: Extract data from one MCP server and use it as input to another server, creating powerful automation workflows.

### Overview

MCP servers use JSON-RPC protocol (not traditional stdin/stdout pipes), so direct piping isn't possible. However, you can extract data using clean mode and shell variables to chain operations between servers.

### The Basic Pattern

```bash
# Step 1: Extract data from Server 1 (using clean mode + jq)
DATA=$(./do -c server1-tool 2>/dev/null | tail -n +3 | jq '.field')

# Step 2: Use that data with Server 2
./do "server2-tool with ${DATA}"
```

**Why this works:**
- Clean mode (`-c`) gives you raw JSON output
- `jq` extracts specific fields from JSON
- Shell variables pass data between commands
- Vodou's natural language processing handles the integration

### Real-World Example: Monitor & Log

```bash
# Get CPU usage from mcp-monitor
CPU_USAGE=$(./do -c performance 2>/dev/null | tail -n +3 | jq '.usage_percent[0]')

# Log it to Vodou memory system
./do "add log entry CPU usage is ${CPU_USAGE}%"
```

**What happens:**
1. `./do -c performance` → Gets CPU data in JSON format
2. `2>/dev/null` → Suppresses error messages
3. `tail -n +3` → Skips instruction text, gets just JSON
4. `jq '.usage_percent[0]'` → Extracts the first CPU usage percentage
5. Variable stores the value (e.g., `25.87`)
6. `./do "add log entry..."` → Passes value to Vodou memory system
7. Vodou saves: "CPU usage is 25.87%"

### Complete System Health Monitoring Script

```bash
#!/bin/bash
# Collect all system metrics and log to Vodou memory

echo "Collecting system metrics..."

# Extract CPU usage
CPU_USAGE=$(./do -c cpu 2>/dev/null | tail -n +3 | jq '.usage_percent[0]')

# Extract memory usage
MEM_USAGE=$(./do -c memory 2>/dev/null | tail -n +3 | jq '.virtual.used_percent')

# Extract disk usage
DISK_USAGE=$(./do -c disk 2>/dev/null | tail -n +3 | jq '.usage.usedPercent')

# Create timestamp
TIMESTAMP=$(date +%Y-%m-%d)

# Log to Vodou memory with structured format
./do "add log entry ${TIMESTAMP}-System-Health-CPU:${CPU_USAGE}% Memory:${MEM_USAGE}% Disk:${DISK_USAGE}%"

echo "✅ Metrics logged: CPU ${CPU_USAGE}%, Memory ${MEM_USAGE}%, Disk ${DISK_USAGE}%"
```

### Advanced Example: Conditional Logging

```bash
#!/bin/bash
# Only log when CPU usage exceeds threshold

CPU_USAGE=$(./do -c performance 2>/dev/null | tail -n +3 | jq '.usage_percent[0]')
THRESHOLD=80

# Check if CPU usage is high (requires bc for floating point comparison)
if (( $(echo "$CPU_USAGE > $THRESHOLD" | bc -l) )); then
    ./do "add log entry ⚠️ High CPU usage detected: ${CPU_USAGE}%"
    echo "Alert: CPU usage is ${CPU_USAGE}%"
else
    echo "CPU usage normal: ${CPU_USAGE}%"
fi
```

### Extracting Multiple Fields

```bash
# Get multiple values from one query
CPU_DATA=$(./do -c cpu 2>/dev/null | tail -n +3)
CPU_USAGE=$(echo "$CPU_DATA" | jq '.usage_percent[0]')
CPU_CORES=$(echo "$CPU_DATA" | jq '.core_count')
CPU_MODEL=$(echo "$CPU_DATA" | jq -r '.info[0].modelName')

# Use all values
./do "add log entry System: ${CPU_MODEL} with ${CPU_CORES} cores, usage: ${CPU_USAGE}%"
```

### Chaining Multiple Servers

```bash
# Get screenshot from browser-tools
./do screenshot

# Get console errors
ERRORS=$(./do -c console 2>/dev/null | tail -n +3 | jq 'length')

# Log to Vodou memory
./do "add log entry Screenshot taken, ${ERRORS} console errors found"
```

### Using jq for Complex Extraction

```bash
# Extract nested JSON fields
MEM_DATA=$(./do -c memory 2>/dev/null | tail -n +3)
VIRTUAL_USED=$(echo "$MEM_DATA" | jq '.virtual.used')
VIRTUAL_TOTAL=$(echo "$MEM_DATA" | jq '.virtual.total')
SWAP_USED=$(echo "$MEM_DATA" | jq '.swap.used')

# Calculate percentage manually if needed
MEM_PERCENT=$(echo "scale=2; ($VIRTUAL_USED / $VIRTUAL_TOTAL) * 100" | bc)

# Log detailed memory info
./do "add log entry Memory: ${MEM_PERCENT}% used (${VIRTUAL_USED} / ${VIRTUAL_TOTAL}), Swap: ${SWAP_USED}"
```

### Common Patterns

#### Pattern 1: Extract → Log
```bash
VALUE=$(./do -c tool1 2>/dev/null | tail -n +3 | jq '.field')
./do "add log entry Value is ${VALUE}"
```

#### Pattern 2: Extract → Condition → Action
```bash
VALUE=$(./do -c tool1 2>/dev/null | tail -n +3 | jq '.field')
if [ "$VALUE" -gt 80 ]; then
    ./do "add log entry Alert: High value ${VALUE}"
fi
```

#### Pattern 3: Extract → Transform → Use
```bash
RAW=$(./do -c tool1 2>/dev/null | tail -n +3 | jq '.field')
FORMATTED=$(printf "%.2f" "$RAW")
./do "add log entry Formatted value: ${FORMATTED}"
```

#### Pattern 4: Multiple Extractions → Combined Log
```bash
CPU=$(./do -c cpu 2>/dev/null | tail -n +3 | jq '.usage_percent[0]')
MEM=$(./do -c memory 2>/dev/null | tail -n +3 | jq '.virtual.used_percent')
./do "add log entry System: CPU ${CPU}%, Memory ${MEM}%"
```

### Tips for Successful Chaining

#### 1. Always Use Clean Mode for Extraction
```bash
# ✅ Good - clean JSON output
DATA=$(./do -c cpu 2>/dev/null | tail -n +3 | jq '.field')

# ❌ Avoid - formatted output is hard to parse
DATA=$(./do cpu | grep "usage")
```

#### 2. Handle Errors Gracefully
```bash
# ✅ Good - handles missing data
CPU_USAGE=$(./do -c cpu 2>/dev/null | tail -n +3 | jq '.usage_percent[0]' 2>/dev/null || echo "0")
./do "add log entry CPU: ${CPU_USAGE}%"
```

#### 3. Use `tail -n +3` to Skip Instruction Text
```bash
# Clean mode includes instruction text, skip it
JSON=$(./do -c tool 2>/dev/null | tail -n +3)
```

#### 4. Validate Data Before Using
```bash
CPU_USAGE=$(./do -c cpu 2>/dev/null | tail -n +3 | jq '.usage_percent[0]')

# Check if value is valid
if [ -z "$CPU_USAGE" ] || [ "$CPU_USAGE" = "null" ]; then
    echo "Error: Could not get CPU usage"
    exit 1
fi

./do "add log entry CPU: ${CPU_USAGE}%"
```

#### 5. Use `jq -r` for String Values (No Quotes)
```bash
# ✅ Good - removes JSON quotes from strings
MODEL=$(./do -c cpu 2>/dev/null | tail -n +3 | jq -r '.info[0].modelName')
# Result: Apple M1 Pro (no quotes)

# ❌ Avoid - includes quotes
MODEL=$(./do -c cpu 2>/dev/null | tail -n +3 | jq '.info[0].modelName')
# Result: "Apple M1 Pro" (with quotes)
```

### Why This Is Powerful

**Traditional Approach** (without chaining):
```bash
# Manual process - multiple steps, copy-paste values
./do cpu                    # Check CPU
# Manually note: 25.87%
./do "add log entry CPU usage is 25.87%"  # Type it manually
```

**With Chaining** (automated):
```bash
# One command - fully automated
CPU_USAGE=$(./do -c cpu 2>/dev/null | tail -n +3 | jq '.usage_percent[0]') && \
./do "add log entry CPU usage is ${CPU_USAGE}%"
```

**Benefits:**
- ✅ **Automated**: No manual copying
- ✅ **Accurate**: No typos or mistakes
- ✅ **Scalable**: Works in scripts and cron jobs
- ✅ **Flexible**: Chain any servers together
- ✅ **Powerful**: Create complex workflows

### Example Workflows

#### Daily System Health Report
```bash
#!/bin/bash
# Run daily to track system health over time

DATE=$(date +%Y-%m-%d)
CPU=$(./do -c cpu 2>/dev/null | tail -n +3 | jq '.usage_percent[0]')
MEM=$(./do -c memory 2>/dev/null | tail -n +3 | jq '.virtual.used_percent')
DISK=$(./do -c disk 2>/dev/null | tail -n +3 | jq '.usage.usedPercent')

./do "add log entry ${DATE}-Daily-Health-CPU:${CPU}% MEM:${MEM}% DISK:${DISK}%"
```

#### Performance Alert System
```bash
#!/bin/bash
# Alert when resources are high

CPU=$(./do -c cpu 2>/dev/null | tail -n +3 | jq '.usage_percent[0]')
MEM=$(./do -c memory 2>/dev/null | tail -n +3 | jq '.virtual.used_percent')

if (( $(echo "$CPU > 80" | bc -l) )); then
    ./do "add log entry ⚠️ High CPU: ${CPU}%"
fi

if (( $(echo "$MEM > 90" | bc -l) )); then
    ./do "add log entry ⚠️ High Memory: ${MEM}%"
fi
```

#### Screenshot + Error Logging
```bash
#!/bin/bash
# Take screenshot and log any errors found

./do screenshot
ERROR_COUNT=$(./do -c console 2>/dev/null | tail -n +3 | jq 'length')
TIMESTAMP=$(date +%Y-%m-%d-%H%M%S)

./do "add log entry ${TIMESTAMP}-Screenshot-${ERROR_COUNT}-errors"
```

### Troubleshooting Chaining

#### Problem: `jq` command not found
```bash
# Install jq
# macOS:
brew install jq

# Linux:
sudo apt-get install jq
# or
sudo yum install jq
```

#### Problem: Getting "null" values
```bash
# Check the JSON structure first
./do -c cpu 2>/dev/null | tail -n +3 | jq '.'

# Verify the field path exists
./do -c cpu 2>/dev/null | tail -n +3 | jq '.usage_percent'
```

#### Problem: Variable is empty
```bash
# Add debugging
CPU_USAGE=$(./do -c cpu 2>/dev/null | tail -n +3 | jq '.usage_percent[0]')
echo "Debug: CPU_USAGE = '${CPU_USAGE}'"  # Check what you got

# Validate before using
if [ -z "$CPU_USAGE" ]; then
    echo "Error: Failed to get CPU usage"
    exit 1
fi
```

### Quick Reference: Chaining Commands

```bash
# Basic extraction
DATA=$(./do -c tool 2>/dev/null | tail -n +3 | jq '.field')

# Extract number
NUMBER=$(./do -c tool 2>/dev/null | tail -n +3 | jq '.number')

# Extract string (no quotes)
STRING=$(./do -c tool 2>/dev/null | tail -n +3 | jq -r '.string')

# Extract array element
ELEMENT=$(./do -c tool 2>/dev/null | tail -n +3 | jq '.array[0]')

# Extract nested field
NESTED=$(./do -c tool 2>/dev/null | tail -n +3 | jq '.parent.child')

# Count array length
COUNT=$(./do -c tool 2>/dev/null | tail -n +3 | jq 'length')

# Use in another command
./do "server2-tool with ${DATA}"
```

**💡 Pro Tip**: Start with simple extractions and build up to complex workflows. Test each step individually before chaining them together!

---

**Next:** [Examples](examples.md) - Real-world usage patterns and workflows