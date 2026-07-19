# Vodou-Gmail — Per-User Setup

The bundled Vodou-Gmail MCP server gives Vodou 36 Gmail tools (read, send, search,
label, draft, archive, threads). Each end-user runs their own OAuth flow once
to authorize access to their own inbox; no credentials ship with Vodou.

## What's NOT in the repo (and never should be)

These files are listed in `.gitignore` (both this directory's `.gitignore`
and the top-level project gitignore — defense-in-depth) and must be created
locally by each user:

| File | What it is | Created by |
|---|---|---|
| `credentials.json` | OAuth client ID + secret from Google Cloud Console | User downloads from console |
| `tokens.json` | Cached access + refresh tokens for the user's Google account | `auth.js` writes after consent |

If you ever see `git status` mention either of these as new/modified, **stop
and check the gitignore** — they should always be ignored.

## Setup (per-user, runs once)

### 1. Create a Google Cloud OAuth client

1. Open <https://console.cloud.google.com/apis/credentials>
2. **Create credentials → OAuth client ID**
3. Application type: **Desktop app**
4. Name: anything (`Vodou Gmail` is fine)
5. Click **Create**, then **Download JSON**
6. Make sure the **Gmail API** is enabled at
   <https://console.cloud.google.com/apis/library/gmail.googleapis.com>

### 2. Save the credentials file

Move the downloaded JSON into this directory and rename it:

```bash
mv ~/Downloads/client_secret_*.json MCP-servers/gmail/credentials.json
```

The launcher reads `credentials.json` from `__dirname` — the file must live
exactly here, with that exact filename.

### 3. Run the one-time auth flow

From your Vodou install root:

```bash
node MCP-servers/gmail/auth.js
```

What happens:
- Opens your default browser to a Google consent screen
- You click **Allow** for these scopes: `gmail.readonly`, `gmail.send`,
  `gmail.modify`, `gmail.labels`
- The local OAuth listener captures the callback
- Tokens get written to `MCP-servers/gmail/tokens.json`
- Tokens auto-refresh from there on; you only do this once

If the browser doesn't open automatically, copy the URL printed in the
terminal and paste it manually.

### 4. Connect via the Apps page

Open <http://localhost:8765/#/apps>, find the **Gmail** card, click **Add
server**. Vodou runs `vodou-core connect gmail node MCP-servers/gmail/launcher.js`,
which:
1. Reads your cached `tokens.json`
2. Refreshes the access token if needed (calls Google's OAuth refresh endpoint)
3. Spawns `gmail-mcp` over stdio with the fresh token
4. Vodou registers the 36 Gmail tools

After that: open **Capabilities → MCP Servers**, toggle `gmail` on, and
chat with phrases like "check my inbox" or "send an email to ...".

## Operational notes

- **Token refresh:** the launcher refreshes the access token on every spawn
  if the cached one is expired. The daemon's proactive OAuth sweep
  (`oauth_refresh_task`, every 5 min) refreshes any token expiring within
  10 min so that long-idle sessions stay live without an extra round-trip.
- **Reauth:** if you change scopes, revoke from
  <https://myaccount.google.com/permissions>, delete `tokens.json`, and
  re-run `node auth.js`.
- **Multiple Google accounts:** the launcher only knows about one set of
  tokens. To use a different account, sign out of the current one
  (`tokens.json` deletion + re-auth).

## Future: Vodou-hosted OAuth (one-click, no console clicks)

The current flow requires each user to create their own Google Cloud
project. The roadmap item "Vodou Google OAuth verification" registers a
single Vodou-owned OAuth client at Google, gets it verified, and lets users
skip steps 1–2 entirely — they just click **Connect with Google**, consent,
done. That unlocks Calendar, Gmail, Drive, Docs, Sheets, Tasks, and Meet
as a single batch. Until then, the per-user setup above is required.
