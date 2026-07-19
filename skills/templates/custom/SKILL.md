---
name: custom-skill-template
description: Blank template — customize with your own tools and workflow
version: 1.0.0
required_tools: []
kind: workflow
trigger_phrases:
  - "my custom skill"
stopping_points: required
actions: actions.json
imported_from:
  source: hand-written
---

# Custom Skill Template

## Overview

A blank template for building your own skill. Replace the placeholders below with your tools and workflow.

## Stopping Point 1: Choose Action

1. **Option A** — describe what this does
2. **Option B** — describe what this does
3. **Option C** — describe what this does

<!-- AGENT_ACTIONS: {"stopping_points":[{"id":1,"title":"Choose Action","options":{"1":{"label":"Option A","vars":{},"steps":[
  {"server":"YOUR_SERVER","tool":"your_tool","args":{"param":"{{TOPIC}}"}}
]},"2":{"label":"Option B","vars":{},"steps":[
  {"server":"YOUR_SERVER","tool":"your_tool","args":{"param":"{{TOPIC}}"}}
]}}}]} -->
