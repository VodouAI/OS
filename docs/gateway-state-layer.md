# Gateway State Layer (prompt caching + bounded context)

**Make every stateless API model behave like the warm `claude -p` subprocess: cheap, cacheable re-sends and a bounded, never-ballooning context — so open models on a managed provider stay both cheap and sharp under agentic load.**

Added in the **0.6.5** release lane (`PLANS/0.6.5/PLAN-GATEWAY-STATE-LAYER.md`). Lives entirely in the TypeScript gateway (`MCP-servers/Vodou-Console/`) plus a one-line forward in the managed LLM proxy. Most pieces ship **on for the managed `vodou` tier, off for BYOK/other installs** — see [Flags](#flags).

---

## Why this exists

The model runs on the **provider's** GPUs. Fireworks / Kimi / DeepSeek / OpenAI chat-completions are **stateless** — they keep nothing between calls. We can't make the provider remember; we must transmit the context it needs **every** turn. "Stateful from our end" therefore means one thing:

> We hold the canonical conversation and send the provider a **minimal, bounded, cacheable view** of it every turn.

That captures both wins the warm `claude -p` gets:

- **Cheap re-sends** — a byte-stable prefix the provider **prompt-caches** (our equivalent of Anthropic native caching).
- **Small payload** — compaction + out-of-band handles so the array never balloons.

Without this, agentic turns balloon (a live board task hit ~273K tok/turn) and the open-model COGS advantage leaks back out. This layer is what keeps it.

> **How Claude itself does it (for contrast):** the warm `claude -p` does **not** "send the bootstrap once." It re-sends system + history every turn wrapped in `cache_control`, billed at ~10% on cache hits — the "stateful feel" is *caching*, not omission. True server-side send-once exists only on OpenAI's stateful Responses API. On a stateless API, "send once" can only mean *drop after turn 1* — which is exactly what Vodou's bootstrap does (see [WS2](#ws2--stable-cache-prefix)).

---

## The shape of a request

Every provider request is assembled as ordered regions; the front is frozen so the provider caches it:

```
┌ STABLE PREFIX  ── system prompt + tool defs              → byte-identical across turns → provider CACHES (cost ↓)
├ VOLATILE TAIL  ── per-turn memory recall + scope         → bounded, sits AFTER the cached prefix
├ RECENT WINDOW  ── last N turns verbatim                  → bounded
└ HANDLES        ── big tool results parked out-of-band; head + expand_result(id) → never re-sent (count ↓)
```

The full state (history + rolling summary + parked blobs) lives in **our** store, keyed by `conversationId`. The provider only ever sees the bounded view.

---

## Workstreams

### WS1 — Cache observability
A `[cache]` log line on the OpenAI-compat streaming path prints `prompt= cached= (% hit) out= model=` from `usage.prompt_tokens_details.cached_tokens`. This is how you confirm caching is actually firing (see [Verifying](#verifying-it-works)). Gated by `VODOU_TOKEN_DIAG` (on unless set to `0`).

### WS2 — Stable cache prefix
On the OpenAI-compat path (`chatWithOpenAICompat`), make the request **front byte-identical** every turn so the provider caches `[system + tool-defs (+ prior turns)]`:

- The **workspace bootstrap** (AGENTS.md operating manual + MEMORY.md, ~6–24K) is sent **once per conversation** (the original design — re-sending it to cache it bills at ~50% on Fireworks, which loses to simply not sending it). The model keeps the always-sent core system prompt + history + per-turn recall.
- The **query-dependent memory recall** is **relocated out** of the system message into a late turn (just before the current user turn) — so the system prompt stays byte-stable and only the volatile tail changes. Scope stays in the prefix (constant per conversation).
- A **session-affinity key** is set on every request: the `user` body field **and** the `x-session-affinity` header (both keyed by `conversationId`) so serverless routing keeps the warm replica under multi-replica/concurrent load.

**Measured:** identical prefix → ~93–97% cache hit, with a **~2-turn warm-up** (turns 1–2 read ~0% before the cache write lands — don't judge a single turn). **Live on the managed tier:** 86% hit on a warm turn through the proxy.

Flag `VODOU_COMPAT_STABLE_PREFIX` — **default ON for the managed `vodou` provider**, OFF for BYOK/other OpenAI-compat installs; explicit env (`0`/`1`) always wins.

### WS3 — Anthropic-SDK cache breakpoints
The direct `anthropic` SDK provider got **zero** caching (only the claude-CLI path caches natively). WS3 adds `cache_control: {type:'ephemeral'}` breakpoints on the **system block** and the **last tool def** at both SDK stream sites. Anthropic's cache order is tools→system→messages, so the tool-defs breakpoint hits even when volatile memory in `system` changes turn-to-turn. Flag `VODOU_SDK_CACHE_CONTROL` — **default ON**; set `0` to disable.

### WS4 — Truncate-with-handle + `expand_result`
The structural fix for the agentic balloon. At the tool-result sink, any result over `VODOU_TOOL_RESULT_CAP` (default **16000 chars**) keeps only the **head** inline and **parks the full blob out-of-band** (`.vodou/tool-results/<id>.txt`, ~24 h), appending a handle:

```
…[<label> truncated: showing first N of M chars. … call expand_result with id="…" (optional offset / query) to read the rest.]
```

Because the full blob lives out-of-band, it is **never re-sent across tool iterations** — killing the multiplier for *every* MCP server, present and future, with no per-tool code. A new built-in **`expand_result(id, offset?, query?)`** tool retrieves more:

- `offset` — 0-based char offset; the response includes `next_offset` to paginate (8K-char windows).
- `query` — return only lines containing the substring (case-insensitive), bounded.

`expand_result` is **always available** (in the base tool surface, not FS-gated) so the managed/non-FS tier can expand `list_available_tools` / `board_show` / `vodou_core_call` results too. **On by default.**

### WS5 — Rolling-summary compaction
When a conversation crosses the compaction threshold, the oldest turns are replaced by a **real LLM summary** (`## Earlier in this conversation`) instead of the legacy first-N-chars truncation — keeping long chats both bounded **and** coherent. The summary is:

- generated by a cheap background `rawLLMCall` (inherits the gateway provider → kimi on managed),
- **refreshed in the background** (fire-and-forget) every `VODOU_ROLLING_SUMMARY_EVERY` messages (default **6**), so the synchronous compaction site never blocks the turn — it reads the latest cached summary and falls back to the naive summary until the first refresh lands and on any LLM failure,
- placed in the **volatile tail** (after the stable prefix), so it doesn't churn the cache.

The last `KEEP_RECENT` turns always stay verbatim. Flag `VODOU_ROLLING_SUMMARY` — **default ON for the managed `vodou` provider**, OFF otherwise; explicit env wins.

### WS6 — Hard per-turn token ceiling
A backstop for runaway agentic turns that WS4/WS5 miss. When cumulative input billed across a turn's tool rounds crosses `VODOU_TURN_TOKEN_BUDGET`, the tool loop **ends early** (after ≥1 round) and streams a final answer from the context gathered so far, logging loudly (`🛑`). Default **0 = disabled (opt-in)** — set e.g. `250000` to arm it. The separate `VODOU_TURN_TOKEN_WARN` (default 120000) only logs, never cuts.

---

## Managed tier vs BYOK

The flags that change model-visible behavior (WS2, WS5) **default ON only when the active provider is `vodou`** (the Vodou-managed Fireworks tier) and OFF for BYOK / other OpenAI-compat installs, so self-hosters aren't opted into a behavior change without choosing it. An explicit env var (`0`/`1`) always overrides the default either way. WS3 and WS4 are pure/transparent wins and default ON everywhere; WS6 is opt-in everywhere.

### Proxy: session-affinity passthrough

Managed-tier requests route through the standalone LLM proxy (`llm.vodou.ai`). The proxy forwards the request **body** intact (so the `user` affinity field survives) and now also forwards the **`x-session-affinity`** / `x-prompt-cache-isolation-key` / `x-multi-turn-session-id` headers to Fireworks — without this, WS2's header-based affinity is dropped at the proxy hop. (Canonical source: `app-vodou-ai/proxy/src/server.mjs`.)

---

## Flags

| Var | Default | Effect |
|---|---|---|
| `VODOU_COMPAT_STABLE_PREFIX` | on for `vodou`, else off | WS2 stable prefix + memory relocation + session affinity |
| `VODOU_SDK_CACHE_CONTROL` | `1` (on) | WS3 Anthropic-SDK `cache_control` breakpoints |
| `VODOU_TOOL_RESULT_CAP` | `16000` | WS4 inline char cap; above it → head + `expand_result` handle |
| `VODOU_ROLLING_SUMMARY` | on for `vodou`, else off | WS5 rolling LLM-summary compaction |
| `VODOU_ROLLING_SUMMARY_EVERY` | `6` | WS5 background-refresh cadence (messages) |
| `VODOU_TURN_TOKEN_BUDGET` | `0` (off) | WS6 hard cut once cumulative turn input exceeds this |
| `VODOU_TURN_TOKEN_WARN` | `120000` | Warn-only cumulative-input threshold (logs, no cut) |
| `VODOU_TOKEN_DIAG` | on unless `0` | WS1 `[cache]` + `[token-budget]` diagnostic logs |

All are read from `process.env` and take effect on a gateway restart (no hot-reload).

---

## Verifying it works

1. Ensure diagnostics are on (`VODOU_TOKEN_DIAG` unset or non-`0`).
2. Send a **warm conversation** (3–4 turns, same `conversationId`) on the managed tier and watch the gateway log:

   ```
   [cache] conv=… prompt=8060 cached=1    (0% hit)   …   ← turn 1 cold
   [cache] conv=… prompt=7800 cached=0    (0% hit)   …   ← turn 2 warm-up
   [cache] conv=… prompt=7946 cached=7411 (93% hit)  …   ← turn 3+ caching
   ```

   Expect the **~2-turn warm-up**, then `cached` climbing toward the stable-prefix token count. `usingManagedProxy=true` on the `[TRACK-DIAG] dispatchToProvider` line confirms it's flowing through the proxy.
3. For WS4: a data-heavy tool call truncates with a `call expand_result with id="…"` note; calling `expand_result` returns a bounded window with `next_offset` to paginate.
4. For WS6 (when armed): the `🛑 … CUT` line appears and the turn still returns an answer.

---

## Notes & limits

- **Periodic cold misses are inherent to serverless.** Even with a byte-stable prefix and session affinity, a single caller sees ~15–30% cache misses from Fireworks replica rebalancing/eviction — measured the same with or without affinity. Affinity's payoff is multi-replica/concurrent routing, not single-caller variance. The only full fix is a **dedicated / self-hosted** deployment (own the KV-cache with vLLM/SGLang sticky sessions) — a roadmap item, not part of this layer.
- **WS2 is conditional, not universal.** Its win is large for agentic / long / large-memory turns (where the re-sent content is unavoidable and big) and roughly cost-neutral for short Q&A. It is a quality+cost shaping, not a guaranteed per-turn discount.
- **WS5 is lossy by design** — it only triggers on long conversations and replaces detail with a summary; the recent window stays verbatim.
- **First-party list-tool compaction (would-be WS7) is deferred** — its generic value is already delivered by WS4; the semantic part (e.g. show `from/subject/date`) belongs as a `compact` param on the MCP servers' `*_list` tools, not a fragile gateway-side compactor.
