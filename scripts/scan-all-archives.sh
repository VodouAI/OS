#!/usr/bin/env bash
# Secret + operator-PII scan over EVERY release artifact, not just the macOS one.
#
# Why this exists as its own script (2026-08-03):
#
# scripts/verify-release.sh is the deep gate, but it only ever ran against the
# macOS tarball — the playbook said in as many words that it "has no win lane yet"
# and shipped the Windows zip regardless. Linux was verified by hand or not at all.
# A gate covering four artifacts out of five is one people route around, and the
# artifact it skips is the one nobody looks at.
#
# It matters because of what got through: a live GitHub PAT, hardcoded in
# MCP-servers/Vodou-Enhanced-Thinking/push-to-github.sh, shipped inside the
# published release tarballs from roughly v0.5.81 to v0.6.19. The repo tree was
# never affected — the publish allowlist correctly excluded it — but release ASSETS
# are uploaded on a separate path that the allowlist never touches. Nothing scanned
# them.
#
# So this is deliberately narrow and fast: no structural checks, no platform
# assumptions, no reason it cannot run on all five. Just "does a credential or an
# operator identifier appear in anything we are about to publish."
#
#   bash scripts/scan-all-archives.sh 0.6.20
#   bash scripts/scan-all-archives.sh path/to/one.tar.gz path/to/another.zip
#
# Exit 1 on any hit, so it can gate a publish step.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PATTERNS="$ROOT/.build/release-pii-patterns.txt"

if [ ! -f "$PATTERNS" ]; then
    echo "❌ $PATTERNS missing — cannot scan. Refusing to report success."
    exit 1
fi

# Resolve args: a bare version expands to every archive for it.
ARCHIVES=()
if [ $# -eq 0 ]; then
    echo "Usage: $0 <version> | <archive> [archive…]" >&2
    exit 1
fi
if [ $# -eq 1 ] && [ ! -f "$1" ]; then
    for f in "$ROOT/.build/releases/archives/Vodou-v$1-prebuilt-"*; do
        [ -f "$f" ] && ARCHIVES+=("$f")
    done
    if [ ${#ARCHIVES[@]} -eq 0 ]; then
        echo "❌ No archives found for version '$1'"
        exit 1
    fi
else
    ARCHIVES=("$@")
fi

echo "🔍 Scanning ${#ARCHIVES[@]} artifact(s) for credentials and operator PII"
echo ""

FAILED=0
for ARCHIVE in "${ARCHIVES[@]}"; do
    NAME=$(basename "$ARCHIVE")
    TMP=$(mktemp -d)
    case "$ARCHIVE" in
        *.zip)    unzip -qq "$ARCHIVE" -d "$TMP" 2>/dev/null ;;
        *.tar.gz) tar -xzf "$ARCHIVE" -C "$TMP" 2>/dev/null ;;
        *)        echo "  ⚠️  $NAME — unknown type, SKIPPED (this is a gap, not a pass)"
                  FAILED=1; rm -rf "$TMP"; continue ;;
    esac

    HITS=0
    while IFS= read -r LINE; do
        case "$LINE" in ''|'#'*) continue ;; esac
        if [ "${LINE#BINARY-SCAN }" != "$LINE" ]; then
            # Literal operator identifiers — scanned in binaries too, because the
            # v0.6.20 leak was inside a Mach-O code-signing certificate where
            # `strings` and a text-only grep both missed it.
            PAT="${LINE#BINARY-SCAN }"
            M=$(grep -ralE "$PAT" "$TMP" --exclude-dir=node_modules 2>/dev/null | head -3 || true)
            LABEL="in a BINARY"
        else
            # Text pass. -I skips binaries on purpose: build paths like /Users/<name>
            # are compiled into every Rust/Go/Swift binary and would fail every
            # release. See the pattern file for why that exclusion is deliberate.
            PAT="$LINE"
            M=$(grep -rIlE "$PAT" "$TMP" --exclude-dir=node_modules 2>/dev/null | head -3 || true)
            LABEL="in a text file"
        fi
        if [ -n "$M" ]; then
            [ "$HITS" -eq 0 ] && echo "  ❌ $NAME"
            HITS=$((HITS + 1))
            echo "       $LABEL: /$PAT/"
            echo "$M" | sed "s|$TMP|         |"
        fi
    done < "$PATTERNS"

    [ "$HITS" -eq 0 ] && echo "  ✅ $NAME" || FAILED=1
    rm -rf "$TMP"
done

echo ""
if [ "$FAILED" -ne 0 ]; then
    echo "❌ SCAN FAILED — do not publish. Fix the source, then rebuild the affected"
    echo "   artifacts. Rebuilding one and shipping the rest is how a leak survives:"
    echo "   on 2026-08-03 the macOS archives were rebuilt while Linux still carried"
    echo "   the old contents, and only a second scan caught it."
    exit 1
fi
echo "✅ All ${#ARCHIVES[@]} artifact(s) clean"
