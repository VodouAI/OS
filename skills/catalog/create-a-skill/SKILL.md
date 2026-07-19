---
name: create-a-skill
description: Guided wizard that builds a custom Vodou skill from your description — picks a type, names it, writes SKILL.md + actions.json, registers triggers
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - create a skill
  - new skill
  - make a skill
  - skill wizard
  - build me a skill
  - create skill
stopping_points: required
actions: actions.json
imported_from: {source: catalog}
metadata:
  vodou:
    category: meta
    surfaces:
      main_chat: full
      skill_panel: partial
    surface_notes: "Skill panel handles menu choices but text-input stopping points require the main gateway chat (workflow-driver supports text_input capture)."
---
# create-a-skill

A guided wizard for building your own Vodou skill. Five quick questions, one new skill on disk + registered triggers + LLM-generated SKILL.md tailored to your description.

## How it works

1. **Describe** what your skill should do (free text)
2. **Pick a type:** plain workflow / system monitor / deep thinking / browser tools / custom
3. **Name it** (dashes only, e.g. `daily-health-check`)
4. **Confirm** → wizard:
   - Calls `_gateway::create_skill` with your inputs
   - LLM generates a SKILL.md tailored to your description (with fallback template)
   - LLM generates 3 trigger phrases for it
   - Writes the skill to `skills/my-skills/<name>/`
   - Inserts intent_mappings rows so the triggers route to the new skill
5. **Done** — say one of the trigger phrases to try it

## Where this works best

- **Main gateway chat (`localhost:8765`):** full wizard — text-input questions render and capture correctly via the workflow-driver
- **Skill panel:** menu options work; text-input questions (description, name) currently route through the LLM and won't reliably capture. Use main chat for the full wizard until skill-panel text-input support lands.

## After it runs

The new skill lands in `skills/my-skills/<name>/SKILL.md` + `actions.json`. You can:
- Edit the generated content directly
- Pull it back via `bt4 skill show <name>`
- Publish it to a private/personal catalog later

## Tip

Be specific in step 1 — "monitor my system every morning at 9am" produces better menu options than "check stuff".
