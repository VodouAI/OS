# MS 365 — Per-User Setup

The bundled MS 365 MCP server (built on `@softeria/ms-365-mcp-server`) gives
Vodou access to Outlook mail, Calendar, OneDrive, Teams, Excel, To Do, and
Contacts via Microsoft Graph — all in one server, ~50 tools.

## What's NOT in the repo (and never should be)

| File | What it is |
|---|---|
| `.token-cache.json` | MSAL access + refresh tokens for the signed-in account |
| `.selected-account.json` | Which account is currently selected (multi-account) |

Both are listed in `.gitignore`.

## Setup (per-user, runs once)

### 1. Run the device-code login flow

From your Vodou install root:

```bash
node MCP-servers/ms365/auth.js
```

A URL and 8-character code will print in the terminal. Open the URL in any
browser, paste the code, sign in with the Microsoft 365 account you want
Vodou to use. Tokens cache to `MCP-servers/ms365/.token-cache.json`.

No Azure app registration is required — the package ships with a default
multi-tenant client. (If your tenant requires a custom app, set
`MS365_MCP_CLIENT_ID` / `MS365_MCP_TENANT_ID` in `.env` before running auth.)

### 2. Connect via the Apps page

Open <http://localhost:8765/#/apps>, find the **MS 365** card, click
**Add server**. The launcher reads your cached tokens and spawns the MCP
server over stdio.

### 3. Enable in Tools

Open **Capabilities → MCP Servers**, toggle `ms365` on. You'll get tools
across Outlook, Calendar, OneDrive, Teams, Excel, To Do, and Contacts.

## Switching accounts

On the MS 365 card, click **Switch account**. That clears the token cache —
re-run `node MCP-servers/ms365/auth.js` and sign in as a different user.

## Multiple accounts

The underlying package supports multi-account natively (see its README), but
the Vodou UI currently exposes a single active account. Multi-account UI is
covered in `PLANS/0.5.46/PLAN-MULTI-ACCOUNT-INTEGRATIONS.md`.
