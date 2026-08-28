#!/bin/sh
# PLAN-BRAIN-INTO-CONSOLE P0.1 — re-copy the canonical brain query layer into
# the Console. Source of truth: MCP-servers/brain/src/{queries,db}.ts.
# Keeps the Console-only header + root-derivation block; everything from the
# `// ── Provenance` marker down is replaced verbatim. The drift test
# (Vodou-Console/src/__tests__/brain-queries-drift.test.ts) checks the result.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/MCP-servers/brain/src"
DST="$ROOT/MCP-servers/Vodou-Console/src/brain"
MARK='// ── Provenance / trust'
cp "$SRC/db.ts" "$DST/db.ts"
head_n=$(grep -n -F "$MARK" "$DST/queries.ts" | head -1 | cut -d: -f1)
src_n=$(grep -n -F "$MARK" "$SRC/queries.ts" | head -1 | cut -d: -f1)
[ -n "$head_n" ] && [ -n "$src_n" ] || { echo "marker not found" >&2; exit 1; }
{ head -n "$((head_n - 1))" "$DST/queries.ts"; tail -n "+$src_n" "$SRC/queries.ts"; } > "$DST/queries.ts.new"
mv "$DST/queries.ts.new" "$DST/queries.ts"
echo "synced $DST/queries.ts from $SRC/queries.ts (from line $src_n)"
