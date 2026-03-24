#!/bin/bash

# Vodou Installer — curl | bash entry point
# Usage: curl -fsSL https://raw.githubusercontent.com/VodouAI/vodou/main/install-vodou.sh | bash
#
# Options (environment variables):
#   VODOU_INSTALL_DIR=~/my-vodou   # Custom install location (default: ~/vodou)
#   VODOU_VERSION=0.5.35           # Specific version (default: latest)
#   DEBUG=1                        # Verbose output

set -e

# ── Config ────────────────────────────────────────────────────
REPO="VodouAI/OS"
VERSION="${VODOU_VERSION:-0.5.35}"
INSTALL_DIR="${VODOU_INSTALL_DIR:-$HOME/vodou}"
DEBUG="${DEBUG:-0}"

dbg() { [ "$DEBUG" = "1" ] && echo "  [DEBUG] $*" || true; }

# ── Banner ────────────────────────────────────────────────────
echo ""
echo "  ╔══════════════════════════════════╗"
echo "  ║     Vodou Installer v${VERSION}      ║"
echo "  ║   AI that learns YOU — locally   ║"
echo "  ╚══════════════════════════════════╝"
echo ""

# ── Detect OS ─────────────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
    Darwin) OS_NAME="macOS" ;;
    Linux)
        echo "Linux support coming soon."
        echo "For now, Vodou runs on macOS (Apple Silicon + Intel)."
        exit 1
        ;;
    *)
        echo "Unsupported OS: $OS"
        echo "Vodou currently supports macOS."
        exit 1
        ;;
esac

# ── Detect architecture ──────────────────────────────────────
ARCH="$(uname -m)"
case "$ARCH" in
    arm64|aarch64) ARCH_NAME="arm64"; ARCH_LABEL="Apple Silicon" ;;
    x86_64)        ARCH_NAME="intel"; ARCH_LABEL="Intel" ;;
    *)
        echo "Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

echo "System: $OS_NAME ($ARCH_LABEL)"
echo "Install to: $INSTALL_DIR"
echo ""

# ── Check for curl ────────────────────────────────────────────
if ! command -v curl &> /dev/null; then
    echo "curl is required but not found. Install it first."
    exit 1
fi

# ── Check if already installed ────────────────────────────────
if [ -f "$INSTALL_DIR/brain-trust4" ]; then
    echo "Vodou is already installed at $INSTALL_DIR"
    echo "To reinstall, remove it first: rm -rf $INSTALL_DIR"
    echo "Or set a different path: VODOU_INSTALL_DIR=~/vodou2 bash install-vodou.sh"
    exit 1
fi

# ── Download ──────────────────────────────────────────────────
ARCHIVE_NAME="OI-v${VERSION}-prebuilt-${ARCH_NAME}.tar.gz"
URL="https://github.com/${REPO}/releases/download/v${VERSION}/${ARCHIVE_NAME}"

echo "Downloading Vodou v${VERSION} for ${ARCH_LABEL}..."
dbg "URL: $URL"

TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

if ! curl -fsSL --progress-bar "$URL" -o "$TEMP_DIR/vodou.tar.gz"; then
    echo ""
    echo "Download failed."
    echo ""
    echo "Possible causes:"
    echo "  - Version v${VERSION} doesn't exist yet"
    echo "  - No internet connection"
    echo "  - GitHub is down"
    echo ""
    echo "Try: https://github.com/${REPO}/releases"
    exit 1
fi

DOWNLOAD_SIZE=$(du -h "$TEMP_DIR/vodou.tar.gz" 2>/dev/null | cut -f1)
echo "Downloaded: $DOWNLOAD_SIZE"

# ── Extract ───────────────────────────────────────────────────
echo "Extracting..."
mkdir -p "$INSTALL_DIR"
tar -xzf "$TEMP_DIR/vodou.tar.gz" -C "$INSTALL_DIR" --strip-components=1

if [ ! -f "$INSTALL_DIR/brain-trust4" ]; then
    echo "Extraction failed — brain-trust4 binary not found."
    echo "The archive may have a different directory structure."
    echo "Try extracting manually: tar -xzf $ARCHIVE_NAME"
    exit 1
fi

echo "Extracted to: $INSTALL_DIR"

# ── Run installer ─────────────────────────────────────────────
echo ""
echo "Running installer..."
cd "$INSTALL_DIR"
DEBUG="$DEBUG" bash install-prebuilt.sh

# ── Add to PATH ───────────────────────────────────────────────
SHELL_PROFILE=""
[ -f "$HOME/.zshrc" ] && SHELL_PROFILE="$HOME/.zshrc"
[ -z "$SHELL_PROFILE" ] && [ -f "$HOME/.bash_profile" ] && SHELL_PROFILE="$HOME/.bash_profile"
[ -z "$SHELL_PROFILE" ] && [ -f "$HOME/.bashrc" ] && SHELL_PROFILE="$HOME/.bashrc"

if [ -n "$SHELL_PROFILE" ]; then
    if ! grep -q "$INSTALL_DIR" "$SHELL_PROFILE" 2>/dev/null; then
        echo "" >> "$SHELL_PROFILE"
        echo "# Vodou" >> "$SHELL_PROFILE"
        echo "export PATH=\"$INSTALL_DIR:\$PATH\"" >> "$SHELL_PROFILE"
        echo ""
        echo "Added $INSTALL_DIR to PATH in $SHELL_PROFILE"
        echo "Run: source $SHELL_PROFILE  (or open a new terminal)"
    fi
fi

# ── Done ──────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════"
echo "  Vodou v${VERSION} installed!"
echo "══════════════════════════════════════"
echo ""
echo "Next steps:"
echo ""
echo "  1. Add your credentials:"
echo "     cd $INSTALL_DIR && nano .env"
echo "     Get OI_TOKEN + OI_USER_ID at: https://app.oios.io"
echo ""
echo "  2. Test it:"
echo "     cd $INSTALL_DIR && ./oi \"hello\""
echo ""
echo "  3. Open the web UI:"
echo "     http://localhost:8765"
echo ""
