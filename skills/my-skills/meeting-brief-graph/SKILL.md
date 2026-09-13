---
name: meeting-brief-graph
description: Before each meeting, a 200-word brief on the attendees from your own memory — every sentence cites the chunk it rests on, unknown names are reported, nothing is invented.
version: 1.0.0
kind: workflow
required_tools: ["google-calendar", "vodou-memory"]
trigger_phrases: ["meeting brief", "brief me before my meeting", "who am I meeting"]
stopping_points: optional
actions: file
---
# Meeting brief (graph form)

PLAN-PEOPLE-PAGES P2 — the graph form of the meeting brief. `recipe.txt` is the
source; `actions.json` is `vodou-core recipe compile recipe.txt` and is not edited
by hand.

What it does, in order:

1. **calendar** — the next two hours of the primary Google calendar
   (`{{NOW}}` → `{{NOW_PLUS_2H}}`).
2. **who** — every attendee and organizer name is looked up in your memory with
   `vodou-memory.entities_lookup`. Read-only: a name memory does not know comes
   back as *no memory of*, and no entity is ever created from an invite.
3. **brief** — at most 200 words. Every factual sentence ends with the
   `[chunk:<id>]` it rests on; unknown attendees get a *no memory of* line; an
   empty window is exactly `NOTHING_TO_REPORT`.
4. **check** — `has_source`, in a fresh context: a brief with an unattributed
   claim line is blocked.

There is no `ask me:`. Nothing in this graph sends; the reply is delivered by
the skill's delivery mode, and a `NOTHING_TO_REPORT` reply is kept in the
console and never forwarded to a channel.

**The scheduled twin.** On 2026-09-10 the scheduler runs graph skills through
`brain /skill` with no delivery and no verdict beyond exit status, so the copy
that runs on the clock is the *console skill* `meeting-brief` (`skills_meta`,
delivery via `delivery_mode`, cron `*/30 12-22 * * 1-5` — the scheduler's
clock is UTC; that is weekdays 08:00–18:00 EDT). Its prompt asks for the same
shape, and the scheduler grades every reply with
`memory::entities::grade_citations`: zero citations after consulting memory is
`could_not / no_sources`, a cited chunk that does not exist is
`degraded / partial_sources`, `NOTHING_TO_REPORT` is `did_the_job /
nothing_to_report`. Flow 16 reads those grades.
