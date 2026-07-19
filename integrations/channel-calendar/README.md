# Calendar channel adapter

Polls Google Calendar for new/updated events and records each as a Vodou turn
with `Surface::Calendar`. Pairs with the email channel adapter — meeting
follow-up emails recall their parent calendar event.

## Prerequisites

- Vodou daemon + Google Calendar MCP server registered
- Self-principal seeded
- Node.js ≥18

## Install

Same shape as `integrations/channel-email/README.md` — copy the launchd plist,
adjust the `ProgramArguments` path to `channel-calendar/poll.mjs`, label
`com.vodou.calendar-poll`.

## How it works

1. Loads `.watermark.json` (last `updated` timestamp)
2. Calls `google_calendar__list_events` via Vodou's tool routing
3. POSTs each new/updated event as a turn with `surface: "calendar"`,
   `role: "system"` (events aren't user-authored), `conversation_id` per event
4. Persists watermark
5. Memory extractor + recall surface the event content cross-surface

## Tuning

| Env var | Default | Meaning |
|---|---|---|
| `CALENDAR_POLL_LIMIT` | `50` | Max events per poll |
| `CALENDAR_ID` | `primary` | Which Google Calendar to poll |
| `VODOU_HOST` | `http://127.0.0.1:8766` | Vodou core API |

## Verify

```bash
sqlite3 MCP-servers/Vodou-Console/gateway.db \
  "SELECT id, conversation_id, substr(content,1,80) FROM gateway_messages \
   WHERE conversation_id LIKE 'workbench:surface:calendar%' \
   ORDER BY id DESC LIMIT 5;"

./vodou-core hosts --host=calendar
```
