# Vodou Memory System

Vodou's memory system is a persistent, queryable knowledge layer that survives across conversations, sessions, and even software updates. It is the foundation that lets Vodou act with continuity instead of treating every conversation as the first.

## Architecture overview

```
┌────────────────────────────────────────────┐
│  Conversation sources                       │
│  ─────────────────                          │
│  • CLI prompts (vodou-hook-bin sock prompt) │ ─┐
│  • Claude Code / Cursor SessionEnd          │  │
│  • Gateway web chat (gateway_messages)      │  │
│  • Channels: Slack/TG/Discord/WhatsApp/iMSG │  │  scope-tagged
│  • ExecDesk personas, automations, skills   │  │  bullets
└────────────────────────────────────────────┘  │
                                                ↓
                ┌────────────────────────────────────────────┐
                │  memory_extraction (single shared pipeline) │
                │  • Same 12 [TAG] vocabulary everywhere      │
                │  • Same prompt + LLM provider (Haiku/auto)  │
                │  • Heuristic fallback if LLM unavailable    │
                └────────────────────────────────────────────┘
                                                ↓
       ┌────────────────────────────────────────────────────────┐
       │  Daily log: <workspace>/memory/YYYY-MM-DD.md           │
       │  + chunker → memory.db (SQLite + FTS5 + embeddings)    │
       └────────────────────────────────────────────────────────┘
                                                ↓
       ┌────────────────────────────────────────────────────────┐
       │  Background pipeline (scheduler-driven)                │
       │  - mem flush             (post-session — CLI/IDE)     │
       │  - gateway_extractor     (every 5 min — auto-cadence) │
       │  - mem promote-micro     (every 5 min)                 │
       │  - mem promote           (weekly)                      │
       │  - mem compact           (daily, opt-in)               │
       │  - mem janitor           (weekly, opt-in)              │
       │  - mem archive           (>30 day files)               │
       └────────────────────────────────────────────────────────┘
                                                ↓
                                    ┌──────────────────┐
                                    │  BrainLoader     │
                                    │  retrieval on    │
                                    │  every prompt    │
                                    │  (cosine + RRF + │
                                    │   BGE reranker)  │
                                    └──────────────────┘
```

### Source coverage by surface

| Surface | Capture path | Default extraction |
|---------|--------------|--------------------|
| CLI / Claude Code / Cursor | `vodou-hook-bin sock prompt` → daemon buffer → flush | ✅ on |
| Gateway web chat (`/#/chat`) | `gateway_messages` → gateway_extractor (5 min) | ✅ on |
| Workbench / automations / skills / ExecDesk | `gateway_messages` → gateway_extractor | ✅ on |
| Slack, Telegram, Discord, WhatsApp, iMessage | `gateway_messages` → gateway_extractor | ⏸️ opt-in (see Privacy gate below) |

**Every surface uses the same extraction prompt, same 12 canonical tags, same LLM provider config.** A `[DONE]` bullet from a Slack DM looks identical to a `[DONE]` bullet from Claude Code, except for the `scope:channel:slack` prefix that lets recall filter by source if desired.

## Storage layout

| Path | Purpose |
|---|---|
| `memory.db` | SQLite DB containing `memory_chunks` table + FTS5 index + embedding column. Lives next to `vodou-core.db` at the project root. |
| `<workspace>/memory/YYYY-MM-DD.md` | Daily memory log files (markdown bullets, one file per day). Source of truth that the chunker indexes into `memory.db`. |
| `<workspace>/memory/MEMORY.md` | Curated long-term memory — durable facts, decisions, preferences. Always injected into agent context. |
| `<workspace>/memory/archive/YYYY/MM/` | Daily logs older than 30 days, archived (planned: monthly compaction by janitor). |
| `<workspace>/memory/janitor-YYYY-MM-DD.md` | Janitor run reports (one per run, dry-run or live). |
| `.vodou/.janitor_state` | JSON state file: `last_run`, `chunks_at_last_run`, `dry_run_count`, `total_runs`. |
| `.vodou/.janitor_lock` | RAII lock file (PID), 10-min stale auto-expiry. |

## Continuity primitive (added v0.5.74)

Vodou v0.5.74 made "the user" a real first-class entity that follows you across every surface. Before continuity shipped, identity was implicit (single-user installs + per-channel chat collapsing did most of the work). After continuity shipped, every turn carries an explicit `principal_id`, every read filters by it, and every recalled chunk knows which surface it came from.

### What's new at the data level

| Column | Where | What it stores |
|---|---|---|
| `principals.id` | `vodou-core.db` | Stable ULID per user (`principal:self:<ts>` for the install owner; `principal:assistant` reserved for assistant turns) |
| `principal_aliases` | `vodou-core.db` | Maps `(surface, external_id)` → `principal_id`. Channels mint aliases on first sight (currently all collapse to self until Phase 3 multi-principal lands) |
| `tenants.id` | `vodou-core.db` | Multi-tenant hedge. Today every install has `tenant_id='self'`; enterprise multi-tenant becomes a bolt-on, not a refactor |
| `memory_chunks.principal_id` | `memory.db` | Every chunk attributes to a principal — file-indexed, gateway-extracted, hook-recorded, all backfilled |
| `gateway_messages.principal_id` | `gateway.db` | Every turn (web chat, Slack DM, Telegram message, hook prompt) stamps the principal at write time |
| `gateway_conversations.scope_filter_mode` | `gateway.db` | `"all"` (default — recall reaches every surface) or `"surface"` (recall stays inside the conversation's own surface) |

### The two chokepoints

The whole primitive enforces itself through two single-entry-point APIs in the Rust core:

- **Write chokepoint — `record_turn`** (`src/continuity/record_turn.rs`)
  Every inbound turn — from any surface — INSERTs into `gateway_messages` through this one function. CI lint (`scripts/lint-continuity-boundary.sh`) bans direct `INSERT INTO gateway_messages` outside the allowlist. Hooks, channels, the npm SDK, the `POST /api/v2/channels/turns` endpoint — all converge here.
- **Read chokepoint — `recall`** (`src/continuity/recall.rs`)
  Every memory query — from any caller — runs through this function. CI lint bans direct `MemorySearch::search_*` outside `src/continuity/`. The legacy `POST /api/memory/search` endpoint and the v2 `POST /api/v2/memory/recall` endpoint both flow into the same function; the difference is the wire shape, not the search behavior.

A bypass anywhere in the codebase is structurally impossible without disabling the lint — which CI catches.

### Provenance, visible to the user

Once chunks carry surface metadata, the UX surfaces it:

- **Web chat "see why" modal** (`MCP-servers/Vodou-Console/public/js/views/chat.js`) — opens to a list of chunks that informed the response. When ≥1 chunk has a parseable surface scope, a rollup line at the top reads `↳ recalled from: slack, telegram`. Each per-chunk row that's surface-tagged shows its own `↳ recalled from <surface>` line. File-indexed chunks (scope `web`) render no surface line — silent by spec.
- **Hook injection** (`<continuity-source>` block) — when Cursor / Claude Code / Codex hooks pull memory context, a discreet 3-line block above the recalled memories names the surfaces and chunk count: `<continuity-source>\n  surfaces: slack, telegram\n  chunks: 5\n</continuity-source>`. Lets the agent in-IDE know where the context is sourced from.

### Surface enum (15 variants, expanding)

Every turn declares its `Surface` from a fixed enum (`src/continuity/principal.rs::Surface`). Today's variants:

- `Web` (gateway desktop chat)
- `ClaudeCodeHook`, `Cursor`, `Cli` (developer surfaces)
- `Slack`, `Discord`, `Telegram`, `WhatsApp`, `IMessage`, `GoogleChat` (channels)
- `Voice`, `Workbench`, `Skill`, `Automation`, `Persona`

Adding a new surface = one variant + one TOML registry stanza + one ~50-line adapter (see `PLAN-HOST-ADAPTER-UNIFICATION.md`).

### What you can do with it today

Practical recipes that work in v0.5.74+:

```bash
# Quick CLI recall (agent / scripting ergonomic) — routes through the same
# daemon `cmd:"search"` socket that BrainLoader uses internally.
vodou-core mem search "continuity primitive" --top-k 5
vodou-core mem search "continuity primitive" --top-k 5 --json | jq '.results[].path'

# Recall everything (default — equivalent to legacy /api/memory/search behavior)
TOKEN=$(cat .vodou/console.token)
curl -s -X POST http://127.0.0.1:8766/api/v2/memory/recall \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"continuity primitive","k":5,"provenance":true}'

# Recall scoped to slack only
curl -s -X POST http://127.0.0.1:8766/api/v2/memory/recall \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"foo","k":5,"scope_filter":{"surfaces":["slack"]}}'

# Recall filtered to a specific principal (everything you've personally said)
curl -s -X POST http://127.0.0.1:8766/api/v2/memory/recall \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"foo","k":5,"principal_id":"principal:self:1778303508215935"}'

# Health check — runtime_status.continuity component
./vodou-core runtime-status --json | jq '.components.continuity'
```

### Hard-filter mode (env-gated)

Today the recall filter is **permissive** — chunks with `principal_id IS NULL` always pass through, even when the caller asks for a specific principal. This was a backwards-compat concession during rollout. Now that 100% of `memory_chunks` have a non-NULL principal (verified in continuity Phase 33), the strict filter is safe to enable:

```bash
VODOU_CONTINUITY_HARD_FILTER=1
```

Set in `.env` to drop NULL-principal rows from filtered recalls. Off by default to avoid surprising rollouts; flip on when you want strict isolation.

## Project axis (per-project memory, PLAN-PROJECT-SCOPED-MEMORY)

Since 2026-07-02, memory has a second ranking dimension alongside `scope`: the gateway **project**. Memories extracted inside a Project (see `docs/gateway-projects.md`) carry that project's id in `memory_chunks.project_id` and, by default, are **hard-filtered out of every other project's recall** — Client A's facts never surface in Client B's chats. This is the per-client isolation piece that Projects Phase 1/2 (conversations, files, instructions, skills) left open.

### How a chunk gets its project

| Write path | Mechanism |
|---|---|
| Tool-usage emit (gateway) | In-band token next to scope: `- [TOOL_USAGE] scope:… project:<id> \| …` |
| Prompt-buffer flush (CLI/IDE + web hook path) | Each buffered entry carries `"project"`; bullets get `project:<id> \|` only when **every** entry in the flush window carries that same project (unanimity — any untagged or cross-project entry → global) |
| Gateway extractor (web chat / channels) | One `gateway_conversations → project_id` lookup per cycle; bullets from a project's conversations get the token |
| Rust chunker | `extract_project()` parses the token into `memory_chunks.project_id` (like `extract_scope()`) |

**Global carve-outs** (chunks that stay `project_id IS NULL` and surface in *every* project):
- All pre-existing chunks (no backfill — nothing retroactively hides)
- Default-project (`proj_default`) conversations — the install root behaves like pre-project installs
- `[PREF]` bullets — preferences describe the user, not the project
- Ambiguous flush windows — any untagged or cross-project entry in the window → no tag (unanimity rule; a wrong tag would *hide* the memory under the hard filter, so ambiguity fails open to global)

### How recall filters

`continuity::recall` accepts `project`; every read surface passes it: daemon `cmd:"prompt"`/`cmd:"search"` payloads (`"project"`), worker brain arg (`memory_active_project`), HTTP (`project` on `/api/memory/search` + `/api/v2/memory/recall`, `memory_active_project` on `/api/brain`), and `VODOU_BRAIN_MEMORY_ACTIVE_PROJECT` for the CLI path. The predicate: **drop chunks whose `project_id` is set and differs from the active project; NULL always passes.** The filter also holds on the degraded FTS-only path (no embeddings), so isolation survives a mis-provisioned daemon. Cache keys mix the project, so projects never share cached result lists.

```bash
# Debug isolation from the CLI
vodou-core mem search "client pricing" --project proj_abc123 --json
```

### Knobs

| Env | Default | Effect |
|---|---|---|
| `VODOU_MEMORY_PROJECT_HARD_FILTER` | `1` (on) | `0` reverts projects to a soft in-project boost (cross-project chunks rank lower but still surface) |
| `VODOU_MEMORY_PROJECT_BOOST` | `2.0` | In-project multiplier when in soft mode (compounds with the scope boost) |

Two independent off-ramps: flip the hard filter off, or stop passing a project (recall reverts to fully shared). Note the contrast with scope: **scope defaults to a soft 2× boost** (cross-tab facts still surface), **project defaults to hard isolation** (client boundaries are absolute).

## Provenance axis (trust tier, PLAN-UNIVERSAL-MEMORY-V2 F1)

Since 2026-07-11, ranking has a third dimension alongside scope and project: **where a chunk came from**. Without it, a throwaway line from a 9-month-old imported ChatGPT session could outrank memory Vodou extracted from your own conversations. The trust multiplier, keyed off the chunk's scope prefix:

| Provenance | Scope prefix | Multiplier |
|---|---|---|
| First-party (gateway chats, channels, workbench, daily logs) | `web`, `gateway`, `channel:%`, `workbench:%`, … | 1.0 (untouched) |
| Live capture lanes (reserved for Phase C) | `capture:%` | × (1 − w/2) |
| Imported history (one-shot exports, browser capture) | `import:%` | × (1 − w) |

`w` is **`VODOU_MEMORY_W_TRUST`** (default `0.15`, so imports score ×0.85; `0` disables). Curated MEMORY.md never competes here — it's injected verbatim every turn, not retrieved from the chunk pool.

Design constraints worth knowing before touching this:
- It's a **soft multiplier, never a filter** — a highly-relevant imported chunk still beats an irrelevant first-party one. (This is what makes "answer a question only your imported history can answer" work: the right import still ranks #1 for its query.)
- It's applied in the **post-rerank loop** (with tag bias / pin boost), not in RRF assembly — the cross-encoder reranker overwrites scores with its sigmoid logits for the top-K head, which would wipe any multiplier baked in earlier. Any future score multiplier has the same constraint.
- Pinned chunks keep their full pin boost regardless of provenance (multiply-then-add ordering).

## Capture lanes (Phase C — passive capture of any AI you use)

Beyond conversations you have *with* Vodou and one-shot imports, Phase C captures AI conversations from other tools into the same brain, provenance-tagged at the `capture:` trust tier (`1 − w/2`, between first-party `1.0` and imported `1 − w` — see §Provenance axis). Captured chunks are never auto-promoted to MEMORY.md and are extra-prunable, exactly like imports.

- **BYOK tee (W1b)** — point any OpenAI-compatible app (Cursor's custom base-URL, Continue, Aider, your own scripts) at Vodou's `/v1` endpoint with an `X-Vodou-App` header. The turn passes through to the real provider and a copy lands as `capture:byok:<app>`.
- **IDE session capture (W1c)** — `mem capture-ide` reads AI-assistant session files IDEs write to local disk (no network, no browser):
  - **Cursor** — `state.vscdb` SQLite: `aiService.prompts` (your prompts) + `aiService.generations` (assistant summaries, timestamped). Watermarked per workspace store. Lands `capture:ide:cursor`.
  - **Claude Code** — `~/.claude/projects/**/*.jsonl` transcripts, offset-watermarked per file, **recent-only by default** (`--since-hours 48`) since Claude Code spawns many session files and is also captured by its SessionEnd hook. Harness cruft (slash-command wrappers, warmup probes, ground-truth blocks) and trivial probe sessions are filtered. Lands `capture:ide:claude-code`.
- **Browser auto-capture (W2a)** — the vodou-bridge extension hooks the network layer (not the DOM) on ChatGPT/Claude and tees each completed turn to `capture:web:<provider>`. Opt-in via the popup's *Auto-capture* checkbox (default off). Per-provider adapters are data; adding Gemini/Perplexity/Grok is one adapter each.
- **Manual capture floor (W2b)** — the universal catch-all: select any text on *any* page → right-click *Send selection to Vodou memory* → `capture:manual:<host>`. Covers surfaces with no adapter; always available (no toggle — it's an explicit per-selection action).

  ```bash
  vodou-core mem capture-ide --source cursor --extract        # capture + distil now
  vodou-core mem capture-ide --source claude-code --since-hours 24
  ```

  **Passive capture (the compounding moat):** set `VODOU_CAPTURE_IDE_ENABLED=1` and the daemon pulls new IDE sessions on an interval automatically — no cron, no command. Off by default (IDE sessions contain your code). Tune with `VODOU_CAPTURE_IDE_SOURCES` (cursor | claude-code | all), `_INTERVAL_SECS` (default 900), `_SINCE_HOURS` (default 48). The push lanes (BYOK tee, browser auto-capture, manual snippets) are already passive when enabled — they fire on traffic/clicks.

  All capture lanes flow through the normal gateway extractor (scope-stamp + dedup + entity-link), so Phase A/B intelligence applies to them automatically. `ide:<app>:<key>` conversation ids resolve to `capture:ide:<app>` via `gateway_extractor::derive_scope`.

## Fact groups (dedup + supersession, PLAN-UNIVERSAL-MEMORY-V2 Phase B)

The same fact accumulates copies — re-extracted across daily logs, duplicated between an import and native memory. `mem dedup scan` clusters near-duplicates into **fact groups**, elects one **canonical** chunk per group, and soft-demotes the rest at retrieval so the canonical owns the top-k slot. Nothing is deleted; reverse any group with `mem dedup clear`.

```bash
vodou-core mem dedup scan     # cluster + elect (pure math, no LLM, ~4s on 3k chunks)
vodou-core mem dedup list     # show groups, largest first
vodou-core mem dedup clear --chunk <id>   # ungroup one chunk/group (or no flag: all near-dup groups)
```

Design points:
- **Two gates, both required** (false-collapse guard): embedding cosine ≥ `--min-cosine` (default 0.88) finds "same meaning"; token-Jaccard ≥ `--min-overlap` (default 0.40, header/scope-stamp lines stripped) blocks "same topic, different fact", which embeds close but shares few concrete tokens.
- **Canonical election ranks provenance before recency** — pinned > first-party > capture > import, then `created_at`, then length. `created_at` on an import chunk is the *import* date, not when the words were originally said, so "newest wins" would let a bulk import steal canonical from native memory.
- **Demotion knob**: `VODOU_MEMORY_W_DUP` (default 0.60 → superseded chunks score ×0.4). Soft, never a filter; applied in the same post-rerank site as the trust multiplier. `ScoreBreakdown.dup_mult` shows it in the visibility UI.
- Sidecar table `memory_fact_groups` (on the heal keep-list — see the gotcha below). Human contradiction-resolutions write rows with `reason='resolution:<id>'`; dedup re-scans never touch those.
- **Value-conflict lane (#3-full):** near-dup pairs whose numeric/date/money/version tokens *conflict* (each side asserts a value the other lacks) are **not grouped** — "pricing is $20/mo" vs "$29/mo" is a change, not a copy, and grouping would silently bury it. They're queued to the contradiction review queue instead (older side plays "history"), covering native↔native and import↔import — pairs the LLM contradiction lanes never see. Hex identifiers (commit hashes, run ids) are excluded from value comparison; pure subsets (one side adds a date qualifier) still group.

## Entity resolution (alias collapse, PLAN-UNIVERSAL-MEMORY-V2 Phase B #4)

"Jim Abraham" and a bare "abraham", "Priest Labs LLC" and "Priest Labs" — one entity, several spellings, scattered across chunks. `mem entities scan` extracts candidates (org-suffixed names, `@handles`, Titlecase name bigrams with a ≥2-chunk frequency floor), collapses aliases, and records chunk↔entity mentions. At retrieval, a query mentioning any alias gets its siblings appended to the **FTS leg only** (embedding, reranker, and MMR see the original query) — so asking about one spelling surfaces chunks that use another.

```bash
vodou-core mem entities scan                # extract + merge (LLM pass capped at 40 pairs)
vodou-core mem entities scan --no-llm       # deterministic merges only
vodou-core mem entities list                # entities, aliases, mention counts
vodou-core mem entities clear               # drop all (expansion off until next scan)
```

Merge ladder, cheapest first: exact normalized key → token-subset with legal suffixes stripped ("Priest Labs" ⊂ "Priest Labs LLC") → unique-surname derived aliases (guarded: a token that also appears as an ordinary lowercase word in the corpus is a common noun, not a surname) → one capped LLM pass over **co-occurring** unmerged pairs (the only step that can know a handle belongs to a person, and co-occurrence in your own chunks is required evidence). Prior merges — including old LLM verdicts — survive re-scans.

Deliberately NOT a knowledge graph (plan §5 scope warning): alias collapse + query expansion only. Kill switch: `VODOU_MEMORY_ENTITY_EXPANSION=0`.

## Contradiction review queue (PLAN-UNIVERSAL-MEMORY-V2 #3-lite)

Imported history sometimes disagrees with current memory — same fact, different value (a company rename, a reversed decision). Instead of letting retrieval silently bury one side, `mem contradictions` finds these and queues them for a human call: *"your ChatGPT history says X; current memory says Y — keep which?"*

```bash
vodou-core mem contradictions scan --max-judgements 25   # find (LLM-judged, capped)
vodou-core mem contradictions list                       # open conflicts
vodou-core mem contradictions resolve <id> --keep native # or --keep import
```

How the scan pairs chunks (then an LLM judge filters, conservative default — unsure ⇒ no conflict):
- **Cosine lane** — each import chunk vs its nearest first-party chunks (`--min-cosine`, default 0.60). Catches same-topic conflicts.
- **Entity lane** — org-suffixed names (`X Inc`, `Y LLC`, …) in import chunks paired against recent chunks naming the *dominant* current orgs. Catches renames/supersessions, whose two sides are usually about **different topics** (the canonical rename pair sits at 0.33 cosine — no similarity gate reaches it). Deliberately no rarity pre-filter: chunks *about* a rename keep incrementing the stale name's mention count, so frequency thresholds rot.

Every judged pair is recorded either way (`no_conflict` rows), so **re-scans only spend LLM calls on new pairs**. The queue (`memory_contradictions` sidecar table in `memory.db`) groups evidence pairs by normalized values — one entry per distinct conflict with a `sources` count — and resolution cascades across the group:
- **keep native** (current memory wins) → the import chunk(s) are superseded: a `superseded_by` pointer in `memory_fact_groups` + retrieval demotion (`VODOU_MEMORY_W_DUP`). Reversible with `mem dedup clear --chunk <id>`.
- **keep import** (history wins) → the first-party chunk(s) are superseded the same way. Pinned chunks are refused — pin is explicit user intent. (`mem reject` remains the hard-delete path for sanitizer-flagged / import-capture content; `mem correct` is the chat/LLM path for fixing any-scope false facts.)

Surfaces: the console **Memory → Imports** tab has a *Contradictions* section (scan button + keep-memory / keep-history per conflict), backed by `GET /api/import/contradictions`, `POST /api/import/contradictions/scan`, and `POST /api/import/contradictions/:id/resolve` on the gateway.

Gotchas if you extend this: new tables in `memory.db` must be added to `heal_polluted_memory_db`'s keep-list (`src/database.rs`) or they're dropped on every DB open; and long LLM-loop CLI commands need an exclusion from the 90s process watchdog in `main.rs` (scan already has one — a mid-scan kill is lossless since verdicts commit incrementally).

## Correct / forget / pin (chat mutation surface, 0.6.19)

When the user says a prior memory was wrong, **do not** only `mem store` / `memory_store` — that leaves the false chunk live and creates dual truths. Use soft-correct:

```bash
# CLI
vodou-core mem correct "Right fact." --wrong "distinctive wrong snippet" --tag CORRECTION --json
vodou-core mem correct "Right fact." --chunk-id '<id-from-search>' --json

# MCP (Vodou-Recall) — preferred mid-chat via vodou_core_call
vodou-core call Vodou-Recall memory_correct '{"right":"…","wrong":"…"}'
vodou-core call Vodou-Recall memory_correct '{"right":"…","chunk_id":"…"}'
```

What `mem correct` does (reuses existing engines — no parallel supersede path):
1. Resolves loser chunk(s) by `--chunk-id` or `--wrong` snippet (any scope).
2. Stores the right fact via the same path as `mem store` (`import:mcp`).
3. Soft-supersedes via `fact_groups::record_supersession` (stamps `invalid_at` so recall hard-filters losers).
4. For import/capture losers: strips matching lines from the backing markdown **and** deletes those DB rows (anti-resurrection if line numbers shift on re-sync).

| Tool | Mutates? | Scope | Notes |
|---|---|---|---|
| `search_memory` / `mem search` | No | all | Find chunk ids / snippets first |
| `memory_store` / `mem store` | Yes | write `import:mcp` | New facts only — not corrections |
| `memory_correct` / `mem correct` | Yes | any (supersede) | Preferred when user corrects a false fact |
| `memory_reject` / `mem reject` | Yes | `import:%` / `capture:%` only | Hard delete + source strip; refuses native |
| `memory_pin` / `mem pin` | Yes | any | `pinned=1` — same as POST `/api/memory/pin` |
| `memory_unpin` / `mem unpin` | Yes | any | Clear pin before correcting a wrongly pinned fact if needed |
| `memory_get` / `mem get` | No | — | Exact read by id/path |

Gateway Operator Surface (`llm.ts`) teaches: search → **correct**, never store-only on a known false fact. Undo soft supersede with `mem dedup clear --chunk <id>`.

Plan / ship record: `PLANS/0.6.19/PLAN-MEMORY-CORRECT-AND-MUTATION-SURFACE.md`.

## Memory vaults (segmented sharing, PLAN-MEMORY-VAULTS)

The alpha-call ask: *"share the family vault, not the bank vault."* A **vault**
is a named, rule-based selection of memory for sharing a subset instead of
everything. Rules (all AND together; empty = no constraint): scope prefixes,
tags, project (strict — global chunks NOT swept in), since-days, and an
`include_imports` opt-in (`import:%` excluded by default, same hygiene as
`mem export`). Per-chunk **overrides** force single memories in or out.
Membership is a rule + exceptions, not a copy — resolved live at read time by
the single owner of the semantics, `src/memory/vaults.rs`. Tables:
`memory_vaults` + `memory_vault_overrides` in memory.db (on the
`heal_polluted_memory_db` keep-list).

```bash
vodou-core mem vault create work --scopes web,capture:ide --tags DECISION,PATTERN
vodou-core mem vault preview work                 # totals by scope/tag + exact member ids
vodou-core mem vault exclude work '<chunk-id>'    # rules minus this one memory
vodou-core mem vault include work '<chunk-id>'    # force one in regardless of rules
vodou-core mem export --vault work                # pack ZIP of exactly the members
vodou-core mem vault list|show|update|delete|clear-override …
```

Surfaces: the **Brain console** (:8767) lists share vaults with preview/export;
writes go through the gateway's `/api/vaults/*` router (brain stays read-only),
which shells this CLI — no vault logic in TypeScript. The export manifest
snapshots the resolved chunk-id list, so a share records exactly what left even
as the live vault keeps growing.

## Brain console (visual navigation, :8767)

The whole memory system above has a visual surface: **brain**
(`MCP-servers/brain/`) — an Obsidian-style constellation over memory.db where
trust tier renders as node luminosity, `memory_refs` as citation edges,
entities as gold hubs, contradictions as pulsing conflict edges, and fact-group
supersession as banners. Constellation + Chronicle (date-spine) layouts, vault
toggles, ⌘K search, per-chunk reading pane with backlinks. Read-only by
construction. Full doc: [vodou-brain.md](./vodou-brain.md).

## Memory pipeline commands

All memory commands route through `vodou-core mem <subcommand>`. The scheduler auto-registers most of these as recurring tasks when their env-var feature flags are enabled.

| Command | Purpose | Frequency | How to enable scheduling |
|---|---|---|---|
| `mem search` | Hybrid FTS5+vector search of `memory.db` chunks via the daemon `cmd:"search"` socket. Flags: `--top-k N` (1-50), `--project <id>` (project-filtered recall — see §Project axis), `--json`. Same pipeline as BrainLoader / `continuity::recall` — prefer this over raw `sqlite3 memory.db "... MATCH ..."` (raw FTS5 skips the BGE reranker + scope/project handling). Distinct from Vodou-Recall's `search_conversation` (chat turns, not chunks). | On demand | N/A — agent / CLI use |
| `mem store` | Append one fact under `import:mcp` (MCP `memory_store`). Not for corrections | On demand | N/A — agent / chat |
| `mem correct` | Soft-correct: store right fact + supersede wrong chunk(s) (`invalid_at`). See §Correct / forget / pin | On demand | N/A — agent / chat |
| `mem reject` | Hard-delete import/capture chunks + strip source lines (MCP `memory_reject`) | On demand | N/A — agent / Imports UI |
| `mem pin` / `mem unpin` | Toggle `memory_chunks.pinned` (MCP `memory_pin` / `memory_unpin`; same as `/api/memory/pin`) | On demand | N/A — agent / Memory UI |
| `mem flush` | Extract bullets from conversation transcript and append to today's daily log + sync to `memory.db` | Every session end (hook) | Auto via `vodou-hook-bin sock flush` |
| `mem extract-gateway` | Pull new `gateway_messages` rows past the watermark, batch by conversation, run extraction, write to daily log + `memory.db` | Every 5 min | Auto-registered tokio task in daemon. Manual: `vodou-core mem extract-gateway --batches N` |
| `mem promote-micro` | LLM-curate new lines from today's daily log into MEMORY.md | Every ~5 min | Default scheduled task `memory-micro-promote` |
| `mem promote` | Promote high-value items from last 7 days into MEMORY.md | Weekly | Default scheduled task `memory-promote` |
| `mem compact` | Dedupe + weighted-rank + cap MEMORY.md | Daily | `VODOU_ENABLE_MEMORY_COMPACT_SCHEDULE=1` |
| `mem janitor` | autoDream consolidation pass over `memory.db` | Weekly | `VODOU_JANITOR_ENABLED=1` |
| `mem archive` | Move daily files >30 days into `memory/archive/` | Manual or scheduled | `mem archive` cron task |
| `mem contradictions` | Scan imported vs first-party memory for same-slot/different-value conflicts; list/resolve the review queue (see §Contradiction review queue) | On demand (scan is LLM-capped; judged pairs cache) | N/A — manual / Imports-tab UI |
| `mem dedup` | Cluster near-duplicate chunks into fact groups, elect canonicals, demote the rest at retrieval; value conflicts routed to the review queue (see §Fact groups) | On demand (pure math, no LLM) | N/A — manual |
| `mem entities` | Entity alias collapse + retrieval-time query expansion (see §Entity resolution) | On demand (LLM pass capped) | N/A — manual |
| `mem capture-ide` | Capture Cursor / Claude Code sessions from local session files into `capture:ide:<app>` (Phase C W1c) | On demand (schedulable) | N/A — manual / `vodou-core schedule` |
| `mem extract-status` | Extraction-queue honesty: per-state counts (pending/extracting/done/failed/skipped), heartbeat age, verbatim recent failures, model preflight warning. `--json` for automation. See [memory-extraction-pipeline.md](memory-extraction-pipeline.md) | On demand | N/A — diagnostic |
| `mem keygen` | Backfill "questions this fact answers" retrieval keys for unkeyed facts (new facts arrive keyed via the extraction fold). Uses the [structured-output](structured-output.md) lane where the provider supports it. `--batches N` drains | Every 5 min (daemon, backfill-only) | Auto; disable `VODOU_KEYGEN_ENABLED=0` |
| `mem reembed` | Strip legacy `## Gateway extraction / scope:… \| [TAG]` boilerplate out of embedded chunk text + re-embed (provenance lives in columns). Resumable, `--dry-run`, `--revert` via the `legacy_text` shadow column. Zero LLM cost | One-time migration / on demand | N/A — manual drain |
| `mem reextract` | Re-extract ALL historical gateway/capture conversations with the current extractor on a separate watermark (recovers facts older extractor bugs dropped). Bounded `--batches N`, resumable, `--status` shows backlog | On demand | N/A — manual drain (LLM-priced) |
| `mem bench-extract --recall` | Extraction-recall benchmark: golden transcripts, noise precision, atomicity; `--backends a,b,c` prints the per-provider parity table. Exit-code gated | On demand / CI | N/A — gate |
| `mem health` | Vault self-test: LLM-generated natural questions through the real search pipeline; `--runs N` (default 2) aggregates independent random draws (never trust a single draw); misses accumulate into `.vodou/health-regressions.json` | On demand | N/A — diagnostic |
| `mem retrieval-bench` | Fixed golden-query recall@1/5 + MRR + above-floor vs `.vodou/retrieval-golden.json` | On demand / CI | N/A — gate |

## Gateway memory extractor

Captures every chat surface that flows through the Vodou-Console gateway — web chat, channels (Slack/TG/Discord/WhatsApp/iMessage), workbench automations, skill executions, ExecDesk personas — into the same `memory.db` that CLI and Claude Code already populate.

### How it works

Every assistant turn writes a row to `gateway_messages` (in `MCP-servers/Vodou-Console/gateway.db`) synchronously, regardless of source. Since 0.6.18 the extractor is **claim-queue based** (full detail: [memory-extraction-pipeline.md](memory-extraction-pipeline.md)):

1. **Enqueue scan:** new rows past the scan cursor (`vodou-core.db` metadata key `gateway_memory_last_id`) are filtered (skip `vodou-heartbeat`, `system`/`tool` roles, `[stream-aborted]` placeholders, content <8 chars), grouped by `conversation_id`, and upserted into `extraction_queue` as explicit `pending` work items. The cursor records only "scanned into items", never success — a failure can no longer hide behind watermark arithmetic.
2. **Claim loop:** workers atomically claim items (`UPDATE … RETURNING`), trim each window to the last complete user/assistant pair, bound each LLM call to a 40KB char budget, and call the shared `memory_extraction::extract()` — same prompt, same tags, same provider chain as CLI flushes. The prompt also emits per-fact `Q:` retrieval questions (folded keygen).
3. Bullets get a `scope:` stamp (e.g. `scope:channel:slack | [DONE] …`) in today's daily log — plus a `project:<id>` token for gateway-Project conversations (`[PREF]` excepted; see §Project axis). **Scope/tag/project are stored in dedicated `memory_chunks` columns exactly as before** (`scope`, `chunk_tag`, `project_id` — every consumer: search boosts, recall APIs, brain console, privacy filters reads these columns). What changed in 0.6.18 is only that the stamp *string* is no longer duplicated inside the embedded text: the chunker sets the columns from the markdown stamp, then strips the boilerplate from the stored/embedded string so vectors carry pure fact content.
4. `MemorySync::sync_path` chunks + embeds the new content into `memory.db`, writing each fact's `Q:` questions to `memory_chunk_keys` in the same pass (facts arrive retrieval-keyed).
5. Every claim settles explicitly: `done`, `failed` (exponential backoff, error chain on the row), or `skipped: awaiting_reply` (recent unpaired tail — re-pends when the reply arrives, auto-resolves after the orphan grace if it never does). Dead workers' claims reclaim after a 15-min lease. `mem extract-status` shows all of it.

### Privacy gate

Channel content (Slack, Telegram, Discord, WhatsApp, iMessage) is **opt-in by default**. The setting lives in `gateway_settings.gateway_extractor_channels_enabled` and can be toggled from the **Memory Extraction Sources** card on `/#/system`.

- **Always on**: web chat, workbench, skills, automations, ExecDesk personas — your own activity inside Vodou
- **Opt-in**: channel-prefixed conversations (`slack:*`, `telegram:*`, `discord:*`, `whatsapp:*`, `imessage:*`) — they often carry other people's words

Toggling `channels_enabled = true` is reversible and takes effect on the next 5-min cycle.

### Manual / backfill

Run a single cycle (catches up since last watermark):

```bash
vodou-core mem extract-gateway --batches 1
```

Backfill historical content (e.g. after first install on an existing gateway.db with thousands of rows):

```bash
vodou-core mem extract-gateway --batches 25 --sleep-secs 30
```

### Observability

- Each cycle writes one JSONL line to `.vodou/extractor.log`:
  `{"ts":"...","cycle":"gateway","watermark":N,"msgs_in_batch":M,"bullets":B,"conv_count":C,"duration_ms":D,"errors":E}`
- `bash scripts/vodou-doctor.sh` reports cycles + last cycle line under section 9 (Memory Pipeline)
- The Memory Extraction Sources card on `/#/system` shows live stats: cycles run, bullets extracted, watermark, last-cycle relative time

### Cost ballpark

For a heavy user (~100 turns/day flowing through the gateway): one batched Haiku call every 5 min, ~10–20 turns per batch. Roughly $0.05–0.30/day depending on plan. Cost-safe and bounded — the LLM call is the only charge in the loop; everything else is local SQLite + file I/O.

## Skeptical memory injection (Step 1 of skeptical-memory rollout)

Vodou does not inject memory as authoritative context. Every memory retrieval is wrapped with an epistemic header that tells the agent these are time-stamped observations, not verified facts:

```
### Relevant Memories
> These are time-stamped observations from past sessions — not verified facts.
> Before acting on any memory, confirm against the current codebase or conversation.
> If a memory conflicts with what you observe now, trust observation. This skepticism
> applies to recalled memory ONLY — follow active skill instructions and AGENT_ACTIONS immediately.

- [memory/2026-04-02.md] - [PLANNED] ...
- [memory/2026-03-29.md] - Decision: ...
```

The header lives in `daemon.rs` and applies to every retrieval served to Claude Code, Cursor, and the gateway. The carve-out for active skill instructions is critical — without it, agents would second-guess `MUST RUN` style instructions in skill files.

## Mechanical contradiction superseding (Step 2 of skeptical-memory rollout)

Every time a new memory chunk is flushed with a `[DONE]`, `[ISSUE]`, or `[PLANNED]` tag, Vodou runs a synchronous post-flush sweep that:

1. Extracts significant words from the new bullet (4+ chars, lowercase)
2. Runs an FTS5 `MATCH` query against `memory_chunks` ordered by **BM25 rank**, filtered by the contradicting tag pair
3. Verifies topic similarity with Jaccard ≥0.35 on each candidate
4. Rewrites the matching old chunk's text in-place: `[PLANNED] foo` → `[SUPERSEDED 2026-04-06] foo`

**Tag pairs:**

| New chunk tag | Supersedes old tags on same topic |
|---|---|
| `[DONE]` | `[PLANNED]` |
| `[ISSUE]` | `[DONE]` (regression) |

This is zero-cost contradiction prevention — no LLM, no async job, no scheduling. Runs on every flush. The `ORDER BY rank` clause is critical at scale (without it, the actual contradicting chunk gets crowded out by the `LIMIT 20` when OR'd common keywords match thousands of chunks).

## Memory janitor (Step 3 of skeptical-memory rollout)

The janitor is a periodic four-phase consolidation pass that runs in-process via the scheduler. It is Vodou's autoDream equivalent — a background agent that keeps `memory.db` healthy at scale over months.

### When it runs

| Trigger | When |
|---|---|
| Scheduled | Daily at 2am via cron `0 2 * * *` (override with `VODOU_JANITOR_SCHEDULE`). Janitor is cheap (~100ms), idempotent, and self-throttles — daily catches drift fast and keeps the DB consistently bounded. |
| Manual | `./vodou-core mem janitor` (respects auto dry-run) |
| Manual force-live | `./vodou-core mem janitor --force-live` (skips dry-run window — DESTRUCTIVE) |

### The four phases

**1. Orient** *(pure SQL, no mutations)*
- Counts active chunks, embeddings, archived rows, superseded rows
- Captures date range and chunks-by-path-prefix distribution

**2. Gather Signal** *(SQL + embeddings)*
- **Duplicate clusters** — pairwise cosine similarity ≥0.85 over the most recent 200 chunks (Jaccard 0.45 fallback when no embeddings exist). Caps at 20 clusters/run, 5 chunks per cluster.
- **Stale superseded** — `[SUPERSEDED]` chunks older than 30 days, eligible for deletion
- **Relative date chunks** — chunks >7 days old containing phrases like `yesterday`, `last week`, `recently`, `this morning`
- **Over-cap count** — `total_chunks − VODOU_MEMORY_CHUNK_CAP` (almost always 0 — cap is a runaway-protection ceiling at 500K, not a routine cleanup target)

**3. Consolidate** *(LLM for merge, mechanical for dates)*
- LLM-merges each duplicate cluster into a single canonical bullet via `memory_extraction::llm_completion()`. Failed LLM calls skip the cluster gracefully — no crash.
- Rewrites relative dates to absolute dates derived from each chunk's `created_at`. Examples:
  - `yesterday` → `2026-04-05`
  - `last week` → `week of 2026-03-30`
  - `recently` → `around 2026-04-06`
  - `this morning` → `2026-04-06`

**4. Prune** *(SQL + filesystem)*
- Deletes stale `[SUPERSEDED]` chunks (>30 days) — these are explicitly marked obsolete by Step 2, safe to delete
- **Runaway-protection only:** enforces `VODOU_MEMORY_CHUNK_CAP` (default 500K — ~5 years of typical use). When fired, uses recency-banded scoring (≤7d=1.0, ≤30d=0.7, ≤90d=0.4, else=0.2) plus category bonuses matching `MemorySearch::category_weight`. **Almost never fires in normal use** — the janitor's daily value comes from the other phases. The cap exists to catch extraction bugs / hook misfires that flood memory with garbage, not to discard real long-term memories.
- Rebuilds FTS5 index after mutations
- Clears `memory_cache` table

### Safety: 1-run auto dry-run (informational)

The very first invocation is automatic dry-run. It executes every phase (including the LLM merge calls — to validate output quality) but applies **no UPDATE/DELETE statements**. A report is written with `**Mode:** dry-run` so you can review what would happen before the next run goes live.

After 1 dry run, subsequent invocations are live (unless `VODOU_JANITOR_DRY_RUN=1` forces permanent dry-run). State is tracked in `.vodou/.janitor_state`:

```json
{
  "last_run": "2026-04-06T23:48:15.618137+00:00",
  "chunks_at_last_run": 3765,
  "dry_run_count": 1,
  "total_runs": 2
}
```

> The dry-run window was originally 3 runs (designed to give users time to spot a misconfigured chunk cap that would prune thousands of chunks). With the cap raised to 500K (runaway protection only), that surprise can't happen, so 1 informational dry-run is enough.

### Configuration

| Env var | Default | Purpose |
|---|---|---|
| `VODOU_JANITOR_ENABLED` | `1` (in `.env.example`; off otherwise) | Master enable. Worker registers the scheduled task only when this is `1`. |
| `VODOU_JANITOR_SCHEDULE` | `0 2 * * *` | Cron expression (daily 2am default). |
| `VODOU_MEMORY_CHUNK_CAP` | `500000` | **Runaway-protection ceiling, not a routine cleanup target.** ~5 years of typical use before this fires. Long-term memory is preserved by design. Lower only if you specifically want aggressive cleanup. |
| `VODOU_JANITOR_DRY_RUN` | `0` | Set to `1` to force permanent dry-run (overrides auto-progression). |

### Example dry-run report

```markdown
# Janitor Report — 2026-04-06

**Mode:** dry-run
**Duration:** 40ms

## Stats
- Total chunks: 3765
- Embeddings: 3765
- Date range: 2026-03-26 00:12:39 → 2026-04-06 23:44:32
- Superseded chunks: 2
- Archived: 0

## Actions
- Merged 0 duplicate clusters (removed 0 chunks)
- Fixed relative dates in 17 chunks
- Deleted 0 stale superseded chunks (>30 days)
- Pruned 0 chunks at cap (4000)
- Compacted 0 monthly archives
```

### Lock + concurrency

A file lock at `.vodou/.janitor_lock` prevents overlapping runs. The lock contains the running PID; if `mtime` is older than 10 minutes, it is treated as stale and replaced. The lock is RAII — it is removed when `run_janitor` returns (success or panic).

### Reusing the live-fire test harness

The janitor module ships with `#[ignore]`-gated live-fire tests that run against a copy of `memory.db`. Use this pattern when adding new memory pipeline code:

```bash
cp memory.db /tmp/memory_livefire.db
VODOU_LIVEFIRE_DB=/tmp/memory_livefire.db cargo test --release \
  --bin vodou-core livefire_janitor -- --ignored --nocapture
```

The harness hard-guards against running on production paths and cleans up synthetic test data before asserting.

## Search & retrieval

When a UserPromptSubmit hook fires, `vodou-hook-bin sock prompt` sends the prompt to the daemon, which runs hybrid search over `memory.db`:

- **FTS5 BM25** — full-text relevance score
- **Vector cosine** — semantic similarity over chunk embeddings
- **Recency banding** — time-decay weight (today=1.0, week=0.9, month=0.7, etc.)
- **Category weight** — boosts for paths under `memory/`, status-tagged chunks (`[DONE]`/`[PLANNED]`/`[ISSUE]`), and workspace files
- **Heartbeat down-weight** — heartbeat-sourced memories are multiplied by `VODOU_MEMORY_W_HEARTBEAT` (default 0.3) to reduce noise

Top-K (default 5) results are injected into the prompt with the epistemic header described above.

## Default schedule (after janitor enable)

Once `VODOU_JANITOR_ENABLED=1` is set in `.env`, the worker auto-registers `memory-janitor` alongside the existing memory tasks:

```
1|memory-promote|@weekly|mem promote|1
2|memory-micro-promote|5m|mem promote-micro|1
3|memory-compact|1d|mem compact|1
4|vodou-heartbeat|every 2h|heartbeat|1
5|memory-janitor|0 2 * * *|mem janitor|1
```

The schedule auto-syncs from `.env` on every worker startup, so changing `VODOU_JANITOR_SCHEDULE` and restarting the worker is enough to update the cron.

## Intent Signal Layer (auto-routing)

Independent of the memory pipeline, Vodou also runs an **intent signal layer** in the same `vodou-hook-bin sock prompt` hook. After the memory search returns, the daemon scans the prompt's first line against the `intent_mappings` table (579 rows mapping keywords/phrases to MCP tools) and, on a strong match, calls BrainLoader directly to inject real tool output into the prompt context.

**What this means in practice:**
- User types `"cpu memory disk"` → daemon detects 100% confidence match → auto-routes to `mcp-monitor::get_cpu_info`/`get_memory_info`/`get_disk_info` → real JSON appears in the prompt under `### Vodou Tool Results (auto-routed)` → agent answers from real data, not training
- User types `"fix the memory leak in cache"` → no signal (weak keyword in long sentence) → only memories are returned → agent proceeds normally
- Skill triggers (`vc_load_skill` → 304 of 579 mappings) are excluded from auto-route in v1 due to higher blast radius — they fall back to advisory text

**Architecture summary:**

| Layer | What it adds | When it runs |
|---|---|---|
| Memory search (existing) | `### Relevant Memories` block with epistemic header | Every prompt |
| Intent signal check (new) | Scans prompt against `intent_mappings`, scores matches, decides whether to fire | Every prompt (~3-5ms cost) |
| Auto-route (new, signal-only) | Calls worker → BrainLoader → injects `### Vodou Tool Results` block | Only when confidence ≥75 + non-skill match (~500ms p95) |
| Telemetry (new) | Writes every check to `signal_log` table for tuning | Every prompt where signal layer runs |

**Configuration:**
```bash
VODOU_INTENT_SIGNAL_ENABLED=1            # Master enable (default 1)
VODOU_INTENT_AUTO_ROUTE=1                # Set 0 for advisory text only, no brain call
VODOU_INTENT_SIGNAL_TIMEOUT_MS=1500      # Hard timeout on the worker brain call
```

**Telemetry table** (`vodou-core.db.signal_log`):
```sql
SELECT id, prompt_excerpt, max_confidence, fired_signal, auto_routed, brain_loader_outcome
FROM signal_log ORDER BY id DESC LIMIT 10;
```

Use this to tune confidence thresholds. After ~1 week of real traffic:
- Filter `WHERE fired_signal=1 AND auto_routed=0` → false positives (signaled but no execution)
- Filter `WHERE fired_signal=0 AND brain_loader_called=1` → false negatives (manual brain call without signal)
- Adjust `WEAK_KEYWORDS` and `MIN_CONFIDENCE_FIRE` in `src/intent_signal.rs` based on what you find

**Plan reference:** [PLANS/0.5.35/DO/3/PLAN-INTENT-SIGNAL-LAYER.md](../PLANS/0.5.35/DO/3/PLAN-INTENT-SIGNAL-LAYER.md)

## Related docs

- [memory-extraction-pipeline.md](./memory-extraction-pipeline.md) — extraction queue, fact shape, drains (reembed/reextract), benchmark gates, ops knobs
- [structured-output.md](./structured-output.md) — API-enforced LLM output shapes (hot-swappable schemas)
- [vodou-scheduler.md](./vodou-scheduler.md) — scheduled task internals
- [cli-reference.md](./cli-reference.md#mem) — full `mem` subcommand reference
- [vodou-brain.md](./vodou-brain.md) — Brain console + brain MCP server (visual memory navigation, vault sharing UI)
- [memory-and-oom.md](../docs-DEV/memory-and-oom.md) (internal) — memory budget tuning
- [TESTING-MEMORY-EXTRACTION.md](../docs-DEV/TESTING-MEMORY-EXTRACTION.md) (internal) — extraction pipeline diagnostics
