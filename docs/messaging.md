# Messaging (Slack, Telegram, Discord, WhatsApp, iMessage)

Use **Messaging** in the web UI to connect chat apps so you can talk to the same assistant you use in the browser, with shared memory and tools (subject to your LLM and server setup).

## Quick setup

1. Start services (`./start-vodou-services.sh` or your usual flow) so the **gateway** is running (default **http://localhost:8765**).
2. Open the gateway → **Messaging** (sidebar).
3. For each provider, follow the on-screen steps and set the tokens in **`.env`** (see **`.env.example`** for variable names).

## Credentials (summary)

| Channel   | Typical env vars (see `.env.example`)        |
|-----------|-----------------------------------------------|
| Telegram  | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_ID`     |
| Slack     | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET` |
| Discord   | `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`       |
| WhatsApp  | Pairing via QR in the UI; media paths under project `.vodou/` by default |

Slack **Socket Mode** tokens are for **Vodou-channels** (DMs/events to the assistant). A separate `SLACK_TOKEN` may exist for other Slack tooling—keep them straight in `.env`.

## Behavior users should know

- **WhatsApp** is limited to **private 1:1** threads you start from your linked device; group and broadcast traffic is not treated as assistant input. Only **messages you send** in those DMs are forwarded (not other people’s DMs).
- Run **one** standalone messaging process for WhatsApp as documented in the gateway UI—avoid a second listener on the same webhook port.
- **Attachments** (images, documents) may be passed into the model when your provider and configuration support it. For **tightening which directories** the gateway may read, use the optional **`CHANNEL_MEDIA_*`** settings in `.env.example` (`CHANNEL_MEDIA_STRICT`, `CHANNEL_MEDIA_ROOTS`, size limits). Leave unset for local dev; enable strict roots for stricter deployments.

## Pluggable channels (v0.8.0+)

Each channel is its own npm package under `~/.vodou/channels/node_modules/`. The Console scans that directory at startup and loads anything matching `@scope/channel-*`. Adding a channel is a runtime install — no Vodou rebuild required.

### Install

From the Console UI, **Settings → Channels → Install** opens a prompt for the package name. Or hit the API directly:

```bash
curl -X POST http://127.0.0.1:8765/api/channels/install \
  -H 'Content-Type: application/json' \
  -d '{"package":"@vodou/channel-telegram"}'
```

The package name must match `@scope/channel-<name>` — that's the gateway's trust boundary on the install endpoint.

### Built-in channels

The 10 first-party channels ship pre-installed: `telegram`, `slack`, `discord`, `whatsapp`, `signal`, `imessage`, `teams`, `googlechat`, `voice`, `web`. They use the same plugin contract as community packages — no special path.

### Building your own

`MCP-servers/Vodou-channels/packages/template/` is a starter scaffold. Copy the directory, rename the package to `@yourscope/channel-<name>`, fill in `connect()`/`send()`/`manifest()`, `npm run build`, and either install locally (`npm install /absolute/path`) or `npm publish` so others can install it via the API above. See the template's `README.md` for the full flow.

> **Trust note:** until v0.5.38 sandboxing lands, installed channels run inside the Console process with full Node access. Vet third-party channel packages before installing. See `PLANS/0.5.38/PLAN-CHANNEL-SANDBOX.md` for the subprocess-isolation roadmap.

## Related docs

- **[setup.md](setup.md)** — install and services
- **[openai-compatible-api.md](openai-compatible-api.md)** — OpenAI-compatible chat API used by tools and IDEs (port 8765)
- **[core-http-api.md](core-http-api.md)** — Vodou core API on port 8766 + generated TypeScript SDK
- **`.env.example`** — full list of channel and gateway variables

Internal wiring and bridge details are not documented here on purpose.
