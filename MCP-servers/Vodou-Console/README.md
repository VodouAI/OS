# Vodou-Console

Web chat interface for Vodou — same intelligence, memory, and skills as the CLI.

**End-user overview (no bridge internals):** see repo **`docs/messaging.md`** and **`docs/setup.md`**.

## Architecture (v0.5.37 — BrainLoader-First)

```
User message
    ↓
┌─────────────────────────────────────────────────────────┐
│                    Vodou-Console                        │
│                                                         │
│  1. Memory injection (daemon socket → memory.db)        │
│  2. BrainLoader (vodou-core brain "<query>")          │
│     → Intent routing, parallel execution, skills        │
│  3. Workflow driver (AGENT_ACTIONS from skills)         │
│     → Multi-step tool sequences, loops, chaining        │
│  4. Claude CLI (conversational formatting only)         │
│     + Bash for follow-up tool calls when needed         │
│                                                         │
│  Context stack (same as Claude Code):                   │
│  • Workspace bootstrap (.context_cache)                 │
│  • Per-message memory search (daemon socket)            │
│  • BrainLoader results                                  │
└─────────────────────────────────────────────────────────┘
```

### What the gateway does vs what Claude does

| Component | Who | What |
|-----------|-----|------|
| Intent routing | BrainLoader | Maps "cpu memory disk" → 4 parallel MCP tool calls |
| Parameter extraction | BrainLoader | Natural language → tool args |
| Parallel execution | BrainLoader | Fires all matched intents simultaneously |
| Skill loading | BrainLoader | Returns skill markdown with stopping points |
| Workflow execution | Gateway | Executes AGENT_ACTIONS from skills (loops, chaining) |
| Memory injection | Gateway | Searches memory.db via daemon socket |
| Workspace bootstrap | Gateway | Loads .context_cache (USER.md, SOUL.md, MEMORY.md, etc.) |
| Conversation | Claude CLI | Interprets results, formats responses, follow-up tool calls |

## Setup

```bash
cd MCP-servers/Vodou-Console
npm install
npm run build
```

### Configuration (.env in project root)

```bash
# Auth (one required)
ANTHROPIC_API_KEY=sk-ant-...    # SDK mode
# OR: install Claude CLI         # Max subscription mode (auto-detected)

# Gateway
WEB_PORT=8765
CLI_MODEL=opus                   # claude CLI model (opus, sonnet, haiku)
CLAUDE_MODEL=claude-sonnet-4-20250514  # SDK model
MAX_TOKENS=8096

# Auto-start with Vodou services
START_AIGATEWAY=1
```

### Requirements

- Vodou daemon running (`vodou-core daemon start`) — for memory injection
- vodou-core binary in project root — for BrainLoader and tool execution
- Claude CLI or ANTHROPIC_API_KEY — for conversational layer

## Usage

```bash
# Start gateway
node dist/index.js

# Or via Vodou services
./start-vodou-services.sh
```

Open http://localhost:8765/#/chat

## WhatsApp (Vodou-channels + whatsmeow bridge)

1. **Standalone only on one process** — Start WhatsApp from **Messaging** in the gateway (`POST /api/channels/standalone/start` with `whatsapp`). That process must own **127.0.0.1:8082** (webhook) and spawn the **whatsapp-bridge** on **8081**. Do **not** also run `channel_connect` for WhatsApp on a second Vodou-channels MCP instance, or webhooks will hit the wrong Node process.
2. **Who triggers Vodou** — Only **private 1:1** chats (`s.whatsapp.net`, legacy `c.us`, `lid`). Groups, broadcast, newsletter, etc. are ignored at the bridge.
3. **Only your messages** — The bridge forwards **`IsFromMe`** only (your phone / linked device). Others’ DMs are ignored.
4. **Replies** — The gateway sends text back via `http://127.0.0.1:8081/api/send`. Long answers are split into **4096**-character chunks.
5. **Incoming attachments → model** — `/chat` passes `attachments` as `channelAttachments`. **Anthropic API:** native **image** (jpeg/png/gif/webp), **PDF** (`document` base64), and **plain text** docs (`.txt`, `.md`, `.csv`, `.json`, `text/plain`, etc. as `document` text/plain). History keeps those blocks; compaction preserves image **and** document turns. **OpenAI** + **Gemini (Google OpenAI-compat URL):** images are sent as `image_url` data URLs when the endpoint matches (see env below). PDFs/documents are not forwarded to those APIs as binary (placeholder text — use Anthropic for full PDF in context). **Claude CLI / Groq / etc.:** path-style fallbacks or placeholders unless noted. **Ollama:** set `CHANNEL_OLLAMA_VISION=1` to emit the same `image_url` parts (model must support vision).
6. **Channel media safety (env)** — | Variable | Purpose | Default |
   |---|---|-----|
   | `CHANNEL_MEDIA_STRICT` | If `1`/`true`, **require** `CHANNEL_MEDIA_ROOTS`; all channel file reads denied until roots are set | off |
   | `CHANNEL_MEDIA_ROOTS` | Comma-separated directory prefixes; files must resolve under one of them. If a path has spaces, wrap the **whole** value in double quotes (each segment may also be quoted; quotes are stripped). | (empty = allow any path when not strict) |
   | `CHANNEL_VISION_MAX_BYTES` | Max bytes per **image** | 5MB |
   | `CHANNEL_DOCUMENT_MAX_BYTES` | Max bytes per **PDF** | 15MB |
   | `CHANNEL_TEXT_ATTACHMENT_MAX_BYTES` | Max bytes for **text/plain** document attachments | 1MB |
   | `CHANNEL_VISION_COMPAT_ENDPOINTS` | Extra substring(s) to treat OpenAI-compat endpoints as vision-capable (e.g. your proxy host) | empty |
7. **Outbound images/files** — `channel_send` / `POST /api/channels/send` with `media_path` (local file the bridge can read). The bridge uploads via whatsmeow and sends `ImageMessage` (or doc/audio/video by extension). Independent of incoming vision.

Rebuild the bridge after Go changes: `cd MCP-servers/Vodou-channels && npm run build`.

## How It Works

### Single-shot queries (cpu, disk, memory, network)

```
User: "cpu memory disk"
  → BrainLoader routes to 4 MCP tools in parallel
  → Gateway shows 1 "BrainLoader" tool chip
  → Claude formats the results conversationally
```

### Interactive skills (deep think, browser tools)

```
User: "deep think about AI orchestration"
  → BrainLoader loads deep-thinking skill
  → Claude presents depth menu (1-3)
  → User picks "2"
  → Gateway detects AGENT_ACTIONS in skill markdown
  → Gateway executes directly:
    1. start_thinking_session (captures SESSION_ID)
    2. add_thought × 10 (loop with progress streaming)
    3. analyze_thinking (quality check)
    4. get_session_state (final results)
  → Claude formats the complete analysis
```

Claude can't skip steps or fake output — the gateway drives every tool call.

### Memory injection

Every message gets memory context from the daemon:
- Hybrid search: FTS5 + vector embeddings (AllMiniLML6V2)
- Same search that Claude Code gets via UserPromptSubmit hook
- Injected into Claude's system prompt alongside workspace bootstrap

## Skill Workflow Driver (AGENT_ACTIONS)

Skills can embed executable workflow definitions as HTML comments. The gateway parses and executes them automatically — no config files, no gateway code changes.

### Format

```markdown
## STOPPING POINT 1 — Select Depth

1. Quick Analysis (5-7 thoughts)
2. Standard Deep Dive (8-12 thoughts)

<!-- AGENT_ACTIONS_1: {"label":"Quick Analysis","vars":{"DEPTH":"5"},"steps":[
  {"server":"Vodou-Enhanced-Thinking","tool":"start_thinking_session",
   "args":{"topic":"{{TOPIC}}","estimated_steps":5},
   "capture":{"SESSION_ID":"session_id"}},
  {"server":"Vodou-Enhanced-Thinking","tool":"add_thought",
   "args":{"session_id":"{{SESSION_ID}}","thought":"Analysis {{i}} of {{DEPTH}}"},
   "loop":5,"stream_progress":true},
  {"server":"Vodou-Enhanced-Thinking","tool":"get_session_state",
   "args":{"session_id":"{{SESSION_ID}}"}}
]} -->
```

### Step properties

| Property | Type | Description |
|----------|------|-------------|
| `server` | string | MCP server name |
| `tool` | string | Tool name |
| `args` | object | Tool arguments (supports `{{VAR}}` templates) |
| `loop` | number/string | Repeat N times (`{{i}}` = current iteration) |
| `capture` | object | Capture response fields as variables for chaining |
| `stream_progress` | boolean | Send progress events to UI during loops |

### Template variables

| Variable | Source |
|----------|--------|
| `{{TOPIC}}` | Extracted from user's original query |
| `{{DEPTH}}` | From the selected option's `vars` |
| `{{SESSION_ID}}` | Captured from a previous step's response |
| `{{i}}` | Loop counter (1-based) |
| `{{SELECTED_LABEL}}` | The label of the option the user picked |

### Adding AGENT_ACTIONS to any skill

1. Edit the skill's `SKILL.md`
2. Add `<!-- AGENT_ACTIONS_N: {...} -->` comments after each stopping point menu
3. Done — gateway parses them from BrainLoader output automatically

### Fallback: workflows.json

For skills without inline AGENT_ACTIONS, a static config file (`src/workflows.json`) defines workflows. Same execution engine, different source.

## WebSocket API

Connect to `ws://localhost:8765`:

```javascript
// Send message
ws.send(JSON.stringify({ type: 'message', content: 'cpu memory disk' }));

// Events
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  switch (data.type) {
    case 'chunk':      // Streaming text delta
    case 'tool_start': // Tool execution started (tool, toolId, args)
    case 'tool_end':   // Tool completed (toolId, result, success, executionTime)
    case 'done':       // Response complete
    case 'error':      // Error (message)
  }
};

// Clear conversation
ws.send(JSON.stringify({ type: 'clear' }));
```

## REST API

```bash
# Chat
curl -X POST http://localhost:8765/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "cpu memory disk"}'

# Health
curl http://localhost:8765/health

# Stats
curl http://localhost:8765/stats
```

## OpenAI-Compatible API (`/v1`)

The gateway exposes an OpenAI-compatible API so any tool that speaks the OpenAI format can use Vodou's full intelligence pipeline — BrainLoader, memory, skills, all MCP servers.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | Chat completion (streaming + non-streaming) |
| `GET` | `/v1/models` | List available models |

### Quick Start

```bash
# Non-streaming
curl -s http://127.0.0.1:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"vodou-default","messages":[{"role":"user","content":"hello"}]}'

# Streaming (SSE)
curl -s http://127.0.0.1:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"vodou-default","stream":true,"messages":[{"role":"user","content":"hello"}]}'

# List models
curl -s http://127.0.0.1:8765/v1/models
```

### IDE Integration

**Continue.dev** — add to `.continue/config.json`:

```json
{
  "models": [{
    "title": "Vodou (Vodou)",
    "provider": "openai",
    "model": "vodou-default",
    "apiKey": "local",
    "apiBase": "http://127.0.0.1:8765/v1"
  }]
}
```

**Cursor** — Settings → Models → Add Model:
- Provider: OpenAI Compatible
- API Base: `http://127.0.0.1:8765/v1`
- Model: `vodou-default`

**aider** — run with:
```bash
aider --openai-api-base http://127.0.0.1:8765/v1 --model vodou-default
```

**Python (OpenAI SDK)**:
```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8765/v1", api_key="local")
response = client.chat.completions.create(
    model="vodou-default",
    messages=[{"role": "user", "content": "what files changed today?"}],
    stream=True
)
for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

**Node.js (OpenAI SDK)**:
```javascript
import OpenAI from 'openai';
const client = new OpenAI({ baseURL: 'http://127.0.0.1:8765/v1', apiKey: 'local' });
const stream = await client.chat.completions.create({
  model: 'vodou-default',
  messages: [{ role: 'user', content: 'check system status' }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

### Authentication

By default, `/v1` is open (localhost use). To require a bearer token:

```bash
# In .env
VODOU_OPENAI_COMPAT_TOKEN=your-secret-token
```

Then all `/v1` requests must include:
```
Authorization: Bearer your-secret-token
```

In IDE configs, set `apiKey` to your token value.

### Conversation Continuity

To maintain context across multiple requests (multi-turn chat), pass a conversation ID:

```json
{
  "model": "vodou-default",
  "conversation_id": "my-session-1",
  "messages": [{"role": "user", "content": "tell me more"}]
}
```

Or via header: `X-Vodou-Conversation-Id: my-session-1`

Without a conversation ID, each request starts a fresh conversation.

### Request Format

Standard OpenAI `chat.completions` format:

```json
{
  "model": "vodou-default",
  "messages": [
    {"role": "user", "content": "your message"}
  ],
  "stream": false,
  "conversation_id": "optional-uuid"
}
```

- **model**: Use `vodou-default` (legacy `oi-default` accepted as alias during grace) (maps to whatever provider is active in Settings)
- **messages**: Only the last `user` message is sent to Vodou's pipeline. Conversation history is managed server-side via `conversation_id`.
- **stream**: `true` for SSE streaming, `false` for full JSON response
- **system messages**: Ignored — Vodou uses its own system prompt with workspace bootstrap and memory

### Response Format

**Non-streaming:**
```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1712345678,
  "model": "vodou-default",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "..."},
    "finish_reason": "stop"
  }],
  "usage": {"prompt_tokens": 150, "completion_tokens": 80, "total_tokens": 230}
}
```

**Streaming (SSE):**
```
data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1712345678,"model":"vodou-default","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1712345678,"model":"vodou-default","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":150,"completion_tokens":80,"total_tokens":230}}

data: [DONE]
```

### How It Connects to Claude

When provider is `claude-cli`, Vodou delegates to Anthropic's official Claude Code CLI binary (`claude -p`) using subscription OAuth — API keys are explicitly stripped from the child environment. When provider is `anthropic`, Vodou uses the Anthropic Messages API with your API key (billed via console.anthropic.com). Vodou does not implement a third-party subscription harness or proxy web sessions.

### What the LLM gets

Every `/v1` request goes through Vodou's full pipeline — the same one the web chat uses:
1. **Memory search** — daemon socket → memory.db hybrid search (FTS5 + vector)
2. **BrainLoader** — intent routing, skill loading, parallel MCP tool execution
3. **Workspace bootstrap** — USER.md, SOUL.md, MEMORY.md, AGENTS.md context
4. **Conversational response** — Claude (or other provider) formats the results

This means IDE chat gets the same quality as web chat — memory, skills, tools, and all.

---

## Dashboard

The gateway serves a full admin dashboard at http://localhost:8765 with views for:
- Chat (AI conversation with tool execution)
- Servers (MCP server management)
- Skills (skill browser)
- Intents (intent mapping viewer)
- Memory (memory search)
- Scheduler (task scheduling)
- Scripts (background jobs)
- Logs (work history)
- Terminal (PTY shell)
- System (health monitoring)

## Development

```bash
npm run dev    # Watch mode (TypeScript)
npm run build  # Build
npm start      # Run
```

## Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Express + WebSocket server, route handlers |
| `src/anthropic.ts` | BrainLoader-first chat orchestration, memory injection, bootstrap |
| `src/workflow-driver.ts` | AGENT_ACTIONS parser + generic workflow executor |
| `src/workflows.json` | Static workflow configs (fallback for skills without inline actions) |
| `src/executor.ts` | vodou-core CLI wrapper (call, brain, runBrainRoute) |
| `src/conversation.ts` | Conversation state manager |
| `src/tools.ts` | Tool definitions for SDK mode |
| `src/db.ts` | SQLite database wrapper |
| `src/terminal.ts` | PTY terminal management |
| `src/api/openai-compat.ts` | OpenAI-compatible `/v1` API adapter |
| `src/api/` | REST API route handlers for dashboard |
| `public/` | Dashboard SPA (HTML + JS) |
