#!/usr/bin/env bash
# backfill-chunk-tags.sh — populate `chunk_tag` for existing memory.db rows
# whose tag couldn't be parsed because the chunker prepended a section header
# before the [TAG] bullet. Pre-v0.5.65 chunks land with chunk_tag IS NULL even
# though the bullet text starts with [DONE]/[ISSUE]/[GOTCHA]/etc.
#
# Usage:  bash scripts/backfill-chunk-tags.sh
# Idempotent — only updates rows where chunk_tag IS NULL.

set -u
DB="${VODOU_MEMORY_DB:-memory.db}"
[ -f "$DB" ] || { echo "memory.db not found at $DB"; exit 1; }

# Map every canonical tag the extractor recognizes. Each line: TAG  PATTERN
# Patterns use SQLite GLOB-on-text-after-trimming; we anchor on `[TAG]` (case-
# insensitive) appearing somewhere in the chunk text.
TAGS=(
  DONE PLANNED ISSUE PREF DECISION GOTCHA DEAD_END METRIC PATTERN
  DEPENDENCY EXAMPLE RESEARCH SUPERSEDED FACT BUG FIX REFACTOR FEATURE
)

before=$(sqlite3 "$DB" "SELECT COUNT(*) FROM memory_chunks WHERE chunk_tag IS NULL OR chunk_tag = '';")
echo "Untagged chunks before: $before"

for tag in "${TAGS[@]}"; do
  # Match `[TAG]` anywhere in the text (case-insensitive). Standard SQLite has
  # no case-insensitive GLOB, so we lower() the text and the literal.
  literal="[$(echo "$tag" | tr '[:upper:]' '[:lower:]')]"
  n=$(sqlite3 "$DB" \
    "UPDATE memory_chunks
       SET chunk_tag = '$tag'
     WHERE (chunk_tag IS NULL OR chunk_tag = '')
       AND lower(text) LIKE '%${literal}%';
     SELECT changes();")
  [ "${n:-0}" -gt 0 ] && printf "  %-12s tagged %d row(s)\n" "$tag" "$n"
done

after=$(sqlite3 "$DB" "SELECT COUNT(*) FROM memory_chunks WHERE chunk_tag IS NULL OR chunk_tag = '';")
echo "Untagged chunks after:  $after"
echo
echo "Tag distribution:"
sqlite3 "$DB" "SELECT COALESCE(chunk_tag,'(null)'), COUNT(*) FROM memory_chunks GROUP BY chunk_tag ORDER BY 2 DESC;"
