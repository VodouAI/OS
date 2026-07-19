# Vodou App Presets

Each `*.json` file in this directory describes a remote MCP server the Vodou gateway can connect to. Contributors can add a new app by submitting a pull request that adds a single JSON file — **no TypeScript edits, no rebuild**.

## Quick start — contributing a preset

1. Copy `_template.json` to `<your-provider>.json`. The filename must match the `id` field.
2. Fill in the fields (see `_schema.json` for every option).
3. Validate locally: `npm run validate-presets`
4. Restart the gateway and verify your preset shows up under `#/apps` with the right card, logo, and auth flow.
5. Open a PR with a one-sentence description.

## Three auth paths

Every preset uses exactly one of these four paths:

| Path | Flag to set | When to use |
|---|---|---|
| **0. Local stdio** | `localStdio: true` + `stdioCommand` + `stdioArgs` | MCP server runs as a local subprocess (e.g. `npx chrome-devtools-mcp@latest`). |
| **1. DCR (preferred)** | `dcrSupported: true` | Provider advertises `/.well-known/oauth-protected-resource` with a `registration_endpoint`. Zero user setup. |
| **1b. DCR + optional key** | `dcrSupported: true` + `dcrOptionalApiKey: true` + `apiKeyEnv` (+ optional header/format) | Same as DCR, but the Apps UI also offers pasting a token (e.g. Tavily). |
| **2. API key / PAT** | `apiKeyOnly: true` + `apiKeyEnv` + optional `apiKeyHeader` / `apiKeyFormat` | Provider uses personal access tokens instead of OAuth. User pastes a key. |
| **3. Manual OAuth** | `authUrl` + `tokenUrl` + `clientIdEnv` + `clientSecretEnv` + `setupDocsUrl` | No DCR; user creates their own OAuth app in the provider console. Legacy fallback. |

If you're not sure which path, look at the provider's MCP docs or try Path 1 first (`dcrSupported: true`) and see if the gateway's Connect button succeeds.

## Rules

- `id` must be lowercase, hyphenated, unique across all presets. **Matches filename.**
- `dcrSupported`, `apiKeyOnly`, and `localStdio` are **mutually exclusive** — pick one.
- Every preset you submit must work end-to-end: click Connect in the UI, complete the flow, see tools show up under Capabilities → MCP Servers.
- Icon field is **emoji only** (one character). For the rich brand logo, set `logo` to a path under `/icons/brands/`.
- **No secrets in JSON.** `apiKeyEnv`, `clientIdEnv`, `clientSecretEnv` are environment-variable names — never the actual key/secret.
- Prefer `.svg` logos when possible; `.png` is acceptable for color-brand logos (set `logoColor: true`).

## Rich setup steps (optional)

For providers with multi-step manual setup (e.g. Asana's OAuth app + workspace distribution), add a `setupSteps` array. Each step has:

- `title` — short heading
- `instructions` — HTML snippet; `<strong>`, `<code>`, `<a>`, `<br>` are allowed
- `link` — `{ url, label }` rendered as a button below the step (optional)
- `gotcha` — warning shown in a yellow callout (optional)

Steps render as a numbered list directly on the card before the credential form.

## Categories

One of:

- **Design & Dev** — dev tools, design tools, infra-adjacent (Cloudflare, Buildkite, Cloudinary, Canva, Chrome DevTools)
- **Productivity** — CRM, task management, docs, search (Linear, Notion, Asana, Attio, monday.com, Airtable, Zapier, Dappier, Exa, Tavily, Audioscrape, Carbon Voice)
- **Finance & Infra** — billing, analytics, infrastructure (Stripe, Cloudflare)
- **Custom** — the "bring your own remote MCP" fallback; rarely set by presets

## CI

Every PR opened against this repo runs `.github/workflows/validate.yml`:

1. JSON schema validation against `_schema.json`.
2. `id` ↔ filename match check.
3. Unique-id check across all files.

A PR that fails CI can't be merged. Fix the errors (the CI log tells you what's wrong) and push again.

## Reference presets

- **HTTP + OAuth (DCR):** `canva.json`, `linear.json` — `dcrSupported: true`, `mcpTransport: "http"` or `"sse"`, official `mcpUrl` from the vendor.
- **Local stdio + bundled Node:** `figma.json` — `node MCP-servers/figma-developer-mcp/node_modules/figma-developer-mcp/dist/bin.js` (shipped in prebuilt releases; see `MCP-servers/figma-developer-mcp`). `chrome-devtools.json` — `npx chrome-devtools-mcp@latest`.

## License

MIT — same as the Vodou gateway. By contributing a preset you agree it can be bundled and redistributed with Vodou.
