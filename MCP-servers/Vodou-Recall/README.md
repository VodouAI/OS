# Vodou-Recall MCP Server

FTS5-backed conversation history search for Vodou. Phase 4 of PLAN-LONG-CONVO-RECALL.md.

## What it does

Exposes one MCP tool — `search_conversation` — that performs a full-text search
over `gateway_messages.content`, scoped strictly to a single `conversation_id`.
Results are bm25-ranked (lower rank = more relevant).

The tool is meant to be called by an LLM when the user references something
discussed earlier in the same conversation that's no longer in the LLM's
context window.

## Why this server exists

claude-cli already receives a Bash invocation path
(`node MCP-servers/Vodou-Console/scripts/convo-recall.mjs ...`) injected into
its system prompt on every cold-spawn turn, so it can do recall without going
through MCP at all.

This server is for **API-based providers** (Anthropic API, OpenAI, OpenRouter,
Ollama) that don't have a Bash escape hatch and instead need a proper
MCP-protocol tool to call. Same backend, different transport.

## Requirements

- Node ≥24 (FTS5 ships in the bundled SQLite there; Node 22 lacks it)
- `gateway.db` populated by Vodou-Console gateway
- Vodou-Console must have created the `gateway_messages_fts` virtual table
  (happens automatically on first gateway boot)

## Tool signature

```json
{
  "name": "search_conversation",
  "input_schema": {
    "conversation_id": "string (required)",
    "query": "string (required)",
    "max_results": "integer (1-25, default 5)"
  }
}
```

Returns:

```json
{
  "results": [
    {
      "id": 1234,
      "role": "user" | "assistant",
      "content": "...",
      "created_at": "2026-05-15 04:16:19",
      "rank": -10.64
    }
  ],
  "count": 1
}
```

`note` is included on the response when something prevented a real query
(missing db, empty query, FTS5 unavailable). The LLM should treat `note` as
diagnostic, not as data.

## How queries are sanitized

FTS5 treats `-`, `:`, `*`, `^`, parens, and double-quotes as operators.
Free-form queries like `narwhal-quasar-7783-baseline` would otherwise parse
hyphens as token separators and produce `no such column: quasar`.

The server strips those characters, tokenizes on whitespace+punctuation,
drops tokens <2 chars, caps at 8 tokens, double-quotes each, and AND's them.
This trades a tiny bit of precision for robustness — the LLM doesn't have to
know FTS5 syntax.

## Env

- `GATEWAY_DB_PATH` — override the path to gateway.db (default:
  `<project_root>/MCP-servers/Vodou-Console/gateway.db`)
