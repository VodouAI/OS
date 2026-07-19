# @vodou/channel-template

Starter template for a Vodou channel package. Copy → rename → fill in.

## Quick start

```bash
cp -R packages/template packages/<your-channel>
cd packages/<your-channel>
# 1. Edit package.json: set "name" to "@yourscope/channel-<name>", flip "private" to false
# 2. Edit src/channel.ts: replace MY_CHANNEL_TYPE, MY_CHANNEL_NAME, fill in connect()/send()
# 3. Edit manifest() with your displayName, requiredEnv, etc.
npm install
npm run build
```

## Naming rules

The gateway's install endpoint enforces `^@[^/]+\/channel-`. Your package must:

- Be scoped: `@scope/...`
- Start with `channel-` after the slash

Examples: `@vodou/channel-matrix`, `@acme/channel-zendesk`.

## Local install (no publish)

```bash
cd ~/.vodou/channels
npm install /absolute/path/to/packages/<your-channel>
# Restart the gateway — it scans node_modules at startup
```

## Publishing

```bash
npm publish --access public
```

Users install via the gateway:

```bash
curl -X POST http://127.0.0.1:8765/api/channels/install \
  -H 'Content-Type: application/json' \
  -d '{"package":"@yourscope/channel-<name>"}'
```

…or click **Install** on the channel card in Settings → Channels.

## Contract

Default export must be a class implementing `VodouChannel`:

- `connect()` — open upstream connection; on each message build an `IncomingMessage` and call `this.deliver(...)` (helper provided)
- `disconnect()` — tear down
- `send(OutgoingMessage)` — push a reply upstream
- `getStatus()` — return connection state + metadata
- `onMessage(handler)` — store handler; gateway sets it once at startup
- `manifest()` — `{ name, displayName, version, description, author, signed, requiredEnv, optionalEnv }`

The SDK gives you `AllowlistWatcher` (per-channel allowlist file with hot reload) and `saveBufferAsAttachment` (drop binary payloads into the workspace attachment dir).

## Channel type union

`ChannelType` in the SDK is currently a closed union of the 10 first-party channels. If your channel id isn't in that list, either:

- (recommended) submit a PR to `@vodou/channel-sdk` widening the union, or
- cast at the boundary as the template does: `'mychan' as ChannelType`

A future SDK release will replace the union with `string` to remove this friction.

## Sandboxing note

Channels currently run in the gateway process. Until per-channel sandboxing ships (v0.7.1), only install community packages you trust.
