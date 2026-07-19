---
name: execdesk-action-content-calendar
description: CMO produces a 4-week content plan tied to brief's quarter goals. Channel-fit reasoning, not generic topic lists. Includes "what we're NOT doing" boundary.
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - content calendar
  - content plan
  - plan my content
  - monthly content
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
    schedule_default: "0 10 1 * *"
    approval_gate: off
    persistent_workbench: workbench:skill:execdesk-action-content-calendar
---

# Content Calendar — CMO 4-week plan (v1.0)

Monthly content plan tied to brief's "this quarter" goals. NOT a generic topic list — channel-fit reasoning grounded in the founder's actual audience and bandwidth.

## Output schema (locked v1.0)

```markdown
# Content Plan — <Month YYYY> for <Company>

**Anchor:** [The single quarter goal this month's content serves. From the brief.]
**Audience:** [Who you're talking to and where they live online.]

## Week 1 (dates)
- **Mon:** [Channel] — [specific topic]. Why: [1 line]
- **Wed:** [Channel] — [specific topic]. Why: [1 line]
- **Fri:** [Channel] — [specific topic]. Why: [1 line]

## Week 2–4 (same structure)

## What I'm NOT doing this month (and why)
- [Channel skipped]: [reason from brief]
- [Format skipped]: [reason from brief]

## Success metrics
- [Specific. NOT "engagement" / "awareness."]
- [Another specific.]

—
*[1-line rationale: why this rhythm, why these channels.]*
```

## Voice + grounding rules

- ≥3 brief citations (audience names, channel-fit reasons, brand specifics)
- Each topic specific enough that founder could draft it tomorrow
- "What I'm NOT doing" section is non-negotiable — forces deliberate channel choice
- Channels limited to 3 max
- Default cadence: 3 posts/week, ~12/month. Adjust to brief's solo-vs-team reality

## Failure modes

- ❌ Daily content plans for solo founders (don't add work)
- ❌ Channel buffet (pick 2–3, double down)
- ❌ Generic topics ("share your origin story") — specific or skip
- ❌ Missing the NOT-doing section
