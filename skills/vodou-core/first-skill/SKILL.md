---
name: first-skill
description: Interactive tutorial that walks new users through building their first Vodou skill — a Chaos Fortune Teller — while teaching how skills work
version: 1.0.0
author: Vodou Community
category: onboarding
kind: workflow
required_tools: []
trigger_phrases:
  - "build my first skill"
  - "teach me to make a skill"
  - "first skill tutorial"
  - "how do I create a skill"
  - "skill tutorial"
  - "--"
  - "--"
stopping_points: required
actions: none
imported_from:
  source: hand-written
---

## Trigger Phrases
- "build my first skill"
- "teach me to make a skill"
- "first skill tutorial"
- "how do I create a skill"
- "skill tutorial"

---

# 🔮 Build Your First Skill: The Chaos Fortune Teller

**You're about to do something most people never do — teach an AI a new trick.**

In the next few minutes, you'll build a real, working Vodou skill from scratch. Not a toy. Not a demo. A legit skill you can run anytime, share with others, and customize however you want.

**What you'll build:** A *Chaos Fortune Teller* — an over-the-top, hilariously dramatic fortune generator that delivers prophecies with fake statistics, conspiracy-level predictions, and questionable life advice.

**What you'll learn:** How Vodou skills actually work — the anatomy, the magic, all of it.

**Time:** ~5 minutes
**Difficulty:** Zero. If you can pick from a menu, you can do this.

---

## ⚠️ **CRITICAL: AI Agent Instructions**

This is a TEACHING skill. The experience IS the journey.

1. **DISPLAY each step's explanation BEFORE doing anything** — the user needs to understand what they're building and why
2. **NEVER skip stopping points** — each one is a learning moment disguised as a fun choice
3. **ACTUALLY create the files** — use real commands to scaffold the skill in `skills/my-skills/chaos-fortune-teller/`
4. **Build the SKILL.md incrementally** — add sections as the user progresses so they see it come together piece by piece
5. **Keep the energy HIGH** — this should feel like an adventure, not a lecture
6. **After each step, briefly show what was added** — so the user sees the skill growing
7. **At the final step, RUN the skill they just built** — this is the WOW moment

---

## Step 1: The Adventure Begins

Welcome, future skill architect! 🏗️

Here's the deal: Vodou skills are just **markdown files**. That's it. No compiling, no deploying, no 47-step CI/CD pipeline. You write a `.md` file, drop it in a folder, and boom — Vodou knows a new trick.

Think of a skill like a **recipe card** for your AI:
- **Name & description** → What's on the menu
- **Trigger phrases** → How you order it
- **Steps & stopping points** → The recipe itself
- **Examples** → Photos of the finished dish

You're about to write your first recipe. And it's going to be *delicious chaos*.

### 🛑 **STOPPING POINT 1: Choose Your Fortune Teller Persona**

Every great fortune teller needs a personality. Pick yours:

1. 🌀 The Cosmic Unhinged Oracle — Talks like the universe just DM'd them. Everything is connected. EVERYTHING.
2. 📊 The Chaotic Statistician — Delivers prophecies with absurdly specific fake percentages. "There's a 73.2% chance your next sneeze changes the economy."
3. 🎭 The Dramatic Soap Opera Psychic — Every fortune is delivered like a telenovela plot twist. Gasps included.
4. 🤖 The Malfunctioning Time Traveler — Glitches between timelines. Accidentally spoils your future, then tries to take it back.
5. 🦑 The Eldritch HR Manager — An ancient cosmic entity that delivers prophecies in corporate jargon. "Per my last vision..."

---

## Step 2: Laying the Foundation (Metadata)

**🧠 Skill Concept: Metadata**

Every skill starts with a tiny block of YAML at the top called **frontmatter**. It's like the skill's ID badge — just a name and a one-line description.

```yaml
---
name: chaos-fortune-teller
description: Delivers unhinged, dramatically absurd fortune readings with fake statistics and cosmic chaos
---
```

That's it. Two lines. Vodou reads this to know what the skill is called and what it does.

**What happens now:** I'm going to create your skill's folder and start the SKILL.md file with this metadata.

### 🛑 **STOPPING POINT 2: Name Your Fortune Teller**

Want to customize the name? Options:

1. `chaos-fortune-teller` — Classic. Perfect. Chef's kiss.
2. Let me name it myself — Go wild. Tell me what you want to call it.

**ACTION:** After the user chooses, create the directory and start the SKILL.md:

```bash
mkdir -p skills/my-skills/{chosen-name}
```

Write the frontmatter to `skills/my-skills/{chosen-name}/SKILL.md`.

---

## Step 3: The Magic Words (Trigger Phrases)

**🧠 Skill Concept: Trigger Phrases**

Trigger phrases are how you "call" your skill. When you say something that matches, Vodou goes "Ah, I know what to do!" and loads your skill.

Think of them like **nicknames** — the more natural they sound, the easier it is to use your skill without thinking about it.

**Rules of thumb:**
- Use 3-5 phrases
- Make them things you'd actually SAY
- Most specific phrase first
- Include shortcuts for lazy days

**Here's what I'd suggest for your fortune teller:**

```markdown
## Trigger Phrases
- "tell my fortune"
- "chaos fortune"
- "read my fortune"
- "fortune teller"
- "what does my future hold"
```

### 🛑 **STOPPING POINT 3: Set Your Trigger Phrases**

1. Use these triggers — They're solid, let's roll
2. I want to write my own — Tell me your phrases and I'll add them
3. Mix it up — Use some of mine, add some of yours

**ACTION:** After the user chooses, append the trigger phrases section to the SKILL.md. Show the user what the file looks like so far.

---

## Step 4: The Welcome Mat (Overview)

**🧠 Skill Concept: The Overview Section**

The overview tells Vodou (and future-you) what this skill does, who it's for, and why it exists. It also sets the TONE — and tone matters because Vodou will channel this energy every time the skill runs.

This is where your chosen persona comes alive. The overview for a Cosmic Unhinged Oracle sounds very different from an Eldritch HR Manager.

**ACTION:** Based on the persona chosen in Step 1, generate an overview section that:
- Describes what the skill does (in 2-3 sentences, IN CHARACTER)
- Lists 3 "Key Benefits" (make them funny and on-brand)
- Sets the tone for how the AI should deliver fortunes

**Example for The Chaotic Statistician:**

```markdown
## Overview

The numbers don't lie. Well, THESE numbers absolutely lie, but they lie with CONFIDENCE. This skill channels the raw power of completely fabricated data science to deliver fortune readings backed by percentages that are as precise as they are fictional.

**Key Benefits:**
- 📊 Every fortune comes with fake-but-specific statistics (87.3% accuracy guaranteed*)
- 🎲 Randomized prediction categories: Love, Career, Snack Choices, Interdimensional Travel
- 😱 Dramatic reveals that would make a TED Talk speaker weep

*accuracy not guaranteed
```

### 🛑 **STOPPING POINT 4: Approve Your Overview**

I'll generate the overview based on your persona. You tell me:

1. Perfect, love it — Add it to the skill
2. Tweak it — Tell me what to change
3. More unhinged — Turn the chaos dial to 11

**ACTION:** After approval, append the overview to SKILL.md. Show the growing file.

---

## Step 5: The Secret Sauce (Stopping Points)

**🧠 Skill Concept: Stopping Points**

This is the MOST IMPORTANT concept in Vodou skills. 🛑

Stopping points are moments where the skill **pauses and asks the user what to do**. They're what make skills interactive instead of just... a wall of text.

There are 5 types:

| Type | Use When | Example |
|------|----------|---------|
| **Path Selection** | User picks from options | "Choose your reading type" |
| **Confirmation** | Before doing something big | "Ready to reveal your fortune?" |
| **Input Required** | Need info from user | "What's your name for the reading?" |
| **Decision Point** | Choice affects outcome | "Do you want the truth or comfort?" |
| **Review** | Showing results | "Here's your fortune. Want another?" |

**For your fortune teller, we'll use 3 stopping points:**
1. **Input** → Ask for their name and a topic (love, career, etc.)
2. **Path Selection** → Choose the intensity level (mild, spicy, UNHINGED)
3. **Review** → Deliver the fortune and ask if they want another

### 🛑 **STOPPING POINT 5: Choose Your Fortune Flow**

How many stopping points do you want in your fortune teller?

1. 2 stops (quick & punchy) — Ask name, deliver fortune. Fast and fun.
2. 3 stops (the sweet spot) — Name, intensity, fortune. Great flow.
3. 4 stops (full experience) — Name, category, intensity, fortune. Full dramatic arc.

**ACTION:** After the user chooses, write the stopping points into the core workflow section of SKILL.md. Build out the full interactive flow based on the persona + number of stops chosen.

---

## Step 6: The Main Event (Core Workflow)

**🧠 Skill Concept: Core Workflow**

This is the beating heart of your skill — the actual instructions that tell Vodou what to do, step by step. Everything you've built so far (metadata, triggers, overview, stopping points) was setup. This is the SHOW.

**ACTION:** Based on ALL choices so far (persona, name, triggers, stopping points), generate the complete Core Workflow section.

The workflow MUST include:
1. A dramatic opening that fits the persona
2. The stopping points chosen in Step 5
3. Fortune generation instructions that include:
   - The persona's unique voice/style
   - Absurdly specific fake details (stats, dates, predictions)
   - At least one "plot twist" revelation in every fortune
   - A dramatic closing line
   - An optional "bonus prophecy" for maximum chaos
4. A "Want another fortune?" loop at the end

**Example fortune structure for The Chaotic Statistician:**
```
📊 FORTUNE ANALYSIS REPORT
━━━━━━━━━━━━━━━━━━━━━━━━━
Subject: {name}
Category: {chosen category}
Confidence Level: {random}%
━━━━━━━━━━━━━━━━━━━━━━━━━

{Main prediction with fake statistics}

⚠️ STATISTICAL ANOMALY DETECTED:
{Plot twist prediction}

📈 TREND FORECAST:
{Bonus prediction about something mundane}

Margin of Error: ±{absurd number} parallel dimensions
This reading was peer-reviewed by {ridiculous number} interdimensional data scientists.
```

### 🛑 **STOPPING POINT 6: Review Your Skill's Core**

I'll generate the full core workflow. Review it:

1. Ship it! — It's perfect, finalize the skill
2. More chaos — Make it wilder
3. Tweak something — Tell me what to adjust

**ACTION:** After approval, append the core workflow to SKILL.md. The file should now be a COMPLETE, working skill.

---

## Step 7: The Grand Finale 🎆

**YOUR SKILL IS BUILT.**

Show the user:

1. **The complete SKILL.md file** — formatted beautifully
2. **Where it lives** — the file path
3. **How to run it** — just say one of the trigger phrases!

**Then, deliver the WOW moment:**

### 🛑 **STOPPING POINT 7: The Moment of Truth**

Your Chaos Fortune Teller is live. Ready to test it?

1. 🔮 Tell my fortune! — Run the skill RIGHT NOW
2. 📖 Show me the full file first — I want to admire my creation
3. ✏️ One more tweak — I want to change something before the big reveal

**ACTION:**
- If they pick 1: **RUN THE FORTUNE TELLER SKILL IMMEDIATELY.** Generate a full, glorious, over-the-top fortune reading using everything they built. This is the "holy shit" moment. Make it INCREDIBLE.
- If they pick 2: Display the complete SKILL.md with syntax highlighting.
- If they pick 3: Make their requested changes, then ask again.

---

## Step 8: What You Just Learned

After the fortune is delivered, give them the recap:

**🎓 Skill Building Cheat Sheet:**

| You Built | What It Does |
|-----------|-------------|
| `---` frontmatter `---` | Tells Vodou the skill's name & description |
| `## Trigger Phrases` | How users activate the skill |
| `## Overview` | Sets the tone and explains the purpose |
| `### 🛑 STOPPING POINT` | Pauses for user input and choices |
| Core Workflow | The actual instructions and logic |

**Your skill file:** `skills/my-skills/{name}/SKILL.md`

**To run it anytime:** Just say one of your trigger phrases!

**To edit it:** Open the SKILL.md and change whatever you want. It's just markdown.

### 🛑 **STOPPING POINT 8: What's Next?**

You just built your first skill. You're now officially dangerous. 😎

1. 🎨 Customize more — Add new fortunes, categories, or personas
2. 🚀 Build another skill — You know how now! Run the Skill Development skill for a guided build
3. 📚 Learn advanced patterns — Stopping point strategies, MCP tool integration, multi-step workflows
4. 🎉 I'm good! — Drop the mic, walk away like a boss

---

## Examples

### Example 1: Quick Run
```
User: "tell my fortune"
→ Skill activates, asks for name and category, delivers chaos fortune
```

### Example 2: Teaching Mode
```
User: "build my first skill"
→ Full 8-step tutorial walks user through creating the Chaos Fortune Teller
```

### Example 3: After Building
```
User: "chaos fortune"
→ Runs the skill they built, delivers a new fortune every time
```

---

## Quick Reference

```bash
# Start the tutorial
"build my first skill"

# Run your fortune teller (after building it)
"tell my fortune"

# Edit your skill
# Just open: skills/my-skills/chaos-fortune-teller/SKILL.md
```

---

## Best Practices Taught

1. **Start simple** — Your first skill should be fun, not complex
2. **Stopping points = interactivity** — They turn monologues into conversations
3. **Persona matters** — The tone you set in the overview affects everything
4. **It's just markdown** — No magic, no compilation, just a text file with structure
5. **Test immediately** — The best way to learn is to see it work

---

*Built with 🔮 by the Vodou community. May your fortunes be chaotic and your skills be legendary.*
