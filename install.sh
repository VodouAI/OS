#!/bin/bash

# Vodou Installation Script
# Installs Vodou in the current directory (allows multiple versions)

set -e

INSTALL_DIR="$(pwd)"
BINARY_NAME="vodou-core"

echo "🚀 Vodou Installation Script"
echo "========================="
echo "📁 Installing to current directory: $INSTALL_DIR"
echo ""
echo "💡 This allows you to run multiple versions of Vodou on the same machine!"
echo "   Each directory can have its own version and database."

# Check available disk space (need ~500MB for install + builds)
AVAILABLE_MB=$(df -m . 2>/dev/null | tail -1 | awk '{print $4}')
if [ -n "$AVAILABLE_MB" ] && [ "$AVAILABLE_MB" -lt 500 ] 2>/dev/null; then
    echo "❌ Low disk space: ${AVAILABLE_MB}MB available, need at least 500MB"
    echo "   Free up space and try again."
    exit 1
elif [ -n "$AVAILABLE_MB" ] && [ "$AVAILABLE_MB" -lt 1000 ] 2>/dev/null; then
    echo "⚠️  Low disk space: ${AVAILABLE_MB}MB available. Vodou needs ~500MB. Proceeding..."
fi

# Verify we're in the right location
if [ ! -f "vodou-core" ]; then
    echo "⚠️  Warning: vodou-core binary not found in current directory"
    echo "   Make sure you've extracted the release archive first"
    exit 1
fi

# Architecture check — catch arm64/intel mismatch early
SYSTEM_ARCH=$(uname -m)
if [[ "$OSTYPE" == "darwin"* ]]; then
    BINARY_ARCH=$(file vodou-core 2>/dev/null | grep -o "arm64\|x86_64" | head -1)
    if [ -n "$BINARY_ARCH" ]; then
        if [[ "$SYSTEM_ARCH" == "arm64" && "$BINARY_ARCH" == "x86_64" ]]; then
            echo "❌ Architecture mismatch: You have an Intel (x86_64) build on Apple Silicon (arm64)"
            echo "   Download the arm64 release instead."
            exit 1
        elif [[ "$SYSTEM_ARCH" == "x86_64" && "$BINARY_ARCH" == "arm64" ]]; then
            echo "❌ Architecture mismatch: You have an ARM (arm64) build on Intel (x86_64)"
            echo "   Download the intel release instead."
            exit 1
        fi
    fi
fi

# Check for sqlite3 (needed for regression tests and diagnostics)
if ! command -v sqlite3 &> /dev/null; then
    echo "⚠️  sqlite3 not found. Some diagnostics and regression tests require it."
    echo "   macOS: built-in (check PATH). Linux: sudo apt install sqlite3"
fi

# Setup configuration first (so we have .env and path for quarantine)
echo "⚙️ Setting up configuration..."
if [ -f ".env.example" ]; then
    if [ ! -f ".env" ]; then
        cp .env.example .env
        echo "   Created .env file from .env.example"
    else
        echo "   .env file already exists"
    fi
fi

# Always set VODOU_PROJECT_PATH in .env to install directory (quoted for paths with spaces)
if [ -f ".env" ]; then
    if grep -q "^VODOU_PROJECT_PATH=" .env; then
        sed -i.bak "s|^VODOU_PROJECT_PATH=.*|VODOU_PROJECT_PATH=\"$INSTALL_DIR\"|" .env 2>/dev/null || sed -i '' "s|^VODOU_PROJECT_PATH=.*|VODOU_PROJECT_PATH=\"$INSTALL_DIR\"|" .env 2>/dev/null || true
        rm -f .env.bak 2>/dev/null || true
        echo "   ✅ Set VODOU_PROJECT_PATH in .env: $INSTALL_DIR"
    else
        echo "" >> .env
        echo "# Project root directory (auto-configured during installation)" >> .env
        echo "VODOU_PROJECT_PATH=\"$INSTALL_DIR\"" >> .env
        echo "   ✅ Added VODOU_PROJECT_PATH to .env: $INSTALL_DIR"
    fi

    # Pin ORT_DYLIB_PATH to an ABSOLUTE path so semantic (vector) memory loads
    # regardless of launch cwd. Only when the bundled ONNX Runtime dylib exists;
    # otherwise leave memory on FTS-only rather than point at a missing file.
    ORT_LIB="$INSTALL_DIR/onnxruntime/lib/libonnxruntime.dylib"
    if [ -e "$ORT_LIB" ]; then
        if grep -q "^ORT_DYLIB_PATH=" .env 2>/dev/null; then
            sed -i.bak "s|^ORT_DYLIB_PATH=.*|ORT_DYLIB_PATH=\"$ORT_LIB\"|" .env 2>/dev/null || sed -i '' "s|^ORT_DYLIB_PATH=.*|ORT_DYLIB_PATH=\"$ORT_LIB\"|" .env 2>/dev/null || true
            rm -f .env.bak 2>/dev/null || true
        else
            echo "ORT_DYLIB_PATH=\"$ORT_LIB\"" >> .env
        fi
        echo "   ✅ Set ORT_DYLIB_PATH (semantic memory enabled)"
    else
        echo "   ℹ️  ONNX Runtime dylib not found — memory will use FTS-only"
    fi

    # Ensure WEB_PORT is set
    if ! grep -q "^WEB_PORT=" .env 2>/dev/null; then
        echo "" >> .env
        echo "# Vodou-Console web chat port" >> .env
        echo "WEB_PORT=8765" >> .env
        echo "   ✅ Set WEB_PORT=8765"
    fi

    # Ensure CLI_MODEL is set
    if ! grep -q "^CLI_MODEL=" .env 2>/dev/null; then
        echo "" >> .env
        echo "# Claude model for CLI and gateway (opus, sonnet, haiku)" >> .env
        echo "CLI_MODEL=opus" >> .env
        echo "   ✅ Set CLI_MODEL=opus"
    fi
fi

# Resolve __VODOU_PROJECT_PATH__ in .cursor and .claude (release uses placeholder)
for _f in .cursor/hooks.json .claude/settings.json; do
    if [ -f "$_f" ]; then
        if grep -q "__VODOU_PROJECT_PATH__" "$_f" 2>/dev/null; then
            sed -i '' "s|__VODOU_PROJECT_PATH__|$INSTALL_DIR|g" "$_f" 2>/dev/null || sed -i "s|__VODOU_PROJECT_PATH__|$INSTALL_DIR|g" "$_f" 2>/dev/null || true
            echo "   ✅ Resolved __VODOU_PROJECT_PATH__ in $_f"
        fi
    fi
done

# Remove macOS quarantine recursively (path from .env when available)
echo "🔓 Removing macOS quarantine attributes..."
if [[ "$OSTYPE" == "darwin"* ]]; then
    QUARANTINE_PATH="$INSTALL_DIR"
    if [ -f ".env" ]; then
        _p=$(grep "^VODOU_PROJECT_PATH=" .env 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'")
        [ -n "$_p" ] && [ -d "$_p" ] && QUARANTINE_PATH="$_p"
    fi
    xattr -dr com.apple.quarantine "$QUARANTINE_PATH" 2>/dev/null || true
    echo "   ✅ Quarantine attributes removed (recursive: $QUARANTINE_PATH)"
fi

# ============================================================================
# 0.5 Install ONNX Runtime 1.23.2 (macOS 13+; vodou-core embed feature)
# ONNX Runtime 1.23.x requires macOS 13.4+. On older Macs Vodou runs with FTS-only memory.
# ============================================================================
if [[ "$OSTYPE" == "darwin"* ]]; then
    MACOS_VER=$(sw_vers -productVersion 2>/dev/null || echo "0")
    MACOS_MAJOR=$(echo "$MACOS_VER" | cut -d. -f1)
    if [ -n "$MACOS_MAJOR" ] && [ "$MACOS_MAJOR" -lt 13 ]; then
        echo ""
        echo "   ℹ️  macOS $MACOS_VER: ONNX Runtime 1.23 requires macOS 13.4+. Memory search will use FTS-only (no vector embeddings)."
    else
        ORT_VERSION="1.23.0"
        ONNX_ARCH="x86_64"
        [[ $(uname -m) == "arm64" ]] && ONNX_ARCH="arm64"
        ONNX_URL="https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/onnxruntime-osx-${ONNX_ARCH}-${ORT_VERSION}.tgz"
        ONNX_DIR="$INSTALL_DIR/onnxruntime"
        ONNX_SUBDIR="onnxruntime-osx-${ONNX_ARCH}-${ORT_VERSION}"

        # Find existing dylib (handles both stripped and non-stripped layouts)
        ORT_DYLIB=""
        [ -f "$ONNX_DIR/lib/libonnxruntime.dylib" ] && ORT_DYLIB="onnxruntime/lib/libonnxruntime.dylib"
        [ -z "$ORT_DYLIB" ] && [ -f "$ONNX_DIR/$ONNX_SUBDIR/lib/libonnxruntime.dylib" ] && ORT_DYLIB="onnxruntime/$ONNX_SUBDIR/lib/libonnxruntime.dylib"

        if [ -z "$ORT_DYLIB" ]; then
            echo ""
            echo "📦 Installing ONNX Runtime ${ORT_VERSION} for macOS ($ONNX_ARCH)..."
            echo "   (Required for vector embeddings — hybrid memory search)"
            mkdir -p "$ONNX_DIR"
            if curl -fsSL "$ONNX_URL" -o "$ONNX_DIR/onnxruntime.tgz"; then
                # Extract without --strip-components (preserves arch-specific dir name)
                tar -xzf "$ONNX_DIR/onnxruntime.tgz" -C "$ONNX_DIR"
                rm -f "$ONNX_DIR/onnxruntime.tgz"
                echo "   ✅ ONNX Runtime ${ORT_VERSION} installed to $ONNX_DIR"
            else
                echo "   ⚠️  Download failed; memory search will use FTS-only (no vector embeddings)"
                echo "   💡 To fix: download from $ONNX_URL and extract to $ONNX_DIR"
            fi

            # Detect the actual dylib path after extraction
            if [ -f "$ONNX_DIR/$ONNX_SUBDIR/lib/libonnxruntime.dylib" ]; then
                ORT_DYLIB="onnxruntime/$ONNX_SUBDIR/lib/libonnxruntime.dylib"
            elif [ -f "$ONNX_DIR/lib/libonnxruntime.dylib" ]; then
                ORT_DYLIB="onnxruntime/lib/libonnxruntime.dylib"
            fi
        else
            echo ""
            echo "   ✅ ONNX Runtime already installed"
        fi

        # Set ORT_DYLIB_PATH in .env (relative path so install is portable)
        if [ -f ".env" ] && [ -n "$ORT_DYLIB" ]; then
            if grep -q "^ORT_DYLIB_PATH=" .env 2>/dev/null; then
                sed -i.bak "s|^ORT_DYLIB_PATH=.*|ORT_DYLIB_PATH=$ORT_DYLIB|" .env 2>/dev/null || sed -i '' "s|^ORT_DYLIB_PATH=.*|ORT_DYLIB_PATH=$ORT_DYLIB|" .env 2>/dev/null || true
                rm -f .env.bak 2>/dev/null || true
            else
                echo "" >> .env
                echo "# ONNX Runtime (vector embeddings for hybrid memory search)" >> .env
                echo "ORT_DYLIB_PATH=$ORT_DYLIB" >> .env
            fi
            echo "   ✅ Set ORT_DYLIB_PATH=$ORT_DYLIB"
        fi
    fi
fi

# Make binary executable
echo "📦 Setting up binary..."
chmod +x vodou-core

# Lock down files containing secrets / personal data. On a multi-user box,
# default 0644 would let any local user read API keys + conversation history.
# (Owner keeps read+write — 600 — so the binary can still open the DBs.)
for _sensitive in .env vodou-core.db vodou-core.db-wal vodou-core.db-shm \
                  memory.db memory.db-wal memory.db-shm; do
    [ -f "$_sensitive" ] && chmod 600 "$_sensitive" 2>/dev/null || true
done
# .vodou/ workspace holds memory logs + workspace state — owner-only.
[ -d ".vodou" ] && chmod -R go-rwx .vodou 2>/dev/null || true

# ── ABI-safe Node lock ──────────────────────────────────────────────────────
# Patch vodou-core.db so Node-based MCP servers spawn with the bundled Node
# we ship in .node/node, NOT the user's system Node. Servers use built-in
# node:sqlite (no native bindings), but we still pin Node so users with very
# old system Node (<22, missing node:sqlite) or wildly newer versions get a
# predictable runtime. Idempotent — no-op if clean DB already has './.node/node'.
if [ -f "vodou-core.db" ] && [ -x ".node/node" ]; then
    if command -v sqlite3 >/dev/null 2>&1; then
        UPDATED=$(sqlite3 vodou-core.db "UPDATE mcp_servers SET command = './.node/node' WHERE command = 'node'; SELECT changes();" 2>/dev/null || echo 0)
        if [ "${UPDATED:-0}" -gt 0 ] 2>/dev/null; then
            echo "   🔒 Locked $UPDATED Node MCP server(s) to bundled Node"
        fi
    fi
fi
# ───────────────────────────────────────────────────────────────────────────

# Make scripts executable
echo "📜 Setting up scripts..."
chmod +x *.sh 2>/dev/null || true
# Launchers: do is canonical; oi/vodou are copies (see scripts/sync-cli-launchers.sh)
chmod +x do ./do vodou 2>/dev/null || true
chmod +x docker-mcp 2>/dev/null || true
# Make mcp-monitor binary executable if it exists
if [ -f "MCP-servers/mcp-monitor/bin/mcp-monitor" ]; then
    chmod +x MCP-servers/mcp-monitor/bin/mcp-monitor 2>/dev/null || true
fi

# Create local config directory (relative to install)
CONFIG_DIR="$INSTALL_DIR/.config"
mkdir -p "$CONFIG_DIR"

# Create screenshots directory
echo "📸 Creating screenshots directory..."
mkdir -p screenshots
SCREENSHOTS_PATH="$(cd screenshots && pwd)"
echo "   ✅ Created screenshots directory at: $SCREENSHOTS_PATH"

# ============================================================================
# 0. Check for Homebrew (optional - only used as fallback for Node.js/Go)
# ============================================================================
# Helper function to find and setup Homebrew
setup_homebrew_path() {
    if command -v brew &> /dev/null; then
        return 0
    fi
    
    # Check common Homebrew locations
    if [ -f "/opt/homebrew/bin/brew" ]; then
        # Apple Silicon
        eval "$(/opt/homebrew/bin/brew shellenv)"
        export PATH="/opt/homebrew/bin:$PATH"
        return 0
    elif [ -f "/usr/local/bin/brew" ]; then
        # Intel Mac
        eval "$(/usr/local/bin/brew shellenv)"
        export PATH="/usr/local/bin:$PATH"
        return 0
    fi
    
    return 1
}

# Note: Homebrew is optional. We prefer direct downloads for faster installation.
# Homebrew is only used as a fallback if direct installation fails.
if [[ "$OSTYPE" == "darwin"* ]]; then
    # Check if Homebrew exists (optional, only for fallback)
    if setup_homebrew_path; then
        echo ""
        echo "🔍 Checking for Homebrew (optional)..."
        echo "   ✅ Homebrew found (will be used as fallback if needed)"
    fi
fi

# ============================================================================
# 1. Check and install Node.js (if needed)
# ============================================================================
# Fast Node.js installation via direct download (pre-built binary, no sudo needed)
install_nodejs_direct() {
    local NODE_VERSION="v22.14.0"
    local ARCH="x64"
    
    if [[ "$OSTYPE" == "darwin"* ]]; then
        if [[ $(uname -m) == "arm64" ]]; then
            ARCH="arm64"
        fi
        local NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-darwin-${ARCH}.tar.gz"
        local INSTALL_DIR="$HOME/.local"
        
        echo "   📥 Downloading Node.js ${NODE_VERSION} (pre-built binary, ~30 seconds)..."
        local TEMP_DIR=$(mktemp -d)
        cd "$TEMP_DIR"
        
        if curl -fsSL "$NODE_URL" -o node.tar.gz; then
            echo "   📦 Extracting Node.js..."
            tar -xzf node.tar.gz
            local NODE_DIR=$(ls -d node-* | head -1)
            
            echo "   🔧 Installing to $INSTALL_DIR (no sudo needed)..."
            mkdir -p "$INSTALL_DIR"
            cp -R "$NODE_DIR"/* "$INSTALL_DIR/"
            
            # Add to PATH for current session
            export PATH="$INSTALL_DIR/bin:$PATH"
            
            # Add to shell profile for persistence
            local SHELL_PROFILE=""
            if [ -n "$ZSH_VERSION" ]; then
                SHELL_PROFILE="$HOME/.zshrc"
            elif [ -n "$BASH_VERSION" ]; then
                SHELL_PROFILE="$HOME/.bash_profile"
            fi
            
            if [ -n "$SHELL_PROFILE" ]; then
                if ! grep -q "$INSTALL_DIR/bin" "$SHELL_PROFILE" 2>/dev/null; then
                    echo "" >> "$SHELL_PROFILE"
                    echo "# Node.js (installed by Vodou install script)" >> "$SHELL_PROFILE"
                    echo "export PATH=\"$INSTALL_DIR/bin:\$PATH\"" >> "$SHELL_PROFILE"
                fi
            fi
            
            cd - > /dev/null
            rm -rf "$TEMP_DIR"
            echo "   ✅ Node.js installed to $INSTALL_DIR"
            return 0
        else
            cd - > /dev/null
            rm -rf "$TEMP_DIR"
            return 1
        fi
    fi
    return 1
}

echo ""
echo "🔍 Checking for Node.js..."
MIN_NODE_MAJOR=20
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ] 2>/dev/null; then
        echo "   ⚠️  Node.js $NODE_VERSION found but too old (need v${MIN_NODE_MAJOR}+)"
        NODE_UPGRADED=false

        if command -v nvm &> /dev/null || [ -s "$HOME/.nvm/nvm.sh" ]; then
            echo "   📥 Detected nvm — installing Node.js 20 via nvm..."
            [ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"
            if nvm install 20 && nvm use 20; then
                NODE_VERSION=$(node --version)
                echo "   ✅ Node.js upgraded via nvm: $NODE_VERSION"
                NODE_UPGRADED=true
            fi
        fi

        if [ "$NODE_UPGRADED" = false ]; then
            echo "   📥 Installing Node.js v22 LTS (pre-built binary, no sudo needed)..."
            if install_nodejs_direct; then
                if command -v node &> /dev/null; then
                    NODE_VERSION=$(node --version)
                    echo "   ✅ Node.js installed: $NODE_VERSION"
                    NODE_UPGRADED=true
                fi
            fi
        fi

        if [ "$NODE_UPGRADED" = false ]; then
            echo "   ❌ Auto-install failed. Please upgrade Node.js manually:"
            echo "      nvm install 20   (if using nvm)"
            echo "      Or download from: https://nodejs.org/"
        fi
    else
        echo "   ✅ Node.js found: $NODE_VERSION"
    fi
    if command -v npm &> /dev/null; then
        NPM_VERSION=$(npm --version)
        echo "   ✅ npm found: v$NPM_VERSION"
    else
        echo "   ⚠️  npm not found. Please install Node.js which includes npm."
        echo "      Visit: https://nodejs.org/"
    fi
else
    echo "   ⚠️  Node.js not found"
    
    # Try fast direct installation first (macOS only)
    if [[ "$OSTYPE" == "darwin"* ]]; then
        if install_nodejs_direct; then
            if command -v node &> /dev/null; then
                NODE_VERSION=$(node --version)
                echo "   ✅ Node.js installed: $NODE_VERSION"
            fi
        else
            # Fallback to Homebrew if direct install fails
            setup_homebrew_path
            if command -v brew &> /dev/null; then
                echo "   📥 Trying Homebrew installation (slower, may compile dependencies)..."
                echo "   💡 Tip: For faster install, download from https://nodejs.org/"
                if brew install node 2>&1 | tee /tmp/node-install.log; then
                    echo "   ✅ Node.js installed successfully!"
                    setup_homebrew_path
                    if command -v node &> /dev/null; then
                        NODE_VERSION=$(node --version)
                        echo "   ✅ Node.js version: $NODE_VERSION"
                    fi
                else
                    echo "   ❌ Node.js installation failed"
                    echo "   📥 Please install manually from: https://nodejs.org/"
                fi
            else
                echo "   📥 To install Node.js:"
                echo "      Download from: https://nodejs.org/ (fastest, ~30 seconds)"
                echo "      Or install Homebrew first, then: brew install node"
            fi
        fi
    else
        echo "   📥 To install Node.js:"
        echo "      Download from: https://nodejs.org/"
    fi
    
    # Check again after potential installation
    if ! command -v node &> /dev/null; then
        echo "   ⚠️  Skipping browser-tools-mcp build (requires Node.js)"
    fi
fi

# ============================================================================
# 2. Build Browser Tools MCP server
# ============================================================================
# Ensure Node.js/npm is in PATH (check all possible installation locations)
ensure_nodejs_in_path() {
    if command -v npm &> /dev/null; then
        return 0
    fi
    
    # Check ~/.local/bin (direct download installation)
    if [ -f "$HOME/.local/bin/npm" ]; then
        export PATH="$HOME/.local/bin:$PATH"
        return 0
    fi
    
    # Check Homebrew locations
    if [[ "$OSTYPE" == "darwin"* ]]; then
        setup_homebrew_path
        if command -v npm &> /dev/null; then
            return 0
        fi
    fi
    
    return 1
}

# Ensure Node.js is accessible
ensure_nodejs_in_path

if [ -d "MCP-servers/browser-tools-mcp" ] && command -v npm &> /dev/null; then
    echo ""
    echo "🌐 Building browser-tools components..."
    
    # Build browser-tools-server (HTTP server)
    if [ -d "MCP-servers/browser-tools-mcp/browser-tools-server" ]; then
        echo "   📦 Building browser-tools-server..."
        cd MCP-servers/browser-tools-mcp/browser-tools-server
        
        # Install dependencies if node_modules doesn't exist
        if [ ! -d "node_modules" ]; then
            echo "      Installing dependencies (this may take 30-60 seconds)..."
            npm install --progress 2>&1 | tee /tmp/browser-tools-server-install.log || {
                echo "      ⚠️  npm install failed. Check /tmp/browser-tools-server-install.log for details"
                cd - > /dev/null
            }
        fi
        
        # Build TypeScript
        if [ -d "node_modules" ] && [ -f "package.json" ]; then
            echo "      🔨 Building TypeScript..."
            if npm run build --silent 2>/dev/null; then
                echo "      ✅ browser-tools-server built successfully"
            else
                echo "      ⚠️  TypeScript build failed (may need manual build)"
            fi
        fi
        cd - > /dev/null
    fi
    
    # Build browser-tools-mcp (MCP stdio server)
    if [ -d "MCP-servers/browser-tools-mcp/browser-tools-mcp" ]; then
        echo "   📦 Building browser-tools-mcp (MCP server)..."
        cd MCP-servers/browser-tools-mcp/browser-tools-mcp
        
        # Install dependencies if node_modules doesn't exist
        if [ ! -d "node_modules" ]; then
            echo "      Installing dependencies..."
            npm install --progress 2>&1 | tee /tmp/browser-tools-mcp-install.log || {
                echo "      ⚠️  npm install failed. Check /tmp/browser-tools-mcp-install.log for details"
                cd - > /dev/null
            }
        fi
        
        # Build TypeScript
        if [ -d "node_modules" ] && [ -f "package.json" ]; then
            echo "      🔨 Building TypeScript..."
            if npm run build --silent 2>/dev/null; then
                echo "      ✅ browser-tools-mcp built successfully"
            else
                echo "      ⚠️  TypeScript build failed (may need manual build)"
            fi
        fi
        cd - > /dev/null
    fi
elif [ -d "MCP-servers/browser-tools-mcp" ]; then
    echo ""
    echo "🌐 browser-tools-mcp found but Node.js/npm not available"
    echo "   Install Node.js to build browser-tools components"
fi

# ============================================================================
# 2.8 Build Vodou-LLM-router (TypeScript compilation)
# ============================================================================
if [ -d "MCP-servers/Vodou-LLM-router" ] && command -v npm &> /dev/null; then
    echo ""
    echo "🤖 Building Vodou-LLM-router..."
    cd MCP-servers/Vodou-LLM-router
    if [ -f "package.json" ]; then
        if [ ! -d "node_modules" ]; then
            echo "   📦 Installing Vodou-LLM-router dependencies..."
            npm install --progress 2>&1 | tee /tmp/llm-router-install.log || { cd - > /dev/null; true; }
        else
            echo "   ✅ Vodou-LLM-router dependencies already installed"
        fi
        if [ ! -f "dist/index.js" ]; then
            echo "   🔨 Building Vodou-LLM-router (TypeScript compilation)..."
            npm run build 2>&1 | tee /tmp/llm-router-build.log || { cd - > /dev/null; true; }
            if [ $? -eq 0 ] && [ -f "dist/index.js" ]; then
                echo "      ✅ Vodou-LLM-router built successfully"
            else
                echo "      💡 Try running manually: cd MCP-servers/Vodou-LLM-router && npm install && npm run build"
            fi
        else
            echo "   ✅ Vodou-LLM-router already built (dist/index.js exists)"
        fi
    else
        echo "   ⚠️  package.json not found in Vodou-LLM-router"
    fi
    cd - > /dev/null
elif [ -d "MCP-servers/Vodou-LLM-router" ]; then
    echo ""
    echo "🤖 Vodou-LLM-router found but Node.js/npm not available"
    echo "   Install Node.js to build Vodou-LLM-router"
fi

# 2.81 Build Vodou-Console (HTTP/WS chat UI on :8765; optional)
if [ -d "MCP-servers/Vodou-Console" ] && command -v npm &> /dev/null; then
    echo ""
    echo "🌐 Building Vodou-Console..."
    cd MCP-servers/Vodou-Console
    if [ -f "package.json" ]; then
        if [ ! -f "dist/index.js" ]; then
            echo "   📦 Installing dependencies (including devDependencies for build)..."
            npm install --progress 2>&1 | tail -3
            echo "   🔨 Building Vodou-Console..."
            npm run build 2>&1 | tail -5
            [ -f "dist/index.js" ] && echo "   ✅ Vodou-Console built (run node dist/index.js for chat on :8765)" || echo "   💡 Try: cd MCP-servers/Vodou-Console && npm install && npm run build"
        else
            echo "   ✅ Vodou-Console already built"
        fi
    fi
    cd - > /dev/null
fi

# 2.815 Build brain (read-only memory navigation MCP + mini console on :8767)
if [ -d "MCP-servers/brain" ] && command -v npm &> /dev/null; then
    echo ""
    echo "🧠 Building brain (memory navigation)..."
    cd MCP-servers/brain
    if [ -f "package.json" ]; then
        if [ ! -f "dist/index.js" ]; then
            npm install --progress 2>&1 | tail -2
            npm run build 2>&1 | tail -2
            [ -f "dist/index.js" ] && echo "   ✅ brain built (Brain console: node dist/serve.js → http://127.0.0.1:8767)" || echo "   💡 Try: cd MCP-servers/brain && npm install && npm run build"
        else
            echo "   ✅ brain already built"
        fi
    fi
    cd - > /dev/null
fi

# 2.82 Build Vodou-channels (Telegram, Slack, Discord, Web MCP)
if [ -d "MCP-servers/Vodou-channels" ] && command -v npm &> /dev/null; then
    echo ""
    echo "📡 Building Vodou-channels..."
    cd MCP-servers/Vodou-channels
    if [ -f "package.json" ]; then
        [ ! -d "node_modules" ] && echo "   📦 Installing dependencies..." && npm install --progress 2>&1 | tail -3
        if [ ! -f "dist/index.js" ]; then
            echo "   🔨 Building Vodou-channels..."
            npm run build 2>&1 | tail -5
            [ -f "dist/index.js" ] && echo "   ✅ Vodou-channels built" || echo "   💡 Try: cd MCP-servers/Vodou-channels && npm install && npm run build"
        else
            echo "   ✅ Vodou-channels already built"
        fi
    fi
    # Build channel packages monorepo (sdk + 10 per-channel packages)
    if [ -d "packages" ] && [ -f "packages/package.json" ]; then
        echo "   📦 Building channel packages..."
        cd packages
        [ ! -d "node_modules" ] && npm install --silent 2>&1 | tail -3
        npm run build --workspaces --if-present 2>&1 | grep -E "error|✅|built" | head -5
        cd - > /dev/null
        echo "   ✅ Channel packages built"
    fi
    cd - > /dev/null
fi

# 2.82b Bootstrap ~/.vodou/channels/ (pluggable channel install dir)
if [ -d "MCP-servers/Vodou-channels/packages" ] && command -v npm &> /dev/null; then
    CHANNELS_DIR="$HOME/.vodou/channels"
    PACKAGES_DIR="$(pwd)/MCP-servers/Vodou-channels/packages"
    # ALWAYS re-link (NOT gated on package.json existing): npm's file: symlinks bake in
    # an absolute path at link time, so a moved repo or a re-install at a new path leaves
    # the old symlinks dangling → Vodou-channels discovers 0 channels and Slack/Telegram/
    # etc. silently fail. Detect dangling links and re-link to the CURRENT path. Matches
    # install-prebuilt.sh's bootstrap block; idempotent and fast.
    _ch_stale=0
    if [ -d "$CHANNELS_DIR/node_modules/@vodou" ]; then
        for _link in "$CHANNELS_DIR/node_modules/@vodou/"channel-*; do
            [ -e "$_link" ] || { _ch_stale=1; break; }
        done
    else
        _ch_stale=1
    fi
    echo ""
    if [ "$_ch_stale" = "1" ] || [ ! -f "$CHANNELS_DIR/package.json" ]; then
        echo "📦 Bootstrapping ~/.vodou/channels/ (fresh)..."
    else
        echo "📦 Re-linking ~/.vodou/channels/ to current install..."
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
    _ch_broken=0
    for _link in "$CHANNELS_DIR/node_modules/@vodou/"channel-*; do
        [ -e "$_link" ] || _ch_broken=$((_ch_broken + 1))
    done
    if [ "$_ch_broken" -gt 0 ]; then
        echo "   ⚠️  $_ch_broken channel symlink(s) still broken — channels may not load"
    else
        echo "   ✅ Channel packages linked to $PACKAGES_DIR"
    fi
fi

# ============================================================================
# 2.83 Build Vodou-Enhanced-Thinking (TypeScript compilation)
# ============================================================================
if [ -d "MCP-servers/Vodou-Enhanced-Thinking" ] && command -v npm &> /dev/null; then
    echo ""
    echo "🧠 Building Vodou-Enhanced-Thinking..."
    cd MCP-servers/Vodou-Enhanced-Thinking
    if [ -f "package.json" ]; then
        if [ ! -d "node_modules" ]; then
            echo "   📦 Installing Vodou-Enhanced-Thinking dependencies..."
            npm install --progress 2>&1 | tee /tmp/enhanced-thinking-install.log || {
                echo "      ⚠️  npm install failed. Check /tmp/enhanced-thinking-install.log for details"
                cd - > /dev/null
            }
        else
            echo "   ✅ Vodou-Enhanced-Thinking dependencies already installed"
        fi
        if [ ! -f "dist/index.js" ]; then
            echo "   🔨 Building Vodou-Enhanced-Thinking (TypeScript compilation)..."
            npm run build 2>&1 | tee /tmp/enhanced-thinking-build.log || {
                echo "      ⚠️  npm build failed. Check /tmp/enhanced-thinking-build.log for details"
                cd - > /dev/null
            }
            if [ $? -eq 0 ] && [ -f "dist/index.js" ]; then
                echo "      ✅ Vodou-Enhanced-Thinking built successfully"
            else
                echo "      ⚠️  Build completed but dist/index.js not found"
                echo "      💡 Try running manually: cd MCP-servers/Vodou-Enhanced-Thinking && npm install && npm run build"
            fi
        else
            echo "   ✅ Vodou-Enhanced-Thinking already built (dist/index.js exists)"
        fi
    else
        echo "   ⚠️  package.json not found in Vodou-Enhanced-Thinking"
    fi
    cd - > /dev/null
elif [ -d "MCP-servers/Vodou-Enhanced-Thinking" ]; then
    echo ""
    echo "🧠 Vodou-Enhanced-Thinking found but Node.js/npm not available"
    echo "   Install Node.js to build Vodou-Enhanced-Thinking"
fi

# ============================================================================
# 2.84 Build Vodou-script-executor (TypeScript compilation)
# ============================================================================
if [ -d "MCP-servers/Vodou-script-executor" ] && command -v npm &> /dev/null; then
    echo ""
    echo "⚙️ Building Vodou-script-executor..."
    cd MCP-servers/Vodou-script-executor
    if [ -f "package.json" ]; then
        if [ ! -d "node_modules" ]; then
            echo "   📦 Installing Vodou-script-executor dependencies..."
            npm install --progress 2>&1 | tee /tmp/script-executor-install.log || {
                echo "      ⚠️  npm install failed. Check /tmp/script-executor-install.log for details"
                cd - > /dev/null
            }
        else
            echo "   ✅ Vodou-script-executor dependencies already installed"
        fi
        if [ ! -f "dist/index.js" ]; then
            echo "   🔨 Building Vodou-script-executor (TypeScript compilation)..."
            npm run build 2>&1 | tee /tmp/script-executor-build.log || {
                echo "      ⚠️  npm build failed. Check /tmp/script-executor-build.log for details"
                cd - > /dev/null
            }
            if [ $? -eq 0 ] && [ -f "dist/index.js" ]; then
                echo "      ✅ Vodou-script-executor built successfully"
            else
                echo "      ⚠️  Build completed but dist/index.js not found"
                echo "      💡 Try running manually: cd MCP-servers/Vodou-script-executor && npm install && npm run build"
            fi
        else
            echo "   ✅ Vodou-script-executor already built (dist/index.js exists)"
        fi
    else
        echo "   ⚠️  package.json not found in Vodou-script-executor"
    fi
    cd - > /dev/null
elif [ -d "MCP-servers/Vodou-script-executor" ]; then
    echo ""
    echo "⚙️ Vodou-script-executor found but Node.js/npm not available"
    echo "   Install Node.js to build Vodou-script-executor"
fi

# ============================================================================
# 2.85 Build Vodou-session-manager (TypeScript compilation)
# ============================================================================
if [ -d "MCP-servers/Vodou-session-manager" ] && command -v npm &> /dev/null; then
    echo ""
    echo "🔧 Building Vodou-session-manager..."
    cd MCP-servers/Vodou-session-manager
    if [ -f "package.json" ]; then
        if [ ! -d "node_modules" ]; then
            echo "   📦 Installing Vodou-session-manager dependencies..."
            npm install --progress 2>&1 | tee /tmp/session-manager-install.log || {
                echo "      ⚠️  npm install failed. Check /tmp/session-manager-install.log for details"
                cd - > /dev/null
            }
        else
            echo "   ✅ Vodou-session-manager dependencies already installed"
        fi
        if [ ! -f "dist/index.js" ]; then
            echo "   🔨 Building Vodou-session-manager (TypeScript compilation)..."
            npm run build 2>&1 | tee /tmp/session-manager-build.log || {
                echo "      ⚠️  npm build failed. Check /tmp/session-manager-build.log for details"
                cd - > /dev/null
            }
            if [ $? -eq 0 ] && [ -f "dist/index.js" ]; then
                echo "      ✅ Vodou-session-manager built successfully"
            else
                echo "      ⚠️  Build completed but dist/index.js not found"
                echo "      💡 Try running manually: cd MCP-servers/Vodou-session-manager && npm install && npm run build"
            fi
        else
            echo "   ✅ Vodou-session-manager already built (dist/index.js exists)"
        fi
    else
        echo "   ⚠️  package.json not found in Vodou-session-manager"
    fi
    cd - > /dev/null
elif [ -d "MCP-servers/Vodou-session-manager" ]; then
    echo ""
    echo "🔧 Vodou-session-manager found but Node.js/npm not available"
    echo "   Install Node.js to build Vodou-session-manager"
fi

# ============================================================================
# 2.9 Install uml-mcp Node.js Dependencies
# ============================================================================
if [ -d "MCP-servers/uml-mcp" ] && command -v node &> /dev/null; then
    if [ -f "MCP-servers/uml-mcp/dist/index.js" ]; then
        echo ""
        echo "📊 uml-mcp ready (pre-built)"
    elif command -v npm &> /dev/null; then
        echo ""
        echo "📊 Building uml-mcp..."
        cd MCP-servers/uml-mcp
        npm install --quiet 2>/dev/null && npm run build 2>/dev/null
        if [ -f "dist/index.js" ]; then
            echo "   ✅ uml-mcp built successfully"
        else
            echo "   ⚠️  uml-mcp build failed — run manually: cd MCP-servers/uml-mcp && npm install && npm run build"
        fi
        cd - > /dev/null
    fi
fi

# ============================================================================
# 2.91 Build dalle (image generation — optional, requires OPENAI_API_KEY)
# ============================================================================
if [ -d "MCP-servers/dalle" ] && command -v npm &> /dev/null; then
    if [ -f "MCP-servers/dalle/dist/index.js" ]; then
        echo ""
        echo "🎨 dalle ready (pre-built)"
    elif [ -f "MCP-servers/dalle/package.json" ]; then
        echo ""
        echo "🎨 Building dalle..."
        cd MCP-servers/dalle
        [ ! -d "node_modules" ] && npm install --quiet 2>/dev/null
        npm run build --silent 2>/dev/null
        [ -f "dist/index.js" ] && echo "   ✅ dalle built" || echo "   ⚠️  dalle build failed — run: cd MCP-servers/dalle && npm install && npm run build"
        cd - > /dev/null
    fi
fi

# ============================================================================
# 3. Check and install Go (if needed, optional - only if mcp-monitor needs building)
# ============================================================================
echo ""
echo "🔍 Checking for mcp-monitor..."
if [ -f "MCP-servers/mcp-monitor/bin/mcp-monitor" ]; then
    echo "   ✅ mcp-monitor binary already exists (Go not needed)"
else
    echo "   ⚠️  mcp-monitor binary not found"
    echo "🔍 Checking for Go..."
    if command -v go &> /dev/null; then
        GO_VERSION=$(go version | awk '{print $3}')
        echo "   ✅ Go found: $GO_VERSION"
    else
        echo "   ⚠️  Go not found (optional - only needed to build mcp-monitor)"
        echo "   💡 mcp-monitor binary is missing. Go is only needed if you want to build it."
        echo "   📥 To install Go (optional):"
        if [[ "$OSTYPE" == "darwin"* ]]; then
            echo "      Download from: https://go.dev/dl/ (fastest, pre-built binary)"
            echo "      Or: brew install go (slower, may compile)"
        else
            echo "      Download from: https://go.dev/dl/"
        fi
        echo "   ⚠️  Skipping mcp-monitor build (requires Go)"
    fi
fi

# ============================================================================
# 4. Build mcp-monitor binary
# ============================================================================
if [ -d "MCP-servers/mcp-monitor" ] && command -v go &> /dev/null; then
    echo ""
    echo "📊 Building mcp-monitor..."
    cd MCP-servers/mcp-monitor
    
    # Check if we have source code or just binary
    if [ -f "main.go" ] || [ -f "go.mod" ]; then
        # We have source, build it
        echo "   🔨 Building mcp-monitor from source..."
        mkdir -p bin
        if go build -o bin/mcp-monitor . 2>/dev/null; then
            chmod +x bin/mcp-monitor 2>/dev/null || true
            echo "   ✅ mcp-monitor built successfully"
        else
            echo "   ⚠️  mcp-monitor build failed (binary may already exist)"
        fi
    elif [ ! -f "bin/mcp-monitor" ]; then
        # No source and no binary - try to clone and build
        # Guard: on macOS, /usr/bin/git is a stub that pops "Install Developer
        # Tools" if CLT aren't installed. Skip the clone if no real git found.
        _git_ok=false
        if [ "$(uname -s)" = "Darwin" ]; then
            for _gp in /Library/Developer/CommandLineTools/usr/bin/git \
                       /usr/local/bin/git /opt/homebrew/bin/git \
                       "/Applications/Xcode.app/Contents/Developer/usr/bin/git"; do
                [ -f "$_gp" ] && _git_ok=true && break
            done
        else
            command -v git &>/dev/null && _git_ok=true
        fi
        if ! $_git_ok; then
            echo "   ⚠️  git not installed — skipping mcp-monitor clone"
        else
        echo "   📥 Source not found, attempting to clone from GitHub..."
        TEMP_DIR="/tmp/mcp-monitor-build-$$"
        if git clone --depth 1 https://github.com/VodouAI/mcp-monitor.git "$TEMP_DIR" 2>/dev/null; then
            cd "$TEMP_DIR"
            mkdir -p "$INSTALL_DIR/MCP-servers/mcp-monitor/bin"
            if go build -o "$INSTALL_DIR/MCP-servers/mcp-monitor/bin/mcp-monitor" . 2>/dev/null; then
                chmod +x "$INSTALL_DIR/MCP-servers/mcp-monitor/bin/mcp-monitor" 2>/dev/null || true
                echo "   ✅ mcp-monitor built and installed successfully"
            fi
            cd - > /dev/null
            rm -rf "$TEMP_DIR"
        else
            echo "   ⚠️  Could not clone mcp-monitor source"
        fi
        fi  # end git available check
    else
        echo "   ✅ mcp-monitor binary already exists"
    fi
    cd - > /dev/null
elif [ -d "MCP-servers/mcp-monitor" ]; then
    echo ""
    echo "📊 mcp-monitor found but Go not available"
    echo "   Install Go to build mcp-monitor if needed"
fi

# ============================================================================
# 5. Initialize workspace from templates (if fresh install)
# ============================================================================
echo ""
echo "📂 Setting up workspace..."
WORKSPACE_DIR="$INSTALL_DIR/.vodou/workspace"
TEMPLATES_DIR="$INSTALL_DIR/templates"

if [ -d "$TEMPLATES_DIR" ]; then
    mkdir -p "$WORKSPACE_DIR/memory"
    mkdir -p "$WORKSPACE_DIR/heartbeat-scripts"

    # Copy each template file only if it doesn't already exist in workspace
    for tmpl in "$TEMPLATES_DIR"/*; do
        fname="$(basename "$tmpl")"
        if [ ! -f "$WORKSPACE_DIR/$fname" ]; then
            cp "$tmpl" "$WORKSPACE_DIR/$fname"
            echo "   ✅ Created $fname"
        else
            echo "   ⏭️  $fname already exists (skipped)"
        fi
    done
    echo "   ✅ Workspace ready at .vodou/workspace/"
else
    echo "   ⚠️  Templates directory not found — workspace files must be created manually"
fi

# Initialize database if it doesn't exist
if [ ! -f "vodou-core.db" ]; then
    echo ""
    echo "💾 Initializing database..."
    ./vodou-core list > /dev/null 2>&1 || echo "   Database will be created on first run"
fi

echo ""
echo "✅ Installation complete!"
echo ""
echo "🎯 Next steps:"
echo ""
echo "1. ⚙️  Add your credentials:"
echo "   Edit .env and add your VODOU_TOKEN and VODOU_USER_ID"
echo "   Get yours at: https://app.vodou.ai"
echo ""
echo "2. 🚀 Quick test:"
echo "   Open Claude Code or Cursor chat and type:  ./do cpu   (./oi / ./vodou are the same script)"
echo ""
echo "3. 🌐 Launch the control panel:"
echo "   http://localhost:8765"
echo "   (Start it with: ./start-vodou-services.sh)"
echo ""
# Auto-run start-vodou-services.sh (no prompt; install often runs in chat/non-interactive)
if [ -f "$INSTALL_DIR/start-vodou-services.sh" ]; then
    echo "🚀 Starting Vodou services..."
    "$INSTALL_DIR/start-vodou-services.sh"
fi

echo "💡 Tip: To install multiple versions, extract each release to a different directory!"
