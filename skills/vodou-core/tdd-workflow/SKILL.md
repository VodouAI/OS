---
name: tdd-workflow
description: Enforces Test-Driven Development (TDD) with RED-GREEN-REFACTOR cycle, enhanced by Vodou memory, parallel checks, and your project toolchain
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - "tdd workflow"
  - "test driven development"
  - "red green refactor"
  - "tdd for [feature]"
  - "write tests first"
  - "test first development"
  - "tdd cycle"
stopping_points: required
actions: none
imported_from:
  source: hand-written
---

# Vodou TDD Workflow - Test-Driven Development with Parallel Intelligence

## Overview

This skill enforces **Test-Driven Development (TDD)** using the proven RED-GREEN-REFACTOR cycle, enhanced by Vodou's parallel execution and codebase intelligence. Instead of manual sequential testing, Vodou analyzes tests, code, and patterns simultaneously to guide the TDD process.

**The Innovation**: TDD enforcement + parallel test analysis + codebase pattern matching = faster, better TDD.

**Based on**: Superpowers' `test-driven-development` workflow, enhanced with Vodou's parallel execution.

---

## Core TDD Workflow: RED-GREEN-REFACTOR

### The Three Phases

1. **🔴 RED**: Write a failing test first
2. **🟢 GREEN**: Write minimal code to make it pass
3. **🔵 REFACTOR**: Improve code while keeping tests green

**Vodou Enhancement**: Parallel analysis at each phase for faster feedback.

---

## Step 1: RED Phase - Write Failing Test First

### ⏸️ STOPPING POINT - Confirm TDD Approach

Before writing any code, confirm the TDD approach:

**"I'll help you implement [feature] using TDD. This means:**
1. **Write the test first** (it will fail - that's expected)
2. **Run the test** (confirm it fails for the right reason)
3. **Write minimal code** (just enough to pass)
4. **Run the test** (confirm it passes)
5. **Refactor** (improve code while keeping tests green)

**Ready to start with the RED phase?"**

### RED Phase Execution

**1. Analyze Existing Tests (Parallel)**

```bash
# Existing test patterns: rg + Vodou memory (MEMORY.md / daily logs)
rg -n "describe\\(|it\\(|#\\[test\\]" src/ tests/
grep -n "test\\|TDD\\|coverage" .vodou/workspace/MEMORY.md 2>/dev/null || true
```

**What this does:**
- Finds existing test files in parallel
- Understands test patterns used in codebase
- Identifies test structure and conventions
- Ensures consistency with existing tests

**2. Write Failing Test**

Based on analysis, write a test that:
- ✅ Follows existing test patterns
- ✅ Tests the desired behavior
- ✅ Will fail (because code doesn't exist yet)
- ✅ Is specific and clear

**Example:**
```typescript
// RED: Write failing test
describe('User Authentication', () => {
  it('should authenticate user with valid credentials', () => {
    const result = authenticate('user@example.com', 'password123');
    expect(result.success).toBe(true);
    expect(result.user).toBeDefined();
  });
});
```

**3. Run Test and Confirm Failure**

```bash
./do "run tests for [test_file]"
cargo test -p my-crate -- --nocapture   # or npm test / pytest as appropriate
```

**⏸️ STOPPING POINT**: 
- Did the test fail? (yes/no)
- Did it fail for the right reason? (yes/no - if no, fix test)
- Ready to move to GREEN phase? (yes/no)

**Critical**: Test MUST fail before proceeding. If it passes, the test is wrong.

---

## Step 2: GREEN Phase - Write Minimal Code

### GREEN Phase Execution

**1. Analyze What's Needed (Parallel)**

```bash
rg -n "[feature]|similar" src/
grep -n "[feature]" .vodou/workspace/MEMORY.md 2>/dev/null || true
```

**What this does:**
- Understands how similar features are implemented
- Identifies required dependencies
- Suggests implementation approach based on codebase patterns
- Ensures consistency

**2. Write Minimal Code**

**Key Principle**: Write ONLY enough code to make the test pass. Nothing more.

**Example:**
```typescript
// GREEN: Minimal code to pass test
function authenticate(email: string, password: string) {
  // Minimal implementation - just enough to pass
  if (email && password) {
    return { success: true, user: { email } };
  }
  return { success: false };
}
```

**3. Run Test and Confirm Pass**

```bash
./do "run tests for [test_file]"
```

**⏸️ STOPPING POINT**:
- Did the test pass? (yes/no)
- Is the code minimal? (yes/no - if no, remove unnecessary code)
- Ready to move to REFACTOR phase? (yes/no)

**Critical**: Code should be minimal. If it does more than needed, remove it.

---

## Step 3: REFACTOR Phase - Improve Code

### REFACTOR Phase Execution

**1. Analyze Code Quality (Parallel)**

```bash
cargo clippy --tests 2>/dev/null || npm run lint 2>/dev/null || true
grep -n "refactor\\|pattern" .vodou/workspace/MEMORY.md 2>/dev/null || true
```

**What this does:**
- Finds dead code and unused variables
- Identifies similar code patterns for consistency
- Checks for type errors
- Suggests improvements based on codebase patterns

**2. Refactor While Keeping Tests Green**

**Refactoring Principles:**
- ✅ Improve code structure
- ✅ Remove duplication (DRY)
- ✅ Improve readability
- ✅ Follow codebase patterns
- ❌ **NEVER** break existing tests

**3. Verify Tests Still Pass**

```bash
# Run tests after refactoring
./do "run tests for [test_file]"
```

**⏸️ STOPPING POINT**:
- Do all tests still pass? (yes/no - if no, revert refactoring)
- Is code improved? (yes/no)
- Ready to commit? (yes/no)

**Critical**: Tests MUST pass after refactoring. If they fail, revert changes.

---

## Complete TDD Cycle Example

### Scenario: Adding User Authentication

**Step 1: RED - Write Failing Test**
```bash
./do "tdd workflow for user authentication"
# → Analyzes existing auth patterns
# → Suggests test structure
# → Creates failing test
```

**Step 2: Run Test (Confirm Failure)**
```bash
./do "run tests for auth.test.ts"
# → Test fails (expected)
# → Confirms failure reason
```

**Step 3: GREEN - Write Minimal Code**
```bash
# → Analyzes similar implementations
# → Writes minimal auth function
# → Runs test (should pass)
```

**Step 4: REFACTOR - Improve Code**
```bash
# → Analyzes code quality
# → Suggests improvements
# → Refactors while keeping tests green
# → Verifies tests still pass
```

**Step 5: Commit**
```bash
./do "log: feature: Implemented user authentication using TDD | tests_added: 3 | files_changed: 2"
```

---

## Advanced TDD Patterns

### Pattern 1: Parallel Test Analysis

```bash
rg --files -g '*test*' -g '*spec*' .
# Use ./?do "run tests" / CI for parallel execution where configured
```

### Pattern 2: Test Coverage Analysis

```bash
./do "run tests with coverage"
# e.g. cargo llvm-cov, nyc, vitest --coverage
```

### Pattern 3: Test-Driven Refactoring

```bash
# Refactor with test safety net
./do "tdd refactor [feature]"
# → Runs all tests first
# → Analyzes code for refactoring opportunities
# → Refactors incrementally
# → Verifies tests after each change
```

---

## TDD Anti-Patterns to Avoid

### ❌ Writing Code Before Tests
**Problem**: Defeats the purpose of TDD  
**Solution**: Always write test first, confirm it fails

### ❌ Writing Too Much Code in GREEN Phase
**Problem**: Violates YAGNI (You Aren't Gonna Need It)  
**Solution**: Write minimal code - only what's needed to pass test

### ❌ Skipping REFACTOR Phase
**Problem**: Code quality degrades over time  
**Solution**: Always refactor after GREEN phase

### ❌ Breaking Tests During Refactoring
**Problem**: Loses TDD safety net  
**Solution**: Run tests after every refactoring change

### ❌ Writing Tests That Don't Fail
**Problem**: Test might be testing nothing  
**Solution**: Always confirm test fails before writing code

---

## Integration with Vodou Tools

### Vodou memory + toolchain
- **Memory**: prior TDD and testing notes in MEMORY.md / daily logs; retrieved on prompts
- **Search**: `rg`, IDE references, language test runners (`cargo test`, `npm test`, …)

### Parallel Execution
- Analyzes tests, code, and patterns simultaneously
- 3-7x faster feedback than sequential TDD
- Comprehensive analysis in seconds

---

## Best Practices

### 1. Always Start with RED
- Write test first
- Confirm it fails
- Understand why it fails

### 2. Keep GREEN Minimal
- Write only enough code to pass
- Don't add features not in test
- YAGNI principle

### 3. Refactor Regularly
- Improve code after each GREEN phase
- Keep tests passing
- Follow codebase patterns

### 4. Use Parallel Analysis
- Leverage Vodou's parallel execution
- Analyze tests, code, and patterns simultaneously
- Get faster feedback

### 5. Follow Codebase Patterns
- Read MEMORY.md and match existing test layout
- Maintain consistency with `rg` / code review

---

## Quick Reference

```bash
# Start TDD workflow
./do "tdd workflow for [feature]"

# RED phase: Write failing test
./do "write test for [feature]"
./do "run tests"  # Confirm failure

# GREEN phase: Write minimal code
./do "implement [feature] minimally"
./do "run tests"  # Confirm pass

# REFACTOR phase: Improve code
./do "refactor [feature]"
./do "run tests"  # Confirm still passing
```

---

## Troubleshooting

### "Test passes without code"
- Test is not specific enough
- Test might be testing nothing
- Rewrite test to be more specific

### "Can't write minimal code"
- Break feature into smaller pieces
- Write test for smallest piece first
- Build incrementally

### "Refactoring breaks tests"
- Revert refactoring
- Refactor in smaller steps
- Run tests after each change

### "Tests are slow"
- Use Vodou's parallel test execution
- Run tests in parallel when possible
- Optimize test setup/teardown

---

**Remember**: TDD is about discipline and safety. Vodou makes it faster and smarter, but the RED-GREEN-REFACTOR cycle remains the core.

