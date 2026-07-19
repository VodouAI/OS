#!/bin/bash

# Install intent mappings for skill-development skill

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DB_PATH="$PROJECT_ROOT/vodou-core.db"

echo "🔧 Installing intent mappings for skill-development skill..."

sqlite3 "$DB_PATH" <<EOF
-- Skill development intents
INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority, execution_type, tool_parameters) VALUES
('create oi skill', 'vodou-core', 'vc_load_skill', 10, 'mcp', '{"skill_name": "skill-development"}'),
('develop skill', 'vodou-core', 'vc_load_skill', 10, 'mcp', '{"skill_name": "skill-development"}'),
('skill development', 'vodou-core', 'vc_load_skill', 10, 'mcp', '{"skill_name": "skill-development"}'),
('new skill wizard', 'vodou-core', 'vc_load_skill', 9, 'mcp', '{"skill_name": "skill-development"}'),
('help me create a skill', 'vodou-core', 'vc_load_skill', 9, 'mcp', '{"skill_name": "skill-development"}'),
('create skill', 'vodou-core', 'vc_load_skill', 9, 'mcp', '{"skill_name": "skill-development"}'),
('build skill', 'vodou-core', 'vc_load_skill', 8, 'mcp', '{"skill_name": "skill-development"}');
EOF

if [ $? -eq 0 ]; then
    echo "✅ Intent mappings installed successfully!"
    echo ""
    echo "You can now use:"
    echo "  oi \"create oi skill\""
    echo "  oi \"develop skill\""
    echo "  oi \"skill development\""
else
    echo "❌ Failed to install intent mappings"
    exit 1
fi

