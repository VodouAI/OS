#!/usr/bin/env bash
#
# fetch-llmfit.sh — download the pinned llmfit binary into vendor/llmfit/ for
# DEV CHECKOUTS (release bundles already ship it via build-release-multi-arch-
# prebuilt.sh). This is NOT `curl | sh`: it downloads a versioned release
# artifact AND its published .sha256, verifies the hash, and refuses on
# mismatch. Nothing is executed during install.
#
# The gateway (Vodou-Console/src/api/system.ts) resolves llmfit as
#   PATH → vendor/llmfit/llmfit → not-available
# so on a dev box you can EITHER `brew install llmfit` (freshest model DB) OR
# run this script. If neither is present the /api/system/model-fit endpoint
# simply reports available:false and the UI falls back to static text.
#
# Pin lives here + in build-release-multi-arch-prebuilt.sh (LLMFIT_VERSION).
# Bumping is one "bump vendored binaries" playbook step; keep the two in sync.
#
# Usage:  scripts/fetch-llmfit.sh [--force]
set -euo pipefail

LLMFIT_VERSION="0.9.37"
REPO="AlexsJones/llmfit"

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="$PROJECT_ROOT/vendor/llmfit"
FORCE="${1:-}"

# ── Resolve host triple (matches llmfit's release artifact naming) ──
os="$(uname -s)"
arch="$(uname -m)"
case "$os-$arch" in
  Darwin-arm64)        TRIPLE="aarch64-apple-darwin";        EXT="tar.gz" ;;
  Darwin-x86_64)       TRIPLE="x86_64-apple-darwin";         EXT="tar.gz" ;;
  # Linux uses the fully-static musl builds — run on any distro regardless of glibc.
  Linux-x86_64)        TRIPLE="x86_64-unknown-linux-musl";   EXT="tar.gz" ;;
  Linux-aarch64|Linux-arm64) TRIPLE="aarch64-unknown-linux-musl"; EXT="tar.gz" ;;
  *)
    echo "❌ fetch-llmfit: unsupported host $os-$arch. Install manually or 'brew install llmfit'." >&2
    exit 1
    ;;
esac

ASSET="llmfit-v${LLMFIT_VERSION}-${TRIPLE}.${EXT}"
BASE="https://github.com/${REPO}/releases/download/v${LLMFIT_VERSION}"

# ── Idempotency: skip if the pinned binary is already in place ──
if [ -x "$DEST_DIR/llmfit" ] && [ "$FORCE" != "--force" ]; then
  have="$("$DEST_DIR/llmfit" --version 2>/dev/null | awk '{print $2}' || true)"
  if [ "$have" = "$LLMFIT_VERSION" ]; then
    echo "✅ llmfit v${LLMFIT_VERSION} already present at vendor/llmfit/ (use --force to re-fetch)"
    exit 0
  fi
fi

# ── Download artifact + its published sha256 sidecar, verify, refuse on mismatch ──
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "📥 Downloading $ASSET ..."
curl -fsSL "$BASE/$ASSET"         -o "$tmp/$ASSET"
curl -fsSL "$BASE/$ASSET.sha256"  -o "$tmp/$ASSET.sha256"

expected="$(awk '{print $1}' "$tmp/$ASSET.sha256")"
if command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$tmp/$ASSET" | awk '{print $1}')"
else
  actual="$(sha256sum "$tmp/$ASSET" | awk '{print $1}')"
fi

if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "❌ sha256 mismatch for $ASSET" >&2
  echo "   expected: ${expected:-<none>}" >&2
  echo "   actual:   $actual" >&2
  exit 1
fi
echo "🔐 sha256 verified."

# ── Extract (layout: llmfit-vX-<triple>/{llmfit,LICENSE,README.md}) ──
mkdir -p "$DEST_DIR"
tar -xzf "$tmp/$ASSET" -C "$DEST_DIR" --strip-components=1
chmod +x "$DEST_DIR/llmfit"

echo "✅ llmfit v${LLMFIT_VERSION} installed to vendor/llmfit/  ($("$DEST_DIR/llmfit" --version 2>/dev/null || echo 'installed'))"
