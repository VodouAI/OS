# Proactive loops

Things Vodou notices on its own — capture that went quiet, an automation that
stopped, memory that stopped being extracted — and tells you about **before** you
go looking.

> **`loops` and `findings` are two different things.**
> `vodou-core loops` is the **commitments lane**: what you promised and what you
> are owed, extracted from your own turns. `vodou-core findings` is **this**: what
> the proactive loops have observed about the system. The console's Activity page
> shows the commitments one. Two meanings for one word is how a command becomes
> unguessable, so the commands are named apart even though the console is not.

## The problem this solves

Four curation engines already ran continuously and each had invented its own way
to reach a person: the contradiction detector through an `eprintln!`, the janitor
through a `work_logs` row, the hygiene grader through a command nobody types, the
entity graph through a click. None of those is a place anyone looks.

So every loop now writes to **one** table and reads back through **one** surface.

## The drain

`loop_findings` (migration 100) is the only output. `src/loops/findings.rs` is
the only writer, so the contract is enforced in one place rather than being five
conventions:

1. **Deterministic id ⇒ idempotent.** The id is
   `sha256(loop_name | subject | bucket)[..16]`, where `bucket` is usually the
   local day. An hourly loop watching ONE persistent condition writes one row and
   bumps `last_seen` / `occurrences` — it does not accrete 24 rows a day.
   `first_seen` never moves, because when the condition started is the
   interesting half.

2. **Evidence is mandatory.** A finding that cannot show its numbers is not a
   finding, it is a feeling. This is what lets a briefing say *"ChatGPT capture
   went quiet 8 days ago — 703 messages before, 0 since"* instead of *"capture may
   be broken"*. An empty evidence object is rejected, not stored.

3. **Loops write, they never fix.** Bulk-rewriting flagged chunks on 2026-08-21
   dropped recall@5 from 0.911 to 0.711 and had to be reverted. Nothing in the
   drain touches your data.

4. **Auto-resolve is the loop's job.** A loop that raised a finding clears it when
   the condition clears. Anything not re-observed for 30 days expires.

5. **A loop cannot escalate itself.** `critical` is a grant in the registry, not a
   decision a loop makes at runtime.

## The registry

`loops.toml` declares every loop. A loop that no registry entry declares is
blocked at commit time by `scripts/loop-guard.py` — the registry is the contract
that stops a fifth engine inventing a sixth output path.

```toml
[loops.capture-gap]
emits                 = "loop_findings"   # never anything else
audience              = "user"            # your capture stopped working — that is yours
severity_max          = "warn"
fixture_fires         = "tests/loops/fixtures/capture_gap_broken.json"
fixture_quiet         = "tests/loops/fixtures/capture_gap_clean.json"
fixture_fresh         = "tests/loops/fixtures/capture_gap_fresh.json"
```

**The fixtures are the point.** `fixture_quiet` and `fixture_fresh` are
must-NOT-fire controls — a healthy system and a brand-new install. The reason
they are mandatory is that *five graders shipped false-positive because none had
one*: a check that only ever ran against broken data looks perfect until it meets
a working install.

### `audience` — who a finding is for

| value | means |
|---|---|
| `user` | your thing stopped working; it belongs in your briefing |
| `operator` | a detail about the machine; `vodou-core findings` only |

The briefing filters on this and fails **closed**: a loop that is not registered
shows nobody anything.

## The loops that exist

| loop | watches | max severity |
|---|---|---|
| `capture-gap` | a capture source that has gone quiet, one-sided turns, configured-but-silent surfaces | `warn` |
| `automation-breaker` | an automation that stopped producing | `warn` |
| `extraction-health` | backlog growth, lag regression, a silent stall | `warn` |
| `staleness` | stored preferences and decisions old enough to be worth re-asking | `info` |

Severities are deliberately low. `staleness` is capped at `info` because a
six-month-old preference is a question, not a problem.

## Reading them

```bash
vodou-core findings                      # every open finding, both audiences
vodou-core findings --audience user      # just what a briefing would show
vodou-core findings --json               # for scripts
```

`findings` is **read-only** by design — rule 3. A finding clears when the
condition clears, or expires after 30 days.

## Are they worth reading?

`vodou-core flows` grades that directly (Flow 26): *are the loops worth reading,
or are they training you to ignore them?* It measures findings that expired
**untouched** — nobody acted, nobody dismissed, the 30-day sweep took them. A
drain nobody opens scores badly even while it is technically correct, which is
the only honest way to measure a notification.

Flow 24 asks a narrower question — do the must-not-fire fixtures still prove
anything, or have they drifted into looking like the firing ones?

## Adding a loop

1. Write it under `src/loops/`.
2. Register it in `loops.toml` with all three fixtures.
3. Emit through `findings::observe()` — never `eprintln!`, never a private table.
   It is called `observe` and not `raise` on purpose: the loop reports what it
   SAW, and whether that is a new row or a bump to an existing one is the drain's
   decision (rule 1), not the loop's.
4. Clear your own findings when the condition clears — `resolve()` by id,
   `resolve_subject()` when yesterday's id is unreachable because the id embeds
   the day, or `resolve_missing()` to clear everything the loop no longer sees.

`scripts/loop-guard.py` blocks the commit if the entry is missing, names a
fixture that does not exist, invents its own drain, or grants itself `critical`.
`scripts/test-loop-guard.sh` proves the guard fires in both directions.

## Related docs

- [`vodou-scheduler.md`](vodou-scheduler.md) — the clock the loops run on
- [`runtime-observability.md`](runtime-observability.md) — what else the system reports about itself
