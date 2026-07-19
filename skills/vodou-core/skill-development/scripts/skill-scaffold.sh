#!/bin/bash

# Skill Scaffolding Script
# Generates basic skill structure based on user input

set -e

echo "🔧 Vodou Skill Scaffolding Tool"
echo "============================"
echo ""

# Get skill name
read -p "Skill name (lowercase, hyphens): " SKILL_NAME

if [[ ! "$SKILL_NAME" =~ ^[a-z0-9-]+$ ]]; then
    echo "❌ Invalid skill name. Use lowercase letters, numbers, and hyphens only."
    exit 1
fi

# Get description
read -p "Description (brief, third-person): " DESCRIPTION

# Get category
echo ""
echo "Category:"
echo "1) Core (oi- prefix)"
echo "2) Community"
read -p "Choice (1 or 2): " CATEGORY_CHOICE

if [ "$CATEGORY_CHOICE" = "1" ]; then
    CATEGORY="oi-core"
    FULL_NAME="oi-$SKILL_NAME"
    DIR_PATH="skills/vodou-core/oi-$SKILL_NAME"
else
    CATEGORY="community"
    FULL_NAME="$SKILL_NAME"
    DIR_PATH="skills/community/$SKILL_NAME"
fi

# Get trigger phrases
echo ""
echo "Enter trigger phrases (press Enter after each, empty line to finish):"
TRIGGERS=()
while true; do
    read -p "Trigger phrase: " TRIGGER
    if [ -z "$TRIGGER" ]; then
        break
    fi
    TRIGGERS+=("$TRIGGER")
done

if [ ${#TRIGGERS[@]} -eq 0 ]; then
    echo "❌ At least one trigger phrase required"
    exit 1
fi

# Get complexity
echo ""
echo "Complexity level:"
echo "1) Simple (basic workflow, 2-3 stopping points)"
echo "2) Moderate (multi-step, 5-7 stopping points)"
echo "3) Complex (advanced, 10+ stopping points)"
read -p "Choice (1, 2, or 3): " COMPLEXITY

# Create directory
mkdir -p "$DIR_PATH"
cd "$DIR_PATH"

# Generate SKILL.md
cat > SKILL.md <<EOF
---
name: $FULL_NAME
description: $DESCRIPTION
---

# $(echo $SKILL_NAME | sed 's/-/ /g' | awk '{for(i=1;i<=NF;i++)sub(/./,toupper(substr($i,1,1)),$i)}1')

## Trigger Phrases
EOF

for trigger in "${TRIGGERS[@]}"; do
    echo "- \"$trigger\"" >> SKILL.md
done

cat >> SKILL.md <<EOF

## Overview

$DESCRIPTION

**Key Benefits:**
- [Benefit 1]
- [Benefit 2]
- [Benefit 3]

---

## Core Workflow

### Step 1: [Step Name]

[Explanation]

\`\`\`bash
# [Comment]
oi "[example command]"
\`\`\`

### 🛑 **STOPPING POINT: [Decision Name]**

[Question or decision]

**Options:**
- **A)** [Option A]
- **B)** [Option B]

**Your choice? (A or B)**

EOF

if [ "$COMPLEXITY" != "1" ]; then
    cat >> SKILL.md <<EOF

### Step 2: [Step Name]

[Explanation]

\`\`\`bash
# [Comment]
oi "[example command]"
\`\`\`

### 🛑 **STOPPING POINT: [Decision Name]**

[Question or decision]

**Options:**
- **1)** [Option 1]
- **2)** [Option 2]

**Your choice? (1 or 2)**
EOF
fi

if [ "$COMPLEXITY" = "3" ]; then
    cat >> SKILL.md <<EOF

### Step 3: [Step Name]

[Explanation]

\`\`\`bash
# [Comment]
oi "[example command]"
\`\`\`
EOF
fi

cat >> SKILL.md <<EOF

---

## Examples

### Example 1: [Scenario]

\`\`\`bash
# [Comment]
oi "[example command]"
\`\`\`

---

## Quick Reference

\`\`\`bash
# [Most common command]
oi "[command]"
\`\`\`
EOF

# Generate install script
INSTALL_SCRIPT="install-$FULL_NAME.sh"
cat > "$INSTALL_SCRIPT" <<EOF
#!/bin/bash

# Install intent mappings for $FULL_NAME skill

SCRIPT_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="\$(cd "\$SCRIPT_DIR/../../.." && pwd)"
DB_PATH="\$PROJECT_ROOT/vodou-core.db"

SKILL_NAME="$FULL_NAME"

echo "🔧 Installing intent mappings for \$SKILL_NAME skill..."

sqlite3 "\$DB_PATH" <<SQL
EOF

PRIORITY=10
for trigger in "${TRIGGERS[@]}"; do
    echo "INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority, execution_type, tool_parameters) VALUES" >> "$INSTALL_SCRIPT"
    echo "('$trigger', 'vodou-core', 'vc_load_skill', $PRIORITY, 'mcp', '{\"skill_name\": \"\$SKILL_NAME\"}');" >> "$INSTALL_SCRIPT"
    PRIORITY=$((PRIORITY - 1))
done

cat >> "$INSTALL_SCRIPT" <<EOF
SQL

if [ \$? -eq 0 ]; then
    echo "✅ Intent mappings installed successfully!"
    echo ""
    echo "You can now use:"
EOF

for trigger in "${TRIGGERS[@]}"; do
    echo "    echo \"  oi \\\"$trigger\\\"\"" >> "$INSTALL_SCRIPT"
done

cat >> "$INSTALL_SCRIPT" <<EOF
else
    echo "❌ Failed to install intent mappings"
    exit 1
fi
EOF

chmod +x "$INSTALL_SCRIPT"

echo ""
echo "✅ Skill scaffolded successfully!"
echo ""
echo "Location: $DIR_PATH"
echo "Files created:"
echo "  - SKILL.md"
echo "  - $INSTALL_SCRIPT"
echo ""
echo "Next steps:"
echo "  1. Edit SKILL.md with your content"
echo "  2. Add stopping points"
echo "  3. Test examples"
echo "  4. Run: ./$INSTALL_SCRIPT"
echo ""

