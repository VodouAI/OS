# Changelog

All notable changes to the open Vodou client are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow the engine release tags.

<!-- Maintained as part of the release playbook (Step 6b). Every published version gets
     an entry BEFORE the open tree syncs, written in user-facing language: what someone
     can now do, not which module changed. Do not write `@doc:` or any bare @word outside
     backticks — GitHub renders it as a user mention and attaches a Contributors block. -->

## [Unreleased]
_Nothing yet._


## [0.6.24] - 2026-08-14 — Alpha

### Fixed
- **Several bundled tools were installed but invisible.** The task board, the memory-graph brain, the IDE memory server, Gmail and Microsoft 365 all shipped with Vodou but were never registered, so the app could not connect to them, they never appeared under Capabilities, and nothing could call them. They are registered now — on fresh installs *and* when you update an existing one. Gmail and Microsoft 365 arrive switched off until you connect an account.
- **Board tasks that ran forever.** A dispatched task did its work and then had no way to report finishing, so it was reclaimed and started over, indefinitely. Workers can now close out their own tasks.
- **Updates take effect immediately.** Newly registered tools used to stay invisible for up to five minutes after an update while the app was still reading its old list. The list is now refreshed before anything reads it.
- **The Chrome DevTools tool could never start.** It was packaged one directory deeper than the app looked for it — in every release that included it — so it failed on first connection and retried in a loop.
- **Your account token was written to the log in plain text** every time your licence was checked, and stayed there. Tokens are now masked wherever they are logged.
- **Bundled tools now always run on the Node that ships with Vodou**, instead of whatever happened to be on the system. On machines with an older Node, or none, several tools simply failed to start.

### Known issues
- Model lists for Groq, DeepSeek, xAI, Mistral, Together and Kimi are three weeks old in this build; other providers are current.
- The Windows build is unsigned — SmartScreen will warn — and is download-only: Windows installs do not auto-update to this version.


## [0.6.23] - 2026-08-11 — Alpha

### Added
- **The Document Library — your documents become memory.** Add a PDF, Word doc, spreadsheet, slide deck, ebook, CSV or note and Vodou reads it, remembers it, and can hand it to any model on request. Add from a file, a whole folder, a URL, or the page you are looking at in your browser.
- **A library you can actually browse** at `/library` — search, filter by state (broken, un-carded, watched), read the extracted text, open the original, and add new documents with a paste-a-path box that shows live progress on a folder import.
- **Attach a document to any chat with `@doc:<name>`** — in the Vodou console, Slack, Telegram, anywhere. A typo suggests the right document rather than failing silently, and a document too large to attach whole says so and points at the section you want.
- **Vodou knows which document answers a question.** Each document gets a routing card — what it is, what it answers, and what it is *not* about — so "what is our liability cap?" reaches the contract instead of a guess. Documents also surface in ordinary memory search for the first time.
- **The panel tells you when a page relates to something you saved.** Reading a contract template? It points at your own agreement. On an unrelated page it stays quiet — deliberately, because a chip that lights up on everything gets ignored.
- **"Add to Vodou Library" in the browser** — right-click any page, or use the keyboard shortcut for pages that own their right-click menu (Google Docs, Notion). Requires Vodou Bridge 0.5.97.73 or later.

### Changed
- **Documents are chunked as documents.** A bullet in a personal note is a standalone fact; a bullet in a plan is prose. Treating them alike split one plan into 181 fragments; it now produces 50 coherent passages with nothing lost.
- **Document matching is fast.** Looking up which document is relevant went from ~10s to under a second by asking the already-running memory service instead of starting a new one for every question.
- **Contradiction detection reads across documents** — a governing-law clause is compared against other governing-law clauses, not the whole corpus.

### Fixed
- **Two silent text-loss bugs in document import**, both found by reading a stored document rather than trusting a success message: a paragraph-splitting bug dropped 940 bytes of a 9,199-byte passage mid-word, and an oversized first paragraph was never split at all.
- **One reranker per install.** The background service and the command line were quietly using different relevance models, so the same question could score differently depending on which answered it.
- **Pasting a document reference no longer confuses the router.** A message containing only `@doc:something` was being treated as a search query and could trigger unrelated tools.
- Browser capture of Notion and similar pages no longer welds every block into one run-on line, and no longer eats words inside links and buttons.

### Known issues
- Windows remains unsigned — SmartScreen will warn. Treat it as a preview.
- Model lists for six providers (groq, deepseek, xai, mistral, together, kimi) are ~3 weeks old in this build.

## [0.6.21] - 2026-08-07 — Alpha

### Added
- **Attach other apps to your Vodou memory** — each connected client gets its own identity, scope and kill switch, with an audit log of what it actually did and per-client rate limits. Settings → Clients shows every attachment and lets you revoke one.
- **Memory arrives before you finish typing** — the inject lane prefetches while you type.
- Every "install the Bridge" surface in the console now points at the live Chrome Web Store listing.

### Changed
- **Memory injection got quieter and more accurate**: a calibrated relevance floor, paraphrase de-duplication that keeps the richest wording, recency tie-breaks, and silence when Vodou genuinely does not know.

### Fixed
- Operator personal details were scrubbed from shipped surfaces, with a PII gate added to the store packaging step.
- Conflict resolution returned blank HTTP 500s in some cases.
- The Linux and Windows release archives can now actually pass verification.

## [0.6.20] - 2026-08-03 — Alpha
### Added
- **Save your chats on 22 AI sites, not 2.** The in-page Save button worked on ChatGPT and Claude only; it now works on all 22 supported sites (Gemini, AI Studio, Grok, Perplexity, DeepSeek, Copilot, Le Chat, Qwen, Kimi, Z.ai, T3 Chat, OpenRouter, Poe, Meta AI, Manus, You.com, Duck.ai, NotebookLM, HuggingChat, Character.AI). Each was verified against a real conversation by reading the stored text back — words and speakers, not turn counts.
- **Auto-attach memory on send** — opt-in, off by default, per site. Pressing send appends relevant memory to your message and sends it as one prompt. With it on, Vodou acts on your behalf; the panel and privacy policy say so. Your message is never lost if the lookup fails.
- **The Brain** — the memory graph made visible: the stars and how they connect, a Latest view showing the newest memory in context, and a Chronicle that opens a day and what it connects to. Relations now say *how* two names relate, and entities are typed rather than guessed.
- **The capture feed** — every captured conversation across every provider on one wall, with the model that answered and a link back to the original thread.
- **Multi-platform bundles** — macOS (Apple Silicon + Intel), Linux (x64 + arm64) and Windows x64.

### Changed
- **The extension is a side panel, not a popup.** The toolbar icon opens a panel holding the memory picker, activity log and every setting, with per-site toggles for both capture and insert across all 22 sites.
- **One in-page control** instead of two floating buttons — a single mark that fans open into the actions available on that site, reporting progress and results on the button itself.
- Onboarding's browser lane can be acted on: install path, live detection when the extension connects, and proof it captured something.

### Fixed
- Capture quality across every site: seven sites leaked the model's private reasoning into the stored answer (one by 1,045 characters — twice the length of the reply); six stored interface text as speech; three had broken conversation identity, including one where every chat shared an id and each save overwrote the last; four dropped, duplicated or invented turns.
- Imports no longer re-extract the same fact once per monthly file.
- Pasted console output is no longer stored as durable memory.
- Guest memory is scoped to the room's vault, closing a bootstrap leak.

### Known issues
- **Windows is unsigned and untested at runtime.** SmartScreen will warn. Treat it as a preview.
- The Save button reads the messages currently rendered on the page — on very long threads that is what is loaded, not the whole history. Provider exports and the paginating backfill still cover the rest.

## [0.6.18] - 2026-07-15
### Fixed
- Fresh-install Brain console: ship a complete `memory.db` schema template so all views work on a brand-new install.

## [0.6.16] - 2026-07-14
### Added
- **Memory Follows You** — your memory travels into ChatGPT, Claude, and 22+ AI surfaces via the browser extension, plus the `vodou-memory` MCP server for Cursor / VS Code / Claude Desktop.
- **Universal Memory** — capture, import, and export across surfaces; provenance-weighted ranking, contradiction queue, fact-group dedup.
- **Memory Vaults** — segmented sharing with per-chunk overrides.

<!-- Older entries: summarize the user-facing highlights per tag as you publish them. -->
