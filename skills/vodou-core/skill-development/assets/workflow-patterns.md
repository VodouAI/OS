# Workflow Patterns

Common workflow patterns for Vodou skills.

## Pattern 1: Analysis → Action

**Use Case:** Analyze something, then take action based on results

**Structure:**
```markdown
## Workflow: Analysis → Action

### Step 1: Analysis
./do "analyze [target]"

### 🛑 **STOPPING POINT: Review Results**

**Analysis Results:**
[Results summary]

**Next Steps:**
1. [Action based on results]
2. [Alternative action]
3. [Review details first]

**Your choice? (1, 2, or 3)**

### Step 2: Action
[Execute chosen action]
```

## Pattern 2: Setup → Configure → Deploy

**Use Case:** Multi-phase setup process

**Structure:**
```markdown
## Workflow: Setup → Configure → Deploy

### Phase 1: Setup
[Initial setup steps]

### 🛑 **STOPPING POINT: Setup Complete**

**Setup finished. Ready to configure?**

**Options:**
1. Proceed to configuration
2. Review setup first
3. Skip to deployment
4. Stop here

**Your choice? (1, 2, 3, or 4)**

### Phase 2: Configuration
[Configuration steps]

### 🛑 **STOPPING POINT: Configuration Complete**

**Configuration finished. Ready to deploy?**

**Options:**
1. Deploy now
2. Review configuration first
3. Test first
4. Stop here

**Your choice? (1, 2, 3, or 4)**

### Phase 3: Deployment
[Deployment steps]
```

## Pattern 3: Diagnose → Fix → Verify

**Use Case:** Problem-solving workflow

**Structure:**
```markdown
## Workflow: Diagnose → Fix → Verify

### Step 1: Diagnosis
./do "diagnose [problem]"

### 🛑 **STOPPING POINT: Diagnosis Results**

**Found Issues:**
[Issue list]

**Fix Options:**
1. Fix all issues
2. Fix specific issues
3. Review details first
4. Skip fixes

**Your choice? (1, 2, 3, or 4)**

### Step 2: Fix
[Fix steps based on choice]

### Step 3: Verify
./do "verify [fixes]"
```

## Pattern 4: Collect → Process → Report

**Use Case:** Data collection and reporting

**Structure:**
```markdown
## Workflow: Collect → Process → Report

### Step 1: Collect Data
./do "collect [data sources]"

### 🛑 **STOPPING POINT: Data Collected**

**Data Collection Complete:**
[Summary]

**Processing Options:**
1. Process all data
2. Process specific subset
3. Review data first
4. Skip processing

**Your choice? (1, 2, 3, or 4)**

### Step 2: Process
[Processing steps]

### Step 3: Report
[Generate report]
```

## Pattern 5: Parallel → Correlate → Decide

**Use Case:** Parallel execution with correlation

**Structure:**
```markdown
## Workflow: Parallel → Correlate → Decide

### Step 1: Parallel Execution
./do "tool1 tool2 tool3"  # Execute in parallel

### 🛑 **STOPPING POINT: Results Correlated**

**Parallel Results:**
[Correlated results]

**Decision Options:**
1. [Action based on correlation]
2. [Alternative action]
3. [Review mode]

**Your choice? (1, 2, or 3)**
```

## Pattern 6: Iterative Refinement

**Use Case:** Improve something iteratively

**Structure:**
```markdown
## Workflow: Iterative Refinement

### Iteration 1
[First iteration]

### 🛑 **STOPPING POINT: Iteration Complete**

**Results:**
[Results]

**Next Steps:**
1. Continue to next iteration
2. Refine current iteration
3. Stop here

**Your choice? (1, 2, or 3)**

### Iteration 2
[Second iteration if continued]
```

## Choosing a Pattern

**Use Analysis → Action when:**
- You need to understand before acting
- Results determine next steps
- User needs to review before proceeding

**Use Setup → Configure → Deploy when:**
- Multi-phase process
- Each phase needs approval
- Clear progression

**Use Diagnose → Fix → Verify when:**
- Problem-solving
- Issues need fixing
- Verification required

**Use Collect → Process → Report when:**
- Data workflow
- Processing needed
- Reporting required

**Use Parallel → Correlate → Decide when:**
- Multiple sources needed
- Correlation important
- Decision based on combined results

**Use Iterative Refinement when:**
- Improvement process
- Multiple iterations
- User controls iteration count

