---
name: browser-tools
description: Comprehensive guide for using browser-tools-mcp to debug, audit, and interact with web browsers through Vodou
enabled: false
deprecated: true
deprecated_by: qa-testing
deprecated_note: "QA testing skill now handles this via vodou-mac-control + browser-tools-stdio hybrid. Only explicit lighthouse/seo/accessibility audit keywords still route to browser-tools-stdio directly."
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - "browser tools"
  - "browser debugging"
  - "browser audit"
  - "web debugging"
  - "browser screenshot"
  - "check browser logs"
  - "run browser audit"
  - "debug browser"
  - "browser console"
  - "web performance"
stopping_points: required
actions: actions.json
imported_from:
  source: hand-written
---

# Vodou Browser Tools - Complete Guide

## Overview

This skill provides comprehensive guidance for using `browser-tools-mcp` to interact with, debug, and audit web browsers through Vodou. The browser-tools-mcp server enables AI agents to capture screenshots, monitor console logs, analyze network traffic, run accessibility/performance/SEO audits, and debug web applications - all through natural language commands.

**Key Capabilities:**
- **Browser Monitoring**: Console logs, network traffic, errors
- **Visual Capture**: Screenshots with automatic clipboard integration
- **Web Audits**: Accessibility, performance, SEO, best practices
- **Debugging**: Comprehensive debugging workflows
- **Element Inspection**: Selected DOM element analysis

## Prerequisites

Before using browser-tools-mcp, ensure:

1. **Chrome Extension Installed**: [BrowserToolsMCP Chrome Extension](https://github.com/AgentDeskAI/browser-tools-mcp/releases/download/v1.2.0/BrowserTools-1.2.0-extension.zip)
2. **Browser Tools Server Running**: `npx @agentdeskai/browser-tools-server@latest` (in separate terminal)
3. **MCP Server Connected**: `browser-tools-mcp` should be registered in Vodou (check with `./vodou-core list`)
4. **Chrome DevTools Open**: Open DevTools and navigate to the BrowserToolsMCP panel

**⏸️ STOPPING POINT**: Before proceeding, verify:
- Is the browser-tools-server running? (Check terminal)
- Is the Chrome extension installed and enabled?
- Is the BrowserToolsMCP panel visible in DevTools?

## Core Tools Reference

### 1. Console & Network Logging

#### `getConsoleLogs`
Retrieve all browser console logs (info, warnings, logs).

```bash
./do "get console logs"
./do "show browser console logs"
./do "what's in the browser console"
```

**Use Cases:**
- Debugging JavaScript issues
- Monitoring application state
- Tracking user interactions
- Verifying code execution

#### `getConsoleErrors`
Get only console errors (critical issues).

```bash
./do "get console errors"
./do "show browser errors"
./do "what errors are in the console"
```

**Use Cases:**
- Identifying JavaScript errors
- Debugging runtime failures
- Tracking error patterns
- Monitoring application health

#### `getNetworkLogs`
Retrieve all successful network requests.

```bash
./do "get network logs"
./do "show network requests"
./do "what network calls were made"
```

**Use Cases:**
- API call monitoring
- Request/response analysis
- Performance debugging
- Data flow tracking

#### `getNetworkErrors`
Get only failed network requests.

```bash
./do "get network errors"
./do "show network failures"
./do "what network requests failed"
```

**Use Cases:**
- API error debugging
- Network failure analysis
- Connection issue identification
- Request timeout tracking

#### `wipeLogs`
Clear all stored browser logs from memory.

```bash
./do "wipe browser logs"
./do "clear all logs"
./do "reset browser logs"
```

**Use Cases:**
- Starting fresh debugging session
- Reducing memory usage
- Clearing old data
- Resetting state

### 2. Visual Capture

#### `takeScreenshot`
Capture a screenshot of the current browser tab.

```bash
./do "take screenshot"
./do "screenshot current page"
./do "capture browser screenshot"
./do "take screenshot of this page"
```

**Advanced Usage:**
```bash
# With custom text description
./do "take screenshot with description: showing login form"
```

**Features:**
- Automatically saves to `$VODOU_PROJECT_PATH/screenshots`
- Auto-pastes into Cursor (if enabled)
- PNG format for clipboard
- JPEG format for AI analysis
- Timestamp-based filenames

**Use Cases:**
- Documenting UI state
- Visual debugging
- Before/after comparisons
- Visual regression testing
- Sharing current state with AI

### 3. Element Inspection

#### `getSelectedElement`
Get the currently selected DOM element from the browser.

```bash
./do "get selected element"
./do "show selected element"
./do "what element is selected"
./do "inspect selected element"
```

**Use Cases:**
- Element-specific debugging
- CSS analysis
- DOM structure inspection
- Element property analysis
- Accessibility checking

### 4. Web Audits

#### `runAccessibilityAudit`
Run WCAG-compliant accessibility audit.

```bash
./do "run accessibility audit"
./do "check accessibility"
./do "audit page accessibility"
./do "WCAG compliance check"
```

**Checks:**
- Color contrast
- Missing alt text
- Keyboard navigation
- ARIA attributes
- Screen reader compatibility

**Use Cases:**
- Accessibility compliance
- WCAG validation
- Inclusive design verification
- Legal compliance

#### `runPerformanceAudit`
Run Lighthouse performance audit.

```bash
./do "run performance audit"
./do "check page performance"
./do "audit performance"
./do "why is this page slow"
```

**Checks:**
- Render-blocking resources
- DOM size
- Image optimization
- JavaScript execution time
- Network latency

**Use Cases:**
- Performance optimization
- Speed improvement
- User experience enhancement
- Core Web Vitals tracking

#### `runSEOAudit`
Run SEO optimization audit.

```bash
./do "run SEO audit"
./do "check SEO"
./do "audit SEO"
./do "how can I improve SEO"
```

**Checks:**
- Meta tags
- Heading structure
- Link structure
- Content optimization
- Search visibility

**Use Cases:**
- SEO optimization
- Search engine visibility
- Content improvement
- Ranking enhancement

#### `runBestPracticesAudit`
Run general web development best practices audit.

```bash
./do "run best practices audit"
./do "check best practices"
./do "audit best practices"
```

**Checks:**
- Security headers
- HTTPS usage
- Console errors
- Image formats
- Modern web standards

**Use Cases:**
- Code quality
- Security verification
- Standards compliance
- Best practice adherence

#### `runNextJSAudit`
Run NextJS-specific SEO and best practices audit.

```bash
./do "run NextJS audit"
./do "check NextJS SEO"
./do "audit NextJS application"
./do "NextJS optimization"
```

**Checks:**
- NextJS meta tag implementation
- App router vs Pages router
- Image optimization
- Route structure
- NextJS-specific SEO

**Use Cases:**
- NextJS optimization
- Framework-specific SEO
- NextJS best practices
- App/Pages router analysis

**⏸️ STOPPING POINT**: Before running NextJS audit, confirm:
- Is this actually a NextJS application?
- Which router is being used (app or pages)?

### 5. Advanced Workflows

<!-- AGENT_ACTIONS: {"stopping_points": [
  {
    "id": 1,
    "title": "Choose browser action",
    "options": {
      "1": {"label":"Run full audit mode","vars":{},"steps":[
        {"server":"browser-tools-mcp","tool":"runAccessibilityAudit","args":{}},
        {"server":"browser-tools-mcp","tool":"runPerformanceAudit","args":{}},
        {"server":"browser-tools-mcp","tool":"runBestPracticesAudit","args":{}},
        {"server":"browser-tools-mcp","tool":"runSEOAudit","args":{}}
      ]},
      "2": {"label":"Run debugger mode","vars":{},"steps":[
        {"server":"browser-tools-mcp","tool":"getConsoleErrors","args":{}},
        {"server":"browser-tools-mcp","tool":"getConsoleLogs","args":{}},
        {"server":"browser-tools-mcp","tool":"getNetworkErrors","args":{}},
        {"server":"browser-tools-mcp","tool":"takeScreenshot","args":{}}
      ]},
      "3": {"label":"Take screenshot only","vars":{},"steps":[
        {"server":"browser-tools-mcp","tool":"takeScreenshot","args":{}}
      ]}
    }
  }
]} -->

#### `runAuditMode`
Run all audits in sequence for comprehensive analysis.

```bash
./do "run audit mode"
./do "enter audit mode"
./do "comprehensive audit"
./do "full page audit"
```

**Execution Sequence:**
1. Accessibility audit
2. Performance audit
3. Best practices audit
4. SEO audit
5. NextJS audit (if applicable)

**Workflow:**
1. Runs all audits sequentially
2. Provides comprehensive analysis
3. Identifies codebase improvements
4. Creates step-by-step plan
5. Asks for approval before changes
6. Re-runs audits after implementation
7. Iterates until optimized

**⏸️ STOPPING POINT**: After audit mode analysis:
- Review the comprehensive plan
- Approve or request modifications
- Confirm before implementation

#### `runDebuggerMode`
Run comprehensive debugging workflow.

```bash
./do "run debugger mode"
./do "enter debugger mode"
./do "debug this issue"
./do "start debugging"
```

**Debugging Sequence:**
1. Reflect on 5-7 possible problem sources
2. Distill to 1-2 most likely sources
3. Add additional logs to validate assumptions
4. Get console logs, errors, network logs
5. Obtain server logs (if accessible)
6. Deep analysis of the issue
7. Suggest additional logs if needed
8. Implement fix
9. Ask for approval to remove debug logs

**⏸️ STOPPING POINT**: During debugging:
- Review identified problem sources
- Approve log additions
- Review analysis before fix
- Approve log removal after fix

## Common Workflows

### Workflow 1: Quick Debugging

```bash
# 1. Check for errors
./do "get console errors network errors"

# 2. Take screenshot for context
./do "take screenshot"

# 3. Get selected element if inspecting specific part
./do "get selected element"
```

### Workflow 2: Performance Investigation

```bash
# 1. Run performance audit
./do "run performance audit"

# 2. Check network logs for slow requests
./do "get network logs"

# 3. Take screenshot of current state
./do "take screenshot"
```

### Workflow 3: Accessibility Compliance

```bash
# 1. Run accessibility audit
./do "run accessibility audit"

# 2. Get selected element for specific checks
./do "get selected element"

# 3. Re-run audit after fixes
./do "run accessibility audit"
```

### Workflow 4: Full Page Analysis

```bash
# 1. Enter audit mode for comprehensive analysis
./do "run audit mode"

# 2. Review plan and approve
# 3. Implementation happens automatically
# 4. Audits re-run automatically
```

### Workflow 5: Issue Debugging

```bash
# 1. Enter debugger mode
./do "run debugger mode"

# 2. Follow the debugging sequence
# 3. Review analysis
# 4. Approve fixes
```

## Parallel Execution Examples

Vodou's parallel execution makes browser debugging faster:

```bash
# Get all logs simultaneously
./do "get console logs get console errors get network logs get network errors"

# Run multiple audits in parallel (if supported)
./do "run accessibility audit run performance audit run SEO audit"

# Comprehensive debugging
./do "get console errors get network errors take screenshot get selected element"
```

## Best Practices

### 1. **Start with Logs**
Before running audits, check logs first:
```bash
./do "get console errors get network errors"
```

### 2. **Use Screenshots for Context**
Always take screenshots when debugging:
```bash
./do "take screenshot"
```

### 3. **Clear Logs Between Sessions**
Start fresh debugging sessions:
```bash
./do "wipe logs"
```

### 4. **Use Audit Mode for Comprehensive Analysis**
For full page optimization:
```bash
./do "run audit mode"
```

### 5. **Use Debugger Mode for Issues**
For specific problems:
```bash
./do "run debugger mode"
```

### 6. **Verify Setup First**
Always check prerequisites:
- Browser-tools-server running?
- Chrome extension enabled?
- DevTools panel open?

## Troubleshooting

### "Server not found" Error
**Problem**: Browser-tools-mcp server not connected
**Solution**: 
```bash
# Check registered servers for browser-tools-mcp connection
./do "list"  # Should show browser-tools-mcp
```

### "Failed to connect to server" Error
**Problem**: Browser-tools-server not running
**Solution**: 
```bash
# Start browser-tools-server in separate terminal
npx @agentdeskai/browser-tools-server@latest
```

### "No logs found" Error
**Problem**: Chrome extension not capturing logs
**Solution**:
1. Open Chrome DevTools
2. Navigate to BrowserToolsMCP panel
3. Ensure extension is enabled
4. Refresh the page

### Screenshots Not Saving
**Problem**: Screenshots not appearing in expected location
**Solution**:
- Check `$VODOU_PROJECT_PATH/screenshots` directory
- Verify `VODOU_PROJECT_PATH` environment variable
- Check Chrome extension settings

### Audits Not Running
**Problem**: Audit tools timing out or failing
**Solution**:
- Ensure Chrome/Chromium is installed
- Check browser-tools-server is running
- Verify page is fully loaded
- Try running individual audits first

## Quick Reference

```bash
# Logging
./do "get console logs"              # All console logs
./do "get console errors"             # Console errors only
./do "get network logs"               # All network requests
./do "get network errors"             # Failed requests
./do "wipe logs"                      # Clear all logs

# Visual
./do "take screenshot"                # Capture current page

# Inspection
./do "get selected element"           # Selected DOM element

# Audits
./do "run accessibility audit"       # WCAG compliance
./do "run performance audit"          # Performance analysis
./do "run SEO audit"                  # SEO optimization
./do "run best practices audit"       # Best practices
./do "run NextJS audit"               # NextJS-specific

# Workflows
./do "run audit mode"                 # Comprehensive audit
./do "run debugger mode"              # Debugging workflow
```

## Integration with Other Vodou Tools

### With Vodou memory (project context)
```bash
# 1. Run browser audit
./do "run performance audit"

# 2. Cross-check prior notes — memory is injected on Vodou prompts; scan MEMORY.md / memory/*.md for frontend perf or audit history
./do "log: analysis: browser perf audit follow-up | notes: …"
```

### After a debugging pass
```bash
./do "run debugger mode"
# Persist anything reusable: ./?do "log: …" so promotion picks it into MEMORY.md
```

### With Vodou-script-executor (Automation)
```bash
# 1. Run audit
./do "run audit mode"

# 2. Execute fixes via scripts
./do "run fix script for accessibility issues"
```

## Advanced Patterns

### Pattern 1: Continuous Monitoring
```bash
# Monitor logs while testing
./do "get console logs get network logs take screenshot"
# ... perform action ...
./do "get console logs get network logs take screenshot"
```

### Pattern 2: Before/After Comparison
```bash
# Before
./do "take screenshot run performance audit"

# ... make changes ...

# After
./do "take screenshot run performance audit"
```

### Pattern 3: Multi-Page Analysis
```bash
# Navigate to page 1
./do "run audit mode"

# Navigate to page 2
./do "run audit mode"

# Compare results
```

## Remember

- **Always verify setup** before starting
- **Use parallel execution** for faster debugging
- **Take screenshots** for visual context
- **Clear logs** between sessions
- **Use audit mode** for comprehensive analysis
- **Use debugger mode** for specific issues
- **Review plans** before implementation
- **Re-run audits** after fixes

Browser-tools-mcp makes web debugging and optimization 10x faster through Vodou's orchestrated intelligence! 🚀

