---
name: hello-world
description: Step-by-step walk-through to get comfortable using Vodou - handholding guide from first command through creating skills, MCP, scripts, and deep Vodou usage
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - "hello world"
  - "oi hello world"
  - "vodou hello world"
  - "walk through"
  - "oi walkthrough"
  - "vodou walkthrough"
  - "walk me through oi"
  - "get started with oi"
  - "first steps oi"
  - "oi first steps"
  - "vodou first steps"
  - "--"
stopping_points: required
actions: none
imported_from:
  source: hand-written
---

# Vodou Hello World - Your Guided Walk-Through

## About
This skill is the onboarding walk-through for Vodou: choose a path (short walk-through, create a skill, connect MCP, scripts, install MCP, or deep dive) and follow step-by-step. Skills control your bot; the bot runs and connects to a whole backend of MCP servers.

## Stopping points (in order)
0. **Identity ritual (first run)** — If `.vodou/workspace/BOOTSTRAP.md` exists, run it first (read file, present to user, guide through name/nature/vibe/emoji and IDENTITY.md, USER.md, SOUL.md). When done or skipped, continue to step 1.
1. Choose your path (1–6)
2. [Path-specific] – e.g. Path 2: Give it a name → [auto] → Your skill just loaded (Step D) → optionally Step E (add one MCP tool, or skip)

## ⚠️ **CRITICAL: AI Agent Instructions**

**This skill is a handholding walk-through for new Vodou users. You MUST:**

0. **Run BOOTSTRAP first (if present)** — Before showing "You just ran a skill", check for `.vodou/workspace/BOOTSTRAP.md`. If it exists, read it and guide the identity ritual. When the user is done: delete `.vodou/workspace/BOOTSTRAP.md`, then run `./do "hello world"` again and present that output (the main skill + Choose your path). If the user says skip or the file is missing, go to step 1.
1. **Load this skill** when users say: "hello world", "oi walkthrough", "get started with oi", "walk me through oi", "oi hello world"
2. **Always show the full intro ("You just ran a skill")** — After BOOTSTRAP (if any), show the intro verbatim. Do not summarize or skip it. Then show the first question (Choose your path).
3. **Present the first question (Choose your path)** with the full numbered menu (1–6). Do not summarize; show every option.
4. **When the user picks an option**, follow the corresponding path: use the section in this file and/or the referenced file in `references/`; at each question, present the title of what it is, explain, then show the options.
5. **Reference supporting documents** in `references/` and `assets/` for full step-by-step flows.
6. **Never skip questions** – wait for user choice before proceeding.
7. **Vodou commands run in this chat** – When you tell the user to run an Vodou command, say to run it in this chat (e.g. "In this chat, type oi ...").
8. **Number every option** – At each question, show a title (what it is), then each option with a number (1, 2, 3...) so the user can reply with that number (e.g. "Reply with 1, 2, or 3"). Never present unnumbered choice lists.
9. **When a path or skill uses an MCP tool** – Run direct Vodou/brain-trust commands for that MCP server (e.g. `./do "cpu"` or `./vodou-core call mcp-monitor get_cpu_info`) and present the tool output to the user. Do not only tell the user to type the phrase; the agent invokes the MCP tool via Vodou and shows the result.
10. **Never summarize the skill output when this skill loads** – Present BOOTSTRAP (if present), then the full intro and the first question (Choose your path) with all options. If you summarize, the user will not see the welcome message.
11. **Always explain what’s going on in detail, then show the options** – At every question: (1) Give the title (what this is). (2) Explain in detail what is happening, what the user is choosing, and why it matters. (3) Present the full numbered options. Never show only a menu without context; never skip the explanation. The user should always understand where they are and what each choice does before replying.
12. **Skills must state what they're about and list stopping-point order** – When any skill loads, show its **About** (what the skill is about) first. Then follow **Stopping points (in order)**: first Step 0 (BOOTSTRAP if present), then the rest of the skill.

---

## How this skill loads (for agents and maintainers)

- **This skill file is markdown only.** No scripts or code are stored inside the skill. Any tooling (e.g. scripts that edit the file) runs externally and only updates the file content; the skill itself is just this markdown.
- **When the welcome message appears:** When the user (or you) runs `./do "hello world"` from the **project root** (the directory that contains `oi`, `vodou-core`, and `skills/`), Vodou loads this skill from disk. The full intro ("You just ran a skill") is in the Vodou output. Show it verbatim to the user.
- **If the user says they don't see the welcome message:** (1) They may be running a different `oi` (e.g. in PATH or another install) that uses a different skills path or binary. (2) The agent may be summarizing the Vodou output — you must show the full intro every time, not summarize.
- **What to do:** Run from project root: `cd /path/to/project && ./do "hello world"`. When you (the agent) run Vodou for the user, present the full skill output including the intro block and the first question (Choose your path) with all options.

---

## Step 0: Identity ritual (run first if BOOTSTRAP exists)

**Agent:** Before showing "You just ran a skill" or the Choose your path menu, do this:

1. **Check for** `.vodou/workspace/BOOTSTRAP.md` (path relative to the Vodou project root — the directory that contains `oi`, `vodou-core`, and `.vodou/`).
2. **If the file exists:** Read it and present its contents to the user. Guide them through the identity ritual: have the conversation (name, nature, vibe, emoji), then help them update IDENTITY.md, USER.md, and SOUL.md.
3. **When the user is done with the ritual:** (a) Delete the file `.vodou/workspace/BOOTSTRAP.md`. (b) Run `./do "hello world"` again (from the Vodou project root) and present the full output — that will load this skill without BOOTSTRAP and show "You just ran a skill" and the Choose your path menu.
4. **If the user says "skip" or "continue"** or the file does not exist, skip to the section below: **"You just ran a skill"** and continue with the rest of this skill.

You are here: hello-world → Step 0 (Identity ritual)  
[Continue to Choose your path] | [Skip]

---

## 🎉 You just ran a skill

You typed a phrase. Vodou loaded **this** — a skill. No config file, no API key. Just words. That's the point.

**Think of skills as making you the AI.** Or better: **our bot.** You control it with skills. That bot can run commands, fire scripts, and connect to a whole backend of possible MCP servers. Skills are the control layer — they decide *what* runs and *when*. You're about to learn how to build skills that steer your bot: daily tasks, MCP tools, scripts. Let's go.

**Under the hood:** Your phrase hit the intent table → matched **hello-world** → Vodou loaded this file. Same system runs tools in parallel and scripts in the background. You say what you want; Vodou figures out the rest. Welcome in.
---

## **Choose your path**

**What do you want to do first?**

**Agent:** Show the user only the "Display to user" block below. At every question in every path, show You are here breadcrumb and [Continue] | [Back] (or [Back] only when there is no Continue). Same formatting as my-first-skill.

<!-- Agent only: 1 → Path 1. 2 → create-a-skill.md. 3 → Path 3 sub-menu then connect-skill-to-mcp.md or example-my-first-skill.md. 4 → scripts-and-background-jobs.md. 5 → install-mcp-server.md. 6 → deep-dive-oi.md. -->

**Display to user:**

**Vodou Hello World** — You just ran a skill. Skills are how you control your bot; that bot runs and connects to a whole backend of MCP servers. Pick a path below to create skills, wire MCP, run scripts, and decide what runs when.

**What you're choosing:** Which path to take next (short walk-through, create a skill, connect to MCP, scripts, install MCP, or full deep dive).

1. **Next** – Continue the short walk-through (parallel execution, main help, one real task).
2. **Create a skill and connect one MCP tool** – ~5–10 min: create an Vodou skill, add one real tool to it, and see it run. Step-by-step in `references/create-a-skill.md` (includes Step E: add one tool with a stopping point; you can skip Step E).
3. **Connect a skill to an MCP server** – After you have a skill, wire it so your skill can use an MCP server’s tools (or understand how skills and MCP work together).
4. **Create a script or background job** – Register and run a script with Vodou; use background jobs and job IDs.
5. **Install an MCP server** – Add a new MCP server to Vodou and use it via `./do ...` in this chat.
6. **Deep dive: full Vodou walk-through** – Do all of the above in order with every step and question spelled out.

**Reply with the number (1–6).**

**Where each path goes:** 2 → `references/create-a-skill.md` · 3 → `references/connect-skill-to-mcp.md` (or full example: `references/example-my-first-skill.md`) · 4 → `references/scripts-and-background-jobs.md` · 5 → `references/install-mcp-server.md` · 6 → `references/deep-dive-oi.md`.

You are here: hello-world → Choose your path  
[Back]

---

## Path 1: Next (Short Walk-Through)

If the user chose **1 – Next**, present these steps one at a time. At each step: explain in detail what’s happening and what the user will do, then show the question (title + options).

### Step 1a – Parallel execution

**In this chat**, have the user type:

```
./do cpu memory disk
```

The agent runs it here. One phrase runs multiple MCP tools in parallel (Layer 2).

**What next?** Reply with a number:
1. **next** – Continue to Step 1b (main Vodou help)
2. **repeat** – Show Step 1a again
3. **back** – Return to Choose your path

You are here: hello-world → Path 1 → Step 1a  
[Continue] | [Back]

### Step 1b – Main Vodou help

**In this chat**, have the user type:

```
./do hello
```

That loads the main help skill (hello).

**What next?** Reply with a number:
1. **next** – Continue to Step 1c (one real task)
2. **repeat** – Show Step 1b again
3. **back** – Return to Choose your path

You are here: hello-world → Path 1 → Step 1b  
[Continue] | [Back]

### Step 1c – One real task

**In this chat**, offer: `./do cpu memory disk network`, `./do list`, `./do run script`, or another concrete task.

**What next?** Reply with a number:
1. **done** – I'm good for now / end walk-through
2. **more** – Give me more example commands
3. **back** – Return to Choose your path

You are here: hello-world → Path 1 → Step 1c  
[Continue] | [Back]

---

## Path 2: Create a skill and connect one MCP tool

When the user chooses **2**, follow the full flow in **`references/create-a-skill.md`**. At each step: explain in detail what’s happening and what the user is choosing, then show the options.

- **~5–10 min:** Create a skill, add one real tool to it, and see it run.
- After Step A (name): auto-apply suggested intents in SKILL.md (no Step B menu), create install script, run it, run oi with their phrase so they see their skill load, then **Step D**.
- After Step D, the file introduces **Step E** (add one MCP tool with a stopping point). Present E0 then E0b; if user says skip, stay at the Step D menu. Otherwise do E1→E2→E3→E4 (pick tool, wire phrase, add menu option, run and show result). At E4, **run the Vodou command** and show the tool output.
- Present it section by section.
- Pause at every **question** in that file and wait for the user’s choice before continuing.
- Do not skip steps or questions.
- **Example outcome:** The full built-out example is **my-first-skill** (six mcp-monitor tools, summaries, "What's next"). Hand-holding to build or run it: **`references/example-my-first-skill.md`**.

---

## Path 3: Connect a Skill to an MCP Server

When the user chooses **3**, explain in detail what “connecting a skill to MCP” means (the skill stays the guide; MCP tools do the work; we wire phrases to tools). Then present this question:

**Connect a skill to MCP** — What do you want to do?

**What you're choosing:** Connect an existing skill (guide) or build/run the full example (my-first-skill).

1. **Connect my existing skill** – Follow **`references/connect-skill-to-mcp.md`** (section by section; at each question, show the title and options).
2. **Build or run the full example (my-first-skill)** – Follow **`references/example-my-first-skill.md`** (menu of six mcp-monitor tools; hand-holding to build from scratch or run as-is).

Reply with 1 or 2. Then follow the chosen reference; at each question, present the title (what it is), explain, then show the options.

You are here: hello-world → Path 3 → Connect a skill to MCP  
[Continue] | [Back]

---

## Path 4: Create a Script or Background Job

When the user chooses **4**, follow **`references/scripts-and-background-jobs.md`**. At each step: explain in detail what’s happening (scripts, job IDs, status), then show the options.

- Walk through registration, running a script, and checking status/cancel.
- Honor every question in that file.

---

## Path 5: Install an MCP Server

When the user chooses **5**, follow **`references/install-mcp-server.md`**. At each step: explain in detail what’s happening (adding a server, intents, phrases), then show the options.

- Guide them through adding a server and using it via intents/phrases.
- Use all questions in the reference.

---

## Path 6: Deep Dive – Full Vodou Walk-Through

When the user chooses **6**, follow **`references/deep-dive-oi.md`**. At each step: explain in detail where they are in the flow and what they’re doing, then show the options.

- That file runs through: first command → intents → create a skill → connect skill to MCP → scripts/background jobs → install MCP server.
- Proceed in order and stop at every question so the user can perform each step in Vodou.

---

## Quick Reference

| You want to…              | Command / Action                    |
|---------------------------|--------------------------------------|
| Start this walk-through   | `./do hello world`                    |
| Continue short path       | Choose option 1 at Choose your path  |
| Create a skill and connect one MCP tool | Choose option 2 → `references/create-a-skill.md` (create skill, then Step E: add one MCP tool and showcase stopping point; can skip Step E) |
| Connect skill to MCP      | Choose option 3 → use `references/connect-skill-to-mcp.md` |
| Scripts & background jobs | Choose option 4 → use `references/scripts-and-background-jobs.md` |
| Install MCP server        | Choose option 5 → use `references/install-mcp-server.md` |
| Full deep dive            | Choose option 6 → use `references/deep-dive-oi.md` |
| Example: my-first-skill| `references/example-my-first-skill.md` — build or run the full example skill |
| Main Vodou help              | `./do hello`                          |
