# Intents Guide - Natural Language Routing

## What are Intents?

**Intents** are natural language keywords that map to **MCP server tools** OR **Skills**. They enable you to use simple phrases like `"cpu"` (for MCP tools) or `"hello"` (for skills) instead of remembering complex server/tool names or skill names.

### Key Concepts

- **Keyword**: Natural language trigger (e.g., "cpu", "memory", "hello", "mastery")
- **Mapping**: Links keyword to `server::tool` combination (MCP) or skill (via vodou-core)
- **Priority**: Determines which intent is used when multiple match
- **Routing**: Vodou automatically routes queries to the right tool or skill
- **Two Types**: MCP server tools and Skills

## How Intents Work

### Intent Detection Flow

**For MCP Server Tools:**
```
User Query: "./do cpu"
    ↓
Vodou analyzes query
    ↓
Looks up "cpu" in intent_mappings table
    ↓
Finds: cpu → mcp-monitor::get_cpu_info (priority: 10)
    ↓
Executes: mcp-monitor::get_cpu_info
    ↓
Returns results
```

**For Skills:**
```
User Query: "./do hello"
    ↓
Vodou analyzes query
    ↓
Looks up "hello" in intent_mappings table
    ↓
Finds: hello → vodou-core::load_skill (priority: 10)
    tool_parameters: {"skill_name": "hello"}
    ↓
Executes: vodou-core::load_skill with skill_name
    ↓
Loads and presents: hello skill content
```

### Database Schema

**intent_mappings table:**
```sql
CREATE TABLE intent_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL,
    server_name TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    priority INTEGER DEFAULT 1,
    execution_type TEXT DEFAULT 'mcp',
    requires_session BOOLEAN DEFAULT 0,
    session_timeout INTEGER DEFAULT 3600,
    tool_parameters TEXT,  -- JSON orchestration directives
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(keyword, server_name, tool_name)
);
```

### Priority System

- **Higher priority** = preferred when multiple intents match
- **Default priority**: 1
- **Common intents**: 10
- **Custom workflows**: 15+
- **System intents**: 20+

## Viewing Intents

### List All Intents

**Natural Language (Recommended):**
```bash
./do "show me all intent mappings"
```

**CLI Command:**
```bash
./do intent list
```

**Output shows:**
- Keyword
- Server::Tool mapping
- Priority level
- Usage examples

### Filter by Category

```bash
./do "show me intent mappings for docker"
./do "show me intent mappings for browser"
./do "show me intent mappings for system"
./do "show me intent mappings for code"
```

### View Specific Intent

```bash
./do intent show cpu
./do intent show memory
./do intent show analyze
```

### Test an Intent

```bash
./do intent test cpu "check my cpu usage"
./do intent test analyze "analyze my codebase"
```

## Creating Intents

### For MCP Server Tools

**Natural Language Method (Recommended):**
```bash
./do "add intent mapping: keyword → server::tool priority X"
```

**Examples:**
```bash
# Basic MCP tool intent
./do "add intent mapping: performance → mcp-monitor::get_cpu_info priority 10"

# Lower priority alternative
./do "add intent mapping: speed → mcp-monitor::get_cpu_info priority 5"

# Custom workflow shortcut
./do "add intent mapping: morning-routine → mcp-monitor::get_system_info priority 15"

# Code analysis intent
./do "add intent mapping: review → chrome-devtools::take_snapshot priority 10"
```

**CLI Method:**
```bash
./do intent add <keyword> <server> <tool> [priority]
```

**Examples:**
```bash
./do intent add "backup" "filesystem" "backup_files" 10
./do intent add "screenshot" "browser-tools-stdio" "takeScreenshot" 10
./do intent add "search" "stackoverflow-mcp" "search_by_tags" 8
```

### For Skills

**Direct Database Method (Recommended for Skills):**
```sql
sqlite3 vodou-core.db "INSERT INTO intent_mappings 
(keyword, server_name, tool_name, execution_type, priority, tool_parameters) VALUES 
('keyword', 'vodou-core', 'vc_load_skill', 'mcp', 10, 
 '{\"skill_name\": \"skill-name\"}');"
```

**Examples:**
```bash
# Add skill intent
sqlite3 vodou-core.db "INSERT INTO intent_mappings 
(keyword, server_name, tool_name, execution_type, priority, tool_parameters) VALUES 
('mastery', 'vodou-core', 'vc_load_skill', 'mcp', 10, 
 '{\"skill_name\": \"mastery\"}');"

# Add multiple trigger phrases for a skill
sqlite3 vodou-core.db "INSERT INTO intent_mappings 
(keyword, server_name, tool_name, execution_type, priority, tool_parameters) VALUES 
('create skill', 'vodou-core', 'vc_load_skill', 'mcp', 10, 
 '{\"skill_name\": \"skill-development\"}'),
('develop skill', 'vodou-core', 'vc_load_skill', 'mcp', 10, 
 '{\"skill_name\": \"skill-development\"}'),
('skill development', 'vodou-core', 'vc_load_skill', 'mcp', 9, 
 '{\"skill_name\": \"skill-development\"}');"
```

**Note**: Skills typically use the `install-<skill-name>.sh` script to register their intents automatically.

## Managing Intents

### Remove an Intent

**Natural Language:**
```bash
./do "remove intent mapping: keyword"
```

**CLI:**
```bash
./do intent remove keyword
```

**Examples:**
```bash
./do "remove intent mapping: performance"
./do intent remove old_keyword
```

### Update an Intent

**Method 1: Remove and Re-add**
```bash
./do intent remove old_keyword
./do "add intent mapping: new_keyword → server::tool priority 10"
```

**Method 2: Direct Database (Advanced)**
```sql
sqlite3 vodou-core.db "UPDATE intent_mappings 
SET keyword = 'new_keyword', priority = 15 
WHERE keyword = 'old_keyword';"
```

### Verify Intent

```bash
# Check if intent exists
./do intent show keyword

# Test the intent
./do intent test keyword "test query"

# Use the intent
./do "keyword"
```

## Intent Best Practices

### 1. Use Clear, Descriptive Keywords

**✅ Good Keywords:**
- `cpu`, `memory`, `disk` - Clear and specific
- `analyze`, `backup`, `screenshot` - Action-oriented
- `system-health`, `code-review` - Descriptive

**❌ Avoid:**
- `thing`, `stuff`, `doit` - Too vague
- `a`, `the`, `it` - Too generic
- `xyz123` - Not descriptive

### 2. Set Appropriate Priorities

**Priority Guidelines:**
- **10**: Common, frequently used intents (system monitoring, common tools)
- **5**: Less common but useful alternatives
- **1**: Default, fallback intents
- **15+**: Custom workflows, shortcuts, orchestrated intents
- **20+**: System-level, critical intents

**Example:**
```bash
# Primary intent (high priority)
./do "add intent mapping: cpu → mcp-monitor::get_cpu_info priority 10"

# Alternative intent (lower priority)
./do "add intent mapping: processor → mcp-monitor::get_cpu_info priority 5"
```

### 3. Group Related Intents

**Create intents that work well together:**
```bash
# System monitoring group
./do "add intent mapping: cpu → mcp-monitor::get_cpu_info priority 10"
./do "add intent mapping: memory → mcp-monitor::get_memory_info priority 10"
./do "add intent mapping: disk → mcp-monitor::get_disk_info priority 10"
./do "add intent mapping: network → mcp-monitor::get_network_info priority 10"

# Now use together: ./do "cpu memory disk network"
```

### 4. Consider Parallel Execution

**Create intents that can execute in parallel:**
```bash
# These can all run simultaneously
./do "cpu memory disk network"
# All execute in parallel automatically
```

### 5. Test Your Intents

**Always test new intents:**
```bash
# Test the intent
./do intent test keyword "your test query"

# Verify it works
./do "keyword"
```

## Common Intent Patterns

### MCP Server Tool Intents

**System Monitoring:**
```bash
cpu → mcp-monitor::get_cpu_info (priority: 10)
memory → mcp-monitor::get_memory_info (priority: 10)
disk → mcp-monitor::get_disk_info (priority: 10)
network → mcp-monitor::get_network_info (priority: 10)
performance → mcp-monitor::get_cpu_info (priority: 10)
```

**Code Analysis:**
```bash
analyze → context7::resolve_library_id (priority: 10) — codebase context: Vodou memory + rg
codebase → skills + local toolchain (priority: 9)
review → code-review skill (priority: 8)
```

**Browser Automation:**
```bash
screenshot → browser-tools-stdio::takeScreenshot (priority: 10)
console → browser-tools-stdio::getConsoleErrors (priority: 10)
navigate → browser-tools-stdio::navigate (priority: 10)
```

**Help & Search:**
```bash
error → stackoverflow-mcp::search_by_tags (priority: 10)
help → stackoverflow-mcp::search_by_tags (priority: 9)
search → stackoverflow-mcp::search_by_tags (priority: 8)
```

### Skill Intents

**Help & Guidance:**
```bash
hello → vodou-core::load_skill (priority: 10)
  tool_parameters: {"skill_name": "hello"}

oi mastery → vodou-core::load_skill (priority: 10)
  tool_parameters: {"skill_name": "mastery"}

create oi skill → vodou-core::load_skill (priority: 10)
  tool_parameters: {"skill_name": "skill-development"}
```

**Installation & Setup:**
```bash
install mcp server → vodou-core::load_skill (priority: 10)
  tool_parameters: {"skill_name": "mcp-installer"}

build mcp server → vodou-core::load_skill (priority: 10)
  tool_parameters: {"skill_name": "mcp-builder"}
```

## Intent Visibility

### Intent Feedback

**When you use an intent, Vodou shows:**
- Which intent mapping was used
- Available related intents
- Priority information

**Example:**
```bash
./do "cpu"

# Output includes:
# 📋 INTENT MAPPING USED: cpu → mcp-monitor::get_cpu_info (priority: 10)
# 🔧 AVAILABLE INTENTS: memory, disk, network, analyze, ...
```

### Verbose Mode

**See detailed intent information:**
```bash
./do -v "cpu"
# Shows full intent detection and routing details
```

## Advanced: Intent Orchestration

### Orchestrated Intents

**Intents can include orchestration directives in `tool_parameters`:**

```sql
-- Basic orchestration: CPU → Memory (automatic)
INSERT INTO intent_mappings (keyword, server_name, tool_name, priority, tool_parameters) VALUES 
('system-check', 'mcp-monitor', 'get_cpu_info', 15, 
 '{"orchestration": {"next_intent": "memory", "execution_type": "immediate"}}');

-- Conditional orchestration: Analysis → User choice
INSERT INTO intent_mappings (keyword, server_name, tool_name, priority, tool_parameters) VALUES
('health-check', 'mcp-monitor', 'get_system_info', 15,
 '{"orchestration": {"execution_type": "conditional", "user_choice_required": true, 
   "options": [{"label": "Optimize memory", "intent": "memory cleanup"}, 
               {"label": "Optimize disk", "intent": "disk cleanup"}]}}');
```

**See**: `docs-DEV/database-schema.md` for complete orchestration configuration (internal doc path)

## Troubleshooting Intents

### Intent Not Found

**Problem**: Intent doesn't exist or isn't recognized

**Solutions:**
1. **Check spelling**: `./do intent list`
2. **Verify server/tool exists**: `./do list`
3. **Check if intent was removed**: `./do intent show keyword`

### Wrong Tool Executing

**Problem**: Different tool executes than expected

**Solutions:**
1. **Check priority**: `./do intent show keyword`
2. **Multiple intents may match**: Higher priority wins
3. **Check for conflicts**: `./do intent list` to see all mappings

### Intent Not Working

**Problem**: Intent exists but doesn't execute

**Solutions:**
1. **Verify server is connected**: `./do list`
2. **Check server health**: `./do "status server-name"`
3. **Test the intent**: `./do intent test keyword "query"`
4. **Check tool name**: Verify exact tool name matches

### Priority Conflicts

**Problem**: Wrong intent executes due to priority

**Solutions:**
1. **Check priorities**: `./do intent list`
2. **Update priority**: Remove and re-add with new priority
3. **Use more specific keyword**: Avoid generic keywords

## Intent Management Commands

### Complete Command Reference

```bash
# Discovery
./do "show me all intent mappings"           # List all
./do "show me intent mappings for <category>" # Filter
./do intent list                             # CLI list
./do intent show <keyword>                   # Show specific

# Management
./do "add intent mapping: keyword → server::tool priority X"  # Add (natural)
./do intent add <keyword> <server> <tool> [priority]          # Add (CLI)
./do "remove intent mapping: keyword"                         # Remove (natural)
./do intent remove <keyword>                                  # Remove (CLI)

# Testing
./do intent test <keyword> <query>          # Test intent
./do "keyword"                               # Use intent
```

## Resources

- **Database Schema**: `docs-DEV/database-schema.md` - Intent table structure (internal)
- **CLI Reference**: `docs/cli-reference.md` - Complete command reference
- **Architecture**: `docs-DEV/architecture.md` - Intent system architecture (internal)
- **Tool Routing**: `docs-DEV/universal-tool-routing.md` - How routing works (internal)

## Next Steps

1. **Explore**: `./do "show me all intent mappings"` - See existing intents
2. **Create**: Add your own custom intents
3. **Test**: Verify your intents work correctly
4. **Optimize**: Group related intents for parallel execution

---

**Intents make Vodou's natural language interface possible!** 🎯

