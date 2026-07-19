# Stopping Point Examples

Complete examples of different stopping point patterns.

## Example 1: Path Selection

```markdown
### 🛑 **STOPPING POINT: Deployment Strategy**

**How would you like to deploy your application?**

**Option 1: Quick Deploy**
- Deploy immediately with default settings
- Fastest option (2 minutes)
- Less control over configuration
- Best for: Development/testing environments

**Option 2: Configured Deploy**
- Review and customize settings first
- More control over deployment
- Takes longer (10 minutes)
- Best for: Staging environments

**Option 3: Custom Deploy**
- Full customization of all settings
- Maximum control
- Most time (20+ minutes)
- Best for: Production deployments

**Your choice? (1, 2, or 3)**
```

## Example 2: Confirmation

```markdown
### 🛑 **STOPPING POINT: Confirm Database Migration**

**I'm about to execute a database migration that will:**

**Actions:**
- Create new tables: `users`, `sessions`, `preferences`
- Modify existing table: `accounts` (add 3 columns)
- Drop deprecated table: `old_logs`

**This will:**
- Change your database schema
- Require application restart
- Potentially affect running services
- Take approximately 5 minutes

**Current database:** `production_db`
**Backup created:** `backup_2024_01_15_143022.sql`

**Proceed with migration? (yes/no)**
```

## Example 3: Input Required

```markdown
### 🛑 **STOPPING POINT: Configuration Required**

**I need the following information to proceed:**

**1. Database Connection:**
   - Format: `postgresql://user:password@host:port/database`
   - Example: `postgresql://admin:secret@localhost:5432/mydb`
   - Current: [Not set]

**2. Target Environment:**
   - Options: `development`, `staging`, `production`
   - Current: [Not set]

**3. Deployment Region:**
   - Options: `us-east-1`, `us-west-2`, `eu-west-1`
   - Current: [Not set]

**Please provide:**
- Database Connection: [your value]
- Target Environment: [your value]
- Deployment Region: [your value]

**Or type 'skip' to use defaults (not recommended for production)**
```

## Example 4: Decision Point

```markdown
### 🛑 **STOPPING POINT: Testing Strategy**

**Your choice will determine the testing approach:**

**Question:** How comprehensive should the testing be?

**Option A: Quick Test**
- Run basic unit tests only
- Time: ~2 minutes
- Coverage: Core functionality
- Best for: Quick validation

**Option B: Standard Test**
- Run full test suite
- Time: ~10 minutes
- Coverage: All functionality
- Best for: Regular development

**Option C: Comprehensive Test**
- Full test suite + integration tests
- Time: ~30 minutes
- Coverage: Everything + edge cases
- Best for: Pre-deployment validation

**Your choice? (A, B, or C)**
```

## Example 5: Review Point

```markdown
### 🛑 **STOPPING POINT: Review Analysis Results**

**Here's what I found during the analysis:**

**Security Issues:**
- 🔴 High: 3 issues (SQL injection risk, XSS vulnerability, weak encryption)
- 🟡 Medium: 5 issues (deprecated APIs, missing validation)
- 🟢 Low: 12 issues (code style, minor improvements)

**Performance Issues:**
- 🔴 Critical: 2 issues (N+1 queries, memory leak)
- 🟡 Warning: 8 issues (slow endpoints, inefficient loops)

**Code Quality:**
- 15 suggestions for improvement
- 5 deprecated patterns found
- 3 potential bugs identified

**Next Steps Available:**
1. **Fix High-Priority Issues** - Address security and critical performance issues first
2. **Review Each Issue Individually** - Go through each issue one by one
3. **Generate Detailed Report** - Create comprehensive report for review
4. **Skip to Next Phase** - Continue workflow without fixes
5. **Custom Selection** - Choose specific issues to address

**How would you like to proceed? (1, 2, 3, 4, or 5)**
```

## Example 6: Progressive Disclosure

```markdown
### 🛑 **STOPPING POINT: Detail Level**

**I can provide information at different levels of detail:**

**Option 1: Quick Overview**
- High-level summary
- Key points only
- Time: 30 seconds
- Best for: Quick understanding

**Option 2: Standard Details**
- Comprehensive explanation
- Examples included
- Time: 2 minutes
- Best for: Most use cases

**Option 3: Deep Dive**
- Complete analysis
- Multiple examples
- Best practices
- Time: 5+ minutes
- Best for: Learning or complex scenarios

**Which level of detail would you like? (1, 2, or 3)**
```

## Example 7: Multi-Choice with Consequences

```markdown
### 🛑 **STOPPING POINT: Optimization Strategy**

**Choose your optimization approach. Each has different trade-offs:**

**Option 1: Aggressive Optimization**
- Maximum performance gains
- More time required (2 hours)
- May require code changes
- Risk: Medium (could break things)
- Best for: Performance-critical applications

**Option 2: Conservative Optimization**
- Safe, incremental improvements
- Less time (30 minutes)
- Minimal code changes
- Risk: Low (very safe)
- Best for: Stable production systems

**Option 3: Balanced Optimization**
- Good performance gains
- Moderate time (1 hour)
- Some code changes
- Risk: Low-Medium
- Best for: Most applications

**Option 4: Custom Strategy**
- You choose specific optimizations
- Time varies
- Changes vary
- Risk varies
- Best for: Specific needs

**Your choice? (1, 2, 3, or 4)**
```

## Example 8: Conditional Stopping Point

```markdown
### Step 1: Initial Check
./do "check system status"

# [Only show this stopping point if issues are found]

### 🛑 **STOPPING POINT: Issues Detected**

**I found the following issues:**

[Issue list]

**How would you like to proceed?**

**Option 1: Fix Issues Now**
- Address all issues immediately
- Workflow continues after fixes
- Time: Varies by issue count

**Option 2: Continue Anyway**
- Proceed with workflow
- Issues remain unresolved
- May cause problems later

**Option 3: Review Details First**
- See detailed information about each issue
- Then decide how to proceed
- More time but better decisions

**Your choice? (1, 2, or 3)**
```

## Best Practices from Examples

1. **Clear Options**: Each option is distinct and understandable
2. **Context Provided**: Users understand what each choice means
3. **Consequences Shown**: Users know what happens with each choice
4. **Time Estimates**: Users know how long each option takes
5. **Risk Levels**: Users understand potential issues
6. **Use Cases**: Users know when each option is best
7. **Consistent Format**: Same structure throughout

## Using These Examples

1. Copy the pattern that fits your need
2. Customize for your specific skill
3. Test with real users
4. Refine based on feedback
5. Iterate and improve

