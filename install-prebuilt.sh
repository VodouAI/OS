#!/bin/bash

# Vodou Pre-Built Installation Script
# Everything ships ready — NO npm install needed. Install in < 30 seconds.
#
# Each extracted archive is a fully self-contained Vodou instance with its own
# .env, databases, memory, and workspace. You can run multiple instances on
# the same machine — just extract to different folders and give each its own port.
#
# Usage:
#   ./install-prebuilt.sh          # Normal install
#   DEBUG=1 ./install-prebuilt.sh  # Verbose debug output
#
# Multiple instances:
#   Extract to ~/vodou-project-a/ and ~/vodou-project-b/
#   Set WEB_PORT=8765 in project-a/.env and WEB_PORT=8766 in project-b/.env
#   Each instance has completely isolated memory, skills, and databases.

set -e

# Resolve to the directory containing this script (not CWD)
INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$INSTALL_DIR"

# ── Flags ──  --headless (or VODOU_HEADLESS=1): server install — no browser
# auto-open, and (Linux/systemd) enable linger so the gateway runs without login.
VODOU_HEADLESS="${VODOU_HEADLESS:-0}"
for _arg in "$@"; do
    case "$_arg" in
        --headless) VODOU_HEADLESS=1 ;;
    esac
done

# ── Install transcript capture ─────────────────────────────────
# Tee stdout+stderr to .vodou/install.log so failed installs are debuggable
# without scrollback gymnastics. Caller can disable via VODOU_INSTALL_NO_LOG=1.
INSTALL_LOG_DIR="$INSTALL_DIR/.vodou"
INSTALL_LOG="$INSTALL_LOG_DIR/install.log"
if [ -z "$VODOU_INSTALL_NO_LOG" ] && [ -z "$VODOU_INSTALL_LOG_ACTIVE" ]; then
    mkdir -p "$INSTALL_LOG_DIR" 2>/dev/null || true
    if : >> "$INSTALL_LOG" 2>/dev/null; then
        {
            echo ""
            echo "========================================"
            echo "  install-prebuilt.sh — $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
            echo "  shell=$SHELL  uname=$(uname -srm)  arch=$(uname -m)"
            echo "  install_dir=$INSTALL_DIR"
            echo "========================================"
        } >> "$INSTALL_LOG"
        export VODOU_INSTALL_LOG_ACTIVE=1
        # Mirror all subsequent output to the log file as well as the terminal.
        exec > >(tee -a "$INSTALL_LOG") 2>&1
        echo "[install] full transcript: $INSTALL_LOG"
    fi
fi

# ── Debug mode ────────────────────────────────────────────────
DEBUG="${DEBUG:-0}"
dbg() { [ "$DEBUG" = "1" ] && echo "  [DEBUG] $*" || true; }
step_start() {
    STEP_START_TIME=$(date +%s)
    dbg "STEP START: $1"
}
step_done() {
    if [ "$DEBUG" = "1" ]; then
        local elapsed=$(( $(date +%s) - STEP_START_TIME ))
        echo "  [DEBUG] STEP DONE: $1 (${elapsed}s)"
    fi
}

echo "⚡ Vodou Pre-Built Installation"
echo "================================"
echo "📁 Installing to: $INSTALL_DIR"
echo "💡 This is the fast installer — all dependencies are pre-built."
[ "$DEBUG" = "1" ] && echo "🔧 Debug mode enabled — verbose output on"
echo ""

# ── Pre-flight checks ──────────────────────────────────────────

# Verify vodou-core binary
if [ ! -f "vodou-core" ]; then
    echo "❌ vodou-core binary not found. Make sure you extracted the release archive."
    exit 1
fi

# Architecture check
SYSTEM_ARCH=$(uname -m)
if [[ "$OSTYPE" == "darwin"* ]]; then
    BINARY_ARCH=$(file vodou-core 2>/dev/null | grep -o "arm64\|x86_64" | head -1)
    if [ -n "$BINARY_ARCH" ]; then
        if [[ "$SYSTEM_ARCH" == "arm64" && "$BINARY_ARCH" == "x86_64" ]]; then
            echo "❌ Architecture mismatch: Intel build on Apple Silicon. Download the arm64 release."
            exit 1
        elif [[ "$SYSTEM_ARCH" == "x86_64" && "$BINARY_ARCH" == "arm64" ]]; then
            echo "❌ Architecture mismatch: ARM build on Intel. Download the intel release."
            exit 1
        fi
    fi
fi

# Disk space check
AVAILABLE_MB=$(df -m . 2>/dev/null | tail -1 | awk '{print $4}')
if [ -n "$AVAILABLE_MB" ] && [ "$AVAILABLE_MB" -lt 300 ] 2>/dev/null; then
    echo "❌ Low disk space: ${AVAILABLE_MB}MB available, need at least 300MB"
    exit 1
fi

# ── Bundled Node.js verification ────────────────────────────────
#
# Vodou ships its own Node 24 LTS at .node/node and uses it MANDATORY for all
# MCP server execution. We do NOT fall back to system Node — `node:sqlite` is
# a built-in Node feature, so the runtime IS the database. Letting the user's
# system Node (which could be 18, 20, 22.5, etc.) host our processes would
# silently break sqlite access.
#
# This is also strictly safer for the user: we never touch their PATH, never
# write to their shell profile, never symlink into /usr/local/bin. Their other
# Node projects continue using whatever Node they have. Our processes just
# always invoke .node/node directly.

step_start "Bundled Node verification"
echo "🔍 Verifying bundled Node.js runtime..."

# ── Provision bundled Node if missing (SOURCE install) ─────────
# Prebuilt bundles ship .node/node ready. The open-core OS tree ships SOURCE
# ONLY — the Node binary is stripped from the open tree, so fetch it here: the
# SAME pinned version the packager stages, downloaded from nodejs.org and
# verified against the official SHASUMS256.txt (refuse on mismatch). Idempotent.
NODE_PIN="v24.15.0"
if [ ! -x "$INSTALL_DIR/.node/node" ]; then
    case "$(uname -s)" in
        Darwin) NODE_OS=darwin ;;
        Linux)  NODE_OS=linux ;;
        *) echo "   ❌ FATAL: cannot provision Node on $(uname -s) — use a prebuilt bundle."; exit 1 ;;
    esac
    case "$(uname -m)" in
        arm64|aarch64) NODE_ARCH=arm64 ;;
        x86_64)        NODE_ARCH=x64 ;;
        *) echo "   ❌ FATAL: unsupported architecture $(uname -m)"; exit 1 ;;
    esac
    echo "   📥 Bundled Node missing (source install) — fetching Node.js ${NODE_PIN} (${NODE_ARCH})..."
    NODE_TARBALL="node-${NODE_PIN}-${NODE_OS}-${NODE_ARCH}.tar.gz"
    NODE_URL="https://nodejs.org/dist/${NODE_PIN}/${NODE_TARBALL}"
    SHASUMS_URL="https://nodejs.org/dist/${NODE_PIN}/SHASUMS256.txt"
    TMP_NODE=$(mktemp -d)
    if ! curl -fsSL "$NODE_URL" -o "$TMP_NODE/node.tar.gz"; then
        echo "   ❌ FATAL: could not download Node.js from $NODE_URL"; rm -rf "$TMP_NODE"; exit 1
    fi
    EXPECTED_SHA=$(curl -fsSL "$SHASUMS_URL" 2>/dev/null | grep " ${NODE_TARBALL}\$" | awk '{print $1}')
    GOT_SHA=$(shasum -a 256 "$TMP_NODE/node.tar.gz" | awk '{print $1}')
    if [ -z "$EXPECTED_SHA" ] || [ "$GOT_SHA" != "$EXPECTED_SHA" ]; then
        echo "   ❌ FATAL: Node.js checksum mismatch — refusing to install."
        echo "      expected: ${EXPECTED_SHA:-<none from SHASUMS256.txt>}"
        echo "      got:      $GOT_SHA"
        rm -rf "$TMP_NODE"; exit 1
    fi
    tar -xzf "$TMP_NODE/node.tar.gz" -C "$TMP_NODE"
    NODE_SRC="$TMP_NODE/node-${NODE_PIN}-${NODE_OS}-${NODE_ARCH}"
    mkdir -p "$INSTALL_DIR/.node"
    cp "$NODE_SRC/bin/node" "$INSTALL_DIR/.node/node"
    cp -R "$NODE_SRC/lib" "$INSTALL_DIR/.node/lib"
    ln -sf "lib/node_modules/npm/bin/npm-cli.js" "$INSTALL_DIR/.node/npm"
    ln -sf "lib/node_modules/npm/bin/npx-cli.js" "$INSTALL_DIR/.node/npx"
    chmod +x "$INSTALL_DIR/.node/node" 2>/dev/null || true
    rm -rf "$TMP_NODE"
    echo "   ✅ Node.js ${NODE_PIN} provisioned + sha256-verified"
fi

if [ ! -x "$INSTALL_DIR/.node/node" ]; then
    echo ""
    echo "   ❌ FATAL: bundled Node.js missing at .node/node"
    echo "      The release archive is incomplete or corrupted. Re-download from:"
    echo "      https://github.com/VodouAI/OS/releases"
    echo ""
    exit 1
fi

# Use the bundled Node/npm for the rest of this install (source installs may
# have no system npm; prebuilt installs already ran under it). Process-local
# PATH only — the user's shell profile is never touched.
export PATH="$INSTALL_DIR/.node:$PATH"

BUNDLED_VERSION=$("$INSTALL_DIR/.node/node" --version 2>/dev/null)
BUNDLED_MAJOR=$(echo "$BUNDLED_VERSION" | sed 's/v//' | cut -d. -f1)
EXPECTED_MAJOR=24

if [ "$BUNDLED_MAJOR" != "$EXPECTED_MAJOR" ] 2>/dev/null; then
    echo ""
    echo "   ❌ FATAL: bundled Node.js is $BUNDLED_VERSION; expected v${EXPECTED_MAJOR}.x"
    echo "      Archive is mismatched with this installer. Re-download from:"
    echo "      https://github.com/VodouAI/OS/releases"
    echo ""
    exit 1
fi

# Verify node:sqlite is available (the entire DB stack depends on this).
if ! "$INSTALL_DIR/.node/node" -e "const {DatabaseSync}=require('node:sqlite'); new DatabaseSync(':memory:').close()" 2>/dev/null; then
    echo ""
    echo "   ❌ FATAL: bundled Node $BUNDLED_VERSION cannot load node:sqlite"
    echo "      Archive is corrupted. Re-download from:"
    echo "      https://github.com/VodouAI/OS/releases"
    echo ""
    exit 1
fi

echo "   ✅ Bundled Node $BUNDLED_VERSION verified (node:sqlite available)"
step_done "Bundled Node verification"

# ── Configuration ──────────────────────────────────────────────

step_start "Configuration"
echo ""
echo "⚙️  Setting up configuration..."

# Create .env from example.
# IS_UPGRADE is captured HERE, before we create anything: a pre-existing .env is
# the only reliable "this folder was already a working install" signal. It can't
# be inferred later from the file's contents, because .env.example itself ships
# keys like WEB_PORT — after the cp below, a fresh install looks identical to an
# upgrade. The port policy further down depends on this distinction.
IS_UPGRADE=0
[ -f ".env" ] && IS_UPGRADE=1
if [ -f ".env.example" ] && [ ! -f ".env" ]; then
    cp .env.example .env
    echo "   ✅ Created .env from .env.example"
fi

# Set VODOU_PROJECT_PATH
if [ -f ".env" ]; then
    if grep -q "^VODOU_PROJECT_PATH=" .env; then
        sed -i.bak "s|^VODOU_PROJECT_PATH=.*|VODOU_PROJECT_PATH=\"$INSTALL_DIR\"|" .env 2>/dev/null || \
        sed -i '' "s|^VODOU_PROJECT_PATH=.*|VODOU_PROJECT_PATH=\"$INSTALL_DIR\"|" .env 2>/dev/null || true
        rm -f .env.bak 2>/dev/null || true
    else
        echo "" >> .env
        echo "VODOU_PROJECT_PATH=\"$INSTALL_DIR\"" >> .env
    fi
    echo "   ✅ VODOU_PROJECT_PATH set"

    # Pin ORT_DYLIB_PATH to an ABSOLUTE path so semantic (vector) memory loads
    # regardless of the daemon/worker launch cwd. Only set it when the bundled
    # ONNX Runtime dylib is actually present; otherwise leave memory on FTS-only
    # rather than point at a missing file.
    ORT_LIB="$INSTALL_DIR/onnxruntime/lib/libonnxruntime.dylib"
    if [ -e "$ORT_LIB" ]; then
        if grep -q "^ORT_DYLIB_PATH=" .env 2>/dev/null; then
            sed -i.bak "s|^ORT_DYLIB_PATH=.*|ORT_DYLIB_PATH=\"$ORT_LIB\"|" .env 2>/dev/null || \
            sed -i '' "s|^ORT_DYLIB_PATH=.*|ORT_DYLIB_PATH=\"$ORT_LIB\"|" .env 2>/dev/null || true
            rm -f .env.bak 2>/dev/null || true
        else
            echo "ORT_DYLIB_PATH=\"$ORT_LIB\"" >> .env
        fi
        echo "   ✅ ORT_DYLIB_PATH set (semantic memory enabled)"
    else
        echo "   ℹ️  ONNX Runtime dylib not found — memory will use FTS-only"
    fi

    # Pin CLAUDE_BIN to the claude CLI the INSTALLING USER can actually see.
    # The services run from a launchd/systemd unit whose PATH is a fixed list
    # written further down (~/.local/bin, /usr/local/bin, /opt/homebrew/bin, …).
    # A claude installed anywhere else — nvm's global bin, a custom npm prefix —
    # is invisible to them, and board dispatch silently downgrades to the gateway
    # backend while chat claude-cli calls just ENOENT. Probing the installer's own
    # PATH is correct wherever claude lives, and unlike the hardcoded list it
    # can't go stale. Same pin pattern as ORT_DYLIB_PATH above; runs on upgrades
    # too, so installs that predate this never-had-it get fixed on next update.
    CLAUDE_CLI_PATH="$(command -v claude 2>/dev/null || true)"
    if [ -n "$CLAUDE_CLI_PATH" ]; then
        if grep -q "^CLAUDE_BIN=" .env 2>/dev/null; then
            sed -i.bak "s|^CLAUDE_BIN=.*|CLAUDE_BIN=\"$CLAUDE_CLI_PATH\"|" .env 2>/dev/null || \
            sed -i '' "s|^CLAUDE_BIN=.*|CLAUDE_BIN=\"$CLAUDE_CLI_PATH\"|" .env 2>/dev/null || true
            rm -f .env.bak 2>/dev/null || true
        else
            echo "CLAUDE_BIN=\"$CLAUDE_CLI_PATH\"" >> .env
        fi
        echo "   ✅ CLAUDE_BIN pinned to $CLAUDE_CLI_PATH"
    else
        echo "   ℹ️  claude CLI not found on PATH — board dispatch will use the"
        echo "      gateway backend. Install it, then re-run this installer or set"
        echo "      CLAUDE_BIN=/path/to/claude in .env and restart services."
    fi

    # ── Port policy ─────────────────────────────────────────────────────────
    # An UPGRADE keeps the port it already had. Anything else strands the user:
    # this block used to rescan on every run, and since the old gateway is still
    # listening while the installer works (nothing stops it beforehand, and
    # launchd keeps it alive), 8765 always looked "in use" — so every upgrade
    # silently moved itself to 8766 and announced it in one line of scrollback.
    # The user then opens their usual localhost:8765, gets the OLD build, and
    # reports "I installed the update but I still see the old version". The new
    # install was fine the whole time; it was just somewhere else.
    #
    # Scanning is still right for a genuine FIRST install alongside an existing
    # one — that is a real second instance and it does need its own port. A
    # deliberate multi-instance setup keeps working across upgrades too, because
    # instance B's .env already says 8766 and we now preserve it.
    _existing_port=$(grep -m1 '^WEB_PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '"' | tr -d "'")
    if [ "$IS_UPGRADE" = "1" ] && [ -n "$_existing_port" ]; then
        WEB_PORT="$_existing_port"
        echo "   ✅ Keeping this install's existing port ($WEB_PORT)"
        # Whoever holds it is the previous version of THIS install (or another
        # install squatting on it). Either way the user expects this URL to show
        # what they just installed, so we take the port rather than move.
        if lsof -nP -iTCP:"$WEB_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
            echo "      Port $WEB_PORT is currently in use — the previous version is still running."
            echo "      It will be stopped so this install serves http://localhost:$WEB_PORT"
            export VODOU_ALLOW_PORT_TAKEOVER=1
        fi
    else
        WEB_PORT=8765
        while lsof -nP -iTCP:$WEB_PORT -sTCP:LISTEN >/dev/null 2>&1; do
            WEB_PORT=$((WEB_PORT + 1))
        done
        if grep -q "^WEB_PORT=" .env 2>/dev/null; then
            sed -i.bak "s|^WEB_PORT=.*|WEB_PORT=$WEB_PORT|" .env 2>/dev/null || \
            sed -i '' "s|^WEB_PORT=.*|WEB_PORT=$WEB_PORT|" .env 2>/dev/null || true
            rm -f .env.bak 2>/dev/null || true
        else
            echo "WEB_PORT=$WEB_PORT" >> .env
        fi
        if [ "$WEB_PORT" != "8765" ]; then
            echo "   ℹ️  Port 8765 is already in use by another Vodou instance."
            echo "      This NEW install will use port $WEB_PORT — open http://localhost:$WEB_PORT"
        fi
    fi
    grep -q "^CLI_MODEL=" .env 2>/dev/null || echo "CLI_MODEL=opus" >> .env
    grep -q "^START_AIGATEWAY=" .env 2>/dev/null || echo "START_AIGATEWAY=1" >> .env
fi

# Resolve __VODOU_PROJECT_PATH__ placeholders
for _f in .cursor/hooks.json .claude/settings.json; do
    if [ -f "$_f" ] && grep -q "__VODOU_PROJECT_PATH__" "$_f" 2>/dev/null; then
        sed -i '' "s|__VODOU_PROJECT_PATH__|$INSTALL_DIR|g" "$_f" 2>/dev/null || \
        sed -i "s|__VODOU_PROJECT_PATH__|$INSTALL_DIR|g" "$_f" 2>/dev/null || true
        echo "   ✅ Resolved paths in $_f"
    fi
done

step_done "Configuration"

# ── Stale-file cleanup ─────────────────────────────────────────
# Wipes leftovers from prior installs/updates. Fresh tarballs never carry these.
# These are safe to remove because this install is about to replace the live files.
echo "🧹 Cleaning stale install/update artifacts..."

# 1. `*.update-old` rollback files left by src/auto_updater.rs after a successful
#    self-update. The new binaries we just wrote replace whatever those backed up.
_STALE_UPDATE_OLD=$(find . -maxdepth 2 -name "*.update-old" -type f 2>/dev/null | wc -l | tr -d ' ')
if [ "$_STALE_UPDATE_OLD" -gt 0 ]; then
    find . -maxdepth 2 -name "*.update-old" -type f -delete 2>/dev/null || true
    echo "   ✅ Removed $_STALE_UPDATE_OLD stale .update-old file(s)"
fi

# 2. Legacy `.oi/` workspace. Canonical path is now `.vodou/`. Three cases:
#    a) Symlink `.oi -> .vodou` — legacy compat symlink from the migration.
#       Safe to remove; current code reads/writes `.vodou/` directly.
#    b) Real `.oi/` dir AND `.vodou/` exists — `.oi/` is orphaned legacy state
#       (migration was blocked because `.vodou/` already existed). Move it aside.
#    c) Real `.oi/` dir, no `.vodou/` — leave alone; the binary's startup
#       migration (src/main.rs:1828) will rename it on first run.
if [ -L ".oi" ]; then
    rm -f .oi 2>/dev/null && echo "   ✅ Removed legacy .oi symlink"
elif [ -d ".oi" ] && [ -d ".vodou" ]; then
    _STAMP=$(date +%Y%m%d-%H%M%S)
    mv .oi ".oi.legacy-$_STAMP" 2>/dev/null && \
        echo "   ✅ Archived orphaned .oi/ → .oi.legacy-$_STAMP/ (safe to delete after confirming nothing important inside)"
fi

# ── macOS quarantine removal ───────────────────────────────────

if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "🔓 Removing macOS quarantine..."
    xattr -dr com.apple.quarantine "$INSTALL_DIR" 2>/dev/null || true
    echo "   ✅ Quarantine removed"

    # Ad-hoc codesign Mach-O binaries. Without this, a freshly-cp'd unsigned
    # binary gets SIGKILL'd by macOS runtime integrity enforcement on first
    # exec — separate mechanism from Gatekeeper/quarantine.
    echo "🔏 Ad-hoc signing native binaries..."
    _CS_TARGETS=(
        "vodou-core" "vodou-hook-bin" "oi" "docker-mcp"
        ".node/node" ".node/bin/node"
    )
    for _bin in "${_CS_TARGETS[@]}"; do
        [ -f "$INSTALL_DIR/$_bin" ] && codesign --force --deep --sign - "$INSTALL_DIR/$_bin" 2>/dev/null || true
    done
    # spawn-helper files inside npm packages
    find "$INSTALL_DIR/MCP-servers" -name "spawn-helper" -type f 2>/dev/null | while read -r _sh; do
        codesign --force --sign - "$_sh" 2>/dev/null || true
    done
    echo "   ✅ Binaries signed (ad-hoc)"
fi

# ── Binary permissions ─────────────────────────────────────────

echo "📦 Setting permissions..."
chmod +x vodou-core 2>/dev/null || true
chmod +x oi 2>/dev/null || true
chmod +x vodou-hook-bin 2>/dev/null || true
chmod +x *.sh 2>/dev/null || true
chmod +x docker-mcp 2>/dev/null || true
# Interactive agentic CLI launcher — the global `vodou` symlink (below) targets this,
# so it must be executable even though it lives under bin/ (not caught by `chmod +x *.sh`).
[ -f "bin/vodou-cli" ] && chmod +x bin/vodou-cli 2>/dev/null || true
[ -f "MCP-servers/mcp-monitor/bin/mcp-monitor" ] && chmod +x MCP-servers/mcp-monitor/bin/mcp-monitor
# Fix spawn-helper permissions (npm tarballs strip +x)
find MCP-servers -name "spawn-helper" -exec chmod +x {} \; 2>/dev/null || true

# Lock down files containing secrets / personal data. On a multi-user box,
# default 0644 would let any local user read API keys + conversation history.
for _sensitive in .env vodou-core.db vodou-core.db-wal vodou-core.db-shm \
                  memory.db memory.db-wal memory.db-shm; do
    [ -f "$_sensitive" ] && chmod 600 "$_sensitive" 2>/dev/null || true
done
# .vodou/ workspace holds memory logs + workspace state — owner-only.
[ -d ".vodou" ] && chmod -R go-rwx .vodou 2>/dev/null || true

echo "   ✅ Permissions set"

# Install/refresh the global launcher symlink for convenience.
# The launcher auto-detects the install it belongs to (via SCRIPT_DIR), so
# symlinking from anywhere is safe. `vodou` = interactive agentic CLI (one-shot
# mode via `vodou -p "..."`). The legacy global `oi` symlink is no longer
# created (pre-rename branding); the repo-local ./oi router still works.
mkdir -p "$HOME/.local/bin"
ln -sf "$INSTALL_DIR/bin/vodou-cli" "$HOME/.local/bin/vodou"
echo "   ✅ Refreshed ~/.local/bin/vodou -> $INSTALL_DIR/bin/vodou-cli (interactive CLI)"
case ":$PATH:" in
    *":$HOME/.local/bin:"*) : ;;
    *) echo "   ⚠️  ~/.local/bin is not on your PATH — add it to use 'vodou' globally:"
       echo "       echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc && source ~/.zshrc" ;;
esac

# ── ONNX Runtime ───────────────────────────────────────────────

if [[ "$OSTYPE" == "darwin"* ]]; then
    MACOS_MAJOR=$(sw_vers -productVersion 2>/dev/null | cut -d. -f1)
    if [ -n "$MACOS_MAJOR" ] && [ "$MACOS_MAJOR" -ge 13 ]; then
        if [ -d "onnxruntime" ] && find onnxruntime -name "libonnxruntime.dylib" -print -quit 2>/dev/null | grep -q .; then
            echo "   ✅ ONNX Runtime already bundled"
        elif [ ! -d "onnxruntime" ]; then
            step_start "ONNX Runtime download"
            echo "📦 Installing ONNX Runtime (for vector embeddings)..."
            ORT_VERSION="1.23.0"
            ONNX_ARCH="x86_64"
            [[ "$SYSTEM_ARCH" == "arm64" ]] && ONNX_ARCH="arm64"
            ONNX_URL="https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/onnxruntime-osx-${ONNX_ARCH}-${ORT_VERSION}.tgz"
            dbg "Downloading ONNX from $ONNX_URL"
            mkdir -p onnxruntime
            if timeout 90 curl -fsSL "$ONNX_URL" -o onnxruntime/onnxruntime.tgz; then
                tar -xzf onnxruntime/onnxruntime.tgz -C onnxruntime
                rm -f onnxruntime/onnxruntime.tgz
                echo "   ✅ ONNX Runtime installed"
            else
                # Clean up partial archive so a re-run doesn't see a corrupt
                # file and skip the download branch.
                rm -f onnxruntime/onnxruntime.tgz
                echo "   ⚠️  Download failed or timed out — memory search will use FTS-only (still works)"
                echo "      Retry manually: curl -fsSL '$ONNX_URL' -o onnxruntime/onnxruntime.tgz && tar -xzf onnxruntime/onnxruntime.tgz -C onnxruntime"
            fi
            step_done "ONNX Runtime download"
        else
            echo "   ✅ ONNX Runtime already present"
        fi

        # Set ORT_DYLIB_PATH
        ORT_DYLIB=""
        ONNX_ARCH="x86_64"
        [[ "$SYSTEM_ARCH" == "arm64" ]] && ONNX_ARCH="arm64"
        [ -f "onnxruntime/lib/libonnxruntime.dylib" ] && ORT_DYLIB="onnxruntime/lib/libonnxruntime.dylib"
        [ -z "$ORT_DYLIB" ] && ORT_DYLIB=$(find onnxruntime -name "libonnxruntime.dylib" 2>/dev/null | head -1)
        if [ -n "$ORT_DYLIB" ] && [ -f ".env" ]; then
            # Pin to an ABSOLUTE path — launchd starts the gateway with
            # WorkingDirectory=$GW_DIR (MCP-servers/Vodou-Console), so a relative
            # path would resolve to a non-existent file and kill semantic memory.
            ORT_DYLIB_ABS="$INSTALL_DIR/$ORT_DYLIB"
            case "$ORT_DYLIB" in /*) ORT_DYLIB_ABS="$ORT_DYLIB" ;; esac
            if grep -q "^ORT_DYLIB_PATH=" .env 2>/dev/null; then
                sed -i.bak "s|^ORT_DYLIB_PATH=.*|ORT_DYLIB_PATH=\"$ORT_DYLIB_ABS\"|" .env 2>/dev/null || \
                sed -i '' "s|^ORT_DYLIB_PATH=.*|ORT_DYLIB_PATH=\"$ORT_DYLIB_ABS\"|" .env 2>/dev/null || true
                rm -f .env.bak 2>/dev/null || true
            else
                echo "ORT_DYLIB_PATH=\"$ORT_DYLIB_ABS\"" >> .env
            fi
        fi
    fi
fi

# ── Workspace initialization ───────────────────────────────────

echo "📂 Setting up workspace..."
WORKSPACE_DIR="$INSTALL_DIR/.vodou/workspace"
mkdir -p "$WORKSPACE_DIR/memory"

if [ -d "templates" ]; then
    # Count existing workspace .md files
    WS_MD_COUNT=$(ls "$WORKSPACE_DIR"/*.md 2>/dev/null | wc -l | tr -d ' ')
    for tmpl in templates/*; do
        fname="$(basename "$tmpl")"
        # Skip memory.toml — it lives at project root, not in workspace
        [ "$fname" = "memory.toml" ] && continue
        if [ -f "$tmpl" ]; then
            # Force copy on fresh install (no .md files), skip-if-exists on re-runs
            if [ "$WS_MD_COUNT" = "0" ] || [ ! -f "$WORKSPACE_DIR/$fname" ]; then
                cp "$tmpl" "$WORKSPACE_DIR/$fname"
            fi
        fi
    done
    NEW_COUNT=$(ls "$WORKSPACE_DIR"/*.md 2>/dev/null | wc -l | tr -d ' ')
    echo "   ✅ Workspace ready ($NEW_COUNT files: SOUL, USER, IDENTITY, MEMORY, AGENTS, TOOLS)"
fi

# Seed a welcome daily log if memory dir is empty (first install)
if [ -z "$(ls -A "$WORKSPACE_DIR/memory" 2>/dev/null)" ]; then
    TODAY=$(date +%Y-%m-%d)
    cat > "$WORKSPACE_DIR/memory/$TODAY.md" << 'WELCOME_EOF'
# Welcome to Vodou

Your AI memory system is active. Daily logs will appear here automatically as you work.

## Getting Started
- Open the gateway at http://localhost:8765
- Complete the onboarding to set up your identity
- Start chatting — Vodou will learn and remember
WELCOME_EOF
    echo "   ✅ Daily memory log initialized"
fi

# ── Database ───────────────────────────────────────────────────

if [ -f "vodou-core.db" ]; then
    echo "   ✅ Database ready (pre-seeded with 13 servers)"
else
    echo "   ⚠️  Database not found — will be created on first run"
fi

# ── Bundled Node lock ───────────────────────────────────────────
# Patch any existing vodou-core.db so Node-based MCP servers spawn with the
# bundled Node we ship in .node/node, NEVER the user's system Node. Required
# because all 8 MCP servers depend on `node:sqlite` (built into Node 24+); a
# different runtime would be missing the database. Idempotent — re-runs safely.
if [ -f "vodou-core.db" ] && [ -x ".node/node" ]; then
    if command -v sqlite3 >/dev/null 2>&1; then
        UPDATED=$(sqlite3 vodou-core.db "UPDATE mcp_servers SET command = './.node/node' WHERE command = 'node'; SELECT changes();" 2>/dev/null || echo 0)
        if [ "${UPDATED:-0}" -gt 0 ] 2>/dev/null; then
            echo "   🔒 Locked $UPDATED Node MCP server(s) to bundled Node 24 (mandatory for node:sqlite)"
        fi
    fi
fi

# ── DB module sanity check ──────────────────────────────────────
#
# After the migration to node:sqlite (built into bundled Node 24), there is
# no native binding to verify. We already confirmed bundled Node + node:sqlite
# load cleanly above. This stub keeps a one-line confirmation so the install
# transcript shows the DB stack is good.
echo ""
echo "🧪 DB stack: node:sqlite (built into bundled Node — no native bindings to verify)"

# Belt-and-suspenders: scrub any stray better-sqlite3 dirs that snuck into the
# archive or were left behind by a pre-2026-05 upgrade. The 8 shipped MCP
# servers all use built-in node:sqlite now (Node 24+), so a real better-sqlite3
# dir under MCP-servers/ is always residue — safe to delete.
STRAY_BS3=0
while IFS= read -r d; do
    [ -z "$d" ] && continue
    rm -rf "$d" && STRAY_BS3=$((STRAY_BS3 + 1))
done < <(find MCP-servers -type d -name better-sqlite3 -prune 2>/dev/null)
[ "$STRAY_BS3" -gt 0 ] && echo "   🧹 cleaned $STRAY_BS3 stale better-sqlite3 dir(s) from previous install"

# ── Verify / provision MCP server dependencies ─────────────────
# Prebuilt bundles ship node_modules + dist ready → fast path, nothing to do.
# The open-core OS tree ships SOURCE ONLY (allowlist excludes node_modules) →
# provision on demand with the bundled npm: `npm ci` for runtime deps, plus
# `npm run build` for servers that ship without a compiled dist/ (e.g. brain,
# Vodou-Recall). Idempotent; a per-server failure warns but never aborts.
echo ""
echo "🔍 Verifying MCP servers (building any that ship as source)..."
READY=0
BUILT=0
FAILED=0
for SERVER_DIR in MCP-servers/Vodou-Console MCP-servers/Vodou-LLM-router MCP-servers/Vodou-Enhanced-Thinking \
    MCP-servers/Vodou-Recall MCP-servers/Vodou-script-executor MCP-servers/Vodou-session-manager \
    MCP-servers/Vodou-channels MCP-servers/dalle MCP-servers/uml-mcp MCP-servers/brain; do
    [ -d "$SERVER_DIR" ] || continue
    SERVER_NAME=$(basename "$SERVER_DIR")
    HAS_BUILD=0
    if [ -f "$SERVER_DIR/package.json" ] && grep -q '"build"[[:space:]]*:' "$SERVER_DIR/package.json" 2>/dev/null; then
        HAS_BUILD=1
    fi
    NEEDS_DIST=0
    [ "$HAS_BUILD" = "1" ] && [ ! -f "$SERVER_DIR/dist/index.js" ] && NEEDS_DIST=1
    # Ready: deps present AND (no build step, or dist already compiled).
    if [ -d "$SERVER_DIR/node_modules" ] && [ "$NEEDS_DIST" = "0" ]; then
        READY=$((READY + 1))
        continue
    fi
    echo "   🔨 $SERVER_NAME — provisioning from source..."
    OK=1
    if [ ! -d "$SERVER_DIR/node_modules" ]; then
        if [ "$NEEDS_DIST" = "1" ]; then
            # Needs a TypeScript build → full install (devDeps: tsc, etc.).
            ( cd "$SERVER_DIR" && { [ -f package-lock.json ] && npm ci --silent || npm install --silent; } ) || OK=0
        else
            # dist already shipped → runtime deps only.
            ( cd "$SERVER_DIR" && { [ -f package-lock.json ] && npm ci --omit=dev --silent || npm install --omit=dev --silent; } ) || OK=0
        fi
    fi
    if [ "$OK" = "1" ] && [ "$NEEDS_DIST" = "1" ]; then
        ( cd "$SERVER_DIR" && npm run build > /dev/null 2>&1 ) || OK=0
    fi
    # Re-check the readiness condition post-provision.
    if [ "$OK" = "1" ] && [ -d "$SERVER_DIR/node_modules" ] && { [ "$HAS_BUILD" = "0" ] || [ -f "$SERVER_DIR/dist/index.js" ]; }; then
        BUILT=$((BUILT + 1))
        echo "   ✅ $SERVER_NAME ready"
    else
        FAILED=$((FAILED + 1))
        echo "   ⚠️  $SERVER_NAME incomplete — run: cd $SERVER_DIR && npm ci && npm run build"
    fi
done
echo "   ✅ $READY prebuilt, $BUILT built from source, $FAILED need attention"

# ── Refresh stale Vodou-Console dist/ ──
# Joe's v0.5.81 fresh install had `dist/index.js` older than `src/index.ts` (see
# PLANS/joes debugging §S5 / §F6). The doctor's `/api/system reports
# version=unknown` warning is caused by the gateway running stale TS code. The
# tarball SHOULD always ship a fresh dist/, but if an upgrade-in-place left an
# old dist around — or if a dev tarball got shipped without a clean build —
# detect it and rebuild here so we never serve stale gateway code to users.
GW_DIR="$INSTALL_DIR/MCP-servers/Vodou-Console"
if [ -d "$GW_DIR" ] && [ -f "$GW_DIR/src/index.ts" ] && [ -d "$GW_DIR/node_modules" ]; then
    NEED_REBUILD=0
    if [ ! -f "$GW_DIR/dist/index.js" ]; then
        NEED_REBUILD=1
        dbg "Vodou-Console dist/index.js missing — will rebuild"
    elif [ "$GW_DIR/src/index.ts" -nt "$GW_DIR/dist/index.js" ]; then
        NEED_REBUILD=1
        dbg "Vodou-Console src/index.ts is newer than dist/index.js — will rebuild"
    fi
    if [ "$NEED_REBUILD" = "1" ]; then
        echo "   🔨 Vodou-Console dist/ stale — rebuilding so version/api endpoints are fresh..."
        if (cd "$GW_DIR" && npm run build > /dev/null 2>&1); then
            echo "   ✅ Vodou-Console rebuilt"
        else
            echo "   ⚠️  Vodou-Console rebuild failed — run manually: cd $GW_DIR && npm run build"
        fi
    fi
fi

# figma-developer-mcp ships under MCP-servers/ (wrapper + nested package; no dist/index.js at root)
if [ -f "MCP-servers/figma-developer-mcp/node_modules/figma-developer-mcp/dist/bin.js" ]; then
    echo "   ✅ figma-developer-mcp (Apps Figma) bundled"
elif [ -d "MCP-servers/figma-developer-mcp" ]; then
    echo "   ⚠️  figma-developer-mcp incomplete — run: cd MCP-servers/figma-developer-mcp && npm ci --omit=dev"
fi

# ── Bootstrap ~/.vodou/channels/ (pluggable channel install dir) ──
# This block ALWAYS runs (not gated on package.json missing) because every
# install/upgrade may put the source packages at a new path, and npm's
# file:<path> symlinks bake in the absolute path at install time. If we skip
# this on upgrades, the symlinks in ~/.vodou/channels/node_modules/@vodou/
# point to the previous install dir which may no longer exist — Vodou-
# channels then discovers 0 channels and Slack/Telegram/etc. silently fail.
CHANNELS_DIR="$HOME/.vodou/channels"
PACKAGES_DIR="$INSTALL_DIR/MCP-servers/Vodou-channels/packages"
if [ -d "$PACKAGES_DIR" ] && command -v npm &> /dev/null; then
    # Detect existing-but-stale (one or more symlinks point at a path that
    # doesn't exist). If everything resolves OK we still re-link silently to
    # ensure absolute-path correctness — fast, idempotent.
    STALE=0
    if [ -d "$CHANNELS_DIR/node_modules/@vodou" ]; then
        for link in "$CHANNELS_DIR/node_modules/@vodou/"channel-*; do
            [ -e "$link" ] || { STALE=1; break; }
        done
    fi
    echo ""
    if [ "$STALE" = "1" ] || [ ! -f "$CHANNELS_DIR/package.json" ]; then
        echo "📦 Bootstrapping ~/.vodou/channels/ (fresh)..."
    else
        echo "📦 Re-linking ~/.vodou/channels/ to current install ..."
    fi
    mkdir -p "$CHANNELS_DIR"
    [ ! -f "$CHANNELS_DIR/package.json" ] && \
        echo '{"name":"vodou-channels-install","version":"1.0.0","private":true}' > "$CHANNELS_DIR/package.json"
    npm install --prefix "$CHANNELS_DIR" --silent \
        "file:$PACKAGES_DIR/telegram" \
        "file:$PACKAGES_DIR/slack" \
        "file:$PACKAGES_DIR/discord" \
        "file:$PACKAGES_DIR/whatsapp" \
        "file:$PACKAGES_DIR/imessage" \
        "file:$PACKAGES_DIR/teams" \
        "file:$PACKAGES_DIR/googlechat" \
        "file:$PACKAGES_DIR/signal" \
        "file:$PACKAGES_DIR/voice" \
        "file:$PACKAGES_DIR/web" 2>&1 | tail -3
    # Verify the symlinks actually resolve now
    BROKEN=0
    if [ -d "$CHANNELS_DIR/node_modules/@vodou" ]; then
        for link in "$CHANNELS_DIR/node_modules/@vodou/"channel-*; do
            [ -e "$link" ] || BROKEN=$((BROKEN + 1))
        done
    fi
    if [ "$BROKEN" -gt 0 ]; then
        echo "   ⚠️  $BROKEN channel symlink(s) still broken after install — channels may not load"
    else
        echo "   ✅ Channel packages linked to $PACKAGES_DIR"
    fi
fi

# ── Screenshots directory ──────────────────────────────────────
mkdir -p screenshots

# ── Quick smoke test ───────────────────────────────────────────
# Bounded by a 15s wall-clock so a slow ONNX/daemon cold-start can't hang the
# installer. The smoke test is informational only — install completion does
# not depend on it succeeding. (Real verification happens via start-vodou-
# services.sh below, which has its own retry logic.)
echo ""
echo "🔍 Running smoke test..."
if [ -x "./vodou-core" ]; then
    SMOKE_TMP=$(mktemp)
    ( ./vodou-core brain "ping" > "$SMOKE_TMP" 2>/dev/null ) &
    SMOKE_PID=$!
    SMOKE_DEADLINE=$((SECONDS + 15))
    while kill -0 "$SMOKE_PID" 2>/dev/null; do
        if [ "$SECONDS" -ge "$SMOKE_DEADLINE" ]; then
            kill "$SMOKE_PID" 2>/dev/null
            wait "$SMOKE_PID" 2>/dev/null
            echo "   ⚠️  Smoke test timed out (15s) — daemon cold-start in progress; install continues"
            break
        fi
        sleep 1
    done
    wait "$SMOKE_PID" 2>/dev/null || true
    if [ -s "$SMOKE_TMP" ] && grep -qi "content\|matched\|result" "$SMOKE_TMP"; then
        echo "   ✅ System responding — pipeline verified"
    elif [ ! -s "$SMOKE_TMP" ] && [ "$SECONDS" -lt "$SMOKE_DEADLINE" ]; then
        echo "   ⚠️  System installed (first query may be slow due to cold start)"
    fi
    rm -f "$SMOKE_TMP"
else
    echo "   ⚠️  vodou-core binary not found — skipping smoke test"
fi

# ── Start services ─────────────────────────────────────────────

echo ""
echo "✅ Installation complete! (Pre-built — no npm install needed)"
echo ""
echo "🎯 Next steps:"
echo ""
echo "1. ⚙️  Add your credentials:"
echo "   Edit .env and add your VODOU_TOKEN and VODOU_USER_ID"
echo "   Get yours at: https://app.vodou.ai"
echo ""
echo "2. 🚀 Quick test:"
echo "   Open Claude Code or Cursor chat and type:  oi hello"
echo ""
ACTUAL_PORT=$(grep "^WEB_PORT=" .env 2>/dev/null | head -1 | cut -d= -f2)
ACTUAL_PORT="${ACTUAL_PORT:-8765}"
echo "3. 🌐 Launch the control panel:"
echo "   http://localhost:${ACTUAL_PORT}"
echo ""
if [ -d "extension/Store-vodou-bridge" ]; then
  echo "4. 🌉 (Optional) Install the Vodou Bridge browser extension — save your AI"
  echo "   chats into memory and insert memory back into them, on 22 AI sites:"
  echo "      chrome://extensions  →  Developer mode  →  Load Unpacked  →"
  echo "      $(pwd)/extension/Store-vodou-bridge"
  echo ""
  # Reworded 2026-08-02 with the switch to the store build. The old text sold it as
  # a lens helper "for gmail.unread, github.pr actions" — the store build declares
  # 38 explicit hosts and does NOT cover mail.google.com or github.com, so it cannot
  # do that and never will. What it actually does is capture and inject on the AI
  # sites, which is also the thing most people install it for.
fi

# ── Add .env sourcing to shell profile (so VODOU_TOKEN/VODOU_USER_ID are always available) ──

SHELL_PROFILE=""
[ -f "$HOME/.zshrc" ] && SHELL_PROFILE="$HOME/.zshrc"
[ -z "$SHELL_PROFILE" ] && [ -f "$HOME/.bash_profile" ] && SHELL_PROFILE="$HOME/.bash_profile"
[ -z "$SHELL_PROFILE" ] && [ -f "$HOME/.bashrc" ] && SHELL_PROFILE="$HOME/.bashrc"
[ -z "$SHELL_PROFILE" ] && [ -f "$HOME/.profile" ] && SHELL_PROFILE="$HOME/.profile"

if [ -n "$SHELL_PROFILE" ]; then
    if ! grep -q "vodou-env-loader" "$SHELL_PROFILE" 2>/dev/null; then
        cat >> "$SHELL_PROFILE" << 'VODOU_SHELL_EOF'

# Vodou — AI that learns you (supports multiple installs)
# vodou-env-loader: detects nearest Vodou project and loads its .env
vodou_load() {
    local dir="$PWD"
    # Walk up from CWD looking for a Vodou install
    while [ "$dir" != "/" ]; do
        if [ -f "$dir/vodou-core" ] && [ -f "$dir/.env" ]; then
            export VODOU_PROJECT_PATH="$dir"
            set -a; . "$dir/.env" 2>/dev/null; set +a
            return 0
        fi
        dir="$(dirname "$dir")"
    done
    # Fallback: use the default install location
    if [ -n "$VODOU_PROJECT_PATH" ] && [ -f "$VODOU_PROJECT_PATH/.env" ]; then
        set -a; . "$VODOU_PROJECT_PATH/.env" 2>/dev/null; set +a
    fi
}
# Set default install and add to PATH
export VODOU_PROJECT_PATH="${VODOU_PROJECT_PATH:-__INSTALL_DIR__}"
export PATH="$VODOU_PROJECT_PATH:$PATH"
# Auto-load .env on shell start
vodou_load
VODOU_SHELL_EOF
        # Replace placeholder with actual install path
        sed -i '' "s|__INSTALL_DIR__|$INSTALL_DIR|g" "$SHELL_PROFILE" 2>/dev/null || \
        sed -i "s|__INSTALL_DIR__|$INSTALL_DIR|g" "$SHELL_PROFILE" 2>/dev/null || true
        echo "   ✅ Added Vodou to $SHELL_PROFILE (supports multiple installs)"
    else
        # Block already exists — update the default VODOU_PROJECT_PATH to this install
        # Handles re-installs where the folder path changed (e.g. "folder 2" → "folder")
        ESCAPED_DIR=$(printf '%s' "$INSTALL_DIR" | sed 's/[&/\]/\\&/g')
        sed -i '' "s|VODOU_PROJECT_PATH=\"\${VODOU_PROJECT_PATH:-[^}]*}\"|VODOU_PROJECT_PATH=\"\${VODOU_PROJECT_PATH:-${ESCAPED_DIR}}\"|g" "$SHELL_PROFILE" 2>/dev/null || \
        sed -i "s|VODOU_PROJECT_PATH=\"\${VODOU_PROJECT_PATH:-[^}]*}\"|VODOU_PROJECT_PATH=\"\${VODOU_PROJECT_PATH:-${ESCAPED_DIR}}\"|g" "$SHELL_PROFILE" 2>/dev/null || true
        echo "   ✅ Updated Vodou path in $SHELL_PROFILE"
    fi
    # Source it now for the current session
    export VODOU_PROJECT_PATH="$INSTALL_DIR"
    set -a; . "$INSTALL_DIR/.env" 2>/dev/null; set +a
fi

# Auto-start services. NON-FATAL: a hiccup in the immediate boot (e.g. a slow
# health check) must not abort the install under `set -e` — the auto-start
# config (launchd/systemd) below still needs to run so the gateway comes up on
# the next login/boot regardless.
if [ -f "$INSTALL_DIR/start-vodou-services.sh" ]; then
    step_start "Service startup"
    echo "🚀 Starting services..."
    # VODOU_ALLOW_PORT_TAKEOVER: an explicit install/upgrade is entitled to the
    # port it just configured. The start script's default is deliberately the
    # opposite (a background vodou-hook spawn must never kill a live gateway),
    # so the permission is granted here, at the one moment the user is standing
    # in front of the machine asking for this install to be the one that runs.
    DEBUG="$DEBUG" VODOU_ALLOW_PORT_TAKEOVER=1 "$INSTALL_DIR/start-vodou-services.sh" || echo "   ⚠️  Immediate service start reported an issue — continuing (auto-start still configured below)."
    step_done "Service startup"
fi

# ── macOS: Install Launch Agent so gateway auto-starts on login ──
if [[ "$OSTYPE" == "darwin"* ]] && [ -f "$INSTALL_DIR/MCP-servers/Vodou-Console/dist/index.js" ]; then
    # Per-install label so multiple Vodou instances each get their own launchd
    # job — otherwise a 2nd install overwrites the single plist and hijacks the
    # 1st install's login auto-start.
    INSTALL_HASH=$(printf '%s' "$INSTALL_DIR" | shasum -a 256 | cut -c1-8)
    LABEL="com.vodou.console.${INSTALL_HASH}"
    PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
    # MANDATORY: bundled Node (only Node guaranteed to have node:sqlite at the
    # right version). Never fall back to system Node — gateway would crash.
    NODE_BIN="$INSTALL_DIR/.node/node"
    if [ ! -x "$NODE_BIN" ]; then
        echo "   ⚠️  Skipping launchd auto-start: bundled Node missing at $NODE_BIN"
        NODE_BIN=""
    fi
    GW_DIR="$INSTALL_DIR/MCP-servers/Vodou-Console"
    GW_LOG_DIR="$GW_DIR/logs"
    mkdir -p "$GW_LOG_DIR" "$HOME/Library/LaunchAgents"

    # Unload previous version if present
    launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true

    # ── Boot out OTHER installs' jobs that fight for the SAME port ──────────
    # The per-install label above is deliberate (two instances, two login
    # jobs), but it only works when the instances sit on different ports. When
    # someone extracts an upgrade into a NEW folder, the old install's job stays
    # loaded and keeps the port; the new install's gateway then loses the race
    # or gets skipped, and the browser keeps serving the OLD build while
    # /api/system reports the NEW version (it reads the binary, not the
    # gateway). Only same-port jobs from a different folder are touched — a
    # genuine second instance on its own port is left alone.
    _effective_port_of() {  # $1 = install dir → its WEB_PORT (default 8765)
        local d="$1" p=""
        [ -f "$d/.env" ] && p=$(grep -m1 '^WEB_PORT=' "$d/.env" 2>/dev/null | cut -d= -f2)
        [ -f "$d/MCP-servers/Vodou-Console/.env" ] && \
            p=$(grep -m1 '^WEB_PORT=' "$d/MCP-servers/Vodou-Console/.env" 2>/dev/null | cut -d= -f2 || echo "$p")
        echo "${p:-8765}"
    }
    _this_port=$(_effective_port_of "$INSTALL_DIR")
    _this_real=$(cd "$INSTALL_DIR" 2>/dev/null && pwd -P)
    for _p in "$HOME"/Library/LaunchAgents/com.vodou.console*.plist; do
        [ -e "$_p" ] || continue
        [ "$_p" = "$PLIST_PATH" ] && continue
        _wd=$(/usr/libexec/PlistBuddy -c "Print :WorkingDirectory" "$_p" 2>/dev/null)
        [ -n "$_wd" ] || continue
        # WorkingDirectory is <install>/MCP-servers/Vodou-Console
        _other=$(cd "$_wd/../.." 2>/dev/null && pwd -P) || continue
        [ -n "$_other" ] && [ "$_other" = "$_this_real" ] && continue
        [ "$(_effective_port_of "$_other")" = "$_this_port" ] || continue
        echo "   ⚠️  Another Vodou install also runs on port $_this_port: $_other"
        echo "        Disabling its login auto-start so this install owns the port."
        launchctl bootout "gui/$(id -u)" "$_p" 2>/dev/null || true
        mv "$_p" "$_p.superseded" 2>/dev/null || true
    done

if [ -n "$NODE_BIN" ]; then
    cat > "$PLIST_PATH" <<LAUNCHD_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${GW_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${GW_LOG_DIR}/gateway-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${GW_LOG_DIR}/gateway-stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${INSTALL_DIR}/.node:${HOME}/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>${HOME}</string>
        <key>VODOU_PROJECT_PATH</key>
        <string>${INSTALL_DIR}</string>
    </dict>
    <key>ThrottleInterval</key>
    <integer>5</integer>
</dict>
</plist>
LAUNCHD_EOF

    launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
    echo "   ✅ Gateway will auto-start on login (launchd: ${LABEL}, bundled Node)"
fi
fi

# ── Linux: install a systemd USER unit so the gateway auto-starts ──
# Direct parallel to the macOS launchd block above. Gateway-only, mirroring
# launchd — the vodou-core daemon + worker are started by
# ./start-vodou-services.sh (full-stack lifecycle unification into
# `vodou-core service …` is the cross-platform Phase 2 refactor). A user unit
# (not system) keeps installs per-user and needs no root; per-install hash in
# the name lets multiple instances coexist without hijacking each other.
if [[ "$OSTYPE" == "linux"* ]] && [ -f "$INSTALL_DIR/MCP-servers/Vodou-Console/dist/index.js" ]; then
    NODE_BIN="$INSTALL_DIR/.node/node"
    if [ ! -x "$NODE_BIN" ]; then
        echo "   ⚠️  Skipping systemd auto-start: bundled Node missing at $NODE_BIN"
    elif ! command -v systemctl >/dev/null 2>&1; then
        echo "   ℹ️  systemd not found — auto-start skipped. Start manually: ./start-vodou-services.sh"
    else
        INSTALL_HASH=$(printf '%s' "$INSTALL_DIR" | sha256sum | cut -c1-8)
        UNIT_NAME="vodou-console-${INSTALL_HASH}.service"
        UNIT_DIR="$HOME/.config/systemd/user"
        GW_DIR="$INSTALL_DIR/MCP-servers/Vodou-Console"
        mkdir -p "$UNIT_DIR" "$GW_DIR/logs"
        cat > "$UNIT_DIR/$UNIT_NAME" <<SYSTEMD_EOF
[Unit]
Description=Vodou Console gateway (${INSTALL_DIR})
After=network.target

[Service]
Type=simple
WorkingDirectory=${GW_DIR}
ExecStart=${NODE_BIN} dist/index.js
Environment=PATH=${INSTALL_DIR}/.node:${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=${HOME}
Environment=VODOU_PROJECT_PATH=${INSTALL_DIR}
Environment=VODOU_NO_OPEN_BROWSER=1
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
SYSTEMD_EOF
        echo "   ✅ systemd user unit written: $UNIT_DIR/$UNIT_NAME"
        # Best-effort enable. Needs a user D-Bus session (absent in bare containers
        # and some SSH sessions); degrade with the exact manual command on failure.
        if systemctl --user daemon-reload 2>/dev/null && systemctl --user enable --now "$UNIT_NAME" 2>/dev/null; then
            echo "   ✅ Gateway auto-starts (systemd --user: ${UNIT_NAME})"
            if [ "$VODOU_HEADLESS" = "1" ]; then
                if loginctl enable-linger "$(id -un)" 2>/dev/null; then
                    echo "   ✅ Lingering enabled — gateway runs without an active login (headless)"
                else
                    echo "   ℹ️  For headless boot-start, run once: sudo loginctl enable-linger $(id -un)"
                fi
            fi
        else
            echo "   ⚠️  systemctl --user not active here (no user D-Bus session). Unit is written; enable it on a real login with:"
            echo "        systemctl --user daemon-reload && systemctl --user enable --now $UNIT_NAME"
            echo "        (or just run ./start-vodou-services.sh)"
        fi
    fi
fi

# Browser auto-open is handled by start-vodou-services.sh (no duplicate open here)
