# Advanced Skills Usage

## Overview

Advanced techniques for using and creating Vodou skills effectively.

## Using Skills Effectively

### Skills First Priority

**CRITICAL RULE**: Always check for matching skills FIRST.

```bash
# When a user types:
./do "create oi skill"

# Vodou's priority order:
# 1. ✅ FIRST: Look for matching skill (finds skill-development)
# 2. Load and present the skill's guidance
# 3. Use remaining context to focus on specific aspects
```

### Following Skill Workflows

**When a skill loads:**

1. **Recognize the skill** - Look for `# SKILL: [name]` pattern
2. **Follow stopping points** - Pause and present options
3. **Execute commands** - Run commands as specified
4. **Maintain context** - Keep session context throughout

### Interactive Skills

**Skills can:**

1. **Ask Questions** - Gather context from users
2. **Execute Vodou Commands** - Run commands during guidance
3. **Use MCP Tools** - Call MCP servers directly
4. **Pause for Decisions** - Stop at stopping points

## Creating Skills

### Skill Structure

**Required Components:**
- YAML frontmatter (name, description)
- Trigger phrases
- Overview
- Core instructions
- Stopping points
- Examples

### Stopping Points

**MANDATORY**: All skills must include stopping points.

```markdown
### 🛑 **STOPPING POINT: [Name]**

[Question or decision]

**Options:**
- **A)** [Option A]
- **B)** [Option B]

**Your choice? (A or B)**
```

### Skill Best Practices

**✅ DO:**
- Include stopping points
- Use progressive disclosure
- Provide real examples
- Test all examples
- Give users control

**❌ DON'T:**
- Skip stopping points
- Assume user intent
- Use untested examples
- Overwhelm users
- Auto-execute without permission

## Advanced Skill Patterns

### Pattern 1: Interactive Discovery

**Skill asks questions to understand needs:**

```markdown
### 🛑 **STOPPING POINT: Understanding Your Needs**

**What's your skill's main purpose?**
1. [Purpose 1]
2. [Purpose 2]
3. [Purpose 3]

**Your choice? (1, 2, or 3)**
```

### Pattern 2: Command Execution

**Skill executes Vodou commands during guidance:**

```markdown
# Skill can execute:
./do "analyze existing skills"
./do "list available tools"
./do "check system requirements"
```

### Pattern 3: MCP Tool Integration

**Skill calls MCP tools directly:**

```markdown
# Skill can call:
./vodou-core call vodou-core vc_load_skill ...
./vodou-core call mcp-monitor get_cpu_info
```

### Pattern 4: Orchestrated Workflows

**Skill orchestrates multi-phase workflows:**

```markdown
# Phase 1: Analysis
# Phase 2: Options presented
# Phase 3: User chooses
# Phase 4: Execution
# Phase 5: Verification
```

## Skill Development Workflow

### Step 1: Plan Your Skill

- What problem does it solve?
- Who is it for?
- What should trigger it?

### Step 2: Create Structure

- Use skill template
- Add stopping points
- Include examples

### Step 3: Test Everything

- Test all examples
- Verify stopping points
- Check intent mappings

### Step 4: Install and Verify

- Install intent mappings
- Test skill loading
- Verify trigger phrases

## Next Steps

After mastering advanced skills:
1. Create your own skills
2. Share skills with community
3. Build skill libraries

