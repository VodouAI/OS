---
name: execdesk-action-growth-hack-runner
description: CMO recommends + sequences which existing growth-hack catalog skills to run this week, given the brief and current goals.
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - growth hack
  - run growth hacks
  - what should we run this week
  - growth experiments
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
    approval_gate: off
    persistent_workbench: workbench:skill:execdesk-action-growth-hack-runner
---

# Growth-Hack Runner — CMO recommends + sequences (v1.0)

The CMO does NOT execute growth-hack skills directly — those have their own runners (`growth-hack-social-bot`, `growth-hack-hn-watcher`, `growth-hack-twitter-thread-scheduler`, `growth-hack-facebook-groups`, `growth-hack-newsletter-digest`). This skill **recommends which to run, in what sequence, with what topic anchor.**

## Output schema (locked v1.0)

```markdown
# Growth Plan — <week of date> for <Company>

**Anchor:** [The single goal these experiments serve. From brief.]

## Run this week (in order)

### 1. <growth-hack-skill-name>
- **Topic anchor:** [specific topic from brief / current launch]
- **Hypothesis:** [what you think will happen + why]
- **Cost:** [hours of founder time + $ + tradeoffs]
- **Success metric:** [specific number]
- **Time to learn:** [when you'll know]

### 2. <growth-hack-skill-name>
[same structure]

## Skipping this week (and why)
- <growth-hack-skill-name>: [why not now]

—
*[1-line rationale: why this sequence, why these experiments.]*
```

## Voice + grounding rules

- Reference REAL existing growth-hack-* skills by name (the ones the user has installed; check memory or assume the catalog defaults)
- Each experiment must have all 4 fields (Hypothesis / Cost / Success metric / Time to learn) — incomplete = not ready
- Cap at 2–3 experiments per week. More = nothing happens.
- Skipping section forces deliberate choice

## Failure modes

- ❌ Recommending non-existent skills
- ❌ Running everything in parallel (founder bandwidth check)
- ❌ Vague metrics ("more engagement")
- ❌ No "skipping" section
