---
name: daily-research-brief
description: workflow template — researcher gathers sources, writer synthesizes into a 400-word brief; pre-installed, activates in Phase 2
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - "apply daily-research-brief template"
  - "/board apply-template daily-research-brief"
stopping_points: none
actions: inline
metadata:
  vodou:
    persona_role: research brief pipeline
    template_kind: research_synthesis
    phase_active: 2
---

# daily-research-brief

A 2-stage pipeline for "give me a researched take on X by tomorrow morning." Researcher pulls sources, writer synthesizes. Ships as a single markdown file the user can paste into Slack/Telegram/their docs.

**Phase 1 status:** pre-installed but inactive (template_kind loader is Phase 2 work).

## Stages

### Stage 1 — Research

<!-- AGENT_ACTIONS_1: {
  "step_key": "research",
  "assignee_default": "researcher",
  "skills": ["board-worker", "web-research", "memory-search"],
  "workspace": "scratch",
  "required_artifacts": {
    "metadata.sources_count": "[5-9]|[1-9][0-9]+",
    "metadata.findings_doc_path": "\\.md$"
  },
  "on_success": "synthesize",
  "on_failure": "research",
  "max_runtime_seconds": 2400,
  "max_retries": 1,
  "budget_usd_cap": 3.00
} -->

Researcher gathers ≥5 sources (web + memory), writes them up in a findings markdown file with sentiment + relevance scoring. The dispatcher validates source count + file path before advancing.

### Stage 2 — Synthesize

<!-- AGENT_ACTIONS_2: {
  "step_key": "synthesize",
  "assignee_default": "writer",
  "skills": ["board-worker", "brief-writer"],
  "workspace": "scratch",
  "required_artifacts": {
    "metadata.brief_path": "\\.md$",
    "metadata.word_count": "(3[5-9][0-9]|4[0-9][0-9]|5[0-9][0-9])"
  },
  "on_success": null,
  "on_failure": "synthesize",
  "max_runtime_seconds": 1200,
  "max_retries": 1,
  "budget_usd_cap": 1.50
} -->

Writer reads the researcher's findings doc + writes a 350-599 word brief (regex enforces the band). Output: a markdown file. Pipeline complete.

## Total budget cap (recommendation)

~$4.50 per brief. Cheap by design — the goal is "I can run this 5x/week without thinking about cost."

## When to use this template vs not

✓ **Use it when** you want a researched take on a single topic, ≤500 words, by tomorrow.

✗ **Skip it when**:
- You need ≥1000 words → split into multiple research-brief runs + a synthesis task
- You need code or numerical analysis → use `ship-a-feature` or create a custom pipeline
- You need real-time updates → this is for end-of-day briefs, not live monitoring
