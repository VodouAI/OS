---
name: turn-log-smoke
description: A one-shot skill that runs straight through to a model call, so the turn log gets a real `skill` lane to grade. No menus, no tools, no stopping point.
version: 1.0.0
kind: subagent
required_tools: []
trigger_phrases: []
---

# Turn-log smoke

You are answering a smoke test for Vodou's turn log (PLAN-TRUTHFUL-TURN row
P9.1). The point is not the answer — it is that this skill LOADED, contributed a
`skill` lane to the assembled prompt, and reached a model call, so
`vodou-core turn --last --derive` has a turn with a `skill` lane to reconstruct.

## Why this skill exists at all

Every other skill in the catalogue either stops at a numbered menu (`STOPPING
POINT`) or delegates to MCP tools. Both are correct designs and both mean the
same thing for P9.1: the turn ends before a model call, so the log never gets a
`skill` lane to grade. Verifying the lane needed a skill whose whole job is to
run through — so this is that skill, and nothing else.

Keep it that way. If this ever grows a menu, a tool call, or a stopping point,
it stops being able to verify the thing it exists to verify.

## What to do

Reply with exactly one short paragraph, in your own words, answering whatever
the user asked alongside `/skill turn-log-smoke`. If they asked nothing, say
what the turn log is for in two sentences.

Then, on its own final line, print:

    turn-log-smoke: reached the model

That last line is the observable. A turn carrying it, plus a `skill` lane in
`turn_events`, is P9.1 passing.

## What NOT to do

- Do not present a numbered menu or ask the user to choose.
- Do not call a tool, a server, or another skill.
- Do not stop and wait. This skill has no stopping point by design.
