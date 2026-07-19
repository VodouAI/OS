# Pro Tips & Best Practices

## Overview

Expert techniques and optimizations for getting the most from Vodou.

## Pro Tip 1: Think Big, Execute Fast

**Don't limit yourself to one operation at a time.**

```bash
# ❌ Limiting yourself
./do "analyze typescript files"
./do "check test coverage"
./do "find unused dependencies"

# ✅ Think big
./do "analyze all typescript files for type errors while checking test coverage and finding unused dependencies"
```

**Key**: Vodou can handle complex parallel operations. Think comprehensively.

## Pro Tip 2: Use Descriptive Queries

**More context = better results**

```bash
# ❌ Vague
./do "analyze authentication"

# ✅ Descriptive
./do "analyze JWT authentication in auth module for OWASP top 10 vulnerabilities"
```

**Key**: Provide context helps Vodou select the right tools and optimize execution.

## Pro Tip 3: Leverage Intent Mappings

**Create custom intents for your workflows**

```bash
# Create custom intent
./do "add intent mapping: morning-routine → parallel: system-check load-context show-todos priority 15"

# Now use:
./do "morning routine"
# All execute in parallel automatically
```

**Key**: Custom intents make common workflows instant.

## Pro Tip 4: Monitor Performance

**Track what's working and what's slow**

```bash
# Check performance
./do "show performance metrics for last 10 operations"
./do "which tools are slowest?"

# Optimize based on findings
```

**Key**: Understanding performance helps optimize workflows.

## Pro Tip 5: Batch Similar Operations

**Group related operations for efficiency**

```bash
# ❌ Multiple separate commands
./do "search for TODO comments"
./do "search for FIXME comments"
./do "search for HACK comments"

# ✅ Batch together
./do "search for TODO FIXME HACK comments in parallel"
```

**Key**: Batching reduces overhead and improves efficiency.

## Pro Tip 6: Use Skills First

**Always check for skills before other operations**

```bash
# Skills contain expert knowledge
./do "create oi skill"        # Loads expert skill development guide
./do "install mcp server"     # Loads expert installation guide
./do "hello"                  # Loads comprehensive help center
```

**Key**: Skills provide curated expertise and proven patterns.

## Pro Tip 7: Right Context at the Right Time

**Vodou provides on-demand, relevant context**

- Faster execution
- Lower token usage
- More relevant information
- Intelligent context management

**Key**: Don't load everything upfront - let Vodou provide context when needed.

## Pro Tip 8: Daisy-Chain Workflows

**MCP results flow into Skills workflows**

```bash
# MCP analysis → Skill workflow → Next actions
./do "analyze system then optimize performance"
# System analysis (MCP) → Optimization skill → Action plan
```

**Key**: Seamless workflow continuity without manual intervention.

## Pro Tip 9: Log Systematically

**Track your work for future context**

```bash
# Rich logging with metadata
./do "log: feature: Implemented JWT authentication | component: auth | files_changed: 5 | duration: 2h | complexity: high"
```

**Key**: Future you (and AI agents) will thank you for good logging.

## Pro Tip 10: Explore Regularly

**Discover new capabilities**

```bash
# Regular exploration
./do "available skills"         # See available skills
./do "list tools"              # See available tools
./do "show intents"            # See intent mappings
```

**Key**: Vodou's capabilities expand - stay updated.

## Common Pitfalls to Avoid

### ❌ Pitfall 1: Sequential Thinking

**Problem**: Thinking one command at a time

**Solution**: Always consider parallel execution

```bash
# Instead of:
./do "cpu"
./do "memory"
./do "disk"

# Do:
./do "cpu memory disk"
```

### ❌ Pitfall 2: Not Checking Skills First

**Problem**: Missing expert guidance

**Solution**: Always check for skills first

```bash
# Skills contain expert knowledge
./do "available skills"  # Check what's available
```

### ❌ Pitfall 3: Ignoring Stopping Points

**Problem**: Skipping user control points

**Solution**: Always respect stopping points

```bash
# When skills present options, choose - don't skip
```

### ❌ Pitfall 4: Making Assumptions

**Problem**: Assuming what users want

**Solution**: Always ask at decision points

```bash
# Present options, let users choose
```

### ❌ Pitfall 5: Forgetting to Log

**Problem**: No work history

**Solution**: Log systematically

```bash
# Log with categories and metadata
./do "log: category: description | metadata"
```

## Advanced Pro Tips

### Tip 11: Create Workflow Templates

**Save common workflows as intents**

```bash
# Development workflow template
./do "add intent mapping: dev-start → parallel: load-context check-system show-todos priority 15"
```

### Tip 12: Use Background Jobs

**For long-running tasks**

```bash
# Start background job
./do "run tests in background"
./do "job status"              # Check progress
./do "job logs <id>"          # View output
```

### Tip 13: Orchestrate Complex Workflows

**Let tools direct next steps**

```bash
# Orchestrated workflow
./do "comprehensive analysis"
# Tools direct what executes next based on results
```

### Tip 14: Monitor System Health

**Keep Vodou running smoothly**

```bash
# Regular health checks
./do "system health"
./do "server status"
```

### Tip 15: Customize Everything

**Adapt Vodou to your needs**

```bash
# Create custom skills
./do "create oi skill"

# Create custom intents
./do "add intent mapping: ..."

# Install custom MCP servers
./do "install mcp server"
```

## Performance Optimization Tips

### Optimize Tool Selection

- Choose tools with similar execution times
- Group by server when possible
- Limit to 5-10 tools for optimal performance

### Optimize Queries

- Be specific and descriptive
- Provide context
- Use natural language

### Optimize Workflows

- Use orchestration for complex workflows
- Batch similar operations
- Log systematically

## Next Steps

After mastering pro tips:
1. Apply tips to your workflows
2. Create custom patterns
3. Share your discoveries

