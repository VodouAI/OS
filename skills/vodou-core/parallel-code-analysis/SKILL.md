---
name: parallel-code-analysis
description: Leverages Vodou's parallel execution to perform comprehensive code analysis across multiple dimensions simultaneously
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - "parallel code analysis"
  - "analyze codebase comprehensively"
  - "full code review"
  - "deep code analysis"
  - "multi-dimensional code check"
stopping_points: optional
actions: none
imported_from:
  source: hand-written
---

# Parallel Code Analysis

## Overview

This skill transforms code analysis from a sequential process into a parallel intelligence operation. Instead of running checks one by one, we analyze code across multiple dimensions simultaneously, reducing analysis time from 30+ minutes to under 2 minutes.

## The Parallel Analysis Framework

### Traditional Approach (Sequential) - 30+ minutes
```bash
# ❌ One at a time... so slow!
1. Run security scan          # 5 minutes
2. Check code quality         # 5 minutes  
3. Analyze dependencies       # 3 minutes
4. Find dead code            # 4 minutes
5. Check type errors         # 3 minutes
6. Analyze complexity        # 3 minutes
7. Review test coverage      # 5 minutes
8. Check documentation       # 2 minutes
```

### Vodou Parallel Approach - Under 2 minutes
```bash
# ✅ Everything at once!
./do "security-scan code-quality dependency-check dead-code type-errors complexity-analysis test-coverage doc-check"
```

## Core Analysis Dimensions

### 1. Security Analysis
```bash
# Comprehensive security sweep
./do "owasp-top-10 cwe-top-25 secret-scanning injection-vulnerabilities dependency-vulnerabilities"

# Results include:
# - SQL injection risks
# - XSS vulnerabilities  
# - Exposed secrets/keys
# - Insecure dependencies
# - Authentication flaws
```

### 2. Code Quality Metrics
```bash
# Multi-dimensional quality check
./do "cyclomatic-complexity code-duplication naming-conventions solid-principles design-patterns"

# Analyzes:
# - Function complexity scores
# - Duplicate code blocks
# - Naming consistency
# - SOLID violations
# - Anti-pattern detection
```

### 3. Architecture Analysis
```bash
# Structural deep dive
./do "layer-violations circular-dependencies module-cohesion api-design database-schema"

# Discovers:
# - Architectural violations
# - Circular dependency chains
# - Low cohesion modules
# - API inconsistencies
# - Schema issues
```

### 4. Performance Analysis
```bash
# Performance bottleneck detection
./do "n+1-queries slow-algorithms memory-leaks resource-usage optimization-opportunities"

# Identifies:
# - Database query issues
# - Algorithmic inefficiencies
# - Memory leak patterns
# - Resource waste
# - Optimization targets
```

### 5. Test Quality Analysis
```bash
# Testing completeness check
./do "test-coverage mutation-testing test-quality test-patterns missing-tests"

# Evaluates:
# - Coverage percentages
# - Test effectiveness
# - Test code quality
# - Missing test scenarios
# - Test anti-patterns
```

## Advanced Analysis Workflows

### Full Stack Analysis
```bash
# Frontend + Backend + Database in parallel
./do "analyze frontend: react-patterns accessibility performance && analyze backend: api-design security scalability && analyze database: schema-quality query-performance indexes"
```

### Change Impact Analysis
```bash
# Analyze recent changes across all dimensions
./do "git-diff-analysis impact-on-tests dependency-changes performance-impact security-implications"
```

### Pre-Release Analysis
```bash
# Comprehensive pre-release check
./do "security-final code-quality-final test-coverage-check documentation-complete performance-baseline"
```

## Intelligent Analysis Patterns

### 1. Contextual Analysis
```bash
# First, load project intelligence
./do "load project-context understand-architecture identify-critical-paths"

# Then, focused analysis
./do "analyze critical-paths for: security quality performance"
```

### 2. Comparative Analysis
```bash
# Compare with best practices
./do "load industry-standards compare-with-codebase generate-gap-analysis"

# Version comparison
./do "compare current-version with-previous identify-regressions quality-trends"
```

### 3. Predictive Analysis
```bash
# Predict future issues
./do "analyze code-trends predict-tech-debt estimate-maintenance-burden identify-risk-areas"
```

## Analysis Output Management

### Generating Reports
```bash
# Comprehensive report generation
./do "generate analysis-report with: executive-summary detailed-findings action-items priority-matrix"

# Specific stakeholder reports
./do "create security-report for-ciso quality-report for-tech-lead performance-report for-devops"
```

### Issue Tracking
```bash
# Create actionable items
./do "convert findings to-github-issues assign-priorities add-labels set-milestones"
```

### Continuous Monitoring
```bash
# Set up monitoring
./do "create analysis-baseline schedule-regular-checks set-quality-gates alert-on-degradation"
```

## Practical Examples

### Example 1: New Codebase Analysis
```bash
# Step 1: Initial reconnaissance
./do "identify languages frameworks libraries architecture-style"

# Step 2: Parallel deep analysis
./do "security-scan quality-check dependency-audit test-assessment documentation-review"

# Step 3: Generate insights
./do "create onboarding-guide identify-improvement-areas suggest-refactoring-plan"
```

### Example 2: Pre-Merge Analysis
```bash
# Analyze PR comprehensively
./do "analyze pull-request: security quality performance test-impact backward-compatibility"

# Generate review
./do "create pr-review with-specific-feedback suggest-improvements check-standards"
```

### Example 3: Technical Debt Assessment
```bash
# Quantify technical debt
./do "measure code-complexity duplication outdated-deps missing-tests poor-documentation"

# Create remediation plan
./do "prioritize tech-debt estimate-effort create-roadmap assign-tasks"
```

## Performance Tips

### 1. Use File Filters
```bash
# Focus on specific areas
./do "analyze only: src/**/*.ts for all-quality-metrics"
```

### 2. Incremental Analysis
```bash
# Analyze only changes
./do "analyze files-changed-in-last-commit across-all-dimensions"
```

### 3. Cached Analysis
```bash
# Use parallel MCP + Vodou memory for speed (no bundled codebase MCP in core ship)
./do "use cached-analysis for-unchanged-files fresh-analysis for-modified"
```

## Integration Patterns

### CI/CD Integration
```bash
# Automated quality gates
./do "run parallel-analysis fail-if: security-critical quality-below-threshold coverage-drops"
```

### IDE Integration
```bash
# Real-time feedback
./do "analyze current-file on-save show-inline-warnings suggest-fixes"
```

### Review Process Integration
```bash
# Automated review assistance
./do "analyze pr generate-review-comments check-against-standards verify-tests"
```

## Quick Reference

```bash
# Full analysis
./do "analyze everything"

# Security focused
./do "security analysis comprehensive"

# Performance focused  
./do "performance analysis with-profiling"

# Quality focused
./do "code quality all-metrics"

# Quick health check
./do "code health quick-scan"

# Specific file analysis
./do "analyze [file] all-dimensions"

# Generate report
./do "create analysis report"
```

## Remember

The power of parallel code analysis isn't just speed - it's the ability to see connections and patterns across multiple dimensions simultaneously. When security, quality, and performance are analyzed together, you discover insights that sequential analysis misses.

**Think parallel. Analyze comprehensively. Act intelligently.**