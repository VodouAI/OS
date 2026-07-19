---
name: self-learning
description: Enables Vodou to learn about itself, analyze its own patterns, and suggest improvements using existing MCP servers
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - "self learn"
  - "learn about yourself"
  - "analyze yourself"
  - "self improvement"
  - "self analysis"
  - "how can you improve"
  - "what are your weaknesses"
  - "self awareness"
stopping_points: required
actions: none
imported_from:
  source: hand-written
---

# Vodou Self-Learning - Making Vodou Self-Aware

## Overview

This skill enables Vodou to become self-aware by using its own powerful MCP servers to analyze itself. Vodou learns about its own codebase patterns, identifies what it does most often, finds bugs in its own code, and suggests improvements - all using existing tools.

**The Innovation**: Vodou uses **built-in memory** (retrieval + MEMORY.md / daily logs), **work logs**, your **language toolchain** (`cargo test`, `rg`, etc.), and optionally **Vodou-Enhanced-Thinking** — no shipped in-memoria/narsil MCP.

---

## Self-Learning Workflow

### Step 1: Learn Vodou's own codebase

```bash
grep -nE "Vodou|brain|memory|skill" .vodou/workspace/MEMORY.md .vodou/workspace/memory/*.md 2>/dev/null | head -50
rg -n "fn main|struct BrainLoader|mem " src/ | head -40
```

**What this does:** Surfaces **recorded** context (memory files) plus a quick **rg** pass — full semantics come from the agent/IDE reading code.

**⏸️ STOPPING POINT**: After learning, ask:
- Should we analyze work logs next? (yes/no)
- Or check codebase health first? (yes/no)

---

### Step 2: Analyze Work Logs for Patterns

**Query the work logs database to understand what Vodou does most often:**

```sql
-- Find most common operations
SELECT category, COUNT(*) as count, 
       GROUP_CONCAT(DISTINCT component) as components
FROM work_logs 
WHERE timestamp >= datetime('now', '-30 days')
GROUP BY category
ORDER BY count DESC;
```

**What this reveals:**
- Most common operation types (tool_call, feature, installation, etc.)
- Most active components
- Patterns in how Vodou is used
- Opportunities for optimization

**Example findings:**
- "tool_call" used 225 times → Consider creating intent mappings
- "feature" used 14 times → Common development pattern
- "installation" used 10 times → Frequent setup operations

**⏸️ STOPPING POINT**: After analyzing work logs, ask:
- Should we check codebase health next? (yes/no)
- Or generate improvement suggestions now? (yes/no)

---

### Step 3: Check codebase health

```bash
cargo test
cargo clippy -- -D warnings 2>/dev/null || true
cargo audit 2>/dev/null || true
```

**What this finds:** Whatever your **Rust/Node/etc. toolchain** reports — there is no bundled narsil-style analyzer MCP.

**⏸️ STOPPING POINT**: After health check, ask:
- Should we think about improvements? (yes/no)
- Or generate suggestions directly? (yes/no)

---

### Step 4: Think About Improvements

**Use Vodou-Enhanced-Thinking to reason about improvements:**

```bash
# Deep thinking about Vodou improvements
./do "deep think about Vodou improvements based on patterns and health analysis"
```

**What this does:**
- Analyzes findings from previous steps
- Reasons about improvement priorities
- Considers trade-offs
- Generates thoughtful recommendations

**⏸️ STOPPING POINT**: After thinking, ask:
- Should we generate the improvement plan? (yes/no)
- Or review findings first? (yes/no)

---

### Step 5: Generate Improvement Suggestions

**Combine all findings into actionable improvements:**

**Based on work log patterns:**
- If "tool_call" is used frequently → Create intent mappings
- If specific components are active → Optimize those areas
- If patterns emerge → Document best practices

**Based on codebase health:**
- Security issues → Fix vulnerabilities
- Dead code → Remove unused code
- Dependencies → Update outdated packages
- Type errors → Fix type issues

**Based on thinking analysis:**
- Prioritize improvements by impact
- Consider implementation complexity
- Suggest quick wins vs. long-term improvements

**Output format:**
```json
{
  "high_priority": [
    {
      "issue": "tool_call used 225 times",
      "action": "Create intent mappings for common tool calls",
      "impact": "high",
      "effort": "low"
    }
  ],
  "medium_priority": [
    {
      "issue": "Dead code found in src/old/",
      "action": "Remove unused code",
      "impact": "medium",
      "effort": "low"
    }
  ],
  "low_priority": [
    {
      "issue": "Minor type errors",
      "action": "Fix type annotations",
      "impact": "low",
      "effort": "medium"
    }
  ]
}
```

---

## Quick Commands

### Full Self-Learning Workflow
```bash
# Complete self-analysis
./do "self learn"
# → Learns codebase, analyzes work logs, checks health, suggests improvements
```

### Individual Steps
```bash
./do "learn about yourself"
# → Read memory files + rg overview of src/

./do "analyze yourself"
# → Run tests/lints (toolchain)

# Just get improvements
./do "self improvement"
# → Generates improvement suggestions
```

### Parallel analysis
Run `cargo test`, `cargo clippy`, and SQL work-log queries in separate terminals or CI — Vodou can orchestrate multiple `./vodou-core call` / shell steps when those tools are connected.

---

## Example Workflow

**User**: `./do "self learn"`

**AI Agent Response**:
1. **Learning codebase** (memory + rg + editor)
   - Scans MEMORY.md / daily logs and key `src/` symbols

2. **Analyzing work logs**
   - Most common: tool_call (225 times)
   - Active components: planning, feature, installation
   - Pattern: Frequent tool orchestration

3. **Checking health** (cargo test / clippy / audit)
   - Security: per `cargo audit` / your scanners
   - Types/lints: per `cargo clippy` or equivalent

4. **Thinking about improvements** (Vodou-Enhanced-Thinking)
   - High priority: Create intent mappings for tool_call
   - Medium priority: Remove dead code
   - Low priority: Minor optimizations

5. **Suggestions**:
   - **High Priority**: Create intent mappings for common tool calls (225 uses)
   - **Medium Priority**: Remove dead code in src/old/ directory
   - **Low Priority**: Optimize database queries

---

## What Makes This Powerful

### Uses what you ship
- **Vodou memory** + work logs + **toolchain** + optional **Enhanced Thinking**

### No extra codebase MCP required
- Core bundle does not include in-memoria / narsil

### Parallel Execution
- Multiple analyses run simultaneously
- 3-7x faster than sequential
- Comprehensive results in seconds

### Self-Awareness
- Vodou understands its own patterns
- Vodou identifies its weaknesses
- Vodou suggests its own improvements

---

## Best Practices

### Regular Self-Learning
- Run `./do "self learn"` weekly
- Track improvements over time
- Monitor health trends

### Action on Findings
- Prioritize high-impact, low-effort improvements
- Document patterns for future reference
- Share insights with team

### Continuous Improvement
- Use findings to guide development
- Create intent mappings for common operations
- Remove dead code regularly
- Update dependencies proactively

---

## Troubleshooting

### "No work logs found"
- Work logs are created when AI agents log their work
- Run some Vodou commands first to generate logs
- Check database: `sqlite3 vodou-core.db "SELECT COUNT(*) FROM work_logs;"`

### "Memory feels empty"
- Ensure daemon/hooks run; check `.vodou/workspace/MEMORY.md` and `memory/*.md`
- Log work: `./do "log: …"`

### "Tests or lints fail"
- Fix `cargo test` / `cargo clippy` output locally; Vodou does not auto-index into a separate codebase MCP

---

## Next Steps

After running self-learning:

1. **Review findings** - Understand what Vodou discovered
2. **Prioritize improvements** - Focus on high-impact items
3. **Take action** - Implement suggested improvements
4. **Track progress** - Run self-learning again to see improvements

---

**Remember**: Vodou is using its own tools to understand itself. This is self-awareness in action! 🧠✨

