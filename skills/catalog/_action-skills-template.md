# Action-skill scaffolding — exec-pack-default

These 10 `execdesk-action-*` directories are skeleton scaffolds for the action skills that CEO and CMO call via AGENT_ACTIONS. Each one gets a real SKILL.md + actions.json during Phase 1 day 4–11 of PLAN-SMB-EXEC-CONSOLE.md.

**Skeleton SKILL.md template** (use this for each action skill):

```markdown
---
name: execdesk-action-<slug>
description: <one-line: what this action skill does>
version: 0.0.1
kind: workflow
required_tools: [<MCP server>.<tool>, ...]
trigger_phrases: []
stopping_points: optional
actions: actions.json
imported_from: {source: catalog}
metadata:
  vodou:
    category: execdesk
    execdesk_role: action
    execdesk_phase: 1
    execdesk_pack: exec-pack-default
    called_by: [execdesk-ceo | execdesk-cmo]
    requires_company_brief: true
---

# <Title>

<One paragraph: what calling exec uses this for, what artifact it produces>

## Inputs (templated by caller)
- `{{TOPIC}}`, `{{TENANT_ID}}`, etc.

## Output
<Describe artifact shape — markdown brief, scheduled job, draft for approval queue, etc.>

## Approval gate
<ON / OFF / hard-locked, per §0.7 #9>
```

**Skeleton actions.json template:**

```json
{
  "_skeleton": true,
  "_authoring_phase": "Phase 1 day <N>",
  "stopping_points": []
}
```

## CEO-called skills (Phase 1 day 4–6)

| Skill | One-liner | Calls | Approval |
|---|---|---|---|
| execdesk-action-quarterly-goals-review | Pulls current OKRs from memory, scores progress, drafts Q-end review | (memory only) | OFF |
| execdesk-action-board-prep | Drafts board deck slides from CFO numbers + CEO commentary | (CFO data + memory) | ON |
| execdesk-action-decision-framework | Structured analysis for hire/fire/pivot/pricing calls | (memory + Vodou-Enhanced-Thinking) | OFF |
| execdesk-action-weekly-brief | Monday 8am cron: synthesizes the week from CMO/CFO/CHRO outputs | (scheduled, memory) | OFF |
| execdesk-action-competitor-monitor | Daily delegation to existing growth-hack-* skills | (Reddit/HN/PH bots) | OFF |

## CMO-called skills (Phase 1 day 9–11)

| Skill | One-liner | Calls | Approval |
|---|---|---|---|
| execdesk-action-growth-hack-runner | Wraps existing growth-hack-* catalog skills under CMO branding | (growth-hack-social-bot, hn-watcher, etc.) | varies |
| execdesk-action-content-calendar | Monthly content plan tied to company brief goals | (LLM only) | OFF |
| execdesk-action-twitter-thread-drafter | Weekly cron: drafts thread, queues to approval | (LLM, memory) | **ON** (external publish) |
| execdesk-action-icp-profile | Maintains the ICP doc, updated from chat conversations | (memory) | OFF |
| execdesk-action-competitor-positioning | Weekly scan of competitor messaging gaps | (existing competitor monitoring infra) | OFF |

## Authoring order (recommended)

1. `weekly-brief` — easiest, no external calls, immediate user-visible value
2. `decision-framework` — wraps Vodou-Enhanced-Thinking, fast win
3. `twitter-thread-drafter` — first approval-queue user; validates that flow end-to-end
4. `growth-hack-runner` — wraps existing skills; high reuse
5. Remaining 6 in parallel by exec

## Eval implication (§0.11.3)

Each action skill needs ≥3 golden-set prompts in the parent exec's eval suite that exercise the action path. Add these alongside Phase 1 day 5–7 CEO eval and day 11 CMO eval.
