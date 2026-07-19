---
name: mcp-installer
description: Comprehensive guide for AI agents to install MCP servers from GitHub with or without Vodou manifest (oi-manifest.json), including intent mapping and parameter configuration
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - "install mcp server"
  - "add mcp from github"
  - "setup mcp server"
  - "install mcp without manifest"
  - "configure mcp server"
stopping_points: required
actions: none
imported_from:
  source: hand-written
---

# MCP Server Installation Master Guide

## Overview

This skill teaches AI agents how to install Model Context Protocol (MCP) servers from GitHub repositories, handling both scenarios: with Vodou manifest (oi-manifest.json) (easy mode) and without (manual configuration). It covers the complete installation process including intent mappings, parameter extraction, and database configuration.

## Interactive Installation Process

**⏸️ STOPPING POINT - Start with User Needs Assessment:**

Before proceeding with any installation, I need to understand your specific situation:

**1. Do you have a GitHub URL for the MCP server you want to install?**
   - **Yes, I have the URL**: [Proceed to URL analysis]
   - **No, help me find one**: [Show popular MCP servers list]
   - **I want to create my own**: [Redirect to skill development]

**2. What's your experience level with MCP servers?**
   - **Beginner**: Simple installation with explanations
   - **Intermediate**: Standard installation with options
   - **Advanced**: Full control over configuration

**3. What's your goal with this MCP server?**
   - **Quick testing/evaluation**: Fast setup with defaults
   - **Production use**: Thorough configuration and validation
   - **Development/learning**: Step-by-step with explanations

**Your answers will determine the exact installation path I guide you through.**

## Prerequisites

- Brain Trust 4 (Vodou) installed and configured
- Access to GitHub repositories
- Basic understanding of MCP servers
- SQLite3 for database operations

## Core Installation Workflows

### 1. Installing WITH Vodou manifest (oi-manifest.json) (Automated)

When a repository includes `Vodou manifest (oi-manifest.json)`, installation is streamlined:

**⏸️ STOPPING POINT - Before Automated Installation:**

I've detected that this repository has an Vodou manifest (oi-manifest.json) file, which means installation can be automated. However, I want to confirm your preferences:

**How should I proceed with the installation?**

**A)** **Full automation** - Install everything with default settings
**B)** **Review first** - Show me what will be installed before proceeding
**C)** **Selective install** - Let me choose which components to install
**D)** **Manual mode** - Guide me through each step with explanations

**Once you choose, I'll execute the appropriate installation path:**

```bash
# For choice A (Full automation):
./do "install https://github.com/user/mcp-server"

# What happens automatically:
# 1. Clones repository
# 2. Reads Vodou manifest (oi-manifest.json)
# 3. Installs dependencies
# 4. Registers MCP server
# 5. Creates intent mappings
# 6. Sets up parameter extraction rules
```

#### Vodou manifest (oi-manifest.json) Structure
```json
{
  "name": "example-mcp",
  "display_name": "Example MCP Server",
  "description": "MCP server for example functionality",
  "command": "node",
  "args": ["dist/index.js"],
  "tools": [
    {
      "name": "example_tool",
      "description": "Does example things",
      "parameters": {
        "query": "string",
        "limit": "number"
      }
    }
  ],
  "intents": [
    {
      "keyword": "example query",
      "tool": "example_tool",
      "priority": 10
    }
  ],
  "extractors": {
    "example_tool.query": "extract everything after 'search for'",
    "example_tool.limit": "extract number or default to 10"
  }
}
```

### 2. Installing WITHOUT Vodou manifest (oi-manifest.json) (Manual)

For repositories without Vodou manifest (oi-manifest.json), follow this comprehensive process:

#### Step 1: Clone and Analyze Repository

```bash
# Clone the repository
git clone https://github.com/user/mcp-server /tmp/mcp-install
cd /tmp/mcp-install

# Analyze structure
./do "analyze repository structure find mcp server entry point check package.json"
```

#### Step 2: Identify MCP Server Configuration

Look for these files in order:
1. `mcp.json` - Standard MCP config
2. `package.json` - Check scripts section
3. `README.md` - Installation instructions
4. `src/index.ts` or `src/index.js` - Entry point

```bash
# Check for MCP configuration
cat mcp.json 2>/dev/null || echo "No mcp.json found"
cat package.json | grep -A5 '"scripts"' || echo "No scripts found"
```

#### Step 3: Install Dependencies

```bash
# For Node.js servers
npm install

# For Python servers  
pip install -r requirements.txt

# Build if necessary
npm run build || echo "No build step"
```

#### Step 4: Test the MCP Server

```bash
# Run the server to discover tools
node dist/index.js --help 2>/dev/null || node src/index.js --help

# Or use vodou-core to test
./vodou-core connect test-mcp node dist/index.js
```

#### Step 5: Register with Brain Trust 4

```bash
# Copy to MCP servers directory
cp -r /tmp/mcp-install "MCP-servers/new-mcp-server"

# Connect the server
./do "connect new-mcp-server node /path/to/MCP-servers/new-mcp-server/dist/index.js"
```

#### Step 6: Create Intent Mappings

After discovering tools, create intent mappings:

```bash
# For each tool discovered, add intent mappings
sqlite3 vodou-core.db "INSERT INTO intent_mappings (keyword, server_name, tool_name, execution_type, priority, tool_parameters) VALUES 
('natural language trigger', 'new-mcp-server', 'tool_name', 'mcp', 10, NULL);"
```

#### Step 7: Configure Parameter Extraction

If the tool requires parameters, you need to either:

**Option A: Use tool_parameters (Recommended)**
```bash
# Add parameters directly in intent mapping
sqlite3 vodou-core.db "UPDATE intent_mappings 
SET tool_parameters = '{\"param1\": \"value1\", \"param2\": \"value2\"}' 
WHERE server_name = 'new-mcp-server' AND tool_name = 'tool_name';"
```

**Option B: Create Parameter Rules**
```bash
# Add extraction rules to extractors.toml
cat >> extractors.toml << 'EOF'

[new-mcp-server.tool_name.param1]
patterns = ["extract text after 'search for'", "get everything after 'find'"]
default = ""

[new-mcp-server.tool_name.param2]  
patterns = ["extract number", "get count"]
default = "10"
EOF
```

**Option C: Database Parameter Rules**
```bash
# Create parameter rule in database
sqlite3 vodou-core.db "INSERT INTO parameter_rules 
(server_name, tool_name, tool_signature, rule_json) VALUES 
('new-mcp-server', 'tool_name', 'new-mcp-server::tool_name', 
'{\"generators\": {\"param1\": {\"type\": \"extract\", \"pattern\": \"after ''query''\"}}}');"
```

## Advanced Installation Patterns

### Pattern 1: Batch Installation from Repository List

```bash
# Install multiple MCP servers
for repo in $(cat mcp-repos.txt); do
    oi "install $repo"
    sleep 2  # Be nice to GitHub
done
```

### Pattern 2: Creating Vodou manifest (oi-manifest.json) for Existing MCP

```bash
# Generate manifest from discovered tools
./do "analyze mcp server generate oi-manifest.json"

# Template for manual creation
cat > Vodou manifest (oi-manifest.json) << 'EOF'
{
  "name": "server-name",
  "display_name": "Display Name",
  "description": "What this MCP server does",
  "command": "node",
  "args": ["dist/index.js"],
  "tools": [],
  "intents": [],
  "extractors": {}
}
EOF
```

### Pattern 3: Debugging Failed Installations

```bash
# Check server health
./do "health-check new-mcp-server"

# View server logs
./do "debug new-mcp-server"

# Test specific tool
./do "call new-mcp-server tool_name '{\"param1\": \"test\"}''"
```

## Common Installation Scenarios

### Scenario 1: TypeScript MCP Server

```bash
# Clone and build
git clone https://github.com/example/ts-mcp-server
cd ts-mcp-server
npm install
npm run build

# Install in Vodou
./do "connect ts-mcp node $(pwd)/dist/index.js"
```

### Scenario 2: Python MCP Server

```bash
# Clone and setup virtual environment
git clone https://github.com/example/py-mcp-server
cd py-mcp-server
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Install in Vodou
./do "connect py-mcp python $(pwd)/src/server.py"
```

### Scenario 3: Docker-based MCP Server

```bash
# For Docker MCP servers
docker pull example/mcp-server
./do "connect docker-mcp docker run -i example/mcp-server"
```

## Best Practices

1. **Always Test First**: Run the server manually before registering
2. **Document Intents**: Create meaningful natural language mappings
3. **Handle Errors**: Add fallback parameter values
4. **Version Control**: Keep track of installed MCP versions
5. **Security**: Review code before installing from unknown sources

## Troubleshooting Guide

### Server Won't Start
```bash
# Check dependencies
npm list || pip list

# Verify entry point
find . -name "index.js" -o -name "server.py"

# Check permissions
chmod +x dist/index.js
```

### Tools Not Discovered
```bash
# Reconnect with verbose mode
./do "reconnect server-name"

# Check server implementation
grep -r "defineTools\|tools:" .
```

### Parameters Not Extracted
```bash
# Test parameter extraction
./do "test extraction 'search for example text' for server-name::tool_name"

# View current rules
sqlite3 vodou-core.db "SELECT * FROM parameter_rules WHERE server_name = 'server-name';"
```

## Quick Reference

```bash
# Install with manifest
./do "install https://github.com/user/mcp-server"

# Install without manifest - manual steps
git clone <repo>
npm install && npm run build
./do "connect server-name node dist/index.js"
./do "add intent 'trigger phrase' server-name tool_name"

# Configure parameters
sqlite3 vodou-core.db "UPDATE intent_mappings SET tool_parameters = '{...}'"

# Test installation
./do "test server-name"
./do "call server-name tool_name"
```

## Creating Your Own Vodou manifest (oi-manifest.json)

To make your MCP server OI-friendly, create `Vodou manifest (oi-manifest.json)`:

```json
{
  "name": "your-mcp-server",
  "display_name": "Your MCP Server", 
  "description": "Clear description of functionality",
  "command": "node",
  "args": ["dist/index.js"],
  "install_steps": [
    "npm install",
    "npm run build"
  ],
  "tools": [
    {
      "name": "your_tool",
      "description": "What this tool does",
      "parameters": {
        "required_param": "string",
        "optional_param": "number?"
      }
    }
  ],
  "intents": [
    {
      "keyword": "natural language trigger",
      "tool": "your_tool",
      "priority": 10,
      "tool_parameters": {
        "optional_param": 42
      }
    }
  ],
  "extractors": {
    "your_tool.required_param": "extract text after 'keyword'"
  }
}
```

## Remember

Installing MCP servers extends OI's capabilities infinitely. Each server adds new tools, and proper configuration ensures natural language understanding. Whether automated with Vodou manifest (oi-manifest.json) or manual, the goal is seamless integration that feels native to users.

**Key Success Factors**:
- Test thoroughly before deployment
- Create intuitive intent mappings
- Document parameter requirements
- Provide sensible defaults
- Enable parallel execution when possible