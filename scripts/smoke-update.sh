#!/usr/bin/env bash
# smoke-update.sh — post-release smoke test for the update pipeline.
# Validates: API returns the right version + checksum, archive downloads,
# checksum matches, extracts cleanly, binary reports the expected version.
# Runs in /tmp isolation — does NOT touch the local install.
#
# Usage: bash scripts/smoke-update.sh           # validates Cargo.toml version
#        bash scripts/smoke-update.sh 0.5.85    # validates a specific version
# Exits non-zero on any stage failure (with which stage failed).
set -euo pipefail

VERSION="${1:-$(grep '^version = ' Cargo.toml | head -1 | sed 's/version = "//;s/"//')}"
ARCH="${ARCH:-arm64}"           # override: ARCH=intel
[ "$(uname -m)" = "x86_64" ] && ARCH=intel
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fail() { echo "❌ stage $1 failed: $2" >&2; exit "$1"; }

echo "🔍 smoke-update v${VERSION} (${ARCH})"
# 1. API check
JSON=$(curl -fsSL "https://app.vodou.ai/api/version/check?version=0.0.1&platform=macos-${ARCH}&architecture=${ARCH}&user_id=smoke" 2>/dev/null) || fail 1 "API unreachable"
API_VER=$(echo "$JSON" | /usr/bin/python3 -c "import sys,json;print(json.load(sys.stdin)['data']['latest_version'])") || fail 1 "API JSON malformed"
API_SHA=$(echo "$JSON" | /usr/bin/python3 -c "import sys,json;print(json.load(sys.stdin)['data']['checksum_sha256'])")
URL=$(echo "$JSON" | /usr/bin/python3 -c "import sys,json;print(json.load(sys.stdin)['data']['download_url'])")
[ "$API_VER" = "$VERSION" ] || fail 1 "API says latest=$API_VER, expected $VERSION"
# 2. Download
curl -fsSL "$URL" -o "$TMP/a.tgz" || fail 2 "download failed: $URL"
# 3. Checksum
LOCAL_SHA=$(shasum -a 256 "$TMP/a.tgz" | cut -d' ' -f1)
[ "$LOCAL_SHA" = "$API_SHA" ] || fail 3 "checksum mismatch: got $LOCAL_SHA, expected $API_SHA"
# 4. Extract
tar -xzf "$TMP/a.tgz" -C "$TMP" || fail 4 "tar extract failed"
ROOT=$(find "$TMP" -maxdepth 2 -name vodou-core -type f -print -quit) || fail 4 "no vodou-core in archive"
[ -n "$ROOT" ] || fail 4 "vodou-core binary missing from tarball"
DIR=$(dirname "$ROOT")
# 5. Binary version + arch
"$ROOT" version 2>&1 | head -1 | grep -q "v${VERSION}" || fail 5 "binary reports wrong version: $("$ROOT" version | head -1)"
file "$ROOT" | grep -qi "$([ "$ARCH" = "arm64" ] && echo arm64 || echo x86_64)" || fail 5 "binary arch mismatch for $ARCH"
# 6. Manifest
[ -f "$DIR/update-manifest.json" ] && grep -q "\"version\":[[:space:]]*\"${VERSION}\"" "$DIR/update-manifest.json" || fail 6 "update-manifest.json missing or wrong version"
# 7. Installer present + executable
[ -x "$DIR/install-prebuilt.sh" ] || fail 7 "install-prebuilt.sh missing or not +x"
# 8. Shipped DB has no user data
SC=$(sqlite3 "$DIR/vodou-core.db" "SELECT COUNT(*) FROM server_credentials;" 2>/dev/null || echo 0)
[ "$SC" = "0" ] || fail 8 "vodou-core.db ships with $SC server_credentials rows"
echo "✅ smoke-update v${VERSION} ${ARCH} — all 8 stages passed"
