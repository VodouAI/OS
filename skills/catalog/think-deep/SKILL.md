---
name: think-deep
description: Run a multi-step thinking session on a topic via Vodou-Enhanced-Thinking — quick, thorough, or deep audit
version: 1.0.0
kind: workflow
required_tools: [Vodou-Enhanced-Thinking.start_thinking_session, Vodou-Enhanced-Thinking.add_thought, Vodou-Enhanced-Thinking.complete_thinking_session]
trigger_phrases:
  - think deeply about
  - deep dive into
  - thinking session
  - analyze in depth
  - reason through
stopping_points: required
actions: actions.json
imported_from: {source: catalog}
metadata:
  vodou:
    category: reasoning
---
# think-deep

Spin up a structured thinking session via `Vodou-Enhanced-Thinking`. Each option chooses how many iterative thoughts to generate before synthesizing.

## Stopping Point 1 — Depth

1. **Quick (3 thoughts)** — fast scan, no detours
2. **Thorough (8 thoughts)** — explore edges + edge cases, with intermediate stream
3. **Deep audit (15 thoughts)** — exhaustive analysis with severity ratings + remediation

The user's topic is templated as `{{TOPIC}}` — the agent should pull it from the question that triggered the skill.

## After the steps run

Synthesize the captured thoughts into a tight bullet summary. Lead with the strongest finding; flag anything risky inline.
