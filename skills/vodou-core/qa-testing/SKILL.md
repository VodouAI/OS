---
name: qa-testing
description: Comprehensive QA testing workflow that validates projects through browser audits, accessibility, performance, console errors, and system health checks
required_tools: ["vodou-mac-control", "mcp-monitor"]
version: 1.0.0
kind: workflow
trigger_phrases:
  - "qa testing"
  - "test my project"
  - "quality assurance"
  - "run qa checks"
  - "qa for [project]"
  - "test project quality"
  - "comprehensive testing"
  - "validate project"
stopping_points: required
actions: actions.json
imported_from:
  source: hand-written
---

# Vodou QA Testing - Comprehensive Project Quality Assurance

## Overview

This skill provides **comprehensive QA testing workflows** for projects, using Vodou's parallel execution to run tests, security scans, performance checks, and quality validations simultaneously. Instead of running checks sequentially, Vodou executes all QA dimensions in parallel for faster, more thorough validation.

**The Innovation**: Manual QA checklist + parallel automated testing = faster, more comprehensive quality assurance.

**Perfect For**: Engineers and developers who need to validate their projects before deployment, releases, or code reviews.

---

## QA Testing Workflow

### Step 1: Understand Testing Scope

**⏸️ STOPPING POINT - Confirm QA Scope**

Before starting QA, confirm what needs to be tested:

**"I'll run comprehensive QA testing on your project. What should I focus on?**
1. **Full QA suite** (tests, security, performance, quality)
2. **Quick validation** (essential checks only)
3. **Specific area** (tests only, security only, performance only)
4. **Pre-deployment** (complete validation before release)

**Which scope should I use?"**

### Step 2: Parallel QA Analysis

**Run all QA checks simultaneously:**

```bash
# Parallel checks you actually ship: host + browser (Chrome DevTools) + audits (browser-tools) + tests/scripts
./do "cpu memory disk"
./do "run tests"
# Browser: navigate / snapshot / screenshot / console / network via chrome-devtools MCP
./vodou-core call chrome-devtools navigate_page '{"type":"url","url":"http://localhost:8765"}'
./vodou-core call chrome-devtools list_console_messages '{}'
./vodou-core call chrome-devtools list_network_requests '{}'
# Audits (if browser-tools-stdio connected): runAccessibilityAudit, runPerformanceAudit, etc.
```

**Project memory (baked in):** prior QA notes and decisions surface on Vodou prompts; persist with `./do "log: …"`. There is no bundled narsil/in-memoria codebase MCP in core ship—use your linters, `rg`, and CI in the terminal.

**Result**: Host + browser + audit tools in parallel where connected; static analysis is your toolchain + memory context.

---

## QA Testing Categories

### Category 1: Test Execution (CRITICAL)

**Priority**: Must pass before deployment

**Checks:**
- Unit tests
- Integration tests
- End-to-end tests
- Test coverage
- Test performance

**Example Commands:**
```bash
# Run all tests
./do "run tests"

# Run tests with coverage
./do "run tests with coverage"

# Run specific test suite
./do "run unit tests"
./do "run integration tests"
./do "run e2e tests"
```

**⏸️ STOPPING POINT**: 
- Tests passing: [count] / [total]
- Test coverage: [percentage]
- Failed tests: [list]
- Should I investigate failures? (yes/no)

---

### Category 2: Security Testing (CRITICAL)

**Priority**: Must pass before deployment

**Checks:**
- OWASP Top 10 vulnerabilities
- CWE Top 25 issues
- Injection vulnerabilities
- Authentication/authorization issues
- Dependency vulnerabilities
- Sensitive data exposure

**Example Commands:**
```bash
# Use your stack: cargo audit, npm audit, trivy, bandit, etc.
cargo audit
npm audit --production
# Plus Vodou memory: search MEMORY.md / memory/*.md for past security notes
```

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
- High priority issues: [count]
- Should I block deployment? (yes/no)
- Or provide fix suggestions? (yes/no)

---

### Category 3: Code Quality (HIGH)

**Priority**: Should pass before deployment

**Checks:**
- Dead code
- Type errors
- Code complexity
- Maintainability issues
- Code smells
- Circular dependencies

**Example Commands:**
```bash
cargo clippy
cargo check
rg -n "TODO|FIXME|unreachable!" src/
```

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

### Category 4: Performance Testing (MEDIUM)

**Priority**: Consider before deployment

**Checks:**
- Performance bottlenecks
- Memory leaks
- CPU usage
- Response times
- Resource utilization

**Example Commands:**
```bash
./do "cpu memory disk"
./vodou-core call browser-tools-stdio runPerformanceAudit '{}'
```

**⏸️ STOPPING POINT**:
- Performance issues found: [count]
- Should I provide optimization suggestions? (yes/no)

---

### Category 5: Pattern Consistency (MEDIUM)

**Priority**: Consider fixing

**Checks:**
- Pattern consistency with codebase
- Similar code for duplication
- Naming conventions
- Architecture violations

**Example Commands:**
```bash
rg -n "duplicate|copy.paste" src/
# Vodou memory: grep .vodou/workspace/MEMORY.md for architecture/pattern decisions
```

**⏸️ STOPPING POINT**:
- Pattern inconsistencies found: [count]
- Should I suggest pattern alignment? (yes/no)

---

## Step 3: QA Report Generation

### Structured QA Report

**Format:**
```json
{
  "qa_summary": {
    "tests_passed": 245,
    "tests_failed": 3,
    "test_coverage": 87.5,
    "security_issues": {
      "critical": 1,
      "high": 3,
      "medium": 5,
      "low": 2
    },
    "code_quality_issues": 12,
    "performance_issues": 2,
    "pattern_inconsistencies": 4,
    "overall_status": "needs_attention"
  },
  "critical_issues": [
    {
      "category": "security",
      "severity": "critical",
      "issue": "...",
      "file": "...",
      "line": 45,
      "recommendation": "..."
    }
  ],
  "test_results": {
    "unit_tests": {"passed": 180, "failed": 2},
    "integration_tests": {"passed": 45, "failed": 1},
    "e2e_tests": {"passed": 20, "failed": 0}
  },
  "recommendations": [
    "Fix critical security issue before deployment",
    "Address 2 failing unit tests",
    "Remove dead code in legacy.ts",
    "Improve test coverage to 90%+"
  ]
}
```

**⏸️ STOPPING POINT**: 
- QA complete. Overall status: [pass/warning/fail]
- **Critical**: [count] (must fix)
- **High**: [count] (should fix)
- **Medium**: [count] (consider fixing)
- **Low**: [count] (nice to have)

**Next steps:**
1. Fix critical issues
2. Address high priority issues
3. Review medium priority
4. Approve deployment

---

## QA Testing Patterns

### Pattern 1: Pre-Deployment QA

```bash
# Complete QA before deployment
./do "qa testing"
# → Runs all checks in parallel
# → Blocks deployment if critical issues found
# → Provides comprehensive report
```

### Pattern 2: Quick Validation

```bash
# Quick QA check
./do "quick qa"
# → Runs essential checks only
# → Fast feedback (1-2 seconds)
# → Focuses on critical issues
```

### Pattern 3: Continuous QA

```bash
# QA as you develop
./do "qa current changes"
# → Analyzes uncommitted changes
# → Provides immediate feedback
# → Suggests improvements
```

### Pattern 4: Targeted QA

```bash
# QA specific area
./do "qa security"
./do "qa tests"
./do "qa performance"
# → Focuses on specific category
# → Faster execution
# → Detailed analysis
```

---

## Integration with Vodou Tools

### chrome-devtools
- Navigate, snapshot, screenshot, console messages, network requests (attached Chrome)

### browser-tools-stdio
- Lighthouse-style audits (accessibility, performance, SEO, best practices) when connected

### Vodou memory (core)
- Retrieval on prompt; durable notes in MEMORY.md / daily logs; `./do "log:"` for handoff

### Parallel Execution
- All QA checks run simultaneously
- 3-7x faster than sequential QA
- Comprehensive feedback in seconds

---

## QA Checklist (Automated)

### Automated Checks
- ✅ Test execution and coverage
- ✅ Security vulnerabilities
- ✅ Dead code
- ✅ Type errors
- ✅ Dependencies
- ✅ Circular dependencies
- ✅ Code patterns
- ✅ Code metrics
- ✅ Performance indicators

### Manual Checks (AI Guides)
- ⚠️ User experience testing
- ⚠️ Business logic validation
- ⚠️ Edge case handling
- ⚠️ Documentation completeness

---

## Best Practices

### 1. Run QA Early and Often
- QA before committing
- QA after each feature
- QA before deployment
- Don't wait for release

### 2. Fix Critical Issues First
- Security issues block deployment
- Failing tests block deployment
- High priority issues should be fixed
- Medium/low can be addressed later

### 3. Use Parallel Analysis
- Leverage Vodou's parallel execution
- Get comprehensive feedback quickly
- Don't wait for sequential checks

### 4. Follow Codebase Patterns
- Check Vodou memory (MEMORY.md) and `rg` for pattern consistency
- Maintain consistency
- Follow existing conventions

### 5. Track QA Over Time
- Monitor test coverage trends
- Track security issue resolution
- Measure code quality improvements
- Use QA metrics for project health

---

## Quick Reference

```bash
# Full QA testing
./do "qa testing"
./do "test my project"
./do "quality assurance"

# Quick validation
./do "quick qa"
./do "validate project"

# Targeted QA
./do "qa security"
./do "qa tests"
./do "qa performance"

# Pre-deployment
./do "qa before deployment"
./do "pre-deployment qa"
```

---

## Troubleshooting

### "QA takes too long"
- Use Vodou's parallel execution
- Run targeted QA for specific areas
- Focus on critical issues first

### "Too many issues found"
- Prioritize by severity
- Fix critical first
- Address high priority
- Medium/low can wait

### "Tests are failing"
- Review test output
- Check test environment
- Verify test data
- Use systematic debugging skill

### "Security issues unclear"
- Review detailed security reports
- Check OWASP/CWE references
- Use code review skill for context
- Consult security documentation

---

## Example Workflows

### Example 1: Pre-Deployment QA

**User**: `./do "qa testing"`

**AI Response**:
1. **Running comprehensive QA** (parallel execution)
   - Tests: ✅ 245/248 passing (98.8%)
   - Security: ⚠️ 1 critical, 3 high
   - Code Quality: ✅ 12 issues (low priority)
   - Performance: ✅ No issues
   - Patterns: ✅ Consistent

2. **QA Report**:
   - **Status**: ⚠️ Needs attention (critical security issue)
   - **Critical**: SQL injection vulnerability
   - **High**: 3 security issues, 3 failing tests
   - **Recommendation**: Fix critical security issue before deployment

3. **Next Steps**:
   - Fix SQL injection vulnerability
   - Address 3 failing tests
   - Review high priority security issues

### Example 2: Quick Validation

**User**: `./do "quick qa"`

**AI Response**:
1. **Running essential QA checks** (parallel execution)
   - Tests: ✅ All passing
   - Security: ✅ No critical issues
   - Code Quality: ✅ Acceptable

2. **Status**: ✅ Ready for deployment

### Example 3: Targeted Security QA

**User**: `./do "qa security"`

**AI Response**:
1. **Running security analysis** (parallel execution)
   - OWASP Top 10: ✅ No issues
   - CWE Top 25: ⚠️ 2 issues found
   - Injection: ✅ No vulnerabilities
   - Dependencies: ⚠️ 1 outdated package

2. **Security Report**:
   - **Status**: ⚠️ Needs attention
   - **Issues**: 2 CWE issues, 1 outdated dependency
   - **Recommendation**: Update dependency, review CWE issues

---

**Remember**: QA testing is about confidence and safety. Vodou makes it faster and more comprehensive, ensuring your projects are production-ready.

