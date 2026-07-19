---
name: project-wizard
description: Interactive project setup wizard that demonstrates flow control by asking questions, analyzing context, and executing appropriate setup commands based on user choices
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - "setup new project"
  - "project wizard"
  - "create project interactively"
  - "guided project setup"
  - "oi project wizard"
  - "vodou project wizard"
stopping_points: required
actions: none
imported_from:
  source: hand-written
---

# Vodou Project Wizard - Interactive Setup Assistant

## Overview

This skill demonstrates Vodou's **parallel orchestration power** combined with **interactive flow control** to create lightning-fast project setup. Watch as Vodou executes multiple analysis tools simultaneously, then guides you through intelligent choices to customize your project.

🚀 **Parallel Processing**: Analyze environment, detect tools, check dependencies in seconds (vs minutes sequentially)
🧠 **Intelligent Guidance**: Adaptive questioning based on your environment and needs
🎯 **User-Controlled Flow**: You drive the decisions, Vodou provides orchestrated execution power
⚡ **Smart Automation**: Execute complex setup workflows with real-time progress and error handling

## Interactive Flow Demonstration

### Step 1: Initial Context Gathering

**⏸️ STOPPING POINT - Safety Check First:**

Before I analyze your directory and suggest project types, let me make sure this is safe:

**Is it safe for me to analyze your current directory?**
- **Yes, analyze this directory** - It's empty or I'm okay with analysis
- **No, let me navigate somewhere else first** - I'll specify a different location
- **Yes, but don't modify anything** - Analysis only, no file creation
- **Show me what analysis you'll do first** - I want to see the commands

**Your choice determines how I proceed with the project setup.**

When you're ready, I'll analyze your environment:

```bash
# 🚀 Vodou's Parallel Analysis Power - All executed simultaneously (3 seconds vs 9+ seconds sequential):
./vodou-core brain "directory-contents existing-files installed-tools framework-detection development-environment"

# What happens in parallel:
# ✅ Scan directory structure and contents
# ✅ Detect existing project files (package.json, requirements.txt, etc.)
# ✅ Identify installed development tools and frameworks
# ✅ Check system capabilities and requirements
# ✅ Analyze development environment configuration

# Result: Complete environment profile in 3 seconds instead of 9+ seconds sequential execution
```

**Then I'll ask:**
"Based on my analysis, what type of project would you like to create?"
1. Web Application (React, Vue, Next.js, etc.)
2. API Service (Node.js, Python, Rust, etc.)
3. CLI Tool (Python, Rust, Go, etc.)
4. Library/Package (NPM, PyPI, Cargo, etc.)
5. Full-Stack Application (Multiple components)

### Step 2: Framework Selection (Dynamic Based on Choice)

Based on your project type selection, I'll present relevant options:

**If Web Application chosen:**
```bash
# I'll check what's available:
./vodou-core "check installed web frameworks"
./vodou-core "analyze popular frameworks for this project type"
```

"Which framework would you prefer?"
1. React (with TypeScript)
2. Next.js 14+ (App Router)
3. Vue 3 (Composition API)
4. Vanilla JavaScript (No framework)
5. Let me analyze and recommend

**If you choose "Let me analyze and recommend":**
```bash
# 🔥 Parallel Framework Analysis - All tools execute simultaneously:
./vodou-core brain "project-requirements framework-comparison team-analysis performance-metrics ecosystem-health"

# Parallel execution includes:
# ✅ Analyze project requirements from directory context
# ✅ Compare framework performance and ecosystem health
# ✅ Check team experience from git history and configurations  
# ✅ Evaluate performance metrics and bundle sizes
# ✅ Assess long-term maintainability factors

# Result: Comprehensive framework analysis in 4 seconds vs 15+ seconds sequential
```

Then provide a data-driven recommendation with performance comparisons and reasoning.

### Step 3: Feature Detection and Configuration

**Interactive Feature Selection:**
"Which features would you like to include? (Select multiple)"

```bash
# I'll present options based on your framework:
[ ] Authentication system
[ ] Database integration
[ ] API endpoints
[ ] Testing setup
[ ] CI/CD pipeline
[ ] Docker configuration
[ ] Documentation templates
```

**For each selected feature, I'll ask follow-up questions:**

If Authentication selected:
"What type of authentication?"
1. JWT-based
2. OAuth (Google, GitHub, etc.)
3. Session-based
4. Magic links
5. Multi-factor

### Step 4: Smart Execution with Progress Updates

Based on your selections, I'll execute the setup:

```bash
# 🚀 Parallel Project Setup - Maximum Efficiency Example (Next.js + Auth + Database):

# 1. Parallel Structure Creation & Analysis (2 seconds vs 6+ seconds)
./vodou-core brain "create-nextjs-structure conflict-detection dependency-analysis security-scan"
# Update: "⚡ Creating structure and analyzing conflicts in parallel..."

# If conflicts found - User Choice Required:
# "⚠️ Found existing package.json. Should I:"
# 1. Merge with existing
# 2. Backup and replace  
# 3. Skip this step

# 2. Parallel Dependency Installation (background process while configuring)
./vodou-core brain "install-nextjs-deps install-auth-jwt install-prisma-orm" &
INSTALL_PID=$!
# Update: "📦 Installing dependencies in background..."

# 3. Simultaneous Configuration Generation (while deps install)
./vodou-core brain "generate-auth-config create-db-schema setup-typescript-config"
# Update: "⚙️ Generating configurations in parallel..."

# 4. Parallel Example Creation (3 seconds vs 9+ seconds)
./vodou-core brain "create-api-routes create-components create-middleware create-tests"
# Update: "📝 Creating examples and tests simultaneously..."

# 5. Wait for background installation and validate everything
wait $INSTALL_PID
./vodou-core brain "validate-setup run-build-test check-security"
# Update: "✅ Validation complete - all systems operational!"

# Total Time: ~8 seconds vs 25+ seconds sequential approach
# 🔥 3x faster with intelligent parallel orchestration
```

### Step 5: Validation and Next Steps

After setup, I'll validate and provide guidance:

```bash
# 🚀 Parallel Validation Suite (2 seconds vs 8+ seconds sequential):
./vodou-core brain "build-validation dependency-check security-audit code-quality performance-test"

# Simultaneous validation includes:
# ✅ Build process verification
# ✅ Dependency resolution check
# ✅ Security vulnerability scan  
# ✅ Code quality analysis
# ✅ Performance baseline test

# Result: Complete project validation in 2 seconds with comprehensive reporting
```

**If errors found:**
"I found some issues during setup:"
- [Error description]
- "Would you like me to:"
  1. Fix automatically
  2. Show me how to fix manually
  3. Continue anyway
  4. Rollback changes

**On success:**
"✅ Project setup complete! Here's what I've created:"
- Project structure overview
- Key files and their purposes
- Available scripts
- Next steps

"Would you like me to:"
1. Start the development server
2. Open the project in your editor
3. Show example usage
4. Create initial Git commit
5. Set up deployment

### Flow Control Examples

#### Example 1: Conditional Path Based on Existing Files
```bash
# Check for existing project
if [ -f "package.json" ]; then
    echo "Found existing package.json. Would you like to:"
    echo "1. Integrate with existing project"
    echo "2. Create fresh in subdirectory"
    echo "3. Backup and replace"
    # Wait for user choice
    # Execute different paths based on selection
fi
```

#### Example 2: Progressive Enhancement
```bash
# Start with basic setup
./vodou-core "create basic project structure"

# Ask: "Basic setup complete. Would you like to add:"
# User selects options
# For each selection, execute additional setup:

if user_wants_testing; then
    ./vodou-core "add jest testing configuration"
    ./vodou-core "create example test files"
    echo "✅ Testing framework added"
fi

if user_wants_docker; then
    ./vodou-core "generate dockerfile for project type"
    ./vodou-core "create docker-compose.yml"
    echo "✅ Docker configuration added"
fi
```

#### Example 3: Error Recovery Flow
```bash
# If installation fails:
echo "❌ Package installation failed. I can:"
echo "1. Retry with different package manager (yarn/pnpm)"
echo "2. Skip problematic packages"
echo "3. Debug the issue"
echo "4. Start over"

# Based on choice:
case $choice in
    1) ./vodou-core "retry installation with yarn";;
    2) ./vodou-core "install packages excluding failed ones";;
    3) ./vodou-core "analyze npm error logs and suggest fixes";;
    4) ./vodou-core "cleanup and restart wizard";;
esac
```

## Advanced Flow Control Patterns

### Pattern 1: Multi-Stage Decision Tree
```
Initial Question → Framework Choice → Feature Selection → Configuration → Execution
                ↓                   ↓                  ↓                ↓
         Context Analysis    Compatibility Check   Validation    Error Handling
```

### Pattern 2: Adaptive Questioning
- Start with broad questions
- Narrow down based on responses
- Skip irrelevant questions
- Add questions based on detected context

### Pattern 3: Rollback Capability
- Track each action taken
- Provide undo options at each step
- Allow full rollback if needed
- Maintain backup of modified files

## Parallel Command Orchestration Available

During the wizard, these commands demonstrate Vodou's parallel execution power:

```bash
# 🚀 Parallel Analysis (2-3 seconds vs 8-12 seconds sequential)
./vodou-core brain "directory-structure language-detection config-analysis dependency-scan environment-check"

# ⚡ Parallel Setup (5-8 seconds vs 15-25 seconds sequential)
./vodou-core brain "project-structure dependency-install config-generation example-creation security-setup"

# ✅ Parallel Validation (2-3 seconds vs 6-10 seconds sequential)
./vodou-core brain "setup-validation build-process issue-detection functionality-test performance-baseline"

# 🔥 Real Performance Impact:
# Traditional Sequential: 30-45 seconds for complete project setup
# Vodou Parallel Orchestration: 8-12 seconds for same comprehensive setup
# Result: 3-4x faster project initialization with better coverage
```

## Example Complete Session

```bash
User: ./?do "project wizard"

Wizard: "🚀 Welcome to the Vodou Project Wizard! I'll demonstrate parallel orchestration power
        while guiding you through project setup. Watch the speed difference!
        
        ⚡ Analyzing your environment in parallel..."

[Executes: ./vodou-core brain "directory-analysis tool-detection environment-scan capability-check"]

Wizard: "✅ Complete environment analysis finished in 2.8 seconds!
        📊 Found: Empty directory, Node.js 18+, VS Code, Git configured
        
        What type of project would you like to create?
        1. Web Application (React/Next.js/Vue - 3-5 sec setup)
        2. API Service (Node/Python/Rust - 4-6 sec setup)
        3. CLI Tool (Python/Rust/Go - 3-4 sec setup)
        4. Library/Package (NPM/PyPI/Cargo - 2-3 sec setup)
        5. Full-Stack Application (Multiple components - 8-12 sec setup)"     

User: "1"

Wizard: "Great choice! For a web application, which framework would you prefer?
        1. React (with TypeScript)
        2. Next.js 14+ (App Router)
        3. Vue 3
        4. Vanilla JavaScript
        5. Let me analyze and recommend"

User: "2"

Wizard: "Excellent! Next.js is a powerful choice. Which features would you like?
        [x] TypeScript configuration
        [ ] Authentication system
        [ ] Database integration
        [ ] Testing setup
        [ ] Docker configuration
        
        Type the numbers of additional features (e.g., 2,3,4):"

User: "2,3"

[Wizard executes parallel setup with real-time progress]

⚡ Installing Next.js + TypeScript in background...
⚡ Configuring JWT auth system...
⚡ Setting up Prisma database...
⚡ Generating example code and tests...
⚡ Running security scan and validation...

Wizard: "🎉 Project setup complete in 8.4 seconds! (vs 25+ seconds traditional approach)
        
        ✅ Created with parallel orchestration:
        - Next.js 14 app with TypeScript
        - JWT authentication system with middleware
        - Prisma database with example schema
        - API routes, components, and comprehensive tests
        - Security configuration and performance optimization
        
        🚀 This is Vodou's orchestration power - 3x faster with better coverage!
        
        Ready for next step?
        1. Start development server
        2. Open in VS Code  
        3. Run test suite
        4. Deploy to cloud
        5. Generate documentation"
```

## Key Takeaways - The Vodou Orchestration Advantage

This skill demonstrates the combined power of **parallel execution** and **flow control**:

1. **🚀 Parallel Orchestration**: Execute 5-10 tools simultaneously (3-4x faster than sequential)
2. **🧠 Intelligent Flow Control**: User decisions drive smart path selection
3. **⚡ Real-Time Progress**: Live updates during parallel execution
4. **🎯 Adaptive Questioning**: Questions change based on parallel analysis results
5. **🛡️ Safe Error Recovery**: Parallel validation with graceful failure handling
6. **📊 Performance Transparency**: Show actual time savings to users

**The Vodou Difference:**
- **Traditional approach**: 30-45 seconds, sequential execution, basic setup
- **Vodou orchestration**: 8-12 seconds, parallel execution, comprehensive setup
- **User experience**: 3-4x faster with better quality and more features

This wizard shows how Vodou transforms project setup from a slow, manual process into a fast, intelligent, user-controlled orchestration that feels like magic but delivers real efficiency gains.