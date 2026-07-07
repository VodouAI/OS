#!/bin/bash

# Vodou Installer — curl | bash entry point
# Usage: curl -fsSL https://raw.githubusercontent.com/VodouAI/OS/main/install-vodou.sh | bash
#
# Options (environment variables):
#   VODOU_INSTALL_DIR=~/my-vodou   # Custom install location (default: ./vodou in current directory)
#   VODOU_VERSION=0.5.37           # Specific version (default: latest)
#   DEBUG=1                        # Verbose output

set -e

# ── Config ────────────────────────────────────────────────────
REPO="VodouAI/OS"
VERSION="${VODOU_VERSION:-latest}"
INSTALL_DIR="${VODOU_INSTALL_DIR:-$PWD/vodou}"
DEBUG="${DEBUG:-0}"

dbg() { [ "$DEBUG" = "1" ] && echo "  [DEBUG] $*" || true; }

normalize_version() {
    # Accept both "0.5.46" and "v0.5.46"
    echo "$1" | sed 's/^v//'
}

resolve_latest_version() {
    local latest_tag
    latest_tag=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | sed -n 's/.*"tag_name":[[:space:]]*"\(v[^"]*\)".*/\1/p' | head -n 1)
    if [ -z "$latest_tag" ]; then
        return 1
    fi
    normalize_version "$latest_tag"
}

# ── Banner ────────────────────────────────────────────────────
# Note: version is resolved later, so we don't print it in the box (the box
# is fixed-width and the version is variable-width).
echo ""
echo "  ╔══════════════════════════════════╗"
echo "  ║         Vodou Installer          ║"
echo "  ║   AI that learns YOU — locally   ║"
echo "  ╚══════════════════════════════════╝"
echo ""

# ── Detect OS ─────────────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
    Darwin) OS_NAME="macOS"; OS_SLUG="macos" ;;
    Linux)  OS_NAME="Linux";  OS_SLUG="linux" ;;
    *)
        echo "Unsupported OS: $OS"
        echo "Vodou supports macOS and Linux. On Windows, use the PowerShell"
        echo "installer:  irm https://raw.githubusercontent.com/VodouAI/OS/main/install-vodou.ps1 | iex"
        exit 1
        ;;
esac

# ── Detect architecture ──────────────────────────────────────
ARCH="$(uname -m)"
if [ "$OS_SLUG" = "macos" ]; then
    case "$ARCH" in
        arm64|aarch64) ARCH_NAME="macos-arm64"; ARCH_LABEL="Apple Silicon" ;;
        x86_64)        ARCH_NAME="macos-intel"; ARCH_LABEL="Intel" ;;
        *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac
else # linux
    case "$ARCH" in
        arm64|aarch64) ARCH_NAME="linux-arm64"; ARCH_LABEL="ARM64" ;;
        x86_64)        ARCH_NAME="linux-x64";   ARCH_LABEL="x86_64" ;;
        *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac
fi

echo "System: $OS_NAME ($ARCH_LABEL)"
echo "Install to: $INSTALL_DIR"
echo ""

# ── Check for curl ────────────────────────────────────────────
if ! command -v curl &> /dev/null; then
    echo "curl is required but not found. Install it first."
    exit 1
fi

# ── Resolve version (latest by default) ───────────────────────
if [ "$VERSION" = "latest" ]; then
    echo "Resolving latest release version..."
    if ! RESOLVED_VERSION=$(resolve_latest_version); then
        echo "Failed to resolve latest release from GitHub."
        echo "Try setting a version manually, for example:"
        echo "  VODOU_VERSION=0.5.46 bash install-vodou.sh"
        exit 1
    fi
    VERSION="$RESOLVED_VERSION"
else
    VERSION=$(normalize_version "$VERSION")
fi

dbg "Resolved version: $VERSION"

# ── Check if already installed ────────────────────────────────
if [ -f "$INSTALL_DIR/vodou-core" ]; then
    echo "Vodou is already installed at $INSTALL_DIR"
    echo "To reinstall, remove it first: rm -rf $INSTALL_DIR"
    echo "Or set a different path: VODOU_INSTALL_DIR=~/vodou2 bash install-vodou.sh"
    exit 1
fi

# ── Download ──────────────────────────────────────────────────
echo "Downloading Vodou v${VERSION} for ${ARCH_LABEL}..."

TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

ARCHIVE_NAME="Vodou-v${VERSION}-prebuilt-${ARCH_NAME}.tar.gz"
URL="https://github.com/${REPO}/releases/download/v${VERSION}/${ARCHIVE_NAME}"
dbg "Download URL: $URL"

download_ok=0
if curl -fsSL --progress-bar "$URL" -o "$TEMP_DIR/vodou.tar.gz"; then
    download_ok=1
elif [ "$OS_SLUG" = "macos" ]; then
    # Fallback for releases <= 0.6.13 which used bare arm64/intel (no macos- prefix).
    LEGACY_NAME="Vodou-v${VERSION}-prebuilt-$([ "$ARCH_NAME" = "macos-arm64" ] && echo arm64 || echo intel).tar.gz"
    LEGACY_URL="https://github.com/${REPO}/releases/download/v${VERSION}/${LEGACY_NAME}"
    dbg "Trying legacy URL: $LEGACY_URL"
    if curl -fsSL --progress-bar "$LEGACY_URL" -o "$TEMP_DIR/vodou.tar.gz"; then
        download_ok=1; ARCHIVE_NAME="$LEGACY_NAME"; URL="$LEGACY_URL"
    fi
fi

if [ "$download_ok" -ne 1 ]; then
    echo ""
    echo "Download failed."
    echo ""
    echo "Tried archive: $ARCHIVE_NAME"
    echo "URL:           $URL"
    echo ""
    echo "Possible causes:"
    echo "  - Version v${VERSION} doesn't exist yet"
    echo "  - Assets are not attached to the release"
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

if [ ! -f "$INSTALL_DIR/vodou-core" ]; then
    echo "Extraction failed — vodou-core binary not found."
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
echo "Vodou is running — onboarding should have opened in your browser."
echo "If it didn't, go to: http://localhost:8765"
echo ""
echo "Onboarding walks you through the rest (credentials, first run)."
echo ""
echo "Manage Vodou anytime:"
echo "  Start:  cd $INSTALL_DIR && ./start-vodou-services.sh"
echo "  Stop:   cd $INSTALL_DIR && ./stop-vodou-services.sh"
echo ""
