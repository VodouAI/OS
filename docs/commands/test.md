# test

Run comprehensive tests on connected MCP servers with detailed reporting.

## Syntax
```bash
vodou-core test [OPTIONS] <NAME>
```

## Parameters
- **`<NAME>`** - Server name to test

## Options
- **`--test-type <TYPE>`** - Type of test to run (default: basic)
  - `basic` - Test core MCP methods (tools/list, prompts/list, resources/list)
  - `full` - Comprehensive testing of all capabilities
  - `performance` - Performance benchmarking and response time analysis

## Description

The `test` command runs comprehensive tests on connected MCP servers using the Inspector. It provides detailed reporting on server functionality, performance, and reliability.

Test categories:
- **Basic Tests** - Core MCP protocol methods
- **Full Tests** - All available capabilities and edge cases
- **Performance Tests** - Response times and reliability metrics

## Examples

### Basic Testing
```bash
# Run basic tests on a server
vodou-core test chrome-devtools

# Explicit basic test (same as above)
vodou-core test chrome-devtools --test-type basic
```

### Comprehensive Testing
```bash
# Run full test suite
vodou-core test mcp-monitor --test-type full

# Performance benchmarking
vodou-core test data-server --test-type performance
```

### Sample Output

**Basic Test Results:**
```
🧪 Testing server: chrome-devtools (basic)
📊 Test Results:
  ✅ tools/list (45ms)
  ✅ prompts/list (23ms)
  ✅ resources/list (18ms)
⏱️  Total Duration: 86ms
🎯 Overall: PASS
```

**Failed Test Example:**
```
🧪 Testing server: broken-server (basic)
📊 Test Results:
  ❌ tools/list (timeout)
    Error: Server did not respond within timeout
  ✅ prompts/list (34ms)
  ❌ resources/list (error)
    Error: Invalid JSON response
⏱️  Total Duration: 5034ms
🎯 Overall: FAIL
```

## Test Types

### Basic Tests
- **tools/list** - List available tools
- **prompts/list** - List available prompts  
- **resources/list** - List available resources
- **Response time** measurement for each method

### Full Tests
- All basic tests plus:
- **tools/call** - Test tool execution (safe tools only)
- **prompts/get** - Test prompt retrieval
- **resources/read** - Test resource access
- **Error handling** - Test invalid requests
- **Edge cases** - Boundary condition testing

### Performance Tests
- **Response time analysis** - Detailed timing metrics
- **Throughput testing** - Multiple concurrent requests
- **Reliability scoring** - Success rate over multiple runs
- **Memory usage** - Resource consumption analysis

## Professional Workflow

```bash
# 1. Connect server
vodou-core connect my-server node ./server.js --validate

# 2. Basic functionality test
vodou-core test my-server

# 3. Comprehensive testing before production
vodou-core test my-server --test-type full

# 4. Performance benchmarking
vodou-core test my-server --test-type performance

# 5. Analyze detailed metrics
vodou-core analyze my-server --output report.json
```

## Use Cases

**Development:**
- Verify server functionality during development
- Regression testing after changes
- Debug server implementation issues

**Quality Assurance:**
- Pre-deployment testing
- Performance benchmarking
- Reliability assessment

**Production Monitoring:**
- Health checks with detailed metrics
- Performance monitoring
- Service level verification

## Related Commands

- [`validate`](validate.md) - Pre-connection validation
- [`inspect`](inspect.md) - Visual debugging
- [`debug`](debug.md) - Method-level debugging
- [`analyze`](analyze.md) - Detailed performance analysis
- [`health-check`](../health-check.md) - Basic health monitoring

## Requirements

- **Connected Server** - Server must be in the database
- **MCP Inspector** - Uses Inspector for testing
- **Node.js** - Required for Inspector functionality

## Interpreting Results

**Success Indicators:**
- ✅ All tests pass
- Response times < 1000ms
- Overall: PASS status

**Warning Signs:**
- Response times > 2000ms
- Intermittent failures
- Partial test passes

**Failure Indicators:**
- ❌ Any critical test fails
- Timeout errors
- Overall: FAIL status

## Troubleshooting

**Tests timing out:**
- Check server responsiveness: `vodou-core status server-name`
- Verify server is running
- Check system resources

**Intermittent failures:**
- Run tests multiple times
- Check server logs for errors
- Verify network stability

**All tests failing:**
- Verify server connection: `vodou-core list`
- Check server configuration
- Try basic status check first