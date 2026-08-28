# Brain — visual memory navigation

Everything Vodou remembers, as a map you can wander. **brain** is a read-only
MCP server plus the interactive memory map (**Vodou console → Memory → ✦ Map**; historically the standalone **Brain console** on :8767) over `memory.db` —
the navigation counterpart to Vodou-Recall (which answers ranked queries and
writes memories). Where `mem search` answers *"what did we decide about X?"*,
brain answers *"what does my memory look like — where did it come from, what
does it orbit around, and where does it disagree with itself?"*

- Server: `MCP-servers/brain/` (stdio MCP, registered as `brain`)
- Console: **Vodou console → Memory → ✦ Map** (`http://127.0.0.1:8765/#/memory?tab=map`). The gateway serves the same `/api/brain/*` routes; the standalone twin on **:8767** (`BRAIN_PORT`) is opt-in with `VODOU_BRAIN_STANDALONE=1` and runs a build copy of the console's graph (PLAN-BRAIN-INTO-CONSOLE, 0.6.29).
- Shipped 2026-07-12 (commits `eaf450e`, `64625d0`; migration `077`)
- Also embedded whole into Vodou One's Brain tray (iframe + `/brain-api/*` proxy — still points at :8767, so One needs `VODOU_BRAIN_STANDALONE=1` until PLAN-BRAIN-INTO-CONSOLE P3 retargets it)

## The one visual rule: trust = luminosity

Brain renders the same provenance multipliers the ranking engine applies at
retrieval (`src/memory/search.rs` trust_mult, `VODOU_MEMORY_W_TRUST`):

| Provenance class | Scopes | Retrieval trust | On screen |
|---|---|---|---|
| **Yours** (first-party) | `web`, `gateway`, `skill`, `workbench:%`, `channel:%` | ×1.0 | brightest |
| **Auto-captured** | `capture:byok/ide/web/manual:%` | ×0.925 | dimmer |
| **Imported** | `import:chatgpt/claude/mcp/%` | ×0.85 | dimmest |

A memory's visual weight *is* its ranking weight. Superseded duplicates and
conflicts get their own treatment (banners, pulsing rose edges).

## Console tour

**Layout tabs (top of canvas, URL-synced):**
- **✦ Constellation** — the whole sky: memory files (circles, hued by dominant
  tag), people/orgs/handles (gold ✦ stars — `mem entities`), cited plans/docs
  (squares). Edges: entity mentions, citations (`memory_refs`), co-mentions,
  conflicts (rose, dashed), and — opt-in — embedding-**similarity** edges (teal,
  dashed; see §Similarity edges). Deep-link: `#/memory?tab=map`
- **≡ Chronicle** — every dated file pinned in date order down the left edge
  (newest first; ↓/↑ button flips), connections fanning right. Deep-link:
  `#/memory?tab=map&layout=chronicle`

**Interactions:** hover = isolate a node's neighborhood · click = read it in
the right-hand pane · double-click = focus mode (local graph; `Esc` returns) ·
drag/zoom/`⌖ Fit` · **⌘K** = quick switcher (FTS5 typeahead over live chunks;
searches archived history too when the archive toggle is on).

**Left rail:**
- **Vaults (provenance)** — toggle Yours / Auto-captured / Imported on and off,
  with per-source counts and trust multipliers.
- **Share vaults** — named, rule-based selections for segmented sharing
  (see §Memory vaults below).
- **Kinds** — tag chips (DECISION / GOTCHA / PREF / …) filter the graph.
- **When** — all time / 90d / 30d / 7d.
- **Scope** — project filter (when project-scoped memory exists) and
  **Include archived history** (janitor-retired chunks, ~6× the live set; off
  by default everywhere: graph, timeline, and ⌘K search all honor it).
- **Show similarity edges** — overlay embedding-similarity links on whatever's on
  screen (constellation or focus). Off by default; see §Similarity edges.

**Right rail (reading pane):** full memory text · provenance chips (class,
trust ×, scope, date, pinned) · where it lives (file:line) · entities it
mentions · what it cites and what cites it (backlinks) · same-fact copies with
canonical/superseded status · conflict cards. Everything is clickable.

**Conflicts (header):** the contradiction review queue
(`memory_contradictions`) — pairs where one source of your memory disagrees
with another, import-side vs your-side, with status. In the console this is the
**Conflicts** tab: *Keep imported* / *Keep yours* / *Not a conflict* resolve in
place (reversible; same-value copies resolve together) — the same write path as
`mem contradictions resolve`. The standalone twin resolves through the gateway too.

**Timeline (bottom):** ~120 days of memory formation as stacked tag bars;
click a day to open its daily log.

## Similarity edges — connect by meaning

Every other edge in the graph is *literal*: a memory links to another only when it
**cites** it (`memory_refs`) or **shares a resolved entity**. Those are sparse — most
memories cite nothing, and imported corpora (your ChatGPT/Claude history) start with
**zero** citation or entity edges, so they float as islands. **Similarity edges** are
the bridge: they connect memories by *meaning*, using the same 384-dim embeddings the
recall engine already stores for every chunk (100% coverage).

Turn them on with **Show similarity edges** in the left rail (or `?sim=1` on the API):

- **Focus a chunk** (double-click) with the toggle on → its top **similar** neighbors
  appear as teal dashed edges, including cross-source links the citation graph misses
  (e.g. an imported ChatGPT decision next to the plan doc it relates to).
- **Constellation** with the toggle on → **file↔file** similarity edges, kept sparse
  by *mutual-top-K* (an edge survives only if each file is in the other's top-K) plus a
  cosine floor and a cap — so the sky gains meaningful bridges, not a hairball.

**Thresholds are calibrated per real corpus.** On this embedding model native memory
sits at cosine 0.84+, but imports/captures at 0.65–0.73 — so the floor (τ) defaults to
**0.65**, low enough that imported memory actually connects; sparsity comes from top-K +
mutual-top-K, not a high floor. Tune with `VODOU_BRAIN_SIM_TAU` (floor) and
`VODOU_BRAIN_SIM_K` (fan-out).

Computed **live** (no stored edge table) so any new memory is a similarity node the
instant it's embedded — nothing to re-index. From the CLI / an agent:

```bash
vodou-core mem similar --chunk 'memory/imports/chatgpt/extracted-2025-01.md:55:c1aab1b6'
vodou-core mem similar --chunk <id> --top-k 8 --min-cos 0.7 --same-scope-only --json
```

> **Recall expansion is separate and OFF by default.** Similarity edges are a *graph*
> feature. Using them to also broaden `mem search` results (associative recall) is gated
> behind `VODOU_MEMORY_GRAPH_EXPANSION=1` and is unvalidated — leave it off until an A/B
> shows it raises hit-rate without hurting precision. Recall itself already ranks by
> embedding similarity against the query; edges add nothing there unless expansion is on.

## MCP tools (for agents)

`./vodou-core call brain <tool> '<json>'` — all read-only over memory.db.

| Tool | Returns |
|---|---|
| `brain_overview` | Counts: live/archived chunks, files, entities, connections, open conflicts, distribution by class + tag |
| `brain_graph` | Constellation nodes+links. Filters: `cls` (yours,captured,imported), `tag`, `since_days`, `project`, `archived` |
| `brain_local` | Local neighborhood of one chunk id / file path / `entity:<n>` (`include_similar: true` adds similarity neighbors) |
| `brain_similar` | Top-K embedding-similarity neighbors of one chunk — "more like this" by meaning (`k`, `tau`, `same_scope_only`). See §Similarity edges |
| `brain_node` | Fully hydrated chunk: text, provenance, entities, citations, backlinks, fact-group status, conflicts |
| `brain_search` | Fast FTS5 bm25 typeahead (`archived: true` reaches retired history). For ranked semantic recall use Vodou-Recall `search_memory` |
| `brain_entities` | All resolved entities with aliases + mention counts |
| `brain_conflicts` | The contradictions queue (`status: "open"` filters) |
| `brain_timeline` | Per-day counts by tag |
| `open_brain_console` | Returns the console route (`#/memory?tab=map`); with `VODOU_BRAIN_STANDALONE=1` starts (if needed) the :8767 twin instead. `open:true` also opens a tab |

Intent routes ship with migration 077: `memory graph`, `show my brain`,
`brain map`, `memory conflicts`, `memory timeline`, `memory entities`, ….

## Memory vaults (segmented sharing)

> "Share the family vault, not the bank vault." — PLAN-MEMORY-VAULTS
> (PLANS/0.6.16); full pipeline detail in `docs/vodou-memory.md` §Memory vaults.

A **vault** is a named, *live* selection of memory — rules (scope prefixes +
tags + project + recency) plus per-chunk include/exclude overrides. Membership
is resolved at read time; chunks keep living where they are. Export a vault as
a portable pack and share exactly that subset, nothing else.

In the Brain console the **Share vaults** rail section lists vaults with
preview and export actions. Brain itself stays read-only: vault writes go
through the gateway (`/api/vaults/*` on :8765), which shells the Rust CLI —
the single owner of rule semantics (`src/memory/vaults.rs`).

```bash
vodou-core mem vault create work --scopes web,capture:ide --tags DECISION,PATTERN
vodou-core mem vault preview work            # counts + exact member list
vodou-core mem vault exclude work 'memory/2026-07-01.md:12:ab34cd56'
vodou-core mem export --vault work           # pack ZIP of exactly that
```

Privacy defaults: `import:%` excluded unless the vault opts in; a `project`
rule matches strictly (global chunks are NOT swept in); the export manifest
snapshots the resolved chunk-id list so you always know what left.

## Ports, env, lifecycle

| Thing | Value |
|---|---|
| Console port | in the gateway (**8765**, `#/memory?tab=map`); standalone twin `BRAIN_PORT` default **8767** only with `VODOU_BRAIN_STANDALONE=1` |
| memory.db path | `VODOU_MEMORY_DB` (default: repo-root `memory.db`) |
| Auto-start | `start-vodou-services.sh` starts the console; `ensure_bundled_mcp_server` heals the MCP registration |
| Manual | `node MCP-servers/brain/dist/serve.js` · rebuild: `cd MCP-servers/brain && npm run build` |

## Guarantees

- **Read-only by construction** — memory.db opened `readOnly`; the HTTP surface
  rejects non-GET. Nothing in brain can mutate memory.
- Binds `127.0.0.1` with a Host-header guard (the gateway's DNS-rebinding
  defense); d3 is vendored at build time (fully offline, no CDN).
- Archived chunks excluded by default on every surface; opt in per view.

## Troubleshooting

- **Map tab says the graph isn't served by this gateway build** — the gateway is
  running a `dist/` older than `src/api/brain.ts`; rebuild the Console and restart
  (`scripts/restart-gateway.sh`).
- **Standalone :8767 won't load / connection refused** — it only runs with
  `VODOU_BRAIN_STANDALONE=1`; then `./vodou-core call brain open_brain_console '{}'`
  respawns it, or run `dist/serve.js` manually.
- **Blank graph** — filters can legitimately empty it (re-enable a vault class
  or widen the time window); the empty-state banner says so.
- **Counts differ from `mem search` results** — brain shows the *live* working
  set (archived=0) by default; total corpus is visible via Include archived.

## Related docs

- [vodou-memory.md](./vodou-memory.md) — the memory engine (trust tiers,
  capture lanes, fact groups, entities, contradictions, janitor)
- [cli-reference.md](./cli-reference.md) §mem — every `mem` subcommand
- [vodou-bridge.md](./vodou-bridge.md) — the browser extension (capture, Ctrl+B insert, memory on the page you're on, tasks)
