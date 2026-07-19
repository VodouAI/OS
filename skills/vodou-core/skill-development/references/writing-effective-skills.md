# Writing Effective Skills

## Overview

This guide covers best practices for writing clear, effective, and user-controlled skills.

## Writing Principles

### 1. Clarity First

**Be Specific:**
```markdown
# ❌ BAD
"Use appropriate tools to analyze the code"

# ✅ GOOD
"Use Vodou memory + rg for structure, then Vodou-script-executor to run tests"
```

**Use Active Voice:**
```markdown
# ❌ BAD
"The codebase should be analyzed"

# ✅ GOOD
"Analyze the codebase using your toolchain and Vodou memory"
```

### 2. User Control

**Always Include Stopping Points:**
```markdown
# ❌ BAD
"I'll now install the dependencies and configure the environment."

# ✅ GOOD
### 🛑 **STOPPING POINT: Installation**

**Ready to install dependencies?**

**Options:**
1. Install all dependencies now
2. Review dependency list first
3. Install only production dependencies
4. Skip installation

**Your choice? (1, 2, 3, or 4)**
```

### 3. Real Examples

**All Examples Must Work:**
```markdown
# ❌ BAD
./do "some example that might work"

# ✅ GOOD
./do "cpu memory disk"  # Verified: Works in v0.5.31
```

**Include Context:**
```markdown
# ✅ GOOD
# Check system resources in parallel
./do "cpu memory disk"

# Analyze codebase for security issues
./do "analyze codebase security"
```

### 4. Progressive Disclosure

**Start Simple:**
```markdown
## Quick Start

[Simple overview with basic workflow]

### 🛑 **STOPPING POINT: Want More?**

**You can:**
- **A)** Continue with quick start
- **B)** See detailed guide
- **C)** Explore advanced options

**Your choice? (A, B, or C)**
```

### 5. Clear Structure

**Use Consistent Formatting:**
- Headers for major sections
- Code blocks for commands
- Lists for options
- Bold for emphasis

**Organize Logically:**
- Overview first
- Prerequisites early
- Workflow in order
- Examples at end

## Writing Checklist

### Content
- [ ] Clear purpose stated
- [ ] Target audience identified
- [ ] Value proposition clear
- [ ] All examples work
- [ ] Stopping points included

### Structure
- [ ] Metadata complete
- [ ] Trigger phrases listed
- [ ] Overview clear
- [ ] Workflow logical
- [ ] Examples relevant

### User Control
- [ ] Stopping points at key decisions
- [ ] Options clearly presented
- [ ] Consequences explained
- [ ] No assumptions made

### Quality
- [ ] Tested all examples
- [ ] Proofread for clarity
- [ ] Consistent formatting
- [ ] No typos or errors

## Common Mistakes

### ❌ Don't Do This

1. **Vague Instructions**
   ```markdown
   "Use appropriate tools"
   ```

2. **Missing Stopping Points**
   ```markdown
   "I'll now do X, Y, and Z"
   ```

3. **Untested Examples**
   ```markdown
   oi "some command that might work"
   ```

4. **Assuming User Intent**
   ```markdown
   "I'll proceed with option A"
   ```

5. **Overwhelming Users**
   ```markdown
   [20 options without context]
   ```

### ✅ Do This Instead

1. **Specific Instructions**
   ```markdown
   "Use rg and tests to analyze codebase"
   ```

2. **Include Stopping Points**
   ```markdown
   ### 🛑 **STOPPING POINT: Next Step**
   [Options with context]
   ```

3. **Tested Examples**
   ```markdown
   oi "cpu memory disk"  # Verified working
   ```

4. **Ask User**
   ```markdown
   "How would you like to proceed?"
   ```

5. **Progressive Disclosure**
   ```markdown
   [Start with 3-4 options, reveal more on demand]
   ```

## Style Guide

### Headers
- Use `##` for major sections
- Use `###` for subsections
- Use `####` for sub-subsections

### Code Blocks
- Always specify language: ` ```bash`
- Include comments explaining context
- Show complete, working commands

### Lists
- Use `-` for unordered lists
- Use `1.` for ordered lists
- Use `**Bold**` for emphasis in lists

### Stopping Points
- Always use `### 🛑 **STOPPING POINT: [Name]**`
- Present options clearly
- Always ask for user input

## Next Steps

After writing:
1. Review for clarity
2. Test all examples
3. Verify stopping points
4. Get feedback
5. Refine and improve

