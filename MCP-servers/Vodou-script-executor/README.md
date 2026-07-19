# Vodou-script-executor

MCP server for executing registered scripts with background job support. This server acts as a proxy between Vodou's intent system and script execution, enabling seamless script execution through natural language queries.

## Features

- ✅ Execute scripts synchronously or in background
- ✅ Automatic background detection based on script configuration
- ✅ Job tracking and status monitoring
- ✅ Output capture and retrieval
- ✅ Job cancellation support
- ✅ Works with existing Vodou intent system

## Installation

```bash
cd MCP-servers/Vodou-script-executor
npm install
npm run build
```

## Connection to Vodou

```bash
cd ../../
./vodou-core connect Vodou-script-executor node -- "$(pwd)/MCP-servers/Vodou-script-executor/dist/index.js"
```

## Usage

### Execute Script

```bash
# Via MCP call
vodou-core call Vodou-script-executor execute_script '{
  "server_name": "my-project",
  "script_name": "backup"
}'

# Via intent (after mapping)
oi "nightly backup"
```

### Check Job Status

```bash
vodou-core call Vodou-script-executor script_status '{"job_id": "job_abc123"}'
```

### Get Job Output

```bash
vodou-core call Vodou-script-executor script_output '{"job_id": "job_abc123", "tail_lines": 100}'
```

### Cancel Job

```bash
vodou-core call Vodou-script-executor cancel_script '{"job_id": "job_abc123"}'
```

## Tools

- `execute_script` - Execute a registered script
- `script_status` - Get status of a background job
- `script_output` - Get output from a script job
- `cancel_script` - Cancel a running background job

## Architecture

This MCP server reads from the `script_registry` and `script_jobs` tables in `vodou-core.db` to:
1. Look up scripts by server_name and script_name
2. Determine if background execution is needed
3. Spawn processes and track them
4. Store job metadata and output

See `SCRIPT-BACKGROUND-EXECUTION.md` for full architecture details.

