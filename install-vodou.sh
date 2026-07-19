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
# Two-source, open-core install: the OPEN tree (servers/scripts/installer, MIT)
# comes from VodouAI/OS; the proprietary ENGINE binaries (EULA) come from
# VodouAI/vodou-core Releases and are sha256-verified by fetch-engine.sh.
OS_REPO="VodouAI/OS"              # open tree (MIT)
CORE_REPO="VodouAI/vodou-core"    # engine binaries (proprietary, EULA)
VERSION="${VODOU_VERSION:-latest}"
INSTALL_DIR="${VODOU_INSTALL_DIR:-$PWD/vodou}"
DEBUG="${DEBUG:-0}"

# Run mode: "in-tree" when invoked from a checked-out OS clone (siblings present),
# else "bootstrap" (curl | bash — nothing local yet, fetch the open tree first).
SCRIPT_SRC="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SRC")" 2>/dev/null && pwd || true)"
if [ -n "${SCRIPT_DIR:-}" ] && [ -f "$SCRIPT_DIR/install-prebuilt.sh" ] && [ -f "$SCRIPT_DIR/fetch-engine.sh" ]; then
    RUN_MODE="in-tree"
else
    RUN_MODE="bootstrap"
fi

dbg() { [ "$DEBUG" = "1" ] && echo "  [DEBUG] $*" || true; }

normalize_version() {
    # Accept both "0.5.46" and "v0.5.46"
    echo "$1" | sed 's/^v//'
}

resolve_latest_version() {
    local latest_tag
    # The engine version is authoritative — resolve "latest" from vodou-core.
    latest_tag=$(curl -fsSL "https://api.github.com/repos/${CORE_REPO}/releases/latest" | sed -n 's/.*"tag_name":[[:space:]]*"\(v[^"]*\)".*/\1/p' | head -n 1)
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
    Darwin) OS_NAME="macOS" ;;
    Linux)  OS_NAME="Linux" ;;
    *)
        echo "Unsupported OS: $OS"
        echo "Vodou supports macOS and Linux here. For Windows, use install-vodou.ps1:"
        echo "  irm https://raw.githubusercontent.com/${OS_REPO}/main/install-vodou.ps1 | iex"
        exit 1
        ;;
esac

# ── Detect architecture ──────────────────────────────────────
# ARCH_LABEL is display-only; fetch-engine.sh does its own os/arch→asset mapping.
ARCH="$(uname -m)"
case "$ARCH" in
    arm64|aarch64)
        ARCH_NAME="arm64"
        [ "$OS" = "Darwin" ] && ARCH_LABEL="Apple Silicon" || ARCH_LABEL="ARM64"
        ;;
    x86_64)
        ARCH_NAME="intel"
        [ "$OS" = "Darwin" ] && ARCH_LABEL="Intel" || ARCH_LABEL="x86_64"
        ;;
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

# ── Resolve the open tree + install location ──────────────────
# in-tree:   we're already inside an OS clone → install in place.
# bootstrap: download the open tree from VodouAI/OS into INSTALL_DIR first.
if [ "$RUN_MODE" = "in-tree" ]; then
    TREE="$SCRIPT_DIR"
    INSTALL_DIR="$SCRIPT_DIR"
    echo "Installing in place: $TREE"
else
    if [ -f "$INSTALL_DIR/vodou-core" ] || [ -f "$INSTALL_DIR/install-prebuilt.sh" ]; then
        echo "Vodou already present at $INSTALL_DIR"
        echo "To reinstall, remove it first: rm -rf $INSTALL_DIR"
        echo "Or set a different path: VODOU_INSTALL_DIR=~/vodou2 bash install-vodou.sh"
        exit 1
    fi
    TREE="$INSTALL_DIR"
    echo "Downloading Vodou open tree from ${OS_REPO}..."
    TEMP_DIR=$(mktemp -d)
    trap 'rm -rf "$TEMP_DIR"' EXIT
    OS_TARBALL="https://github.com/${OS_REPO}/archive/refs/heads/main.tar.gz"
    dbg "OS tree URL: $OS_TARBALL"
    if ! curl -fsSL "$OS_TARBALL" -o "$TEMP_DIR/os.tar.gz"; then
        echo ""
        echo "Failed to download the open tree from ${OS_REPO}."
        echo "  - No internet connection, or GitHub is down"
        echo "  - Try: https://github.com/${OS_REPO}"
        exit 1
    fi
    mkdir -p "$INSTALL_DIR"
    tar -xzf "$TEMP_DIR/os.tar.gz" -C "$INSTALL_DIR" --strip-components=1
    if [ ! -f "$INSTALL_DIR/fetch-engine.sh" ] || [ ! -f "$INSTALL_DIR/install-prebuilt.sh" ]; then
        echo "Open tree incomplete after extract (fetch-engine.sh / install-prebuilt.sh missing)."
        exit 1
    fi
    echo "Open tree ready: $INSTALL_DIR"
fi

# ── Fetch + verify the proprietary engine from vodou-core ─────
# fetch-engine.sh pulls the matching-arch engine from CORE_REPO Releases and
# REFUSES to install on a sha256 mismatch — the tamper/corruption guard.
echo ""
echo "Fetching engine v${VERSION} for ${ARCH_LABEL} (sha256-verified)..."
if ! DEBUG="$DEBUG" bash "$TREE/fetch-engine.sh" "$VERSION" "$TREE"; then
    echo ""
    echo "Engine fetch/verify failed."
    echo "  - Is v${VERSION} published on ${CORE_REPO}?  https://github.com/${CORE_REPO}/releases"
    echo "  - A CHECKSUM MISMATCH means the download was corrupted or tampered — do NOT run it."
    exit 1
fi

if [ ! -f "$TREE/vodou-core" ]; then
    echo "Engine missing after fetch — vodou-core not found in $TREE."
    exit 1
fi

# ── Run the prebuilt installer (engine now present + verified) ─
echo ""
echo "Running installer..."
cd "$TREE"
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
