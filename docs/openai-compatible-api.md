# OpenAI-Compatible API

The gateway exposes a local OpenAI-compatible **`POST /v1/chat/completions`** (and **`GET /v1/models`**) on the same host/port as the web UI (default **http://127.0.0.1:8765**). Any client that speaks the OpenAI request format can use it as a backend; behavior matches your configured **models, memory, skills, and connected MCP servers**—not a bare static LLM proxy.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | Chat completion (streaming + non-streaming) |
| `GET` | `/v1/models` | List available models |

Base URL: `http://127.0.0.1:8765/v1`

---

## Quick Start

### Test with curl

```bash
# Non-streaming
curl -s http://127.0.0.1:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "oi-default",
    "messages": [{"role": "user", "content": "what is Vodou?"}]
  }'

# Streaming (SSE)
curl -s http://127.0.0.1:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "oi-default",
    "stream": true,
    "messages": [{"role": "user", "content": "check system status"}]
  }'

# List models
curl -s http://127.0.0.1:8765/v1/models
```

---

## IDE Integration

### Continue.dev (VS Code)

Add to `.continue/config.json`:

```json
{
  "models": [{
    "title": "Vodou (Vodou)",
    "provider": "openai",
    "model": "oi-default",
    "apiKey": "local",
    "apiBase": "http://127.0.0.1:8765/v1"
  }]
}
```

### Cursor

Settings > Models > Add Model:
- **Provider:** OpenAI Compatible
- **API Base:** `http://127.0.0.1:8765/v1`
- **API Key:** `local` (or your `VODOU_OPENAI_COMPAT_TOKEN` if set)
- **Model:** `oi-default`

### aider

```bash
aider --openai-api-base http://127.0.0.1:8765/v1 --model oi-default
```

---

## Capture conversations to memory (BYOK)

Any app you point at this endpoint can also **feed your Vodou memory** — the "BYOK tee" (Universal Memory V2, Phase C W1b). The request passes through to the configured provider as normal *and* a copy of the conversation is captured, distilled, and indexed at the `capture:byok:<app>` trust tier (between your own memory and one-shot imports — provenance-ranked, deduped, never auto-promoted to `MEMORY.md`).

Name the app so its captures are labeled and scoped, via the `X-Vodou-App` header (or OpenAI's `user` field):

```bash
curl http://127.0.0.1:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Vodou-App: cursor" \
  -d '{"model":"vodou-default","messages":[{"role":"user","content":"..."}]}'
```

Notes:
- Conversation ids become `byok:<app>:<uuid>`, which `gateway_extractor::derive_scope` maps to `capture:byok:<app>`.
- Kill switch: `VODOU_BYOK_SCOPED_IDS=0` reverts to bare-UUID, `web`-scoped extraction (i.e. no BYOK capture tagging).
- This is one lane of the capture portfolio — see [`vodou-memory.md`](./vodou-memory.md) §Capture lanes for the browser, IDE, and manual lanes.

---

## SDK Usage

### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8765/v1",
    api_key="local"  # or your VODOU_OPENAI_COMPAT_TOKEN
)

# Non-streaming
response = client.chat.completions.create(
    model="oi-default",
    messages=[{"role": "user", "content": "what files changed today?"}]
)
print(response.choices[0].message.content)

# Streaming
stream = client.chat.completions.create(
    model="oi-default",
    messages=[{"role": "user", "content": "explain the memory system"}],
    stream=True
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

### Node.js / TypeScript

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
    baseURL: 'http://127.0.0.1:8765/v1',
    apiKey: 'local'
});

// Non-streaming
const response = await client.chat.completions.create({
    model: 'oi-default',
    messages: [{ role: 'user', content: 'check cpu and memory' }]
});
console.log(response.choices[0].message.content);

// Streaming
const stream = await client.chat.completions.create({
    model: 'oi-default',
    messages: [{ role: 'user', content: 'run the deep thinking skill' }],
    stream: true,
});
for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

### Shell (with jq)

```bash
# Parse non-streaming response
curl -s http://127.0.0.1:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"oi-default","messages":[{"role":"user","content":"hello"}]}' \
  | jq -r '.choices[0].message.content'
```

---

## Authentication

By default, the `/v1` API is open (localhost use only). To require authentication:

```bash
# Add to your .env file
VODOU_OPENAI_COMPAT_TOKEN=your-secret-token-here
```

All `/v1` requests must then include:
```
Authorization: Bearer your-secret-token-here
```

In IDE configs, set `apiKey` to your token.

The gateway logs auth status on startup:
```
[Gateway] OpenAI-compatible API mounted at /v1 (bearer auth enabled)
```

---

## Multi-Turn Conversations

Each request can include a `conversation_id` to maintain context across turns:

```json
{
  "model": "oi-default",
  "conversation_id": "project-review-session",
  "messages": [{"role": "user", "content": "tell me more about that"}]
}
```

Or pass via header:
```
X-Vodou-Conversation-Id: project-review-session
```

**Without a conversation ID**, each request starts a fresh conversation (no history).

**With a conversation ID**, Vodou maintains full conversation state:
- Message history (stored in gateway.db)
- Active skill state (survives across requests)
- Sticky Vodou context (BrainLoader results carry forward)
- File change tracking (knows what was modified in this session)

---

## Request Format

```json
{
  "model": "oi-default",
  "messages": [
    {"role": "system", "content": "ignored — Vodou uses its own system prompt"},
    {"role": "user", "content": "your message here"}
  ],
  "stream": false,
  "conversation_id": "optional-stable-id"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | Yes | Use `oi-default` (routes to active provider in Settings) |
| `messages` | array | Yes | OpenAI message format. Only the last `user` message is processed. |
| `stream` | boolean | No | `true` for SSE streaming, `false` for JSON response (default) |
| `conversation_id` | string | No | Stable ID for multi-turn conversations |

**Notes:**
- `system` messages are ignored — Vodou has its own system prompt with workspace bootstrap and memory
- Only the **last user message** is sent to Vodou's pipeline. Conversation history is managed server-side.
- `temperature`, `top_p`, `max_tokens` and other OpenAI params are accepted but not forwarded (Vodou uses its own settings)

---

## Response Format

### Non-streaming

```json
{
  "id": "chatcmpl-a1b2c3d4e5f6g7h8i9j0k1l2",
  "object": "chat.completion",
  "created": 1712345678,
  "model": "oi-default",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Here's what I found..."
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 150,
    "completion_tokens": 80,
    "total_tokens": 230
  }
}
```

### Streaming (SSE)

Each chunk:
```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1712345678,"model":"oi-default","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}
```

Final chunk (with usage):
```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1712345678,"model":"oi-default","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":150,"completion_tokens":80,"total_tokens":230}}
```

Stream terminator:
```
data: [DONE]
```

### Error Responses

```json
{
  "error": {
    "message": "Description of what went wrong",
    "type": "server_error"
  }
}
```

| Status | Type | When |
|--------|------|------|
| 400 | `invalid_request_error` | Missing/empty messages array, no user message |
| 401 | `auth_error` | Missing or invalid bearer token (when `VODOU_OPENAI_COMPAT_TOKEN` is set) |
| 500 | `server_error` | Chat pipeline error (provider down, tool failure, etc.) |
| 503 | `server_error` | Gateway not configured (no provider selected) |

---

## What Happens Under the Hood

Every `/v1/chat/completions` request goes through Vodou's full intelligence pipeline:

```
POST /v1/chat/completions
    |
    v
[Bearer auth check]
    |
    v
[Extract last user message]
    |
    v
chat(conversationId, message, onEvent)     <-- same function as web UI
    |
    +-- Memory search (daemon socket -> memory.db hybrid search)
    +-- BrainLoader (vodou-core brain "<query>")
    |     +-- Intent routing
    |     +-- Skill loading
    |     +-- Parallel MCP tool execution
    +-- Workspace bootstrap (USER.md, SOUL.md, MEMORY.md)
    +-- Provider (Claude CLI / Anthropic API / OpenAI / Google / ...)
    |
    v
[Map events to OpenAI format]
    |
    v
SSE chunks or JSON response
```

This means your IDE gets the **exact same quality** as the web chat — memory, skills, tools, everything.

---

## Limitations (v1)

- **No tool pass-through**: Client-side `tools`/`tool_choice` params are ignored. Vodou manages its own tools internally via BrainLoader and AGENT_ACTIONS.
- **System messages ignored**: Vodou uses its own system prompt. Client system messages are not forwarded.
- **Single user message**: Only the last user message is processed. Full message history replay from clients is not supported (use `conversation_id` for multi-turn).
- **No image input**: Multi-modal content blocks are converted to text only.
- **Usage tokens**: May be estimates depending on provider. Exact tokens are returned when available from the upstream provider.

---

## Configuration Reference

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `VODOU_OPENAI_COMPAT_TOKEN` | _(unset)_ | Bearer token for `/v1` auth. Unset = open access. |
| `WEB_PORT` | `8765` | Port for all gateway endpoints including `/v1` |

The `/v1` API uses whatever LLM provider is configured in the gateway Settings page. Change providers, models, and API keys there — the `/v1` endpoint automatically uses the active config.

---

## Troubleshooting

**"Vodou gateway not configured" (503)**
- Open http://localhost:8765/#/settings and configure a provider
- Or set `ANTHROPIC_API_KEY` in `.env` for API mode
- Or install Claude CLI for subscription mode

**"Missing bearer token" (401)**
- You have `VODOU_OPENAI_COMPAT_TOKEN` set in `.env` — include `Authorization: Bearer <token>` in your request
- Or remove/comment out `VODOU_OPENAI_COMPAT_TOKEN` for open localhost access

**Empty responses**
- Check gateway logs: `tail -f /tmp/oi-aigateway.log`
- Ensure Vodou daemon is running: `vodou-core daemon ensure`
- Ensure MCP servers are connected: check http://localhost:8765/#/servers

**Slow first response**
- First request may cold-start the CLI pool (~2-3s). Subsequent requests use the warm pool.
- BrainLoader routing adds ~200-500ms. This is the cost of intelligent routing.

**IDE can't connect**
- Verify gateway is running: `curl http://127.0.0.1:8765/v1/models`
- Check the port matches your IDE config
- If using auth, ensure `apiKey` in IDE config matches `VODOU_OPENAI_COMPAT_TOKEN`
