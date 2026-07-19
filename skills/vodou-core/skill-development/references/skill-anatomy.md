# Skill Anatomy - Complete Structure Reference

## Overview

This guide details every component of an Vodou skill, from metadata to examples.

## Complete Structure

```
SKILL.md
├── YAML Frontmatter (Metadata)
├── Trigger Phrases
├── Overview
├── Core Instructions
│   ├── Prerequisites
│   ├── Workflow Steps
│   ├── Stopping Points
│   └── Advanced Usage
├── Examples
├── Troubleshooting
└── Quick Reference
```

## Component Details

### 1. YAML Frontmatter (Required)

**Location:** Top of file, between `---` markers

**Required Fields:**
```yaml
---
name: skill-name          # Lowercase, hyphens, no spaces
description: Brief desc    # Third-person, <200 chars
---
```

**Optional Fields:**
```yaml
---
name: skill-name
description: Brief desc
version: 1.0.0            # Optional version
author: Your Name          # Optional author
category: core|community   # Optional category
---
```

**Best Practices:**
- Keep name lowercase
- Use hyphens, not underscores
- Description should be clear and concise
- Third-person perspective

### 2. Trigger Phrases Section

**Location:** After metadata, before overview

**Format:**
```markdown
## Trigger Phrases
- "primary trigger phrase"
- "common variation"
- "alternative phrasing"
- "abbreviated version"
```

**Best Practices:**
- 3-5 trigger phrases
- Start with most specific
- Include variations
- Test with real users

### 3. Overview Section

**Location:** After trigger phrases

**Should Include:**
- What the skill does
- Who it's for
- Why it's valuable
- Key benefits

**Format:**
```markdown
## Overview

[2-3 sentences explaining what this skill does and why it's valuable]

**Key Benefits:**
- [Benefit 1]
- [Benefit 2]
- [Benefit 3]
```

### 4. Core Instructions

**Location:** Main content section

**Subsections:**

#### Prerequisites (Optional)
```markdown
## Prerequisites

- [Required setup]
- [Necessary configurations]
- [Expected environment]
```

#### Workflow Steps
```markdown
## Core Workflow

### Step 1: [Step Name]

[Explanation]

```bash
./do "[example command]"
```

### Step 2: [Step Name]

[Explanation]

```bash
./do "[example command]"
```
```

#### Stopping Points
```markdown
### 🛑 **STOPPING POINT: [Name]**

[Question or decision]

**Options:**
- **A)** [Option A]
- **B)** [Option B]

**Your choice? (A or B)**
```

#### Advanced Usage (Optional)
```markdown
## Advanced Usage

### [Advanced Pattern 1]

[Description and example]

### [Advanced Pattern 2]

[Description and example]
```

### 5. Examples Section

**Location:** After core instructions

**Format:**
```markdown
## Examples

### Example 1: [Scenario Name]

```bash
# [Comment explaining scenario]
./do "[complete working example]"
```

### Example 2: [Another Scenario]

```bash
# [Comment explaining this scenario]
./do "[another complete example]"
```
```

**Best Practices:**
- All examples must work
- Include comments explaining context
- Show different scenarios
- Test every example

### 6. Troubleshooting (Optional)

**Location:** After examples

**Format:**
```markdown
## Troubleshooting

### [Common Issue 1]

**Problem:** [Description]

**Solution:** 
```bash
./do "[solution command]"
```

### [Common Issue 2]

**Problem:** [Description]

**Solution:**
```bash
./do "[solution command]"
```
```

### 7. Quick Reference (Optional)

**Location:** End of file

**Format:**
```markdown
## Quick Reference

```bash
# [Most common command]
./do "[command]"

# [Second most common]
./do "[command]"

# [Third most common]
./do "[command]"
```
```

## Structure Variations

### Simple Structure (Basic Skills)
```
1. Metadata
2. Trigger Phrases
3. Overview
4. Core Workflow (3-5 steps)
5. Examples (2-3)
6. Quick Reference
```

### Standard Structure (Most Skills)
```
1. Metadata
2. Trigger Phrases
3. Overview
4. Prerequisites
5. Core Workflow (5-10 steps)
6. Advanced Usage
7. Examples (3-5)
8. Troubleshooting
9. Quick Reference
```

### Advanced Structure (Complex Skills)
```
1. Metadata
2. Trigger Phrases
3. Overview
4. Prerequisites
5. Core Workflow (10+ steps)
6. Multiple Workflow Paths
7. Advanced Patterns
8. Orchestration Directives
9. Examples (5+ scenarios)
10. Best Practices
11. Troubleshooting
12. Quick Reference
```

## Component Checklist

For each skill component:
- [ ] Metadata complete and correct
- [ ] Trigger phrases tested
- [ ] Overview clear and valuable
- [ ] Prerequisites listed (if needed)
- [ ] Workflow steps clear
- [ ] Stopping points included
- [ ] Examples all work
- [ ] Troubleshooting helpful (if included)
- [ ] Quick reference useful (if included)

## Next Steps

After understanding structure:
1. Plan your skill (see `skill-planning-guide.md`)
2. Choose appropriate structure
3. Write each section
4. Test everything
5. Install and verify

