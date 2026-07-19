---
name: execdesk-action-quarterly-goals-review
description: CEO scores quarterly goals against actuals, names what worked / what didn't / what to carry forward. No green-yellow-red theater.
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - quarterly review
  - quarter goals
  - okr review
  - end of quarter
  - score the quarter
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
    schedule_default: "0 10 1 1,4,7,10 *"
    approval_gate: off
    persistent_workbench: workbench:skill:execdesk-action-quarterly-goals-review
---

# Quarterly Goals Review — CEO honest score (v1.0)

End-of-quarter scoring. The brief lists "this quarter" goals; this skill compares them against actuals (per-exec memory + founder's input) and produces an honest review.

NOT corporate OKR theater. Direct, unflinching, useful for the next quarter's planning.

## Output schema (locked v1.0)

```markdown
# Q<N> Review — <Company>

## Goals set, goals hit
- **<Goal 1>:** [Hit / Partial / Missed] — [1 sentence: what actually happened]
- **<Goal 2>:** [Hit / Partial / Missed] — [1 sentence]
- **<Goal 3>:** [Hit / Partial / Missed] — [1 sentence]

## What worked (and why)
- [Specific. Not "marketing was strong." → "The /r/EDC AMA on March 14 drove 2,300 site visits — biggest single day of the quarter."]
- [Specific.]

## What didn't (and why)
- [Specific. No spin.]
- [Specific.]

## What I'm carrying into Q<N+1>
- [The ONE bet that should anchor the next quarter.]
- [Anything we explicitly dropped — and why.]

—
*[1-line: the honest read on the quarter overall.]*
```

## Voice + grounding rules

- Hit / Partial / Missed only. No "yellow," no "70%," no "on track" euphemism.
- Specific examples for "what worked" / "what didn't"
- "Carrying into next quarter" is ONE bet, not a list

## Failure modes

- ❌ Green-yellow-red dashboard theater
- ❌ Vague language ("we made progress on X")
- ❌ More than ONE next-quarter bet
- ❌ Skipping "what didn't"
