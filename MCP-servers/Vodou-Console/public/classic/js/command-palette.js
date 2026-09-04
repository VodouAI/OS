/**
 * Command Palette (Cmd+K / Ctrl+K)
 * Spotlight-style fuzzy search across intents, skills, and recent commands
 * Reuses autocomplete suggest data + localStorage for recent commands
 */

const CommandPalette = {
  _overlay: null,
  _input: null,
  _results: null,
  _visible: false,
  _activeIdx: -1,
  _items: [],
  _recents: [],
  MAX_RECENTS: 15,

  init() {
    this._overlay = document.getElementById('cmd-palette-overlay');
    this._input = document.getElementById('cmd-palette-input');
    this._results = document.getElementById('cmd-palette-results');
    if (!this._overlay || !this._input) return;

    // Load recent commands from localStorage
    try {
      this._recents = JSON.parse(localStorage.getItem('vodou-recent-commands') || '[]');
    } catch { this._recents = []; }

    // Input handler
    this._input.addEventListener('input', () => this._onInput());

    // Keyboard
    this._input.addEventListener('keydown', (e) => this._onKeydown(e));

    // Close on overlay click
    this._overlay.addEventListener('click', (e) => {
      if (e.target === this._overlay) this.close();
    });

    // Global shortcut: Cmd+K / Ctrl+K
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        this._visible ? this.close() : this.open();
      }
    });
  },

  open() {
    this._visible = true;
    this._overlay.classList.add('visible');
    this._input.value = '';
    this._activeIdx = -1;
    this._showDefault();
    this._input.focus();
  },

  close() {
    this._visible = false;
    this._overlay.classList.remove('visible');
    this._input.value = '';
    this._activeIdx = -1;
  },

  /** Record a command to recents */
  recordRecent(cmd) {
    // Remove if already exists, then add to front
    this._recents = this._recents.filter(r => r !== cmd);
    this._recents.unshift(cmd);
    if (this._recents.length > this.MAX_RECENTS) this._recents.pop();
    localStorage.setItem('vodou-recent-commands', JSON.stringify(this._recents));
  },

  /** Show default view: recent commands */
  _showDefault() {
    this._items = [];

    // Recent commands
    if (this._recents.length > 0) {
      for (const cmd of this._recents.slice(0, 8)) {
        this._items.push({
          type: 'recent',
          label: cmd,
          target: '',
          icon: '\u23F2',  // timer icon
        });
      }
    }

    this._render();
  },

  async _onInput() {
    const query = this._input.value.trim().toLowerCase();
    if (!query) {
      this._activeIdx = -1;
      this._showDefault();
      return;
    }

    // Get suggest data — fetch fresh if autocomplete cache is missing servers
    let data = null;
    if (typeof ChatAutocomplete !== 'undefined') {
      data = await ChatAutocomplete._ensureData();
    }
    if (!data || !data.servers) {
      // Cache doesn't have servers — fetch fresh
      try {
        const res = await fetch('/api/intents/suggest');
        if (res.ok) {
          data = await res.json();
          // Update autocomplete cache too
          if (typeof ChatAutocomplete !== 'undefined') {
            ChatAutocomplete._cache = data;
            ChatAutocomplete._dirty = false;
          }
        }
      } catch {}
    }

    this._items = [];

    // Search recent commands
    const recentMatches = this._recents
      .filter(r => r.toLowerCase().includes(query))
      .slice(0, 3)
      .map(r => ({ type: 'recent', label: r, target: '', icon: '\u23F2' }));

    // Search skills
    const skillMatches = [];
    if (data?.skills) {
      for (const s of data.skills) {
        const name = s.name.toLowerCase();
        const desc = (s.description || '').toLowerCase();
        const score = this._score(query, name, desc);
        if (score > 0) {
          skillMatches.push({
            type: 'skill',
            label: s.name,
            target: s.description || '',
            icon: '\uD83C\uDF93', // graduation cap
            score,
          });
        }
      }
      skillMatches.sort((a, b) => b.score - a.score);
    }

    // Search intents
    const intentMatches = [];
    if (data?.intents) {
      for (const i of data.intents) {
        const kw = i.keyword.toLowerCase();
        const tool = (i.tool_name || '').toLowerCase();
        const server = (i.server_name || '').toLowerCase();
        const score = Math.max(
          this._score(query, kw, ''),
          this._score(query, tool, '') * 0.7,
          this._score(query, server, '') * 0.5
        );
        if (score > 0) {
          intentMatches.push({
            type: 'intent',
            label: i.keyword,
            target: `${i.server_name}: ${i.tool_name || ''}`,
            icon: '\u26A1', // lightning
            score,
          });
        }
      }
      intentMatches.sort((a, b) => b.score - a.score);
    }

    // Search servers
    const serverMatches = [];
    if (data?.servers) {
      for (const s of data.servers) {
        const name = s.name.toLowerCase();
        const tools = (s.tool_names || '').toLowerCase();
        const score = Math.max(
          this._score(query, name, ''),
          this._score(query, tools, '') * 0.6
        );
        if (score > 0) {
          const toolInfo = s.tool_count > 0 ? s.tool_count + ' tools' : 'no tools';
          const status = s.health_status === 'healthy' ? '\u2705' : '\u26A0\uFE0F';
          serverMatches.push({
            type: 'server',
            label: s.name,
            target: status + ' ' + toolInfo + (s.tool_names ? ' — ' + s.tool_names : ''),
            icon: '\uD83D\uDD0C', // plug
            score,
          });
        }
      }
      serverMatches.sort((a, b) => b.score - a.score);
    }

    // Combine with sections
    if (recentMatches.length > 0) this._items.push(...recentMatches);
    if (serverMatches.length > 0) this._items.push(...serverMatches.slice(0, 5));
    if (skillMatches.length > 0) this._items.push(...skillMatches.slice(0, 6));
    if (intentMatches.length > 0) this._items.push(...intentMatches.slice(0, 10));

    // Cap total
    this._items = this._items.slice(0, 15);
    this._activeIdx = this._items.length > 0 ? 0 : -1;
    this._render();
  },

  _score(query, primary, secondary) {
    if (primary === query) return 100;
    if (primary.startsWith(query)) return 80;
    if (primary.includes(query)) return 60;
    // Check hyphenated segments
    const segments = primary.split(/[-_\s]/);
    for (const seg of segments) {
      if (seg.startsWith(query)) return 45;
    }
    if (secondary && secondary.includes(query)) return 30;
    return 0;
  },

  _render() {
    this._results.innerHTML = '';

    if (this._items.length === 0) {
      this._results.innerHTML = '<div class="cmd-palette-empty">No results found</div>';
      return;
    }

    // Group by type with section headers
    let lastType = '';
    const sectionLabels = { recent: 'Recent', server: 'Servers', skill: 'Skills', intent: 'Intents' };

    for (let idx = 0; idx < this._items.length; idx++) {
      const item = this._items[idx];

      // Section header
      if (item.type !== lastType) {
        lastType = item.type;
        const section = document.createElement('div');
        section.className = 'cmd-palette-section';
        section.textContent = sectionLabels[item.type] || item.type;
        this._results.appendChild(section);
      }

      const el = document.createElement('div');
      el.className = 'cmd-palette-item' + (idx === this._activeIdx ? ' active' : '');

      const icon = document.createElement('span');
      icon.className = 'cp-icon';
      icon.textContent = item.icon || '';

      const label = document.createElement('span');
      label.className = 'cp-label';
      label.textContent = item.type === 'skill' ? '/' + item.label : item.label;

      el.appendChild(icon);
      el.appendChild(label);

      if (item.target) {
        const target = document.createElement('span');
        target.className = 'cp-target';
        target.textContent = item.target;
        el.appendChild(target);
      }

      const badge = document.createElement('span');
      badge.className = 'cp-badge ' + item.type;
      badge.textContent = item.type;
      el.appendChild(badge);

      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this._select(idx, false);
      });

      el.addEventListener('mouseenter', () => {
        this._activeIdx = idx;
        this._results.querySelectorAll('.cmd-palette-item').forEach((el, i) => {
          el.classList.toggle('active', i === idx);
        });
      });

      this._results.appendChild(el);
    }
  },

  _select(idx, fillOnly) {
    const item = this._items[idx];
    if (!item) return;

    const chatInput = document.getElementById('chat-input');
    if (!chatInput) return;

    // P19: Skills get /prefix
    const insertLabel = item.type === 'skill' ? '/' + item.label : item.label;

    if (fillOnly) {
      // Tab — fill input but don't send
      chatInput.value = insertLabel;
      chatInput.focus();
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 240) + 'px';
      this.close();
    } else if (item.type === 'server') {
      // Navigate to servers page with this server expanded
      this.close();
      window.location.hash = '#/servers/' + encodeURIComponent(item.label);
    } else if (item.type === 'tool') {
      // Show inline form for this tool
      this.close();
      this._showToolForm(item.server, item.label, {});
    } else {
      // Enter — fill and send
      this.recordRecent(insertLabel);
      this.close();
      if (typeof ChatView !== 'undefined') {
        ChatView.sendMessage(insertLabel);
      }
    }
  },

  _onKeydown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this._items.length > 0) {
        this._activeIdx = (this._activeIdx + 1) % this._items.length;
        this._render();
        this._scrollToActive();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (this._items.length > 0) {
        this._activeIdx = this._activeIdx <= 0 ? this._items.length - 1 : this._activeIdx - 1;
        this._render();
        this._scrollToActive();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this._activeIdx >= 0) {
        this._select(this._activeIdx, false);
      } else if (this._input.value.trim()) {
        // Send raw input as a message
        const text = this._input.value.trim();
        this.recordRecent(text);
        this.close();
        if (typeof ChatView !== 'undefined') ChatView.sendMessage(text);
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (this._activeIdx >= 0) {
        this._select(this._activeIdx, true);
      } else if (this._items.length > 0) {
        this._select(0, true);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    }
  },

  _scrollToActive() {
    const active = this._results.querySelector('.cmd-palette-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  },

  /** Show a tool form inline in the chat */
  async _showToolForm(server, tool, prefill) {
    if (typeof InlineForms === 'undefined' || typeof ChatView === 'undefined') return;

    const form = await InlineForms.showForTool(server, tool, prefill,
      // onSubmit
      async (params) => {
        const argsJson = JSON.stringify(params);
        const cmd = `./vodou-core call ${server} ${tool} '${argsJson}'`;
        ChatView.sendMessage(cmd);
      },
      // onCancel
      null
    );

    if (form) {
      // Add form as a message in chat
      const el = ChatView.createMsgEl('Form', 'tool-name', 'tool-av', 'T', '', '');
      el.content.appendChild(form);
      ChatView.messagesEl.appendChild(el.msg);
      ChatView.scrollToBottom();
      // Focus the first input
      const firstInput = form.querySelector('.tf-input, .tf-textarea, .tf-select');
      if (firstInput) firstInput.focus();
    } else {
      // No schema — just run it
      ChatView.sendMessage(`./vodou-core call ${server} ${tool} '{}'`);
    }
  },
};
