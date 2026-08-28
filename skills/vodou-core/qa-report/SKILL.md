---
name: qa-report
description: Show the latest VODOU QA scorecard as human-readable markdown in chat — score, per-step table, and failure tails from the real runner output
version: 1.0.0
required_tools: ["execute_script"]
kind: workflow
trigger_phrases:
  - "qa report"
  - "show qa report"
  - "latest qa"
  - "qa scorecard"
  - "qa results"
  - "how did qa do"
stopping_points: none
actions: actions.json
---

# VODOU QA — Latest Scorecard

## Overview
Prints the most recent QA scorecard (`.vodou/qa/latest.md`, rewritten by `scripts/qa/qa.sh` on every run) directly into the chat window. The numbers come from the runner, injected pre-LLM — never from the model.

## Instructions

**⚠️ AUTO-EXECUTE ON LOAD. No greeting, no preamble.**

### Step 1: Fetch the scorecard (AUTO-EXECUTE)

Call `Vodou-script-executor::execute_script` with
`{"server_name":"vodou-qa","script_name":"qa-report","params":{}}`.

### Step 2: Render it verbatim

Display the returned markdown **exactly as returned** — heading, score line, step table, and every failure block with its log path. Do not summarize, re-order, round, or re-word any number. Unescape `\n` into real newlines so the table renders.

### Step 3: Add at most two lines of context

After the scorecard, optionally add up to two lines: how stale it is (compare the stamp to now) and whether tonight's runner (task 50, 03:10) has fired since. Nothing else.

If the script returns empty, say the runner has not produced a scorecard yet and point at `./vodou-core call Vodou-script-executor execute_script '{"server_name":"vodou-qa","script_name":"qa-nightly"}'`. Do not invent results.

<!-- AGENT_ACTIONS: {"initial_steps": [{"server": "Vodou-script-executor", "tool": "execute_script", "args": {"server_name": "vodou-qa", "script_name": "qa-report", "params": {}}}]} -->

## Notes
- Source of truth: `PLANS/0.6.28/VODOU-QA/`
- Scorecard files: `.vodou/qa/latest.md` (human) / `.vodou/qa/latest.json` (machine)
- Findings register for dedupe: `PLANS/0.6.28/VODOU-QA/BREAKAGE-BASELINE.md`
