---
name: user-flow-control
description: Guidelines for building skills with proper stopping points where AI agents pause for user input instead of making assumptions and executing commands automatically
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - "user flow control"
  - "interactive ai control"
  - "ai stopping points"
  - "pause for user input"
  - "skill interaction patterns"
stopping_points: required
actions: inline
imported_from:
  source: hand-written
---

# Vodou User Flow Control - Building Interactive Skills

## Overview

This skill teaches developers how to build Vodou skills with proper **stopping points** - moments where the AI pauses to ask the user questions instead of making assumptions and proceeding automatically. Every Vodou skill should give users control over the interaction flow.

## Core Concept: AI as Interactive Guide

Traditional AI follows a linear path:
```
User Request → AI Analysis → AI Action → AI Response
```

Vodou User Flow Control creates dynamic interaction:
```
User Request → AI Analysis → Present Options → WAIT for User Choice → 
Adapt Path → Execute Based on Choice → Present New Options → Continue...
```

## Mandatory Stopping Points for All Skills

Every Vodou skill MUST include these stopping points:

### 1. After Initial Analysis - Present Path Options
```bash
# ❌ BAD - AI makes assumptions:
"I found 3 issues. Let me fix them automatically."

# ✅ GOOD - AI pauses for user choice:
"I found 3 issues. Which should we tackle first?"
"1. Memory optimization (quick win)"
"2. Security vulnerabilities (critical)" 
"3. Performance tuning (comprehensive)"
"Your choice?"
```

### 2. Before Executing Potentially Disruptive Commands
```bash
# ❌ BAD - AI executes without asking:
./vodou-core "restart all services"

# ✅ GOOD - AI asks permission first:
"I need to restart services to apply changes. Proceed?"
"1. Yes, restart all services now"
"2. Just restart the affected service"
"3. Skip restart for now"  
"4. Show me what will be restarted first"
```

### 3. When Multiple Approaches Are Possible
```bash
# ❌ BAD - AI picks approach arbitrarily:
"Installing with npm..."

# ✅ GOOD - AI lets user choose approach:
"Multiple installation methods available:"
"1. NPM install (fastest)"
"2. Build from source (most control)"
"3. Use package manager (system integration)"
"Which method do you prefer?"
```

### 4. After Discovering Important Information
```bash
# ❌ BAD - AI assumes what to do with findings:
"Found security issue. Applying fix..."

# ✅ GOOD - AI reports and asks for direction:
"🚨 Found critical security vulnerability in dependency."
"How should we handle this?"
"1. Update dependency immediately"
"2. Show me details first"
"3. Check for breaking changes"
"4. Skip for now and continue"
```

## Key Principles

### 1. Pause and Present Options
AI agents should stop at decision points and present meaningful choices:

```bash
# Instead of assuming what to do:
"I found 3 memory issues. Let me fix them all."

# Use flow control:
"I found 3 memory issues. Which should we tackle first?"
"1. High Chrome usage (immediate impact)"  
"2. System indexing (background cleanup)"
"3. Memory leak detection (long-term solution)"
"Your choice determines our approach."
```

### 2. Adapt Execution Paths
Each user choice triggers different command sequences:

```bash
# Choice 1 triggers Chrome optimization:
if user_choice == "1":
    ./vodou-core "identify chrome memory hogs"
    ./vodou-core "find unnecessary chrome processes"
    ask("Should I close specific tabs or restart Chrome entirely?")

# Choice 2 triggers system optimization:
elif user_choice == "2":
    ./vodou-core "check spotlight indexing status"
    ./vodou-core "analyze system background processes"
    ask("Pause indexing temporarily or optimize it?")
```

### 3. Context-Aware Questions
Questions should adapt based on what the AI discovers:

```bash
# Dynamic questioning based on findings:
if high_cpu_detected:
    ask("High CPU detected. Investigate:")
    "1. Find the process causing it"
    "2. Check if this is normal for your workflow"
    "3. Look for optimization opportunities"

if network_slow_detected:
    ask("Network latency found. Focus on:")
    "1. Test specific external services"
    "2. Analyze local network config"
    "3. Check DNS resolution speed"
```

## Flow Control Patterns

### Pattern 1: Investigation Flow
```bash
# Start broad, narrow based on user interest
"System analysis complete. What concerns you most?"
"1. Performance issues"
"2. Security assessment" 
"3. Development environment"

# Then dive deeper based on choice:
if performance_chosen:
    analyze_performance()
    ask("Found bottlenecks in CPU and disk. Which first?")
```

### Pattern 2: Progressive Disclosure
```bash
# Reveal information step by step
"Initial scan found 5 issues. See overview or dive into specifics?"

if overview:
    show_summary()
    ask("Which issue category interests you most?")

if specifics:
    ask("Which specific area to analyze first?")
    present_detailed_options()
```

### Pattern 3: Error Recovery Flow
```bash
# Handle failures gracefully with user choice
if command_fails:
    "Command failed. I can:"
    "1. Try alternative approach"
    "2. Skip this step"
    "3. Debug the issue"
    "4. Get more info before proceeding"
    
    # Wait for choice, then adapt
```

### Pattern 4: Confirmation Points
```bash
# Pause before potentially disruptive actions
"I found 2GB of temp files to delete. Proceed?"
"1. Yes, delete them"
"2. Show me what files first" 
"3. Skip cleanup"
"4. More conservative cleanup"
```

## Implementation Guidelines

### For AI Agents
1. **Always present 3-5 meaningful options** (not too few, not overwhelming)
2. **Make consequences clear** ("This will restart the service")
3. **Adapt follow-up questions** based on previous choices
4. **Remember context** throughout the conversation
5. **Provide escape hatches** ("Go back", "Skip this", "Show overview")

### Question Quality Standards
- ✅ **Specific**: "Optimize memory or CPU first?" not "What next?"
- ✅ **Actionable**: Each option leads to concrete actions
- ✅ **Contextual**: Based on actual findings, not generic
- ✅ **Consequential**: User choice meaningfully changes the path

### Command Adaptation
```bash
# Commands should change based on user path:

# Memory optimization path:
./vodou-core "find memory leaks"
./vodou-core "analyze process memory usage"

# Performance optimization path:  
./vodou-core "benchmark system performance"
./vodou-core "identify CPU bottlenecks"

# Security assessment path:
./vodou-core "scan for security vulnerabilities"
./vodou-core "check system hardening"
```

## Advanced Flow Control

### Multi-Stage Decision Trees
```
Initial Question → User Choice A → Follow-up Question A → User Choice A1 → Execute A1
                              → Follow-up Question B → User Choice A2 → Execute A2
                → User Choice B → Follow-up Question B → Execute B1
```

### Context Stacking
Remember user preferences within the session:
```bash
# Remember user tends toward performance over security
if user_previously_chose_performance:
    prioritize_performance_options()
    
# Remember user prefers detailed explanations
if user_prefers_detailed:
    show_detailed_analysis()
else:
    show_summary_only()
```

### Parallel Flow Management
Handle multiple concurrent user interests:
```bash
# User interested in both performance and security
"You've chosen both performance and security analysis."
"Should I:"
"1. Do performance first, then security"
"2. Run both in parallel and show combined results"
"3. Focus on security-performance intersection"
```

## Flow Control Examples

### Example 1: System Optimization Wizard
```bash
User: ./?do "optimize my system"

AI: "System analysis complete! I found several optimization opportunities:
     - Memory usage at 85% (high)  
     - 15 background processes running
     - Disk usage at 78%
     
     What's your priority?"
     1. Free up memory immediately
     2. Clean up disk space  
     3. Optimize startup performance
     4. Comprehensive optimization plan

User: "1"

AI: "Memory optimization path selected. I found:
     - Chrome using 600MB (multiple tabs)
     - Development tools using 400MB
     - System services using 200MB
     
     Best approach?"
     1. Close unnecessary browser tabs
     2. Restart development tools to clear leaks
     3. Optimize system services
     4. All of the above in sequence

# Flow continues based on user choices...
```

### Example 2: Debugging Assistant
```bash
User: ./?do "help debug this error"

AI: "I'll help debug your error. First, what type of error are you seeing?"
     1. Application crash/exception
     2. Performance/slowness issue
     3. Network/connectivity problem
     4. Build/compilation error
     5. Show me the error and I'll categorize it

User: "5"

AI: [After analyzing error]
     "This appears to be a memory allocation error in Rust. I can:"
     1. Analyze your code for memory safety issues
     2. Check system memory availability
     3. Review compiler flags and build settings
     4. Run diagnostic tools to pinpoint the issue
     
     "Which approach would be most helpful?"

# Flow adapts based on error type and user preference
```

## Why This Helps AI Agents

Proper stopping points transform AI agent behavior:

### ✅ **Before (No Stopping Points)**
- AI makes assumptions about user intent
- Commands execute automatically without confirmation
- Users feel like they lost control
- Mistakes happen when AI guesses wrong
- Linear, rigid interaction flow

### ✅ **After (With Stopping Points)**  
- AI asks for clarification at key moments
- User drives the direction of the conversation
- AI becomes a collaborative partner, not automation
- Fewer mistakes due to user confirmation
- Dynamic, user-controlled interaction flow

### For AI Agents Running Skills

When you encounter a skill with proper stopping points:

1. **Present the options exactly as written** in the skill
2. **Wait for user input** - don't proceed automatically
3. **Execute the path** the user chooses
4. **Ask follow-up questions** based on the results
5. **Remember user preferences** for the rest of the session

**Example AI Agent Behavior:**
```bash
# Skill loads and presents options:
"System analysis complete. What's your priority?"
"1. Fix memory issues (immediate)"
"2. Security assessment (thorough)"  
"3. Performance optimization (comprehensive)"

# AI agent waits for user to type "1", "2", or "3"
# Then executes the corresponding path from the skill
# Then presents the next set of options based on results
```

## Integration with Vodou Skills

Every Vodou skill should incorporate flow control:

```markdown
### In Your Skill:
1. Present initial options after analysis
2. Wait for user choice  
3. Execute path based on choice
4. Present follow-up options
5. Continue until user satisfaction

### Example Integration:
"MCP server analysis complete. What's your goal?"
1. Install new MCP server
2. Debug existing server issues  
3. Optimize server performance
4. Create custom MCP server

[Based on choice, load different sub-workflows]
```

## Best Practices

### Do:
- ✅ **Present clear, actionable options**
- ✅ **Explain what each choice leads to**  
- ✅ **Remember user preferences in the session**
- ✅ **Provide "go back" and "overview" options**
- ✅ **Adapt questions based on findings**

### Don't:
- ❌ **Ask vague questions** ("What would you like to do?")
- ❌ **Present too many options** (>6 becomes overwhelming)
- ❌ **Make assumptions** about what user wants
- ❌ **Ignore previous user choices** in the session
- ❌ **Force users down a single path**

## Flow Control Commands

Skills can use these patterns for consistent flow control:

```bash
# Present options and wait
ask_user_choice() {
    echo "Your options:"
    echo "1. [Option with clear outcome]"
    echo "2. [Alternative with different outcome]" 
    echo "3. [Third path]"
    echo "Choice?"
}

# Execute based on choice
execute_user_path() {
    case $user_choice in
        1) execute_path_1 && ask_followup_1;;
        2) execute_path_2 && ask_followup_2;;
        3) execute_path_3 && ask_followup_3;;
    esac
}

# Adaptive questioning
adapt_questions_to_context() {
    if [[ $findings == "high_memory" ]]; then
        present_memory_options()
    elif [[ $findings == "slow_network" ]]; then
        present_network_options()
    fi
}
```

## Success Metrics

Good flow control creates:
- **User Agency**: Users feel in control of the interaction
- **Relevant Options**: Choices are meaningful and contextual  
- **Clear Outcomes**: Users understand what each choice does
- **Adaptive Paths**: Experience changes based on user preferences
- **Efficient Resolution**: Reaches user goals faster through directed paths

## Remember

User Flow Control transforms AI from an automated script executor into an intelligent, interactive guide. The user drives the conversation, while the AI provides expert knowledge, relevant options, and adaptive execution paths.

**The goal**: Make users feel like they're having a conversation with an expert consultant who pauses to understand their priorities and adapts their approach accordingly.

---

## AGENT_ACTIONS — Making Skills Executable

Skills can embed executable tool sequences so the Vodou-Console (or CLI agents) can execute multi-step workflows automatically when the user picks a stopping point option.

### Format

Add `<!-- AGENT_ACTIONS_N: {...} -->` HTML comments after each stopping point menu, where N matches the option number:

```markdown
## STOPPING POINT 1 — Choose Action

1. Quick scan
2. Deep analysis

<!-- AGENT_ACTIONS_1: {"label":"Quick scan","vars":{"DEPTH":"3"},"steps":[
  {"server":"your-server","tool":"start_scan","args":{"target":"{{TOPIC}}"},"capture":{"SCAN_ID":"id"}},
  {"server":"your-server","tool":"check_result","args":{"scan_id":"{{SCAN_ID}}"}}
]} -->

<!-- AGENT_ACTIONS_2: {"label":"Deep analysis","vars":{"DEPTH":"10"},"steps":[
  {"server":"your-server","tool":"start_scan","args":{"target":"{{TOPIC}}","depth":10},"capture":{"SCAN_ID":"id"}},
  {"server":"your-server","tool":"analyze","args":{"scan_id":"{{SCAN_ID}}"},"loop":10,"stream_progress":true},
  {"server":"your-server","tool":"get_report","args":{"scan_id":"{{SCAN_ID}}"}}
]} -->
```

### Step Properties

| Property | Description |
|----------|-------------|
| `server` | MCP server name (must be registered in Vodou) |
| `tool` | Tool name on that server |
| `args` | Arguments object — supports `{{VAR}}` template variables |
| `loop` | Repeat this step N times (`{{i}}` = 1-based counter) |
| `capture` | `{"VAR_NAME": "response_field"}` — capture a field from the response for use in later steps |
| `stream_progress` | Show progress in the UI during loops |

### Template Variables

| Variable | Source |
|----------|--------|
| `{{TOPIC}}` | Extracted from the user's original query |
| `{{i}}` | Current loop iteration (1-based) |
| `{{VAR_NAME}}` | Any variable captured from a previous step |
| Variables from `vars` | Injected when the user picks the option (e.g., `"vars":{"DEPTH":"10"}` → `{{DEPTH}}`) |

### How It Works

1. BrainLoader loads the skill and returns the markdown (including HTML comments)
2. The gateway's workflow driver parses `<!-- AGENT_ACTIONS_N: -->` blocks
3. User picks an option number
4. Gateway executes the corresponding steps sequentially via `vodou-core call`
5. Variables are captured and chained between steps
6. Claude gets the complete results to format conversationally

**Key benefit:** Claude can't skip steps, fake output, or wing it — the gateway drives every tool call. The skill author controls the exact workflow.