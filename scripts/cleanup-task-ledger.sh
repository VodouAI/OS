#!/usr/bin/env bash
# Safely deduplicate task_ledger.json in-place.
# - Backs up first
# - Shows diff
# - Requires explicit confirmation
# - Verifies JSON schema before overwriting
set -euo pipefail

LEDGER="${PWD}/.vodou/workspace/task_ledger.json"

if [ ! -f "$LEDGER" ]; then
    echo "No ledger found at $LEDGER"
    exit 1
fi

TIMESTAMP=$(date +%Y%m%dT%H%M%S)
BACKUP="${LEDGER}.pre-fix-${TIMESTAMP}"

# Gap 10: backup first
cp "$LEDGER" "$BACKUP"
echo "Backed up to: $BACKUP"

# Dedupe by title (mirrors task_title() logic: first **bold** or text before em-dash, lowercased)
jq '
  .tasks as $all
  | .tasks = (
      $all
      | group_by(
          .text
          | gsub("\\*\\*"; "")
          | gsub("\\*"; "")
          | gsub("[🔴⚠️✅🟡🟢]"; "")
          | split(" — ")[0]
          | ascii_downcase
          | sub("^\\s+"; "")
          | sub("\\s+$"; "")
        )
      | map(
          if length == 1 then .[0]
          else (
            .[0]
            + {
                text:          (max_by(.last_seen_run // 0).text),
                last_seen_run: (map(.last_seen_run // 0) | max),
                stale_runs:    (map(.stale_runs // 0) | min),
                created_run:   (map(.created_run // 0) | min)
              }
          )
          end
        )
    )
  | .updated_at = (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
' "$LEDGER" > /tmp/ledger-cleaned.json

echo ""
echo "=== BEFORE ==="
jq '.tasks | length as $total | {total:$total, open:[.[] | select(.status=="open")] | length, done:[.[] | select(.status=="done")] | length}' "$LEDGER"
echo ""
echo "=== AFTER ==="
jq '.tasks | length as $total | {total:$total, open:[.[] | select(.status=="open")] | length, done:[.[] | select(.status=="done")] | length}' /tmp/ledger-cleaned.json
echo ""
echo "=== DIFF (titles only) ==="
diff <(jq -r '.tasks[] | "\(.status // "?"): \(.text)"' "$LEDGER" | sort) \
     <(jq -r '.tasks[] | "\(.status // "?"): \(.text)"' /tmp/ledger-cleaned.json | sort) || true
echo ""
read -r -p "Apply cleanup? [y/N] " confirm
if [[ "$confirm" =~ ^[Yy]$ ]]; then
    # R7: post-migration schema verification before overwriting live ledger
    if ! jq empty /tmp/ledger-cleaned.json 2>/dev/null; then
        echo "CORRUPTED — cleaned file is not valid JSON. Aborting."
        echo "   Backup preserved at $BACKUP"
        exit 1
    fi
    if ! jq -e '.tasks | type == "array"' /tmp/ledger-cleaned.json > /dev/null; then
        echo "SCHEMA ERROR — .tasks is not an array. Aborting."
        exit 1
    fi
    if ! jq -e '(.tasks | length) as $total | [.tasks[] | select(.text and .status)] | length == $total' /tmp/ledger-cleaned.json > /dev/null; then
        echo "SCHEMA ERROR — some tasks missing text or status field. Aborting."
        exit 1
    fi
    echo "Schema smoke tests passed"
    cp /tmp/ledger-cleaned.json "$LEDGER"
    echo "Done. Backup preserved at $BACKUP"
else
    echo "Aborted. Ledger unchanged. Backup preserved at $BACKUP"
fi
