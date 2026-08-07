# Memory Extraction Pipeline — Reliability & Operations

How Vodou turns raw conversation into vault facts, and how to observe, drain,
benchmark, and repair that pipeline. This documents the systems shipped by
PLAN-EXTRACTION-ROBUSTNESS (0.6.18): the claim-based extraction queue, the
clean fact shape, write-time retrieval keys, the recovery drains, and the
benchmark gates. For the memory system as a whole (storage, retrieval, vaults,
janitor) see [vodou-memory.md](vodou-memory.md). For API-enforced LLM output
shapes see [structured-output.md](structured-output.md).

## Design philosophy

The pipeline used to be fail-soft-and-continue, which read as resilience but
was actually silence — on 2026-07-17 a single afternoon surfaced seven
distinct silent-failure modes (classifier self-poisoning, silent zero paths,
stderr black holes, a retired model default, max_tokens truncation,
prompt-and-pray JSON, watchdog WAL tears). The rebuild is deliberately
boring: **explicit work items with explicit states, honest counters, bounded
drains, and benchmark gates.** Failure is a row you can see, never a skipped
span.

## The extraction queue (claim-based work items)

The gateway lane (web chat, workbench, skills, personas, `capture:*`
surfaces) runs a two-stage loop every ~5 minutes:

**Stage 1 — enqueue scan.** New `gateway_messages` rows past the scan cursor
(metadata key `gateway_memory_last_id`) are grouped by conversation and
upserted into `extraction_queue` (vodou-core.db) as explicit work items. The
watermark is ONLY this scan cursor — it records "rows up to id N have become
queue items", never processing success, so it can never again hide a failure.

**Stage 2 — claim loop.** Workers claim items one at a time with an atomic
`UPDATE … RETURNING` (a concurrent CLI drain and the daemon get distinct
items) and settle every claim:

| State | Meaning |
|---|---|
| `pending` | Waiting to be claimed. Each item's `span_start..span_end` is that conversation's **unprocessed** row window. |
| `extracting` | Claimed by a worker. A claim older than 15 min is a dead worker's lease — reclaimable. |
| `done` | Window fully processed. New rows re-pend the item with a fresh window. |
| `failed` | LLM/system error. Retries with exponential backoff (1m/5m/25m/2h/12h via `attempts`); the full `{e:#}` error chain is stored on the row. |
| `skipped` | Deliberate deferral with a reason — e.g. `awaiting_reply` for a recent unpaired user turn. Re-pends the moment its reply row arrives; if the reply never comes, it becomes reclaimable after the orphan grace (`VODOU_EXTRACT_ORPHAN_GRACE_SECS`, default 3600s) and resolves. |

Partial progress is first-class: if a window's prefix extracts but the tail
is a recent unpaired turn, the prefix settles and the item becomes
`skipped: awaiting_reply` with the window shrunk to the tail. If new rows
arrive *while* a worker is mid-item, completion re-pends the remainder
automatically.

This replaced the watermark-clamp machinery (deferred-min, stall counters,
force-advance pin-breaker) — those defended a pinnable watermark that no
longer exists.

The import lane (`mem import` archives) and history re-extraction keep their
own per-job watermarks and record outcomes to the same ledger under
`source='import'` / `source='history'`.

## Observability — the honesty layer

```bash
vodou-core mem extract-status [--json]
```

Prints: per-state counts (`pending / extracting / done / failed / skipped`),
cumulative facts written, seconds since the last **completed** extractor
cycle (the heartbeat — stamped even on no-work cycles, so "idle" and "dead"
are distinguishable), the newest failing conversations with verbatim error
chains, and an oldest-pending age warning when workers aren't keeping up
(>1h is loud). A config-time **model preflight** also runs here: if the
direct-API anthropic lane is configured with a retired/typo'd model id, the
status output says so instead of letting every extraction call 404 silently
(the daemon prints the same warning once at startup).

The daemon WARNs every cycle when items are failing, the heartbeat is stale
(>900s), or the oldest pending item exceeds 1h. Each cycle also appends one
JSONL line to `.vodou/extractor.log`.

### Headless error honesty

CLI stderr is redirected to `.vodou/system.log`, which historically made
fatal errors invisible to invoking automation (`2>&1` captures nothing after
the redirect). Now: fatal errors and watchdog kills are **mirrored to
stdout** whenever stderr is redirected, so captured output can never show a
clean "done" for a failed command. Hook-protocol commands (`sock`,
`context`) are exempt — their stdout stays protocol-clean.

### Watchdog safety

The 90s process watchdog exempts every long-by-design mem command
(`keygen`, `import`, `extract-import`, `extract-gateway`, `reembed`,
`reextract`, `bench-extract`, `health`, `retrieval-bench`,
`contradictions scan`). Before a watchdog `exit(124)` fires on anything
else, it best-effort checkpoints memory.db and vodou-core.db WALs
(`wal_checkpoint(TRUNCATE)`) so a mid-write kill can only cost the process's
own in-flight transaction — never other sessions' committed rows (the
2026-07-17 WAL-tear incident).

## Fact shape (what a stored fact IS)

Since 0.6.18, the embedded chunk text is **pure fact content**:

- The `## Gateway extraction` header and `- scope:… | [TAG]` stamp are
  stripped at the chunker seam. Provenance lives in the `scope`,
  `chunk_tag`, and `project_id` columns (they were already populated — the
  change removes the ~40-char shared prefix that flattened cosine
  distinctiveness across the entire vault).
- Daily-log markdown files keep the stamps — files remain the human-readable,
  regenerable source of truth. Chunk ids hash the RAW markdown, so ids (and
  their question keys, pins, archival flags) are stable across the change.
- **Write-time retrieval keys (folded keygen):** the extraction prompt emits
  indented `Q:` lines under every bullet — natural questions the fact answers.
  They ride the markdown, the chunker peels them into the chunk's key set, and
  sync writes them to `memory_chunk_keys` (`{chunk_id}#q{n}`, idempotent) in the
  same pass. New facts arrive already keyed; the keygen daemon task is
  backfill-only. Keys are generated in **first person** — "how many kids do I
  have?", not "how many sons does Chad have?" — because the user asks an AI about
  *themselves*; this was the single biggest recall lever for personal facts. Keys
  also include short **topic phrases** ("my dog", "my coffee"), stored with
  `kind='topic'` (vs `kind='question'`), so imperative task prompts match too
  (see [memory-follows-you.md](memory-follows-you.md) §2).
- **`IDENTITY` tag:** personal/identity facts about the user (name, family, pets,
  home, life details) are tagged `IDENTITY` rather than `RESEARCH`. This makes
  them findable, travel-eligible, and top-durability in ranking. The extraction
  prompt routes personal facts here; ranking gives `IDENTITY` a tag-bias so it
  wins for self-referential prompts.

Legacy rows were migrated by the `mem reembed` drain (24,215 chunks stripped
and re-embedded on 2026-07-18); each rewritten row keeps its original text in
the `legacy_text` shadow column until you choose to drop it.

## Drains (bounded, resumable, watchdog-exempt)

| Command | What it does |
|---|---|
| `mem reembed [--batch-size N] [--batches N] [--dry-run] [--revert]` | Strip embedded provenance boilerplate from historical chunk text and re-embed. Idempotent (`legacy_text IS NULL` is the work marker), transaction-per-batch, WAL-checkpointed. `--dry-run` shows counts + sample before/after; `--revert` restores originals from the shadow column. Local-only — zero LLM calls. |
| `mem reextract [--batches N] [--status]` | Re-extract ALL historical gateway/capture conversations with the current (fixed) extractor on its own watermark (`history_reextract_last_id`). Recovers facts the pre-P3a contaminated extractor silently deduped away. Inherits the channel privacy gate and injected-context strip; bullets land in `memory/reextract/extracted-<YYYY-MM>.md`; duplicates absorbed by Jaccard + reconcile. LLM-priced: ~1 call per conversation-slice; run in bounded `--batches` chunks whenever convenient. |
| `mem keygen [--batches N]` | Backfill question keys for unkeyed facts (30/cycle default). Uses the structured-output lane when the provider supports it (see [structured-output.md](structured-output.md)). |
| `mem extract-gateway --batches N` | Manually drive enqueue+claim cycles (same code path as the daemon task). |

## Benchmarks (the gates)

| Command | Measures | Gate |
|---|---|---|
| `mem bench-extract --recall` | Extraction recall on golden transcripts (anchor-substring facts, incl. the pet-name-class passing-mention fixtures), noise precision, **atomicity** (facts that stand alone — no dangling referential openers), N=2 attempts per fixture to tame provider variance | recall ≥ 0.70 + noise clean (exit-code gated) |
| `mem bench-extract --recall --backends claude,anthropic,…` | **Per-provider parity table** — recall/atomicity/noise per provider | every provider within 20 points of the best (exit-code gated) |
| `mem health [--facts N] [--runs N]` | Vault self-test: sample random facts, LLM-generate natural questions (anti-circular vs stored keys), run the real search pipeline. `--runs` (default 2) aggregates independent random draws — a single draw's score is dominated by the luck of the sample (the same vault measured 37% and 94% minutes apart on one-draw runs). Misses persist into a self-curated regression set (`.vodou/health-regressions.json`) re-tested every run. | informational; regression set is the fix-list |
| `mem retrieval-bench` | Fixed golden queries (`.vodou/retrieval-golden.json`): recall@1/5, MRR, above-floor | bar ≥90% (aspirational — tracks PLAN-RETRIEVAL-ROBUSTNESS) |
| `mem inject-bench` | The **external-LLM inject** path end-to-end (`.vodou/inject-golden.json`): does the right fact inject (`must_inject`), does an unanswerable prompt stay silent (`must_be_silent`), do denied facts never travel (`must_not_leak`). Grades the real selection, not raw retrieval. `--init` seeds a starter file. | recall ≥ bar, 100% silence, 0 leaks (exit-code gated) — see [memory-follows-you.md](memory-follows-you.md) §5 |

Interpretation guide: `bench-extract` grades the **write side** (did facts
get captured), `health`/`retrieval-bench` grade the **read side** (can
natural questions find them). Never react to a single-draw health number.

## Environment knobs

| Var | Default | Purpose |
|---|---|---|
| `VODOU_PROCESS_TIMEOUT_SECS` | 90 | CLI watchdog (exempted commands ignore it) |
| `VODOU_EXTRACT_ORPHAN_GRACE_SECS` | 3600 | How long an unpaired tail may wait for its reply |
| `VODOU_MEMORY_EXTRACT_TIMEOUT_SECS` | 60 | Per-LLM-request timeout (raise for huge IDE-capture prompts) |
| `VODOU_KEYGEN_ENABLED` / `VODOU_KEYGEN_MAX_PER_CYCLE` / `VODOU_KEYGEN_QUESTIONS_PER_FACT` | on / 30 / 3 | Keygen backfill dials |
| `VODOU_RECALL_BENCH_ATTEMPTS` | 2 | Attempts per bench fixture |
| `VODOU_MEMORY_EXTRACTION_PROVIDER` | (unset) | Force the extraction provider for one invocation (used for parity runs / live tests) |
| `VODOU_STRUCTURED_MODE` | on | `off` disables API-level schema enforcement globally |

## Related docs

- [vodou-memory.md](vodou-memory.md) — the memory system end to end
- [structured-output.md](structured-output.md) — API-enforced LLM output shapes
- [memory-follows-you.md](memory-follows-you.md) — vaults, injection, portability
- `PLANS/0.6.18/done/PLAN-EXTRACTION-ROBUSTNESS.md` — the full design + failure catalog
