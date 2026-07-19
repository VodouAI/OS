# analyze

Analyze MCP server performance with detailed metrics and recommendations.

## Syntax
```bash
vodou-core analyze [OPTIONS] <NAME>
```

## Parameters
- **`<NAME>`** - Server name to analyze

## Options
- **`--output <FILE>`** - Save detailed analysis report to JSON file

## Description

The `analyze` command performs comprehensive performance analysis of MCP servers with enhanced metrics from Brain Trust 4's Universal MCP Architecture, providing detailed reliability scoring, connection pool analysis, and actionable recommendations for optimization.

Enhanced analysis includes:
- **Reliability Scoring** - Overall server reliability (0-100) with health trend analysis
- **Performance Metrics** - Response times, throughput, and connection pool efficiency
- **Capability Assessment** - Tool/prompt/resource coverage with universal routing integration
- **Health Integration** - Real-time health status and monitoring service integration
- **Connection Pool Analysis** - Pool utilization and performance impact assessment
- **Routing Intelligence** - Server selection scoring and routing optimization recommendations

## Examples

### Basic Analysis
```bash
# Analyze server performance
vodou-core analyze chrome-devtools

# Analyze with detailed console output
vodou-core analyze mcp-monitor
```

### Generate Report
```bash
# Save detailed analysis to JSON file
vodou-core analyze data-server --output performance-report.json

# Timestamped report for tracking
vodou-core analyze my-server --output "analysis-$(date +%Y%m%d).json"
```

### Sample Output

**Enhanced Analysis (Brain Trust 4):**
```
🔬 Analyzing server: chrome-devtools
📊 Enhanced Analysis Results:
  🎯 Reliability Score: 100/100 (trending: stable)
  ⚡ Avg Response Time: 23.5ms (excellent, vs 156ms without pooling)
  🔧 Tools Available: 17 (all responding)
  🏥 Health Status: ✅ Healthy (97% success rate)
  🔄 Connection Pool: ✅ Optimal (pooled for 45 minutes)
  🎯 Routing Score: 160/160 (preferred for universal routing)
  📊 Universal Routing: Receives 42% of read_memory tool calls
```

**Server with Issues:**
```
🔬 Analyzing server: slow-server
📊 Analysis Results:
  🎯 Reliability Score: 67/100
  ⚡ Avg Response Time: 1247.8ms
  🔧 Test Methods: 3
💡 Recommendations:
  - Check server configuration and dependencies
  - Verify all required capabilities are implemented
```

**Generated Report (JSON):**
```json
{
  "server_name": "chrome-devtools",
  "timestamp": "2025-09-10T15:30:00.000Z",
  "reliability_score": 100,
  "avg_response_time_ms": 23.5,
  "test_results": [
    {
      "method": "tools/list",
      "success": true,
      "response_time_ms": 18,
      "error": null
    },
    {
      "method": "prompts/list", 
      "success": true,
      "response_time_ms": 25,
      "error": null
    },
    {
      "method": "resources/list",
      "success": true,
      "response_time_ms": 28,
      "error": null
    }
  ]
}
```

## Analysis Metrics

### Reliability Score
- **100** - Perfect reliability, all tests pass
- **75-99** - Good reliability with minor issues
- **50-74** - Moderate reliability, some failures
- **25-49** - Poor reliability, significant issues
- **0-24** - Critical reliability problems

### Performance Classifications
- **Excellent** - < 50ms average response time
- **Good** - 50-200ms average response time  
- **Acceptable** - 200-1000ms average response time
- **Slow** - 1000-5000ms average response time
- **Critical** - > 5000ms average response time

### Method Coverage
- **Complete** - All MCP methods implemented and working
- **Partial** - Some methods missing or failing
- **Minimal** - Basic functionality only
- **Broken** - Critical methods not working

## Professional Workflow

### Development Analysis
```bash
# 1. Implement server
vodou-core connect my-server node ./server.js --validate

# 2. Basic testing
vodou-core test my-server

# 3. Performance analysis
vodou-core analyze my-server

# 4. Generate baseline report
vodou-core analyze my-server --output baseline.json
```

### Production Monitoring
```bash
# Regular performance monitoring
vodou-core analyze prod-server --output "monitoring/$(date +%Y%m%d-%H%M).json"

# Compare with baseline
vodou-core analyze prod-server
# (manually compare with previous reports)
```

### Performance Optimization
```bash
# 1. Identify performance issues
vodou-core analyze slow-server --output before-optimization.json

# 2. Make optimizations
# (implement fixes)

# 3. Verify improvements
vodou-core analyze slow-server --output after-optimization.json

# 4. Compare results
# (compare JSON reports)
```

## Use Cases

**Development:**
- Performance baseline establishment
- Optimization impact measurement
- Quality gate for releases

**Production:**
- Regular performance monitoring
- SLA compliance verification
- Performance regression detection

**Troubleshooting:**
- Root cause analysis for performance issues
- Detailed diagnostics for failing servers
- Historical performance tracking

## Related Commands

- [`test`](test.md) - Run tests before analysis
- [`validate`](validate.md) - Validate before connecting
- [`inspect`](inspect.md) - Visual debugging for issues
- [`debug`](debug.md) - Isolate specific method problems
- [`health-check-detailed`](health-check-detailed.md) - Comprehensive health monitoring
- [`health-dashboard`](health-dashboard.md) - Real-time health monitoring
- [`routing-stats`](routing-stats.md) - Universal routing performance analysis

## Report Analysis

### JSON Report Structure
```json
{
  "server_name": "string",           // Server identifier
  "timestamp": "ISO8601",            // Analysis time
  "reliability_score": number,       // 0-100 reliability score
  "avg_response_time_ms": number,    // Average response time
  "test_results": [                  // Individual test results
    {
      "method": "string",            // MCP method name
      "success": boolean,            // Test success status
      "response_time_ms": number,    // Method response time
      "error": "string|null"         // Error message if failed
    }
  ]
}
```

### Tracking Performance Over Time
```bash
# Create timestamped reports
vodou-core analyze my-server --output "reports/$(date +%Y-%m-%d-%H-%M).json"

# Compare reports manually or with scripts
# (JSON diff tools can help identify changes)
```

## Requirements

- **Connected Server** - Server must be in the database
- **MCP Inspector** - Uses Inspector for testing
- **Node.js** - Required for Inspector functionality
- **Write Permissions** - For output file generation (if using --output)

## Troubleshooting

**Analysis fails:**
- Check server status: `vodou-core status server-name`
- Verify Inspector is working: `vodou-core test server-name`
- Check server logs for errors

**Poor performance scores:**
- Review recommendations in output
- Check server resource usage
- Verify network connectivity
- Consider server optimization

**Cannot write report file:**
- Check directory permissions
- Verify disk space
- Use absolute path for output file