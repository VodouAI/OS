---
name: autonomous-plan
description: Create or edit the plan file the autonomous scheduler uses so Vodou can work unattended (e.g. overnight).
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - "create autonomous plan"
  - "plan for autonomous"
  - "autonomous plan"
  - "set up overnight"
  - "oi work on itself"
  - "vodou work on itself"
  - "create plan for scheduler"
stopping_points: required
actions: none
imported_from:
  source: hand-written
---

# Vodou Autonomous Plan — Create a Plan for Unattended Runs

## What This Does

The **autonomous scheduler** runs `./do 'autonomous continue'` on a schedule (e.g. every 4h). Each run: the **planning step** reads a plan file (from `.env`: `VODOU_AUTONOMOUS_PLAN_PATH`), asks an LLM for **one** next task, then runs it. So Vodou can work on itself while you sleep — one task per run.

**When adding a scheduled task for autonomous runs**, the payload must always be **`./do 'autonomous continue'`**, never the text of a plan task (e.g. "Add unit tests for...").

This skill helps you **create or edit** that plan file and wire up `.env` and the schedule.

---

## Plan File Location and Format

- **Recommended path**: `.vodou/workspace/autonomous-plan.md` (already created as a template).
- **Alternative**: Any path relative to project root, e.g. `PLANS/0.5.33.3/0.5.33.3.2/VODOU-FULL-BUILD-PLAN.md`.
- **Format**: Markdown with a clear **Goal** and **phases/sections** of concrete, one-at-a-time tasks. Use `- [ ]` checkboxes or "NEXT" so the LLM can pick the next task. Example:

```markdown
## Goal
Improve Vodou while unattended: tests, docs, small refactors.

## Phase 1
- [ ] Run full test suite and log result.
- [ ] Add or expand unit tests for one module.
- [ ] Update one section of docs from recent memory.
```

The LLM sees this plus recent memory and USER.md/SOUL.md, and returns e.g. `TASK: Run full test suite and log result`.

---

## Stopping Point 1

**What do you want to do?**

1. **Create a new plan** — I'll create or overwrite `.vodou/workspace/autonomous-plan.md` with a template (Vodou working on itself: tests, docs, small refactors). You can edit it after.
2. **Edit the existing plan** — I'll show the current `.vodou/workspace/autonomous-plan.md` (or the file at `VODOU_AUTONOMOUS_PLAN_PATH`) and add/change tasks based on your instructions.
3. **Wire up .env and schedule** — I'll show you the exact `.env` line and schedule commands so the daemon runs autonomous tasks (e.g. every 4h) and uses this plan.
4. **Full overnight setup** — Create/confirm plan, set `VODOU_AUTONOMOUS_PLAN_PATH`, add recurring task, approve autonomous, and remind you to install/start the daemon.

Reply with 1, 2, 3, or 4.
