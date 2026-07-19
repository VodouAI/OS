---
name: deep-thinking
description: Guides AI agents through deep, iterative thinking processes using Enhanced-Thinking MCP server with persistence, quality analysis, and contextual intelligence
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - "deep think"
  - "think deep"
  - "deep research"
  - "deep think about [topic]"
  - "think deep about [topic]"
  - "deep research on [topic]"
  - "analyze deeply"
  - "comprehensive analysis"
stopping_points: required
actions: none
imported_from:
  source: hand-written
metadata:
  vodou:
    preservation_reason: user-preserved 2026-04-25
---

# Vodou Deep Thinking - Persistent Intelligence Analysis

## ⚠️ HARD RULE — NO BATCH DISPATCH ⚠️

**DO NOT plan all `add_thought` calls upfront and submit them as a parallel tool-use batch.** That breaks this skill. The MCP server will reject every call after the first as a duplicate, and the user will see a session of garbage.

**The correct flow per thought is:**
1. Write ONE `add_thought` Bash call. Submit it. STOP.
2. Read the response — especially the `previousThoughts` array and any `suggestions`.
3. Write the NEXT thought *informed by what you just read*. Submit it. STOP.
4. Repeat.

Each thought must be a **single, completed tool call whose response you actually consume** before composing the next thought. If you queue thoughts 1–15 in one tool_use block, you have not understood this skill — re-read this section before continuing.

The server enforces this with three guards: thoughts shorter than 30 chars, thoughts matching the "iteration N of M on:" template, and thoughts duplicating prior ones — all rejected with an error you must read.

## Overview

This skill runs a genuine deep thinking session using the Vodou-Enhanced-Thinking MCP server. The agent generates real analytical thoughts via sequential Bash calls — NOT template loops. Each thought must be original analysis that builds on the previous one.

**Critical rule:** The agent writes every thought. The MCP server stores and tracks them. The agent is not a loop runner — it is the thinker. **One add_thought per response cycle. Read. Then write the next.**

---

## ⏸️ STOPPING POINT 1 — Choose Depth

Before thinking, present the user with depth options:

```
🧠 Deep Thinking Session: [SHORT TOPIC — 5-10 words max, not the full prompt]

How deep should I go?

1. Quick Analysis (5 thoughts) — Key insights, fast
2. Standard Deep Dive (10 thoughts) — Comprehensive
3. Expert Investigation (15 thoughts) — Exhaustive
```

Wait for the user to pick 1, 2, or 3.

---

## Agent Instructions — Execute After User Picks Depth

### Step 1: Start the session

Extract a SHORT topic (5-10 words) from the user's request. Do NOT use the full prompt as the topic. Use a concise description of what you're actually thinking about.

```bash
./vodou-core call Vodou-Enhanced-Thinking start_thinking_session '{"topic": "[SHORT TOPIC]", "estimated_steps": [DEPTH]}'
```

Capture the `session_id` from the response.

Show the user:
```
✨ Session started — ID: [session_id]
🎯 Topic: [SHORT TOPIC]
🔢 Depth: [N] thoughts
```

---

### Step 2: Generate real thoughts — one Bash call per thought

**CRITICAL — ONE CALL PER RESPONSE CYCLE:** You must write the actual thought content yourself for EVERY thought. Do NOT pass the user's prompt as the thought. Do NOT repeat the same text. Each thought must be original analysis that builds on what came before. **Do NOT submit all N add_thought calls in one tool-use batch.** The server WILL reject them and the session will fail.

The pattern is:
1. Submit ONE `add_thought`.
2. The tool returns a response containing `previousThoughts` and `suggestions`.
3. READ THE RESPONSE. Notice what's already been written. Notice what the analyzer suggests.
4. Compose the next thought to *answer or extend* what you just read.
5. Submit that next `add_thought` as a SEPARATE tool call in your next response.

For each thought N, call:

```bash
./vodou-core call Vodou-Enhanced-Thinking add_thought '{"session_id": "[SESSION_ID]", "thought": "[YOUR ACTUAL ANALYTICAL THOUGHT HERE]", "thought_number": N, "total_thoughts": [DEPTH]}'
```

**What to think about at each stage:**

- **Thought 1** — Core problem definition. What is actually being asked? What are the key variables? What failure modes exist?
- **Thought 2** — Current state analysis. What exists today? What works, what doesn't?
- **Thought 3** — Root causes or underlying mechanisms. Why does this happen?
- **Thought 4** — Alternatives and tradeoffs. What other approaches exist? What are the costs?
- **Thought 5** — Non-obvious connections. What does this relate to that isn't obvious?
- **Thought 6** — Second-order effects. If you implement this, what happens downstream?
- **Thought 7** — Assumptions and blind spots. What are you assuming? Where could you be wrong?
- **Thought 8** — Concrete implementation details. How would this actually be built?
- **Thought 9** — Edge cases and failure modes. What breaks this?
- **Thought 10** — Synthesis so far. What's the clearest picture emerging?
- **Thoughts 11-15** — Go deeper on whatever the analysis reveals needs more attention: security, performance, maintainability, user experience, cost, risk.

**After every 3-4 thoughts, run a quality check:**

```bash
./vodou-core call Vodou-Enhanced-Thinking analyze_thinking '{"session_id": "[SESSION_ID]"}'
```

Use the gaps and suggestions returned to adjust your next thoughts.

---

### Step 3: Complete the session

After all thoughts are done:

```bash
./vodou-core call Vodou-Enhanced-Thinking complete_thinking_session '{"session_id": "[SESSION_ID]", "synthesis": "[YOUR COMPREHENSIVE SYNTHESIS — summarize the key findings, the clearest path forward, and any open questions]"}'
```

---

## ⏸️ STOPPING POINT 2 — After Analysis

Present what you found, then ask:

```
Session complete. Quality score: [score]

What's next?

1. Go deeper — 5 more thoughts
2. Done — present final summary
3. Explore a different angle
```

If user picks 1, continue adding thoughts to the same session_id.
If user picks 2, present your full synthesis clearly.

---

## Rules for Good Thoughts

**DO:**
- Build on previous thoughts — reference what you found in thought N-1
- Be specific — name files, functions, systems, real examples
- Disagree with yourself — if a previous assumption looks wrong, say so
- Quantify when possible — "this adds ~50ms latency" beats "this is slower"
- Connect to the user's actual context (their codebase, their platform, their constraints)

**DO NOT:**
- Repeat the user's prompt as a thought
- Write generic filler ("This is an important topic that deserves consideration")
- Run the same thought twice with different wording
- Use template placeholders — write real content

---

## Advanced Options

### Resume a previous session
```bash
./vodou-core call Vodou-Enhanced-Thinking list_thinking_sessions '{"status": "active", "limit": 5}'
# Then continue with add_thought using the existing session_id
```

### Branch to a different perspective
Add a thought with `"branchFromThought": N` to explore an alternative angle without losing the main thread.

### Revise a thought
If quality analysis reveals a flawed assumption in thought N, add a new thought with `"isRevision": true, "revisesThought": N`.

---

## What Makes This Different from a Shallow Run

The Vodou-Enhanced-Thinking server stores thoughts and returns them back with each add_thought call. This means:
- You always have the full history when writing the next thought
- Quality scores improve as you build on previous insights
- Sessions persist — they can be resumed in future conversations
- The `session_id` is the key to everything — capture it and show it to the user

**The garbage output** ("Deep analysis iteration N of 5 on: [full prompt]") happens when the agent passes the user prompt as the topic AND runs thoughts mechanically without writing content. This skill fixes both problems: short topic, real thoughts written by the agent.
