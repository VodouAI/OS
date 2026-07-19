# brain — Vodou memory navigation

A read-only MCP server + mini web console for navigating everything Vodou
remembers. Where Vodou-Recall *answers* ("what did we decide about X?"),
brain lets you *wander*: an Obsidian-style constellation of memory files,
entities, citations, supersession chains, conflicts, and (opt-in) embedding-
**similarity** edges that connect memories by meaning — with provenance (trust)
rendered as luminosity.

## The two surfaces

**1. MCP tools** (stdio, for agents — `./vodou-core call brain <tool>`)

| Tool | What it returns |
|---|---|
| `brain_overview` | Counts: live chunks, files, entities, connections, open conflicts, distribution by vault class + tag |
| `brain_graph` | Constellation nodes+links (files, entities, cited docs); filters: `cls`, `tag`, `since_days` |
| `brain_local` | Local neighborhood of one chunk / file / `entity:<n>` (`include_similar: true` adds similarity neighbors) |
| `brain_similar` | Top-K embedding-similarity neighbors of a chunk — "more like this" by meaning (`k`, `tau`, `same_scope_only`) |
| `brain_node` | Full chunk detail: text, provenance, entities, citations, backlinks, fact-group, conflicts |
| `brain_search` | Fast FTS5 bm25 typeahead over live chunks |
| `brain_entities` | All resolved entities with aliases + mention counts |
| `brain_conflicts` | The contradictions queue (read-only view) |
| `brain_timeline` | Per-day counts by tag |
| `open_brain_console` | Starts + opens the web UI, returns URL |

**2. The Brain console** (humans — `http://127.0.0.1:8767`)

- **Constellation** — force graph: files (circles, tag-hued), entities (gold
  veve stars), cited plans/docs (squares). *Brighter = more trusted*: yours
  ×1.0, auto-captured ×0.925, imported ×0.85 — the same multipliers
  `src/memory/search.rs` applies at retrieval.
- **Vaults** (left) — toggle provenance classes on/off; per-source counts.
- **Reading pane** (right) — full memory text, provenance chips, backlinks,
  entities, same-fact copies, conflict cards.
- **Focus mode** — double-click any node for its local graph. Esc returns.
- **⌘K quick switcher** — FTS search across every memory.
- **Timeline** (bottom) — 120 days of memory formation, stacked by tag;
  click a day to open its daily log.
- **Conflicts** — where one source disagrees with another (rose, pulsing).

## Running

```bash
cd MCP-servers/brain
npm install && npm run build          # tsc + vendors d3 into public/vendor/

# register with vodou-core (once):
cd ../.. && ./vodou-core connect brain node MCP-servers/brain/dist/index.js

# agent access:
./vodou-core call brain brain_overview '{}'
./vodou-core call brain open_brain_console '{}'

# console only (no MCP):
node MCP-servers/brain/dist/serve.js   # http://127.0.0.1:8767
```

## Guarantees & env

- **Read-only by construction** — memory.db opened `readOnly`; the HTTP
  surface rejects non-GET. Resolutions/writes stay with `vodou-core mem …`.
- Binds `127.0.0.1` with a Host-header guard (gateway's DNS-rebinding defense).
- Fully offline — d3 is vendored at build time, no CDN.
- `VODOU_MEMORY_DB` — memory.db path override. `BRAIN_PORT` — port (8767).
- Archived chunks are excluded everywhere by default (`archived=1` = janitor
  history, ~18k rows); pass `archived=1` on `/api/brain/graph` to include.
