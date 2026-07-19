# Orchestration Patterns - Complete Guide

## Overview

Orchestration means tools direct what executes next based on results - intelligent automation.

## How Orchestration Works

### Basic Concept

**Traditional: Manual Steps**
```bash
./do "check cpu"                    # Step 1
./do "check memory"                 # Step 2 (manual decision)
./do "run optimization"             # Step 3 (manual decision)
```

**Vodou Orchestration: Intelligent Workflow**
```bash
./do "optimize my system"
# Step 1: CPU analysis (automatic)
# Step 2: Memory analysis (triggered by CPU results)
# Step 3: Options presented (based on findings)
# Step 4: User chooses → execution
# Result: Intelligent workflow with context flow
```

## Orchestration Modes

### 1. Immediate Orchestration

**Next tool executes automatically based on results**

```bash
# Example: System analysis → automatic optimization
./do "system optimization"
# Analysis → Auto-detects issues → Suggests fixes → Executes
```

### 2. Conditional Orchestration

**Present user choices based on analysis findings**

```bash
# Example: Security scan → user chooses remediation
./do "security audit"
# Scan → Analysis → Options presented → User chooses → Execution
```

### 3. Parallel Orchestration

**Execute multiple workflows simultaneously**

```bash
# Example: Multiple analysis paths in parallel
./do "comprehensive analysis"
# Multiple workflows execute in parallel
# Results correlated automatically
```

### 4. Sequential Orchestration

**Execute steps in specific order with context**

```bash
# Example: Development workflow
./do "implement feature with testing"
# Analysis → Implementation → Testing → Validation
# Context flows between each phase
```

## Database-Driven Orchestration

### Creating Custom Orchestration

**Add orchestration to intent mappings:**

```sql
sqlite3 vodou-core.db "INSERT INTO intent_mappings 
(keyword, server_name, tool_name, priority, tool_parameters) VALUES 
('system optimization', 'mcp-monitor', 'get_system_info', 15, 
'{\"orchestration\": {
  \"next_intent\": \"memory analysis\", 
  \"execution_type\": \"conditional\", 
  \"user_choice_required\": true, 
  \"options\": [
    {\"label\": \"Optimize memory\", \"intent\": \"memory cleanup\"}, 
    {\"label\": \"Optimize disk\", \"intent\": \"disk cleanup\"}
  ]
}}');"
```

**Now use:**
```bash
./do "system optimization"
# Runs system analysis → presents options → executes chosen optimization
```

## Cross-Server Orchestration

### Multi-Server Workflows

**Tools from different servers work together:**

```bash
# Example: System → Browser → Code → Scripts
./do "comprehensive security audit"
# mcp-monitor (system analysis) → 
# browser-tools (web security) → 
# code-review skill + chrome-devtools (browser) → 
# Vodou-script-executor (fixes)
# Each phase informs the next with shared context
```

### Orchestration Flow

1. **Phase 1**: Initial analysis (parallel tools)
2. **Phase 2**: Results trigger specific diagnostics
3. **Phase 3**: Options presented to user
4. **Phase 4**: User chooses → next phase executes
5. **Phase 5**: Verification and completion

## Real-World Orchestration Examples

### Example 1: System Optimization

```bash
./do "optimize my system"

# Orchestration flow:
# 1. Analysis (parallel: cpu, memory, disk, network)
# 2. Results analyzed → issues detected
# 3. Options presented:
#    - Optimize memory (if memory issues)
#    - Optimize disk (if disk issues)
#    - Optimize network (if network issues)
# 4. User chooses → optimization executes
# 5. Verification → results shown
```

### Example 2: Development Workflow

```bash
./do "implement feature with testing"

# Orchestration flow:
# 1. Analyze existing code (parallel tools)
# 2. Generate implementation plan
# 3. Create implementation
# 4. Generate tests
# 5. Run tests
# 6. Validate results
# Context flows between each phase
```

### Example 3: Security Audit

```bash
./do "security audit"

# Orchestration flow:
# 1. Security scan (parallel: multiple scanners)
# 2. Analysis and prioritization
# 3. Options presented:
#    - Fix high-priority issues
#    - Review all issues
#    - Generate report
# 4. User chooses → remediation workflow
# 5. Verification → security status
```

## Advanced Orchestration Patterns

### Pattern 1: Conditional Branching

**Workflow branches based on results:**

```bash
# If CPU high → optimize CPU
# If memory high → optimize memory
# If both high → optimize both
./do "smart system optimization"
```

### Pattern 2: Iterative Refinement

**Workflow improves iteratively:**

```bash
# Analyze → Optimize → Test → Refine → Repeat
./do "iterative code optimization"
```

### Pattern 3: Multi-Phase Orchestration

**Complex workflows with multiple phases:**

```bash
# Phase 1: Analysis
# Phase 2: Planning
# Phase 3: Execution
# Phase 4: Validation
./do "complete development workflow"
```

### Pattern 4: Database-Driven Orchestration

**Store orchestration directives in the database for reusable workflows:**

```sql
INSERT INTO intent_mappings 
(keyword, server_name, tool_name, priority, tool_parameters) 
VALUES 
('system optimization', 'mcp-monitor', 'get_cpu_info', 15, 'mcp',
'{
  "orchestration": {
    "execution_type": "conditional",
    "user_choice_required": true,
    "options": [
      {"label": "Optimize memory", "intent": "memory"},
      {"label": "Optimize disk", "intent": "disk"},
      {"label": "Check network", "intent": "network"}
    ]
  }
}');
```

**Usage:**
```bash
./do "system optimization"
# → Executes get_cpu_info
# → Presents 3 options
# → User selects → Next intent executes
```

**Key Benefits:**
- Store orchestration logic in database
- Reusable across sessions
- Easy to update and maintain
- Works with all execution modes (immediate, conditional, parallel, sequential)

**See**: `docs-DEV/database-driven-orchestration.md` for complete documentation (internal doc path).

### Pattern 5: Triple-Layer Orchestration (MCP + Skills + Scripts)

**✅ PROVEN WORKING**: Orchestrate across all three Vodou layers in a single workflow.

**Mix MCP servers, Skills, and Scripts:**

```sql
INSERT INTO intent_mappings 
(keyword, server_name, tool_name, priority, tool_parameters) 
VALUES 
('triple layer workflow', 'mcp-monitor', 'get_cpu_info', 20, 'mcp',
'{
  "orchestration": {
    "execution_type": "conditional",
    "user_choice_required": true,
    "options": [
      {"label": "Load Vodou Hello Skill", "intent": "hello"},
      {"label": "Check Memory (MCP)", "intent": "memory"},
      {"label": "Run Script", "intent": "nightly backup"}
    ]
  }
}');
```

**How It Works:**
- **MCP Server Tools**: Route via intent keyword (e.g., `memory` → `mcp-monitor::get_memory_info`)
- **Skills**: Route via skill trigger phrases (e.g., `hello` → `vodou-core::vc_load_skill`)
- **Scripts**: Route via script keywords (e.g., `nightly backup` → `Vodou-script-executor::execute_script`)

**Key Benefits:**
- Unified orchestration across all three layers
- Flexible routing to any layer
- User control with options from different layers
- Seamless integration through intent system

**See**: `docs-DEV/database-driven-orchestration.md` for complete triple-layer orchestration documentation (internal doc path).

## Best Practices

### ✅ DO

1. **Design Clear Workflows**
   - Logical flow between phases
   - Clear decision points
   - User control at key moments

2. **Use Conditional Orchestration**
   - Present options based on results
   - Let users choose paths
   - Adapt to findings

3. **Maintain Context**
   - Pass context between phases
   - Share results across tools
   - Correlate findings

### ❌ DON'T

1. **Don't Over-Orchestrate**
   - Keep workflows simple
   - Don't create unnecessary complexity
   - Use orchestration when it adds value

2. **Don't Skip User Control**
   - Always include stopping points
   - Present options at key decisions
   - Never assume user intent

3. **Don't Lose Context**
   - Maintain context between phases
   - Share results appropriately
   - Correlate findings

## Troubleshooting

### Issue: Orchestration Not Working

**Check:**
- Intent mapping exists?
- Orchestration configured correctly?
- Tool_parameters format valid?

**Solution:**
- Verify intent mapping
- Check JSON format
- Test orchestration directive

### Issue: Wrong Workflow Path

**Check:**
- Conditional logic correct?
- Options presented properly?
- User choices handled correctly?

**Solution:**
- Review orchestration configuration
- Test conditional branches
- Verify user choice handling

## Next Steps

After mastering orchestration:
1. Create custom orchestrated workflows
2. Explore cross-server patterns
3. Build complex multi-phase workflows

