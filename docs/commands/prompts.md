# prompts - Server Prompts Discovery

Show all available prompt templates for a specific MCP server. Prompts are reusable templates for LLM interactions with defined arguments that can be used to generate consistent AI responses.

## Syntax

```bash
vodou-core prompts <NAME>
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `<NAME>` | Yes | Server name (from `list` command) |

## Examples

```bash
# Show prompts for code analysis server
vodou-core prompts code-analyzer

# Show prompts for documentation server  
vodou-core prompts docs-server

# Show prompts for any server (most will return empty)
vodou-core prompts my-server
```

## Output Examples

### Code Analysis Prompts
```
📝 Prompts for code-analyzer:
  - code_review: Review code for issues and improvements
    Arguments:
      - code (required)
      - language
      - style_guide
      - severity_level

  - generate_docs: Generate documentation from code
    Arguments:
      - source_path (required)
      - format
      - include_private
      - output_style

  - explain_code: Explain what code does in natural language
    Arguments:
      - code_snippet (required)
      - audience
      - detail_level
```

### Documentation Generation Prompts
```
📝 Prompts for docs-server:
  - api_documentation: Generate API documentation
    Arguments:
      - endpoint_data (required)
      - format
      - include_examples
      - auth_info

  - user_guide: Create user guide from specifications
    Arguments:
      - spec_content (required)
      - target_audience
      - complexity_level

  - changelog_entry: Generate changelog entries
    Arguments:
      - changes (required)
      - version
      - release_type
```

### Content Generation Prompts
```
📝 Prompts for content-server:
  - summarize_text: Create concise summaries
    Arguments:
      - text (required)
      - max_length
      - style
      - key_points

  - translate_content: Translate text between languages
    Arguments:
      - text (required)
      - source_language
      - target_language (required)
      - preserve_formatting

  - rewrite_content: Rewrite content for different audiences
    Arguments:
      - original_text (required)
      - target_audience (required)
      - tone
      - length_adjustment
```

### No Prompts Available (Common)
```
No prompts found for server: mcp-monitor
Try connecting first: vodou-core connect mcp-monitor <command> <args...>
```

**Note**: This is normal - most current MCP servers don't provide prompts yet.

## Understanding Prompts

### What Are MCP Prompts?
MCP prompts are **reusable templates** for LLM interactions that:
- **Standardize requests** to AI models
- **Provide consistent results** across uses
- **Include parameter definitions** for customization
- **Enable complex AI workflows** with structured inputs

### Prompt vs Tool Difference
| Aspect | **Tools** | **Prompts** |
|--------|-----------|-------------|
| Purpose | Execute functions | Generate AI responses |
| Output | Structured data | Natural language / formatted text |
| Usage | Direct computation | AI model interaction |
| Parameters | Function arguments | Template variables |
| Processing | Server-side logic | LLM processing |

### Prompt Structure
Each prompt includes:
- **Name** - Identifier for the prompt template
- **Description** - What the prompt is used for
- **Arguments** - Parameters that customize the prompt
- **Template** (internal) - The actual prompt structure

## Prompt Arguments

### Argument Types

**Required Arguments** - Must be provided:
```
- code (required): The code to analyze
- target_language (required): Language to translate to
```

**Optional Arguments** - Have defaults or are optional:
```
- format: Output format (default: "markdown")  
- detail_level: How detailed to be (default: "medium")
- include_examples: Whether to include examples (default: true)
```

### Argument Categories

**Content Arguments** - The main content to process:
- `text`, `code`, `content`, `data`
- Usually required as the primary input

**Configuration Arguments** - How to process the content:
- `format`, `style`, `language`, `template`
- Often optional with sensible defaults

**Output Arguments** - How to format results:
- `max_length`, `detail_level`, `include_examples`
- Usually optional to customize output

**Context Arguments** - Additional context for processing:
- `audience`, `domain`, `use_case`, `constraints`
- Optional arguments that improve results

## Current Prompt Ecosystem

### Limited Availability
**Current Reality**: Most MCP servers don't provide prompts yet because:
- **MCP protocol is new** - servers focus on tools first
- **Prompt standardization** still evolving
- **Implementation complexity** higher than tools
- **Use cases** still being explored

### Servers That May Have Prompts
Look for prompts in:
- **AI/ML servers** - Code analysis, content generation
- **Documentation servers** - Template-based doc generation  
- **Content processing servers** - Text transformation, summarization
- **Specialized AI servers** - Domain-specific AI workflows

### Future Growth
Expect more prompts as:
- **MCP adoption grows** - more servers implement prompts
- **AI workflows mature** - standard patterns emerge
- **Template libraries develop** - reusable prompt collections
- **Integration improves** - better AI model integration

## Prompt Discovery Process

Prompts are discovered during the `connect` operation:

1. **Connection established** with MCP server
2. **Protocol initialized** following MCP specification
3. **Prompts listed** via `prompts/list` MCP method (if supported)
4. **Arguments extracted** from prompt definitions
5. **Database stored** for persistent access
6. **Graceful fallback** if server doesn't support prompts

## Using Discovered Prompts (Conceptual)

**Note**: Brain Trust 4 currently **discovers and lists** prompts but doesn't execute them directly. Prompt execution would typically involve:

### 1. AI Agent Integration
```bash
# Conceptual: AI agent uses prompt via MCP server
ai-agent use-prompt server-name prompt-name \
  --code "./src/main.rs" \
  --language "rust" \
  --style_guide "company-standard"
```

### 2. MCP Server Tools
Some servers may provide tools that execute prompts:
```bash
# Check if server has prompt execution tools
vodou-core tools code-analyzer | grep -i prompt

# Execute prompt via tool (if available)
vodou-core call code-analyzer execute_prompt '{
  "prompt_name": "code_review",
  "arguments": {
    "code": "fn main() { println!(\"Hello\"); }",
    "language": "rust"
  }
}'
```

### 3. Template Extraction
Future versions might support prompt template access:
```bash
# Conceptual: Get prompt template for manual use
vodou-core get-prompt-template code-analyzer code_review > review_template.txt
```

## Error Scenarios

### Server Not Found
```
No prompts found for server: unknown-server
Try connecting first: vodou-core connect unknown-server <command> <args...>
```

**Solution**: Check server name with `vodou-core list` or connect the server.

### Server Connected but No Prompts
```
No prompts found for server: tool-only-server
Try connecting first: vodou-core connect tool-only-server <command> <args...>
```

**Note**: This is **very common** - most servers don't provide prompts yet.

### Prompt Discovery Failed
If prompts were expected but not found:
```bash
# Reconnect to refresh capabilities
vodou-core connect prompt-server node ./server.js

# Check if server supports prompts
vodou-core capabilities prompt-server | grep "📝 Prompts"
```

## Integration Examples

### Prompt Inventory
```bash
#!/bin/bash
# Find all servers that provide prompts

echo "=== MCP Prompt Inventory ==="
echo "=========================="

TOTAL_PROMPTS=0
SERVERS_WITH_PROMPTS=0

vodou-core list | grep "^  -" | cut -d: -f1 | sed 's/^  - //' | while read server; do
    PROMPT_COUNT=$(vodou-core prompts "$server" 2>/dev/null | grep -c "^  -" || echo "0")
    
    if [ "$PROMPT_COUNT" -gt 0 ]; then
        echo ""
        echo "📝 $server: $PROMPT_COUNT prompts"
        vodou-core prompts "$server" | grep "^  -" | sed 's/^  -/  •/'
        SERVERS_WITH_PROMPTS=$((SERVERS_WITH_PROMPTS + 1))
        TOTAL_PROMPTS=$((TOTAL_PROMPTS + PROMPT_COUNT))
    fi
done

echo ""
echo "Summary: $SERVERS_WITH_PROMPTS servers with $TOTAL_PROMPTS total prompts"
```

### Prompt Argument Analysis
```bash
#!/bin/bash
# Analyze prompt arguments across all servers

SERVER="$1"
if [ -z "$SERVER" ]; then
    echo "Usage: $0 <server-name>"
    exit 1
fi

echo "=== Prompt Arguments for $SERVER ==="

vodou-core prompts "$SERVER" | grep -A 20 "^  -" | while read line; do
    if [[ "$line" =~ ^[[:space:]]*-[[:space:]].*: ]]; then
        # This is a prompt name line
        prompt_name=$(echo "$line" | sed 's/^[[:space:]]*-[[:space:]]*//' | cut -d: -f1)
        echo ""
        echo "Prompt: $prompt_name"
    elif [[ "$line" =~ ^[[:space:]]*-[[:space:]].*\(required\) ]]; then
        # Required argument
        arg_name=$(echo "$line" | sed 's/^[[:space:]]*-[[:space:]]*//' | cut -d' ' -f1)
        echo "  ✅ $arg_name (required)"
    elif [[ "$line" =~ ^[[:space:]]*-[[:space:]].* ]]; then
        # Optional argument
        arg_name=$(echo "$line" | sed 's/^[[:space:]]*-[[:space:]]*//')
        echo "  ⚪ $arg_name (optional)"
    fi
done
```

### Prompt Template Discovery
```bash
#!/bin/bash
# Create structured overview of all available prompts

echo "# MCP Prompt Templates"
echo "====================="
echo ""

vodou-core list | grep "^  -" | cut -d: -f1 | sed 's/^  - //' | while read server; do
    PROMPT_COUNT=$(vodou-core prompts "$server" 2>/dev/null | grep -c "^  -" || echo "0")
    
    if [ "$PROMPT_COUNT" -gt 0 ]; then
        echo "## Server: $server"
        echo ""
        vodou-core prompts "$server" | grep "^  -" | while read line; do
            prompt_line=$(echo "$line" | sed 's/^  - //')
            prompt_name=$(echo "$prompt_line" | cut -d: -f1)
            prompt_desc=$(echo "$prompt_line" | cut -d: -f2-)
            echo "### $prompt_name"
            echo "$prompt_desc"
            echo ""
        done
        echo ""
    fi
done
```

## Server Development Guidance

### For MCP Server Developers
If you're developing an MCP server, consider adding prompts for:

**Code Analysis Servers:**
- Code review prompts
- Documentation generation prompts  
- Code explanation prompts
- Refactoring suggestion prompts

**Content Processing Servers:**
- Summarization prompts
- Translation prompts
- Style conversion prompts
- Format transformation prompts

**Domain-Specific Servers:**
- Technical writing prompts
- Report generation prompts
- Analysis framework prompts
- Decision support prompts

### Prompt Design Best Practices
- **Clear descriptions** - Explain what the prompt does
- **Required vs optional** - Mark required arguments clearly
- **Default values** - Provide sensible defaults for optional arguments
- **Examples** - Include usage examples in descriptions
- **Consistency** - Use consistent argument naming across prompts

## Performance Considerations

### Prompt Discovery Performance
- **Discovery during connection** - all prompts discovered at once
- **Database storage** - prompts cached locally after discovery
- **No network calls** - `prompts` command uses cached data only
- **Fast queries** - sub-millisecond for typical prompt counts

### Large Prompt Collections
For servers with many prompts:
- **Categorization by name** using `grep`
- **Filtering by purpose** using keyword search
- **Argument analysis** for understanding complexity

```bash
# Filter by category
vodou-core prompts ai-server | grep "code_"
vodou-core prompts ai-server | grep "generate_"
vodou-core prompts ai-server | grep "analyze_"

# Search by purpose
vodou-core prompts ai-server | grep -i "documentation"
vodou-core prompts ai-server | grep -i "review"
```

## Related Commands

- [`capabilities`](capabilities.md) - High-level server capability overview including prompts
- [`connect`](connect.md) - Discover and store prompts during connection
- [`list`](list.md) - Find server names to use with prompts command
- [`tools`](tools.md) - View server tools (some may execute prompts)

## See Also

- [Examples](../examples.md#prompt-discovery) - Prompt discovery examples (when available)
- [CLI Reference](../cli-reference.md#prompts) - Complete command reference
- [Architecture](../../docs-DEV/architecture.md#prompt-discovery) (internal) — how prompt discovery works internally