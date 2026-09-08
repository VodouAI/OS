#!/usr/bin/env bash
# DI-2 Experiment 4 — "reproduce deliberately".
#
# Runs every arm against THROWAWAY databases in a temp dir. Never opens
# gateway.db. Both runtimes, because the whole point is the Node comparison.
#
#   bash scripts/di2/run-experiment-4.sh [outdir]
#
# Findings from the 2026-09-05 run are in .build/DI-2-GATEWAY-DB-CORRUPTION.md.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${1:-$(mktemp -d -t di2)}"
mkdir -p "$OUT"

N24="$ROOT/.node/node"
N22="$(command -v node)"
[ -x "$N24" ] || { echo "no .node/node — see DI-2 doc, this tree keeps Node 24 there"; exit 1; }
echo "node24: $($N24 -v)   node22-or-PATH: $($N22 -v)   out: $OUT"

for N in "$N24" "$N22"; do
  V="$($N -v)"
  for MODE in faithful desync; do
    echo; echo "===== $V · $MODE ====="
    "$N" "$ROOT/scripts/di2/exp4.mjs" "$MODE" 40 4000 "$OUT" 2>&1 | grep -v Experimental
  done

  echo; echo "===== $V · concurrent: 1 long-lived handle + 3 writer processes ====="
  F="$OUT/shared-$(basename "$N")-$RANDOM.db"
  "$N" "$ROOT/scripts/di2/setup.mjs" "$F" 2>&1 | grep -v Experimental
  ( "$N" "$ROOT/scripts/di2/holder.mjs" "$F" 32 &
    sleep 1
    "$N" "$ROOT/scripts/di2/writer.mjs" "$F" A 28 &
    "$N" "$ROOT/scripts/di2/writer.mjs" "$F" B 28 &
    "$N" "$ROOT/scripts/di2/writer.mjs" "$F" C 28 &
    wait ) 2>&1 | grep -vE "Experimental|trace-warnings"
  echo "--- fresh connection to the same file ---"
  "$N" "$ROOT/scripts/di2/fresh.mjs" "$F" 2>&1 | grep -v Experimental

  echo; echo "===== $V · CONTROL: identical traffic, no FTS5 table ====="
  G="$OUT/nofts-$(basename "$N")-$RANDOM.db"
  DI2_NOFTS=1 "$N" "$ROOT/scripts/di2/setup.mjs" "$G" 2>&1 | grep -v Experimental
  ( DI2_NOFTS=1 "$N" "$ROOT/scripts/di2/holder.mjs" "$G" 32 &
    sleep 1
    "$N" "$ROOT/scripts/di2/writer.mjs" "$G" A 28 &
    "$N" "$ROOT/scripts/di2/writer.mjs" "$G" B 28 &
    "$N" "$ROOT/scripts/di2/writer.mjs" "$G" C 28 &
    wait ) 2>&1 | grep -vE "Experimental|trace-warnings"
done
echo; echo "artifacts left in $OUT"
