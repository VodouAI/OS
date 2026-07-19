# health-dashboard

Real-time health dashboard with comprehensive server monitoring and recommendations.

## Syntax

```bash
vodou-core health-dashboard [OPTIONS]
```

## Description

The `health-dashboard` command provides a comprehensive real-time health monitoring interface for all connected MCP servers. It displays health status, performance metrics, and actionable recommendations in a user-friendly dashboard format.

## Options

- `--refresh <SECONDS>` - Auto-refresh interval in seconds (0 = no refresh, default: 0)

## Features

### Real-time Monitoring
- **Live Health Status** - Current health of all servers
- **Performance Metrics** - Response times, success rates, capability counts
- **Trend Analysis** - Health trends over time with moving averages
- **Alert System** - Highlights servers requiring attention

### Health Categories
- **✅ Healthy** - Server operating normally (< 100ms, > 95% success)
- **⚠️ Degraded** - Server experiencing performance issues
- **❌ Unhealthy** - Server not responding or frequent failures
- **🔄 Recovering** - Server recovering from previous issues
- **❓ Unknown** - Health status not yet determined

## Examples

### Basic Dashboard
```bash
# Show current health dashboard
vodou-core health-dashboard
```

### Auto-Refreshing Dashboard
```bash
# Refresh every 5 seconds
vodou-core health-dashboard --refresh 5

# Refresh every 30 seconds for monitoring
vodou-core health-dashboard --refresh 30
```

## Example Output

```bash
$ vodou-core health-dashboard
🏥 Health Dashboard
================================================================================
📊 Overall Health Statistics:
   Servers: 4 total (✅ 3 healthy, ⚠️ 1 degraded, ❌ 0 unhealthy)
   Monitoring Service: 🟢 Active (background monitoring enabled)
   Cache Status: 🟢 Fresh (last updated 23 seconds ago)
   Connection Pool: 🟢 Optimal (3/4 servers pooled, avg 145ms response)

🖥️  Server Health Details:
   ✅ Healthy mcp-monitor (100% success, 8ms avg, trending: stable)
      📊 Capabilities: 6 tools, 0 prompts, 0 resources  
      🔄 Usage: 45 calls in last hour, last used 2 minutes ago
      💡 Status: Excellent performance, no action needed

   ✅ Healthy filesystem (97% success, 45ms avg, trending: stable)  
      📊 Capabilities: 12 tools, 0 prompts, 3 resources
      🔄 Usage: 23 calls in last hour, last used 30 seconds ago
      💡 Status: Good performance, minor latency increases

   ✅ Healthy browser-tools (95% success, 78ms avg, trending: improving)
      📊 Capabilities: 14 tools, 0 prompts, 0 resources
      🔄 Usage: 12 calls in last hour, last used 5 minutes ago  
      💡 Status: Performance improving after recent issues

   ⚠️ Degraded database-server (89% success, 234ms avg, trending: declining)
      📊 Capabilities: 8 tools, 0 prompts, 2 resources
      🔄 Usage: 8 calls in last hour, 3 failures, last used 15 minutes ago
      ⚠️  Issues: High response time, occasional timeouts
      💡 Recommendation: Check database connectivity and server load

📈 Performance Trends (Last Hour):
   Response Time: 91ms avg (↗️ +12ms from previous hour)
   Success Rate: 95.2% (↘️ -2.1% from previous hour)  
   Total Calls: 88 (↗️ +15 from previous hour)
   Active Connections: 3/4 servers pooled

🔧 Health Recommendations:
   1. 🎯 Investigate database-server performance issues
      • Check database connectivity: vodou-core tools database-server
      • Monitor resource usage: vodou-core health-check-detailed --server database-server
      • Consider reconnection: vodou-core reconnect database-server

   2. 🚀 Overall system health is good
      • 3/4 servers performing optimally
      • Connection pooling providing 25-50x performance improvement
      • Background monitoring detecting issues proactively

   3. 📊 Monitoring suggestions
      • Enable auto-recovery: vodou-core start-monitoring --auto-recovery
      • Check detailed stats: vodou-core health-stats
      • View routing optimization: vodou-core routing-stats

⏰ Last Updated: 2025-09-11 14:32:15 (23 seconds ago)
🔄 Auto-refresh: Disabled (use --refresh <seconds> to enable)

💡 Use Ctrl+C to exit • For detailed analysis: vodou-core health-stats
```

## Dashboard Sections

### 1. Overall Health Statistics
- **Server Counts** - Total servers by health status
- **Monitoring Status** - Background monitoring service status
- **Cache Status** - Tool and health cache freshness
- **Connection Pool** - Connection pooling status and performance

### 2. Server Health Details
For each server:
- **Health Status** - Current health with trend indicators
- **Performance Metrics** - Success rate, response time, trends
- **Capability Summary** - Tools, prompts, resources count
- **Usage Statistics** - Recent activity and call patterns
- **Status Assessment** - Health summary and recommendations

### 3. Performance Trends
- **Response Time Trends** - Average response time changes
- **Success Rate Trends** - Success rate changes over time
- **Usage Patterns** - Call volume and activity trends
- **Connection Status** - Pool utilization and efficiency

### 4. Health Recommendations
- **Issue Identification** - Servers requiring attention
- **Actionable Suggestions** - Specific commands to resolve issues
- **Optimization Tips** - Performance improvement suggestions
- **Monitoring Guidance** - Best practices for ongoing monitoring

## Real-time Updates

### Auto-Refresh Mode
```bash
# Enable auto-refresh every 10 seconds
$ vodou-core health-dashboard --refresh 10
🏥 Health Dashboard (Auto-refresh: 10s)
[dashboard content updates automatically...]

# Press Ctrl+C to stop auto-refresh
^C
Dashboard refresh stopped.
```

### Manual Refresh
```bash
# Run dashboard command again for updated information
vodou-core health-dashboard
```

## Health Status Indicators

### Status Icons
- **🟢** - Excellent (green)
- **🟡** - Good (yellow) 
- **🟠** - Degraded (orange)
- **🔴** - Unhealthy (red)
- **⚪** - Unknown (white)

### Trend Indicators
- **↗️** - Improving
- **➡️** - Stable  
- **↘️** - Declining
- **📈** - Strong improvement
- **📉** - Strong decline

### Performance Thresholds
- **Healthy**: < 100ms response, > 95% success rate
- **Degraded**: 100ms-1s response, 85-95% success rate
- **Unhealthy**: > 1s response, < 85% success rate

## Integration with Other Commands

### Follow-up Actions
Based on dashboard recommendations:

```bash
# Investigate specific server issues
vodou-core health-check-detailed --server database-server

# Reconnect problematic servers
vodou-core reconnect database-server

# Enable background monitoring
vodou-core start-monitoring --auto-recovery

# View detailed statistics
vodou-core health-stats
```

### Monitoring Workflow
```bash
# 1. Check overall health
vodou-core health-dashboard

# 2. Investigate specific issues
vodou-core health-check-detailed --detailed

# 3. Take corrective action
vodou-core reconnect-all

# 4. Monitor improvements
vodou-core health-dashboard --refresh 30
```

## Performance Monitoring

### Key Metrics Tracked
- **Response Time** - Average response time per server
- **Success Rate** - Percentage of successful operations
- **Capability Count** - Number of tools/prompts/resources available
- **Usage Frequency** - Call patterns and activity levels
- **Error Rates** - Failure patterns and error types

### Historical Data
- **Moving Averages** - Smoothed metrics over time windows
- **Trend Analysis** - Direction of performance changes  
- **Baseline Comparison** - Performance vs historical baselines
- **Anomaly Detection** - Identification of unusual patterns

## Related Commands

- [`health-check-detailed`](health-check-detailed.md) - Detailed health analysis
- [`health-stats`](health-stats.md) - Comprehensive health statistics
- [`start-monitoring`](start-monitoring.md) - Background health monitoring
- [`health-check`](health-check.md) - Quick health check

## Troubleshooting

### Dashboard Not Updating
1. **Check Server Connectivity** - `vodou-core health-check`
2. **Refresh Tool Cache** - `vodou-core all-tools`
3. **Restart Monitoring** - `vodou-core stop-monitoring && vodou-core start-monitoring`

### Performance Issues
1. **Check Individual Servers** - `vodou-core health-check-detailed --detailed`
2. **Monitor Connection Pool** - Look for connection pool status in dashboard
3. **Review Server Logs** - Check for specific error patterns

### Auto-Refresh Problems
1. **Terminal Compatibility** - Some terminals may not support auto-refresh
2. **Resource Usage** - Frequent refreshes may impact performance
3. **Network Latency** - Slow connections may affect refresh timing

## See Also

- [Health Monitoring Guide](../../docs-DEV/health-monitoring.md) (internal)
- [Health Check Detailed](health-check-detailed.md)
- [Health Statistics](health-stats.md)
- [Performance Guide](../../docs-DEV/performance.md) (internal)