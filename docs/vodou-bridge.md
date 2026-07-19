# Vodou Browser Bridge

The **Vodou Browser Bridge** is a Chrome extension that connects your real, logged-in browser session to your local Vodou gateway. It does two things:

1. **Import your ChatGPT & Claude conversations into your Vodou memory** — one click, straight from the chat you're viewing. *(This is the main reason to install it.)*
2. **Powers lenses that read authenticated pages** — e.g. a Gmail-thread or Linear-issue lens that needs your session to read what you're looking at.

Everything runs locally: the extension talks **only** to the gateway on `127.0.0.1:8765` over a WebSocket. Your conversations and cookies never leave your machine.

---

## Import your ChatGPT / Claude memories

Once the bridge is installed and connected (green dot in the popup), you have three ways to import a chat:

### 1. The in-page button (easiest)
Open any conversation on **chatgpt.com** or **claude.ai**. A floating **🧠 Save to Vodou** button appears in the bottom-right corner. Click it — the conversation is imported and the memory is distilled in the background. You'll see `✓ Saved`.

### 2. The popup button
Click the **Vodou Bridge** toolbar icon → **🧠 Import this chat**. Same result, for whatever chat tab you have open.

### 3. The Memory → Imports tab
In Vodou, go to **Memory → Imports**. There you can:
- **Capture the open chat** or **Backfill all ChatGPT** (import your entire ChatGPT history — the only export path for ChatGPT Team accounts, which have no export button).
- See every import **job** with status and message counts, and **Extract** / **Undo** each.
- **Scan for contradictions** — places where your imported history disagrees with current memory (same fact, different value, e.g. an old company name). Each conflict shows both sides; whichever you keep, the losing line is **superseded** — demoted in search, never deleted, reversible with `mem dedup clear`.
- Review any lines the sanitizer flagged.

### 4. Auto-capture (passive, opt-in)
The popup has an **Auto-capture AI chats** checkbox (off by default). Turn it on and the bridge saves each chat to your Vodou memory *as you go* — no clicking. It works by hooking the **network layer** (the JSON/SSE/WebSocket streams the web app exchanges with its own backend), not by scraping the page, so it's far more robust to UI changes than DOM extraction. Both sides of the exchange are captured — the assistant's reply from the response stream and **your prompt from the request body** (that's where most providers carry it). Captured chats land at the `capture:web:<provider>` trust tier (between your own memory and one-shot imports — provenance-ranked, deduped, never auto-promoted).

**Supported providers (22):** ChatGPT, Claude, **Gemini**, **Perplexity**, **Grok** (grok.com *and* x.com/i/grok), **DeepSeek**, **Le Chat** (Mistral), **Qwen**, **Kimi**, **Duck.ai**, **HuggingChat**, **You.com**, **T3 Chat**, **OpenRouter**, **Poe** — plus *experimental* adapters (written from known wire formats, not yet verified against live traffic): **Copilot**, **Meta AI**, **Google AI Studio**, **NotebookLM**, **Z.ai**, **Character.AI**, and **Manus**. If a provider stops capturing, its endpoint changed — the page console logs a `[vodou-netcap] … parsed 0 turns` breadcrumb; report it and it's a one-adapter fix (`extension/vodou-bridge/inject.js` `ADAPTERS`, with unit tests in `extension/vodou-bridge/test/parsers.test.mjs`). Anything without an adapter still has the right-click **Send selection** floor below.

### 4½. Memory follows you (🧠 My context button)

Every supported AI chat page also gets a purple **🧠 My context** button (Alt+V): it inserts a block of relevant memories from your **portable vault** into the site's composer, so ChatGPT/Claude/Gemini answer with your context without you re-explaining. Only the portable vault is ever disclosed; injected blocks are marker-fenced and stripped by every capture lane so memory never re-learns its own output. Full guide (including IDE/MCP setup for Cursor, VS Code, Visual Studio, Claude Desktop): `docs/memory-follows-you.md`.

### 5. Send any selection (right-click)
Select text on **any** page → right-click → **Send selection to Vodou memory**. The universal catch-all for surfaces with no adapter (a Gemini answer, an article, a random page). Lands at `capture:manual:<host>`. Always available — it's an explicit per-selection action, no toggle.

### What actually gets imported
- **The full conversation transcript** → lands in the gateway as a searchable archive (`source: import:chatgpt` / `import:claude`), hidden from your normal chat sidebar so it doesn't clutter your tabs.
- **Distilled memory** → durable facts/decisions/preferences are written to a markdown file under `.vodou/workspace/memory/imports/<source>/…` **and** indexed into your memory brain, so they surface in search and per-turn context. The markdown file is the source of truth; the database is a rebuildable index over it.

### How it reads the chat (no scraping surprises)
- **ChatGPT**: replays ChatGPT's own internal API using your logged-in session cookies (content-shaped, robust).
- **Claude**: reads the rendered conversation from the page (DOM). If a Claude capture ever comes back with 0 messages, that's the page layout changing — report it and the extractor gets updated.

Browser capture is **user-initiated, local-only, and uses your own account** — but note it relies on undocumented endpoints/DOM that can change, and operating it carries the usual terms-of-service considerations for automating your own logged-in session.

---

## Install (sideload from your Vodou install dir)

The extension ships inside every Vodou install:

1. Open `chrome://extensions` in a new Chrome tab.
2. Toggle **Developer mode** ON (top-right).
3. Click **Load unpacked**.
4. Select the folder `extension/vodou-bridge` inside your Vodou install directory.
5. Click the puzzle-piece icon in your Chrome toolbar and **pin** the Vodou Bridge icon.
6. Click the icon → **Connect** (the dot goes green).

The extension auto-discovers a running gateway on `127.0.0.1:8765` and connects in ~1 second.

### Verify it's working
Open the popup — a green **Connected to Vodou** status means you're ready. (Programmatically: `http://localhost:8765/api/vbb/state` returns `"connected": true`.)

---

## Reliability & the MV3 service worker

Chrome MV3 extensions run on a **service worker** that Chrome suspends when idle and restarts on activity. The bridge is built to ride this out:

- The gateway pushes a **`server_heartbeat` every 20 seconds** while a bridge is connected. Inbound WebSocket traffic resets Chrome's ~30s service-worker idle timer (Chrome ≥116), so the worker — and the socket — stay alive indefinitely instead of dying and reconnecting every half-minute. The extension replies with `bridge_health`, keeping liveness fresh in both directions.
- **Stale sockets are reaped, not trusted**: if either side hears nothing for 75s it treats the socket as dead — the gateway reports `connected: false` honestly (instead of letting lens calls burn 30s timeouts against a zombie) and the extension force-reconnects on its next alarm.
- The gateway uses an **active liveness check** on new connections — it pings the existing one; a genuinely-live connection is kept and the redundant one is dropped, while a dead/orphaned socket is replaced.
- **One bridge slot**: if the extension is loaded in a second browser/profile, the loser gets rejected (`1013`) and after 3 straight rejects stands by for 5 minutes instead of hammering reconnects (the popup shows `slot_standby`; clicking the icon or saving settings retries immediately). If you see the gateway log warn about rejected newcomers, remove the extension from the extra profile.
- If the popup ever shows disconnected, **click the Vodou icon** (or close/reopen the popup) — the service worker wakes and reconnects within a couple of seconds.

If you ever see a stuck state after upgrading the extension: `chrome://extensions` → **Remove** Vodou Bridge → quit Chrome fully → reopen → **Load unpacked** again. A full quit clears any lingering service worker.

---

## Troubleshooting

**"Vodou Bridge not connected" when I click Capture/Import**
- Confirm the popup shows a green dot. If not, click the icon to wake it, then retry.
- Make sure Vodou is running (`http://localhost:8765` loads).

**Capture says "no ChatGPT/Claude chat tab found"**
- Open an actual conversation tab (for ChatGPT, be inside a specific chat so the URL looks like `chatgpt.com/c/<id>`), then capture.

**Claude capture returns 0 messages**
- The DOM extractor's selectors need updating for the current claude.ai layout — report it. (ChatGPT uses the API path and isn't affected.)

**Firewall / corporate network**
- The bridge talks to `localhost` only — no outbound traffic, no firewall config needed.

**Uninstall**
- `chrome://extensions` → **Vodou Bridge** → **Remove**. Nothing to clean up on the Vodou side.

---

## Security model

- Runs in Chrome's normal extension sandbox; talks **only** to the local gateway over `127.0.0.1:8765`.
- Uses **your own** logged-in session — you initiate every capture; nothing is automated behind your back.
- Imported memory is treated as **untrusted input**: it's provenance-tagged (`import:*`), run through a sanitizer (strips hidden-instruction text, flags suspicious lines for review), and is **never** auto-promoted into your curated `MEMORY.md`.
- Session cookies stay in Chrome; the gateway requests page content via the extension and never stores raw cookies itself.

---

## Also: lenses that read authenticated pages

The same bridge powers **lenses** that need your session to read a logged-in page (e.g. a Gmail-thread or Linear-issue lens). Most built-in lenses (npm.package, wikipedia.article, arxiv.paper, hackernews.item, youtube.video, image.preview, map.directions, snippet.url, …) use server-side HTTP fetch and work **without** the bridge — you only need it for lenses whose manifest declares `requires.needs_session: true`, which surface a "Vodou Bridge required" banner when relevant.

### For lens authors
If your lens needs the user's active tab, declare `requires: { needs_session: true }` in its manifest — the gateway preflights the bridge and shows a structured install card instead of a confusing "fetch failed". Lenses that only use `ctx.fetchStatic` should leave `needs_session` off so they work for everyone.
