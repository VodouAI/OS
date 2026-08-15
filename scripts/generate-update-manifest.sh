#!/usr/bin/env bash
# generate-update-manifest.sh — write update-manifest.json into a release staging directory.
# Called by build-release.sh BEFORE the tar step.
#
# Usage:
#   scripts/generate-update-manifest.sh <RELEASE_DIR> [PROJECT_ROOT] [PLATFORM_OVERRIDE]
#   PLATFORM_OVERRIDE e.g. macos-arm64 | macos-x86_64 when staging ≠ build machine uname
#
# Writes: <RELEASE_DIR>/update-manifest.json
# The updater (auto_updater.rs) reads this on install to verify arch, hashes, schema compat.

set -euo pipefail

RELEASE_DIR="${1:-}"
PROJECT_ROOT="${2:-.}"
PLATFORM_OVERRIDE="${3:-}"

if [ -z "$RELEASE_DIR" ] || [ ! -d "$RELEASE_DIR" ]; then
    echo "Usage: $0 <RELEASE_DIR> [PROJECT_ROOT] [PLATFORM_OVERRIDE]" >&2
    exit 1
fi

# ── Version ──────────────────────────────────────────────────────────────────
VERSION=$(grep '^version = ' "$PROJECT_ROOT/Cargo.toml" | head -1 | sed 's/version = "//;s/"//')
if [ -z "$VERSION" ]; then
    echo "[manifest] ERROR: cannot read VERSION from Cargo.toml" >&2
    exit 1
fi

# ── Platform ─────────────────────────────────────────────────────────────────
if [ -n "$PLATFORM_OVERRIDE" ]; then
    PLATFORM="$PLATFORM_OVERRIDE"
else
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    ARCH=$(uname -m)
    case "$ARCH" in
        arm64|aarch64) ARCH_NORM="arm64" ;;
        x86_64)        ARCH_NORM="x86_64" ;;
        *)             ARCH_NORM="$ARCH" ;;
    esac
    case "$OS" in
        darwin)  OS_NORM="macos" ;;
        linux)   OS_NORM="linux" ;;
        mingw*|cygwin*|msys*) OS_NORM="windows" ;;
        *)       OS_NORM="$OS" ;;
    esac
    PLATFORM="${OS_NORM}-${ARCH_NORM}"
fi

# ── SHA256 helper ─────────────────────────────────────────────────────────────
sha256_file() {
    local f="$1"
    if command -v shasum &>/dev/null; then
        shasum -a 256 "$f" | cut -d' ' -f1
    elif command -v sha256sum &>/dev/null; then
        sha256sum "$f" | cut -d' ' -f1
    else
        echo "UNAVAILABLE"
    fi
}

# ── Binary entries ────────────────────────────────────────────────────────────
# The Windows staging tree ships `vodou-core.exe` / `vodou-hook-bin.exe`; every
# other target ships the bare name. Probing only the bare name produced a
# manifest with an EMPTY binaries array for win-x64 — silently, because an empty
# array is valid JSON and nothing downstream asserted a count. Try the .exe form
# as a fallback so one loop covers both layouts. (`oi` is a POSIX shell launcher
# and legitimately absent from the Windows zip, which ships .cmd shims instead —
# so a 2-entry Windows manifest is correct, 0 was not.)
BINARIES_JSON=""
for BIN_NAME in vodou-core oi vodou-hook-bin; do
    BIN_PATH="$RELEASE_DIR/$BIN_NAME"
    if [ ! -f "$BIN_PATH" ] && [ -f "$BIN_PATH.exe" ]; then
        BIN_PATH="$BIN_PATH.exe"
        BIN_NAME="$BIN_NAME.exe"
    fi
    if [ -f "$BIN_PATH" ]; then
        HASH=$(sha256_file "$BIN_PATH")
        SIZE=$(wc -c < "$BIN_PATH" | tr -d ' ')
        if [ -n "$BINARIES_JSON" ]; then
            BINARIES_JSON="${BINARIES_JSON},"
        fi
        BINARIES_JSON="${BINARIES_JSON}
    {\"name\": \"${BIN_NAME}\", \"sha256\": \"${HASH}\", \"size\": ${SIZE}}"
    fi
done

# ── Schema versions from db_snapshot.rs (or database.rs fallback) ────────────
# Use || true so pipefail doesn't exit when the literal-number grep finds nothing
BINARY_MAX_SCHEMA=$(grep 'BINARY_MAX_SCHEMA_VERSION' "$PROJECT_ROOT/src/db_snapshot.rs" 2>/dev/null \
    | grep -oE '= [0-9]+' | grep -oE '[0-9]+' | head -1 || true)
if [ -z "$BINARY_MAX_SCHEMA" ]; then
    BINARY_MAX_SCHEMA=$(grep 'CURRENT_SCHEMA_VERSION' "$PROJECT_ROOT/src/database.rs" 2>/dev/null \
        | grep -oE '= [0-9]+' | grep -oE '[0-9]+' | head -1 || true)
fi
BINARY_MAX_SCHEMA="${BINARY_MAX_SCHEMA:-0}"
# min_schema_version: the oldest schema the new binary can still migrate from.
# Conservative: same as binary_max_schema_version until we track this separately.
MIN_SCHEMA="${BINARY_MAX_SCHEMA}"

# ── Timestamp ─────────────────────────────────────────────────────────────────
GENERATED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")

# ── Write manifest ─────────────────────────────────────────────────────────────
MANIFEST_PATH="$RELEASE_DIR/update-manifest.json"
cat > "$MANIFEST_PATH" << EOF
{
  "version": "${VERSION}",
  "platform": "${PLATFORM}",
  "binaries": [${BINARIES_JSON}
  ],
  "min_schema_version": ${MIN_SCHEMA},
  "binary_max_schema_version": ${BINARY_MAX_SCHEMA},
  "generated_at": "${GENERATED_AT}"
}
EOF

echo "[manifest] wrote update-manifest.json (v${VERSION}, ${PLATFORM}, ${BINARY_MAX_SCHEMA} max schema)"
echo "           $(wc -c < "$MANIFEST_PATH" | tr -d ' ') bytes → $MANIFEST_PATH"
