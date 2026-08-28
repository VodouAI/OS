# Orchestration Directives — a tool asking for what happens next

A tool can end its response by saying what should run after it. Vodou reads that
and keeps going, without the model deciding.

```json
{
  "content": [{ "type": "text", "text": "Found 3 stale branches." }],
  "orchestration": {
    "execution_type": "parallel",
    "options": [
      { "label": "lint",  "intent": "run the linter" },
      { "label": "tests", "intent": "run the test suite" },
      { "label": "types", "intent": "typecheck the project" }
    ]
  }
}
```

That is the whole surface. This document is the contract: what each field
promises, what a branch may assume, and what happens when one fails.

> **Status, stated plainly.** As of 2026-08-24 **no shipped tool emits one of
> these**. The lane works and is tested, but it has no producer, which is exactly
> why two bugs sat in it undetected for a long time (see
> [History](#history-why-this-document-exists)). If you are adding the first one,
> read [When NOT to use this](#when-not-to-use-this) first — most things that
> look like a fan are not one.

---

## Where the directive goes

Vodou looks in three places, in order, and takes the first it finds:

1. `response.orchestration` — the root. **Prefer this.**
2. `response.result.orchestration` — for gateway-shaped responses.
3. `response.content[i].orchestration` — embedded in a content item.

A directive that is present but **does not parse** is now reported rather than
ignored:

```
[Orchestration] an `orchestration` directive was present but REJECTED: …
  Valid execution_type: immediate | conditional | parallel | sequential
```

Before that, a misspelled `execution_type` made the whole directive vanish and
the chain quietly ran one thing. If you get no follow-on and no error, check
this line.

---

## The four modes

| `execution_type` | Meaning | Branches |
|---|---|---|
| `immediate` | Run one intent next | one |
| `conditional` | Choose a path from context, or ask the user | one, after choosing |
| `parallel` | Run several independent intents | all of them |
| `sequential` | Run several intents in authored order | all of them |

### `immediate`

```json
{ "execution_type": "immediate", "next_intent": "summarise the results" }
```

`next_intent` is matched against Vodou's intent routing, and the **best-ranked**
tool wins. This is the one mode where "several matches" means candidates for one
job, not several jobs.

### `conditional`

```json
{
  "execution_type": "conditional",
  "conditions": { "status": "failed" },
  "next_intent": "open the failure log"
}
```

Each key in `conditions` is compared against the latest result's data. On a
match, `next_intent` runs. With `user_choice_required: true` and `options`, the
choices are presented and the user picks.

### `parallel`

```json
{
  "execution_type": "parallel",
  "options": [
    { "label": "filings", "intent": "fetch the latest filings" },
    { "label": "pricing", "intent": "check competitor pricing" }
  ]
}
```

Every option becomes **one branch** — its own best-matching tool. Branches do
**not** see each other's output; they are running at the same time. A branch that
needs another's result belongs in `sequential`, or in a chain.

### `sequential`

Same shape, run in authored order. "In order" is a promise about **ordering**,
not about aborting: a failed step does not stop the ones after it.

---

## Fields

| Field | Type | Meaning |
|---|---|---|
| `execution_type` | one of the four above | Required. An unknown value is rejected, not defaulted. |
| `next_intent` | string | Single-branch shorthand. Equivalent to one `options` entry. |
| `options[]` | `{label, intent, parameters?}` | The branches. |
| `parameters` | object | Applies to every branch unless a branch overrides it. |
| `context_data` | object | Visible to every branch. |
| `conditions` | object | `conditional` only — matched against the latest result. |
| `user_choice_required` | bool | `conditional` only — present the options and wait. |

### `options` and `next_intent` are alternatives

Setting both under `parallel` or `sequential` is an **error**:

```
orchestration directive sets BOTH `options` and `next_intent` under Parallel —
they are alternatives (next_intent is single-branch shorthand). Pick one.
```

`options` used to win silently, so an author who set both got an answer to one of
their two questions with no indication which.

---

## What you are entitled to expect

**Every branch runs.** A three-option `parallel` executes three branches. (It did
not always — see [History](#history-why-this-document-exists).)

**A failed branch does not take its siblings down.** It is recorded, and the
others continue.

**The count reaches the answer.** A fan that ran fewer branches than it declared
says so in the output, not only in the log:

```
_Fan: 2/3 branches ran — 1 did not._
```

A complete fan reports `3/3` too. Reporting only on failure would teach a reader
that silence means whole.

**One chain per fan.** If several branches each return their own directive, the
chain continues from the **first** and the others are counted and logged. Letting
each branch continue would turn one directive into N chains and make a fan a way
around the depth limit.

**Depth is shared.** The follow-on chain is bounded (10 hops), and a fan
decrements that budget **once**, not once per branch.

**Every gate still applies, per branch.** The mutation hold gate, `PreToolUse`
hooks and mutation dedup run for each branch exactly as they do for a single
tool call. A fan is not a way to reach a tool that would otherwise be held.

---

## What you should not expect

**Branches are not currently concurrent.** They all run, in order, one at a time.
Making them genuinely concurrent means moving the safety gates above, which is
tracked as P1b in `PLANS/0.6.28/PLAN-ORCHESTRATION-FAN.md` and deliberately
sequenced last.

**Branches cannot read each other.** By definition — they are meant to be
independent. If one needs another's output, you want `sequential` or a chain.

**A branch that matches no tool is skipped, with a log line.** It is not an
error, and it still counts against the fan's total, so the `2/3` is honest.

---

## When NOT to use this

Most things that look like a fan are not one. Before adding a directive:

- **Does the next step read this tool's output?** Then it is a chain
  (`immediate`), not a fan.
- **Do the branches genuinely not need each other?** If branch B would be better
  with A's result, you want `sequential` — or you want one tool.
- **Is it actually N tool calls?** A readiness check across three servers sounds
  like a fan and is usually one database lookup. Fanning it spends three tool
  calls to answer a question a query already answers.
- **Would a skill be better?** Skills have `together:` blocks with the same
  semantics, plus a plan card, a run record, and real concurrency today. See
  `PLAN-GRAPH-SKILLS.md`. Directives are for a **tool** that discovers, at run
  time, that several independent things now need doing — not for a workflow an
  author could have written down.

The last one matters most. Vodou has two lanes for fanning work. The skills lane
is declared by an author and is the one to reach for. This lane exists for the
case a skill cannot express: the tool itself learns what needs to happen next.

---

## History (why this document exists)

This lane shipped with four documented modes, and two of them did not do what
their documentation said. Nobody noticed for a long time, because nothing emitted
a directive — there was no caller to be wrong.

- `parallel` resolved every option correctly and then executed **one**. The
  executor took `[0]` from the resolved list and discarded the rest with no
  error, no log and no count.
- `sequential` lost work earlier still: it returned `options.first()` under a doc
  comment reading *"(return first intent, others will be handled in subsequent
  iterations)"*. They never were.

The cause was a return type that meant two different things: *ranked candidates
for one intent* under `immediate`/`conditional`, and *one match per branch* under
`parallel`/`sequential`. Taking `[0]` is **correct** in three arms out of four,
which is why it survived review — and why the obvious fix (loop over the list)
would have broken `immediate`.

The lesson worth keeping: a feature with no caller is a feature nobody notices
breaking. If you add the first producer, add a test that asserts **executed
branches == authored branches**. Every test in this area passed throughout,
because none of them counted.

Full write-up: `PLANS/0.6.28/PLAN-ORCHESTRATION-FAN.md`, finding QA-G3.
