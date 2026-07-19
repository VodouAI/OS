#!/bin/bash

# Skill Validation Script
# Validates skill structure and format

set -e

SKILL_FILE="${1:-SKILL.md}"

if [ ! -f "$SKILL_FILE" ]; then
    echo "❌ Skill file not found: $SKILL_FILE"
    exit 1
fi

echo "🔍 Validating skill: $SKILL_FILE"
echo ""

ERRORS=0
WARNINGS=0

# Check YAML frontmatter
if ! head -3 "$SKILL_FILE" | grep -q "^---$"; then
    echo "❌ Missing YAML frontmatter"
    ERRORS=$((ERRORS + 1))
fi

# Check for name field
if ! grep -q "^name:" "$SKILL_FILE"; then
    echo "❌ Missing 'name' field in frontmatter"
    ERRORS=$((ERRORS + 1))
fi

# Check for description field
if ! grep -q "^description:" "$SKILL_FILE"; then
    echo "❌ Missing 'description' field in frontmatter"
    ERRORS=$((ERRORS + 1))
fi

# Check for Trigger Phrases section
if ! grep -q "^## Trigger Phrases" "$SKILL_FILE"; then
    echo "❌ Missing 'Trigger Phrases' section"
    ERRORS=$((ERRORS + 1))
fi

# Check for Overview section
if ! grep -q "^## Overview" "$SKILL_FILE"; then
    echo "❌ Missing 'Overview' section"
    ERRORS=$((ERRORS + 1))
fi

# Check for at least one stopping point
STOPPING_POINTS=$(grep -c "🛑 \*\*STOPPING POINT" "$SKILL_FILE" || echo "0")
if [ "$STOPPING_POINTS" -eq 0 ]; then
    echo "⚠️  No stopping points found (user control recommended)"
    WARNINGS=$((WARNINGS + 1))
fi

# Check for examples
if ! grep -q "^## Examples" "$SKILL_FILE"; then
    echo "⚠️  No 'Examples' section found (examples recommended)"
    WARNINGS=$((WARNINGS + 1))
fi

# Check for code blocks with oi commands
VODOU_COMMANDS=$(grep -c 'oi "' "$SKILL_FILE" || echo "0")
if [ "$VODOU_COMMANDS" -eq 0 ]; then
    echo "⚠️  No Vodou command examples found"
    WARNINGS=$((WARNINGS + 1))
fi

# Summary
echo ""
if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
    echo "✅ Skill validation passed!"
    exit 0
elif [ $ERRORS -eq 0 ]; then
    echo "✅ Skill structure valid (with $WARNINGS warnings)"
    exit 0
else
    echo "❌ Validation failed: $ERRORS errors, $WARNINGS warnings"
    exit 1
fi

