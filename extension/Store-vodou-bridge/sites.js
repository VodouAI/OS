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
// Qwen off the chat. subdomain, and one build's manifest missing both). The
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
// `mechanism` is how injected context reaches the model. Every entry below is
// `composer`: typed into the page's own composer, visible, and editable before
// send. This build has no other path — outgoing requests are never modified.
globalThis.VODOU_SITES = [
  { key: 'chatgpt', label: 'ChatGPT', host: /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/, mechanism: 'composer', capture: 'chatgpt' },
  { key: 'claude', label: 'Claude', host: /(^|\.)claude\.ai$/, mechanism: 'composer', capture: 'claude' },
  { key: 'gemini', label: 'Gemini', host: /(^|\.)gemini\.google\.com$/, mechanism: 'composer', capture: 'gemini',
    // VERIFIED 2026-08-01 against a real 2-turn chat. `message-content` is the
    // model's text container inside model-response; taking model-response itself
    // would swallow the disclaimer and the action buttons.
    save: { user: 'user-query-content', assistant: 'message-content',
            urlPattern: 'https://gemini.google.com/*', uuid: '/app/([0-9a-f]{8,})' } },
  { key: 'aistudio', label: 'AI Studio', host: /(^|\.)aistudio\.google\.com$/, mechanism: 'composer', capture: 'aistudio',
    // VERIFIED 2026-08-01 against a real 2-turn chat, both halves. Role is a class
    // on .chat-turn-container; ms-text-chunk is the text and correctly excludes the
    // turn's own UI (edit / more_vert / the timestamp / thumb_up).
    // No uuid pattern on purpose: unsaved chats are all /prompts/new_chat, so the
    // extractor's content-hash fallback supplies the id.
    save: { user: '.chat-turn-container.user ms-text-chunk',
            assistant: '.chat-turn-container.model ms-text-chunk',
            urlPattern: 'https://aistudio.google.com/*' } },
  { key: 'grok', label: 'Grok', host: /(^|\.)grok\.com$|(^|\.)x\.com$|(^|\.)twitter\.com$/, mechanism: 'composer', capture: 'grok',
    // VERIFIED 2026-08-01 against a real 6-turn chat. Explicit test ids on both
    // roles — the cleanest of the sites checked so far.
    // .thinking-container is stripped because every assistant turn opens with
    // "Worked for 6s", which would otherwise be stored as words Grok said. The
    // same container holds the expanded reasoning trace, so this is also the
    // reasoning-leak strip for this site.
    save: { user: '[data-testid="user-message"]',
            assistant: '[data-testid="assistant-message"]',
            strip: ['.thinking-container'],
            urlPattern: 'https://grok.com/*', uuid: '/c/([0-9a-f-]{8,})' } },
  { key: 'perplexity', label: 'Perplexity', host: /(^|\.)perplexity\.ai$/, mechanism: 'composer', capture: 'perplexity',
    // VERIFIED 2026-08-01 against a real 10-turn thread. Perplexity exposes no
    // message test ids; queries carry a `group/query` utility class and answers
    // render into `.prose`.
    // [class~="group/query"] rather than .group\\/query — the ~= form matches the
    // whitespace-separated class list and needs no escaping, which a Tailwind class
    // containing a slash otherwise does.
    // Checked that no .prose sits INSIDE a query block: if one did, closest() would
    // mark every answer as the user's and the whole thread would invert.
    save: { user: '[class~="group/query"]', assistant: '.prose',
            urlPattern: 'https://*.perplexity.ai/*', uuid: '/search/([0-9a-z-]{8,})' } },
  { key: 'deepseek', label: 'DeepSeek', host: /(^|\.)chat\.deepseek\.com$/, mechanism: 'composer', capture: 'deepseek',
    // VERIFIED 2026-08-01 against a real 8-turn chat. DeepSeek ships no test ids
    // and hashes its class names, but .ds-message and .ds-markdown are
    // design-system classes and stable. Only ASSISTANT messages contain
    // .ds-markdown, so :not(:has()) separates the two roles without depending on
    // a hash like `d29f3d7d` that changes on any rebuild.
    // scroller is load-bearing, not an optimisation: DeepSeek virtualizes, and
    // this very conversation had 5 of its 8 messages missing from the DOM until
    // the list was scrolled to the top.
    save: { user: '.ds-message:not(:has(.ds-markdown))', assistant: '.ds-markdown',
            scroller: '.ds-virtual-list',
            urlPattern: 'https://chat.deepseek.com/*', uuid: '/s/([0-9a-f-]{8,})' } },
  { key: 'copilot', label: 'Copilot', host: /(^|\.)copilot\.microsoft\.com$/, mechanism: 'composer', capture: 'copilot',
    // VERIFIED 2026-08-01 against a real 4-turn chat. data-content is an explicit
    // role marker, so no structural inference is needed.
    // Copilot prefixes each turn with "You said" / "Copilot said" like Gemini does,
    // but the default screen-reader strip already removes it — confirmed on the
    // extracted text, not assumed from the markup.
    // Conversation ids here are 21-char nanoid-style, NOT uuids, so the pattern is
    // deliberately looser than the /c/<uuid> sites.
    save: { user: '[data-content="user-message"]', assistant: '[data-content="ai-message"]',
            urlPattern: 'https://copilot.microsoft.com/*', uuid: '/chats/([0-9a-zA-Z_-]{8,})' } },
  { key: 'mistral', label: 'Le Chat', host: /(^|\.)chat\.mistral\.ai$/, mechanism: 'composer', capture: 'lechat',
    // VERIFIED 2026-08-01 against a real 2-turn chat. data-message-author-role is
    // the same marker ChatGPT uses.
    // The ASSISTANT selector is the answer PART, not the message: Le Chat splits a
    // reply into parts and only `answer` is the reply itself, so this is the
    // reasoning-leak boundary for this site — a thinking part is a different
    // part-type and never matches.
    // .text-hint carries a per-message timestamp INSIDE the user turn, which would
    // otherwise be stored as if the user had typed "10:01pm" after their question.
    save: { user: '[data-message-author-role="user"]',
            assistant: '[data-message-part-type="answer"]',
            strip: ['.text-hint'],
            urlPattern: 'https://chat.mistral.ai/*', uuid: '/chat/([0-9a-f-]{8,})' } },
  { key: 'qwen', label: 'Qwen', host: /(^|\.)qwen\.ai$/, mechanism: 'composer', capture: 'qwen',
    // VERIFIED 2026-08-01 against a real 2-turn chat. Role is carried by the class
    // itself (-user / -assistant), no structural inference needed.
    // Every assistant turn opens with a "Thinking completed" status card. The strip
    // is a SUBSTRING match on the class rather than the exact wrapper name for two
    // reasons: the wrapper is spelled `...-status-card-wraper` (their typo, one r —
    // easy to silently mis-type here and lose the strip), and an EXPANDED reasoning
    // panel is a sibling with its own qwen-chat-thinking-* class that an exact match
    // would miss, leaking the model's private reasoning into memory as its answer.
    save: { user: '.qwen-chat-message-user', assistant: '.qwen-chat-message-assistant',
            strip: ['[class*="qwen-chat-thinking"]'],
            urlPattern: 'https://chat.qwen.ai/*', uuid: '/c/([0-9a-f-]{8,})' } },
  { key: 'kimi', label: 'Kimi', host: /(^|\.)kimi\.com$|(^|\.)kimi\.moonshot\.cn$/, mechanism: 'composer', capture: 'kimi',
    // VERIFIED 2026-08-01 against a real 2-turn chat. Role is on the class.
    // .toolcall-container is the WORST leak found across the sites checked: it is
    // also .thinking-container, and on this conversation it held 1045 characters of
    // Kimi's private chain-of-thought — "The user is asking ... Let me check the
    // memory space" — sitting INSIDE the assistant turn and ahead of the reply. Left
    // in, Vodou would store the model's reasoning as the model's answer, and the
    // extraction downstream would treat it as fact.
    // .segment-user-action-row is the Edit/Copy/Share row inside the USER turn.
    save: { user: '.chat-content-item-user', assistant: '.chat-content-item-assistant',
            strip: ['.toolcall-container', '.segment-user-action-row'],
            urlPattern: 'https://*.kimi.com/*', uuid: '/chat/([0-9a-f-]{8,})' } },
  { key: 'zai', label: 'Z.ai', host: /(^|\.)chat\.z\.ai$/, mechanism: 'composer', capture: 'zai',
    // VERIFIED 2026-08-01 against a real 2-turn chat.
    // .thinking-chain-container was COLLAPSED on the verifying conversation (15
    // chars, just the "Thought Process" header), so the strip was not exercised
    // against expanded reasoning. It holds up anyway because the whole CONTAINER is
    // removed and expanded content lives inside it — structural, not luck. Same
    // reasoning as Qwen; contrast Kimi, where reasoning was expanded and would have
    // leaked 1045 characters.
    save: { user: '.chat-user', assistant: '.chat-assistant',
            strip: ['.thinking-chain-container', '.edit-user-message-button'],
            urlPattern: 'https://chat.z.ai/*', uuid: '/c/([0-9a-f-]{8,})' } },
  { key: 't3', label: 'T3 Chat', host: /(^|\.)t3\.chat$/, mechanism: 'composer', capture: 't3chat',
    // VERIFIED 2026-08-01 against a real 8-turn chat: 8 [data-message-id] nodes, 8
    // extracted, alternating correctly.
    // Both roles key off the message WRAPPER, not the content. T3 marks user turns
    // with aria-label="Your message" and leaves assistant turns unmarked, but .prose
    // appears INSIDE the user wrapper too — so the obvious pairing
    // (user: [aria-label], assistant: .prose) matches every user turn twice and
    // stores it duplicated, with a turn count that still looks plausible.
    save: { user: '[data-message-id]:has([aria-label="Your message"])',
            assistant: '[data-message-id]:not(:has([aria-label="Your message"]))',
            urlPattern: 'https://t3.chat/*', uuid: '/chat/([0-9a-f-]{8,})' } },
  { key: 'openrouter', label: 'OpenRouter', host: /(^|\.)openrouter\.ai$/, mechanism: 'composer', capture: 'openrouter',
    // VERIFIED 2026-08-02. Deferred twice — it needed a capability, not a selector.
    // role   assistant is :has(> div.group.relative); user is the :not() of it.
    //        Confirmed against all 8 rendered turns: the marker pattern .A.A.A.A
    //        matched the real UAUAUAUA exactly. Two other candidates were tested and
    //        REJECTED — every message carries mx-auto, and .ph-no-capture, which
    //        reads like a user-content marker, is on assistant turns too.
    // strip  the sticky model-name header ("DeepSeek V4 Flash"), the per-reply cost
    //        footer ("$0.00026 143 tok 153ms"), and buttons — which is where the
    //        "Reasoning" toggle lives. Expanding that toggle on the verifying
    //        conversation revealed NOTHING (length unchanged at 238), so the strip
    //        was not exercised against expanded reasoning; it holds structurally
    //        because the toggle itself is removed. Same caveat as Qwen and Z.ai.
    // scrollCollect is the point of this entry. scroll-to-top alone — enough for
    //        DeepSeek — recovers ONE window here: 8842px of conversation against a
    //        738px viewport, 6 of 14+ turns carrying text. This walks top to bottom
    //        collecting as it goes, because the nodes are destroyed behind it.
    save: { user: '[data-message-id]:not(:has(> div.group.relative))',
            assistant: '[data-message-id]:has(> div.group.relative)',
            strip: ['div[class*="md:sticky"]', 'div.flex.items-center.px-1', 'button'],
            scroller: '[data-scroll-container]', scrollCollect: true,
            urlPattern: 'https://openrouter.ai/*', uuid: '[?&]room=([0-9a-zA-Z_-]{8,})' } },
  { key: 'poe', label: 'Poe', host: /(^|\.)poe\.com$/, mechanism: 'composer', capture: 'poe',
    // VERIFIED 2026-08-01 against a real 6-turn chat: 6 message nodes, 6 extracted.
    // Poe ships CSS-module class names with a per-BUILD hash suffix
    // (ChatMessage_chatMessage__xkgHx). Every selector here is a SUBSTRING match on
    // the stable prefix — pinning the full class would work today and break on Poe's
    // next deploy, silently, since a selector that matches nothing just yields an
    // empty capture.
    // Role is expressed as SIDE, not as a role word: user turns contain a
    // rightSideMessageBubble, assistant turns carry a bot header instead.
    // That header is the bot's display name ("Assistant") and is stripped, or every
    // reply would begin with the name of the bot as if it had said it.
    save: { user: '[class*="ChatMessage_chatMessage"]:has([class*="rightSideMessageBubble"])',
            assistant: '[class*="ChatMessage_chatMessage"]:not(:has([class*="rightSideMessageBubble"]))',
            strip: ['[class*="LeftSideMessageHeader"]', '[class*="MessageOverflowActions"]',
                    '[class*="messageMetadataContainer"]'],
            urlPattern: 'https://poe.com/*', uuid: '/chat/([0-9a-z]{8,})' } },
  { key: 'metaai', label: 'Meta AI', host: /(^|\.)meta\.ai$/, mechanism: 'composer', capture: 'metaai',
    // VERIFIED 2026-08-01 against a real 22-turn chat; alternation checked across all
    // 22, not just the head.
    // Meta marks ONLY assistant turns. The sole thing separating a user turn from an
    // assistant one in the markup is a Tailwind MARGIN — mt-8 vs mt-4 — which is not
    // something to key a role off: a spacing tweak would INVERT every role, and an
    // inverted transcript is invisible downstream.
    // So the user selector matches the turn WRAPPER by its animation utility, and the
    // role decision is structural (does this turn contain an assistant-message).
    // The failure modes differ in the way that matters: if Meta renames the animation
    // class, user turns disappear — obvious. Keying on the margin would have silently
    // swapped speakers instead.
    // thinking-status is the "Show thinking" toggle; subagent-cot-list is a subagent
    // chain-of-thought — both are the model's reasoning, not its answer.
    save: { user: '[class*="translate-y-"]:not(:has([data-testid="assistant-message"]))',
            assistant: '[data-testid="assistant-message"]',
            strip: ['[data-testid="thinking-status"]', '[data-testid="subagent-cot-list"]'],
            urlPattern: 'https://*.meta.ai/*', uuid: '/prompt/([0-9a-f-]{8,})' } },
  { key: 'manus', label: 'Manus', host: /(^|\.)manus\.im$/, mechanism: 'composer', capture: 'manus',
    // VERIFIED 2026-08-01 against a real 4-turn chat; checked BOTH directions for
    // nesting (0 and 0) before trusting the pair.
    // The names are backwards from what they suggest and were established by reading
    // the text, not by reasoning about the class:
    //   .limited-markdown-content  = the USER's turn
    //   .chat-selection-ask-root   = the ASSISTANT's turn  ("ask" is not the user's)
    // Do not "fix" this by swapping them to match intuition.
    // The user turn's own wrapper carries only Tailwind utilities (empty:pb-0), so
    // there was no semantic anchor on that side other than this one.
    save: { user: '.limited-markdown-content', assistant: '.chat-selection-ask-root',
            urlPattern: 'https://*.manus.im/*', uuid: '/app/([0-9a-zA-Z]{8,})' },
    // Auto-attach could not find the send button here by ANY attribute: it is a
    // <button> with only Tailwind utilities — no aria-label, no test id, no type,
    // and an SVG with an empty class. The positional fallback misses it too,
    // because the control sits OUTSIDE the container holding the composer toolbar
    // (toolbar's last button is an X at x=447; send is at x=1071).
    // So: the icon path, which is the only stable thing on it. Verified as exactly
    // one match. If Manus redraws that icon this stops matching and clicking send
    // attaches nothing — the same silent miss as before, no worse, and Ctrl+B and
    // Enter are unaffected.
    send: 'button:has(path[d^="M7.91699"])' },
  { key: 'you', label: 'You.com', host: /(^|\.)you\.com$/, mechanism: 'composer', capture: 'youcom',
    // VERIFIED 2026-08-01 against a real 6-turn chat. Indexed test ids
    // (youchat-question-turn-N / youchat-answer-turn-N), matched by PREFIX so turn
    // count is irrelevant.
    // The web-results panel is stripped: those are search citations rendered inside
    // the answer, not words the model wrote.
    // The conversation id is a QUERY parameter, not a path segment — which is why
    // the extractor matches against pathname+search.
    save: { user: '[data-testid^="youchat-question-turn-"]',
            assistant: '[data-testid^="youchat-answer-turn-"]',
            strip: ['[data-testid="youchat-web-results-panel"]', '[data-testid$="-you-chat-updates"]'],
            urlPattern: 'https://*.you.com/*', uuid: '[?&]cid=([0-9a-zA-Z_-]{8,})' } },
  { key: 'duck', label: 'Duck.ai', host: /(^|\.)duck\.ai$|(^|\.)duckduckgo\.com$/, mechanism: 'composer', capture: 'duckai',
    // VERIFIED 2026-08-02 against a real 4-turn chat. Deferred once as unsolvable —
    // the assistant turn has no test id, no role, no aria, and every wrapper class
    // up to <main> is a build hash (PBQZNIcKgp0FJ_yxBVaB). Solved WITHOUT touching a
    // single hashed class:
    //   the DuckDuckGo banner PRECEDES the user message and the reply FOLLOWS it, so
    //   the general sibling combinator separates them. The banner is excluded for
    //   free rather than needing its own strip.
    // stripAssistant, not strip: the model-name header ("Claude Haiku 4.5") is the
    // assistant element's FIRST CHILD and can only be reached structurally — and the
    // user message's first child is the message itself. A shared strip would have
    // deleted every user turn while looking like it was tidying a header.
    // No conversation id exists at all — the URL stays / for every chat — so the
    // extractor's content-hash fallback supplies it, keyed on title + first user turn.
    save: { user: '[data-testid="user-message"]',
            assistant: '[data-testid="user-message"] ~ *',
            stripAssistant: [':scope > *:first-child'],
            urlPattern: ['https://duck.ai/*', 'https://*.duckduckgo.com/*'] } },
  { key: 'notebooklm', label: 'NotebookLM', host: /(^|\.)notebook(lm)?\.google\.com$/, mechanism: 'composer', capture: 'notebooklm',
    // VERIFIED 2026-08-01 against a real 8-turn notebook chat.
    // The role classes are DIRECTIONAL and read the opposite way to most sites:
    //   .from-user-container = FROM the user   → the user's turn
    //   .to-user-container   = TO the user     → the assistant's turn
    // Read as "the user's container" both look like the user. They are not.
    // Three things are stripped, all of which were landing in the stored text:
    //   chat-actions     the per-message toolbar
    //   .citation-marker inline source numbers, which render as bare digits mid
    //                    sentence ("...observability 2 3 .")
    //   button           Material icon BUTTONS whose ligature names are their text,
    //                    so an unstripped answer ended "keep_pin Save to note
    //                    copy_all thumb_up thumb_down". Every button inside a
    //                    NotebookLM message is chrome, never content.
    save: { user: 'chat-message:has(.from-user-container)',
            assistant: 'chat-message:has(.to-user-container)',
            strip: ['chat-actions', '.citation-marker', 'button'],
            // TWO patterns, not 'notebook*.google.com'. A Chrome match pattern allows
            // '*' as the WHOLE host or as a leading '*.' subdomain wildcard — never
            // mid-host. The invalid form does not fail at load; chrome.tabs.query
            // throws at Save time, which is how it reached a user. sites.js already
            // matches both hosts in its `host` regex, so both belong here too.
            urlPattern: ['https://notebook.google.com/*', 'https://notebooklm.google.com/*'],
            uuid: '/notebook/([0-9a-f-]{8,})' } },
  { key: 'huggingface', label: 'HuggingChat', host: /(^|\.)huggingface\.co$/, mechanism: 'composer', capture: 'huggingchat',
    // VERIFIED 2026-08-01 against a real 6-turn chat.
    // The CONTAINER is load-bearing here, not tidiness. HuggingChat marks turns with
    // Tailwind's `group`, and its page header uses `group` too — unscoped, the query
    // returned 8 nodes including the page title and the account badge, so the user's
    // OWN USERNAME ("cpriest73 Get PRO") would have been stored as something they
    // said. Scoped to the message list it returns exactly the 6 real turns.
    // Role is structural: assistant turns contain .prose, user turns do not. The only
    // other difference is w-full vs w-fit, which is not something to key a role on.
    // Stripped: the collapsible reasoning header, buttons, and .absolute — the model
    // attribution badge ("agentic with Kimi-K2.6 via together") is positioned
    // absolutely under each reply and otherwise lands at the end of every answer.
    save: { container: 'div.h-max.flex-col.gap-8',
            user: 'div.group:not(:has(.prose))', assistant: 'div.group:has(.prose)',
            strip: ['[class*="group/header"]', 'button', '.absolute'],
            urlPattern: 'https://huggingface.co/chat/*', uuid: '/conversation/([0-9a-f]{8,})' } },
  { key: 'character', label: 'Character.AI', host: /(^|\.)character\.ai$|(^|\.)old\.character\.ai$/, mechanism: 'composer', capture: 'characterai',
    // VERIFIED 2026-08-01 against a real chat: 4 message nodes, 3 captured — see below.
    // Both roles share ONE test id (completed-message), so role comes from layout
    // direction: the user's turns sit inside a .flex-row-reverse row.
    // The swiper exclusion is the point of this entry. Character.AI keeps ALTERNATE
    // regenerated replies in the DOM as carousel slides — only one is shown, the rest
    // are real messages the model produced but the user did not keep. Captured, they
    // become extra assistant turns in the transcript: replies that were never part of
    // the conversation, indistinguishable afterwards from ones that were. No other
    // site in the twenty does this. Hidden slides are excluded explicitly rather than
    // relying on them happening to be empty, which is only true until one is rendered.
    save: { user: '.flex-row-reverse [data-testid="completed-message"]',
            assistant: '[data-testid="completed-message"]:not(.flex-row-reverse *):not(.swiper-slide:not(.swiper-slide-visible) *)',
            urlPattern: 'https://*.character.ai/*', uuid: '/chat/([0-9a-zA-Z_-]{8,})' } },
];
