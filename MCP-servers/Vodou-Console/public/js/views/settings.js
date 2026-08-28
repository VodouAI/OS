/**
 * LLM Settings View — provider selection, credential management, connection testing
 *
 * Model inputs use <input> + <datalist> (editable combo box) so users can always
 * type a new model name even if the suggestions list is stale.
 */

const SettingsView = {
  _data: null,
  _envData: null,
  _envInitial: null,
  _envAutosaveTimer: null,
  _envAutosaveClearTimer: null,
  _envSaving: false,

  // Shared escaper — safe.js loads first, so VodouSafe is always present.
  // (Old local copy didn't escape '>'.)
  _esc(s) {
    return window.VodouSafe.escapeHtml(s);
  },

  _envRestartStripHtml() {
    return `<div class="env-restart-strip">
      <div class="env-restart-copy">
        <strong>Apply .env &amp; service changes</strong>
        <p class="settings-note settings-note-tight">Stops the web gateway (drops pooled Claude CLI sessions), the Vodou daemon, and the worker — then runs <code>start-vodou-services.sh</code>. Use after changing secrets or flags that need a clean process tree.</p>
      </div>
      <button type="button" class="btn btn-secondary env-full-restart-btn">Restart gateway, worker &amp; daemon</button>
    </div>`;
  },

  _bindEnvRestartButtons(panel) {
    panel.querySelectorAll('.env-full-restart-btn').forEach((btn) => {
      btn.addEventListener('click', () => SettingsView._fullRestartStack());
    });
  },

  async _fullRestartStack() {
    if (!confirm('Restart gateway, Vodou daemon, and worker? This page will disconnect. Wait about 30 seconds, then refresh.')) return;
    try {
      const r = await API.post('/api/system/restart-stack', {});
      alert(r.message || 'Restart scheduled.');
    } catch (e) {
      alert(e.message || String(e));
    }
  },

  TABS: ['appearance', 'profile', 'model', 'env', 'memory', 'clients', 'about'],

  _activeTab() {
    const q = location.hash.includes('?') ? location.hash.split('?')[1] : '';
    const tab = new URLSearchParams(q).get('tab') || 'appearance';
    return this.TABS.includes(tab) ? tab : 'appearance';
  },

  // Deep link from the Vodou Bridge panel: #/settings?tab=memory&section=bridge
  // scrolls to the Browser bridge card (pair code lives there). The memory panel
  // renders async, so this runs after _loadMemoryPanel AND on route changes —
  // the hash router cannot use a plain #anchor, it already owns the hash.
  _scrollToSectionIfAsked() {
    const q = location.hash.includes('?') ? location.hash.split('?')[1] : '';
    if (new URLSearchParams(q).get('section') !== 'bridge') return;
    if (this._activeTab() !== 'memory') return;
    const el = document.getElementById('mem-bridge-section');
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.style.transition = 'box-shadow .3s';
    el.style.boxShadow = '0 0 0 2px var(--accent, #2563eb)';
    setTimeout(() => { el.style.boxShadow = ''; }, 2200);
  },

  _activateTab(tab) {
    const root = document.getElementById('settings-root');
    if (!root) return;
    const bar = root.querySelector('.settings-tab-bar');
    if (bar) {
      bar.querySelectorAll('.settings-tab').forEach(b => {
        const on = b.dataset.tab === tab;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
    this.TABS.forEach(t => {
      const p = document.getElementById('settings-panel-' + t);
      if (p) p.hidden = t !== tab;
    });
  },

  async render(container) {
    const tab = this._activeTab();
    container.innerHTML = '<div class="page-header"><h1>Settings</h1><p class="page-subtitle">Appearance, profile, LLM/Model, environment, attached clients, and about</p></div><div id="settings-root" class="loading-state">Loading...</div>';

    try {
      this._data = await API.get('/api/settings');
      const root = document.getElementById('settings-root');
      root.className = '';
      const mk = (id, label) => {
        const on = id === tab;
        return `<button type="button" class="settings-tab${on ? ' active' : ''}" data-tab="${id}" role="tab" aria-selected="${on ? 'true' : 'false'}">${label}</button>`;
      };
      root.innerHTML = `
        <div class="settings-tab-bar" role="tablist">
          ${mk('appearance', 'Appearance')}
          ${mk('profile', 'Profile')}
          ${mk('model', 'LLM/Model')}
          ${mk('env', 'Environment')}
          ${mk('memory', 'Memory')}
          ${mk('clients', 'Clients')}
          ${mk('about', 'About')}
        </div>
        <div id="settings-panel-appearance" class="settings-panel"${tab === 'appearance' ? '' : ' hidden'}></div>
        <div id="settings-panel-profile" class="settings-panel"${tab === 'profile' ? '' : ' hidden'}>
          <div class="loading-state">Loading profile…</div>
        </div>
        <div id="settings-panel-model" class="settings-panel"${tab === 'model' ? '' : ' hidden'}></div>
        <div id="settings-panel-env" class="settings-panel"${tab === 'env' ? '' : ' hidden'}>
          <div class="loading-state">Loading environment…</div>
        </div>
        <div id="settings-panel-memory" class="settings-panel"${tab === 'memory' ? '' : ' hidden'}>
          <div class="loading-state">Loading memory settings…</div>
        </div>
        <div id="settings-panel-clients" class="settings-panel"${tab === 'clients' ? '' : ' hidden'}>
          <div class="loading-state">Loading clients…</div>
        </div>
        <div id="settings-panel-about" class="settings-panel"${tab === 'about' ? '' : ' hidden'}>
          <div class="loading-state">Loading…</div>
        </div>`;
      this._bindTabs(root);
      this._renderAppearancePanel();
      void this._loadProfilePanel();
      this._renderModelPanel();
      void this._loadAboutPanel();
      void this._loadEnvPanel();
      void this._loadMemoryPanel();
      void this._loadClientsPanel();
    } catch (err) {
      document.getElementById('settings-root').innerHTML = `<div class="empty-state">Failed to load settings: ${err.message}</div>`;
    }
  },

  _renderAppearancePanel() {
    const panel = document.getElementById('settings-panel-appearance');
    if (!panel) return;
    const theme = (window.VodouTheme && window.VodouTheme.getTheme()) || 'dark';
    const palette = (window.VodouTheme && window.VodouTheme.getPalette()) || 'brand';
    const cards = [
      { id: 'brand', name: 'Vodou Brand', badge: 'Default', sw: ['#2563EB', '#6B7280', '#0F1419'],
        desc: 'Official Vodou guide blue and slate.' },
      { id: 'ritual', name: 'Ritual Gold', badge: 'Classic', sw: ['#c9a227', '#ede6d6', '#14110d'],
        desc: 'Obsidian / Bone / Gold — previous gateway default.' },
      { id: 'ember', name: 'Warm Coral', badge: 'Soft', sw: ['#D97757', '#F5EDE8', '#1A1412'],
        desc: 'Soft warm coral on charcoal — calm and approachable.' },
      { id: 'moss', name: 'Neon Green', badge: 'Hard', sw: ['#1DB954', '#FFFFFF', '#121212'],
        desc: 'Bold green on near-black — high energy.' },
      { id: 'ocean', name: 'Soft Teal', badge: 'Soft', sw: ['#10A37F', '#ECECEC', '#0D0D0D'],
        desc: 'Quiet teal on deep charcoal.' },
      { id: 'crimson', name: 'Signal Red', badge: 'Hard', sw: ['#E50914', '#FFFFFF', '#221F1F'],
        desc: 'Vivid red on charcoal — sharp and cinematic.' },
      { id: 'violet', name: 'Stream Purple', badge: 'Hard', sw: ['#9146FF', '#EFEFF1', '#0E0E10'],
        desc: 'Saturated purple on near-black.' },
      { id: 'rose', name: 'Rausch Coral', badge: 'Hard', sw: ['#FF385C', '#FFFFFF', '#222222'],
        desc: 'Bright coral-pink on charcoal/white.' },
      { id: 'graphite', name: 'Mono Link', badge: 'Muted', sw: ['#0070F3', '#EDEDED', '#000000'],
        desc: 'Near-mono with a cool blue link accent.' },
      { id: 'glacier', name: 'Sky Signal', badge: 'Soft', sw: ['#1D9BF0', '#E7E9EA', '#000000'],
        desc: 'Clear sky blue on black/white.' },
      { id: 'espresso', name: 'Warm Ink', badge: 'Soft', sw: ['#9A6B3F', '#FFFFFF', '#191919'],
        desc: 'Warm brown ink on soft gray paper.' },
      { id: 'saffron', name: 'Marketplace Orange', badge: 'Hard', sw: ['#FF9900', '#FFFFFF', '#0F1111'],
        desc: 'Bright amber-orange on deep navy.' },
      { id: 'blush', name: 'Pastel Blush', badge: 'Soft', sw: ['#F2A7C3', '#F8F0F2', '#1A1216'],
        desc: 'Soft pastel pink — gentle and airy.' },
      { id: 'lilac', name: 'Issue Indigo', badge: 'Soft', sw: ['#5E6AD2', '#F7F8F8', '#0F1011'],
        desc: 'Cool indigo on near-black / paper white.' },
      { id: 'mint', name: 'Fresh Mint', badge: 'Soft', sw: ['#3ECF8E', '#EDEDED', '#1C1C1C'],
        desc: 'Fresh mint green on charcoal.' },
      { id: 'powder', name: 'Payment Violet', badge: 'Soft', sw: ['#635BFF', '#F6F9FC', '#0A2540'],
        desc: 'Soft violet on navy and paper.' },
      { id: 'seafoam', name: 'Commerce Green', badge: 'Soft', sw: ['#008060', '#E8F5F0', '#0B1A14'],
        desc: 'Deep teal-green — steady and commercial.' },
      { id: 'peach', name: 'Warm Peach', badge: 'Soft', sw: ['#F0A878', '#F8F0E8', '#1A1410'],
        desc: 'Soft peach pastel — warm and light.' },
      { id: 'lime', name: 'Electric Lime', badge: 'Hard', sw: ['#58CC02', '#FFFFFF', '#131F24'],
        desc: 'Hard lime green — playful and loud.' },
      { id: 'cobalt', name: 'Blurple', badge: 'Hard', sw: ['#5865F2', '#F2F3F5', '#1E1F22'],
        desc: 'Saturated blurple on slate chat surfaces.' },
      { id: 'magenta', name: 'Hot Magenta', badge: 'Hard', sw: ['#E1306C', '#F5F5F5', '#000000'],
        desc: 'Hot magenta on pure black/white.' },
      { id: 'tangerine', name: 'Coral Orange', badge: 'Hard', sw: ['#FF7A59', '#FFFFFF', '#2D3E50'],
        desc: 'Coral orange on slate blue-gray.' },
      { id: 'burgundy', name: 'Aubergine', badge: 'Hard', sw: ['#4A154B', '#F8F0F8', '#1A0A1C'],
        desc: 'Deep aubergine with a pink accent.' },
      { id: 'olive', name: 'Forge Green', badge: 'Muted', sw: ['#238636', '#E6EDF3', '#0D1117'],
        desc: 'Muted success green on forge-dark surfaces.' },
    ];
    const cardHtml = cards.map((c) => {
      const badge = c.badge
        ? `<span class="appearance-palette-badge${['Classic','Soft','Muted'].includes(c.badge) ? ' appearance-palette-badge-muted' : ''}">${c.badge}</span>`
        : '';
      const swatches = c.sw.map((hex) => `<span style="background:${hex}"></span>`).join('');
      return `<button type="button" class="appearance-palette-card${palette === c.id ? ' is-active' : ''}" data-palette-pick="${c.id}">
            <div class="appearance-palette-swatches">${swatches}</div>
            <div class="appearance-palette-meta">
              <strong>${c.name}</strong>
              ${badge}
            </div>
            <p>${c.desc}</p>
          </button>`;
    }).join('');
    panel.innerHTML = `
      <div class="settings-section">
        <h2 class="settings-section-title">Color mode</h2>
        <p class="settings-note">Light or dark. Same control as the sun/moon button in the sidebar.</p>
        <div class="appearance-mode-row" role="radiogroup" aria-label="Color mode">
          <button type="button" class="appearance-mode-btn${theme === 'dark' ? ' is-active' : ''}" data-theme-pick="dark">Dark</button>
          <button type="button" class="appearance-mode-btn${theme === 'light' ? ' is-active' : ''}" data-theme-pick="light">Light</button>
        </div>
      </div>
      <div class="settings-section">
        <h2 class="settings-section-title">Palette</h2>
        <div class="appearance-palette-grid" role="radiogroup" aria-label="Color palette">
          ${cardHtml}
        </div>
        <p class="settings-note settings-note-tight">Stored in this browser (<code>localStorage</code>). Applies instantly.</p>
      </div>
      <div class="settings-section settings-section-spaced">
        <h2 class="settings-section-title">Navigation</h2>
        <p class="settings-note settings-note-block-sm">Vodou ships more surfaces than most people need. The developer ones are hidden by default so the everyday path is findable. <strong>Nothing is removed</strong> — every link still works if you have it bookmarked.</p>
        <label class="mem-src-card mem-src-card--inline">
          <input type="checkbox" id="ui-show-everything" ${this._data && (this._data['ui.show_everything'] === true || this._data['ui.show_everything'] === '1') ? 'checked' : ''} style="margin:0;">
          <span class="mem-src-main">
            <strong>Show everything (developer surfaces)</strong>
            <div class="mem-src-detail muted">Adds Kanban board, Scripts, Routing rules, Lenses, and the Advanced group (Builder, Terminal) back to the sidebar.</div>
          </span>
          <span id="ui-show-everything-status" class="muted" style="font-size:11px;"></span>
        </label>
      </div>`;

    // PLAN-ALPHA F6 — nav gating toggle.
    const showAll = panel.querySelector('#ui-show-everything');
    if (showAll) {
      showAll.addEventListener('change', async () => {
        const on = showAll.checked;
        const status = panel.querySelector('#ui-show-everything-status');
        // Apply optimistically so the sidebar responds immediately, then persist.
        // A checkbox that waits on a round-trip before doing anything reads as broken.
        if (on) document.documentElement.setAttribute('data-show-everything', '1');
        else document.documentElement.removeAttribute('data-show-everything');
        try { localStorage.setItem('vodou-show-everything', on ? '1' : '0'); } catch (e) {}
        try {
          await API.post('/api/settings', { 'ui.show_everything': on ? '1' : '' });
          if (this._data) this._data['ui.show_everything'] = on;
          if (status) status.textContent = 'saved';
        } catch (e) {
          // Roll the UI back rather than leaving it showing a state the server
          // does not hold — the next reload would silently contradict it.
          if (status) status.textContent = 'could not save';
          showAll.checked = !on;
          if (!on) document.documentElement.setAttribute('data-show-everything', '1');
          else document.documentElement.removeAttribute('data-show-everything');
        }
      });
    }

    panel.querySelectorAll('[data-theme-pick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (window.VodouTheme) window.VodouTheme.setTheme(btn.getAttribute('data-theme-pick'));
        this._renderAppearancePanel();
      });
    });
    panel.querySelectorAll('[data-palette-pick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (window.VodouTheme) window.VodouTheme.setPalette(btn.getAttribute('data-palette-pick'));
        this._renderAppearancePanel();
      });
    });
  },

  _bindTabs(root) {
    const bar = root.querySelector('.settings-tab-bar');
    if (!bar) return;
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('.settings-tab[data-tab]');
      if (!btn) return;
      const tab = btn.dataset.tab;
      const next = `#/settings?tab=${encodeURIComponent(tab)}`;
      if (location.hash !== next) {
        location.hash = next;
      } else {
        this._activateTab(tab);
      }
    });
  },

  onRouteChange() {
    this._activateTab(this._activeTab());
    this._scrollToSectionIfAsked();
  },

  _collectEnvPatch() {
    const patch = {};
    document.querySelectorAll('#settings-panel-env input.env-value-input[data-env-key]').forEach((inp) => {
      const k = inp.getAttribute('data-env-key');
      const secret = inp.getAttribute('data-secret') === '1';
      const v = inp.value;
      if (secret) {
        if (v.trim()) patch[k] = v;
      } else {
        const init = this._envInitial[k] ?? '';
        if (v !== init) patch[k] = v;
      }
    });
    return patch;
  },

  _scheduleEnvAutosave() {
    clearTimeout(this._envAutosaveTimer);
    this._envAutosaveTimer = setTimeout(() => {
      this._envAutosaveTimer = null;
      void this._flushEnvAutosave();
    }, 700);
  },

  _bindEnvAutosave(panel) {
    panel.addEventListener('input', (e) => {
      if (e.target?.classList?.contains('env-value-input')) this._scheduleEnvAutosave();
    });
    panel.addEventListener('change', (e) => {
      if (e.target?.classList?.contains('env-value-input')) this._scheduleEnvAutosave();
    });
  },

  async _flushEnvAutosave() {
    const panel = document.getElementById('settings-panel-env');
    if (!panel) return;
    if (this._envSaving) {
      this._scheduleEnvAutosave();
      return;
    }
    const patch = this._collectEnvPatch();
    if (Object.keys(patch).length === 0) return;

    const statusEl = document.getElementById('env-autosave-status');
    this._envSaving = true;
    if (statusEl) {
      statusEl.textContent = 'Saving…';
      statusEl.classList.remove('env-autosave-err');
    }
    try {
      const res = await API.post('/api/settings/project-env', { patch });
      const saved = res.savedKeys || Object.keys(patch);
      for (const k of saved) {
        const inp = panel.querySelector(`input.env-value-input[data-env-key="${k}"]`);
        if (!inp) continue;
        const isSec = inp.getAttribute('data-secret') === '1';
        if (isSec && res.maskedPreview && res.maskedPreview[k]) {
          inp.value = '';
          this._envInitial[k] = '';
          const row = inp.closest('.env-row');
          const st = row?.querySelector('.env-secret-state');
          if (st) {
            st.innerHTML = `Saved value (masked): <code>${this._esc(res.maskedPreview[k])}</code>`;
          }
        } else if (!isSec) {
          this._envInitial[k] = inp.value;
        }
      }
      if (statusEl) {
        statusEl.textContent = 'Saved to .env';
        clearTimeout(this._envAutosaveClearTimer);
        this._envAutosaveClearTimer = setTimeout(() => {
          if (statusEl.textContent === 'Saved to .env') statusEl.textContent = '';
        }, 3200);
      }
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = 'Save failed: ' + (err.message || String(err));
        statusEl.classList.add('env-autosave-err');
      }
    } finally {
      this._envSaving = false;
      if (Object.keys(this._collectEnvPatch()).length > 0) this._scheduleEnvAutosave();
    }
  },

  async _loadEnvPanel(savedMessage) {
    const panel = document.getElementById('settings-panel-env');
    if (!panel) return;
    try {
      const data = await API.get('/api/settings/project-env');
      this._envData = data;
      this._envInitial = {};
      const rows = [];
      for (const sec of data.sections || []) {
        const items = (sec.items || []).map((it) => {
          const secret = it.isSecret;
          const displayVal = secret ? '' : (it.value ?? '');
          this._envInitial[it.key] = displayVal;
          const hint = it.exampleDefault
            ? `<div class="env-meta">Example default: <code>${this._esc(it.exampleDefault)}</code></div>`
            : '';
          const secretState = secret
            ? (it.maskedPreview
              ? `<div class="env-meta env-secret-state">Saved value (masked): <code>${this._esc(it.maskedPreview)}</code></div>`
              : `<div class="env-meta env-secret-state">${it.hasValue ? '' : 'No value set yet.'}</div>`)
            : '';
          const desc = it.description
            ? `<p class="env-desc">${this._esc(it.description)}</p>`
            : '';
          const typ = secret ? 'password' : 'text';
          const ph = secret
            ? (it.maskedPreview ? 'New value to replace secret' : 'Enter value')
            : '';
          return `<div class="env-row">
            <div class="env-key">${this._esc(it.key)}</div>
            ${desc}
            ${hint}
            ${secretState}
            <div class="env-input-row">
              <input type="${typ}" class="settings-input env-value-input" data-env-key="${this._esc(it.key)}" data-secret="${secret ? '1' : ''}" placeholder="${this._esc(ph)}" value="${this._esc(displayVal)}" autocomplete="off" spellcheck="false">
            </div>
          </div>`;
        }).join('');
        rows.push(`<div class="env-section"><h3>${this._esc(sec.title)}</h3>${items}</div>`);
      }
      const emptyHint = !(data.sections || []).length
        ? '<p class="settings-note settings-note-block">Add a <code>.env.example</code> at the project root to drive this list, or create a <code>.env</code> with keys you need — they will appear under “Other”.</p>'
        : '';
      const autosaveNote = savedMessage
        ? `<span class="env-autosave-status" id="env-autosave-status">${this._esc(savedMessage)}</span>`
        : '<span class="env-autosave-status" id="env-autosave-status"></span>';
      panel.innerHTML = `
        ${this._envRestartStripHtml()}
        <div class="env-banner">
          <strong>Project <code>.env</code></strong> — ${this._esc(data.restartNote || '')}
          <p class="env-autosave-bar">Edits save automatically about a second after you stop typing. ${autosaveNote}</p>
        </div>
        ${emptyHint}
        ${rows.join('')}
        <div class="env-actions env-actions--autosave">
          <p class="settings-note settings-note-zero">Tip: after changing values that affect the brain or MCP, use <strong>Restart gateway, worker &amp; daemon</strong> above or below.</p>
        </div>
        ${this._envRestartStripHtml()}`;
      this._bindEnvRestartButtons(panel);
      this._bindEnvAutosave(panel);
    } catch (err) {
      panel.innerHTML = `<div class="empty-state">Could not load environment: ${this._esc(err.message)}</div>`;
    }
  },

  async _loadMemoryPanel() {
    const panel = document.getElementById('settings-panel-memory');
    if (!panel) return;
    try {
      const settled = await Promise.allSettled([
        API.get('/api/memory/extractor/status'),
        API.get('/api/capture/status'),
        API.get('/api/vaults'),
        API.get('/api/system'),
        API.get('/api/capture/pair'),
        API.get('/api/system/gateway-extractor-settings'),
        API.get('/api/system/extractor-log?tail=20'),
        // PLAN-PROJECT-VAULTS §4.3 — names for the project chip + the "Only this
        // project" label. Rides the existing allSettled batch, so it adds no
        // round-trip and a failure degrades to ids instead of breaking the panel.
        API.get('/api/projects'),
      ]);
      const val = (i, fallback) => settled[i].status === 'fulfilled' ? settled[i].value : fallback;
      this._projectsForVaults = (val(7, { projects: [] }).projects) || [];
      const sys = val(3, {});
      const ctx = {
        status: val(0, { backends: [], override: null, lastBench: null }),
        capture: val(1, null),
        vaults: val(2, { vaults: [] }),
        brain: sys.memoryBrain || null,
        health: sys.memoryHealth || null,
        pair: val(4, null),
        channels: val(5, { channels_enabled: false }),
        cycles: val(6, { cycles: [] }),
      };
      this._memoryCtx = ctx;
      panel.innerHTML = this._renderMemoryPanel(ctx);
      this._bindMemoryPanel(panel);
      this._scrollToSectionIfAsked();
    } catch (err) {
      panel.innerHTML = `<div class="empty-state">Failed to load memory settings: ${this._esc(err.message || String(err))}</div>`;
    }
  },

  _memAgo(ts) {
    if (!ts) return 'never';
    try {
      const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts).getTime();
      if (!Number.isFinite(d)) return String(ts);
      const sec = Math.max(0, Math.floor((Date.now() - d) / 1000));
      if (sec < 60) return `${sec}s ago`;
      if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
      if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
      return `${Math.floor(sec / 86400)}d ago`;
    } catch { return String(ts); }
  },

  // One producer for the Browser-bridge Status block (initial render + the
  // require-toggle handler). The "go pair it" instructions render ONLY when
  // something actually needs pairing: required + connected means the extension
  // already holds the current code and paired silently — telling the user to go
  // paste it again is what made a working state read as a broken one.
  _pairStatusHtml(connected, required) {
    const state = `${connected ? '<span class="settings-ok">Connected</span>' : '<span class="settings-warn">Not connected</span>'}${required ? (connected ? ' · <span class="settings-ok">paired</span>' : ' · <strong class="settings-warn">pairing required</strong>') : ' · open (no code required)'}`;
    const action = (required && !connected)
      ? '<div class="mem-pair-status-action">Next: copy the code → click the <strong>Vodou</strong> toolbar icon (the panel opens) → <strong>Settings</strong> → paste the code → <strong>Pair</strong>.</div>'
      : '';
    return `<div>${state}</div>${action}`;
  },

  _renderMemSourceCard({ id, title, sub, detail, enabled, connected, chunks, lastAt, toggleKey, locked, envKey, alwaysOn, extra, meta }) {
    const dot = connected ? 'live' : (enabled ? 'warm' : '');
    // Name the variable. "env override" alone tells someone they cannot change it
    // and not where to go — and the old tooltip said "UI writes still save, but env
    // wins", which describes a write this disabled toggle cannot perform. True at the
    // API level, meaningless to a person looking at a dead control.
    const lockNote = locked
      ? `<span class="mem-src-lock" title="${this._esc(envKey ? `Set by ${envKey} in your .env — change it there, then restart Vodou.` : 'Set by an environment variable in your .env.')}">${envKey ? this._esc(envKey) : 'env override'}</span>`
      : '';
    const toggleHtml = alwaysOn
      ? `<span class="mem-src-always">always on</span>`
      : `<button type="button" class="mem-src-toggle${enabled ? ' on' : ''}" data-setting="${this._esc(toggleKey || '')}" data-on="${enabled ? '1' : '0'}" ${locked ? 'disabled' : ''} aria-pressed="${enabled ? 'true' : 'false'}" title="${locked ? this._esc(envKey ? `Fixed by ${envKey} — change it in .env` : 'Fixed by an environment variable') : (enabled ? 'Disable' : 'Enable')}"></button>`;
    const metaLine = meta != null
      ? meta
      : `${Number(chunks || 0).toLocaleString()} memories · last ${this._esc(this._memAgo(lastAt))}`;
    return `
      <div class="mem-src-card" data-lane="${this._esc(id)}">
        <span class="mem-src-dot ${dot}"></span>
        <div class="mem-src-main">
          <div class="mem-src-head">
            <strong>${this._esc(title)}</strong>
            ${sub ? `<span class="mem-src-sub">${this._esc(sub)}</span>` : ''}
            ${lockNote}
          </div>
          <div class="mem-src-detail muted">${detail}</div>
          <div class="mem-src-meta muted">${metaLine}</div>
          ${extra || ''}
        </div>
        ${toggleHtml}
      </div>`;
  },

  _renderMemoryPanel(ctx) {
    const status = ctx.status || {};
    const lanes = (ctx.capture && ctx.capture.lanes) || {};
    const override = status.override || '';
    const backends = status.backends || [];
    const lastBench = status.lastBench || null;
    const brain = ctx.brain || {};
    const pair = ctx.pair || {};
    const vaultList = (ctx.vaults && (ctx.vaults.vaults || ctx.vaults)) || [];
    const vaultArr = Array.isArray(vaultList) ? vaultList : [];
    const channelsOn = !!(ctx.channels && ctx.channels.channels_enabled);
    const cycles = (ctx.cycles && ctx.cycles.cycles) || [];

    const opts = ['<option value="">(none — use memory.toml)</option>']
      .concat(backends.map(b => `<option value="${this._esc(b)}"${b === override ? ' selected' : ''}>${this._esc(b)}</option>`))
      .join('');

    const ide = lanes.ide || {};
    const byok = lanes.byok || {};
    const web = lanes.web || {};
    const manual = lanes.manual || {};
    const imp = lanes.import || {};
    const ideSources = ide.sources || 'cursor';
    const ideSub = ideSources === 'all' ? 'Cursor · Claude Code' : ideSources === 'claude-code' ? 'Claude Code' : 'Cursor';
    const captureTotal = [ide, byok, web, manual, imp].reduce((n, l) => n + (l.chunks || 0), 0);

    const ideExtra = `
      <div class="mem-src-extra">
        <label class="mem-src-field">IDEs to watch
          <select id="mem-ide-sources" class="settings-input" ${ide.sources_overridden_by_env ? 'disabled' : ''}>
            <option value="cursor"${ideSources === 'cursor' ? ' selected' : ''}>Cursor only</option>
            <option value="claude-code"${ideSources === 'claude-code' ? ' selected' : ''}>Claude Code only</option>
            <option value="all"${ideSources === 'all' ? ' selected' : ''}>Cursor + Claude Code</option>
          </select>
        </label>
      </div>`;

    // The browser lane is the one source a user cannot turn on from inside Vodou:
    // the extension comes from the Chrome Web Store, so an app update never brings
    // it. This card said "install Vodou Bridge" and then offered no way to — the
    // same dead end onboarding had before PLAN-ONBOARDING-EXTENSION-STEP, and the
    // one an updating user hits INSTEAD of onboarding, which they never see again.
    const webExtra = web.connected || !window.VodouExtStore?.LISTING_LIVE
      ? ''
      : `<div class="mem-src-extra">
          ${window.VodouExtStore.installLink('Install the extension', 'btn btn-secondary btn-small')}
        </div>`;

    // Installed-vs-latest, resolved server-side against app.vodou.ai's record
    // (api/extension-version.ts). Every field is null unless we actually know,
    // so an absent record renders nothing rather than a hedge.
    //
    // Two different messages, deliberately:
    //   · a STORE build self-updates — Chrome pulls it within ~24h, so the user
    //     is told to wait, not sent to click something that changes nothing;
    //   · anything else (an unpacked dev build) will never update itself and
    //     gets the actual link.
    // And `unsupported` (below min_supported_version) is a warning, not a pill:
    // that build is broken, not merely dated. Nagging on every release is how a
    // notice gets ignored by the time it matters.
    const extUpd = web.extension_update || {};
    const webUpdateNote = !extUpd.update_available
      ? ''
      : `<div class="mem-src-extra">
          <span class="${extUpd.unsupported ? 'status-warn-text' : 'text-muted-color'}">
            ${extUpd.unsupported
              ? `⚠️ Bridge v${this._esc(extUpd.installed)} is below the supported minimum (v${this._esc(extUpd.latest)}) — capture may not work correctly.`
              : `Bridge v${this._esc(extUpd.latest)} is available (you have v${this._esc(extUpd.installed)}).`}
          </span>
          ${extUpd.self_updating
            ? ' <span class="text-muted-color">Chrome updates this automatically, usually within a day.</span>'
            : ` ${window.VodouExtStore?.installLink('Update the extension', 'btn btn-secondary btn-small') || ''}`}
        </div>`;

    const byokApps = (byok.apps || []).length
      ? `apps seen: ${(byok.apps || []).slice(0, 6).map(a => this._esc(a)).join(', ')}${(byok.apps || []).length > 6 ? '…' : ''}`
      : 'no BYOK apps seen yet — point a client at the OpenAI-compatible endpoint';

    const sourcesHtml = [
      this._renderMemSourceCard({
        id: 'native', title: 'Vodou itself', sub: 'Chat · workbench · skills · automations',
        detail: 'Your own activity inside Vodou. Always extracted into long-term memory.',
        enabled: true, connected: true, alwaysOn: true, meta: 'always indexed',
      }),
      this._renderMemSourceCard({
        id: 'ide', title: 'This Mac', sub: ideSub,
        detail: ide.enabled
          ? (ide.connected
            ? `Capturing IDE sessions · last daemon run ${this._memAgo(ide.last_run_at)}${ide.last_error ? ` · error: ${ide.last_error}` : ''}`
            : 'Enabled — waiting for the Vodou daemon capture task')
          : 'Off — IDE AI sessions are not being remembered',
        enabled: !!ide.enabled, connected: !!ide.connected, chunks: ide.chunks, lastAt: ide.last_capture_at,
        toggleKey: 'capture.ide.enabled', locked: !!ide.overridden_by_env, envKey: ide.env_key, extra: ideExtra,
      }),
      this._renderMemSourceCard({
        id: 'web', title: 'Your browser', sub: web.extension_version ? `Bridge v${web.extension_version}` : 'ChatGPT · Claude',
        // The pair code is only a step when pairing is ENFORCED, and it is off by
        // default (bridge.ts:62). Telling every user to enter a code that nothing
        // is asking for sends them looking for a problem they do not have.
        detail: !web.connected
          ? (pair.required
            ? 'Extension not connected — install Vodou Bridge, then enter the pair code below'
            : 'Extension not connected — install Vodou Bridge and it connects on its own')
          : (web.enabled ? 'Capturing ChatGPT / Claude web conversations' : 'Extension connected — flip on to capture web AI chats'),
        enabled: !!web.enabled, connected: !!web.connected, chunks: web.chunks, lastAt: web.last_capture_at,
        toggleKey: 'capture.web.armed', locked: !!web.overridden_by_env, envKey: web.env_key,
        extra: webExtra + webUpdateNote,
      }),
      this._renderMemSourceCard({
        id: 'byok', title: 'BYOK / OpenAI-compatible apps', sub: 'Aider, Cursor API, custom clients',
        detail: byok.enabled ? byokApps : 'Off — scoped conversation ids disabled for the /v1 endpoint',
        enabled: !!byok.enabled, connected: !!byok.connected, chunks: byok.chunks, lastAt: byok.last_capture_at,
        toggleKey: 'capture.byok.enabled', locked: !!byok.overridden_by_env, envKey: byok.env_key,
      }),
      this._renderMemSourceCard({
        id: 'import', title: 'Imports', sub: 'ChatGPT / Claude / Obsidian exports',
        detail: 'One-shot history imports. Manage jobs on the Memory page.',
        enabled: true, connected: true, chunks: imp.chunks, lastAt: imp.last_capture_at, alwaysOn: true,
      }),
    ].join('');

    // PLAN-PROJECT-VAULTS §4.3 — a vault WITH a `project` rule is owned by that
    // project; one WITHOUT is global and shows everywhere (§2 principle 1). No
    // vault can ever disappear from this list: a global vault is always visible,
    // and "Show all projects" brings owned ones back (INV-1/INV-5).
    const activeProj = (window.ProjectScope && window.ProjectScope.active()) || null;
    const scopeOn = !!(window.ProjectScope && window.ProjectScope.enabled() && !window.ProjectScope.showAll());
    const projName = (id) => {
      const p = (this._projectsForVaults || []).find((x) => x.id === id);
      return p ? p.name : id;
    };
    const visibleVaults = vaultArr.filter((v) => {
      const owner = (v.rules || {}).project;
      if (!owner) return true;                 // global — never hidden
      if (!scopeOn) return true;               // flag off / show-all — show everything
      return owner === activeProj;
    });
    const hiddenCount = vaultArr.length - visibleVaults.length;
    const vaultRows = visibleVaults.length
      ? visibleVaults.map(v => {
          const rules = v.rules || {};
          const bits = [];
          if ((rules.tags || []).length) bits.push(`tags: ${(rules.tags || []).join(', ')}`);
          if ((rules.scopes || []).length) bits.push(`${(rules.scopes || []).length} scope(s)`);
          if ((rules.pinned_scopes || []).length) bits.push(`+${(rules.pinned_scopes || []).length} pinned`);
          if (rules.include_profile) bits.push('profile');
          if (rules.include_imports) bits.push('imports');
          if (rules.since_days) bits.push(`${rules.since_days}d`);
          const chip = rules.project
            ? `<span class="mem-vault-projchip" title="Only this project's memory (plus any pinned scopes)">${this._esc(projName(rules.project))}</span>`
            : '';
          return `<div class="mem-vault-row">
            <strong>${this._esc(v.name)}</strong>${chip}
            <span class="muted">${this._esc(bits.join(' · ') || 'no filters')}</span>
            <button type="button" class="btn btn-secondary btn-small mem-vault-preview" data-vault="${this._esc(v.name)}">Preview</button>
          </div>`;
        }).join('') + (hiddenCount ? `<p class="settings-note settings-note-tight">${hiddenCount} vault(s) belong to other projects — switch project, or use “Show all projects” in the chat header.</p>` : '')
      : `<p class="settings-note settings-note-zero">No vaults yet. Create named slices of memory to share selectively (family vs work, portable profile, etc.).</p>`;

    const lastBenchHtml = lastBench ? `
      <div class="settings-section-tight">
        <div class="settings-current-label">Last benchmark</div>
        <div class="settings-row settings-row-gap-sm">
          <span class="settings-label-fixed">Backend</span><code>${this._esc(lastBench.backend)}</code>
        </div>
        ${lastBench.reference ? `<div class="settings-row settings-row-gap-sm"><span class="settings-label-fixed">Reference</span><code>${this._esc(lastBench.reference)}</code></div>` : ''}
        <div class="settings-row settings-row-gap-sm">
          <span class="settings-label-fixed">Passed</span>
          <span>${lastBench.passed}/${lastBench.total} (${(lastBench.pass_rate * 100).toFixed(0)}%) — <strong class="${lastBench.pass ? 'settings-ok' : 'settings-warn'}">${lastBench.pass ? 'PASS' : 'FAIL'}</strong></span>
        </div>
        ${lastBench.avg_cosine != null ? `<div class="settings-row settings-row-gap-sm"><span class="settings-label-fixed">Avg cosine</span><span>${lastBench.avg_cosine.toFixed(3)}</span></div>` : ''}
        <div class="settings-row settings-row-gap-sm"><span class="settings-label-fixed">Ran at</span><span>${this._esc(lastBench.ran_at || '')}</span></div>
      </div>` : '';

    const cycleBullets = cycles.reduce((s, c) => s + (c.bullets || 0), 0);
    const lastCycle = cycles.length ? cycles[cycles.length - 1] : null;
    const cycleStats = cycles.length
      ? `Recent cycles: <strong>${cycles.length}</strong> · Bullets: <strong>${cycleBullets}</strong>${lastCycle ? ` · Last: <strong>${this._memAgo(lastCycle.ts)}</strong>` : ''}`
      : `<em>No extractor cycles yet.</em>`;

    const modelTag = brain.memory_model_tag || '—';
    const chunkN = brain.chunks != null ? Number(brain.chunks).toLocaleString() : '—';
    const health = ctx.health || {};
    const healthPct = health.pct != null ? `${Math.round(health.pct)}%` : '—';
    const healthSpark = health.sparkline && health.sparkline !== '—' ? ` ${health.sparkline}` : '';
    const upgrade = brain.upgrade_available
      ? `<span class="settings-warn">Upgrade available</span>`
      : `<span class="settings-ok">Ready</span>`;

    return `
      <div class="settings-section">
        <h3 class="settings-section-title">Memory at a glance</h3>
        <p class="settings-note settings-note-block-sm">Long-term recall lives in <code>memory.db</code>. Browse on Memory. Switching MiniLM ↔ bge (re-embed for better search) is on System — not related to vaults.</p>
        <div class="mem-glance">
          <div><span class="muted">Chunks</span><strong>${chunkN}</strong></div>
          <div><span class="muted">Embedder</span><strong>${this._esc(modelTag)}</strong></div>
          <div><span class="muted">Health</span><strong>${this._esc(healthPct)}${this._esc(healthSpark)}</strong></div>
          <div><span class="muted">Capture lanes</span><strong>${captureTotal.toLocaleString()}</strong></div>
          <div><span class="muted">Status</span>${upgrade}</div>
        </div>
        <div class="settings-row settings-row-gap-sm" style="margin-top:12px;gap:8px;flex-wrap:wrap;">
          <a href="#/memory" class="btn btn-primary btn-link-inline">Open Memory</a>
          <a href="#/system" class="btn btn-secondary btn-link-inline" title="Memory brain status on System (embedder MiniLM/bge). Does not start a migrate by itself.">System → memory brain</a>
        </div>
      </div>

      <div class="settings-section settings-section-spaced">
        <h3 class="settings-section-title">Sources</h3>
        <p class="settings-note settings-note-block-sm">Where memories come from. Toggle a lane to start or stop collecting. Locked lanes are driven by an env var.</p>
        <div id="mem-sources">${sourcesHtml}</div>
        <div id="mem-sources-status" class="settings-note settings-note-tight"></div>
      </div>

      <div class="settings-section settings-section-spaced" id="mem-bridge-section">
        <h3 class="settings-section-title">Browser bridge</h3>
        <p class="settings-note settings-note-block-sm">Pair the Vodou Bridge extension so ChatGPT / Claude web chats can flow into memory. Pairing is optional (off by default).</p>
        <label class="mem-src-card mem-src-card--inline" style="margin-bottom:10px;">
          <input type="checkbox" id="mem-pair-require" ${pair.required ? 'checked' : ''} ${pair.required_by_env ? 'disabled data-env-locked="1"' : ''} style="margin:0;">
          <span class="mem-src-main">
            <strong>Require pairing code</strong>
            <div class="mem-src-detail muted">${pair.required_by_env ? 'Locked by VODOU_VBB_REQUIRE_TOKEN env.' : 'When on, the extension must enter the code below before it can connect.'}</div>
          </span>
          <span id="mem-pair-require-status" class="muted" style="font-size:11px;"></span>
        </label>
        <div class="settings-row settings-row-gap-sm">
          <span class="settings-label-fixed">Pair code</span>
          <code id="mem-pair-code" class="mem-pair-code" title="Click to copy" role="button" tabindex="0">${this._esc(pair.code || '————')}</code>
          <button type="button" class="btn btn-secondary btn-small" id="mem-pair-rotate">Rotate</button>
          <span id="mem-pair-status" class="settings-note settings-note-tight"></span>
        </div>
        <div class="mem-pair-howto" id="mem-pair-howto">
          <div class="mem-pair-howto-title">How to pair</div>
          <ol>
            <li>Click the code above to copy it.</li>
            <li>Click the <strong>Vodou</strong> toolbar icon — the panel opens (this page cannot open it for you).</li>
            <li>In the panel's <strong>Settings</strong> tab, paste the code → <strong>Pair</strong>. (The box only appears while pairing is required.)</li>
          </ol>
        </div>
        <div class="settings-row settings-row-gap-sm" style="align-items:flex-start;">
          <span class="settings-label-fixed">Status</span>
          <div id="mem-pair-status-block">${this._pairStatusHtml(pair.connected, pair.required)}</div>
        </div>
      </div>

      <div class="settings-section settings-section-spaced">
        <h3 class="settings-section-title">Channels privacy</h3>
        <p class="settings-note settings-note-block-sm">Slack, Telegram, Discord, WhatsApp${window.VODOU_OS === 'mac' ? ', iMessage' : ''} often carry other people’s words. Off by default.</p>
        <label class="mem-src-card mem-src-card--inline">
          <input type="checkbox" id="ext-channels-toggle" ${channelsOn ? 'checked' : ''} style="margin:0;">
          <span class="mem-src-main">
            <strong>Index channel messages</strong>
            <div class="mem-src-detail muted">Inbound + outbound. Your Vodou chat / workbench activity is always extracted regardless.</div>
          </span>
          <span id="ext-channels-status" class="muted" style="font-size:11px;"></span>
        </label>
        <div id="ext-cycles-stats" class="settings-note settings-note-tight">${cycleStats}</div>
      </div>

      <div class="settings-section settings-section-spaced">
        <h3 class="settings-section-title">Vaults</h3>
        <p class="settings-note settings-note-block-sm">Named rule-based slices of memory for selective sharing (“portable profile”, project-only packs). Full manager also lives in Brain.</p>
        <div id="mem-vault-list">${vaultRows}</div>
        <div id="mem-vault-preview" class="settings-note settings-note-tight"></div>
        <details class="mem-advanced" style="margin-top:12px;" open>
          <summary>Create vault</summary>
          <p class="settings-note settings-note-tight">Rules pick which memories are in the pack. Empty tags+scopes = everything except imports. Full editor also lives in Brain.</p>
          <div class="settings-row settings-row-gap-sm" style="margin-top:10px;flex-wrap:wrap;">
            <input type="text" id="mem-vault-name" class="settings-input" placeholder="Name (e.g. portable)" style="max-width:220px;" autocomplete="off">
            <input type="text" id="mem-vault-tags" class="settings-input" placeholder="Tags (comma: PREF,IDENTITY)" style="max-width:280px;" autocomplete="off">
            <input type="text" id="mem-vault-scopes" class="settings-input" placeholder="Scopes (comma: web,skill)" style="max-width:280px;" autocomplete="off">
            <input type="number" id="mem-vault-since" class="settings-input" placeholder="Since days" min="1" max="36500" style="max-width:110px;">
            <label class="muted" style="display:flex;align-items:center;gap:6px;font-size:12px;">
              <input type="checkbox" id="mem-vault-profile"> Include profile
            </label>
            <label class="muted" style="display:flex;align-items:center;gap:6px;font-size:12px;">
              <input type="checkbox" id="mem-vault-imports"> Include imports
            </label>
            <button type="button" class="btn btn-primary btn-small" id="mem-vault-create">Create vault</button>
          </div>
          <!-- PLAN-PROJECT-VAULTS §4.3 / D1 option B. The form DEFAULTS to the
               active project rather than auto-provisioning a vault per project:
               a "Project · X" vault that resolves to ~40 chunks would be a share
               target that under-delivers on its own name. Opt in per vault. -->
          <div class="settings-row settings-row-wrap" id="mem-vault-project-row">
            <label class="settings-check" title="Limit this vault to the active project's memory">
              <input type="checkbox" id="mem-vault-only-project"> Only this project<span id="mem-vault-project-name" class="muted"></span>
            </label>
            <div id="mem-vault-pinned-wrap" style="display:none;width:100%;">
              <p class="settings-note settings-note-tight">
                Most of a project's memory carries no project stamp — the work happened at the install
                root before the project existed. Tick the surfaces whose memory belongs in this vault;
                they are added to the project's own chunks, not intersected with them.
              </p>
              <div id="mem-vault-pinned-list" class="project-skills-list">Loading surfaces…</div>
            </div>
          </div>
          <div id="mem-vault-create-status" class="settings-note settings-note-tight"></div>
        </details>
      </div>

      <div class="settings-section settings-section-spaced">
        <h3 class="settings-section-title">Extraction backend</h3>
        <p class="settings-note">Which LLM turns chats into long-term memories (session end / flush).
          <strong>Provider</strong> = which backend runs extraction.
          <code>auto</code> = same backend as Settings → LLM/Model.
          <strong>Model</strong>: <em>Follow chat model (live)</em> means “don’t pick a separate model —
          reuse the chat model already chosen for that backend on LLM Settings. Change it there,
          extraction uses the new one next time.” Pick a specific model only if you want extraction
          locked to something different from chat.
          Env <code>VODOU_MEMORY_EXTRACTION_*</code> beats these UI overrides; <code>heuristic</code> = no LLM.</p>
        <div class="settings-row settings-row-gap-sm">
          <span class="settings-current-label settings-label-fixed">Provider</span>
          <select id="memext-override" class="settings-input">${opts}</select>
        </div>
        <div class="settings-row settings-row-gap-sm" id="memext-model-row">
          <span class="settings-current-label settings-label-fixed">Model</span>
          <select id="memext-model" class="settings-input">
            <option value="">Follow chat model (live)</option>
          </select>
          <button type="button" class="btn btn-secondary btn-small" id="memext-model-refresh" title="Refresh model list">Refresh</button>
        </div>
        <div id="memext-effective" class="settings-note settings-note-tight"></div>
        <div class="settings-row settings-row-gap-md">
          <button type="button" class="btn btn-primary" id="memext-save">Save</button>
          <button type="button" class="btn btn-secondary" id="memext-clear">Clear overrides</button>
        </div>
        <div id="memext-save-status" class="settings-note settings-note-tight"></div>
      </div>

      <details class="settings-section settings-section-spaced mem-advanced">
        <summary class="settings-section-title" style="cursor:pointer;">Advanced — extraction benchmark</summary>
        <p class="settings-note">Runs the 50-prompt fixture. Structure-only is a cheap sanity check; compare mode scores cosine vs a reference. Can take minutes.</p>
        <div class="settings-row settings-row-gap-sm">
          <span class="settings-current-label settings-label-fixed">Test backend</span>
          <select id="memext-bench-backend" class="settings-input">
            ${backends.map(b => `<option value="${this._esc(b)}"${b === 'ollama' ? ' selected' : ''}>${this._esc(b)}</option>`).join('')}
          </select>
        </div>
        <div class="settings-row settings-row-gap-sm">
          <span class="settings-current-label settings-label-fixed">Reference</span>
          <select id="memext-bench-reference" class="settings-input">
            <option value="">(structure-only — no reference)</option>
            ${backends.filter(b => b !== 'ollama' && b !== 'heuristic' && b !== 'auto').map(b => `<option value="${this._esc(b)}"${b === 'anthropic' ? ' selected' : ''}>${this._esc(b)}</option>`).join('')}
          </select>
        </div>
        <div class="settings-row settings-row-gap-md">
          <button type="button" class="btn btn-primary" id="memext-bench-run">Run benchmark</button>
          <span id="memext-bench-status" class="settings-note settings-note-tight"></span>
        </div>
        <div id="memext-bench-results" class="settings-section-tight" style="display:none"></div>
        ${lastBenchHtml}
      </details>
    `;
  },

  _timeAgoShort(ts) {
    return this._memAgo(ts);
  },

  _bindMemoryPanel(panel) {
    const statusEl = panel.querySelector('#mem-sources-status');
    const putCapture = async (key, value) => {
      if (statusEl) statusEl.textContent = 'Saving…';
      try {
        await API.put('/api/capture/settings', { [key]: value });
        if (statusEl) {
          statusEl.textContent = '✓ saved';
          statusEl.className = 'settings-note settings-note-tight settings-ok';
          setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 1500);
        }
        // Refresh lane cards without full tab reload noise
        void this._loadMemoryPanel();
      } catch (err) {
        if (statusEl) {
          statusEl.textContent = `Failed: ${err.message || err}`;
          statusEl.className = 'settings-note settings-note-tight settings-warn';
        }
        throw err;
      }
    };

    panel.querySelectorAll('.mem-src-toggle').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.dataset.setting;
        if (!key || btn.disabled) return;
        const next = btn.dataset.on === '1' ? '0' : '1';
        btn.disabled = true;
        try {
          await putCapture(key, next);
        } catch {
          btn.disabled = false;
        }
      });
    });

    panel.querySelector('#mem-ide-sources')?.addEventListener('change', async (e) => {
      const sel = e.target;
      sel.disabled = true;
      try {
        await putCapture('capture.ide.sources', sel.value);
      } catch {
        sel.disabled = false;
      }
    });

    const channelsToggle = panel.querySelector('#ext-channels-toggle');
    const channelsStatus = panel.querySelector('#ext-channels-status');
    channelsToggle?.addEventListener('change', async () => {
      channelsToggle.disabled = true;
      if (channelsStatus) channelsStatus.textContent = 'Saving…';
      try {
        await API.put('/api/system/gateway-extractor-settings', { channels_enabled: channelsToggle.checked });
        if (channelsStatus) {
          channelsStatus.textContent = channelsToggle.checked ? '✓ enabled' : '✓ disabled';
          setTimeout(() => { if (channelsStatus) channelsStatus.textContent = ''; }, 1500);
        }
      } catch (err) {
        channelsToggle.checked = !channelsToggle.checked;
        if (channelsStatus) channelsStatus.textContent = `Failed: ${err.message || 'error'}`;
      } finally {
        channelsToggle.disabled = false;
      }
    });

    // Live repaint of the pairing Status block, shared by Rotate and the require
    // toggle — both change what the connected extension is about to experience.
    const repaintPairStatus = async () => {
      const statusBlock = panel.querySelector('#mem-pair-status-block');
      if (!statusBlock) return;
      try {
        const live = await API.get('/api/capture/pair');
        statusBlock.innerHTML = this._pairStatusHtml(!!live.connected, !!live.required);
      } catch { /* keep the last paint */ }
    };

    const pairHowtoMsg = 'Copied. Click the Vodou toolbar icon → Settings → paste → Pair';
    const copyPairCode = async () => {
      const st = panel.querySelector('#mem-pair-status');
      const codeEl = panel.querySelector('#mem-pair-code');
      const code = (codeEl?.textContent || '').trim();
      if (!code || code === '————') return;
      try {
        await navigator.clipboard.writeText(code);
        if (st) {
          st.textContent = pairHowtoMsg;
          st.className = 'settings-note settings-note-tight settings-ok';
          setTimeout(() => {
            if (st && st.textContent === pairHowtoMsg) {
              st.textContent = '';
              st.className = 'settings-note settings-note-tight';
            }
          }, 5000);
        }
      } catch (err) {
        if (st) st.textContent = `Copy failed — type ${code} in the Vodou panel (Settings tab)`;
      }
    };
    const codeEl = panel.querySelector('#mem-pair-code');
    codeEl?.addEventListener('click', () => { void copyPairCode(); });
    codeEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        void copyPairCode();
      }
    });

    panel.querySelector('#mem-pair-rotate')?.addEventListener('click', async () => {
      const st = panel.querySelector('#mem-pair-status');
      const codeEl = panel.querySelector('#mem-pair-code');
      if (st) st.textContent = 'Rotating…';
      try {
        const r = await API.post('/api/capture/pair/rotate', {});
        if (codeEl) codeEl.textContent = r.code || '————';
        if (st) {
          // `kicked` = enforcement is on and the gateway just dropped the old
          // pairing; the extension's panel is showing the pair prompt right now.
          st.textContent = r.kicked
            ? '✓ new code — the extension was disconnected and must re-pair'
            : '✓ new code — applies when pairing is required';
          setTimeout(() => { if (st) st.textContent = ''; }, 5000);
        }
        await repaintPairStatus();
        setTimeout(() => { void repaintPairStatus(); }, 3000);
      } catch (err) {
        if (st) st.textContent = `Failed: ${err.message || err}`;
      }
    });

    panel.querySelector('#mem-pair-require')?.addEventListener('change', async () => {
      const box = panel.querySelector('#mem-pair-require');
      const st = panel.querySelector('#mem-pair-require-status');
      if (!box) return;
      box.disabled = true;
      if (st) st.textContent = 'Saving…';
      try {
        const r = await API.post('/api/capture/pair/require', { required: !!box.checked });
        if (st) {
          st.textContent = r.required ? '✓ required' : '✓ optional';
          setTimeout(() => { if (st) st.textContent = ''; }, 3500);
        }
        // Flipping require KICKS the bridge socket; the extension reconnects on
        // its own within a few seconds, offering its stored code. Repaint from
        // the live endpoint now AND after the dust settles — if the stored code
        // matches, the honest end state is "Connected · paired" with no
        // instructions, because nothing needs doing.
        await repaintPairStatus();
        setTimeout(() => { void repaintPairStatus(); }, 3000);
      } catch (err) {
        box.checked = !box.checked;
        if (st) st.textContent = `Failed: ${err.message || err}`;
      } finally {
        if (box.getAttribute('data-env-locked') !== '1') box.disabled = false;
      }
    });

    panel.querySelectorAll('.mem-vault-preview').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.vault;
        const out = panel.querySelector('#mem-vault-preview');
        if (out) out.textContent = `Previewing “${name}”…`;
        try {
          const r = await API.get(`/api/vaults/${encodeURIComponent(name)}/preview`);
          const preview = r.preview || r;
          const n = preview.total ?? r.count ?? r.chunks
            ?? (Array.isArray(preview.ids) ? preview.ids.length : null)
            ?? (Array.isArray(r.members) ? r.members.length : null);
          if (out) {
            out.textContent = n != null
              ? `“${name}” matches ${Number(n).toLocaleString()} memor${Number(n) === 1 ? 'y' : 'ies'}.`
              : `Preview: ${JSON.stringify(preview).slice(0, 200)}`;
            out.className = 'settings-note settings-note-tight settings-ok';
          }
        } catch (err) {
          if (out) {
            out.textContent = `Preview failed: ${err.message || err}`;
            out.className = 'settings-note settings-note-tight settings-warn';
          }
        }
      });
    });

    // PLAN-PROJECT-VAULTS §4.3 — "Only this project" pre-fills from the ACTIVE
    // project (D1 option B: default the form, don't auto-provision). The pinned
    // picker is lazy: it only fetches when the box is ticked, so the common case
    // (a global vault) costs nothing.
    (() => {
      const cb = panel.querySelector('#mem-vault-only-project');
      const wrap = panel.querySelector('#mem-vault-pinned-wrap');
      const nameEl = panel.querySelector('#mem-vault-project-name');
      const list = panel.querySelector('#mem-vault-pinned-list');
      if (!cb || !wrap) return;
      const activeId = (window.ProjectScope && window.ProjectScope.active()) || null;
      const proj = (this._projectsForVaults || []).find((x) => x.id === activeId);
      // Default is the install root — everything global already lives there, so a
      // "Default vault" would duplicate the whole cabinet under a narrower name.
      const offerable = !!proj && activeId !== 'proj_default';
      if (!offerable) {
        panel.querySelector('#mem-vault-project-row')?.setAttribute('style', 'display:none;');
        return;
      }
      if (nameEl) nameEl.textContent = ' — ' + proj.name;
      let loaded = false;
      cb.addEventListener('change', async () => {
        wrap.style.display = cb.checked ? '' : 'none';
        if (!cb.checked || loaded || !list) return;
        loaded = true;
        try {
          // /api/vaults/scopes, NOT the dock's pinnable-surface list. The dock
          // excludes skill consoles because they are OWNED (one project each) —
          // correct there, wrong here: a vault asks which MEMORY to include, and
          // the console scopes carry most of it. Ranked by chunk count so the
          // choice is made against real numbers.
          const r = await API.get('/api/vaults/scopes');
          const scopes = r.scopes || [];
          list.innerHTML = '';
          if (!scopes.length) { list.textContent = 'No scopes with memory yet.'; return; }
          for (const sc of scopes) {
            const row = document.createElement('label');
            row.className = 'project-skill-row';
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.value = sc.scope;
            box.className = 'mem-vault-pinned-cb';
            const txt = document.createElement('span');
            // COHERENCE F41 — same hand-rolled translation as projects.js had.
            txt.textContent = globalThis.VodouVocabulary.scopeLabel(sc.scope) + '  (' + sc.n + ')';
            row.append(box, txt);
            list.appendChild(row);
          }
        } catch { list.textContent = 'Could not load scopes.'; }
      });
    })();

    panel.querySelector('#mem-vault-create')?.addEventListener('click', async () => {
      const name = (panel.querySelector('#mem-vault-name')?.value || '').trim();
      const tagsRaw = (panel.querySelector('#mem-vault-tags')?.value || '').trim();
      const scopesRaw = (panel.querySelector('#mem-vault-scopes')?.value || '').trim();
      const sinceRaw = (panel.querySelector('#mem-vault-since')?.value || '').trim();
      const includeProfile = !!panel.querySelector('#mem-vault-profile')?.checked;
      const includeImports = !!panel.querySelector('#mem-vault-imports')?.checked;
      const st = panel.querySelector('#mem-vault-create-status');
      const btn = panel.querySelector('#mem-vault-create');
      if (!name) {
        if (st) {
          st.textContent = 'Name required.';
          st.className = 'settings-note settings-note-tight settings-warn';
        }
        return;
      }
      const splitCsv = (s) => s ? s.split(',').map((x) => x.trim()).filter(Boolean) : [];
      const tags = splitCsv(tagsRaw);
      const scopes = splitCsv(scopesRaw);
      const rules = {
        tags,
        scopes,
        include_profile: includeProfile,
        include_imports: includeImports,
      };
      // §4.1/§4.3 — `project` narrows to that project's stamped chunks;
      // `pinned_scopes` UNIONs the ticked surfaces onto that leg (it is ignored
      // server-side without a project, so the two travel together).
      const onlyProject = panel.querySelector('#mem-vault-only-project');
      if (onlyProject && onlyProject.checked) {
        const pid = (window.ProjectScope && window.ProjectScope.active()) || null;
        if (pid) {
          rules.project = pid;
          const picked = Array.from(panel.querySelectorAll('.mem-vault-pinned-cb'))
            .filter((c) => c.checked).map((c) => c.value);
          if (picked.length) rules.pinned_scopes = picked;
        }
      }
      if (sinceRaw) {
        const d = Number(sinceRaw);
        if (!Number.isFinite(d) || d < 1) {
          if (st) {
            st.textContent = 'Since days must be a positive number.';
            st.className = 'settings-note settings-note-tight settings-warn';
          }
          return;
        }
        rules.since_days = Math.floor(d);
      }
      if (st) {
        st.textContent = 'Creating…';
        st.className = 'settings-note settings-note-tight';
      }
      if (btn) btn.disabled = true;
      try {
        await API.post('/api/vaults', { name, rules });
        sessionStorage.setItem('vodou.vault.createFlash', name);
        await this._loadMemoryPanel();
      } catch (err) {
        if (st) {
          st.textContent = `Failed: ${err.message || err}`;
          st.className = 'settings-note settings-note-tight settings-warn';
        }
        if (btn) btn.disabled = false;
      }
    });

    const flashName = sessionStorage.getItem('vodou.vault.createFlash');
    if (flashName) {
      sessionStorage.removeItem('vodou.vault.createFlash');
      const st = panel.querySelector('#mem-vault-create-status');
      if (st) {
        st.textContent = `✓ Created “${flashName}”. Use Preview to see what it includes.`;
        st.className = 'settings-note settings-note-tight settings-ok';
      }
    }

    panel.querySelector('#memext-save')?.addEventListener('click', async () => {
      const sel = panel.querySelector('#memext-override');
      const modelSel = panel.querySelector('#memext-model');
      const val = sel?.value || '';
      const modelVal = modelSel?.value || '';
      const saveStatus = panel.querySelector('#memext-save-status');
      if (saveStatus) { saveStatus.textContent = 'Saving…'; saveStatus.className = 'settings-note settings-note-tight'; }
      try {
        const r = await API.post('/api/memory/extractor/set-backend', {
          provider: val || null,
          model: modelVal || null,
        });
        if (saveStatus) {
          const follow = r.follow_chat ? ' (following chat model)' : '';
          saveStatus.textContent = `Saved — ${r.effective_provider || val || 'toml'} / ${r.effective_model || '—'}${follow}`;
          saveStatus.className = 'settings-note settings-note-tight settings-ok';
        }
        SettingsView._updateMemextEffective(panel, r);
      } catch (e) {
        if (saveStatus) {
          saveStatus.textContent = 'Failed: ' + (e.message || e);
          saveStatus.className = 'settings-note settings-note-tight settings-warn';
        }
      }
    });

    panel.querySelector('#memext-clear')?.addEventListener('click', async () => {
      const sel = panel.querySelector('#memext-override');
      const modelSel = panel.querySelector('#memext-model');
      if (sel) sel.value = '';
      if (modelSel) modelSel.value = '';
      panel.querySelector('#memext-save')?.click();
    });

    panel.querySelector('#memext-override')?.addEventListener('change', () => {
      void SettingsView._loadMemextModels(panel);
    });
    panel.querySelector('#memext-model-refresh')?.addEventListener('click', () => {
      void SettingsView._loadMemextModels(panel, true);
    });

    // Seed model list + effective line from status already on panel context
    void SettingsView._initMemextModelUi(panel, this._memoryCtx?.status);

    panel.querySelector('#memext-bench-run')?.addEventListener('click', async () => {
      const backend = panel.querySelector('#memext-bench-backend')?.value || '';
      const reference = panel.querySelector('#memext-bench-reference')?.value || '';
      const benchStatus = panel.querySelector('#memext-bench-status');
      const resultsEl = panel.querySelector('#memext-bench-results');
      const btn = panel.querySelector('#memext-bench-run');
      if (!backend) { if (benchStatus) benchStatus.textContent = 'Pick a test backend first.'; return; }
      if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
      if (benchStatus) { benchStatus.textContent = 'Running 50 prompts…'; benchStatus.className = 'settings-note settings-note-tight'; }
      if (resultsEl) resultsEl.style.display = 'none';
      try {
        const body = reference ? { backend, reference } : { backend };
        const report = await API.post('/api/memory/extractor/bench', body);
        if (benchStatus) {
          benchStatus.textContent = `${report.passed}/${report.total} passed (${(report.pass_rate * 100).toFixed(0)}%) — ${report.pass ? 'PASS' : 'FAIL'}`;
          benchStatus.className = 'settings-note settings-note-tight ' + (report.pass ? 'settings-ok' : 'settings-warn');
        }
        if (resultsEl) {
          resultsEl.style.display = '';
          resultsEl.innerHTML = SettingsView._renderBenchResults(report);
        }
      } catch (e) {
        if (benchStatus) {
          benchStatus.textContent = 'Benchmark failed: ' + (e.message || e);
          benchStatus.className = 'settings-note settings-note-tight settings-warn';
        }
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Run benchmark'; }
      }
    });
  },

  _updateMemextEffective(panel, info) {
    const el = panel.querySelector('#memext-effective');
    if (!el || !info) return;
    const follow = info.follow_chat ? ' · following chat' : '';
    const chat = info.chat?.provider
      ? ` · chat is ${info.chat.provider}/${info.chat.model || '—'}`
      : '';
    el.textContent = `Effective now: ${info.effective_provider || '—'} → ${info.effective_lane || info.effective_provider || '—'} / ${info.effective_model || '—'}${follow}${chat}`;
  },

  async _initMemextModelUi(panel, status) {
    const modelSel = panel.querySelector('#memext-model');
    if (modelSel && status?.model_override) {
      // Ensure current override appears even before catalog loads
      const opt = document.createElement('option');
      opt.value = status.model_override;
      opt.textContent = status.model_override;
      opt.selected = true;
      modelSel.appendChild(opt);
    }
    this._updateMemextEffective(panel, status);
    await this._loadMemextModels(panel, false, status);
  },

  async _loadMemextModels(panel, refresh, statusHint) {
    const provSel = panel.querySelector('#memext-override');
    const modelSel = panel.querySelector('#memext-model');
    const modelRow = panel.querySelector('#memext-model-row');
    if (!modelSel) return;

    let provider = (provSel?.value || '').trim();
    // Empty override → effective from status / auto
    let catalog = statusHint?.catalog_provider || '';
    let currentOverride = statusHint?.model_override || (modelSel.value || '');
    try {
      if (!statusHint || refresh || !catalog) {
        const st = await API.get('/api/memory/extractor/status');
        // Preview: if user changed provider dropdown but hasn't saved, resolve catalog from dropdown
        if (provider) {
          catalog = provider === 'auto' || provider === 'gateway'
            ? (st.chat?.provider || st.catalog_provider || 'anthropic')
            : (provider === 'claude' ? 'claude-cli' : provider);
        } else {
          catalog = st.catalog_provider || st.chat?.provider || '';
          currentOverride = st.model_override || '';
        }
        this._updateMemextEffective(panel, {
          ...st,
          effective_provider: provider || st.effective_provider,
          effective_lane: catalog,
        });
      }
    } catch { /* keep prior */ }

    if (!provider) provider = statusHint?.effective_provider || 'auto';
    if (provider === 'heuristic') {
      if (modelRow) modelRow.style.display = 'none';
      return;
    }
    if (modelRow) modelRow.style.display = '';

    if (!catalog || catalog === 'heuristic') {
      modelSel.innerHTML = '<option value="">Follow chat model (live)</option>';
      return;
    }

    const prev = currentOverride || modelSel.value || '';
    modelSel.innerHTML = '<option value="">Follow chat model (live)</option>';
    try {
      const qs = refresh ? '?refresh=1' : '';
      const result = await API.get('/api/settings/models/' + encodeURIComponent(catalog) + qs);
      const models = result.models || [];
      const vals = models.map((m) => (typeof m === 'object' ? m.value : m));
      for (let i = 0; i < models.length; i++) {
        const m = models[i];
        const val = vals[i];
        const label = typeof m === 'object' ? m.label : m;
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = label;
        if (val === prev) opt.selected = true;
        modelSel.appendChild(opt);
      }
      if (prev && !vals.includes(prev)) {
        const opt = document.createElement('option');
        opt.value = prev;
        opt.textContent = prev + ' (saved)';
        opt.selected = true;
        modelSel.appendChild(opt);
      }
      if (!prev) modelSel.value = '';
    } catch (err) {
      console.error('memext models:', err);
    }
  },

  _renderBenchResults(report) {
    const rows = (report.rows || []).map(r => {
      const cos = r.cosine != null ? `<code>${r.cosine.toFixed(3)}</code>` : '—';
      const status = r.ok ? '<span class="settings-ok">✓</span>' : '<span class="settings-warn">✗</span>';
      return `<tr>
        <td>${status}</td>
        <td><code>${SettingsView._esc(r.category)}</code></td>
        <td><code>${SettingsView._esc(r.name)}</code></td>
        <td>${r.bullet_count}</td>
        <td>${r.has_why ? '✓' : ''}</td>
        <td>${r.has_how ? '✓' : ''}</td>
        <td>${cos}</td>
        <td>${r.elapsed_ms}ms</td>
      </tr>`;
    }).join('');
    return `<table class="settings-bench-table">
      <thead><tr><th></th><th>cat</th><th>name</th><th>bullets</th><th>why</th><th>how</th><th>cos</th><th>t</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  },

  // ── Attached clients (PLAN-MCP-EGRESS-MEMORY T2) ───────────────────────────
  //
  // The opposite direction from Settings → Servers: that page is what Vodou connects
  // TO, this one is what has connected to Vodou. Two lists, because they are two
  // different things — an HTTP client holds a token of its own and can be revoked
  // here; a stdio client gets its own process and carries no token, so it can only
  // ever be detached from its own config file.

  /** Stored instants are naive UTC ('YYYY-MM-DD HH:MM:SS') — parse as UTC, show local. */
  _whenLocal(s) {
    if (!s) return '';
    const d = new Date(String(s).replace(' ', 'T') + 'Z');
    return isNaN(d.getTime()) ? '' : d.toLocaleString();
  },

  _sinceLabel(s) {
    if (!s) return 'never';
    const d = new Date(String(s).replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return 'never';
    const mins = Math.floor((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  },

  async _loadClientsPanel() {
    const panel = document.getElementById('settings-panel-clients');
    if (!panel) return;
    try {
      const data = await API.get('/api/mcp/clients');
      this._renderClientsPanel(panel, data);
    } catch (err) {
      panel.innerHTML = `<div class="empty-state">Could not load attached clients: ${this._esc(err.message || String(err))}</div>`;
    }
  },

  _renderClientsPanel(panel, data) {
    const clients = data.clients || [];
    const targets = data.targets || [];
    const active = clients.filter(c => !c.revoked);
    const revoked = clients.filter(c => c.revoked);
    const attached = targets.filter(t => t.attached);

    // The ceiling chip. The engine resolves the default/opt-out distinction
    // (effective_rate_limit_per_min); the view only words it. Older engines predate the
    // field entirely — show nothing rather than guess.
    const limitChip = (c) => {
      if (c.effective_rate_limit_per_min === undefined) return '';
      if (c.effective_rate_limit_per_min === null) {
        return `<code style="font-size:12px;opacity:.75;">unlimited</code>`;
      }
      const isDefault = c.rate_limit_per_min === null || c.rate_limit_per_min === undefined;
      return `<code style="font-size:12px;opacity:.75;" title="${isDefault ? 'Default ceiling — set per client with: mcp install <client> --http --rate-limit N' : 'Set for this client'}">${c.effective_rate_limit_per_min}/min${isDefault ? '' : ' ·set'}</code>`;
    };

    const row = (c) => `
      <div class="settings-row settings-row-gap-sm" style="align-items:center;gap:12px;flex-wrap:wrap;">
        <span class="settings-current-label settings-label-fixed">${this._esc(c.label || c.client_id)}</span>
        <code style="font-size:12px;opacity:.75;">${this._esc(c.profile)}</code>
        <code style="font-size:12px;opacity:.75;">vault: ${this._esc(c.vault)}</code>
        ${limitChip(c)}
        <span style="font-size:12px;color:var(--text-muted,#888);">last seen ${this._esc(this._sinceLabel(c.last_seen_at))}</span>
        ${c.revoked
          ? `<span style="font-size:12px;color:var(--text-muted,#888);">revoked ${this._esc(this._whenLocal(c.revoked_at))}</span>`
          : `<button type="button" class="btn btn-sm" data-revoke="${this._esc(c.client_id)}">Revoke</button>`}
      </div>`;

    const targetRow = (t) => `
      <div class="settings-row settings-row-gap-sm" style="align-items:center;gap:12px;flex-wrap:wrap;">
        <span class="settings-current-label settings-label-fixed">${this._esc(t.label)}</span>
        <code style="font-size:12px;opacity:.75;">${this._esc(t.transport || 'stdio')}</code>
        <span style="font-size:12px;color:var(--text-muted,#888);">${t.registered ? 'own token' : 'no token — owner access'}</span>
      </div>`;

    panel.innerHTML = `
      <div class="settings-section">
        <p class="settings-note settings-note-block-sm">
          Apps that have attached to Vodou and use its memory, skills, and connected tools.
          This is the opposite of <a href="#/capabilities?tab=tools" style="color:var(--accent,#2563eb);text-decoration:underline;">Servers</a>, which is what Vodou connects to.
        </p>
      </div>

      <div class="settings-section">
        <h3 class="settings-subhead">Attached clients</h3>
        ${active.length
          ? active.map(row).join('')
          : `<p class="settings-note settings-note-block-sm">No app holds its own key yet. Attach one and it appears here:</p>
             <pre style="margin:0;padding:10px;border-radius:6px;background:var(--bg-elev,rgba(127,127,127,.08));font-size:12px;overflow-x:auto;">vodou-core mcp install cursor --http --profile memory --vault portable</pre>`}
        <p class="settings-note settings-note-block-sm">
          Each client gets a key of its own, so revoking one leaves the others working.
          The key itself is never stored here — only a fingerprint of it.
        </p>
      </div>

      ${revoked.length ? `
      <div class="settings-section">
        <h3 class="settings-subhead">Revoked</h3>
        ${revoked.map(row).join('')}
        <p class="settings-note settings-note-block-sm">Re-attaching a client issues a new key and brings it back.</p>
      </div>` : ''}

      <div class="settings-section">
        <h3 class="settings-subhead">Apps configured to connect</h3>
        ${attached.length
          ? attached.map(targetRow).join('')
          : `<p class="settings-note settings-note-block-sm">No app config points at Vodou yet. Run <code>vodou-core mcp install</code> to see which ones were found.</p>`}
        <p class="settings-note settings-note-block-sm">
          Apps that launch Vodou themselves need no key — they get their own process, and
          their scope is set on the command line.
        </p>
      </div>

      <div class="settings-section">
        <h3 class="settings-subhead">What they did</h3>
        <div class="settings-row settings-row-gap-sm" style="gap:10px;align-items:center;">
          <label style="font-size:12px;display:flex;align-items:center;gap:6px;cursor:pointer;">
            <input type="checkbox" id="mcp-audit-flagged-only"> refused & limited only
          </label>
        </div>
        <div id="mcp-audit-table"><p class="settings-note settings-note-block-sm">Loading…</p></div>
        <p class="settings-note settings-note-block-sm">
          What each attached app called, and whether it was served, refused by its profile,
          or stopped at its rate ceiling. What was <em>asked</em> is not recorded — the log
          keeps a fingerprint of the arguments, never their text. Kept 30 days.
        </p>
      </div>`;

    panel.querySelectorAll('button[data-revoke]').forEach(btn => {
      btn.addEventListener('click', () => this._revokeClient(btn));
    });
    const flaggedOnly = panel.querySelector('#mcp-audit-flagged-only');
    if (flaggedOnly) {
      flaggedOnly.addEventListener('change', () => this._loadClientsAudit(flaggedOnly.checked));
    }
    this._loadClientsAudit(false);
  },

  async _loadClientsAudit(flaggedOnly) {
    const el = document.getElementById('mcp-audit-table');
    if (!el) return;
    try {
      const data = await API.get('/api/mcp/clients/audit?limit=50');
      let calls = data.calls || [];
      // "Flagged" is refused + limited. The engine's --denied filter is denied-only, so
      // filter both here from the one response instead of a second CLI spawn.
      if (flaggedOnly) calls = calls.filter(c => c.outcome === 'denied' || c.outcome === 'limited');
      if (!calls.length) {
        el.innerHTML = `<p class="settings-note settings-note-block-sm">${flaggedOnly ? 'Nothing has been refused or rate-limited.' : 'No calls recorded yet — attached apps appear here as soon as they use a tool.'}</p>`;
        return;
      }
      const outcomeChip = (o) => {
        const colors = { ok: 'var(--text-muted,#888)', denied: '#d97706', limited: '#d97706', error: '#dc2626' };
        return `<span style="font-size:11px;color:${colors[o] || 'inherit'};">${this._esc(o)}</span>`;
      };
      // 30-day totals, flagged outcomes first so "cursor: 3 denied" is not buried
      // under a big ok-count.
      const totals = {};
      for (const s of (data.summary || [])) {
        totals[s.outcome] = (totals[s.outcome] || 0) + s.count;
      }
      const order = ['denied', 'limited', 'error', 'ok'];
      const summaryLine = order.filter(o => totals[o]).map(o => `${totals[o]} ${o}`).join(' · ');
      el.innerHTML = `
        ${summaryLine ? `<p class="settings-note settings-note-block-sm" style="margin-bottom:6px;">Last 30 days: ${this._esc(summaryLine)}</p>` : ''}
        <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead><tr style="text-align:left;color:var(--text-muted,#888);">
            <th style="padding:4px 8px;">When</th><th style="padding:4px 8px;">Client</th>
            <th style="padding:4px 8px;">Tool</th><th style="padding:4px 8px;">Outcome</th>
            <th style="padding:4px 8px;text-align:right;">ms</th>
          </tr></thead>
          <tbody>
            ${calls.map(c => `
              <tr style="border-top:1px solid var(--border,rgba(127,127,127,.15));">
                <td style="padding:4px 8px;white-space:nowrap;" title="${this._esc(this._whenLocal(c.at))}">${this._esc(this._sinceLabel(c.at))}</td>
                <td style="padding:4px 8px;">${this._esc(c.label || c.client_id)}<span style="opacity:.5;"> · ${this._esc(c.transport)}</span></td>
                <td style="padding:4px 8px;"><code style="font-size:11px;">${this._esc(c.tool)}</code></td>
                <td style="padding:4px 8px;">${outcomeChip(c.outcome)}</td>
                <td style="padding:4px 8px;text-align:right;color:var(--text-muted,#888);">${c.duration_ms == null ? '—' : this._esc(String(c.duration_ms))}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        </div>`;
    } catch (err) {
      el.innerHTML = `<p class="settings-note settings-note-block-sm">Could not load activity: ${this._esc(err.message || String(err))}</p>`;
    }
  },

  async _revokeClient(btn) {
    const id = btn.dataset.revoke;
    if (!id) return;
    if (!confirm(`Revoke ${id}?\n\nIt loses access immediately. Every other client keeps working, and you can re-attach it later.`)) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Revoking…';
    try {
      const r = await API.post(`/api/mcp/clients/${encodeURIComponent(id)}/revoke`, {});
      if (r && r.revoked === false) {
        // Already revoked by someone else, or gone. Nothing broke — just re-read.
        btn.textContent = 'Already revoked';
      }
      await this._loadClientsPanel();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = label;
      alert(`Could not revoke ${id}: ${err.message || err}`);
    }
  },

  async _loadAboutPanel() {
    const panel = document.getElementById('settings-panel-about');
    if (!panel) return;
    try {
      const [data, settings] = await Promise.all([API.get('/api/system'), API.get('/api/settings')]);
      const cfg = data.configured ? 'Ready' : 'Not fully configured';
      const telemetryOn = settings.usage_telemetry_enabled !== 'false' && settings.usage_telemetry_enabled !== '0';
      panel.innerHTML = `
        <div class="settings-section">
          <div class="settings-row settings-row-gap-sm"><span class="settings-current-label settings-label-fixed">Version</span><span>${data.version || '—'}</span></div>
          <div class="settings-row settings-row-gap-sm"><span class="settings-current-label settings-label-fixed">Auth</span><span>${data.authMode || '—'}</span></div>
          <div class="settings-row settings-row-gap-md"><span class="settings-current-label settings-label-fixed">Status</span><span>${cfg}</span></div>
          <p class="settings-note settings-note-block-sm">Diagnostics, uptime, and database counts live on System.</p>
          <a href="#/system" class="btn btn-primary btn-link-inline">Open System status</a>
        </div>
        <div class="settings-section">
          <h3 class="settings-subhead">Usage Analytics</h3>
          <p class="settings-note settings-note-block-sm">Vodou sends anonymous usage data (tool names, timing, errors) to <strong>app.vodou.ai</strong> to track reliability and improve the product. No message content or API keys are ever sent.</p>
          <div class="settings-row" style="align-items:center;gap:10px;">
            <input type="checkbox" id="telemetry-toggle" style="margin:0;" ${telemetryOn ? 'checked' : ''}>
            <label for="telemetry-toggle" style="margin:0;cursor:pointer;">Send usage analytics to Vodou</label>
            <span id="telemetry-status" style="font-size:12px;color:var(--text-muted,#888);margin-left:4px;"></span>
          </div>
        </div>`;

      const toggle = panel.querySelector('#telemetry-toggle');
      const status = panel.querySelector('#telemetry-status');
      toggle?.addEventListener('change', async () => {
        toggle.disabled = true;
        if (status) status.textContent = 'Saving…';
        try {
          await API.post('/api/settings', { usage_telemetry_enabled: toggle.checked ? 'true' : 'false' });
          if (status) {
            status.textContent = toggle.checked ? '✓ enabled' : '✓ disabled';
            setTimeout(() => { if (status) status.textContent = ''; }, 1500);
          }
        } catch (err) {
          toggle.checked = !toggle.checked;
          if (status) status.textContent = `Failed: ${err.message || 'error'}`;
        } finally {
          toggle.disabled = false;
        }
      });
    } catch (err) {
      panel.innerHTML = `<div class="empty-state">Could not load version: ${err.message}</div>`;
    }
  },

  _renderModelPanel() {
    const d = this._data;
    const el = document.getElementById('settings-panel-model');
    if (!el) return;

    const providerCards = d.available_providers.map(p => this._renderProviderCard(p, d)).join('');

    const activeP = d.available_providers.find(p => p.status === 'active');
    const activeLabel = activeP ? activeP.name : 'None';
    const activeModel =
      d.provider === 'claude-cli' ? d.cli_model
        : d.provider === 'kimi-cli' ? d.kimi_cli_model
          : d.provider === 'kimi' ? d.kimi_model
            : d[d.provider + '_model'] || d.claude_model || '';
    // Show just the model name, not the full provider path
    // (accounts/fireworks/models/kimi-k2p6 → kimi-k2p6).
    const activeModelShort = activeModel ? String(activeModel).split('/').pop() : '';

    el.innerHTML = `
      <div class="settings-current">
        <span class="settings-current-label">Active Provider</span>
        <span class="settings-current-value">${activeLabel}${activeModelShort ? ' — ' + activeModelShort : ''}</span>
      </div>

      <div class="settings-grid">
        ${providerCards}
      </div>

      <div class="settings-section settings-section-spaced">
        <h3 class="settings-subhead">Advanced</h3>
        <div class="settings-row">
          <label>Max Tokens</label>
          <input type="number" id="settings-max-tokens" value="${d.max_tokens || ''}" placeholder="Provider default" class="settings-input settings-input-sm">
        </div>
        <p class="settings-note">Applies to all providers except Claude CLI, which manages its own token limits.</p>
        <div class="settings-actions-top">
          <button class="btn btn-primary" onclick="SettingsView._saveAdvanced()">Save Advanced Settings</button>
        </div>
      </div>
    `;

    ['vodou', 'claude-cli', 'kimi-cli', 'anthropic', 'kimi', 'openai', 'google', 'groq', 'deepseek', 'xai', 'mistral', 'openrouter', 'fireworks', 'together', 'ollama', 'lmstudio', 'llamacpp'].forEach(p => this._fetchModels(p, true));
    this._loadVodouUsage();

    // Hardware-aware recommendation strips (llmfit). No-ops if unavailable /
    // bucket empty — static model lists stand. Vodou Local uses `gguf`.
    if (window.ModelFitStrip) {
      ModelFitStrip.mount('modelfit-ollama', {
        bucket: 'ollama',
        current: d.ollama_model || '',
        onSelect: (ref) => this._setModelValue('provider-ollama-model', ref),
      });
      // LM Studio → MLX picks (native on Apple Silicon); llama.cpp → GGUF picks.
      ModelFitStrip.mount('modelfit-lmstudio', {
        bucket: 'mlx',
        current: d.lmstudio_model || '',
        onSelect: (ref) => this._setModelValue('provider-lmstudio-model', ref),
      });
      ModelFitStrip.mount('modelfit-llamacpp', {
        bucket: 'gguf',
        current: d.llamacpp_model || '',
        onSelect: (ref) => this._setModelValue('provider-llamacpp-model', ref),
      });
    }
    // Downloaded-model cache readout for the Vodou Local card.
    this._loadLlamaCppCache();
  },

  /**
   * Set a model combo (select + custom input) to a value programmatically.
   * If the value is one of the preset options, select it; otherwise switch the
   * combo to "Other" and put the value in the custom input. Mirrors the manual
   * paths in _getModelValue / _onModelChange.
   */
  async _stopLlamaCpp() {
    const statusEl = document.getElementById('llamacpp-status');
    try {
      const r = await API.post('/api/settings/llamacpp/stop', {});
      if (statusEl) statusEl.textContent = r.stopped ? 'Stopped.' : 'Not running.';
    } catch (err) {
      if (statusEl) statusEl.textContent = 'Stop failed: ' + (err?.message || err);
    }
  },

  async _loadLlamaCppCache() {
    const infoEl = document.getElementById('llamacpp-cache-info');
    const btnEl = document.getElementById('llamacpp-clear-btn');
    if (!infoEl) return;
    try {
      const c = await API.get('/api/settings/llamacpp/cache');
      const n = (c.models || []).length;
      if (!n) {
        infoEl.textContent = 'No models downloaded yet.';
        if (btnEl) btnEl.disabled = true;
      } else {
        infoEl.textContent = `Downloaded: ${n} model${n > 1 ? 's' : ''} · ${c.totalHuman}`;
        infoEl.title = (c.models || []).map(m => `${m.name} (${m.sizeHuman})`).join('\n');
        if (btnEl) btnEl.disabled = false;
      }
    } catch {
      infoEl.textContent = '';
    }
  },

  async _clearLlamaCppCache() {
    const infoEl = document.getElementById('llamacpp-cache-info');
    if (!confirm('Delete all downloaded llama.cpp model weights? They will re-download on next use. (Your other AI models are not affected.)')) return;
    if (infoEl) infoEl.textContent = 'Clearing…';
    try {
      const r = await API.post('/api/settings/llamacpp/cache/clear', {});
      if (infoEl) infoEl.textContent = `Cleared ${(r.cleared || []).length} model(s).`;
      setTimeout(() => this._loadLlamaCppCache(), 800);
    } catch (err) {
      if (infoEl) infoEl.textContent = 'Clear failed: ' + (err?.message || err);
    }
  },

  _setModelValue(id, value) {
    const select = document.getElementById(id);
    const custom = document.getElementById(id + '-custom');
    if (!select) return;
    const hasOption = Array.from(select.options).some(o => o.value === value);
    if (hasOption) {
      select.value = value;
      if (custom) { custom.classList.add('is-hidden'); custom.value = ''; }
    } else {
      select.value = '__other__';
      if (custom) { custom.classList.remove('is-hidden'); custom.value = value; }
    }
  },

  /**
   * Build a model selector: <select> with an "Other..." option that reveals a text input.
   */
  _modelCombo(id, value, suggestions, disabled) {
    const vals = suggestions.map(m => typeof m === 'object' ? m.value : m);
    const labels = suggestions.map(m => typeof m === 'object' ? m.label : m);
    const isCustom = value && !vals.includes(value);

    let options = suggestions.map((m, i) => {
      const val = vals[i];
      const label = labels[i];
      return `<option value="${val}" ${val === value ? 'selected' : ''}>${label}</option>`;
    }).join('');
    options += `<option value="__other__" ${isCustom ? 'selected' : ''}>Other (type model name)...</option>`;

    return `<select id="${id}" class="settings-input" ${disabled ? 'disabled' : ''} onchange="SettingsView._onModelChange('${id}')">${options}</select>
      <input type="text" id="${id}-custom" class="settings-input settings-input-custom ${isCustom ? '' : 'is-hidden'}" placeholder="Enter model name..." value="${isCustom ? value : ''}">
      <datalist id="${id}-list"></datalist>`;
  },

  _onModelChange(id) {
    const select = document.getElementById(id);
    const customInput = document.getElementById(id + '-custom');
    if (!select || !customInput) return;
    if (select.value === '__other__') {
      customInput.classList.remove('is-hidden');
      customInput.focus();
    } else {
      customInput.classList.add('is-hidden');
      customInput.value = '';
      // Auto-save if this is the active provider
      const card = select.closest('.provider-card');
      if (card?.classList.contains('active')) {
        this._activateProvider(card.dataset.provider);
      }
    }
  },

  /**
   * Get the actual model value from a combo (select + custom input).
   */
  _getModelValue(id) {
    const select = document.getElementById(id);
    if (!select) return '';
    if (select.value === '__other__') {
      const custom = document.getElementById(id + '-custom');
      return custom?.value || '';
    }
    return select.value;
  },

  _renderProviderCard(provider, data) {
    const isActive = provider.status === 'active';
    const isConfigured = provider.status === 'configured';
    const statusDot = isActive ? 'status-active' : isConfigured ? 'status-configured' : 'status-unconfigured';
    const statusLabel = isActive ? 'Active' : isConfigured ? 'Configured' : '';
    const expandedClass = isActive ? 'expanded' : '';

    let fields = '';
    switch (provider.id) {
      case 'vodou': {
        const vodouModels = [
          { value: 'accounts/fireworks/models/kimi-k2p6', label: 'Vodou Standard (Kimi K2.6)' },
          { value: 'accounts/fireworks/models/kimi-k2p7-code', label: 'Vodou Coding (Kimi K2.7 Code)' },
          { value: 'accounts/fireworks/models/deepseek-v4-pro', label: 'Vodou Pro (DeepSeek V4)' },
          { value: 'accounts/fireworks/models/deepseek-v4-flash', label: 'Vodou Fast (DeepSeek Flash)' },
          { value: 'accounts/fireworks/models/gpt-oss-120b', label: 'Vodou Lite (GPT-OSS 120B)' },
        ];
        fields = `
          <div class="cli-status-card cli-status-inline">
            <div class="cli-status-content">
              <div class="cli-status-title text-sm">Included in your Vodou plan</div>
              <div class="cli-status-desc cli-status-desc-top">No API key needed — Vodou runs the model for you and usage counts against your monthly plan limit.</div>
            </div>
          </div>
          <div id="vodou-usage" class="provider-field">
            <label>Plan usage</label>
            <div id="vodou-usage-body" class="settings-note">Loading usage…</div>
          </div>
          <div class="provider-field">
            <label>Model</label>
            <div class="flex gap-2">
              <div class="flex-1">
                ${this._modelCombo('provider-vodou-model', data.vodou_model || 'accounts/fireworks/models/kimi-k2p6', vodouModels)}
              </div>
              <button class="btn btn-small provider-refresh-btn" onclick="SettingsView._fetchModels('vodou')" title="Refresh model list">Refresh</button>
            </div>
          </div>`;
        break;
      }
      case 'claude-cli': {
        const cli = data.claude_cli_status || {};
        let statusHtml = '';

        if (!cli.installed) {
          statusHtml = `
            <div class="cli-status-card cli-status-missing">
              <div class="cli-status-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
              </div>
              <div class="cli-status-content">
                <div class="cli-status-title">Claude CLI not found</div>
                <div class="cli-status-desc">Install it to use your Max subscription</div>
                <code class="cli-install-cmd cli-install-cmd-select">${window.VODOU_OS === 'windows' ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash'}</code>
                ${window.VODOU_OS === 'windows' ? '<div class="cli-status-desc">Run in PowerShell, then open a new window (PATH refresh).</div>' : ''}
                <a href="#/terminal" class="cli-open-terminal">Open Terminal to install</a>
              </div>
            </div>`;
        } else if (!cli.authenticated) {
          statusHtml = `
            <div class="cli-status-card cli-status-auth">
              <div class="cli-status-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
              </div>
              <div class="cli-status-content">
                <div class="cli-status-title">Authentication needed</div>
                <div class="cli-status-desc">Run <code>claude</code> once to sign in with your Max subscription</div>
                <a href="#/terminal" class="cli-open-terminal">Open Terminal to authenticate</a>
              </div>
            </div>`;
        } else {
          statusHtml = `
            <div class="cli-status-card cli-status-ready">
              <div class="cli-status-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              </div>
              <div class="cli-status-content">
                <div class="cli-status-title">Ready</div>
                <div class="cli-status-desc">${cli.version || 'Installed and authenticated'}</div>
              </div>
            </div>`;
        }

        const cliDisabled = !cli.installed || !cli.authenticated;
        fields = `
          ${statusHtml}
          <div class="provider-field provider-field-top">
            <label>LLM/Model</label>
            <div class="flex gap-2">
              <div class="flex-1">
                ${this._modelCombo('provider-claude-cli-model', data.cli_model || 'sonnet', ['fable', 'opus', 'sonnet', 'haiku'], cliDisabled)}
              </div>
              <button class="btn btn-small provider-refresh-btn" onclick="SettingsView._fetchModels('claude-cli')" title="Refresh model list">Refresh</button>
            </div>
          </div>`;
        break;
      }
      case 'kimi-cli': {
        const kc = data.kimi_cli_status || {};
        let statusHtml = '';
        if (!kc.installed) {
          statusHtml = `
            <div class="cli-status-card cli-status-missing">
              <div class="cli-status-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
              </div>
              <div class="cli-status-content">
                <div class="cli-status-title">Kimi CLI not found</div>
                <div class="cli-status-desc">${window.VODOU_OS === 'windows' ? 'Kimi Code CLI is not yet available on Windows — use Kimi (Moonshot API) instead' : 'Install Moonshot Kimi Code CLI for terminal + OAuth'}</div>
                ${window.VODOU_OS === 'windows' ? '' : `<code class="cli-install-cmd cli-install-cmd-select">curl -LsSf https://code.kimi.com/install.sh | bash</code>
                <a href="#/terminal" class="cli-open-terminal">Open Terminal to install</a>`}
              </div>
            </div>`;
        } else {
          statusHtml = `
            <div class="cli-status-card cli-status-ready">
              <div class="cli-status-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              </div>
              <div class="cli-status-content">
                <div class="cli-status-title">Binary found</div>
                <div class="cli-status-desc">${kc.version || 'Run `kimi login` if chat fails'}</div>
              </div>
            </div>`;
        }
        const kcDisabled = !kc.installed;
        fields = `
          ${statusHtml}
          <div class="provider-field provider-field-top">
            <label>LLM/Model</label>
            <div class="flex gap-2">
              <div class="flex-1">
                ${this._modelCombo('provider-kimi-cli-model', data.kimi_cli_model || 'kimi-k3', [
                  'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code:batch', 'kimi-k2.7-code-highspeed', 'kimi-k2.6', 'kimi-k2.5',
                  'moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k',
                  'moonshot-v1-128k-vision-preview', 'moonshot-v1-32k-vision-preview',
                ], kcDisabled)}
              </div>
              <button class="btn btn-small provider-refresh-btn" onclick="SettingsView._fetchModels('kimi-cli')" title="Refresh model list">Refresh</button>
            </div>
          </div>`;
        break;
      }
      case 'anthropic':
        fields = `
          <div class="provider-field">
            <label>API Key</label>
            <input type="password" id="provider-anthropic-key" placeholder="sk-ant-..." value="" class="settings-input" autocomplete="off">
            <small class="settings-note">${data.anthropic_api_key || 'Not set'}</small>
          </div>
          <div class="provider-field">
            <label>LLM/Model</label>
            <div class="flex gap-2">
              <div class="flex-1">
                ${this._modelCombo('provider-anthropic-model', data.claude_model || 'claude-sonnet-4-20250514', [
                  { value: 'claude-fable-5', label: 'Fable 5 (claude-fable-5)' },
                  { value: 'claude-opus-4-6', label: 'Opus 4.6 (claude-opus-4-6)' },
                  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (claude-sonnet-4-6)' },
                  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (claude-haiku-4-5)' },
                  { value: 'claude-opus-4-20250514', label: 'Opus 4 (claude-opus-4)' },
                  { value: 'claude-sonnet-4-20250514', label: 'Sonnet 4 (claude-sonnet-4)' },
                  { value: 'claude-3-5-sonnet-20241022', label: 'Sonnet 3.5 (claude-3-5-sonnet)' },
                  { value: 'claude-3-5-haiku-20241022', label: 'Haiku 3.5 (claude-3-5-haiku)' },
                  { value: 'claude-3-opus-20240229', label: 'Opus 3 (claude-3-opus)' },
                  { value: 'claude-3-sonnet-20240229', label: 'Sonnet 3 (claude-3-sonnet)' },
                  { value: 'claude-3-haiku-20240307', label: 'Haiku 3 (claude-3-haiku)' },
                ])}
              </div>
              <button class="btn btn-small provider-refresh-btn" onclick="SettingsView._fetchModels('anthropic')" title="Refresh model list">Refresh</button>
            </div>
          </div>`;
        break;
      case 'openai':
        fields = `
          <div class="provider-field">
            <label>API Key</label>
            <input type="password" id="provider-openai-key" placeholder="sk-..." value="" class="settings-input" autocomplete="off">
            <small class="settings-note">${data.openai_api_key || 'Not set'}</small>
          </div>
          <div class="provider-field">
            <label>LLM/Model</label>
            <div class="flex gap-2">
              <div class="flex-1">
                ${this._modelCombo('provider-openai-model', data.openai_model || 'gpt-4o', [
                  'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
                  'o3', 'o3-mini', 'o4-mini',
                  'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo',
                ])}
              </div>
              <button class="btn btn-small provider-refresh-btn" onclick="SettingsView._fetchModels('openai')" title="Fetch live model list from OpenAI">Refresh</button>
            </div>
          </div>`;
        break;
      // --- Preset OpenAI-compatible providers (key + model) ---
      case 'google': case 'groq': case 'deepseek': case 'xai': case 'mistral': case 'kimi': case 'openrouter': case 'fireworks': case 'together': {
        const presetMeta = {
          google:   { keyId: 'google', keyField: 'google_api_key', modelField: 'google_model', placeholder: 'AIza...', defaultModel: 'gemini-2.5-flash',
                      models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-pro', 'gemini-1.5-flash'] },
          groq:     { keyId: 'groq', keyField: 'groq_api_key', modelField: 'groq_model', placeholder: 'gsk_...', defaultModel: 'llama-3.3-70b-versatile',
                      models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'meta-llama/llama-4-scout-17b-16e-instruct', 'meta-llama/llama-4-maverick-17b-128e-instruct', 'qwen/qwen-3-32b', 'qwen-qwq-32b', 'deepseek-r1-distill-llama-70b', 'mistral-saba-24b', 'gemma2-9b-it', 'llama-guard-3-8b'] },
          deepseek: { keyId: 'deepseek', keyField: 'deepseek_api_key', modelField: 'deepseek_model', placeholder: 'sk-...', defaultModel: 'deepseek-chat',
                      models: ['deepseek-chat', 'deepseek-reasoner'] },
          xai:      { keyId: 'xai', keyField: 'xai_api_key', modelField: 'xai_model', placeholder: 'xai-...', defaultModel: 'grok-3',
                      models: ['grok-4', 'grok-3', 'grok-3-mini-beta', 'grok-2-1212', 'grok-2-vision-1212'] },
          mistral:  { keyId: 'mistral', keyField: 'mistral_api_key', modelField: 'mistral_model', placeholder: 'sk-...', defaultModel: 'mistral-large-latest',
                      models: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest', 'magistral-medium-latest', 'magistral-small-latest', 'ministral-8b-latest', 'ministral-3b-latest', 'open-mistral-nemo', 'mistral-embed'] },
          kimi:     { keyId: 'kimi', keyField: 'kimi_api_key', modelField: 'kimi_model', placeholder: 'sk-...', defaultModel: 'kimi-k3',
                      models: [
                        'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code:batch', 'kimi-k2.7-code-highspeed', 'kimi-k2.6', 'kimi-k2.5',
                        'moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k',
                        'moonshot-v1-128k-vision-preview', 'moonshot-v1-32k-vision-preview',
                      ] },
          openrouter: { keyId: 'openrouter', keyField: 'openrouter_api_key', modelField: 'openrouter_model', placeholder: 'sk-or-...', defaultModel: 'openai/gpt-4o',
                      models: [
                        'openai/gpt-4o', 'openai/gpt-4o-mini',
                        'anthropic/claude-3.5-sonnet',
                        'google/gemini-2.0-flash-001',
                        'meta-llama/llama-3.3-70b-instruct',
                        'deepseek/deepseek-chat',
                        // NVIDIA Nemotron 3 — serverless on OpenRouter (dedicated-only on Fireworks).
                        'nvidia/nemotron-3-ultra-550b-a55b',
                        'nvidia/nemotron-3-super-120b-a12b',
                        'nvidia/nemotron-3-nano-30b-a3b',
                        'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
                      ] },
          fireworks: { keyId: 'fireworks', keyField: 'fireworks_api_key', modelField: 'fireworks_model', placeholder: 'fw_...', defaultModel: 'accounts/fireworks/models/kimi-k2p6',
                      models: [
                        'accounts/fireworks/models/kimi-k2p7-code',
                        'accounts/fireworks/models/kimi-k2p6',
                        'accounts/fireworks/models/kimi-k2p5',
                        'accounts/fireworks/models/kimi-k2-thinking',
                        'accounts/fireworks/models/deepseek-v4-pro',
                        'accounts/fireworks/models/deepseek-v4-flash',
                        'accounts/fireworks/models/gpt-oss-120b',
                        'accounts/fireworks/models/glm-5p1',
                      ] },
          together: { keyId: 'together', keyField: 'together_api_key', modelField: 'together_model', placeholder: 'API key from together.ai', defaultModel: 'moonshotai/Kimi-K2.6',
                      models: [
                        'moonshotai/Kimi-K2.6',
                        'moonshotai/Kimi-K2.5',
                        'deepseek-ai/DeepSeek-V4-Pro',
                        'meta-llama/Llama-3.3-70B-Instruct-Turbo',
                        'Qwen/Qwen3-235B-A22B-Instruct-2507-tput',
                        'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8',
                        'openai/gpt-oss-120b',
                      ] },
        };
        const pm = presetMeta[provider.id];
        fields = `
          <div class="provider-field">
            <label>API Key</label>
            <input type="password" id="provider-${pm.keyId}-key" placeholder="${pm.placeholder}" value="" class="settings-input" autocomplete="off">
            <small class="settings-note">${data[pm.keyField] || 'Not set'}</small>
          </div>
          <div class="provider-field">
            <label>LLM/Model</label>
            <div class="flex gap-2">
              <div class="flex-1">
                ${this._modelCombo('provider-' + pm.keyId + '-model', data[pm.modelField] || pm.defaultModel, pm.models)}
              </div>
              <button class="btn btn-small provider-refresh-btn" onclick="SettingsView._fetchModels('${provider.id}')" title="Refresh model list">Refresh</button>
            </div>
          </div>`;
        break;
      }
      case 'ollama':
        fields = `
          <div class="cli-status-card cli-status-inline">
            <div class="cli-status-content">
              <div class="cli-status-title text-sm">Quick Install</div>
              <code class="cli-install-cmd">${window.VODOU_OS === 'mac' ? 'brew install ollama && ollama pull llama3' : window.VODOU_OS === 'windows' ? 'winget install Ollama.Ollama' : 'curl -fsSL https://ollama.com/install.sh | sh'}</code>
              <div class="cli-status-desc cli-status-desc-top">Then run <code>ollama serve</code> to start the local server.</div>
            </div>
          </div>
          <div class="provider-field">
            <label>Base URL</label>
            <input type="text" id="provider-ollama-url" placeholder="http://localhost:11434" value="${data.ollama_base_url}" class="settings-input">
          </div>
          <div class="provider-field">
            <label>LLM/Model</label>
            <div class="flex gap-2">
              <div class="flex-1">
                ${this._modelCombo('provider-ollama-model', data.ollama_model || '', [
                  'llama3.3', 'llama3.1', 'llama3', 'mistral', 'mixtral',
                  'codellama', 'deepseek-coder-v2', 'phi3', 'gemma2', 'qwen2.5',
                ])}
              </div>
              <button class="btn btn-small provider-refresh-btn" onclick="SettingsView._fetchModels('ollama')" title="Fetch installed models from Ollama">Refresh</button>
            </div>
          </div>
          <div id="modelfit-ollama" class="modelfit-host"></div>`;
        break;
      case 'lmstudio':
        fields = `
          <div class="cli-status-card cli-status-inline">
            <div class="cli-status-content">
              <div class="cli-status-title text-sm">Local GUI runtime</div>
              <code class="cli-install-cmd">https://lmstudio.ai</code>
              <div class="cli-status-desc cli-status-desc-top">Launch LM Studio once, then it can auto-start via <code>lms server start</code>. Fastest on Apple Silicon (MLX).</div>
            </div>
          </div>
          <div class="provider-field">
            <label>Base URL</label>
            <input type="text" id="provider-lmstudio-url" placeholder="http://localhost:1234" value="${data.lmstudio_base_url || 'http://localhost:1234'}" class="settings-input">
          </div>
          <div class="provider-field">
            <label>LLM/Model</label>
            <div class="flex gap-2">
              <div class="flex-1">
                ${this._modelCombo('provider-lmstudio-model', data.lmstudio_model || '', [])}
              </div>
              <button class="btn btn-small provider-refresh-btn" onclick="SettingsView._fetchModels('lmstudio')" title="Fetch loaded/available models from LM Studio">Refresh</button>
            </div>
          </div>
          <div id="modelfit-lmstudio" class="modelfit-host"></div>`;
        break;
      case 'llamacpp':
        fields = `
          <div class="cli-status-card cli-status-inline">
            <div class="cli-status-content">
              <div class="cli-status-title text-sm">Built in — zero install</div>
              <div class="cli-status-desc cli-status-desc-top">Runs locally via the bundled <code>llama-server</code>. Models download from HuggingFace on first use and are cached.</div>
            </div>
          </div>
          <div class="provider-field">
            <label>Model (HuggingFace <code>-hf</code> ref)</label>
            <div class="flex gap-2">
              <div class="flex-1">
                ${this._modelCombo('provider-llamacpp-model', data.llamacpp_model || '', [
                  // Curated for Vodou (agentic — tool-calling + reasoning weighted).
                  // All refs verified to exist on HF with a Q4_K_M quant. Download-on-first-use.
                  { value: 'bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M',        label: 'Qwen2.5 3B — fast, good tool-calling (~8GB RAM)' },
                  { value: 'bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M',      label: 'Llama 3.2 3B — light & fast (~8GB RAM)' },
                  { value: 'bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M',        label: 'Qwen2.5 7B — best all-round for agents (~16GB RAM)' },
                  { value: 'NousResearch/Hermes-3-Llama-3.1-8B-GGUF:Q4_K_M',   label: 'Hermes 3 8B — tuned for tool-calling (~16GB RAM)' },
                  { value: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF:Q4_K_M', label: 'Llama 3.1 8B — strong general (~16GB RAM)' },
                  { value: 'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M',  label: 'Qwen2.5 Coder 7B — coding tasks (~16GB RAM)' },
                  { value: 'bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF:Q4_K_M',label: 'DeepSeek-R1 7B — reasoning (~16GB RAM)' },
                  { value: 'bartowski/Qwen2.5-14B-Instruct-GGUF:Q4_K_M',       label: 'Qwen2.5 14B — high quality (~32GB RAM)' },
                  { value: 'bartowski/Qwen2.5-Coder-14B-Instruct-GGUF:Q4_K_M', label: 'Qwen2.5 Coder 14B — coding (~32GB RAM)' },
                  { value: 'bartowski/DeepSeek-R1-Distill-Qwen-14B-GGUF:Q4_K_M',label: 'DeepSeek-R1 14B — reasoning (~32GB RAM)' },
                ])}
              </div>
              <button class="btn btn-small provider-refresh-btn" onclick="SettingsView._fetchModels('llamacpp')" title="Refresh loaded model">Refresh</button>
              <button class="btn btn-small" onclick="SettingsView._stopLlamaCpp()" title="Stop the local llama.cpp server">Stop</button>
            </div>
          </div>
          <div id="llamacpp-status" class="settings-note"></div>
          <div class="provider-field" id="llamacpp-cache-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <span class="settings-note" id="llamacpp-cache-info">Downloaded models: …</span>
            <button class="btn btn-small" id="llamacpp-clear-btn" onclick="SettingsView._clearLlamaCppCache()" title="Delete downloaded GGUF weights to free disk">Clear downloaded models</button>
          </div>
          <div id="modelfit-llamacpp" class="modelfit-host"></div>`;
        break;
      case 'custom':
        fields = `
          <div class="settings-note" style="margin-bottom:8px;">Using LM Studio or llama.cpp? They now have their own cards above — no manual setup needed.</div>
          <div class="provider-field">
            <label>Base URL</label>
            <input type="text" id="provider-custom-url" placeholder="http://localhost:1234" value="${data.custom_llm_base_url}" class="settings-input">
          </div>
          <div class="provider-field">
            <label>LLM/Model</label>
            <input type="text" id="provider-custom-model" placeholder="Type your model name" value="${data.custom_llm_model}" class="settings-input">
            <small class="model-hint">Enter the exact model name your endpoint expects</small>
          </div>
          <div class="provider-field">
            <label>API Key (optional)</label>
            <input type="password" id="provider-custom-key" placeholder="Optional" value="" class="settings-input" autocomplete="off">
            <small class="settings-note">${data.custom_llm_api_key || 'Not set'}</small>
          </div>`;
        break;
    }

    const descriptions = {
      'claude-cli': 'Using Max subscription via claude binary <span class="provider-recommended">Recommended</span>',
      'anthropic': 'Direct API access with your key — <a href="https://console.anthropic.com/settings/keys" target="_blank" class="provider-key-link">Get API key</a>',
      'kimi-cli': 'Kimi Code CLI — terminal agent (<code>kimi</code>). Run <code>kimi login</code> once. <a href="https://moonshotai.github.io/kimi-cli/en/" target="_blank" rel="noopener" class="provider-key-link">Docs</a>',
      'kimi': 'OpenAI-compatible Moonshot API — <a href="https://platform.moonshot.ai/console/api-keys" target="_blank" rel="noopener" class="provider-key-link">Get API key</a>',
      'openai': 'GPT-4o, o3, o4-mini, and more — <a href="https://platform.openai.com/api-keys" target="_blank" class="provider-key-link">Get API key</a>',
      'google': 'Gemini 2.5 Pro, Flash — free tier available — <a href="https://aistudio.google.com/apikey" target="_blank" class="provider-key-link">Get API key</a>',
      'groq': 'Ultra-fast inference — Llama, Qwen, DeepSeek — <a href="https://console.groq.com/keys" target="_blank" class="provider-key-link">Get API key</a>',
      'deepseek': 'DeepSeek V3 — strong reasoning and coding — <a href="https://platform.deepseek.com/api_keys" target="_blank" class="provider-key-link">Get API key</a>',
      'xai': 'Grok 4, Grok 3 — xAI\'s flagship models — <a href="https://console.x.ai" target="_blank" class="provider-key-link">Get API key</a>',
      'mistral': 'Mistral Large, Codestral, Magistral reasoning — <a href="https://console.mistral.ai/api-keys" target="_blank" class="provider-key-link">Get API key</a>',
      'openrouter': 'Separate from OpenAI — keys start with <code>sk-or-v1-</code>. One key routes to many vendors — <a href="https://openrouter.ai/keys" target="_blank" rel="noopener" class="provider-key-link">Get API key</a>',
      'fireworks': 'Hosted Kimi K2.6 — fast, low-latency, ZDR by default for open models — <a href="https://fireworks.ai/account/api-keys" target="_blank" rel="noopener" class="provider-key-link">Get API key</a>',
      'together': 'Together.ai — failover provider, EU Sweden region available, friendlier ToS for SaaS bundling — <a href="https://api.together.ai/settings/api-keys" target="_blank" rel="noopener" class="provider-key-link">Get API key</a>',
      'ollama': 'Run models locally — no API key needed <span class="provider-note-warn">Requires 16GB+ RAM. Responses will be slower than cloud providers.</span>',
      'lmstudio': 'Run models locally with a GUI — fastest on Apple Silicon (MLX). No API key needed.',
      'llamacpp': 'Built in — no install needed. Models download on first use.',
      'custom': 'LM Studio, vLLM, or any OpenAI-compatible endpoint',
    };

    return `
      <div class="provider-card ${isActive ? 'active' : ''} ${expandedClass}" data-provider="${provider.id}">
        <div class="provider-header" onclick="SettingsView._toggleCard('${provider.id}')">
          <div class="provider-radio">
            <span class="status-dot ${statusDot}"></span>
          </div>
          <div class="provider-info">
            <div class="provider-name">${provider.name} ${statusLabel ? `<span class="provider-status-badge ${statusDot}">${statusLabel}</span>` : ''}</div>
            <div class="provider-desc">${descriptions[provider.id] || ''}</div>
          </div>
        </div>
        <div class="provider-body" id="provider-body-${provider.id}">
          ${fields}
          <div class="provider-actions">
            <button class="btn btn-secondary" onclick="SettingsView._testProvider('${provider.id}')">Test Connection</button>
            ${isActive
              ? `<button class="btn btn-primary" onclick="SettingsView._activateProvider('${provider.id}')">Save Changes</button>`
              : `<button class="btn btn-primary" onclick="SettingsView._activateProvider('${provider.id}')">Activate</button>`}
            ${(this._CLEARABLE_KEY_FIELDS[provider.id] && data[this._CLEARABLE_KEY_FIELDS[provider.id]])
              ? `<button class="btn btn-secondary" onclick="SettingsView._clearProviderKey('${provider.id}')" title="Remove the saved API key from the database and .env">Clear key</button>`
              : ''}
          </div>
          <div class="provider-test-result" id="test-result-${provider.id}"></div>
        </div>
      </div>
    `;
  },

  _toggleCard(providerId) {
    const cards = document.querySelectorAll('.provider-card');
    cards.forEach(card => {
      if (card.dataset.provider === providerId) {
        card.classList.toggle('expanded');
      }
    });
  },

  async _testProvider(providerId) {
    const resultEl = document.getElementById('test-result-' + providerId);
    resultEl.innerHTML = '<span class="text-muted-color text-sm">Testing...</span>';

    const body = { provider: providerId };
    switch (providerId) {
      case 'claude-cli':
      case 'kimi-cli':
        break;
      case 'anthropic':
        body.api_key = document.getElementById('provider-anthropic-key')?.value || undefined;
        body.model = this._getModelValue('provider-anthropic-model');
        break;
      case 'openai':
        body.api_key = document.getElementById('provider-openai-key')?.value || undefined;
        body.model = this._getModelValue('provider-openai-model');
        break;
      case 'ollama':
        body.base_url = document.getElementById('provider-ollama-url')?.value;
        body.model = this._getModelValue('provider-ollama-model');
        break;
      case 'lmstudio':
        body.base_url = document.getElementById('provider-lmstudio-url')?.value;
        body.model = this._getModelValue('provider-lmstudio-model');
        break;
      case 'llamacpp':
        body.model = this._getModelValue('provider-llamacpp-model');
        break;
      case 'google': case 'groq': case 'deepseek': case 'xai': case 'mistral': case 'kimi': case 'openrouter': case 'fireworks': case 'together': {
        const raw = document.getElementById('provider-' + providerId + '-key')?.value;
        const t = raw != null ? String(raw).replace(/\r/g, '').trim() : '';
        if (t) {
          body.api_key = t;
          if (providerId === 'openrouter') body.openrouter_api_key = t;
        }
        body.model = this._getModelValue('provider-' + providerId + '-model');
        break;
      }
      case 'custom':
        body.base_url = document.getElementById('provider-custom-url')?.value;
        body.model = document.getElementById('provider-custom-model')?.value;
        body.api_key = document.getElementById('provider-custom-key')?.value || undefined;
        break;
    }

    try {
      const result = await API.post('/api/settings/test', body);
      if (result.success) {
        resultEl.innerHTML = `<span class="status-ok-text">Connected! LLM/Model: ${result.model}${result.response ? ' — "' + result.response.substring(0, 60) + '"' : ''}</span>`;
      } else {
        resultEl.innerHTML = `<span class="status-error-text">Failed: ${result.error}</span>`;
      }
    } catch (err) {
      resultEl.innerHTML = `<span class="status-error-text">Error: ${err.message}</span>`;
    }
  },

  // provider id → settings key whose API key can be cleared. Mirrors the
  // backend CLEARABLE_KEY_ENV map in api/settings.ts. Providers without an API
  // key (claude-cli, kimi-cli, ollama) are intentionally absent.
  _CLEARABLE_KEY_FIELDS: {
    anthropic: 'anthropic_api_key', openai: 'openai_api_key',
    google: 'google_api_key', groq: 'groq_api_key', deepseek: 'deepseek_api_key',
    xai: 'xai_api_key', mistral: 'mistral_api_key', kimi: 'kimi_api_key',
    openrouter: 'openrouter_api_key', fireworks: 'fireworks_api_key',
    together: 'together_api_key', custom: 'custom_llm_api_key',
  },

  async _clearProviderKey(providerId) {
    const keyField = this._CLEARABLE_KEY_FIELDS[providerId];
    if (!keyField) return;
    if (!confirm(`Remove the saved API key for ${providerId}? It will be cleared from the database and .env.`)) return;
    try {
      // No `provider` in the payload — clearing a key must not also re-activate
      // that provider. Empty string is the explicit "clear" signal.
      await API.post('/api/settings', { [keyField]: '' });
      this._data = await API.get('/api/settings');
      this._renderModelPanel();
    } catch (err) {
      alert('Clear failed: ' + (err.message || err));
    }
  },

  async _activateProvider(providerId) {
    const body = { provider: providerId };

    // Find the button that was clicked and show saving state
    const card = document.querySelector(`.provider-card[data-provider="${providerId}"]`);
    const btn = card?.querySelector('.btn-primary');
    const origText = btn?.textContent;
    if (btn) { btn.textContent = 'Saving...'; btn.disabled = true; }

    switch (providerId) {
      case 'vodou':
        // Managed: no key, just the curated model. Activation = use Vodou's LLM, meter against plan.
        body.vodou_model = this._getModelValue('provider-vodou-model');
        break;
      case 'claude-cli':
        body.cli_model = this._getModelValue('provider-claude-cli-model');
        break;
      case 'kimi-cli':
        body.kimi_cli_model = this._getModelValue('provider-kimi-cli-model');
        break;
      case 'anthropic': {
        const key = document.getElementById('provider-anthropic-key')?.value;
        if (key) body.anthropic_api_key = key;
        body.claude_model = this._getModelValue('provider-anthropic-model');
        break;
      }
      case 'openai': {
        const key = document.getElementById('provider-openai-key')?.value;
        if (key) body.openai_api_key = key;
        body.openai_model = this._getModelValue('provider-openai-model');
        break;
      }
      case 'google': case 'groq': case 'deepseek': case 'xai': case 'mistral': case 'kimi': case 'openrouter': case 'fireworks': case 'together': {
        const presetKey = document.getElementById('provider-' + providerId + '-key')?.value?.replace(/\r/g, '')?.trim();
        if (presetKey) body[providerId + '_api_key'] = presetKey;
        body[providerId + '_model'] = this._getModelValue('provider-' + providerId + '-model');
        break;
      }
      case 'ollama':
        body.ollama_base_url = document.getElementById('provider-ollama-url')?.value;
        body.ollama_model = this._getModelValue('provider-ollama-model');
        break;
      case 'lmstudio':
        body.lmstudio_base_url = document.getElementById('provider-lmstudio-url')?.value;
        body.lmstudio_model = this._getModelValue('provider-lmstudio-model');
        break;
      case 'llamacpp':
        body.llamacpp_model = this._getModelValue('provider-llamacpp-model');
        break;
      case 'custom': {
        body.custom_llm_base_url = document.getElementById('provider-custom-url')?.value;
        body.custom_llm_model = document.getElementById('provider-custom-model')?.value;
        const customKey = document.getElementById('provider-custom-key')?.value;
        if (customKey) body.custom_llm_api_key = customKey;
        break;
      }
    }

    try {
      const result = await API.post('/api/settings', body);
      console.log('[Settings] Saved:', result);

      // Show success briefly before re-rendering
      if (btn) { btn.textContent = 'Saved!'; btn.className = 'btn btn-success'; }

      if (typeof ChatView !== 'undefined' && ChatView._refreshFooterModel) {
        void ChatView._refreshFooterModel();
      }

      // Reload and re-render after a beat so user sees the confirmation
      setTimeout(async () => {
        this._data = await API.get('/api/settings');
        this._renderModelPanel();
      }, 600);
    } catch (err) {
      console.error('[Settings] Save failed:', err);
      if (btn) { btn.textContent = origText; btn.disabled = false; }
      const testEl = document.getElementById('test-result-' + providerId);
      if (testEl) {
        const upgrade = err?.data?.upgrade_url;
        if (err?.data?.reason === 'not_entitled' && upgrade) {
          testEl.innerHTML = `<span class="status-error-text">${err.message} </span><a href="${upgrade}" target="_blank" rel="noopener">Upgrade plan →</a>`;
        } else {
          testEl.innerHTML = `<span class="status-error-text">Save failed: ${err.message}</span>`;
        }
      }
    }
  },

  async _saveAdvanced() {
    const maxTokens = document.getElementById('settings-max-tokens')?.value;
    try {
      await API.post('/api/settings', { max_tokens: maxTokens });
      const btn = document.querySelector('.settings-section .btn-primary');
      if (btn) { btn.textContent = 'Saved!'; setTimeout(() => { btn.textContent = 'Save Advanced Settings'; }, 1500); }
    } catch (err) {
      alert('Failed to save: ' + err.message);
    }
  },

  /**
   * Fetch live model lists from provider APIs.
   * Updates the datalist options so the combo box stays fresh.
   * @param {boolean} silent - if true, don't show errors (used on page load)
   */
  async _fetchModels(providerId, silent) {
    try {
      // Save current key/url first if user typed one
      if (providerId === 'openai') {
        const key = document.getElementById('provider-openai-key')?.value;
        if (key) await API.post('/api/settings', { openai_api_key: key });
      } else if (providerId === 'openrouter') {
        const key = document.getElementById('provider-openrouter-key')?.value?.replace(/\r/g, '')?.trim();
        if (key) await API.post('/api/settings', { openrouter_api_key: key });
      } else if (providerId === 'ollama') {
        const url = document.getElementById('provider-ollama-url')?.value;
        if (url) await API.post('/api/settings', { ollama_base_url: url });
      } else if (providerId === 'lmstudio') {
        const url = document.getElementById('provider-lmstudio-url')?.value;
        if (url) await API.post('/api/settings', { lmstudio_base_url: url });
      }

      const qs = silent ? '' : '?refresh=1';
      const result = await API.get('/api/settings/models/' + providerId + qs);
      if (!result.models?.length) return;

      // Update the <select> with fresh models
      const select = document.getElementById('provider-' + providerId + '-model');
      if (!select || select.tagName !== 'SELECT') return;

      const currentVal = this._getModelValue('provider-' + providerId + '-model');
      // models may be strings or { value, label } objects (e.g. branded Vodou models)
      const mVals = result.models.map(m => typeof m === 'object' ? m.value : m);
      let options = result.models.map((m, i) => {
        const val = mVals[i]; const label = typeof m === 'object' ? m.label : m;
        return `<option value="${val}" ${val === currentVal ? 'selected' : ''}>${label}</option>`;
      }).join('');
      const isCustom = currentVal && !mVals.includes(currentVal);
      options += `<option value="__other__" ${isCustom ? 'selected' : ''}>Other (type model name)...</option>`;
      select.innerHTML = options;

      // The custom <input> was shown at first render if currentVal wasn't in the
      // static presets. Now that the live list may contain it, re-sync visibility so
      // we don't end up with two fields (select + custom input) for the same value.
      const customInput = document.getElementById('provider-' + providerId + '-model-custom');
      if (customInput) {
        if (isCustom) {
          customInput.classList.remove('is-hidden');
        } else {
          customInput.classList.add('is-hidden');
          customInput.value = '';
        }
      }

      if (result.error && !silent) {
        const testEl = document.getElementById('test-result-' + providerId);
        if (testEl) testEl.innerHTML = `<span class="status-warn-text">${result.error}</span>`;
      }
    } catch (err) {
      if (!silent) console.error('Failed to fetch models:', err);
    }
  },

  async _loadVodouUsage() {
    const el = document.getElementById('vodou-usage-body');
    if (!el) return;
    // The card (incl. its Activate button) renders synchronously before this async
    // fetch, so entitlement is applied here once the answer arrives.
    const card = document.querySelector('.provider-card[data-provider="vodou"]');
    const btn = card?.querySelector('.provider-actions .btn-primary');
    try {
      const u = await API.get('/api/settings/vodou-usage');
      // Free / BYOK-only plan: the managed LLM isn't included. Lock activation and
      // point the user at billing. The server-side 403 gate is the real enforcement;
      // this is the UX. (entitled is only present on a successful fetch.)
      if (u && u.ok && u.entitled === false) {
        const upgrade = u.upgrade_url || 'https://app.vodou.ai/dashboard/billing';
        el.innerHTML = `
          <div class="settings-note">
            <strong>Vodou LLM isn't included in the Free plan.</strong>
            Upgrade to a paid plan to use the managed model — usage then counts against your
            monthly token allowance. BYOK providers (Claude CLI, Anthropic API, …) stay free on any plan.
            <div style="margin-top:8px">
              <a class="btn btn-primary btn-small" href="${upgrade}" target="_blank" rel="noopener">Upgrade plan</a>
            </div>
          </div>`;
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Upgrade required';
          btn.title = 'Upgrade to a paid plan to use the Vodou LLM';
          btn.onclick = (e) => { e.preventDefault(); window.open(upgrade, '_blank', 'noopener'); };
        }
        return;
      }
      if (!u || !u.ok) {
        const msg = u && u.reason === 'not_connected' ? 'Connect your Vodou account at app.vodou.ai to see usage.'
          : u && u.reason === 'disabled' ? 'Managed LLM is not enabled on this gateway.'
          : u && u.reason === 'invalid_token' ? 'Vodou token invalid — sign in again.'
          : 'Usage unavailable right now.';
        el.innerHTML = `<span class="text-muted-color">${msg}</span>`;
        return;
      }
      const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 2 : 0) + 'M' : Number(n).toLocaleString();
      const bar = u.pct >= 100 ? 'var(--tw-status-error, #dc2626)' : u.pct >= 90 ? '#eab308' : 'var(--tw-link, #2563eb)';
      el.innerHTML = `
        <div class="text-sm" style="display:flex;justify-content:space-between;align-items:baseline;gap:16px;margin-bottom:6px">
          <span style="text-transform:capitalize">${u.plan_id} plan</span>
          <span class="font-mono">${fmt(u.tokens_used)} / ${fmt(u.monthly_token_limit)} (${u.pct}%)</span>
        </div>
        <div style="width:100%;height:8px;background:rgba(127,127,127,0.2);border-radius:9999px;overflow:hidden">
          <div style="height:8px;width:${Math.min(100, u.pct)}%;background:${bar};border-radius:9999px"></div>
        </div>`;
    } catch {
      el.innerHTML = `<span class="text-muted-color">Usage unavailable right now.</span>`;
    }
  },

  async _loadProfilePanel() {
    const panel = document.getElementById('settings-panel-profile');
    if (!panel) return;
    try {
      const d = await API.get('/api/profile');
      panel.innerHTML = `
        <div class="profile-grid">

          <div class="settings-section profile-section">
            <h3 class="profile-section-title">You</h3>
            <div class="profile-avatar-row">
              <div class="profile-avatar-wrap" id="user-avatar-wrap" title="Click to upload photo">
                <div class="profile-avatar" id="user-avatar-preview">
                  ${d.userAvatar
                    ? `<img src="${this._esc(d.userAvatar)}" alt="Your avatar">`
                    : `<span>${(d.userName || 'U').charAt(0).toUpperCase()}</span>`}
                </div>
                <div class="profile-avatar-overlay">Change</div>
                <input type="file" id="user-avatar-input" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" class="is-hidden">
              </div>
              <p class="settings-note settings-note-zero">PNG, JPG, GIF, WebP or SVG. Shown next to your messages in chat.</p>
            </div>
            <div class="settings-row profile-field-row">
              <label for="profile-username">Display name</label>
              <input type="text" id="profile-username" class="settings-input" value="${this._esc(d.userName)}" placeholder="Your name">
            </div>
            <div class="settings-row profile-field-row">
              <label for="profile-pronouns">Pronouns</label>
              <input type="text" id="profile-pronouns" class="settings-input" value="${this._esc(d.pronouns)}" placeholder="e.g. they/them">
            </div>
            <div class="settings-row profile-field-row">
              <label for="profile-timezone">Timezone</label>
              <input type="text" id="profile-timezone" class="settings-input" value="${this._esc(d.timezone || this._detectTimezone())}" placeholder="e.g. America/Detroit">
            </div>
            <div class="settings-actions-md">
              <button class="btn btn-primary" onclick="SettingsView._saveUserProfile()">Save</button>
              <span class="profile-save-status is-hidden" id="user-save-status">Saved</span>
            </div>
          </div>

          <div class="settings-section profile-section">
            <h3 class="profile-section-title">Vodou</h3>
            <div class="profile-avatar-row">
              <div class="profile-avatar-wrap" id="ai-avatar-wrap" title="Click to upload icon">
                <div class="profile-avatar profile-avatar--ai" id="ai-avatar-preview">
                  <img src="${this._esc(d.aiAvatar)}" alt="AI avatar" class="profile-ai-avatar-img">
                  <span class="is-hidden">🔮</span>
                </div>
                <div class="profile-avatar-overlay">Change</div>
                <input type="file" id="ai-avatar-input" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" class="is-hidden">
              </div>
              <p class="settings-note settings-note-zero">The icon shown next to Vodou's messages in chat.</p>
            </div>
            <div class="settings-row profile-field-row">
              <label for="profile-ai-emoji">Emoji</label>
              <input type="text" id="profile-ai-emoji" class="settings-input" value="${this._esc(d.aiEmoji || '')}" placeholder="e.g. 🔮" maxlength="4" style="max-width:6rem">
            </div>
            <div class="settings-row profile-field-row">
              <label for="profile-ai-color">Avatar color</label>
              <div class="flex-center gap-3">
                <input type="color" id="profile-ai-color" value="${this._esc(d.aiAvatarColor || '#6B7280')}" class="profile-color-input">
                <span class="settings-note settings-note-zero">Used when no image is set</span>
              </div>
            </div>
            <div class="settings-row profile-field-row">
              <label for="profile-ainame">Name</label>
              <input type="text" id="profile-ainame" class="settings-input" value="${this._esc(d.aiName)}" placeholder="Vodou">
            </div>
            <div class="settings-row profile-field-row">
              <label for="profile-aivibe">Vibe</label>
              <input type="text" id="profile-aivibe" class="settings-input" value="${this._esc(d.aiVibe)}" placeholder="Sharp, resourceful, a little scrappy">
            </div>
            <div class="settings-actions-md">
              <button class="btn btn-primary" onclick="SettingsView._saveAiProfile()">Save</button>
              <span class="profile-save-status is-hidden" id="ai-save-status">Saved</span>
            </div>
          </div>

        </div>`;

      const aiImg = panel.querySelector('.profile-ai-avatar-img');
      if (aiImg) {
        aiImg.addEventListener('error', () => {
          aiImg.classList.add('is-hidden');
          const fallback = aiImg.nextElementSibling;
          if (fallback) fallback.classList.remove('is-hidden');
        });
      }

      this._bindAvatarUpload('user-avatar-wrap', 'user-avatar-input', 'user-avatar-preview', '/api/profile/avatar', false);
      this._bindAvatarUpload('ai-avatar-wrap', 'ai-avatar-input', 'ai-avatar-preview', '/api/profile/ai-avatar', true);
      const colorInput = document.getElementById('profile-ai-color');
      if (colorInput) {
        colorInput.addEventListener('change', () => SettingsView._saveAiProfile());
      }
    } catch (err) {
      panel.innerHTML = `<div class="empty-state">Could not load profile: ${this._esc(err.message)}</div>`;
    }
  },

  _bindAvatarUpload(wrapId, inputId, previewId, endpoint, isAi) {
    const wrap = document.getElementById(wrapId);
    const input = document.getElementById(inputId);
    const preview = document.getElementById(previewId);
    if (!wrap || !input || !preview) return;

    wrap.addEventListener('click', () => input.click());

    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      const ext = file.name.split('.').pop() || 'png';
      const reader = new FileReader();
      reader.onload = async (e) => {
        const data = e.target.result;
        try {
          const r = await API.post(endpoint, { data, ext });
          if (r.ok) {
            if (isAi) {
              preview.innerHTML = `<img src="${r.url}?t=${Date.now()}" alt="AI avatar">`;
            } else {
              preview.innerHTML = `<img src="${r.url}?t=${Date.now()}" alt="Your avatar">`;
            }
          }
        } catch (err) {
          alert('Upload failed: ' + err.message);
        }
      };
      reader.readAsDataURL(file);
    });
  },

  _detectTimezone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; }
    catch { return ''; }
  },

  async _saveUserProfile() {
    const userName = document.getElementById('profile-username')?.value?.trim();
    const pronouns = document.getElementById('profile-pronouns')?.value?.trim();
    const timezone = document.getElementById('profile-timezone')?.value?.trim();
    if (timezone) {
      try { new Intl.DateTimeFormat(undefined, { timeZone: timezone }); }
      catch {
        alert(`"${timezone}" isn't a timezone this machine recognizes — use an IANA name like America/Detroit`);
        return;
      }
    }
    try {
      await API.post('/api/profile', { userName, pronouns, timezone });
      const s = document.getElementById('user-save-status');
      if (s) { s.classList.remove('is-hidden'); setTimeout(() => { s.classList.add('is-hidden'); }, 2000); }
    } catch (err) {
      alert('Save failed: ' + err.message);
    }
  },

  async _saveAiProfile() {
    const aiName = document.getElementById('profile-ainame')?.value?.trim();
    const aiVibe = document.getElementById('profile-aivibe')?.value?.trim();
    const aiEmoji = document.getElementById('profile-ai-emoji')?.value?.trim();
    const aiAvatarColor = document.getElementById('profile-ai-color')?.value;
    try {
      await API.post('/api/profile', { aiName, aiVibe, aiEmoji, aiAvatarColor });
      const s = document.getElementById('ai-save-status');
      if (s) { s.classList.remove('is-hidden'); setTimeout(() => { s.classList.add('is-hidden'); }, 2000); }
    } catch (err) {
      alert('Save failed: ' + err.message);
    }
  },
};
