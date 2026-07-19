# Skill Planning Guide

## Overview

Planning is the foundation of a great skill. This guide helps you think through all aspects before writing.

## Planning Questions

### 1. Purpose & Value

**What problem does this skill solve?**
- Be specific: "Help developers optimize React performance" not "React help"
- Identify the pain point: What's frustrating or time-consuming?
- Define success: What does "done" look like?

**Who is it for?**
- Developers? Teams? End users?
- What's their skill level?
- What tools do they already use?

**What makes it valuable?**
- Saves time? How much?
- Adds capability? What?
- Improves quality? How?

### 2. Trigger Phrases

**Natural Language Activation**

Think about how users would naturally ask for this:
- Primary phrase (most specific)
- Common variations
- Alternative phrasings
- Abbreviated versions

**Examples:**
- "react optimization" → Primary
- "optimize react" → Variation
- "react performance" → Alternative
- "react perf" → Abbreviated

**Best Practices:**
- Use 3-5 trigger phrases
- Make them specific (avoid generic words)
- Test with real users if possible

### 3. Complexity Assessment

**Simple Skills:**
- Single workflow
- Few steps (3-5)
- Minimal branching
- 2-3 stopping points
- Examples: Basic setup, simple analysis

**Moderate Skills:**
- Multi-step process
- Some branching
- Multiple tools
- 5-7 stopping points
- Examples: Code review, deployment workflow

**Complex Skills:**
- Multiple workflow paths
- Extensive branching
- Many tools
- Orchestration
- 10+ stopping points
- Examples: Full development lifecycle, complex analysis

### 4. Tool Requirements

**What MCP servers does it need?**
- List specific servers
- Identify required tools
- Consider alternatives

**What Skills might it use?**
- Other skills as dependencies?
- Skills it orchestrates?

**What external resources?**
- Files? APIs? Databases?

### 5. Stopping Point Strategy

**Where do users need control?**

**Mandatory Stopping Points:**
- After initial analysis
- Before potentially disruptive actions
- At decision branches
- When input is required

**Optional Stopping Points:**
- After each major phase
- Before complex operations
- At review points

**Stopping Point Types:**
1. **Path Selection** - Choose workflow direction
2. **Confirmation** - Approve before action
3. **Input Required** - Provide information
4. **Decision Points** - Make choices
5. **Review Points** - Review before proceeding

### 6. Category Decision

**Core Skills** (`oi-` prefix):
- Universal Vodou functionality
- System-level operations
- Official Vodou patterns
- Used by many users

**Community Skills:**
- Domain-specific
- Framework-specific
- Personal productivity
- Experimental

## Planning Template

```markdown
# Skill Planning Document

## Purpose
[What problem does this solve?]

## Target Users
[Who is this for?]

## Value Proposition
[Why is this valuable?]

## Trigger Phrases
1. [Primary]
2. [Variation 1]
3. [Variation 2]
4. [Variation 3]

## Complexity Level
[ ] Simple
[ ] Moderate
[ ] Complex

## Required Tools
- [MCP Server 1] - [Purpose]
- [MCP Server 2] - [Purpose]
- [Skill 1] - [Purpose]

## Stopping Points
1. [Location] - [Type] - [Purpose]
2. [Location] - [Type] - [Purpose]
3. [Location] - [Type] - [Purpose]

## Workflow Outline
1. [Step 1]
   - [Sub-step]
   - [Sub-step]
2. [Step 2]
   - [Sub-step]
   - [Sub-step]

## Examples Needed
- [Example 1] - [Scenario]
- [Example 2] - [Scenario]
- [Example 3] - [Scenario]

## Success Criteria
- [ ] Skill loads correctly
- [ ] All examples work
- [ ] Stopping points function
- [ ] Users can complete workflow
```

## Next Steps

After planning:
1. Review with stakeholders (if applicable)
2. Validate tool availability
3. Test trigger phrases
4. Proceed to structure design

