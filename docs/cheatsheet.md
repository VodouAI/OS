# Vodou Command Cheatsheet

**Quick reference guide for all Vodou tools and commands**

---

## 📋 Table of Contents

- [Quick Start](#quick-start)
- [Advanced Usage: Chaining MCP Servers](#advanced-usage-chaining-mcp-servers)
- [System Monitoring (mcp-monitor)](#system-monitoring-mcp-monitor)
- [Browser Automation (browser-tools-stdio)](#browser-automation-browser-tools-stdio)
- [Memory & Context](#memory--context)
- [Sequential Thinking (OI-Sequential-Thinking)](#sequential-thinking-vodou-sequential-thinking)
- [Server Management](#server-management)
- [Output Modes](#output-modes)
- [Use Cases & Examples](#use-cases--examples)

---

## Quick Start

### Web UI

With the gateway enabled (**`START_AIGATEWAY=1`**, **`WEB_PORT`** default **8765**), open **http://localhost:8765** for chat, messaging, and settings. See [setup.md](setup.md) and [messaging.md](messaging.md).

### Basic Usage
```bash
# Get help
./do

# List all connected servers
./do list

# Check server status
./do status

# Natural language queries
./do "cpu"
./do "memory"
./do "take a screenshot"
```

### Output Modes
```bash
# Standard mode (default) - formatted output
./do cpu

# Verbose mode - detailed debugging info
./do -v cpu
./do --verbose "memory"

# Clean mode - raw JSON only
./do -c cpu
./do --clean "memory disk"
```

---

## Advanced Usage: Chaining MCP Servers

**One of Vodou's most powerful features**: You can extract data from one MCP server and use it as input to another server, creating powerful automation workflows.

### The Basic Pattern

```bash
# Step 1: Extract data from Server 1 (using clean mode + jq)
DATA=$(./do -c server1-tool 2>/dev/null | tail -n +3 | jq '.field')

# Step 2: Use that data with Server 2
./do "server2-tool with ${DATA}"
```

**Why this works:**
- MCP servers use JSON-RPC protocol (not traditional pipes)
- Clean mode (`-c`) gives you raw JSON output
- `jq` extracts specific fields from JSON
- Shell variables pass data between commands
- Vodou's natural language processing handles the integration

---

### Real-World Example: Monitor & Log

```bash
# Get CPU usage from mcp-monitor
CPU_USAGE=$(./do -c performance 2>/dev/null | tail -n +3 | jq '.usage_percent[0]')

# Log it to Vodou memory system
./do "add log entry CPU usage is ${CPU_USAGE}%"
```

**What happens:**
1. `./do -c performance` → Gets CPU data in JSON format
2. `2>/dev/null` → Suppresses error messages
3. `tail -n +3` → Skips instruction text, gets just JSON
4. `jq '.usage_percent[0]'` → Extracts the first CPU usage percentage
5. Variable stores the value (e.g., `25.87`)
6. `./do "add log entry..."` → Passes value to Vodou memory system
7. Vodou saves: "CPU usage is 25.87%"

---

### Complete System Health Monitoring Script

```bash
#!/bin/bash
# Collect all system metrics and log to Vodou memory

echo "Collecting system metrics..."

# Extract CPU usage
CPU_USAGE=$(./do -c cpu 2>/dev/null | tail -n +3 | jq '.usage_percent[0]')

# Extract memory usage
MEM_USAGE=$(./do -c memory 2>/dev/null | tail -n +3 | jq '.virtual.used_percent')

# Extract disk usage
DISK_USAGE=$(./do -c disk 2>/dev/null | tail -n +3 | jq '.usage.usedPercent')

# Create timestamp
TIMESTAMP=$(date +%Y-%m-%d)

# Log to Vodou memory with structured format
./do "add log entry ${TIMESTAMP}-System-Health-CPU:${CPU_USAGE}% Memory:${MEM_USAGE}% Disk:${DISK_USAGE}%"

echo "✅ Metrics logged: CPU ${CPU_USAGE}%, Memory ${MEM_USAGE}%, Disk ${DISK_USAGE}%"
```

---

### Advanced Example: Conditional Logging

```bash
#!/bin/bash
# Only log when CPU usage exceeds threshold

CPU_USAGE=$(./do -c performance 2>/dev/null | tail -n +3 | jq '.usage_percent[0]')
THRESHOLD=80

# Check if CPU usage is high (requires bc for floating point comparison)
if (( $(echo "$CPU_USAGE > $THRESHOLD" | bc -l) )); then
    ./do "add log entry ⚠️ High CPU usage detected: ${CPU_USAGE}%"
    echo "Alert: CPU usage is ${CPU_USAGE}%"
else
    echo "CPU usage normal: ${CPU_USAGE}%"
fi
```

---

### Extracting Multiple Fields

```bash
# Get multiple values from one query
CPU_DATA=$(./do -c cpu 2>/dev/null | tail -n +3)
CPU_USAGE=$(echo "$CPU_DATA" | jq '.usage_percent[0]')
CPU_CORES=$(echo "$CPU_DATA" | jq '.core_count')
CPU_MODEL=$(echo "$CPU_DATA" | jq -r '.info[0].modelName')

# Use all values
./do "add log entry System: ${CPU_MODEL} with ${CPU_CORES} cores, usage: ${CPU_USAGE}%"
```

---

### Chaining Multiple Servers

```bash
# Get screenshot from browser-tools
./do screenshot

# Get console errors
ERRORS=$(./do -c console 2>/dev/null | tail -n +3 | jq 'length')

# Log to Vodou memory
./do "add log entry Screenshot taken, ${ERRORS} console errors found"
```

---

### Using jq for Complex Extraction

```bash
# Extract nested JSON fields
MEM_DATA=$(./do -c memory 2>/dev/null | tail -n +3)
VIRTUAL_USED=$(echo "$MEM_DATA" | jq '.virtual.used')
VIRTUAL_TOTAL=$(echo "$MEM_DATA" | jq '.virtual.total')
SWAP_USED=$(echo "$MEM_DATA" | jq '.swap.used')

# Calculate percentage manually if needed
MEM_PERCENT=$(echo "scale=2; ($VIRTUAL_USED / $VIRTUAL_TOTAL) * 100" | bc)

# Log detailed memory info
./do "add log entry Memory: ${MEM_PERCENT}% used (${VIRTUAL_USED} / ${VIRTUAL_TOTAL}), Swap: ${SWAP_USED}"
```

---

### Common Patterns

#### Pattern 1: Extract → Log
```bash
VALUE=$(./do -c tool1 2>/dev/null | tail -n +3 | jq '.field')
./do "add log entry Value is ${VALUE}"
```

#### Pattern 2: Extract → Condition → Action
```bash
VALUE=$(./do -c tool1 2>/dev/null | tail -n +3 | jq '.field')
if [ "$VALUE" -gt 80 ]; then
    ./do "add log entry Alert: High value ${VALUE}"
fi
```

#### Pattern 3: Extract → Transform → Use
```bash
RAW=$(./do -c tool1 2>/dev/null | tail -n +3 | jq '.field')
FORMATTED=$(printf "%.2f" "$RAW")
./do "add log entry Formatted value: ${FORMATTED}"
```

#### Pattern 4: Multiple Extractions → Combined Log
```bash
CPU=$(./do -c cpu 2>/dev/null | tail -n +3 | jq '.usage_percent[0]')
MEM=$(./do -c memory 2>/dev/null | tail -n +3 | jq '.virtual.used_percent')
./do "add log entry System: CPU ${CPU}%, Memory ${MEM}%"
```

---

### Tips for Successful Chaining

#### 1. Always Use Clean Mode for Extraction
```bash
# ✅ Good - clean JSON output
DATA=$(./do -c cpu 2>/dev/null | tail -n +3 | jq '.field')

# ❌ Avoid - formatted output is hard to parse
DATA=$(./do cpu | grep "usage")
```

#### 2. Handle Errors Gracefully
```bash
# ✅ Good - handles missing data
CPU_USAGE=$(./do -c cpu 2>/dev/null | tail -n +3 | jq '.usage_percent[0]' 2>/dev/null || echo "0")
./do "add log entry CPU: ${CPU_USAGE}%"
```

#### 3. Use `tail -n +3` to Skip Instruction Text
```bash
# Clean mode includes instruction text, skip it
JSON=$(./do -c tool 2>/dev/null | tail -n +3)
```

#### 4. Validate Data Before Using
```bash
CPU_USAGE=$(./do -c cpu 2>/dev/null | tail -n +3 | jq '.usage_percent[0]')

# Check if value is valid
if [ -z "$CPU_USAGE" ] || [ "$CPU_USAGE" = "null" ]; then
    echo "Error: Could not get CPU usage"
    exit 1
fi

./do "add log entry CPU: ${CPU_USAGE}%"
```

#### 5. Use `jq -r` for String Values (No Quotes)
```bash
# ✅ Good - removes JSON quotes from strings
MODEL=$(./do -c cpu 2>/dev/null | tail -n +3 | jq -r '.info[0].modelName')
# Result: Apple M1 Pro (no quotes)

# ❌ Avoid - includes quotes
MODEL=$(./do -c cpu 2>/dev/null | tail -n +3 | jq '.info[0].modelName')
# Result: "Apple M1 Pro" (with quotes)
```

---

### Why This Is Powerful

**Traditional Approach** (without chaining):
```bash
# Manual process - multiple steps, copy-paste values
./do cpu                    # Check CPU
# Manually note: 25.87%
./do "add log entry CPU usage is 25.87%"  # Type it manually
```

**With Chaining** (automated):
```bash
# One command - fully automated
CPU_USAGE=$(./do -c cpu 2>/dev/null | tail -n +3 | jq '.usage_percent[0]') && \
./do "add log entry CPU usage is ${CPU_USAGE}%"
```

**Benefits:**
- ✅ **Automated**: No manual copying
- ✅ **Accurate**: No typos or mistakes
- ✅ **Scalable**: Works in scripts and cron jobs
- ✅ **Flexible**: Chain any servers together
- ✅ **Powerful**: Create complex workflows

---

### Example Workflows

#### Daily System Health Report
```bash
#!/bin/bash
# Run daily to track system health over time

DATE=$(date +%Y-%m-%d)
CPU=$(./do -c cpu 2>/dev/null | tail -n +3 | jq '.usage_percent[0]')
MEM=$(./do -c memory 2>/dev/null | tail -n +3 | jq '.virtual.used_percent')
DISK=$(./do -c disk 2>/dev/null | tail -n +3 | jq '.usage.usedPercent')

./do "add log entry ${DATE}-Daily-Health-CPU:${CPU}% MEM:${MEM}% DISK:${DISK}%"
```

#### Performance Alert System
```bash
#!/bin/bash
# Alert when resources are high

CPU=$(./do -c cpu 2>/dev/null | tail -n +3 | jq '.usage_percent[0]')
MEM=$(./do -c memory 2>/dev/null | tail -n +3 | jq '.virtual.used_percent')

if (( $(echo "$CPU > 80" | bc -l) )); then
    ./do "add log entry ⚠️ High CPU: ${CPU}%"
fi

if (( $(echo "$MEM > 90" | bc -l) )); then
    ./do "add log entry ⚠️ High Memory: ${MEM}%"
fi
```

#### Screenshot + Error Logging
```bash
#!/bin/bash
# Take screenshot and log any errors found

./do screenshot
ERROR_COUNT=$(./do -c console 2>/dev/null | tail -n +3 | jq 'length')
TIMESTAMP=$(date +%Y-%m-%d-%H%M%S)

./do "add log entry ${TIMESTAMP}-Screenshot-${ERROR_COUNT}-errors"
```

---

### Troubleshooting Chaining

#### Problem: `jq` command not found
```bash
# Install jq
# macOS:
brew install jq

# Linux:
sudo apt-get install jq
# or
sudo yum install jq
```

#### Problem: Getting "null" values
```bash
# Check the JSON structure first
./do -c cpu 2>/dev/null | tail -n +3 | jq '.'

# Verify the field path exists
./do -c cpu 2>/dev/null | tail -n +3 | jq '.usage_percent'
```

#### Problem: Variable is empty
```bash
# Add debugging
CPU_USAGE=$(./do -c cpu 2>/dev/null | tail -n +3 | jq '.usage_percent[0]')
echo "Debug: CPU_USAGE = '${CPU_USAGE}'"  # Check what you got

# Validate before using
if [ -z "$CPU_USAGE" ]; then
    echo "Error: Failed to get CPU usage"
    exit 1
fi
```

---

### Quick Reference: Chaining Commands

```bash
# Basic extraction
DATA=$(./do -c tool 2>/dev/null | tail -n +3 | jq '.field')

# Extract number
NUMBER=$(./do -c tool 2>/dev/null | tail -n +3 | jq '.number')

# Extract string (no quotes)
STRING=$(./do -c tool 2>/dev/null | tail -n +3 | jq -r '.string')

# Extract array element
ELEMENT=$(./do -c tool 2>/dev/null | tail -n +3 | jq '.array[0]')

# Extract nested field
NESTED=$(./do -c tool 2>/dev/null | tail -n +3 | jq '.parent.child')

# Count array length
COUNT=$(./do -c tool 2>/dev/null | tail -n +3 | jq 'length')

# Use in another command
./do "server2-tool with ${DATA}"
```

---

**💡 Pro Tip**: Start with simple extractions and build up to complex workflows. Test each step individually before chaining them together!

---

## System Monitoring (mcp-monitor)

**Purpose**: Monitor system resources and performance metrics

### CPU Information
```bash
# Get CPU usage and core information
./do cpu

# Example output:
# - Core count: 10
# - Model: Apple M1 Pro
# - Usage: 25.89%
# - Frequency: 3.23 GHz
```

**Use Cases:**
- Monitor CPU usage during heavy workloads
- Check system performance
- Debug performance bottlenecks
- Track resource consumption

---

### Memory Information
```bash
# Get memory usage statistics
./do memory

# Example output:
# - Virtual memory: 78.19% used (13.2 GB / 17.2 GB)
# - Swap: 92.51% used (11.9 GB / 12.9 GB)
# - Available: 3.7 GB
```

**Use Cases:**
- Monitor memory usage
- Detect memory leaks
- Plan system upgrades
- Optimize application memory usage

---

### Disk Information
```bash
# Get disk usage and I/O statistics
./do disk

# Example output:
# - Usage: 79.08% (786 GB / 995 GB)
# - File system: APFS
# - I/O counters for all disks
# - Read/Write statistics
```

**Use Cases:**
- Monitor disk space
- Track I/O performance
- Plan storage upgrades
- Identify disk bottlenecks

---

### System Status
```bash
# Check all server health status
./do status

# Example output:
# ✅ Vodou-Enhanced-Thinking - Online
# ✅ browser-tools-stdio - Online
# ✅ mcp-monitor - Online
```

**Use Cases:**
- Verify all services are running
- Quick health check
- Troubleshooting connectivity issues

---

### Performance Monitoring
```bash
# Get performance metrics (maps to CPU info)
./do performance

# Combined system check
./do "cpu memory disk"
```

**Use Cases:**
- Comprehensive system monitoring
- Performance baseline establishment
- Resource planning

---

## Browser Automation (browser-tools-stdio)

**Purpose**: Automate browser tasks, audits, and debugging

### Screenshots
```bash
# Take a screenshot of current browser page
./do screenshot

# Example output:
# Screenshot saved to: screenshots/screenshot-2025-12-28T01-53-18-230Z.png
# PNG version available for AI analysis
```

**Use Cases:**
- Document UI states
- Visual regression testing
- Debug layout issues
- Create documentation screenshots

---

### Console Logs
```bash
# Get all console logs
./do logs

# Get only console errors
./do console

# Example output:
# - Log messages with timestamps
# - Error messages
# - Warning messages
```

**Use Cases:**
- Debug JavaScript errors
- Monitor application logging
- Track user interactions
- Performance debugging

---

### Network Monitoring
```bash
# Get network request logs
./do network

# Example output:
# - HTTP requests
# - Response times
# - Failed requests
# - Network errors
```

**Use Cases:**
- Debug API calls
- Monitor network performance
- Track resource loading
- Identify slow requests

---

### SEO Audit
```bash
# Run comprehensive SEO audit
./do seo

# Example output:
# - Score: 80/100
# - Issues found: 2
# - Recommendations:
#   * Add meta description
#   * Fix robots.txt
```

**Use Cases:**
- Optimize website for search engines
- Identify SEO issues
- Improve search rankings
- Content optimization

---

### Quality Audit (Best Practices)
```bash
# Run best practices audit
./do quality

# Example output:
# - Score: 100/100
# - Security: ✅
# - Trust: ✅
# - User Experience: ✅
# - Browser Compatibility: ✅
```

**Use Cases:**
- Ensure code quality
- Security compliance
- Browser compatibility checks
- User experience validation

---

### Accessibility Audit
```bash
# Run accessibility audit
./do accessibility
./do a11y

# Checks:
# - ARIA labels
# - Keyboard navigation
# - Screen reader compatibility
# - Color contrast
```

**Use Cases:**
- Ensure WCAG compliance
- Improve accessibility
- Support assistive technologies
- Legal compliance

---

### Performance Audit
```bash
# Run performance audit
./do "performance audit"
./do speed
./do optimize

# Metrics:
# - Page load time
# - Resource optimization
# - Core Web Vitals
# - Performance score
```

**Use Cases:**
- Optimize page speed
- Improve Core Web Vitals
- Reduce load times
- Enhance user experience

---

### Comprehensive Audit Mode
```bash
# Run all audits in sequence
./do audit

# Runs:
# 1. Accessibility audit
# 2. Performance audit
# 3. Best practices audit
# 4. SEO audit
# 5. NextJS audit (if applicable)
```

**Use Cases:**
- Complete website analysis
- Pre-launch checklist
- Regular quality checks
- Comprehensive optimization

---

### NextJS Audit
```bash
# Run NextJS-specific SEO audit
./do nextjs
./do react
./do framework

# Checks:
# - Meta tags configuration
# - JSON-LD schema
# - Sitemap generation
# - robots.txt
# - Image optimization
```

**Use Cases:**
- NextJS SEO optimization
- Framework-specific best practices
# - Meta tag configuration
# - Structured data setup

---

### Debugger Mode
```bash
# Enter debugging mode
./do debugger
./do troubleshoot

# Provides:
# - Systematic debugging approach
# - Log collection guidance
# - Issue analysis framework
```

**Use Cases:**
- Systematic bug investigation
# - Debug complex issues
# - Collect diagnostic information
# - Structured problem-solving

---

### Element Selection
```bash
# Get currently selected element
./do element
./do select

# Example output:
# - Element details
# - CSS properties
# - DOM structure
# - Accessibility attributes
```

**Use Cases:**
- Inspect page elements
# - Debug CSS issues
# - Verify element properties
# - Accessibility testing

---

### Clear Logs
```bash
# Clear all browser logs
./do clear
./do reset
./do clean

# Clears:
# - Console logs
# - Network logs
# - Error logs
```

**Use Cases:**
- Start fresh debugging session
# - Clear old logs
# - Reset browser state

---

## Memory & Context

**Purpose**: Manage conversation memory, context, and knowledge

### Memory map (brain) & vaults

```bash
open "http://127.0.0.1:8765/#/memory?tab=map"   # Memory map — the constellation (standalone :8767 only with VODOU_BRAIN_STANDALONE=1)
./vodou-core call brain brain_overview '{}'     # agent-side: memory stats
./vodou-core mem vault create work --scopes web --tags DECISION
./vodou-core mem vault preview work             # exact membership before sharing
./vodou-core mem export --vault work            # share ONLY that vault (pack ZIP)
```

### Search Memory (hybrid FTS5+vector)
```bash
# Search memory.db chunks via the daemon's hybrid search pipeline
./vodou-core mem search "fundraising narrative" --top-k 5

# JSON output for scripting / agent consumption
./vodou-core mem search "continuity primitive" --json | jq '.results[].path'
```

Routes through the daemon's `cmd:"search"` socket — same pipeline BrainLoader uses (BGE reranker, scope boost). **Prefer this over raw `sqlite3 memory.db "... MATCH ..."`** — raw FTS5 skips the reranker. Distinct from Vodou-Recall's `search_conversation`, which searches gateway chat turns, not memory chunks.

### Correct / forget / pin (0.6.19)
```bash
# Fix a false fact (prefer over bare mem store)
./vodou-core mem correct "Right fact." --wrong "wrong snippet" --tag CORRECTION --json
./vodou-core call Vodou-Recall memory_correct '{"right":"…","chunk_id":"…"}'

# Forget import/capture only (native → correct, not reject)
./vodou-core call Vodou-Recall memory_reject '{"chunk_id":"…"}'

# Pin / unpin (elevates recall)
./vodou-core mem pin '<chunk-id>' --json
./vodou-core mem unpin '<chunk-id>' --json
```

Full behavior: [vodou-memory.md §Correct / forget / pin](./vodou-memory.md#correct--forget--pin-chat-mutation-surface-0619).

---

### Add Log Entry
```bash
# Add structured log entry
./do "add log entry test entry from Vodou command"
./do "add log"
./do "create log"

# Example output:
# ✅ Log entry created in session 'default'
# - Memory ID: 68a22b9e-2f0e-4949-aebb-a556e68db34d
```

**Use Cases:**
- Track milestones
# - Document decisions
# - Create audit trail
# - Build conversation history

---

### Create Session
```bash
# Create or switch to named session
./do "create session project-alpha"
./do "new session"
./do "switch session"

# Example output:
# ✅ Session 'project-alpha' created/activated
```

**Use Cases:**
- Organize conversations by project
# - Separate contexts
# - Manage multiple workflows
# - Context isolation

---

### Save Context
```bash
# Log contextual information
./do "save context important project details"
./do "log memory"
./do "contextual log"

# Example output:
# ✅ Contextual information logged to session 'default'
# - Context type: general
# - Memory ID: 7ad7edb8-d68d-461a-bc1e-c75eab50251e
```

**Use Cases:**
- Preserve important context
# - Remember key details
# - Build knowledge base
# - Maintain continuity

---

### View Logs
```bash
# List all log entries
./do "show logs"
./do "list logs"
./do "view logs"

# Example output:
# - 10 entries found
# - Timestamps
# - Content preview
# - Context types
```

**Use Cases:**
- Review conversation history
# - Find previous decisions
# - Audit trail
# - Context recovery

---

### Memory Recall
```bash
# Search and recall memories
./do "remember test memory recall"
./do "recall memory"
./do "find memory"
./do "search memory"

# Example output:
# - 5 matching results
# - Similarity scores
# - Timestamps
# - Full content
```

**Use Cases:**
- Find previous information
# - Semantic search
# - Context retrieval
# - Knowledge lookup

---

### Session Summary
```bash
# Generate session summary
./do "summarize test-session"
./do "session summary"
./do "summary"

# Example output:
# - Total memories: 2
# - By context type: general: 2
# - One-line summaries
```

**Use Cases:**
- Create session summaries
# - Transfer context
# - Document progress
# - Knowledge transfer

---

### Notebook Management

#### Add Notebook
```bash
# Add entry to knowledge library
./do "add notebook style_guide Always use clear variable names"
# Note: Requires direct call format for complex entries
```

#### Show Notebooks
```bash
# List all notebooks
./do "show notebook"
./do "list notebooks"

# Example output:
# - 13 entries across 10 notebooks
# - Notebook names
# - Last updated timestamps
# - Content previews
```

#### Use Notebook
```bash
# Activate notebook entries
./do "use notebook style_guide"
./do "get notebook"
./do "load notebook"

# Example output:
# - Notebook activated
# - Entries loaded
# - Active instructions
```

#### Notebook Status
```bash
# Check notebook status
./do "notebook status"
./do "notebook info"

# Example output:
# - Active notebooks
# - Entry counts
# - Last updated dates
```

**Use Cases:**
- Store coding standards
# - Maintain style guides
# - Keep project rules
# - Reference documentation

---

### Bridge Context
```bash
# Copy context between sessions
./do "bridge context test context bridging"
./do "copy context"
./do "transfer context"

# Example output:
# ✅ Bridged 10 memories from 'default' to 'default'
# - Memories copied: 10
```

**Use Cases:**
- Transfer context between sessions
# - Share knowledge
# - Merge conversations
# - Context migration

---

## Sequential Thinking (OI-Sequential-Thinking)

> **Note:** Many installs prefer **enhanced / deep thinking** flows (e.g. `./do "deep think …"`) or skills such as **deep-thinking**. The **OI-Sequential-Thinking** MCP server may not be present until you connect it—check `./do list` and your [setup.md](setup.md). The examples below assume that server is installed and named as shown.

**Purpose**: Structured, step-by-step problem-solving with dynamic adaptation and revision capabilities

### Sequential Thinking Process
```bash
# Start sequential thinking process
./do "sequential thinking analyze this problem"
./do "think step by step about the solution"
./do "think sequentially about optimizing performance"

# Example output:
# - Thought 1: Initial analysis
# - Thought 2: Breaking down components
# - Thought 3: Evaluating approaches
# - Solution hypothesis and verification
```

**Use Cases:**
- Breaking down complex problems into manageable steps
- Planning and design with room for revision
- Analysis that might need course correction
- Problems where the full scope isn't clear initially
- Multi-step solutions requiring context maintenance
- Filtering out irrelevant information

---

### Basic Sequential Thinking
```bash
# Simple sequential thinking query
./do "sequential thinking how to optimize database queries"
./do "think step by step about improving code performance"
./do "sequential thought about API design"

# The tool automatically:
# - Starts with thought 1 of 5 (default)
# - Sets nextThoughtNeeded to true
# - Extracts your query as the thought content
```

**What happens:**
1. Tool breaks down your query into structured thinking steps
2. Maintains context across multiple thoughts
3. Allows revision and branching as understanding deepens
4. Generates solution hypothesis when appropriate
5. Verifies hypothesis based on chain of thought

---

### Multi-Step Thinking Process
```bash
# The tool supports multi-step processes
# Step 1: Initial analysis
./do "sequential thinking step 1: understand the requirements"

# Step 2: Continue thinking
./do "sequential thinking step 2: analyze the constraints"

# Step 3: Final step
./do "sequential thinking step 3: synthesize solution - done"
```

**Key Features:**
- **Dynamic adjustment**: Change total thoughts as you progress
- **Revision capability**: Question or revise previous thoughts
- **Branching**: Explore alternative approaches
- **Flexible**: Add more thoughts even after reaching the "end"
- **Uncertainty expression**: Mark when unsure or exploring

---

### Advanced Usage: Direct Tool Calls

**For AI agents or scripts requiring explicit control:**

```bash
# Direct call with full parameters
./vodou-core call OI-Sequential-Thinking sequentialthinking '{
  "thought": "First, I need to understand the problem domain",
  "thoughtNumber": 1,
  "totalThoughts": 5,
  "nextThoughtNeeded": true
}'

# Continue to step 2
./vodou-core call OI-Sequential-Thinking sequentialthinking '{
  "thought": "Breaking down the problem into components",
  "thoughtNumber": 2,
  "totalThoughts": 5,
  "nextThoughtNeeded": true
}'

# Final step
./vodou-core call OI-Sequential-Thinking sequentialthinking '{
  "thought": "Synthesizing findings into a solution",
  "thoughtNumber": 5,
  "totalThoughts": 5,
  "nextThoughtNeeded": false
}'
```

---

### Revision and Branching

```bash
# Revise a previous thought
./vodou-core call OI-Sequential-Thinking sequentialthinking '{
  "thought": "Actually, I need to reconsider my approach from thought 2",
  "thoughtNumber": 3,
  "totalThoughts": 5,
  "nextThoughtNeeded": true,
  "isRevision": true,
  "revisesThought": 2
}'

# Branch into alternative approach
./vodou-core call OI-Sequential-Thinking sequentialthinking '{
  "thought": "Exploring an alternative approach",
  "thoughtNumber": 4,
  "totalThoughts": 5,
  "nextThoughtNeeded": true,
  "branchFromThought": 2,
  "branchId": "alt-approach-1"
}'
```

**Use Cases:**
- **Revision**: When you realize a previous thought was incorrect
- **Branching**: When you want to explore multiple solution paths
- **Branching**: For A/B testing different approaches

---

### Parameters Explained

**Required Parameters:**
- `thought` (string): Your current thinking step
- `nextThoughtNeeded` (boolean): Whether another thought is needed
- `thoughtNumber` (integer): Current thought number (1, 2, 3...)
- `totalThoughts` (integer): Estimated total thoughts needed

**Optional Parameters:**
- `isRevision` (boolean): Whether this revises previous thinking
- `revisesThought` (integer): Which thought number is being reconsidered
- `branchFromThought` (integer): Branching point thought number
- `branchId` (string): Identifier for the current branch
- `needsMoreThoughts` (boolean): If more thoughts are needed beyond initial estimate

---

### Natural Language Intent Mappings

The following keywords automatically route to sequential thinking:
- `sequential thinking`
- `think sequentially`
- `step by step thinking`
- `sequential thought`
- `think step by step`

**Examples:**
```bash
./do "sequential thinking about API design"
./do "think step by step how to optimize queries"
./do "step by step thinking about the architecture"
```

---

### Best Practices

#### 1. Start with Initial Estimate
```bash
# ✅ Good - provide initial scope
./do "sequential thinking step 1 of 5: analyze requirements"
```

#### 2. Adjust as Needed
```bash
# ✅ Good - adapt total thoughts
./do "sequential thinking step 3 of 7: need more analysis"
```

#### 3. Mark Revisions Clearly
```bash
# ✅ Good - explicit revision
./do "sequential thinking revise thought 2: reconsider approach"
```

#### 4. Use for Complex Problems
```bash
# ✅ Good - complex multi-step problems
./do "sequential thinking design a distributed system"

# ❌ Avoid - simple queries don't need sequential thinking
./do "sequential thinking what is 2+2"
```

---

### Common Patterns

#### Pattern 1: Problem Analysis
```bash
./do "sequential thinking analyze the performance bottleneck"
# Step 1: Identify the issue
# Step 2: Trace root causes
# Step 3: Evaluate solutions
# Step 4: Recommend approach
```

#### Pattern 2: Design Planning
```bash
./do "sequential thinking design the database schema"
# Step 1: Identify entities
# Step 2: Define relationships
# Step 3: Optimize for queries
# Step 4: Validate design
```

#### Pattern 3: Debugging Process
```bash
./do "sequential thinking debug the memory leak"
# Step 1: Reproduce issue
# Step 2: Identify potential causes
# Step 3: Test hypotheses
# Step 4: Implement fix
```

---

### Troubleshooting

#### Problem: Tool times out on natural language queries
```bash
# Solution: Use direct calls for reliability
./vodou-core call OI-Sequential-Thinking sequentialthinking '{
  "thought": "Your thinking here",
  "thoughtNumber": 1,
  "totalThoughts": 5,
  "nextThoughtNeeded": true
}'
```

#### Problem: Parameter extraction fails
```bash
# Solution: Direct calls bypass parameter extraction
# Natural language works but direct calls are more reliable
```

#### Problem: Need to adjust total thoughts
```bash
# Solution: Just continue with new totalThoughts value
./vodou-core call OI-Sequential-Thinking sequentialthinking '{
  "thought": "Realizing I need more steps",
  "thoughtNumber": 5,
  "totalThoughts": 8,
  "nextThoughtNeeded": true,
  "needsMoreThoughts": true
}'
```

---

## Server Management

### List Servers
```bash
# List all connected MCP servers
./do list

# Example output:
# - Vodou-Enhanced-Thinking: node ...
# - browser-tools-stdio: node ...
# - mcp-monitor: ./MCP-servers/...
```

---

### Health Check
```bash
# Check health of all servers
./do health-check

# Example output:
# ✅ All servers healthy
# - Response times
# - Status indicators
```

---

### Server Status
```bash
# Check individual server status
./do status server-name

# Check all servers
./do status
```

---

### Connect Server
```bash
# Connect to new MCP server
./do connect server-name command

# Example:
./do connect my-server "node server.js"
```

---

### Remove Server
```bash
# Remove MCP server
./do remove server-name
```

---

### Tools Discovery
```bash
# List tools for a server
./do tools server-name

# List all tools from all servers
./do all-tools

# Find specific tool
./do find-tool tool-name
```

---

## Output Modes

### Standard Mode (Default)
```bash
# Formatted output with metadata
./do cpu

# Includes:
# - Tool results
# - Intent mappings used
# - Related tools
# - AI agent guidance
```

---

### Verbose Mode
```bash
# Detailed debugging output
./do -v cpu
./do --verbose "memory"
./do -d disk

# Includes:
# - Full context loading
# - Parameter generation details
# - Execution traces
# - Complete metadata
```

---

### Clean Mode
```bash
# Raw JSON output only
./do -c cpu
./do --clean "memory"
./do --clean "cpu memory disk"

# Includes:
# - Only tool results (JSON)
# - No formatting
# - No metadata
# - Ideal for scripting/AI agents
```

---

## Use Cases & Examples

### Daily System Monitoring
```bash
# Quick system check
./do "cpu memory disk"

# Comprehensive health check
./do status
./do health-check
```

---

### Web Development Workflow
```bash
# Take screenshot for documentation
./do screenshot

# Check for console errors
./do console

# Run full audit
./do audit

# Check SEO
./do seo
```

---

### Debugging Session
```bash
# Enter debug mode
./do debugger

# Check console logs
./do logs

# Check network requests
./do network

# Clear logs and start fresh
./do clear
```

---

### Memory Management
```bash
# Create project session
./do "create session my-project"

# Log important decisions
./do "add log entry 2025-12-28-API-Design-Chose REST over GraphQL"

# Save context
./do "save context User prefers dark mode interface"

# Recall information
./do "remember API design decision"

# Memory pipeline (low-level)
./vodou-core mem render          # Build MEMORY.md from memory.db (what actually maintains it)
./vodou-core mem pin --text "…"  # Make a fact stick to the top of every render
# mem promote / promote-micro / compact are RETIRED (2026-08-16) — they wrote into
# a MEMORY.md zone that mem render now overwrites whole every 60s.
./vodou-core mem janitor          # autoDream consolidation (auto dry-run for first 3 runs)
./vodou-core mem janitor --force-live  # Skip dry-run window (DESTRUCTIVE)
./vodou-core mem archive          # Move >30d daily logs to memory/archive/
./vodou-core mem config           # Show extraction provider + flush config
```

---

### Quality Assurance
```bash
# Run all quality checks
./do audit

# Check specific areas
./do seo
./do quality
./do accessibility
./do "performance audit"
```

---

### Parallel Operations
```bash
# Run multiple tools simultaneously
./do "cpu memory disk console screenshot"

# All execute in parallel for 3-5x speedup
```

---

## Tips & Best Practices

### 1. Use Natural Language
```bash
# ✅ Good - natural language
./do "what is my cpu usage"
./do "take a screenshot"
./do "check for errors"

# ❌ Avoid - too technical
./do "mcp-monitor::get_cpu_info"
```

---

### 2. Combine Related Queries
```bash
# ✅ Good - related tools together
./do "cpu memory disk"
./do "console network"

# ❌ Avoid - unrelated tools
./do "cpu screenshot deep think"
```

---

### 3. Use Clean Mode for Scripting
```bash
# ✅ Good - for AI agents/scripts
./do -c cpu > cpu_data.json
./do --clean "memory" | jq .

# ✅ Good - for human reading
./do cpu
./do "memory"
```

---

### 4. Leverage Sessions for Projects
```bash
# ✅ Good - organized by project
./do "create session project-alpha"
./do "add log entry milestone reached"
./do "summarize project-alpha"

# ❌ Avoid - mixing contexts
./do "add log entry"  # Which project?
```

---

### 5. Regular Health Checks
```bash
# ✅ Good - proactive monitoring
./do status
./do health-check

# Run daily or before important work
```

---

## Common Patterns

### System Health Check
```bash
./do "cpu memory disk"
./do status
```

### Pre-Deployment Checklist
```bash
./do audit
./do seo
./do "performance audit"
```

### Debugging Workflow
```bash
./do debugger
./do console
./do network
./do screenshot
```

### Knowledge Management
```bash
./do "create session project-name"
./do "add log entry decision made"
./do "save context important detail"
./do "remember previous decision"
```

---

### Complex Problem Solving
```bash
# Use sequential thinking for complex problems
./do "sequential thinking design a scalable API architecture"
./do "think step by step about optimizing database performance"
./do "sequential thought analyze the security vulnerabilities"
```

---

## Troubleshooting

### Server Not Responding
```bash
# Check status
./do status

# Reconnect
./do reconnect server-name

# Health check
./do health-check
```

### Tool Not Found
```bash
# List available tools
./do tools server-name

# Find tool across servers
./do find-tool tool-name

# List all tools
./do all-tools
```

### Verbose Debugging
```bash
# Use verbose mode
./do -v "your query"

# Check logs
./do "show logs"
```

---

## Quick Reference

### System Monitoring
- `./do cpu` - CPU information
- `./do memory` - Memory usage
- `./do disk` - Disk usage
- `./do status` - Server status

### Browser Tools
- `./do screenshot` - Take screenshot
- `./do console` - Console errors
- `./do logs` - Console logs
- `./do network` - Network logs
- `./do audit` - Full audit
- `./do seo` - SEO audit
- `./do quality` - Quality audit

### Memory Management
- `./do "add log entry"` - Add log
- `./do "create session"` - New session
- `./do "remember"` - Recall memory
- `./do "show logs"` - View logs
- `./vodou-core mem janitor` - Run autoDream consolidation (dry-run for first 3 invokes)
- `./vodou-core mem render` - Build MEMORY.md from memory.db (replaces promote/compact, retired 2026-08-16)
- `./vodou-core mem pin` - Pin a fact so every render carries it

### Sequential Thinking
- `./do "sequential thinking"` - Start sequential thinking process
- `./do "think step by step"` - Step-by-step problem solving
- `./do "think sequentially"` - Sequential thought process
- `./vodou-core call OI-Sequential-Thinking sequentialthinking` - Direct tool call

### Server Management
- `./do list` - List servers
- `./do status` - Check status
- `./do health-check` - Health check
- `./do tools server-name` - List tools

---

## Need Help?

```bash
# Show help
./do

# List all commands
./do help

# Show intent mappings
./do "intent list"
```

---

**Last Updated**: 2025-12-28  
**Version**: Vodou v0.5.22-arm64  
**Total Tools Tested**: 27+  
**Success Rate**: 96.3%

