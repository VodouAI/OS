#!/bin/bash
# scripts/check-node-pin.sh — fail if Node version pins drift across the repo.
#
# Pins must agree across:
#   - .nvmrc                                 (developer nvm hint)
#   - .tool-versions                         (developer asdf hint)
#   - .build/scripts/build-release-multi-arch-prebuilt.sh NODE_VERSION
#   - install-prebuilt.sh                    (EXPECTED_MAJOR check)
#   - MCP-servers/*/package.json engines.node range
#
# Run from repo root.

set -e
cd "$(dirname "$0")/.."

EXPECTED_VERSION="24.15.0"
EXPECTED_MAJOR="24"
EXPECTED_RANGE=">=24.0.0 <25.0.0"

fail=0
red() { printf '\033[31m%s\033[0m\n' "$1"; }
ok()  { printf '\033[32m%s\033[0m\n' "$1"; }

# 1. .nvmrc
nvmrc=$(tr -d 'v[:space:]' < .nvmrc 2>/dev/null || echo "")
if [ "$nvmrc" = "$EXPECTED_VERSION" ]; then
    ok "  .nvmrc                  → $nvmrc"
else
    red "  .nvmrc                  → '$nvmrc' (expected $EXPECTED_VERSION)"
    fail=1
fi

# 2. .tool-versions
tv=$(awk '$1=="nodejs"{print $2}' .tool-versions 2>/dev/null || echo "")
if [ "$tv" = "$EXPECTED_VERSION" ]; then
    ok "  .tool-versions          → $tv"
else
    red "  .tool-versions          → '$tv' (expected $EXPECTED_VERSION)"
    fail=1
fi

# 3. build script NODE_VERSION
bs=$(grep -E '^\s*local\s+NODE_VERSION="v?[0-9]' .build/scripts/build-release-multi-arch-prebuilt.sh 2>/dev/null \
     | head -1 | sed -E 's/.*"v?([0-9.]+)".*/\1/')
if [ "$bs" = "$EXPECTED_VERSION" ]; then
    ok "  build script            → v$bs"
else
    red "  build script            → 'v$bs' (expected v$EXPECTED_VERSION)"
    fail=1
fi

# 4. install-prebuilt EXPECTED_MAJOR
em=$(grep -E '^\s*EXPECTED_MAJOR=' install-prebuilt.sh 2>/dev/null | head -1 | sed -E 's/.*=([0-9]+).*/\1/')
if [ "$em" = "$EXPECTED_MAJOR" ]; then
    ok "  install-prebuilt.sh     → v${em}.x"
else
    red "  install-prebuilt.sh     → 'v${em}.x' (expected v${EXPECTED_MAJOR}.x)"
    fail=1
fi

# 5. MCP servers' engines.node — only first-party Vodou-* + ExecDesk-Console.
# dalle, context7, uml-mcp are third-party wrappers — pinning their Node range
# is out of scope.
for pj in \
    MCP-servers/Vodou-LLM-router/package.json \
    MCP-servers/Vodou-Enhanced-Thinking/package.json \
    MCP-servers/Vodou-Recall/package.json \
    MCP-servers/Vodou-script-executor/package.json \
    MCP-servers/Vodou-session-manager/package.json \
    MCP-servers/Vodou-channels/package.json \
    MCP-servers/Vodou-Console/package.json \
    MCP-servers/ExecDesk-Console/package.json
do
    [ -f "$pj" ] || { red "  $pj missing"; fail=1; continue; }
    en=$(node -e "process.stdout.write(require('./$pj').engines?.node || '')" 2>/dev/null)
    if [ "$en" = "$EXPECTED_RANGE" ]; then
        ok "  ${pj#MCP-servers/}  → $en"
    else
        red "  ${pj#MCP-servers/}  → '$en' (expected $EXPECTED_RANGE)"
        fail=1
    fi
done

if [ "$fail" -ne 0 ]; then
    echo ""
    red "Node version pins are out of sync. Update all listed entries to match."
    exit 1
fi

echo ""
ok "All Node version pins agree on v$EXPECTED_VERSION"
