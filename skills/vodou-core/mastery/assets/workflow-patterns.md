# Workflow Patterns

## Overview

Common workflow patterns for advanced Vodou usage.

## Pattern 1: Analysis → Action

**Use Case:** Analyze something, then take action

**Structure:**
```bash
# Phase 1: Parallel analysis
./do "analyze [target] with [tools]"

# Phase 2: Results analyzed
# Options presented based on findings

# Phase 3: User chooses action
# Action executes
```

## Pattern 2: Parallel Discovery

**Use Case:** Discover what's available

**Structure:**
```bash
# Multiple discovery tools in parallel
./do "available skills list tools show intents"
# All execute simultaneously
# Results correlated
```

## Pattern 3: Iterative Improvement

**Use Case:** Improve something iteratively

**Structure:**
```bash
# Iteration 1: Analyze
./do "analyze [target]"

# Iteration 2: Optimize
./do "optimize [target] based on analysis"

# Iteration 3: Verify
./do "verify improvements"
```

## Pattern 4: Multi-Phase Orchestration

**Use Case:** Complex workflows with multiple phases

**Structure:**
```bash
# Phase 1: Analysis (parallel tools)
# Phase 2: Planning (based on results)
# Phase 3: Execution (user-approved)
# Phase 4: Verification (confirm results)
```

## Pattern 5: Cross-Server Workflow

**Use Case:** Tools from different servers working together

**Structure:**
```bash
# Server 1: Analysis
# Server 2: Action (triggered by Server 1 results)
# Server 3: Verification (triggered by Server 2 results)
```

## Pattern 6: Conditional Branching

**Use Case:** Different paths based on results

**Structure:**
```bash
# Analysis → Results → Options → User chooses → Path executes
```

## Next Steps

After learning patterns:
1. Apply patterns to your workflows
2. Create custom patterns
3. Build pattern libraries

