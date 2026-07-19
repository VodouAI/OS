# Advanced Patterns

## Overview

Advanced patterns enable complex workflows, orchestration, and dynamic behavior.

## Orchestration Patterns

### Pattern 1: Conditional Orchestration

**Concept:** Next steps depend on results

**Implementation:**
```markdown
### Step 1: Analysis
./do "analyze system performance security"

### 🛑 **STOPPING POINT: Results-Based Next Steps**

**Analysis Results:**
- [Results summary]

**Next Steps Based on Results:**
- **If high CPU**: Optimize CPU usage
- **If security issues**: Fix security problems
- **If outdated deps**: Update dependencies

**Which issue should we address first?**
1. CPU optimization
2. Security fixes
3. Dependency updates
4. All of the above
5. Review details first

**Your choice? (1, 2, 3, 4, or 5)**
```

### Pattern 2: Multi-Phase Orchestration

**Concept:** Workflow with multiple phases

**Implementation:**
```markdown
## Phase 1: Analysis
./do "analyze codebase structure dependencies"

### 🛑 **STOPPING POINT: Phase 1 Complete**

**Analysis complete. Ready for Phase 2?**

**Options:**
1. Proceed to Phase 2 (Optimization)
2. Review Phase 1 results first
3. Skip to Phase 3 (Testing)
4. Stop here

**Your choice? (1, 2, 3, or 4)**
```

### Pattern 3: Cross-Server Orchestration

**Concept:** Results from one server trigger next server

**Implementation:**
```markdown
### Step 1: System Analysis (mcp-monitor)
./do "cpu memory disk network"

### 🛑 **STOPPING POINT: Analysis Results**

**System Status:**
- CPU: [status]
- Memory: [status]
- Disk: [status]

**Next Steps:**
- **If issues found**: Analyze with browser-tools
- **If all good**: Proceed to code analysis

**How would you like to proceed?**
1. Analyze with browser-tools (if issues)
2. Proceed to code analysis
3. Generate report first
4. Stop here

**Your choice? (1, 2, 3, or 4)**
```

## Dynamic Patterns

### Pattern 1: Dynamic Workflow Generation

**Concept:** Workflow adapts based on user input

**Implementation:**
```markdown
### 🛑 **STOPPING POINT: Workflow Customization**

**What aspects do you want to include?**

**Analysis Options:**
- [ ] Code structure
- [ ] Security audit
- [ ] Performance analysis
- [ ] Dependency check
- [ ] Test coverage

**Select all that apply (comma-separated):**
[User input determines workflow]
```

### Pattern 2: Adaptive Stopping Points

**Concept:** Stopping points appear based on context

**Implementation:**
```markdown
### Step 1: Initial Check
./do "check system status"

# If issues found, show stopping point
### 🛑 **STOPPING POINT: Issues Detected**

[Only appears if issues found]

**Issues detected. How would you like to proceed?**
1. Fix issues now
2. Continue anyway
3. Review details first
```

## Integration Patterns

### Pattern 1: Skill Chaining

**Concept:** One skill triggers another

**Implementation:**
```markdown
### Step 1: Initial Analysis
./do "analyze codebase"

### 🛑 **STOPPING POINT: Next Skill**

**Analysis complete. Next step?**

**Options:**
1. Run security audit (code-review or dedicated security skill)
2. Run performance analysis (mcp-monitor + your profiler toolchain)
3. Generate report (my-report-generator)
4. Custom workflow

**Your choice? (1, 2, 3, or 4)**
```

### Pattern 2: MCP + Skill Integration

**Concept:** MCP results inform skill workflow

**Implementation:**
```markdown
### Step 1: MCP Data Collection
./do "cpu memory disk"  # MCP server

### Step 2: Skill Processing
# Skill processes MCP results

### 🛑 **STOPPING POINT: Processed Results**

**Based on MCP data:**
- [Processed insights]

**Next steps:**
1. [Action based on results]
2. [Alternative action]
3. [Review mode]

**Your choice? (1, 2, or 3)**
```

## Best Practices for Advanced Patterns

### ✅ DO

1. **Explain Complexity**: Help users understand
2. **Provide Defaults**: But allow customization
3. **Show Consequences**: What happens with each choice
4. **Test Thoroughly**: Advanced patterns need more testing
5. **Document Well**: Complex patterns need good docs

### ❌ DON'T

1. **Don't Overcomplicate**: Keep it as simple as possible
2. **Don't Hide Complexity**: Be transparent
3. **Don't Skip Testing**: Advanced patterns need more testing
4. **Don't Assume**: Always ask users
5. **Don't Break Basics**: Advanced should enhance, not replace

## When to Use Advanced Patterns

**Use Advanced Patterns When:**
- Multiple valid workflow paths
- Results determine next steps
- Complex integration needed
- Dynamic behavior required
- Orchestration needed

**Don't Use Advanced Patterns When:**
- Simple workflow suffices
- Single path is clear
- Basic patterns work
- Complexity adds no value

## Next Steps

After learning advanced patterns:
1. Plan your advanced skill
2. Choose appropriate patterns
3. Implement carefully
4. Test extensively
5. Document thoroughly

