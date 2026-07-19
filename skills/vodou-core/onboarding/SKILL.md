---
name: onboarding
description: Conversational onboarding — personalize Vodou by setting up your name, timezone, communication style, and AI identity preferences
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - "setup"
  - "setup oi"
  - "personalize"
  - "personalize oi"
  - "setup memory"
  - "who am i"
  - "configure oi"
  - "--"
stopping_points: required
actions: none
imported_from:
  source: hand-written
---

# Vodou Setup — Conversational Onboarding

## AI Agent Instructions

**This skill runs a conversational setup flow inside any LLM chat session (Claude Code, Cursor, etc.) where terminal `read -p` prompts don't work.**

When this skill loads, guide a natural, friendly conversation to collect the user's preferences and write them to the workspace files. Follow the stopping points exactly — never skip ahead or assume answers.

---

## Flow

### Greeting

Start with something warm and brief:

> Hey! Let's get Vodou set up for you. I'll ask a few quick questions so Vodou can remember who you are and how you like to work.

Then present what will be collected:

---

## STOPPING POINT 1: What We'll Set Up

Here's what we can personalize:

1. **Your name** and what Vodou should call you
2. **Your timezone** (I'll try to detect it automatically)
3. **Communication style** — how you want Vodou to talk to you
4. **What you're working on** — any context about your current projects
5. **AI personality** (optional) — customize Vodou's name, vibe, and emoji

**Choose:**
1. **Let's go** — walk me through all of them
2. **Quick setup** — just name, timezone, and style (skip the rest)
3. **Skip for now** — I'll do this later

**Wait for the user's choice before proceeding.**

---

### If user chooses 1 (Let's go) or 2 (Quick setup):

Ask these questions **one at a time**, waiting for each answer:

#### Question 1: Name
> What's your name?

Follow up:
> And what should Vodou call you? (First name, nickname, handle — whatever feels right)

If they give the same answer for both, that's fine — just use it.

#### Question 2: Timezone
Try to detect their timezone first by checking the system:
```bash
python3 -c "import time; print(time.tzname[0])" 2>/dev/null
```

Then ask:
> I detected your timezone as **[detected_tz]**. Sound right, or would you prefer something else?

If detection fails:
> What timezone are you in? (e.g., EST, PST, UTC, CET)

#### Question 3: Communication Style
> How do you like your AI to communicate? Pick a style:
>
> 1. **Casual and direct** — skip the fluff, get to the point
> 2. **Professional and thorough** — detailed, structured responses
> 3. **Minimal — just the facts** — as brief as possible
> 4. **Friendly and encouraging** — warm, supportive tone

#### Question 4: Context (only if "Let's go")
> What are you working on right now? Any projects, languages, or tools I should know about?

(Accept any freeform answer. If they say "nothing specific" or skip, that's fine.)

#### Question 5: AI Personality (only if "Let's go")
> Want to customize how Vodou presents itself? You can change:
> - **Name** (default: Vodou)
> - **Vibe** (default: matches your communication style)
> - **Emoji** (default: lightning bolt)
>
> Or just say "defaults are fine" to keep the standard identity.

---

## STOPPING POINT 2: Confirm Before Writing

After collecting all answers, present a summary:

> Here's what I've got:
>
> **About You:**
> - Name: [name]
> - Call you: [call_name]
> - Timezone: [timezone]
> - Style: [communication_style]
> - Context: [project_context or "none yet"]
>
> **Vodou Identity:**
> - Name: [ai_name or "Vodou"]
> - Vibe: [vibe]
> - Emoji: [emoji or "lightning bolt"]
>
> I'll write this to your workspace files (USER.md, IDENTITY.md, MEMORY.md).
>
> **Choose:**
> 1. **Looks good — save it**
> 2. **Let me change something** (tell me what to fix)
> 3. **Cancel** — don't save anything

**Wait for the user's approval before writing any files.**

---

## File Write Instructions

When the user approves (choice 1 at Stopping Point 2), update these files:

### `.vodou/workspace/USER.md`

Replace the entire file with:

```markdown
# USER.md - About Your Human

_Learn about the person you're helping. Update this as you go._

- **Name:** [name]
- **What to call them:** [call_name]
- **Pronouns:** _(optional)_
- **Timezone:** [timezone]
- **Notes:**

## Context

[project_context if provided, otherwise: "_(What do they care about? What projects are they working on? Build this over time.)_"]
```

### `.vodou/workspace/IDENTITY.md`

Replace the entire file with:

```markdown
# IDENTITY.md - Who Am I?

- **Name:** [ai_name or "Vodou"]
- **Creature:** Universal Intelligence Orchestrator
- **Vibe:** [vibe — use their communication style choice if they didn't customize]
- **Emoji:** [emoji or "lightning bolt"]
- **Avatar:** _(workspace-relative path or URL)_
```

### `.vodou/workspace/MEMORY.md`

**Append** to the existing MEMORY.md (do NOT overwrite). Add a new section after the existing content:

```markdown

## Setup [today's date YYYY-MM-DD]

- User: [name]
- Timezone: [timezone]
- Preference: Communication style — [style]
[- User prefers: [any other noted preferences]]
[- Context: [project context if provided]]
```

Use the `Preference:` and `User prefers:` prefixes — these are high-value patterns that get promoted by Vodou's weekly memory consolidation.

---

### After Writing

Confirm success:

> Done! Vodou is personalized. Your preferences will persist across sessions.
>
> **Quick tips:**
> - Run `./do "setup"` anytime to update your preferences
> - Your memory grows automatically as you work with Vodou
> - Try `./do "hello"` to explore what Vodou can do

---

## If User Chooses "Skip for now" (Stopping Point 1, Choice 3)

> No problem. Run `./do "setup"` whenever you're ready. Vodou works fine with defaults — personalization just makes it better.
