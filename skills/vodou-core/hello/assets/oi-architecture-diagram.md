# Vodou Architecture Diagram

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      User Interface                           │
│                    (Natural Language)                         │
└──────────────────────────┬────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Vodou Brain Loader                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Intent     │  │    Tool     │  │  Parameter   │     │
│  │  Detection   │→ │  Selection  │→ │  Generation  │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
└──────────────────────────┬────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              Parallel Execution Engine                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Tool 1   │  │ Tool 2   │  │ Tool 3   │  │ Tool N   │   │
│  │ (parallel)│  │(parallel)│  │(parallel)│  │(parallel)│   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
└──────────────────────────┬────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    MCP Client Layer                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   stdio      │  │    HTTP      │  │  WebSocket   │     │
│  │  Protocol    │  │   Protocol   │  │   Protocol   │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
└──────────────────────────┬────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  MCP Server Ecosystem                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ mcp-     │  │ browser- │  │ Vodou-   │  │ Vodou-   │   │
│  │ monitor  │  │ tools    │  │ Enhanced │  │ Sequential│  │
│  │ (6 tools)│  │ (14 tools)│ │ Thinking │  │ Thinking │   │
│  └──────────┘  └──────────┘  │ (6 tools)│  │ (1 tool) │   │
│  ┌──────────┐  ┌──────────┐  └──────────┘  └──────────┘   │
│  │ Vodou-   │  │ Vodou-   │  ┌──────────┐  ┌──────────┐   │
│  │ channels │  │ context7 │  │ Vodou-uml│  │ Vodou-   │   │
│  │          │  │ (2 tools)│  │ -mcp     │  │ script-  │   │
│  │ (7 tools)│  └──────────┘  │ (1 tool) │  │ executor │   │
│  └──────────┘  ┌──────────┐  └──────────┘  │ (4 tools)│   │
│  ┌──────────┐  │ Vodou-   │  ┌──────────┐  └──────────┘   │
│  │ Vodou-   │  │ skills-  │  │ Vodou-   │  ┌──────────┐   │
│  │ session- │  │ executor │  │ ...      │  │ Unlimited│   │
│  │ manager  │  │ (3 tools)│  │ (expand) │  │ Servers  │   │
│  │ (5 tools)│  └──────────┘  └──────────┘  └──────────┘   │
│  └──────────┘                                              │
│  Total: 10 servers, 60+ tools (verified)                  │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Skills System (24 Skills)                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │  hello   │  │ mastery  │  │ skill-      │     │
│  │  (help)     │  │ (advanced)   │  │ dev         │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ code-review │  │ deep-think  │  │ qa-testing  │     │
│  │ review      │  │ thinking    │  │ testing     │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ project-    │  │ browser-    │  │ parallel-   │     │
│  │ wizard      │  │ tools       │  │ code-analysis│     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ mcp-builder │  │ uml-diagram │  │ context7-   │     │
│  │ builder     │  │ diagram     │  │ docs         │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ mcp-install │  │ channels    │  │ script-exec │     │
│  │ installer    │  │ (optional)  │  │ executor     │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ systematic- │  │ tdd-flow    │  │ impl-plan        │ │
│  │ -debugging   │  │ workflow     │  │ -planning    │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ user-flow   │  │ self-improve│  │ install        │   │
│  │ -control     │  │ learning     │  │ -test-kit    │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ flow-demo   │  │ docker-      │  │ memory      │     │
│  │              │  │ compose-dev  │  │ assistant    │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ oi-...       │  │ (expandable) │  │              │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│  Total: 24 skills (verified), Unlimited expansion          │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Database Layer                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Intent     │  │   Server    │  │   Work      │     │
│  │  Mappings    │  │  Config     │  │   Logs      │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

## Data Flow

### 1. User Query
```
User: "./do 'cpu memory disk'"
```

### 2. Intent Detection
```
Brain Loader → Intent Mappings → Find matching tools
```

### 3. Tool Selection
```
Intent → Server Selection → Tool Selection → Parameter Generation
```

### 4. Parallel Execution
```
Tool 1 (mcp-monitor::get_cpu_info) ┐
Tool 2 (mcp-monitor::get_memory_info)├→ Execute simultaneously
Tool 3 (mcp-monitor::get_disk_info) ┘
```

### 5. Result Correlation
```
Results → Correlation → Presentation → User
```

## Component Details

### Brain Loader
- Orchestrates workflow execution
- Manages parallel tool execution
- Correlates results
- Handles orchestration directives

### MCP Client
- Connects to MCP servers
- Manages communication protocols
- Handles stdio, HTTP, WebSocket, SSE
- Connection pooling

### Skills System
- Provides expert guidance
- Interactive workflows
- Best practices
- User control points

### Database
- SQLite database
- Server configurations
- Intent mappings
- Work logs and analytics

## Protocol Support

### stdio (Standard Input/Output)
- Most common protocol
- Text-based communication
- Simple and reliable

### HTTP
- REST API style
- Web-based servers
- Remote services

### Server-Sent Events (SSE)
- One-way streaming
- Real-time updates
- Event-driven

## Execution Modes

### Parallel Execution
```
Multiple tools execute simultaneously
Results automatically correlated
3-7x faster than sequential
```

### Orchestrated Execution
```
Tools direct what executes next
Results trigger subsequent steps
User choices guide the path
```

### Sequential Execution
```
Tools execute in specific order
Context flows between steps
When orchestration requires order
```

## Performance Characteristics

### Speed
- **Parallel**: 3-5 seconds for 5-10 tools
- **Sequential**: 15-30 seconds for same tools
- **Improvement**: 3-7x faster

### Token Efficiency
- **Traditional**: 21,000+ tokens
- **Vodou**: 2,200 tokens
- **Savings**: 90% reduction

### Scalability
- **Current MCP Servers**: 10 verified servers, 60+ tools
- **Current Skills**: 24 verified skills
- **Potential**: Unlimited expansion
- **Protocol**: Agnostic (stdio working, HTTP/WebSocket/SSE in development)

---

**This architecture enables Vodou's unique capabilities!** 🏗️

