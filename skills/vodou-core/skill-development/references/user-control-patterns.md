# User Control Patterns

## Overview

User control is the foundation of great Vodou skills. This guide shows patterns for giving users control over important aspects.

## Control Patterns

### Pattern 1: Progressive Disclosure

**Concept:** Start simple, reveal complexity on demand

**Implementation:**
```markdown
## Quick Start

[Simple overview]

### 🛑 **STOPPING POINT: Want More Details?**

**You can:**
- **A)** Continue with quick start (simple)
- **B)** See detailed guide (comprehensive)
- **C)** Explore advanced options (expert)

**Your choice? (A, B, or C)**
```

**When to use:**
- Complex skills with multiple levels
- Users with varying expertise
- Optional advanced features

### Pattern 2: Choice-Driven Workflow

**Concept:** User choices determine workflow path

**Implementation:**
```markdown
### 🛑 **STOPPING POINT: Workflow Selection**

**What do you want to accomplish?**

**Option 1: [Goal 1]**
- Path: [Steps]
- Time: [Estimate]
- Complexity: [Level]

**Option 2: [Goal 2]**
- Path: [Steps]
- Time: [Estimate]
- Complexity: [Level]

**Your choice? (1 or 2)**
```

**When to use:**
- Multiple valid approaches
- Different user goals
- Varying complexity needs

### Pattern 3: Approval Gates

**Concept:** User must approve before proceeding

**Implementation:**
```markdown
### 🛑 **STOPPING POINT: Approval Required**

**I'm ready to:**
- [Action 1]
- [Action 2]

**This will:**
- [Effect 1]
- [Effect 2]

**Review the plan:**
[Plan summary]

**Approve? (yes/no)**
```

**When to use:**
- Potentially disruptive actions
- Irreversible changes
- High-stakes operations

### Pattern 4: Configuration Control

**Concept:** User controls all configuration

**Implementation:**
```markdown
### 🛑 **STOPPING POINT: Configuration**

**Default Configuration:**
- [Setting 1]: [Default]
- [Setting 2]: [Default]

**Options:**
1. Use defaults
2. Customize all
3. Customize specific settings

**Your choice? (1, 2, or 3)**
```

**When to use:**
- Multiple configuration options
- User preferences matter
- Different environments

### Pattern 5: Review & Refine

**Concept:** User reviews and refines before final execution

**Implementation:**
```markdown
### 🛑 **STOPPING POINT: Review & Refine**

**Here's what I've prepared:**

[Summary of work]

**You can:**
1. Proceed as-is
2. Refine [specific aspect]
3. Review details first
4. Start over

**Your choice? (1, 2, 3, or 4)**
```

**When to use:**
- Complex outputs
- User wants to verify
- Multiple refinement options

### Pattern 6: Branching Decisions

**Concept:** Decisions create workflow branches

**Implementation:**
```markdown
### 🛑 **STOPPING POINT: Decision Branch**

**Your choice determines the path:**

**If you choose A:**
- [Path A steps]
- [Outcome A]

**If you choose B:**
- [Path B steps]
- [Outcome B]

**Your choice? (A or B)**
```

**When to use:**
- Mutually exclusive paths
- Different outcomes needed
- Conditional workflows

## Control Levels

### Minimal Control (2-3 stopping points)
- Simple workflows
- Low-risk operations
- Clear, single path

**Example:** Basic file operations

### Moderate Control (5-7 stopping points)
- Standard workflows
- Some options
- Multiple phases

**Example:** Code review process

### Full Control (10+ stopping points)
- Complex workflows
- Many options
- High-stakes operations

**Example:** Production deployment

## Control Over Different Aspects

### 1. Structure Control

**Let users choose:**
- Skill complexity
- Number of sections
- Detail level

### 2. Workflow Control

**Let users choose:**
- Workflow path
- Step order
- Which steps to include

### 3. Tool Control

**Let users choose:**
- Which tools to use
- Tool configuration
- Tool alternatives

### 4. Output Control

**Let users choose:**
- Output format
- Detail level
- What to include

### 5. Timing Control

**Let users choose:**
- When to proceed
- When to pause
- When to stop

## Best Practices

### ✅ DO

1. **Ask Early**: Get user input before major decisions
2. **Explain Why**: Help users understand choices
3. **Show Consequences**: What happens with each choice
4. **Provide Defaults**: But let users override
5. **Respect Choices**: Never override user decisions

### ❌ DON'T

1. **Don't Assume**: Always ask
2. **Don't Override**: Never change user choices
3. **Don't Skip**: Include stopping points
4. **Don't Overwhelm**: Too many choices confuse
5. **Don't Auto-Execute**: Always get approval

## Control Checklist

For user control:
- [ ] Stopping points at key decisions
- [ ] Clear options presented
- [ ] Consequences explained
- [ ] User choices respected
- [ ] No assumptions made
- [ ] Progressive disclosure used
- [ ] Approval gates for risky actions

## Examples

See `assets/stopping-point-examples.md` for complete examples of these patterns.

