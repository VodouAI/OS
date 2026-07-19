# health-check Command

Perform a quick health check on all connected MCP servers with enhanced Brain Trust 4 health monitoring integration and optional performance metrics.

## Syntax

```bash
vodou-core health-check [OPTIONS]
```

## Options

- **`--metrics`** - Show performance metrics with health results using Inspector testing

## Description

The `health-check` command provides a rapid overview of all server health status. It's designed for:

- **Quick monitoring** - Fast health overview of entire system
- **Script integration** - Simple success/failure checking
- **System diagnostics** - Identify which servers need attention
- **Minimal output** - Concise, scannable results

## Examples

### Basic Health Check

```bash
vodou-core health-check
```

**Output:**
```
🏥 Health Check - Testing 3 servers...

  Testing chrome-devtools: ✅ Healthy
  Testing mcp-monitor: ✅ Healthy
  Testing mcpadvisor: ✅ Healthy
```

### No Servers Connected

```bash
vodou-core health-check
```

**Output:**
```
🏥 Health Check - No servers connected
```

### Mixed Results

```bash
vodou-core health-check
```

**Output:**
```
🏥 Health Check - Testing 4 servers...

  Testing chrome-devtools: ✅ Healthy
  Testing mcp-monitor: ✅ Healthy
  Testing mcpadvisor: ✅ Healthy
  Testing broken-server: ❌ Cannot start: No such file or directory
```

## Health Check Process

For each server, the health check:

1. **Attempts connection** using stored command and arguments
2. **Tests initialization** - MCP protocol handshake
3. **Verifies response** - Server responds to basic commands
4. **Reports status** - Simple healthy/unhealthy result

## Status Results

| Result | Meaning | Next Steps |
|--------|---------|------------|
| `✅ Healthy` | Server is fully operational | None needed |
| `❌ Failed initialization` | Server starts but MCP protocol fails | Check server logs, try `reconnect` |
| `❌ Cannot start` | Server process won't start | Check command/path, verify server exists |

## Use Cases

### System Monitoring
```bash
# Regular health check in monitoring scripts
*/5 * * * * vodou-core health-check | grep "❌" && alert-system
```

### Pre-deployment Verification
```bash
# Verify all systems before deployment
vodou-core health-check
if [ $? -eq 0 ]; then
  echo "All servers healthy, proceeding with deployment"
else
  echo "Server issues detected, deployment paused"
fi
```

### Troubleshooting Workflow
```bash
# 1. Quick health check to identify issues
vodou-core health-check

# 2. Detailed status on problematic servers
vodou-core status problematic-server

# 3. Attempt reconnection
vodou-core reconnect problematic-server
```

### Development Setup Verification
```bash
# Verify development environment is ready
vodou-core health-check
# Continue with development if all servers healthy
```

### Professional Monitoring with Metrics
```bash
# Enhanced health check with performance metrics
vodou-core health-check --metrics
```

**Enhanced Output (Brain Trust 4):**
```
🏥 Enhanced Health Check with Metrics - Testing 3 servers...
  Testing chrome-devtools: ✅ Healthy (45ms, pool: active, score: 160/160)
  Testing mcp-monitor: ✅ Healthy (62ms, pool: active, score: 155/160)
  Testing mcpadvisor: ✅ Healthy (38ms, pool: active, score: 150/160)
📊 Enhanced Health Summary:
  Healthy: 3/3 servers (100% availability)
  Connection Pool: 3/3 servers pooled (97% efficiency)
  Avg Response: 48ms (vs 2.3s without pooling)
  Universal Routing: Optimal server selection enabled
  Health Monitoring: Background monitoring active
```

## Scripting Integration

### Exit Codes
- **0**: All servers healthy
- **1**: One or more servers unhealthy or error occurred

### Output Parsing
```bash
# Check if any servers failed
if vodou-core health-check | grep -q "❌"; then
  echo "Some servers are unhealthy"
  vodou-core health-check | grep "❌"
fi
```

### Silent Mode
```bash
# Redirect output for silent health checking
if vodou-core health-check > /dev/null 2>&1; then
  echo "All systems operational"
fi
```

## Performance Characteristics

- **Fast execution** - Optimized for speed over detailed analysis
- **Parallel potential** - Could test servers concurrently (future enhancement)
- **Minimal resource usage** - Light network and CPU footprint
- **Fail-fast** - Quickly identifies non-responsive servers

## Health Check Modes

### Standard Mode (Default)
- Basic online/offline testing
- Fast MCP protocol verification
- Minimal output for scripting
- Optimized for speed

### Metrics Mode (--metrics)
- Inspector-based comprehensive testing
- Response time measurements
- Performance summary statistics
- Detailed health analysis

## Comparison with Related Commands

| Command | Purpose | Detail Level | Speed | Brain Trust 4 Features |
|---------|---------|--------------|-------|------------------------|
| `health-check` | Quick overview of all servers | Low | Fast | Connection pool status |
| `health-check --metrics` | Performance health overview | Medium | Medium | Pool efficiency, routing scores |
| `health-dashboard` | Real-time monitoring | High | Fast | Live dashboard, auto-refresh |
| `health-check-detailed` | Comprehensive health analysis | Very High | Medium | Trend analysis, recommendations |
| `status [server] --detailed` | Single server with Inspector tests | Very High | Medium | Enhanced with pool integration |

## Related Commands

- [`status`](status.md) - Detailed health and capability information
- [`health-dashboard`](health-dashboard.md) - Real-time health monitoring dashboard
- [`health-check-detailed`](health-check-detailed.md) - Comprehensive health analysis
- [`start-monitoring`](start-monitoring.md) - Background health monitoring service
- [`reconnect-all`](reconnect-all.md) - Fix issues by reconnecting all servers
- [`list`](list.md) - See which servers are configured

---

**Next:** [`reconnect`](reconnect.md) - Reconnect and refresh server capabilities