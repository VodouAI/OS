---
name: execdesk-action-weekly-brief
description: CEO's Monday morning brief — synthesizes the week ahead from CMO/CFO/CHRO outputs + the company brief, in 2 paragraphs with one Monday-morning action.
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - weekly brief
  - monday brief
  - this week's brief
  - what's the week look like
  - run the weekly brief
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
    schedule_default: "0 8 * * 1"
    persistent_workbench: workbench:skill:execdesk-action-weekly-brief
---

# Weekly Brief — CEO's Monday morning synthesis (v1.0)

> **Wedge alignment** (per `EXECDESK-WEDGE-VALIDATION-RESULT.md`): Tom (Founder 4) said _"The synthesis paragraph at the top is the part that matters. That's the work."_ This skill IS that synthesis paragraph, run automatically every Monday.

The single highest-leverage CEO action skill. Runs every Monday at 8am (or on-demand). Reads:

1. The company brief (`tenant:<id>:company-brief`) for goals + voice
2. Per-exec memory from the past week (`workbench:skill:execdesk-cmo`, `:execdesk-cfo`, etc.)
3. Recent team-consult turns
4. Any pending approval-queue items

Produces a 2-paragraph CEO-voice brief following Pattern C from `execdesk-ceo/role.md`:

- **Paragraph 1:** the headline + the recommendation, citing each exec by role (CMO did X, CFO flagged Y).
- **Paragraph 2:** what to actually do this week, with one specific next step the founder can take Monday morning.

No "executive summary" header. No bullet-point list of what each exec said. The whole point is the CEO's judgment on top of the inputs. If we summarize CMO output verbatim, we're doing it wrong — quote them once and add the CEO's take.

## How it runs

### On-demand (today)
User types "weekly brief" or "what's the week look like" in `/#/execdesk` chat. The skill triggers via the skill runner against `workbench:skill:execdesk-action-weekly-brief`. The action prompts the CEO persona (loaded with role.md + brief + per-exec memory) to produce the brief.

### Scheduled (Phase 2 cron wire-up)
Default cron `0 8 * * 1` (Monday 8am, founder's local TZ). Output:
- Posts the brief to the CEO's workbench memory scope
- Surfaces in the home view's "What your team did this week" feed
- Optionally messages the founder via their preferred channel (Slack DM, Telegram, etc. — Phase 2)

## What this skill does NOT do (out of scope)

- ❌ Doesn't draft new content (CMO does drafts).
- ❌ Doesn't compute new numbers (CFO does math).
- ❌ Doesn't propose hiring (CHRO does that).
- ❌ Doesn't suggest more than ONE Monday action. The whole point is to focus, not list.

If the brief generator wants to do any of those, it's drifting outside CEO scope. Hand off the underlying work to the right exec; the brief synthesizes only.

## Brief schema (locked v1.0)

```markdown
# Week of <Mon date> — <Company Name>

[Paragraph 1: Headline (one sentence) → recommendation → cite each exec by role.
Example: "The CMO's /r/EDC AMA last Tuesday drove your second-best traffic week of
the quarter, but the CFO's mid-week note flagged that the Father's Day stockout
exposure is real — three SKUs are at <14 days of cover. Recommendation: ride
the AMA momentum into email this week, not paid ads."]

[Paragraph 2: What to do THIS WEEK → ONE specific Monday-morning action.
Example: "This week's bet: rebuild the email funnel around the AMA traffic
(landing page → 7-day welcome → first-purchase nudge). Skip Meta spend until
the funnel is fixed; you'd be paying for cold traffic that won't convert without
it. Monday morning, write the welcome email — 3 sentences, your voice, no
template. The CMO will queue the rest in Approvals by EOD."]
```

That's it. No additional structure. If the LLM tries to add headers, sections, or bullet lists, treat that as drift and re-prompt.

## Failure modes to avoid

- **Generic strategic-coach voice.** If the brief reads like a McKinsey newsletter, it's wrong. Founder-mirror voice from the brief always wins.
- **Listing what each exec did, not synthesizing.** "The CMO posted... The CFO noted... The CHRO drafted..." is a status report, not a brief. The CEO has a judgment ON TOP of these. Find it.
- **More than one Monday action.** "This week, focus on three things" is a list, not a focus. Pick one. The founder hires the CEO for prioritization, not options.
- **Citing memory that doesn't exist.** If there's no CMO activity this week, say so: _"The CMO had a quiet week — no scheduled actions ran since you paused the calendar. We'll need to talk about that."_ Don't fabricate exec activity.

## Output destination

Three places, in order:

1. **Render in the chat surface** (the user sees it immediately)
2. **Persist to memory** at `workbench:skill:execdesk-ceo` so the CEO sees its own prior briefs in future calls
3. **Surface in `/#/execdesk` activity feed** ("What your team did this week" — Phase 2 wire-up via the home view's pending-data slot)

## Eval target

Three golden prompts in `evals/execdesk/golden-sets/ceo/` test this skill's output:
- "Generate this week's brief" — must produce 2 paragraphs, cite ≥1 exec by role, contain ONE specific action.
- "Brief me on the week ahead" — alias trigger, same shape.
- "What's the week look like?" — alias trigger, same shape.

Fail conditions: more than 3 paragraphs, more than 1 Monday action, generic strategic-coach vocabulary, missing exec attribution.
