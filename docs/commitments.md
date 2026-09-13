# Commitments — what you promised, and what you are owed

> **`loops` and `findings` are two different things.** `vodou-core loops` is
> **this**: promises pulled out of your own turns. `vodou-core findings` is the
> [proactive loops](proactive-loops.md) — what the system noticed about itself.
> The console's Activity page shows this one.

## Why it exists

A promise is the most common thing a person says to an AI that the memory system
throws away. Measured over 30 days: **251 promise-shaped user turns became 3
chunks.**

The extractor was right to drop them — *"I'll send the deck Friday"* is not a
durable fact about you, and storing it as one would pollute the memory that
answers *"what does Chad care about"*. But it is a thing you will be judged on.
So promises get their own lane, and it reads the **turn text**, not the tags.

## What it reads, and what it costs

The lane watches `turn_events` for `user/message` rows. A regex pre-filter gates
the model call, and **the filter is the design, not a cost trim**: roughly 8
model calls a day instead of 265.

## What it produces

Rows in `open_loops`:

| kind | means |
|---|---|
| `commitment` | you said you would do something, for someone, possibly by a time |
| `parked_ask` | a question that was asked and never answered |
| `blocked_verifier` | something that could not be checked |
| `disputed_fact` | two sources disagree |

```
$ vodou-core loops
1 open loop(s)  (667 turns seen, 72 model calls)

  #399 [commitment] you owe chad — send Chad an update about GTM plans
       (due 2026-09-14 13:00:00 UTC; from hook at 2026-09-13 02:32:02)
```

`you owe` / `you are owed` is the direction. A commitment with a date is **armed**
— it becomes a scheduled delivery so it reaches you when it matters rather than
when you next open a list. An undated one is listed, never pushed: a reminder
with no deadline is nagging.

## Closing one

```bash
vodou-core loops              # list (default)
vodou-core loops run          # one extraction cycle now
vodou-core loops close <id>   # done
vodou-core loops drop <id>    # it was never real
```

`close` and `drop` both set `closed_at`; they differ in `closed_by`, so the
ledger can tell "I did it" from "that was noise". Nothing is deleted.

The lane also closes loops on its own when it sees the promise kept — a reply on
the platform, or a report naming the same thing.

## The timezone it uses

A dated commitment resolves its "Friday" against **your** timezone, through
`user.timezone` (see
[vodou-scheduler.md](vodou-scheduler.md#which-clock-a-schedule-is-on)). If you
have never set one, it falls back to the machine's clock and says so — once a
day, and only after a dated promise has actually been stored against it, because
a warning that fires before it has cost you anything is one you learn to ignore.

Stored instants are naive UTC, so the list prints `UTC` explicitly rather than
implying a zone it does not know.

## Related docs

- [proactive-loops.md](proactive-loops.md) — the other thing called "loops"
- [vodou-scheduler.md](vodou-scheduler.md) — how a dated commitment gets delivered
