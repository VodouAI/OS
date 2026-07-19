# Runtime observability (kernel health)

Vodou exposes a single **overall** runtime signal (**healthy** / **degraded** / **down**) plus per-component detail from the daemon, worker, and gateway. Use this before blaming the LLM or MCP tools when chat or tools misbehave.

## Web UI

- **`#/system`** — Full breakdown (versions, processes, WebSocket, **`runtime`** payload when present).
- **Chat footer** — **Kernel** link (color by status); polls **`GET /api/system`** about every **25s** (gateway caches the `runtime-status` subprocess result server-side; polling stays cheap).
- **Shell v2 menubar** — Kernel pill (dot + short label) next to memory/model/WebSocket; same data source; click goes to **`#/system`**.

## API

**`GET /api/system`** includes a **`runtime`** object (when available) with at least **`overall`**. The gateway merges this with version info; see `MCP-servers/Vodou-Console/src/api/system.ts` for cache TTL behavior.

## Continuity component (added v0.5.74)

`runtime.components.continuity` reports the live state of the continuity primitive — the cross-surface user-identity layer documented in [vodou-memory.md](vodou-memory.md). Inspect it directly:

```bash
./vodou-core runtime-status --json | jq '.components.continuity'
```

Sample output (healthy install with light traffic):

```json
{
  "phase": "phase-5",
  "ok": true,
  "principals_count": 2,
  "aliases_count": 0,
  "has_self_principal": true,
  "note": "Phase 0/1/1.5/2/2.5/4/5 chokepoints active. SLO + resolver cache observable.",
  "last_record_turn_ms": 2,
  "record_turn_total": 147,
  "slo_violations_total": 0,
  "slo_violations_24h": 0,
  "slo_violation_ratio": 0.0,
  "slo_warm_threshold_ms": 200,
  "resolver_cache_hits": 24,
  "resolver_cache_misses": 1,
  "resolver_cache_hit_ratio": 0.96
}
```

| Field | What it means | Healthy range |
|---|---|---|
| `phase` | Highest continuity phase active in this binary | `"phase-5"` (current) |
| `ok` | Schema present + at least one principal | `true` |
| `principals_count` | Rows in `principals` table | `≥2` (self + assistant) |
| `aliases_count` | Rows in `principal_aliases` (multi-principal Phase 3) | `0` until Phase 3 ships |
| `has_self_principal` | The install owner row exists | `true` |
| `last_record_turn_ms` | Duration of the most recent `record_turn` call | `<10ms` typical, well under 200 ms warm SLO |
| `record_turn_total` | Lifetime count since daemon boot | grows monotonically with traffic |
| `slo_violations_total` | Lifetime count of `record_turn` calls that exceeded `slo_warm_threshold_ms` | should stay `0` |
| `slo_violations_24h` | Same, sliding 24-hour window (auto-pruned) | should stay `0` |
| `slo_violation_ratio` | `slo_violations_total / record_turn_total` | should stay `0.0` |
| `slo_warm_threshold_ms` | Per-state SLO ceiling for the warm path | `200` (constant) |
| `resolver_cache_hits` / `_misses` | LRU cache stats for `principal_resolver` | hit ratio climbs to ~0.95+ after warmup |
| `resolver_cache_hit_ratio` | `hits / (hits + misses)`, or `null` if no calls yet | `null` → first call → settles ~0.95+ |

A healthy continuity surface looks like: **`ok=true`, `slo_violations_24h=0`, `resolver_cache_hit_ratio > 0.9` once the daemon has handled a few prompts.**

### Recall trace (default-on in v0.5.74+)

`.env` sets `VODOU_RECALL_TRACE=1` so every recall call emits a one-line trace to `.vodou/system.log`:

```
[continuity recall] principal=(any) scope=(none) mode=Standard top_k=5 returned=5 dropped_by_principal=0 415ms
```

Useful when triaging "why didn't memory show up" questions — the trace shows what was asked, what was returned, and how many rows the principal filter dropped.

## CLI

```bash
./vodou-core runtime-status --json
./do runtime-status
```

Prefer **`vodou-core runtime-status --json`** for scripts, CI, and pipes — **`./do`** may print extra lines that confuse **`head`** / partial reads.

## Environment variables

| Variable | Role |
|----------|------|
| **`VODOU_GATEWAY_AUTO_ENSURE`** | When truthy, gateway startup can ensure the daemon (and related bootstrap). Turn off if you manage the daemon explicitly. |
| **`VODOU_HOOK_SKIP_ENSURE`** | When set, Cursor/IDE hooks skip daemon ensure — useful when hooks must not block on orchestration during incidents or controlled tests. |

See `.env.example` for defaults and related keys.

## Binary swap hygiene (UE / stuck processes)

Replacing **`vodou-core`** while daemon, worker, or gateway-spawned children still run can contribute to bad process states and **uninterruptible sleep** around exec/read.

1. **`./do daemon stop`** and **`./do worker stop`** (from project root with correct **`VODOU_PROJECT_PATH`**).
2. **`pgrep -fl vodou-core`** — terminate lingering daemon, worker, CLI, and **`runtime-status`** children before overwriting the binary.
3. Copy **`target/{debug,release}/vodou-core`** → **`./vodou-core`** (or your install path).
4. Restart daemon/worker/gateway as you normally do.

Deep dive: **`PLANS/0.5.73/PLAN-RUNTIME-OBSERVABILITY.md`** (sections 11–12).

## Related

- **`bash scripts/vodou-doctor.sh`** — Full health audit; see [troubleshooting.md](troubleshooting.md).
- **Triage blurb for agents:** root **`AGENTS.md`** → **Troubleshooting** → **Kernel / runtime triage**.
