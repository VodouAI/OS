#!/usr/bin/env bash
# Build the Vodou Desktop installer.
#
# Stages the Tier-1 runtime (vodou-core + ONNX dylib + gateway + MiniLM embedder)
# into apps/desktop/resources, then runs electron-builder.
# Rerankers (Tier 2) are intentionally NOT bundled — jina-turbo lazy-downloads on
# first memory rerank. See PLANS/0.6.5/DO/PLAN-VODOU-DESKTOP.md.
#
# Usage:
#   scripts/build-desktop.sh                      # build for the host (mac-arm64)
#   TARGET=mac-x64 scripts/build-desktop.sh       # Intel macOS
#   TARGET=linux-x64 scripts/build-desktop.sh     # Linux x64 (run on Linux / CI)
#   STAGE_ONLY=1 ...                              # stage resources + compile shell, skip electron-builder
#   SKIP_CARGO=1 ...                              # reuse an existing per-target vodou-core build
#
# Per-target deps the script resolves: vodou-core (per-target cargo build),
# ONNX dylib (.build/onnx-cache or downloaded from Microsoft), Node (downloaded),
# node-pty prebuild (target-matched). Windows is intentionally unsupported (the
# Unix-socket daemon + bash orchestration aren't Windows-native — see the plan).
set -euo pipefail

# ── Locate repo root (this script lives in scripts/) ──────────────────────────
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESK="$ROOT/apps/desktop"
RES="$DESK/resources"
cd "$ROOT"

# ── Target platform resolution ────────────────────────────────────────────────
TARGET="${TARGET:-mac-arm64}"
ORT_VERSION="1.23.0"   # must match the `ort` crate pin (=2.0.0-rc.11) in Cargo.toml
case "$TARGET" in
  mac-arm64) OS=darwin; ARCH=arm64; EXPECT=arm64;  DYLIB_GLOB="libonnxruntime*.dylib"; ONNX_PKG="onnxruntime-osx-arm64-$ORT_VERSION";   NODE_ARCH="darwin-arm64"; RUST_T="aarch64-apple-darwin";     EB_FLAGS="--mac dmg --arm64" ;;
  mac-x64)   OS=darwin; ARCH=x64;   EXPECT=x86_64; DYLIB_GLOB="libonnxruntime*.dylib"; ONNX_PKG="onnxruntime-osx-x86_64-$ORT_VERSION"; NODE_ARCH="darwin-x64";   RUST_T="x86_64-apple-darwin";       EB_FLAGS="--mac dmg --x64" ;;
  linux-x64) OS=linux;  ARCH=x64;   EXPECT=x86_64; DYLIB_GLOB="libonnxruntime.so*";    ONNX_PKG="onnxruntime-linux-x64-$ORT_VERSION";  NODE_ARCH="linux-x64";    RUST_T="x86_64-unknown-linux-gnu";  EB_FLAGS="--linux AppImage --x64" ;;
  *) echo "✗ unknown TARGET=$TARGET (use mac-arm64 | mac-x64 | linux-x64)" >&2; exit 1 ;;
esac
# Friendly artifact name: Intel macOS DMG is marked "-intel" (electron-builder would
# otherwise drop the arch suffix on x64). Others keep electron-builder's default arch name.
EB_NAME=""
[ "$TARGET" = "mac-x64" ] && EB_NAME='-c.dmg.artifactName=${productName}-${version}-intel.${ext}'
KEEP_PTY="$NODE_ARCH"   # node-pty prebuild to keep in the bundled gateway (target, not host)
echo "▸ Vodou Desktop build — repo: $ROOT — TARGET=$TARGET"

# ── Never build over running processes (stale binaries serve old code) ────────
pkill -f "vodou-core worker" 2>/dev/null || true
pkill -f "vodou-core daemon" 2>/dev/null || true

# ── 1. Resolve vodou-core for the target (per-target cargo build; verify arch) ─
# Build natively when target OS == host OS (incl. mac arm64→x64 cross-arch, which
# rustup handles). Cross-OS (e.g. linux target on macOS) must be prebuilt elsewhere.
HOST_OS=$([ "$(uname -s)" = "Darwin" ] && echo darwin || echo linux)
if [ "${SKIP_CARGO:-0}" != "1" ] && [ "$OS" = "$HOST_OS" ]; then
  echo "▸ cargo build --release --target $RUST_T"
  cargo build --release --target "$RUST_T"
fi
CORE=""
for c in "target/$RUST_T/release/vodou-core" ".build/target/$RUST_T/release/vodou-core"; do
  [ -f "$ROOT/$c" ] && { CORE="$ROOT/$c"; break; }
done
# Host-native fallbacks only when target == host (arm64 mac dev convenience).
if [ -z "$CORE" ] && [ "$TARGET" = "mac-arm64" ] && [ "$(uname -m)" = "arm64" ]; then
  for c in "vodou-core" "target/release/vodou-core"; do [ -f "$ROOT/$c" ] && { CORE="$ROOT/$c"; break; }; done
fi
[ -n "$CORE" ] && [ -f "$CORE" ] || { echo "✗ vodou-core for $TARGET not found — build it: cargo build --release --target $RUST_T" >&2; exit 1; }
file "$CORE" | grep -q "$EXPECT" || { echo "✗ vodou-core arch mismatch for $TARGET (want $EXPECT): $CORE" >&2; exit 1; }
echo "  ✓ vodou-core: $CORE"

# ── 2. Stage resources ────────────────────────────────────────────────────────
echo "▸ staging resources → $RES"
rm -rf "$RES"
mkdir -p "$RES/bin" "$RES/fastembed_cache" "$RES/gateway" "$RES/scripts"

# Tier 1: core binary
cp "$CORE" "$RES/bin/vodou-core"
chmod +x "$RES/bin/vodou-core"

# Tier 1: mandatory ONNX dylib (per-target). Source order: onnx-cache → repo's
# onnxruntime/lib (host arch) → download the official Microsoft build (v$ORT_VERSION).
ORT_SRC=""
for d in "$ROOT/.build/onnx-cache/$ONNX_PKG/lib" "$ROOT/onnxruntime/lib"; do
  if compgen -G "$d/$DYLIB_GLOB" >/dev/null 2>&1; then
    # Pick the real (non-symlink) versioned lib so `file` reports the true arch.
    _anylib="$(find "$d" -maxdepth 1 -type f -name 'libonnxruntime*' 2>/dev/null | head -1)"
    [ -z "$_anylib" ] && _anylib="$(find "$d" -maxdepth 1 -name 'libonnxruntime*' 2>/dev/null | head -1)"
    if [ -n "$_anylib" ] && file "$_anylib" | grep -q "$EXPECT"; then ORT_SRC="$d"; break; fi
  fi
done
if [ -z "$ORT_SRC" ]; then
  echo "  ▸ fetching ONNX Runtime v$ORT_VERSION for $TARGET (Microsoft release)"
  mkdir -p "$ROOT/.build/onnx-cache"
  curl -fsSL "https://github.com/microsoft/onnxruntime/releases/download/v$ORT_VERSION/$ONNX_PKG.tgz" -o /tmp/onnx-$TARGET.tgz
  tar -xzf /tmp/onnx-$TARGET.tgz -C "$ROOT/.build/onnx-cache"
  ORT_SRC="$ROOT/.build/onnx-cache/$ONNX_PKG/lib"
fi
compgen -G "$ORT_SRC/$DYLIB_GLOB" >/dev/null 2>&1 || { echo "  ✗ ONNX dylib not found for $TARGET" >&2; exit 1; }
cp -P "$ORT_SRC"/$DYLIB_GLOB "$RES/bin/" 2>/dev/null || true
echo "  ✓ ONNX dylib staged ($ORT_SRC)"

# Tier 1: MiniLM (intent/skill) + bge-small (memory) — offline first-boot
MINILM="$ROOT/.fastembed_cache/models--Xenova--all-MiniLM-L6-v2"
BGE="$ROOT/.fastembed_cache/models--Qdrant--bge-small-en-v1.5-onnx-Q"
if [ -d "$MINILM" ]; then
  cp -R "$MINILM" "$RES/fastembed_cache/"
  echo "  ✓ MiniLM embedder staged (~23MB)"
else
  echo "  ⚠ MiniLM cache not found at $MINILM — first boot will download it" >&2
fi
if [ -d "$BGE" ]; then
  cp -R "$BGE" "$RES/fastembed_cache/"
  echo "  ✓ bge-small memory embedder staged (~64MB)"
else
  echo "  ⚠ bge-small cache not found at $BGE — fresh installs need it offline" >&2
fi
# NOTE: rerankers (bge ~1.1GB / jina ~146MB) are NOT staged — Tier 2 lazy-download.

# ── 3. Bundle Node 24 + the gateway ────────────────────────────────────────────
# The gateway imports `node:sqlite` (Node 22.5+ built-in) and node-pty (ships
# prebuilds). Bun lacks node:sqlite and Electron's embedded Node is 20 — so we
# bundle the official, self-contained Node 24 binary. See PLAN "Backend bundling".
NODE_VERSION="${NODE_VERSION:-v24.16.0}"
# NODE_ARCH is the TARGET's arch (set in target resolution), not the host's —
# so an Intel DMG built on Apple Silicon bundles darwin-x64 Node, etc.
NODE_BINREL="bin/node"

echo "▸ bundling Node $NODE_VERSION ($NODE_ARCH)"
NODE_CACHE="$ROOT/.build/node-$NODE_VERSION-$NODE_ARCH"
if [ ! -f "$NODE_CACHE/$NODE_BINREL" ]; then
  mkdir -p "$NODE_CACHE"
  if [ "$NODE_ARCH" = "win-x64" ]; then
    curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-win-x64.zip" -o /tmp/node-dl.zip
    unzip -qo /tmp/node-dl.zip -d "$NODE_CACHE.unz" && cp "$NODE_CACHE.unz"/*/node.exe "$NODE_CACHE/"
  else
    curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-$NODE_ARCH.tar.gz" -o /tmp/node-dl.tgz
    mkdir -p "$NODE_CACHE.unz" && tar -xzf /tmp/node-dl.tgz -C "$NODE_CACHE.unz"
    cp "$NODE_CACHE.unz"/*/bin/node "$NODE_CACHE/bin/node" 2>/dev/null || { mkdir -p "$NODE_CACHE/bin"; cp "$NODE_CACHE.unz"/*/bin/node "$NODE_CACHE/bin/node"; }
  fi
fi
cp "$NODE_CACHE/$NODE_BINREL" "$RES/bin/$(basename "$NODE_BINREL")"
chmod +x "$RES/bin/$(basename "$NODE_BINREL")"
echo "  ✓ Node bundled (self-contained, node:sqlite flag-free)"

GW="$ROOT/MCP-servers/Vodou-Console"
echo "▸ building gateway"
( cd "$GW" && npm run build )
echo "  ▸ staging gateway dist + node_modules → resources/gateway"
mkdir -p "$RES/gateway"
cp -R "$GW/dist" "$RES/gateway/"
# REQUIRED: the console frontend (index.html, css, js, data, uploads). The gateway
# serves static from ../public — without it, /health works but pages render BLANK.
cp -R "$GW/public" "$RES/gateway/"
# MCP integration preset templates (small; silences the "presets dir not found" warning).
[ -d "$GW/presets" ] && cp -R "$GW/presets" "$RES/gateway/"
cp "$GW/package.json" "$RES/gateway/"
[ -f "$GW/package-lock.json" ] && cp "$GW/package-lock.json" "$RES/gateway/"
# Reuse the installed node_modules (node-pty ships in-package prebuilds; no native
# sqlite addon — node:sqlite is built in), then trim to shrink the bundle:
cp -R "$GW/node_modules" "$RES/gateway/"
#  (a) drop dev dependencies (189M → ~107M)
( cd "$RES/gateway" && npm prune --omit=dev >/dev/null 2>&1 || true )
#  (b) strip node-pty prebuilds for platforms other than the TARGET (~107M → ~55M)
PTY_PREBUILDS="$RES/gateway/node_modules/node-pty/prebuilds"
if [ -d "$PTY_PREBUILDS" ]; then
  find "$PTY_PREBUILDS" -mindepth 1 -maxdepth 1 -type d ! -name "$KEEP_PTY" -exec rm -rf {} + 2>/dev/null || true
  echo "  ✓ kept node-pty prebuild: $KEEP_PTY"
fi
echo "  ✓ gateway staged ($(du -sh "$RES/gateway" 2>/dev/null | cut -f1))"

# ── 3b. Strip ExecDesk product IP (proprietary SMB surface) from the open-core gateway ──
# Removes the orchestrator + product UI/CSS + its route mount. Benign name-references in
# shared files are intentionally left (decision: IP-out is the bar). See
# PLANS/0.6.5/PLAN-OPEN-SOURCE-READINESS.md.
echo "▸ stripping ExecDesk product IP from gateway"
GWP="$RES/gateway"
rm -f "$GWP/public/js/views/execdesk.js" "$GWP/public/js/views/execdesk-approval.js" \
      "$GWP/public/js/shell/execdesk-init.js" "$GWP/public/css/06-execdesk.css" \
      "$GWP/dist/api/exec.js" "$GWP/dist/api/exec.js.map"
# Remove ExecDesk markup from index.html (nav blocks, script tags, css link, comments).
perl -0777 -i -pe '
  s{<a\b[^>]*nav-execdesk-only[^>]*>.*?</a>\s*}{}gs;
  s{<script\b[^>]*execdesk[^>]*></script>\s*}{}gi;
  s{<link\b[^>]*execdesk[^>]*>\s*}{}gi;
  s{<!--[^>]*ExecDesk[^>]*-->\s*}{}gi;
' "$GWP/public/index.html"
# Drop the router import + mount (execRouter appears only on those two lines).
perl -ni -e 'print unless /execRouter/' "$GWP/dist/index.js"
# Hard verify: product files gone, router unmounted, JS still valid.
for f in dist/api/exec.js public/js/views/execdesk.js public/js/views/execdesk-approval.js \
         public/js/shell/execdesk-init.js public/css/06-execdesk.css; do
  [ -e "$GWP/$f" ] && { echo "✗ ExecDesk IP strip failed: $f survived" >&2; exit 1; }
done
grep -q "execRouter" "$GWP/dist/index.js" && { echo "✗ ExecDesk router still referenced in index.js" >&2; exit 1; }
node --check "$GWP/dist/index.js" || { echo "✗ gateway index.js broke after ExecDesk strip" >&2; exit 1; }
echo "  ✓ ExecDesk product IP stripped (orchestrator + UI removed; gateway still valid)"

# ── 3c. License set (hybrid) ──────────────────────────────────────────────────
# The DMG ships the proprietary vodou-core binary AND the Apache-2.0 gateway
# surface, so LICENSE + LICENSE-APACHE + NOTICE + LICENSING.md + EULA.md ride
# along. Fail closed — see LICENSING.md §1.
for LIC in LICENSE LICENSE-APACHE NOTICE LICENSING.md EULA.md; do
  [ -f "$ROOT/$LIC" ] || { echo "✗ $LIC missing from repo root — refusing to ship DMG without it" >&2; exit 1; }
  cp "$ROOT/$LIC" "$RES/"
done
echo "  ✓ license set staged (LICENSE, LICENSE-APACHE, NOTICE, LICENSING.md, EULA.md)"

# ── 4. Icons (best-effort; never block the build) ─────────────────────────────
ICON_SRC="$ROOT/app-vodou-ai/public/vodou-512.png"
if [ -f "$ICON_SRC" ]; then
  cp "$ICON_SRC" "$DESK/assets/icon.png"
  cp "$ICON_SRC" "$DESK/assets/trayTemplate.png"
  if [ "$OS" = "darwin" ] && [ "$(uname -s)" = "Darwin" ] && command -v iconutil >/dev/null 2>&1; then
    ICONSET="$(mktemp -d)/icon.iconset"; mkdir -p "$ICONSET"
    for s in 16 32 64 128 256 512; do
      sips -z $s $s "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null 2>&1 || true
      sips -z $((s*2)) $((s*2)) "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null 2>&1 || true
    done
    iconutil -c icns "$ICONSET" -o "$DESK/assets/icon.icns" 2>/dev/null && echo "  ✓ icon.icns generated" || echo "  ⚠ icns generation failed"
  fi
else
  echo "  ⚠ icon source not found ($ICON_SRC) — using electron default" >&2
fi

# ── 4b. Build-id stamp ────────────────────────────────────────────────────────
# A content hash of the runtime (vodou-core + gateway) written into the bundle.
# On launch, vodou-home compares it to the installed ~/.vodou/bin/.build-id and
# re-provisions when it differs — so a new DMG applies even at the SAME version
# (no `rm -rf ~/.vodou` needed). It rides along in bin/ (already provisioned).
BUILD_ID=$(
  {
    shasum -a 256 "$RES/bin/vodou-core" 2>/dev/null
    find "$RES/gateway/public" "$RES/gateway/dist" -type f -exec shasum -a 256 {} + 2>/dev/null
  } | shasum -a 256 | cut -c1-16
)
echo "$BUILD_ID" > "$RES/bin/.build-id"
echo "  ✓ build-id: $BUILD_ID"

# ── 5. Package ────────────────────────────────────────────────────────────────
cd "$DESK"
[ -d node_modules ] || npm install
npm run build   # compile the Electron shell (TS → dist)
if [ "${STAGE_ONLY:-0}" = "1" ]; then
  echo "✓ Staged resources + compiled shell for $TARGET (STAGE_ONLY). Skipping electron-builder."
else
  EB_ARGS=($EB_FLAGS)
  [ -n "$EB_NAME" ] && EB_ARGS+=("$EB_NAME")                         # Intel → -intel.dmg
  [ "${PUBLISH:-0}" = "1" ] && EB_ARGS+=("--publish" "always")       # CI → VodouAI/vodou-desktop
  echo "▸ electron-builder ${EB_ARGS[*]}"
  CSC_IDENTITY_AUTO_DISCOVERY="${CSC_IDENTITY_AUTO_DISCOVERY:-false}" npx electron-builder "${EB_ARGS[@]}"
  echo "✓ Done ($TARGET). Installer(s) in $DESK/dist-build/"
fi
