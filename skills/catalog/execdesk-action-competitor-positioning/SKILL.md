---
name: execdesk-action-competitor-positioning
description: CMO weekly scan — what competitors are saying, what gap to claim, where the positioning is drifting.
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - competitor positioning
  - competitor scan
  - what are competitors saying
  - positioning gaps
stopping_points: optional
actions: actions.json
imported_from: {source: catalog}
metadata:
  vodou:
    category: execdesk
    execdesk_role: action
    execdesk_phase: 1
    execdesk_pack: exec-pack-default
    called_by: execdesk-cmo
    requires_company_brief: true
    schedule_default: "0 11 * * 5"
    approval_gate: off
    persistent_workbench: workbench:skill:execdesk-action-competitor-positioning
---

# Competitor Positioning Scan — CMO weekly (v1.0)

Weekly Friday scan. NOT a competitor feature audit (that's a different exercise). The output is a "what messaging gap should we claim" recommendation.

## Output schema (locked v1.0)

```markdown
# Competitor Scan — week of <date> for <Company>

## What competitors emphasized this week
- **<Competitor 1>:** [the angle they leaned into — landing page, tweet, ad copy]
- **<Competitor 2>:** [angle]
- **<Competitor 3>:** [angle]

## What they're NOT saying (the gap)
[1–2 sentences. The positioning angle nobody is claiming. This is where we play.]

## Our positioning this week
**Stay:** [if our anchor still holds — say so + why]
**Sharpen:** [what micro-shift to test in this week's content]
**Avoid:** [where the competitors are crowded — don't fight there]

## One thing to test this week
[Specific tactical move: a tweet angle, a landing page headline test, a community post angle.]

—
*[1-line rationale.]*
```

## Voice + grounding rules

- Names competitors from the brief by name. Don't invent.
- "What they're NOT saying" is the highest-leverage section — that's where the gap is
- One thing to test, not a list. Focus.

## Failure modes

- ❌ Feature-spec audit ("Competitor X has free shipping, you don't"). Skip — that's not positioning.
- ❌ Hedged recommendations ("we could test something around X"). Specific test or skip.
- ❌ Naming competitors not in the brief
