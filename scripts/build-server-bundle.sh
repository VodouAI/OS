#!/usr/bin/env bash
# Build the Vodou Desktop MCP "server bundle" — the set of Vodou-native MCP servers
# the desktop app downloads on first run (see PLAN "download-on-first-run").
#
# Produces: apps/desktop/dist-build/vodou-server-bundle-<os>-<arch>.tar.gz
# whose contents overlay onto ~/.vodou:
#   MCP-servers/<server>/{dist,node_modules}
#   start-vodou-services.sh, stop-vodou-services.sh
#
# The desktop downloads this from VODOU_SERVER_BUNDLE_URL (default: a GitHub
# release asset). Host it wherever; for local testing point that env at the file.
#
# Usage: scripts/build-server-bundle.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/apps/desktop/dist-build"
STAGE="$(mktemp -d)/bundle"
cd "$ROOT"

# ONE universal bundle: the servers are pure JS (node:sqlite is built in), the only
# native dep is node-pty which ships prebuilds for every platform — we keep them all.
# fsevents (mac-only, optional) is harmlessly ignored on other OSes. So this single
# tarball runs on mac/win/linux; only the DMG/installer (Node + dylib) is per-platform.
TARBALL="$OUT_DIR/vodou-server-bundle.tar.gz"

# Standard servers: <name> with dist/ + node_modules at the server root.
SERVERS=(
  Vodou-channels
  Vodou-Enhanced-Thinking
  Vodou-LLM-router
  Vodou-Recall
  Vodou-Board
  Vodou-session-manager
  Vodou-script-executor
  vodou-mac-control
)

echo "▸ staging universal server bundle → $STAGE"
mkdir -p "$STAGE/MCP-servers"

prune_node_modules() {
  # $1 = dir containing node_modules. Drop dev deps (incl. native dev build tools
  # like @rollup/rollup-*), but KEEP all node-pty prebuilds so the bundle is universal.
  local d="$1"
  [ -d "$d/node_modules" ] || return 0
  ( cd "$d" && npm prune --omit=dev >/dev/null 2>&1 || true )
}

for s in "${SERVERS[@]}"; do
  SRC="$ROOT/MCP-servers/$s"
  if [ ! -f "$SRC/dist/index.js" ]; then
    echo "  ⚠ skip $s (no dist/index.js — build it first: cd MCP-servers/$s && npm run build)" >&2
    continue
  fi
  DEST="$STAGE/MCP-servers/$s"
  mkdir -p "$DEST"
  cp -R "$SRC/dist" "$DEST/"
  cp "$SRC/package.json" "$DEST/" 2>/dev/null || true
  [ -f "$SRC/package-lock.json" ] && cp "$SRC/package-lock.json" "$DEST/"
  [ -d "$SRC/node_modules" ] && cp -R "$SRC/node_modules" "$DEST/" && prune_node_modules "$DEST"
  echo "  ✓ $s ($(du -sh "$DEST" 2>/dev/null | cut -f1))"
done

# context7 has a nested layout (packages/mcp/dist).
C7="$ROOT/MCP-servers/context7"
if [ -f "$C7/packages/mcp/dist/index.js" ]; then
  mkdir -p "$STAGE/MCP-servers/context7/packages/mcp"
  cp -R "$C7/packages/mcp/dist" "$STAGE/MCP-servers/context7/packages/mcp/"
  cp "$C7/packages/mcp/package.json" "$STAGE/MCP-servers/context7/packages/mcp/" 2>/dev/null || true
  [ -d "$C7/node_modules" ] && cp -R "$C7/node_modules" "$STAGE/MCP-servers/context7/" && prune_node_modules "$STAGE/MCP-servers/context7"
  echo "  ✓ context7"
fi

# Orchestration scripts (optional; the desktop connects servers itself, but ship
# these so a power user can run the full stack from ~/.vodou too).
for f in start-vodou-services.sh stop-vodou-services.sh; do
  [ -f "$ROOT/$f" ] && cp "$ROOT/$f" "$STAGE/"
done

# License set (hybrid): the bundle distributes the Apache-2.0 client surface
# (first-party server dist/), so LICENSE-APACHE + NOTICE must accompany it;
# LICENSE + LICENSING.md carry the map; EULA covers proprietary binaries.
# Vendored servers keep their own licenses inside their dirs.
for LIC in LICENSE LICENSE-APACHE NOTICE LICENSING.md EULA.md; do
  [ -f "$ROOT/$LIC" ] || { echo "✗ $LIC missing from repo root — refusing to pack bundle without it" >&2; exit 1; }
  cp "$ROOT/$LIC" "$STAGE/"
done
echo "  ✓ license set staged (LICENSE, LICENSE-APACHE, NOTICE, LICENSING.md, EULA.md)"

echo "▸ packing $TARBALL"
mkdir -p "$OUT_DIR"
tar -czf "$TARBALL" -C "$STAGE" .
echo "✓ Done — $(du -sh "$TARBALL" | cut -f1): $TARBALL"
echo ""
echo "Universal bundle (runs on mac/win/linux). Host once and set VODOU_SERVER_BUNDLE_URL,"
echo "  or upload as the 'latest' GitHub release asset on VodouAI/vodou-desktop."
echo "Local test:  VODOU_SERVER_BUNDLE_URL=\"$TARBALL\" /Applications/Vodou.app/Contents/MacOS/Vodou"
