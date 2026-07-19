# Skills Guide - Complete Reference

## What are Skills?

**Skills** are expert guides that teach AI agents (and you) how to accomplish tasks effectively. They're like having a senior developer or expert consultant available 24/7.

### Key Characteristics

- **Expert Knowledge**: Curated best practices and proven patterns
- **Interactive**: Can ask questions and adapt to your needs
- **Executable**: Can run Vodou commands and MCP tools
- **Structured**: Follow a standard format for consistency

## Skills vs MCP Servers

### MCP Servers
- Provide **tools** (functions to execute)
- Focus on **capabilities** (what can be done)
- Execute **operations** (do something)

### Skills
- Provide **guidance** (how to do things)
- Focus on **workflows** (best practices)
- Teach **patterns** (proven approaches)

**Think of it this way:**
- **MCP Servers** = The tools in your toolbox
- **Skills** = The expert who teaches you how to use them effectively

## Skills Structure

### Directory Structure

```
my-skill/
├── SKILL.md          # Required: instructions + metadata
├── scripts/          # Optional: executable code
├── references/       # Optional: documentation
└── assets/           # Optional: templates, resources
```

### SKILL.md Format

**Required Frontmatter:**
```markdown
---
name: my-skill
description: What this skill does and when to use it
---
```

**Content Sections:**
- Trigger phrases
- Overview
- Instructions
- Stopping points
- Examples

## How Skills Work

### 1. Discovery

**At Startup:**
- Vodou scans `skills/` directory
- Loads metadata (name, description) from each `SKILL.md`
- Registers trigger phrases in database

**Result**: Vodou knows what skills exist and when they might be relevant

### 2. Activation

**When Query Matches:**
- User query matches skill's trigger phrases
- Vodou loads full `SKILL.md` content
- Skill instructions become available to AI agent

**Priority**: Skills are checked FIRST before other operations

### 3. Execution

**Interactive Guidance:**
- Skill provides step-by-step instructions
- Can ask questions (stopping points)
- Can execute Vodou commands
- Can call MCP tools
- Adapts based on user responses

## Using Skills

### Natural Language (Automatic)

**Skills activate automatically:**
```bash
./do "create oi skill"
# Automatically loads skill-development skill

./do "install mcp server"
# Automatically loads mcp-installer skill

./do "hello"
# Automatically loads hello skill (this help center)
```

### Direct Skill Loading

**Load a specific skill:**
```bash
./do "load skill mastery"
```

### List Available Skills

```bash
./do "available skills"
```

## Creating Skills

### Step 1: Create Directory

```bash
mkdir -p skills/my-skill
```

### Step 2: Create SKILL.md

```markdown
---
name: my-skill
description: What this skill does
---

# My Skill

## Trigger Phrases
- "do my task"
- "help with my task"

## Overview
This skill helps you accomplish [task].

## Instructions

### Step 1: Preparation
...

### Step 2: Execution
...

⏸️ STOPPING POINT: Ask user for confirmation
```

### Step 3: Register Intent Mappings

**Automatic (Recommended):**
```bash
./do "register skill my-skill"
```

**Manual:**
```bash
sqlite3 vodou-core.db "INSERT INTO intent_mappings 
(keyword, server_name, tool_name, priority, tool_parameters) VALUES 
('do my task', 'vodou-core', 'vc_load_skill', 10, 
'{\"skill_name\": \"my-skill\"}');"
```

### Step 4: Test

```bash
./do "do my task"
# Should load your skill
```

## Skill Best Practices

### Writing Effective Skills

**1. Clear Description**
- What does this skill do?
- When should it be used?
- What problems does it solve?

**2. Good Trigger Phrases**
- Natural language
- Common variations
- Specific enough to avoid conflicts

**3. Structured Instructions**
- Step-by-step guidance
- Clear stopping points
- Examples and use cases

**4. Interactive Elements**
- Ask questions when needed
- Present options clearly
- Wait for user input

### Stopping Points

**When to Use:**
- Before destructive actions
- When user choice is needed
- When clarification is required

**Format:**
```markdown
⏸️ STOPPING POINT: [Description]

[Present options clearly]
[Wait for user response]
```

### Executing Commands

**Skills can run Vodou commands:**
```markdown
## Step 1: Check System
Run: `./do "cpu memory disk"`
```

**Skills can call MCP tools:**
```markdown
## Step 2: Analyze Code
Execute: `./vodou-core call chrome-devtools take_snapshot '{}'` (browser) or use Vodou memory + `rg` for code
```

## Built-in Vodou Skills

### Core Skills

**hello**
- Comprehensive help center
- User onboarding
- Quick reference

**mastery**
- Advanced Vodou techniques
- Best practices
- Power user guide

**skill-development**
- Guide to creating skills
- Best practices
- Examples

**mcp-installer**
- Installing MCP servers
- Server management
- Troubleshooting

### Community Skills

**Location**: `skills/community/`

**Adding Community Skills:**
1. Create skill in `skills/community/`
2. Follow standard structure
3. Register intent mappings
4. Share with community

## Skills vs Traditional Documentation

### Traditional Docs
- Static information
- One-size-fits-all
- No interaction

### Skills
- Interactive guidance
- Adaptive to user needs
- Can execute commands
- Context-aware

## Advanced Topics

### Skill Orchestration

**Skills can orchestrate workflows:**
```markdown
## Workflow
1. Execute: `./do "analyze codebase"`
2. Based on results, present options
3. Execute chosen path
4. Verify results
```

### Cross-Skill Communication

**Skills can load other skills:**
```markdown
## Step 1: Load Related Skill
Execute: `./do "load skill related-skill"`
```

### Dynamic Content

**Skills can adapt based on:**
- User responses
- System state
- Previous results
- Context

## Troubleshooting

### Skill Not Loading
- Check trigger phrases match
- Verify intent mappings in database
- Check SKILL.md format

### Skill Not Executing
- Verify skill is loaded
- Check stopping points
- Review error messages

### Skill Conflicts
- Check for duplicate trigger phrases
- Verify priority settings
- Review intent mappings

## Resources

- **Agent Skills Spec**: https://agentskills.io
- **Skill Examples**: `skills/` directory
- **Development Guide**: `./do "create oi skill"`
- **Best Practices**: `mastery` skill

## Next Steps

1. **Explore**: `./do "available skills"` - See available skills
2. **Use**: `./do "hello"` - Try the help center
3. **Learn**: `./do "oi mastery"` - Advanced techniques
4. **Create**: `./do "create oi skill"` - Build your own

---

**Skills are Vodou's intelligence layer!** 🎓

