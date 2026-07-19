# Advanced Intent Management

## Overview

Advanced techniques for creating and managing intent mappings for both MCP servers and Skills.

## Intent Types

### MCP Server Tool Intents

**Map keywords to specific MCP server tools:**

```bash
# Format: keyword → MCP-server-name::tool-name priority X
cpu → mcp-monitor::get_cpu_info (priority: 10)
memory → mcp-monitor::get_memory_info (priority: 10)
```

**Format Breakdown:**
| Component | Example | Description |
|-----------|---------|-------------|
| `keyword` | `cpu` | The trigger phrase you'll type |
| `MCP-server-name` | `mcp-monitor` | The MCP server providing the tool |
| `tool-name` | `get_cpu_info` | The specific tool to execute |
| `priority` | `10` | Higher number = preferred when multiple match (1-15+) |

**Visual Example:**
```
./do "add intent mapping: health → mcp-monitor::get_cpu_info priority 15"
                          ^^^^^^   ^^^^^^^^^^^  ^^^^^^^^^^^^  ^^^^^^^^^^
                          keyword  MCP server   tool name     priority
```

### Skill Intents

**Map keywords to Skills:**

```bash
# Format: keyword → vodou-core::vc_load_skill
# tool_parameters: {"skill_name": "skill-name"}
hello → vodou-core::vc_load_skill
  tool_parameters: {"skill_name": "hello"}
```

## Creating Advanced Intents

### MCP Server Tool Intents

**Natural Language Method:**
```bash
./do "add intent mapping: keyword → server::tool priority X"
```

**CLI Method:**
```bash
./do intent add <keyword> <server> <tool> [priority]
```

**Database Method:**
```sql
sqlite3 vodou-core.db "INSERT INTO intent_mappings 
(keyword, server_name, tool_name, priority, execution_type, tool_parameters) VALUES 
('keyword', 'server', 'tool', 10, 'mcp', NULL);"
```

### Skill Intents

**Database Method (Recommended):**
```sql
sqlite3 vodou-core.db "INSERT INTO intent_mappings 
(keyword, server_name, tool_name, priority, execution_type, tool_parameters) VALUES 
('keyword', 'vodou-core', 'vc_load_skill', 10, 'mcp', 
 '{\"skill_name\": \"skill-name\"}');"
```

## Advanced Intent Patterns

### Pattern 1: Parallel Intent Groups

**Multiple intents that work well together:**

```bash
# System monitoring group
cpu → mcp-monitor::get_cpu_info (priority: 10)
memory → mcp-monitor::get_memory_info (priority: 10)
disk → mcp-monitor::get_disk_info (priority: 10)
network → mcp-monitor::get_network_info (priority: 10)

# Use together:
./do "cpu memory disk network"  # All execute in parallel
```

### Pattern 2: Priority-Based Routing

**Higher priority intents preferred:**

```bash
# Common intent (high priority)
cpu → mcp-monitor::get_cpu_info (priority: 10)

# Alternative intent (lower priority)
performance → mcp-monitor::get_cpu_info (priority: 5)
```

### Pattern 3: Orchestrated Intents

**Intents with orchestration directives:**

```sql
sqlite3 vodou-core.db "INSERT INTO intent_mappings 
(keyword, server_name, tool_name, priority, tool_parameters) VALUES 
('system optimization', 'mcp-monitor', 'get_system_info', 15, 
'{\"orchestration\": {
  \"next_intent\": \"memory analysis\", 
  \"execution_type\": \"conditional\", 
  \"user_choice_required\": true
}}');"
```

## Intent Management Best Practices

### ✅ DO

1. **Use Clear Keywords**
   - Specific and descriptive
   - Easy to remember
   - Avoid conflicts

2. **Set Appropriate Priorities**
   - 10: Common intents
   - 5: Less common
   - 1: Default/fallback
   - 15+: Custom workflows

3. **Group Related Intents**
   - Create intent groups
   - Use similar keywords
   - Consider parallel execution

4. **Test Your Intents**
   ```bash
   oi intent test keyword "your test query"
   ```

### ❌ DON'T

1. **Don't Use Vague Keywords**
   - Avoid "thing", "stuff", "doit"
   - Be specific

2. **Don't Create Conflicts**
   - Check existing intents
   - Use unique keywords
   - Set priorities appropriately

3. **Don't Skip Testing**
   - Always test new intents
   - Verify they work
   - Check for conflicts

## Intent Troubleshooting

### Issue: Intent Not Found

**Check:**
- Intent exists? `./do intent list`
- Keyword spelled correctly?
- Priority set?

**Solution:**
- Verify intent mapping
- Check spelling
- Test intent

### Issue: Wrong Tool Executing

**Check:**
- Multiple intents match?
- Priority correct?
- Intent conflict?

**Solution:**
- Check priority
- Review intent mappings
- Resolve conflicts

### Issue: Skill Not Loading

**Check:**
- Skill exists? `./do "available skills"`
- tool_parameters correct?
- JSON format valid?

**Solution:**
- Verify skill name
- Check JSON format
- Test skill loading

## Next Steps

After mastering advanced intents:
1. Create custom intent workflows
2. Build intent libraries
3. Share intent patterns

