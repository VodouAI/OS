---
name: chuck-norris
description: Uses LLM to generate fresh Chuck Norris jokes on demand with option to keep the laughs rolling
version: 1.3.0
required_tools: []
kind: workflow
trigger_phrases:
  - "chuck norris joke"
  - "tell me a chuck norris joke"
  - "chuck norris"
stopping_points: required
actions: actions.json
imported_from:
  source: hand-written
---

# Chuck Norris Joke Generator

## Overview
This skill generates 5 fresh, original Chuck Norris jokes every time. No repeats, no canned material — pure AI-generated roundhouse kicks to your funny bone.

## Instructions

**⚠️ AUTO-EXECUTE ON LOAD: Generate the jokes IMMEDIATELY. Do NOT greet the user, do NOT explain what you're about to do.**

### Step 1: Generate 5 Chuck Norris Jokes (AUTO-EXECUTE)

Generate 5 original, hilarious Chuck Norris jokes. Mix classic Chuck Norris fact format with creative new angles. Number them 1-5. Just the jokes, no intro or outro.

### Step 2: Present the Jokes

Format like this:

```
🥋 CHUCK NORRIS JOKE GENERATOR 🥋
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[The 5 jokes from Step 1]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Step 3: Show the stopping point menu and STOP.

## Want More?

1. Hit me with 5 more
2. That's enough destruction for now

<!-- AGENT_ACTIONS: {"initial_steps": [{"server": "Vodou-LLM-router", "tool": "chat", "args": {"message": "Generate 5 original, hilarious Chuck Norris jokes. Mix classic Chuck Norris fact format with creative new angles. Number them 1-5. Just the jokes, no intro or outro."}}], "stopping_points": [{"id": 1, "title": "Want More?", "options": {"1": {"label": "Hit me with 5 more", "vars": {}, "steps": [{"server": "Vodou-LLM-router", "tool": "chat", "args": {"message": "Generate 5 MORE original, hilarious Chuck Norris jokes. Different from typical ones — be creative and surprising. Mix classic Chuck Norris fact format with fresh angles. Number them 1-5. Just the jokes, no intro or outro."}}]}, "2": {"label": "That's enough destruction for now", "vars": {}, "steps": []}}}]} -->

## Notes
- Every batch of jokes should be unique — never repeat
- Tone: absurd, confident, legendary
- The LLM MUST generate jokes fresh — never use canned/hardcoded jokes
