# Vodou Core HTTP API

The Vodou Rust binary (`vodou-core` daemon) exposes a typed HTTP API on **`http://127.0.0.1:8766`** for the Console and any other local client. Bound to localhost only — not network-accessible.

## What it covers

29 documented endpoints across servers, tools, OAuth, automations, hooks, schedule, memory, and **continuity (v2)**. Two are public (`/health`, `/openapi.json`); the rest require Bearer auth.

## Authentication

A per-install shared secret is generated at first daemon start and written to `.vodou/console.token` (mode `0600`). Read it from there and send as:

```
Authorization: Bearer <token>
```

## Public endpoints

| Method | Path | Returns |
|---|---|---|
| GET | `/health` | `{ ok, service, version }` — no auth |
| GET | `/openapi.json` | full OpenAPI 3.0 spec — no auth |

## Discovering the surface

```bash
curl -s http://127.0.0.1:8766/openapi.json | jq '.paths | keys[]'
```

The spec is the source of truth — it lists every method, parameter, request body shape, and response schema for the protected routes.

## Continuity primitive — v2 endpoints (added v0.5.74)

The `/api/v2/...` endpoints are the canonical surface for the continuity primitive (cross-surface user identity + memory). Every external SDK consumer should use them; the legacy `/api/memory/search` endpoint stays available with deprecation headers but is scheduled for sunset.

### `POST /api/v2/memory/recall` — canonical memory read

Replaces `POST /api/memory/search`. Adds principal-scoped filtering, scope filtering (per surface or per conversation), per-state SLO contract, and provenance fields.

**Request body:**

```json
{
  "query": "string (required)",
  "k": 5,
  "principal_id": "principal:self:... (optional — filter to this principal)",
  "tenant_id": "self (optional — multi-tenant hedge, defaults to 'self')",
  "scope_filter": "all | { \"surfaces\": [\"slack\", \"telegram\"] } | { \"conversation_id\": \"workbench:...\" }",
  "max_age_secs": 604800,
  "include_unverified": false,
  "provenance": true
}
```

**Response:**

```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "chunk_id": "memory/2026-05-09.md:123:abcd",
        "chunk_scope": "workbench:channel:slack",
        "principal_id": "principal:self:1778303508215935",
        "surface": "slack",
        "provenance_scope": "workbench:channel:slack",
        "score": 1.0389,
        "raw_vector_sim": 0.39,
        "text": "...",
        "path": "memory/2026-05-09.md",
        "created_at": "2026-05-09 14:30:00",
        "pinned": false,
        "chunk_tag": "DECISION"
      }
    ],
    "latency_ms": 415,
    "slo_state": "warm",
    "fallback_path": null
  }
}
```

**SLO contract:** `slo_state` is one of `"warm"` (≤500 ms), `"cold"` (≤2000 ms), or `"recovery"` (≤3000 ms). When the deadline trips, `fallback_path` is set to `"rrf-only"` (rerank skipped) or `"empty"` (no results); the response is still 200 OK.

### `POST /api/v2/channels/turns` — canonical channel inbound write

The endpoint that npm channel packages (`@vodou/channel-slack`, `-telegram`, etc.) call to record an inbound turn. Routes through the `record_turn` chokepoint so every external integration inherits principal-aware persistence by default.

**Request body:**

```json
{
  "principal_id": "principal:self:...",
  "surface": "slack | telegram | discord | whatsapp | imessage | googlechat | web | voice | cli | claude-code-hook | cursor",
  "role": "user | assistant | system | tool",
  "content": "...",
  "conversation_id": "optional — defaults to workbench:surface:<surface>",
  "occurred_at": "optional ISO-8601 — defaults to now",
  "surface_external_id": "optional — slack message ts, telegram message id, etc."
}
```

**Response:** `{ ok, data: { gateway_message_id, principal_id, conversation_id, recorded_at_ms } }`. `400` on invalid surface or empty content; `503` if gateway.db is missing. Full schema is in `/openapi.json` under `paths./api/v2/channels/turns.post`.

### Legacy endpoint deprecation

`POST /api/memory/search` returns three RFC-standard headers on every response, indicating its successor:

```
Deprecation: true
Sunset: Mon, 01 Jun 2026 00:00:00 GMT
Link: </api/v2/memory/recall>; rel="successor-version"; type="application/json"
```

The endpoint will continue to work bit-for-bit identically to today during the deprecation window. New integrations should use `/api/v2/memory/recall`.

## Generated TypeScript SDK

Console-side code uses a generated SDK so requests and responses are typed end-to-end against the live spec:

```ts
import { core, type Schemas } from './core-sdk.js';

const r = await core.GET('/api/servers');
if (r.error) throw new Error(r.error.error);
const servers = r.data?.data?.servers;     // typed: Schemas['Server'][]
```

Regenerate types after the spec changes:

```bash
cd MCP-servers/Vodou-Console
npm run gen:core-api    # writes src/core-api.ts from /openapi.json
```

The runtime client (`src/core-sdk.ts`) is a thin wrapper around `openapi-fetch` that loads the per-install token lazily on first call.

For ad-hoc CLI use, either `curl` against `/openapi.json` or use the hand-written facade in `src/core-client.ts` (`VodouCore.searchMemory(...)`, etc.) which still works alongside the generated SDK.

## Versioning

`info.version` in the spec tracks the Vodou release version. The Console does not currently hard-fail on version mismatch — that pre-flight check is on the v0.5.38 release-prep list.

## Related

- **[setup.md](setup.md)** — daemon start, project layout, where `.vodou/console.token` lives
- **[openai-compatible-api.md](openai-compatible-api.md)** — separate OpenAI-compatible chat API on port 8765 (the gateway / Console UI), distinct from the core API on 8766
- **[messaging.md](messaging.md)** — channel install/uninstall endpoints (`/api/channels/*`) live in the Console (8765), not core (8766)
- **[vodou-memory.md](vodou-memory.md)** — what `principal_id`, `surface`, and `scope_filter` mean conceptually; how the recall pipeline composes
- **[runtime-observability.md](runtime-observability.md)** — `runtime.components.continuity` health surface (`principals_count`, `slo_violations_24h`, resolver cache hit ratio)
