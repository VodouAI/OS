# Vodou-LLM-Router MCP Server

Intelligent routing using LLM to find the RIGHT skill/MCP/script for any query.

## Overview

This MCP server is the "brain" that makes Vodou smart at understanding user intent. It:

1. **Analyzes queries** using pattern matching and LLM intelligence
2. **Routes to the best handler**: skill, MCP tool, script, or chat
3. **Maintains conversation** for general chat interactions
4. **Lists capabilities** of the entire Vodou system

## Architecture

```
User Query
     │
     ▼
┌────────────────────────────────────────┐
│           Vodou-LLM-Router                │
│                                        │
│  1. Quick Pattern Match (fast)         │
│     - CPU/Memory → mcp-monitor         │
│     - Deep think → Vodou-Enhanced-Thinking│
│     - Greetings → chat                 │
│                                        │
│  2. LLM Analysis (if no quick match)   │
│     - Full capabilities context        │
│     - Intelligent routing decision     │
│                                        │
│  Output: RouteDecision                 │
│  {type, target, tools, reasoning}      │
└────────────────────────────────────────┘
     │
     ▼
  skill / mcp / script / chat
```

## Tools

### `route_query`

Analyze a query and get a routing decision.

```json
{
  "query": "What's my CPU usage?",
  "context": "optional additional context"
}
```

**Returns:**
```json
{
  "type": "mcp",
  "target": "mcp-monitor",
  "tools": ["get_cpu_usage"],
  "reasoning": "System monitoring query - direct MCP tool match",
  "confidence": 0.95,
  "originalQuery": "What's my CPU usage?"
}
```

### `chat`

Handle general conversation with maintained history.

```json
{
  "message": "Hello, how are you?",
  "clear_history": false
}
```

### `get_capabilities`

List all Vodou capabilities.

```json
{
  "format": "summary",  // "summary", "detailed", or "json"
  "refresh": false
}
```

### `explain_route`

Get detailed explanation of routing for a query.

```json
{
  "query": "deep think about API design"
}
```

### `complete`

Generic LLM completion for memory extraction, planning, agent. Used by vodou-core when LLM is via MCP. Supports providers: `claude` (CLI or Anthropic if API key set), `anthropic`, `ollama`, `script`, `openai`, `custom` (OpenAI-compatible endpoint).

```json
{
  "prompt": "User prompt text",
  "system": "Optional system instruction",
  "provider": "claude",
  "model": "haiku",
  "timeout_secs": 60,
  "max_tokens": 1024
}
```

**Returns:** `{ "text": "..." }` or error with `{ "error": "timeout"|"provider_not_configured"|"api_error", "message": "..." }`.

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | No* | - | Anthropic API key (if set, uses SDK) |
| `CLAUDE_BIN` | No | `claude` | Claude CLI binary when using CLI mode |
| `CLI_MODEL` | No | sonnet | Model name for Claude CLI |
| `LLM_MODEL` | No | claude-sonnet-4-20250514 | Model for API key mode |
| `MAX_TOKENS` | No | 1024 | Max tokens for routing decision |
| `VODOU_PATH` | No | auto-detect (from router dir) | Vodou project root; must contain `vodou-core.db` and optionally `memory.db` |
| `VODOU_MEMORY_EXTRACTION_PROVIDER` | No | `claude` | Default for `complete` tool: `claude`, `anthropic`, `ollama`, `script`, `openai`, `custom` |
| `VODOU_LLM_TIMEOUT_SECS` | No | 60 | Default timeout for `complete` (overridable per call) |
| `VODOU_LLM_RETRY` | No | - | Set to `1` to enable retries (2x, 1s/2s backoff) for HTTP providers on 5xx/network errors |
| `OPENAI_API_KEY` | For `openai` | - | Required when provider is `openai` |
| `VODOU_EXTRACTION_SCRIPT_COMMAND` | For `script` | - | Command for `script` provider (or pass `script_command` in tool args) |
| `VODOU_CUSTOM_LLM_BASE_URL` | For `custom` | - | OpenAI-compatible endpoint base URL |
| `OLLAMA_BASE_URL` | For `ollama` | http://localhost:11434 | Ollama server URL |

*Auth priority: if `ANTHROPIC_API_KEY` is set, uses Anthropic SDK; otherwise uses **Claude CLI** (same as Vodou-Console / Vodou system, e.g. Max subscription). Without either, pattern matching only.

### Full Vodou context (direct DB + memory)

The router **connects to Vodou’s DBs directly** so the LLM has **everything** before answering:

**From vodou-core.db:**
- **Intent mappings** — keyword → server::tool (same as the brain’s fast path).
- **MCP servers & tools** — every server and every tool name (full callable surface).
- **Scheduled tasks** — name, schedule, payload, next/last run (scheduler).
- **Skills registry** — registered skills (name, description).
- **Script registry** — runnable scripts (server, script_name, command).

**From memory.db:**
- **Relevant memories** — FTS search on the user query, top hits injected.

**From capabilities (files/config):**
- **Skills** (SKILL.md on disk), **MCP** (config), **scripts** (scripts/ dir).

On every `route_query` and `chat`, the router loads all of the above into one “Vodou state” section and passes it to the LLM. So the LLM sees intents, memory, every MCP tool, the scheduler, skills, and scripts — full power, no export script.

### Add to config.json

```json
{
  "Vodou-LLM-router": {
    "command": "node",
    "args": ["./MCP-servers/Vodou-LLM-router/dist/index.js"],
    "env": {
      "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}"
    }
  }
}
```

## Installation

- **Requirements**: Node.js 18+. On macOS, if `npm install` fails with `gyp ERR!`, run `xcode-select --install` (uses `better-sqlite3`).

```bash
cd MCP-servers/Vodou-LLM-router
npm install
npm run build
```

## Usage Examples

### Route System Monitoring Query
```
Query: "cpu memory disk"
→ Route: mcp-monitor with tools [get_cpu_usage, get_memory_usage, get_disk_usage]
```

### Route Deep Thinking
```
Query: "deep think about microservices architecture"
→ Route: Vodou-Enhanced-Thinking with tool [start_thinking_session]
```

### Route to Skill
```
Query: "security audit"
→ Route: skill code-review
```

### General Conversation
```
Query: "Hello, tell me a joke"
→ Route: chat (no specific tool needed)
```

## Routing Logic

1. **Quick Pattern Matching** (fast, no API call):
   - CPU/memory/disk → mcp-monitor
   - Deep think → Vodou-Enhanced-Thinking
   - Save/recall memory → Vodou memory system
   - Screenshot → chrome-devtools
   - Script execution → Vodou-script-executor
   - Skill trigger phrases → respective skills
   - Greetings → chat

2. **LLM Routing** (when pattern doesn't match):
   - Sends full capabilities context to LLM
   - LLM makes intelligent routing decision
   - Returns structured RouteDecision

## Testing

From `MCP-servers/Vodou-LLM-router` (or Vodou root with `node MCP-servers/Vodou-LLM-router/test-router.mjs`):

```bash
# Default: route_query (CPU + microservices) + get_capabilities
node test-router.mjs

# Route a single query (uses full Vodou context: intents, memory, MCP, scheduler, scripts)
node test-router.mjs "what's my CPU and memory?"
node test-router.mjs "what's scheduled?"
node test-router.mjs "list scheduled tasks"
node test-router.mjs "deep think about API design"
node test-router.mjs "run the nightly backup script"
```

You should see the router’s JSON decision (type, target, tools, reasoning, confidence). Ensure `vodou-core.db` and optionally `memory.db` exist at Vodou root so the context is loaded.

## Development

```bash
# Watch mode
npm run dev

# Build
npm run build

# Test
node dist/index.js
```

## License

MIT
