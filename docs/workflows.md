# Workflows — say it, see it, run it

A workflow is several tools running as one thing, with the parts that don't need
each other running at the same time. You describe it in a sentence; Vodou shows
you a **plan** before anything happens; you decide whether to run it.

Nothing in this document executes when you ask for it. Building a plan compiles
and describes — the buttons are what run.

---

## Why it's a graph

Everything below calls this a workflow. The code, the events and the database
call it a **graph** (`graph_plan`, `graph_runs`, `/api/graph/*`), and the reason
is worth two minutes because it explains every design decision here.

A recipe is a set of **steps** and the **reads between them**. When one step's
text mentions `{calendar}`, that is an edge: this step needs that one's output.
Steps with no edge between them are independent — and independence is a fact
about the work, not a preference, which is what makes it safe to run them at the
same time without asking anyone.

```
   calendar ─┐
   mail ─────┼──▶ join (2 of 3) ──▶ digest ──▶ check ──▶ ask me
   slack ────┘
```

Three consequences you can see in the product:

- **Parallelism is derived, not declared.** You do not mark things parallel. If a
  step reads nothing from the step above it, the compiler moves it into the
  `together:` block and tells you it did — that is the ⓘ note on the plan card.
  A chain that was only a chain because you wrote it in order becomes 4.6× faster
  without you doing anything.
- **A failure is a value the graph can route**, not an exception. One branch
  timing out does not take the run down: the join records `2 of 3 settled`, names
  the branch that died, and the run continues if the count is met.
- **The join is the only place that decides.** Counts come from recorded branch
  states, never from what a model wrote about them — so the number you read and
  the number the system stored cannot disagree.

A "workflow" with one step and no edges is a graph too. It is just not an
interesting one, which is why those are declined (see below).

## Three ways in

**1. Just say it.** A sentence that describes recurring or multi-step work is
recognised on its own:

```
every morning check my calendar and unread mail and write me a summary
every friday post a project summary to slack and email the team
whenever a PR lands, check CI and tell me what broke
```

Recognition is deliberately narrow: an explicit schedule word (*every morning*,
*whenever*, *each week*) or an explicit workflow word (*workflow*, *automation*).
A bare `and` chain is **not** enough — *"check my calendar and email"* is two
lookups to most people who type it, and treating it as a workflow would change
what already works for everyone.

**2. `/workflow <sentence>`** — for everything the sentence rule ignores by
design:

```
/workflow summarize my unread mail and post it to slack
/workflow pull my open github issues and my calendar and tell me what's realistic today
```

No schedule word, no guess: you named the intent. Bare `/workflow` prints usage.

**3. `create-a-skill`** still works and now writes a recipe rather than JSON by
hand.

### When a sentence keyword-matches a tool

*"every morning summarize my calendar…"* also matches the calendar tool. Vodou
**holds** that auto-route rather than outbidding it — running one tool would
answer a different question than the one you asked. `vodou-core intent-signal
"<sentence>"` shows the hold and why.

---

## The plan card

```
Here's how I'd run that
together — these don't need each other, so they run at once
  calendar   google-calendar·list-events
  mail       gmail·messages_list
  join — needs 1 of 2
then — needs the results above
  digest     write one weekly digest from {calendar, mail}
ask me — nothing ships without you
             email this digest to me?
[Run once]  [Save + schedule]  [Edit recipe]
```

**`[Run once]`** runs the plan without saving it, through the same driver a saved
skill uses — so the `ask me` gate above is enforced rather than skipped.
**`[Save + schedule]`** asks for a name, a phrase to run it by, and an optional
schedule, then writes the skill, its trigger and its scheduled task, reporting
each by name. If the skill saves and the schedule does not, it says so rather
than rounding up to "done".

```text
```

- **The tool column is the RESOLVED `server·tool`** — a wrong resolution is
  visible while it is still free to fix.
- **⚠ marks a step that changes something outside Vodou** (sends, posts,
  deletes). Those are **held behind an `ask me` gate** unless you wrote
  *"without asking"* — held, not merely announced: the step does not run until
  you answer. The compiler decides this, so it is true of a plan you run once, a
  skill you save, and a skill on a schedule alike.

  Two consequences worth knowing:

  - **A send inside a `together:` block takes the whole block with it.** Moving
    one branch alone would leave its join counting a branch that never ran. If
    you want the harmless steps to run first, put the send in its own block —
    the compiler says so in a ⓘ note when it happens.
  - **A step that READS a send's output is refused**, not reordered. It cannot
    both wait for your approval and hand its output to something that already
    ran; split it into two recipes.

  The gate is over-inclusive on purpose: a false positive costs one click, a
  false negative sends something you did not authorise.
- **ⓘ notes are the compiler's own words** — most often that a step you wrote as
  sequential does not actually read anything from the step above it, so it was
  moved into the parallel block.
- **The join line is computed from recorded branch states**, never from model
  text.

---

## Where it shows up

One engine, several surfaces. Each renders the SAME facts — the canonical text
form travels on the wire so a surface without a DOM shows exactly what the web
card enhances, rather than reimplementing it and drifting.

| Surface | What you get |
|---|---|
| **Console chat** | The full plan card, live run card, `[Run once]` / `[Save + schedule]`, buttons for `ask me:`. |
| **Side panel** (next to ChatGPT/Claude/Gemini) | The plan as text, run lines as they happen, and the `ask me:` question with numbered buttons. |
| **Channels** (Telegram, Slack, Discord, WhatsApp, iMessage, Signal, Teams, Google Chat, Voice, Web) | The same as text. You answer with the number. This is what makes an approval reach a phone. |
| **Board** | A graph mini-run card in the task drawer — outcome, branch counts, and what it is waiting on. Board runs record which task caused them. |
| **Skills catalog** | Shape glyph, schedule + last run, and the shape filter. |
| **CLI** | `vodou-core recipe compile <file> --plan` prints the plan, including the ⚠ line naming which step leaves the machine. |

## The recipe notation

The plan card is a rendering of this, and `[Edit recipe]` puts it in front of
you:

```
together sources:
  calendar: google-calendar.list-events {"calendarId":"primary","timeMin":"2026-08-25T00:00:00Z"}
  mail: gmail.messages_list {"labelIds":["UNREAD","INBOX"],"maxResults":15}
then:
  need: 2 of 3
  digest: write one summary from {calendar, mail}
check:
  every item names its source
ask me:
  post this to #daily?
```

| Block | Means |
|---|---|
| `together:` | These run at once. Members that hit the same server queue one at a time. |
| `then:` | Needs the results above. `{name}` reads a step's output. |
| `need: N of M` | The join. A branch that fails is recorded and named; the run continues if the count is met. |
| `check:` | A verifier with **fresh context** — it never sees the conversation that produced the work. `unknown` is never a pass. |
| `ask me:` | Stops and waits for you. |

Three sigils are filled at run time and are never validated at compile time:
`{branch}` (a step's output), `{{VAR}}` (a captured variable), `{@my team}` (a
personal fact from memory — only IDENTITY/PREF/USER facts answer, ambiguity is
reported rather than guessed, and every fill carries its `chunk_id`).

`actions.json` is still the only thing the engines run, and `vodou-core recipe
show <file>` converts back. What changed is who writes the JSON.

---

## After it runs

A skill's own tab (its **Skill Console**) shows what it has done:

- the header line — `last: 11m ago 2/3 · partial · 20s`
- a **Runs** list, collapsed, newest first, with `N not clean` in the toggle so a
  bad run is findable without opening every entry
- a **Shape** panel showing the recipe, decompiled from the actions that actually
  run

A multi-phase skill writes one run row **per phase**, and the list groups them
into one entry marked `2 phases` — otherwise four rows appear for one thing you
ran once.

Every number on those screens is computed by the server from recorded branch
states, and the header, the list and the run card all read the same field. They
cannot disagree with each other.

---

## What refuses, and why

**Arguments the tool would reject.** The compiler checks values against the
tool's own input schema and refuses rather than guessing:

```
`calendar` calls google-calendar.list-events and argument `timeMin` is "yesterday",
and the tool wants a timestamp. Nothing resolves relative dates when a recipe is
compiled, so this would reach the API verbatim. Write an absolute timestamp
(e.g. "2026-08-25T00:00:00Z")
```

Relative dates are **not** resolved for you: deciding whether that happens at
author time or run time is unfinished, and a wrong guess can fire a send.

**A plan with no tools.** Free prose compiles into a `prompt` step, so
*"do the thing"* is a valid one-node graph — and a card for it is just your
question rephrased. Those are declined.

**Not caught:** a well-typed value that is still wrong. `{"query":"from:me"}` is
a valid string against a string schema; only Slack knows it means nothing.

---

## For developers

**CLI**

| Command | Does |
|---|---|
| `vodou-core recipe compile <file>` | Recipe → `actions.json`. `--plan` for the card as text, `--with-notes` for JSON with compiler notes and which steps could not be argument-checked. |
| `vodou-core recipe show <file>` | `actions.json` → recipe. |
| `vodou-core recipe check <rule> --artifact <file>` | Run a verifier. |
| `vodou-core recipe note` | Append one bullet about a run to today's memory log. |
| `vodou-core call-group` | Run a `together:` block as ONE process. Spec on stdin, one JSON outcome on stdout. |
| `vodou-core intent-signal "<text>"` | Whether a sentence is held as a workflow, and why. |
| `vodou-core flows --flow 11` | Is extraction still honest? (unrelated to graphs, but the same instrument.) |

**HTTP** (gateway, `:8765`)

| Endpoint | Does |
|---|---|
| `POST /api/graph/plan` | Compile a recipe and describe it. Executes nothing. Returns the plan plus its text form. |
| `GET /api/graph/runs?skill=&limit=` | Run history with a computed summary, parsed branches and counts. |
| `GET /api/graph/runs/:runId` | One run. |
| `GET /api/graph/asks` | Every run currently parked on a question. |
| `POST /api/graph/runs/:runId/answer` | Answer a parked run — `{"answer":"1"}`. Within one gateway process; see the limits. |
| `POST /api/graph/run` | Run a plan ONCE without saving it (`[Run once]`). Registers it as a live workflow so the `ask me:` gate is enforced by the same driver a saved skill uses. |
| `POST /api/graph/save` | Save a plan as a skill (`[Save + schedule]`) — SKILL.md, actions.json, trigger phrases, and a scheduled task when a schedule is given. |
| `GET /api/graph/recipe?skill=` | A skill's shape, DECOMPILED from its actions rather than read from prose that can drift from them. |
| `GET /api/graph/shapes` | Every skill that has a graph, with its shape (`chain`/`fan`/`fan+check`/`cycle`/`menu`), width, check count, whether a gate holds a send, and its schedule with last-run. Computed from `actions.json` on disk and the scheduler table — never from a description. |

**Events** (WebSocket, alongside `tool_call_*`): `graph_plan`, `graph_branch`,
`graph_join`, `graph_check`, `graph_ask`, `graph_done`. Every count in them is
read from recorded state, never from model text. They are buffered and replayed
on reconnect, so a browser that reloads mid-run redraws the card rather than
showing half of one.

**Vocabulary.** The notation deliberately never shows engine words. When you
move from this page to the code, this is the mapping:

| You write | Engine field | Meaning |
|---|---|---|
| `together:` | `parallel_group` | Independent branches, run at once |
| `then:` | `depends_on` + `kind: join` | Needs the results above |
| `need: N of M` | `min_success`, `on_partial` | Partial-failure policy |
| `check:` | `kind: verifier` (`fresh_context: true`) | Gate; never sees the worker's conversation |
| `ask me:` | `kind: human` (stopping point) | Human approval, inline |
| `skip if missing` | `on_fail` | A failure the graph routes around |
| (never written) | `capture`, `artifact`, `out` | Data plumbing, inferred |

**Source:** `src/graph_recipe.rs` (compiler — and where the approval gate is
enforced), `src/graph_args.rs` (argument
validation), `src/graph_group.rs` (parallel execution), `src/graph_check.rs`
(verifiers), `src/graph_shape.rs` (is this a workflow?),
`MCP-servers/Vodou-Console/src/graph-plan.ts`, `graph-offer.ts`, `graph-runs.ts`,
`graph-save.ts`.
Schema: `schemas/actions.schema.json`.

---

## Current limits

Stated plainly so nothing here reads as more finished than it is.

- **`[Edit recipe]` puts the recipe in the composer** instead of an inline
  editor, and the Shape panel on a Skill Console tab is **read-only**. Editing
  means recompiling and rewriting the skill, which is the same write path
  `[Save + schedule]` uses and has not been done yet.
- **`[Show as diagram]` does not exist.**
- **No cost or time estimate** on the card header. A first run has nothing to
  estimate from, and inventing a number is worse than showing none.
- ~~The catalog has no shape glyph or filter~~ **Done 2026-08-26.** Every skill
  row shows its shape and, when scheduled, its cadence and last run; the list
  filters by `all · wide · with checks · scheduled`. The chips appear only when
  something could match them, so an install with no wide skills is not offered a
  filter that would always come back empty.
- **A parked run does not survive a gateway restart.** The workflow state that
  would resume it is in memory, so a restart sweeps parked runs to `failed`
  rather than leaving a question whose workflow no longer exists — answerable
  forever, resumable never. **Cross-surface answering therefore works within one
  gateway process.** Answering from a phone tomorrow is not yet a thing this
  does.

  This is now **measured, not assumed**: `scripts/broken-lab.sh graph-kill` boots
  an isolated gateway, SIGKILLs it mid-fan with branches recorded
  (`{"expected":2,"settled":0}`), restarts it, and reads back what boot reconcile
  did — the run is recovered as `failed` with its branch states preserved, and no
  run is left claiming to be running. That is the honest shape of the guarantee:
  **a crash never loses the record of what was in flight, and never lies about
  it — but it does not resume the work.**
- ~~Answering from another surface is proven at the API, not yet end to end
  through a channel.~~ **Done 2026-08-26.** The side panel renders the plan, the
  live run lines and the `ask me:` question with its options as buttons that send
  the number you would have typed. Channels (Telegram, Slack, Discord, WhatsApp,
  iMessage, Signal, Teams, Google Chat, Voice, Web) receive the same thing as
  TEXT and you reply with the number. Before this the gate held and **nobody was
  told** — a parked run was silent on every one of those surfaces.
- **A run card has no `[Edit]`**, because `graph_done` does not carry the recipe
  it came from, and no sticky pill when the card scrolls away.

Plans: `PLANS/0.6.28/PLAN-GRAPH-SKILLS.md` (the whole design) and
`PLANS/0.6.29/done/PLAN-GRAPH-FRONTEND.md` (what remains, in order).
