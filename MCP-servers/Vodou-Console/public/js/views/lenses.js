/**
 * Lenses View — PLAN-LENSES-MANAGEMENT §3 Phase 3.
 *
 * Sidebar tab showing every installed lens (built-in + community), with
 * an inspect modal for the trust contract (manifest + extracts + requires +
 * source) and enable/disable/uninstall actions for community lenses.
 *
 * Read-only mirror of:
 *   GET    /api/lenses/installed
 *   GET    /api/lenses/installed/:id
 *   POST   /api/lenses/install                  body: { git_url, version? }
 *   POST   /api/lenses/installed/:id/enable
 *   POST   /api/lenses/installed/:id/disable
 *   DELETE /api/lenses/installed/:id
 */
const LensesView = {
  _lenses: [],
  _filter: '',
  _tab: 'lenses', // 'lenses' | 'permissions'

  async render(container) {
    container.appendChild(Components.pageHeader('Lenses', 'Visual rich-rendering modules — built-in and community-installed'));
    container.appendChild(Components.loading());
    try {
      await this._fetch();
      container.innerHTML = '';
      this._renderTabs(container);
      this._renderAvailabilityNote(container);
      // Passive bridge preflight — fetch /api/lenses/status, peek at
      // bridge.connected. If false, show an install/wake banner above the
      // list so the user knows what to do BEFORE clicking a lens and seeing
      // BRIDGE_REQUIRED in the card. Best-effort: any failure here is
      // silent — never block the list render.
      this._renderBridgeBanner(container).catch(() => { /* silent */ });
      if (this._tab === 'permissions') {
        this._renderPermissions(container);
      } else {
        this._renderHeader(container);
        this._renderList(container);
      }
    } catch (e) {
      container.innerHTML = '';
      container.appendChild(Components.pageHeader('Lenses', 'Failed to load'));
      const err = document.createElement('div');
      err.className = 'empty-state';
      err.textContent = (e && e.message) || 'Could not load lenses.';
      container.appendChild(err);
    }
  },

  async _fetch() {
    const r = await API.get('/api/lenses/installed');
    this._lenses = (r && r.data) || [];
  },

  _renderTabs(container) {
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex; gap:4px; border-bottom:1px solid var(--border-primary); margin-bottom:16px;';
    const mkTab = (key, label) => {
      const b = document.createElement('button');
      b.textContent = label;
      const active = this._tab === key;
      b.style.cssText = `
        padding:8px 14px; background:transparent; border:0; cursor:pointer;
        color:${active ? 'var(--text-primary)' : 'var(--text-muted)'};
        border-bottom:2px solid ${active ? '#16a34a' : 'transparent'};
        margin-bottom:-1px; font-size:13px;
      `;
      b.addEventListener('click', () => {
        this._tab = key;
        const parent = bar.parentElement;
        if (parent) this.render(parent);
      });
      return b;
    };
    bar.appendChild(mkTab('lenses', 'Installed'));
    bar.appendChild(mkTab('permissions', 'Permissions'));
    container.appendChild(bar);
  },

  async _renderPermissions(container) {
    const wrap = document.createElement('div');
    container.appendChild(wrap);
    const status = document.createElement('div');
    status.style.cssText = 'color:var(--text-muted); font-size:13px; margin-bottom:12px;';
    status.textContent = 'Loading consents…';
    wrap.appendChild(status);
    let consents = [];
    try {
      const r = await API.get('/api/lenses/consents');
      consents = (r && r.data && r.data.consents) || [];
    } catch (e) {
      status.style.color = '#f87171';
      status.textContent = `Failed to load consents: ${e?.message || e}`;
      return;
    }
    if (consents.length === 0) {
      status.textContent = 'No consents granted yet. When a lens action needs a domain, you\'ll get a one-time consent dialog.';
      return;
    }
    status.textContent = `${consents.length} active consent${consents.length === 1 ? '' : 's'}`;
    const list = document.createElement('div');
    list.style.cssText = 'display:flex; flex-direction:column; gap:8px;';
    wrap.appendChild(list);
    for (const c of consents) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:12px; padding:12px 14px; background:var(--bg-secondary); border:1px solid var(--border-primary); border-radius:8px;';
      const body = document.createElement('div');
      body.style.cssText = 'flex:1; min-width:0;';
      body.innerHTML = `
        <div style="color:var(--text-primary); font-weight:600;">${this._esc(c.lens_id)} → ${this._esc(c.action_id)}</div>
        <div style="color:var(--text-secondary); font-size:12px; margin-top:2px;">Domain: ${this._esc(c.domain)}</div>
        <div style="color:var(--text-muted); font-size:11px; margin-top:2px;">Granted ${new Date(c.granted_at).toLocaleString()} · used ${c.used_count}× ${c.last_used_at ? '· last ' + this._timeAgo(c.last_used_at) : ''}</div>
      `;
      row.appendChild(body);
      const btn = document.createElement('button');
      btn.textContent = 'Revoke';
      btn.style.cssText = 'padding:6px 12px; background:transparent; color:#f87171; border:1px solid #7f1d1d; border-radius:6px; cursor:pointer;';
      btn.addEventListener('click', async () => {
        if (!confirm(`Revoke ${c.lens_id} → ${c.action_id} for ${c.domain}?`)) return;
        try {
          await API.del(`/api/lenses/consents/${encodeURIComponent(c.lens_id)}/${encodeURIComponent(c.action_id)}?domain=${encodeURIComponent(c.domain)}`);
          const parent = container.parentElement;
          if (parent) this.render(parent);
        } catch (e) {
          alert(`Revoke failed: ${e?.message || e}`);
        }
      });
      row.appendChild(btn);
      list.appendChild(row);
    }
  },

  // Passive preflight — peek at /api/lenses/status.bridge. If the Vodou
  // Browser Bridge extension isn't connected AND at least one installed
  // lens actually needs it (`requires.needs_session: true`), render an
  // inline banner with install/wake instructions. Don't show the banner
  // when no installed lens needs the bridge — most built-ins use plain
  // server-side fetch and work fine without it, so a generic "install the
  // bridge" message would be misleading.
  /** Where inline lens UI is supported (mirrors server lenses-policy.ts). */
  _renderAvailabilityNote(container) {
    const note = document.createElement('div');
    note.className = 'lenses-availability-note';
    note.innerHTML = `
      <div class="lenses-availability-note__title">Where lenses render</div>
      <p class="lenses-availability-note__lead">
        Lenses are <strong>inline rich UI</strong> in chat — maps, recipes, PRs, and similar.
        They only run in the <strong>primary gateway web chat</strong> (<a href="#/chat">#/chat</a>).
        Everywhere else you still get a normal text reply from the same model.
      </p>
      <div class="lenses-availability-note__grid">
        <div class="lenses-availability-note__col lenses-availability-note__col--yes">
          <div class="lenses-availability-note__label">Works here</div>
          <ul>
            <li>Main <strong>Chat</strong> tab in this console (<code>#/chat</code>)</li>
            <li>Questions asked directly in the gateway UI (not forwarded from another app)</li>
          </ul>
        </div>
        <div class="lenses-availability-note__col lenses-availability-note__col--no">
          <div class="lenses-availability-note__label">Plain text only</div>
          <ul>
            <li><strong>Telegram, Slack, Discord, WhatsApp</strong>, and other messaging channels</li>
            <li><strong>Channel workbench</strong> tabs in this console (messaging mirrors)</li>
            <li>Integration, skill, and automation workbench chats</li>
            <li><strong>Cursor, Claude Code, CLI</strong> — no gateway lens renderer</li>
          </ul>
        </div>
      </div>
      <p class="lenses-availability-note__foot">
        On channels the assistant is not prompted to emit lens blocks; any stray fence is stripped before delivery.
        Some lenses still need the <strong>Vodou Browser Bridge</strong> (see banner below when applicable).
      </p>`;
    container.appendChild(note);
  },

  async _renderBridgeBanner(container) {
    let status;
    try {
      const r = await API.get('/api/lenses/status');
      status = (r && r.data && r.data.bridge) || null;
    } catch {
      return; // Endpoint unavailable — stay silent.
    }
    if (!status || status.connected) return; // Bridge fine, nothing to surface.

    // Only surface the banner when an installed lens actually needs the
    // bridge. `this._lenses` is hydrated by _fetch() above; each item has
    // either `manifest.requires.needs_session` or a flattened equivalent.
    const needsBridge = (this._lenses || []).some((l) => {
      const m = l?.manifest || l;
      return !!(m && m.requires && m.requires.needs_session);
    });
    if (!needsBridge) return;

    const everConnected = !!status.browser_info;
    const banner = document.createElement('div');
    banner.style.cssText = `
      background: var(--bg-elevated, #fff8e1);
      border: 1px solid #f59e0b;
      border-left-width: 4px;
      border-radius: 6px;
      padding: 12px 14px;
      margin: 0 0 14px;
      font-size: 13px;
      color: var(--text-primary, #1f2937);
    `;
    const heading = everConnected ? 'Vodou Bridge is sleeping' : 'Vodou Bridge not installed';
    const body = everConnected
      ? `Click the <strong>Vodou</strong> icon in your Chrome toolbar — it reconnects in a couple of seconds. Lenses that need the bridge will work once it does.`
      : `Lenses that read your active tab (Gmail, Calendar, Docs, etc.) need the Vodou Browser Bridge.<br>
         <strong>To install:</strong> <a href="https://chromewebstore.google.com/detail/vodou-bridge/ehlanbbiaeelnimkakfffehoahimkjjf" target="_blank" rel="noopener noreferrer">get Vodou Bridge from the Chrome Web Store</a> → pin the toolbar icon.`;
    banner.innerHTML = `
      <div style="display:flex; align-items:flex-start; gap:10px;">
        <span style="font-size:18px; line-height:1;">🌉</span>
        <div style="flex:1;">
          <div style="font-weight:600; margin-bottom:4px;">${heading}</div>
          <div style="line-height:1.5;">${body}</div>
        </div>
        <button type="button" class="btn btn-sm" style="white-space:nowrap;">Recheck</button>
      </div>`;
    const recheckBtn = banner.querySelector('button');
    if (recheckBtn) {
      recheckBtn.addEventListener('click', async () => {
        recheckBtn.disabled = true;
        recheckBtn.textContent = 'Checking...';
        const parent = container.parentElement;
        if (parent) await this.render(parent);
      });
    }
    container.appendChild(banner);
  },

  _renderHeader(container) {
    const wrap = document.createElement('div');
    wrap.className = 'lenses-header';
    wrap.style.cssText = 'display:flex; align-items:center; gap:12px; margin-bottom:16px;';
    const total = this._lenses.length;
    const community = this._lenses.filter(l => l.source !== 'builtin').length;
    const title = document.createElement('div');
    title.style.cssText = 'flex:1; color:var(--text-muted); font-size:13px;';
    title.textContent = `${total} installed (${total - community} built-in · ${community} community)`;
    wrap.appendChild(title);

    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Filter…';
    search.style.cssText = 'padding:6px 10px; border:1px solid var(--border-primary); background:var(--bg-primary); color:var(--text-primary); border-radius:6px; width:200px;';
    search.value = this._filter;
    search.addEventListener('input', (e) => {
      this._filter = e.target.value.toLowerCase();
      const listEl = document.getElementById('lenses-list');
      if (listEl) {
        listEl.innerHTML = '';
        this._renderRows(listEl);
      }
    });
    wrap.appendChild(search);

    const browseBtn = document.createElement('button');
    browseBtn.textContent = 'Browse directory';
    browseBtn.style.cssText = 'padding:6px 14px; background:var(--border-primary); color:var(--text-secondary); border:1px solid var(--border-primary); border-radius:6px; cursor:pointer;';
    browseBtn.addEventListener('click', () => this._openBrowseDirectory());
    wrap.appendChild(browseBtn);

    const addBtn = document.createElement('button');
    addBtn.className = 'btn-primary';
    addBtn.textContent = '+ Add lens';
    addBtn.style.cssText = 'padding:6px 14px; background:#16a34a; color:#fff; border:0; border-radius:6px; cursor:pointer;';
    addBtn.addEventListener('click', () => this._openInstallDialog());
    wrap.appendChild(addBtn);

    container.appendChild(wrap);
  },

  async _openBrowseDirectory() {
    const modal = this._modal('Community Lenses');
    const body = modal.body;

    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Search by id, motive, category, author…';
    search.style.cssText = 'width:100%; padding:8px 10px; background:var(--bg-primary); border:1px solid var(--border-primary); color:var(--text-primary); border-radius:6px; box-sizing:border-box; margin-bottom:12px;';
    body.appendChild(search);

    const status = document.createElement('div');
    status.style.cssText = 'color:var(--text-muted); font-size:12px; margin-bottom:8px;';
    status.textContent = 'Loading directory…';
    body.appendChild(status);

    const list = document.createElement('div');
    list.style.cssText = 'display:flex; flex-direction:column; gap:6px;';
    body.appendChild(list);

    const installedIds = new Set(this._lenses.map(l => (l.manifest || {}).type));
    let entries = [];

    const render = (q) => {
      list.innerHTML = '';
      const ql = (q || '').trim().toLowerCase();
      const filtered = entries.filter(e => {
        if (!ql) return true;
        const m = e.manifest || {};
        return e.id.toLowerCase().includes(ql)
            || (m.motive || '').toLowerCase().includes(ql)
            || (m.category || '').toLowerCase().includes(ql)
            || (e.author || '').toLowerCase().includes(ql);
      });
      if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color:var(--text-muted); padding:24px; text-align:center;';
        empty.textContent = entries.length === 0
          ? 'The community directory is empty. Be the first — open a PR at github.com/VodouAI/lenses-directory.'
          : 'No lenses match your search.';
        list.appendChild(empty);
        return;
      }
      for (const e of filtered) list.appendChild(this._directoryRow(e, installedIds, modal));
    };

    try {
      const r = await API.get('/api/lenses/directory');
      entries = (r && r.data && r.data.entries) || [];
      status.textContent = `${entries.length} community lens${entries.length === 1 ? '' : 'es'} available`;
      render('');
    } catch (e) {
      status.style.color = '#f87171';
      status.textContent = `Directory fetch failed: ${e?.message || e}`;
      return;
    }

    search.addEventListener('input', (e) => render(e.target.value));

    const close = document.createElement('button');
    close.textContent = 'Close';
    close.style.cssText = 'padding:8px 14px; background:var(--bg-tertiary); color:var(--text-primary); border:0; border-radius:6px; cursor:pointer; margin-left:auto;';
    close.addEventListener('click', () => modal.close());
    modal.footer.appendChild(close);
  },

  _directoryRow(entry, installedIds, parentModal) {
    const m = entry.manifest || {};
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; gap:10px; padding:10px 12px; background:var(--bg-secondary); border:1px solid var(--border-primary); border-radius:6px;';
    const icon = document.createElement('div');
    icon.style.cssText = 'font-size:20px; min-width:28px; text-align:center;';
    icon.textContent = m.icon || '🔍';
    row.appendChild(icon);

    const info = document.createElement('div');
    info.style.cssText = 'flex:1; min-width:0;';
    const title = document.createElement('div');
    title.style.cssText = 'display:flex; align-items:center; gap:6px;';
    const id = document.createElement('span');
    id.style.cssText = 'color:var(--text-primary); font-weight:600;';
    id.textContent = entry.id;
    title.appendChild(id);
    if (entry.author) {
      const author = document.createElement('span');
      author.style.cssText = 'color:var(--text-muted); font-size:12px;';
      author.textContent = `by ${entry.author}`;
      title.appendChild(author);
    }
    if (entry.stars) {
      const stars = document.createElement('span');
      stars.style.cssText = 'color:#fbbf24; font-size:12px;';
      stars.textContent = `⭐ ${entry.stars}`;
      title.appendChild(stars);
    }
    info.appendChild(title);
    const motive = document.createElement('div');
    motive.style.cssText = 'color:var(--text-secondary); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
    motive.textContent = m.motive || '';
    info.appendChild(motive);
    row.appendChild(info);

    const action = document.createElement('button');
    if (installedIds.has(entry.id)) {
      action.textContent = '✓ Installed';
      action.disabled = true;
      action.style.cssText = 'padding:6px 12px; background:transparent; color:#86efac; border:1px solid #14532d; border-radius:6px; cursor:default;';
    } else {
      action.textContent = 'Install';
      action.style.cssText = 'padding:6px 12px; background:#16a34a; color:#fff; border:0; border-radius:6px; cursor:pointer;';
      action.addEventListener('click', async () => {
        action.disabled = true;
        action.textContent = 'Installing…';
        try {
          await API.post('/api/lenses/install', { directory_id: entry.id });
          action.textContent = '✓ Installed';
          action.style.background = 'transparent';
          action.style.color = '#86efac';
          action.style.border = '1px solid #14532d';
          installedIds.add(entry.id);
          // Refresh the underlying sidebar list
          await this._fetch();
          const listEl = document.getElementById('lenses-list');
          if (listEl) { listEl.innerHTML = ''; this._renderRows(listEl); }
        } catch (e) {
          action.disabled = false;
          action.textContent = 'Install';
          alert(`Install failed: ${e?.message || e}`);
        }
      });
    }
    row.appendChild(action);
    return row;
  },

  _renderList(container) {
    const list = document.createElement('div');
    list.id = 'lenses-list';
    list.style.cssText = 'display:flex; flex-direction:column; gap:8px;';
    this._renderRows(list);
    container.appendChild(list);
  },

  _renderRows(list) {
    const filter = this._filter;
    const rows = this._lenses.filter(l => {
      if (!filter) return true;
      const m = l.manifest || {};
      return (m.type || '').toLowerCase().includes(filter)
          || (m.motive || '').toLowerCase().includes(filter)
          || (l.source || '').toLowerCase().includes(filter);
    });
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = filter ? 'No lenses match your filter.' : 'No lenses installed.';
      list.appendChild(empty);
      return;
    }
    for (const l of rows) list.appendChild(this._row(l));
  },

  _row(lens) {
    const m = lens.manifest || {};
    const row = document.createElement('div');
    row.className = 'lens-row';
    row.style.cssText = `
      display:flex; align-items:center; gap:12px;
      padding:12px 14px; background:var(--bg-secondary); border:1px solid var(--border-primary);
      border-radius:8px; cursor:pointer; transition:background .15s;
    `;
    row.addEventListener('mouseenter', () => row.style.background = 'var(--bg-hover)');
    row.addEventListener('mouseleave', () => row.style.background = 'var(--bg-secondary)');
    row.addEventListener('click', () => this._openInspect(m.type));

    const icon = document.createElement('div');
    icon.style.cssText = 'font-size:24px; min-width:32px; text-align:center;';
    icon.textContent = m.icon || '🔍';
    row.appendChild(icon);

    const body = document.createElement('div');
    body.style.cssText = 'flex:1; min-width:0;';
    const titleLine = document.createElement('div');
    titleLine.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:2px;';

    const typ = document.createElement('span');
    typ.style.cssText = 'font-weight:600; color:var(--text-primary);';
    typ.textContent = m.type || '?';
    titleLine.appendChild(typ);

    const ver = document.createElement('span');
    ver.style.cssText = 'color:var(--text-muted); font-size:12px;';
    ver.textContent = `v${m.version}`;
    titleLine.appendChild(ver);

    titleLine.appendChild(this._statusPill(lens));
    if (lens.source !== 'builtin') {
      const sourceTag = document.createElement('span');
      sourceTag.style.cssText = 'font-size:11px; padding:2px 6px; border-radius:3px; background:#1e3a8a; color:#bfdbfe;';
      sourceTag.textContent = lens.source;
      titleLine.appendChild(sourceTag);
    }

    body.appendChild(titleLine);

    const motive = document.createElement('div');
    motive.style.cssText = 'color:var(--text-secondary); font-size:13px; margin-bottom:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
    motive.textContent = m.motive || '';
    body.appendChild(motive);

    const meta = document.createElement('div');
    meta.style.cssText = 'color:var(--text-muted); font-size:11px;';
    const patterns = (m.url_patterns && m.url_patterns.length) ? m.url_patterns.slice(0, 2).join(', ') : '(no URL patterns)';
    const used = lens.uses_count
      ? `· used ${lens.uses_count}× · last ${this._timeAgo(lens.last_used_at)}`
      : '· unused';
    meta.textContent = `${patterns} ${used}`;
    body.appendChild(meta);

    row.appendChild(body);
    return row;
  },

  _statusPill(lens) {
    const span = document.createElement('span');
    span.style.cssText = 'font-size:11px; padding:2px 8px; border-radius:10px; display:inline-flex; align-items:center; gap:4px;';
    if (!lens.enabled) {
      span.style.background = '#374151';
      span.style.color = '#9ca3af';
      span.textContent = '⚫ disabled';
    } else if (lens.health_status === 'fetch_failing' || lens.health_status === 'load_failed') {
      span.style.background = '#7f1d1d';
      span.style.color = '#fecaca';
      span.textContent = `🔴 ${lens.health_status.replace('_', ' ')}`;
    } else if (lens.health_status === 'selectors_stale') {
      span.style.background = '#854d0e';
      span.style.color = '#fde68a';
      span.textContent = '🟡 stale';
    } else {
      span.style.background = '#14532d';
      span.style.color = '#86efac';
      span.textContent = '🟢 ready';
    }
    return span;
  },

  _timeAgo(ts) {
    if (!ts) return 'never';
    const diff = Date.now() - ts;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  },

  async _openInspect(id) {
    let data;
    try {
      const r = await API.get(`/api/lenses/installed/${encodeURIComponent(id)}`);
      data = r && r.data;
    } catch (e) {
      alert('Could not load lens: ' + (e?.message || e));
      return;
    }
    if (!data) return;

    const m = data.manifest || {};
    const modal = this._modal(`${m.icon || '🔍'} ${m.type} v${m.version}`);
    const body = modal.body;

    const section = (label, fn) => {
      const h = document.createElement('h4');
      h.textContent = label;
      h.style.cssText = 'color:var(--text-primary); margin:14px 0 6px; font-size:13px; text-transform:uppercase; letter-spacing:.04em;';
      body.appendChild(h);
      fn(body);
    };

    section('Motive', (b) => {
      const p = document.createElement('p');
      p.style.cssText = 'color:var(--text-secondary); margin:0; line-height:1.5;';
      p.textContent = m.motive || '(none)';
      b.appendChild(p);
    });

    section('URL patterns', (b) => {
      const list = document.createElement('div');
      list.style.cssText = 'color:var(--text-secondary); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px;';
      if (m.url_patterns && m.url_patterns.length) {
        list.innerHTML = m.url_patterns.map(p => `<div>• ${this._esc(p)}</div>`).join('');
      } else {
        list.textContent = '(none — explicit-invoke only)';
      }
      b.appendChild(list);
    });

    section('What it extracts', (b) => {
      const list = document.createElement('div');
      list.style.cssText = 'color:var(--text-secondary); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px;';
      if (m.extracts && m.extracts.length) {
        list.innerHTML = m.extracts.map(f => `<div>• ${this._esc(f)}</div>`).join('');
      } else {
        list.textContent = '(not declared)';
      }
      b.appendChild(list);
    });

    section('Requires', (b) => {
      const r = m.requires || {};
      const lines = [
        `Render paths: ${(r.paths || []).join(', ') || '?'}`,
        `Cookie scope: ${r.cookie_scope || 'ephemeral'}`,
      ];
      if (r.network_domains && r.network_domains.length) lines.push(`Network domains: ${r.network_domains.join(', ')}`);
      const div = document.createElement('div');
      div.style.cssText = 'color:var(--text-secondary); font-size:12px;';
      div.innerHTML = lines.map(l => `<div>${this._esc(l)}</div>`).join('');
      b.appendChild(div);
    });

    section('Source', (b) => {
      const div = document.createElement('div');
      div.style.cssText = 'color:var(--text-secondary); font-size:12px;';
      const installedAt = data.installed_at ? new Date(data.installed_at).toLocaleString() : '—';
      div.innerHTML = `
        <div>Source:   ${this._esc(data.source)}</div>
        ${data.source_url ? `<div>URL:      <a href="${this._esc(data.source_url)}" target="_blank" style="color:#60a5fa;">${this._esc(data.source_url)}</a></div>` : ''}
        <div>Installed: ${installedAt}</div>
        <div>Uses:     ${data.uses_count || 0}</div>
        <div>Health:   ${this._esc(data.health_status || 'healthy')}</div>
      `;
      b.appendChild(div);
    });

    // Footer actions
    const footer = modal.footer;
    if (data.source !== 'builtin') {
      const toggleBtn = document.createElement('button');
      toggleBtn.style.cssText = 'padding:8px 14px; background:var(--border-primary); color:var(--text-secondary); border:1px solid var(--border-primary); border-radius:6px; cursor:pointer;';
      toggleBtn.textContent = data.enabled ? 'Disable' : 'Enable';
      toggleBtn.addEventListener('click', async () => {
        const path = data.enabled ? 'disable' : 'enable';
        try {
          await API.post(`/api/lenses/installed/${encodeURIComponent(m.type)}/${path}`, {});
          modal.close();
          await this._fetch();
          const listEl = document.getElementById('lenses-list');
          if (listEl) { listEl.innerHTML = ''; this._renderRows(listEl); }
        } catch (e) {
          alert(`Toggle failed: ${e?.message || e}`);
        }
      });
      footer.appendChild(toggleBtn);

      const uninstBtn = document.createElement('button');
      uninstBtn.style.cssText = 'padding:8px 14px; background:transparent; color:#f87171; border:1px solid #7f1d1d; border-radius:6px; cursor:pointer;';
      uninstBtn.textContent = 'Uninstall';
      uninstBtn.addEventListener('click', async () => {
        if (!confirm(`Uninstall ${m.type}? This removes cache, consents, and the on-disk module.`)) return;
        try {
          await API.del(`/api/lenses/installed/${encodeURIComponent(m.type)}`);
          modal.close();
          await this._fetch();
          const listEl = document.getElementById('lenses-list');
          if (listEl) { listEl.innerHTML = ''; this._renderRows(listEl); }
        } catch (e) {
          alert(`Uninstall failed: ${e?.message || e}`);
        }
      });
      footer.appendChild(uninstBtn);
    } else {
      const note = document.createElement('div');
      note.style.cssText = 'color:var(--text-muted); font-size:12px; flex:1;';
      note.textContent = 'Built-in lens — bundled with Vodou, not removable.';
      footer.appendChild(note);
    }

    const done = document.createElement('button');
    done.style.cssText = 'padding:8px 14px; background:var(--bg-tertiary); color:var(--text-primary); border:0; border-radius:6px; cursor:pointer; margin-left:auto;';
    done.textContent = 'Done';
    done.addEventListener('click', () => modal.close());
    footer.appendChild(done);
  },

  _openInstallDialog() {
    const modal = this._modal('Install a lens');
    const body = modal.body;

    const intro = document.createElement('p');
    intro.style.cssText = 'color:var(--text-secondary); margin:0 0 12px; line-height:1.5;';
    intro.textContent = 'Paste a git URL pointing at a lens repo. The repo must contain a manifest.json and index.js at its root.';
    body.appendChild(intro);

    const label = document.createElement('label');
    label.textContent = 'Git URL';
    label.style.cssText = 'display:block; color:var(--text-muted); font-size:11px; margin-bottom:4px;';
    body.appendChild(label);

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'https://github.com/<author>/vodou-lens-<id>';
    input.style.cssText = 'width:100%; padding:8px 10px; background:var(--bg-primary); border:1px solid var(--border-primary); color:var(--text-primary); border-radius:6px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; box-sizing:border-box;';
    body.appendChild(input);

    const status = document.createElement('div');
    status.style.cssText = 'color:var(--text-muted); font-size:12px; margin-top:8px; min-height:18px;';
    body.appendChild(status);

    const installBtn = document.createElement('button');
    installBtn.textContent = 'Install';
    installBtn.style.cssText = 'padding:8px 14px; background:#16a34a; color:#fff; border:0; border-radius:6px; cursor:pointer; margin-left:auto;';
    installBtn.addEventListener('click', async () => {
      const url = input.value.trim();
      if (!url) { status.textContent = 'Enter a git URL.'; return; }
      installBtn.disabled = true;
      status.textContent = 'Installing — git clone, validate, register…';
      try {
        const r = await API.post('/api/lenses/install', { git_url: url });
        const id = r?.data?.id || 'unknown';
        status.style.color = '#86efac';
        status.textContent = `✓ installed ${id}. Refreshing…`;
        setTimeout(async () => {
          modal.close();
          await this._fetch();
          const listEl = document.getElementById('lenses-list');
          if (listEl) { listEl.innerHTML = ''; this._renderRows(listEl); }
        }, 600);
      } catch (e) {
        installBtn.disabled = false;
        status.style.color = '#f87171';
        status.textContent = `✗ ${e?.message || e}`;
      }
    });

    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'padding:8px 14px; background:var(--bg-tertiary); color:var(--text-primary); border:0; border-radius:6px; cursor:pointer;';
    cancel.addEventListener('click', () => modal.close());
    modal.footer.appendChild(cancel);
    modal.footer.appendChild(installBtn);
  },

  _modal(titleText) {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed; inset:0; background:rgba(0,0,0,.6); z-index:1000;
      display:flex; align-items:center; justify-content:center; padding:24px;
    `;
    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background:var(--bg-primary); border:1px solid var(--border-primary); border-radius:10px;
      max-width:580px; width:100%; max-height:80vh; display:flex; flex-direction:column;
      box-shadow:0 20px 60px rgba(0,0,0,.5);
    `;
    const header = document.createElement('div');
    header.style.cssText = 'padding:16px 20px; border-bottom:1px solid var(--border-primary); display:flex; align-items:center;';
    const h = document.createElement('h3');
    h.style.cssText = 'margin:0; color:var(--text-primary); font-size:15px; flex:1;';
    h.textContent = titleText;
    header.appendChild(h);
    const xBtn = document.createElement('button');
    xBtn.textContent = '✕';
    xBtn.style.cssText = 'background:transparent; border:0; color:var(--text-muted); font-size:18px; cursor:pointer; padding:0 6px;';
    xBtn.addEventListener('click', () => close());
    header.appendChild(xBtn);
    const body = document.createElement('div');
    body.style.cssText = 'padding:16px 20px; overflow-y:auto; flex:1;';
    const footer = document.createElement('div');
    footer.style.cssText = 'padding:12px 20px; border-top:1px solid var(--border-primary); display:flex; align-items:center; gap:8px;';
    dialog.appendChild(header);
    dialog.appendChild(body);
    dialog.appendChild(footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    return { overlay, body, footer, close };
  },

  // Shared escaper — safe.js loads first, so VodouSafe is always present.
  _esc(s) {
    return window.VodouSafe.escapeHtml(s);
  },
};

if (typeof Router !== 'undefined') {
  Router.register('/lenses', (el) => LensesView.render(el), LensesView);
}
