// One object, one noun. One taxonomy, one translation.
//
// COHERENCE Phase 2 — the language pass. F7 and F9 were fixed by editing the
// surfaces that were wrong at the time, and the plan says why that is not
// enough:
//
//   "The pass produces an artifact, not a decision... Without a home,
//    vocabulary decisions revert within a month — drift is just Rule 8
//    violated slowly."
//
// It reverted in under two weeks. `memory::provenance::scope_label()` landed in
// core with a total mapping and a human-word fallback; ZERO console JS files
// ever called it, and 21 sites went on rendering the raw scope. One of them
// (projects.js) hand-rolled `.replace(/^workbench:/,'')` — the shared rule
// worked around locally, which is exactly how a rule dies. That is F41.
//
// This is the home.
//
// THE SOURCE OF TRUTH IS RUST: src/memory/provenance.rs. This file mirrors it,
// and `test/vocabulary-parity.test.mjs` runs both over the live scope
// vocabulary and fails if they ever disagree — so the mirror cannot rot
// quietly, which is the only failure mode that matters for a file like this.
//
// Loaded BOTH ways, exactly like gateway-errors.js and sites.js:
//   import './vocabulary.js'                    (module service worker)
//   <script src="vocabulary.js">                (side panel, console)

globalThis.VodouVocabulary = {
  /**
   * ONE NOUN PER OBJECT (F9). Eight nouns were in use for roughly four things,
   * and a reader who meets two words for one object reasonably concludes there
   * are two objects, goes looking for the difference, and finds none.
   *
   * DELIBERATE EXCEPTION — "notes and memories" survives in the page-memory
   * consent copy. A note and a memory are the same object, so the rule says
   * collapse it; but that is PERMISSION copy, and narrowing the words narrows
   * the apparent scope of the disclosure. A privacy ask should err toward
   * describing more than it does. Consistency loses to disclosure there, on
   * purpose. See extension/test/vocabulary.test.mjs, which asserts the
   * exception still exists so it stays a decision rather than an oversight.
   */
  NOUNS: {
    chat: 'the thing you had with an AI and Vodou saved',
    memory: 'anything Vodou knows, however it got there',
    document: 'a file in your Library',
    briefing: 'what a scheduled skill produced',
  },

  /** Retired synonyms → the word to use instead. Enforced by vocabulary.test.mjs. */
  RETIRED: {
    conversation: 'chat',
    conversations: 'chats',
    thread: 'chat',
    threads: 'chats',
    transcript: 'chat',
    docs: 'documents',
  },

  /**
   * Product names spelled the way their owners spell them. Anything absent is
   * title-cased on `-`/`_`, which is right far more often than it is wrong and
   * never leaks a schema word.
   */
  SOURCES: {
    chatgpt: 'ChatGPT',
    claude: 'Claude',
    'claude-code': 'Claude Code',
    claudecode: 'Claude Code',
    'claude-cowork': 'Claude Cowork',
    aistudio: 'AI Studio',
    openrouter: 'OpenRouter',
    notebooklm: 'NotebookLM',
    huggingchat: 'HuggingChat',
    characterai: 'Character.AI',
    duckai: 'DuckDuckGo AI',
    youcom: 'You.com',
    metaai: 'Meta AI',
    lechat: 'Le Chat',
    t3chat: 'T3 Chat',
    deepseek: 'DeepSeek',
    openclaw: 'OpenClaw',
    obsidian: 'Obsidian',
  },

  /** `claude-code` → `Claude Code`. Mirrors provenance.rs::pretty_source. */
  prettySource(slug) {
    const s = String(slug || '').toLowerCase();
    if (this.SOURCES[s]) return this.SOURCES[s];
    return s
      .split(/[-_]/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  },

  /**
   * Where a memory came from, in words the person reading it would use.
   *
   * Mirrors provenance.rs::scope_label. THE FALLBACK IS NEVER THE RAW SCOPE:
   * an unrecognised scope is still a memory, and "memory" is a true thing to
   * call it. Leaking a schema word is not.
   *
   * `web` is the one to understand. It is the largest label in the corpus
   * (22,674 chunks) and it never meant "from the web" — it is simply the
   * default when a chunk carries no inline `scope:` token, and those live in
   * the daily logs. So the commonest provenance word in the product was not
   * jargon, it was false.
   */
  scopeLabel(scope) {
    const raw = String(scope == null ? '' : scope).trim();
    if (!raw) return 'memory';
    const p = raw.split(':');
    const at = (i) => p[i] || '';

    switch (at(0)) {
      case 'capture':
        if (at(1) === 'web' && p.length > 2) return this.prettySource(at(2));
        if (at(1) === 'ide' && p.length > 2) return this.prettySource(at(2));
        if (at(1) === 'manual') return 'saved by you';
        return 'captured';
      case 'import':
        return p.length > 1 ? `imported from ${this.prettySource(at(1))}` : 'memory';
      case 'skill':
        return 'a skill run';
      case 'doc':
        return 'a document';
      case 'gateway':
        return 'Vodou chat';
      case 'pinned':
        return 'pinned';
      case 'workbench':
        if (at(1) === 'channel' && p.length > 2) return this.prettySource(at(2));
        // Phrased as speech, not a key-value pair: a person says "the X skill",
        // never "skill: X".
        if (at(1) === 'skill-console' && p.length > 2) return `the ${this.prettySource(at(2))} skill`;
        if (at(1) === 'integration' && p.length > 2) return this.prettySource(at(2));
        return 'your workspace';
      case 'channel':
        return p.length > 1 ? this.prettySource(at(1)) : 'memory';
      case 'web':
        // Exactly `web`, not a `web:*` prefix — the no-token default bucket.
        return p.length === 1 ? 'your notes' : 'memory';
      case 'tenant':
        return 'your account';
      default:
        return 'memory';
    }
  },
};
