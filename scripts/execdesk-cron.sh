#!/usr/bin/env bash
#
# ExecDesk scheduled-action runner.
# Invoked by vodou-core's scheduler to fire an ExecDesk action skill on cron.
#
# Usage: execdesk-cron.sh <exec_id> "<trigger phrase>"
# Example: execdesk-cron.sh execdesk-ceo "generate this week's weekly brief"

set -e

EXEC_ID="${1:?usage: execdesk-cron.sh <exec_id> <prompt>}"
PROMPT="${2:?usage: execdesk-cron.sh <exec_id> <prompt>}"
GATEWAY="${EXECDESK_GATEWAY:-http://localhost:8765}"

# Cron tenant — separate from user sessions so user-tier limits don't apply.
CRON_TENANT="cron-${EXEC_ID}"

# Build payload via python to handle JSON escaping safely.
PAYLOAD=$(EXEC_ID="$EXEC_ID" PROMPT="$PROMPT" CRON_TENANT="$CRON_TENANT" python3 -c '
import os, json, sys
payload = {
    "prompt": os.environ["PROMPT"],
    "execs": [os.environ["EXEC_ID"]],
    "tenant_id": os.environ["CRON_TENANT"],
    "tier": "scale",
    "synthesize": False,
}
print(json.dumps(payload))
')

# Fire the call and summarize result for scheduler logs.
RESPONSE=$(curl -s --max-time 180 -X POST "${GATEWAY}/api/exec/team-consult" \
    -H 'Content-Type: application/json' \
    -d "$PAYLOAD")

echo "$RESPONSE" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    if d.get("execs"):
        e = d["execs"][0]
        role = (e.get("role") or "").upper()
        text = (e.get("text") or "")
        snippet = text[:200] + ("..." if len(text) > 200 else "")
        ms = e.get("ms", 0)
        print(f"[ExecDesk cron] {role} ({ms}ms): {snippet}")
    else:
        err = d.get("error", "unknown")
        print(f"[ExecDesk cron] FAILED: {err}")
except Exception as ex:
    print(f"[ExecDesk cron] parse error: {ex}")
'
