# Changelog

All notable changes to the open Vodou client are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow the engine release tags.

<!-- TODO(Chad): backfill from .build/RELEASE-PLAYBOOK.md release notes for the versions
     you want public; keep it to user-facing changes (not internal refactors). -->

## [Unreleased]
- First public open-core release: open client + proprietary engine split (client was MIT at launch; **Apache-2.0 since 2026-07-25**).

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
