/**
 * Apps view — curated OAuth/API-key hub for remote MCP servers (preset catalog).
 *
 * Shows preset providers grouped by category. Each card exposes the right UX for
 * its auth path:
 *   - DCR providers  → "Connect" button → OAuth popup → vodou-core handles DCR + OAuth
 *   - API-key providers → inline input field → POST /api/oauth/credentials
 *   - Manual OAuth providers → setup docs link + API-key fallback (if configured)
 *   - Local stdio MCP (e.g. Chrome DevTools) → setup steps + POST /api/servers
 */

const AppsView = (() => {
  let _el = null;
  let _messageListener = null;

  // Track a mounted workbench so we can unmount on view switch.
  let _activeWorkbench = null;

  // Last providers list handed to renderSidebarApps, so hashchange
  // can re-paint the sidebar (show/hide the active-integration context
  // block) without triggering a fresh /api/oauth/status fetch.
  let _lastProviders = null;

  /** Same gear glyph as channel sidebar (channels.js) — shared look & feel. */
  const GEAR_SVG =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

  async function ensurePresetInCache(providerId) {
    if (_presetCache.has(providerId)) return;
    try {
      const res = await fetch('/api/oauth/status');
      if (!res.ok) return;
      const { providers } = await res.json();
      if (Array.isArray(providers)) {
        for (const pr of providers) _presetCache.set(pr.id, pr);
      }
    } catch {}
  }

  function _ensureDisconnectedHandlers() {
    const host = document.getElementById('nav-apps-items');
    if (!host || host.dataset.discHooked === '1') return;
    host.dataset.discHooked = '1';
    host.addEventListener('click', (ev) => {
      const gear = ev.target && ev.target.closest && ev.target.closest('.nav-item-gear[data-provider]');
      if (gear) {
        ev.preventDefault();
        ev.stopPropagation();
        const id = gear.dataset.provider;
        if (!id) return;
        openProviderModal(id);
        return;
      }
      const btn = ev.target && ev.target.closest
        ? ev.target.closest('button.nav-item-disconnected[data-provider]')
        : null;
      if (!btn) return;
      ev.preventDefault();
      const id = btn.dataset.provider;
      if (!id) return;
      // Ensure we're on the grid route so post-connect renders are visible
      // when the modal closes, then open the same setup modal the cards use.
      if (!location.hash.startsWith('#/apps')) {
        location.hash = '#/apps';
      }
      const ui = window._integrationUi;
      if (ui && typeof ui.manageConnection === 'function') {
        ui.manageConnection(id);
      } else if (ui && typeof ui.openProviderModal === 'function') {
        ui.openProviderModal(id);
      }
    });
  }

  function _parseHashQuery() {
    const h = location.hash || '';
    const q = h.indexOf('?');
    if (q < 0) return new URLSearchParams();
    return new URLSearchParams(h.slice(q + 1));
  }

  async function render(el) {
    _el = el;

    // Tear down any previous workbench before re-rendering.
    if (_activeWorkbench) {
      try { _activeWorkbench.unmount(); } catch {}
      _activeWorkbench = null;
    }

    const qs = _parseHashQuery();
    const mode = qs.get('mode');
    const serverId = qs.get('server');

    if (mode === 'chat' && serverId) {
      await renderWorkbench(el, serverId);
      return;
    }

    el.innerHTML = `
      <div class="view-container">
        <div class="channels-header">
          <div>
            <div class="page-title">Apps</div>
            <div class="page-subtitle">Connect external services so Vodou can access your data. Most apps use Dynamic Client Registration — zero setup required. Local MCP servers (stdio via <code>npx</code>) use Add server on their card instead of OAuth.</div>
          </div>
        </div>
        <div id="apps-grid" class="apps-grid">
          <div class="spinner-wrap"><div class="spinner"></div></div>
        </div>
      </div>`;

    await loadStatus();
    attachMessageListener();
  }

  async function renderWorkbench(el, serverId) {
    // First make sure the preset cache is warm — the adapter reads it for
    // display name + logo. If the user deep-linked directly to chat mode we
    // may not have a cache yet.
    if (!_presetCache.has(serverId)) {
      try { await loadStatus(); } catch {}
    }

    el.innerHTML = `
      <div class="view-container view-container--workbench">
        <div class="workbench-shell">
          <main class="workbench-main" id="workbench-main">
            <div class="spinner-wrap"><div class="spinner"></div></div>
          </main>
        </div>
      </div>`;

    // Ensure the sidebar has the latest provider list AND paints the nested
    // Tools block under the active integration before the downstream descriptor fetch.
    await loadStatus();

    const scopeRaw = `workbench:integration:${serverId}`;

    // Mount the ScopedWorkbench in the main pane.
    const mainEl = document.getElementById('workbench-main');
    try {
      const descriptor = await window.ScopeRegistry.resolve(scopeRaw);
      if (!descriptor) {
        mainEl.innerHTML = `<div class="empty-state">Could not load workbench for <code>${serverId}</code>. Is this app connected?</div>`;
        return;
      }

      // Render the rail's tool list from the same descriptor — it knows the canonical tools.
      renderRailTools(descriptor);

      // Auto-prefill `/server <id> ` so the user sees the canonical
      // slash-command syntax every time this workbench loads, and the LLM
      // gets an explicit server hint on the first turn.
      const scopeIsIntegration = descriptor.scopeType === 'integration' && descriptor.scopeId;
      const autoPrefill = scopeIsIntegration ? '/server ' + descriptor.scopeId + ' ' : '';

      _activeWorkbench = await window.ScopedWorkbench.mount({
        mount: mainEl,
        scopeDescriptor: descriptor,
        chromeless: true,
        prefill: autoPrefill,
      });
    } catch (err) {
      console.error('[Workbench] mount failed:', err);
      mainEl.innerHTML = `<div class="empty-state">Workbench failed to mount: ${String(err && err.message || err)}</div>`;
    }
  }

  function renderSidebarApps(providers) {
    const container = document.getElementById('nav-apps-items');
    if (!container) return;
    const all = Array.isArray(providers) ? providers : [];
    const connected = all.filter(p => p.connected);
    const disconnected = all.filter(p => !p.connected && !p.blocked).slice(0, 20);
    const h = location.hash || '';
    const pathOnly = (h.split('?')[0] || '').replace(/^#/, '') || '';
    const qs = h.indexOf('?') >= 0 ? h.slice(h.indexOf('?') + 1) : '';
    const urlParams = new URLSearchParams(qs);
    const activeServer = urlParams.get('server');
    const isWorkbench = pathOnly === '/apps' && urlParams.get('mode') === 'chat' && !!activeServer;
    if (!connected.length && !disconnected.length) {
      container.innerHTML = '';
      return;
    }
    const iconFor = (p) => p.logo
      ? `<img src="${escapeAttr(p.logo)}" alt="${escapeAttr(p.name)}" class="nav-app-logo${p.logoColor ? '' : ' icon-logo-mono-img'}" />`
      : `<span class="nav-app-logo">${p.icon || ''}</span>`;
    const connectedRow = (p) => {
      const active = p.id === activeServer ? ' active' : '';
      const contextBlock = (isWorkbench && p.id === activeServer) ? `
        <div class="nav-app-context" id="nav-app-context">
          <div class="nav-app-context-label">Tools</div>
          <div class="workbench-rail-tools" id="workbench-rail-tools">
            <div class="sw-tool-hint">Loading…</div>
          </div>
        </div>` : '';
      return `<a href="#/apps?server=${encodeURIComponent(p.id)}&mode=chat" class="nav-item nav-item-app${active}" title="${escapeAttr(p.name)} workbench">
          ${iconFor(p)}
          <span class="nav-app-name">${escapeAttr(p.name)}</span>
          <button type="button" class="nav-item-gear" data-provider="${escapeAttr(p.id)}" title="Manage ${escapeAttr(p.name)}" aria-label="Manage ${escapeAttr(p.name)}">${GEAR_SVG}</button>
        </a>${contextBlock}`;
    };
    const disconnectedRow = (p) => `
      <div class="nav-app-sidebar-row">
        <button type="button" class="nav-item nav-item-disconnected" data-provider="${escapeAttr(p.id)}" title="Connect ${escapeAttr(p.name)}">
          ${iconFor(p)}
          <span class="nav-app-name">${escapeAttr(p.name)}</span>
          <span class="nav-app-plus" aria-hidden="true">+</span>
        </button>
        <button type="button" class="nav-item-gear" data-provider="${escapeAttr(p.id)}" title="Setup &amp; tokens — ${escapeAttr(p.name)}" aria-label="Setup ${escapeAttr(p.name)}">${GEAR_SVG}</button>
      </div>`;
    const disconnectedBlock = disconnected.length ? `
      <details class="nav-apps-more">
        <summary class="nav-apps-more-summary">Not connected (${disconnected.length})</summary>
        <div class="nav-apps-more-list">
          ${disconnected.map(disconnectedRow).join('')}
        </div>
      </details>` : '';
    const prevToolsEl = document.getElementById('workbench-rail-tools');
    const prevToolsHtml = prevToolsEl ? prevToolsEl.innerHTML : null;

    container.innerHTML = connected.map(connectedRow).join('') + disconnectedBlock;
    _lastProviders = providers;
    _ensureDisconnectedHandlers();

    if (prevToolsHtml && !prevToolsHtml.includes('Loading…')) {
      const newTools = document.getElementById('workbench-rail-tools');
      if (newTools) newTools.innerHTML = prevToolsHtml;
    }
  }

  function renderRailTools(descriptor) {
    const toolsDiv = document.getElementById('workbench-rail-tools');
    if (!toolsDiv) return;
    const tools = descriptor.toolRail || [];
    if (!tools.length) {
      toolsDiv.innerHTML = '<div class="sw-tool-hint">No tools cached for this server. Connect or refresh.</div>';
      return;
    }
    toolsDiv.innerHTML = tools.map((t) => `
      <button type="button" class="workbench-rail-tool" data-prefill="${escapeAttr(t.prefill || '')}" title="${escapeAttr(t.description || '')}">
        <span class="workbench-rail-tool-name">${escapeAttr(t.name)}</span>
        ${t.description ? `<span class="workbench-rail-tool-desc">${escapeAttr(t.description)}</span>` : ''}
      </button>
    `).join('');
    toolsDiv.querySelectorAll('.workbench-rail-tool').forEach((b) => {
      b.addEventListener('click', () => {
        const p = b.dataset.prefill || '';
        const input = document.querySelector('.workbench-main .sw-input');
        if (input) {
          input.value = p;
          input.focus();
          input.selectionStart = input.selectionEnd = input.value.length;
        }
      });
    });
  }

  async function loadStatus() {
    try {
      const [oauthRes, serversRes] = await Promise.all([
        fetch('/api/oauth/status'),
        fetch('/api/servers').catch(() => null),
      ]);
      if (!oauthRes.ok) throw new Error(`HTTP ${oauthRes.status}`);
      const { providers } = await oauthRes.json();

      // Merge in per-server fields from /api/servers (tool_count, intent_count, health,
      // active flag) when available — keeps Apps cards in sync with the source of truth
      // that the (now hidden) Capabilities → MCP Servers tab reads from.
      if (serversRes && serversRes.ok) {
        try {
          const { servers } = await serversRes.json();
          const byName = new Map((servers || []).map(s => [s.name, s]));
          for (const p of providers) {
            const s = byName.get(p.id);
            if (!s) continue;
            if (typeof s.tool_count === 'number') p.toolCount = s.tool_count;
            if (typeof s.intent_count === 'number') p.intentCount = s.intent_count;
            if (s.health_status) p.mcpHealth = s.health_status;
            if (typeof s.active === 'number') p.mcpEnabled = s.active !== 0;
          }
        } catch { /* /api/servers shape changed — fall back to oauth/status only */ }
      }

      let catalog = { ok: false, available: false, rows: [] };
      try {
        const regRes = await fetch('/api/mcp-registry/dcr-targets');
        if (regRes.ok) catalog = await regRes.json();
      } catch {
        /* optional local mcp-registry snapshot */
      }

      renderGrid(providers, catalog);
      renderSidebarApps(providers);
      return providers;
    } catch (err) {
      const grid = document.getElementById('apps-grid');
      if (grid) grid.innerHTML = `<p class="error-msg">Failed to load apps: ${err.message}</p>`;
      return null;
    }
  }

  // Connection is async: OAuth grants land first, then MCP tool discovery fills in
  // toolCount + mcpHealth a few seconds later. After a fresh connect we poll until
  // that downstream state settles so the card doesn't sit at "connected but 0 tools".
  function isProviderSettled(p) {
    if (!p || !p.connected) return false;
    return p.mcpHealth === 'healthy' || (p.toolCount != null && p.toolCount > 0);
  }

  let _activePoll = null;
  async function pollUntilSettled(providerId, { attempts = 8, intervalMs = 2000 } = {}) {
    if (_activePoll === providerId) return;
    _activePoll = providerId;
    try {
      for (let i = 0; i < attempts; i++) {
        await new Promise(r => setTimeout(r, intervalMs));
        if (_activePoll !== providerId) return;
        const providers = await loadStatus();
        if (!providers) return;
        const p = providers.find(x => x.id === providerId);
        if (isProviderSettled(p)) return;
      }
    } finally {
      if (_activePoll === providerId) _activePoll = null;
    }
  }

  function renderMcpRegistryCatalog(catalog) {
    if (!catalog || catalog.ok === false) return '';
    if (!catalog.available) {
      const hint = catalog.hint || 'No local mcp-registry snapshot (registry.db missing).';
      return `
      <div class="category-section mcp-registry-catalog">
        <h2 class="category-title">MCP registry — DCR advertised</h2>
        <p class="form-hint">${escapeAttr(hint)}</p>
      </div>`;
    }
    const rows = catalog.rows || [];
    if (rows.length === 0) {
      return `
      <div class="category-section mcp-registry-catalog">
        <h2 class="category-title">MCP registry — DCR advertised</h2>
        <p class="form-hint">Catalog file exists but there are no rows with <code>dcr_advertised</code>. Run <code>mcp-registry</code> metadata / DCR probes.</p>
      </div>`;
    }
    const listHtml = rows
      .map((row) => {
        const reg = row.registry_name
          ? `<span class="mcp-dcr-reg">${escapeAttr(row.registry_name)}</span>`
          : '';
        return `<div class="mcp-dcr-row" data-needle="${escapeAttr(row.needle || '')}">
        <div class="mcp-dcr-main">
          <div class="mcp-dcr-title">${escapeAttr(row.display_name || '')}</div>
          ${reg}
          <code class="mcp-dcr-url">${escapeAttr(row.mcp_url || '')}</code>
        </div>
        <button type="button" class="btn btn-sm btn-primary" data-action="mcp-dcr-connect" data-url="${escapeAttr(row.mcp_url || '')}" data-name="${escapeAttr(row.server_name || '')}">Connect</button>
      </div>`;
      })
      .join('');
    return `
      <div class="category-section mcp-registry-catalog">
        <h2 class="category-title">MCP registry — DCR advertised</h2>
        <p class="form-hint">Local snapshot — <strong>${rows.length}</strong> server(s) in <code>mcp-registry/data/registry.db</code> with DCR advertised. <strong>Connect</strong> uses the same OAuth flow as &quot;Add custom app&quot;; server name is <code>mcreg_&lt;catalog id&gt;</code>.</p>
        <input type="search" id="mcp-dcr-filter" class="form-input mcp-dcr-filter" placeholder="Filter by name, URL, registry id…" autocomplete="off" />
        <div id="mcp-dcr-list" class="mcp-dcr-list">${listHtml}</div>
      </div>`;
  }

  function renderGrid(providers, catalog) {
    const grid = document.getElementById('apps-grid');
    if (!grid) return;

    if (!providers || providers.length === 0) {
      grid.innerHTML = '<p class="empty-msg">No apps configured.</p>';
      return;
    }

    // Group by category
    const byCategory = {};
    providers.forEach(p => {
      if (!byCategory[p.category]) byCategory[p.category] = [];
      byCategory[p.category].push(p);
    });

    const categoryOrder = ['Design & Dev', 'Productivity', 'Finance & Infra', 'Custom'];
    let html = categoryOrder
      .filter(cat => byCategory[cat])
      .map(cat => `
        <div class="category-section">
          <h2 class="category-title">${cat}</h2>
          <div class="card-grid">
            ${byCategory[cat].map(renderCard).join('')}
          </div>
        </div>
      `).join('');

    html += renderMcpRegistryCatalog(catalog || {});

    // Add custom app form
    html += `
      <div class="category-section">
        <h2 class="category-title">Add Custom App</h2>
        <div class="custom-integration-form">
          <p class="form-hint">Paste any remote MCP server URL. If the server supports OAuth (DCR), you'll be prompted to authorize. Otherwise, enter an API key.</p>
          <div class="form-row">
            <input type="text" id="custom-mcp-url" placeholder="https://mcp.example.com/mcp" class="form-input" />
            <input type="text" id="custom-mcp-name" placeholder="Name (optional)" class="form-input form-input-sm" />
          </div>
          <div class="form-row">
            <button class="btn btn-sm btn-primary" id="custom-connect-oauth">Connect (OAuth)</button>
            <button class="btn btn-sm" id="custom-toggle-apikey">Use API Key</button>
          </div>
          <div class="api-key-input is-hidden" id="custom-apikey-section">
            <input type="password" id="custom-apikey-field" placeholder="Paste API key or bearer token" />
            <button class="btn btn-sm btn-primary" id="custom-save-apikey">Save</button>
          </div>
          <div id="custom-error" class="custom-error is-hidden"></div>
        </div>
      </div>`;

    grid.innerHTML = html;

    // Attach event handlers — cards only fire Connect (DCR simple), Disconnect, or open-modal.
    // All setup flows, credential entry, tests, etc. live inside the modal.
    grid.querySelectorAll('[data-action="connect"]').forEach(btn =>
      btn.addEventListener('click', () => connectProvider(btn.dataset.provider))
    );
    grid.querySelectorAll('[data-action="disconnect"]').forEach(btn =>
      btn.addEventListener('click', () => disconnectProvider(btn.dataset.provider))
    );
    grid.querySelectorAll('[data-action="open-modal"]').forEach(btn =>
      btn.addEventListener('click', () => openProviderModal(btn.dataset.provider))
    );
    grid.querySelectorAll('[data-action="open-workbench"]').forEach(btn =>
      btn.addEventListener('click', () => {
        location.hash = `#/apps?server=${encodeURIComponent(btn.dataset.provider)}&mode=chat`;
      })
    );
    grid.querySelectorAll('[data-action="toggle-active"]').forEach((input) =>
      input.addEventListener('change', (ev) => onToggleActive(ev.currentTarget))
    );
    // Custom integration form handlers
    const oauthBtn = document.getElementById('custom-connect-oauth');
    if (oauthBtn) oauthBtn.addEventListener('click', connectCustomOAuth);
    const toggleBtn = document.getElementById('custom-toggle-apikey');
    if (toggleBtn) toggleBtn.addEventListener('click', () => {
      const section = document.getElementById('custom-apikey-section');
      if (section) section.classList.toggle('is-hidden');
    });
    const saveBtn = document.getElementById('custom-save-apikey');
    if (saveBtn) saveBtn.addEventListener('click', saveCustomApiKey);

    attachMcpDcrHandlers();
  }

  function attachMcpDcrHandlers() {
    const filt = document.getElementById('mcp-dcr-filter');
    const list = document.getElementById('mcp-dcr-list');
    if (filt && list) {
      filt.addEventListener('input', () => {
        const terms = filt.value
          .toLowerCase()
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        list.querySelectorAll('.mcp-dcr-row').forEach((row) => {
          const hay = row.getAttribute('data-needle') || '';
          const ok = terms.length === 0 || terms.every((w) => hay.includes(w));
          row.classList.toggle('is-hidden', !ok);
        });
      });
    }
    document.querySelectorAll('[data-action="mcp-dcr-connect"]').forEach((btn) => {
      btn.addEventListener('click', () => connectMcpDcrCatalog(btn));
    });
  }

  async function connectMcpDcrCatalog(btn) {
    const url = btn.getAttribute('data-url');
    const name = btn.getAttribute('data-name');
    if (!url) return;
    try {
      const res = await fetch('/api/oauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, name }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Failed to start OAuth', 'error');
        return;
      }
      const popup = window.open(data.authorize_url, '_blank', 'width=700,height=800,noopener');
      if (!popup) showFallbackLink(name || url, data.authorize_url);
    } catch (err) {
      showToast(err.message || String(err), 'error');
    }
  }

  // Keep a map of presets by id so modal openers can look up full preset data on click.
  // Also exposed on window so the IntegrationScopeAdapter can read the same cache
  // without opening a second API fetch path.
  const _presetCache = new Map();
  window._integrationPresets = _presetCache;

  // Expose selected helpers so the scoped workbench (Integration adapter) can
  // render the same setup instructions + Connect flow as the cards on this view.
  // Keeping the modal + connect code colocated here — the adapter just delegates.
  window._integrationUi = {
    openProviderModal: (id) => openProviderModal(id),
    connectProvider: (id) => connectProvider(id),
    buildStepsHtml: (steps) => buildStepsHtml(steps),
    // Full inline panel — renders install steps + credential inputs + submit
    // buttons directly into `mountEl`. After a successful connect/save/test,
    // re-fetches /api/oauth/status, updates the preset cache, and re-renders
    // itself so the panel flips to a "Connected" view without a page reload.
    renderSetupPanel: (providerId, mountEl) => renderSetupPanel(providerId, mountEl),
    // Lightweight modal that wraps renderSetupPanel — used by workbench header's
    // "Manage" button so unconnected + connected servers get the same UI surface.
    manageConnection: (providerId) => manageConnection(providerId),
  };

  async function manageConnection(providerId) {
    // Warm cache so preset is available for icon/name/status in the header.
    if (!_presetCache.has(providerId)) {
      try { await loadStatus(); } catch {}
    }
    const p = _presetCache.get(providerId);
    const iconHtml = p?.logo
      ? `<img src="${escapeAttr(p.logo)}" alt="${escapeAttr(p.name)}" class="${p.logoColor ? '' : 'icon-logo-mono-img'}" />`
      : `<span class="icon">${p?.icon || ''}</span>`;
    const sheet = Components.openModal({
      iconHtml,
      title: p?.name || providerId,
      subtitle: p?.connected ? (p.expired ? 'Expired' : 'Connected') : 'Not connected',
    });
    if (p && p.logoColor === false) {
      const iconWrap = sheet.overlay.querySelector('.modal-sheet-icon');
      if (iconWrap) iconWrap.classList.add('icon-logo-mono');
    }
    // Give the modal's body the inline panel. Any save/test/connect/disconnect
    // re-renders the panel inside the same mountEl — no modal teardown needed.
    renderSetupPanel(providerId, sheet.body);
    return sheet;
  }

  // Re-fetch status, update cache, return the (possibly updated) preset.
  async function refreshPresetFromStatus(providerId) {
    try {
      const res = await fetch('/api/oauth/status');
      if (!res.ok) return _presetCache.get(providerId);
      const { providers } = await res.json();
      if (Array.isArray(providers)) {
        for (const p of providers) _presetCache.set(p.id, p);
      }
    } catch {}
    return _presetCache.get(providerId);
  }

  function renderSetupPanel(providerId, mountEl) {
    const p = _presetCache.get(providerId);
    if (!mountEl) return;
    if (!p) {
      mountEl.innerHTML = `<div class="sw-empty-hint">App preset for <code>${escapeAttr(providerId)}</code> not found.</div>`;
      return;
    }
    mountEl.innerHTML = '';

    const panel = document.createElement('div');
    panel.className = 'sw-setup-panel';

    const authLabel =
      p.authPath === 'dcr' && p.dcrOptionalApiKey ? 'OAuth or API key'
      : p.authPath === 'dcr' ? 'Auto-setup (DCR)'
      : p.authPath === 'apiKey' ? 'API key'
      : p.authPath === 'manual' ? 'Manual OAuth'
      : p.authPath === 'localStdio' ? 'Local MCP'
      : '';
    const mcpOn = p.mcpEnabled !== false;
    const healthy = p.connected && !p.expired && !p.blocked && mcpOn && p.mcpHealth === 'healthy';
    const statusLabel = p.blocked
      ? 'Blocked'
      : p.connected
        ? (p.expired ? 'Expired' : (healthy ? 'Connected · healthy' : (!mcpOn ? 'Saved · inactive' : (p.mcpHealth === 'unhealthy' ? 'Connected · MCP error' : 'Connected'))))
        : 'Not connected';
    const statusClass = healthy ? 'ok' : (p.expired || p.blocked || p.mcpHealth === 'unhealthy') ? 'warn' : p.connected ? 'warn' : 'muted';
    const dotClass = healthy ? 'ok' : (p.expired || p.blocked || p.mcpHealth === 'unhealthy') ? 'warn' : p.connected ? 'idle' : 'off';
    const toolCountChip = (p.connected && p.toolCount != null)
      ? `<span class="sw-setup-tool-count">${p.toolCount} tool${p.toolCount === 1 ? '' : 's'}</span>`
      : '';

    panel.innerHTML = `
      <div class="sw-setup-header">
        <div class="sw-setup-title">
          <span class="sw-setup-dot sw-setup-dot-${dotClass}" title="${escapeAttr(statusLabel)}"></span>
          ${escapeAttr(p.name)}${p.connected ? '' : ' — connect'}
          ${toolCountChip}
        </div>
        <div class="sw-setup-auth">${escapeAttr(authLabel)} <span class="sw-setup-status sw-setup-status-${statusClass}">${escapeAttr(statusLabel)}</span></div>
      </div>
      ${p.description ? `<p class="sw-setup-desc">${escapeAttr(p.description)}</p>` : ''}
    `;
    mountEl.appendChild(panel);

    // Blocked providers: show the reason + setup steps (recall), no forms.
    if (p.blocked) {
      const blockBody = document.createElement('div');
      blockBody.innerHTML = `<p class="sw-setup-desc">${escapeAttr(p.blockedReason || 'Unavailable from this hub.')}</p>${buildStepsHtml(p.setupSteps)}`;
      panel.appendChild(blockBody);
      if (p.setupDocsUrl) {
        const actions = document.createElement('div');
        actions.className = 'sw-setup-actions';
        actions.innerHTML = `<a href="${escapeAttr(p.setupDocsUrl)}" target="_blank" rel="noopener" class="setup-link">Provider docs →</a>`;
        panel.appendChild(actions);
      }
      return;
    }

    // Connection KV (connected only)
    if (p.connected) {
      const kv = document.createElement('div');
      kv.className = 'sw-setup-kv';
      const rows = [
        [p.authPath === 'localStdio' ? 'stdio' : 'MCP URL', `<code>${escapeAttr(p.mcpUrl || '—')}</code>`],
        ['Auth', p.credentialType === 'local_stdio' ? 'Local stdio' : (p.credentialType || '—')],
        ...(p.scope ? [['Scope', `<code>${escapeAttr(p.scope)}</code>`]] : []),
        ['Tools', p.toolCount != null ? String(p.toolCount) : '—'],
        ['Updated', p.updatedAt || '—'],
      ];
      kv.innerHTML = rows.map(([k, v]) => `<div class="sw-setup-kv-row"><span class="sw-setup-kv-k">${escapeAttr(k)}</span><span class="sw-setup-kv-v">${v}</span></div>`).join('');
      panel.appendChild(kv);
    }

    // Setup instructions: only show on first-time connect. Once connected,
    // the user doesn't need the walkthrough cluttering the panel — they can
    // re-open the gear/details modal if they ever need to recall.
    if (p.setupSteps && p.setupSteps.length && !p.connected) {
      const steps = document.createElement('details');
      steps.className = 'sw-setup-steps-wrap';
      steps.setAttribute('open', '');
      steps.innerHTML = `
        <summary class="sw-setup-steps-summary">Setup instructions</summary>
        ${buildStepsHtml(p.setupSteps)}
      `;
      panel.appendChild(steps);
    }

    // Auth-path specific form
    const form = document.createElement('div');
    form.className = 'sw-setup-form';
    panel.appendChild(form);

    const actions = document.createElement('div');
    actions.className = 'sw-setup-actions';
    panel.appendChild(actions);

    // Test-result area (shared with connected-state test flow)
    const testArea = document.createElement('div');
    testArea.className = 'test-result is-hidden';
    testArea.id = `test-result-${p.id}`;
    panel.appendChild(testArea);

    if (p.connected) {
      // Connected: expose the right "change credentials" affordance for this
      // auth path + Test/Disconnect + docs link.
      //   apiKey   → Replace API key input + Save button
      //   manual   → Client ID/Secret inputs (prefilled) + Reconnect button
      //   dcr      → Reconnect button (re-runs DCR OAuth with existing clientId)
      //   localStdio → read-only view, no change UI (edit via Servers page)
      const isApiKey = p.credentialType === 'api_key' || p.credentialType === 'bearer_token';
      const isManual = p.authPath === 'manual';
      const isDcr = p.authPath === 'dcr';
      const isStdio = p.authPath === 'localStdio';

      if (isApiKey) {
        form.innerHTML = `
          <label class="sw-setup-label">Replace API key</label>
          <input type="password" id="api-key-field-${p.id}" placeholder="Paste new ${escapeAttr(p.name)} token" class="sheet-input" />
        `;
      } else if (isManual) {
        form.innerHTML = `
          <div class="saved-creds-hint">✓ Loaded saved credentials. Overwrite either field then click <strong>Reconnect</strong> to re-authorize.</div>
          <label class="sw-setup-label">Client ID</label>
          <input type="text" id="manual-client-id-${p.id}" placeholder="Client ID" class="sheet-input" value="${escapeAttr(p.savedClientId || '')}" />
          <label class="sw-setup-label">Client Secret</label>
          <input type="password" id="manual-client-secret-${p.id}" placeholder="Client Secret" class="sheet-input" value="${escapeAttr(p.savedClientSecret || '')}" />
        `;
      } else if (isDcr) {
        const oauthActive = p.credentialType === 'oauth_access_token';
        const keySwitch = p.dcrOptionalApiKey && oauthActive;
        form.innerHTML = `
          <div class="saved-creds-hint">Authorized via DCR (no manual OAuth app needed). Click <strong>Reconnect</strong> to re-authorize if tokens were revoked.</div>
          ${keySwitch ? `
          <p class="form-hint" style="margin-top:10px">Or paste an API key to switch — saving clears OAuth tokens for this app.</p>
          <label class="sw-setup-label">API key</label>
          <input type="password" id="api-key-field-${p.id}" placeholder="tvly-…" class="sheet-input" />` : ''}
        `;
      }

      actions.innerHTML = `
        ${isApiKey ? `<button type="button" class="btn btn-primary" data-sw-action="save-key">Save</button>` : ''}
        ${isDcr && p.dcrOptionalApiKey && p.credentialType === 'oauth_access_token' ? `<button type="button" class="btn" data-sw-action="save-key">Save key (replace OAuth)</button>` : ''}
        ${isManual ? `<button type="button" class="btn btn-primary" data-sw-action="manual-connect">Reconnect</button>` : ''}
        ${isDcr ? `<button type="button" class="btn btn-primary" data-sw-action="dcr-connect">Reconnect</button>` : ''}
        <button type="button" class="btn" data-sw-action="test">Test connection</button>
        <button type="button" class="btn btn-danger" data-sw-action="disconnect">Disconnect</button>
        ${p.setupDocsUrl ? `<a href="${escapeAttr(p.setupDocsUrl)}" target="_blank" rel="noopener" class="setup-link">${isStdio ? 'Provider docs' : 'Where to get this'} →</a>` : ''}
      `;
    } else if (p.authPath === 'apiKey') {
      form.innerHTML = `
        <label class="sw-setup-label">API token</label>
        <input type="password" id="api-key-field-${p.id}" placeholder="Paste your ${escapeAttr(p.name)} token" class="sheet-input" />
      `;
      actions.innerHTML = `
        <button type="button" class="btn btn-primary" data-sw-action="save-key">Save &amp; Connect</button>
        ${p.setupDocsUrl ? `<a href="${escapeAttr(p.setupDocsUrl)}" target="_blank" rel="noopener" class="setup-link">Where to get this →</a>` : ''}
      `;
    } else if (p.authPath === 'manual') {
      const hasSaved = !!(p.savedClientId || p.savedClientSecret);
      form.innerHTML = `
        ${hasSaved ? `<div class="saved-creds-hint">✓ Loaded saved credentials. Overwrite either field to change.</div>` : ''}
        <label class="sw-setup-label">Client ID</label>
        <input type="text" id="manual-client-id-${p.id}" placeholder="Client ID" class="sheet-input" value="${escapeAttr(p.savedClientId || '')}" />
        <label class="sw-setup-label">Client Secret</label>
        <input type="password" id="manual-client-secret-${p.id}" placeholder="Client Secret" class="sheet-input" value="${escapeAttr(p.savedClientSecret || '')}" />
      `;
      actions.innerHTML = `
        <button type="button" class="btn btn-primary" data-sw-action="manual-connect">${hasSaved ? 'Reconnect' : 'Connect'}</button>
        ${p.setupDocsUrl ? `<a href="${escapeAttr(p.setupDocsUrl)}" target="_blank" rel="noopener" class="setup-link">Where to get this →</a>` : ''}
      `;
    } else if (p.authPath === 'userUrl') {
      const placeholder = p.userSuppliedUrlPlaceholder || `https://mcp.${p.id}.com/your-id`;
      form.innerHTML = `
        <label class="sw-setup-label">Your ${escapeAttr(p.name)} MCP URL</label>
        <input type="url" id="user-url-${p.id}" placeholder="${escapeAttr(placeholder)}" class="sheet-input" />
        <p class="form-hint">After completing the setup steps above, paste the personal MCP URL the vendor gave you.</p>
      `;
      actions.innerHTML = `
        <button type="button" class="btn btn-primary" data-sw-action="user-url-connect" data-provider="${p.id}">Connect</button>
        ${p.setupDocsUrl ? `<a href="${escapeAttr(p.setupDocsUrl)}" target="_blank" rel="noopener" class="setup-link">${escapeAttr(p.name)} docs →</a>` : ''}`;
    } else if (p.authPath === 'localStdio') {
      const cmd = p.stdioCommand || '';
      const args = Array.isArray(p.stdioArgs) ? p.stdioArgs : [];
      form.innerHTML = `
        <label class="sw-setup-label">Binary</label>
        <div class="sw-setup-readonly"><code>${escapeAttr(cmd)}</code></div>
        <label class="sw-setup-label">Args</label>
        <div class="sw-setup-readonly"><code>${escapeAttr(args.join(' '))}</code></div>
      `;
      actions.innerHTML = `<button type="button" class="btn btn-primary" data-sw-action="add-stdio" data-provider="${p.id}" data-command="${escapeAttr(cmd)}" data-args="${escapeAttr(JSON.stringify(args))}">Add server</button>`;
    } else if (p.authPath === 'dcr' && p.dcrOptionalApiKey) {
      const envHint = p.apiKeyEnv
        ? `<p class="form-hint">You can also set <code>${escapeAttr(p.apiKeyEnv)}</code> in the gateway environment.</p>`
        : '';
      form.innerHTML = `
        <p class="form-hint">Use <strong>Connect with OAuth</strong> (browser) or paste an <strong>API key</strong> from the provider dashboard.</p>
        <label class="sw-setup-label">API key</label>
        <input type="password" id="api-key-field-${p.id}" placeholder="Paste token (e.g. tvly-…)" class="sheet-input" />
        ${envHint}`;
      actions.classList.add('sw-setup-actions-col');
      actions.innerHTML = `
        <button type="button" class="btn btn-primary" data-sw-action="save-key">Save API key &amp; Connect</button>
        <button type="button" class="btn" data-sw-action="dcr-connect">Connect with OAuth</button>
        ${p.setupDocsUrl ? `<a href="${escapeAttr(p.setupDocsUrl)}" target="_blank" rel="noopener" class="setup-link">Provider docs →</a>` : ''}`;
    } else {
      // DCR (OAuth only)
      actions.innerHTML = `<button type="button" class="btn btn-primary" data-sw-action="dcr-connect">Connect</button>`;
    }

    // Wire up actions — after any action, refresh state from /api/oauth/status
    // and re-render this same panel so the user sees Connected immediately.
    const reRender = async () => {
      await refreshPresetFromStatus(p.id);
      renderSetupPanel(p.id, mountEl);
    };

    panel.querySelectorAll('[data-sw-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.getAttribute('data-sw-action');
        try {
          if (action === 'save-key') {
            await saveApiKey(p.id);
            await reRender();
          } else if (action === 'manual-connect') {
            await connectManualOAuth(p.id);
            // Popup is open — poll, then re-render when settled.
            pollUntilSettled(p.id);
            setTimeout(reRender, 1500);
          } else if (action === 'add-stdio') {
            await connectLocalStdio(btn);
            await reRender();
          } else if (action === 'dcr-connect') {
            await connectProvider(p.id);
            pollUntilSettled(p.id);
            setTimeout(reRender, 1500);
          } else if (action === 'user-url-connect') {
            await connectUserSuppliedUrl(p);
            pollUntilSettled(p.id);
            setTimeout(reRender, 1500);
          } else if (action === 'test') {
            await testConnection(p.id);
          } else if (action === 'disconnect') {
            await disconnectProvider(p.id);
            await reRender();
          }
        } catch (err) {
          showToast(err.message || String(err), 'error');
        }
      });
    });
  }

  function buildStepsHtml(steps) {
    if (!steps || !steps.length) return '';
    return `<ol class="setup-steps">${steps.map(s => `
      <li>
        <div class="step-title">${s.title}</div>
        <div class="step-instructions">${s.instructions}</div>
        ${s.gotcha ? `<div class="step-gotcha">⚠ ${s.gotcha}</div>` : ''}
        ${s.link ? `<a href="${escapeAttr(s.link.url)}" target="_blank" rel="noopener" class="step-link">${s.link.label} →</a>` : ''}
      </li>`).join('')}</ol>`;
  }

  function renderCard(p) {
    _presetCache.set(p.id, p);
    const authBadge =
      p.blocked ? '<span class="manual-badge" title="OAuth cannot complete from this hub for this provider">Blocked</span>'
      : p.authPath === 'localStdio' ? '<span class="local-badge" title="Runs a command on this machine — no cloud OAuth">Local MCP</span>'
      : p.authPath === 'dcr' && p.dcrOptionalApiKey ? '<span class="auto-setup-badge" title="OAuth (DCR) or paste an API key">OAuth / key</span>'
      : p.authPath === 'dcr' ? '<span class="auto-setup-badge" title="Dynamic Client Registration — no manual OAuth app needed">Auto-setup</span>'
      : p.authPath === 'apiKey' ? '<span class="api-key-badge">API key</span>'
      : p.authPath === 'userUrl' ? '<span class="manual-badge" title="Sign in to the vendor and paste your personal MCP URL">Paste URL</span>'
      : '<span class="manual-badge">Manual OAuth</span>';

    const mcpOn = p.mcpEnabled !== false;
    const statusBadge = !p.connected
      ? '<span class="badge badge-off">Not connected</span>'
      : !mcpOn
        ? '<span class="badge badge-warn" title="Toggle Active on this card to enable">Saved · inactive</span>'
        : (p.expired ? '<span class="badge badge-warn">Expired</span>' : '<span class="badge badge-ok">Connected</span>');

    const mcpBadge = p.connected && mcpOn
      ? (p.mcpHealth === 'healthy' ? '<span class="badge badge-ok">MCP healthy</span>'
        : p.mcpHealth === 'unhealthy' ? '<span class="badge badge-warn">MCP error</span>'
        : '<span class="badge badge-off">MCP ' + p.mcpHealth + '</span>')
      : '';

    const intentBadge = (p.connected && p.intentCount > 0)
      ? `<span class="badge badge-off" title="${p.intentCount} intent mapping${p.intentCount === 1 ? '' : 's'}">${p.intentCount} intent${p.intentCount === 1 ? '' : 's'}</span>`
      : '';

    // Decide the primary action button + whether it opens the modal or fires directly.
    // Modal houses: setup steps, credential forms, tools list, test, disconnect, etc.
    let primaryBtn = '';
    let detailsLabel = 'Details';
    if (p.blocked) {
      primaryBtn = `<button class="btn btn-sm" disabled title="${escapeAttr(p.blockedReason || 'Unavailable from this hub')}">Unavailable</button>`;
      detailsLabel = 'Why blocked →';
    } else if (p.connected) {
      primaryBtn = `<button class="btn btn-sm btn-danger" data-action="disconnect" data-provider="${p.id}">Disconnect</button>`;
    } else if (p.authPath === 'localStdio') {
      primaryBtn = `<button class="btn btn-sm btn-primary" data-action="open-modal" data-provider="${p.id}">Add server</button>`;
    } else if (p.authPath === 'dcr') {
      const hasSteps = p.setupSteps && p.setupSteps.length;
      primaryBtn = hasSteps
        ? `<button class="btn btn-sm btn-primary" data-action="open-modal" data-provider="${p.id}">Setup &amp; Connect</button>`
        : `<button class="btn btn-sm btn-primary" data-action="connect" data-provider="${p.id}">Connect</button>`;
    } else if (p.authPath === 'apiKey') {
      primaryBtn = `<button class="btn btn-sm btn-primary" data-action="open-modal" data-provider="${p.id}">${(p.setupSteps && p.setupSteps.length) ? 'Setup &amp; Connect' : 'Enter API key'}</button>`;
    } else if (p.authPath === 'manual') {
      const hasSaved = !!(p.savedClientId || p.savedClientSecret);
      primaryBtn = `<button class="btn btn-sm btn-primary" data-action="open-modal" data-provider="${p.id}">${hasSaved ? 'Reconnect' : 'Setup &amp; Connect'}</button>`;
    } else if (p.authPath === 'userUrl') {
      primaryBtn = `<button class="btn btn-sm btn-primary" data-action="open-modal" data-provider="${p.id}">Setup &amp; Connect</button>`;
    }

    const iconHtml = p.logo
      ? `<span class="icon icon-logo ${p.logoColor ? 'icon-logo-color' : 'icon-logo-mono'}">
           <img src="${p.logo}" alt="${escapeAttr(p.name)}" onerror="this.parentNode.innerHTML=${JSON.stringify(p.icon)}" />
         </span>`
      : `<span class="icon">${p.icon}</span>`;

    const metaHtml = [authBadge, statusBadge, mcpBadge, intentBadge].filter(Boolean).join(' ');
    const stateClass = p.blocked ? 'is-blocked' : p.expired ? 'is-expired' : p.connected ? 'is-connected' : 'is-idle';

    const chatBtn = p.connected
      ? `<button type="button" class="btn btn-sm btn-secondary" data-action="open-workbench" data-provider="${p.id}">Chat →</button>`
      : '';

    // Active toggle — visible whenever the server row exists in mcp_servers (connected
    // OAuth/key, or registered local stdio). Lets users enable/disable orchestration
    // straight from the card so they never have to bounce to Capabilities → MCP Servers.
    const isRegistered = p.connected || (p.credentialType === 'local_stdio');
    const activeToggleHtml = (isRegistered && !p.blocked) ? `
      <div class="card-active-row">
        <span class="card-active-label">Active</span>
        <label class="toggle-switch" title="${mcpOn ? 'Disable' : 'Enable'} for orchestration">
          <input type="checkbox" ${mcpOn ? 'checked' : ''}
                 data-action="toggle-active" data-provider="${escapeAttr(p.id)}" />
          <span class="toggle-slider"></span>
        </label>
      </div>` : '';

    return `
      <div class="integration-card ${stateClass}">
        <div class="card-header">
          ${iconHtml}
          <div class="info"><div class="name">${p.name}</div></div>
        </div>
        <div class="description">${p.description}</div>
        <div class="actions">
          ${primaryBtn}
          ${chatBtn}
          <div class="integration-card-manage-row">
            <button type="button" class="nav-item-gear integration-card-gear" data-action="open-modal" data-provider="${p.id}" title="Manage ${escapeAttr(p.name)}" aria-label="Manage ${escapeAttr(p.name)}">${GEAR_SVG}</button>
            <button type="button" class="card-details-link" data-action="open-modal" data-provider="${p.id}">${detailsLabel}</button>
          </div>
        </div>
        ${metaHtml ? `<div class="meta card-meta-footer">${metaHtml}</div>` : ''}
        ${activeToggleHtml}
      </div>`;
  }

  // --- Modal (sheet) renderer — houses setup steps, credentials, MCP info, tools, actions ---
  /** Same `<details>` pattern as channel gear modal (channels.js `_collapsibleSection`). */
  function _collapsibleSection(labelText, { openByDefault = false } = {}) {
    const section = document.createElement('div');
    section.className = 'sheet-section';
    const details = document.createElement('details');
    details.className = 'sw-setup-steps-wrap sheet-section-collapsible';
    if (openByDefault) details.setAttribute('open', '');
    const summary = document.createElement('summary');
    summary.className = 'sw-setup-steps-summary';
    summary.textContent = labelText;
    details.appendChild(summary);
    section.appendChild(details);
    return { section, body: details };
  }

  function _mkSection(label) {
    const root = document.createElement('div');
    root.className = 'sheet-section';
    const l = document.createElement('div');
    l.className = 'sheet-section-label';
    l.textContent = label;
    root.appendChild(l);
    const body = document.createElement('div');
    root.appendChild(body);
    return { root, body };
  }
  function _mkKv(label, rows) {
    const s = _mkSection(label);
    rows.forEach(([k, v]) => {
      const row = document.createElement('div');
      row.className = 'sheet-kv-row';
      row.innerHTML = `<div class="sheet-kv-label">${k}</div><div class="sheet-kv-value">${v}</div>`;
      s.body.appendChild(row);
    });
    return s.root;
  }

  async function openProviderModal(providerId) {
    await ensurePresetInCache(providerId);
    const p = _presetCache.get(providerId);
    if (!p) {
      showToast('Could not load app.', 'error');
      return;
    }
    const mcpOn = p.mcpEnabled !== false;

    const iconHtml = p.logo
      ? `<img src="${escapeAttr(p.logo)}" alt="${escapeAttr(p.name)}" class="${p.logoColor ? '' : 'icon-logo-mono-img'}" onerror="this.parentNode.innerHTML=${JSON.stringify(p.icon)}" />`
      : `<span class="icon">${p.icon}</span>`;

    const authLabel =
      p.authPath === 'dcr' && p.dcrOptionalApiKey ? 'OAuth or API key'
      : p.authPath === 'dcr' ? 'Auto-setup (DCR)'
      : p.authPath === 'apiKey' ? 'API key'
      : p.authPath === 'manual' ? 'Manual OAuth'
      : p.authPath === 'localStdio' ? 'Local MCP'
      : '—';
    const statusLabel = p.connected ? (p.expired ? 'Expired' : 'Connected') : 'Not connected';
    const subtitle = `${authLabel} · <span class="${p.connected ? 'sheet-sub-ok' : 'sheet-sub-muted'}">${statusLabel}</span>`;

    const sheet = Components.openModal({
      iconHtml,
      title: p.name,
      subtitle,
    });
    if (p.logoColor === false && sheet.body.parentNode) {
      const iconWrap = sheet.overlay.querySelector('.modal-sheet-icon');
      if (iconWrap) iconWrap.classList.add('icon-logo-mono');
    }

    if (p.description) {
      const d = document.createElement('div');
      d.className = 'sheet-description';
      d.textContent = p.description;
      sheet.body.appendChild(d);
    }

    if (p.blocked) {
      const block = _mkSection('Why blocked');
      block.body.innerHTML = `<p style="margin:0 0 10px">${p.blockedReason || 'Unavailable from this hub.'}</p>${buildStepsHtml(p.setupSteps)}`;
      sheet.body.appendChild(block.root);
      if (p.setupDocsUrl) {
        const link = document.createElement('a');
        link.href = p.setupDocsUrl;
        link.target = '_blank';
        link.rel = 'noopener';
        link.className = 'setup-link';
        link.textContent = 'Provider docs →';
        sheet.body.appendChild(link);
      }
      return sheet;
    }

    if (p.connected) {
      const closeBtn = sheet.header.querySelector('.modal-sheet-close');
      const actionsWrap = document.createElement('div');
      actionsWrap.className = 'modal-sheet-header-actions';

      // Switch account: present for any connected provider. localStdio with a
      // configured switchAccount.tokensPath wipes the token file; cloud OAuth
      // simply revokes credentials and prompts the user to reconnect with a
      // different account at the provider's consent screen.
      const switchHdr = document.createElement('button');
      switchHdr.type = 'button';
      switchHdr.className = 'btn btn-secondary btn-sm';
      switchHdr.textContent = 'Switch account';
      switchHdr.title = 'Sign out and re-auth as a different account.';
      switchHdr.addEventListener('click', async () => {
        await switchAccount(p);
        sheet.close();
      });
      actionsWrap.appendChild(switchHdr);

      const disconnectHdr = document.createElement('button');
      disconnectHdr.type = 'button';
      disconnectHdr.className = 'btn btn-danger btn-sm';
      disconnectHdr.textContent = 'Disconnect';
      disconnectHdr.title = 'Revoke this app connection on this machine.';
      disconnectHdr.addEventListener('click', async () => {
        await disconnectProvider(p.id);
        sheet.close();
      });
      actionsWrap.appendChild(disconnectHdr);
      if (closeBtn) sheet.header.insertBefore(actionsWrap, closeBtn);

      sheet.body.appendChild(_mkKv('Connection', [
        [p.authPath === 'localStdio' ? 'stdio' : 'MCP URL', `<code>${escapeAttr(p.mcpUrl || '—')}</code>`],
        ['Auth', p.credentialType === 'local_stdio' ? 'Local stdio' : (p.credentialType || '—')],
        ...(p.scope ? [['Scope', `<code>${escapeAttr(p.scope)}</code>`]] : []),
        ['Tools', p.toolCount != null ? String(p.toolCount) : '—'],
        ['Updated', p.updatedAt || '—'],
      ]));

      if (!mcpOn) {
        const warn = document.createElement('div');
        warn.className = 'sheet-warn';
        warn.innerHTML = `<strong>${escapeAttr(p.name)}</strong> is inactive — flip the <em>Active</em> toggle on its card to load tools and run health checks.`;
        sheet.body.appendChild(warn);
      }

      const toolsWrap = _collapsibleSection('Tools', { openByDefault: true });
      const toolsList = document.createElement('div');
      toolsList.className = 'sheet-tools-list';
      toolsList.innerHTML = '<div class="sheet-empty">Loading…</div>';
      toolsWrap.body.appendChild(toolsList);
      sheet.body.appendChild(toolsWrap.section);
      fetch(`/api/tools?server=${encodeURIComponent(p.id)}`)
        .then(r => r.json())
        .then(d => {
          const tools = (d && d.tools) || [];
          if (tools.length) {
            toolsList.innerHTML = tools.map(t =>
              `<span class="sheet-tool-chip" title="${escapeAttr(t.description || '')}">${escapeAttr(t.name)}</span>`
            ).join('');
          } else {
            toolsList.innerHTML = '<div class="sheet-empty">No tools discovered yet. Try Test connection.</div>';
          }
        })
        .catch(() => { toolsList.innerHTML = '<div class="sheet-empty">Failed to load tools.</div>'; });

      if (p.setupSteps && p.setupSteps.length) {
        const st = _collapsibleSection('Setup instructions (recall)', { openByDefault: false });
        st.body.innerHTML = buildStepsHtml(p.setupSteps);
        sheet.body.appendChild(st.section);
      }

      const isApiKey = p.credentialType === 'api_key' || p.credentialType === 'bearer_token';
      if (isApiKey) {
        const adv = _collapsibleSection('Replace API key', { openByDefault: true });
        adv.body.innerHTML = `
          <input type="password" id="api-key-field-${p.id}" placeholder="Paste new ${escapeAttr(p.name)} token" class="sheet-input" />
          <div class="sheet-inline-actions">
            <button class="btn btn-sm btn-primary" data-sheet-action="save-key">Save</button>
            ${p.setupDocsUrl ? `<a href="${escapeAttr(p.setupDocsUrl)}" target="_blank" rel="noopener" class="setup-link">Where to get this →</a>` : ''}
          </div>`;
        sheet.body.appendChild(adv.section);
        adv.body.querySelector('[data-sheet-action="save-key"]').addEventListener('click', async () => {
          await saveApiKey(p.id);
          sheet.close();
        });
      }

      sheet.footer.classList.add('channels-modal-test-footer');
      const row = document.createElement('div');
      row.className = 'channels-modal-footer-test';
      const testBtn = document.createElement('button');
      testBtn.type = 'button';
      testBtn.className = 'btn btn-secondary';
      testBtn.textContent = 'Test Connection';
      testBtn.addEventListener('click', () => testConnection(p.id));
      const resultDiv = document.createElement('div');
      resultDiv.id = `test-result-${p.id}`;
      resultDiv.className = 'test-result is-hidden channels-modal-test-result';
      row.appendChild(testBtn);
      row.appendChild(resultDiv);
      sheet.footer.appendChild(row);
      return sheet;
    }

    // NOT CONNECTED — collapsible sections match channel gear modal rhythm
    if (p.setupSteps && p.setupSteps.length) {
      const s = _collapsibleSection('Setup', { openByDefault: true });
      s.body.innerHTML = buildStepsHtml(p.setupSteps);
      sheet.body.appendChild(s.section);
    }

    if (p.authPath === 'apiKey') {
      const keySec = _collapsibleSection('API token', { openByDefault: true });
      keySec.body.innerHTML = `
        <input type="password" id="api-key-field-${p.id}" placeholder="Paste your ${escapeAttr(p.name)} token" class="sheet-input" />
        ${p.setupDocsUrl ? `<a href="${escapeAttr(p.setupDocsUrl)}" target="_blank" rel="noopener" class="setup-link">Where to get this →</a>` : ''}`;
      sheet.body.appendChild(keySec.section);
      sheet.footer.innerHTML = `<button type="button" class="btn btn-sm btn-primary" data-sheet-action="save-key">Save &amp; Connect</button>`;
      sheet.footer.querySelector('[data-sheet-action="save-key"]').addEventListener('click', async () => {
        await saveApiKey(p.id);
        sheet.close();
      });
    } else if (p.authPath === 'manual') {
      const hasSaved = !!(p.savedClientId || p.savedClientSecret);
      const credSec = _collapsibleSection('OAuth credentials', { openByDefault: true });
      credSec.body.innerHTML = `
        ${hasSaved ? `<div class="saved-creds-hint">✓ Loaded saved credentials. Overwrite either field to change.</div>` : ''}
        <input type="text" id="manual-client-id-${p.id}" placeholder="Client ID" class="sheet-input" value="${escapeAttr(p.savedClientId || '')}" />
        <input type="password" id="manual-client-secret-${p.id}" placeholder="Client Secret" class="sheet-input" value="${escapeAttr(p.savedClientSecret || '')}" />`;
      sheet.body.appendChild(credSec.section);
      sheet.footer.innerHTML = `<button type="button" class="btn btn-sm btn-primary" data-sheet-action="manual-connect">${hasSaved ? 'Reconnect' : 'Connect'}</button>`;
      sheet.footer.querySelector('[data-sheet-action="manual-connect"]').addEventListener('click', async () => {
        await connectManualOAuth(p.id);
        sheet.close();
      });
    } else if (p.authPath === 'userUrl') {
      const urlSec = _collapsibleSection(`Your ${p.name} MCP URL`, { openByDefault: true });
      const placeholder = p.userSuppliedUrlPlaceholder || `https://mcp.${p.id}.com/your-id`;
      urlSec.body.innerHTML = `
        <p class="form-hint">After completing the setup steps above, paste the personal MCP URL the vendor gave you.</p>
        <input type="url" id="user-url-${p.id}" placeholder="${escapeAttr(placeholder)}" class="sheet-input" />
        ${p.setupDocsUrl ? `<a href="${escapeAttr(p.setupDocsUrl)}" target="_blank" rel="noopener" class="setup-link">${escapeAttr(p.name)} docs →</a>` : ''}`;
      sheet.body.appendChild(urlSec.section);
      sheet.footer.innerHTML = `<button type="button" class="btn btn-sm btn-primary" data-sheet-action="user-url-connect">Connect</button>`;
      sheet.footer.querySelector('[data-sheet-action="user-url-connect"]').addEventListener('click', async () => {
        const input = document.getElementById(`user-url-${p.id}`);
        const url = input?.value.trim();
        if (!url) { showToast('Paste your MCP URL first', 'error'); return; }
        try { new URL(url); } catch { showToast('That does not look like a valid URL', 'error'); return; }
        try {
          const res = await fetch('/api/oauth/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, name: p.id }),
          });
          const data = await res.json();
          if (!res.ok) { showToast(data.error || 'Failed to start OAuth', 'error'); return; }
          if (data.authorize_url) {
            const popup = window.open(data.authorize_url, '_blank', 'width=700,height=800,noopener');
            if (!popup) showFallbackLink(p.id, data.authorize_url);
          } else {
            showToast(`${p.name} added`, 'success');
            await loadStatus();
          }
          sheet.close();
        } catch (err) {
          showToast(`Error: ${err.message}`, 'error');
        }
      });
    } else if (p.authPath === 'localStdio') {
      const cmd = p.stdioCommand || '';
      const args = Array.isArray(p.stdioArgs) ? p.stdioArgs : [];
      const cmdSec = _collapsibleSection('Command', { openByDefault: true });
      const inner = document.createElement('div');
      inner.innerHTML = `
        <div class="sheet-kv-row"><div class="sheet-kv-label">Binary</div><div class="sheet-kv-value"><code>${escapeAttr(cmd)}</code></div></div>
        <div class="sheet-kv-row"><div class="sheet-kv-label">Args</div><div class="sheet-kv-value"><code>${escapeAttr(args.join(' '))}</code></div></div>`;
      cmdSec.body.appendChild(inner);
      sheet.body.appendChild(cmdSec.section);
      sheet.footer.innerHTML = `<button type="button" class="btn btn-sm btn-primary" data-sheet-action="add-stdio">Add server</button>`;
      sheet.footer.querySelector('[data-sheet-action="add-stdio"]').addEventListener('click', async () => {
        const btn = document.createElement('button');
        btn.dataset.provider = p.id;
        btn.dataset.command = cmd;
        btn.dataset.args = JSON.stringify(args);
        await connectLocalStdio(btn);
        sheet.close();
      });
    } else if (p.authPath === 'dcr' && p.dcrOptionalApiKey) {
      const envHint = p.apiKeyEnv
        ? `<p class="form-hint">Or set <code>${escapeAttr(p.apiKeyEnv)}</code> in the gateway environment.</p>`
        : '';
      const keySec = _collapsibleSection('API key (optional)', { openByDefault: true });
      keySec.body.innerHTML = `
        <p class="form-hint">Paste a token if you prefer not to use OAuth.</p>
        <input type="password" id="api-key-field-${p.id}" placeholder="e.g. tvly-…" class="sheet-input" />
        ${envHint}
        ${p.setupDocsUrl ? `<a href="${escapeAttr(p.setupDocsUrl)}" target="_blank" rel="noopener" class="setup-link">Provider docs →</a>` : ''}`;
      sheet.body.appendChild(keySec.section);
      sheet.footer.innerHTML = `<div class="sheet-dcr-dual-actions">
        <button type="button" class="btn btn-sm btn-primary" data-sheet-action="save-key">Save key &amp; Connect</button>
        <button type="button" class="btn btn-sm" data-sheet-action="connect">Connect with OAuth</button>
      </div>`;
      sheet.footer.querySelector('[data-sheet-action="save-key"]').addEventListener('click', async () => {
        await saveApiKey(p.id);
        sheet.close();
      });
      sheet.footer.querySelector('[data-sheet-action="connect"]').addEventListener('click', () => {
        sheet.close();
        connectProvider(p.id);
      });
    } else {
      // DCR (OAuth only)
      sheet.footer.innerHTML = `<button type="button" class="btn btn-sm btn-primary" data-sheet-action="connect">Connect</button>`;
      sheet.footer.querySelector('[data-sheet-action="connect"]').addEventListener('click', () => {
        sheet.close();
        connectProvider(p.id);
      });
    }
    return sheet;
  }


  async function saveApiKey(providerId) {
    const input = document.getElementById(`api-key-field-${providerId}`);
    if (!input) return;
    const apiKey = input.value.trim();
    if (!apiKey) { showToast('Enter a key first', 'error'); return; }

    try {
      const res = await fetch('/api/oauth/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId, apiKey }),
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.error || 'Failed to save key', 'error'); return; }
      showToast(`${providerId} connected!`, 'success');
      await loadStatus();
      pollUntilSettled(providerId);
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
  }

  async function connectLocalStdio(btn) {
    const name = btn.getAttribute('data-provider');
    const command = btn.getAttribute('data-command');
    let args = [];
    try {
      args = JSON.parse(btn.getAttribute('data-args') || '[]');
    } catch {
      showToast('Invalid stdio args on card', 'error');
      return;
    }
    if (!name || !command) {
      showToast('Missing server name or command', 'error');
      return;
    }
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = 'Connecting…';
    try {
      const res = await fetch('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type: 'stdio', command, args }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || data.output || 'Connect failed', 'error');
        return;
      }
      showToast(`${name} connected and active`, 'success');
      await loadStatus();
      pollUntilSettled(name);
    } catch (err) {
      showToast(err.message || String(err), 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  }

  async function connectUserSuppliedUrl(p) {
    const input = document.getElementById(`user-url-${p.id}`);
    const url = input?.value.trim();
    if (!url) { showToast('Paste your MCP URL first', 'error'); return; }
    try { new URL(url); } catch { showToast('That does not look like a valid URL', 'error'); return; }
    try {
      const res = await fetch('/api/oauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, name: p.id }),
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.error || 'Failed to start OAuth', 'error'); return; }
      if (data.authorize_url) {
        const popup = window.open(data.authorize_url, '_blank', 'width=700,height=800,noopener');
        if (!popup) showFallbackLink(p.id, data.authorize_url);
      } else {
        showToast(`${p.name} added`, 'success');
        await loadStatus();
      }
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
  }

  async function connectProvider(providerId) {
    try {
      const res = await fetch('/api/oauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Failed to start OAuth', 'error');
        return;
      }
      const popup = window.open(data.authorize_url, '_blank', 'width=700,height=800,noopener');
      if (!popup) showFallbackLink(providerId, data.authorize_url);
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
  }

  async function switchAccount(p) {
    const confirmMsg = p.authPath === 'localStdio'
      ? `Switch ${p.name} account? This deletes the saved tokens on this machine — you'll re-run the auth command to sign in as someone else.`
      : `Switch ${p.name} account? You'll be disconnected, then click Connect to sign in as a different account at ${p.name}.`;
    if (!confirm(confirmMsg)) return;
    try {
      const res = await fetch('/api/oauth/switch-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: p.id }),
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.error || 'Failed to switch account', 'error'); return; }
      await loadStatus();
      if (data.mode === 'localStdio' && data.reauthCommand) {
        const m = Components.openModal({
          title: `Switch ${p.name} account`,
          subtitle: 'Tokens cleared — run the command below to sign in with a new account.',
        });
        const body = document.createElement('div');
        body.style.cssText = 'padding:8px 0';
        body.innerHTML = `
          <p>Run this in your terminal from the project root:</p>
          <pre style="background:#0f0f0f;border:1px solid #333;border-radius:8px;padding:12px;overflow:auto;user-select:all"><code>${escapeAttr(data.reauthCommand)}</code></pre>
          <p style="color:#9ca3af;font-size:13px">A browser window will open for Google consent. After signing in, return to this Apps page and click <strong>Add server</strong> again on the ${escapeAttr(p.name)} card.</p>`;
        m.body.appendChild(body);
        const copyBtn = document.createElement('button');
        copyBtn.className = 'btn btn-sm btn-primary';
        copyBtn.textContent = 'Copy command';
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(data.reauthCommand).then(() => showToast('Copied', 'success'));
        });
        m.footer.appendChild(copyBtn);
      } else {
        showToast(`${p.name} disconnected — click Connect to sign in as a different account.`, 'success');
      }
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
  }

  // Active toggle handler — mirrors the dependents-confirm flow used by servers.js so
  // disabling a server with active intents/skills/scheduled tasks prompts before nuking.
  async function onToggleActive(input) {
    const serverName = input.dataset.provider;
    const checked = !!input.checked;
    if (!serverName) return;

    if (!checked) {
      try {
        const depRes = await fetch(`/api/servers/${encodeURIComponent(serverName)}/dependents`);
        if (depRes.ok) {
          const deps = await depRes.json();
          const hasIntents = deps.intents && deps.intents.length > 0;
          const hasSkills = deps.skills && deps.skills.length > 0;
          const hasTasks = deps.scheduled_tasks && deps.scheduled_tasks.length > 0;
          if (hasIntents || hasSkills || hasTasks) {
            let msg = `Disabling "${serverName}" will affect:\n`;
            if (hasIntents) msg += `\n• ${deps.intents.length} intent keyword${deps.intents.length > 1 ? 's' : ''} (${deps.intents.map(i => i.keyword || i).join(', ')})`;
            if (hasSkills) msg += `\n• ${deps.skills.length} active skill${deps.skills.length > 1 ? 's' : ''} (${deps.skills.join(', ')})`;
            if (hasTasks) msg += `\n• ${deps.scheduled_tasks.length} scheduled task${deps.scheduled_tasks.length > 1 ? 's' : ''} (${deps.scheduled_tasks.join(', ')})`;
            msg += '\n\nThese will stop working until the server is re-enabled.';
            const ok = (Components && typeof Components.confirm === 'function')
              ? await Components.confirm(msg)
              : window.confirm(msg);
            if (!ok) { input.checked = true; return; }
          }
        }
      } catch { /* dependents fetch optional — proceed without warning */ }
    }

    try {
      input.disabled = true;
      const verb = checked ? 'enable' : 'disable';
      const res = await fetch(`/api/servers/${encodeURIComponent(serverName)}/${verb}`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      showToast(`${serverName} ${checked ? 'enabled' : 'disabled'}`, 'success');
      await loadStatus();
    } catch (err) {
      showToast(`Failed to ${checked ? 'enable' : 'disable'}: ${err.message}`, 'error');
      input.checked = !checked;
    } finally {
      input.disabled = false;
    }
  }

  async function disconnectProvider(providerId) {
    try {
      const res = await fetch('/api/oauth/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.error || 'Failed to disconnect', 'error'); return; }
      showToast('Disconnected', 'success');
      await loadStatus();
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  async function connectManualOAuth(providerId) {
    const clientIdEl = document.getElementById(`manual-client-id-${providerId}`);
    const clientSecretEl = document.getElementById(`manual-client-secret-${providerId}`);
    if (!clientIdEl || !clientSecretEl) return;
    const clientId = clientIdEl.value.trim();
    const clientSecret = clientSecretEl.value.trim();
    if (!clientId) { showToast('Client ID is required', 'error'); return; }

    try {
      const res = await fetch('/api/oauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId, clientId, clientSecret: clientSecret || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.error || 'Failed to start OAuth', 'error'); return; }
      const popup = window.open(data.authorize_url, '_blank', 'width=700,height=800,noopener');
      if (!popup) showFallbackLink(providerId, data.authorize_url);
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
  }

  async function testConnection(providerId) {
    const resultEl = document.getElementById(`test-result-${providerId}`);
    if (!resultEl) return;
    resultEl.classList.remove('is-hidden');
    resultEl.className = 'test-result test-pending channels-modal-test-result';
    resultEl.textContent = 'Testing...';

    try {
      const res = await fetch('/api/oauth/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        resultEl.className = 'test-result test-ok channels-modal-test-result';
        resultEl.textContent = `✓ Connection OK — ${data.toolCount} tools available${data.sample?.length ? ` (e.g. ${data.sample.slice(0, 3).join(', ')})` : ''}`;
      } else {
        resultEl.className = 'test-result test-error channels-modal-test-result';
        resultEl.textContent = `✗ Test failed: ${data.error || 'unknown error'}`;
      }
    } catch (err) {
      resultEl.className = 'test-result test-error channels-modal-test-result';
      resultEl.textContent = `✗ Test failed: ${err.message}`;
    }
  }

  function showCustomError(msg) {
    const el = document.getElementById('custom-error');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('is-hidden', !msg);
  }

  async function connectCustomOAuth() {
    const urlInput = document.getElementById('custom-mcp-url');
    const nameInput = document.getElementById('custom-mcp-name');
    if (!urlInput) return;
    const url = urlInput.value.trim();
    if (!url) { showCustomError('Enter an MCP server URL'); return; }
    try { new URL(url); } catch { showCustomError('Invalid URL'); return; }
    showCustomError('');

    const name = nameInput?.value.trim() || undefined;
    try {
      const res = await fetch('/api/oauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, name }),
      });
      const data = await res.json();
      if (!res.ok) { showCustomError(data.error || 'Failed to start OAuth'); return; }
      const popup = window.open(data.authorize_url, '_blank', 'width=700,height=800,noopener');
      if (!popup) showFallbackLink(name || url, data.authorize_url);
    } catch (err) {
      showCustomError(`Error: ${err.message}`);
    }
  }

  async function saveCustomApiKey() {
    const urlInput = document.getElementById('custom-mcp-url');
    const nameInput = document.getElementById('custom-mcp-name');
    const keyInput = document.getElementById('custom-apikey-field');
    if (!urlInput || !keyInput) return;
    const url = urlInput.value.trim();
    const apiKey = keyInput.value.trim();
    if (!url) { showCustomError('Enter an MCP server URL'); return; }
    if (!apiKey) { showCustomError('Enter an API key'); return; }
    try { new URL(url); } catch { showCustomError('Invalid URL'); return; }
    showCustomError('');

    const name = nameInput?.value.trim() || undefined;
    try {
      const res = await fetch('/api/oauth/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, name, apiKey }),
      });
      const data = await res.json();
      if (!res.ok) { showCustomError(data.error || 'Failed to save key'); return; }
      showToast(`${data.serverName} connected!`, 'success');
      urlInput.value = '';
      if (nameInput) nameInput.value = '';
      keyInput.value = '';
      document.getElementById('custom-apikey-section')?.classList.add('is-hidden');
      await loadStatus();
      if (data.serverName) pollUntilSettled(data.serverName);
    } catch (err) {
      showCustomError(`Error: ${err.message}`);
    }
  }

  function attachMessageListener() {
    if (_messageListener) window.removeEventListener('message', _messageListener);
    _messageListener = (event) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === 'oauth_done') {
        showToast(`${event.data.provider} connected!`, 'success');
        loadStatus().then(() => pollUntilSettled(event.data.provider));
      }
    };
    window.addEventListener('message', _messageListener);
  }

  function showFallbackLink(providerId, authUrl) {
    const grid = document.getElementById('apps-grid');
    if (!grid) return;
    const notice = document.createElement('div');
    notice.className = 'fallback-notice';
    notice.innerHTML = `
      <p>Popup was blocked. <a href="${authUrl}" target="_blank" rel="noopener">Click here to authorize ${providerId}</a>, then come back and refresh.</p>
      <button class="btn btn-sm" onclick="this.parentNode.remove()">Dismiss</button>`;
    grid.prepend(notice);
  }

  function showToast(msg, type) {
    const existing = document.querySelector('.vodou-toast-container');
    const container = existing || (() => {
      const c = document.createElement('div');
      c.className = 'vodou-toast-container';
      document.body.appendChild(c);
      return c;
    })();
    const toast = document.createElement('div');
    toast.className = `vodou-toast vodou-toast-${type || 'info'}`;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
  }

  // Styles (scoped, injected once)
  (function injectStyles() {
    if (document.getElementById('apps-styles')) return;
    const s = document.createElement('style');
    s.id = 'apps-styles';
    s.textContent = `
      .apps-grid { display: flex; flex-direction: column; gap: 40px; padding: 4px 0; }
      .category-section h2.category-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); margin: 0 0 12px; }
      .card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
      .integration-card { position: relative; background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: 10px; padding: 16px; display: flex; flex-direction: column; gap: 10px; transition: border-color 0.15s, box-shadow 0.15s; overflow: hidden; }
      .integration-card:hover { border-color: var(--accent); box-shadow: 0 2px 12px rgba(13,148,136,0.12); }
      .integration-card::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: transparent; transition: background 0.15s; }
      .integration-card.is-connected::before { background: #22c55e; }
      .integration-card.is-expired::before { background: #f59e0b; }
      .integration-card.is-blocked::before { background: var(--text-muted); }
      .integration-card.is-idle::before { background: transparent; }
      .integration-card .card-header { display: flex; align-items: center; gap: 10px; }
      .integration-card .icon { font-size: 22px; line-height: 1; }
      .integration-card .icon-logo { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; flex-shrink: 0; border-radius: 6px; background: var(--bg-tertiary); overflow: hidden; }
      .integration-card .icon-logo img { width: 20px; height: 20px; object-fit: contain; display: block; }
      .integration-card .icon-logo-mono img { filter: invert(1) brightness(1.1); }
      .integration-card .info { flex: 1; min-width: 0; }
      .integration-card .name { font-weight: 600; color: var(--text-primary); font-size: 14px; line-height: 1.2; margin-bottom: 4px; }
      .integration-card .meta { display: flex; gap: 4px; flex-wrap: wrap; }
      .integration-card .card-meta-footer { padding-top: 10px; margin-top: 2px; border-top: 1px solid var(--border-primary); }
      .integration-card .card-active-row {
        display: flex; align-items: center; justify-content: space-between;
        padding-top: 10px; margin-top: 2px; border-top: 1px solid var(--border-primary);
      }
      .integration-card .card-active-label {
        font-size: 11px; font-weight: 600; color: var(--text-muted);
        text-transform: uppercase; letter-spacing: 0.4px;
      }
      .integration-card .description { font-size: 12px; color: var(--text-muted); line-height: 1.45; margin: 0; }
      .integration-card .actions { margin-top: auto; display: flex; flex-direction: column; gap: 6px; }
      .integration-card-manage-row { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
      .integration-card-gear { opacity: 0.45; margin-left: 0; }
      .integration-card:hover .integration-card-gear { opacity: 1; }
      .badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 600; letter-spacing: 0.2px; }
      .badge-ok { background: var(--success-bg); color: var(--success-text); }
      .badge-warn { background: #422006; color: #fcd34d; }
      .badge-off { background: var(--bg-tertiary); color: var(--text-muted); }
      .auto-setup-badge, .api-key-badge, .local-badge, .manual-badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 600; letter-spacing: 0.2px; }
      .auto-setup-badge { background: var(--accent-bg); color: var(--accent-text); }
      .api-key-badge { background: #1e3a8a; color: #93c5fd; }
      .local-badge { background: #14532d; color: #86efac; }
      .manual-badge { background: var(--bg-tertiary); color: var(--text-muted); }
      .integration-card .btn-danger { background: transparent; color: var(--error-text, #fca5a5); border: 1px solid var(--border-primary); font-weight: 500; }
      .integration-card .btn-danger:hover { background: var(--error-bg, #1c0a0a); border-color: var(--error, #ef4444); color: var(--error-text, #fca5a5); opacity: 1; }
      .api-key-input { display: flex; flex-direction: column; gap: 0.5rem; }
      .api-key-input.is-hidden { display: none; }
      .api-key-input input { background: var(--bg-input); border: 1px solid var(--border-primary); border-radius: 6px; padding: 0.5rem; color: var(--text-primary); font-family: monospace; }
      .setup-link, .setup-link:visited, .setup-link:active { font-size: 0.75rem; color: var(--accent-text); text-decoration: none; }
      .setup-link:hover { color: var(--accent-text); text-decoration: underline; }
      .fallback-notice { background: var(--bg-tertiary); border: 1px solid var(--border-primary); border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
      .fallback-notice p { color: var(--text-secondary); margin-bottom: 0.5rem; }
      .fallback-notice a, .fallback-notice a:visited, .fallback-notice a:active { color: var(--accent-text); }
      .fallback-notice a:hover { color: var(--accent-text); text-decoration: underline; }
      .error-msg, .empty-msg { color: var(--text-muted); padding: 1rem 0; }
      .custom-integration-form { background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: 10px; padding: 1.25rem; display: flex; flex-direction: column; gap: 0.75rem; }
      .custom-integration-form .form-hint { font-size: 0.85rem; color: var(--text-muted); margin: 0; line-height: 1.4; }
      .custom-integration-form .form-row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
      .custom-integration-form .form-input { background: var(--bg-input); border: 1px solid var(--border-primary); border-radius: 6px; padding: 0.5rem 0.75rem; color: var(--text-primary); font-family: monospace; font-size: 0.85rem; flex: 1; min-width: 200px; }
      .custom-integration-form .form-input-sm { max-width: 180px; min-width: 120px; flex: 0.4; }
      .custom-integration-form .api-key-input { display: flex; flex-direction: column; gap: 0.5rem; }
      .custom-integration-form .api-key-input input { background: var(--bg-input); border: 1px solid var(--border-primary); border-radius: 6px; padding: 0.5rem; color: var(--text-primary); font-family: monospace; }
      .custom-error { color: var(--error-text, #ef4444); font-size: 0.85rem; background: var(--error-bg, #1c0a0a); border-radius: 6px; padding: 0.5rem 0.75rem; }
      details.card-details { margin: 0; }
      details.card-details > summary { list-style: none; cursor: pointer; user-select: none; font-size: 11px; color: var(--text-muted); padding: 6px 10px; background: var(--bg-tertiary); border: 1px solid var(--border-primary); border-radius: 6px; display: flex; align-items: center; gap: 6px; transition: background 0.12s, color 0.12s, border-color 0.12s; }
      details.card-details > summary::-webkit-details-marker { display: none; }
      details.card-details > summary::before { content: '▸'; font-size: 10px; color: var(--text-muted); transition: transform 0.15s; display: inline-block; }
      details.card-details[open] > summary::before { transform: rotate(90deg); }
      details.card-details > summary:hover { color: var(--text-primary); border-color: var(--accent); }
      details.card-details[open] > summary { color: var(--text-primary); border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
      details.card-details .summary-label { font-weight: 600; letter-spacing: 0.3px; text-transform: uppercase; }
      details.setup-connect-collapse { margin: 0; }
      details.setup-connect-collapse > summary { list-style: none; cursor: pointer; user-select: none; }
      details.setup-connect-collapse > summary::-webkit-details-marker { display: none; }
      details.setup-connect-collapse > summary.btn-setup-connect { display: inline-flex; align-items: center; gap: 6px; }
      details.setup-connect-collapse > summary.btn-setup-connect::after { content: '▸'; font-size: 10px; transition: transform 0.15s; }
      details.setup-connect-collapse[open] > summary.btn-setup-connect::after { transform: rotate(90deg); }
      .setup-connect-body { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; background: var(--bg-tertiary); border: 1px solid var(--border-primary); border-radius: 6px; }
      .setup-connect-body > .setup-steps { margin: 0; }
      .details-panel { background: var(--bg-tertiary); border: 1px solid var(--border-primary); border-top: none; border-radius: 0 0 6px 6px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
      .detail-row { display: flex; gap: 10px; align-items: baseline; line-height: 1.4; }
      .detail-label { color: var(--text-muted); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; min-width: 64px; flex-shrink: 0; }
      .detail-value { color: var(--text-primary); word-break: break-all; font-size: 12px; }
      code.detail-value { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; background: var(--bg-input); padding: 1px 6px; border-radius: 4px; color: var(--text-primary); }
      .detail-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; padding-top: 8px; border-top: 1px solid var(--border-primary); }
      .test-result { font-size: 0.8rem; padding: 0.5rem 0.75rem; border-radius: 6px; margin-top: 0.25rem; }
      .test-ok { background: var(--success-bg, #052e16); color: var(--success-text, #86efac); }
      .test-error { background: var(--error-bg, #1c0a0a); color: var(--error-text, #fca5a5); }
      .test-pending { background: var(--bg-input); color: var(--text-muted); }
      .manual-oauth-input { display: flex; flex-direction: column; gap: 0.5rem; background: var(--bg-tertiary); border: 1px solid var(--border-primary); border-radius: 8px; padding: 0.75rem; margin-top: 0.25rem; }
      .manual-oauth-input.is-hidden { display: none; }
      .manual-oauth-input input { background: var(--bg-input); border: 1px solid var(--border-primary); border-radius: 6px; padding: 0.5rem; color: var(--text-primary); font-family: monospace; font-size: 0.85rem; }
      .manual-oauth-hint { font-size: 0.8rem; color: var(--text-muted); margin: 0 0 0.25rem 0; line-height: 1.4; }
      .manual-oauth-hint .setup-link,
      .manual-oauth-hint .setup-link:visited,
      .manual-oauth-hint .setup-link:active { color: var(--accent-text); }
      .setup-steps { padding-left: 1.25rem; margin: 0 0 0.5rem 0; display: flex; flex-direction: column; gap: 0.65rem; counter-reset: step; }
      .setup-steps li { font-size: 0.85rem; color: var(--text-secondary); line-height: 1.45; }
      .setup-steps .step-title { font-weight: 600; color: var(--text-primary); margin-bottom: 0.15rem; }
      .setup-steps .step-instructions { color: var(--text-secondary); }
      .setup-steps .step-instructions a,
      .setup-steps .step-instructions a:visited,
      .setup-steps .step-instructions a:active { color: var(--accent-text); text-decoration: underline; }
      .setup-steps .step-instructions a:hover { color: var(--accent-text); text-decoration: underline; }
      .setup-steps .step-instructions code { background: var(--bg-input); padding: 1px 5px; border-radius: 4px; font-size: 0.8rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
      .setup-steps .step-gotcha { background: var(--warn-bg, #422006); color: var(--warn-text, #fcd34d); border-left: 3px solid var(--warn-border, #f59e0b); padding: 0.4rem 0.6rem; border-radius: 4px; margin: 0.35rem 0; font-size: 0.8rem; }
      .setup-steps .step-link,
      .setup-steps .step-link:visited,
      .setup-steps .step-link:active { display: inline-block; margin-top: 0.25rem; font-size: 0.8rem; color: var(--accent-text); text-decoration: none; padding: 0.2rem 0.5rem; border: 1px solid var(--border-primary); border-radius: 4px; }
      .setup-steps .step-link:hover { background: var(--bg-tertiary); color: var(--accent-text); }
      .saved-creds-hint { background: var(--success-bg, #052e16); color: var(--success-text, #86efac); border-left: 3px solid #22c55e; padding: 0.4rem 0.6rem; border-radius: 4px; font-size: 0.8rem; margin-bottom: 0.25rem; }
      details.setup-collapse { margin-bottom: 0.25rem; }
      details.setup-collapse > summary { cursor: pointer; font-size: 0.8rem; color: var(--text-muted); padding: 0.3rem 0.5rem; background: var(--bg-input); border-radius: 4px; user-select: none; list-style: none; }
      details.setup-collapse > summary::-webkit-details-marker { display: none; }
      details.setup-collapse > summary::before { content: '▸ '; display: inline-block; transition: transform 0.15s; }
      details.setup-collapse[open] > summary::before { transform: rotate(90deg); }
      details.setup-collapse[open] > summary { background: var(--bg-tertiary); color: var(--text-secondary); margin-bottom: 0.35rem; }
      details.setup-collapse > .setup-steps { margin-top: 0.35rem; }
      details.setup-collapse > summary .summary-hide { display: none; }
      details.setup-collapse[open] > summary .summary-show { display: none; }
      details.setup-collapse[open] > summary .summary-hide { display: inline; }
      .mcp-registry-catalog { background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: 10px; padding: 1.25rem; display: flex; flex-direction: column; gap: 0.65rem; }
      .mcp-registry-catalog > .form-hint { margin: 0; }
      .mcp-dcr-filter { width: 100%; max-width: 28rem; }
      .mcp-dcr-list { max-height: 320px; overflow: auto; display: flex; flex-direction: column; gap: 0.35rem; margin-top: 0.25rem; border: 1px solid var(--border-primary); border-radius: 8px; padding: 0.5rem; background: var(--bg-tertiary); }
      .mcp-dcr-row { display: flex; align-items: center; gap: 0.65rem; padding: 0.45rem 0.5rem; border-radius: 6px; background: var(--bg-secondary); border: 1px solid var(--border-primary); }
      .mcp-dcr-row:hover { border-color: var(--accent-text); }
      .mcp-dcr-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.15rem; }
      .mcp-dcr-title { font-weight: 600; font-size: 0.88rem; color: var(--text-primary); }
      .mcp-dcr-reg { font-size: 0.72rem; color: var(--text-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      .mcp-dcr-url { font-size: 0.72rem; word-break: break-all; color: var(--text-secondary); background: var(--bg-input); padding: 2px 6px; border-radius: 4px; }
      .mcp-dcr-row .btn { flex-shrink: 0; }
    `;
    document.head.appendChild(s);
  })();

  function _primeSidebar() {
    if (!document.getElementById('nav-apps-items')) return;
    loadStatus().catch(() => {});
    // Navigating off the workbench needs to drop the context block even if
    // no fetch fires — re-render from cache on every hashchange.
    window.addEventListener('hashchange', () => {
      if (_lastProviders) renderSidebarApps(_lastProviders);
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _primeSidebar, { once: true });
  } else {
    _primeSidebar();
  }

  return { render, primeSidebar: _primeSidebar };
})();
