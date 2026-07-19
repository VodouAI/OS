#!/bin/bash
# install-deep-thinking.sh
# Installation script for deep-thinking skill

SKILL_NAME="deep-thinking"
# Resolve DB path relative to script location (works on any machine)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRAIN_TRUST_DB="${VODOU_PROJECT_PATH:-$(cd "$SCRIPT_DIR" && while [ ! -f vodou-core.db ] && [ "$(pwd)" != "/" ]; do cd ..; done && pwd)}/vodou-core.db"

echo "Installing $SKILL_NAME skill intent mappings..."

# Add intent mappings with tool_parameters for direct skill loading
sqlite3 "$BRAIN_TRUST_DB" "INSERT OR IGNORE INTO intent_mappings (keyword, server_name, tool_name, execution_type, priority, tool_parameters) VALUES 
('deep think', 'vodou-core', 'vc_load_skill', 'mcp', 10, '{\"skill_name\": \"$SKILL_NAME\"}'),
('think deep', 'vodou-core', 'vc_load_skill', 'mcp', 10, '{\"skill_name\": \"$SKILL_NAME\"}'),
('deep research', 'vodou-core', 'vc_load_skill', 'mcp', 10, '{\"skill_name\": \"$SKILL_NAME\"}'),
('analyze deeply', 'vodou-core', 'vc_load_skill', 'mcp', 9, '{\"skill_name\": \"$SKILL_NAME\"}'),
('comprehensive analysis', 'vodou-core', 'vc_load_skill', 'mcp', 9, '{\"skill_name\": \"$SKILL_NAME\"}'),
('deep think about', 'vodou-core', 'vc_load_skill', 'mcp', 10, '{\"skill_name\": \"$SKILL_NAME\"}'),
('think deep about', 'vodou-core', 'vc_load_skill', 'mcp', 10, '{\"skill_name\": \"$SKILL_NAME\"}'),
('deep research on', 'vodou-core', 'vc_load_skill', 'mcp', 10, '{\"skill_name\": \"$SKILL_NAME\"}');"

# Verify installation
MAPPINGS=$(sqlite3 "$BRAIN_TRUST_DB" "SELECT COUNT(*) FROM intent_mappings WHERE tool_parameters LIKE '%$SKILL_NAME%';")

if [ "$MAPPINGS" -gt 0 ]; then
    echo "✅ Successfully installed $MAPPINGS intent mappings for $SKILL_NAME"
    echo ""
    echo "Available triggers:"
    sqlite3 "$BRAIN_TRUST_DB" "SELECT keyword FROM intent_mappings WHERE tool_parameters LIKE '%$SKILL_NAME%' ORDER BY priority DESC;"
else
    echo "❌ Failed to install intent mappings"
    exit 1
fi

