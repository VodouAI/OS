---
name: code-review
description: Structured code review workflow with parallel automated analysis using security scans, quality checks, test coverage, and pattern consistency
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - "code review"
  - "review code"
  - "review changes"
  - "review pull request"
  - "review this code"
  - "code review for [feature]"
  - "pre-commit review"
stopping_points: required
actions: none
imported_from:
  source: hand-written
---

# Vodou Code Review - Parallel Automated Code Review

## Overview

This skill provides **structured code review workflows** enhanced by Vodou's parallel execution. Instead of manual sequential review, Vodou runs security scans, quality checks, test analysis, and pattern matching simultaneously to provide comprehensive review feedback in seconds.

**The Innovation**: Manual review checklist + parallel automated analysis = faster, more comprehensive reviews.

**Based on**: Superpowers' `requesting-code-review` workflow, enhanced with Vodou's parallel execution.

---

## Code Review Workflow

### Step 1: Pre-Review Analysis (Parallel)

**⏸️ STOPPING POINT - Confirm Review Scope**

Before starting review, confirm scope:

**"I'll review [files/changes/feature]. Should I:**
1. **Review specific files** (list files)
2. **Review recent changes** (git diff)
3. **Review entire feature** (feature branch)
4. **Review against plan** (if implementation plan exists)

**Which scope should I review?"**

### Parallel Analysis Execution

**Run all analyses simultaneously:**

```bash
./do "cpu memory disk"
git diff --stat
cargo clippy 2>/dev/null || npm run lint 2>/dev/null || true
grep -nE "security|auth|TODO|FIXME" .vodou/workspace/MEMORY.md 2>/dev/null || true
```

**What this drives:** host health, diff scope, linters/typecheck from **your** toolchain, and **Vodou memory** for past review notes. Core ship has no narsil/in-memoria MCP.

**Result:** Parallel where you wire multiple `oi` / CI steps; static analysis is local tools + memory context.

---

## Step 2: Review Categories

### Category 1: Security Issues (CRITICAL)

**Priority**: Must fix before merge

**Checks:**
- OWASP Top 10 vulnerabilities
- CWE Top 25 issues
- Injection vulnerabilities
- Authentication/authorization issues
- Sensitive data exposure

**Example Output:**
```json
{
  "severity": "critical",
  "issue": "SQL injection vulnerability in user authentication",
  "file": "src/auth/login.ts",
  "line": 45,
  "recommendation": "Use parameterized queries"
}
```

**⏸️ STOPPING POINT**: 
- Critical security issues found: [count]
- Should I block merge? (yes/no)
- Or provide fix suggestions? (yes/no)

---

### Category 2: Code Quality (HIGH)

**Priority**: Should fix before merge

**Checks:**
- Dead code
- Type errors
- Code complexity
- Maintainability issues
- Code smells

**Example Output:**
```json
{
  "severity": "high",
  "issue": "Dead code: unused function 'oldAuthMethod'",
  "file": "src/auth/legacy.ts",
  "line": 12,
  "recommendation": "Remove unused function"
}
```

**⏸️ STOPPING POINT**:
- Code quality issues found: [count]
- Should I provide fix suggestions? (yes/no)

---

### Category 3: Pattern Consistency (MEDIUM)

**Priority**: Consider fixing

**Checks:**
- Pattern consistency with codebase
- Similar code for duplication
- Naming conventions
- Architecture violations

**Example Output:**
```json
{
  "severity": "medium",
  "issue": "Inconsistent pattern: Uses Factory instead of existing Builder pattern",
  "file": "src/services/user-service.ts",
  "recommendation": "Follow existing Builder pattern (used 1,800 times in codebase)"
}
```

**⏸️ STOPPING POINT**:
- Pattern inconsistencies found: [count]
- Should I suggest pattern alignment? (yes/no)

---

### Category 4: Test Coverage (MEDIUM)

**Priority**: Consider adding tests

**Checks:**
- Test coverage for new code
- Missing test scenarios
- Test quality
- Test patterns

**Example Output:**
```json
{
  "severity": "medium",
  "issue": "No tests for new authentication function",
  "file": "src/auth/new-auth.ts",
  "recommendation": "Add tests following TDD workflow"
}
```

---

### Category 5: Documentation (LOW)

**Priority**: Nice to have

**Checks:**
- Missing documentation
- Incomplete comments
- API documentation

---

## Step 3: Review Report Generation

### Structured Review Report

**Format:**
```json
{
  "review_summary": {
    "files_reviewed": 5,
    "total_issues": 12,
    "critical": 1,
    "high": 3,
    "medium": 5,
    "low": 3
  },
  "critical_issues": [
    {
      "severity": "critical",
      "category": "security",
      "issue": "...",
      "file": "...",
      "line": 45,
      "recommendation": "..."
    }
  ],
  "high_priority": [...],
  "medium_priority": [...],
  "low_priority": [...],
  "recommendations": [
    "Fix critical security issue before merge",
    "Remove dead code in legacy.ts",
    "Add tests for new authentication"
  ]
}
```

**⏸️ STOPPING POINT**: 
- Review complete. Issues found: [count]
- **Critical**: [count] (must fix)
- **High**: [count] (should fix)
- **Medium**: [count] (consider fixing)
- **Low**: [count] (nice to have)

**Next steps:**
1. Fix critical issues
2. Address high priority issues
3. Review medium priority
4. Approve merge

---

## Review Against Implementation Plan

### If Plan Exists

**Compare code against plan:**

```bash
./do "compare implementation with plan for [feature]"
grep -n "[feature]\\|plan" .vodou/workspace/MEMORY.md 2>/dev/null || true
```

**Checks:**
- ✅ All planned features implemented
- ✅ Implementation follows plan structure
- ✅ No unplanned features added
- ✅ Code matches plan specifications

---

## Advanced Review Patterns

### Pattern 1: Pre-Commit Review

```bash
# Review before committing
./do "pre-commit review"
# → Runs all checks in parallel
# → Blocks commit if critical issues found
# → Provides fix suggestions
```

### Pattern 2: Feature Branch Review

```bash
# Review entire feature branch
./do "review feature branch authentication"
# → Analyzes all files in feature
# → Compares with main branch
# → Checks for conflicts
```

### Pattern 3: Incremental Review

```bash
# Review as you code
./do "review current changes"
# → Analyzes uncommitted changes
# → Provides immediate feedback
# → Suggests improvements
```

---

## Integration with Vodou Tools

### Vodou memory + toolchain
- **Memory**: decisions and past reviews in MEMORY.md / daily logs
- **Tools**: `rg`, git, cargo/npm/python linters, audits you configure

### Parallel Execution
- All analyses run simultaneously
- 3-7x faster than sequential review
- Comprehensive feedback in seconds

---

## Review Checklist (Automated)

### Automated Checks
- ✅ Security vulnerabilities
- ✅ Dead code
- ✅ Type errors
- ✅ Dependencies
- ✅ Circular dependencies
- ✅ Code patterns
- ✅ Test coverage
- ✅ Code metrics

### Manual Checks (AI Guides)
- ⚠️ Code readability
- ⚠️ Business logic correctness
- ⚠️ Performance considerations
- ⚠️ User experience impact

---

## Best Practices

### 1. Review Early and Often
- Review before committing
- Review after each feature
- Don't wait for PR

### 2. Fix Critical Issues First
- Security issues block merge
- High priority issues should be fixed
- Medium/low can be addressed later

### 3. Use Parallel Analysis
- Leverage Vodou's parallel execution
- Get comprehensive feedback quickly
- Don't wait for sequential checks

### 4. Follow Codebase Patterns
- Check MEMORY.md and match existing module patterns (`rg`, IDE)

### 5. Provide Actionable Feedback
- Specific issues with file/line
- Clear recommendations
- Prioritized by severity

---

## Quick Reference

```bash
# Review specific files
./do "code review files: src/auth/login.ts, src/auth/logout.ts"

# Review recent changes
./do "review changes"

# Review feature
./do "code review for user authentication"

# Pre-commit review
./do "pre-commit review"
```

---

## Troubleshooting

### "Review takes too long"
- Use Vodou's parallel execution
- Review smaller chunks
- Focus on critical issues first

### "Too many issues found"
- Prioritize by severity
- Fix critical first
- Address high priority
- Medium/low can wait

### "Issues not relevant"
- Review is automated - use judgment
- Focus on actionable issues
- Ignore false positives

---

**Remember**: Code review is about quality and safety. Vodou makes it faster and more comprehensive, but human judgment is still essential.

