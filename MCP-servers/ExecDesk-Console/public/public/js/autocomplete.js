/**
 * Chat Autocomplete — suggests intents & skills as user types.
 *
 * Factory pattern: each composer gets its own instance via
 * `ChatAutocomplete.attach({ input, dropdown, toggleBtn })`. Cache,
 * toggle state, and `/api/intents/suggest` fetch are shared across
 * instances at module scope so the same data powers both main chat
 * and scoped workbenches.
 *
 * Backward-compat: `ChatAutocomplete.init()` is preserved — it looks
 * up the HTML-baked IDs `chat-input` / `autocomplete-dropdown` /
 * `ac-toggle` and calls `attach()`.
 *
 * Cache auto-invalidates on any POST/PUT/DELETE to /api/intents or
 * /api/skills. Enabled toggle persists in localStorage.
 */
const ChatAutocomplete = (() => {
  /* ---- Module-level shared state (one cache for all instances) ---- */
  let _cache = null;           // { intents, skills, servers }
  let _dirty = true;
  let _enabled = true;         // hydrated from localStorage on first attach
  let _enabledHydrated = false;
  const _serverTools = {};     // serverName → [tools]
  let _fetchIntercepted = false;
  const _instances = [];       // all attached instances (for enable/disable broadcast)

  function _hydrateEnabled() {
    if (_enabledHydrated) return;
    const saved = localStorage.getItem('vodou-autocomplete');
    _enabled = saved !== 'off';
    _enabledHydrated = true;
  }

  function _interceptFetch() {
    if (_fetchIntercepted) return;
    _fetchIntercepted = true;
    const original = window.fetch;
    window.fetch = function(url, opts) {
      const result = original.apply(this, arguments);
      if (typeof url === 'string' && (url.includes('/api/intents') || url.includes('/api/skills'))) {
        const method = (opts?.method || 'GET').toUpperCase();
        if (method !== 'GET') {
          result.then(() => { _dirty = true; }).catch(() => {});
        }
      }
      return result;
    };
  }

  async function _ensureData() {
    if (!_dirty && _cache) return _cache;
    try {
      const res = await fetch('/api/intents/suggest');
      if (res.ok) {
        _cache = await res.json();
        _dirty = false;
      }
    } catch { /* non-critical */ }
    return _cache;
  }

  function _scoreWord(word, target) {
    if (target === word) return 100;
    if (target.startsWith(word)) return 80;
    if (target.includes(word)) return 60;
    const segments = target.split(/[-_]/);
    for (const seg of segments) {
      if (seg.startsWith(word)) return 40;
    }
    return 0;
  }

  /**
   * Attach an autocomplete instance to an existing textarea + dropdown.
   *
   * @param {Object} opts
   * @param {HTMLTextAreaElement} opts.input
   * @param {HTMLElement} opts.dropdown
   * @param {HTMLElement} [opts.toggleBtn]
   * @returns {AutocompleteInstance}
   */
  function attach(opts) {
    if (!opts || !opts.input || !opts.dropdown) {
      return null;
    }
    _hydrateEnabled();
    _interceptFetch();

    const instance = {
      input: opts.input,
      dropdown: opts.dropdown,
      toggleBtn: opts.toggleBtn || null,
      _visible: false,
      _activeIdx: -1,
      _items: [],
      _cursorWord: null,
    };

    function _syncToggleUI() {
      if (!instance.toggleBtn) return;
      instance.toggleBtn.classList.toggle('ac-on', _enabled);
      instance.toggleBtn.title = _enabled
        ? 'Autocomplete ON — click to disable'
        : 'Autocomplete OFF — click to enable';
    }

    function _getWordAtCursor() {
      const pos = instance.input.selectionStart ?? instance.input.value.length;
      const textBefore = instance.input.value.substring(0, pos);
      const match = textBefore.match(/(\S+)$/);
      if (!match) return { word: '', start: pos, end: pos };
      const word = match[1];
      const start = pos - word.length;
      const textAfter = instance.input.value.substring(pos);
      const fwdMatch = textAfter.match(/^(\S+)/);
      const end = pos + (fwdMatch ? fwdMatch[1].length : 0);
      return { word: word.toLowerCase(), start, end };
    }

    function _getPhraseAtCursor() {
      const pos = instance.input.selectionStart ?? instance.input.value.length;
      const textBefore = instance.input.value.substring(0, pos).trimEnd();
      const words = textBefore.split(/\s+/);
      const phrases = [];
      for (let n = Math.min(4, words.length); n >= 1; n--) {
        const phrase = words.slice(-n).join(' ').toLowerCase();
        const start = pos - textBefore.length + textBefore.lastIndexOf(words.slice(-n).join(' '));
        phrases.push({ phrase, wordCount: n, start });
      }
      return phrases;
    }

    async function _onFormInput(afterForm) {
      let data = await _ensureData();
      if (!data || !data.servers) {
        try {
          const res = await fetch('/api/intents/suggest');
          if (res.ok) { _cache = await res.json(); _dirty = false; data = _cache; }
        } catch {}
      }
      if (!data || !data.servers) { _hide(); return; }

      const parts = afterForm.split(/\s+/).filter((p) => p);
      const hasTrailingSpace = afterForm.endsWith(' ');

      if (parts.length === 0 || (parts.length === 1 && !hasTrailingSpace)) {
        const query = (parts[0] || '').toLowerCase();
        instance._items = [];
        for (const s of data.servers) {
          const name = s.name.toLowerCase();
          const score = !query ? 50 : _scoreWord(query, name);
          if (score > 0 || !query) {
            instance._items.push({
              type: 'server', keyword: s.name,
              target: (s.tool_count || 0) + ' tools',
              score: score || 50,
              _formReplace: 'server',
            });
          }
        }
        instance._items = instance._items.sort((a, b) => b.score - a.score).slice(0, 15).reverse();
      } else {
        const serverName = parts[0];
        const toolQuery = (parts[1] || '').toLowerCase();

        if (!_serverTools[serverName]) {
          try {
            const res = await fetch('/api/intents/tools-by-server?server=' + encodeURIComponent(serverName));
            if (res.ok) _serverTools[serverName] = await res.json();
          } catch {}
        }

        const tools = _serverTools[serverName] || [];
        instance._items = [];
        for (const t of tools) {
          const name = t.name.toLowerCase();
          const desc = (t.description || '').toLowerCase();
          const score = !toolQuery ? 50 : Math.max(
            _scoreWord(toolQuery, name),
            _scoreWord(toolQuery, desc) * 0.5
          );
          if (score > 0 || !toolQuery) {
            instance._items.push({
              type: 'tool', keyword: t.name,
              target: t.description ? t.description.substring(0, 60) : '',
              score: score || 50,
              _formReplace: 'tool',
            });
          }
        }
        // Cap kept generous — Zoho ships ~184 tools, MS 365 ~50, others vary.
        // Dropdown is scrollable; users filter via typing. 250 covers any
        // realistic MCP server in the catalog today.
        instance._items = instance._items.sort((a, b) => b.score - a.score).slice(0, 250).reverse();
      }

      if (instance._items.length === 0) { _hide(); return; }
      instance._activeIdx = -1;
      instance._cursorWord = null;
      _render();
      _show();
    }

    async function _onSkillInput(query) {
      const data = await _ensureData();
      if (!data || !data.skills) { _hide(); return; }
      const q = query.toLowerCase();
      instance._items = [];
      for (const s of data.skills) {
        const name = s.name.toLowerCase();
        const desc = (s.description || '').toLowerCase();
        const score = !q ? 50 : Math.max(
          _scoreWord(q, name),
          _scoreWord(q, desc) * 0.5
        );
        if (score > 0 || !q) {
          instance._items.push({
            type: 'skill', keyword: s.name,
            target: s.description ? s.description.substring(0, 60) : '',
            score: score || 50,
            _skillReplace: true,
          });
        }
      }
      instance._items = instance._items.sort((a, b) => b.score - a.score).slice(0, 20).reverse();
      if (instance._items.length === 0) { _hide(); return; }
      instance._activeIdx = -1;
      instance._cursorWord = null;
      _render();
      _show();
    }

    async function _onInput() {
      if (!_enabled) return;
      const fullText = instance.input.value;

      const formMatch = fullText.match(/^\/server\s*(.*)/i);
      // Preserve trailing space — _onFormInput uses it to decide between
      // "still typing server name" (no trailing space → show server list)
      // and "moved on to tool name" (trailing space → show tool list).
      if (formMatch) { await _onFormInput(formMatch[1]); return; }

      const skillCmdMatch = fullText.match(/^\/skill\s*(.*)/i);
      if (skillCmdMatch) { await _onSkillInput(skillCmdMatch[1].trim()); return; }

      const { word, start, end } = _getWordAtCursor();
      instance._cursorWord = { start, end };

      if (!word || word.length < 1) { _hide(); return; }

      const data = await _ensureData();
      if (!data) { _hide(); return; }

      const phrases = _getPhraseAtCursor();
      const textBeforeCursor = instance.input.value.substring(0, instance.input.selectionStart ?? 0).trimStart();
      const skillSuggestionsAllowed = textBeforeCursor.length === 0 || /^\/[a-zA-Z0-9_-]*$/.test(textBeforeCursor);

      const intentMatches = [];
      for (const i of data.intents) {
        if (!skillSuggestionsAllowed && i.tool_name === 'vc_load_skill') continue;
        const kw = i.keyword.toLowerCase();
        let bestScore = 0;
        let bestPhrase = phrases[phrases.length - 1];
        for (const p of phrases) {
          const s = _scoreWord(p.phrase, kw);
          if (s > bestScore) { bestScore = s; bestPhrase = p; }
        }
        if (bestScore > 0) {
          intentMatches.push({
            type: 'intent', keyword: i.keyword,
            target: `${i.server_name}: ${i.tool_name || '(default)'}`,
            score: bestScore, _phraseStart: bestPhrase.start,
          });
        }
      }

      const skillMatches = [];
      if (skillSuggestionsAllowed) for (const s of data.skills) {
        const name = s.name.toLowerCase();
        const desc = (s.description || '').toLowerCase();
        let bestScore = 0;
        let bestPhrase = phrases[phrases.length - 1];
        for (const p of phrases) {
          const sc = Math.max(
            _scoreWord(p.phrase, name),
            _scoreWord(p.phrase, desc) * 0.5
          );
          if (sc > bestScore) { bestScore = sc; bestPhrase = p; }
        }
        if (bestScore > 0) {
          skillMatches.push({
            type: 'skill', keyword: s.name,
            target: s.description || '', score: bestScore,
            _phraseStart: bestPhrase.start,
          });
        }
      }

      const serverMatches = [];
      if (data?.servers) {
        for (const s of data.servers) {
          const name = s.name.toLowerCase();
          const tools = (s.tool_names || '').toLowerCase();
          const score = Math.max(
            _scoreWord(word, name),
            _scoreWord(word, tools) * 0.5
          );
          if (score > 0) {
            serverMatches.push({
              type: 'server',
              keyword: '/server ' + s.name,
              target: (s.tool_count || 0) + ' tools' + (s.tool_names ? ' — ' + s.tool_names : ''),
              score,
            });
          }
        }
      }

      instance._items = [...intentMatches, ...skillMatches, ...serverMatches]
        .sort((a, b) => b.score - a.score).slice(0, 10).reverse();

      if (instance._items.length === 0) { _hide(); return; }
      instance._activeIdx = -1;
      _render();
      _show();
    }

    function _render() {
      instance.dropdown.innerHTML = '';
      for (let idx = 0; idx < instance._items.length; idx++) {
        const item = instance._items[idx];
        const el = document.createElement('div');
        el.className = 'ac-item' + (idx === instance._activeIdx ? ' active' : '');

        const badge = document.createElement('span');
        badge.className = 'ac-badge ' + item.type;
        badge.textContent = item.type;

        const keyword = document.createElement('span');
        keyword.className = 'ac-keyword';
        keyword.textContent = item.type === 'skill' ? '/' + item.keyword : item.keyword;

        const arrow = document.createElement('span');
        arrow.className = 'ac-arrow';
        arrow.textContent = '\u2192';

        const target = document.createElement('span');
        target.className = 'ac-target';
        target.textContent = item.target;

        el.appendChild(badge);
        el.appendChild(keyword);
        el.appendChild(arrow);
        el.appendChild(target);

        el.addEventListener('mousedown', (e) => { e.preventDefault(); _select(idx); });

        instance.dropdown.appendChild(el);
      }
    }

    function _select(idx) {
      const item = instance._items[idx];
      if (!item) return;
      const input = instance.input;

      if (item._skillReplace) {
        const triggerPhrase = item.keyword.replace(/-/g, ' ');
        input.value = triggerPhrase;
        input.focus();
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 144) + 'px';
        _hide();
        if (typeof ChatView !== 'undefined' && ChatView.sendMessage) {
          ChatView.sendMessage(triggerPhrase);
          input.value = '';
          input.style.height = 'auto';
        }
        return;
      }

      if (item._formReplace === 'server') {
        input.value = '/server ' + item.keyword + ' ';
        input.focus();
        const pos = input.value.length;
        input.setSelectionRange(pos, pos);
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 144) + 'px';
        _onFormInput(item.keyword + ' ');
        return;
      }
      if (item._formReplace === 'tool') {
        const parts = input.value.match(/^\/server\s+(\S+)/i);
        const server = parts ? parts[1] : '';
        input.value = '/server ' + server + ' ' + item.keyword;
        input.focus();
        const pos = input.value.length;
        input.setSelectionRange(pos, pos);
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 144) + 'px';
        _hide();
        return;
      }

      if (item.type === 'server' && item.keyword.startsWith('/server ')) {
        input.value = item.keyword + ' ';
        input.focus();
        const pos = input.value.length;
        input.setSelectionRange(pos, pos);
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 144) + 'px';
        _hide();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }

      const phraseStart = item._phraseStart !== undefined ? item._phraseStart : (instance._cursorWord?.start ?? 0);
      const cursorEnd = instance._cursorWord?.end ?? input.value.length;
      const before = input.value.substring(0, phraseStart);
      const after = input.value.substring(cursorEnd);
      const insertion = item.type === 'skill' ? '/' + item.keyword : item.keyword;
      input.value = before + insertion + after;

      if (item.type === 'skill') {
        if (typeof ChatView !== 'undefined' && ChatView._addSkillPill) {
          ChatView._addSkillPill(item.keyword);
        }
      }

      const newPos = phraseStart + insertion.length;
      input.focus();
      input.setSelectionRange(newPos, newPos);
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 144) + 'px';
      _hide();
    }

    function _onKeydown(e) {
      if (!instance._visible) return;
      const key = e.key;

      if (key === 'ArrowUp' || key === 'Up') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (instance._activeIdx === -1) instance._activeIdx = instance._items.length - 1;
        else instance._activeIdx = Math.max(instance._activeIdx - 1, 0);
        _render();
        _scrollToActive();
      } else if (key === 'ArrowDown' || key === 'Down') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (instance._activeIdx === -1) instance._activeIdx = instance._items.length - 1;
        else if (instance._activeIdx < instance._items.length - 1) instance._activeIdx++;
        else instance._activeIdx = -1;
        _render();
        _scrollToActive();
      } else if (key === 'Tab') {
        if (instance._activeIdx >= 0) {
          e.preventDefault(); e.stopImmediatePropagation();
          _select(instance._activeIdx);
        } else if (instance._items.length > 0) {
          e.preventDefault(); e.stopImmediatePropagation();
          _select(instance._items.length - 1);
        }
      } else if (key === 'Escape' || key === 'Esc') {
        e.preventDefault(); e.stopImmediatePropagation();
        _hide();
      } else if (key === 'Enter' && !e.shiftKey && instance._activeIdx >= 0) {
        e.preventDefault(); e.stopImmediatePropagation();
        _select(instance._activeIdx);
      }
    }

    function _scrollToActive() {
      const active = instance.dropdown.querySelector('.ac-item.active');
      if (active) active.scrollIntoView({ block: 'nearest' });
    }

    function _show() {
      instance.dropdown.classList.add('visible');
      instance._visible = true;
      instance.dropdown.scrollTop = instance.dropdown.scrollHeight;
    }

    function _hide() {
      if (instance._visible) {
        instance.dropdown.classList.remove('visible');
        instance._visible = false;
        instance._activeIdx = -1;
      }
    }

    function _onDocClick(e) {
      if (!instance.dropdown.contains(e.target) && e.target !== instance.input) _hide();
    }

    function _onToggleClick() {
      _enabled = !_enabled;
      localStorage.setItem('vodou-autocomplete', _enabled ? 'on' : 'off');
      for (const inst of _instances) {
        if (inst.toggleBtn) {
          inst.toggleBtn.classList.toggle('ac-on', _enabled);
          inst.toggleBtn.title = _enabled
            ? 'Autocomplete ON — click to disable'
            : 'Autocomplete OFF — click to enable';
        }
      }
      if (!_enabled) _hide();
    }

    instance.input.addEventListener('input', _onInput);
    // capture phase so this fires BEFORE the composer's keydown handler
    instance.input.addEventListener('keydown', _onKeydown, true);
    document.addEventListener('click', _onDocClick);
    if (instance.toggleBtn) instance.toggleBtn.addEventListener('click', _onToggleClick);

    _syncToggleUI();

    // API on the instance — exposed for the composer/ChatView to query state
    instance.hide = _hide;
    instance.show = _show;
    instance.destroy = () => {
      instance.input.removeEventListener('input', _onInput);
      instance.input.removeEventListener('keydown', _onKeydown, true);
      document.removeEventListener('click', _onDocClick);
      if (instance.toggleBtn) instance.toggleBtn.removeEventListener('click', _onToggleClick);
      _hide();
      const i = _instances.indexOf(instance);
      if (i >= 0) _instances.splice(i, 1);
    };

    _instances.push(instance);
    return instance;
  }

  /**
   * Legacy init() — looks up the HTML-baked IDs and calls attach().
   * Kept so existing `ChatAutocomplete.init()` calls still work.
   */
  function init() {
    const input = document.getElementById('chat-input');
    const dropdown = document.getElementById('autocomplete-dropdown');
    const toggleBtn = document.getElementById('ac-toggle');
    if (!input || !dropdown) return null;
    // If already attached to this input, skip
    if (_instances.some((i) => i.input === input)) return _instances.find((i) => i.input === input);
    const instance = attach({ input, dropdown, toggleBtn });
    // Preserve legacy shape — `ChatAutocomplete._visible` / `._activeIdx` /
    // `._hide()` reads are used by `chat.js` (shouldSend guard). Mirror the
    // primary instance's state onto the module for back-compat.
    Object.defineProperty(ChatAutocomplete, '_visible', { get: () => instance ? instance._visible : false, configurable: true });
    Object.defineProperty(ChatAutocomplete, '_activeIdx', { get: () => instance ? instance._activeIdx : -1, configurable: true });
    ChatAutocomplete._hide = () => instance && instance.hide();
    return instance;
  }

  function invalidate() { _dirty = true; }

  return { attach, init, invalidate };
})();
