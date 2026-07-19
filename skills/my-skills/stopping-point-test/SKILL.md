---
name: stopping-point-test
description: A test skill with 5 stopping points to validate the Vodou skill system handles sequential user interactions correctly
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - "stopping point test"
  - "test stopping points"
  - "run stopping point test"
  - "skill system test"
stopping_points: required
actions: actions.json
imported_from:
  source: hand-written
---

# Vodou Stopping Point Test

## About

A diagnostic skill that walks through 5 sequential stopping points. Each stopping point presents a numbered menu and waits for user input before proceeding. Used to verify the skill engine handles multi-step interactive flows correctly.

## Stopping points (in order)

1. **Welcome Gate** — Confirm the user wants to start the test
2. **Color Check** — User picks a color to verify menu selection works
3. **Echo Back** — Confirm the selection was captured, ask for a number
4. **Computation Gate** — Do something with the number, present results
5. **Wrap-Up** — Summary and exit

## Instructions

Present this on load:

**Vodou Stopping Point Test v1.0**

This skill tests that the stopping point system works correctly. We'll walk through 5 checkpoints. At each one, you pick an option and I move to the next.

**Ready?**

1. **Start the test** — Let's go
2. **Skip to point 3** — Jump ahead to test mid-entry
3. **Abort** — Nevermind, exit the skill

<!-- AGENT_ACTIONS: {"stopping_points": [
  {
    "id": 1,
    "title": "Welcome Gate",
    "options": {
      "1": {"label":"Start the test","vars":{"COLOR":"pending","NUMBER":"pending"},"steps":[]},
      "2": {"label":"Skip to point 3","vars":{"COLOR":"blue","NUMBER":"pending"},"steps":[],"goto":3},
      "3": {"label":"Abort","vars":{},"steps":[]}
    }
  },
  {
    "id": 2,
    "title": "Color Check — Pick a color",
    "options": {
      "1": {"label":"Red","vars":{"COLOR":"Red"},"steps":[]},
      "2": {"label":"Green","vars":{"COLOR":"Green"},"steps":[]},
      "3": {"label":"Blue","vars":{"COLOR":"Blue"},"steps":[]},
      "4": {"label":"Gold","vars":{"COLOR":"Gold"},"steps":[]},
      "5": {"label":"Surprise me","vars":{"COLOR":"Purple"},"steps":[]}
    }
  },
  {
    "id": 3,
    "title": "Echo Back — You picked {{COLOR}}. Now pick a number",
    "options": {
      "1": {"label":"Pick for me — 42","vars":{"NUMBER":"42"},"steps":[]},
      "2": {"label":"Lucky 7","vars":{"NUMBER":"7"},"steps":[]},
      "3": {"label":"Go big — 99","vars":{"NUMBER":"99"},"steps":[]},
      "4": {"label":"69 — nice","vars":{"NUMBER":"69"},"steps":[]}
    }
  },
  {
    "id": 4,
    "title": "Computation Gate — Color {{COLOR}} + Number {{NUMBER}}",
    "options": {
      "1": {"label":"Generate my color-number reading","vars":{},"steps":[
        {"server":"Vodou-Enhanced-Thinking","tool":"start_thinking_session","args":{"topic":"{{LLM:The user picked color {{COLOR}} and number {{NUMBER}}. Generate a fun one-paragraph personality reading based on this combination — like a horoscope but based on color+number. Keep it lighthearted and under 100 words.}}","depth":3},"capture":{"SESSION_ID":"session_id"}}
      ]},
      "2": {"label":"Skip computation — just move on","vars":{},"steps":[]}
    }
  },
  {
    "id": 5,
    "title": "Test Complete — All 5 stopping points passed",
    "options": {
      "1": {"label":"Run it again","vars":{},"steps":[]},
      "2": {"label":"Done","vars":{},"steps":[]},
      "3": {"label":"Report a bug","vars":{},"steps":[]}
    }
  }
]} -->

## After the AGENT_ACTIONS complete:

The LLM should format the results nicely. For checkpoint 5, present a summary table:

| Checkpoint | What was tested | Result |
|-----------|----------------|--------|
| 1. Welcome Gate | Skill loaded, menu displayed | PASS |
| 2. Color Check | Multi-option menu, selection stored | PASS (chose {{COLOR}}) |
| 3. Echo Back | Variable carried between points | PASS (chose {{NUMBER}}) |
| 4. Computation Gate | MCP tool call (Enhanced Thinking) | PASS |
| 5. Wrap-Up | Summary rendered, all variables intact | PASS |

## Notes
- This is a diagnostic/test skill — not meant for production use
- Each stopping point MUST pause and wait for user input — the engine enforces this
- Variables (COLOR, NUMBER) persist across stopping points via the workflow engine
- The MCP call at Stopping Point 4 validates that skills can invoke tools mid-flow
- Steps with empty `"steps":[]` just capture the user's choice and advance to the next phase
