---
name: soul
description: Show and update SOUL.md - persona, boundaries, preferences
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - "show my soul"
  - "soul"
  - "update SOUL"
  - "SOUL.md"
  - "prefer Rust"
  - "update preference"
  - "my boundaries"
  - "persona"
stopping_points: required
actions: none
imported_from:
  source: hand-written
---

# Vodou Soul - Who You Are

## Overview

SOUL.md defines who the AI is: core truths, boundaries, vibe, continuity. It's injected every turn as part of workspace bootstrap.

## Quick Commands

**View SOUL (and full context):**
```bash
./do context --base-only
```
SOUL.md is included in the workspace bootstrap output.

**Edit SOUL directly:**
```bash
# SOUL lives in workspace root
# ~/.vodou/workspace/SOUL.md or ./.vodou/workspace/SOUL.md
```

## Updating Preferences

To add a preference like "prefer Rust":
1. Open SOUL.md in your workspace
2. Add under Boundaries or a new Preferences section: `- Prefer Rust for new projects`
3. Or append to MEMORY.md: `- [Preference] User prefers Rust`

**Stopping Point**

**What would you like to do?**
1. **Show SOUL content** — Run `./do context --base-only`, extract SOUL section
2. **Add a preference** — Guide user to edit SOUL.md or MEMORY.md
3. **Bootstrap workspace** — Run `./do bootstrap` if SOUL.md doesn't exist yet
