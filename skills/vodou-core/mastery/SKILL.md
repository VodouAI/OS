---
name: mastery
description: Master Vodou's advanced capabilities with progressive learning paths, stopping points, and user-controlled exploration
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - "oi mastery"
  - "vodou mastery"
  - "learn oi"
  - "how to use oi effectively"
  - "oi best practices"
  - "vodou best practices"
  - "optimize oi usage"
  - "learn orchestration"
  - "advanced oi"
  - "--"
stopping_points: required
actions: none
imported_from:
  source: hand-written
---

# Vodou Mastery - Advanced Techniques & Best Practices

## ⚠️ **CRITICAL: AI Agent Instructions**

**This skill teaches advanced Vodou techniques. You MUST:**

### **For Human Users (Progressive Disclosure):**
1. **Present the overview first** - Give users a solid foundation
2. **Use stopping points** - Guide users to specific topics based on their needs
3. **Progressive disclosure** - Start broad, go deep on demand
4. **Reference supporting docs** - Use `references/` and `assets/` for detailed info
5. **Give users control** - Let them choose what to learn

### **For AI Agent Learning (BYPASS MODE):**
**When you need to quickly learn all Vodou mastery content for your own knowledge:**

1. **Read all reference files immediately** (bypass stopping points):
   - `references/parallel-execution.md` - Complete parallel execution guide
   - `references/orchestration-patterns.md` - All orchestration patterns
   - `references/skills-advanced.md` - Advanced skills usage
   - `references/intents-advanced.md` - Advanced intent management
   - `references/work-logging.md` - Complete logging guide
   - `references/workflow-examples.md` - Real-world examples
   - `references/pro-tips.md` - Expert tips and best practices

2. **Read all asset files:**
   - `assets/workflow-patterns.md` - Common workflow patterns
   - `assets/orchestration-examples.md` - Orchestration examples

3. **Read the complete SKILL.md** - All sections and stopping points

**BYPASS RULE**: When loading this skill for YOUR OWN LEARNING (not presenting to users), read all references and assets immediately. When presenting to HUMAN USERS, use progressive disclosure with stopping points.

**This skill contains advanced Vodou knowledge. Use progressive disclosure for users - but bypass for your own learning!**

---

## 📖 **Quick Overview: What is Vodou Mastery?**

**Vodou Mastery** teaches you to use Vodou's advanced capabilities effectively:

- **Parallel Execution** - Run 5-10 tools simultaneously (3-7x faster)
- **Workflow Orchestration** - Tools direct what executes next
- **Skills System** - Expert guidance with user control (66+ active skills)
- **Intent Mappings** - Custom natural language routing (392+ intent mappings)
- **Scripts System** - Background job execution and management
- **Work Logging** - Track your work systematically
- **Right Context at the Right Time** - On-demand, relevant context
- **Daisy-Chain Workflows** - MCP results flow into Skills

**Key Philosophy:**
Vodou transforms you from a sequential tool user into an **intelligent workflow orchestrator** with expert guidance, parallel processing, and full user control.

---

## 🛑 **STOPPING POINT 1: What Would You Like to Master?**

Now that you understand the basics, what advanced topic would you like to explore?

**Choose a topic:**

1. **⚡ Parallel Execution** - Master running multiple tools simultaneously for 3-7x speedup
2. **🎯 Workflow Orchestration** - Learn how tools direct what executes next
3. **🧠 Skills System** - Advanced skill usage and creation
4. **🔗 Intent Mappings** - Create custom natural language routing
5. **📝 Work Logging** - Systematic work tracking and metadata
6. **🔄 Real-World Workflows** - Complete examples and patterns
7. **💡 Pro Tips & Best Practices** - Expert techniques and optimizations
8. **📚 All Reference Guides** - Access all detailed documentation

**Please tell me which number (1-8) interests you, or say "all" for everything!**

---

## ⚡ **Section 1: Parallel Execution - The Game Changer**

### Quick Summary

**Parallel execution** is Vodou's superpower - running multiple tools simultaneously instead of one at a time.

**Key Points:**
- Execute 5-10 MCP tools in parallel
- 3-7x faster than sequential execution
- Automatic result correlation
- Think in parallel, not sequential

### Real Performance Comparison

**Traditional Sequential Approach:**
```bash
# ❌ SLOW - Sequential execution (15-30 seconds)
./do "check cpu"          # 3-4 seconds
./do "check memory"       # 3-4 seconds  
./do "check disk"         # 3-4 seconds
./do "analyze code"       # 5-8 seconds
# Total: ~15-20 seconds + manual correlation
```

**Vodou Parallel Approach:**
```bash
# ✅ FAST - Parallel execution (3-5 seconds total)
./do "cpu memory disk analyze-code"
# All execute simultaneously, results correlated automatically
# 5-7x FASTER + comprehensive analysis
```

### 🛑 **STOPPING POINT 2: Parallel Execution Depth**

**How deep do you want to go?**

**Option 1: Quick Overview**
- Basic parallel execution examples
- Simple patterns
- 2-3 minutes

**Option 2: Comprehensive Guide**
- All parallel patterns
- Power user examples
- Best practices
- 10-15 minutes

**Option 3: Advanced Patterns**
- Complex parallel workflows
- Cross-server coordination
- Performance optimization
- 20+ minutes

**Your choice? (1, 2, or 3)**

**For detailed parallel execution guide, see:** `references/parallel-execution.md`

---

## 🎯 **Section 2: Workflow Orchestration - The Intelligence Revolution**

### Quick Summary

**Workflow Orchestration** means tools direct what executes next based on results - intelligent automation.

**Key Points:**
- Tools can trigger next steps automatically
- Conditional workflows based on results
- User choices determine workflow paths
- Cross-server orchestration
- **Triple-layer orchestration** - Mix MCP servers, Skills, and Scripts in a single workflow

### How Orchestration Works

**Traditional: Manual Steps**
```bash
./do "check cpu"                    # Step 1: See CPU usage
./do "check memory"                 # Step 2: Manually check memory
./do "run optimization"             # Step 3: Manually decide to optimize
```

**Vodou Orchestration: Intelligent Workflow**
```bash
./do "optimize my system"
# Analysis → Detection → Options → Execution → Verification
# Each step informs the next, user chooses path
```

### 🛑 **STOPPING POINT 3: Orchestration Learning Path**

**What aspect of orchestration interests you?**

**Option 1: Basic Orchestration**
- How orchestration works
- Simple examples
- Getting started

**Option 2: Advanced Patterns**
- Database-driven orchestration (Pattern 4)
- Triple-layer orchestration (Pattern 5: MCP + Skills + Scripts)
- Cross-server workflows
- Custom orchestration directives
- Complex patterns

**Option 3: Real-World Examples**
- Complete workflow examples
- Step-by-step walkthroughs
- Best practices

**Your choice? (1, 2, or 3)**

**For detailed orchestration guide, see:** 
- `references/orchestration-patterns.md` - All orchestration patterns
- `docs-DEV/database-driven-orchestration.md` - Complete Database-Driven Orchestration documentation (Pattern 4 & 5) (internal)

---

## 🧠 **Section 3: Skills System - The Intelligence Layer**

### Quick Summary

**Skills** are expert guides that teach AI agents (and you) how to accomplish tasks effectively.

**Key Points:**
- Skills checked FIRST before other operations
- Interactive guidance with stopping points
- Can execute Vodou commands and MCP tools
- User control at decision points
- 66+ active skills with built-in Rust executor
- 183 skill intent mappings for natural language access

### Skills First Priority

**CRITICAL RULE**: When you receive an `oi` command, ALWAYS check for matching skills FIRST.

```bash
# When a user types:
./do "create oi skill"

# Vodou's priority order:
# 1. ✅ FIRST: Look for matching skill (finds skill-development)
# 2. Load and present the skill's guidance
# 3. Use remaining context to focus on specific aspects
```

### 🛑 **STOPPING POINT 4: Skills Learning Path**

**What do you want to learn about skills?**

**Option 1: Using Skills**
- How to use existing skills
- Finding the right skill
- Following skill workflows

**Option 2: Creating Skills**
- Skill development guide
- Best practices
- Templates and examples

**Option 3: Advanced Skills**
- Interactive skills
- Skills that execute commands
- Orchestration in skills

**Your choice? (1, 2, or 3)**

**For detailed skills guide, see:** `references/skills-advanced.md`

---

## 🔗 **Section 4: Intent Mappings - Natural Language Routing**

### Quick Summary

**Intent Mappings** route natural language keywords to MCP server tools OR Skills.

**Key Points:**
- Map keywords to `server::tool` (MCP servers)
- Map keywords to `vodou-core::vc_load_skill` (Skills)
- Priority system for conflict resolution
- Create custom intents for your workflows
- 183 skill intents + 209 MCP tool intents = 392+ total intent mappings

### How Intents Work

**MCP Server Intents:**
```bash
cpu → mcp-monitor::get_cpu_info (priority: 10)
```

**Skill Intents:**
```bash
hello → vodou-core::vc_load_skill
  tool_parameters: {"skill_name": "hello"}
```

### 🛑 **STOPPING POINT 5: Intent Management**

**What do you want to do with intents?**

**Option 1: View Existing Intents**
- List all intents
- Understand current mappings
- See how they work

**Option 2: Create New Intents**
- Add MCP server tool intents
- Add skill intents
- Set priorities

**Option 3: Advanced Intent Patterns**
- Orchestration in intents
- Complex routing patterns
- Best practices

**Your choice? (1, 2, or 3)**

**For detailed intents guide, see:** `references/intents-advanced.md`

---

## 📝 **Section 5: Work Logging - Your Digital Memory**

### Quick Summary

**Work Logging** tracks your work systematically for future context.

**Key Points:**
- Log with categories and metadata
- Track features, bugfixes, analysis, etc.
- Rich metadata for analytics
- Future context for AI agents

### Logging Format

```bash
# Basic logging
./do "log: Fixed authentication bug"

# Rich logging with metadata (RECOMMENDED)
./do "log: feature: Implemented JWT authentication | component: auth | files_changed: 5 | duration: 2h | complexity: high"
```

**Categories**: feature, bugfix, analysis, documentation, testing, refactor, performance, security, config, deployment, maintenance, research, planning, review

### 🛑 **STOPPING POINT 6: Work Logging Depth**

**How detailed do you want to get?**

**Option 1: Quick Start**
- Basic logging format
- Common categories
- Simple examples

**Option 2: Comprehensive Guide**
- All categories explained
- Metadata best practices
- Advanced patterns

**Option 3: Analytics & Reporting**
- Using logged data
- Querying work history
- Performance tracking

**Your choice? (1, 2, or 3)**

**For detailed logging guide, see:** `references/work-logging.md`

---

## 🔄 **Section 6: Real-World Workflows - Complete Examples**

### Quick Summary

**Real-world workflows** show Vodou's true value - expert guidance + parallel processing + user direction.

**Key Points:**
- Complete end-to-end examples
- Multiple tools working together
- User control at decision points
- Real performance improvements

### Example Workflows

**System Performance Investigation:**
- 15 tools in parallel (5 seconds)
- Results trigger diagnostics
- User chooses optimization path
- Complete solution in 2 minutes (vs 10+ minutes)

**Security Assessment:**
- 20+ tools in parallel (8 seconds)
- Comprehensive security audit
- Prioritized recommendations
- Complete in 2 minutes (vs 30+ minutes)

### 🛑 **STOPPING POINT 7: Workflow Examples**

**What type of workflow interests you?**

**Option 1: System Operations**
- Performance monitoring
- Troubleshooting
- Optimization

**Option 2: Development Workflows**
- Code analysis
- Testing
- Deployment

**Option 3: Security & Analysis**
- Security audits
- Code reviews
- Dependency analysis

**Your choice? (1, 2, or 3)**

**For complete workflow examples, see:** `references/workflow-examples.md` and `assets/workflow-patterns.md`

---

## 💡 **Section 7: Pro Tips & Best Practices**

### Quick Summary

**Pro tips** help you get the most from Vodou.

**Key Tips:**
- Think in parallel, not sequential
- Use descriptive queries
- Leverage intent mappings
- Monitor performance
- Batch similar operations

### 🛑 **STOPPING POINT 8: Pro Tips Focus**

**What area do you want to optimize?**

**Option 1: Performance Tips**
- Speed optimization
- Parallel execution patterns
- Efficiency improvements

**Option 2: Workflow Tips**
- Better workflows
- Orchestration patterns
- Best practices

**Option 3: All Pro Tips**
- Complete pro tips guide
- Common pitfalls
- Quick reference

**Your choice? (1, 2, or 3)**

**For complete pro tips, see:** `references/pro-tips.md`

---

## 📚 **Section 8: All Reference Guides**

### Complete Documentation Library

**Reference Guides** (in `references/` directory):
- `parallel-execution.md` - Complete parallel execution guide
- `orchestration-patterns.md` - All orchestration patterns
- `skills-advanced.md` - Advanced skills usage
- `intents-advanced.md` - Advanced intent management
- `work-logging.md` - Complete logging guide
- `workflow-examples.md` - Real-world examples
- `pro-tips.md` - Expert tips and best practices

**Assets** (in `assets/` directory):
- `workflow-patterns.md` - Common workflow patterns
- `orchestration-examples.md` - Orchestration examples

### 🛑 **STOPPING POINT 9: Reference Guide Selection**

**Which reference guide would you like?**

1. Parallel Execution Guide
2. Orchestration Patterns
3. Advanced Skills Guide
4. Advanced Intents Guide
5. Work Logging Guide
6. Workflow Examples
7. Pro Tips Guide
8. All of the above

**Say the number (1-8) or name the guide you want.**

---

## 🤖 **AI Agent Quick Reference: Complete File List**

**For AI agents learning Vodou mastery - read all these files immediately (BYPASS MODE):**

### **Reference Files** (read all 7):
1. `skills/vodou-core/mastery/references/parallel-execution.md`
2. `skills/vodou-core/mastery/references/orchestration-patterns.md`
3. `skills/vodou-core/mastery/references/skills-advanced.md`
4. `skills/vodou-core/mastery/references/intents-advanced.md`
5. `skills/vodou-core/mastery/references/work-logging.md`
6. `skills/vodou-core/mastery/references/workflow-examples.md`
7. `skills/vodou-core/mastery/references/pro-tips.md`

### **Asset Files** (read all 2):
1. `skills/vodou-core/mastery/assets/workflow-patterns.md`
2. `skills/vodou-core/mastery/assets/orchestration-examples.md`

### **Main Skill File**:
- `skills/vodou-core/mastery/SKILL.md` (this file - read completely)

**Total: 10 files to read for complete Vodou mastery knowledge**

**BYPASS INSTRUCTION**: When you (AI agent) need to learn Vodou mastery for your own knowledge, read all 10 files above immediately. Skip stopping points and progressive disclosure - this is for YOUR learning, not user presentation.

---

## 🎯 **Quick Reference**

### Essential Commands

```bash
# Discovery (ALWAYS CHECK SKILLS FIRST!)
./do "available skills"           # Available skills - CHECK FIRST!
./do "list tools"                  # Available MCP tools
./do "show intents"                # All intent mappings

# Parallel Execution
./do "cpu memory disk network"     # Multiple tools in parallel

# Skills Usage (PRIORITY #1)
./do "create oi skill"             # Loads skill-development
./do "install mcp server"          # Loads mcp-installer
./do "hello"                       # Loads hello help center
./do "available skills"            # List all 66+ available skills

# Scripts Usage (Background Jobs)
./do "run script"                  # Execute background scripts
./do "script status job_12345"     # Check job status
./do "script output job_12345"     # View live output

# Logging
./do "log: category: message | key: value | key2: value2"

# Status
./do "job status"                  # Background job status
./do "system health"               # System status
./do "recent work"                 # Work history
```

---

## 💡 **Key Principles**

**Remember these when mastering Vodou:**

1. **Think Parallel** - Always consider parallel execution
2. **Skills First** - Check for skills before other operations
3. **User Control** - Respect stopping points and user choices
4. **Right Context** - On-demand, relevant context loading
5. **Daisy-Chain** - MCP results flow into Skills workflows
6. **Log Everything** - Track your work systematically
7. **Never Assume** - Always ask users at decision points

---

## 🚀 **The Vodou Evolution**

**Your journey:**
- **Tool Executor** → Sequential tool usage
- **Parallel Processor** → Multiple tools simultaneously
- **Intelligent Workflow Orchestrator** → Expert guidance + parallel execution + user control

**Master Vodou and transform how you work!**

---

**Need help?** Ask me questions at any stopping point, or reference the guides in `references/` and `assets/`.
