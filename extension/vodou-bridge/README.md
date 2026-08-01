# Vodou Bridge — Chrome extension (full / sideload)

The local bridge that lets Vodou's gateway chat use your real Chrome session
to render cards and act in your tabs — and capture your ChatGPT/Claude
conversations into your Vodou memory (PLAN-UNIVERSAL-MEMORY Phase 4).

**Chrome Web Store edition (memory-only, CWS-safe):** `extension/Store-vodou-bridge/`  
Do **not** upload this full folder to CWS — it includes `act_in_tab`, which the store build deliberately omits.

## Install (developer mode, MVP)

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. Click **Load unpacked**
4. Select this folder: `extension/vodou-bridge/`
5. The bridge icon (🩸) appears in your Chrome toolbar.

Once loaded, the bridge auto-connects to `ws://127.0.0.1:8765/api/vbb` (the
default Vodou gateway). Click the icon to see status + change the URL.

## Wire protocol (v1)

WebSocket. JSON messages. Gateway initiates connection via the extension.

**Gateway → Extension (request):**

```json
{ "id": 42, "cmd": "fetch", "url": "...", "opts": {...} }
{ "id": 42, "cmd": "extract", "url": "...", "selector": "h1", "opts": { "timeout_ms": 15000 } }
{ "id": 42, "cmd": "act_in_tab", "urlPattern": "github.com/*/pull/*", "script": "(()=>{...})()", "args": [] }
{ "id": 42, "cmd": "list_tabs", "urlPattern": "github.com/*" }
```

**Extension → Gateway (reply):**

```json
{ "id": 42, "body": "...", "status": 200, "headers": {...} }     // fetch
{ "id": 42, "matches": [{ "outerHTML": "...", "text": "...", "attrs": {...} }] }  // extract
{ "id": 42, "result": ... }                                       // act_in_tab
{ "id": 42, "tabs": [{ "id": 7, "url": "...", "title": "...", "active": true }] }  // list_tabs
{ "id": 42, "error": { "code": "FETCH_FAILED", "message": "..." } }  // any failure
```

**Extension → Gateway (unsolicited):**

```json
{ "cmd": "bridge_ready", "version": "0.5.88", "protocol": { "min": 1, "max": 1 }, "browser_info": {...} }
{ "cmd": "bridge_health", "uptime_ms": 12345 }
```

## Permissions explained

- `scripting` — needed to run content scripts (for `extract` + `act_in_tab`)
- `tabs` — needed to open/close hidden tabs and query existing ones
- `storage` — saves your gateway URL preference
- `alarms` — keeps the service worker awake so the WebSocket stays connected (MV3 limitation workaround)
- `<all_urls>` — needed for `fetch` to send your real cookies for arbitrary domains. Same permission Pocket, uBlock Origin, and password managers use.

The bridge is local-only — it talks to `localhost` and nothing else. There is
no remote control surface. If Vodou isn't running, the bridge is dormant.

## Building icons

Icons are missing from this repo for size reasons. Drop PNGs at:
- `icons/icon16.png`
- `icons/icon48.png`
- `icons/icon128.png`

Without them, Chrome shows a default puzzle-piece icon — still works.

## Production install (TODO)

Web Store submission is on the post-MVP roadmap (1-7 day review). For now,
developer-mode sideload is the install path.
