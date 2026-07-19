#!/usr/bin/env bash
#
# fetch-llamacpp.sh — download the pinned llama.cpp server into vendor/llamacpp/
# for DEV CHECKOUTS (release bundles ship it via build-release-multi-arch-
# prebuilt.sh). Sibling of scripts/fetch-llmfit.sh; same contract.
#
# NOTE: unlike llmfit, llama.cpp releases do NOT publish per-asset `.sha256`
# sidecars, so the expected hash is PINNED in this script (SHA256 map). Bumping
# the pin = update LLAMACPP_BUILD + the two hashes (download once, `shasum -a
# 256`, paste). Refuses on mismatch; refuses if the host artifact isn't pinned
# (unless VODOU_ALLOW_UNPINNED=1).
#
# The bundled server powers the `llamacpp` provider (Vodou Local). The gateway
# resolves vendor/llamacpp/llama-server → PATH (see src/api/llamacpp.ts).
#
# Usage:  scripts/fetch-llamacpp.sh [--force]
set -euo pipefail

LLAMACPP_BUILD="b9867"
REPO="ggml-org/llama.cpp"

# Pinned SHA256 per artifact (no upstream sidecars). macOS ships bash 3.2 (no
# associative arrays), so this is a plain case. Empty → unpinned (refused by
# default). Add rows when bumping / porting to Linux.
pinned_sha() {
  case "$1" in
    "llama-${LLAMACPP_BUILD}-bin-macos-arm64.tar.gz") echo "8614dce043dcf54150185c6568c0fa092f8cfd2944617aac305e70a8ce1027e3" ;;
    "llama-${LLAMACPP_BUILD}-bin-macos-x64.tar.gz")   echo "040d77e325b879719b746c6467022081adc680b53ce83de118ea11b0d3cee9ad" ;;
    # Linux (pin when the Linux port lands):
    # "llama-${LLAMACPP_BUILD}-bin-ubuntu-x64.tar.gz") echo "" ;;
    *) echo "" ;;
  esac
}

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="$PROJECT_ROOT/vendor/llamacpp"
FORCE="${1:-}"

# ── Resolve host artifact (llama.cpp's release naming) ──
os="$(uname -s)"; arch="$(uname -m)"
case "$os-$arch" in
  Darwin-arm64)  ARTIFACT="llama-${LLAMACPP_BUILD}-bin-macos-arm64.tar.gz" ;;
  Darwin-x86_64) ARTIFACT="llama-${LLAMACPP_BUILD}-bin-macos-x64.tar.gz" ;;
  Linux-x86_64)  ARTIFACT="llama-${LLAMACPP_BUILD}-bin-ubuntu-x64.tar.gz" ;;
  Linux-aarch64|Linux-arm64) ARTIFACT="llama-${LLAMACPP_BUILD}-bin-ubuntu-arm64.tar.gz" ;;
  *) echo "❌ fetch-llamacpp: unsupported host $os-$arch." >&2; exit 1 ;;
esac

BASE="https://github.com/${REPO}/releases/download/${LLAMACPP_BUILD}"

# ── Idempotency ──
if [ -x "$DEST_DIR/llama-server" ] && [ "$FORCE" != "--force" ]; then
  echo "✅ llama.cpp ${LLAMACPP_BUILD} already present at vendor/llamacpp/ (use --force to re-fetch)"
  exit 0
fi

expected="$(pinned_sha "$ARTIFACT")"
if [ -z "$expected" ] && [ "${VODOU_ALLOW_UNPINNED:-0}" != "1" ]; then
  echo "❌ No pinned sha256 for $ARTIFACT. Add it to SHA256 in this script, or set VODOU_ALLOW_UNPINNED=1 to bypass (not recommended)." >&2
  exit 1
fi

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
echo "📥 Downloading $ARTIFACT ..."
curl -fsSL "$BASE/$ARTIFACT" -o "$tmp/$ARTIFACT"

if command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$tmp/$ARTIFACT" | awk '{print $1}')"
else
  actual="$(sha256sum "$tmp/$ARTIFACT" | awk '{print $1}')"
fi

if [ -n "$expected" ]; then
  if [ "$expected" != "$actual" ]; then
    echo "❌ sha256 mismatch for $ARTIFACT" >&2
    echo "   expected: $expected" >&2
    echo "   actual:   $actual" >&2
    exit 1
  fi
  echo "🔐 sha256 verified."
else
  echo "⚠️  UNPINNED (VODOU_ALLOW_UNPINNED=1). Computed sha256: $actual"
  echo "    → paste this into the SHA256 map to pin it."
fi

# ── Extract (layout: llama-<build>/{llama-server, libggml*.dylib, libllama*.dylib, ...}) ──
rm -rf "$DEST_DIR"; mkdir -p "$DEST_DIR"
tar -xzf "$tmp/$ARTIFACT" -C "$DEST_DIR" --strip-components=1
# Server subset: drop the other tool executables; KEEP every dylib (llama-server's
# @rpath closure lives beside it). Reclaims most of the ~27→22 MB trim safely.
find "$DEST_DIR" -maxdepth 1 -type f -name 'llama-*' ! -name 'llama-server' -delete 2>/dev/null || true
chmod +x "$DEST_DIR/llama-server" 2>/dev/null || true

if [ ! -x "$DEST_DIR/llama-server" ]; then
  echo "❌ extraction did not yield an executable llama-server" >&2
  exit 1
fi
echo "✅ llama.cpp ${LLAMACPP_BUILD} installed to vendor/llamacpp/ (server + dylibs)"
