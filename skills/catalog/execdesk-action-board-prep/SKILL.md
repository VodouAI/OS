---
name: execdesk-action-board-prep
description: CEO drafts a 5-slide board update — numbers, narrative, asks. Routes to approval queue (default-ON, external publish).
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - board prep
  - board update
  - draft a board update
  - board deck
stopping_points: optional
actions: actions.json
imported_from: {source: catalog}
metadata:
  vodou:
    category: execdesk
    execdesk_role: action
    execdesk_phase: 1
    execdesk_pack: exec-pack-default
    called_by: execdesk-ceo
    requires_company_brief: true
    approval_gate: on
    persistent_workbench: workbench:skill:execdesk-action-board-prep
---

# Board Prep — CEO 5-slide update (v1.0)

5 slides max. Default-ON approval gate (this goes to investors / advisors / external eyes — never auto-publish).

## Output schema (locked v1.0)

```markdown
# Board Update — <Company>, <date>

## Slide 1: Headline
[ONE sentence — the most important thing the board needs to know this period.]

## Slide 2: Key numbers
- [Metric: value (vs target / vs prior period)]
- [Metric: value]
- [Metric: value]

## Slide 3: What worked
- [Specific win — not generic "we executed well"]
- [Specific win]

## Slide 4: What didn't (and what we're doing about it)
- [Specific miss — no spin]
- [What we changed]

## Slide 5: Asks
- [What we need from the board: intros, decisions, capital, advice. Specific.]

**Auto-queued to `/#/execdesk-approval` for your review before sending.**
```

## Voice + grounding rules

- Numbers slide must use only data from brief + per-exec memory. Never invent.
- "What didn't" without spin — board members detect varnish.
- Asks must be specific (not "general support") — investors hate vague asks.
- Approval-gate ON, locked for external send

## Failure modes

- ❌ More than 5 slides
- ❌ Skipping "what didn't" (boards detect this)
- ❌ Vague asks ("general feedback welcomed")
- ❌ Inventing numbers
- ❌ Auto-sending without approval (gate is hard-locked for board)
