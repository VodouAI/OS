# Installation Guide

## Overview

After creating your skill, you need to install it so Vodou can find and use it.

## Installation Steps

### Step 1: File Placement

**Core Skills:**
```
skills/vodou-core/your-skill/
  ├── SKILL.md
  ├── install-your-skill.sh
  └── [optional directories]
```

**Community Skills:**
```
skills/community/your-skill/
  ├── SKILL.md
  ├── install-your-skill.sh
  └── [optional directories]
```

### Step 2: Create Install Script

**Template:**
```bash
#!/bin/bash

# Install intent mappings for your-skill

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DB_PATH="$PROJECT_ROOT/vodou-core.db"

SKILL_NAME="your-skill-name"

echo "🔧 Installing intent mappings for $SKILL_NAME skill..."

sqlite3 "$DB_PATH" <<EOF
INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority, execution_type, tool_parameters) VALUES
('trigger phrase 1', 'vodou-core', 'vc_load_skill', 10, 'mcp', '{"skill_name": "$SKILL_NAME"}'),
('trigger phrase 2', 'vodou-core', 'vc_load_skill', 10, 'mcp', '{"skill_name": "$SKILL_NAME"}'),
('trigger phrase 3', 'vodou-core', 'vc_load_skill', 9, 'mcp', '{"skill_name": "$SKILL_NAME"}');
EOF

if [ $? -eq 0 ]; then
    echo "✅ Intent mappings installed successfully!"
    echo ""
    echo "You can now use:"
    echo "  oi \"trigger phrase 1\""
    echo "  oi \"trigger phrase 2\""
else
    echo "❌ Failed to install intent mappings"
    exit 1
fi
```

### Step 3: Make Script Executable

```bash
chmod +x install-your-skill.sh
```

### Step 4: Run Install Script

```bash
./install-your-skill.sh
```

### Step 5: Verify Installation

```bash
# Check intent mappings
sqlite3 vodou-core.db "SELECT keyword, priority FROM intent_mappings WHERE tool_parameters LIKE '%your-skill-name%';"

# Test skill loading
./do "call vodou-core load_skill your-skill-name"

# Test trigger phrases
./do "trigger phrase 1"
```

## Installation Methods

### Method 1: Manual Installation

**Steps:**
1. Place skill file in correct directory
2. Create install script
3. Run install script manually
4. Verify installation

**Best for:** Learning, understanding process

### Method 2: Automated Script

**Steps:**
1. Use provided install script
2. Review script contents
3. Run script
4. Verify installation

**Best for:** Standard installation, repeatability

### Method 3: Guided Installation

**Steps:**
1. Follow step-by-step guide
2. Execute commands with guidance
3. Learn as you go
4. Verify each step

**Best for:** First-time installation, learning

## Verification Checklist

After installation:
- [ ] Skill file in correct location
- [ ] Install script created
- [ ] Script is executable
- [ ] Intent mappings installed
- [ ] Skill loads correctly
- [ ] Trigger phrases work
- [ ] Examples execute

## Troubleshooting

### Issue: Script Won't Run

**Check:**
- Script is executable: `chmod +x install-script.sh`
- Script path is correct
- Database path is correct

### Issue: Intent Mappings Not Installed

**Check:**
- Database path correct
- SQL syntax correct
- Database permissions

**Verify:**
```bash
sqlite3 vodou-core.db "SELECT * FROM intent_mappings WHERE keyword LIKE '%your-trigger%';"
```

### Issue: Skill Won't Load

**Check:**
- File location correct
- YAML frontmatter valid
- Name matches directory

**Verify:**
```bash
./do "call vodou-core load_skill your-skill-name"
```

## Next Steps

After installation:
1. Test all trigger phrases
2. Test all examples
3. Verify stopping points
4. Get user feedback
5. Iterate and improve

