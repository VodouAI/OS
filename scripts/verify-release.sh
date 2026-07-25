#!/usr/bin/env bash
# verify-release.sh — sanity-check a release archive before publishing.
# Usage: scripts/verify-release.sh <archive.tar.gz>
#
# Extracts to a temp dir, checks required files exist, checks forbidden files
# are absent, verifies update-manifest.json, and reports pass/fail.
# Exit 0 = all checks passed. Exit 1 = one or more failures.

set -euo pipefail

ARCHIVE="${1:-}"
if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
    echo "Usage: $0 <path/to/release.tar.gz>" >&2
    exit 1
fi

FAILED=0
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "🔍 Verifying release: $(basename "$ARCHIVE")"
echo "   Extracting to $TMPDIR ..."
tar -xzf "$ARCHIVE" -C "$TMPDIR"

# Find the top-level release directory inside the archive
EXTRACTED=$(ls -d "$TMPDIR"/*/ 2>/dev/null | head -1)
if [ -z "$EXTRACTED" ]; then
    echo "  ❌ CRITICAL: archive appears empty or has no top-level directory"
    exit 1
fi
EXTRACTED="${EXTRACTED%/}"
echo "   Extracted root: $(basename "$EXTRACTED")"
echo ""

# ── Required binaries (floor: at least 3) ────────────────────────────────────
echo "── Binaries ──────────────────────────────────────────────────────────────"
BIN_COUNT=0
for BIN in vodou-core oi vodou-hook-bin; do
    if [ -f "$EXTRACTED/$BIN" ]; then
        SIZE=$(du -h "$EXTRACTED/$BIN" | cut -f1)
        echo "  ✅ $BIN ($SIZE)"
        BIN_COUNT=$((BIN_COUNT + 1))
    else
        echo "  ❌ MISSING: $BIN"
        FAILED=1
    fi
done
[ "$BIN_COUNT" -lt 3 ] && { echo "  ❌ Expected at least 3 binaries, found $BIN_COUNT"; FAILED=1; }

# ── Required scripts ───────────────────────────────────────────────────────────
echo ""
echo "── Scripts ───────────────────────────────────────────────────────────────"
# bin/vodou-cli is load-bearing twice over: install-prebuilt.sh symlinks
# ~/.local/bin/vodou → it (the branded CLI command), and the auto-updater
# copies it out of THIS archive to heal older installs. The packager only
# WARNS when it's missing (and it already shipped missing once, pre-0.6.9) —
# this is the hard gate.
for SCRIPT in oi start-vodou-services.sh .env.example install-prebuilt.sh bin/vodou-cli; do
    if [ -f "$EXTRACTED/$SCRIPT" ] || [ -d "$EXTRACTED/$SCRIPT" ]; then
        echo "  ✅ $SCRIPT"
    else
        echo "  ❌ MISSING: $SCRIPT"
        FAILED=1
    fi
done
# The CLI launcher must also be executable — a cp that loses the mode bit
# would make the healed ~/.local/bin/vodou symlink point at a dead command.
if [ -f "$EXTRACTED/bin/vodou-cli" ] && [ ! -x "$EXTRACTED/bin/vodou-cli" ]; then
    echo "  ❌ bin/vodou-cli is not executable"
    FAILED=1
fi

# ── Licensing (hybrid: proprietary binaries + Apache-2.0 client surface) ──────
# Must ship: LICENSE (hybrid pointer), LICENSE-APACHE + NOTICE (open surface),
# LICENSING.md (map), EULA.md (binaries). See LICENSING.md §1.
echo ""
echo "── Licensing ─────────────────────────────────────────────────────────────"
for LIC in LICENSE LICENSE-APACHE NOTICE LICENSING.md EULA.md; do
    if [ -f "$EXTRACTED/$LIC" ]; then
        echo "  ✅ $LIC"
    else
        echo "  ❌ MISSING: $LIC (hybrid release must ship the full license set incl. EULA.md)"
        FAILED=1
    fi
done
# Guard against the pre-hybrid heredoc LICENSE ("This software is NOT open
# source") ever coming back — it misstates the licensing of the open surface.
if [ -f "$EXTRACTED/LICENSE" ] && grep -q "NOT open source" "$EXTRACTED/LICENSE"; then
    echo "  ❌ LICENSE is the stale all-proprietary text (predates hybrid licensing)"
    FAILED=1
fi
if [ -f "$EXTRACTED/EULA.md" ] && ! grep -q 'Apache License, Version 2.0' "$EXTRACTED/EULA.md"; then
    echo "  ❌ EULA.md missing Apache-2.0 open-surface wording (need v1.4+)"
    FAILED=1
fi

# ── Required MCP servers (floor: at least 1) ─────────────────────────────────
echo ""
echo "── MCP Servers ───────────────────────────────────────────────────────────"
MCP_COUNT=0
if [ -d "$EXTRACTED/MCP-servers" ]; then
    MCP_COUNT=$(ls -d "$EXTRACTED/MCP-servers"/*/ 2>/dev/null | wc -l | tr -d ' ')
    echo "  ✅ MCP-servers/ ($MCP_COUNT servers)"
else
    echo "  ❌ MISSING: MCP-servers/"
    FAILED=1
fi
[ "$MCP_COUNT" -lt 1 ] && { echo "  ❌ Expected at least 1 MCP server, found $MCP_COUNT"; FAILED=1; }

# ── LLM model catalogs (Settings selector) ───────────────────────────────────
# PLAN-LLM-MODEL-CATALOG-SYNC: shipped JSON under Vodou-Console/public/data/llm-models.
# Soft warn if auto catalogs >14d; hard fail if missing/empty or >21d.
echo ""
echo "── LLM model catalogs ────────────────────────────────────────────────────"
LLM_CAT="$EXTRACTED/MCP-servers/Vodou-Console/public/data/llm-models"
if [ ! -d "$LLM_CAT" ] || [ ! -f "$LLM_CAT/manifest.json" ]; then
    echo "  ❌ MISSING: MCP-servers/Vodou-Console/public/data/llm-models/manifest.json"
    FAILED=1
else
    echo "  ✅ llm-models/manifest.json"
    NOW_EPOCH=$(date +%s)
    for REQ in vodou.json claude-cli.json kimi-cli.json openai.json anthropic.json openrouter.json; do
        if [ ! -f "$LLM_CAT/$REQ" ]; then
            echo "  ❌ MISSING: llm-models/$REQ"
            FAILED=1
            continue
        fi
        COUNT=$(python3 -c "import json;print(len(json.load(open('$LLM_CAT/$REQ')).get('models') or []))" 2>/dev/null || echo 0)
        if [ "$COUNT" -lt 1 ]; then
            echo "  ❌ EMPTY: llm-models/$REQ"
            FAILED=1
        else
            echo "  ✅ $REQ ($COUNT models)"
        fi
    done
    # Age gate on auto providers listed in manifest
    python3 - "$LLM_CAT" "$NOW_EPOCH" <<'PY' || FAILED=1
import json, sys, os
cat, now = sys.argv[1], int(sys.argv[2])
man = json.load(open(os.path.join(cat, "manifest.json")))
soft, hard = 14 * 86400, 21 * 86400
failed = 0
for p in man.get("auto") or []:
    path = os.path.join(cat, f"{p}.json")
    if not os.path.isfile(path):
        print(f"  ❌ MISSING auto catalog: {p}.json")
        failed = 1
        continue
    j = json.load(open(path))
    models = j.get("models") or []
    if not models:
        print(f"  ❌ EMPTY auto catalog: {p}.json")
        failed = 1
        continue
    ts = j.get("fetched_at") or ""
    try:
        # accept Z or offset
        from datetime import datetime
        t = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except Exception:
        print(f"  ❌ bad fetched_at on {p}.json: {ts!r}")
        failed = 1
        continue
    age = now - int(t)
    if age > hard:
        print(f"  ❌ STALE (>{21}d): {p}.json fetched_at={ts}")
        failed = 1
    elif age > soft:
        print(f"  ⚠️  soft (>{14}d): {p}.json fetched_at={ts}")
    else:
        print(f"  ✅ {p}.json age ok ({age // 86400}d)")
sys.exit(failed)
PY
fi

# ── Vodou-channels + file:@vodou/channel-sdk ───────────────────────────────────
echo ""
echo "── Vodou-channels (channel-sdk) ──────────────────────────────────────────"
VC="$EXTRACTED/MCP-servers/Vodou-channels"
if [ -d "$VC" ]; then
    if [ -f "$VC/package.json" ]; then
        echo "  ✅ package.json"
    else
        echo "  ❌ MISSING: Vodou-channels/package.json"
        FAILED=1
    fi
    if [ -f "$VC/packages/sdk/dist/index.js" ]; then
        echo "  ✅ packages/sdk/dist/index.js"
    else
        echo "  ❌ MISSING: packages/sdk/dist/index.js (prebuild must compile packages/sdk before npm install)"
        FAILED=1
    fi
    if [ -e "$VC/node_modules/@vodou/channel-sdk" ]; then
        echo "  ✅ node_modules/@vodou/channel-sdk"
    else
        echo "  ❌ MISSING: node_modules/@vodou/channel-sdk"
        FAILED=1
    fi
else
    echo "  ⏭  Vodou-channels/ not in archive (skipped)"
fi

# ── figma-developer-mcp (Apps → Figma, bundled Framelink server) ─────────────
echo ""
echo "── figma-developer-mcp (Framelink) ───────────────────────────────────────"
FIG_BIN="$EXTRACTED/MCP-servers/figma-developer-mcp/node_modules/figma-developer-mcp/dist/bin.js"
if [ -f "$FIG_BIN" ]; then
    echo "  ✅ bundled: figma-developer-mcp → dist/bin.js"
else
    echo "  ❌ MISSING: MCP-servers/figma-developer-mcp/node_modules/figma-developer-mcp/dist/bin.js"
    echo "     Prebuilt release must run copy_server_prebuilt figma-developer-mcp (see .build/scripts/build-release-multi-arch-prebuilt.sh)"
    FAILED=1
fi

# ── Required skills ────────────────────────────────────────────────────────────
echo ""
echo "── Skills ────────────────────────────────────────────────────────────────"
SKILL_COUNT=0
if [ -d "$EXTRACTED/skills" ]; then
    SKILL_COUNT=$(find "$EXTRACTED/skills" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
    echo "  ✅ skills/ ($SKILL_COUNT skill files)"
else
    echo "  ❌ MISSING: skills/"
    FAILED=1
fi
[ "$SKILL_COUNT" -lt 5 ] && { echo "  ❌ Expected at least 5 skill files, found $SKILL_COUNT"; FAILED=1; }

# ── update-manifest.json ───────────────────────────────────────────────────────
echo ""
echo "── update-manifest.json ──────────────────────────────────────────────────"
if [ -f "$EXTRACTED/update-manifest.json" ]; then
    echo "  ✅ update-manifest.json present"
    # Validate required fields
    for FIELD in version platform binaries binary_max_schema_version; do
        if grep -q "\"$FIELD\"" "$EXTRACTED/update-manifest.json"; then
            echo "    ✅ field: $FIELD"
        else
            echo "    ❌ MISSING field: $FIELD"
            FAILED=1
        fi
    done
    # Check version matches archive name
    MANIFEST_VER=$(grep '"version"' "$EXTRACTED/update-manifest.json" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
    ARCHIVE_BASE=$(basename "$ARCHIVE")
    if echo "$ARCHIVE_BASE" | grep -q "$MANIFEST_VER"; then
        echo "    ✅ version ($MANIFEST_VER) matches archive filename"
    else
        echo "    ⚠️  version ($MANIFEST_VER) may not match archive filename ($ARCHIVE_BASE)"
    fi
else
    echo "  ⚠️  update-manifest.json absent (updater will soft-skip validation)"
fi

# ── vodou-core version must match update-manifest.json (catches wrong tarball) ──
echo ""
echo "── Binary vs manifest version ─────────────────────────────────────────────"
if [ -x "$EXTRACTED/vodou-core" ] && [ -f "$EXTRACTED/update-manifest.json" ]; then
    MANIFEST_VER=$(grep '"version"' "$EXTRACTED/update-manifest.json" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
    BIN_LINE=$("$EXTRACTED/vodou-core" version 2>/dev/null || true)
    BIN_VER=$(echo "$BIN_LINE" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | tail -1)
    if [ -n "$MANIFEST_VER" ] && [ -n "$BIN_VER" ] && [ "$MANIFEST_VER" = "$BIN_VER" ]; then
        echo "  ✅ vodou-core ($BIN_VER) matches update-manifest.json"
    else
        echo "  ❌ CRITICAL: manifest version '$MANIFEST_VER' vs binary '$BIN_LINE' (parsed: '$BIN_VER')"
        FAILED=1
    fi
else
    echo "  ⏭  skipped (need executable vodou-core + update-manifest.json)"
fi

# ── Forbidden: backup / pre-migration artifacts ───────────────────────────────
# Defense-in-depth match to the build script's strip pass. If anything *.bak /
# *.bak2 / *.pre-* slipped through, fail loud — these range from cosmetic clutter
# (SKILL.md.pre-migrate.bak ×~50) to actual credential leaks
# (credentials.json.bak2). Caught the v0.5.97 ~80-file pollution + possible
# OAuth backup in MCP-servers/gmail/.
echo ""
echo "── Forbidden: backup / pre-migration artifacts ──────────────────────────"
BAK_FILES=$(find "$EXTRACTED" -type f \( -name "*.bak" -o -name "*.bak[0-9]" -o -name "*.pre-*" \) 2>/dev/null || true)
if [ -n "$BAK_FILES" ]; then
    BAK_COUNT=$(echo "$BAK_FILES" | wc -l | tr -d ' ')
    echo "  ❌ CRITICAL: found $BAK_COUNT backup file(s) in archive:"
    echo "$BAK_FILES" | head -20 | sed 's/^/    /'
    [ "$BAK_COUNT" -gt 20 ] && echo "    ... ($((BAK_COUNT - 20)) more)"
    FAILED=1
else
    echo "  ✅ No .bak / .pre-* backup files in archive"
fi
# Misplaced DBs in public/ asset dirs (v0.5.97: 28MB brain-trust4.db under public/icons)
PUBLIC_DBS=$(find "$EXTRACTED/MCP-servers" -path '*/public/*' \( -name "*.db" -o -name "*.db-*" \) 2>/dev/null || true)
if [ -n "$PUBLIC_DBS" ]; then
    echo "  ❌ CRITICAL: stray .db file(s) under MCP-servers/*/public/:"
    echo "$PUBLIC_DBS" | sed 's/^/    /'
    FAILED=1
else
    echo "  ✅ No stray .db files under MCP-servers/*/public/"
fi

# ── Forbidden: source code ─────────────────────────────────────────────────────
echo ""
echo "── Forbidden files (must be absent) ─────────────────────────────────────"
[ -d "$EXTRACTED/src" ]            && { echo "  ❌ CRITICAL: src/ (source code) in archive"; FAILED=1; } || echo "  ✅ src/ absent"
[ -f "$EXTRACTED/Cargo.toml" ]     && { echo "  ❌ CRITICAL: Cargo.toml in archive"; FAILED=1; }         || echo "  ✅ Cargo.toml absent"
[ -f "$EXTRACTED/Cargo.lock" ]     && { echo "  ❌ CRITICAL: Cargo.lock in archive"; FAILED=1; }         || echo "  ✅ Cargo.lock absent"
[ -d "$EXTRACTED/.git" ]           && { echo "  ❌ CRITICAL: .git/ in archive"; FAILED=1; }              || echo "  ✅ .git/ absent"
[ -d "$EXTRACTED/backups" ]        && { echo "  ❌ CRITICAL: backups/ in archive"; FAILED=1; }           || echo "  ✅ backups/ absent"
[ -d "$EXTRACTED/update_staging" ] && { echo "  ❌ CRITICAL: update_staging/ in archive"; FAILED=1; }   || echo "  ✅ update_staging/ absent"
[ -f "$EXTRACTED/.update-lock" ]   && { echo "  ❌ CRITICAL: .update-lock in archive"; FAILED=1; }      || echo "  ✅ .update-lock absent"
[ -f "$EXTRACTED/.env" ]           && { echo "  ❌ CRITICAL: .env (live credentials) in archive"; FAILED=1; } || echo "  ✅ .env absent"

# Proprietary content must NOT ship (the release archive is the public/open surface).
# skills/autonomous = local skill-learning output (operator-derived; can embed
# chat excerpts / sender handles). Must ship EMPTY.
AUTONOMOUS_SKILLS=$(find "$EXTRACTED/skills/autonomous" -name "SKILL.md" 2>/dev/null || true)
if [ -n "$AUTONOMOUS_SKILLS" ]; then
    echo "  ❌ CRITICAL: locally-learned autonomous skills in archive (operator-derived content):"
    echo "$AUTONOMOUS_SKILLS" | head -5 | sed 's/^/    /'
    FAILED=1
else
    echo "  ✅ skills/autonomous ships empty"
fi

# ExecDesk personas/action-skills are commercial IP — build-release.sh strips them; this
# is the hard gate so a build regression can't re-leak them. (PLANS/0.6.5 OPEN-SOURCE-READINESS)
STRAY_EXECDESK=$(find "$EXTRACTED/skills" -maxdepth 2 -type d -name "execdesk-*" 2>/dev/null || true)
if [ -n "$STRAY_EXECDESK" ]; then
    echo "  ❌ CRITICAL: ExecDesk proprietary content in archive (must be excluded):"
    echo "$STRAY_EXECDESK" | sed 's/^/    /'
    FAILED=1
else
    echo "  ✅ No ExecDesk proprietary content (skills/catalog/execdesk-*)"
fi

# .env* anywhere in the tree (caught the v0.5.78 .env.backup-* leak)
STRAY_ENVS=$(find "$EXTRACTED" -type f \( -name ".env" -o -name ".env.*" \) ! -name ".env.example" 2>/dev/null || true)
if [ -n "$STRAY_ENVS" ]; then
    echo "  ❌ CRITICAL: stray .env / .env.* files (potential credentials leak):"
    echo "$STRAY_ENVS" | sed 's/^/    /'
    FAILED=1
else
    echo "  ✅ No stray .env / .env.* files (besides .env.example)"
fi

# ── Embedded-secret scan of shipped binaries (defense-in-depth) ──────────────
# `strings` the binaries and FAIL if any look like a baked-in credential. This
# catches an accidentally-compiled-in secret (API key / token / private key) — it
# does NOT (and is not meant to) hide the binary's STRUCTURE: command names and
# CLI help text are expected in `strings` output and are fine (commodity, not
# secret). Patterns are high-confidence prefixes so help text never false-positives.
echo ""
echo "── Embedded-secret scan (binaries) ──────────────────────────────────────"
SECRET_HIT=""
for BIN in "$EXTRACTED/vodou-core" "$EXTRACTED/vodou-hook-bin" "$EXTRACTED/oi"; do
    [ -f "$BIN" ] || continue
    # Entropy guard: drop candidates with a run of 6+ identical chars. Real
    # credentials are high-entropy and never have such runs; they only appear
    # when `strings` glues adjacent binary literals across a missing null byte
    # (e.g. the legit "ExecDesk-Console" component name abutting a parser
    # char-class table "6666…jjjj" in the x86_64 layout → bogus "sk-Console66…jj").
    # This preserves real-secret detection while killing layout-artifact false positives.
    HIT=$(strings -n 8 "$BIN" 2>/dev/null | grep -aoE 'sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----' | perl -ne 'print unless /(.)\1{5,}/' | head -3 || true)
    if [ -n "$HIT" ]; then
        echo "  ❌ CRITICAL: possible embedded secret in $(basename "$BIN"):"
        echo "$HIT" | sed 's/^/    [redacted-prefix] /'
        SECRET_HIT=1
        FAILED=1
    fi
done
[ -z "$SECRET_HIT" ] && echo "  ✅ No embedded secret patterns in shipped binaries"

# ── Operator-PII scan (text files) ───────────────────────────────────────────
# The 2026-07-02 audit found the operator's real phone/email/paths in shipped
# docs and the gateway's public/api-manifest.json example payloads. Patterns
# live OUTSIDE the shipped surface (.build/ never ships; scripts/ does — so
# hardcoding the patterns here would itself leak them). One pattern per line,
# grep -E syntax, '#' comments allowed. Skipped with a warning if the file is
# absent (e.g. CI checkout without .build/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PII_PATTERNS="$SCRIPT_DIR/../.build/release-pii-patterns.txt"
if [ -f "$PII_PATTERNS" ]; then
    PII_HIT=""
    while IFS= read -r PAT; do
        case "$PAT" in ''|'#'*) continue ;; esac
        MATCHES=$(grep -rIlE "$PAT" "$EXTRACTED" --exclude-dir=node_modules 2>/dev/null | head -5 || true)
        if [ -n "$MATCHES" ]; then
            echo "  ❌ CRITICAL: operator PII pattern matched in archive:"
            echo "$MATCHES" | sed "s|$EXTRACTED|    |"
            PII_HIT=1
            FAILED=1
        fi
    done < "$PII_PATTERNS"
    [ -z "$PII_HIT" ] && echo "  ✅ No operator PII patterns in shipped text files"
else
    echo "  ⚠️  $PII_PATTERNS absent — operator PII scan skipped"
fi

# .vodou/secrets and google-oauth.json (OAuth client credentials — never ship)
if [ -d "$EXTRACTED/.vodou/secrets" ]; then
    echo "  ❌ CRITICAL: .vodou/secrets/ in archive (e.g. google-oauth.json)"
    FAILED=1
else
    echo "  ✅ .vodou/secrets/ absent"
fi
STRAY_GOOGLE_OAUTH=$(find "$EXTRACTED" -type f -name "google-oauth.json" ! -path "*/node_modules/*" 2>/dev/null || true)
if [ -n "$STRAY_GOOGLE_OAUTH" ]; then
    echo "  ❌ CRITICAL: google-oauth.json in archive:"
    echo "$STRAY_GOOGLE_OAUTH" | sed 's/^/    /'
    FAILED=1
else
    echo "  ✅ google-oauth.json absent"
fi
STRAY_TOKEN_FILES=$(find "$EXTRACTED" -type f \( -name "tokens.json" -o -name "credentials.json" \) ! -path "*/node_modules/*" 2>/dev/null || true)
if [ -n "$STRAY_TOKEN_FILES" ]; then
    echo "  ❌ CRITICAL: MCP OAuth sidecar (tokens.json / credentials.json) in archive:"
    echo "$STRAY_TOKEN_FILES" | sed 's/^/    /'
    FAILED=1
else
    echo "  ✅ No tokens.json / credentials.json outside node_modules"
fi

# whatsapp-bridge binary must match the archive's target architecture.
# Detect arch from filename: ...-arm64.tar.gz vs ...-intel.tar.gz
ARCHIVE_BASE=$(basename "$ARCHIVE")
EXPECTED_BRIDGE_ARCH=""
case "$ARCHIVE_BASE" in
    *-arm64.tar.gz|*-arm64.zip) EXPECTED_BRIDGE_ARCH="arm64" ;;
    *-intel.tar.gz|*-intel.zip|*-x86_64.tar.gz) EXPECTED_BRIDGE_ARCH="x86_64" ;;
esac
BRIDGE="$EXTRACTED/MCP-servers/Vodou-channels/whatsapp-bridge/whatsapp-bridge"
if [ -f "$BRIDGE" ]; then
    if [ -n "$EXPECTED_BRIDGE_ARCH" ] && command -v file &>/dev/null; then
        BRIDGE_INFO=$(file "$BRIDGE")
        if echo "$BRIDGE_INFO" | grep -q "$EXPECTED_BRIDGE_ARCH"; then
            echo "  ✅ whatsapp-bridge is $EXPECTED_BRIDGE_ARCH"
        else
            echo "  ❌ CRITICAL: whatsapp-bridge arch mismatch — expected $EXPECTED_BRIDGE_ARCH, got: $BRIDGE_INFO"
            FAILED=1
        fi
    fi
    [ -x "$BRIDGE" ] || { echo "  ❌ whatsapp-bridge is not executable"; FAILED=1; }
else
    echo "  ⚠️  whatsapp-bridge binary not shipped (WhatsApp channel will be unavailable)"
fi

# ── Forbidden: unexpected databases (CRITICAL) ────────────────────────────────
# Template DBs (vodou-core.db, memory.db, skills/skills_registry.db) ship intentionally.
# mcp-registry/data/registry.db is the catalog of installable MCP servers
# (~2600 targets) bundled by build-release-multi-arch-prebuilt.sh — read-only,
# no user data, intentionally shipped.
# Flag anything else — e.g. gateway.db, thinking.db, or stray DBs inside skill dirs.
echo ""
echo "── Unexpected databases (template DBs are allowed) ─────────────────────"
ALLOWED_DBS="vodou-core.db|memory.db|skills/skills_registry.db|mcp-registry/data/registry.db"
UNEXPECTED_DB_FILES=$(find "$EXTRACTED" \( -name "*.db" -o -name "*.db-wal" -o -name "*.db-shm" \) 2>/dev/null \
    | grep -v "node_modules\|/public/" \
    | grep -vE "/(vodou-core|memory)\.db$" \
    | grep -vE "/skills/skills_registry\.db$" \
    | grep -vE "/mcp-registry/data/registry\.db$" \
    || true)
if [ -n "$UNEXPECTED_DB_FILES" ]; then
    echo "  ❌ CRITICAL: unexpected .db files found (not template DBs):"
    echo "$UNEXPECTED_DB_FILES" | sed 's/^/    /'
    FAILED=1
else
    echo "  ✅ Only expected template DBs present"
fi

# ── Template DB contents (CRITICAL — must be empty of user data) ─────────────
# Filename allowlist alone is not enough: the v0.5.78 leak shipped a personal
# memory.db with 9,665 chunks because the build's schema-only template path
# fell back to `cp memory.db` on failure. Row-count gates catch that class
# of bug regardless of how the file got there.
echo ""
echo "── Template DB contents (must be empty of user data) ────────────────────"
if command -v sqlite3 &> /dev/null; then
    if [ -f "$EXTRACTED/memory.db" ]; then
        MEM_CHUNKS=$(sqlite3 "$EXTRACTED/memory.db" "SELECT COUNT(*) FROM memory_chunks;" 2>/dev/null || echo "ERR")
        if [ "$MEM_CHUNKS" = "0" ]; then
            echo "  ✅ memory.db has 0 memory_chunks rows"
        else
            echo "  ❌ CRITICAL: memory.db has $MEM_CHUNKS memory_chunks rows (user data leak)"
            FAILED=1
        fi
    fi
    if [ -f "$EXTRACTED/vodou-core.db" ]; then
        CORE_CREDS=$(sqlite3 "$EXTRACTED/vodou-core.db" "SELECT COUNT(*) FROM server_credentials;" 2>/dev/null || echo "0")
        CORE_CHUNKS=$(sqlite3 "$EXTRACTED/vodou-core.db" "SELECT COUNT(*) FROM memory_chunks;" 2>/dev/null || echo "0")
        if [ "$CORE_CREDS" = "0" ] && [ "$CORE_CHUNKS" = "0" ]; then
            echo "  ✅ vodou-core.db has 0 credentials and 0 memory_chunks"
        else
            echo "  ❌ CRITICAL: vodou-core.db has $CORE_CREDS credentials, $CORE_CHUNKS memory_chunks (user data leak)"
            FAILED=1
        fi
    fi
else
    echo "  ⚠️  sqlite3 not available — skipping DB content checks (install sqlite3 to verify)"
fi

# ── Memory embedders (PLAN-SELF-HEALING-MEMORY D1a) ───────────────────────────
# Fresh installs boot memory on bge-small offline; MiniLM stays for intent/skill.
# Packagers must stage both under .fastembed_cache (see build-desktop.sh /
# build-release-multi-arch-prebuilt.sh). Missing bge = airplane first-boot fail.
echo ""
echo "── Memory embedders (bge + MiniLM) ───────────────────────────────────────"
BGE_DIR="$EXTRACTED/.fastembed_cache/models--Qdrant--bge-small-en-v1.5-onnx-Q"
MINILM_DIR="$EXTRACTED/.fastembed_cache/models--Xenova--all-MiniLM-L6-v2"
# Desktop bundles may nest under Resources/fastembed_cache — accept either layout.
BGE_DESK="$EXTRACTED/Resources/fastembed_cache/models--Qdrant--bge-small-en-v1.5-onnx-Q"
MINILM_DESK="$EXTRACTED/Resources/fastembed_cache/models--Xenova--all-MiniLM-L6-v2"
if [ -d "$BGE_DIR" ] || [ -d "$BGE_DESK" ]; then
    echo "  ✅ bge-small-en-v1.5-onnx-Q staged"
else
    echo "  ❌ MISSING bge-small ONNX cache (.fastembed_cache/models--Qdrant--bge-small-en-v1.5-onnx-Q)"
    FAILED=1
fi
if [ -d "$MINILM_DIR" ] || [ -d "$MINILM_DESK" ]; then
    echo "  ✅ MiniLM (intent/skill) staged"
else
    echo "  ❌ MISSING MiniLM ONNX cache (.fastembed_cache/models--Xenova--all-MiniLM-L6-v2)"
    FAILED=1
fi
# Guard: release .env must not force EMBED_MODEL (empty-vault resolver owns fresh → bge)
if [ -f "$EXTRACTED/.env.example" ]; then
    if grep -q '^VODOU_MEMORY_EMBED_MODEL=' "$EXTRACTED/.env.example"; then
        echo "  ❌ .env.example sets VODOU_MEMORY_EMBED_MODEL=… (must stay commented for release defaults)"
        FAILED=1
    else
        echo "  ✅ .env.example leaves VODOU_MEMORY_EMBED_MODEL unset"
    fi
fi

# ── Executable bits ────────────────────────────────────────────────────────────
echo ""
echo "── Executable bits ───────────────────────────────────────────────────────"
for F in vodou-core oi vodou-hook-bin start-vodou-services.sh; do
    if [ -f "$EXTRACTED/$F" ]; then
        if [ -x "$EXTRACTED/$F" ]; then
            echo "  ✅ $F is executable"
        else
            echo "  ❌ $F is NOT executable"
            FAILED=1
        fi
    fi
done

# ── Summary ────────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════════════════"
if [ "$FAILED" -eq 0 ]; then
    echo "✅ All checks passed — release looks good to publish"
    exit 0
else
    echo "❌ RELEASE VERIFICATION FAILED — do not publish until all issues are resolved"
    exit 1
fi
