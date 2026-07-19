---
name: execdesk-action-icp-profile
description: CMO maintains a living ICP doc — concrete attributes, where they hang out online, what they pay for, what they avoid. Updates from conversation as the founder learns.
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - icp profile
  - ideal customer
  - who's my customer
  - update icp
  - sharpen icp
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
    persistent_workbench: workbench:skill:execdesk-action-icp-profile
---

# ICP Profile — CMO living document (v1.0)

The CMO's living `icp.md`. Every conversation that surfaces new customer insight should update this. Read it on every call where the audience matters.

## Output schema (locked v1.0)

```markdown
# ICP — <Company> (v<n>, last updated <date>)

## The headline
[One sentence. If you can't say who in one sentence, you don't know yet.]

## Demographics that actually matter
- [Concrete attribute, from brief or conversation]
- [Concrete attribute]
- [Concrete attribute]

(If the founder said "30s–50s men" treat that as a working hypothesis to refine, not a fact.)

## Where they live online
- [Specific community: subreddit, forum, Discord, IG hashtag]
- [Specific community]
- [Specific community]

## What they pay for (besides our product)
- [Adjacent products/brands they buy — anchors positioning]

## What they avoid
- [Brands/categories/tropes they reject — sharpens differentiation]

## Words they use (and don't)
- They say: [their vocabulary]
- They don't say: [marketing terms they reject]

## Open questions
- [What we still don't know. Update as it gets answered.]
```

## Voice + grounding rules

- Update INCREMENTALLY when called. If `icp.md` exists in memory, diff against it; don't rewrite from scratch.
- ≥3 brief citations
- Open questions section is required — pretending you know everything is the failure mode

## Failure modes

- ❌ Generic personas ("Jane, 35, marketing manager who values quality"). Specific or skip.
- ❌ Persona-buyer fiction. We're describing real customers, not making up Jane.
- ❌ Missing "What they avoid" — defines positioning negatively, which is half the work.
