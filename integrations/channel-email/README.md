# Email channel adapter

Polls Gmail for new messages and records each as a Vodou turn with
`Surface::Email`. Cross-surface recall pulls email content when discussing the
topic in any other surface.

## Prerequisites

- Vodou daemon running (`./vodou-core daemon ensure`)
- Gmail MCP server registered with Vodou (so `gmail__list_messages` is callable)
- Self-principal seeded (`vodou-core continuity init`)
- Node.js ≥18 (for native `fetch`)

## Install

```bash
# 1. Verify dependencies
which node                                  # >= 18
sqlite3 vodou-core.db "SELECT id FROM principals WHERE is_self=1 LIMIT 1;"  # non-empty
ls .vodou/console.token                     # exists, mode 0600

# 2. Test poll once manually
VODOU_PROJECT_PATH=/path/to/vodou \
  node integrations/channel-email/poll.mjs
# Expected stderr: "[email-poll] starting; last_history_id=none"
#                   "[email-poll] recorded N messages; watermark advanced"

# 3. Schedule via cron (every 5 min) or launchd (preferred on macOS)
crontab -e
# Add:
# */5 * * * * cd /path/to/vodou && /usr/local/bin/node integrations/channel-email/poll.mjs >> /tmp/vodou-email-poll.log 2>&1
```

## launchd plist (macOS, preferred)

`~/Library/LaunchAgents/com.vodou.email-poll.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>          <string>com.vodou.email-poll</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/vodou/integrations/channel-email/poll.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>VODOU_PROJECT_PATH</key><string>/path/to/vodou</string></dict>
  <key>StartInterval</key>  <integer>300</integer>  <!-- 5 min -->
  <key>StandardErrorPath</key><string>/tmp/vodou-email-poll.err</string>
  <key>StandardOutPath</key>  <string>/tmp/vodou-email-poll.log</string>
</dict>
</plist>
```

Then: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.vodou.email-poll.plist`

## How it works

1. Loads `.watermark.json` (last `historyId` / `messageId` we recorded)
2. Calls `gmail__list_messages` via Vodou's tool routing API (which delegates
   to the Gmail MCP server)
3. For each new message, POSTs to `/api/v2/channels/turns` with:
   - `surface: "email"`
   - `conversation_id: "workbench:surface:email:<threadId>"`
   - `surface_external_id: <message.id>` (for replay/dedup)
4. Persists new watermark
5. Memory extractor's 5-min cycle picks up the new gateway_messages rows and
   chunks them into `memory.db` with `chunk_scope=workbench:surface:email`
6. Cross-surface recall now surfaces those chunks

## Verify

```bash
# After at least one poll cycle:
sqlite3 MCP-servers/Vodou-Console/gateway.db \
  "SELECT id, conversation_id, substr(content,1,60) FROM gateway_messages \
   WHERE conversation_id LIKE 'workbench:surface:email%' \
   ORDER BY id DESC LIMIT 5;"

# After 5 min (next memory extractor cycle):
TOKEN=$(cat .vodou/console.token)
curl -s -X POST http://127.0.0.1:8766/api/v2/memory/recall \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"<keyword from a recent email>","k":5,"provenance":true}' | jq

./vodou-core hosts --host=email
# Expected: status=stable, prompt=pass, record_turn=pass, surface_seen=true
```

## Tuning

| Env var | Default | Meaning |
|---|---|---|
| `EMAIL_POLL_LIMIT` | `20` | Max messages per poll (Gmail API quota friendly) |
| `VODOU_HOST` | `http://127.0.0.1:8766` | Vodou core API |
| `VODOU_PROJECT_PATH` | `cwd` | Where to find `.vodou/console.token` and `vodou-core.db` |

## Adapt for non-Gmail IMAP

Replace the `listGmailMessages` function with any IMAP client (e.g.
`imapflow`); the rest of the poller (record_turn loop, watermark, conv_id
shaping) is generic. The HTTP boundary doesn't care which mail provider you
use as long as you supply `surface: "email"`.
