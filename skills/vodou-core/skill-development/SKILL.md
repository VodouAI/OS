---
name: skill-development
description: Comprehensive guide to creating Vodou skills with full user control, stopping points, and best practices
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - "create oi skill"
  - "develop skill"
  - "skill development"
  - "new skill wizard"
  - "help me create a skill"
  - "build a skill"
  - "skill creation guide"
  - "--"
stopping_points: required
actions: inline
imported_from:
  source: hand-written
metadata:
  vodou:
    preservation_reason: user-preserved 2026-04-25
---

# Vodou Skill Development - Complete Guide

## ⚠️ **CRITICAL: AI Agent Instructions**

**This skill guides users through creating Vodou skills with FULL USER CONTROL. You MUST:**

1. **Ask questions first** - Understand what skill they want to create
2. **Present options at stopping points** - Never assume, always ask
3. **Give users control** - Let them decide structure, stopping points, complexity
4. **Use progressive disclosure** - Start with overview, go deep on demand
5. **Reference supporting docs** - Use `references/` and `assets/` for detailed info

**User control is MANDATORY. Never auto-generate without user approval.**

6. **Use the correct stopping point format** — All options MUST be simple numbered lines (`1. Option text`) so the gateway UI renders them as clickable buttons. NEVER use tables, lettered options (A/B/C), "Option 1:" labels, or bold numbered formats. The gateway detects blocks of 2+ sequential numbered lines and converts them to buttons automatically. When generating SKILL.md files, ensure all stopping points follow this exact format.

---

## 📖 **Quick Overview: What is Skill Development?**

**Vodou Skills** are expert guides that teach AI agents (and users) how to accomplish tasks effectively. They're markdown files with:
- **Metadata** (name, description)
- **Trigger phrases** (natural language activation)
- **Instructions** (step-by-step workflows)
- **Stopping points** (user control and decision points)
- **Examples** (real, working commands)

**Key Principles:**
- ✅ **User Control**: Skills must include stopping points for user decisions
- ✅ **Progressive Disclosure**: Start simple, reveal complexity on demand
- ✅ **Tested Examples**: All commands must actually work
- ✅ **Clear Structure**: Easy to follow and understand

---

## 🛑 **STOPPING POINT 1: What Do You Want to Create?**

Before we start, I need to understand your skill. This determines everything we build.

**Please tell me:**

1. **What's the main purpose of your skill?**
   - What problem does it solve?
   - Who is it for?
   - What makes it valuable?

2. **What should trigger this skill?**
   - What natural language phrases should activate it?
   - Think of 3-5 ways users might ask for it

3. **What complexity level?**
   - **Simple**: Basic workflow, few steps, minimal stopping points
   - **Moderate**: Multi-step process, several stopping points, some branching
   - **Complex**: Advanced orchestration, multiple paths, extensive user control

4. **What category?**
   - **Core Skill** (`oi-` prefix): Universal Vodou functionality
   - **Community Skill**: Domain-specific or specialized use case

**Once you answer these, I'll guide you through the appropriate creation path.**

**Would you like to:**

1. Answer these questions now and I'll create a custom skill structure
2. See examples of different skill types first
3. Use a guided wizard that asks questions step-by-step
4. Start with a template and customize it

---

## 🎯 **Section 1: Skill Planning & Discovery**

### Quick Summary

Before writing any code, we need to plan your skill. This includes understanding:
- The problem it solves
- Who will use it
- What tools it needs
- How complex it should be
- What stopping points are needed

### 🛑 **STOPPING POINT 2: Planning Approach**

**How would you like to plan your skill?**

1. Guided Discovery — I'll ask you questions, we explore together, you maintain full control
2. Template-Based — Start with a proven template, customize to your needs
3. Example-Driven — Look at similar skills first, adapt patterns that work
4. Minimal Start — Create basic structure first, add complexity incrementally

**For detailed planning guidance, see:** `references/skill-planning-guide.md`

---

## 📐 **Section 2: Skill Structure & Anatomy**

### Quick Summary

Every Vodou skill follows a standard structure:
1. **Metadata** (YAML frontmatter)
2. **Trigger Phrases** (natural language activation)
3. **Overview** (what and why)
4. **Core Instructions** (step-by-step workflows)
5. **Stopping Points** (user control points)
6. **Examples** (working commands)
7. **Troubleshooting** (optional)

### 🛑 **STOPPING POINT 3: Structure Decisions**

**What structure does your skill need?**

**Basic Structure** (Simple skills):
- Overview
- Core workflow
- Examples
- 2-3 stopping points

**Standard Structure** (Most skills):
- Overview
- Prerequisites
- Core workflow with steps
- Advanced usage
- Examples
- Troubleshooting
- 5-7 stopping points

**Advanced Structure** (Complex skills):
- Overview
- Prerequisites
- Multiple workflow paths
- Advanced patterns
- Orchestration directives
- Examples (multiple scenarios)
- Best practices
- Troubleshooting
- 10+ stopping points

1. Basic — Overview, core workflow, examples, 2-3 stopping points
2. Standard — Full structure with prerequisites, advanced usage, troubleshooting, 5-7 stopping points
3. Advanced — Multiple workflow paths, orchestration, 10+ stopping points

**For complete structure details, see:** `references/skill-anatomy.md`

---

## 🛑 **Section 3: Stopping Points & User Control**

### Quick Summary

**Stopping points are MANDATORY** for user control. They pause execution and ask for user input before proceeding.

**Key Stopping Point Types:**
1. **Path Selection** - User chooses workflow direction
2. **Confirmation** - User approves before potentially disruptive actions
3. **Input Required** - User provides necessary information
4. **Decision Points** - User makes choices that affect workflow
5. **Review Points** - User reviews results before next step

### 🛑 **STOPPING POINT 4: Stopping Point Strategy**

**How much user control does your skill need?**

**Minimal Control** (2-3 stopping points):
- After initial analysis
- Before final execution
- Good for: Simple, low-risk workflows

**Moderate Control** (5-7 stopping points):
- After each major phase
- Before potentially disruptive actions
- At decision branches
- Good for: Standard workflows with options

**Full Control** (10+ stopping points):
- After every significant step
- Multiple decision branches
- Review points throughout
- Good for: Complex, high-stakes workflows

1. Minimal Control — 2-3 stopping points, simple low-risk workflows
2. Moderate Control — 5-7 stopping points, standard workflows with options
3. Full Control — 10+ stopping points, complex high-stakes workflows

**For stopping point patterns and examples, see:** `references/stopping-points-guide.md` and `assets/stopping-point-examples.md`

---

## 📝 **Section 4: Writing Your Skill**

### Quick Summary

Writing effective skills requires:
- Clear, actionable instructions
- Real, tested examples
- Proper stopping points
- User control at key moments
- Progressive disclosure

### 🛑 **STOPPING POINT 5: Writing Approach**

**How would you like to write your skill?**

1. I Write, You Review — I generate sections, you review and approve each one
2. Collaborative Writing — We write together section by section
3. Template Fill-In — You fill in a template, I help refine
4. Guided Generation — I ask questions for each section, you answer, I write

**For writing best practices, see:** `references/writing-effective-skills.md`

---

## 🧪 **Section 5: Testing & Validation**

### Quick Summary

Before finalizing, your skill must be tested:
- All examples must work
- Stopping points must function correctly
- Intent mappings must be installed
- Skill must load properly

### 🛑 **STOPPING POINT 6: Testing Strategy**

**How do you want to test your skill?**

**Quick Test** (5 minutes):
- Verify skill loads
- Test one example
- Check basic structure

**Standard Test** (15 minutes):
- Test all examples
- Verify stopping points
- Check intent mappings
- Validate metadata

**Comprehensive Test** (30+ minutes):
- Test all examples in multiple scenarios
- Verify all stopping points
- Test edge cases
- Validate with real users
- Performance testing

1. Quick Test (5 minutes) — Verify skill loads, test one example, check basic structure
2. Standard Test (15 minutes) — Test all examples, verify stopping points, check intents
3. Comprehensive Test (30+ minutes) — Full validation, edge cases, real user testing

**For testing procedures, see:** `references/testing-guide.md`

---

## 📦 **Section 6: Auto-Install & Intent Registration**

### ⚠️ **CRITICAL: This section runs AUTOMATICALLY**

**When the user confirms their trigger phrases (at any stopping point where triggers are finalized), you MUST immediately execute the full installation. Do NOT ask the user how they want to install — just DO IT. The skill creator experience ends with a working, installed skill.**

### Auto-Install Sequence

**Execute ALL of the following steps in order using Bash immediately after trigger phrases are confirmed:**

#### Step 1: Create the skill via API

```bash
curl -s -X POST http://localhost:8765/api/skills \
  -H 'Content-Type: application/json' \
  -d '{"name":"{skill-name}","description":"{description}","category":"my-skills"}'
```

- `{skill-name}` = kebab-case version of the skill name (e.g., `broken-time-machine`)
- `{description}` = one-line description from the overview
- If the API returns 409 (already exists), that's fine — continue to Step 2

#### Step 2: Write the SKILL.md file

**Use a QUOTED heredoc** to write the complete skill content. The API in Step 1 created the directory — now overwrite with the real content:

```bash
cat > "skills/my-skills/{skill-name}/SKILL.md" << 'SKILLEOF'
---
name: {skill-name}
description: {description}
category: my-skills
tags: [{tags}]
version: 1.0.0
author: {user name if known}
---

# {Skill Display Name}

## Persona
{The full persona instructions built during the walkthrough}

## Workflow
{The complete workflow with all stopping points built during the walkthrough}

## Notes
{Any guardrails/guidelines established during the walkthrough}
SKILLEOF
```

**Important:** Use `<< 'SKILLEOF'` (quoted) so shell variables and backticks in the markdown are NOT interpreted. Include ALL content from the walkthrough — persona, workflow stops, notes, everything.

After writing, verify the file:
```bash
wc -l "skills/my-skills/{skill-name}/SKILL.md"
```

#### Step 3: Install intent mappings for EVERY trigger phrase

For EACH trigger phrase the user confirmed, insert into the intent database:

```bash
sqlite3 vodou-core.db "INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority, execution_type, tool_parameters) VALUES ('{trigger phrase}', 'vodou-core', 'vc_load_skill', 10, 'mcp', '{\"skill_name\": \"{skill-name\"}');"
```

- First trigger phrase gets priority `10`
- Remaining trigger phrases get priority `9`
- Repeat for ALL trigger phrases — do not skip any

#### Step 4: Verify installation

```bash
# Verify intent mappings were installed
sqlite3 vodou-core.db "SELECT keyword, tool_name FROM intent_mappings WHERE tool_parameters LIKE '%{skill-name}%';"
```

#### Step 5: Present completion confirmation

After ALL commands succeed, tell the user:

> ✅ **{Skill Name} is installed and LIVE!**
>
> 📁 Saved to: `skills/my-skills/{skill-name}/SKILL.md`
> 🎯 Intent mappings installed for {N} trigger phrases:
> {list each trigger phrase}
>
> **Try it now!** Just say "{first trigger phrase}" to activate your skill.

### Error Handling

- **API 409 (skill exists):** Continue — just overwrite the SKILL.md
- **sqlite3 fails:** Warn but don't block — skill still works from UI, just won't auto-route from chat
- **File write fails:** Show error, check directory permissions, retry once

**For additional installation details, see:** `references/installation-guide.md`

---

## 🎨 **Section 7: Advanced Patterns**

### Quick Summary

Advanced skill patterns include:
- Orchestration directives
- Cross-server workflows
- Conditional branching
- Dynamic stopping points
- Workflow chaining

### 🛑 **STOPPING POINT 8: Advanced Features**

**Does your skill need advanced features?**

**Basic Features** (Standard skill):
- Simple workflow
- Basic stopping points
- Standard examples

**Intermediate Features**:
- Multiple workflow paths
- Conditional stopping points
- Cross-tool integration

**Advanced Features**:
- **AGENT_ACTIONS** — Deterministic tool execution (engine-enforced, LLM can't bypass)
- **`{{LLM:prompt}}`** — LLM-generated content at each step (context-aware)
- Multi-phase stopping points (execute phase 1 → present phase 2 menu)
- Variable capture and chaining between steps

1. Basic Features — Simple workflow, basic stopping points, standard examples
2. Intermediate Features — Multiple workflow paths, conditional stopping points, cross-tool integration
3. Advanced Features — AGENT_ACTIONS with deterministic tool execution and `{{LLM:}}` templates

**AGENT_ACTIONS (Unified Format):**

When your skill uses MCP tools, embed them in the unified format so the engine executes them deterministically:

```markdown
<!-- AGENT_ACTIONS: {"stopping_points": [
  {
    "id": 1,
    "title": "Choose Action",
    "options": {
      "1": {"label":"Quick scan","vars":{"DEPTH":"3"},"steps":[
        {"server":"your-server","tool":"start","args":{"topic":"{{TOPIC}}"},"capture":{"ID":"id"}},
        {"server":"your-server","tool":"process","args":{"id":"{{ID}}","thought":"{{LLM:Analyze {{TOPIC}} in depth}}"},"loop":3}
      ]},
      "2": {"label":"Deep scan","vars":{"DEPTH":"10"},"steps":[...]}
    }
  },
  {
    "id": 2,
    "title": "What next?",
    "options": {
      "1": {"label":"Go deeper","steps":[...]},
      "2": {"label":"Done","steps":[]}
    }
  }
]} -->
```

**Key features:**
- `stopping_points` — engine enforces pause between phases (LLM can't skip)
- `capture` — chain outputs: step 1's `session_id` feeds into step 2
- `{{LLM:prompt}}` — LLM generates context-aware content (not static strings)
- `{{TOPIC}}` — resolves to user's query
- `{{i}}` — loop counter (1-based)
- `loop` — repeat a step N times
- Works in both gateway (workflow driver) and CLI (`vodou-core workflow run`)

**For advanced patterns, see:** `references/advanced-patterns.md`

---

## 📚 **All Reference Guides**

### Available Documentation

**Core Guides:**
- `references/skill-planning-guide.md` - Complete planning process
- `references/skill-anatomy.md` - Detailed structure reference
- `references/stopping-points-guide.md` - Stopping point patterns
- `references/writing-effective-skills.md` - Writing best practices
- `references/testing-guide.md` - Testing procedures
- `references/installation-guide.md` - Installation steps
- `references/advanced-patterns.md` - Advanced skill patterns
- `references/user-control-patterns.md` - User control best practices

**Templates & Examples:**
- `assets/skill-template.md` - Complete skill template
- `assets/stopping-point-examples.md` - Stopping point examples
- `assets/workflow-patterns.md` - Common workflow patterns
- `assets/orchestration-examples.md` - Orchestration examples

**Scripts:**
- `scripts/skill-scaffold.sh` - Generate skill structure
- `scripts/validate-skill.sh` - Validate skill format
- `scripts/test-examples.sh` - Test all examples

### 🛑 **STOPPING POINT 9: What Would You Like to Explore?**

**Choose a path:**
1. **Planning** - Start planning your skill
2. **Structure** - Learn about skill anatomy
3. **Stopping Points** - Understand user control
4. **Writing** - Writing best practices
5. **Testing** - Testing procedures
6. **Installation** - Installation guide
7. **Advanced** - Advanced patterns
8. **Templates** - Use a template
9. **Examples** - See example skills

**Which would you like to explore? (1-9)**

---

## 🚀 **Quick Start: Create Your First Skill**

If you're ready to start creating, here's the fastest path:

### Step 1: Answer Key Questions
```bash
# I'll ask you:
1. What's your skill's purpose?
2. What triggers it?
3. What complexity level?
4. What category?
```

### Step 2: Choose Your Path
- **Guided Wizard** - Step-by-step with questions
- **Template-Based** - Start with template
- **Example-Driven** - Learn from examples

### Step 3: Build Your Skill
- I'll help you write each section
- You maintain full control
- We add stopping points together

### Step 4: Test & Install
- Test all examples
- Install intent mappings
- Verify it works

**Ready to start? Tell me what skill you want to create!**

---

## 💡 **Key Principles**

**Remember these when creating skills:**

1. **User Control First** - Always include stopping points
2. **Progressive Disclosure** - Start simple, reveal complexity
3. **Test Everything** - All examples must work
4. **Clear Structure** - Easy to follow
5. **Real Examples** - Use actual Vodou commands
6. **Ask, Don't Assume** - Present options, let users choose

---

## 🎯 **Quick Reference**

**Common Commands:**
```bash
# Test skill loading
./do "your-skill-name"

# List all skills
./do "available skills"

# Test intent mapping
./do "your trigger phrase"
```

**Directory Structure:**
```
skills/
  vodou-core/       # Core skills (no prefix)
    your-skill/
      SKILL.md
      install-your-skill.sh
      references/   # Optional
      assets/       # Optional
      scripts/      # Optional
  community/        # Community skills
    your-skill/
      SKILL.md
```

**Need help?** Ask me questions at any stopping point, or reference the guides in `references/` and `assets/`.
