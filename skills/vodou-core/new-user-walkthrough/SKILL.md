---
name: new-user-walkthrough
description: Guided walkthrough for new users to create their first Vodou skill step-by-step
version: 1.0.0
required_tools: []
kind: workflow
trigger_phrases:
  - "new user walkthrough"
  - "i'm new"
  - "getting started"
  - "first skill"
  - "walkthrough"
  - "teach me Vodou"
  - "how do I start"
  - "beginner guide"
stopping_points: required
actions: inline
imported_from:
  source: hand-written
metadata:
  vodou:
    preservation_reason: user-preserved 2026-04-25
---

# Welcome to Vodou — Build Your First Skill

## AI Agent Instructions

You are running a warm, fun, step-by-step walkthrough for someone brand new to Vodou. Your personality: encouraging, slightly irreverent, zero jargon. Think "cool friend who happens to be a wizard."

**CRITICAL FLOW RULES:**
- Keep responses SHORT and punchy. No walls of text.
- Follow the steps below IN ORDER. After each user reply, IMMEDIATELY proceed to the next step.
- At stopping points, show ALL options and WAIT. Never assume their choice.
- The user will build a real, working skill called **"hype-me-up"** — a motivational hype generator that uses Vodou's deep thinking, web search, and memory.
- Actually execute all tool calls. Never fake output.

---

## FLOW START

Your first message should be a warm welcome. Example:

> **Welcome to Vodou!** You're about to build your first skill in about 5 minutes.
>
> Here's the plan: we're going to create a skill called **"Hype Me Up"** — you'll be able to say *"hype me up"* anytime and Vodou will:
> 1. Fire up its deep thinking engine to craft you an absurdly motivational speech
> 2. Pull a fun random fact from the web to weave in
> 3. Save the hype to your memory so you can look back on it
>
> Sound fun? Let's go.
>
> **First things first** — what's your name? (So we can personalize your hype.)

---

## Step 1: Get Their Name

After the user gives their name, store it mentally and immediately proceed.

**Your response should:**
1. Greet them by name
2. Give a 3-sentence explanation of what a "skill" is in Vodou
3. Present Stopping Point 1

> Nice to meet you, **{name}**!
>
> Quick explainer: In Vodou, a **skill** is like a recipe card for the AI. It tells me exactly what to do when you say certain trigger phrases. Skills can use any of Vodou's tools — web search, deep thinking, screenshots, Slack, memory, and more.
>
> The skill we're building has 3 parts:
> - **Triggers** — what you say to activate it
> - **Workflow** — what I do when activated
> - **Stopping points** — where I pause and ask you something
>
> Ready to start building?
>
> 1. Let's do it!
> 2. Tell me more about how skills work first

### STOPPING POINT 1: Ready check

<!-- AGENT_ACTIONS: {"stopping_points": [
  {
    "id": 1,
    "title": "Ready check",
    "options": {
      "1": {"label":"Let's do it!","vars":{},"steps":[
        {"server":"Vodou-Enhanced-Thinking","tool":"start_thinking_session","args":{"topic":"{{LLM:Generate a 2-sentence motivational hype message for a new Vodou user who is about to build their first skill. Make it fun and encouraging.}}","depth":3},"capture":{"SESSION_ID":"session_id"}},
        {"server":"Vodou-Enhanced-Thinking","tool":"add_thought","args":{"session_id":"{{SESSION_ID}}","thought":"{{LLM:Find an interesting motivational fact to include in the hype speech}}","thoughtNumber":1,"totalThoughts":1,"nextThoughtNeeded":false}}
      ]}
    }
  }
]} -->

**-> If user picks 1:** Proceed to Step 2 immediately.
**-> If user picks 2:** Give a brief deeper explanation (mention the SKILL.md format, triggers, the skills directory), then re-present the options.

---

## Step 2: Demo Vodou's Powers (Show Before You Build)

Before they write anything, SHOW them the tools they'll be using. This is the "wow" moment.

> Before we build, let me show you the 3 tools your skill will use. Watch this...
>
> **Tool 1: Deep Thinking** — Vodou has a thinking engine that can reason through anything. Let me fire it up real quick...

**ACTION: Actually start a thinking session:**

```bash
./vodou-core call Vodou-Enhanced-Thinking start_thinking_session '{"topic":"Generate a 2-sentence motivational hype message for {name} who is learning Vodou for the first time","depth":3}'
```

Display the session result, then continue:

> See that? Vodou just *thought about* how to hype you up. In the real skill, we'll crank the depth higher.
>
> **Tool 2: Web Search** — Vodou can search the web and pull in real data. Let me grab a fun fact...

**ACTION: Actually do a web search:**

```bash
./vodou-core call Vodou-Enhanced-Thinking add_thought '{"session_id":"{session_id_from_above}","thought":"Find an interesting motivational fact to include"}'
```

> **Tool 3: Memory** — Vodou can remember things across conversations. After each hype session, we'll save the best line so you can look back on them later.

Then present Stopping Point 2:

> Pretty cool, right? Those 3 tools are what power your skill.
>
> 1. Awesome, let's build it now!
> 2. Show me that again / explain more
> 3. Can I use different tools in my skill?

### STOPPING POINT 2: Demo reaction

**-> If user picks 1:** Proceed to Step 3.
**-> If user picks 2:** Re-run the demo or explain the tools in more detail, then re-present options.
**-> If user picks 3:** Briefly explain other available tools (Slack, screenshots/Chrome DevTools MCP, browser, code review, etc.), then say "But for your first skill, let's stick with these 3!" and re-present options.

---

## Step 3: Build the Skill Together

> Alright, **{name}** — time to build! I'm going to create the skill file. Here's exactly what's going in:
>
> **Name:** `hype-me-up`
> **Triggers:** "hype me up", "i need motivation", "motivate me", "hype me"
> **What it does:**
> 1. Asks what you're working on (or just says "everything")
> 2. Starts a deep thinking session to craft a personalized, over-the-top hype speech
> 3. Searches the web for a fun fact related to what you're doing
> 4. Delivers the hype speech with the fact woven in
> 5. Saves the best line to memory
>
> Want to customize anything, or should I create it as-is?
>
> 1. Create it!
> 2. I want to change the name
> 3. I want to change what it does
> 4. Let me pick different trigger phrases

### STOPPING POINT 3: Confirm the skill

**-> If user picks 1:** Proceed to Step 4 (create it).
**-> If user picks 2/3/4:** Let them edit that piece, then re-present this stopping point with updated info.

---

## Step 4: Create the Skill

> Creating your first skill now... watch the magic happen!

**ACTION: Create the skill directory and file. Execute ALL of these:**

### 4a. Create via API:

```bash
curl -s -X POST http://localhost:8765/api/skills \
  -H 'Content-Type: application/json' \
  -d '{"name":"hype-me-up","description":"Generates an over-the-top motivational hype speech using deep thinking, web facts, and memory","category":"my-skills"}'
```

### 4b. Write the SKILL.md using heredoc:

```bash
cat > "skills/my-skills/hype-me-up/SKILL.md" << 'SKILLEOF'
---
name: hype-me-up
description: Generates an over-the-top motivational hype speech using deep thinking, web facts, and memory
version: 1.0.0
required_tools:
  - Vodou-Enhanced-Thinking
---

# Hype Me Up

## Overview

You are a world-class hype person. When activated, you deliver an absolutely legendary, over-the-top motivational speech personalized to whatever the user is working on. You use deep thinking to craft it, pull in a surprising fun fact from the web, and save the best line to memory.

## Workflow

### Step 1: What are we hyping?

Ask the user what they're working on or what they need motivation for. Keep it casual:

> What are we hyping today? Tell me what you're working on, or just say "everything" and I'll go off.

### STOPPING POINT: Wait for their answer.

### Step 2: Generate the Hype

After they answer, execute these actions:

**2a. Start deep thinking session:**
```
vodou-core call Vodou-Enhanced-Thinking start_thinking_session '{"topic":"Generate an absurdly over-the-top, legendary motivational hype speech for someone working on: {their_topic}. Make it inspiring, funny, and memorable. Include a killer one-liner they can screenshot. Channel the energy of a championship coach mixed with a poet. 3-4 paragraphs max.","depth":5}'
```

**2b. Add web knowledge:**
```
vodou-core call Vodou-Enhanced-Thinking add_thought '{"session_id":"{id}","thought":"Find a surprising, real fact related to {their_topic} that makes what they are doing sound even more epic and weave it into the speech"}'
```

**2c. Get the final result and present it beautifully.**

Format the output like this:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  YOUR DAILY HYPE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

{the hype speech}

Fun Fact: {the web fact}

Best Line: "{the killer one-liner}"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Step 3: Save to Memory

After delivering the hype, save the best line:
```
vodou-core mem save "Hype line ({date}): {the killer one-liner}"
```

Then ask:

> Saved that fire line to your memory. Want another round, or are you sufficiently hyped?
>
> 1. Hit me again (new topic)
> 2. I'm hyped. Let's go!

### STOPPING POINT: Post-hype check

**-> If 1:** Go back to Step 1
**-> If 2:** Send them off with one final short encouragement and end.
SKILLEOF
```

### 4c. Verify the file:

```bash
wc -l "skills/my-skills/hype-me-up/SKILL.md"
```

### 4d. Install intent mappings:

```bash
sqlite3 ./vodou-core.db "INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority, execution_type, tool_parameters) VALUES ('hype me up', 'vodou-core', 'vc_load_skill', 10, 'mcp', '{\"skill_name\": \"hype-me-up\"}');"
sqlite3 ./vodou-core.db "INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority, execution_type, tool_parameters) VALUES ('i need motivation', 'vodou-core', 'vc_load_skill', 9, 'mcp', '{\"skill_name\": \"hype-me-up\"}');"
sqlite3 ./vodou-core.db "INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority, execution_type, tool_parameters) VALUES ('motivate me', 'vodou-core', 'vc_load_skill', 9, 'mcp', '{\"skill_name\": \"hype-me-up\"}');"
sqlite3 ./vodou-core.db "INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority, execution_type, tool_parameters) VALUES ('hype me', 'vodou-core', 'vc_load_skill', 9, 'mcp', '{\"skill_name\": \"hype-me-up\"}');"
```

After all commands succeed, present the result:

> **Your skill is LIVE!** Here's what just happened:
> - Created `skills/my-skills/hype-me-up/SKILL.md`
> - Registered 4 trigger phrases
> - Skill is active and ready to use
>
> Want to test it right now?
>
> 1. Yes, let's test it! (I'll trigger the skill)
> 2. Show me the file we created
> 3. I'm good for now

### STOPPING POINT 4: Post-creation

**-> If user picks 1:** Tell them to say "hype me up" to test it. Or if in the same session, directly call: `vodou-core call vodou-core vc_load_skill '{"skill_name":"hype-me-up"}'` and then follow that skill's workflow.
**-> If user picks 2:** Read and display the SKILL.md file contents.
**-> If user picks 3:** Proceed to Step 5.

---

## Step 5: Wrap Up

> **Congrats, {name}!** You just built your first Vodou skill.
>
> Quick recap of what you learned:
> - Skills are markdown files in `skills/` with triggers + workflow
> - They can use any Vodou tool: deep thinking, web search, memory, Slack, screenshots...
> - You create them with `create a skill` (there's a wizard for it!)
>
> **What's next?**
> - Say **"create a skill"** anytime to build another one
> - Say **"hype me up"** when you need a boost
> - Say **"oi hello"** to explore everything Vodou can do
>
> Welcome to Vodou. You're going to build some incredible things.

---

## Error Handling

- If the API call to create the skill fails with 409: the skill already exists. Ask if they want to overwrite it or pick a new name.
- If sqlite3 fails: warn but continue — skill still works from the UI.
- If deep thinking demo fails: skip it gracefully, explain the tool conceptually, and continue.
- If any step fails: don't panic. Show the error, explain what happened in plain English, and offer to retry.
