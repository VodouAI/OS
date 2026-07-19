# Create a New Vodou Skill – Step-by-Step

Skills are how you control your bot. That bot can run and connect to a whole backend of possible MCP servers. This guide walks you through creating a skill so a phrase like `./do my phrase` loads it.

**At every step** you can change triggers, name, path, or content—or just type what you want.

## What you're learning

- **Skills = your control layer.** You're building your bot. A skill is a guided workflow (markdown + optional assets). **How Vodou intents work:** When someone types `./do <phrase>`, Vodou looks up that phrase in the intent table; if it matches a keyword registered for your skill, Vodou loads your skill. So "intents" are the trigger phrases that load your skill. Your bot can run commands, fire scripts, and connect to MCP servers; skills decide what runs and when.
- **When you're done,** typing `./do my first skill` (or your phrase) in this chat will load the skill you create—same idea as `./do hello world` loading this walk-through.

---

## What we'll do together

1. Create a skill directory and `SKILL.md` (same structure as **my-skill3**: About, How Vodou used this skill, Connect to MCP servers – make it work for you, What you can do next, Trigger Phrases, Stopping points, menu).
2. Add trigger phrases (suggested from the skill name) and the Run it / Edit it / Intents / Add MCP server / Back menu.
3. Write an install script that registers intent mappings.
4. Run the install script, then run with your intents so you see your skill load; then Step D (Run it / Edit it / Intents / Add MCP server / Back).

**Outcome:** A skill like `skills/my-skills/my-skill3/SKILL.md` — onboarding, MCP connection instructions, and a menu that works with Vodou.

---

## Skill format for Vodou (required)

For Vodou and agents to run a skill correctly, every skill must include:

1. **About** – One line stating what the skill is about. Shown when the skill loads so the user (and agent) know what they're in. Place it right after the title or Trigger Phrases.
2. **Stopping points (in order)** – A numbered list of when the skill stops for user input. Vodou/agents use this to present questions in the right order and to know the flow (e.g. "1. Give it a name → 2. [auto] → 3. Your skill just loaded (Run it / Edit it / Intents / Add MCP / Back)").

**Agent:** When any skill loads, show its **About** first, then follow the **Stopping points (in order)** so each question is presented in sequence. Do not skip or reorder.

---

## 🛑 STOPPING POINT A: Give it a name

**High level:** We're directing your bot — adding a new phrase that, when someone types it, loads a skill you control. First step: give that skill a name. Vodou will put it at `skills/my-skills/<name>/` (e.g. `skills/my-skills/my-tool/`).

**Reply with a number:**
1. **name** – Give it a name (e.g. skill1, my-tool — tell me and we'll create it)
2. **need help** – Pick a name together
3. **back** – Return to hello-world Choose your path

Or just type the skill name (e.g. "skill1", "help", "back").

---

## Step 1: Create the Directory and SKILL.md

Create the folder and one file: `SKILL.md`.

**1.1 Create the directory** (the agent can do this from the project, or you create it):

```bash
mkdir -p skills/my-skills/my-first-skill
```

(Replace `my-first-skill` with your chosen folder name. Default location is `skills/my-skills/` for skills you create here.)

**1.2 Create `SKILL.md`** in that folder. The walk-through must create the same structure as **`skills/my-skills/my-skill3/SKILL.md`** (the canonical example). Required sections:

- YAML frontmatter: `name`, `description` (e.g. "run it, edit it, add intents, or connect to MCP servers to make it work for you")
- **About** – Short paragraph: created in hello-world, how Vodou works (phrase → intent → skill load), you're controlling your bot, connect to MCP to make it work for you
- **How Vodou used this skill** – Bullets: who typed what, Vodou matched and loaded, Trigger Phrases / Intents
- **Connect to MCP servers – make it work for you** – What MCP is (skill = guide, MCP = work). How to connect: (1) `./do list`, (2) add server (path 5 or install), (3) wire phrases via intents, (4) use from skill by adding steps that say "run oi &lt;phrase&gt;". Make it work for you: decide what the skill should help with, add MCP for that, add menu options that run the right `./do ...` commands.
- **What you can do next** – Run it, Edit it (first ask: tell me what you want this skill to do), Intents, Add MCP server, Back (with short explanations)
- **Trigger Phrases** (suggested intents)
- **Stopping points (in order)** – 1. Main menu – Run it / Edit it / Intents / Add MCP server / Back
- **Choose an option** – Numbered menu: 1 Run it, 2 Edit it (first ask: what do you want this skill to do?), 3 Intents, 4 Add MCP server, 5 Back. Plus "Or type what you want." When user chooses Edit it, ask first: **Tell me what you want this skill to do.**

Copy the structure and wording from `skills/my-skills/my-skill3/SKILL.md`; replace skill name and trigger phrases with the user's choice.

**Action:** Create the directory and `SKILL.md`. Use **`skills/my-skills/my-skill3/SKILL.md`** as the template (all sections including "Connect to MCP servers – make it work for you"); substitute the user's skill name and suggested intents.

---

## Suggested intents (auto, no menu)

**Agent:** After Step A (user gives a name), create SKILL.md using **`skills/my-skills/my-skill3/SKILL.md`** as the template. Include every section: **About**, **How Vodou used this skill**, **Connect to MCP servers – make it work for you** (What it is, How to connect, Make it work for you), **What you can do next**, **Trigger Phrases**, **Stopping points (in order)**, and the numbered menu (Run it / Edit it / Intents / Add MCP server / Back). Replace skill name and trigger phrases with the user's name/phrases. Derive intents from the skill name: (1) Strip the `oi-` prefix → primary phrase (e.g. `my-skill3` → "skill3"; `my-first-skill` → "my first skill"). (2) Add "run &lt;primary&gt;" (e.g. "run skill3", "run my skill"). **Do not show a Step B menu.** Auto-proceed: create the install script (Step 2), run it, run `./do &lt;primary&gt;` so the user sees their skill load, then present Step D ("Your skill just loaded. Add more intents or good?"). If the user wants to add or change intents, they do it at Step D.

---

## Step 2: Create the Install Script

The install script writes intent mappings into `vodou-core.db` so that when someone runs `./do my first skill`, Vodou loads your skill.

**2.1 Create `install-my-first-skill.sh`** in the same folder as `SKILL.md`.

**2.2 Use this template** (replace `my-first-skill` and the trigger phrases with yours):

```bash
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# From skills/my-skills/my-first-skill, go up 3 levels to project root
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DB_PATH="$PROJECT_ROOT/vodou-core.db"

echo "Installing intent mappings for my-first-skill..."
sqlite3 "$DB_PATH" <<EOF
INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority, execution_type, tool_parameters) VALUES
('my first skill', 'vodou-core', 'vc_load_skill', 10, 'mcp', '{"skill_name": "my-first-skill"}'),
('run my skill', 'vodou-core', 'vc_load_skill', 9, 'mcp', '{"skill_name": "my-first-skill"}');
EOF

if [ $? -eq 0 ]; then
    echo "Intent mappings installed successfully!"
    echo "  oi my first skill"
else
    echo "Failed to install intent mappings"
    exit 1
fi
```

**Notes:**

- `keyword`: phrase the user types (e.g. "my first skill").
- `server_name`: `vodou-core` (built-in).
- `tool_name`: `vc_load_skill`.
- `tool_parameters`: JSON with `"skill_name": "my-first-skill"` (must match the `name` in your SKILL.md frontmatter).
- If your skill is one level deeper (e.g. `skills/my-skills/category/my-skill/`), use `SCRIPT_DIR/../../../..` for PROJECT_ROOT (4 levels).

**Action:** Create the script and make it executable: `chmod +x skills/my-skills/my-first-skill/install-my-first-skill.sh`

🛑 **STOPPING POINT C – reply with a number:**

1. **done** – Script is ready; go to Step 3 (run script, then run with your intents).
2. **change triggers or path** – Tell me what to change; I'll update the script.
3. **back** – Return to hello-world Choose your path.

Or just type something else (e.g. "done", "add phrase X", "back").

---

## Step 3: Run the Install Script, Then Run With Your Intents

**3.1 Run the install script** (the agent runs it from this chat):

```bash
./skills/my-skills/my-first-skill/install-my-first-skill.sh
```

(Adjust path if you used a different folder.)

**3.2 Run with your intents first (onboarding):** The agent runs `./do <your phrase>` (e.g. `./do skill2` or `./do my first skill`) in this chat and shows you the output. You see your skill load right away.

**Agent:** After the install script succeeds, run `./do "<primary_phrase>"` (e.g. `./do "skill2"`) from project root and show the user the skill output. Then present STOPPING POINT D.



🛑 **STOPPING POINT D – Your skill just loaded. What next?**

1. **Run it** – Run this skill again (e.g. `./do skill3`).
2. **Edit it** – First ask: what do you want this skill to do? Then change SKILL.md (description, options).
3. **Intents** – Add, change, or remove trigger phrases for this skill.
4. **Add MCP server** – Install or connect an MCP server (hello-world path 5).
5. **Back** – Return to hello-world Choose your path.

Or just type what you want (e.g. "run it", "add phrase X", "back").

---

## Summary

| Step | What you did |
|------|----------------|
| A | Chose skill folder and path |
| 1 | Created directory and `SKILL.md` with name, description, triggers, one stopping point |
| B | Auto: suggested intents in SKILL.md, no menu; proceed to Step 2 |
| 2 | Created install script that inserts intent mappings for your trigger phrases → `vc_load_skill` with your `skill_name` |
| C | Confirmed or customized (triggers, name, path) |
| 3 | Ran install script; agent runs `./do <phrase>` so user sees skill load; then ask add more intents or good |
| D | Confirmed it works or customized (triggers, content, back to earlier step) |

**Next:** You can add more trigger phrases in the install script (more `INSERT OR REPLACE` rows) or connect this skill to MCP (see `references/connect-skill-to-mcp.md`). For the full example skill (my-first-skill: six tools, summaries, "What's next"), see **`references/example-my-first-skill.md`**.
