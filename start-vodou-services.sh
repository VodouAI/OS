#!/bin/bash

# P4 — this entrypoint declares its stack (stacks.toml). Read by
# `vodou-core stacks`, the exec-world seam, and the receipt, so a lane
# that is off in this composition renders `off (stack)` rather than
# absent — indistinguishable from a lane that failed.
export VODOU_STACK="${VODOU_STACK:-web}"

# KISS: Vodou Services Manager
# Handles both setup and execution of required services
#
# Usage:
#   ./start-vodou-services.sh          # Normal startup
#   DEBUG=1 ./start-vodou-services.sh  # Verbose debug output with timeouts shown

# ALWAYS use script's own location as the project root.
# Never trust VODOU_PROJECT_PATH from the shell — it may point to a stale/old install.
VODOU_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export VODOU_PROJECT_PATH="$VODOU_DIR"
SHELL_RC=""

# ── Debug mode ────────────────────────────────────────────────
DEBUG="${DEBUG:-0}"
dbg() { [ "$DEBUG" = "1" ] && echo "  [DEBUG] $*" || true; }

# ── Read WEB_PORT from .env (installer may have assigned a non-default port) ──
WEB_PORT="${WEB_PORT:-8765}"
if [ -f "$VODOU_DIR/.env" ]; then
    _env_port=$(grep -m1 '^WEB_PORT=' "$VODOU_DIR/.env" 2>/dev/null | cut -d= -f2)
    [ -n "$_env_port" ] && WEB_PORT="$_env_port"
fi
if [ -f "$VODOU_DIR/MCP-servers/Vodou-Console/.env" ]; then
    _gw_port=$(grep -m1 '^WEB_PORT=' "$VODOU_DIR/MCP-servers/Vodou-Console/.env" 2>/dev/null | cut -d= -f2)
    [ -n "$_gw_port" ] && WEB_PORT="$_gw_port"
fi

# ── sqlite3 availability (used for DB-based server checks) ──
HAS_SQLITE3=0
command -v sqlite3 &>/dev/null && HAS_SQLITE3=1
[ "$HAS_SQLITE3" = "0" ] && dbg "sqlite3 not found — DB-based server checks will be skipped"

# ── Port ownership helpers ────────────────────────────────────
# `lsof -ti :PORT` matches EVERY socket on that port, CLIENTS INCLUDED. A
# browser tab holding the gateway's WebSocket is returned as a "PID on 8765",
# so the kill path below used to SIGTERM Google Chrome. That is the real
# "chat wigs out + new browser windows" symptom filed as §F2 — a browser being
# killed and recovering, not a gateway restarting. Always filter to LISTEN.
listening_pids_on_port() {
    local port="$1"
    command -v lsof &>/dev/null || return 0
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null
}

# Absolute cwd of a running PID = the install that gateway is actually serving.
# Asks the kernel, not the process, so it works against every already-installed
# build — no new endpoint, no gateway cooperation, nothing to roll out first.
# Empty output means "could not determine", which callers must treat as unknown
# rather than as a mismatch.
pid_cwd() {
    local pid="$1" d=""
    [ -n "$pid" ] || return 0
    if [ -r "/proc/$pid/cwd" ]; then
        d=$(readlink -f "/proc/$pid/cwd" 2>/dev/null)                              # Linux
    elif command -v lsof &>/dev/null; then
        d=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1) # macOS
    fi
    [ -n "$d" ] || return 0
    (cd "$d" 2>/dev/null && pwd -P) || true
}

# ── Aux-surface port guard ────────────────────────────────────
# 5.8/5.9 below used to treat "something is listening" as proof the brain
# console / Vodou One was already up. It is not. stop-vodou-services.sh only
# ever killed the listener on WEB_PORT, so a gateway started back when the
# install ran WEB_PORT=8767 outlives every later stop/start once WEB_PORT moves
# back to 8765 — nothing kills it again — and the start path then printed
# "brain console already running" for that squatter and never spawned the real
# server. One install sat like that for seven weeks. So probe identity, not
# presence, and reclaim the port when the squatter is provably ours (cwd inside
# this install). A stranger's dev server on the port is reported, never killed.
#
# mtime of a file, and the newest mtime among a directory's .js — portable
# across BSD stat (-f %m) and GNU stat (-c %Y).
file_mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || true; }
newest_build_mtime() {
    local target="$1" newest="" m f
    [ -e "$target" ] || return 0
    if [ ! -d "$target" ]; then file_mtime "$target"; return 0; fi
    while IFS= read -r f; do
        m=$(file_mtime "$f"); [ -n "$m" ] || continue
        if [ -z "$newest" ] || { [ "$m" -gt "$newest" ] 2>/dev/null; }; then newest="$m"; fi
    done <<EOF
$(find "$target" -type f -name '*.js' 2>/dev/null)
EOF
    echo "$newest"
}

# Epoch seconds at which a PID started. Empty = could not determine, which
# callers must treat as "assume current" rather than "assume stale" — restarting
# a healthy server on a bad clock read is worse than skipping one update.
proc_start_epoch() {
    local pid="$1" lstart=""
    [ -n "$pid" ] || return 0
    # Linux: /proc/<pid> directory mtime is the process start time.
    if [ -d "/proc/$pid" ]; then
        stat -c %Y "/proc/$pid" 2>/dev/null && return 0
    fi
    lstart=$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//;s/ *$//')
    [ -n "$lstart" ] || return 0
    date -j -f '%c' "$lstart" +%s 2>/dev/null || date -d "$lstart" +%s 2>/dev/null || true
}

# Echoes exactly one of: free | running | stale | reclaimed | blocked
#
# $4 (optional) is the build target — a file, or a directory whose newest .js
# dates the build. If the running server predates its own code, it is serving
# pre-update JS: neither auto_updater.rs nor component_updater.rs ever stops
# these two surfaces (both only kill PIDs on WEB_PORT and then delegate here),
# so without this check an updated install keeps the old brain console running
# forever and this function would keep reporting it as healthy.
probe_aux_port() {
    local port="$1" probe_url="$2" probe_match="$3" build_target="${4:-}"
    local pids pid got ours=0 survivors stale=0 built proc_started
    pids=$(listening_pids_on_port "$port")
    [ -n "$pids" ] || { echo free; return 0; }

    # Identity: the real server answers THIS route with THIS text. A squatting
    # gateway 404s here (it only serves /api/brain/execute), so it cannot pass.
    if curl -fsS -m 3 "$probe_url" 2>/dev/null | grep -q "$probe_match"; then
        if [ -n "$build_target" ]; then
            built=$(newest_build_mtime "$build_target")
            if [ -n "$built" ]; then
                for pid in $pids; do
                    proc_started=$(proc_start_epoch "$pid")
                    [ -n "$proc_started" ] || continue
                    if [ "$built" -gt "$proc_started" ] 2>/dev/null; then stale=1; fi
                done
            fi
        fi
        # Current → leave it alone. Stale → fall through to the ownership check
        # below, so we only ever restart a stale server that is provably ours.
        if [ "$stale" != "1" ]; then
            echo running
            return 0
        fi
    fi

    for pid in $pids; do
        got=$(pid_cwd "$pid")
        [ -n "$got" ] || continue
        case "$got" in "$VODOU_DIR"|"$VODOU_DIR"/*) ours=1 ;; esac
    done
    if [ "$ours" != "1" ]; then echo blocked; return 0; fi

    for pid in $pids; do kill "$pid" 2>/dev/null; done
    sleep 2
    survivors=$(listening_pids_on_port "$port")
    if [ -n "$survivors" ]; then
        for pid in $survivors; do kill -9 "$pid" 2>/dev/null; done
        sleep 1
    fi
    if [ -n "$(listening_pids_on_port "$port")" ]; then
        echo blocked
    elif [ "$stale" = "1" ]; then
        echo stale
    else
        echo reclaimed
    fi
}

# Node good enough to run the aux surfaces. Both are ESM, and the brain opens
# memory.db through `node:sqlite`, which only exists in Node 22.13+/24+. 5.8/5.9
# used to spawn a bare `node` with no version gate: on a box whose PATH node is
# older, the server died on import while the script still printed "started", so
# the failure was invisible. Mirrors the gateway's GW_NODE selection above.
# Empty output means "no usable Node" — callers must report that, not spawn.
aux_node() {
    local n="$VODOU_DIR/.node/node" v major rest minor
    [ -x "$n" ] && { echo "$n"; return 0; }
    n="$(command -v node 2>/dev/null || true)"
    [ -n "$n" ] || return 0
    v="$("$n" --version 2>/dev/null | sed 's/^v//')"
    major="${v%%.*}"; rest="${v#*.}"; minor="${rest%%.*}"
    [ -n "$major" ] || return 0
    if [ "$major" -gt 22 ] 2>/dev/null; then echo "$n"; return 0; fi
    if [ "$major" = "22" ] && [ "${minor:-0}" -ge 13 ] 2>/dev/null; then echo "$n"; fi
    return 0
}

# ── Self-heal macOS quarantine ────────────────────────────────
# Releases are ad-hoc signed, never notarized, so any file that arrives carrying
# com.apple.quarantine (browser download, Archive Utility expand, AirDrop, VM
# shared folder) trips Gatekeeper's "Apple could not verify ... is free of
# malware" dialog the first time something dlopen()s it. node-pty's pty.node is
# the usual first casualty because the gateway loads it at boot.
# install-prebuilt.sh already strips quarantine — but a user who runs THIS
# script first, or copies an installed folder onto another machine afterwards,
# never got that pass. So strip here too: probe a few representative files and
# only walk the whole tree when one is actually flagged, so the normal start
# path pays nothing.
if [[ "$OSTYPE" == "darwin"* ]] && command -v xattr &>/dev/null; then
    _pty_arch="x64"; [[ $(uname -m) == "arm64" ]] && _pty_arch="arm64"
    _q_hit=0
    for _probe in "$VODOU_DIR" \
                  "$VODOU_DIR/vodou-core" \
                  "$VODOU_DIR/vodou-hook-bin" \
                  "$VODOU_DIR/MCP-servers/Vodou-Console/node_modules/node-pty/prebuilds/darwin-$_pty_arch/pty.node"; do
        [ -e "$_probe" ] || continue
        if xattr -p com.apple.quarantine "$_probe" &>/dev/null; then _q_hit=1; break; fi
    done
    if [ "$_q_hit" = "1" ]; then
        echo "🔓 macOS quarantine detected — clearing it (one time, a few seconds)..."
        xattr -dr com.apple.quarantine "$VODOU_DIR" 2>/dev/null || true
        echo "   ✅ Quarantine cleared"
    fi
fi

# ── Self-heal global CLI symlink ──────────────────────────────
# install-prebuilt.sh creates ~/.local/bin/vodou on fresh installs only;
# anyone who UPDATES an older install in place never got it (and the
# auto-updater only heals the paths it runs). This script runs after every
# update and on every manual start, so heal here too. Idempotent + quiet:
# only touches links that are missing or point somewhere else. The legacy
# global `oi` symlink is deliberately NOT propagated (pre-rename branding).
_healed_cli_link=0
heal_cli_symlink() {
    local target="$1" link="$2"
    [ -e "$target" ] || return 0
    if [ "$(readlink "$link" 2>/dev/null)" != "$target" ]; then
        mkdir -p "$(dirname "$link")"
        if ln -sf "$target" "$link" 2>/dev/null; then
            echo "   ✅ Linked $link -> $target"
            _healed_cli_link=1
        fi
    fi
}
[ -f "$VODOU_DIR/bin/vodou-cli" ] && chmod +x "$VODOU_DIR/bin/vodou-cli" 2>/dev/null
heal_cli_symlink "$VODOU_DIR/bin/vodou-cli" "$HOME/.local/bin/vodou"
if [ "$_healed_cli_link" = "1" ]; then
    case ":$PATH:" in
        *":$HOME/.local/bin:"*) : ;;
        *) echo "   ⚠️  ~/.local/bin is not on your PATH — add it to use 'vodou' globally:"
           echo "       echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc && source ~/.zshrc" ;;
    esac
fi

# FR-4 (ALPHA-READINESS §9 A0) — macOS ships no `timeout` binary, and without
# coreutils there is no `gtimeout` either. The `timeout ... daemon ensure` call
# further down was therefore a command-not-found on every Mac: the guard never
# guarded anything, and the failure branch under it — "trying direct start" —
# ran on EVERY start, racing a daemon that was in fact coming up fine. Prefers
# the real binary where it exists so Linux behaviour is unchanged.
run_with_timeout() {
    local secs="$1"; shift
    if command -v timeout >/dev/null 2>&1; then
        timeout "$secs" "$@"
    elif command -v gtimeout >/dev/null 2>&1; then
        gtimeout "$secs" "$@"
    else
        "$@" &
        local cmd_pid=$!
        local waited=0
        while kill -0 "$cmd_pid" 2>/dev/null; do
            if [ "$waited" -ge "$secs" ]; then
                kill -TERM "$cmd_pid" 2>/dev/null || true
                sleep 1
                kill -KILL "$cmd_pid" 2>/dev/null || true
                wait "$cmd_pid" 2>/dev/null || true
                return 124
            fi
            sleep 1
            waited=$((waited + 1))
        done
        wait "$cmd_pid"
    fi
}

# Run vodou-core with timeout guard (default 30s).
# Prevents hangs from blocking the entire installer.
run_vc() {
    local VC_TIMEOUT="${VC_TIMEOUT:-30}"
    dbg "vodou-core $* (timeout: ${VC_TIMEOUT}s)"
    local VC_PID
    trap '[[ -n $VC_PID ]] && kill -9 $VC_PID 2>/dev/null; exit 130' SIGINT SIGTERM
    "$VODOU_DIR/vodou-core" "$@" &
    VC_PID=$!
    # Watchdog: kill vodou-core if it exceeds timeout
    ( sleep "$VC_TIMEOUT" && kill -9 $VC_PID 2>/dev/null ) &
    local WATCHDOG=$!
    wait $VC_PID 2>/dev/null
    local ret=$?
    kill $WATCHDOG 2>/dev/null
    wait $WATCHDOG 2>/dev/null 2>&1
    trap - SIGINT SIGTERM
    if [ $ret -eq 137 ]; then
        echo "   ⚠️  vodou-core timed out after ${VC_TIMEOUT}s (killed)"
        return 1
    fi
    dbg "vodou-core exited with code $ret"
    return $ret
}

if [ -f "$VODOU_DIR/scripts/mcp-bundled-heal.sh" ]; then
    # shellcheck source=scripts/mcp-bundled-heal.sh
    . "$VODOU_DIR/scripts/mcp-bundled-heal.sh"
fi

# Ensure Node.js is on PATH (check common install locations, bundled .node/ as last resort)
for EXTRA_PATH in "$HOME/.local/bin" "/opt/homebrew/bin" "/usr/local/bin" "$VODOU_DIR/.node"; do
    if [ -d "$EXTRA_PATH" ] && [[ ":$PATH:" != *":$EXTRA_PATH:"* ]]; then
        export PATH="$EXTRA_PATH:$PATH"
    fi
done

# Detect shell type
if [ -n "$ZSH_VERSION" ]; then
    SHELL_RC="$HOME/.zshrc"
    SHELL_NAME="zsh"
elif [ -n "$BASH_VERSION" ]; then
    SHELL_RC="$HOME/.bashrc"
    SHELL_NAME="bash"
fi

# Check if auto-start is already configured
is_auto_start_configured() {
    if [ -n "$SHELL_RC" ] && [ -f "$SHELL_RC" ]; then
        grep -q "start-vodou-services.sh" "$SHELL_RC" 2>/dev/null
    else
        return 1
    fi
}

# Setup auto-start configuration
setup_auto_start() {
    if [ -z "$SHELL_RC" ]; then
        echo "❌ Unsupported shell. Please add this manually to your shell profile:"
        echo "   if [ -f \"$VODOU_DIR/start-vodou-services.sh\" ]; then"
        echo "       \"$VODOU_DIR/start-vodou-services.sh\" > /dev/null 2>&1"
        echo "   fi"
        return 1
    fi

    echo "🚀 Setting up Vodou Auto-Start for your system..."
    echo "📍 Vodou Directory: $VODOU_DIR"

    # Add auto-start configuration
    echo "" >> "$SHELL_RC"
    echo "# Vodou Auto-Start Services" >> "$SHELL_RC"
    echo "if [ -f \"$VODOU_DIR/start-vodou-services.sh\" ]; then" >> "$SHELL_RC"
    echo "    \"$VODOU_DIR/start-vodou-services.sh\" > /dev/null 2>&1" >> "$SHELL_RC"
    echo "fi" >> "$SHELL_RC"

    echo "✅ Vodou auto-start configured in $SHELL_RC"
    echo "🔄 Please restart your terminal or run: source $SHELL_RC"
    echo ""
    echo "💡 This will automatically start Vodou services every time you open a terminal"
    echo "🛑 To disable: Remove the Vodou Auto-Start section from $SHELL_RC"
}

# Ensure Node.js is in PATH (in case it was installed to ~/.local/bin)
setup_nodejs_path() {
    if command -v npm &> /dev/null; then
        export PATH  # Ensure PATH is exported for child processes
        return 0
    fi
    
    # Check common Node.js installation locations
    if [ -f "$HOME/.local/bin/npm" ]; then
        export PATH="$HOME/.local/bin:$PATH"
        return 0
    fi
    
    # Check Homebrew locations
    if [ -f "/opt/homebrew/bin/npm" ]; then
        export PATH="/opt/homebrew/bin:$PATH"
        return 0
    elif [ -f "/usr/local/bin/npm" ]; then
        export PATH="/usr/local/bin:$PATH"
        return 0
    fi
    
    return 1
}

# Check if Docker is installed
check_docker_installed() {
    if command -v docker &> /dev/null; then
        return 0
    else
        return 1
    fi
}

# Start the actual services
start_services() {
    echo "🚀 Starting Vodou Required Services..."
    
    # Ensure Node.js is accessible and exported for child processes
    setup_nodejs_path
    export PATH  # Ensure PATH is exported for all child processes
    
    # Ensure we're in the Vodou directory
    cd "$VODOU_DIR"

    # Create .env from .env.example if missing (ensures gateway starts on first run)
    if [ ! -f "$VODOU_DIR/.env" ] && [ -f "$VODOU_DIR/.env.example" ]; then
        cp "$VODOU_DIR/.env.example" "$VODOU_DIR/.env"
        # Set VODOU_PROJECT_PATH
        echo "VODOU_PROJECT_PATH=\"$VODOU_DIR\"" >> "$VODOU_DIR/.env"
        echo "VODOU_ALLOW_HEADLESS_BRAIN=1" >> "$VODOU_DIR/.env"
        echo "   ✅ Created .env from .env.example"
    fi

    # Source .env for all variables
    if [ -f "$VODOU_DIR/.env" ]; then
        set -a; . "$VODOU_DIR/.env" 2>/dev/null; set +a
    fi

    # Load START_AIGATEWAY from .env if set (so .env.example START_AIGATEWAY=1 is effective)
    if [ -f "$VODOU_DIR/.env" ] && grep -q "^START_AIGATEWAY=" "$VODOU_DIR/.env" 2>/dev/null; then
        export START_AIGATEWAY=$(grep "^START_AIGATEWAY=" "$VODOU_DIR/.env" | cut -d '=' -f2- | tr -d '"' | tr -d "'")
    fi

    # Default to starting gateway if not explicitly set
    export START_AIGATEWAY="${START_AIGATEWAY:-1}"

    # Docker Gateway removed — not needed for current MCP server set

    # 2. Browser Tools: browser-tools-mcp removed — replaced by chrome-devtools (npx-based, no startup needed)
    # 3. OI-Sequential-Thinking and OI-playwright-mcp removed (deprecated — use chrome-devtools instead)

    # 5. Auto-connect context7 to Vodou (if not already connected)
    echo ""
    dbg "=== context7 ==="
    echo "📚 Checking context7 connection..."
    if [ -d "$VODOU_DIR/MCP-servers/context7" ]; then
        # Check if Context7 is already connected
        if [ -f "$VODOU_DIR/vodou-core.db" ]; then
            CONTEXT7_CONNECTED=$(sqlite3 "$VODOU_DIR/vodou-core.db" "SELECT COUNT(*) FROM mcp_servers WHERE name='context7';" 2>/dev/null || echo "0")
            
            if [ "$CONTEXT7_CONNECTED" = "0" ]; then
                echo "   🔌 Connecting context7 to Vodou..."
                
                # Check if Node.js is available
                if command -v node &> /dev/null; then
                    # Check if built (packages/mcp/dist/index.js exists) AND dependencies are installed
                    if [ -f "$VODOU_DIR/MCP-servers/context7/packages/mcp/dist/index.js" ] && [ -d "$VODOU_DIR/MCP-servers/context7/node_modules" ]; then
                        # Connect Context7 to Vodou using built version
                        cd "$VODOU_DIR"
                        run_vc connect context7 node "$VODOU_DIR/MCP-servers/context7/packages/mcp/dist/index.js" > /dev/null 2>&1
                        
                        if [ $? -eq 0 ]; then
                            echo "   ✅ context7 connected successfully"
                        else
                            echo "   ⚠️  Failed to connect built version, trying npx fallback..."
                            # Fallback to npx
                            run_vc connect context7 npx -- -y @upstash/context7-mcp > /dev/null 2>&1
                            if [ $? -eq 0 ]; then
                                echo "   ✅ context7 connected successfully (using npx)"
                            else
                                echo "   ⚠️  Failed to connect context7 (may need manual connection)"
                                echo "      Run: ./vodou-core connect context7 npx -- -y @upstash/context7-mcp"
                            fi
                        fi
                    elif [ -f "$VODOU_DIR/MCP-servers/context7/packages/mcp/dist/index.js" ] && [ ! -d "$VODOU_DIR/MCP-servers/context7/node_modules" ]; then
                        echo "   ⚠️  context7 dependencies missing (node_modules not found)"
                        echo "   💡 Using npx fallback (no build needed)..."
                        cd "$VODOU_DIR"
                        run_vc connect context7 npx -- -y @upstash/context7-mcp > /dev/null 2>&1
                        if [ $? -eq 0 ]; then
                            echo "   ✅ context7 connected successfully (using npx)"
                        else
                            echo "   ⚠️  Failed to connect. To build from source:"
                            echo "      Install pnpm: npm install -g pnpm"
                            echo "      Then: cd MCP-servers/context7 && pnpm install && pnpm run build:mcp"
                            echo "      Then: ./vodou-core connect context7 node MCP-servers/context7/packages/mcp/dist/index.js"
                        fi
                    else
                        echo "   💡 context7 not built, using npx fallback (published package)..."
                        cd "$VODOU_DIR"
                        run_vc connect context7 npx -- -y @upstash/context7-mcp > /dev/null 2>&1
                        if [ $? -eq 0 ]; then
                            echo "   ✅ context7 connected successfully (using npx)"
                        else
                            echo "   ⚠️  Failed to connect. To build from source:"
                            echo "      Install pnpm: npm install -g pnpm"
                            echo "      Then: cd MCP-servers/context7 && pnpm install && pnpm run build:mcp"
                            echo "      Then: ./vodou-core connect context7 node MCP-servers/context7/packages/mcp/dist/index.js"
                        fi
                    fi
                else
                    echo "   ⚠️  Node.js not found. context7 requires Node.js"
                fi
            else
                echo "   ✅ context7 already connected"
            fi
        else
            echo "   ℹ️  Database not initialized yet. context7 will be connected on first Vodou command."
        fi
    else
        echo "   ⚠️  context7 not found in release"
    fi

    # 5.5. Auto-connect Vodou-LLM-router (heals stale /tmp or absolute dev paths)
    echo ""
    if declare -F ensure_bundled_mcp_server >/dev/null 2>&1; then
        ensure_bundled_mcp_server Vodou-LLM-router MCP-servers/Vodou-LLM-router/dist/index.js
    elif [ ! -d "$VODOU_DIR/MCP-servers/Vodou-LLM-router" ]; then
        echo "   ⚠️  Vodou-LLM-router not found in release"
    fi

    # 5.5b. Self-heal channel plugin symlinks (BEFORE connect, so the server
    # discovers channels on init). The @vodou/channel-* packages in
    # ~/.vodou/channels/node_modules are file: symlinks that bake in an absolute
    # path at link time. If the repo was moved (e.g. vodou → _vodou) or a source
    # install skipped the linking step, every symlink dangles and Vodou-channels
    # discovers 0 channels — Slack/Telegram/etc. then silently fail with no signal.
    # Detect dangling links (or a missing install) and re-link to the CURRENT path.
    # Mirrors install-prebuilt.sh's bootstrap block; idempotent and fast.
    CHANNELS_DIR="$HOME/.vodou/channels"
    PACKAGES_DIR="$VODOU_DIR/MCP-servers/Vodou-channels/packages"
    if [ -d "$PACKAGES_DIR" ] && command -v npm &> /dev/null; then
        _ch_stale=0
        if [ -d "$CHANNELS_DIR/node_modules/@vodou" ]; then
            for _link in "$CHANNELS_DIR/node_modules/@vodou/"channel-*; do
                [ -e "$_link" ] || { _ch_stale=1; break; }
            done
        else
            _ch_stale=1
        fi
        if [ "$_ch_stale" = "1" ]; then
            echo ""
            echo "   🔧 Channel plugin symlinks missing/stale — re-linking to current install..."
            mkdir -p "$CHANNELS_DIR"
            [ ! -f "$CHANNELS_DIR/package.json" ] && \
                echo '{"name":"vodou-channels-install","version":"1.0.0","private":true}' > "$CHANNELS_DIR/package.json"
            npm install --prefix "$CHANNELS_DIR" --silent \
                "file:$PACKAGES_DIR/telegram" "file:$PACKAGES_DIR/slack" "file:$PACKAGES_DIR/discord" \
                "file:$PACKAGES_DIR/whatsapp" "file:$PACKAGES_DIR/imessage" "file:$PACKAGES_DIR/teams" \
                "file:$PACKAGES_DIR/googlechat" "file:$PACKAGES_DIR/signal" "file:$PACKAGES_DIR/voice" \
                "file:$PACKAGES_DIR/web" > /dev/null 2>&1
            _ch_broken=0
            for _link in "$CHANNELS_DIR/node_modules/@vodou/"channel-*; do
                [ -e "$_link" ] || _ch_broken=$((_ch_broken + 1))
            done
            if [ "$_ch_broken" -gt 0 ]; then
                echo "   ⚠️  $_ch_broken channel symlink(s) still broken after re-link — channels may not load"
            else
                echo "   ✅ Channel plugins re-linked to current install ($PACKAGES_DIR)"
            fi
        fi
    fi

    # 5.5c. Channel copy-drift guard: the runtime loads packages/*/dist (via the
    # symlinks above), NOT src/channels/. If src/channels/ carries newer code,
    # a fix was written but never shipped — warn loudly (2026-07-11 QA sweep
    # found live adapters ~8 weeks behind incl. security fixes; see
    # PLANS/0.6.15/PLAN-QA-SWEEP-FINDINGS.md P0-1).
    if [ -x "$VODOU_DIR/MCP-servers/Vodou-channels/scripts/check-channel-sync.sh" ]; then
        "$VODOU_DIR/MCP-servers/Vodou-channels/scripts/check-channel-sync.sh" || true
    fi

    # 5.6. Auto-connect Vodou-channels (heals stale paths)
    echo ""
    if declare -F ensure_bundled_mcp_server >/dev/null 2>&1; then
        ensure_bundled_mcp_server Vodou-channels MCP-servers/Vodou-channels/dist/index.js
    elif [ ! -d "$VODOU_DIR/MCP-servers/Vodou-channels" ]; then
        echo "   ⚠️  Vodou-channels not found in release"
    fi

    # 5.6b. Channel credential sanity check. Without this, alpha users enable a
    # channel in .env, forget the token, and only discover the breakage when an
    # outgoing message silently fails.
    if [ -f "$VODOU_DIR/.env" ]; then
        _env_has_nonempty() {
            grep -qE "^${1}=[^[:space:]\"']+." "$VODOU_DIR/.env" 2>/dev/null
        }
        _env_enabled() {
            grep -qE "^${1}=(1|true|TRUE|yes|YES)\$" "$VODOU_DIR/.env" 2>/dev/null
        }
        _channel_warn=0
        if _env_enabled SLACK_ENABLED && ! _env_has_nonempty SLACK_BOT_TOKEN; then
            echo "   ⚠️  Slack enabled in .env but SLACK_BOT_TOKEN is empty — outgoing Slack messages will silently fail."
            _channel_warn=1
        fi
        if _env_enabled TELEGRAM_ENABLED && ! _env_has_nonempty TELEGRAM_BOT_TOKEN; then
            echo "   ⚠️  Telegram enabled in .env but TELEGRAM_BOT_TOKEN is empty — outgoing Telegram messages will silently fail."
            _channel_warn=1
        fi
        if _env_enabled DISCORD_ENABLED && ! _env_has_nonempty DISCORD_BOT_TOKEN; then
            echo "   ⚠️  Discord enabled in .env but DISCORD_BOT_TOKEN is empty — outgoing Discord messages will silently fail."
            _channel_warn=1
        fi
        [ "$_channel_warn" = "1" ] && echo "      Set the missing token(s) in .env and restart Vodou."
    fi

    # 5.7. Optional: start Vodou-Console (chat UI on :$WEB_PORT). Set START_AIGATEWAY=1 to enable.
    if [ "${START_AIGATEWAY:-0}" = "1" ] && command -v node &> /dev/null; then
        _GW_DIR="$VODOU_DIR/MCP-servers/Vodou-Console"
        if [ -d "$_GW_DIR" ] && [ -f "$_GW_DIR/tsconfig.json" ]; then
            _GW_NEED_BUILD=0
            [ ! -f "$_GW_DIR/dist/index.js" ] && _GW_NEED_BUILD=1
            [ -f "$_GW_DIR/src/index.ts" ] && [ -f "$_GW_DIR/dist/index.js" ] && [ "$_GW_DIR/src/index.ts" -nt "$_GW_DIR/dist/index.js" ] && _GW_NEED_BUILD=1
            [ ! -f "$_GW_DIR/dist/api/project-env.js" ] && _GW_NEED_BUILD=1
            if [ "$_GW_NEED_BUILD" = "1" ]; then
                echo "   🔨 Building Vodou-Console (dist missing or older than src)..."
                (cd "$_GW_DIR" && npm run build) || echo "   ⚠️  Vodou-Console build failed — fix errors then run: cd MCP-servers/Vodou-Console && npm run build"
            fi
        fi
        if [ -f "$_GW_DIR/dist/index.js" ]; then
            VODOU_SYSLOG="$VODOU_DIR/.vodou/system.log"
            mkdir -p "$VODOU_DIR/.vodou"
            # Kill any stale gateway process(es) on this port before starting fresh.
            # SIGTERM first, then SIGKILL after 2s if anything's still alive.
            # Without the SIGKILL escalation, half-dead zombie gateways survive
            # the SIGTERM and the new spawn fails to bind, leaving the user with
            # an unresponsive port that LOOKS healthy in the followup probe.
            local STALE_PIDS=$(listening_pids_on_port "$WEB_PORT")
            if [ -n "$STALE_PIDS" ]; then
                # GUARD: do NOT kill OUR OWN healthy gateway. vodou-hook can spawn
                # this script during an active chat; SIGTERMing the live gateway
                # mid-turn is the §F2 regression and must stay fixed.
                #
                # But "healthy" alone is the WRONG test, and testing only that is
                # its own bug: after an update — or a second install into a new
                # folder — a healthy gateway belonging to a DIFFERENT install can
                # own this port. Skipping for that one is exactly how an update
                # lands with the new engine binary and the old UI, while
                # /api/system cheerfully reports the new version (it reads the
                # binary, not the gateway). So skip only when the listener is
                # serving THIS install, proven by its cwd.
                if curl -fsS -m 8 "http://127.0.0.1:$WEB_PORT/health" 2>/dev/null | grep -q '"status"'; then
                    local _want _got _owner="" _match=unknown
                    _want=$(cd "$_GW_DIR" 2>/dev/null && pwd -P)
                    for pid in $STALE_PIDS; do
                        _got=$(pid_cwd "$pid")
                        [ -n "$_got" ] || continue
                        _owner="$_got"
                        if [ "$_got" = "$_want" ]; then _match=ours; break; else _match=foreign; fi
                    done
                    case "$_match" in
                        ours)
                            dbg "Port $WEB_PORT owner is this install's gateway ($_want) — leaving it alone"
                            echo "   ℹ️  Vodou-Console already running on port $WEB_PORT (skipping restart)"
                            return 0
                            ;;
                        foreign)
                            # Proven mismatch. Taking the port IS the restart the
                            # caller asked for — never silently serve stale code.
                            echo "   ⚠️  Port $WEB_PORT is held by a gateway from another install:"
                            echo "        running: $_owner"
                            echo "        this:    $_want"
                            echo "        Taking over the port so you get this install's UI."
                            ;;
                        *)
                            # Healthy, but we could not read any listener's cwd, so
                            # we cannot prove it is foreign. Ambiguity resolves in
                            # favour of whichever mistake is cheaper for the caller:
                            # an explicit install/update wants the port (a stale UI
                            # is the bug being fixed); a background hook does not
                            # (killing a live chat is §F2).
                            if [ "${VODOU_ALLOW_PORT_TAKEOVER:-0}" = "1" ]; then
                                echo "   ⚠️  Port $WEB_PORT owner could not be identified — taking it over (install/update)."
                            else
                                dbg "Port $WEB_PORT healthy, owner unidentifiable — leaving it alone (set VODOU_ALLOW_PORT_TAKEOVER=1 to force)"
                                echo "   ℹ️  Vodou-Console already running on port $WEB_PORT (skipping restart)"
                                return 0
                            fi
                            ;;
                    esac
                fi
                # FR-10 (ALPHA-READINESS §9 D) — never SIGKILL a process we
                # cannot show is ours.
                #
                # The aux-surface guard 500 lines up already states the rule —
                # "a stranger's dev server on the port is reported, never
                # killed" — and then this path, the one that actually runs on
                # every start, did the opposite. Anything listening on WEB_PORT
                # that failed a /health probe got SIGTERM and then SIGKILL,
                # health probe being the only test. Someone else's dev server on
                # 8765 does not answer /health with a Vodou status either. The
                # first thing a stranger would notice is their own work dying
                # when they installed Vodou.
                #
                # Ownership evidence, cheapest first: cwd inside a directory
                # that holds a vodou-core binary, or an argv naming this
                # install's gateway entry point. Unprovable ⇒ not ours.
                local OURS="" FOREIGN=""
                for pid in $STALE_PIDS; do
                    local _cwd _args _mine=0
                    _cwd=$(pid_cwd "$pid")
                    if [ -n "$_cwd" ]; then
                        # The gateway runs from MCP-servers/Vodou-Console, so
                        # check that directory and two levels up.
                        for _cand in "$_cwd" "$_cwd/../.." "$_cwd/.."; do
                            if [ -f "$_cand/vodou-core" ] || [ -f "$_cand/vodou-core.exe" ]; then _mine=1; break; fi
                        done
                    fi
                    if [ "$_mine" = "0" ]; then
                        _args=$(ps -o args= -p "$pid" 2>/dev/null || true)
                        case "$_args" in *Vodou-Console*|*vodou-core*) _mine=1 ;; esac
                    fi
                    if [ "$_mine" = "1" ]; then OURS="$OURS $pid"; else FOREIGN="$FOREIGN $pid"; fi
                done

                if [ -n "$FOREIGN" ]; then
                    echo "   ⚠️  Port $WEB_PORT is held by a process that is not Vodou (pid(s):$FOREIGN)"
                    for pid in $FOREIGN; do
                        echo "        $(ps -o pid=,comm= -p "$pid" 2>/dev/null | sed 's/^ *//')"
                    done
                    echo "        Not touching it. Give Vodou a different port instead:"
                    echo "          echo 'WEB_PORT=8766' >> \"$VODOU_DIR/.env\"  &&  bash start-vodou-services.sh"
                    return 1
                fi

                if [ -z "$OURS" ]; then
                    dbg "nothing on port $WEB_PORT could be attributed — leaving it alone"
                    return 1
                fi

                dbg "Killing gateway processes on port $WEB_PORT: $OURS"
                for pid in $OURS; do kill "$pid" 2>/dev/null; done
                sleep 2
                local SURVIVORS=$(listening_pids_on_port "$WEB_PORT")
                if [ -n "$SURVIVORS" ]; then
                    dbg "SIGKILL escalation for survivors: $SURVIVORS"
                    # Escalate only against the pids we already attributed.
                    for pid in $SURVIVORS; do
                        case " $OURS " in *" $pid "*) kill -9 "$pid" 2>/dev/null ;; esac
                    done
                    sleep 1
                fi
            fi
            # Apply any pending DB migrations BEFORE the gateway launches.
            #
            # Migrations do run on their own — but via `worker start`, which is
            # ~300 lines below this point (§5.10). The gateway reads the server
            # registry at startup, so on the first boot after an upgrade it would
            # load a PRE-migration registry and not see newly registered servers
            # (Vodou-Board, vodou-memory, brain's MCP row) until its next
            # 5-minute health tick reconnected them. Running the migration here
            # closes that window: one-shot, ~0.5s, and a no-op when the schema is
            # already current (Database::new's fast path skips the suite).
            if [ -x "$VODOU_DIR/vodou-core" ]; then
                MIGRATE_OUT="$("$VODOU_DIR/vodou-core" migrate 2>&1)" && \
                    dbg "migrate: $MIGRATE_OUT" || \
                    echo "   ⚠️  vodou-core migrate failed (continuing): $MIGRATE_OUT"
            fi

            # Prefer the bundled Node 24 (shipped in the prebuilt archive).
            # On a dev tree there's no .node/ — fall back to system Node if it's
            # >=22.13 (the version that introduced built-in `node:sqlite`).
            # Anything older lacks the DB driver and would crash on first query.
            GW_NODE="$VODOU_DIR/.node/node"
            if [ ! -x "$GW_NODE" ]; then
                SYS_NODE="$(command -v node 2>/dev/null || true)"
                if [ -z "$SYS_NODE" ]; then
                    echo "   ❌ FATAL: no bundled Node ($VODOU_DIR/.node/node) and no system 'node' on PATH — install Node 22.13+ or re-install Vodou archive"
                    return 1
                fi
                # Parse "v22.15.1" → "22 15"; require major>22 OR (major==22 AND minor>=13)
                SYS_NODE_VER="$("$SYS_NODE" --version 2>/dev/null | sed 's/^v//')"
                SYS_MAJOR="${SYS_NODE_VER%%.*}"
                SYS_REST="${SYS_NODE_VER#*.}"
                SYS_MINOR="${SYS_REST%%.*}"
                if [ -z "$SYS_MAJOR" ] || { [ "$SYS_MAJOR" -lt 22 ] 2>/dev/null; } || { [ "$SYS_MAJOR" = "22" ] && [ "$SYS_MINOR" -lt 13 ] 2>/dev/null; }; then
                    echo "   ❌ FATAL: system Node $SYS_NODE_VER lacks node:sqlite (need 22.13+ or 24+); install Node 24 or use the prebuilt archive"
                    return 1
                fi
                echo "   ℹ️  No bundled Node — using system Node $SYS_NODE_VER (dev tree)"
                GW_NODE="$SYS_NODE"
            fi
            # Dedicated gateway log: stdout+stderr → .vodou/gateway.log so the
            # [ground-truth] degrade lines (and any crash trace) are greppable in
            # one small file instead of buried in the 2MB+ shared system.log.
            # Single redirect, no tee subprocess — keeps the process tree clean.
            GW_LOG="$VODOU_DIR/.vodou/gateway.log"
            # BRAIN_PORT rides along so the gateway can tell the Bridge extension
            # where the brain mini console (started in 5.8 below) is listening.
            (cd "$_GW_DIR" && nohup env VODOU_PROJECT_PATH="$VODOU_DIR" BRAIN_PORT="${BRAIN_PORT:-8767}" "$GW_NODE" dist/index.js >>"$GW_LOG" 2>&1 &)
            # Health check — give the gateway up to 5s to bind to the port.
            # Without this, a startup crash silently leaves the service down
            # and the user only finds out later when WS errors appear in the
            # browser. Now we tell them up-front and point at the log file.
            HEALTH_OK=0
            for _ in 1 2 3 4 5; do
                sleep 1
                if curl -fsS -m 1 "http://127.0.0.1:$WEB_PORT/" >/dev/null 2>&1; then
                    HEALTH_OK=1
                    break
                fi
            done
            if [ "$HEALTH_OK" = "1" ]; then
                echo "   🌐 Vodou-Console started (chat UI http://localhost:$WEB_PORT); log: $VODOU_SYSLOG"
            else
                echo "   ❌ Vodou-Console FAILED to start within 5s on port $WEB_PORT"
                echo "      Common causes: another process on port $WEB_PORT; bundled Node missing; .vodou/ workspace not writable"
                # Surface the actual error so the user doesn't have to hunt for it.
                if [ -s "$_GW_DIR/logs/gateway-stderr.log" ]; then
                    echo "      ── last 20 lines of $_GW_DIR/logs/gateway-stderr.log ──"
                    tail -n 20 "$_GW_DIR/logs/gateway-stderr.log" 2>/dev/null | sed 's/^/        /'
                elif [ -s "$VODOU_SYSLOG" ]; then
                    echo "      ── last 20 lines of $VODOU_SYSLOG ──"
                    tail -n 20 "$VODOU_SYSLOG" 2>/dev/null | sed 's/^/        /'
                else
                    echo "      No log output yet — check: $VODOU_SYSLOG and $_GW_DIR/logs/gateway-stderr.log"
                fi
            fi
        elif [ "${START_AIGATEWAY:-0}" = "1" ]; then
            echo "   ⚠️  Vodou-Console not started: dist/index.js still missing after build (run 'cd MCP-servers/Vodou-Console && npm run build')"
        fi
    elif [ "${START_AIGATEWAY:-0}" = "1" ]; then
        echo "   ⚠️  Vodou-Console not started: node not found (install Node.js 18+)"
    fi

    # 5.8. Brain mini console — OPT-IN since PLAN-BRAIN-INTO-CONSOLE (0.6.29): the
    # graph lives in the gateway at #/memory?tab=map. The standalone :8767 twin
    # runs the same build copy and only starts with VODOU_BRAIN_STANDALONE=1.
    # (stop-vodou-services.sh still stops a stale one either way.)
    if [ "${VODOU_BRAIN_STANDALONE:-0}" != "1" ]; then
        echo "   🧠 Brain: embedded in the console (Memory → Map). Standalone :8767 is opt-in: VODOU_BRAIN_STANDALONE=1"
    else
        # 5.8. Brain mini console — read-only memory navigation UI (BRAIN_PORT, default 8767).
        # The brain MCP server itself is stdio (spawned per call); this is just its web view.
        _BRAIN_DIR="$VODOU_DIR/MCP-servers/brain"
        _BRAIN_PORT="${BRAIN_PORT:-8767}"
        _BRAIN_URL="http://127.0.0.1:$_BRAIN_PORT"
        _BRAIN_PROBE="$_BRAIN_URL/api/brain/overview"
        _BRAIN_LOG="$VODOU_DIR/.vodou/logs/brain-console.log"
        if [ ! -f "$_BRAIN_DIR/dist/serve.js" ]; then
            if [ -d "$_BRAIN_DIR" ]; then
                echo "   ⚠️  Brain console not started: $_BRAIN_DIR/dist/serve.js missing (cd MCP-servers/brain && npm run build)"
            else
                # Was a dbg (invisible without DEBUG=1). That was the wrong call: an
                # install MISSING MCP-servers/brain is the case that actually happens
                # in the field — brain fails the auto-update allowlist's `vodou-`
                # prefix test, so an install that never had it, or lost it, is never
                # sent it. A user then opens 127.0.0.1:8767 (which the ALPHA guide
                # tells them to) and gets connection-refused with nothing anywhere
                # explaining why. Reported 2026-08-15; the log showed only
                # "Cannot find module .../brain/dist/index.js" from an unrelated
                # caller. Say it here, where the person starting the service reads.
                echo "   ⚠️  Brain console not installed — $_BRAIN_DIR is missing, so http://127.0.0.1:$_BRAIN_PORT will refuse connections."
                # Two shapes: the archive's top dir was renamed to Vodou/ in
                # v0.5.52, so staging is .../v0.6.X/Vodou/MCP-servers (two levels)
                # on anything recent and .../v0.6.X/MCP-servers (one level) on
                # older extracts. find_or_download_staging accepts both; so does this.
                _BRAIN_STAGED=$(ls -d "$VODOU_DIR"/update_staging/*/Vodou/MCP-servers/brain \
                                      "$VODOU_DIR"/update_staging/*/MCP-servers/brain 2>/dev/null | tail -1)
                if [ -n "$_BRAIN_STAGED" ]; then
                    echo "        Restore it from the release you already downloaded:"
                    echo "          cp -R \"$_BRAIN_STAGED\" \"$_BRAIN_DIR\""
                else
                    echo "        Restore it with:  ./vodou-core update --components   (choose MCP-servers/brain)"
                fi
            fi
        elif [ -z "$(aux_node)" ]; then
            echo "   ⚠️  Brain console not started: needs Node 22.13+ for node:sqlite (found: $(node --version 2>/dev/null || echo 'no node on PATH'))"
        else
            _BRAIN_NODE="$(aux_node)"
            # dist/ (not just serve.js) dates the build: an update replaces
            # queries.js/db.js too, and any of them going stale matters.
            # NOTE: plain case + a pre-test, not `;;&` fallthrough — /bin/bash on
            # macOS is 3.2, where `;;&` is a syntax error.
            _BRAIN_STATE="$(probe_aux_port "$_BRAIN_PORT" "$_BRAIN_PROBE" '"chunks_live"' "$_BRAIN_DIR/dist")"
            [ "$_BRAIN_STATE" = "stale" ] && echo "   ♻️  Brain console was running pre-update code — restarting it"
            case "$_BRAIN_STATE" in
                running)
                    echo "   🧠 Brain console already running ($_BRAIN_URL)"
                    ;;
                blocked)
                    echo "   ⚠️  Brain console NOT started — port $_BRAIN_PORT is held by something that is neither the brain nor ours:"
                    lsof -nP -iTCP:"$_BRAIN_PORT" -sTCP:LISTEN 2>/dev/null | sed -n '2,3p' | sed 's/^/        /'
                    echo "        Free that port, or start with: BRAIN_PORT=<other> ./start-vodou-services.sh"
                    ;;
                *)  # free | reclaimed | stale
                    mkdir -p "$VODOU_DIR/.vodou/logs"
                    # BRAIN_PORT passed explicitly so the port we probe and the port
                    # serve.js binds can never drift apart.
                    (cd "$VODOU_DIR" && nohup env BRAIN_PORT="$_BRAIN_PORT" "$_BRAIN_NODE" "$_BRAIN_DIR/dist/serve.js" >> "$_BRAIN_LOG" 2>&1 &)
                    # Probe, don't assume. The old code printed "started" whether or
                    # not the process survived import, so a brain that died on a
                    # node:sqlite error looked exactly like a healthy one.
                    _BRAIN_OK=0
                    for _ in 1 2 3 4 5; do
                        sleep 1
                        if curl -fsS -m 1 "$_BRAIN_PROBE" 2>/dev/null | grep -q '"chunks_live"'; then _BRAIN_OK=1; break; fi
                    done
                    if [ "$_BRAIN_OK" = "1" ]; then
                        echo "   🧠 Brain console started (memory UI $_BRAIN_URL)"
                    else
                        echo "   ❌ Brain console FAILED to answer on port $_BRAIN_PORT within 5s"
                        if [ -s "$_BRAIN_LOG" ]; then
                            echo "      ── last 10 lines of $_BRAIN_LOG ──"
                            tail -n 10 "$_BRAIN_LOG" 2>/dev/null | sed 's/^/        /'
                        else
                            echo "      No output in $_BRAIN_LOG — check that memory.db exists and is readable"
                        fi
                    fi
                    ;;
            esac
        fi

    fi

    # 5.9. Vodou One — the five-tray desktop shell (VODOU_ONE_PORT, default 8768).
    # server.mjs serves the prebuilt dist/ and proxies the gateway (8765) + brain (8767);
    # node builtins only, so no npm install. Suppress with VODOU_ONE_DISABLE=1.
    _ONE_DIR="$VODOU_DIR/one/web"
    _ONE_PORT="${VODOU_ONE_PORT:-8768}"
    _ONE_URL="http://127.0.0.1:$_ONE_PORT"
    _ONE_LOG="$VODOU_DIR/.vodou/logs/vodou-one.log"
    if [ "${VODOU_ONE_DISABLE:-0}" != "1" ] && [ -f "$_ONE_DIR/server.mjs" ]; then
        if [ -z "$(aux_node)" ]; then
            echo "   ⚠️  Vodou One not started: needs Node 22.13+ (found: $(node --version 2>/dev/null || echo 'no node on PATH'))"
        else
            _ONE_NODE="$(aux_node)"
            # /health answers {"ok":true,"shell":"vodou-one",...}; the gateway's
            # /health answers "status" instead, so this tells the two apart.
            # server.mjs is the whole server (its dist/ is static, re-read per
            # request), so that one file dates the build.
            _ONE_STATE="$(probe_aux_port "$_ONE_PORT" "$_ONE_URL/health" 'vodou-one' "$_ONE_DIR/server.mjs")"
            [ "$_ONE_STATE" = "stale" ] && echo "   ♻️  Vodou One was running pre-update code — restarting it"
            case "$_ONE_STATE" in
                running)
                    echo "   🪟 Vodou One already running ($_ONE_URL)"
                    ;;
                blocked)
                    echo "   ⚠️  Vodou One NOT started — port $_ONE_PORT is held by something that is neither Vodou One nor ours:"
                    lsof -nP -iTCP:"$_ONE_PORT" -sTCP:LISTEN 2>/dev/null | sed -n '2,3p' | sed 's/^/        /'
                    echo "        Free that port, or start with: VODOU_ONE_PORT=<other> ./start-vodou-services.sh"
                    ;;
                *)  # free | reclaimed | stale
                    mkdir -p "$VODOU_DIR/.vodou/logs"
                    # If One is launchd-managed (one/services/install.sh, label
                    # com.vodou.one.web, KeepAlive=true), hand it back to launchd
                    # rather than starting a second ad-hoc copy: stop-vodou-
                    # services.sh boots that job out, so without this a stop/start
                    # cycle would silently downgrade an always-on install to a
                    # detached process that dies with its parent.
                    _ONE_PLIST="$HOME/Library/LaunchAgents/com.vodou.one.web.plist"
                    _ONE_VIA_LAUNCHD=0
                    if [ "$(uname -s)" = "Darwin" ] && [ -f "$_ONE_PLIST" ] && command -v launchctl >/dev/null 2>&1; then
                        if launchctl bootstrap "gui/$(id -u)" "$_ONE_PLIST" 2>/dev/null; then
                            _ONE_VIA_LAUNCHD=1
                            dbg "Vodou One handed back to launchd (com.vodou.one.web)"
                        fi
                    fi
                    # server.mjs proxies /api,/chat,/v1 → gateway and /brain-api
                    # → brain, reading WEB_PORT/BRAIN_PORT from its own env. Those
                    # are plain script vars here, not exported, so without this the
                    # proxy silently defaults to 8765/8767 on an install that moved
                    # either port — the same wrong-port failure this block guards.
                    if [ "$_ONE_VIA_LAUNCHD" != "1" ]; then
                        (cd "$VODOU_DIR" && nohup env VODOU_ONE_PORT="$_ONE_PORT" WEB_PORT="$WEB_PORT" BRAIN_PORT="$_BRAIN_PORT" "$_ONE_NODE" "$_ONE_DIR/server.mjs" >> "$_ONE_LOG" 2>&1 &)
                    fi
                    _ONE_OK=0
                    for _ in 1 2 3 4 5; do
                        sleep 1
                        if curl -fsS -m 1 "$_ONE_URL/health" 2>/dev/null | grep -q 'vodou-one'; then _ONE_OK=1; break; fi
                    done
                    if [ "$_ONE_OK" = "1" ]; then
                        echo "   🪟 Vodou One started (five-tray shell $_ONE_URL)"
                    else
                        echo "   ❌ Vodou One FAILED to answer on port $_ONE_PORT within 5s"
                        if [ -s "$_ONE_LOG" ]; then
                            echo "      ── last 10 lines of $_ONE_LOG ──"
                            tail -n 10 "$_ONE_LOG" 2>/dev/null | sed 's/^/        /'
                        fi
                    fi
                    ;;
            esac
        fi
    fi

    # 6–9. Auto-connect bundled Node MCP servers (heals stale /tmp or absolute dev paths)
    echo ""
    if declare -F ensure_bundled_mcp_server >/dev/null 2>&1; then
        ensure_bundled_mcp_server brain MCP-servers/brain/dist/index.js
        echo ""
        ensure_bundled_mcp_server Vodou-Enhanced-Thinking MCP-servers/Vodou-Enhanced-Thinking/dist/index.js
        echo ""
        ensure_bundled_mcp_server Vodou-session-manager MCP-servers/Vodou-session-manager/dist/index.js
        echo ""
        ensure_bundled_mcp_server Vodou-script-executor MCP-servers/Vodou-script-executor/dist/index.js
        echo ""
        ensure_bundled_mcp_server uml-mcp MCP-servers/uml-mcp/dist/index.js
    else
        [ ! -d "$VODOU_DIR/MCP-servers/Vodou-Enhanced-Thinking" ] && echo "   ⚠️  Vodou-Enhanced-Thinking not found in release"
        [ ! -d "$VODOU_DIR/MCP-servers/Vodou-session-manager" ] && echo "   ⚠️  Vodou-session-manager not found in release"
        [ ! -d "$VODOU_DIR/MCP-servers/Vodou-script-executor" ] && echo "   ⚠️  Vodou-script-executor not found in release"
        [ ! -d "$VODOU_DIR/MCP-servers/uml-mcp" ] && echo "   ⚠️  uml-mcp not found in release"
    fi

    # 10. Auto-connect mcp-monitor (prebuilt binary)
    echo ""
    dbg "=== mcp-monitor ==="
    echo "📊 Checking mcp-monitor connection..."
    if [ -f "$VODOU_DIR/MCP-servers/mcp-monitor/bin/mcp-monitor" ]; then
        if [ -f "$VODOU_DIR/vodou-core.db" ]; then
            MCP_MON_CONNECTED=$(sqlite3 "$VODOU_DIR/vodou-core.db" "SELECT COUNT(*) FROM mcp_servers WHERE name='mcp-monitor';" 2>/dev/null || echo "0")
            if [ "$MCP_MON_CONNECTED" = "0" ]; then
                echo "   🔌 Connecting mcp-monitor to Vodou..."
                cd "$VODOU_DIR"
                run_vc connect mcp-monitor "$VODOU_DIR/MCP-servers/mcp-monitor/bin/mcp-monitor" > /dev/null 2>&1
                [ $? -eq 0 ] && echo "   ✅ mcp-monitor connected" || echo "   ⚠️  Connect manually: ./vodou-core connect mcp-monitor MCP-servers/mcp-monitor/bin/mcp-monitor"
            else
                echo "   ✅ mcp-monitor already connected"
            fi
        fi
    else
        echo "   ⚠️  mcp-monitor binary not found"
    fi

    # 11. Auto-connect slack (npx package — optional, requires SLACK_BOT_TOKEN)
    echo ""
    dbg "=== slack ==="
    echo "💬 Checking slack connection..."
    if [ -f "$VODOU_DIR/vodou-core.db" ]; then
        SLACK_CONNECTED=$(sqlite3 "$VODOU_DIR/vodou-core.db" "SELECT COUNT(*) FROM mcp_servers WHERE name='slack';" 2>/dev/null || echo "0")
        if [ "$SLACK_CONNECTED" = "0" ]; then
            echo "   🔌 Connecting slack MCP to Vodou..."
            cd "$VODOU_DIR"
            run_vc connect slack npx -- -y @jtalk22/slack-mcp > /dev/null 2>&1
            [ $? -eq 0 ] && echo "   ✅ slack connected (set SLACK_BOT_TOKEN in .env to use)" || echo "   ⚠️  Connect manually: ./vodou-core connect slack npx -- -y @jtalk22/slack-mcp"
        else
            echo "   ✅ slack already connected"
        fi
    fi

    # 12. Auto-connect dalle (image generation — optional, requires OPENAI_API_KEY)
    echo ""
    dbg "=== dalle ==="
    echo "🎨 Checking dalle connection..."
    if [ -d "$VODOU_DIR/MCP-servers/dalle" ]; then
        if [ -f "$VODOU_DIR/vodou-core.db" ]; then
            DALLE_CONNECTED=$(sqlite3 "$VODOU_DIR/vodou-core.db" "SELECT COUNT(*) FROM mcp_servers WHERE name='dalle';" 2>/dev/null || echo "0")
            if [ "$DALLE_CONNECTED" = "0" ]; then
                if [ -f "$VODOU_DIR/MCP-servers/dalle/dist/index.js" ] && command -v node &> /dev/null; then
                    echo "   🔌 Connecting dalle to Vodou..."
                    cd "$VODOU_DIR"
                    run_vc connect dalle node "$VODOU_DIR/MCP-servers/dalle/dist/index.js" > /dev/null 2>&1
                    [ $? -eq 0 ] && echo "   ✅ dalle connected (set OPENAI_API_KEY in .env to use)" || echo "   ⚠️  Connect manually: ./vodou-core connect dalle node MCP-servers/dalle/dist/index.js"
                else
                    echo "   ⚠️  dalle not built — run: cd MCP-servers/dalle && npm install && npm run build"
                fi
            else
                echo "   ✅ dalle already connected"
            fi
        fi
    fi

    # 13. Auto-connect vodou-mac-control (if binary exists and not already connected)
    if [ -f "$VODOU_DIR/MCP-servers/vodou-mac-control/dist/index.js" ] && command -v node &> /dev/null; then
        VMC_CONNECTED=$(sqlite3 "$VODOU_DIR/vodou-core.db" "SELECT COUNT(*) FROM mcp_servers WHERE name='vodou-mac-control';" 2>/dev/null || echo "0")
        if [ "$VMC_CONNECTED" = "0" ]; then
            echo "   🔌 Connecting vodou-mac-control to Vodou..."
            run_vc connect vodou-mac-control node "$VODOU_DIR/MCP-servers/vodou-mac-control/dist/index.js" > /dev/null 2>&1
            if [ $? -eq 0 ]; then
                echo "   ✅ vodou-mac-control connected"
            fi
        fi
    fi

    # DB rename migration: brain-trust4.db → vodou-core.db (one-time, on first run after rename)
    if [ -f "$VODOU_DIR/brain-trust4.db" ] && [ ! -f "$VODOU_DIR/vodou-core.db" ]; then
        mv "$VODOU_DIR/brain-trust4.db" "$VODOU_DIR/vodou-core.db"
        for ext in -wal -shm; do
            [ -f "$VODOU_DIR/brain-trust4.db${ext}" ] && mv "$VODOU_DIR/brain-trust4.db${ext}" "$VODOU_DIR/vodou-core.db${ext}"
        done
        echo "   ✅ Migrated brain-trust4.db → vodou-core.db"
    fi

    # 14. chrome-devtools — pre-configured in clean DB as local node install (no npx needed)
    # Ensure daemon_stdio lifecycle (persistent browser session through worker)
    sqlite3 "$VODOU_DIR/vodou-core.db" "UPDATE mcp_servers SET lifecycle_type='daemon_stdio' WHERE name='chrome-devtools' AND COALESCE(lifecycle_type,'') != 'daemon_stdio';" 2>/dev/null

    # Daemon + Worker: ensure both running (daemon ensure auto-starts worker too)
    dbg "=== Daemon + Worker ==="
    if [ -x "$VODOU_DIR/vodou-core" ]; then
        # Fast-path guard (ops #4): if both services are ALREADY alive and the
        # daemon answers on its socket, do NOT run `daemon ensure` at all. ensure
        # is idempotent, but on a slow/timed-out probe it can fall through to a
        # direct `daemon start` (below) that competes with the live daemon for the
        # same flock/socket — a ~1–2s socket gap during which the gateway's
        # ground-truth probe reads a dead socket → false "daemon down". When
        # everything's up there is nothing to do; leave the running processes
        # untouched. Re-running this whole script mid-session used to churn the
        # daemon/worker every invocation; this makes it a true no-op when healthy.
        _dsock="$VODOU_DIR/.vodou/daemon.sock"
        _wsock="$VODOU_DIR/.vodou/worker.sock"
        if [ -S "$_dsock" ] && [ -S "$_wsock" ] \
           && "$VODOU_DIR/vodou-core" sock status 2>/dev/null | grep -q '"pid"'; then
            dbg "daemon + worker already alive (sockets up, daemon answered) — skipping ensure (no-op)"
            echo "   ✅ Vodou daemon: Running (already up — left untouched)"
            echo "   ✅ Vodou worker: Running (already up — left untouched)"
        else
        dbg "Ensuring Vodou daemon + worker are running"
        # Model warmup (embeddings/reranker) can take 60–120s on cold boot; 15s caused
        # timeout → duplicate daemon start competing for the same flock/socket.
        DAEMON_ENSURE_TIMEOUT="${DAEMON_ENSURE_TIMEOUT:-180}"
        if run_with_timeout "$DAEMON_ENSURE_TIMEOUT" "$VODOU_DIR/vodou-core" daemon ensure 2>/dev/null; then
            echo "   ✅ Vodou daemon: Running"
        else
            _daemon_sock="$VODOU_DIR/.vodou/daemon.sock"
            _sock_out="$("$VODOU_DIR/vodou-core" sock status 2>/dev/null || true)"
            if [ -S "$_daemon_sock" ] && echo "$_sock_out" | grep -q '"pid"'; then
                dbg "daemon ensure timed out but sock status shows a live daemon — treating as running"
                echo "   ✅ Vodou daemon: Running"
            else
                dbg "Daemon ensure failed or timed out, trying direct start"
                nohup "$VODOU_DIR/vodou-core" daemon start > /dev/null 2>>"${VODOU_SYSLOG:-/tmp/vodou-system.log}" &
                sleep 1
            fi
        fi
        # Verify worker came up (daemon ensure starts it, but double-check)
        if [ -S "$VODOU_DIR/.vodou/worker.sock" ]; then
            echo "   ✅ Vodou worker: Running"
        else
            dbg "Worker socket not found, starting explicitly"
            nohup "$VODOU_DIR/vodou-core" worker start > /dev/null 2>>"${VODOU_SYSLOG:-/tmp/vodou-system.log}" &
            sleep 2
            [ -S "$VODOU_DIR/.vodou/worker.sock" ] && echo "   ✅ Vodou worker: Running" || echo "   ⚠️  Vodou worker: Failed to start"

        # Footprint / CPU watcher (processes.toml: footprint-watch). Catches a
        # daemon memory or CPU spike IN THE ACT — footprint, stacks, a banner —
        # instead of reconstructing it after a reboot (2026-08-29). Must run from
        # here, not launchd: TCC blocks launchd agents from reading this repo.
        # Opt out with VODOU_FOOTPRINT_WATCH=0.
        if [ "${VODOU_FOOTPRINT_WATCH:-1}" != "0" ]; then
            if [ -f "$VODOU_DIR/.vodou/footprint-watch.pid" ] && kill -0 "$(cat "$VODOU_DIR/.vodou/footprint-watch.pid" 2>/dev/null)" 2>/dev/null; then
                echo "   ✅ Footprint watch: Running"
            else
                (cd "$VODOU_DIR" && nohup bash scripts/footprint-watch.sh > /dev/null 2>&1 &)
                sleep 1
                [ -f "$VODOU_DIR/.vodou/footprint-watch.pid" ] && echo "   ✅ Footprint watch: Running (banner on trip)" || echo "   ⚠️  Footprint watch: Failed to start"
            fi
        fi
        fi
        fi  # end health-guard else (ops #4)
    fi

    # Wait a moment for services to initialize
    echo ""
    echo "⏳ Waiting for services to initialize..."
    sleep 3

    # 4. Verify services are running
    echo "🔍 Verifying services..."

    # Probe /health, not just port presence. A half-dead zombie gateway can
    # accept TCP connects but return nothing on HTTP, leaving us reporting
    # "Running" while the user sees errors everywhere. /health is cheap and
    # always-on; if it doesn't return JSON with "status", the service is
    # effectively dead even if the port is bound.
    if [ -n "$(listening_pids_on_port "$WEB_PORT")" ]; then
        if curl -fsS -m 3 "http://127.0.0.1:$WEB_PORT/health" 2>/dev/null | grep -q '"status"'; then
            echo "✅ Vodou-Console: Running (http://localhost:$WEB_PORT)"
        else
            echo "⚠️  Vodou-Console: Port $WEB_PORT bound but /health not responding — likely a zombie. Run: lsof -nP -iTCP:$WEB_PORT -sTCP:LISTEN -t | xargs kill -9; bash start-vodou-services.sh"
        fi
    elif [ "${START_AIGATEWAY:-0}" = "1" ]; then
        echo "❌ Vodou-Console: Failed to start (check .vodou/system.log)"
    else
        echo "ℹ️  Vodou-Console: Not started (set START_AIGATEWAY=1 to enable)"
    fi

    echo ""
    echo "🎯 Vodou Services startup complete!"
    echo ""
    echo "💡 Quick Start Commands:"
    echo "   ./oi \"hello\"              # Get started with Vodou help center"
    echo "   ./oi \"cpu memory disk\"    # Test parallel execution"

    # Auto-open gateway in browser
    if [ "${START_AIGATEWAY:-0}" = "1" ]; then
        # Wait for gateway to be ready (up to 10 seconds)
        # LISTEN-filtered: an already-open browser tab holding a socket to the
        # OLD gateway would otherwise satisfy this loop instantly and we would
        # "open the browser" against a port nothing is serving yet.
        for _i in $(seq 1 10); do
            [ -n "$(listening_pids_on_port "$WEB_PORT")" ] && break
            sleep 1
        done

        if [ -n "$(listening_pids_on_port "$WEB_PORT")" ]; then
            # Only auto-open on first run, or when explicitly forced.
            # Re-opening on every shell/session restart spawned runaway tabs.
            local FIRST_RUN=0
            if [ ! -f "$VODOU_DIR/.vodou/workspace/.gateway_opened" ]; then
                FIRST_RUN=1
            fi

            if [ "${VODOU_NO_OPEN_BROWSER:-0}" != "1" ] && { [ "$FIRST_RUN" = "1" ] || [ "${VODOU_OPEN_BROWSER:-0}" = "1" ]; }; then
                local URL="http://localhost:$WEB_PORT"
                if [ "$FIRST_RUN" = "1" ]; then
                    URL="http://localhost:$WEB_PORT/#/onboarding"
                fi

                echo ""
                echo "🌐 Opening gateway: $URL"
                if [[ "$(uname)" == "Darwin" ]]; then
                    open "$URL" 2>/dev/null || \
                    osascript -e "open location \"$URL\"" 2>/dev/null || true
                elif command -v xdg-open &>/dev/null; then
                    xdg-open "$URL" 2>/dev/null
                fi
                mkdir -p "$VODOU_DIR/.vodou/workspace" 2>/dev/null
                touch "$VODOU_DIR/.vodou/workspace/.gateway_opened" 2>/dev/null
            else
                echo "ℹ️  Gateway ready: http://localhost:$WEB_PORT (set VODOU_OPEN_BROWSER=1 to auto-open)"
            fi

            # LLM check — fire on every startup until configured. Without this,
            # alpha users with no Anthropic key never learn why chat doesn't work.
            if ! command -v claude &>/dev/null \
                && ! grep -qE "^(ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY|LLM_PROVIDER)=" "$VODOU_DIR/.env" 2>/dev/null \
                && ! grep -qE "^(LLM_PROVIDER|ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY)=" "$VODOU_DIR/MCP-servers/Vodou-Console/.env" 2>/dev/null; then
                echo ""
                echo "   ⚠️  No LLM configured — chat will not work until you add one."
                echo "      Open http://localhost:$WEB_PORT/#/settings and pick a provider (Anthropic, OpenAI, Gemini, or local)."
            fi
        fi
    fi

    # #2 deploy-reliability — the exit code must reflect ACTUAL gateway health.
    # Earlier best-effort steps (run_vc watchdogs, optional channel/server connects)
    # can leave a benign non-zero $? even when the whole stack is up, which surfaced
    # as spurious "start failed (exit 1)" reports while the gateway was in fact
    # healthy. Probe the port (bash builtin, no curl/nc dep) and return accordingly.
    if [ "${START_AIGATEWAY:-0}" = "1" ]; then
        local _hp
        _hp="$(grep -E '^WEB_PORT=' "$VODOU_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2 | tr -dc '0-9')"
        _hp="${_hp:-8765}"
        if (exec 3<>"/dev/tcp/127.0.0.1/${_hp}") 2>/dev/null; then
            exec 3>&- 2>/dev/null || true
            return 0
        fi
        return 1
    fi
    return 0
}

# Main logic
main() {
    # If auto-start is not configured, set it up first
    if ! is_auto_start_configured; then
        setup_auto_start
        echo ""
        echo "🔄 Now starting services..."
        start_services
    else
        # Auto-start is configured, just start services
        start_services
    fi
}

# Run main function
main "$@"
