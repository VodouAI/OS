#!/usr/bin/env bash
# verify-published-tree.sh — is the tree a stranger actually downloads correct?
#
# ALPHA-READINESS §9 C (RC-3, RC-4, RC-10). Every gate in publish-os-tree.sh
# runs on the STAGING directory. Nothing has ever checked what landed on main.
# That is not a theoretical gap: v0.6.26 published an open tree with no
# .env.example — the rsync named it in an --include but never as a SOURCE — and
# all the gates passed, because the stage was fine and nobody looked at main.
#
# Lives here rather than inline in publish-os-tree.sh so BOTH callers run the
# same code: the publish script (as GATE 10, immediately after the push) and CI
# (on every tag, catching a tree that rotted between releases). One producer,
# one spelling — a guard in one writer is not a rule.
#
# Usage: verify-published-tree.sh [ref]      ref defaults to "main"
# Exit 0 = the published tree is serviceable. Exit 1 = it is not.

set -uo pipefail

REF="${1:-main}"
RAW="https://raw.githubusercontent.com/VodouAI/OS/${REF}"
FAIL=""

echo "── Published tree: ${RAW}"

# Files the installers name and cannot proceed without. A 404 in this list is
# the whole v0.6.26 bug.
for f in .env.example install-prebuilt.sh install-vodou.sh install-vodou.ps1 install.bat \
         fetch-engine.sh start-vodou-services.sh stop-vodou-services.sh memory.toml hosts.toml; do
  CODE=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$RAW/$f" 2>/dev/null || echo "000")
  if [ "$CODE" = "200" ]; then
    printf '  ✅ %-26s %s\n' "$f" "$CODE"
  else
    printf '  ❌ %-26s %s\n' "$f" "$CODE"
    FAIL="$FAIL $f($CODE)"
  fi
done

# PRESENCE IS NOT CORRECTNESS.
#
# install.bat was present in every published tree and passed every gate for four
# months while being the 2026-05-12 OI-era file: it ends on `pause`, points at an
# `oi.bat` no release has shipped since 0.5.x, and never runs `service install`.
# A manifest of names cannot tell a working installer from that one.
echo "── Content asserts (the checks a name-only manifest cannot make)"
PUB_BAT=$(curl -s -m 20 "$RAW/install.bat" 2>/dev/null || true)
if printf '%s' "$PUB_BAT" | grep -q "service install"; then
  echo "  ✅ install.bat registers the service"
else
  echo "  ❌ install.bat does NOT run 'service install' — this is the stale OI-era file (RC-4)"
  FAIL="$FAIL install.bat(stale-content)"
fi
if printf '%s' "$PUB_BAT" | grep -q "oi.bat"; then
  echo "  ❌ install.bat points at oi.bat, which no release has shipped since 0.5.x"
  FAIL="$FAIL install.bat(oi.bat)"
fi

# The open tree has ONE .env.example for macOS, Linux and Windows — unlike the
# archives, which the packer rewrites per platform. So an active macOS ORT path
# here is handed to every Linux and Windows box that runs the one-liner, and the
# .so or .dll that shipped beside it is never loaded (RC-10).
PUB_ENV=$(curl -s -m 20 "$RAW/.env.example" 2>/dev/null || true)
if printf '%s' "$PUB_ENV" | grep -qE '^ORT_DYLIB_PATH=.*\.dylib'; then
  echo "  ❌ .env.example ships an ACTIVE macOS ORT path — Linux/Windows inherit a library they cannot load (RC-10)"
  FAIL="$FAIL .env.example(macOS-ORT-path)"
else
  echo "  ✅ .env.example has no active macOS-only ORT path"
fi

echo ""
if [ -n "$FAIL" ]; then
  echo "❌ PUBLISHED TREE FAILED:$FAIL"
  exit 1
fi
echo "✅ Published tree serves every required file, with correct content."
