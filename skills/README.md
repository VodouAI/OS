# Vodou Skills

Welcome to Vodou Skills - a revolutionary way to extend AI agent capabilities through simple markdown files. Skills transform AI agents from general-purpose tools into specialized experts for your specific workflows.

## What are Vodou Skills?

Skills are markdown files with YAML frontmatter that teach AI agents how to perform complex tasks using Vodou's orchestrated intelligence. They combine:
- Natural language instructions
- Best practice workflows
- Tool orchestration patterns
- Domain-specific expertise

## Quick Start

### Using Skills

```bash
# List available skills
./vodou-core call vodou-core list_skills '{}'

# Search for skills
./vodou-core call vodou-core search_skills '{"keyword": "docker"}'

# Load a specific skill
./vodou-core call vodou-core load_skill '{"skill_name": "mastery"}'
```

### Coming Soon: Natural Language Activation

Once vodou-core is updated to handle skill execution types:
```bash
./do "learn oi"                    # Loads mastery skill
./do "docker dev"                  # Loads docker-compose-dev skill
./do "parallel code analysis"      # Loads parallel-code-analysis skill
```

## Available Skills

### Core Skills (`/skills/core/`)
- **mastery** - Master Vodou's parallel execution and best practices
- **parallel-code-analysis** - Comprehensive code analysis using parallel execution
- **skill-development** - Complete guide for creating, testing, and organizing Vodou skills

### Community Skills (`/skills/community/`)
- **docker-compose-dev** - Docker Compose development workflows

## Creating Your Own Skills

### Basic Structure

```markdown
---
name: your-skill-name
description: Brief third-person description of what this skill does
version: 1.0.0
required_tools:
  - mcp-monitor
  - Vodou-script-executor
---

# Your Skill Name

## Trigger Phrases
- "your skill"
- "alternative trigger"

## Overview
What this skill enables and why it's useful.

## Instructions
Step-by-step guidance for the AI agent.

## Examples
Concrete usage examples with Vodou commands.
```

### Best Practices

1. **Keep it Focused** - One skill, one purpose
2. **Use Clear Triggers** - Natural phrases users would say
3. **Leverage Parallel Execution** - Show Vodou's power
4. **Include Examples** - Real commands that work
5. **List Required Tools** - Ensure dependencies are clear

### Skill Guidelines

- **Name**: Lowercase with hyphens (e.g., `docker-compose-dev`)
- **Description**: Third-person, under 200 characters
- **Version**: Semantic versioning (1.0.0)
- **Content**: 1,500-2,000 words for main instructions
- **Examples**: Include actual `oi` commands

## Contributing Skills

1. Create your skill in `/skills/community/`
2. Test that it loads correctly
3. Create an installation script (see `install-skill-development.sh` as example)
4. Submit a PR with:
   - The skill markdown file
   - Installation script for intent mappings
   - Updated README entry
   - Example usage

### Installation Scripts

Each skill should include an installation script to add intent mappings:

```bash
# Example usage
./skills/install-skill-development.sh

# This automatically adds all intent mappings for the skill
```

See `/skills/install-skill-development.sh` as a complete example.

## How Skills Work

1. **Discovery**: Skills are discovered by natural language triggers
2. **Loading**: Skill content is loaded into AI context on demand
3. **Execution**: AI follows skill instructions using Vodou tools
4. **Logging**: Work is logged for future reference

## Advanced Features

### Progressive Disclosure
Skills load only when needed, keeping AI context efficient.

### Tool Requirements
Skills declare which MCP tools they need, ensuring compatibility.

### Version Control
Skills are versioned, allowing for updates without breaking existing workflows.

## Examples

### Using the Vodou Mastery Skill
```bash
# Load the skill
./vodou-core call vodou-core load_skill '{"skill_name": "mastery"}'

# The AI now knows how to:
# - Use parallel execution effectively
# - Log work with rich metadata
# - Chain operations efficiently
# - Discover and use tools optimally
```

### Using the Docker Dev Skill
```bash
# Load the skill
./vodou-core call vodou-core load_skill '{"skill_name": "docker-compose-dev"}'

# The AI now knows how to:
# - Set up Docker development environments
# - Debug container issues
# - Optimize Docker builds
# - Handle common Docker problems
```

## Future Vision

Skills will enable:
- Instant expertise sharing across teams
- Standardized workflows for organizations
- Community-driven AI enhancement
- Universal skill portability across AI models

## Get Involved

- Create skills for your workflows
- Share skills with the community
- Improve existing skills
- Report issues and suggestions

Together, we're building the future of AI agent specialization!