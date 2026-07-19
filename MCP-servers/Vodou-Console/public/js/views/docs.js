/**
 * Docs & API Explorer View
 *
 * Three tabs:
 *  1. Apps  — visual showcase of all connection types
 *  2. API Explorer  — browse endpoints + live Try-It (loads /api/docs/manifest, derived from OpenAPI)
 *  3. Docs          — browse + render the /docs markdown files
 */

const DocsView = {
  _activeTab: 'apps',
  _manifest: null,
  _docFiles: null,
  _activeGroup: null,
  _activeEndpoint: null,
  _activeDocPath: null,

  // Shared escaper — safe.js loads first, so VodouSafe is always present.
  _esc(s) {
    return window.VodouSafe.escapeHtml(s);
  },

  /* GitHub-style heading slug for in-page anchors (#some-heading). */
  _slug(t) {
    return String(t ?? '')
      .replace(/@@CODE\d+@@/g, '')       // drop any stashed-code placeholders
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')          // strip emoji, punctuation, markdown markers
      .trim()
      .replace(/\s/g, '-');              // GitHub maps each space to a hyphen (no collapse)
  },

  /* ─── Simple markdown → HTML renderer ─── */
  _md(text) {
    if (!text) return '';

    // Stash code (fenced + inline) as opaque placeholders BEFORE any other
    // pass, so heading/bold/paragraph rules never rewrite code contents —
    // e.g. a `# comment` line inside a ```bash block must not become an <h1>.
    // Placeholders are restored verbatim at the very end.
    const stash = [];
    const hold = (out) => `@@CODE${stash.push(out) - 1}@@`;

    // Slug from a heading's text, resolving stashed inline code back to its
    // text content first — so `### `version`` yields id "version" (matching
    // GitHub), not an empty slug.
    const slugify = (t) => DocsView._slug(
      String(t).replace(/@@CODE(\d+)@@/g, (_, i) => String(stash[+i]).replace(/<[^>]+>/g, '')));

    // Pre-pass: stash fenced code blocks with a line scanner. A single regex
    // mis-pairs fences when one has a trailing-whitespace info line or the
    // doc has an odd fence; toggling on any line that starts with ``` is
    // robust. An unterminated block is closed at EOF.
    const srcLines = text.split('\n');
    const pre = [];
    for (let i = 0; i < srcLines.length; i++) {
      const open = /^```(\w*)/.exec(srcLines[i]);
      if (!open) { pre.push(srcLines[i]); continue; }
      const lang = open[1] || '';
      const buf = [];
      i++;
      while (i < srcLines.length && !/^```/.test(srcLines[i])) { buf.push(srcLines[i]); i++; }
      pre.push(hold(`<pre class="docs-code-block"><code class="lang-${DocsView._esc(lang)}">${DocsView._esc(buf.join('\n').replace(/\s+$/, ''))}</code></pre>`));
    }

    let html = pre.join('\n')
      // Inline code — must stay on one line, so an unbalanced backtick can't
      // run away and swallow whole paragraphs/code blocks.
      .replace(/`([^`\n]+)`/g, (_, c) => hold(`<code class="docs-inline-code">${DocsView._esc(c)}</code>`))
      // H1-H4 — escape the heading text (raw-injection sink); `*` survives so the
      // bold/italic passes below still work inside headings. The id enables
      // in-page anchor links (e.g. [`search`](#search) -> ## search).
      .replace(/^#### (.+)$/gm, (_, t) => `<h4 id="${slugify(t)}" class="docs-h4">${DocsView._esc(t)}</h4>`)
      .replace(/^### (.+)$/gm, (_, t) => `<h3 id="${slugify(t)}" class="docs-h3">${DocsView._esc(t)}</h3>`)
      .replace(/^## (.+)$/gm, (_, t) => `<h2 id="${slugify(t)}" class="docs-h2">${DocsView._esc(t)}</h2>`)
      .replace(/^# (.+)$/gm, (_, t) => `<h1 id="${slugify(t)}" class="docs-h1">${DocsView._esc(t)}</h1>`)
      // Bold & italic
      .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // Links — reject non-http(s)/mailto/relative schemes (no javascript:/data:),
      // quote-escape the URL (attribute breakout), and escape the label.
      //  • in-page #anchors (not #/ SPA routes) scroll within the doc
      //  • links to another .md doc load that doc in the viewer (no new tab)
      //  • everything else opens in a new tab
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => {
        const u = String(url).trim();
        const isAnchor = /^#[^/]/.test(u);
        const isDocLink = !isAnchor && /\.md(#[\w-]*)?$/i.test(u) && !/^[a-z][a-z0-9+.-]*:/i.test(u);
        let href, attrs;
        if (isAnchor) {
          href = u; attrs = 'class="docs-link docs-anchor"';
        } else if (isDocLink) {
          href = u; attrs = 'class="docs-link docs-doclink"';
        } else {
          href = /^(https?:\/\/|mailto:|\/|\.{0,2}\/)/i.test(u) ? u : '#';
          attrs = 'target="_blank" rel="noopener" class="docs-link"';
        }
        return '<a href="' + href.replace(/"/g, '&quot;') + '" ' + attrs + '>' + DocsView._esc(label) + '</a>';
      })
      // Horizontal rules
      .replace(/^---+$/gm, '<hr class="docs-hr">')
      // Blockquotes
      .replace(/^> (.+)$/gm, '<blockquote class="docs-blockquote">$1</blockquote>')
      // Unordered lists
      .replace(/^[\*\-] (.+)$/gm, '<li>$1</li>')
      // Ordered lists
      .replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    // Wrap consecutive <li> in <ul>
    html = html.replace(/(<li>[\s\S]+?<\/li>)(\n(?!<li>)|$)/g, (match, items) => {
      return `<ul class="docs-ul">${items}</ul>\n`;
    });

    // Paragraphs + GFM tables. A line that is ONLY a block-level code
    // placeholder (a fenced block) is emitted as-is; inline placeholders ride
    // along inside paragraphs / table cells and are restored at the end.
    const lines = html.split('\n');
    const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
    const isSep = (l) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.includes('-');
    const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    const isBlockPlaceholder = (l) => {
      const m = /^@@CODE(\d+)@@$/.exec(l.trim());
      return m && /^<(pre|div|table)/.test(stash[+m[1]]);
    };
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) { out.push(''); continue; }

      // Fenced code block (stashed) — emit the placeholder untouched.
      if (isBlockPlaceholder(line)) { out.push(trimmed); continue; }

      // Table block: header row + separator row + zero-or-more body rows
      if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
        const header = cells(line);
        i += 2; // skip header + separator
        const body = [];
        while (i < lines.length && isRow(lines[i]) && lines[i].trim()) {
          body.push(cells(lines[i]));
          i++;
        }
        i--; // step back; outer loop will advance
        const thead = `<thead><tr>${header.map(c => `<th>${c}</th>`).join('')}</tr></thead>`;
        const tbody = `<tbody>${body.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>`;
        out.push(`<table class="docs-table">${thead}${tbody}</table>`);
        continue;
      }

      if (/^<(h[1-6]|pre|ul|ol|li|blockquote|hr|div|table)/.test(trimmed)) {
        out.push(trimmed);
      } else {
        out.push(`<p class="docs-p">${trimmed}</p>`);
      }
    }

    // Restore stashed code verbatim. Iterate in case a stashed span nests
    // another placeholder (indices strictly decrease, so this terminates).
    let result = out.join('\n');
    for (let pass = 0; pass < 5 && /@@CODE\d+@@/.test(result); pass++) {
      result = result.replace(/@@CODE(\d+)@@/g, (_, idx) => stash[+idx] ?? '');
    }
    return result;
  },
  /* ─── Main render entry point ─── */
  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h1>Docs &amp; API</h1>
        <p class="page-subtitle">Apps showcase, live API explorer, and documentation</p>
      </div>
      <div class="docs-tab-bar" role="tablist">
        <button class="docs-tab active" data-tab="apps" role="tab">🔌 Apps</button>
        <button class="docs-tab" data-tab="api" role="tab">⚡ API Explorer</button>
        <button class="docs-tab" data-tab="docs" role="tab">📚 Docs</button>
      </div>
      <div id="docs-panel-apps" class="docs-panel"></div>
      <div id="docs-panel-api" class="docs-panel" hidden></div>
      <div id="docs-panel-docs" class="docs-panel" hidden></div>`;

    container.querySelector('.docs-tab-bar').addEventListener('click', (e) => {
      const btn = e.target.closest('.docs-tab');
      if (!btn) return;
      const tab = btn.dataset.tab;
      this._switchTab(container, tab);
    });

    this._renderApps(container.querySelector('#docs-panel-apps'));

    // Preload data quietly
    this._loadManifest();
    this._loadDocFiles();

    // Deep link: #/docs?doc=<path> opens that doc directly in the Docs tab.
    // Used by the Vodou Bridge extension's "docs" link (→ vodou-bridge.md) and any
    // external link that wants to land on a specific doc.
    const q = location.hash.includes('?') ? location.hash.split('?')[1] : '';
    const docParam = new URLSearchParams(q).get('doc');
    if (docParam) {
      this._activeDocPath = docParam;
      this._switchTab(container, 'docs');
    }
  },

  _switchTab(container, tab) {
    this._activeTab = tab;
    container.querySelectorAll('.docs-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    container.querySelectorAll('.docs-panel').forEach(p => { p.hidden = true; });
    const panel = container.querySelector(`#docs-panel-${tab}`);
    if (panel) panel.hidden = false;

    if (tab === 'api') this._renderApiExplorer(panel);
    if (tab === 'docs') this._renderDocs(panel);
  },

  /* ══════════════════════════════════════════════════
     TAB 1: APPS
  ══════════════════════════════════════════════════ */
  _renderApps(panel) {
    panel.innerHTML = `
      <div class="apps-grid">

        <div class="integration-section">
          <h2 class="int-section-title">Messaging</h2>
          <p class="int-section-desc">Connect Vodou to your favorite messaging apps. Full two-way conversations with shared memory and tools.</p>
          <div class="int-cards">
            ${this._intCard('📱', 'Telegram', 'Bot via TELEGRAM_BOT_TOKEN. QR-free setup, instant activation.', [
              'Set TELEGRAM_BOT_TOKEN in Settings → Environment',
              'Go to Messaging → Connect Telegram',
              'Start chatting with your bot'
            ], '#/messaging')}
            ${this._intCard('💬', 'Slack', 'Socket Mode — works behind firewalls, no public URL needed.', [
              'Create a Slack App with Socket Mode enabled',
              'OAuth → Bot scopes: include users:read for teammate display names',
              'Set SLACK_BOT_TOKEN + SLACK_APP_TOKEN, then Messaging → Connect Slack'
            ], '#/messaging')}
            ${this._intCard('🎮', 'Discord', 'Bot token integration. Mention the bot or DM it.', [
              'Create a Discord bot application',
              'Set DISCORD_BOT_TOKEN',
              'Go to Messaging → Connect Discord'
            ], '#/messaging')}
            ${this._intCard('🟢', 'WhatsApp', 'QR-code pairing — no API key required.', [
              'Go to Messaging → Connect WhatsApp',
              'Scan the QR code with your phone',
              'Start chatting'
            ], '#/messaging')}
          </div>
        </div>

        <div class="integration-section">
          <h2 class="int-section-title">IDE & Code Editor</h2>
          <p class="int-section-desc">Use Vodou as your AI coding assistant — drop-in replacement for OpenAI in any IDE.</p>
          <div class="int-cards">
            ${this._intCard('🖱️', 'Cursor', 'Add as a custom OpenAI-compatible provider in Cursor settings.', [
              'Open Cursor → Preferences → Models',
              'Add custom model: http://localhost:8765/v1',
              'Model name: vodou'
            ], null, 'code', 'cursor')}
            ${this._intCard('🧩', 'Continue.dev', 'VS Code extension — full AI pair programmer.', [
              'Install Continue extension in VS Code',
              'Add to .continue/config.json',
              '"apiBase": "http://localhost:8765/v1"'
            ], null, 'code', 'continue')}
            ${this._intCard('🤖', 'aider', 'AI pair programming in your terminal.', [
              'pip install aider-chat',
              'aider --openai-api-base http://localhost:8765/v1 --model vodou'
            ], null, 'code', 'aider')}
            ${this._intCard('🔗', 'Any OpenAI SDK', 'Python, Node, or curl — anything that speaks OpenAI.', [
              'Set OPENAI_BASE_URL=http://localhost:8765/v1',
              'Set OPENAI_API_KEY=any-value',
              'Use model: vodou'
            ], null, 'code', 'sdk')}
          </div>
        </div>

        <div class="integration-section">
          <h2 class="int-section-title">Protocol & Platform</h2>
          <p class="int-section-desc">Deep app connections for builders and power users.</p>
          <div class="int-cards">
            ${this._intCard('⚙️', 'MCP Protocol', 'Vodou is an MCP host — any MCP-compatible client can connect.', [
              'Configure your MCP client to point to Vodou',
              'All tools exposed automatically',
              'See Settings → Servers for details'
            ], '#/capabilities')}
            ${this._intCard('🌐', 'Browser Extension', 'Interact with Vodou from any webpage.', [
              'Install the Vodou browser extension',
              'Highlights, summaries, and chat on any page',
              'See docs/browser-extension-installation.md'
            ], null, 'doc', 'browser-extension-installation')}
            ${this._intCard('🪝', 'Webhooks', 'External services POST into Vodou. Zapier, Make, anything.', [
              'Create a named webhook in Settings',
              'POST to /api/webhooks/receive/:name',
              'Vodou processes and responds'
            ], '#/settings')}
            ${this._intCard('🔮', 'REST API', 'Full HTTP API — 14 endpoint groups, 50+ endpoints.', [
              'Base URL: http://localhost:8765',
              'No auth by default (local-only)',
              'Click API Explorer tab for full docs + try-it'
            ], null, 'action', 'api')}
          </div>
        </div>

      </div>`;

    // Wire up "action" cards
    panel.querySelectorAll('[data-action="api"]').forEach(el => {
      el.addEventListener('click', () => {
        const container = panel.closest('.main-content') || panel.closest('#main-content') || document.getElementById('main-content');
        if (container) this._switchTab(container.closest('[id]') || container.parentElement, 'api');
        // Also try hash nav
        const tabBar = panel.closest('.page-content')?.querySelector('.docs-tab-bar') || document.querySelector('.docs-tab-bar');
        if (tabBar) {
          const btn = tabBar.querySelector('[data-tab="api"]');
          if (btn) btn.click();
        }
      });
    });

    panel.querySelectorAll('[data-action="doc"]').forEach(el => {
      el.addEventListener('click', () => {
        const docPath = el.dataset.target + '.md';
        this._activeDocPath = docPath;
        const tabBar = panel.closest('.page-content')?.querySelector('.docs-tab-bar') || document.querySelector('.docs-tab-bar');
        if (tabBar) {
          const btn = tabBar.querySelector('[data-tab="docs"]');
          if (btn) btn.click();
        }
      });
    });

    // Code snippet cards
    panel.querySelectorAll('[data-action="code"]').forEach(el => {
      el.addEventListener('click', () => {
        const target = el.dataset.target;
        this._showCodeSnippet(target);
      });
    });
  },

  _intCard(emoji, title, desc, steps, href, actionType, actionTarget) {
    const stepsHtml = steps.map(s => `<li>${this._esc(s)}</li>`).join('');
    let cta = '';
    if (href) {
      cta = `<a href="${href}" class="int-card-cta btn btn-secondary btn-sm">Open →</a>`;
    } else if (actionType === 'code') {
      cta = `<button class="int-card-cta btn btn-secondary btn-sm" data-action="code" data-target="${actionTarget}">Setup guide →</button>`;
    } else if (actionType === 'doc') {
      cta = `<button class="int-card-cta btn btn-secondary btn-sm" data-action="doc" data-target="${actionTarget}">Read docs →</button>`;
    } else if (actionType === 'action') {
      cta = `<button class="int-card-cta btn btn-secondary btn-sm" data-action="${actionTarget}">Explore →</button>`;
    }
    return `
      <div class="int-card">
        <div class="int-card-header">
          <span class="int-card-emoji">${emoji}</span>
          <span class="int-card-title">${this._esc(title)}</span>
        </div>
        <p class="int-card-desc">${this._esc(desc)}</p>
        <ol class="int-card-steps">${stepsHtml}</ol>
        ${cta}
      </div>`;
  },

  _codeSnippets: {
    cursor: {
      title: 'Cursor IDE Setup',
      code: `// In Cursor → Preferences → Models → Add Model
// Model name: vodou
// API Base: http://localhost:8765/v1
// API Key: any-value (not validated)`
    },
    continue: {
      title: 'Continue.dev Config (~/.continue/config.json)',
      code: `{
  "models": [
    {
      "title": "Vodou",
      "provider": "openai",
      "model": "vodou",
      "apiBase": "http://localhost:8765/v1",
      "apiKey": "any"
    }
  ]
}`
    },
    aider: {
      title: 'aider Terminal Setup',
      code: `# Install aider
pip install aider-chat

# Run with Vodou
aider --openai-api-base http://localhost:8765/v1 \\
      --openai-api-key any-value \\
      --model vodou`
    },
    sdk: {
      title: 'Python / Node SDK',
      code: `# Python
import openai
client = openai.OpenAI(
    base_url="http://localhost:8765/v1",
    api_key="any-value"
)
response = client.chat.completions.create(
    model="vodou",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)

// Node.js
import OpenAI from 'openai';
const client = new OpenAI({
  baseURL: 'http://localhost:8765/v1',
  apiKey: 'any-value'
});
const r = await client.chat.completions.create({
  model: 'vodou',
  messages: [{ role: 'user', content: 'Hello!' }]
});
console.log(r.choices[0].message.content);`
    }
  },

  _showCodeSnippet(key) {
    const snippet = this._codeSnippets[key];
    if (!snippet) return;
    const existing = document.getElementById('docs-code-modal');
    if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.id = 'docs-code-modal';
    modal.className = 'docs-modal-overlay';
    modal.innerHTML = `
      <div class="docs-modal">
        <div class="docs-modal-header">
          <span>${this._esc(snippet.title)}</span>
          <button class="docs-modal-close" title="Close">&times;</button>
        </div>
        <pre class="docs-code-block docs-modal-code"><code>${this._esc(snippet.code)}</code></pre>
        <button class="btn btn-secondary btn-sm docs-modal-copy">Copy</button>
      </div>`;
    modal.querySelector('.docs-modal-close').addEventListener('click', () => modal.remove());
    modal.querySelector('.docs-modal-copy').addEventListener('click', (e) => {
      navigator.clipboard.writeText(snippet.code).then(() => {
        e.target.textContent = 'Copied!';
        setTimeout(() => { e.target.textContent = 'Copy'; }, 2000);
      });
    });
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
  },

  /* ══════════════════════════════════════════════════
     TAB 2: API EXPLORER
  ══════════════════════════════════════════════════ */
  async _loadManifest() {
    if (this._manifest) return this._manifest;
    try {
      const data = await API.get('/api/docs/manifest');
      this._manifest = data;
      return data;
    } catch {
      return null;
    }
  },

  async _renderApiExplorer(panel) {
    panel.innerHTML = '<div class="loading-state">Loading API manifest…</div>';
    const manifest = await this._loadManifest();
    if (!manifest) {
      panel.innerHTML = '<div class="empty-state">Could not load API manifest.</div>';
      return;
    }

    // Default to first group
    if (!this._activeGroup) this._activeGroup = manifest.groups[0]?.id;

    panel.innerHTML = `
      <div class="api-explorer">
        <div class="api-sidebar">
          <div class="api-sidebar-header">
            <span class="api-sidebar-title">${this._esc(manifest.title)}</span>
            <span class="api-count">${manifest.groups.reduce((n, g) => n + g.endpoints.length, 0)} endpoints</span>
          </div>
          <div class="api-group-list">
            ${manifest.groups.map(g => `
              <button class="api-group-btn ${g.id === this._activeGroup ? 'active' : ''}" data-group="${g.id}">
                <span class="api-group-icon">${g.icon}</span>
                <span class="api-group-label">${this._esc(g.label)}</span>
                <span class="api-group-count">${g.endpoints.length}</span>
              </button>`).join('')}
          </div>
        </div>
        <div class="api-main" id="api-main-panel"></div>
      </div>`;

    panel.querySelectorAll('.api-group-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this._activeGroup = btn.dataset.group;
        this._activeEndpoint = null;
        panel.querySelectorAll('.api-group-btn').forEach(b => b.classList.toggle('active', b.dataset.group === this._activeGroup));
        this._renderApiGroup(panel.querySelector('#api-main-panel'), manifest);
      });
    });

    this._renderApiGroup(panel.querySelector('#api-main-panel'), manifest);
  },

  _renderApiGroup(el, manifest) {
    const group = manifest.groups.find(g => g.id === this._activeGroup);
    if (!group) return;
    el.innerHTML = `
      <div class="api-group-header">
        <div>
          <h2 class="api-group-title">${group.icon} ${this._esc(group.label)}</h2>
          <p class="api-group-desc">${this._esc(group.description)}</p>
        </div>
      </div>
      <div class="api-endpoint-list">
        ${group.endpoints.map((ep, i) => this._endpointCard(ep, i)).join('')}
      </div>`;

    el.querySelectorAll('.api-ep-card').forEach((card, i) => {
      card.querySelector('.api-ep-header').addEventListener('click', () => {
        const isOpen = card.classList.contains('open');
        el.querySelectorAll('.api-ep-card').forEach(c => c.classList.remove('open'));
        if (!isOpen) {
          card.classList.add('open');
          this._activeEndpoint = i;
          this._bindTryIt(card, group.endpoints[i]);
        }
      });
    });
  },

  _endpointCard(ep, i) {
    const methodClass = {
      GET: 'method-get', POST: 'method-post', PUT: 'method-put',
      DELETE: 'method-delete', PATCH: 'method-patch'
    }[ep.method] || 'method-get';

    const bodyJson = ep.body ? JSON.stringify(ep.body, null, 2) : '';
    const responseJson = ep.response_example ? JSON.stringify(ep.response_example, null, 2) : '';

    return `
      <div class="api-ep-card" data-index="${i}">
        <div class="api-ep-header">
          <span class="api-method ${methodClass}">${ep.method}</span>
          <span class="api-ep-path">${this._esc(ep.path)}</span>
          <span class="api-ep-summary">${this._esc(ep.summary)}</span>
          <svg class="api-ep-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        <div class="api-ep-body">
          <p class="api-ep-desc">${this._esc(ep.description)}</p>
          ${ep.query ? `
            <div class="api-ep-section">
              <div class="api-ep-section-label">Query Parameters</div>
              <pre class="docs-code-block">${this._esc(JSON.stringify(ep.query, null, 2))}</pre>
            </div>` : ''}
          ${bodyJson && ep.method !== 'GET' ? `
            <div class="api-ep-section">
              <div class="api-ep-section-label">Request Body (JSON)</div>
              <div class="api-try-body-wrap">
                <textarea class="api-try-body" rows="6" spellcheck="false">${this._esc(bodyJson)}</textarea>
              </div>
            </div>` : ''}
          <div class="api-try-bar">
            <button class="btn btn-accent btn-sm api-try-btn">▶ Try It</button>
            <span class="api-try-url">${window.location.origin}${ep.path}</span>
          </div>
          <div class="api-try-result" hidden>
            <div class="api-try-result-header">
              <span class="api-try-status"></span>
              <span class="api-try-time"></span>
              <button class="api-try-copy btn btn-secondary btn-sm">Copy</button>
            </div>
            <pre class="docs-code-block api-try-output"></pre>
          </div>
          ${responseJson ? `
            <div class="api-ep-section">
              <div class="api-ep-section-label">Example Response</div>
              <pre class="docs-code-block">${this._esc(responseJson)}</pre>
            </div>` : ''}
        </div>
      </div>`;
  },

  _bindTryIt(card, ep) {
    const btn = card.querySelector('.api-try-btn');
    if (!btn || btn._bound) return;
    btn._bound = true;
    btn.addEventListener('click', async () => {
      const resultEl = card.querySelector('.api-try-result');
      const outputEl = card.querySelector('.api-try-output');
      const statusEl = card.querySelector('.api-try-status');
      const timeEl = card.querySelector('.api-try-time');
      const copyBtn = card.querySelector('.api-try-copy');

      btn.disabled = true;
      btn.textContent = '⏳ Running…';
      resultEl.hidden = false;
      outputEl.textContent = 'Sending request…';
      statusEl.textContent = '';
      timeEl.textContent = '';

      // Build the actual path (strip :params)
      const path = ep.path.replace(/:(\w+)/g, (_, p) => {
        const val = prompt(`Enter value for :${p}`, 'example');
        return val || p;
      });

      const t0 = Date.now();
      try {
        let res;
        const opts = {
          method: ep.method,
          headers: { 'Content-Type': 'application/json' }
        };

        // Add query params if GET with query
        let url = path;
        if (ep.query && ep.method === 'GET') {
          const params = new URLSearchParams(ep.query);
          url = `${path}?${params}`;
        }

        // Add body
        if (ep.method !== 'GET') {
          const bodyTextarea = card.querySelector('.api-try-body');
          if (bodyTextarea) {
            try { opts.body = bodyTextarea.value; } catch { opts.body = '{}'; }
          }
        }

        res = await fetch(url, opts);
        const ms = Date.now() - t0;
        let text;
        try { text = await res.json(); text = JSON.stringify(text, null, 2); }
        catch { text = await res.text(); }

        statusEl.textContent = `${res.status} ${res.statusText}`;
        statusEl.className = 'api-try-status ' + (res.ok ? 'status-ok' : 'status-err');
        timeEl.textContent = `${ms}ms`;
        outputEl.textContent = text;

        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(text).then(() => {
            copyBtn.textContent = 'Copied!';
            setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
          });
        });
      } catch (err) {
        statusEl.textContent = 'Error';
        statusEl.className = 'api-try-status status-err';
        outputEl.textContent = err.message;
      } finally {
        btn.disabled = false;
        btn.textContent = '▶ Try It';
      }
    });
  },

  /* ══════════════════════════════════════════════════
     TAB 3: DOCS BROWSER
  ══════════════════════════════════════════════════ */
  async _loadDocFiles() {
    if (this._docFiles) return this._docFiles;
    try {
      const data = await API.get('/api/docs/files');
      this._docFiles = data.files;
      return data.files;
    } catch {
      return [];
    }
  },

  async _renderDocs(panel) {
    panel.innerHTML = '<div class="loading-state">Loading documentation…</div>';
    const files = await this._loadDocFiles();
    if (!files || files.length === 0) {
      panel.innerHTML = '<div class="empty-state">No documentation files found.</div>';
      return;
    }

    // Group files by category
    const categories = {};
    for (const f of files) {
      const cat = f.category === 'root' ? 'General' : f.category.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push(f);
    }

    // Set default doc if navigated from Apps docs context
    if (!this._activeDocPath && files.length > 0) {
      this._activeDocPath = files.find(f => f.path === 'README.md')?.path || files[0].path;
    }

    panel.innerHTML = `
      <div class="docs-layout">
        <div class="docs-nav">
          <div class="docs-nav-search-wrap">
            <input type="text" class="docs-nav-search" placeholder="Search docs…" autocomplete="off">
          </div>
          <div class="docs-nav-tree" id="docs-nav-tree">
            ${Object.entries(categories).map(([cat, catFiles]) => `
              <div class="docs-nav-section">
                <div class="docs-nav-section-label">${this._esc(cat)}</div>
                ${catFiles.map(f => `
                  <button class="docs-nav-item ${f.path === this._activeDocPath ? 'active' : ''}" data-path="${this._esc(f.path)}">
                    ${this._esc(f.name)}
                  </button>`).join('')}
              </div>`).join('')}
            <div class="docs-nav-empty is-hidden">No docs match your search.</div>
          </div>
        </div>
        <div class="docs-content" id="docs-content">
          <div class="loading-state">Loading…</div>
        </div>
      </div>`;

    panel.querySelector('.docs-nav-search').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      let anyMatch = false;
      panel.querySelectorAll('.docs-nav-item').forEach(btn => {
        const match = btn.textContent.toLowerCase().includes(q) || btn.dataset.path.toLowerCase().includes(q);
        if (match) anyMatch = true;
        btn.classList.toggle('is-hidden', !match);
      });
      panel.querySelectorAll('.docs-nav-section').forEach(sec => {
        const anyVisible = Array.from(sec.querySelectorAll('.docs-nav-item')).some(b => !b.classList.contains('is-hidden'));
        sec.classList.toggle('is-hidden', !anyVisible);
      });
      // Show an explicit "no matches" hint instead of a blank sidebar.
      const emptyHint = panel.querySelector('.docs-nav-empty');
      if (emptyHint) emptyHint.classList.toggle('is-hidden', anyMatch || q === '');
    });

    panel.querySelectorAll('.docs-nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.docs-nav-item').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._activeDocPath = btn.dataset.path;
        this._loadAndRenderDoc(panel.querySelector('#docs-content'), btn.dataset.path);
      });
    });

    if (this._activeDocPath) {
      this._loadAndRenderDoc(panel.querySelector('#docs-content'), this._activeDocPath);
    }
  },

  // Resolve a relative doc link (e.g. "commands/validate.md") against the
  // directory of the doc it appears in, collapsing "." and "..".
  _resolveDocPath(fromFile, rel) {
    if (rel.startsWith('/')) return rel.replace(/^\/+/, '');
    const parts = fromFile.includes('/') ? fromFile.replace(/\/[^/]*$/, '').split('/') : [];
    for (const seg of rel.split('/')) {
      if (seg === '' || seg === '.') continue;
      else if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return parts.join('/');
  },

  async _loadAndRenderDoc(el, filePath) {
    el.innerHTML = '<div class="loading-state">Loading…</div>';
    try {
      const data = await API.get(`/api/docs/file?path=${encodeURIComponent(filePath)}`);
      const html = this._md(data.content);
      el.innerHTML = `
        <div class="docs-article">
          <div class="docs-breadcrumb">${this._esc(filePath)}</div>
          <div class="docs-article-body">${html}</div>
        </div>`;

      const scrollToId = (id) => {
        if (!id) return;
        const target = el.querySelector(`[id="${CSS.escape(id)}"]`);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };

      // In-page anchor links (#heading) scroll within the doc instead of
      // touching location.hash (which would trip the SPA router). Always
      // preventDefault so dead anchors don't navigate away.
      el.querySelectorAll('a.docs-anchor').forEach(a => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          scrollToId(decodeURIComponent((a.getAttribute('href') || '').slice(1)));
        });
      });

      // Cross-doc links (…/foo.md[#sec]) load the target doc in the viewer.
      el.querySelectorAll('a.docs-doclink').forEach(a => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const raw = a.getAttribute('href') || '';
          const hashAt = raw.indexOf('#');
          const relPath = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
          const frag = hashAt >= 0 ? decodeURIComponent(raw.slice(hashAt + 1)) : '';
          const target = this._resolveDocPath(filePath, relPath);
          this._openDoc(target, frag);
        });
      });

      // Honor a pending fragment from a cross-doc link (…/foo.md#section).
      if (this._pendingAnchor) {
        const frag = this._pendingAnchor;
        this._pendingAnchor = null;
        // Let layout settle before scrolling.
        requestAnimationFrame(() => scrollToId(frag));
      }
    } catch (err) {
      el.innerHTML = `<div class="empty-state">Could not load: ${this._esc(filePath)}</div>`;
    }
  },

  // Switch the viewer to another doc (updating the nav highlight) and
  // optionally scroll to a fragment once it loads.
  _openDoc(path, fragment) {
    this._pendingAnchor = fragment || null;
    const navBtns = document.querySelectorAll('.docs-nav-item');
    let matched = null;
    navBtns.forEach(b => {
      const isMatch = b.dataset.path === path;
      b.classList.toggle('active', isMatch);
      if (isMatch) matched = b;
    });
    this._activeDocPath = path;
    const content = document.querySelector('#docs-content');
    if (content) {
      this._loadAndRenderDoc(content, path);
      if (matched) matched.scrollIntoView({ block: 'nearest' });
    }
  }
};
