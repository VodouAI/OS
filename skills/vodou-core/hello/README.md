# Vodou Hello - Comprehensive Help Center

## Overview

`hello` is Vodou's comprehensive help center and user guide. It serves as the primary onboarding and reference resource for new and existing Vodou users.

## Structure

```
hello/
├── SKILL.md                    # Main skill file with progressive disclosure
├── README.md                   # This file
├── references/                 # Detailed reference guides
│   ├── what-is-oi.md          # Complete Vodou overview
│   ├── mcp-servers-guide.md   # MCP servers complete guide
│   ├── skills-guide.md         # Skills system guide
│   ├── quick-start.md          # 5-minute quick start
│   └── troubleshooting.md      # Common problems and solutions
├── assets/                     # Visual aids and examples
│   ├── architecture-diagram.md  # System architecture
│   └── workflow-examples.md    # Real-world use cases
└── scripts/                    # Installation and utilities
    └── install-hello.sh     # Intent mapping installer
```

## Features

### Progressive Disclosure
- Starts with friendly introduction
- Early stopping point to guide user learning path
- Deep dives into specific topics based on user choice

### Comprehensive Coverage
- **General Vodou Overview**: What is Vodou, why it exists, how it works
- **MCP Servers**: Complete guide to MCP servers and how to use them
- **Skills System**: Understanding and creating skills
- **Quick Start**: Get running in 5 minutes
- **Advanced Topics**: Orchestration, parallel execution, workflows
- **Troubleshooting**: Common problems and solutions

### User-Friendly Design
- Marketing/UX perspective
- Hand-holding approach for beginners
- Clear explanations without jargon
- Real-world examples

## Installation

### Automatic Installation

The skill is automatically available when Vodou is installed. To register intent mappings:

```bash
cd skills/vodou-core/hello/scripts
./install-hello.sh
```

### Manual Installation

```bash
# Register intent mappings in database
sqlite3 vodou-core.db "INSERT OR IGNORE INTO intent_mappings 
(keyword, server_name, tool_name, execution_type, priority, tool_parameters) VALUES 
('hello', 'vodou-core', 'vc_load_skill', 'mcp', 10, '{\"skill_name\": \"hello\"}');"
```

## Usage

### Trigger Phrases

- `hello`
- `hello world`
- `hi oi`
- `what is oi`
- `how does oi work`
- `help me get started`
- `setup oi`
- `./do help`
- `./do guide`
- `help center`

### Examples

```bash
# Basic help
./do "hello"

# Specific question
./do "what is oi"

# Get started
./do "help me get started"
```

## Content Organization

### Main Skill (SKILL.md)

1. **Introduction** - Friendly welcome
2. **Stopping Point 1** - What would you like to learn?
3. **Section 1** - What is Vodou? (General Overview)
4. **Section 2** - MCP Servers Guide
5. **Section 3** - Skills Guide
6. **Section 4** - Quick Start Guide
7. **Section 5** - Advanced Topics
8. **Section 6** - Troubleshooting
9. **Reference Materials** - Links to supporting docs
10. **Next Steps** - Guidance for different user levels

### Reference Guides

**what-is-oi.md**
- Complete Vodou overview
- Architecture explanation
- Performance characteristics
- Use cases

**mcp-servers-guide.md**
- What are MCP servers
- How they work
- Using MCP servers
- Installing new servers
- Development guide

**skills-guide.md**
- What are skills
- How skills work
- Creating skills
- Best practices

**quick-start.md**
- 5-minute setup guide
- Step-by-step instructions
- First commands
- Common issues

**troubleshooting.md**
- Common problems
- Solutions
- Advanced debugging
- Prevention tips

### Assets

**architecture-diagram.md**
- System architecture
- Data flow diagrams
- Component details
- Protocol support

**workflow-examples.md**
- Real-world use cases
- Parallel vs sequential
- Orchestrated workflows
- Performance comparisons

## Design Principles

### Progressive Disclosure
- Start simple, go deeper on demand
- Early stopping points for user guidance
- Clear navigation paths

### User-Centric
- Written from user perspective
- Hand-holding for beginners
- Clear explanations
- Real examples

### Comprehensive
- Covers all major topics
- Links to detailed references
- Multiple learning paths
- Troubleshooting included

### Accessible
- Natural language triggers
- Multiple entry points
- Clear structure
- Easy navigation

## Maintenance

### Updating Content

1. **Main Skill**: Edit `SKILL.md`
2. **References**: Edit files in `references/`
3. **Assets**: Edit files in `assets/`
4. **Test**: Run `./do "hello"` to verify

### Adding New Content

1. Create new reference file in `references/`
2. Link from main `SKILL.md`
3. Update this README
4. Test and verify

## Contributing

When updating this skill:

1. Maintain progressive disclosure structure
2. Keep user-friendly tone
3. Add stopping points where user choice is needed
4. Link to detailed references
5. Test all trigger phrases
6. Update this README

## Version History

- **v1.0** - Initial comprehensive help center
  - Progressive disclosure structure
  - Complete reference guides
  - Architecture diagrams
  - Workflow examples

---

**This is Vodou's help center - your guide to everything Vodou!** 🚀

