# Script Integration Examples
## How Scripts Blend Seamlessly with MCP Tools

## 🎯 **Core Concept: Invisible Integration**

Scripts work **exactly like MCP tools** through the same intent system. Users never need to know which is which.

---

## 📝 **Natural Language Examples**

### **MCP Tools (Existing)**
```bash
# These are MCP tool calls
./do "chrome-devtools blueprint"              # → MCP: get_project_blueprint
./do "open example.com in browser"            # → MCP: chrome-devtools (navigate_page, etc.)
./do "take snapshot of the page"              # → MCP: take_snapshot (when mapped)
```

### **Scripts (New - Same Syntax!)**
```bash
# These are script calls - but syntax is identical!
./do "nightly backup"            # → Script: npm run learn
./do "chrome-devtools learn directory"       # → Script: npm run learn:dir
./do "chrome-devtools force learn"           # → Script: npm run learn:force
```

### **Mixed Usage (User Can't Tell)**
```bash
# User types natural language - system routes transparently
./do "chrome-devtools blueprint"              # MCP tool
./do "nightly backup"           # Script (background)
./do "chrome-devtools analyze codebase"     # MCP tool
./do "chrome-devtools learn directory ./src" # Script (background)

# All work the same way - user doesn't need to know!
```

---

## 🔄 **How It Works (High-Level)**

### **Step 1: Intent Registration**
```sql
-- MCP Tool Intent (existing)
INSERT INTO intent_mappings (keyword, server_name, tool_name, execution_type, priority) VALUES
  ('chrome-devtools blueprint', 'chrome-devtools', 'get_project_blueprint', 'mcp', 10);

-- Script Intent (new - same table!)
INSERT INTO intent_mappings (keyword, server_name, script_name, execution_type, priority) VALUES
  ('nightly backup', 'chrome-devtools', 'learn', 'script', 10);
```

### **Step 2: User Query**
```bash
./do "nightly backup"
```

### **Step 3: Intent Matching (Existing System)**
```
Query: "nightly backup"
  ↓
Intent Matcher finds: (chrome-devtools, learn, script)
  ↓
execution_type = 'script'
```

### **Step 4: Execution Routing**
```
if execution_type == 'mcp':
    → Execute MCP tool call (existing)
    
if execution_type == 'script':
    → Get script from script_registry
    → Execute: npm run learn
    → Return formatted output (same format as MCP)
```

### **Step 5: User Sees**
```
✅ Background job started: job_abc123
📊 Progress: 0% (0/1000 files)
⏱️  Estimated: 15 minutes

Check status: ./do "script status job_abc123"
```

---

## 🎨 **Intent Mapping Examples**

### **Auto-Discovered Scripts**
```sql
-- When package.json is scanned, scripts are auto-registered:

-- From package.json:
{
  "scripts": {
    "learn": "bash scripts/auto-learn.sh",
    "learn:force": "bash scripts/auto-learn.sh --force",
    "learn:dir": "bash scripts/learn-directory.sh"
  }
}

-- Auto-creates intents:
INSERT INTO intent_mappings (keyword, server_name, script_name, execution_type, priority) VALUES
  ('chrome-devtools learn', 'chrome-devtools', 'learn', 'script', 10),
  ('nightly backup', 'chrome-devtools', 'learn', 'script', 10),
  ('chrome-devtools force learn', 'chrome-devtools', 'learn:force', 'script', 10),
  ('chrome-devtools learn directory', 'chrome-devtools', 'learn:dir', 'script', 10);
```

### **Manual Intent Creation**
```bash
# Via CLI (future)
./do intent add "nightly backup" "chrome-devtools" --script "learn"

# Via SQL (now)
sqlite3 vodou-core.db <<SQL
INSERT INTO intent_mappings (keyword, server_name, script_name, execution_type, priority) 
VALUES ('nightly backup', 'chrome-devtools', 'learn', 'script', 10);
SQL
```

---

## 🚀 **Execution Flow Comparison**

### **MCP Tool Execution**
```
./do "chrome-devtools blueprint"
  ↓
Intent: (chrome-devtools, get_project_blueprint, mcp)
  ↓
vodou-core call chrome-devtools get_project_blueprint '{}'
  ↓
MCP Server Response
  ↓
Formatted Output
```

### **Script Execution (Identical Flow!)**
```
./do "nightly backup"
  ↓
Intent: (chrome-devtools, learn, script)
  ↓
Get script from script_registry
  ↓
Execute: npm run learn (in working_directory)
  ↓
Formatted Output (same format!)
```

**Key Point**: The execution path differs internally, but the user experience is identical!

---

## 💡 **Implementation Strategy (High-Level)**

Since we don't have binary source access, we can use a **wrapper/proxy approach**:

### **Option 1: Script Executor Wrapper**
```bash
# Create: scripts/script-executor.sh
#!/bin/bash
# Wraps script execution to integrate with vodou-core

SERVER=$1
SCRIPT=$2
PARAMS=$3

# Get script from database
SCRIPT_CMD=$(sqlite3 vodou-core.db "SELECT command FROM script_registry WHERE server_name='$SERVER' AND script_name='$SCRIPT'")
WORK_DIR=$(sqlite3 vodou-core.db "SELECT working_directory FROM script_registry WHERE server_name='$SERVER' AND script_name='$SCRIPT'")

# Execute script
cd "$WORK_DIR" && eval "$SCRIPT_CMD $PARAMS"
```

### **Option 2: Database-Driven Router**
The binary would check `execution_type` in the intent match:
- If `'mcp'`: Call MCP tool (existing code)
- If `'script'`: Call script executor (new code path)

Both return the same format, so the user experience is seamless.

---

## 🎯 **User Experience Goals**

1. ✅ **No "script" keyword needed** - just natural language
2. ✅ **Same syntax as MCP tools** - `./do "nightly backup"`
3. ✅ **Same output format** - can't tell difference
4. ✅ **Automatic background** - long scripts run in background
5. ✅ **Transparent routing** - system decides MCP vs Script

---

## 📊 **Example: Complete Workflow**

```bash
# 1. User wants to learn codebase
./do "nightly backup"

# 2. System matches intent (script)
# 3. Detects: background_execution = true
# 4. Starts background job
# 5. Returns job ID

✅ Background job started: job_abc123
📊 Check status: ./do "script status job_abc123"

# 6. User continues working, checks status later
./do "script status job_abc123"

Status: running (65%)
Progress: Processing 650 of 1000 files...
Started: 2024-12-29 14:30:00
Elapsed: 8 minutes
Estimated: 4 minutes remaining

# 7. Job completes, user gets results
./do "script output job_abc123"

✅ Learning completed successfully!
📊 Files processed: 1000
⏱️  Duration: 12 minutes
💾 Database updated: chrome-devtools.db

# 8. User can now use learned data
./do "chrome-devtools blueprint"  # Uses learned data (MCP tool)
./do "chrome-devtools patterns"    # Uses learned data (MCP tool)
```

---

## 🔑 **Key Takeaways**

1. **Scripts = First-Class Citizens**: Work exactly like MCP tools
2. **No Special Syntax**: Just natural language intents
3. **Transparent Routing**: System handles MCP vs Script automatically
4. **Same User Experience**: Can't tell difference between types
5. **Background Support**: Long scripts run automatically in background
6. **Seamless Integration**: Uses existing intent system, no new concepts

**The magic**: Scripts feel like MCP tools because they use the same intent system!

