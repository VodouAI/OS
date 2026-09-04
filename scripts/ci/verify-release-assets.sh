#!/usr/bin/env bash
# verify-release-assets.sh — does the release API agree with the published bytes?
#
# ALPHA-READINESS §9 C. The auto-updater's source of truth is
# app.vodou.ai/api/version/check, not update-manifest.json: auto_updater.rs
# verifies checksum_sha256 and HARD-FAILS when it is absent. Nothing checked
# that those API rows match the assets actually on the release, for all five
# platform strings a client can send. A wrong or missing row is invisible until
# a stranger's update aborts mid-download.
#
# Also covers RC-11 from the client side: an unrecognised platform string must
# not be answered with the macOS-Intel bundle.
#
# Usage: verify-release-assets.sh <version>       e.g. 0.6.27
#        VODOU_API_BASE=... to point at a staging API.
# Exit 0 = every platform row resolves and matches. 1 = a mismatch. 2 = the API
# could not be reached at all (an infrastructure answer, not a release verdict).

set -uo pipefail

VERSION="${1:-}"
[ -n "$VERSION" ] || { echo "Usage: $0 <version>" >&2; exit 1; }
VERSION="${VERSION#v}"
API="${VODOU_API_BASE:-https://app.vodou.ai}"
FAIL=""
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else openssl dgst -sha256 "$1" | awk '{print $NF}'; fi
}

# The five (platform, architecture) pairs auto_updater.rs::detect_platform can
# produce. Not a guess — os is macos|linux|windows and arch is arm64|x86_64,
# joined with a hyphen (src/auto_updater.rs).
PAIRS="macos-arm64:arm64 macos-x86_64:x86_64 linux-arm64:arm64 linux-x86_64:x86_64 windows-x86_64:x86_64"

echo "── Release API rows for v${VERSION} (${API})"
REACHED=0
for pair in $PAIRS; do
  PLATFORM="${pair%%:*}"; ARCH="${pair##*:}"
  URL="${API}/api/version/check?version=0.0.0&platform=${PLATFORM}&os_name=ci&os_version=1&architecture=${ARCH}&user_id=ci"
  BODY=$(curl -s -m 30 "$URL" 2>/dev/null || true)
  if [ -z "$BODY" ]; then
    printf '  ⚠️  %-16s no response\n' "$PLATFORM"
    FAIL="$FAIL ${PLATFORM}(no-response)"
    continue
  fi
  REACHED=1
  # Deliberately grep, not jq: a CI runner may not have jq, and adding a
  # dependency to the one job that must never be skipped is a bad trade.
  # The API returns JSON with escaped solidi ("https:\/\/github.com\/…"), which
  # is valid JSON and a URL curl cannot fetch. Caught by actually running this
  # against the live endpoint rather than reading the response shape — the
  # checksum comparison would have passed and every download would have 404'd.
  DL=$(printf '%s' "$BODY" | grep -oE '"download_url"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/' | sed 's|\\/|/|g')
  SUM=$(printf '%s' "$BODY" | grep -oE '"checksum_sha256"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  if [ -z "$SUM" ]; then
    # auto_updater.rs:1619-1629 refuses to update without this. A row missing it
    # is a release that cannot be shipped to that platform, whatever else is right.
    printf '  ❌ %-16s no checksum_sha256 — the updater hard-fails on this row\n' "$PLATFORM"
    FAIL="$FAIL ${PLATFORM}(no-checksum)"
    continue
  fi
  if [ -z "$DL" ]; then
    printf '  ❌ %-16s no download_url\n' "$PLATFORM"
    FAIL="$FAIL ${PLATFORM}(no-url)"
    continue
  fi
  # The URL must be for THIS platform. RC-11: an unknown platform string is
  # answered with the macOS-Intel bundle, and the client only discovers that
  # after a 357 MB download. The same wrong-asset answer for a KNOWN platform
  # would be worse and equally invisible.
  case "$PLATFORM" in
    macos-arm64)    WANT="macos-arm64" ;;
    macos-x86_64)   WANT="macos-intel" ;;
    linux-arm64)    WANT="linux-arm64" ;;
    linux-x86_64)   WANT="linux-x64" ;;
    windows-x86_64) WANT="win-x64" ;;
  esac
  case "$DL" in
    *"$WANT"*) : ;;
    *) printf '  ❌ %-16s serves the WRONG asset: %s (expected one naming %s)\n' "$PLATFORM" "$DL" "$WANT"
       FAIL="$FAIL ${PLATFORM}(wrong-asset)"; continue ;;
  esac

  if [ "${VERIFY_ASSET_BYTES:-1}" = "1" ]; then
    F="$WORK/$(basename "$DL")"
    if curl -fsSL -m 900 "$DL" -o "$F" 2>/dev/null; then
      GOT=$(sha256_of "$F")
      if [ "$GOT" = "$(printf '%s' "$SUM" | tr 'A-Z' 'a-z')" ]; then
        printf '  ✅ %-16s %s  sha256 matches the API row\n' "$PLATFORM" "$(basename "$DL")"
      else
        printf '  ❌ %-16s sha256 MISMATCH\n       api %s\n       got %s\n' "$PLATFORM" "$SUM" "$GOT"
        FAIL="$FAIL ${PLATFORM}(sha-mismatch)"
      fi
      rm -f "$F"
    else
      printf '  ❌ %-16s download_url is not fetchable: %s\n' "$PLATFORM" "$DL"
      FAIL="$FAIL ${PLATFORM}(url-404)"
    fi
  else
    printf '  ✅ %-16s row present and asset-named correctly (bytes not fetched)\n' "$PLATFORM"
  fi
done

# RC-11 — an unrecognised platform must be an error, not the Intel Mac bundle.
echo "── Unknown-platform behaviour (RC-11)"
BODY=$(curl -s -m 30 "${API}/api/version/check?version=0.0.0&platform=freebsd-riscv&os_name=ci&os_version=1&architecture=riscv&user_id=ci" 2>/dev/null || true)
if printf '%s' "$BODY" | grep -q "macos-intel"; then
  echo "  ❌ an unknown platform is served the macOS-Intel bundle (RC-11) — a client discovers this after a 357 MB download"
  FAIL="$FAIL rc-11"
else
  echo "  ✅ unknown platform is not served a macOS bundle"
fi

echo ""
if [ "$REACHED" = "0" ]; then
  echo "⚠️  Could not reach ${API} at all — this is an infrastructure result, not a release verdict."
  exit 2
fi
if [ -n "$FAIL" ]; then
  echo "❌ RELEASE ASSETS FAILED:$FAIL"
  exit 1
fi
echo "✅ All five platform rows resolve, name the right asset, and match its bytes."
