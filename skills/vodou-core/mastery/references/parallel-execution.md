# Parallel Execution - Complete Guide

## Overview

Parallel execution is Vodou's superpower - running multiple MCP tools simultaneously instead of one at a time.

## Why Parallel Execution Matters

**Traditional Sequential:**
- One tool at a time
- 15-30 seconds for multiple operations
- Manual result correlation
- Slow and inefficient

**Vodou Parallel:**
- 5-10 tools simultaneously
- 3-5 seconds for multiple operations
- Automatic result correlation
- 3-7x faster

## Basic Parallel Execution

### Simple Examples

```bash
# System monitoring (3 tools in parallel)
./do "cpu memory disk"
# All execute simultaneously
# Result: 3 seconds vs 9+ seconds sequential

# Code analysis (4 tools in parallel)
./do "analyze codebase security performance dependencies"
# All execute simultaneously
# Result: 5 seconds vs 20+ seconds sequential
```

### Power User Examples

```bash
# System troubleshooting: 8 tools in parallel
./do "system-health cpu memory disk network logs processes performance"

# Security assessment: 6 tools in parallel
./do "security-scan vulnerability-check configuration-audit log-analysis"

# Development workflow: 10 tools in parallel
./do "code-quality test-runner security-scan dependency-check build-status"
```

## Parallel Execution Patterns

### Pattern 1: Related Operations

**When to use:** Operations that are related but independent

```bash
# All system resources
./do "cpu memory disk network"

# All code analysis
./do "analyze codebase security performance"
```

### Pattern 2: Comprehensive Analysis

**When to use:** Multiple perspectives on the same topic

```bash
# Security from multiple angles
./do "security-scan vulnerability-check configuration-audit"

# Performance from multiple tools
./do "cpu memory disk network performance-metrics"
```

### Pattern 3: Discovery Operations

**When to use:** Exploring what's available

```bash
# Discover capabilities
./do "available skills list tools show intents"
```

## Best Practices

### ✅ DO

1. **Group Related Operations**
   - Operations that work well together
   - Similar execution time
   - Related results

2. **Think in Parallel**
   - Always consider: "What else can run at the same time?"
   - Break sequential habits

3. **Use Descriptive Queries**
   - More context = better parallel execution
   - Vodou can optimize tool selection

### ❌ DON'T

1. **Don't Force Sequential**
   - Avoid `&&` when operations are independent
   - Let Vodou execute in parallel

2. **Don't Overload**
   - 5-10 tools is optimal
   - Too many can slow down

3. **Don't Mix Dependent Operations**
   - If operation B needs result from A, use sequential
   - Otherwise, use parallel

## Performance Optimization

### Optimal Tool Count

- **2-5 tools**: Fastest (2-3 seconds)
- **5-10 tools**: Optimal (3-5 seconds)
- **10+ tools**: Still fast but may take longer (5-8 seconds)

### Tool Selection

- Choose tools with similar execution times
- Avoid mixing very fast and very slow tools
- Group by server when possible

## Real-World Examples

### Example 1: System Health Check

```bash
# Sequential (slow)
./do "cpu"        # 3s
./do "memory"     # 3s
./do "disk"       # 3s
./do "network"     # 3s
# Total: 12+ seconds

# Parallel (fast)
./do "cpu memory disk network"
# Total: 3 seconds
# Speedup: 4x faster
```

### Example 2: Code Analysis

```bash
# Sequential (slow)
./do "analyze codebase"           # 5s
./do "check security"             # 4s
./do "check performance"          # 4s
./do "check dependencies"         # 3s
# Total: 16+ seconds

# Parallel (fast)
./do "analyze codebase security performance dependencies"
# Total: 5 seconds
# Speedup: 3x faster
```

## Advanced Patterns

### Cross-Server Parallel Execution

```bash
# Tools from different servers in parallel
./do "cpu memory disk analyze-codebase take-screenshot"
# mcp-monitor + chrome-devtools + browser-tools-stdio
# All execute simultaneously
```

### Conditional Parallel Execution

```bash
# Parallel execution with conditional next steps
./do "system-health cpu memory disk"
# Results determine next parallel operations
```

## Troubleshooting

### Issue: Tools Not Executing in Parallel

**Check:**
- Are tools independent?
- Are there dependencies?
- Check execution logs

**Solution:**
- Ensure tools are independent
- Use `&&` only for dependencies
- Group related operations

### Issue: Slower Than Expected

**Check:**
- Tool count (too many?)
- Tool execution times
- Server health

**Solution:**
- Limit to 5-10 tools
- Group by execution time
- Check server status

## Next Steps

After mastering parallel execution:
1. Learn orchestration patterns
2. Explore workflow examples
3. Create custom parallel intents

