// The one list of sites Vodou touches — for BOTH lanes.
//
// Loaded as the first content script (so content.js sees it on the page) and by
// sidepanel.html (so the per-site toggles render from the same source). Before this
// file existed the inject list lived inside content.js and the old popup hard-coded
// two checkboxes, which is how ChatGPT and Claude ended up as the only sites a
// user could turn off while the hotkey was live on 22.
//
// Each entry carries BOTH names for the same surface, because the two lanes grew
// their own vocabularies and six of them disagree:
//
//   key     — inject: matched against location.hostname, and the storage key for
//             the per-site inject toggle
//   capture — the adapter `name` in inject.js, which is what arrives as
//             d.provider on a captured turn, and the storage key for the
//             per-site capture toggle
//
// Where they differ: mistral/lechat, t3/t3chat, you/youcom, duck/duckai,
// huggingface/huggingchat, character/characterai. Gating capture on `key` would
// silently fail to gate exactly those six — the same invisible drift that has
// already cost three host-migration bugs. test/sites.test.mjs asserts
// every adapter in inject.js has an entry here and vice versa.
//
// A host migration has to land in the manifest AND here. It has silently broken
// three times when it landed in only one (NotebookLM -> notebook.google.com,
// Qwen off the chat. subdomain, and the sideload manifest missing both). The
// failure is invisible: injectSiteKey() returns null on an unknown host and the
// keydown handler leaves the hotkey to the page, so there is no toast and no
// console line.
//
// Labels are PRODUCT names, not company names — ChatGPT not OpenAI, Claude not
// Anthropic, Le Chat not Mistral. The gateway's feed has its own copy of these
// strings (Vodou-Console/public/feed.html PROVIDER_LABEL) because it runs in a
// different process and cannot load this file; the two disagreed on exactly one
// (Mistral vs Le Chat) until 2026-07-29, and test/sites.test.mjs now compares them.
//
// There is deliberately NO per-site "import full history" flag here. A `fullImport`
// field existed briefly on 2026-07-29 and was removed with the button it gated: the
// gateway's DOM extractors (`claude_conversation`, the ChatGPT path) read only the
// message nodes currently rendered, and both sites virtualise long threads — so the one
// thing such a button promises, the earlier messages, is the thing it cannot deliver.
// Full history comes from the provider's own export (Claude) or the paginating backfill
// (ChatGPT). Live turns are covered on all 22 sites by passive capture.
//
// `mechanism` is how injected context reaches the model:
//   composer — typed into the page's composer, visible, editable before send
//   network  — spliced into the outgoing request body, invisible
globalThis.VODOU_SITES = [
  { key: 'chatgpt', label: 'ChatGPT', host: /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/, mechanism: 'network', capture: 'chatgpt' },
  { key: 'claude', label: 'Claude', host: /(^|\.)claude\.ai$/, mechanism: 'composer', capture: 'claude' },
  { key: 'gemini', label: 'Gemini', host: /(^|\.)gemini\.google\.com$/, mechanism: 'composer', capture: 'gemini' },
  { key: 'aistudio', label: 'AI Studio', host: /(^|\.)aistudio\.google\.com$/, mechanism: 'composer', capture: 'aistudio' },
  { key: 'grok', label: 'Grok', host: /(^|\.)grok\.com$|(^|\.)x\.com$|(^|\.)twitter\.com$/, mechanism: 'composer', capture: 'grok' },
  { key: 'perplexity', label: 'Perplexity', host: /(^|\.)perplexity\.ai$/, mechanism: 'composer', capture: 'perplexity' },
  { key: 'deepseek', label: 'DeepSeek', host: /(^|\.)chat\.deepseek\.com$/, mechanism: 'composer', capture: 'deepseek' },
  { key: 'copilot', label: 'Copilot', host: /(^|\.)copilot\.microsoft\.com$/, mechanism: 'composer', capture: 'copilot' },
  { key: 'mistral', label: 'Le Chat', host: /(^|\.)chat\.mistral\.ai$/, mechanism: 'composer', capture: 'lechat' },
  { key: 'qwen', label: 'Qwen', host: /(^|\.)qwen\.ai$/, mechanism: 'composer', capture: 'qwen' },
  { key: 'kimi', label: 'Kimi', host: /(^|\.)kimi\.com$|(^|\.)kimi\.moonshot\.cn$/, mechanism: 'composer', capture: 'kimi' },
  { key: 'zai', label: 'Z.ai', host: /(^|\.)chat\.z\.ai$/, mechanism: 'composer', capture: 'zai' },
  { key: 't3', label: 'T3 Chat', host: /(^|\.)t3\.chat$/, mechanism: 'composer', capture: 't3chat' },
  { key: 'openrouter', label: 'OpenRouter', host: /(^|\.)openrouter\.ai$/, mechanism: 'composer', capture: 'openrouter' },
  { key: 'poe', label: 'Poe', host: /(^|\.)poe\.com$/, mechanism: 'composer', capture: 'poe' },
  { key: 'metaai', label: 'Meta AI', host: /(^|\.)meta\.ai$/, mechanism: 'composer', capture: 'metaai' },
  { key: 'manus', label: 'Manus', host: /(^|\.)manus\.im$/, mechanism: 'composer', capture: 'manus' },
  { key: 'you', label: 'You.com', host: /(^|\.)you\.com$/, mechanism: 'composer', capture: 'youcom' },
  { key: 'duck', label: 'Duck.ai', host: /(^|\.)duck\.ai$|(^|\.)duckduckgo\.com$/, mechanism: 'composer', capture: 'duckai' },
  { key: 'notebooklm', label: 'NotebookLM', host: /(^|\.)notebook(lm)?\.google\.com$/, mechanism: 'composer', capture: 'notebooklm' },
  { key: 'huggingface', label: 'HuggingChat', host: /(^|\.)huggingface\.co$/, mechanism: 'composer', capture: 'huggingchat' },
  { key: 'character', label: 'Character.AI', host: /(^|\.)character\.ai$|(^|\.)old\.character\.ai$/, mechanism: 'composer', capture: 'characterai' },
];
