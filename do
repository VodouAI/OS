#!/bin/bash

# P4 — this entrypoint declares its stack (stacks.toml). Read by
# `vodou-core stacks`, the exec-world seam, and the receipt, so a lane
# that is off in this composition renders `off (stack)` rather than
# absent — indistinguishable from a lane that failed.
export VODOU_STACK="${VODOU_STACK:-headless}"

# Universal Vodou Router - handles ALL Brain Trust commands

# Resolve script directory (follow symlinks when possible)
SCRIPT_PATH="$0"
while [ -L "$SCRIPT_PATH" ]; do
    LINK_TARGET="$(readlink "$SCRIPT_PATH")"
    if [[ "$LINK_TARGET" == /* ]]; then
        SCRIPT_PATH="$LINK_TARGET"
    else
        SCRIPT_PATH="$(dirname "$SCRIPT_PATH")/$LINK_TARGET"
    fi
done
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"

# Vodou project root = vodou-core (+ exe) plus any launcher: do (canonical), oi (legacy), vodou (alias).
find_project_root() {
    local dir="$1"
    while [ -n "$dir" ] && [ "$dir" != "/" ]; do
        if { [ -f "$dir/vodou-core" ] || [ -f "$dir/vodou-core.exe" ]; } \
            && { [ -f "$dir/do" ] || [ -f "$dir/oi" ] || [ -f "$dir/vodou" ]; }; then
            echo "$dir"
            return 0
        fi
        dir="$(dirname "$dir")"
    done
    return 1
}

# Choose the best project root:
# 1) nearest from current working directory
# 2) VODOU_PROJECT_PATH if valid
# 3) script location (or its parent)
PROJECT_ROOT=""
if PROJECT_ROOT="$(find_project_root "$PWD")"; then
    :
elif [ -n "$VODOU_PROJECT_PATH" ] \
    && { [ -f "$VODOU_PROJECT_PATH/vodou-core" ] || [ -f "$VODOU_PROJECT_PATH/vodou-core.exe" ]; } \
    && { [ -f "$VODOU_PROJECT_PATH/do" ] || [ -f "$VODOU_PROJECT_PATH/oi" ] || [ -f "$VODOU_PROJECT_PATH/vodou" ]; }; then
    PROJECT_ROOT="$VODOU_PROJECT_PATH"
elif PROJECT_ROOT="$(find_project_root "$SCRIPT_DIR")"; then
    :
elif PROJECT_ROOT="$(find_project_root "$(dirname "$SCRIPT_DIR")")"; then
    :
else
    PROJECT_ROOT="$SCRIPT_DIR"
fi

export VODOU_PROJECT_PATH="$PROJECT_ROOT"
cd "$PROJECT_ROOT"

# Ensure Node.js is in PATH (in case it was installed to ~/.local/bin)
setup_nodejs_path() {
    if command -v npm &> /dev/null; then
        return 0
    fi
    
    # Check common Node.js installation locations
    if [ -f "$HOME/.local/bin/npm" ]; then
        export PATH="$HOME/.local/bin:$PATH"
        return 0
    fi

    # Check nvm (common on Linux)
    if [ -d "$HOME/.nvm" ]; then
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
        if command -v npm &> /dev/null; then return 0; fi
    fi

    # Check fnm (fast node manager)
    if [ -d "$HOME/.fnm" ]; then
        export PATH="$HOME/.fnm:$PATH"
        eval "$(fnm env 2>/dev/null)" 2>/dev/null
        if command -v npm &> /dev/null; then return 0; fi
    fi

    # Check Homebrew locations (macOS)
    if [ -f "/opt/homebrew/bin/npm" ]; then
        export PATH="/opt/homebrew/bin:$PATH"
        return 0
    elif [ -f "/usr/local/bin/npm" ]; then
        export PATH="/usr/local/bin:$PATH"
        return 0
    fi

    # Check Linux system locations
    if [ -f "/usr/bin/npm" ]; then
        return 0
    fi
    
    return 1
}

# Setup Node.js PATH before running any commands
setup_nodejs_path

# Ensure bundled Node.js is on PATH
[ -d ".node" ] && export PATH="$(pwd)/.node:$PATH"

# Source .env for all environment variables (VODOU_TOKEN, VODOU_USER_ID, ORT_DYLIB_PATH, etc.)
if [ -f ".env" ]; then
    set -a; . ./.env 2>/dev/null; set +a
fi

# Load ORT_DYLIB_PATH from .env (ONNX Runtime 1.23.2 for vodou-core embed feature)
if [ -f ".env" ]; then
    ORT_PATH=$(grep -E "^ORT_DYLIB_PATH=" .env 2>/dev/null | cut -d= -f2-)
    if [ -n "$ORT_PATH" ]; then
        export ORT_DYLIB_PATH="$ORT_PATH"
    fi
fi

# Run vodou-core so that when this script is killed (e.g. IDE cancel), the child is killed too.
# Prevents orphan vodou-core processes (PPID 1, UE state on macOS).
run_vodou_core() {
    local VC_PID
    trap '[[ -n $VC_PID ]] && kill -9 $VC_PID 2>/dev/null; exit 130' SIGINT SIGTERM
    "$BINARY_PATH" "$@" &
    VC_PID=$!
    wait $VC_PID
    local ret=$?
    trap - SIGINT SIGTERM
    return $ret
}

# Try worker socket first for supported commands; return 0 if handled, 1 to fall back to run_vodou_core.
try_worker() {
    local JSON="$1"
    [ -z "$JSON" ] && return 1
    [ ! -S ".vodou/worker.sock" ] && return 1
    "$BINARY_PATH" worker send --json "$JSON" 2>/dev/null
}

# Build worker JSON for a command.
worker_json() {
    case "$1" in
        list) echo '{"cmd":"list"}' ;;
        list-skills) echo '{"cmd":"list-skills","args":{}}' ;;
        version) echo '{"cmd":"version"}' ;;
        list-tools-db) echo '{"cmd":"list-tools-db","args":{}}' ;;
        find-tool) echo "{\"cmd\":\"find-tool\",\"args\":{\"tool\":\"$2\"}}" ;;
        tool-schema) echo "{\"cmd\":\"tool-schema\",\"args\":{\"tool\":\"$2\"}}" ;;
        export-servers) echo '{"cmd":"export-servers"}' ;;
        health-stats) echo '{"cmd":"health-stats"}' ;;
        approvals) echo "{\"cmd\":\"approvals\",\"args\":{\"server\":\"$2\"}}" ;;
        schedule-list) echo '{"cmd":"schedule-list"}' ;;
        status) echo "{\"cmd\":\"status\",\"args\":{\"server\":\"$2\"}}" ;;
        enable) echo "{\"cmd\":\"enable\",\"args\":{\"server\":\"$2\"}}" ;;
        disable) echo "{\"cmd\":\"disable\",\"args\":{\"server\":\"$2\"}}" ;;
        log) echo "{\"cmd\":\"log\",\"args\":{\"message\":\"$2\"}}" ;;
        *) echo '' ;;
    esac
}

# Determine binary path (release vs development)
# Prefer release binary in root, then fall back to dev build
# Handle both Unix and Windows (.exe) binaries for Git Bash/WSL compatibility
if [ -f "./vodou-core" ]; then
    BINARY_PATH="./vodou-core"
elif [ -f "./vodou-core.exe" ]; then
    BINARY_PATH="./vodou-core.exe"
elif [ -f "./vodou-core" ]; then
    BINARY_PATH="./vodou-core"
elif [ -f "./vodou-core.exe" ]; then
    BINARY_PATH="./vodou-core.exe"
elif [ -f "./target/release/vodou-core" ]; then
    BINARY_PATH="./target/release/vodou-core"
elif [ -f "./target/debug/vodou-core" ]; then
    BINARY_PATH="./target/debug/vodou-core"
elif [ -f "./target/debug/vodou-core" ]; then
    BINARY_PATH="./target/debug/vodou-core"
elif [ -f "./target/debug/vodou-core.exe" ]; then
    BINARY_PATH="./target/debug/vodou-core.exe"
else
    echo "❌ Error: vodou-core binary not found"
    echo "   Looked for: ./vodou-core, ./vodou-core.exe (and legacy ./vodou-core)"
    echo "   And: ./target/release/vodou-core, ./target/debug/vodou-core"
    exit 1
fi

# Check if query provided
if [ $# -eq 0 ]; then
    echo "🧠 Vodou Core — short launcher: ./do (same as ./oi / ./vodou)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Usage: do [OPTIONS] [command] [args...]"
    echo ""
    echo "Options:"
    echo "  --verbose, -v, -d    Show detailed loader output"
    echo "  --clean, -c          Output only raw JSON from tools (no formatting)"
    echo ""
    echo "CLI Commands (60+):"
    echo "  ./do list                        # List all MCP servers"
    echo "  ./do connect <name> <command>    # Connect to MCP server"
    echo "  ./do health-check                # Check all server health"
    echo "  ./do install <name>              # Install MCP server"
    echo "  ./do tools <server>              # Show server tools"
    echo "  ./do sync-mappings <server>      # Auto-discover ID mappings"
    echo ""
    echo "Intent queries:"
    echo "  ./do cpu"
    echo "  ./do \"analyze codebase\""
    echo ""
    echo "Aliases: ./oi, ./vodou (identical scripts)"
    echo ""
    echo "⚡ Universal interface for all Vodou Core operations"
    exit 1
fi

# Intercept "speak" commands — route to gateway voice endpoint (MCP say dies too fast)
FULL_QUERY="$*"
SPEAK_TEXT=""
if echo "$FULL_QUERY" | grep -qi "^speak[: ]"; then
    SPEAK_TEXT=$(echo "$FULL_QUERY" | sed -E 's/^[Ss]peak[: ]*//')
elif echo "$FULL_QUERY" | grep -qi "^say "; then
    SPEAK_TEXT=$(echo "$FULL_QUERY" | sed -E 's/^[Ss]ay //')
fi
if [ -n "$SPEAK_TEXT" ]; then
    WEB_PORT=${WEB_PORT:-8765}
    curl -s -X POST "http://localhost:${WEB_PORT}/api/channels/voice/speak" \
        -H 'Content-Type: application/json' \
        -d "{\"text\":$(echo "$SPEAK_TEXT" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().strip()))')}" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print('🔊 ' + d.get('message','Done'))" 2>/dev/null || echo "⚠️ Gateway not running. Start it first: ./start-vodou-services.sh"
    exit 0
fi

# Parse verbose and clean flags
VERBOSE_MODE=false
CLEAN_MODE=false
ARGS=()

# Process arguments to extract verbose and clean flags
while [[ $# -gt 0 ]]; do
    case $1 in
        --verbose|-v|-d)
            VERBOSE_MODE=true
            shift
            ;;
        --clean|-c)
            CLEAN_MODE=true
            shift
            ;;
        *)
            ARGS+=("$1")
            shift
            ;;
    esac
done

# Restore arguments without verbose flags
set -- "${ARGS[@]}"

# Remove quotes from arguments (strip leading/trailing quotes from each arg)
CLEANED_ARGS=()
for arg in "$@"; do
    # Remove leading and trailing quotes if present
    cleaned_arg=$(echo "$arg" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
    CLEANED_ARGS+=("$cleaned_arg")
done

# If first argument contains spaces and starts with a known CLI command, split it
if [ ${#CLEANED_ARGS[@]} -eq 1 ] && [[ "${CLEANED_ARGS[0]}" =~ [[:space:]] ]]; then
    FIRST_ARG="${CLEANED_ARGS[0]}"
    FIRST_WORD="${FIRST_ARG%% *}"
    # Check if first word is a known CLI command
    case "$FIRST_WORD" in
        connect|tools|prompts|resources|capabilities|call|remove|status|reconnect|health-check|remove-all|reconnect-all|config|update-config|config-startup|export-servers|import-servers|inspect|inspector-cleanup|inspector-start|inspector-restart|validate|test|debug|backfill-metadata|install|scan|call-tool|find-tool|all-tools|list-tools-db|tool-schema|routing-stats|start-monitoring|stop-monitoring|health-check-detailed|health-dashboard|health-stats|registry|roots|update-roots|clear-roots|approvals|approval-policy|auto-approve|progress|cancel|clear-progress|parallel|parallel-custom|brain|mcp-server|sync-docker|sync-mappings|log|help|enable|disable|list|list-skills|update|version|credentials|context|mem|bootstrap|setup|conversation|daemon|worker|workflow|routing-feedback|routing-reset|schedule|runtime-status|board)
            # Split the argument into command and remaining args
            CLEANED_ARGS=($FIRST_ARG)
            ;;
    esac
fi

# CLI Commands (ALL 59+ vodou-core commands) - Direct pass-through
# Ambiguous commands: words that are both CLI subcommands AND common in natural language.
# If followed by args that look like natural language (3+ words total), route to BrainLoader.
COMMAND="${CLEANED_ARGS[0]%% *}"
AMBIGUOUS_CLI_COMMANDS="debug|test|search|analyze|scan|update|help|install|remove|call"
WORD_COUNT=${#CLEANED_ARGS[@]}
if [[ "$COMMAND" =~ ^($AMBIGUOUS_CLI_COMMANDS)$ ]] && [ "$WORD_COUNT" -ge 3 ]; then
    # 3+ words and first word is ambiguous — treat as natural language query
    COMMAND="__intent_query__"
fi
USE_WORKER=
WJSON=
case "$COMMAND" in
    list|list-skills|version|list-tools-db|export-servers|health-stats) USE_WORKER=1; WJSON=$(worker_json "$COMMAND") ;;
    find-tool|tool-schema|approvals|status|enable|disable) USE_WORKER=1; WJSON=$(worker_json "$COMMAND" "${CLEANED_ARGS[1]}") ;;
    schedule) if [ "${CLEANED_ARGS[1]}" = "list" ]; then USE_WORKER=1; WJSON=$(worker_json "schedule-list"); fi ;;
    log) USE_WORKER=1; WJSON=$(worker_json "$COMMAND" "${CLEANED_ARGS[*]:1}") ;;
esac
case "$COMMAND" in
        connect|tools|prompts|resources|capabilities|call|remove|status|reconnect|health-check|remove-all|reconnect-all|config|update-config|config-startup|export-servers|import-servers|inspect|inspector-cleanup|inspector-start|inspector-restart|validate|test|debug|backfill-metadata|install|scan|call-tool|find-tool|all-tools|list-tools-db|tool-schema|routing-stats|start-monitoring|stop-monitoring|health-check-detailed|health-dashboard|health-stats|registry|roots|update-roots|clear-roots|approvals|approval-policy|auto-approve|progress|cancel|clear-progress|parallel|parallel-custom|brain|mcp-server|sync-docker|sync-mappings|log|help|enable|disable|list|list-skills|update|version|credentials|context|mem|bootstrap|setup|conversation|daemon|worker|workflow|routing-feedback|routing-reset|schedule|runtime-status|board)
        # Prefer worker when socket exists, fall back to run_vodou_core
        if [ -n "$USE_WORKER" ] && [ -n "$WJSON" ] && try_worker "$WJSON"; then
            exit $?
        fi
        if [ "$VERBOSE_MODE" = true ]; then
            echo "🚀 **VODOU CLI COMMAND** (Verbose Mode)"
            echo "Command: ${CLEANED_ARGS[*]}"
            echo ""
            run_vodou_core "${CLEANED_ARGS[@]}"
        else
            echo "🚀 **VODOU CLI COMMAND**"
            echo "Command: ${CLEANED_ARGS[*]}"
            echo ""
            run_vodou_core "${CLEANED_ARGS[@]}"
        fi
        ;;
    log:*)
        # Log commands - call log command directly
        # Extract everything after "log:" from the full input
        LOG_MESSAGE="${*#log: }"
        if [ "$VERBOSE_MODE" = true ]; then
            echo "🚀 **VODOU LOG COMMAND** (Verbose Mode)"
            echo "Log: $LOG_MESSAGE"
            echo ""
            run_vodou_core log "$LOG_MESSAGE" --verbose
        else
            echo "🚀 **VODOU LOG COMMAND**"
            echo "Log: $LOG_MESSAGE"
            echo ""
            run_vodou_core log "$LOG_MESSAGE"
        fi
        ;;
    *)
        # Intent-based queries - use AI OS Kernel
        # Join cleaned arguments (quotes already removed)
        QUERY="${CLEANED_ARGS[*]}"
        
        if [ "$CLEAN_MODE" = true ]; then
            # Clean mode: output only raw JSON (no echo, no formatting)
            run_vodou_core brain "$QUERY" --clean
        elif [ "$VERBOSE_MODE" = true ]; then
            echo "🚀 **VODOU COMMAND TRIGGERED** (Verbose Mode)"
            echo "Query: $QUERY"
            echo ""
            echo "🔍 **DETAILED LOADER OUTPUT ENABLED**"
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            run_vodou_core brain "$QUERY" --verbose
        else
            echo "🚀 **VODOU COMMAND TRIGGERED**"
            echo "Query: $QUERY"
            echo ""
            run_vodou_core brain "$QUERY"
        fi
        ;;
esac