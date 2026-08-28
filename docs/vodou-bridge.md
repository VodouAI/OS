# Vodou Bridge — the browser extension

**Vodou Bridge** is a Chrome (Manifest V3) extension that puts your local Vodou next to whatever page you're on. It talks **only** to the Vodou gateway on your own machine (`127.0.0.1:8765`, WebSocket + local HTTP). Nothing you read, type, or save through it goes to Vodou's servers.

What it does today (Store build 0.5.97.75):

| Lane | What | Where it works |
|---|---|---|
| **Save my chats** | Auto-capture your AI conversations as you have them; save a chat with one click; backfill older threads | 35 AI-chat sites (22 adapters, see below) |
| **Save anything** | Right-click → *Send selection to Vodou memory*; *Add this page / linked file to Vodou Library* | **Any** page |
| **Use memory in your chats** | Ctrl+B (agentic) / Ctrl+Shift+B (visible) insert; the panel picker; opt-in auto-attach on send | AI-chat sites — and, since .75, Ctrl+B / Ctrl+Shift+B in **any** text box on **any** page |
| **Memory on the page you're on** *(new in .75, off by default)* | Memories and documents tied to *this* page and *this* site; a note about the page; link a memory to it; suggestions while you type; the icon turns green | **Any** http(s) page |
| **Fill a form from memory** *(new in .75)* | Right-click → review card → only ticked answers written; Ctrl+B fills the empty fields at once; never submits; remembers your answers per page | **Any** page with a form |
| **Tasks** | ⌃⇧Y runs your composer draft as a Vodou task and puts the answer back in your draft; the panel's Ask tab | AI-chat sites (Ask: anywhere) |
| **Library** | "Your documents on this page" — Library documents that match the page; `@doc:` attach tokens | Any page |
| **Enable Vodou on this site** *(new in .75)* | One Chrome prompt per site you choose → Vodou's script runs there automatically (no right-click first); optional "also save what I write here" | Any site you enable |
| **Browser tools for the brain** *(new in .75)* | `vodou-browser` MCP server: read/insert/fill/find on the page you're on, from skills, tasks and the CLI, under the same rules | Where Vodou has access |
| **Lenses** (full/sideload build only) | Lenses that need your logged-in session to read a page | Where a lens asks for it |

Product principle throughout: **nothing is sent on your behalf and nothing is read that you didn't ask for** — every automatic lane is off until you turn it on, and each one tells you what it reads before it runs.

---

## Install

### A. From the Chrome Web Store (recommended)

The Store listing is live: **[Vodou Bridge](https://chromewebstore.google.com/detail/vodou-bridge/ehlanbbiaeelnimkakfffehoahimkjjf)** (item id `ehlanbbiaeelnimkakfffehoahimkjjf`). Install, pin the icon, then:

1. Have Vodou running (`./start-vodou-services.sh`; `http://localhost:8765` loads).
2. Click the Vodou icon → the side panel opens. If the gateway requires pairing (default), the panel shows **Pairing required** — enter the 6-digit code from **Vodou → Settings → Memory → Browser bridge** once. The panel's Connection section reads **Connected**.

The Store build declares host permissions for `localhost`/`127.0.0.1`, `policy.vodou.ai` and the 35 AI-chat hosts — no wildcard site access. Everything else it does on other pages happens **on your gesture** (`activeTab`): a right-click, a shortcut, a click on its icon.

### B. Sideload (development / the full build)

Every install ships three builds under `extension/`:

| Folder | What it is | Use it when |
|---|---|---|
| `Store-vodou-bridge/` | Byte-identical to what's on the Chrome Web Store | You want exactly the shipped behaviour, or you're testing a Store release before upload |
| `vodou-bridge/` | The full build: `<all_urls>` host access, plus `act_in_tab` for lenses that need your session | You use session-reading lenses (Gmail thread, Linear issue…) |
| `sideload-only-vodou-bridge/` | Full build without the Store-only trims | Rarely; kept in sync for the parity test |

`chrome://extensions` → **Developer mode** on → **Load unpacked** → pick one folder → pin the icon → click it → pair. **Load only one of them** — see *One bridge slot* below. The three folders share a version string; tell them apart by code, not version (the Store build says `channel=store` in its background script and is the only one with the "This page" box).

---

## The side panel

The Vodou icon (or **⌃⇧M** — Control, not Command, on macOS) opens a **side panel** that stays open across tabs. There is no popup any more. Four tabs:

- **Memory** — the page-aware section at the top ("Your memory here", "Related to what you're typing", "Your documents on this page"), then the **picker**: search all your memory (or one vault), tick facts, **Insert** them into the page's text box. Rows show relevance, tag, source, age, and 🔒 for facts outside your shared vault.
- **Ask** — talk to your local Vodou (memory + brain) about anything, from any page. Answers can go straight into your draft.
- **Activity** — what the bridge did: captures, inserts, tasks, library adds, with timestamps.
- **Settings** — every switch below, plus Connection / Pairing / Advanced (custom gateway URL, off by default; pointing at a non-local address means chat data can leave this computer, and the panel says so).

On ChatGPT and Claude there is also a small **Vodou disc** bottom-right of the page: hover expands it to **Save what's here** (save the open conversation) and **Add my memory** (same as Ctrl+B).

---

## Save my chats (capture)

**Auto-capture AI chats** (Settings → *Save my chats*, **off by default**). Turn it on and every supported chat is saved to your local memory *as it happens* — you can untick individual sites in the grid under the switch. It hooks the site's own network traffic (the JSON/SSE/WebSocket the page exchanges with its backend), not the DOM, so both your prompt and the reply are captured faithfully and it survives UI redesigns. Captured turns land at `capture:web:<provider>` — provenance-ranked below your first-party memory, deduped, never auto-promoted into `MEMORY.md`.

**Supported (22 adapters, 35 hosts):** ChatGPT, Claude, Gemini, Google AI Studio, Grok (grok.com and x.com/i/grok), Perplexity, DeepSeek, Copilot, Le Chat (Mistral), Qwen, Kimi, Z.ai, T3 Chat, OpenRouter, Poe, Meta AI, Manus, You.com, Duck.ai, NotebookLM, HuggingChat, Character.AI. Some are experimental (written from known wire formats); if one stops capturing, the page console logs `[vodou-netcap] … parsed 0 turns` — report it, it's a one-adapter fix (`inject.js` `ADAPTERS`, tests in `test/parsers.test.mjs`).

**Also remember what I said before I installed Vodou** (off by default) — opening an old conversation files the rest of that thread too. To assemble a complete thread Vodou may ask the site for that conversation, signed in as you, the same way the page itself does (ChatGPT and Claude today).

**Save what's here** — the disc on ChatGPT/Claude: saves the open conversation now, whether or not auto-capture is on. Lands under `import:<provider>:<id>` (manual saves are idempotent).

**Send selection to Vodou memory** — highlight text on **any** page → right-click → this item. Lands at `capture:manual:<host>` **with the page it came from** (since .75), so it shows up under *Your memory here* the next time you're on that page. Silent by design (no toast) — verify in Vodou → Memory if you want to see it land.

**Add this page to Vodou Library** / **Add linked file to Vodou Library** — right-click anywhere on a page (or on a link to a PDF/DOCX/etc.). The page's text is read once, on that click, and filed as a Library document (chunked, embedded, carded); a badge on the icon shows ⋯ → ✓, and a notification names the document. Google Docs can't be read from the browser (canvas) — the toast tells you the File → Download route. Since .75 the document is stamped with the page it came from, so it appears as a 📄 row under *Your memory here* on that page.

A remote **capture kill switch** exists: the extension downloads a small public JSON from `policy.vodou.ai` at startup and ~twice a day. It can only *turn a site's capture off* (never on), carries no logic, and the request sends nothing about you (no cookies, no query, no body).

---

## Use memory in your chats (insert)

Settings → **Work in your AI chats**:

| Switch | Default | What it does |
|---|---|---|
| **Let Vodou work in these chats** | on | Enables the shortcuts and the disc's *Add my memory* on the ticked sites |
| **Attach memory to every message, then send it** (auto-attach) | **off** | On send, pauses briefly, appends related memory to your message, and **Vodou sends it for you**. Off = nothing is ever sent on your behalf |
| **Use the full brain, not just memory** | off | Ctrl+B runs the agentic Face (skills, tools) instead of plain retrieval; the panel shows a task pill while it works |
| **Let it send, post and create — not just read** | off | Lets brain mode use side-effecting tools |

Shortcuts (Chrome → `chrome://extensions/shortcuts` to change; on macOS these are the **Control** key):

| Keys | What |
|---|---|
| **⌃B** | Add relevant memory to this chat — invisible network attach where the site supports it, else a visible composer insert; brain mode if enabled |
| **⌃⇧B** | Add memory **visibly** into the composer — on any supported site, and since .75 in **any text box on any page** (facts from the page you're on if page memory is on, else what memory finds for your draft) |
| **⌃⇧M** | Open the panel |
| **⌃⇧Y** | Run your draft as a Vodou task (see *Tasks*) |

How it decides what to insert: your draft (up to 500 chars) seeds a retrieval over all memory; the gateway selects the facts worth attaching (`mem context` with the reranker), and they're inserted fence-less — "the fact stands on its own". Injected text is registered so capture never re-learns it as something you said. If a rich editor refuses the insert, the text is copied to your clipboard and the toast says so.

The panel **picker** does the same by hand: search, tick, **Insert** (Ctrl+B is the one-key version). Full guide, including IDE/MCP setup: [memory-follows-you.md](memory-follows-you.md).

---

## Memory on the page you're on *(new in .75)*

Settings → **This page** → **Show what I know about the page I'm on** — **off by default**. The first time you turn it on, the panel shows a disclosure card and asks; it re-asks if what the feature reads ever changes (the disclosure is versioned).

What it reads, and what it does not: while the panel is open, the **address and title of the tab you are viewing** go to Vodou on your own computer to look up your own memories; while you type in a text box on the page, **what you've typed so far** (≤500 chars) goes the same way to find related memories — never in password, payment or one-time-code fields, and nothing you type is stored by the extension. Nothing is recorded about pages you merely visit; no browsing history is collected, stored or sent anywhere. Turn it off and the panel reads neither your tab nor your typing.

With it on, the **toolbar icon turns green** on a page you have memory *from* (facts noted, clipped or captured here; documents saved from here); hover it for the count. Blue = nothing from this page. (The site tier and title-only guesses deliberately don't color the icon.)

**Per site.** The "This page" box has a control, *On <site>:* **Off — don't look at this site** / **Suggest only — show, never save** / **Suggest + collect**. Banks, health portals, tax and sign-in hosts are **off by default** (Vodou never reads the tab there until you say so); everything else defaults to suggest + collect. The gateway enforces the mode — a suggest-only site refuses notes and 📎 links, an off site is never asked about — and the rule covers subdomains. **Forget site…** hides every memory Vodou has from the current site (two clicks: the first shows the count, the second confirms; reversible with `vodou-core mem forget --host <h> --undo`; Library documents from the site are counted, not removed).

With it on, the Memory tab shows, at the top:

- **Your memory here** — memories stamped **on this page** (a chat you had *in this conversation*, a selection you clipped *here*, a note you wrote *here*), then **on this site**, and any Library **📄 documents** you saved from this page or site (one row per document; click copies its `@doc:` token). Rows show age ("today", "3d"); tick + **Insert** or **Insert all** puts them into the page's text box.
- **Note about this page…** — type, Save; stored with the page stamped, visible immediately. This is how a page with no chat (Jira, Notion, your own brain console) gets memories.
- **📎 this page** — on any picker row: stamp that memory with the current page so it appears here next time.
- **Related to what you're typing** — appears when you pause while writing in a text box on the page: what memory finds for the draft, tick + Insert; folds when you leave the field.

Under the hood: memories carry `source_url` / `source_host` (the page normalized — tracking parameters stripped, chat URLs identified by their conversation id) and `source_ref` (the conversation a captured fact came from), written by the extractor for captured and manually saved chats (`page:` / `ref:` tokens), by `mem store --url` for notes, by `mem page-link` for links (which also rewrites the token in your own memory logs so a re-index keeps it), and by the Library for saved pages. Vaults can select by site (`mem vault create --hosts wikipedia.org,notion.so`), and the memory map (Memory → ✦ Map) has a **Site** filter. `mem page-match <url>` shows the tiers from the CLI; the gateway route is `POST /api/page-match`. Only pages captured **from now on** are stamped — there is no backfill for older memories.

---

## Fill a form from memory *(new in .75)*

Right-click on any page with a form → **Fill this form from Vodou** (or the `fill-from-memory` shortcut, unbound by default; the panel's **Fill form…** button works on pages Vodou has already opened). The extension reads the form's field **labels, names, types and options** — never password, payment or one-time-code fields, and never what's already typed — and the panel shows a **review card**: a proposed value per field with the memory it came from and a confidence, all editable, ticked when confident. **Fill ticked fields** writes them into the page; **nothing is ever submitted** — you press the page's own button.

**Ctrl+B on a form page** is the one-key version: with your cursor *not* in a text box (or in an empty one), it fills the **empty** fields straight away with what memory answers confidently — instant identity/learn-back answers first, model answers a few seconds later — toasts how many it filled, and opens the review card with those rows marked ✓ so you can edit a value and fill again. It never overwrites something you typed. With a draft in a text box, Ctrl+B does what it does on ChatGPT instead: inserts the memories related to what you're writing into that box.

Where answers come from, in order: (1) **what you answered on this page before** ("you answered here", instant, no model), then this site; (2) your **memory** — identity facts (name, e-mail, phone, address, employer…) and per-field retrieval — through one call to the same LLM your memory extraction uses (BYOK / local models apply), under a hard rule: only what memory supports, never invented; long text boxes may be **drafted** from memory in a sentence or two. Selects only get values the dropdown actually offers.

**Learn-back:** with *Remember my answers on this page* ticked (default; only on suggest + collect sites), the answers you accept — including your edits — are stored as page-tied facts, so the same form pre-fills next time without a model call. Identical answers aren't stored twice; a changed answer wins. Editing a proposed value changes what's remembered *for that form*, not the fact it came from (use `mem correct` for that).

CLI: `vodou-core mem fill-plan --stdin-json [--no-llm]`; gateway `POST /api/page-match/fill-plan`, `POST /api/page-match/learn`.

## The browser as tools for the brain (`vodou-browser`) *(new in .75)*

Vodou's brain, skills and the CLI can read and act on the page you're looking at through a fixed set of packaged tools — `tabs_list`, `tabs_open`, `tabs_activate`, `page_read`, `page_model`, `page_insert`, `page_fill`, `page_find`, `page_save` — exposed as the MCP server **`vodou-browser`** (`./vodou-core call vodou-browser page_read '{}'`; skills and `AGENT_ACTIONS` use the same). Each call goes local Vodou → gateway → the extension, which enforces the same rules as everything else: the site's page-memory mode (`off` = refused), access to that page (a listed AI site, a site you enabled, or a page you right-clicked Vodou on — otherwise the tool fails with that instruction rather than widening access), a receipt in the panel's **Activity** tab. Nothing submits forms, clicks buttons or navigates except `tabs_open` / `tabs_activate`, which you see happen. This replaces the Store-disabled `act_in_tab` script lane; no code is ever sent to a page.

## Tasks (⌃⇧Y and Ask)

Type a request in an AI chat's composer, press **⌃⇧Y**: the panel opens, Vodou runs it as a task (skills, tools, memory) and puts the answer back in your draft for you to review and send. If you've moved on and the panel can't show you, a desktop notification carries the result (**Tell me when a task finishes somewhere I can't see**, on by default; click it to open the panel). The panel's **Ask** tab is the same brain without a composer — ask anything from any page.

---

## Documents (Library) on the page you're on

Independent of page memory: the Memory tab's **Your documents on this page** lists Library documents that match the tab's title/site — *"this page is about this document"* or *"this document mentions what's on this page"*. Click a row to copy `@doc:<slug>`, then paste it into any Vodou chat to attach the document. Precision-over-recall by design; it usually shows nothing.

---

## Preview: the new chat console

Settings → **Preview** → **Use the new chat console** (off): turns the panel into a chat-first console with Memory, Apps, Skills and Settings inside it. Close and reopen the panel after switching; a button in its corner brings you back.

---

## Privacy & permissions

- **Where things go:** to Vodou on `127.0.0.1` only. Vodou Inc. does not receive the content of pages or chats through the extension. Memory you insert into an AI chat goes to that AI provider — you sent it.
- **What leaves your machine through the extension:** one download of a public settings file from `policy.vodou.ai` (no cookies, no identifiers). That's all.
- **Permissions and why** (also in the Store listing): `sidePanel` (the UI), `activeTab` + `scripting` (read/insert on the page you clicked/shortcut in — that page, that once), `tabs` (the address/title of the tab you're viewing — for page memory, document match, and knowing which chat you're in; no reading of other tabs, no history), `storage` (settings, a bounded retry queue, the activity list), `alarms` (30 s reconnect check, 12 h policy download), `cookies` (only to save a conversation from a listed AI site as you, on your click; never stored, never sent elsewhere), `contextMenus` (three items), `notifications` (task results, Library adds).
- Full policy: `legal/PRIVACY-POLICY.md` (v1.7) — also at app.vodou.ai/privacy.

---

## Reliability

Chrome suspends MV3 service workers when idle. The bridge rides this out: the gateway pushes a `server_heartbeat` every 20 s while connected (which keeps the worker alive), both sides reap a socket that's silent for 75 s, and the extension reconnects on its next alarm. Click the icon to wake it if the panel ever reads disconnected.

**One bridge slot.** The gateway admits **one** bridge at a time. A second copy — another profile, another window, or two builds loaded at once — gets rejected (`1013`) and after three rejects stands by for five minutes; its panel reads **"another window holds the connection."** The fix is never "retry harder": disable the extra copy in `chrome://extensions`, then reopen the panel. (The gateway log names the origins fighting: `[vbb] rejected N newcomer socket(s) … from chrome-extension://…`.)

If an upgrade leaves things stuck: `chrome://extensions` → Remove → quit Chrome fully → reopen → reinstall/Load unpacked. A full quit clears any lingering worker.

---

## Troubleshooting

- **"another window holds the connection"** — two Vodou Bridge installs are enabled (Store + unpacked is the classic case). Keep one. See *One bridge slot*.
- **A setting described here isn't in my Settings tab** — you're on a different build (the two sideload builds have no "This page" section) or on the Console Two preview. Check `chrome://extensions` → the card's version *and* folder; the Store install is `From Chrome Web Store`.
- **"Vodou Bridge not connected"** — is Vodou running? `http://localhost:8765` should load. Then click the icon.
- **Panel shows nothing under "Your memory here"** — only pages captured, clipped, noted or saved since .75 are stamped; write a note or clip a sentence and it appears. Also check the switch is on (Settings → This page).
- **Ctrl+B does nothing on a site** — it's the Control key on macOS; check `chrome://extensions/shortcuts` for conflicts. On a page with no text box the toast says so; open the panel and copy instead.
- **Add this page did nothing** — open the extension's service-worker console (`chrome://extensions` → the card → *service worker*) and click again: the `[library] …` lines name the step (menu click → reading tab → N chars → filed / failed).
- **Capture stopped on one site** — its API changed; console shows `[vodou-netcap] … parsed 0 turns`. Report the site.
- **Uninstall** — `chrome://extensions` → Remove. Nothing to clean up on the Vodou side; your memory stays.

---

## Lenses that read authenticated pages (full build)

The full (`vodou-bridge/`) build also powers **lenses** that need your session to read a logged-in page (Gmail thread, Linear issue…). Most built-in lenses (npm.package, wikipedia.article, arxiv.paper, hackernews.item, youtube.video, …) fetch server-side and work without the bridge; only lenses whose manifest declares `requires.needs_session: true` need it and show a "Vodou Bridge required" card otherwise. Lens authors: declare `requires: { needs_session: true }` only if you truly need the user's tab; `ctx.fetchStatic`-only lenses should leave it off.

---

## For developers

- **Source:** `extension/Store-vodou-bridge/` (`background.js` service worker + bridge, `content.js` page side, `inject.js` MAIN-world network taps + 22 adapters, `sites.js` site registry, `sidepanel.html/js` the panel, `console2.*` the preview).
- **Tests:** `cd extension/Store-vodou-bridge && node --test 'test/*.test.mjs'` (parsers, capture queue, brain/chat lanes, lease messages, backfill…). Gateway-side: `MCP-servers/Vodou-Console/src/__tests__/page-match.test.ts`, `page-memory-consent.test.ts`, `page-id.parity.test.ts`, `library-e2e.test.ts`.
- **Release gates:** `./scripts/pack-vodou-bridge-store.sh` (PII scan built in) → `python3 scripts/verify-store-zip.py <extracted-zip-dir>` (31 checks) → `python3 scripts/verify-cws-claims.py` (fails when a Store justification no longer matches the package: executeScript/contextMenu/badge/shortcut counts, the `tabs` sentence, no `optional_host_permissions` before P5). All three builds must carry the same version (parity test).
- **Store paperwork:** `PLANS/0.6.21-Browser-ext/extention/CWS-LISTING-COPY.md`, `CWS-PERMISSION-JUSTIFICATIONS.md`, `CWS-UPLOAD-RUNBOOK.md`; per-release dashboard steps in `legal/CWS-P1-DASHBOARD-ACTIONS.md`.
- **Gateway surfaces the extension uses:** WebSocket `/api/vbb` (`capture_turn`, `capture_request`, `context_request`, `brain_request`, `title_probe`, task/chat commands; gateway→extension `fetch`, `list_tabs`, `cookies_fetch`, `extract_builtin`; `act_in_tab`/`extract` are UNSUPPORTED in the Store build because they'd ship code); HTTP `POST /api/page-match` (+ `/note`, `/link`), `POST /api/library/match`, `/api/library/url`, `/api/library/text`; `GET /api/vbb/state` for status.
- **CLI equivalents:** `vodou-core mem page-match <url> [--json]`, `mem page-link <chunk-id> --url <u>`, `mem store "<text>" --url <u>`, `mem forget --host <h> [--dry-run|--undo]`, `mem vault create … --hosts a,b`, `mem library add|add-text --url <u>|match <query>`, `mem import <src> --stdin-json --url <u>`. Gateway: `GET/PUT /api/page-match/site-mode`, `POST /api/page-match/forget-host`.
- **Roadmap** (`PLANS/0.6.26/PLAN-MEMORY-ON-EVERY-PAGE.md`): P0–P7 built (page identity, panel, collect/insert anywhere, typing suggestions, green icon, per-site modes/forget/vault hosts/brain facet, fill-from-memory with learn-back, per-site "Enable Vodou on this site", the `vodou-browser` tool catalogue). Deferred: P6b action chips; P5 generic capture is opt-in per site.
