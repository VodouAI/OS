# Zoho channel adapter

Polls Zoho for recent activity and records each as a Vodou turn with
`Surface::Zoho`. Cross-surface recall surfaces Zoho history when discussing
customers / topics in Slack / web chat / IDE / etc.

## Two modes

**`ZOHO_MODE=mail`** (default) — polls Zoho Mail via the `ZohoMail_SearchEmails`
tool that ships with the standard Vodou Zoho MCP server registration.
**Verified live 2026-05-09: this works out of the box.**

**`ZOHO_MODE=crm`** — polls Zoho CRM modules (Notes/Deals/Contacts/Activities).
**Requires installing a Zoho CRM MCP server separately** — the default Vodou
Zoho integration only exposes Mail tools. If you have a CRM MCP server
installed, set `ZOHO_SERVER` and `ZOHO_CRM_TOOL` to point at it.

## Prerequisites

- Vodou daemon running
- Zoho CRM MCP server registered with Vodou (or the v0.5.74 ExecDesk Zoho
  integration)
- Zoho OAuth completed (tokens stored in vodou-core via `oi credentials`)
- Self-principal seeded
- Node.js ≥18

## Install

```bash
# Test poll once
VODOU_PROJECT_PATH=/path/to/vodou \
  ZOHO_MODULES="Notes,Deals,Contacts" \
  node integrations/channel-zoho/poll.mjs

# Schedule via launchd (every 10 min — Zoho rate limits are tighter)
# Use the same plist shape as channel-email/README.md, with:
#   Label: com.vodou.zoho-poll
#   ProgramArguments: ["node", ".../channel-zoho/poll.mjs"]
#   StartInterval: 600
```

## Tuning

| Env var | Default | Meaning |
|---|---|---|
| `ZOHO_MODE` | `mail` | `mail` (Zoho Mail, works out of box) or `crm` (requires CRM MCP server) |
| `ZOHO_SERVER` | `zoho` | MCP server name registered in Vodou |
| `ZOHO_MAIL_TOOL` | `ZohoMail_SearchEmails` | Tool name for mail mode |
| `ZOHO_CRM_TOOL` | `list_records` | Tool name for crm mode (only used if ZOHO_MODE=crm) |
| `ZOHO_MODULES` | `Notes,Deals,Contacts,Activities` | Modules to poll in crm mode |
| `ZOHO_POLL_LIMIT` | `50` | Max records per poll |
| `VODOU_HOST` | `http://127.0.0.1:8766` | |

## How it works

For each configured Zoho module, the poller:
1. Lists records modified since the last watermark
2. Formats each as a readable turn body (Name, Owner, Stage, Value, Note)
3. POSTs as a turn with `surface: "zoho"`, `role: "system"`,
   `conversation_id: "workbench:surface:zoho:<module>:<id>"`
4. Persists the highest `Modified_Time` as new watermark

## Verify

```bash
sqlite3 MCP-servers/Vodou-Console/gateway.db \
  "SELECT id, conversation_id, substr(content,1,80) FROM gateway_messages \
   WHERE conversation_id LIKE 'workbench:surface:zoho%' \
   ORDER BY id DESC LIMIT 10;"

# Cross-surface CRM recall
TOKEN=$(cat .vodou/console.token)
curl -s -X POST http://127.0.0.1:8766/api/v2/memory/recall \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"<customer name>","k":5,"provenance":true}' | jq

./vodou-core hosts --host=zoho
```

## Adapt for non-default Zoho tools

If your Zoho integration uses different tool names than `zoho_crm__list_records`,
edit the `tool` field in `listZohoRecords()` accordingly. The HTTP boundary
to Vodou doesn't change.
