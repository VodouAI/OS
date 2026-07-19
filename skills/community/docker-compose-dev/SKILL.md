---
name: docker-compose-dev
description: Comprehensive Docker Compose development workflow automation for containerized applications
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - "docker dev"
  - "compose workflow"
  - "container development"
  - "docker compose setup"
  - "containerize my app"
stopping_points: optional
actions: none
imported_from:
  source: hand-written
---

# Docker Compose Development Workflow

## Overview

This skill provides a complete Docker Compose development workflow, from initial setup through debugging and optimization. It handles common Docker development tasks efficiently using Vodou's parallel execution capabilities.

## Pre-Flight Checklist

Before starting any Docker work, always run the pre-flight check:

```bash
./do "check docker daemon status disk-space available-ports memory-usage"
```

This parallel check ensures:
- Docker daemon is running
- Sufficient disk space (Docker images can be large)
- Required ports are available
- Adequate memory for containers

## Core Workflows

### 1. New Project Setup

```bash
# Analyze project and generate appropriate Dockerfile and docker-compose.yml
./do "analyze project structure detect-framework suggest-dockerfile generate-compose-config"

# Verify generated files
./do "validate dockerfile lint-compose check-security-issues"

# Build and test
./do "docker build test-container check-logs"
```

### 2. Development Environment Setup

#### Hot Reload Configuration
```bash
# For Node.js/React/Vue
./do "setup docker volumes for hot-reload configure-webpack-watch"

# For Python/Django/Flask
./do "configure django-reload setup-volume-mounts"

# For any framework
./do "analyze framework setup-hot-reload-for-{framework}"
```

#### Environment Variables
```bash
# Generate .env template
./do "scan compose file create-env-template"

# Validate environment
./do "check env-vars validate-secrets scan-for-exposed-keys"
```

### 3. Container Management

#### Starting Services
```bash
# Smart startup with health checks
./do "docker compose up with-health-monitoring log-aggregation"

# Selective services
./do "start only database redis worker"

# With debugging
./do "start services with-debug-ports exposed"
```

#### Monitoring
```bash
# Comprehensive monitoring
./do "monitor containers cpu-usage memory-usage disk-io network-traffic"

# Log analysis
./do "aggregate logs from all-containers analyze-errors show-warnings"

# Health checks
./do "check container-health endpoint-status database-connections"
```

### 4. Common Issues & Solutions

#### Port Conflicts
```bash
# Detect and resolve
./do "find port-conflicts suggest-alternatives update-compose-file"
```

#### Volume Permissions
```bash
# Fix permission issues
./do "diagnose volume-permissions fix-ownership set-correct-modes"
```

#### Network Issues
```bash
# Debug connectivity
./do "test inter-container-networking check-dns trace-routes"

# Fix common issues
./do "recreate docker-network flush-dns restart-affected-containers"
```

#### Performance Issues
```bash
# Analyze performance
./do "profile containers identify-bottlenecks suggest-optimizations"

# Optimize resources
./do "tune memory-limits cpu-shares optimize-build-cache"
```

### 5. Database Management

#### Database Operations
```bash
# Backup before changes
./do "backup database-container to-local-volume with-timestamp"

# Migrations
./do "run database-migrations show-pending verify-success"

# Data seeding
./do "seed development-data maintain-referential-integrity"
```

### 6. Multi-Stage Builds

```bash
# Optimize image size
./do "analyze dockerfile suggest-multi-stage optimize-layers"

# Security scanning
./do "scan image-vulnerabilities check-base-image update-dependencies"
```

### 7. Debugging Workflows

#### Container Debugging
```bash
# Interactive debugging
./do "exec into-container install-debug-tools start-debug-session"

# Remote debugging setup
./do "expose debug-port configure-ide-connection"
```

#### Log Investigation
```bash
# Comprehensive log analysis
./do "collect logs from-all-containers filter-by-timestamp search-errors correlate-events"
```

## Best Practices

### 1. **Always Use Named Volumes**
```yaml
volumes:
  postgres_data:
    name: ${PROJECT_NAME}_postgres_data
```

### 2. **Health Checks Are Essential**
```bash
./do "add health-checks to all-services with-proper-intervals"
```

### 3. **Resource Limits**
```bash
./do "set memory-limits cpu-limits for-all-containers based-on-available-resources"
```

### 4. **Security First**
```bash
# Regular security scans
./do "scan docker-images for-vulnerabilities check-outdated-packages"

# Secrets management
./do "rotate secrets update-env-files restart-affected-services"
```

### 5. **Build Optimization**
```bash
# Optimize build times
./do "analyze build-cache suggest-cache-mounts optimize-layer-order"
```

## Advanced Patterns

### Docker Compose Override Files
```bash
# Development overrides
./do "create compose.override.yml for-local-development with-debug-settings"

# Production preparation
./do "create compose.prod.yml optimize-for-production remove-dev-dependencies"
```

### Service Dependencies
```bash
# Manage startup order
./do "analyze service-dependencies optimize-startup-order add-wait-scripts"
```

### Scaling Services
```bash
# Scale intelligently
./do "analyze load-patterns scale-services monitor-performance"
```

## Troubleshooting Playbook

### Container Won't Start
```bash
./do "check docker-logs validate-compose-syntax verify-image-exists check-port-availability"
```

### Slow Performance
```bash
./do "analyze resource-usage check-build-context optimize-volumes review-network-mode"
```

### Connection Issues
```bash
./do "verify network-configuration test-dns check-firewall inspect-iptables"
```

## Quick Commands Reference

```bash
# Setup
./do "docker setup for [framework]"
./do "generate docker configs"

# Development
./do "start dev environment"
./do "watch logs for [service]"
./do "restart [service] with debug"

# Debugging
./do "debug container [name]"
./do "analyze docker issues"
./do "fix common docker problems"

# Maintenance
./do "cleanup docker artifacts"
./do "update all images"
./do "backup volumes"

# Monitoring
./do "docker health check"
./do "show resource usage"
./do "analyze performance"
```

## Integration with CI/CD

```bash
# Prepare for CI/CD
./do "create dockerfile.ci optimize-for-ci-cache generate-build-script"

# Test CI locally
./do "simulate ci-build run-tests-in-container generate-reports"
```

## Remember

Docker Compose development is about managing complexity. Use Vodou's parallel execution to handle multiple aspects simultaneously:

```bash
# The power move - do everything at once
./do "start services monitor-health watch-logs check-endpoints run-tests"
```

This skill helps you maintain development velocity while ensuring your containerized applications run smoothly and efficiently.