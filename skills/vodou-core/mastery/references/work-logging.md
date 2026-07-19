# Work Logging - Complete Guide

## Overview

Systematic work tracking with categories and metadata for future context.

## Why Log Work?

**Benefits:**
- Future context for AI agents
- Project history tracking
- Performance analytics
- Knowledge retention

## Logging Format

### Basic Logging

```bash
./do "log: Fixed authentication bug"
```

### Rich Logging (Recommended)

```bash
./do "log: feature: Implemented JWT authentication | component: auth | files_changed: 5 | duration: 2h | complexity: high"
```

## Categories

**Available Categories:**
- **feature** - New functionality
- **bugfix** - Bug fixes
- **analysis** - Code analysis
- **documentation** - Documentation
- **testing** - Testing
- **refactor** - Refactoring
- **performance** - Performance work
- **security** - Security work
- **config** - Configuration
- **deployment** - Deployment
- **maintenance** - Maintenance
- **research** - Research
- **planning** - Planning
- **review** - Code review
- **general** - General work

## Metadata Keys

**Common Metadata:**
- **component** - System component
- **severity** - Impact level (low, medium, high, critical)
- **duration** - Time spent
- **files_changed** - Number of files
- **files_modified** - Specific files
- **lines_added** - Lines added
- **lines_removed** - Lines removed
- **technology** - Tech used
- **issue_id** - Related issue
- **pr_id** - Related PR

## Logging Examples

### Feature Development

```bash
./do "log: feature: Added user authentication | component: auth | files_changed: 5 | duration: 3h"
```

### Bug Fixes

```bash
./do "log: bugfix: Fixed memory leak | component: connection_pool | files_changed: 1 | severity: high | duration: 20min"
```

### Analysis Work

```bash
./do "log: analysis: Analyzed codebase structure | scope: full_codebase | findings: 15_issues"
```

### Performance Work

```bash
./do "log: performance: Optimized database queries | component: database | improvement: 50%_faster"
```

## Best Practices

### ✅ DO

1. **Log Immediately**
   - Log right after completing work
   - Don't wait

2. **Use Categories**
   - Always include category
   - Helps organization

3. **Include Metadata**
   - Add relevant metadata
   - Enables analytics

4. **Be Specific**
   - Clear descriptions
   - Useful for future reference

### ❌ DON'T

1. **Don't Skip Logging**
   - Log significant work
   - Future you will thank you

2. **Don't Be Vague**
   - Clear descriptions
   - Specific details

3. **Don't Forget Metadata**
   - Metadata enables analytics
   - Include relevant keys

## Querying Work Logs

### View Recent Work

```bash
# SQL commands (for AI agents)
sqlite3 vodou-core.db "SELECT * FROM work_logs WHERE timestamp >= datetime('now', '-7 days')"
```

### Filter by Category

```bash
sqlite3 vodou-core.db "SELECT * FROM work_logs WHERE category = 'feature' ORDER BY timestamp DESC"
```

### Performance Analysis

```bash
sqlite3 vodou-core.db "SELECT category, COUNT(*) as count, AVG(LENGTH(message)) as avg_length FROM work_logs GROUP BY category"
```

## Next Steps

After mastering work logging:
1. Log all significant work
2. Use rich metadata
3. Query logs for insights

