#!/bin/bash
# Background Job Wrapper Script
# Runs a command, captures output, and updates database on exit
# This script is spawned as a detached process and handles its own lifecycle

set -e

JOB_ID="$1"
DB_PATH="$2"
COMMAND="$3"
WORKING_DIR="$4"
OUTPUT_FILE="$5"
ERROR_FILE="$6"

# Ensure output directories exist
mkdir -p "$(dirname "$OUTPUT_FILE")"
mkdir -p "$(dirname "$ERROR_FILE")"

# Write start marker
echo "--- Job $JOB_ID Started: $(date -u +%Y-%m-%dT%H:%M:%SZ) ---" >> "$OUTPUT_FILE"
echo "--- Job $JOB_ID Started: $(date -u +%Y-%m-%dT%H:%M:%SZ) ---" >> "$ERROR_FILE"
echo "Command: $COMMAND" >> "$OUTPUT_FILE"
echo "Working Directory: $WORKING_DIR" >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"

# Function to update database on exit
update_db_on_exit() {
    local exit_code=$1
    local status
    
    if [ $exit_code -eq 0 ]; then
        status="completed"
    else
        status="failed"
    fi
    
    # Use sqlite3 to update the database
    sqlite3 "$DB_PATH" <<EOF
UPDATE script_jobs 
SET status = '$status', 
    exit_code = $exit_code, 
    completed_at = CURRENT_TIMESTAMP
WHERE job_id = '$JOB_ID';
EOF
    
    # Write completion marker
    echo "" >> "$OUTPUT_FILE"
    echo "--- Job $JOB_ID Finished with code $exit_code: $(date -u +%Y-%m-%dT%H:%M:%SZ) ---" >> "$OUTPUT_FILE"
    echo "" >> "$ERROR_FILE"
    echo "--- Job $JOB_ID Finished with code $exit_code: $(date -u +%Y-%m-%dT%H:%M:%SZ) ---" >> "$ERROR_FILE"
}

# Trap exit to always update database
trap 'update_db_on_exit $?' EXIT

# Trap signals to update database
trap 'update_db_on_exit 130' SIGTERM
trap 'update_db_on_exit 130' SIGINT

# Change to working directory
cd "$WORKING_DIR" || {
    echo "Error: Failed to change to working directory: $WORKING_DIR" >> "$ERROR_FILE"
    exit 1
}

# Load .env file if it exists (go up to project root)
PROJECT_ROOT="$(cd "$WORKING_DIR/../.." && pwd 2>/dev/null || echo "$WORKING_DIR")"
if [ -f "$PROJECT_ROOT/.env" ]; then
    set -a
    source "$PROJECT_ROOT/.env" 2>/dev/null || true
    set +a
fi

# Export VODOU_PROJECT_PATH if not set
export VODOU_PROJECT_PATH="${VODOU_PROJECT_PATH:-$PROJECT_ROOT}"

# Execute the command, capturing both stdout and stderr
# If params were passed via environment, append them to the command
# Params are passed as JSON in PARAMS_JSON env var
if [ -n "$PARAMS_JSON" ]; then
    # Parse JSON params and append as command arguments
    # For scripts that accept positional args, extract path and maxFiles
    PATH_ARG=$(echo "$PARAMS_JSON" | grep -o '"path":"[^"]*"' | cut -d'"' -f4 || echo "")
    MAX_FILES_ARG=$(echo "$PARAMS_JSON" | grep -o '"maxFiles":[0-9]*' | cut -d':' -f2 || echo "")
    
    # Build command with parameters
    if [ -n "$PATH_ARG" ] && [ -n "$MAX_FILES_ARG" ]; then
        COMMAND="$COMMAND $PATH_ARG $MAX_FILES_ARG"
    elif [ -n "$PATH_ARG" ]; then
        COMMAND="$COMMAND $PATH_ARG"
    fi
fi

# Execute the command, capturing both stdout and stderr
eval "$COMMAND" >> "$OUTPUT_FILE" 2>> "$ERROR_FILE"

EXIT_CODE=$?

# Exit with the command's exit code
exit $EXIT_CODE

