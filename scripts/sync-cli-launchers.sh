#!/usr/bin/env bash
# Keep root launchers byte-identical: do (source of truth) → oi, vodou.
# No symlinks — zip/install bundles stay valid everywhere.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[ -f "$ROOT/do" ] || { echo "missing $ROOT/do"; exit 1; }
cp "$ROOT/do" "$ROOT/oi"
cp "$ROOT/do" "$ROOT/vodou"
chmod +x "$ROOT/do" "$ROOT/oi" "$ROOT/vodou"
echo "Synced: do → oi, do → vodou ($(wc -c < "$ROOT/do") bytes each)"
