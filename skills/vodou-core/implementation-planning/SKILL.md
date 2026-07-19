---
name: implementation-planning
description: Context-aware implementation planning using Vodou memory, repo search, and your toolchain (no bundled codebase MCP)
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - "implementation plan"
  - "create plan for [feature]"
  - "plan implementation"
  - "break down [feature]"
  - "task breakdown"
  - "implementation tasks"
  - "plan [feature]"
stopping_points: required
actions: none
imported_from:
  source: hand-written
---

# Vodou Implementation Planning - Context-Aware Task Breakdown

## Overview

This skill creates **detailed implementation plans** that break work into bite-sized tasks (2-5 minutes each), enhanced by Vodou's codebase intelligence. Instead of generic task lists, Vodou analyzes existing patterns, dependencies, and architecture to create context-aware plans.

**The Innovation**: Generic planning + codebase intelligence = better, more accurate plans.

**Based on**: Superpowers' `writing-plans` workflow, enhanced with Vodou's codebase intelligence.

---

## Implementation Planning Workflow

### Step 1: Understand Requirements

**⏸️ STOPPING POINT - Confirm Feature Scope**

Before planning, understand what needs to be built:

**"I'll create an implementation plan for [feature]. Let me confirm:**
1. **What is the feature?** (clear description)
2. **What are the requirements?** (functional requirements)
3. **What are the constraints?** (technical, time, resources)
4. **What's the priority?** (high, medium, low)

**Can you describe the feature and requirements?"**

### Step 2: Analyze Codebase Context (Parallel)

**Gather codebase intelligence in parallel:**

```bash
grep -nE "[feature]|architecture|plan" .vodou/workspace/MEMORY.md 2>/dev/null || true
rg -n "struct |impl |fn " src/ 2>/dev/null | head -40
git log -n 15 --oneline
```

**What this gathers:** prior decisions from **Vodou memory**, rough structure from **rg**/git — not a separate in-memoria/narsil server.

---

### Step 3: Create Detailed Task Breakdown

**Break feature into 2-5 minute tasks:**

### Task Structure

Each task includes:
- ✅ **Exact file paths** (where to make changes)
- ✅ **Complete code** (what to write)
- ✅ **Verification steps** (how to verify)
- ✅ **Dependencies** (what needs to be done first)
- ✅ **Pattern to follow** (based on codebase analysis)

### Example Task Breakdown

**Feature: User Authentication**

**Task 1: Create authentication types (2 minutes)**
- **File**: `src/types/auth.ts`
- **Code**: 
  ```typescript
  export interface AuthResult {
    success: boolean;
    user?: User;
    error?: string;
  }
  ```
- **Verification**: TypeScript compiles without errors
- **Dependencies**: None
- **Pattern**: Follow existing type definitions in `src/types/`

**Task 2: Create authentication service (3 minutes)**
- **File**: `src/services/auth-service.ts`
- **Code**: [Based on existing service patterns]
- **Verification**: Service can be instantiated
- **Dependencies**: Task 1 (types)
- **Pattern**: Follow `src/services/user-service.ts` pattern

**Task 3: Write authentication tests (4 minutes)**
- **File**: `src/services/__tests__/auth-service.test.ts`
- **Code**: [Test structure based on existing tests]
- **Verification**: Tests run (will fail - that's expected in TDD)
- **Dependencies**: Task 2 (service)
- **Pattern**: Follow TDD workflow, use existing test patterns

**Task 4: Implement authentication logic (5 minutes)**
- **File**: `src/services/auth-service.ts`
- **Code**: [Implementation to make tests pass]
- **Verification**: Tests pass
- **Dependencies**: Task 3 (tests)
- **Pattern**: Follow existing authentication patterns

**Task 5: Add error handling (3 minutes)**
- **File**: `src/services/auth-service.ts`
- **Code**: [Error handling based on existing patterns]
- **Verification**: Error cases handled correctly
- **Dependencies**: Task 4 (implementation)
- **Pattern**: Follow existing error handling patterns

**⏸️ STOPPING POINT**: 
- Plan created: [X] tasks, estimated [Y] minutes
- Review plan? (yes/no)
- Ready to execute? (yes/no)

---

## Advanced Planning Patterns

### Pattern 1: Pattern-Aware Planning

```bash
# Plan using existing patterns
./do "implementation plan for [feature] using existing patterns"
# → Analyzes similar features
# → Identifies patterns to follow
# → Creates plan that matches codebase style
```

### Pattern 2: Dependency-Aware Planning

```bash
# Plan with dependency analysis
./do "implementation plan for [feature] with dependencies"
# → Analyzes dependencies
# → Orders tasks by dependency
# → Identifies potential conflicts
```

### Pattern 3: Incremental Planning

```bash
# Plan incrementally
./do "plan first phase of [feature]"
# → Breaks large feature into phases
# → Plans first phase in detail
# → Outlines subsequent phases
```

---

## Task Quality Criteria

### Good Tasks Have:
- ✅ **Clear scope** (2-5 minutes)
- ✅ **Exact file paths** (no ambiguity)
- ✅ **Complete code** (ready to implement)
- ✅ **Verification steps** (how to verify)
- ✅ **Dependencies** (what comes first)
- ✅ **Pattern reference** (follows codebase)

### Bad Tasks Are:
- ❌ Too vague ("implement feature")
- ❌ Too large ("build entire system")
- ❌ Missing details ("add function somewhere")
- ❌ No verification ("hope it works")

---

## Integration with Vodou Tools

### Vodou memory + editor
- MEMORY.md / daily logs for decisions; agent/IDE for reading code and similar modules

### Parallel Execution
- Analyzes codebase in parallel
- Gets comprehensive context quickly
- Creates better plans faster

---

## Planning Best Practices

### 1. Start with Context
- Analyze codebase first
- Understand patterns
- Identify similar features

### 2. Break into Small Tasks
- 2-5 minutes per task
- Clear scope
- Easy to verify

### 3. Be Specific
- Exact file paths
- Complete code
- Clear verification

### 4. Follow Patterns
- Use existing patterns
- Maintain consistency
- Follow conventions

### 5. Consider Dependencies
- Order tasks correctly
- Identify blockers
- Plan dependencies

---

## Quick Reference

```bash
# Create implementation plan
./do "implementation plan for [feature]"

# Plan with context
./do "create plan for [feature] using codebase patterns"

# Break down feature
./do "break down [feature] into tasks"
```

---

## Troubleshooting

### "Plan is too vague"
- Analyze codebase more deeply
- Look at similar features
- Break into smaller tasks

### "Tasks are too large"
- Break into smaller pieces
- 2-5 minutes per task
- One concept per task

### "Missing dependencies"
- Analyze dependencies first
- Order tasks correctly
- Identify blockers early

---

**Remember**: Good planning saves time. Vodou makes planning faster and more accurate with codebase intelligence.

