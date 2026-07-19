#!/usr/bin/env bash
# Publish the Vodou Desktop preview release to the PUBLIC repo VodouAI/vodou-desktop.
# YOU run this (not the agent) — publishing monorepo-built artifacts to a public
# destination is a deliberate, user-triggered action.
#
# Uploads (both already built + audited):
#   - apps/desktop/dist-build/Vodou-0.6.5-arm64.dmg        (ExecDesk-stripped, verified)
#   - apps/desktop/dist-build/vodou-server-bundle.tar.gz   (universal, audited clean)
#
# Usage:  ! bash scripts/publish-desktop-release.sh     (or run in your own terminal)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
REPO="VodouAI/vodou-desktop"
VERSION=$(python3 -c "import json;print(json.load(open('apps/desktop/package.json'))['version'])")
TAG="desktop-v$VERSION"
DMG_ARM="apps/desktop/dist-build/Vodou-$VERSION-arm64.dmg"   # Apple Silicon
DMG_X64="apps/desktop/dist-build/Vodou-$VERSION-intel.dmg"   # Intel
BUNDLE="apps/desktop/dist-build/vodou-server-bundle.tar.gz"

TOKEN=$(grep -E "^GH_TOKEN=" .env | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d ' ')
[ -z "$TOKEN" ] && { echo "✗ GH_TOKEN not found in .env"; exit 1; }
[ -f "$BUNDLE" ] || { echo "✗ bundle missing: $BUNDLE"; exit 1; }

api() { curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "$@"; }

echo "▸ creating release $TAG on $REPO"
RESP=$(api -X POST "https://api.github.com/repos/$REPO/releases" \
  -d "{\"tag_name\":\"$TAG\",\"name\":\"Vodou Desktop $VERSION (preview)\",\"prerelease\":true,\"target_commitish\":\"main\",\"body\":\"Preview build for macOS (arm64 + Intel). Unsigned: right-click the app -> Open the first time. The universal server bundle downloads automatically on first launch.\"}")
RID=$(printf '%s' "$RESP" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('id') or '')")
if [ -z "$RID" ]; then
  # Maybe it already exists — fetch it.
  RID=$(api "https://api.github.com/repos/$REPO/releases/tags/$TAG" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('id') or '')")
fi
[ -z "$RID" ] && { echo "✗ could not create/find release:"; printf '%s\n' "$RESP" | python3 -m json.tool; exit 1; }
echo "  ✓ release id: $RID"

upload() { # $1=file $2=name $3=content-type  (REPLACES an existing same-named asset)
  [ -f "$1" ] || { echo "  - skip $2 (not built)"; return 0; }
  # GitHub rejects a re-upload of a same-named asset (422). Delete the old one first
  # so re-publishing actually ships the new build.
  local existing_id
  existing_id=$(api "https://api.github.com/repos/$REPO/releases/$RID/assets" \
    | python3 -c "import json,sys;[print(a['id']) for a in json.load(sys.stdin) if a['name']=='$2']" 2>/dev/null | head -1)
  if [ -n "$existing_id" ]; then
    api -X DELETE "https://api.github.com/repos/$REPO/releases/assets/$existing_id" >/dev/null
    echo "  ↻ replaced existing $2"
  fi
  echo "▸ uploading $2 ($(du -h "$1" | cut -f1))"
  code=$(curl -s -o /tmp/upl.json -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: $3" \
    --data-binary @"$1" \
    "https://uploads.github.com/repos/$REPO/releases/$RID/assets?name=$2")
  if [ "$code" = "201" ]; then echo "  ✓ uploaded $2"
  else echo "  ✗ upload failed ($code):"; python3 -m json.tool < /tmp/upl.json 2>/dev/null || cat /tmp/upl.json; fi
}

upload "$DMG_ARM" "Vodou-$VERSION-arm64.dmg"  "application/x-apple-diskimage"
upload "$DMG_X64" "Vodou-$VERSION-intel.dmg"  "application/x-apple-diskimage"
upload "$BUNDLE"  "vodou-server-bundle.tar.gz" "application/gzip"

echo ""
echo "✓ Done. Public release:"
echo "  https://github.com/$REPO/releases/tag/$TAG"
echo "Verify the bundle URL the app uses:"
echo "  curl -sI https://github.com/$REPO/releases/download/$TAG/vodou-server-bundle.tar.gz | head -1"
