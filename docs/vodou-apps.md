# Vodou Apps

External services Vodou can read from and write to — Notion, Linear, Stripe, Cloudflare, and so on. Each app surfaces its tools through the MCP protocol; once connected, those tools are callable from the main chat, the scoped workbench, scheduled tasks, and automations.

## How an app connection works

Every connection follows one of four auth paths, in preference order:

| Path | Flag in preset | What happens |
|---|---|---|
| 0 — Local stdio | `localStdio: true` | Vodou spawns a local subprocess (e.g. `npx chrome-devtools-mcp@latest`). No OAuth, no remote URL. |
| 1 — DCR (preferred) | `dcrSupported: true` | Dynamic Client Registration (RFC 7591). You click Connect, Vodou handshakes with the provider, you authorize in a popup, tokens land on your machine. Zero setup. |
| 2 — API key / PAT | `apiKeyOnly: true` | You paste a personal access token. Some providers require this because they don't support DCR. |
| 3 — Manual OAuth | (neither of the above) | You create an OAuth app in the provider's console, copy client_id + client_secret into `.env`, then Connect. Legacy fallback. |

**Most current presets use Path 1 (DCR).** Only a few (Airtable, Zapier, Dappier, Exa) use Path 2, and Asana uses Path 3.

## The preset catalog

The list of apps Vodou knows about is maintained as JSON files in a **public GitHub repo: [`github.com/VodouAI/Apps`](https://github.com/VodouAI/Apps)**. Each JSON file describes one provider.

Why a public repo:
- **Community contributions are just PRs against JSON.** No TypeScript, no gateway rebuild, no Vodou-team bottleneck.
- **Schema-validated** — every PR runs `scripts/validate-presets.mjs` in CI against `presets/_schema.json` before it can merge.
- **Pinned per release** — each Vodou release bundles a snapshot at a specific commit SHA, recorded in `presets/.integrations-sha`. Upgrades pick up the catalog as of that snapshot.

### Current catalog (17 presets)

**Design & Dev:** Buildkite, Canva, Chrome DevTools MCP, Cloudinary
**Productivity:** Airtable, Asana, Attio, Audioscrape, Carbon Voice, Dappier, Exa Search, Linear, monday.com, Notion, Zapier
**Finance & Infra:** Cloudflare, Stripe

See [`presets/README.md` in VodouAI/Apps](https://github.com/VodouAI/Apps/blob/main/presets/README.md) for the full contributor guide.

## Connecting an app (as a user)

1. Open the gateway (`http://localhost:8765`) and navigate to **Apps** in the sidebar.
2. Find the card for the service you want. Click **Connect**.
3. **Path 1 (DCR):** popup opens, authorize, returns — done.
4. **Path 2 (API key):** setup steps appear on the card. Follow them (often includes opening the provider's token page, setting scopes, copying a `pat_...` token back into the card).
5. **Path 3 (manual OAuth):** the card shows numbered setup steps. You'll create an OAuth app in the provider's console, set the redirect URL to `http://localhost:8765/api/oauth/callback`, then paste client_id + client_secret back into the card before clicking Connect.

Once connected, the app's tools are immediately available to Vodou — no restart required. Check **Capabilities → MCP Servers** to confirm the tool count.

## Contributing a new preset (as a developer)

1. Fork [VodouAI/Apps](https://github.com/VodouAI/Apps).
2. Copy `presets/_template.json` to `presets/<your-provider>.json`. **Filename must match the `id` field.**
3. Fill in the fields (see `presets/_schema.json` for every option). Minimum required: `id`, `name`, `icon`, `category`, `description`, `mcpUrl`, `mcpTransport`.
4. Validate locally:
   ```bash
   npm install --save-dev ajv ajv-formats
   node scripts/validate-presets.mjs
   ```
5. Open a PR against `main`. CI runs the validator on every push. Once merged, the new preset ships in the next Vodou release.

**Rules:**
- `dcrSupported`, `apiKeyOnly`, `localStdio` are mutually exclusive — pick exactly one auth path.
- `id` is lowercase-hyphenated, unique across all presets, matches filename.
- `icon` is a single emoji; rich brand logo goes in `logo` as a path under `/icons/brands/`.
- **No secrets in JSON.** Env-var names only: `apiKeyEnv`, `clientIdEnv`, `clientSecretEnv`.

## Using apps

### From main chat

Type naturally — the LLM routes to the right tool. Examples:
- "Search my Notion for 'weekly review'"
- "Close Linear issue LIN-42"
- "List recent Stripe customers"

For explicit routing, use the `/server` slash command: `/server notion notion-search "weekly review"`. This opens an inline parameter form in main chat.

### From the scoped workbench (per-app chat)

Navigate to **Apps → connected card → Open in workbench** (or hit `#/apps?server=notion&mode=chat`). You get a chat view scoped to that one server — the LLM only sees that app's tools, memory is tagged `workbench:integration:<id>`, and the composer auto-prefills `/server <id> ` so you stay in scope.

### From scheduled tasks

Activity → Scheduled → **+ Add Scheduled Task** → payload type `mcp_tool` → pick app/tool/args. See [vodou-scheduler.md](./vodou-scheduler.md).

### From automations

Activity → Automations → **+ New automation**. Event-driven chains across multiple apps. See [vodou-automations.md](./vodou-automations.md).

## Where it lives

| Component | Location |
|---|---|
| Preset catalog (canonical) | [github.com/VodouAI/Apps](https://github.com/VodouAI/Apps) |
| Preset catalog (local snapshot) | `MCP-servers/Vodou-Console/presets/*.json` — populated by release build from the public repo at a pinned SHA |
| Runtime loader | `MCP-servers/Vodou-Console/src/api/oauth-presets.ts` |
| Local validator | `MCP-servers/Vodou-Console/scripts/validate-presets.mjs` — `npm run validate-presets` |
| API endpoints | `GET /api/oauth/presets` (list), `GET /api/oauth/status` (per-provider connection state + tool counts), `POST /api/oauth/start` (begin connect), `POST /api/oauth/test` (re-discover tools), `POST /api/oauth/credentials` (paste API key), `POST /api/oauth/revoke` (disconnect) |
| UI view | `MCP-servers/Vodou-Console/public/js/views/apps.js` |
| Scoped workbench | `MCP-servers/Vodou-Console/public/js/scoped-workbench.js` |

## Related docs

- [mcp-host.md](./mcp-host.md) — how MCP servers connect to Vodou
- [mcp-protocol.md](./mcp-protocol.md) — MCP wire protocol background
- [vodou-scheduler.md](./vodou-scheduler.md) — time-triggered tool calls
- [vodou-automations.md](./vodou-automations.md) — event-driven chains
