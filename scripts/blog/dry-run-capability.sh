#!/usr/bin/env bash
# Write the next capability post WITHOUT shipping it.
#
# Picks the capability the lane would write next (or the one named as $1),
# drafts it with the full pipeline (brief, diagrams, redaction gate, rubric,
# revision, 8b signup-link and graphics check) and writes it to
# .vodou/blog/test-drafts/. Nothing under content/blog changes, so no deploy
# or freshness run can publish it, and the ledger is untouched, so the
# capability is still owed a real post.
#
# Usage: scripts/blog/dry-run-capability.sh [capability-id]
# Exit codes are the writer's: 0 drafted, 2 redaction gate blocked, 1 anything else.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
OUT=".vodou/blog/test-drafts"
mkdir -p "$OUT"
JSON="$OUT/capability.json"

if [[ -n "${1:-}" ]]; then
  # A named capability: pretend nothing is covered and the quota is free, so
  # `next` walks the whole list, then keep only the one asked for.
  EMPTY=$(mktemp -d)
  printf '{"published":[]}' > "$EMPTY/l.json"
  python3 - "$1" "$EMPTY/l.json" "$EMPTY" "$JSON" <<'PY'
import json, subprocess, sys
want, ledger, blogdir, out = sys.argv[1:5]
caps = json.load(open("scripts/blog/capabilities.json"))["capabilities"]
if not any(c["id"] == want and c["eligible"] for c in caps):
    sys.exit(f"no eligible capability named {want}")
covered = [{"post_mode": "capability", "capability_id": c["id"]} for c in caps
           if c["eligible"] and c["id"] != want]
json.dump({"published": covered}, open(ledger, "w"))
got = subprocess.run(["python3", "scripts/blog/capabilities.py", "next", "--ledger", ledger,
                      "--blogdir", blogdir, "--out", out, "--per-day", "0"],
                     capture_output=True, text=True).stdout.strip()
if got != want:
    sys.exit(f"next picked {got!r}, wanted {want!r}")
PY
  rm -rf "$EMPTY"
  PICK="$1"
else
  PICK=$(python3 scripts/blog/capabilities.py next --out "$JSON" --per-day 0)
fi
[[ -n "$PICK" ]] || { echo "every eligible capability already has a post"; exit 0; }

echo "[dry-run] capability: $PICK"
BLOG_DRY_OUTDIR="$OUT" BLOG_ANGLE="${BLOG_ANGLE:-teach}" BLOG_KEEP_WORK="${BLOG_KEEP_WORK:-1}" \
  ./scripts/blog/write-feature-post.sh --feature-json "$JSON" --slot "${BLOG_SLOT:-midday}"
