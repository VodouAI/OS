# Structured Output — API-Enforced LLM Response Shapes

Vodou's janitorial LLM lanes (question-key generation today; extraction and
reconcile candidates tomorrow) can have their output shape **enforced by the
provider's API** instead of asked for in the prompt and defensively parsed.
Where enforcement is available, malformed JSON becomes impossible; where it
isn't, the call declines *before any LLM spend* and the caller runs its
normal prompt-and-salvage path — structured can never make things slower,
costlier, or worse.

Design + rationale: `PLANS/0.6.18/done/PLAN-STRUCTURED-OUTPUT-FRAMEWORK.md`.
Code: `src/structured_output.rs`.

## How it works

```
llm_completion_structured(config, prompt, system, "<lane>")
  ├─ resolve effective provider (no LLM call)
  ├─ unsupported provider / kill switch / demoted lane → Err immediately
  ├─ anthropic        → forced strict tool call ("emit" tool, input_schema)
  │                     → answer read from tool_use.input (API-validated)
  ├─ any OpenAI-compat → response_format: {type: json_schema, strict: true}
  │   (openai, google, groq, deepseek, xai, mistral, openrouter,
  │    fireworks, together, kimi, custom, vodou)
  └─ returns schema-validated serde_json::Value
```

A lightweight dependency-free validator re-checks the result (type /
required / enum / items) as belt-and-suspenders on top of the API guarantee.

**Callers keep their salvage path.** Pattern (keygen is the reference
implementation, `src/memory/keygen.rs`):

```rust
match structured_output::llm_completion_structured(cfg, &prompt, sys, "keygen_questions") {
    Ok(value) => adapt(value),                  // guaranteed shape
    Err(_)    => classic_prompt_and_salvage(),  // exactly one normal call
}
```

## Lanes and schemas

A **lane** is a named JSON Schema. Current lanes:

| Lane | Consumer | Shape |
|---|---|---|
| `keygen_questions` | `mem keygen` + daemon keygen task | `{facts:[{fact:int, questions:[string]}]}` |
| `extraction_facts` | reserved (extraction still emits markdown bullets by design) | `{facts:[{text, tag, questions}]}` |

Schema resolution per call:

1. **Runtime override:** `.vodou/schemas/<lane>.json` — edit it and the next
   LLM call uses it. No rebuild, no restart. A malformed override logs a
   warning and falls back (an override can degrade you, never break you).
   Delete the file to return to the default.
2. **Compiled default:** `schemas/<lane>.json` in the repo (baked in at
   build time).

**Schema rules** (both Anthropic strict tools and OpenAI strict json_schema):
object root (wrap arrays), `"additionalProperties": false` on every object,
every property listed in `"required"`, no recursion, no numeric min/max —
keep bounds in the prompt and enforce them in the caller's adapter.

## Adding a lane (~10 lines)

1. Write `schemas/<name>.json` following the rules above.
2. Add one row to `LANES` in `src/structured_output.rs` (name, include_str,
   one-line description — the description becomes the tool description on
   the anthropic lane).
3. Call `llm_completion_structured(config, prompt, system, "<name>")` from
   the consumer and adapt the returned `Value`.

## Adding / adjusting a provider

- A new OpenAI-compatible provider needs **nothing** — the family default
  applies as soon as its dispatch arm goes through `llm_openai_compat`.
- A provider with a novel enforcement shape (e.g. llama.cpp `format:`
  grammar for the local-workhorse plan) = add it to `NATIVE_PROVIDERS` and
  thread the request field in its builder.
- Providers that can't enforce (claude-cli, ollama today, script,
  heuristic) simply stay off the list — callers fall back automatically.

## Safety valves

| Knob | Effect |
|---|---|
| `VODOU_STRUCTURED_MODE=off` | Global kill switch — every lane declines pre-call |
| Automatic demotion | A provider 4xx naming the enforcement feature (`response_format` / `json_schema` / `tool_choice` / `strict` / `unsupported`) demotes that lane to the salvage floor for the process lifetime — one warning, no error storm. Restart clears it. |
| Runtime override logging | Using a `.vodou/schemas/` override logs one line per process so hot-patched schemas are visible in system.log |

## Verification

Unit: `cargo test -- structured_output` (registry, validator, demotion,
provider table). Live: force a native provider for one keygen batch —

```bash
ANTHROPIC_API_KEY=<key> VODOU_MEMORY_EXTRACTION_PROVIDER=anthropic \
  vodou-core mem keygen --batches 1
# system.log should show: "[keygen] structured lane returned N fact(s)"
```

Live-verified 2026-07-18 against the real Anthropic API: 30 facts → one
strict tool call → 60 schema-valid keys, while the daemon's claude-cli lane
correctly declined pre-call and used the salvage path.

## Related docs

- [memory-extraction-pipeline.md](memory-extraction-pipeline.md) — the pipeline these lanes serve
- [vodou-memory.md](vodou-memory.md) — the memory system end to end
