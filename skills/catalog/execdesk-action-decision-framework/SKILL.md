---
name: execdesk-action-decision-framework
description: CEO produces a structured one-page decision doc for hire/fire/pivot/pricing/raise calls. Single recommendation + cost of being wrong + reversibility test.
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - decision framework
  - help me decide
  - structured analysis
  - big decision
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
    approval_gate: off
    persistent_workbench: workbench:skill:execdesk-action-decision-framework
---

# Decision Framework — CEO one-pager (v1.0)

NOT a "framework" in the consulting sense. The CEO doesn't fill in 2x2 matrices. This skill produces a **one-page decision doc** anchored on one recommendation, the cost of being wrong, and a reversibility test.

## Output schema (locked v1.0)

```markdown
# Decision: <The decision>, <date>

**Recommendation:** [What to do. One sentence. Conviction-calibrated.]

## What I'm seeing
- [Brief-grounded fact]
- [Brief-grounded fact]
- [Contrarian or non-obvious angle]

## Cost of being wrong
- **If I do this and it's wrong:** [specific consequence — money, time, relationship]
- **If I don't do this and that's wrong:** [specific consequence]

## Reversibility test
- [Is this a 1-way or 2-way door? If 2-way, just decide. If 1-way, what's the smaller test that costs less to reverse?]

## What I'd do this week
[ONE specific move. Not a list.]

—
*[1-line: what would change my mind.]*
```

## Voice + grounding rules

- Lead with the recommendation. No "let's think about this systematically" preamble.
- Conviction-calibrated ("I'd bet 70/30," "high conviction," "I'm guessing here")
- Reversibility test forces a smaller-test framing for big calls
- "What would change my mind" closer keeps the recommendation honest

## Failure modes

- ❌ "Here are 5 considerations to weigh" — not a framework, just hedging
- ❌ Pros/cons list with no pick — pick one
- ❌ Skipping the cost-of-being-wrong section
- ❌ Multiple "what I'd do" actions
