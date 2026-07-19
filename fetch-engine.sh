#!/bin/bash
# =============================================================================
# fetch-engine.sh — download the proprietary Vodou engine for THIS platform from
# VodouAI/vodou-core Releases, verify its sha256 against the release manifest,
# and install it beside the open tree. The MIT `OS` repo ships NO engine; this
# bridges to it. Use of the engine is governed by the EULA (bundled in the asset).
#
# Usage: ./fetch-engine.sh <VERSION> [INSTALL_DIR]     (INSTALL_DIR default: .)
# =============================================================================
set -euo pipefail

VERSION="${1:?usage: fetch-engine.sh <VERSION> [INSTALL_DIR]}"; VERSION="${VERSION#v}"
INSTALL_DIR="${2:-.}"
CORE_REPO="VodouAI/vodou-core"
BASE="https://github.com/${CORE_REPO}/releases/download/v${VERSION}"

# --- detect platform → engine label ---
os="$(uname -s)"; arch="$(uname -m)"
case "$os/$arch" in
  Darwin/arm64)  LABEL=macos-arm64 ;;
  Darwin/x86_64) LABEL=macos-intel ;;
  Linux/x86_64)  LABEL=linux-x64 ;;
  Linux/aarch64|Linux/arm64) LABEL=linux-arm64 ;;
  *) case "${OS:-}" in Windows_NT) LABEL=windows-x64 ;; *) echo "unsupported platform: $os/$arch"; exit 1 ;; esac ;;
esac
echo "▸ platform: ${LABEL}  ·  engine v${VERSION}"

need() { command -v "$1" >/dev/null || { echo "required tool missing: $1"; exit 1; }; }
need curl

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# --- manifest: authoritative asset name + sha256 for this arch ---
echo "▸ fetching manifest…"
if ! curl -fsSL "${BASE}/manifest.json" -o "$TMP/manifest.json"; then
  echo "✗ no manifest at ${BASE}/manifest.json — is v${VERSION} published on ${CORE_REPO}?"; exit 1
fi
read -r ASSET WANT_SHA < <(python3 - "$TMP/manifest.json" "$LABEL" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); e=m.get("engines",{}).get(sys.argv[2])
if not e: print(""); sys.exit(0)
print(e["asset"], e["sha256"])
PY
)
[ -z "${ASSET:-}" ] && { echo "✗ no engine for ${LABEL} in the v${VERSION} manifest"; exit 1; }

# --- download + verify (refuse on mismatch) ---
echo "▸ downloading ${ASSET}…"
curl -fSL --progress-bar "${BASE}/${ASSET}" -o "$TMP/$ASSET"
GOT_SHA="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"
if [ "$GOT_SHA" != "$WANT_SHA" ]; then
  echo "✗ CHECKSUM MISMATCH — refusing to install."
  echo "   expected $WANT_SHA"; echo "   got      $GOT_SHA"; exit 1
fi
echo "✓ sha256 verified"

# --- install ---
mkdir -p "$INSTALL_DIR"
tar -xzf "$TMP/$ASSET" -C "$INSTALL_DIR"
chmod +x "$INSTALL_DIR/vodou-core" "$INSTALL_DIR/vodou-hook-bin" 2>/dev/null || true
[ -f "$INSTALL_DIR/vodou-core" ] || [ -f "$INSTALL_DIR/vodou-core.exe" ] || { echo "✗ engine binary missing after extract"; exit 1; }
echo "✅ engine v${VERSION} installed → ${INSTALL_DIR}  (governed by EULA.md)"
