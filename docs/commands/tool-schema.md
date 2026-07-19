# tool-schema

Show input schema for a specific tool.

## Syntax

```bash
vodou-core tool-schema <tool-name>
```

## Description

The `tool-schema` command displays the complete input schema for any MCP tool, including:

- **Tool location**: Which server provides the tool
- **Description**: What the tool does
- **Input schema**: Complete JSON schema with properties, types, descriptions, defaults, and required fields

This command is essential for understanding how to call MCP tools correctly, as it shows exactly what parameters are required and optional.

## Arguments

| Argument | Description | Required |
|----------|-------------|----------|
| `tool-name` | Name of the tool to show schema for | Yes |

## Examples

### Show schema for a simple tool

```bash
vodou-core tool-schema take_snapshot
```

**Output:**
```
🔍 Looking up schema for tool: take_snapshot
✅ Found tool 'take_snapshot' on server: chrome-devtools

📝 Description: Perform comprehensive analysis of a codebase including semantic concepts, patterns, and complexity metrics

📋 Input Schema:
```json
{
  "properties": {
    "path": {
      "description": "Path to the codebase directory to analyze",
      "type": "string"
    }
  },
  "required": [
    "path"
  ],
  "type": "object"
}
```
```

### Show schema for a complex tool

```bash
vodou-core tool-schema get_process_info
```

**Output:**
```
🔍 Looking up schema for tool: get_process_info
✅ Found tool 'get_process_info' on server: mcp-monitor

📝 Description: Get process information

📋 Input Schema:
```json
{
  "properties": {
    "limit": {
      "default": 10,
      "description": "Limit the number of processes returned",
      "type": "number"
    },
    "pid": {
      "description": "Process ID. If not specified, returns summary information for all processes",
      "type": "number"
    },
    "sort_by": {
      "default": "cpu",
      "description": "Sort field (cpu, memory, pid, name)",
      "type": "string"
    }
  },
  "type": "object"
}
```
```

### Tool not found

```bash
vodou-core tool-schema nonexistent_tool
```

**Output:**
```
🔍 Looking up schema for tool: nonexistent_tool
❌ Tool 'nonexistent_tool' not found in database
💡 Try 'vodou-core find-tool nonexistent_tool' to see which servers provide this tool
```

## Schema Information

The JSON schema includes:

- **`properties`**: Object containing all available parameters
- **`type`**: Data type for each parameter (string, number, boolean, array, object)
- **`description`**: Human-readable description of what the parameter does
- **`default`**: Default value if the parameter is optional
- **`required`**: Array of parameter names that must be provided
- **`items`**: For array types, defines the type of array elements
- **`enum`**: For parameters with limited valid values

## Related Commands

- [`find-tool`](find-tool.md) - Find which servers provide a specific tool
- [`all-tools`](all-tools.md) - List all tools across all servers
- [`call-tool`](call-tool.md) - Call a tool by name with automatic routing
- [`tools`](tools.md) - Show tools for a specific server

## Use Cases

1. **Parameter Discovery**: Learn what parameters a tool accepts
2. **Type Information**: Understand data types and validation rules
3. **Default Values**: See what optional parameters default to
4. **Required Fields**: Know which parameters are mandatory
5. **Tool Integration**: Understand how to call tools programmatically

## Technical Details

- **Database Query**: Queries the `tools` table for schema information
- **JSON Schema**: Uses standard JSON Schema format (draft-07)
- **Server Resolution**: Shows which server provides the tool
- **Error Handling**: Provides helpful suggestions when tools aren't found

## Performance

- **Fast Lookup**: Direct database query with indexed tool names
- **Cached Data**: Uses existing tool metadata from server discovery
- **Minimal Overhead**: No server connections required for schema lookup


