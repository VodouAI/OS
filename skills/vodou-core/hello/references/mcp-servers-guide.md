# MCP Servers Guide - Complete Reference

## What is an MCP Server?

**MCP (Model Context Protocol)** is a standardized protocol that allows AI agents to interact with tools and services. An **MCP Server** is a program that implements this protocol and provides specific capabilities.

### Key Concepts

- **Protocol**: Standardized communication format
- **Server**: Program that provides tools
- **Tools**: Functions the server can execute
- **Resources**: Data the server can provide
- **Prompts**: Templates for common tasks

## How MCP Servers Work

### Communication Flow

```
AI Agent (Vodou)
    ↓
MCP Protocol
    ↓
MCP Server
    ↓
Tool Execution
    ↓
Results Returned
```

### Protocol Types

**1. stdio (Standard Input/Output)**
- Text-based communication
- Most common type
- Simple and reliable

**2. HTTP**
- REST API style
- Web-based servers
- Good for remote services

**3. WebSocket**
- Real-time bidirectional
- Streaming data
- Interactive applications

**4. Server-Sent Events (SSE)**
- One-way streaming
- Real-time updates
- Event-driven

## MCP Servers in Vodou

### Built-in Servers

**System & Infrastructure**
- `mcp-monitor` - System monitoring (CPU, memory, disk, network)
- `filesystem-docs` - File operations
- `memory-orchestrator` - Memory management

**Development Tools**
- `chrome-devtools` - Chrome DevTools MCP (navigate, snapshot, screenshot, console, network)
- `github-test` - GitHub integration
- `git-mcp` - Git operations
- `repomix` - Repository analysis

**Web & Browser**
- `browser-tools-stdio` - Browser automation
- `puppeteer` - Advanced browser control
- `apify-mcp-server` - Web scraping

**AI & Knowledge**
- `stackoverflow-mcp` - Stack Overflow search
- `sequential-thinking` - Deep analysis
- `context7` - Context management

**And 20+ more!**

### Viewing Available Servers

```bash
# List all connected servers
./do list

# Show server details
./do "status mcp-monitor"

# List all tools from a server
./do "tools mcp-monitor"
```

## Using MCP Servers

### Natural Language (Recommended)

**Vodou automatically finds the right tool:**
```bash
./do "check my cpu"
# Automatically uses mcp-monitor::get_cpu_info

./do "analyze my codebase"
# Routes to mapped MCP tools (e.g. chrome-devtools, mcp-monitor) per intent DB
```

### Direct Tool Calls

**Call specific tools directly:**
```bash
./vodou-core call mcp-monitor get_cpu_info

./vodou-core call chrome-devtools take_snapshot '{}'
```

### Parallel Execution

**Run multiple tools simultaneously:**
```bash
./do "cpu memory disk network"
# All mcp-monitor tools execute in parallel
```

## Installing MCP Servers

### From GitHub

**Automatic Installation:**
```bash
./do "install mcp server from github.com/user/repo"
```

**Manual Installation:**
1. Clone repository to `MCP-servers/` directory
2. Install dependencies
3. Update database configuration
4. Restart services

### From npm

```bash
npm install -g mcp-server-name
./do "connect mcp-server-name npx mcp-server-name"
```

### From pip

```bash
pip install mcp-server-name
./do "connect mcp-server-name python -m mcp_server_name"
```

### Custom Installation

**1. Create Server Directory**
```bash
mkdir -p MCP-servers/my-server
```

**2. Add Server Files**
- Server executable or script
- Configuration files
- Dependencies

**3. Register in Database**
```bash
./do "connect my-server /path/to/server"
```

**4. Restart Services**
```bash
./start-vodou-services.sh
```

## Managing MCP Servers

### Connection Management

**Connect a server:**
```bash
./do "connect server-name command [args]"
```

**Disconnect a server:**
```bash
./do "remove server-name"
```

**Reconnect a server:**
```bash
./do "reconnect server-name"
```

### Health Monitoring

**Check server health:**
```bash
./do "status server-name"
./do "health-check"
./do "health-dashboard"
```

### Server Discovery

**Find servers by capability:**
```bash
./do "find tool get_cpu_info"
./do "all-tools"
```

## MCP Server Development

### Creating Your Own Server

**1. Choose Protocol**
- stdio (simplest)
- HTTP (web-based)
- WebSocket (real-time)

**2. Implement MCP Protocol**
- Tool definitions
- Resource definitions
- Prompt templates

**3. Register with Vodou**
```bash
./do "connect my-server /path/to/server"
```

### Server Structure

```
my-mcp-server/
├── src/
│   └── index.ts        # Server implementation
├── package.json        # Dependencies
└── README.md           # Documentation
```

### Example Server

**TypeScript (stdio):**
```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server({
  name: "my-server",
  version: "1.0.0",
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "my_tool",
    description: "Does something useful",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string" }
      }
    }
  }]
}));

const transport = new StdioServerTransport();
await server.connect(transport);
```

## Best Practices

### Server Selection
- Use natural language when possible
- Vodou automatically selects the best server
- Direct calls for specific needs

### Parallel Execution
- Group related tools together
- Vodou executes them in parallel automatically
- Results are automatically correlated

### Error Handling
- Check server health regularly
- Monitor for connection issues
- Use `./do "health-check"` to diagnose

### Performance
- Use parallel execution for multiple tools
- Cache results when appropriate
- Monitor server response times

## Troubleshooting

### Server Won't Connect
- Check server executable path
- Verify dependencies installed
- Check logs for errors

### Tools Not Found
- Verify server is connected
- Check tool names match
- Use `./do "tools server-name"` to list

### Performance Issues
- Check server health
- Monitor resource usage
- Consider parallel execution

### Protocol Errors
- Verify MCP protocol version
- Check server compatibility
- Review error logs

## Resources

- **MCP Specification**: https://modelcontextprotocol.io
- **MCP SDK**: https://github.com/modelcontextprotocol
- **Server Examples**: `MCP-servers/` directory
- **Documentation**: `docs/mcp-protocol.md`

## Next Steps

1. **Explore**: `./do list` - See all available servers
2. **Try**: `./do "cpu memory disk"` - Use multiple tools
3. **Learn**: `./do "oi mastery"` - Advanced techniques
4. **Create**: Build your own MCP server

---

**MCP Servers are the foundation of Vodou's power!** 🔌

