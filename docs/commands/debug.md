# debug

Debug MCP servers using CLI Inspector methods for targeted troubleshooting.

## Syntax
```bash
vodou-core debug [OPTIONS] <NAME>
```

## Parameters
- **`<NAME>`** - Server name to debug

## Options
- **`--method <METHOD>`** - Specific MCP method to test
  - `tools/list` - Test tool discovery
  - `prompts/list` - Test prompt discovery
  - `resources/list` - Test resource discovery

## Description

The `debug` command provides targeted debugging of specific MCP server methods using the Inspector CLI. This is useful for isolating issues and testing individual server capabilities.

Use `debug` when you need to:
- **Isolate Issues** - Test specific methods that are failing
- **Quick Testing** - Fast verification of individual capabilities
- **Development Debugging** - Test methods during development
- **Troubleshooting** - Pinpoint exactly what's not working

## Examples

### Interactive Debugging
```bash
# Debug server without specifying method (shows available options)
vodou-core debug chrome-devtools
```

### Method-Specific Debugging
```bash
# Test tool discovery specifically
vodou-core debug chrome-devtools --method tools/list

# Test prompt discovery
vodou-core debug mcp-monitor --method prompts/list

# Test resource discovery
vodou-core debug data-server --method resources/list
```

### Sample Output

**Interactive Mode:**
```
🐛 Debugging server: chrome-devtools
  Use --method to specify a method to test
  Available methods: tools/list, prompts/list, resources/list
```

**Method Testing:**
```
🐛 Debugging server: chrome-devtools
  Testing method: tools/list
  Result: ✅ SUCCESS
```

**Method Failure:**
```
🐛 Debugging server: broken-server
  Testing method: tools/list
  Result: ❌ FAILED
```

## Available Methods

### tools/list
Tests the server's ability to list available tools.
```bash
vodou-core debug my-server --method tools/list
```

### prompts/list  
Tests the server's ability to list available prompts.
```bash
vodou-core debug my-server --method prompts/list
```

### resources/list
Tests the server's ability to list available resources.
```bash
vodou-core debug my-server --method resources/list
```

## Debugging Workflow

### Quick Issue Isolation
```bash
# 1. Server seems broken, let's debug
vodou-core debug my-server

# 2. Test specific failing method
vodou-core debug my-server --method tools/list

# 3. If that works, try the next
vodou-core debug my-server --method prompts/list

# 4. Continue until you find the issue
vodou-core debug my-server --method resources/list
```

### Development Testing
```bash
# Test each capability as you implement it
vodou-core debug new-server --method tools/list     # ✅ SUCCESS
vodou-core debug new-server --method prompts/list   # ❌ FAILED - needs implementation
vodou-core debug new-server --method resources/list # ❌ FAILED - needs implementation
```

### Troubleshooting Failed Tests
```bash
# If comprehensive test fails, isolate the issue
vodou-core test my-server    # Shows some failures

# Debug each method individually
vodou-core debug my-server --method tools/list
vodou-core debug my-server --method prompts/list
vodou-core debug my-server --method resources/list
```

## Use Cases

**Development:**
- Test individual methods during implementation
- Verify fixes for specific capabilities
- Quick functional verification

**Troubleshooting:**
- Isolate failing methods from comprehensive tests
- Pinpoint exact failure points
- Verify fixes after changes

**Quality Assurance:**
- Targeted testing of specific functionality
- Method-level regression testing
- Precise issue reproduction

## Related Commands

- [`test`](test.md) - Comprehensive testing (use first)
- [`validate`](validate.md) - Pre-connection validation
- [`inspect`](inspect.md) - Visual debugging
- [`analyze`](analyze.md) - Performance analysis
- [`status`](../status.md) - Basic server status

## Debugging Strategy

### 1. Start Broad
```bash
vodou-core status my-server      # Basic health
vodou-core test my-server        # Comprehensive test
```

### 2. Narrow Down
```bash
vodou-core debug my-server       # See available methods
```

### 3. Target Specific Issues
```bash
vodou-core debug my-server --method tools/list    # Test specific failure
```

### 4. Visual Inspection
```bash
vodou-core inspect my-server     # Visual debugging if needed
```

## Requirements

- **Connected Server** - Server must be in the database
- **MCP Inspector** - Uses Inspector CLI for method testing
- **Node.js** - Required for Inspector functionality

## Troubleshooting

**No methods available:**
- Check server connection: `vodou-core list`
- Verify server status: `vodou-core status server-name`
- Ensure server implements MCP protocol

**All methods failing:**
- Check server is running
- Verify MCP protocol implementation
- Try full test suite: `vodou-core test server-name`

**Intermittent failures:**
- Run method test multiple times
- Check server logs for errors
- Verify system resources