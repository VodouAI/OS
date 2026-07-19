# Stopping Points Guide

## Overview

Stopping points are **MANDATORY** for user control. They pause execution and ask for user input before proceeding.

## Why Stopping Points Matter

**Without Stopping Points:**
- AI assumes what users want
- No control over workflow direction
- Risk of unwanted actions
- Poor user experience

**With Stopping Points:**
- Users maintain control
- Clear decision points
- Safe execution
- Better outcomes

## Stopping Point Types

### 1. Path Selection

**When to use:** Multiple valid approaches exist

**Format:**
```markdown
### 🛑 **STOPPING POINT: Choose Your Approach**

**How would you like to proceed?**

**Option 1: [Approach Name]**
- [Description]
- [Pros]
- [Cons]

**Option 2: [Approach Name]**
- [Description]
- [Pros]
- [Cons]

**Option 3: [Approach Name]**
- [Description]
- [Pros]
- [Cons]

**Your choice? (1, 2, or 3)**
```

**Example:**
```markdown
### 🛑 **STOPPING POINT: Deployment Strategy**

**How would you like to deploy?**

**Option 1: Quick Deploy**
- Deploy immediately with defaults
- Fastest option
- Less control

**Option 2: Configured Deploy**
- Review and configure first
- More control
- Takes longer

**Option 3: Custom Deploy**
- Full customization
- Maximum control
- Most time

**Your choice? (1, 2, or 3)**
```

### 2. Confirmation

**When to use:** Before potentially disruptive actions

**Format:**
```markdown
### 🛑 **STOPPING POINT: Confirm Action**

**I'm about to:**
- [Action 1]
- [Action 2]
- [Action 3]

**This will:**
- [Effect 1]
- [Effect 2]

**Proceed? (yes/no)**
```

**Example:**
```markdown
### 🛑 **STOPPING POINT: Confirm Database Migration**

**I'm about to:**
- Run database migration
- Update schema
- Modify existing data

**This will:**
- Change database structure
- Require application restart
- Potentially affect running services

**Proceed? (yes/no)**
```

### 3. Input Required

**When to use:** User must provide information

**Format:**
```markdown
### 🛑 **STOPPING POINT: Input Required**

**I need the following information:**

1. **[Field 1]**: [Description]
   - [Example or format]

2. **[Field 2]**: [Description]
   - [Example or format]

**Please provide:**
- [Field 1]: [your value]
- [Field 2]: [your value]
```

**Example:**
```markdown
### 🛑 **STOPPING POINT: Configuration Required**

**I need the following information:**

1. **Database URL**: Connection string for your database
   - Format: `postgresql://user:pass@host:port/dbname`
   - Example: `postgresql://admin:secret@localhost:5432/mydb`

2. **Environment**: Target environment
   - Options: development, staging, production

**Please provide:**
- Database URL: [your value]
- Environment: [your value]
```

### 4. Decision Points

**When to use:** Choices affect workflow direction

**Format:**
```markdown
### 🛑 **STOPPING POINT: Decision Required**

**Your decision will determine the next steps:**

**Question:** [What needs to be decided?]

**Options:**
- **A)** [Option A] → [What happens next]
- **B)** [Option B] → [What happens next]
- **C)** [Option C] → [What happens next]

**Your choice? (A, B, or C)**
```

**Example:**
```markdown
### 🛑 **STOPPING POINT: Testing Strategy**

**Your decision will determine the next steps:**

**Question:** How comprehensive should testing be?

**Options:**
- **A)** Quick test → Run basic tests only (2 minutes)
- **B)** Standard test → Run full test suite (10 minutes)
- **C)** Comprehensive test → Full suite + integration tests (30 minutes)

**Your choice? (A, B, or C)**
```

### 5. Review Points

**When to use:** User should review before proceeding

**Format:**
```markdown
### 🛑 **STOPPING POINT: Review Results**

**Here's what I found:**

[Results summary]

**Next steps:**
- [Option 1]
- [Option 2]
- [Option 3]

**How would you like to proceed?**
```

**Example:**
```markdown
### 🛑 **STOPPING POINT: Review Analysis**

**Here's what I found:**

**Security Issues:** 3 high, 5 medium, 12 low
**Performance Issues:** 2 critical, 8 warnings
**Code Quality:** 15 suggestions

**Next steps:**
- Fix high-priority security issues
- Address critical performance problems
- Review code quality suggestions

**How would you like to proceed?**
1. Fix all high-priority issues
2. Review each issue individually
3. Generate detailed report first
4. Skip to next phase

**Your choice? (1, 2, 3, or 4)**
```

## Stopping Point Placement

### Mandatory Locations

1. **After Initial Analysis**
   - Present findings
   - Ask for direction

2. **Before Disruptive Actions**
   - File modifications
   - Database changes
   - System configuration
   - Deployment

3. **At Decision Branches**
   - Multiple valid paths
   - User preference matters

4. **When Input Required**
   - Configuration needed
   - User data required
   - Choices needed

### Optional Locations

1. **After Major Phases**
   - Review progress
   - Confirm continuation

2. **Before Complex Operations**
   - Explain what will happen
   - Get approval

3. **At Review Points**
   - Show results
   - Get feedback

## Best Practices

### ✅ DO

1. **Be Clear**: Explain what's happening
2. **Provide Context**: Why this decision matters
3. **Show Options**: Present all valid choices
4. **Explain Consequences**: What happens with each choice
5. **Use Consistent Format**: Same format throughout skill
6. **Wait for Response**: Never proceed without user input

### ❌ DON'T

1. **Don't Assume**: Never proceed without asking
2. **Don't Overwhelm**: Too many options confuse
3. **Don't Be Vague**: Clear questions get clear answers
4. **Don't Skip**: Every skill needs stopping points
5. **Don't Auto-Execute**: Always ask first

## Stopping Point Checklist

For each stopping point:
- [ ] Clear question or decision
- [ ] All options presented
- [ ] Consequences explained
- [ ] Format consistent
- [ ] User must respond
- [ ] Response determines next step

## Examples

See `assets/stopping-point-examples.md` for complete examples.

