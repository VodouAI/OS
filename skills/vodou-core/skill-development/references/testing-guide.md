# Testing Guide

## Overview

Testing ensures your skill works correctly and provides a good user experience.

## Testing Checklist

### 1. Structure Testing

**Check:**
- [ ] Metadata is valid YAML
- [ ] All required fields present
- [ ] File structure correct
- [ ] No syntax errors

**Commands:**
```bash
# Validate YAML frontmatter
head -5 SKILL.md

# Check file structure
ls -la skills/vodou-core/your-skill/
```

### 2. Loading Testing

**Check:**
- [ ] Skill loads without errors
- [ ] Metadata displays correctly
- [ ] Content renders properly

**Commands:**
```bash
# Test skill loading
./do "call vodou-core load_skill your-skill-name"

# Available skills (should include yours)
./do "available skills"
```

### 3. Trigger Testing

**Check:**
- [ ] All trigger phrases work
- [ ] Intent mappings installed
- [ ] Skill activates correctly

**Commands:**
```bash
# Test each trigger phrase
./do "trigger phrase 1"
./do "trigger phrase 2"
./do "trigger phrase 3"
```

### 4. Example Testing

**Check:**
- [ ] All examples execute
- [ ] Commands produce expected results
- [ ] No errors occur

**Commands:**
```bash
# Test each example from your skill
./do "example command 1"
./do "example command 2"
```

### 5. Stopping Point Testing

**Check:**
- [ ] Stopping points appear
- [ ] Options are clear
- [ ] User input is required
- [ ] Workflow continues correctly

**Manual Testing:**
- Load skill
- Follow workflow
- Verify stopping points appear
- Test each option
- Verify correct continuation

### 6. Integration Testing

**Check:**
- [ ] Works with other skills
- [ ] Works with MCP servers
- [ ] No conflicts

**Commands:**
```bash
# Test with other tools
./do "your skill trigger and other command"
```

## Testing Levels

### Quick Test (5 minutes)
- Verify skill loads
- Test one example
- Check basic structure

### Standard Test (15 minutes)
- Test all examples
- Verify stopping points
- Check intent mappings
- Validate metadata

### Comprehensive Test (30+ minutes)
- Test all examples in multiple scenarios
- Verify all stopping points
- Test edge cases
- Validate with real users
- Performance testing

## Testing Scripts

### Basic Validation
```bash
#!/bin/bash
# validate-skill.sh

SKILL_FILE="SKILL.md"

# Check YAML frontmatter
if ! head -3 "$SKILL_FILE" | grep -q "^---$"; then
    echo "❌ Missing YAML frontmatter"
    exit 1
fi

# Check for required sections
if ! grep -q "## Trigger Phrases" "$SKILL_FILE"; then
    echo "❌ Missing Trigger Phrases section"
    exit 1
fi

if ! grep -q "## Overview" "$SKILL_FILE"; then
    echo "❌ Missing Overview section"
    exit 1
fi

echo "✅ Basic structure valid"
```

### Example Testing
```bash
#!/bin/bash
# test-examples.sh

# Extract examples from skill
grep -A 2 '```bash' SKILL.md | grep 'oi "' | while read cmd; do
    echo "Testing: $cmd"
    # Execute and check result
    # (Implementation depends on your setup)
done
```

## Common Issues

### Issue: Skill Won't Load

**Check:**
- YAML frontmatter syntax
- File location correct
- Name matches directory

**Fix:**
```bash
# Verify file location
ls -la skills/vodou-core/your-skill/SKILL.md

# Check YAML syntax
head -5 SKILL.md
```

### Issue: Trigger Phrases Don't Work

**Check:**
- Intent mappings installed
- Keywords match exactly
- Priority set correctly

**Fix:**
```bash
# Check intent mappings
sqlite3 vodou-core.db "SELECT * FROM intent_mappings WHERE keyword LIKE '%your-trigger%';"

# Reinstall if needed
bash install-your-skill.sh
```

### Issue: Examples Fail

**Check:**
- Commands are correct
- Tools are available
- Environment is set up

**Fix:**
- Test commands manually
- Verify tool availability
- Check environment setup

## Next Steps

After testing:
1. Fix any issues found
2. Re-test after fixes
3. Get user feedback
4. Iterate and improve

