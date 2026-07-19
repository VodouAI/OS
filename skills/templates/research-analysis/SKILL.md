---
name: research-analysis-template
description: Deep research and analysis on any topic using multi-step thinking
version: 1.0.0
required_tools: ["Vodou-Enhanced-Thinking"]
kind: workflow
trigger_phrases:
  - "research {{TOPIC}}"
  - "analyze {{TOPIC}}"
  - "deep dive {{TOPIC}}"
stopping_points: required
actions: actions.json
imported_from:
  source: hand-written
---

# Research & Analysis Template

## Overview

Multi-step deep research on any topic. Uses the Enhanced Thinking engine for structured analysis with configurable depth.

## Stopping Point 1: Choose Analysis Depth

1. **Quick Analysis** (3 thinking steps) — fast overview
2. **Standard Analysis** (7 thinking steps) — balanced depth
3. **Deep Research** (15 thinking steps) — comprehensive investigation

<!-- AGENT_ACTIONS: {"stopping_points":[{"id":1,"title":"Choose Analysis Depth","options":{"1":{"label":"Quick Analysis","vars":{"DEPTH":"3"},"steps":[
  {"server":"Vodou-Enhanced-Thinking","tool":"start_thinking_session","args":{"topic":"{{TOPIC}}","depth":"{{DEPTH}}"},"capture":{"SESSION_ID":"session_id"}},
  {"server":"Vodou-Enhanced-Thinking","tool":"add_thought","args":{"session_id":"{{SESSION_ID}}","thought":"Analyze key aspects of {{TOPIC}}","nextThoughtNeeded":false}}
]},"2":{"label":"Standard Analysis","vars":{"DEPTH":"7"},"steps":[
  {"server":"Vodou-Enhanced-Thinking","tool":"start_thinking_session","args":{"topic":"{{TOPIC}}","depth":"{{DEPTH}}"},"capture":{"SESSION_ID":"session_id"}},
  {"server":"Vodou-Enhanced-Thinking","tool":"add_thought","args":{"session_id":"{{SESSION_ID}}","thought":"Continue analysis of {{TOPIC}} — explore implications, tradeoffs, and recommendations"},"loop":5,"stream_progress":true},
  {"server":"Vodou-Enhanced-Thinking","tool":"add_thought","args":{"session_id":"{{SESSION_ID}}","thought":"Synthesize findings into actionable conclusions","nextThoughtNeeded":false}}
]},"3":{"label":"Deep Research","vars":{"DEPTH":"15"},"steps":[
  {"server":"Vodou-Enhanced-Thinking","tool":"start_thinking_session","args":{"topic":"{{TOPIC}}","depth":"{{DEPTH}}"},"capture":{"SESSION_ID":"session_id"}},
  {"server":"Vodou-Enhanced-Thinking","tool":"add_thought","args":{"session_id":"{{SESSION_ID}}","thought":"Continue deep analysis of {{TOPIC}}"},"loop":13,"stream_progress":true},
  {"server":"Vodou-Enhanced-Thinking","tool":"add_thought","args":{"session_id":"{{SESSION_ID}}","thought":"Final synthesis — key findings, recommendations, and next steps","nextThoughtNeeded":false}}
]}}}]} -->

## Output Format

Present findings as:
- Executive summary (2-3 sentences)
- Key findings (bulleted)
- Recommendations (numbered)
- Next steps
