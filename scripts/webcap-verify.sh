#!/bin/sh
# Verify what web capture ACTUALLY stored — text, not console claims.
#
#   scripts/webcap-verify.sh                # every provider, summary
#   scripts/webcap-verify.sh kimi           # one provider, full text head/tail per row
#   scripts/webcap-verify.sh kimi VDU-KIMI  # also sweep memory.db for that canary
#
# Why this exists: "captured 2 turn(s)" is not proof. A mislabelled pair counts as 2,
# and a reply clipped at the first word looks perfect in every cheaper check.
# See PLANS/0.6.21/extention/CAPTURE-ADAPTER-DEBUGGING.md.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
GW="$ROOT/MCP-servers/Vodou-Console/gateway.db"
MEM="$ROOT/memory.db"
SITE=${1:-}
CANARY=${2:-}

if [ ! -f "$GW" ]; then echo "no gateway.db at $GW" >&2; exit 1; fi

if [ -z "$SITE" ]; then
  echo "== webcap providers in gateway.db =="
  sqlite3 -readonly "$GW" -column -header "
    SELECT substr(conversation_id, 8, instr(substr(conversation_id, 8), ':') - 1) AS provider,
           count(DISTINCT conversation_id) AS convs,
           count(*)                        AS msgs,
           sum(role = 'user')              AS user_turns,
           sum(role = 'assistant')         AS asst_turns,
           max(created_at)                 AS last_seen
      FROM gateway_messages
     WHERE conversation_id LIKE 'webcap:%'
     GROUP BY provider
     ORDER BY last_seen DESC;"
  exit 0
fi

echo "== webcap:$SITE — stored rows (first 90 chars / last 60 chars) =="
sqlite3 -readonly "$GW" -line "
  SELECT id,
         conversation_id,
         role,
         length(content)                                          AS len,
         substr(replace(content, char(10), ' '), 1, 90)           AS head,
         substr(replace(content, char(10), ' '), -60)             AS tail,
         created_at
    FROM gateway_messages
   WHERE conversation_id LIKE 'webcap:$SITE:%'
   ORDER BY id;"

echo
echo "== dedup keys (id: = provider msg id, h: = content hash) =="
sqlite3 -readonly "$GW" -column -header "
  SELECT role, substr(dedupe_key, 1, 24) AS dedupe_key, source_msg_id
    FROM gateway_messages
   WHERE conversation_id LIKE 'webcap:$SITE:%'
   ORDER BY id;" 2>/dev/null || echo "(no dedupe_key column — pre-P0 build)"

if [ -n "$CANARY" ] && [ -f "$MEM" ]; then
  echo
  echo "== memory.db chunks carrying '$CANARY' =="
  sqlite3 -readonly "$MEM" -column -header "
    SELECT id, scope, substr(replace(text, char(10), ' '), 1, 80) AS text
      FROM memory_chunks
     WHERE archived = 0 AND text LIKE '%$CANARY%'
     ORDER BY scope;"
fi
