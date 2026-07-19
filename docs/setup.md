# Vodou Setup Guide

Complete setup guide for Vodou - an intelligent MCP orchestrator.

## 🎯 **Quick Start (5 Minutes)**

For a complete Vodou installation with all features:

```bash
# 1. Build the system
cargo build --release

# 2. Start all required services (one-time setup)
./start-vodou-services.sh

# 3. Sync Docker servers (if Docker Desktop available)
./do sync-docker

# 4. Test the system
./do "cpu memory disk analyze codebase"

# 5. Verify everything works
./do health-check

# Optional: Connect to remote servers (see Remote Server Setup below)
```

## 📋 **System Prerequisites**

### **Required Dependencies**
- **Rust** - For building Vodou from source
- **SQLite** - Built into Vodou (system SQLite helpful for debugging)
- **Git** - For repository operations and server installation

### **Optional Dependencies (for full functionality)**
- **Node.js & npm** - For NPM-based MCP servers (file operations, web tools)
- **Docker Desktop** - For Docker Gateway servers (12 servers including search, weather, browser automation)
- **Internet connectivity** - For server installation and external registries

### **Installation Commands by Platform**

**macOS:**
```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install optional dependencies
brew install node sqlite3 docker

# Install Docker Desktop from: https://www.docker.com/products/docker-desktop/
```

**Ubuntu/Debian:**
```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install optional dependencies
sudo apt update
sudo apt install nodejs npm sqlite3 docker.io

# Start Docker service
sudo systemctl start docker
sudo systemctl enable docker
```

**Windows:**
```bash
# Install Rust from: https://rustup.rs/
# Install Node.js from: https://nodejs.org/
# Install Docker Desktop from: https://www.docker.com/products/docker-desktop/
# Install SQLite from: https://www.sqlite.org/download.html
```

## 🚀 **Installation Steps**

### **Step 1: Build Vodou**

```bash
# Clone or navigate to Vodou directory
cd vodou-core

# Build the system
cargo build --release

# Verify build
./target/release/vodou-core --help
```

### **Step 2: Start Required Services**

The `start-vodou-services.sh` script handles all critical background services:

```bash
# Start all required services (one-time setup)
./start-vodou-services.sh
```

**What this script does:**
- ✅ **Starts Docker Gateway Service** - Required for 12 Docker servers
- ✅ **Starts Browser Tools MCP** - Required for screenshots and browser automation
- ✅ **Configures Auto-Start** - Services start automatically on terminal launch
- ✅ **Verifies Services** - Confirms all services are running

**⚠️ IMPORTANT**: The Browser Tools MCP server requires a Chrome extension to function. See [Browser Extension Installation](browser-extension-installation.md) for setup instructions.

**Expected output:**
```
🚀 Setting up Vodou Auto-Start for your system...
📍 Vodou Directory: /path/to/vodou-core
✅ Vodou auto-start configured in ~/.bashrc
🔄 Please restart your terminal or run: source ~/.bashrc

💡 This will automatically start Vodou services every time you open a terminal
🛑 To disable: Remove the Vodou Auto-Start section from ~/.bashrc

🔄 Now starting services...
🚀 Starting Vodou Required Services...
🐳 Starting Docker Gateway...
✅ Docker Gateway started (PID: 12345)
🌐 Checking Browser Tools...
   ✅ Browser Tools already running
⏳ Waiting for services to initialize...
🔍 Verifying services...
✅ Docker Gateway running (PID: 12345)
✅ Browser Tools: Running
🎯 Vodou Services startup complete!
```

### **Step 3: Sync Docker Servers (Optional)**

If you have Docker Desktop installed, sync the available Docker MCP servers:

```bash
# Sync Docker Desktop MCP servers with Vodou
./do sync-docker
```

**What this does:**
- 🔍 **Reads Docker Desktop registry** - `~/.docker/mcp/registry.yaml`
- 📦 **Auto-discovers servers** - Finds all available Docker MCP servers
- 🔧 **Auto-discovers tools** - Finds all tools for each server
- 🎯 **Auto-generates parameters** - Creates parameter rules for intelligent tool calls
- 💾 **Stores in database** - Adds servers to Vodou database

**Expected output:**
```
🐳 Syncing Docker Desktop MCP servers with Vodou...
   ✅ Added: docker-duckduckgo
   🔧 Auto-discovered 2 tools
   🎯 Auto-generated 2 parameter rules
   ✅ Added: docker-fetch
   🔧 Auto-discovered 1 tools
   🎯 Auto-generated 1 parameter rules
   ✅ Added: docker-chrome-devtools-mcp
   🔧 Auto-discovered 3 tools
   🎯 Auto-generated 3 parameter rules
🎯 Sync complete: 12 servers processed, 12 new servers added
```

### **Step 4: Install Additional Servers (Optional)**

Install additional MCP servers for enhanced functionality:

```bash
# Install file system operations
./do install filesystem

# Install database operations
./do install postgres

# Search for more servers
./do search "web search"
./do search "code analysis"
./do search "browser automation"
```

### **Step 5: Verify Installation**

Test that everything is working correctly:

```bash
# Test intent-based execution (parallel)
./do "cpu memory disk analyze codebase"

# Check server health
./do health-check

# List all connected servers
./do list

# Test specific functionality
./do "search for rust programming"
./do "take a screenshot"
./do "what is the weather in new york"
```

## Web gateway and messaging

When **`START_AIGATEWAY=1`** (default in **`.env.example`**) and dependencies are installed, the **web UI** is served on **`WEB_PORT`** (default **8765**):

- Open **http://localhost:8765** (or your host/port) for chat, **Messaging**, capabilities, memory, and settings.
- Use **[messaging.md](messaging.md)** for Slack, Telegram, Discord, and WhatsApp: tokens live in **`.env`**; follow **`.env.example`**.
- IDEs and tools can use the local **OpenAI-compatible** HTTP API — see **[openai-compatible-api.md](openai-compatible-api.md)**.

If the page does not load, confirm the gateway process started with `./start-vodou-services.sh` (or your orchestration script) and that nothing else is bound to the same port.

## 🔧 **Configuration**

### **Environment Variables**

Create a `.env` file for API keys and configuration:

```bash
# Create .env file
cat > .env << EOF
# StackOverflow API key (for rate limits)
STACKOVERFLOW_API_KEY=your_api_key_here

# OpenWeather API key (for weather data)
OWM_API_KEY=your_weather_api_key_here

# Debug mode (optional)
DEBUG=true
EOF
```

### **Shell Profile Configuration**

The `start-vodou-services.sh` script automatically configures your shell profile. If you need to configure manually:

**Bash (.bashrc):**
```bash
# Add to ~/.bashrc
if [ -f "/path/to/vodou-core/start-vodou-services.sh" ]; then
    "/path/to/vodou-core/start-vodou-services.sh" > /dev/null 2>&1
fi
```

**Zsh (.zshrc):**
```bash
# Add to ~/.zshrc
if [ -f "/path/to/vodou-core/start-vodou-services.sh" ]; then
    "/path/to/vodou-core/start-vodou-services.sh" > /dev/null 2>&1
fi
```

## 🌐 **Remote Server Setup** ⭐ **New!**

Vodou supports connecting to remote MCP servers via HTTP/HTTPS. This enables integration with cloud-hosted MCP services and enterprise APIs.

### Quick Remote Server Connection

```bash
# Connect to remote HTTP server
vodou-core connect gusto --url https://mcp.api.gusto.com/anthropic --validate

# Add credentials (using environment variable - recommended)
vodou-core credentials gusto add --cred-type api_key --from-env "GUSTO_API_KEY" --header "X-API-Key"

# Add API key to .env file
echo "GUSTO_API_KEY=your-api-key-here" >> .env

# Test connection
vodou-core call gusto get_employee_info
```

### Complete Remote Server Workflow

1. **Connect with Validation** - Preview server capabilities before adding:
   ```bash
   vodou-core connect <server-name> --url <https://server-url> --validate
   ```

2. **Add Credentials** - Store authentication securely:
   ```bash
   # Option 1: From environment variable (recommended)
   vodou-core credentials <server> add --cred-type api_key --from-env "API_KEY_VAR" --header "X-API-Key"
   
   # Option 2: Store value directly
   vodou-core credentials <server> add --cred-type api_key "sk-xxx" --header "X-API-Key"
   ```

3. **Configure Environment** - Add credentials to `.env` file (if using `--from-env`):
   ```bash
   echo "API_KEY_VAR=your-api-key" >> .env
   ```

4. **Test Connection** - Verify everything works:
   ```bash
   vodou-core credentials <server> test
   vodou-core call <server> <tool>
   ```

### Example: Gusto MCP Server

```bash
# 1. Connect with validation
vodou-core connect gusto --url https://mcp.api.gusto.com/anthropic --validate

# 2. Add credentials from environment variable
vodou-core credentials gusto add --cred-type api_key --from-env "GUSTO_API_KEY" --header "X-API-Key"

# 3. Add to .env file
echo "GUSTO_API_KEY=sk-xxx" >> .env

# 4. Test
vodou-core credentials gusto test
vodou-core call gusto get_employee_info
```

### Security Best Practices

- ✅ **Use `--from-env`** - Store credential references, not values
- ✅ **Keep `.env` secure** - Already in `.gitignore`
- ✅ **Rotate credentials** - Regularly update API keys
- ✅ **Validate connections** - Always use `--validate` for new servers

For complete remote server documentation, see [Remote Servers Guide](../docs-DEV/remote-servers.md) (internal doc).

## 🧪 **Testing Your Installation**

### **Basic Functionality Test**

```bash
# Test system monitoring
./do "cpu memory disk"

# Test code analysis
./do "analyze codebase"

# Test web search (if Docker servers synced)
./do "search for artificial intelligence"

# Test browser automation (if Docker servers synced)
./do "take a screenshot"
```

### **Advanced Functionality Test**

```bash
# Test parallel execution
./do "cpu memory disk analyze codebase health-check"

# Test intent-based routing
./do "help with javascript error"
./do "read file README.md"
./do "check system status"
```

### **Health Check**

```bash
# Comprehensive health check
./do health-check

# Detailed health dashboard
./do health-dashboard

# Server status
./do status
```

## 🚨 **Troubleshooting**

### **Common Issues**

**1. Services Not Starting:**
```bash
# Check if services are running
./start-vodou-services.sh

# Check Docker Gateway status
./docker-gateway-service.sh status

# Check Browser Tools
ps aux | grep browser-tools
```

**2. Docker Servers Not Working:**
```bash
# Verify Docker Desktop is running
docker --version
docker ps

# Check Docker Gateway logs
cat /tmp/docker-gateway.log

# Restart Docker Gateway
./docker-gateway-service.sh restart
```

**3. Build Issues:**
```bash
# Clean and rebuild
cargo clean
cargo build --release

# Update Rust
rustup update

# Check Rust version
rustc --version
```

**4. Permission Issues:**
```bash
# Make scripts executable
chmod +x start-vodou-services.sh
chmod +x docker-gateway-service.sh
chmod +x ./do

# Check file permissions
ls -la start-vodou-services.sh
```

### **Getting Help**

```bash
# Show all available commands
./do help

# Show specific command help
./do help install
./do help sync-docker

# Check system status
./do health-check
./do list
```

## 📊 **What You Get After Setup**

### **Core Capabilities**
- **🧠 Intent Detection** - 95 intent mappings for natural language queries
- **⚡ Parallel Execution** - Execute multiple MCP servers simultaneously
- **🎯 Smart Parameters** - 291+ parameter rules for intelligent tool calls
- **📊 Clean Output** - Optimized results for AI agents

### **Available Servers (Typical Installation)**
- **System Monitoring** - CPU, memory, disk usage
- **Code Analysis** - Language detection, complexity analysis
- **Web Search** - DuckDuckGo search, web fetching
- **Browser Automation** - Screenshots, accessibility audits
- **File Operations** - Read, write, search files
- **Database Operations** - PostgreSQL, SQLite operations
- **Weather Data** - Current weather, forecasts
- **Documentation** - StackOverflow, Wikipedia access

### **Performance Metrics**
- **Execution Time** - 3-5 seconds for complex operations
- **Token Savings** - 98% reduction vs traditional AI interactions
- **Server Count** - 40+ MCP servers operational
- **Tool Count** - 300+ tools available

## 🧠 **Vodou Memory + Claude Code (Optional)**

Integrate Vodou memory with Claude Code (VS Code, Cursor) for workspace context and prompt-targeted memories:

```bash
./do mem setup              # Project: .claude/settings.json
./do mem setup --global     # User: ~/.claude/settings.json
./do mem setup --vscode     # Also install Claude Code extension
```

See [Claude Code Hooks](claude-code-hooks.md) for full documentation.

## 🎯 **Next Steps**

After successful setup:

1. **Explore Commands** - Run `./do help` to see all 60+ commands
2. **Test Intent Queries** - Try natural language queries like `./do "analyze my code"`
3. **Install More Servers** - Use `./do search` to find additional servers
4. **Configure API Keys** - Add API keys to `.env` for enhanced functionality
5. **Read Documentation** - Explore the `docs/` directory for advanced features

## 💡 **Pro Tips**

- **Use Parallel Execution** - Combine multiple queries: `./do "cpu memory analyze codebase"`
- **Auto-Start Services** - Services start automatically on terminal launch
- **Health Monitoring** - Run `./do health-check` regularly to ensure optimal performance
- **Intent-Based Queries** - Use natural language instead of remembering specific commands
- **Docker Integration** - Keep Docker Desktop running for full server functionality

---

**🎉 Congratulations! You now have a fully operational Vodou system with intelligent MCP orchestration capabilities.**
