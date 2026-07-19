# Vodou Scripts - Complete Technical Documentation

## What Are Scripts?

**Scripts** are registered commands that can be executed through Vodou's script execution system. They enable you to run long-running processes, npm/yarn scripts, shell commands, and custom automation tasks with full job tracking and monitoring.

### Key Concepts

- **Script Registry**: Database table storing all registered scripts
- **Synchronous Execution**: Quick tasks that return output immediately
- **Background Execution**: Long-running tasks that run independently
- **Job Tracking**: Unique job IDs for monitoring and control
- **Output Capture**: Separate stdout/stderr log files for background jobs
- **Process Control**: Ability to cancel running jobs

---

## Scripts Architecture

### Communication Flow

```
User Query (Natural Language)
    ↓
Intent Detection
    ↓
Vodou-script-executor MCP Server
    ↓
Script Registry Lookup
    ↓
Execute Script (Sync or Background)
    ↓
Job Tracking & Monitoring
    ↓
Results Returned
```

### Execution Modes

**1. Synchronous Execution**
- Scripts without `background_execution` flag
- Scripts with estimated duration < 300 seconds
- Returns output immediately
- Blocks until completion
- Best for quick operations (< 5 minutes)

**2. Background Execution**
- Scripts with `background_execution=true`
- Scripts with estimated duration > 300 seconds
- Returns job ID immediately
- Runs independently in background
- Best for long-running operations (> 5 minutes)

---

## Vodou Script Executor MCP Server

### Overview

**Vodou-script-executor** is the MCP server that powers script execution in Vodou. It provides 4 core tools for script management:

1. **`execute_script`** - Execute registered scripts
2. **`script_status`** - Monitor background job status
3. **`script_output`** - View live script output
4. **`cancel_script`** - Stop running background jobs

### Tools

#### 1. execute_script

Execute a registered script synchronously or in background.

**Parameters:**
- `server_name` (string, required): Server that owns the script
- `script_name` (string, required): Name of the script to execute
- `params` (object, optional): Script parameters

**Returns:**
- **Synchronous**: Script output as string
- **Background**: Job ID for tracking

**Example:**
```bash
# Via MCP call
./vodou-core call Vodou-script-executor execute_script '{
  "server_name": "my-project",
  "script_name": "backup"
}'

# Via natural language (with intent mapping)
./do "nightly backup"
```

#### 2. script_status

Get status of a background job.

**Parameters:**
- `job_id` (string, required): Job ID from execute_script

**Returns:**
- Job status (running, completed, failed, cancelled)
- Start time and elapsed time
- Exit code (if completed)
- Process ID (PID)

**Example:**
```bash
./vodou-core call Vodou-script-executor script_status '{"job_id": "job_abc123"}'
```

#### 3. script_output

Get output from a script job (real-time tail).

**Parameters:**
- `job_id` (string, required): Job ID from execute_script
- `tail_lines` (number, optional): Number of lines to retrieve (default: 100)

**Returns:**
- Last N lines from stdout log file
- Real-time output for running jobs

**Example:**
```bash
./vodou-core call Vodou-script-executor script_output '{
  "job_id": "job_abc123",
  "tail_lines": 50
}'
```

#### 4. cancel_script

Cancel a running background job.

**Parameters:**
- `job_id` (string, required): Job ID to cancel

**Returns:**
- Success/failure status
- Graceful termination (SIGTERM → SIGKILL)

**Example:**
```bash
./vodou-core call Vodou-script-executor cancel_script '{"job_id": "job_abc123"}'
```

---

## Using Scripts

### Natural Language Execution

**With Intent Mappings:**
```bash
# Execute script via natural language
./do "nightly backup"
./do "run build"
./do "run tests"
./do "deploy"
```

### Direct MCP Calls

**Execute Script:**
```bash
./vodou-core call Vodou-script-executor execute_script '{
  "server_name": "my-project",
  "script_name": "backup"
}'
```

**Check Status:**
```bash
./vodou-core call Vodou-script-executor script_status '{"job_id": "job_abc123"}'
```

**View Output:**
```bash
./vodou-core call Vodou-script-executor script_output '{
  "job_id": "job_abc123",
  "tail_lines": 100
}'
```

**Cancel Job:**
```bash
./vodou-core call Vodou-script-executor cancel_script '{"job_id": "job_abc123"}'
```

### Finding Scripts

```bash
# List registered scripts (via database query)
sqlite3 vodou-core.db "SELECT server_name, script_name, description FROM script_registry WHERE is_active = 1;"

# Check script details
sqlite3 vodou-core.db "SELECT * FROM script_registry WHERE server_name = 'my-project' AND script_name = 'backup';"
```

---

## Creating and Registering Scripts

### Database Schema

Scripts are registered in the `script_registry` table:

```sql
CREATE TABLE script_registry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_name TEXT NOT NULL,
    script_name TEXT NOT NULL,
    command TEXT NOT NULL,
    working_directory TEXT,
    background_execution INTEGER DEFAULT 0,
    estimated_duration INTEGER,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(server_name, script_name)
);
```

### Registering a Script

**Method 1: Direct Database Insert**

```sql
INSERT INTO script_registry (
    server_name,
    script_name,
    command,
    working_directory,
    background_execution,
    estimated_duration,
    description
) VALUES (
    'my-project',
    'backup',
    './scripts/backup.sh',
    '/path/to/project',
    1,  -- background_execution = true
    600,  -- estimated_duration in seconds (10 minutes)
    'Learn codebase structure and patterns'
);
```

**Method 2: Via Vodou Intent System**

First register the script in database, then create intent mapping:

```sql
-- Register script
INSERT INTO script_registry (...) VALUES (...);

-- Create intent mapping
INSERT INTO intent_mappings (
    keyword,
    server_name,
    tool_name,
    priority,
    tool_parameters
) VALUES (
    'nightly backup',
    'Vodou-script-executor',
    'execute_script',
    10,
    '{"server_name": "my-project", "script_name": "backup"}'
);
```

**Then use via natural language:**
```bash
./do "nightly backup"
```

### Intent Mappings for Scripts

**Creating Script Intents:**

```sql
INSERT INTO intent_mappings (
    keyword,
    server_name,
    tool_name,
    execution_type,
    priority,
    tool_parameters
) VALUES (
    'my-script-keyword',
    'Vodou-script-executor',
    'execute_script',
    'mcp',
    10,
    '{"server_name": "my-server", "script_name": "my-script"}'
);
```

**Common Script Intent Patterns:**

**Codebase Learning:**
```sql
INSERT INTO intent_mappings (...) VALUES (
    'nightly backup',
    'Vodou-script-executor',
    'execute_script',
    'mcp',
    10,
    '{"server_name": "my-project", "script_name": "backup"}'
);
```

**Build Tasks:**
```sql
INSERT INTO intent_mappings (...) VALUES (
    'run build',
    'Vodou-script-executor',
    'execute_script',
    'mcp',
    10,
    '{"server_name": "my-project", "script_name": "build"}'
);
```

**Testing:**
```sql
INSERT INTO intent_mappings (...) VALUES (
    'run tests',
    'Vodou-script-executor',
    'execute_script',
    'mcp',
    10,
    '{"server_name": "my-project", "script_name": "test"}'
);
```

---

## Background Job Management

### Job Lifecycle

1. **Execute**: Script starts, job ID returned
2. **Running**: Script executes in background
3. **Monitor**: Check status and view output
4. **Complete/Fail/Cancel**: Job finishes

### Job Status States

- **`running`**: Script is currently executing
- **`completed`**: Script finished successfully (exit code 0)
- **`failed`**: Script exited with error (non-zero exit code)
- **`cancelled`**: Script was cancelled by user

### Job Information

Each job includes:
- **Job ID**: Unique identifier (e.g., `job_abc123`)
- **Server Name**: Server that owns the script
- **Script Name**: Name of executed script
- **Status**: Current job state
- **Start Time**: When job started
- **Elapsed Time**: How long job has been running
- **Exit Code**: Process exit code (if completed)
- **Process ID (PID)**: System process ID
- **Output Files**: Paths to stdout/stderr logs

### Monitoring Jobs

**Check Status:**
```bash
./do "script status job_abc123"
./vodou-core call Vodou-script-executor script_status '{"job_id": "job_abc123"}'
```

**View Live Output:**
```bash
./do "script output job_abc123"
./vodou-core call Vodou-script-executor script_output '{
  "job_id": "job_abc123",
  "tail_lines": 100
}'
```

**View Last 50 Lines:**
```bash
./vodou-core call Vodou-script-executor script_output '{
  "job_id": "job_abc123",
  "tail_lines": 50
}'
```

### Cancelling Jobs

**Cancel Running Job:**
```bash
./do "cancel script job_abc123"
./vodou-core call Vodou-script-executor cancel_script '{"job_id": "job_abc123"}'
```

**Process:**
1. Sends SIGTERM (graceful termination)
2. Waits 5 seconds
3. If still running, sends SIGKILL (force kill)
4. Updates job status to `cancelled`

---

## Script Best Practices

### 1. Choose Execution Mode

**Use Synchronous for:**
- Quick operations (< 5 minutes)
- Tasks that need immediate results
- Simple commands

**Use Background for:**
- Long-running operations (> 5 minutes)
- Tasks that can run independently
- Operations that don't block other work

### 2. Set Estimated Duration

**Benefits:**
- Helps Vodou decide execution mode automatically
- Provides user expectations
- Aids in resource planning

**Example:**
```sql
estimated_duration = 600  -- 10 minutes
```

### 3. Provide Clear Descriptions

**Good:**
```sql
description = 'Learn codebase structure and patterns for AI context'
```

**Bad:**
```sql
description = 'script'
```

### 4. Use Appropriate Working Directories

**Set working directory:**
```sql
working_directory = '/path/to/project'
```

**Benefits:**
- Scripts run in correct context
- Relative paths work correctly
- Environment variables load properly

### 5. Monitor Long-Running Jobs

**Check status regularly:**
```bash
./do "script status job_abc123"
```

**View output for debugging:**
```bash
./do "script output job_abc123"
```

### 6. Handle Job Failures

**Check exit codes:**
```bash
# Status shows exit_code
./do "script status job_abc123"
```

**View error logs:**
```bash
# Check stderr file path from job status
cat /path/to/logs/job_abc123.err
```

---

## Scripts vs MCP Tools

### Scripts
- **Purpose**: Background job execution and automation
- **Format**: Registered commands in database
- **Execution**: Process spawning with job tracking
- **Control**: Job-based monitoring and cancellation
- **Scope**: Long-running operations, builds, deployments

### MCP Tools
- **Purpose**: Direct tool execution
- **Format**: JSON-RPC tool definitions
- **Execution**: Direct function calls
- **Control**: Parameter-based
- **Scope**: Low-level operations, API calls, queries

### Relationship

Scripts and MCP tools work together:
- Scripts can call MCP tools internally
- MCP tools can trigger scripts
- Both use the same intent system
- Users can't tell the difference

---

## Common Use Cases

### 1. Codebase Learning

**Register Script:**
```sql
INSERT INTO script_registry (
    server_name, script_name, command,
    working_directory, background_execution, estimated_duration
) VALUES (
    'my-project', 'backup', './scripts/backup.sh',
    '/path/to/project', 1, 600
);
```

**Execute:**
```bash
./do "nightly backup"
# Returns: job_abc123

# Monitor
./do "script status job_abc123"
./do "script output job_abc123"
```

### 2. Build Tasks

**Register Script:**
```sql
INSERT INTO script_registry (
    server_name, script_name, command,
    working_directory, background_execution
) VALUES (
    'my-project', 'build', 'npm run build',
    '/path/to/project', 1
);
```

**Execute:**
```bash
./do "run build"
# Runs in background, returns job ID
```

### 3. Testing

**Register Script:**
```sql
INSERT INTO script_registry (
    server_name, script_name, command,
    working_directory, background_execution, estimated_duration
) VALUES (
    'my-project', 'test', 'npm test',
    '/path/to/project', 1, 300
);
```

**Execute:**
```bash
./do "run tests"
```

### 4. Data Processing

**Register Script:**
```sql
INSERT INTO script_registry (
    server_name, script_name, command,
    working_directory, background_execution, estimated_duration
) VALUES (
    'data-processor', 'process', 'python process_data.py',
    '/path/to/data', 1, 1800
);
```

**Execute:**
```bash
./do "process data"
```

---

## Technical Details

### Database Tables

#### script_registry

Stores all registered scripts.

```sql
CREATE TABLE script_registry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_name TEXT NOT NULL,
    script_name TEXT NOT NULL,
    command TEXT NOT NULL,
    working_directory TEXT,
    background_execution INTEGER DEFAULT 0,
    estimated_duration INTEGER,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(server_name, script_name)
);
```

#### script_jobs

Tracks all script executions.

```sql
CREATE TABLE script_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT UNIQUE NOT NULL,
    server_name TEXT NOT NULL,
    script_name TEXT NOT NULL,
    command TEXT NOT NULL,
    working_directory TEXT,
    status TEXT DEFAULT 'running',
    pid INTEGER,
    exit_code INTEGER,
    output_file TEXT,
    error_file TEXT,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    elapsed_seconds INTEGER
);
```

### Environment Variable Loading

Script executor automatically loads `.env` files:

1. Checks working directory for `.env`
2. Loads environment variables
3. Makes them available to script
4. No manual configuration needed

### Output File Management

**Automatic Logging:**
- Background jobs create separate log files
- `job_id.out` for stdout
- `job_id.err` for stderr
- Stored in `logs/scripts/` directory

**File Paths:**
- Available in `script_status` response
- Can be accessed directly
- Persist after job completion

### Process Management

**Independent Execution:**
- Background jobs run in separate processes
- Detached from Vodou process
- Survive Vodou restarts
- Can be monitored independently

**Graceful Termination:**
- SIGTERM first (allows cleanup)
- Wait 5 seconds
- SIGKILL if still running
- Updates database status

---

## Integration with Vodou

### Triple-Layer Intelligence System

**Scripts are Layer 3** of Vodou's architecture:

1. **Layer 1: Skills** - Expert workflow guidance
2. **Layer 2: MCP Tools** - Parallel tool execution
3. **Layer 3: Scripts** - Background job management

**Scripts work with all layers:**
- Skills can orchestrate scripts
- MCP tools can trigger scripts
- Scripts can call MCP tools
- All layers coordinate together

### Intent System Integration

Scripts integrate with Vodou's intent system:

```sql
-- Script intent mapping
INSERT INTO intent_mappings (
    keyword,
    server_name,
    tool_name,
    tool_parameters
) VALUES (
    'my-script',
    'Vodou-script-executor',
    'execute_script',
    '{"server_name": "my-server", "script_name": "my-script"}'
);
```

**Then use:**
```bash
./do "my-script"
```

---

## API Reference

### execute_script

Execute a registered script synchronously or in background.

**Request:**
```json
{
  "server_name": "my-project",
  "script_name": "backup",
  "params": {}
}
```

**Response (Synchronous):**
```json
{
  "output": "Script executed successfully",
  "status": "completed"
}
```

**Response (Background):**
```json
{
  "jobId": "job_abc123",
  "status": "running",
  "message": "Background job started: job_abc123",
  "checkStatus": "./do \"script status job_abc123\"",
  "viewOutput": "./do \"script output job_abc123\""
}
```

### script_status

Get status of a background job.

**Request:**
```json
{
  "job_id": "job_abc123"
}
```

**Response:**
```json
{
  "job_id": "job_abc123",
  "status": "running",
  "server_name": "my-project",
  "script_name": "backup",
  "started_at": "2024-01-13T14:30:00Z",
  "elapsed_seconds": 120,
  "pid": 12345,
  "output_file": "/path/to/logs/job_abc123.out",
  "error_file": "/path/to/logs/job_abc123.err"
}
```

### script_output

Get output from a script job.

**Request:**
```json
{
  "job_id": "job_abc123",
  "tail_lines": 100
}
```

**Response:**
```
Last 100 lines of script output...
```

### cancel_script

Cancel a running background job.

**Request:**
```json
{
  "job_id": "job_abc123"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Job cancelled successfully",
  "status": "cancelled"
}
```

---

## Troubleshooting

### Script Not Found

**Error:** `Script not found: server_name::script_name`

**Solution:**
1. Check script is registered:
   ```sql
   SELECT * FROM script_registry 
   WHERE server_name = 'server_name' AND script_name = 'script_name';
   ```
2. Verify server_name and script_name match exactly
3. Re-register script if needed

### Job Not Starting

**Error:** Job created but status remains `running` with no output

**Solution:**
1. Check script command is valid
2. Verify working directory exists
3. Check file permissions
4. View error log: `cat /path/to/logs/job_id.err`

### Output Not Appearing

**Issue:** `script_output` returns empty

**Solution:**
1. Verify job is actually running: `script_status`
2. Check output file exists: Path from `script_status`
3. Wait a few seconds for output to be written
4. Check file permissions

### Cannot Cancel Job

**Issue:** `cancel_script` doesn't stop job

**Solution:**
1. Check job is actually running: `script_status`
2. Verify job_id is correct
3. Check process exists: `ps aux | grep <PID>`
4. Manually kill if needed: `kill -9 <PID>`

### Environment Variables Not Loading

**Issue:** Script can't find environment variables

**Solution:**
1. Ensure `.env` file exists in working directory
2. Check `.env` file format (KEY=value)
3. Verify working_directory is set correctly
4. Script executor automatically loads `.env` files

---

## Examples

### Complete Workflow

**1. Register Script:**
```sql
INSERT INTO script_registry (
    server_name, script_name, command,
    working_directory, background_execution, estimated_duration
) VALUES (
    'my-project', 'deploy', 'npm run deploy',
    '/path/to/project', 1, 1200
);
```

**2. Create Intent:**
```sql
INSERT INTO intent_mappings (
    keyword, server_name, tool_name, priority, tool_parameters
) VALUES (
    'deploy', 'Vodou-script-executor', 'execute_script', 10,
    '{"server_name": "my-project", "script_name": "deploy"}'
);
```

**3. Execute:**
```bash
./do "deploy"
# Returns: job_abc123
```

**4. Monitor:**
```bash
./do "script status job_abc123"
./do "script output job_abc123"
```

**5. Complete:**
```bash
# Job finishes, status becomes 'completed'
./do "script status job_abc123"
```

---

## Summary

**Scripts in Vodou provide:**
- ✅ Background job execution
- ✅ Full job tracking and monitoring
- ✅ Real-time output viewing
- ✅ Process control and cancellation
- ✅ Integration with intent system
- ✅ Automatic environment loading
- ✅ Persistent job history

**Use scripts for:**
- Long-running operations
- Build and deployment tasks
- Data processing
- Testing suites
- Codebase learning
- Any automation that needs monitoring

**Scripts are a core part of Vodou's Triple-Layer Intelligence System, enabling background automation while maintaining full visibility and control.**

