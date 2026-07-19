#!/usr/bin/env bash
# Export intent_mappings from vodou-core.db to .vodou/workspace/intent_mappings.json
# so Vodou-LLM-router can load them and the LLM sees the same intents as the brain.
# Run from Vodou project root: ./MCP-servers/Vodou-LLM-router/scripts/export-intents-for-router.sh

set -e
VODOU_ROOT="${VODOU_ROOT:-$(pwd)}"
DB="${VODOU_ROOT}/vodou-core.db"
OUT="${VODOU_ROOT}/.vodou/workspace/intent_mappings.json"

if [[ ! -f "$DB" ]]; then
  echo "No vodou-core.db at $DB" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 not found; install it or run from an environment that has it." >&2
  exit 1
fi
sqlite3 -json "$DB" "SELECT keyword, server_name, tool_name, priority FROM intent_mappings ORDER BY priority DESC, keyword" | node -e "
const d = require('fs').readFileSync(0, 'utf8').trim();
const a = d.startsWith('[') ? JSON.parse(d) : d.split('\n').filter(Boolean).map(l => JSON.parse(l));
require('fs').writeFileSync(process.argv[1], JSON.stringify(a));
console.error('Exported ' + a.length + ' intents to ' + process.argv[1]);
" "$OUT"
