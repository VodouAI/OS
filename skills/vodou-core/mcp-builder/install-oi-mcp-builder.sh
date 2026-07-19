#!/bin/bash
# Vodou MCP Builder - Installation Script
# Installs intent mappings for dynamic MCP server building

SKILL_NAME="mcp-builder"
# Resolve DB path relative to script location (works on any machine)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRAIN_TRUST_DB="${VODOU_PROJECT_PATH:-$(cd "$SCRIPT_DIR" && while [ ! -f vodou-core.db ] && [ "$(pwd)" != "/" ]; do cd ..; done && pwd)}/vodou-core.db"

echo "🛠️ Installing Vodou MCP Builder skill intent mappings..."

# Install intent mappings for the skill
sqlite3 "$BRAIN_TRUST_DB" "INSERT OR IGNORE INTO intent_mappings (keyword, server_name, tool_name, execution_type, priority, tool_parameters) VALUES 
('build mcp server', 'vodou-core', 'vc_load_skill', 'mcp', 10, '{\"skill_name\": \"$SKILL_NAME\"}'),
('create mcp for task', 'vodou-core', 'vc_load_skill', 'mcp', 10, '{\"skill_name\": \"$SKILL_NAME\"}'),
('need custom mcp', 'vodou-core', 'vc_load_skill', 'mcp', 9, '{\"skill_name\": \"$SKILL_NAME\"}'),
('generate mcp server', 'vodou-core', 'vc_load_skill', 'mcp', 10, '{\"skill_name\": \"$SKILL_NAME\"}'),
('build tool for', 'vodou-core', 'vc_load_skill', 'mcp', 9, '{\"skill_name\": \"$SKILL_NAME\"}'),
('custom mcp server', 'vodou-core', 'vc_load_skill', 'mcp', 9, '{\"skill_name\": \"$SKILL_NAME\"}'),
('make mcp server', 'vodou-core', 'vc_load_skill', 'mcp', 8, '{\"skill_name\": \"$SKILL_NAME\"}'),
('build mcp for', 'vodou-core', 'vc_load_skill', 'mcp', 9, '{\"skill_name\": \"$SKILL_NAME\"}'),
('create custom tool', 'vodou-core', 'vc_load_skill', 'mcp', 8, '{\"skill_name\": \"$SKILL_NAME\"}'),
('mcp builder', 'vodou-core', 'vc_load_skill', 'mcp', 8, '{\"skill_name\": \"$SKILL_NAME\"}');"

# Verify installation
MAPPINGS=$(sqlite3 "$BRAIN_TRUST_DB" "SELECT COUNT(*) FROM intent_mappings WHERE tool_parameters LIKE '%$SKILL_NAME%';")
echo "✅ Installed $MAPPINGS intent mappings for $SKILL_NAME"

echo ""
echo "🎯 Vodou MCP Builder is now available! Try:"
echo "   oi \"build mcp server\""
echo "   oi \"create mcp for cryptocurrency tracking\""
echo "   oi \"build tool for database reporting\""
echo ""
echo "🚀 This skill enables Vodou to create custom MCP servers for any task!"
echo "   - Analyzes requirements and generates complete servers"
echo "   - Full Vodou integration with natural language triggers"  
echo "   - Templates for Python, Node.js, and other languages"
echo "   - Automatic installation and testing"
echo ""