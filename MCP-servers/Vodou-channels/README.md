# Vodou-Channels MCP Server

Frontend surface area for Vodou: Telegram, Slack, Discord, Voice, Web.

## Overview

Vodou-Channels provides the "body" for Vodou - the input/output interfaces that connect Vodou to the world:

```
┌─────────────────────────────────────────────────────┐
│                  Vodou-Channels                         │
│                                                      │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐   │
│  │Telegram │ │ Slack   │ │ Discord │ │  Voice  │   │
│  └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘   │
│       │          │          │          │          │
│  ┌────┴──────────┴──────────┴──────────┴────┐     │
│  │              Channel Manager              │     │
│  └────────────────────┬─────────────────────┘     │
│                       │                            │
│              ┌────────┴────────┐                  │
│              │   Vodou Binary     │                  │
│              │   ./do "query"  │                  │
│              └─────────────────┘                  │
│                       │                            │
│  ┌────────────────────┴────────────────────────┐  │
│  │              Web Interface                    │  │
│  │         http://localhost:8766                 │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

## Dependencies — read before running npm here

All runtime deps ship prebuilt in `node_modules/`. `@vodou/channel-sdk` is **vendored** — it lives at `packages/sdk` inside this server and is wired as a `file:` link (`node_modules/@vodou/channel-sdk → ../../packages/sdk`). It was never published to npm, so:

- ❌ Never run `npm install @vodou/channel-sdk` (or any `@vodou/*` name) — the registry 404s, and npm can prune the existing link while failing.
- ✅ To repair broken/missing deps: a **plain** `npm install` in this directory. The lockfile relinks `packages/sdk` locally and fetches public deps from npm.
- The server also self-heals at startup: if the `@vodou/channel-sdk` link is missing but `packages/sdk` exists, it recreates the link automatically (see `src/index.ts` preflight).

## Channels

| Channel | Status | Description |
|---------|--------|-------------|
| **Telegram** | ✅ | Bot receives messages, processes through Vodou, responds |
| **Slack** | ✅ | Bot responds to messages and @mentions |
| **Discord** | ✅ | Bot responds to messages in channels and DMs |
| **Voice** | ✅ | Text-to-speech output using system TTS |
| **Web** | ✅ | WebSocket-based web interface (default localhost:8766) |

## Tools

### `channel_connect`

Connect to messaging channels to start receiving messages.

```json
{
  "channels": ["telegram", "web"]
}
```

### `channel_disconnect`

Disconnect from channels.

```json
{
  "channels": ["telegram"]
}
```

### `channel_send`

Send a message to a specific channel.

```json
{
  "channel": "telegram",
  "recipient": "123456789",
  "message": "Hello from Vodou!"
}
```

### `channel_broadcast`

Broadcast a message to all connected channels.

```json
{
  "message": "Important announcement!"
}
```

### `channel_status`

Get status of channels.

```json
{
  "channel": "telegram"
}
```

### `voice_speak`

Speak text through system speakers.

```json
{
  "text": "Hello, I am Vodou"
}
```

### `voice_stop`

Stop current speech.

### `voice_list_voices`

List available system voices.

## Configuration

### Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_ADMIN_ID=your_user_id

# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...

# Discord
DISCORD_BOT_TOKEN=your_bot_token
DISCORD_GUILD_ID=your_server_id

# Voice
VOICE_ENGINE=say
VOICE_NAME=

# Web
WEB_PORT=8766
```

### Getting Channel Tokens

#### Telegram
1. Talk to @BotFather on Telegram
2. Create a new bot with `/newbot`
3. Copy the token

#### Slack
1. Go to https://api.slack.com/apps
2. Create new app
3. Enable Socket Mode
4. Add Bot Token Scopes: `chat:write`, `app_mentions:read`, `channels:history`, `im:history`, `im:write`, and `users:read` (required for `users.info` / `users.list` — without it the gateway UI shows raw `U…` ids). **Reinstall** after adding scopes.
5. Install (or **Reinstall**) to workspace whenever you add scopes
6. Copy Bot Token and App Token
7. Optional: set `SLACK_PREFETCH_USERS=1` in `MCP-servers/Vodou-channels/.env` to bulk-load member names once at startup (same scope). If names are still ids, check `channels-slack.log` for `users.info failed (missing_scope)`.

#### Discord
1. Go to https://discord.com/developers/applications
2. Create new application
3. Go to Bot section
4. Enable Message Content Intent
5. Copy token

## Installation

```bash
cd MCP-servers/Vodou-channels
npm install
npm run build
```

## Usage

### Standalone mode (Telegram keeps running)

When you run `./do "channel_connect telegram"`, the Vodou process exits when the command finishes, so the Telegram polling process is stopped and the bot stops receiving messages. To keep Telegram (or other channels) running, start Vodou-channels in **standalone** mode in a separate terminal or as a background service. Put `TELEGRAM_BOT_TOKEN` in `MCP-servers/Vodou-channels/.env` (see `.env.example`), then:

```bash
cd MCP-servers/Vodou-channels
VODOU_CHANNELS_STANDALONE=telegram node --env-file=.env dist/index.js
```

Leave that process running. Incoming Telegram messages will be processed through Vodou (it spawns `./do "message"` from the project root). Use Ctrl+C to stop.

You can list multiple channels: `VODOU_CHANNELS_STANDALONE=telegram,web`

### Quick Start - Web Interface Only

```bash
# Connect just the web interface
./do "channel connect web"

# Open http://localhost:8766 in browser
```

### Full Setup - All Channels

```bash
# Set environment variables first
export TELEGRAM_BOT_TOKEN=your_token
export SLACK_BOT_TOKEN=xoxb-...
# etc.

# Connect all channels
./do "channel connect telegram slack discord voice web"

# Check status
./do "channel status"
```

### Sending Messages

```bash
# Send to Telegram user
./do "channel send telegram 123456789 'Hello!'"

# Speak through voice
./do "voice speak 'Hello, I am Vodou'"

# Broadcast to all channels
./do "channel broadcast 'System update complete'"
```

## How It Works

1. **Message arrives** on any connected channel (Telegram, Slack, etc.)
2. **Channel Manager** receives the message
3. **Vodou binary** is called: `./do "user's message"`
4. **Response** is sent back through the same channel

This creates a bidirectional communication loop where Vodou can be accessed from any messaging platform.

## Architecture

```
User (Telegram/Slack/Discord/Web)
              │
              ▼
┌─────────────────────────────┐
│       Vodou-Channels MCP       │
│                             │
│  channel_connect            │
│  channel_send               │
│  voice_speak                │
└─────────────────────────────┘
              │
              ▼
┌─────────────────────────────┐
│     Channel Manager         │
│                             │
│  Telegram  Slack  Discord   │
│  Voice     Web              │
└─────────────────────────────┘
              │
              ▼
┌─────────────────────────────┐
│         ./do "query"        │
│                             │
│  Vodou-LLM-Router → Skills     │
│                → MCP Tools  │
│                → Scripts    │
└─────────────────────────────┘
              │
              ▼
        Response back
```

## Add to config.json

```json
{
  "Vodou-channels": {
    "command": "node",
    "args": ["./MCP-servers/Vodou-channels/dist/index.js"],
    "env": {
      "TELEGRAM_BOT_TOKEN": "${TELEGRAM_BOT_TOKEN}",
      "SLACK_BOT_TOKEN": "${SLACK_BOT_TOKEN}",
      "SLACK_APP_TOKEN": "${SLACK_APP_TOKEN}",
      "DISCORD_BOT_TOKEN": "${DISCORD_BOT_TOKEN}",
      "WEB_PORT": "8766"
    }
  }
}
```

## License

MIT
