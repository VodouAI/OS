#!/usr/bin/env bash
# Pack the Chrome Web Store edition of Vodou Bridge.
# Usage: ./scripts/pack-vodou-bridge-store.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/extension/Store-vodou-bridge"
OUT_DIR="$ROOT/dist"
VERSION="$(python3 -c "import json; print(json.load(open('$SRC/manifest.json'))['version'])")"
OUT_ZIP="$OUT_DIR/vodou-bridge-${VERSION}-store.zip"

mkdir -p "$OUT_DIR"
rm -f "$OUT_ZIP"

# Stage a clean tree (no tests, no icon builder, no DS_Store)
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
rsync -a \
  --exclude 'test' \
  --exclude 'store-assets' \
  --exclude 'build-icons.mjs' \
  --exclude '.DS_Store' \
  --exclude '*.map' \
  "$SRC/" "$STAGE/Store-vodou-bridge/"

# Hard fail if a store zip would still contain remote-code patterns
if rg -q 'new Function|runUserScript' "$STAGE/Store-vodou-bridge/background.js"; then
  echo "ERROR: store background.js still contains remote-code patterns" >&2
  exit 1
fi
if rg -q '<all_urls>' "$STAGE/Store-vodou-bridge/manifest.json"; then
  echo "ERROR: store manifest still has <all_urls>" >&2
  exit 1
fi

(
  cd "$STAGE"
  zip -r -q "$OUT_ZIP" Store-vodou-bridge \
    -x '*.DS_Store' -x '*/test/*' -x '*/build-icons.mjs'
)

echo "Wrote $OUT_ZIP"
unzip -l "$OUT_ZIP" | head -40
