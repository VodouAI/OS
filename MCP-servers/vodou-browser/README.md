# vodou-browser — the browser as a tool catalogue (PLAN-MEMORY-ON-EVERY-PAGE P7)

Exposes the Vodou Bridge extension's packaged page tools over MCP (stdio), so the brain,
skills, `AGENT_ACTIONS` and `./vodou-core call vodou-browser <tool> '<json>'` can read and act
on the page the user is looking at.

Path: this server → gateway `POST /api/vbb/tool` → bridge `tool_call` → extension `runBrowserTool`.
The extension enforces per-site page-memory mode (`off` = refused), needs its content script on
the page (declared AI sites, sites the user enabled via "Enable Vodou on this site", or a page the
user right-clicked Vodou on), and writes a receipt to the panel's Activity tab. Nothing submits,
clicks buttons or navigates except `tabs_open` / `tabs_activate`.

Tools: `tabs_list`, `tabs_open {url}`, `tabs_activate {tabId}`, `page_read {tabId?, maxChars?}`,
`page_model {tabId?}`, `page_insert {text}`, `page_fill {items:[{id|sel, value}]}`,
`page_find {text}`, `page_save {tabId?}`. `tools/list` reads the live catalogue from the gateway
(`GET /api/vbb/tools`) and falls back to the static list when the bridge is down.

Register: `./vodou-core connect vodou-browser node MCP-servers/vodou-browser/index.js`
Env: `VODOU_GATEWAY_URL` (default `http://127.0.0.1:8765`).
Dependency-free on purpose (no `npm install` in `MCP-servers/*`, see CLAUDE.md).
