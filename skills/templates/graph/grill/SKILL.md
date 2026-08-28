---
name: grill
description: Draft an approach, attack it with fresh eyes, and ask you before any work starts — the alignment gate
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - "grill this"
  - "grill my plan"
  - "plan first"
  - "align before you build"
  - "check my approach"
stopping_points: required
actions: actions.json
imported_from:
  source: hand-written
metadata:
  vodou:
    category: graph-template
    cost_tier: quick
---

# Grill — the alignment gate

Before any work starts: draft an approach, **attack it**, then ask you.

This is the cheapest correction in the whole loop. A plan is a paragraph; the
work is an afternoon. Finding the missing file, the unhandled case or the absent
test while it is still a paragraph costs a few seconds of model time. Finding it
after the work is done costs the work.

## What it does

1. **Asks what you want planned.** Nothing runs until you have said.
2. **Drafts an approach** — concrete: which files, in what order, and the one
   test that would prove it worked.
3. **Grills the draft.** A second pass whose only job is to find what the plan
   fails to name. It did not write the plan and does not defend it.
4. **Checks the grill itself.** A critique that objects in general terms is
   not usable — it cannot be acted on and cannot be argued with. This check
   runs on a fresh context that has seen neither the plan-writer nor the
   critic, and blocks if the grill did not quote what it was attacking.
5. **Asks you** before anything proceeds.

## Why the grill is a separate step

Every serious result on AI self-review says the same thing: a model reviewing its
own work is far too easy on itself. The critique has to come from a call that did
not produce the thing being criticised, or it is agreement in a different font.

That holds here by construction. Each step in a Vodou graph is a stateless
one-shot call — the grill receives the plan's *text*, not the plan-writer's
conversation. It has the artifact and no attachment to it.

## Using it

Say any trigger phrase, or run it from its Skill Console tab. Answer the first
question with what you want planned — a feature, a migration, a decision, a
piece of writing. It is not specific to code.

To skip the gate on work you have already thought through, just do the work.
The point of this skill is the moments when you have not.

## Shape

<!-- GRAPH
ask first:
  TASK: What should I plan? Describe the change or decision.
together draft:
  plan: Draft a concrete approach for this task: {{TASK}}. Name the specific files, systems or steps you would change, the order you would do them in, and the ONE observation that would prove it worked. State what you are assuming. No hedging, no options list — commit to an approach.
then:
  grill: You did NOT write this plan and you do not have to defend it. Attack it: {plan}. Find what it fails to name — a file it will have to touch and did not mention, a case it does not handle, an assumption it states as fact, a way it could be wrong that it cannot detect. Be specific; quote the part you are attacking. If a gap is real, say what would close it. If the plan is genuinely sound, reply exactly "no gaps found" and nothing else — do not invent a critique to look useful.
check:
  - Does the grill quote the specific part of the plan it is attacking, rather than objecting in general?
ask me:
  - Proceed with this plan?
-->
