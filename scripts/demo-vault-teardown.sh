#!/usr/bin/env bash
# Remove the CWS-screenshot demo vault and the invented facts behind it.
#
# The seed facts ("Deploys on Fridays are banned", "standup is 9:15am ET", …) are
# indexed into the DEFAULT `web` scope, which means that until this runs they are
# ordinary memory: retrievable by normal search and eligible for injection into a
# real chat. Deleting the vault alone does NOT remove them — `mem vault delete`
# says "memory itself untouched" and means it.
#
# Set up by: PLANS/0.6.21/extention/CWS-SCREENSHOT-SHOOTING-SCRIPT.md
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SEED_DIR="${1:-$HOME/vodou-demo-vault}"

echo "→ un-indexing $SEED_DIR"
./vodou-core mem scan "$SEED_DIR" --remove || echo "  (nothing indexed — continuing)"

echo "→ deleting vault 'demo'"
./vodou-core mem vault delete demo || echo "  (no such vault — continuing)"

echo "→ verifying zero residue"
BY_PATH=$(sqlite3 memory.db "SELECT count(*) FROM memory_chunks WHERE path LIKE '%vodou-demo-vault%';")
# Match the BULLET FORM the scan stores ("- Deploys on Fridays…"), not the bare
# phrase. A loose '%Deploys on Fridays%' also matches this session's own work log
# ("Demo screenshot question chosen: …"), which is legitimate memory about real
# work and must not be deleted — it produced a false alarm on the first live run.
BY_TEXT=$(sqlite3 memory.db "SELECT count(*) FROM memory_chunks WHERE text LIKE '- Deploys on Fridays are banned%' OR text LIKE '- Postgres is the system of record; Redis%' OR text LIKE '- Prefers TypeScript with strict mode%';")
echo "  chunks by path: $BY_PATH"
echo "  chunks by text: $BY_TEXT"

if [ "$BY_PATH" != "0" ] || [ "$BY_TEXT" != "0" ]; then
  echo "ERROR: demo facts are still in memory.db — they remain injectable. Investigate before shipping." >&2
  exit 1
fi

rm -rf "$SEED_DIR"
echo "✓ demo vault gone, memory.db clean, seed dir removed"
