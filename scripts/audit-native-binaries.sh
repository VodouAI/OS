#!/bin/bash
# scripts/audit-native-binaries.sh
#
# Fresh-install native-binary audit. Run this after extracting a release archive
# on a clean test machine. It catches the entire class of "ABI/arch mismatch"
# bugs that have shipped before:
#
#   - Stray .node addons (non-sql.js, non-fsevents) that could ABI-mismatch
#   - Rust/Swift binaries with wrong arch for the host
#   - Gatekeeper quarantine xattrs (would prompt user on first launch)
#   - node-gyp / prebuild-install / source rebuild attempts during install
#   - Bundled Node missing or unable to load node:sqlite
#
# Usage:
#   ./scripts/audit-native-binaries.sh /path/to/extracted/archive
#
# Exit codes:
#   0 = clean (no fatal findings)
#   1 = at least one block-the-release finding
#   2 = invocation error

set -e

INSTALL_DIR="${1:-$(pwd)}"
if [ ! -d "$INSTALL_DIR" ]; then
    echo "usage: $0 <install-dir>"
    exit 2
fi
cd "$INSTALL_DIR" || exit 2

EXPECTED_NODE_MAJOR="24"
EXPECTED_NODE_VERSION="v24.15.0"

fail=0
warn=0
heading() { printf '\n\033[1;36m=== %s ===\033[0m\n' "$1"; }
ok()      { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn()    { printf '  \033[33m!\033[0m %s\n' "$1"; warn=$((warn+1)); }
err()     { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }

echo "Auditing: $INSTALL_DIR"
echo "Host arch: $(uname -m) / $(uname -s)"

# ── 1. Stray native node addons ─────────────────────────────────
heading "1. Native node addons (.node files)"
# Allowed: fsevents (macOS file watcher, mature, stable across Node versions),
#          node-pty (terminal emulator, has its own per-arch prebuilds),
#          sql.js (none — pure JS WASM, doesn't ship .node).
# Anything else is a potential ABI landmine.
strays=()
while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in
        */fsevents/*) ;; # known-OK
        */node-pty/*) ;; # known-OK (per-arch prebuild)
        *) strays+=("$f") ;;
    esac
done < <(find . -name "*.node" -type f 2>/dev/null | grep -v "^\./\.node/" || true)

if [ ${#strays[@]} -eq 0 ]; then
    ok "No unexpected native addons found"
else
    err "${#strays[@]} unexpected native addon(s) — these are ABI-fragile:"
    for s in "${strays[@]}"; do
        printf "      %s\n      %s\n" "$s" "$(file "$s" 2>/dev/null | sed 's/^[^:]*: //')"
    done
fi

# Optional: enumerate the allowed ones for visibility
allowed=$(find . -name "*.node" -type f 2>/dev/null | grep -E "/(fsevents|node-pty)/" | wc -l | tr -d ' ')
[ "$allowed" -gt 0 ] && ok "$allowed allow-listed addons (fsevents/node-pty) — verify per-arch correctness manually"

# ── 2. Rust/Swift binary architecture ───────────────────────────
heading "2. Rust + Swift binary architecture"
HOST_ARCH=$(uname -m)
case "$HOST_ARCH" in
    arm64) EXPECTED_ARCH_PATTERN="arm64" ;;
    x86_64) EXPECTED_ARCH_PATTERN="x86_64" ;;
    *) EXPECTED_ARCH_PATTERN="$HOST_ARCH" ;;
esac

check_arch() {
    local bin="$1"
    [ ! -f "$bin" ] && { warn "missing: $bin"; return; }
    local desc=$(file "$bin" 2>/dev/null)
    if echo "$desc" | grep -q "$EXPECTED_ARCH_PATTERN"; then
        ok "$(basename "$bin"): $EXPECTED_ARCH_PATTERN"
    else
        err "$(basename "$bin") arch mismatch — host=$EXPECTED_ARCH_PATTERN"
        echo "      $desc"
    fi
}

check_arch "vodou-core"
check_arch "vodou-hook-bin"
# Swift binaries: only check the host-arch build (per-arch artifacts coexist
# in dev tree but only one ships per release archive).
case "$HOST_ARCH" in
    arm64) swift_bin="MCP-servers/vodou-mac-control/swift/.build/arm64-apple-macosx/release/vodou-ax" ;;
    x86_64) swift_bin="MCP-servers/vodou-mac-control/swift/.build/x86_64-apple-macosx/release/vodou-ax" ;;
esac
[ -n "$swift_bin" ] && [ -f "$swift_bin" ] && check_arch "$swift_bin"

# ── 3. Gatekeeper quarantine xattrs ─────────────────────────────
heading "3. Gatekeeper quarantine attributes"
if [ "$(uname -s)" = "Darwin" ]; then
    quarantined=$(xattr -r . 2>/dev/null | grep -i "com.apple.quarantine" | wc -l | tr -d ' ')
    if [ "$quarantined" -eq 0 ]; then
        ok "No quarantine xattrs"
    else
        err "$quarantined file(s) have com.apple.quarantine — Gatekeeper will prompt user"
        echo "      Fix: xattr -r -d com.apple.quarantine $INSTALL_DIR"
    fi
else
    ok "skipped (not macOS)"
fi

# ── 4. Install transcript scrub ─────────────────────────────────
heading "4. Install transcript — no native compiles"
LOG=".vodou/install.log"
if [ -f "$LOG" ]; then
    forbidden=$(grep -iE "node-gyp|gyp ERR|rebuilding from source|prebuild-install|--build-from-source" "$LOG" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$forbidden" -eq 0 ]; then
        ok "No native compile activity in install log"
    else
        err "$forbidden suspicious line(s) in install log:"
        grep -iE "node-gyp|gyp ERR|rebuilding from source|prebuild-install|--build-from-source" "$LOG" | head -5 | sed 's/^/      /'
    fi
else
    warn "No install transcript at $LOG — install must capture for audit"
fi

# ── 5. Bundled Node + node:sqlite ───────────────────────────────
heading "5. Bundled Node runtime + node:sqlite"
if [ ! -x ".node/node" ]; then
    err "Bundled Node missing at .node/node"
else
    actual=$(.node/node --version 2>/dev/null)
    if [ "$actual" = "$EXPECTED_NODE_VERSION" ]; then
        ok "Bundled Node = $actual (exact pin match)"
    else
        actual_major=$(echo "$actual" | sed 's/v//' | cut -d. -f1)
        if [ "$actual_major" = "$EXPECTED_NODE_MAJOR" ]; then
            warn "Bundled Node = $actual (major OK, patch differs from $EXPECTED_NODE_VERSION)"
        else
            err "Bundled Node = $actual (expected $EXPECTED_NODE_VERSION)"
        fi
    fi

    if .node/node -e "const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync(':memory:'); d.exec('CREATE TABLE t(x)'); d.prepare('INSERT INTO t VALUES (?)').run(1); if (d.prepare('SELECT x FROM t').get().x !== 1) process.exit(1); d.close()" 2>/dev/null; then
        ok "node:sqlite end-to-end smoke (CREATE/INSERT/SELECT) passes"
    else
        err "node:sqlite smoke test failed — bundled Node is broken or wrong build"
    fi
fi

# Stamped version file (build script writes this)
if [ -f ".node/VERSION" ]; then
    stamped=$(cat .node/VERSION)
    if [ "$stamped" = "$EXPECTED_NODE_VERSION" ]; then
        ok ".node/VERSION stamp matches: $stamped"
    else
        err ".node/VERSION = $stamped (expected $EXPECTED_NODE_VERSION)"
    fi
fi

# ── 6. better-sqlite3 must be GONE everywhere ───────────────────
heading "6. better-sqlite3 residue"
res_pkg=$(grep -lE '"better-sqlite3"|"@types/better-sqlite3"' MCP-servers/Vodou-*/package.json MCP-servers/ExecDesk-Console/package.json 2>/dev/null | grep -v "Vodou-Console copy" | wc -l | tr -d ' ')
if [ "$res_pkg" -eq 0 ]; then
    ok "No better-sqlite3 deps in any in-scope server's package.json"
else
    err "$res_pkg server(s) still list better-sqlite3"
fi

res_dirs=$(find MCP-servers -type d -name better-sqlite3 -prune 2>/dev/null | grep -v "Vodou-Console copy" | wc -l | tr -d ' ')
if [ "$res_dirs" -eq 0 ]; then
    ok "No better-sqlite3 directories under MCP-servers/"
else
    err "$res_dirs leftover better-sqlite3 dir(s) shipped in archive"
fi

res_imports=$(grep -rEn "^[^/]*\b(import|require)\b[^/]*['\"]better-sqlite3['\"]" \
    MCP-servers/Vodou-*/dist MCP-servers/ExecDesk-Console/dist 2>/dev/null \
    | grep -v "Vodou-Console copy" | wc -l | tr -d ' ')
if [ "$res_imports" -eq 0 ]; then
    ok "No better-sqlite3 imports/requires in compiled dist/"
else
    err "$res_imports compiled file(s) still import better-sqlite3"
fi

# ── 7. node_modules size sanity ─────────────────────────────────
heading "7. Archive size sanity"
size=$(du -sh "$INSTALL_DIR" 2>/dev/null | awk '{print $1}')
ok "Install dir size: $size"

# ── Summary ─────────────────────────────────────────────────────
heading "Summary"
if [ "$fail" -gt 0 ]; then
    printf '\033[31m%s\033[0m\n' "$fail blocking finding(s) — DO NOT SHIP."
    [ "$warn" -gt 0 ] && printf '\033[33m%s\033[0m\n' "$warn warning(s) (review manually)."
    exit 1
fi

if [ "$warn" -gt 0 ]; then
    printf '\033[33m%s\033[0m\n' "$warn warning(s) — review before shipping."
fi
printf '\033[32m%s\033[0m\n' "Audit clean."
exit 0
