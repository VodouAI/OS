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
  --exclude 'node_modules' \
  --exclude 'build-icons.mjs' \
  --exclude '.DS_Store' \
  --exclude '*.map' \
  --exclude 'README.md' \
  "$SRC/" "$STAGE/Store-vodou-bridge/"

# README.md is a DEV doc and must not ship. Chrome never renders it, and it told a
# reviewer — twice — that a fuller sideload build exists with `act_in_tab`, the
# exact capability stripped for their policy, alongside internal repo paths. Same
# lesson as 9bdbbc85: don't hand a reviewer the alarming sentence in prose.
#
# NOTICE does ship: the root LICENSE (hybrid, Apache-2.0 for extension/) states it
# must be preserved on redistribution, and the package carried LICENSE without it.
if [ -f "$ROOT/NOTICE" ]; then
  cp "$ROOT/NOTICE" "$STAGE/Store-vodou-bridge/NOTICE"
else
  echo "WARNING: no NOTICE at repo root — Apache-2.0 attribution not shipped" >&2
fi

# ── OPERATOR-PII / CREDENTIAL GUARD (added 2026-08-06) ─────────────────────────
# The .52 store zip shipped the operator's real medical and location details in
# debugging comments — 11 hits, publicly downloadable. Comments ship exactly like
# code. Scan the whole staged tree against the same pattern file the release scan
# and secret-guard read, so a new pattern lands in one place and all layers get it.
PII_FILE="$ROOT/.build/release-pii-patterns.txt"
if [ -f "$PII_FILE" ]; then
  PII_HITS=$(grep -rInE -f <(grep -vE '^\s*(#|$)' "$PII_FILE" | sed 's/^BINARY-SCAN //') \
    "$STAGE/Store-vodou-bridge" 2>/dev/null | head -12) || true
  if [ -n "$PII_HITS" ]; then
    echo "ERROR: operator-PII / credential patterns found in the staged store build:" >&2
    echo "$PII_HITS" >&2
    exit 1
  fi
else
  echo "WARNING: $PII_FILE missing — PII scan skipped" >&2
fi

# Hard fail if a store zip would still contain remote-code patterns
if rg -q 'new Function|runUserScript' "$STAGE/Store-vodou-bridge/background.js"; then
  echo "ERROR: store background.js still contains remote-code patterns" >&2
  exit 1
fi
if rg -q '<all_urls>' "$STAGE/Store-vodou-bridge/manifest.json"; then
  echo "ERROR: store manifest still has <all_urls>" >&2
  exit 1
fi

# Chrome rejects a manifest description over 132 characters at UPLOAD time — before
# any human review. Ours was 192 and would have bounced silently late in the process.
DESC_LEN=$(python3 -c "import json;print(len(json.load(open('$STAGE/Store-vodou-bridge/manifest.json'))['description']))")
if [ "$DESC_LEN" -gt 132 ]; then
  echo "ERROR: manifest description is ${DESC_LEN} chars — Chrome's limit is 132" >&2
  exit 1
fi

# ── ENCODING GUARD ─────────────────────────────────────────────────────────────
# Chrome refuses to load a content script containing NUL bytes, noncharacters
# (U+FFFE/U+FFFF, U+FDD0–U+FDEF) or lone surrogates, and reports it as:
#
#   "Could not load file 'inject.js' for content script. It isn't UTF-8 encoded."
#
# That message sends you hunting an encoding problem that does not exist — the
# bytes ARE valid UTF-8, they just contain codepoints Chrome's validator rejects.
# It cost a debugging round on 2026-07-27, from a literal U+FFFF typed into a
# regex range while transcribing a binary protocol. Fail the pack, not the load.
python3 - "$STAGE/Store-vodou-bridge" <<'PYEOF' || exit 1
import pathlib, sys
root = pathlib.Path(sys.argv[1])
bad = 0
for f in sorted(list(root.glob('*.js')) + list(root.glob('*.json')) + list(root.glob('**/*.js'))):
    raw = f.read_bytes()
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError as e:
        print(f"ERROR: {f.name} is not valid UTF-8 (byte {e.start})"); bad += 1; continue
    for i, ch in enumerate(text):
        cp = ord(ch)
        if cp == 0 or 0xFDD0 <= cp <= 0xFDEF or (cp & 0xFFFE) == 0xFFFE or 0xD800 <= cp <= 0xDFFF:
            line = text.count('\n', 0, i) + 1
            print(f"ERROR: {f.name} line {line} contains U+{cp:04X} — Chrome will refuse to load this build")
            print("       Spell it as an escape (backslash-u-digits), never the literal character.")
            bad += 1
            break
raise SystemExit(1 if bad else 0)
PYEOF

# ── SIDELOAD DRIFT CHECK ───────────────────────────────────────────────────────
# The store build and extension/vodou-bridge/ are meant to differ by exactly ONE
# thing: the PLAN-AUTO-INJECT-P4 network body-rewrite block, which is
# sideload-only (Chad, 2026-07-25). The store build keeps the call site and stubs
# it out, so the two inject.js files should be identical once that block is
# normalised back to the stub.
#
# They drifted 39 commits / eleven days apart before anyone noticed (ported in
# fa15858), during which the sideload build silently shipped broken capture for
# nine sites — including Poe filing the user's own prompt as the assistant's.
# Nothing failed; it just quietly rotted. This is the cheapest place to catch it,
# because it is the one script that runs whenever the store build is touched.
#
# WARNS rather than fails: a store release must not be blocked by the state of a
# different build. Set VODOU_STRICT_DRIFT=1 to make it fatal.
SIDE="$ROOT/extension/vodou-bridge/inject.js"
if [ -f "$SIDE" ]; then
  DRIFT=$(python3 - "$SRC/inject.js" "$SIDE" <<'PYEOF'
import sys, pathlib, difflib
store = pathlib.Path(sys.argv[1]).read_text()
side  = pathlib.Path(sys.argv[2]).read_text()
STUB  = "  async function maybeInjectArgs(args) { return args; }"
START = "  // ── PLAN-AUTO-INJECT-P4 mechanism #1: network body-rewrite"
END   = "  try { window.__vodouInjectInternals = { injectRewriteBody, netInjectTarget }; } catch (_) {}"
try:
    i = side.index(START); j = side.index(END) + len(END)
    side_norm = side[:i] + STUB + side[j:]     # collapse the sideload-only block back to the stub
except ValueError:
    print("sideload build is missing the PLAN-AUTO-INJECT-P4 block entirely")
    raise SystemExit(0)
if side_norm == store:
    raise SystemExit(0)
d = [l for l in difflib.unified_diff(store.splitlines(), side_norm.splitlines(),
                                     "store", "sideload(normalised)", lineterm="", n=0)
     if l.startswith(("+", "-")) and not l.startswith(("+++", "---"))]
print(f"{len(d)} line(s) differ beyond the sideload-only block")
for l in d[:12]:
    print("      " + l[:110])
if len(d) > 12:
    print(f"      … and {len(d)-12} more")
PYEOF
) || true
  if [ -n "$DRIFT" ]; then
    echo "" >&2
    echo "WARNING: extension/vodou-bridge/inject.js has drifted from the store build." >&2
    echo "  $DRIFT" >&2
    echo "  The two builds should differ ONLY by the sideload-only inject block." >&2
    echo "  Port with: replace the store's maybeInjectArgs stub with the sideload block (see fa15858)." >&2
    echo "" >&2
    if [ "${VODOU_STRICT_DRIFT:-0}" = "1" ]; then
      echo "ERROR: VODOU_STRICT_DRIFT=1 — treating drift as fatal." >&2
      exit 1
    fi
  else
    echo "sideload build in sync (differs only by the inject block)"
  fi
fi

# Zip the CONTENTS, not the containing folder.
#
# `zip -r out.zip Store-vodou-bridge` produces Store-vodou-bridge/manifest.json,
# i.e. the manifest one level down. The Chrome Web Store looks for manifest.json
# at the ROOT of the upload and rejects a nested layout ("Manifest file is
# missing or unreadable") — a wasted review round-trip for a packaging detail.
(
  cd "$STAGE/Store-vodou-bridge"
  zip -r -q "$OUT_ZIP" . \
    -x '*.DS_Store' -x './test/*' -x './build-icons.mjs'
)

# Fail loudly rather than shipping a zip the Store will reject on upload.
if ! unzip -l "$OUT_ZIP" | awk '{print $4}' | grep -qx 'manifest.json'; then
  echo "ERROR: manifest.json is not at the zip root — CWS will reject this upload" >&2
  exit 1
fi

echo "Wrote $OUT_ZIP"
unzip -l "$OUT_ZIP" | head -40
