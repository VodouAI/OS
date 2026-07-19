#!/usr/bin/env bash
# scripts/lint-continuity-boundary.sh
#
# Enforces the continuity primitive boundary (PLAN-CONTINUITY-PRIMITIVE.md §12.5).
# SYMMETRIC: read AND write paths guarded. Every chokepoint API has a paired grep
# rule on the opposite side. Asymmetric enforcement = silent drift; this script
# prevents that.
#
# Run in CI; fail the build on any forbidden match.
#
# Phase 0 (this commit, v0.5.75): schema + types only — most rules below are
# enabled but tolerant (zero matches expected today). Phase 1 (record_turn) and
# Phase 2 (recall) enable the strict patterns once the canonical APIs land.

set -euo pipefail

cd "$(dirname "$0")/.."

EXIT=0

# ─── Phase 0 sanity checks ───────────────────────────────────────────────────

if [ ! -d "src/continuity" ]; then
  echo "❌ src/continuity/ directory missing — Phase 0 not applied."
  EXIT=1
fi

for f in src/continuity/mod.rs src/continuity/principal.rs src/continuity/resolver.rs; do
  if [ ! -f "$f" ]; then
    echo "❌ $f missing — Phase 0 incomplete."
    EXIT=1
  fi
done

if ! grep -q "pub mod continuity;" src/lib.rs; then
  echo "❌ src/lib.rs does not register pub mod continuity;"
  EXIT=1
fi

if [ ! -f "migrations/068_continuity_principals.sql" ]; then
  echo "❌ migrations/068_continuity_principals.sql missing"
  EXIT=1
fi

# ─── Phase 1 (record_turn) — write-side enforcement ──────────────────────────
# Enable strict mode once src/continuity/record_turn.rs lands.
PHASE_1_ACTIVE=0
if [ -f "src/continuity/record_turn.rs" ]; then
  PHASE_1_ACTIVE=1
fi

if [ "$PHASE_1_ACTIVE" = "1" ]; then
  RAW_GW_INSERTS=$(grep -rn "INSERT INTO gateway_messages" src/ \
    --include="*.rs" \
    | grep -v "src/continuity/record_turn.rs" || true)
  if [ -n "$RAW_GW_INSERTS" ]; then
    echo "❌ Direct INSERT INTO gateway_messages outside src/continuity/record_turn.rs:"
    echo "$RAW_GW_INSERTS"
    EXIT=1
  fi

  # memory_chunks allowlist: chokepoint + legitimate write paths surveyed 2026-05-09.
  # Rationale: record_turn writes gateway_messages, NOT memory_chunks (chunks come from
  # the extractor pipeline). The chunk-write paths below are the architecturally-blessed
  # producers of memory_chunks rows — adding a NEW writer here = architectural review.
  #
  #   src/continuity/                — chokepoint module (future record_turn helpers)
  #   src/memory/file_indexer.rs     — disk path indexer
  #   src/memory/sync.rs             — sync loop
  #   src/memory_extraction.rs       — hook-side extractor
  #   src/gateway_extractor.rs       — gateway-side extractor (reads gateway_messages → chunks)
  #   src/memory_flush.rs            — SessionEnd flush from hook
  #   src/memory_janitor.rs          — consolidation / dedup writes
  #   src/database.rs                — TEST FIXTURES ONLY (tests::* mods); production goes through Database methods
  #   src/memory/search.rs           — TEST FIXTURES ONLY (PLAN-PROJECT-SCOPED-MEMORY project-axis tests seed chunks)
  #   src/board/context.rs           — TEST FIXTURES ONLY (tests::seed_memory_chunk); production reads via sock_client search
  RAW_MEM_INSERTS=$(grep -rn "INSERT INTO memory_chunks" src/ \
    --include="*.rs" \
    | grep -v -E "src/continuity/|src/memory/(file_indexer|sync|search)\.rs|src/memory_extraction\.rs|src/gateway_extractor\.rs|src/memory_flush\.rs|src/memory_janitor\.rs|src/database\.rs|src/board/context\.rs" \
    || true)
  if [ -n "$RAW_MEM_INSERTS" ]; then
    echo "❌ Direct INSERT INTO memory_chunks outside continuity + extractor allowlist:"
    echo "$RAW_MEM_INSERTS"
    echo ""
    echo "If this is a new architecturally-approved chunk-writer, add it to the allowlist"
    echo "in scripts/lint-continuity-boundary.sh with a one-line comment explaining why."
    EXIT=1
  fi
fi

# ─── Tool-audit chokepoint (PLAN-TOOL-CALL-CAPTURE.md Delta 1) ──────────────
TOOL_AUDIT_ACTIVE=0
if [ -f "src/tool_audit.rs" ]; then
  TOOL_AUDIT_ACTIVE=1
fi

if [ "$TOOL_AUDIT_ACTIVE" = "1" ]; then
  RAW_AUDIT_INSERTS=$(grep -rn "INSERT INTO tool_call_events" src/ \
    --include="*.rs" \
    | grep -v "src/tool_audit.rs" || true)
  if [ -n "$RAW_AUDIT_INSERTS" ]; then
    echo "❌ Direct INSERT INTO tool_call_events outside src/tool_audit.rs:"
    echo "$RAW_AUDIT_INSERTS"
    EXIT=1
  fi
fi

# ─── Phase 2 (recall) — read-side enforcement ────────────────────────────────
# Enable strict mode once src/continuity/recall.rs lands.
PHASE_2_ACTIVE=0
if [ -f "src/continuity/recall.rs" ]; then
  PHASE_2_ACTIVE=1
fi

if [ "$PHASE_2_ACTIVE" = "1" ]; then
  # Catches BOTH `MemorySearch::search(...)` (bare) and `MemorySearch::search_*`.
  # The bare form was a silent bypass under the old `search_` regex — agent.rs
  # and autonomous_planning.rs slipped through pre-2026-05-09. Asymmetric write
  # AND read enforcement is the §10 risk #4 lesson; the regex covers both.
  # src/memory/search.rs is the DEFINING module — its unit tests exercise the
  # API in place (PLAN-PROJECT-SCOPED-MEMORY project-axis tests). Production
  # callers still must go through continuity::recall.
  # The trailing grep -v drops comment-only lines (`//`, `///`, `//!`) — doc
  # comments that *mention* the API are not calls (board/context.rs:11 was a
  # long-standing false positive that kept this lint red on clean trees).
  RAW_SEARCH_CALLS=$(grep -rn -E "MemorySearch::search[(_]" src/ \
    --include="*.rs" \
    | grep -v -E "src/continuity/|src/memory/search\.rs" \
    | grep -v -E "^[^:]+:[0-9]+:[[:space:]]*//" || true)
  if [ -n "$RAW_SEARCH_CALLS" ]; then
    echo "❌ Direct MemorySearch::search* call outside src/continuity/:"
    echo "$RAW_SEARCH_CALLS"
    EXIT=1
  fi
fi

# ─── Result ──────────────────────────────────────────────────────────────────

if [ $EXIT -eq 0 ]; then
  echo "✅ Continuity boundary clean (phase_1=$PHASE_1_ACTIVE phase_2=$PHASE_2_ACTIVE tool_audit=$TOOL_AUDIT_ACTIVE)."
fi

exit $EXIT
