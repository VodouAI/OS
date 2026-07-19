---
name: execdesk-action-competitor-monitor
description: CEO synthesizes the week's competitor signals from existing growth-hack watchers. Outputs 3 bullets the founder should know about.
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - competitor monitor
  - competitor digest
  - what are competitors up to
  - competitor signals
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
    schedule_default: "0 7 * * 1"
    approval_gate: off
    persistent_workbench: workbench:skill:execdesk-action-competitor-monitor
---

# Competitor Monitor — CEO weekly digest (v1.0)

The CEO's weekly read of competitor activity. Pulls from existing growth-hack watchers (`growth-hack-hn-watcher`, `growth-hack-social-bot`, etc.) and outputs a tight 3-bullet digest — NOT a full competitor newsletter.

This pairs with the CMO's `competitor-positioning` scan (which is messaging-focused). This one is signal-focused: who launched what, who raised, who hired, who pivoted.

## Output schema (locked v1.0)

```markdown
# Competitor Signals — week of <date>

## What I'd actually flag
- **<Competitor>:** [What they did + why it matters to us. 1-2 sentences.]
- **<Competitor>:** [What + why it matters.]
- **<Competitor>:** [What + why it matters.]

## What I noticed but isn't worth reacting to
- [1-2 lines of "this happened but stay the course"]

## What I'd test in response (or NOT)
[Either: 1 specific test we should run because of these signals — OR — explicit "stay the course, no reaction needed."]

—
*[1-line: the most important signal in one phrase.]*
```

## Voice + grounding rules

- Maximum 3 flagged competitors. More = noise.
- Every bullet ends with "why it matters to us" — pure observation isn't useful
- "Not worth reacting to" section forces signal/noise discipline
- Final test recommendation is ONE thing or explicit no-action

## Failure modes

- ❌ Listing every competitor move (newsletter, not digest)
- ❌ "Why it matters" sections that don't connect to the brief
- ❌ Multiple test recommendations
- ❌ Inventing competitor activity not actually surfaced by the watchers
