#!/usr/bin/env bash
#
# Publish "latest Vodou Bridge" to app.vodou.ai — the record every installed
# gateway reads to decide whether to nudge the user about the extension.
#
# WHEN TO RUN THIS: when the Chrome Web Store listing goes LIVE, NOT when the
# app release is cut. Those are different days. A CWS submission clears review
# on Google's schedule — the manifest version ships inside the app tarball
# immediately, but the extension users can actually install lags by hours or
# days. Publishing the row at app-release time therefore tells every user to
# update to a build that does not exist yet, and the pill they cannot action is
# worse than no pill.
#
# The version is READ FROM the manifest, never typed. A hand-typed version that
# disagrees with the shipped manifest by one digit produces a permanent
# "update available" for users who are already current, and nothing in the
# system would contradict it.
#
# Usage:
#   scripts/publish-extension-version.sh                  # dry run — prints the SQL
#   scripts/publish-extension-version.sh --apply          # execute over SSH
#   scripts/publish-extension-version.sh --min 0.5.97.60  # also set a support floor
#   scripts/publish-extension-version.sh --notes "..."    # release notes (no commas)
#   scripts/publish-extension-version.sh --version 0.5.97.73   # store is BEHIND the
#                                                              # packed manifest
#
# Exit codes: 0 ok · 1 usage/precondition · 2 remote failure

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/extension/Store-vodou-bridge/manifest.json"
# No Desktop/home defaults — those paths are operator-local and must not ship
# as implicit infrastructure. Set before --apply (dry-run does not need them).
PEM="${VODOU_WEB_PEM:-}"
REMOTE="${VODOU_WEB_HOST:-}"
DB="${VODOU_WEB_DB:-/var/www/app.oios.io/backend/database/usage_tracking.db}"
STORE_URL="https://chromewebstore.google.com/detail/vodou-bridge/ehlanbbiaeelnimkakfffehoahimkjjf"

APPLY=0
MIN_SUPPORTED=""
NOTES=""
VERSION_OVERRIDE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --min)   MIN_SUPPORTED="${2:-}"; shift 2 ;;
    --version) VERSION_OVERRIDE="${2:-}"; shift 2 ;;
    --notes) NOTES="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

[ -f "$MANIFEST" ] || { echo "❌ manifest not found: $MANIFEST" >&2; exit 1; }

MANIFEST_VERSION="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['version'])" "$MANIFEST")"
[ -n "$MANIFEST_VERSION" ] || { echo "❌ no version in $MANIFEST" >&2; exit 1; }

# The packed manifest is what we BUILT; the store serves what Google has
# APPROVED, and those diverge whenever an upload is held or still in review.
# Publishing the built version in that window points every gateway at a build
# nobody can install — the one failure this whole step is arranged to avoid.
# --version is the escape hatch for "the store is behind us", and it is capped
# at the manifest so it can only ever name a version we have actually built.
VERSION="$MANIFEST_VERSION"
if [ -n "$VERSION_OVERRIDE" ]; then
  if ! printf '%s' "$VERSION_OVERRIDE" | grep -Eq '^[0-9]+(\.[0-9]+){0,3}$'; then
    echo "❌ --version '$VERSION_OVERRIDE' is not a version" >&2
    exit 1
  fi
  NEWEST="$(printf '%s\n%s\n' "$MANIFEST_VERSION" "$VERSION_OVERRIDE" \
    | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n | tail -1)"
  if [ "$NEWEST" = "$VERSION_OVERRIDE" ] && [ "$VERSION_OVERRIDE" != "$MANIFEST_VERSION" ]; then
    echo "❌ --version $VERSION_OVERRIDE is NEWER than the packed manifest ($MANIFEST_VERSION)." >&2
    echo "   You cannot publish a build that does not exist. Bump the manifest first." >&2
    exit 1
  fi
  VERSION="$VERSION_OVERRIDE"
fi

# Chrome's format: 1–4 dot-separated integers. Anything else means the manifest
# was hand-edited into a shape Chrome would reject at upload — catch it here
# rather than after it is the published answer for every install.
if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+(\.[0-9]+){0,3}$'; then
  echo "❌ '$VERSION' is not a Chrome extension version (1-4 dotted integers)" >&2
  exit 1
fi

if [ -n "$MIN_SUPPORTED" ]; then
  if ! printf '%s' "$MIN_SUPPORTED" | grep -Eq '^[0-9]+(\.[0-9]+){0,3}$'; then
    echo "❌ --min '$MIN_SUPPORTED' is not a version" >&2
    exit 1
  fi
  # A floor above the version being published marks every install unsupported,
  # including brand-new ones. Refuse rather than publish a self-contradiction.
  LOWEST="$(printf '%s\n%s\n' "$VERSION" "$MIN_SUPPORTED" | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n | head -1)"
  if [ "$LOWEST" != "$MIN_SUPPORTED" ] && [ "$VERSION" != "$MIN_SUPPORTED" ]; then
    echo "❌ --min $MIN_SUPPORTED is NEWER than the published version $VERSION" >&2
    echo "   every user, including fresh installs, would be marked unsupported." >&2
    exit 1
  fi
fi

# Commas are the release_notes separator on the read side (check.php splits on
# /[,\n]/), so a comma silently becomes two bullets.
case "$NOTES" in
  *,*) echo "❌ --notes must not contain commas (they split into separate notes)" >&2; exit 1 ;;
esac

MIN_SQL="NULL"
[ -n "$MIN_SUPPORTED" ] && MIN_SQL="'$MIN_SUPPORTED'"

read -r -d '' REMOTE_SCRIPT <<ENDSSH || true
set -e
DB="$DB"

# BACK IT UP FIRST — same discipline as Step 7. This is the production
# billing/version database and what follows is a global UPDATE.
sudo cp "\$DB" "\$DB.bak-pre-ext-${VERSION}-\$(date +%Y%m%d%H%M%S)"

# The table may not exist on a box that predates the migration.
sudo sqlite3 "\$DB" "CREATE TABLE IF NOT EXISTS extension_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version_number VARCHAR(20) NOT NULL,
    channel VARCHAR(20) NOT NULL DEFAULT 'store',
    min_supported_version VARCHAR(20),
    release_notes TEXT,
    download_url TEXT,
    is_latest BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (version_number, channel));"
sudo sqlite3 "\$DB" "CREATE UNIQUE INDEX IF NOT EXISTS idx_extension_versions_latest
    ON extension_versions (channel) WHERE is_latest = 1;"

# Demote first: the partial unique index REJECTS a second is_latest row, so an
# insert before the demote fails outright rather than leaving two.
sudo sqlite3 "\$DB" "UPDATE extension_versions SET is_latest = 0 WHERE channel = 'store';"
sudo sqlite3 "\$DB" "INSERT INTO extension_versions
    (version_number, channel, min_supported_version, release_notes, download_url, is_latest)
  VALUES ('${VERSION}', 'store', ${MIN_SQL}, '${NOTES}', '${STORE_URL}', 1)
  ON CONFLICT(version_number, channel) DO UPDATE SET
    min_supported_version = excluded.min_supported_version,
    release_notes         = excluded.release_notes,
    download_url          = excluded.download_url,
    is_latest             = 1,
    updated_at            = CURRENT_TIMESTAMP;"

echo "--- extension_versions (last 3) ---"
sudo sqlite3 -header "\$DB" "SELECT version_number, channel, min_supported_version, is_latest
  FROM extension_versions ORDER BY id DESC LIMIT 3;"
ENDSSH

echo "Vodou Bridge → app.vodou.ai"
if [ "$VERSION" = "$MANIFEST_VERSION" ]; then
  echo "  version:  $VERSION   (read from $(basename "$(dirname "$MANIFEST")")/manifest.json)"
else
  echo "  version:  $VERSION   (--version override; packed manifest is $MANIFEST_VERSION)"
  echo "            ⚠️  publishing the STORE version, not the built one — correct when"
  echo "                the $MANIFEST_VERSION upload is held or still in review."
fi
echo "  channel:  store"
echo "  min:      ${MIN_SUPPORTED:-<none — routine update, pill only>}"
echo "  notes:    ${NOTES:-<none>}"
echo

if [ "$APPLY" -ne 1 ]; then
  echo "DRY RUN — nothing sent. Remote script that WOULD run:"
  echo "────────────────────────────────────────────────────"
  printf '%s\n' "$REMOTE_SCRIPT"
  echo "────────────────────────────────────────────────────"
  echo "Re-run with --apply to execute."
  exit 0
fi

[ -n "$PEM" ] || { echo "❌ set VODOU_WEB_PEM to the SSH private key path" >&2; exit 1; }
[ -f "$PEM" ] || { echo "❌ SSH key not found: $PEM" >&2; exit 1; }
[ -n "$REMOTE" ] || { echo "❌ set VODOU_WEB_HOST (e.g. user@host)" >&2; exit 1; }

printf '%s\n' "$REMOTE_SCRIPT" \
  | ssh -i "$PEM" -o StrictHostKeyChecking=no "$REMOTE" 'bash -s' \
  || { echo "❌ remote update failed" >&2; exit 2; }

echo
echo "Verifying what the API now serves…"
SERVED="$(curl -fsSL "https://app.vodou.ai/api/version/check?version=0.0.1&platform=macos-arm64&architecture=arm64&user_id=ext-publish" \
  | python3 -c "import json,sys; d=json.load(sys.stdin).get('data',{}); e=d.get('extension') or {}; print(e.get('latest_version',''))" 2>/dev/null || true)"

if [ "$SERVED" = "$VERSION" ]; then
  echo "✅ /api/version/check now reports extension $SERVED"
else
  echo "❌ API reports '${SERVED:-<nothing>}', expected '$VERSION'" >&2
  echo "   the write landed but the endpoint disagrees — check that the deployed" >&2
  echo "   check.php has the extension block (backend/api/version/check.php)." >&2
  exit 2
fi
