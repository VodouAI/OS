# Gateway chat debugging (Vodou-Console)

Use this when the **web chat UI shows history** but the **model acts like the thread is empty**, when **streams never appear until refresh**, or when you need a **single support snapshot** from a running gateway.

## UI history vs LLM context (two paths)

| Path | Source | Purpose |
|------|--------|---------|
| **Web UI** | `loadRecentMessages` / `loadMessagesOlderThan` in `conversation-store.ts` | Tabs, “Load earlier”, WebSocket `history` / `switch_conversation` |
| **LLM** | `loadMessages` in `conversation-store.ts`, called from `conversation-hydrate.ts` | Seeds the in-memory `ConversationManager` before `chat()` when it was empty |

`llm.ts` does **not** call `loadMessages` directly. After a gateway restart (or any cold in-memory state), **`hydrateLlmConversationFromDb(conversationId, pendingUserPlain?)`** replays recent rows from `gateway.db` into the conversation manager so the provider sees prior turns. The UI already loaded the same data for display; this keeps the LLM path aligned.

**This is chat transcript context** (what you already said in this thread in the gateway UI), **not** Vodou **project memory** (`memory.db` / daemon recall / promoted bullets). Hydration fixes “model forgot the conversation after a gateway restart”; it does not replace or fix the recall pipeline.

## “Reply stops halfway” / frozen assistant bubble

Several different causes look the same in the UI:

1. **Extended thinking / reasoning with no text yet** — Some models stream `thinking_delta` (Claude CLI / Anthropic SDK) or `reasoning_content` (OpenAI-compat) long before the first answer token. The gateway now emits a **one-shot `status` event** (“Model is reasoning…”) on those streams so the chat shows work in progress instead of a dead gap. Answer text still only appears when the provider sends real content.

2. **MCP / BrainLoader stalls** — e.g. **Vodou-channels** stdio failing or timing out (~30s+) can block the pipeline before the model streams; fix the failing server or install. Check gateway stderr and `./vodou-core health-check`.

3. **True truncation** — `max_tokens`, provider `stop_reason`, or `[stream-aborted: no content]` in logs; inspect `[CLI pool] RESULT` and provider responses.

- **Env:** `VODOU_LLM_SEED_MAX_MESSAGES` (default `80`, clamped 10–200) caps how many DB rows are replayed.
- **Duplicate user line:** If the WebSocket handler has already `saveMessage`’d the current user turn, pass the cleaned plain text as `pendingUserPlain` so the last DB user row is skipped once when hydrating.

Relevant files:

- `MCP-servers/Vodou-Console/src/conversation-hydrate.ts`
- `MCP-servers/Vodou-Console/src/conversation-store.ts` (`loadMessages` vs `loadRecentMessages`)

## Localhost diagnostics JSON

```bash
curl -sS http://127.0.0.1:8765/api/system/diagnostics | jq .
```

Only works from **loopback**. Includes **`gateway_debug`**:

- **`last_stream_no_clients`** — `streamToConversation` had no WebSocket client whose server-side `conversationId` matched the event (possible mismatch: UI stuck streaming while DB still saves). Logs also emit `[Gateway DIAG] streamToConversation: no WS client matched …`.
- **`last_chat_failure`** — last thrown error from a `chat()` path (conversation id, optional `turnId`, error string, timestamp). Cleared on the next successful `chat()` completion on instrumented paths.

## Server logs: `turnId`

Gateway logs include a per-turn UUID on `chat()` entry, e.g.:

`[Gateway DIAG] chat() ENTRY turnId=… convId=…`

Correlate one user message with gateway stderr / `.vodou/system.log` without guessing from timestamps alone.

## Browser: WebSocket conversation mismatch

If chunks arrive for a **different** conversation than the active tab, the client **buffers** them for that tab (by design). To surface that in the devtools console:

```js
localStorage.setItem('VODOU_DEBUG_WS', '1');
```

Reload the chat page. When a `chunk` or `done` is not applied to the active tab, you’ll see `[VODOU_DEBUG_WS] …` warnings with `eventConv` vs `activeConv`.

Remove with `localStorage.removeItem('VODOU_DEBUG_WS')`.

## Related

- [troubleshooting.md](troubleshooting.md) — doctor, kernel health
- [runtime-observability.md](runtime-observability.md) — daemon/worker/gateway hygiene
