---
name: systematic-debugging
description: Structured 4-phase debugging process enhanced with parallel diagnostics, root cause analysis, and optional reasoning tools
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - "debug [issue]"
  - "systematic debugging"
  - "find root cause"
  - "debug this error"
  - "troubleshoot [problem]"
  - "why is this failing"
  - "investigate [issue]"
stopping_points: required
actions: actions.json
imported_from:
  source: hand-written
---

# Vodou Systematic Debugging - Parallel Diagnostic Workflow

## Overview

This skill provides **systematic debugging workflows** using a proven 4-phase process, enhanced by Vodou's parallel execution and **built-in memory** (retrieval + MEMORY.md / daily logs). There is no separate shipped codebase-analysis MCP—use memory plus your editor and tests.

**The Innovation**: Structured debugging process + parallel diagnostics = faster root cause identification.

**Based on**: Superpowers' `systematic-debugging` workflow, enhanced with Vodou's parallel execution.

---

## 4-Phase Debugging Process

### Phase 1: Reproduce and Isolate

**⏸️ STOPPING POINT - Understand the Problem**

Before debugging, understand the issue:

**"I'll help debug [issue]. Let me understand:**
1. **What is the problem?** (error message, unexpected behavior)
2. **When does it happen?** (always, sometimes, specific conditions)
3. **What were you doing?** (steps to reproduce)
4. **What's the expected behavior?** (what should happen)

**Can you describe the issue?"**

### Phase 1 Execution

**1. Reproduce the Issue**

```bash
# Try to reproduce
./do "run [command/script]"
./do "test [feature]"
```

**2. Isolate Variables (Parallel Analysis)**

```bash
# Environment + local repo checks (Vodou does not ship a bundled codebase-analysis MCP)
./do "cpu memory disk"
rg -n "error_symbol|TODO|FIXME" .   # search; narrow path for huge repos
cargo check                          # Rust — use npm run build, ruff, tsc, etc. for your stack
```

**What this does:**
- Checks system resources (CPU, memory, disk)
- Surfaces likely code locations via search
- Runs your project's typecheck / build as a sanity pass

**⏸️ STOPPING POINT**:
- Can you reproduce the issue? (yes/no)
- Is it consistent? (yes/no)
- Ready to move to Phase 2? (yes/no)

### STOPPING POINT 1 — Choose Debug Depth

1. **Quick scan (fast triage)** — host/resource checks only
2. **Standard debug (recommended)** — host scan + 10-step Enhanced Thinking session
3. **Deep root-cause analysis** — host scan + 15-step Enhanced Thinking deep session

<!-- AGENT_ACTIONS: see actions.json -->

---

### Agent Instructions — After Stopping Point 1

After the user selects Standard or Deep, the actions.json runs mcp-monitor diagnostics and starts a thinking session (capturing SESSION_ID). **You then drive the thinking loop directly:**

For **Standard debug** (10 steps), walk through these phases:
- **Steps 1-3 — Reproduce & Isolate:** What triggers the bug? What works vs fails? What's the environment difference?
- **Steps 4-6 — Gather Evidence:** Trace data flow, check error paths, examine state at each boundary
- **Steps 7-9 — Root Cause:** Form hypotheses, test against evidence, eliminate red herrings
- **Step 10 — Synthesis:** Summarize findings, propose fix, note verification steps

For **Deep root-cause** (15 steps), add:
- **Steps 11-13 — Challenge:** Stress-test the root cause. What could we be wrong about?
- **Steps 14-15 — Fix Design:** Evaluate tradeoffs, blast radius, implementation plan

**For each step, call `add_thought` directly:**
```bash
./vodou-core call Vodou-Enhanced-Thinking add_thought '{
  “session_id”: “[SESSION_ID]”,
  “thought”: “[Your analysis for this step]”,
  “thoughtNumber”: [N],
  “totalThoughts”: [DEPTH],
  “nextThoughtNeeded”: true
}'
```

Set `nextThoughtNeeded: false` on the final step. After all steps, call `analyze_thinking` for quality score, then present findings to the user.

**Key:** Generate each thought yourself — do NOT use `rawLLMCall` or `{{LLM:}}` templates. You are the reasoning engine. Each thought should build on previous findings, narrow the search space, and be specific and actionable.

---

### Phase 2: Gather Evidence

**Collect diagnostic information in parallel:**

```bash
# Repo-side: your editor, ripgrep, git — plus Vodou memory (see below)
rg -n “[error_function]|error_keyword” src/
git log -n 20 --oneline -- [error_file]
```

**Vodou memory (baked in):** relevant chunks from `memory.db` / daily logs are retrieved on each prompt (daemon + hooks); durable project truth lives in `.vodou/workspace/MEMORY.md` and `.vodou/workspace/memory/`. Use `./do “log: …”` to persist decisions.

**What this gathers:**
- Error location and context from stack traces + search
- Recent changes touching the failing area
- Prior decisions and issues from **memory** when they match the topic

**⏸️ STOPPING POINT**:
- Evidence gathered: [list]
- Ready to analyze? (yes/no)

---

### Phase 3: Identify Root Cause

**Analyze evidence to find root cause:**

### Root Cause Analysis Techniques

#### Technique 1: Data Flow Analysis

```bash
# Trace data flow manually: jump to definition, find references, read call sites
rg -n "\\b[function]\\b" --glob "*.rs" .   # adjust glob for your language
```

**What this finds:**
- Where data comes from
- How it's transformed
- Where it goes
- Potential corruption points

#### Technique 2: Pattern Matching

```bash
# Find similar issues
rg -n "[error_pattern]" .
```

**What this finds:**
- Similar bugs in codebase
- Known patterns that cause issues
- Historical fixes for similar problems

#### Technique 3: Dependency Analysis

```bash
# Check dependencies / types (use your stack)
cargo tree              # Rust
npm ls                  # Node
pip check               # Python
cargo check             # or npm run build, tsc --noEmit, etc.
```

**What this finds:**
- Dependency conflicts
- Circular dependencies
- Type mismatches
- Version issues

#### Technique 4: Hypothesis Testing

```bash
# Test hypotheses: cross-check MEMORY.md / today's memory file for related [issue] keywords
./do "log: analysis: hypothesis checked for [issue] | result: …"
```

**What this does:**
- Grounds hypotheses in what the project already recorded
- Keeps a trail for the next session via work logs / memory promotion

**⏸️ STOPPING POINT**:
- Root cause identified: [cause]
- Confidence level: [high/medium/low]
- Ready to verify? (yes/no)

---

### Phase 4: Verify and Fix

**1. Verify Root Cause**

```bash
# Verify the root cause
./do "test [hypothesis]"
./do "reproduce with [specific_conditions]"
```

**2. Implement Fix**

```bash
# Fix the issue
./do "fix [root_cause]"
./do "implement solution for [issue]"
```

**3. Verify Fix**

```bash
# Verify fix works
./do "run tests"
./do "reproduce issue"  # Should not reproduce
cargo check   # or your project's typecheck command
```

**⏸️ STOPPING POINT**:
- Fix implemented? (yes/no)
- Issue resolved? (yes/no)
- Tests passing? (yes/no)
- Ready to commit? (yes/no)

---

## Advanced Debugging Patterns

### Pattern 1: Parallel Diagnostics

```bash
# Run all diagnostics simultaneously
./do "debug authentication failure"
# → Analyzes logs, code, dependencies, patterns in parallel
# → Provides comprehensive diagnostic report
# → Suggests likely root causes
```

### Pattern 2: Root Cause Tracing

```bash
# Trace root cause through code
./do "trace root cause for [error]"
# → Uses data flow analysis
# → Traces error through call stack
# → Identifies origin point
```

### Pattern 3: Pattern-Based Debugging

```bash
# Find similar issues
./do "find similar bugs for [error]"
# → Searches codebase for similar issues
# → Shows how similar issues were fixed
# → Suggests fix based on patterns
```

---

## Debugging Techniques

### Technique 1: Defense in Depth

**Check multiple layers:**
- Application code
- Dependencies
- System resources
- Configuration
- Environment

**Vodou Enhancement**: Check all layers in parallel

### Technique 2: Condition-Based Waiting

**Wait for specific conditions:**
- Error to occur
- System state to change
- Resource to become available

**Vodou Enhancement**: Monitor multiple conditions simultaneously

### Technique 3: Root Cause Tracing

**Trace error to origin:**
- Follow call stack
- Trace data flow
- Analyze control flow

**Vodou Enhancement**: Parallel analysis of all paths

---

## Integration with Vodou Tools

### Host & environment
- **mcp-monitor** — CPU, memory, disk, host context for “is the machine healthy?”

### Memory (core — no extra MCP)
- **Retrieval on prompt** — hybrid search surfaces relevant prior notes
- **Files** — `.vodou/workspace/MEMORY.md`, `.vodou/workspace/memory/YYYY-MM-DD.md`
- **Durability** — `./do "log: category: …"` and mem promote/compact flows as you use them

### Repo & editor
- Stack traces, **rg**, **git**, language toolchains, and the IDE/agent you’re already in — there is **no** bundled in-memoria/narsil-style server in core ship.

### Parallel Execution
- All diagnostics run simultaneously
- 3-7x faster than sequential debugging
- Comprehensive analysis in seconds

---

## Debugging Checklist

### Phase 1: Reproduce
- ✅ Can reproduce issue
- ✅ Isolated variables
- ✅ Understand conditions

### Phase 2: Gather Evidence
- ✅ Error messages
- ✅ Stack traces
- ✅ Log files
- ✅ System state
- ✅ Recent changes

### Phase 3: Root Cause
- ✅ Analyzed evidence
- ✅ Tested hypotheses
- ✅ Identified root cause
- ✅ High confidence

### Phase 4: Fix
- ✅ Implemented fix
- ✅ Verified fix works
- ✅ Tests passing
- ✅ Issue resolved

---

## Best Practices

### 1. Don't Guess
- Gather evidence first
- Test hypotheses
- Verify assumptions

### 2. Use Parallel Diagnostics
- Leverage Vodou's parallel execution
- Check multiple things simultaneously
- Get comprehensive information quickly

### 3. Follow the Process
- Don't skip phases
- Verify each step
- Document findings

### 4. Learn from Patterns
- Search Vodou memory (MEMORY.md / daily logs) and `rg` for similar past issues
- Learn from historical fixes
- Build debugging knowledge

### 5. Verify Fixes
- Always verify fix works
- Run tests
- Confirm issue doesn't reproduce

---

## Quick Reference

```bash
# Start debugging
./do "debug [issue]"

# Systematic debugging
./do "systematic debugging for [error]"

# Find root cause
./do "find root cause for [issue]"

# Troubleshoot
./do "troubleshoot [problem]"
```

---

## Troubleshooting

### "Can't reproduce issue"
- Gather more information
- Check conditions
- Try different scenarios

### "Too much information"
- Focus on relevant evidence
- Prioritize by likelihood
- Use Vodou's parallel analysis to filter

### "Root cause unclear"
- Test more hypotheses
- Gather more evidence
- Use deep thinking for analysis

---

**Remember**: Systematic debugging is about process, not guessing. Vodou makes it faster and more comprehensive, but the 4-phase process ensures thoroughness.

