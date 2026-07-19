# MCP Protocol Implementation

Detailed documentation of Brain Trust 4's Model Context Protocol (MCP) implementation, including protocol compliance, message formats, and server communication patterns.

## MCP Protocol Overview

### What is MCP?

The **Model Context Protocol (MCP)** is an open standard for AI agents to securely connect to external systems and data sources. Brain Trust 4 implements MCP as a **universal client** that can connect to any MCP-compliant server.

### MCP Core Concepts

**MCP Servers** - External systems that provide capabilities:
- **Tools** - Functions that can be executed with parameters
- **Prompts** - Templates for AI model interactions
- **Resources** - Data sources (files, APIs, databases)

**MCP Clients** - AI agents or systems that use server capabilities:
- **Brain Trust 4** - Universal MCP client for capability discovery
- **AI Assistants** - LLMs that use MCP servers for extended functionality
- **Development Tools** - IDEs and tools that integrate MCP capabilities

---

## Protocol Version Negotiation

Vodou supports multiple MCP protocol versions and automatically negotiates with servers:

**Supported Versions:**
- `2024-11-05` - Initial MCP specification (STDIO and basic HTTP)
- `2025-11-25` - Latest specification (adds Streamable HTTP, enhanced session management)

**Negotiation Process:**
1. Client sends `initialize` request with latest protocol version (`2025-11-25`)
2. Server responds with supported version (may be different)
3. Client caches successful version for future connections
4. All subsequent requests use the negotiated version

**Version in Initialize Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-11-25",
    "capabilities": {},
    "clientInfo": {
      "name": "vodou-core",
      "version": "0.5.33"
    }
  }
}
```

**Version Caching:**
- Successful protocol versions are stored in `mcp_servers.protocol_version`
- Cached version is used for all future connections to that server
- Cache is cleared if connection fails with version mismatch

---

## OAuth 2.0 Authentication

Vodou supports OAuth 2.0 authentication for remote MCP servers that require it.

### OAuth Flow

**1. Discovery (Protected Resource Metadata - PRM)**
```json
{
  "authorization_endpoint": "https://example.com/oauth/authorize",
  "token_endpoint": "https://example.com/oauth/token",
  "scopes_supported": ["read", "write"],
  "registration_endpoint": "https://example.com/oauth/register"
}
```

**2. Dynamic Client Registration (DCR) - Optional**
If server supports DCR, Vodou can automatically register a client:
```json
{
  "client_id": "auto-generated-id",
  "client_secret": "auto-generated-secret",
  "redirect_uris": ["http://localhost:8080/callback"]
}
```

**3. Authorization Flow**
1. User initiates OAuth flow: `vodou-core credentials <server> oauth`
2. Browser opens to authorization endpoint
3. User authorizes application
4. Server redirects to callback URL with authorization code
5. Vodou exchanges code for access token
6. Token is stored securely in database

**4. Token Storage**
```sql
-- Tokens stored in server_credentials table
SELECT * FROM server_credentials WHERE server_id = ? AND credential_type = 'oauth_token';
```

### OAuth Configuration

**Via CLI:**
```bash
# Configure OAuth for a server
vodou-core credentials <server> oauth \
  --client-id <id> \
  --client-secret <secret> \
  --redirect-uri http://localhost:8080/callback \
  --scope "read write"
```

**Database Storage:**
- `oauth_configs` - OAuth endpoint configurations
- `dynamic_oauth_clients` - Dynamically registered clients
- `server_credentials` - Access tokens and refresh tokens

### OAuth Providers

Vodou has been tested with:
- **Figma** — Official **remote** MCP (`https://mcp.figma.com/mcp`) uses OAuth and vendor allowlists. The bundled **Apps → Figma** preset uses **local stdio** (bundled `figma-developer-mcp` under `MCP-servers/figma-developer-mcp/`, invoked via `node` from the project root) and a **personal access token** (`FIGMA_API_KEY` in `.env`); see `MCP-servers/figma-developer-mcp/README.md`.
- **GitHub** - OAuth for repository access
- **Custom Servers** - Any OAuth 2.0 compliant server

---

## Session Management

### HTTP Session IDs

Some HTTP MCP servers return a session ID during initialization that must be included in all subsequent requests.

**Session ID Flow:**
1. `initialize` request sent to server
2. Server responds with `MCP-Session-Id` header
3. Client stores session ID
4. All subsequent requests include `MCP-Session-Id` header

**Example:**
```http
POST /mcp HTTP/1.1
Host: example.com
Content-Type: application/json
MCP-Session-Id: abc123def456...

{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list",
  "params": {}
}
```

**Connection Pool Integration:**
- Session IDs are preserved when HTTP connections are cloned
- Each HTTP connection maintains its own session ID
- Session IDs are automatically managed - no manual configuration needed

---

## Protocol Stack

### Transport Layer: STDIO and HTTP

Brain Trust 4 supports **multiple transport layers** for MCP communication:

#### STDIO Transport (Local Processes)

```
┌─────────────────────────────────────────┐
│            Application Layer            │
│   (Capability Discovery & Execution)   │
└─────────────────────────────────────────┘
                     │
┌─────────────────────────────────────────┐
│             MCP Protocol Layer          │
│         (JSON-RPC 2.0 Messages)        │
└─────────────────────────────────────────┘
                     │
┌─────────────────────────────────────────┐
│           Transport Layer               │
│    (STDIO - stdin/stdout)               │
│    (HTTP/HTTPS - REST API) ⭐ New!      │
└─────────────────────────────────────────┘
                     │
┌─────────────────────────────────────────┐
│            Process Layer                │
│    (MCP Server Process Management)     │
│    (Remote HTTP Server) ⭐ New!         │
└─────────────────────────────────────────┘
```

#### HTTP Transport (Remote Servers) ⭐ **New!**

HTTP transport enables connecting to remote MCP servers via HTTP/HTTPS:

- **JSON-RPC over HTTP** - Same JSON-RPC 2.0 protocol over HTTP POST requests
- **Stateless Connections** - Each request is independent (no persistent connection)
- **Header-Based Authentication** - API keys, bearer tokens via HTTP headers
- **Session Management** - Stateless design (no session state required)
- **HTTPS Support** - Secure connections for production use

**HTTP Request Format:**
```http
POST /anthropic HTTP/1.1
Host: mcp.api.gusto.com
Content-Type: application/json
Authorization: Bearer token-xxx
X-API-Key: sk-xxx

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {}
}
```

**HTTP Response Format:**
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": {}
  }
}
```

### Message Format: JSON-RPC 2.0

All MCP communication uses **JSON-RPC 2.0** format:

**Request Message:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "method_name",
  "params": {
    "parameter": "value"
  }
}
```

**Response Message:**
```json
{
  "jsonrpc": "2.0", 
  "id": 1,
  "result": {
    "data": "response_data"
  }
}
```

**Error Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32602,
    "message": "Invalid params",
    "data": {
      "details": "Additional error information"
    }
  }
}
```

**Notification (No Response Expected):**
```json
{
  "jsonrpc": "2.0",
  "method": "notification_method",
  "params": {
    "data": "notification_data"
  }
}
```

---

## MCP Connection Lifecycle

### STDIO Connection Lifecycle

### HTTP Connection Lifecycle ⭐ **New!**

HTTP connections follow a similar lifecycle but use HTTP requests instead of stdin/stdout:

1. **Connection Establishment** - HTTP client connects to server URL
2. **Authentication** - Credentials loaded and added to HTTP headers
3. **Initialize Request** - POST request with `initialize` method
4. **Initialize Response** - Server responds with protocol version and capabilities
5. **Initialized Notification** - Client sends `initialized` notification
6. **Capability Discovery** - Client requests tools, prompts, resources via HTTP
7. **Tool Execution** - Tools called via HTTP POST requests
8. **Connection Cleanup** - Stateless (no cleanup needed, each request is independent)

**HTTP Handshake Example:**
```http
# 1. Initialize Request
POST /anthropic HTTP/1.1
Host: mcp.api.gusto.com
Content-Type: application/json
Authorization: Bearer token-xxx

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": {
      "name": "vodou-core",
      "version": "0.5.21"
    }
  }
}

# 2. Initialize Response
HTTP/1.1 200 OK
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": {
      "tools": {}
    },
    "serverInfo": {
      "name": "gusto-mcp",
      "version": "1.0.0"
    }
  }
}

# 3. Initialized Notification
POST /anthropic HTTP/1.1
Host: mcp.api.gusto.com
Content-Type: application/json
Authorization: Bearer token-xxx

{
  "jsonrpc": "2.0",
  "method": "initialized",
  "params": {}
}
```

**Key Differences from STDIO:**
- ✅ **Stateless** - No persistent connection, each request is independent
- ✅ **Header Authentication** - Credentials sent via HTTP headers
- ✅ **HTTPS Support** - Secure connections for production
- ⚠️ **No Connection Pooling** - Each request creates new HTTP connection
- ⚠️ **Timeout Handling** - 30 second default timeout per request

## MCP Connection Lifecycle (STDIO)

### 1. Process Initialization

Brain Trust 4 spawns the MCP server process:

```rust
let mut cmd = Command::new(command)
    .args(args)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()?;
```

### 2. Protocol Handshake

#### Initialize Request
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {
      "roots": {
        "listChanged": true
      },
      "sampling": {}
    },
    "clientInfo": {
      "name": "vodou-core",
      "version": "1.0.0"
    }
  }
}
```

#### Initialize Response
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": {
      "logging": {},
      "tools": {
        "listChanged": true
      },
      "prompts": {
        "listChanged": true
      },
      "resources": {
        "subscribe": true,
        "listChanged": true
      }
    },
    "serverInfo": {
      "name": "example-mcp-server",
      "version": "1.0.0"
    }
  }
}
```

#### Initialized Notification
```json
{
  "jsonrpc": "2.0",
  "method": "notifications/initialized"
}
```

### 3. Capability Discovery

Brain Trust 4 discovers all server capabilities in parallel.

---

## MCP Methods Implementation

### Tools Discovery

#### tools/list Request
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list",
  "params": {}
}
```

#### tools/list Response
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      {
        "name": "get_weather",
        "description": "Get current weather for a location",
        "inputSchema": {
          "type": "object",
          "properties": {
            "location": {
              "type": "string",
              "description": "City name or coordinates"
            },
            "units": {
              "type": "string", 
              "enum": ["celsius", "fahrenheit"],
              "default": "celsius"
            }
          },
          "required": ["location"]
        }
      },
      {
        "name": "get_forecast",
        "description": "Get weather forecast for a location",
        "inputSchema": {
          "type": "object",
          "properties": {
            "location": {"type": "string"},
            "days": {"type": "integer", "default": 5}
          },
          "required": ["location"]
        }
      }
    ]
  }
}
```

### Tool Execution

#### tools/call Request
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "get_weather",
    "arguments": {
      "location": "San Francisco",
      "units": "fahrenheit"
    }
  }
}
```

#### tools/call Response
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Current weather in San Francisco:\nTemperature: 68°F\nCondition: Partly cloudy\nHumidity: 65%\nWind: 12 mph W"
      }
    ],
    "isError": false
  }
}
```

### Prompts Discovery

#### prompts/list Request  
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "prompts/list",
  "params": {}
}
```

#### prompts/list Response
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "prompts": [
      {
        "name": "code_review",
        "description": "Review code for quality and best practices",
        "arguments": [
          {
            "name": "code",
            "description": "The code to review",
            "required": true
          },
          {
            "name": "language",
            "description": "Programming language",
            "required": false
          },
          {
            "name": "style_guide", 
            "description": "Coding style guide to follow",
            "required": false
          }
        ]
      }
    ]
  }
}
```

### Resources Discovery

#### resources/list Request
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "resources/list",
  "params": {}
}
```

#### resources/list Response
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "resources": [
      {
        "uri": "file:///var/log/system.log",
        "name": "System Log",
        "description": "Main system log file",
        "mimeType": "text/plain"
      },
      {
        "uri": "https://api.github.com/repos/user/project",
        "name": "GitHub Project API",
        "description": "GitHub repository data",
        "mimeType": "application/json"
      },
      {
        "uri": "postgresql://localhost:5432/app_db",
        "name": "Application Database",
        "description": "Main application database",
        "mimeType": "application/sql"
      }
    ]
  }
}
```

---

## Error Handling

### Standard JSON-RPC Errors

| Code | Message | Description |
|------|---------|-------------|
| -32700 | Parse error | Invalid JSON received |
| -32600 | Invalid Request | JSON-RPC request malformed |
| -32601 | Method not found | Method does not exist |
| -32602 | Invalid params | Invalid method parameters |
| -32603 | Internal error | Server internal error |

### MCP-Specific Errors

#### Method Not Supported
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "error": {
    "code": -32601,
    "message": "Method not found: prompts/list",
    "data": {
      "method": "prompts/list",
      "supported_methods": ["tools/list", "tools/call"]
    }
  }
}
```

#### Tool Not Found
```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "error": {
    "code": -32602,
    "message": "Tool not found: unknown_tool",
    "data": {
      "available_tools": ["get_weather", "get_forecast"]
    }
  }
}
```

### Brain Trust 4 Error Handling

Brain Trust 4 implements **graceful fallback** for MCP errors:

```rust
// Graceful fallback for unsupported methods
match self.send_request(request) {
    Ok(response) => {
        // Process successful response
        parse_prompts(response)
    },
    Err(_) => {
        // Server doesn't support prompts - graceful fallback
        Ok(Vec::new()) // Return empty list
    }
}
```

**Benefits:**
- **Universal compatibility** - works with servers that support only some capabilities
- **Continued operation** - discovery continues even if some methods fail
- **Clear feedback** - users know what capabilities are/aren't available

---

## Protocol Compliance

### MCP Specification Compliance

Brain Trust 4 implements:

**✅ Core Protocol:**
- JSON-RPC 2.0 message format
- STDIO transport layer
- Initialize/initialized handshake
- Standard error codes and formats

**✅ Capability Discovery:**
- tools/list method implementation
- prompts/list method implementation  
- resources/list method implementation
- Graceful fallback for unsupported methods

**✅ Tool Execution:**
- tools/call method implementation
- Parameter validation and forwarding
- Response parsing and error handling

**🔄 Future Enhancements:**
- Prompt execution (prompts/get method)
- Resource reading (resources/read method)
- Subscription support for dynamic capabilities
- Logging and progress notifications

### Server Compatibility

**Tested Server Types:**
- **Node.js servers** - Chrome DevTools MCP, mcpadvisor, custom servers
- **Native binary servers** - mcp-monitor (Rust/Go binaries)
- **Python servers** - weather-mcp, data processing servers

**Protocol Versions:**
- **Primary**: 2024-11-05 (latest stable)
- **Backward compatibility** with earlier versions where possible

**Server Requirements:**
- **STDIO transport** - must communicate via stdin/stdout
- **JSON-RPC 2.0** - must use standard message format
- **Initialize handshake** - must support protocol initialization

---

## Communication Patterns

### Message Ordering

Brain Trust 4 follows strict message ordering:

1. **Initialize** → Wait for response
2. **Initialized notification** → No response expected
3. **Capability discovery** → Parallel requests for tools/prompts/resources
4. **Tool calls** → One request/response per call

### Request/Response Correlation

```rust
// Each request gets unique ID
let request_id = self.next_id(); // Increments: 1, 2, 3, ...

let request = json!({
    "jsonrpc": "2.0",
    "id": request_id,
    "method": "tools/list",
    "params": {}
});
```

**ID Management:**
- **Sequential IDs** - 1, 2, 3, ... for each connection
- **Per-connection state** - IDs reset for each server connection
- **Response correlation** - response `id` matches request `id`

### Connection State Management

```rust
pub struct MCPClient {
    process: std::process::Child,      // Server process handle
    stdin: std::process::ChildStdin,   // Write channel to server
    stdout: BufReader<std::process::ChildStdout>, // Read channel from server
    request_id: u32,                   // Next request ID
}
```

**Lifecycle:**
1. **connect()** - Spawn process, capture stdin/stdout
2. **initialize()** - Protocol handshake  
3. **discover_*()** - Capability discovery
4. **call_tool()** - Tool execution (multiple calls possible)
5. **close()** - Clean process termination

---

## Advanced Protocol Features

### Capability Negotiation

Servers advertise their capabilities in the initialize response:

```json
{
  "capabilities": {
    "tools": {
      "listChanged": true  // Server supports tools/list
    },
    "prompts": {
      "listChanged": true  // Server supports prompts/list
    },
    "resources": {
      "subscribe": true,    // Server supports resource subscriptions
      "listChanged": true   // Server supports resources/list
    }
  }
}
```

Brain Trust 4 **attempts all capability discovery** regardless of advertised capabilities, with graceful fallback.

### Schema Validation

**Tool Input Schemas:**
```json
{
  "inputSchema": {
    "type": "object",
    "properties": {
      "location": {
        "type": "string",
        "description": "Location to get weather for"
      },
      "units": {
        "type": "string",
        "enum": ["metric", "imperial"],
        "default": "metric"
      }
    },
    "required": ["location"]
  }
}
```

**Brain Trust 4 Schema Handling:**
- **Stores schemas** as JSON strings in database
- **Validates JSON** parameter format before tool calls
- **Displays parameters** in human-readable format
- **Forwards validation** to MCP servers (servers do final validation)

### Resource URI Schemes

**Supported Resource Types:**

**File Resources:**
```
file:///absolute/path/to/file.txt
file:///var/log/system.log
file:///etc/config/app.conf
```

**HTTP Resources:**
```
https://api.example.com/data
https://docs.example.com/api
http://internal.company.com/metrics
```

**Database Resources:**
```
postgresql://user:pass@host:port/database
mysql://host:port/database
sqlite:///path/to/database.db
mongodb://host:port/database
```

**Other Resources:**
```
s3://bucket/object
gcs://bucket/object
redis://host:port/database
```

---

## Performance Characteristics

### Connection Performance

**Typical Connection Times:**
- **Process spawn**: 100-500ms (depends on server startup time)
- **Protocol initialization**: 50-200ms (network/IPC latency)
- **Capability discovery**: 100-1000ms (depends on server capability count)
- **Tool execution**: 50ms-30s (depends on tool complexity)

### Optimization Strategies

**Connection Pooling (Future):**
```rust
// Conceptual: Reuse connections for multiple operations
pub struct MCPConnectionPool {
    connections: HashMap<String, MCPClient>,
    max_idle_time: Duration,
}
```

**Parallel Discovery:**
```rust
// Current: Parallel capability discovery
let tools_future = client.discover_tools();
let prompts_future = client.discover_prompts(); 
let resources_future = client.discover_resources();

// Execute in parallel
let (tools, prompts, resources) = tokio::join!(
    tools_future,
    prompts_future, 
    resources_future
);
```

### Scalability Limits

**Per-Server Limits:**
- **Tools**: 1000+ tools per server (practical limit)
- **Prompts**: 100+ prompts per server (typical)
- **Resources**: 10000+ resources per server (depending on source)

**System Limits:**
- **Concurrent servers**: 50+ servers (limited by system resources)
- **Database size**: 100MB+ (scales with capability count)
- **Memory usage**: 5-10MB base + 1-2MB per active connection

---

## Debugging and Troubleshooting

### Protocol Debugging

#### Message Logging (Conceptual)
```rust
// Debug mode: Log all JSON-RPC messages
if std::env::var("MCP_DEBUG").is_ok() {
    eprintln!("→ {}", serde_json::to_string_pretty(&request)?);
    eprintln!("← {}", serde_json::to_string_pretty(&response)?);
}
```

#### Manual Protocol Testing
```bash
# Test server manually
node ./server.js &
SERVER_PID=$!

# Send initialize request
echo '{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "test", "version": "1.0.0"}}}' | node ./server.js

# Send tools/list request
echo '{"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}' | node ./server.js

kill $SERVER_PID
```

### Common Protocol Issues

#### Server Startup Problems
```
Symptom: Connection timeout during initialize
Causes: 
- Server takes too long to start
- Server doesn't implement MCP protocol correctly
- Server outputs non-JSON during startup

Solutions:
- Check server startup time manually
- Verify server implements initialize method
- Check server stderr for error messages
```

#### Protocol Version Mismatch
```
Symptom: Initialize fails with version error
Causes:
- Server requires different protocol version
- Server doesn't support latest MCP features

Solutions:
- Check server documentation for supported versions
- Update server to latest MCP implementation
- Use compatible protocol version in requests
```

#### Method Not Implemented
```
Symptom: Method not found errors during discovery
Expected: Normal for servers that don't support all capabilities
Behavior: Brain Trust 4 uses graceful fallback (continues normally)
```

---

## Future Protocol Enhancements

### MCP Protocol Evolution

**Upcoming Features (MCP Specification):**
- **Streaming responses** for large datasets
- **Bidirectional communication** for real-time updates
- **Authentication and authorization** improvements
- **Performance optimizations** for high-throughput scenarios

**Brain Trust 4 Roadmap:**
- **Connection pooling** for better performance
- **Protocol debugging** with detailed logging
- **Enhanced error reporting** with context
- **Resource reading** implementation
- **Prompt execution** implementation

### Integration Opportunities

**AI Agent Integration:**
```rust
// Future: Direct AI agent integration
pub trait AIAgent {
    fn use_mcp_tool(&self, server: &str, tool: &str, params: Value) -> Result<String>;
    fn use_mcp_prompt(&self, server: &str, prompt: &str, args: Value) -> Result<String>;
    fn read_mcp_resource(&self, server: &str, uri: &str) -> Result<String>;
}
```

**Workflow Orchestration:**
```rust
// Future: Multi-server workflows
pub struct MCPWorkflow {
    steps: Vec<MCPWorkflowStep>,
    servers: Vec<String>,
}
```

---

**Brain Trust 4's MCP implementation provides universal compatibility with any MCP-compliant server, enabling seamless AI agent integration and capability discovery.**

## See Also

- [Architecture](../docs-DEV/architecture.md) (internal) — how MCP fits into Brain Trust 4's architecture
- [CLI Reference](cli-reference.md) - Commands that use MCP protocol
- [Examples](examples.md) - Real-world MCP server usage examples
- [Troubleshooting](troubleshooting.md#mcp-protocol-issues) - MCP protocol troubleshooting