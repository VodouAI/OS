/**
 * MCP Servers View — list, detail expansion, enable/disable, test, add server
 */
function normalizeServersList(raw) {
  if (Array.isArray(raw)) return raw;
  return raw?.servers ?? [];
}

const ServersView = {
  expandedServer: null,
  serverDetail: null,

  async render(container, expandServerName) {
    container.appendChild(Components.pageHeader('MCP Servers', 'Manage connected MCP servers'));
    container.appendChild(Components.loading());

    try {
      const servers = normalizeServersList(await API.get('/api/servers'));
      container.innerHTML = '';

      // Header with add button
      const headerWrap = document.createElement('div');
      headerWrap.className = 'servers-header';

      const headerText = document.createElement('div');
      const titleRow = document.createElement('div');
      titleRow.className = 'servers-title-row';
      titleRow.innerHTML = '<div class="page-title">MCP Servers</div>';
      titleRow.appendChild(Components.helpTip('Extensions that give Vodou new abilities \u2014 like web search, file access, or code tools. Enable the ones you need.'));
      headerText.appendChild(titleRow);
      headerText.innerHTML += `<div class="page-subtitle">${servers.length} servers registered. <strong>Active</strong> = loaded for health checks and orchestration; remote / integration rows default off until you turn them on here. Stdio servers still start on demand when you use Vodou.</div>`;
      headerWrap.appendChild(headerText);

      const btnWrap = document.createElement('div');
      btnWrap.className = 'servers-header-actions';
      const refreshBtn = document.createElement('button');
      refreshBtn.className = 'btn btn-secondary';
      refreshBtn.textContent = 'Refresh status';
      refreshBtn.title = 'Run health check for all servers and refresh the list';
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true;
        refreshBtn.textContent = 'Checking…';
        try {
          await API.post('/api/servers/refresh-health');
          const updated = normalizeServersList(await API.get('/api/servers'));
          const tableWrap = document.getElementById('servers-table-wrap');
          if (tableWrap) this._renderTable(tableWrap, updated);
          Components.toast('Status refreshed', 'success');
        } catch (e) {
          Components.toast('Refresh failed: ' + (e.message || e), 'error');
        }
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'Refresh status';
      });
      btnWrap.appendChild(refreshBtn);
      const addBtn = document.createElement('button');
      addBtn.className = 'btn btn-primary';
      addBtn.textContent = '+ Add Server';
      addBtn.addEventListener('click', () => this._showAddForm(container));
      btnWrap.appendChild(addBtn);
      headerWrap.appendChild(btnWrap);

      container.appendChild(headerWrap);

      // Add form placeholder
      const formWrap = document.createElement('div');
      formWrap.id = 'add-server-form-wrap';
      container.appendChild(formWrap);

      if (servers.length === 0) {
        const emptyEl = Components.emptyState('No servers connected yet. Install one to give Vodou new abilities.');
        const discoverBtn = document.createElement('button');
        discoverBtn.className = 'btn btn-primary empty-state-action';
        discoverBtn.textContent = 'Discover Servers';
        discoverBtn.classList.add('mt-3');
        discoverBtn.addEventListener('click', () => this._showAddForm(container));
        emptyEl.appendChild(document.createElement('br'));
        emptyEl.appendChild(discoverBtn);
        container.appendChild(emptyEl);
        return;
      }

      // Server table
      const tableWrap = document.createElement('div');
      tableWrap.id = 'servers-table-wrap';
      this._renderTable(tableWrap, servers);
      container.appendChild(tableWrap);

      // Detail panel (shown below table when a server is clicked)
      const detailPanel = document.createElement('div');
      detailPanel.id = 'server-detail-panel';
      container.appendChild(detailPanel);

      if (expandServerName) {
        setTimeout(() => this._showDetail(expandServerName), 0);
      }
    } catch (err) {
      container.innerHTML = '';
      container.appendChild(Components.errorState('Failed to load servers: ' + err.message));
    }
  },

  _renderTable(wrap, servers) {
    wrap.innerHTML = '';
    const table = Components.table(
      [
        { label: '', width: '32px', render: (s) => Components.statusDot(s.health_status === 'healthy' || s.active) },
        { label: 'Name', key: 'name', render: (s) => {
          const a = document.createElement('a');
          a.href = '#/servers/' + encodeURIComponent(s.name);
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.className = 'servers-name-link';
          a.textContent = s.name;
          a.title = 'Open server details in new tab';
          a.addEventListener('click', (e) => e.stopPropagation());
          return a;
        }},
        { label: 'Active', width: '70px', render: (s) => {
          return Components.toggle(!!s.active, async (checked) => {
            if (!checked) {
              // Disabling — check for dependents first
              try {
                const deps = await API.get(`/api/servers/${s.name}/dependents`);
                const hasIntents = deps.intents && deps.intents.length > 0;
                const hasSkills = deps.skills && deps.skills.length > 0;
                const hasTasks = deps.scheduled_tasks && deps.scheduled_tasks.length > 0;
                if (hasIntents || hasSkills || hasTasks) {
                  let msg = `Disabling "${s.name}" will affect:\n`;
                  if (hasIntents) msg += `\n\u2022 ${deps.intents.length} intent keyword${deps.intents.length > 1 ? 's' : ''} (${deps.intents.map(i => i.keyword).join(', ')})`;
                  if (hasSkills) msg += `\n\u2022 ${deps.skills.length} active skill${deps.skills.length > 1 ? 's' : ''} (${deps.skills.join(', ')})`;
                  if (hasTasks) msg += `\n\u2022 ${deps.scheduled_tasks.length} scheduled task${deps.scheduled_tasks.length > 1 ? 's' : ''} (${deps.scheduled_tasks.join(', ')})`;
                  msg += '\n\nThese will stop working until the server is re-enabled.';
                  if (!await Components.confirm(msg)) return;
                }
              } catch {}
            }
            try {
              await API.post(`/api/servers/${s.name}/${checked ? 'enable' : 'disable'}`);
              Components.toast(`${s.name} ${checked ? 'enabled' : 'disabled'}`, 'success');
              if (window._refreshAlerts) window._refreshAlerts();
            } catch (e) {
              Components.toast('Failed: ' + e.message, 'error');
            }
          });
        }},
        { label: 'Tools', width: '70px', render: (s) => {
          const badge = Components.badge(String(s.tool_count), 'default');
          return badge;
        }},
        { label: 'Intents', width: '70px', render: (s) => {
          return Components.badge(String(s.intent_count), 'default');
        }},
        { label: 'Type', width: '90px', key: 'connection_type', className: 'secondary-text' },
        { label: 'Description', render: (s) => {
          const span = document.createElement('span');
          span.className = 'secondary-text';
          span.textContent = (s.description || '').substring(0, 60);
          return span;
        }},
      ],
      servers,
      {
        onRowClick: (server) => this._showDetail(server.name),
      }
    );
    wrap.appendChild(table);
  },

  _showAddForm(container) {
    const formWrap = document.getElementById('add-server-form-wrap');
    if (!formWrap) return;

    // Toggle off if already showing
    if (formWrap.children.length > 0) {
      formWrap.innerHTML = '';
      return;
    }

    const self = this;
    let activeTab = 'discover';

    const form = document.createElement('div');
    form.className = 'add-server-form';

    // Tabs
    const tabs = document.createElement('div');
    tabs.className = 'form-tabs';

    const tabDefs = [
      { id: 'discover', label: 'Discover' },
      { id: 'stdio', label: 'Advanced: Command Line' },
      { id: 'http', label: 'Advanced: HTTP Endpoint' },
    ];

    const tabButtons = {};
    for (const t of tabDefs) {
      const btn = document.createElement('button');
      btn.className = 'form-tab' + (t.id === activeTab ? ' active' : '');
      btn.textContent = t.label;
      btn.type = 'button';
      btn.addEventListener('click', () => {
        activeTab = t.id;
        for (const b of Object.values(tabButtons)) b.className = 'form-tab';
        btn.className = 'form-tab active';
        renderFields();
      });
      tabs.appendChild(btn);
      tabButtons[t.id] = btn;
    }
    form.appendChild(tabs);

    // Fields container
    const fieldsWrap = document.createElement('div');

    function renderFields() {
      fieldsWrap.innerHTML = '';

      if (activeTab === 'discover') {
        renderDiscoverTab(fieldsWrap);
        return;
      }

      // Name (always shown for manual tabs)
      const nameGroup = document.createElement('div');
      nameGroup.className = 'form-group';
      nameGroup.innerHTML = '<label>Server Name</label><input type="text" id="add-srv-name" placeholder="my-server" />';
      fieldsWrap.appendChild(nameGroup);

      if (activeTab === 'stdio') {
        fieldsWrap.insertAdjacentHTML('beforeend', `
          <div class="form-group"><label>Command</label><input type="text" id="add-srv-command" placeholder="npx" /></div>
          <div class="form-group"><label>Arguments</label><input type="text" id="add-srv-args" placeholder="-y @modelcontextprotocol/server-memory" /><div class="form-hint">Space-separated arguments</div></div>
          <div class="form-group"><label>Environment Variables</label><textarea id="add-srv-env" placeholder="KEY=value&#10;ANOTHER_KEY=value" rows="3"></textarea><div class="form-hint">One KEY=value pair per line (optional)</div></div>
        `);
      } else {
        fieldsWrap.insertAdjacentHTML('beforeend', `
          <div class="form-group"><label>Server URL</label><input type="text" id="add-srv-url" placeholder="https://api.example.com/mcp" /></div>
          <div class="form-group"><label>API Key</label><input type="text" id="add-srv-apikey" placeholder="Optional — for Bearer auth" /><div class="form-hint">If the server requires OAuth, a browser window will open for authentication.</div></div>
        `);
      }

      // Actions for manual tabs
      const actions = document.createElement('div');
      actions.className = 'form-actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.type = 'button';
      cancelBtn.addEventListener('click', () => { formWrap.innerHTML = ''; });
      actions.appendChild(cancelBtn);

      const submitBtn = document.createElement('button');
      submitBtn.className = 'btn btn-primary';
      submitBtn.textContent = 'Connect Server';
      submitBtn.type = 'button';
      submitBtn.addEventListener('click', () => handleManualSubmit(submitBtn));
      actions.appendChild(submitBtn);

      fieldsWrap.appendChild(actions);
    }

    async function handleManualSubmit(submitBtn) {
      const name = document.getElementById('add-srv-name')?.value?.trim();
      if (!name) { Components.toast('Server name is required', 'error'); return; }

      let payload;
      if (activeTab === 'stdio') {
        const command = document.getElementById('add-srv-command')?.value?.trim();
        if (!command) { Components.toast('Command is required', 'error'); return; }
        const argsStr = document.getElementById('add-srv-args')?.value?.trim() || '';
        const envStr = document.getElementById('add-srv-env')?.value?.trim() || '';
        const env = {};
        if (envStr) {
          for (const line of envStr.split('\n')) {
            const eq = line.indexOf('=');
            if (eq > 0) env[line.substring(0, eq).trim()] = line.substring(eq + 1).trim();
          }
        }
        payload = { name, type: 'stdio', command, args: argsStr, env: Object.keys(env).length ? env : undefined };
      } else {
        const url = document.getElementById('add-srv-url')?.value?.trim();
        if (!url) { Components.toast('URL is required', 'error'); return; }
        const apiKey = document.getElementById('add-srv-apikey')?.value?.trim() || undefined;
        payload = { name, type: 'http', url, apiKey };
      }

      submitBtn.textContent = 'Connecting...';
      submitBtn.disabled = true;
      try {
        await API.post('/api/servers', payload);
        Components.toast(`${name} connected successfully`, 'success');
        formWrap.innerHTML = '';
        if (window.refreshSidebarCounts) window.refreshSidebarCounts();
        const mainContent = document.getElementById('main-content');
        if (mainContent) self.render(mainContent);
      } catch (e) {
        Components.toast('Connect failed: ' + e.message, 'error');
        submitBtn.textContent = 'Connect Server';
        submitBtn.disabled = false;
      }
    }

    function renderDiscoverTab(wrap) {
      // Search row
      const searchRow = document.createElement('div');
      searchRow.className = 'discover-search-row';
      searchRow.innerHTML = '<input type="text" id="discover-search-input" placeholder="Search MCP servers... (e.g. database, github, filesystem)" />';

      const searchBtn = document.createElement('button');
      searchBtn.className = 'btn btn-primary';
      searchBtn.textContent = 'Search';
      searchBtn.type = 'button';
      searchRow.appendChild(searchBtn);
      wrap.appendChild(searchRow);

      // Results container
      const resultsWrap = document.createElement('div');
      resultsWrap.id = 'discover-results';
      wrap.appendChild(resultsWrap);

      // Search handler
      async function doSearch() {
        const q = document.getElementById('discover-search-input')?.value?.trim();
        if (!q) { Components.toast('Enter a search query', 'error'); return; }

        resultsWrap.innerHTML = '';
        resultsWrap.appendChild(Components.loading());
        searchBtn.textContent = 'Searching...';
        searchBtn.disabled = true;

        try {
          const data = await API.get(`/api/servers/search?q=${encodeURIComponent(q)}&limit=15`);
          resultsWrap.innerHTML = '';

          if (!data.results || data.results.length === 0) {
            resultsWrap.innerHTML = '<div class="empty-state">No servers found for "' + q + '"</div>';
            return;
          }

          const list = document.createElement('div');
          list.className = 'discover-results';

          for (const srv of data.results) {
            const card = document.createElement('div');
            card.className = 'discover-card';

            const detailUrl = (srv.repository && srv.repository.url) ? srv.repository.url
              : (srv.packages && srv.packages[0] && (srv.packages[0].registryType || srv.packages[0].registry_type) === 'npm' && srv.packages[0].identifier)
                ? 'https://www.npmjs.com/package/' + encodeURIComponent(srv.packages[0].identifier)
                : 'https://registry.modelcontextprotocol.io/servers?search=' + encodeURIComponent(srv.name);

            // Header: name (clickable) + install button
            const header = document.createElement('div');
            header.className = 'discover-card-header';

            const name = document.createElement('a');
            name.className = 'discover-card-name';
            name.href = detailUrl;
            name.target = '_blank';
            name.rel = 'noopener noreferrer';
            name.textContent = srv.name;
            name.title = 'Open details in new tab';
            name.addEventListener('click', (e) => e.stopPropagation());
            header.appendChild(name);

            const installBtn = document.createElement('button');
            installBtn.className = 'btn btn-primary btn-sm';
            installBtn.textContent = 'Install';
            installBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); handleInstall(srv, installBtn); });
            header.appendChild(installBtn);

            card.appendChild(header);
            card.classList.add('cursor-pointer');
            card.title = 'Open details in new tab';
            card.addEventListener('click', (e) => {
              if (e.target === installBtn || installBtn.contains(e.target)) return;
              e.preventDefault();
              window.open(detailUrl, '_blank', 'noopener,noreferrer');
            });

            // Description
            if (srv.description) {
              const desc = document.createElement('div');
              desc.className = 'discover-card-desc';
              desc.textContent = srv.description;
              card.appendChild(desc);
            }

            // Meta: rating + tags + install method
            const meta = document.createElement('div');
            meta.className = 'discover-card-meta';

            if (srv.rating > 0) {
              const rating = document.createElement('span');
              rating.className = 'discover-card-rating';
              rating.textContent = '\u2605 ' + srv.rating.toFixed(1);
              meta.appendChild(rating);
            }

            if (srv.tags && srv.tags.length > 0) {
              for (const tag of srv.tags.slice(0, 5)) {
                meta.appendChild(Components.badge(tag, 'default'));
              }
            }

            if (srv.install_method && srv.install_method !== 'unknown') {
              const method = document.createElement('span');
              method.className = 'discover-card-install-method';
              method.textContent = srv.install_method;
              meta.appendChild(method);
            }

            card.appendChild(meta);
            list.appendChild(card);
          }

          resultsWrap.appendChild(list);
        } catch (e) {
          resultsWrap.innerHTML = '';
          resultsWrap.appendChild(Components.errorState('Search failed: ' + e.message));
        } finally {
          searchBtn.textContent = 'Search';
          searchBtn.disabled = false;
        }
      }

      searchBtn.addEventListener('click', doSearch);
      // Enter key triggers search
      document.getElementById('discover-search-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doSearch();
      });

      // Divider
      const divider = document.createElement('div');
      divider.className = 'discover-divider';
      divider.textContent = 'OR paste a GitHub URL';
      wrap.appendChild(divider);

      // GitHub URL scan row
      const scanRow = document.createElement('div');
      scanRow.className = 'discover-search-row';
      scanRow.innerHTML = '<input type="text" id="discover-scan-url" placeholder="https://github.com/user/repo" />';

      const scanBtn = document.createElement('button');
      scanBtn.className = 'btn btn-primary';
      scanBtn.textContent = 'Scan';
      scanBtn.type = 'button';
      scanRow.appendChild(scanBtn);
      wrap.appendChild(scanRow);

      // Scan results container
      const scanResultsWrap = document.createElement('div');
      scanResultsWrap.id = 'scan-results';
      wrap.appendChild(scanResultsWrap);

      scanBtn.addEventListener('click', async () => {
        const url = document.getElementById('discover-scan-url')?.value?.trim();
        if (!url) { Components.toast('Enter a GitHub URL', 'error'); return; }

        scanResultsWrap.innerHTML = '';
        scanResultsWrap.appendChild(Components.loading());
        scanBtn.textContent = 'Scanning...';
        scanBtn.disabled = true;

        try {
          const data = await API.post('/api/servers/scan', { url });
          scanResultsWrap.innerHTML = '';

          const result = document.createElement('div');
          result.className = 'scan-result';

          const title = document.createElement('div');
          title.className = 'scan-result-title';
          title.textContent = 'Scan Results';
          result.appendChild(title);

          // MCP detected?
          const detected = document.createElement('div');
          detected.className = 'scan-result-row';
          detected.innerHTML = '<span class="scan-result-label">MCP Server:</span>';
          const detectedBadge = Components.badge(
            data.mcp_server_detected ? 'Detected' : 'Not Detected',
            data.mcp_server_detected ? 'success' : 'error'
          );
          detected.appendChild(detectedBadge);
          result.appendChild(detected);

          // Package managers
          if (data.package_managers && data.package_managers.length > 0) {
            const pm = document.createElement('div');
            pm.className = 'scan-result-row';
            pm.innerHTML = '<span class="scan-result-label">Package Mgr:</span>';
            for (const p of data.package_managers) {
              pm.appendChild(Components.badge(p, 'default'));
            }
            result.appendChild(pm);
          }

          // Server files
          if (data.server_files && data.server_files.length > 0) {
            const sf = document.createElement('div');
            sf.className = 'scan-result-row';
            sf.innerHTML = '<span class="scan-result-label">Server Files:</span><span>' + data.server_files.join(', ') + '</span>';
            result.appendChild(sf);
          }

          // Installation hints
          if (data.installation_hints && data.installation_hints.length > 0) {
            const hints = document.createElement('div');
            hints.className = 'scan-result-row';
            hints.classList.add('servers-scan-hints');
            hints.innerHTML = '<span class="scan-result-label">Install Hints:</span>';
            for (const h of data.installation_hints) {
              const hint = document.createElement('code');
              hint.className = 'servers-scan-hint';
              hint.textContent = h;
              hints.appendChild(hint);
            }
            result.appendChild(hints);
          }

          scanResultsWrap.appendChild(result);
        } catch (e) {
          scanResultsWrap.innerHTML = '';
          scanResultsWrap.appendChild(Components.errorState('Scan failed: ' + e.message));
        } finally {
          scanBtn.textContent = 'Scan';
          scanBtn.disabled = false;
        }
      });

      // Cancel button at bottom
      const actions = document.createElement('div');
      actions.className = 'form-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.type = 'button';
      cancelBtn.addEventListener('click', () => { formWrap.innerHTML = ''; });
      actions.appendChild(cancelBtn);
      wrap.appendChild(actions);
    }

    async function handleInstall(srv, btn) {
      const serverName = typeof srv === 'string' ? srv : srv.name;
      btn.textContent = 'Installing...';
      btn.disabled = true;

      try {
        const payload = typeof srv === 'string'
          ? { name: srv }
          : { name: srv.name, install_type: srv.install_type, remote_url: srv.remote_url };
        await API.post('/api/servers/install', payload);
        Components.toast(`${serverName} installed successfully`, 'success');
        btn.textContent = 'Installed';
        btn.classList.add('btn-success');
        if (window.refreshSidebarCounts) window.refreshSidebarCounts();
        // Refresh table behind the form
        try {
          const servers = normalizeServersList(await API.get('/api/servers'));
          const tableWrap = document.getElementById('servers-table-wrap');
          if (tableWrap) self._renderTable(tableWrap, servers);
        } catch (_) {}
      } catch (e) {
        Components.toast('Install failed: ' + e.message, 'error');
        btn.textContent = 'Install';
        btn.disabled = false;
      }
    }

    renderFields();
    form.appendChild(fieldsWrap);
    formWrap.appendChild(form);
  },

  async _showDetail(serverName) {
    const panel = document.getElementById('server-detail-panel');
    if (!panel) return;

    // Toggle off if clicking same server
    if (this.expandedServer === serverName) {
      panel.innerHTML = '';
      this.expandedServer = null;
      return;
    }

    this.expandedServer = serverName;
    panel.innerHTML = '';
    panel.appendChild(Components.loading());

    try {
      const detail = await API.get(`/api/servers/${serverName}`);
      panel.innerHTML = '';

      const card = document.createElement('div');
      card.className = 'detail-card';

      // Header with name and actions
      const header = document.createElement('div');
      header.className = 'detail-header';
      header.innerHTML = `
        <div>
          <h3 class="servers-detail-title">${detail.name}</h3>
          <span class="secondary-text">${detail.description || 'No description'}</span>
        </div>
      `;

      // Action buttons
      const actions = document.createElement('div');
      actions.className = 'detail-actions';

      const testBtn = document.createElement('button');
      testBtn.className = 'btn btn-sm';
      testBtn.textContent = 'Test Connection';
      testBtn.addEventListener('click', async () => {
        testBtn.textContent = 'Testing...';
        testBtn.disabled = true;
        try {
          const result = await API.post(`/api/servers/${serverName}/test`);
          Components.toast(result.success ? 'Connection OK' : 'Test failed: ' + result.output, result.success ? 'success' : 'error');
        } catch (e) {
          Components.toast('Test error: ' + e.message, 'error');
        }
        testBtn.textContent = 'Test Connection';
        testBtn.disabled = false;
      });
      actions.appendChild(testBtn);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn btn-sm';
      removeBtn.classList.add('status-error-text');
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', async () => {
        // Fetch dependents for an informed confirmation dialog
        let msg = `Remove ${serverName}? This will also delete its tools and intent mappings.`;
        try {
          const deps = await API.get(`/api/servers/${serverName}/dependents`);
          msg = `Remove ${serverName}? This is permanent.\n\nThis will delete:\n` +
            `• ${deps.intents?.length || 0} intent mappings\n` +
            `• All tools and parameter rules\n` +
            `• Extractor rules for this server`;
          if (deps.skills?.length) {
            msg += `\n\n⚠ Skills affected: ${deps.skills.join(', ')}`;
          }
          if (deps.scheduled_tasks?.length) {
            msg += `\n⚠ Scheduled tasks referencing this server: ${deps.scheduled_tasks.join(', ')}`;
          }
        } catch { /* fall back to simple message */ }

        if (await Components.confirm(msg)) {
          try {
            const result = await API.del(`/api/servers/${serverName}`);
            // Build cleanup summary for toast
            const c = result.cleaned || {};
            const parts = [];
            if (c.tools) parts.push(`${c.tools} tools`);
            if (c.intents) parts.push(`${c.intents} intents`);
            if (c.parameterRules) parts.push(`${c.parameterRules} param rules`);
            if (c.idMappings) parts.push(`${c.idMappings} ID mappings`);
            if (c.extractors) parts.push(`${c.extractors} extractors`);
            const summary = parts.length ? ` (cleaned: ${parts.join(', ')})` : '';
            Components.toast(`${serverName} removed${summary}`, 'success');
            if (result.warnings?.length) {
              Components.toast(`⚠ ${result.warnings.join('; ')}`, 'warning');
            }
            if (window.refreshSidebarCounts) window.refreshSidebarCounts();
            // Re-render the whole view
            const container = document.getElementById('main-content');
            if (container) this.render(container);
          } catch (e) {
            Components.toast('Remove failed: ' + e.message, 'error');
          }
        }
      });
      actions.appendChild(removeBtn);

      header.appendChild(actions);
      card.appendChild(header);

      // Command info
      const cmdSection = document.createElement('div');
      cmdSection.className = 'detail-section';
      cmdSection.innerHTML = `
        <div class="detail-label">Command</div>
        <code class="detail-code">${detail.command} ${detail.args || ''}</code>
        <div class="servers-detail-meta-row">
          <span class="secondary-text">Type: ${detail.connection_type}</span>
          <span class="secondary-text">Lifecycle: ${detail.lifecycle_type || 'ephemeral'}</span>
          <span class="secondary-text">Health: ${detail.health_status || 'unknown'}</span>
        </div>
      `;
      card.appendChild(cmdSection);

      // Credentials / Auth panel
      const credSection = document.createElement('div');
      credSection.className = 'detail-section';
      credSection.innerHTML = `<div class="detail-label">Authentication</div>`;

      const credBody = document.createElement('div');
      credBody.className = 'cred-panel';

      // Show existing credentials
      const existingCreds = detail.credentials || [];
      if (existingCreds.length > 0) {
        const credList = document.createElement('div');
        credList.className = 'cred-list';
        for (const cred of existingCreds) {
          const row = document.createElement('div');
          row.className = 'cred-row';
          const typeLabel = cred.credential_type.replace(/_/g, ' ');
          const sourceTag = cred.source === 'env' ? `env: ${cred.env_var_name}` : cred.source || 'database';
          row.innerHTML = `
            <div class="cred-row-info">
              <span class="cred-row-type">${typeLabel}</span>
              <span class="cred-row-header">${cred.header_name || ''}: ${cred.credential_value || '(env)'}</span>
              <span class="cred-row-source">${sourceTag}</span>
            </div>
          `;
          const removeCredBtn = document.createElement('button');
          removeCredBtn.className = 'btn btn-sm';
          removeCredBtn.classList.add('status-error-text');
          removeCredBtn.textContent = 'Remove';
          removeCredBtn.addEventListener('click', async () => {
            try {
              await API.del(`/api/servers/${serverName}/credentials/${cred.credential_type}`);
              Components.toast('Credential removed', 'success');
              this._showDetail(serverName); // refresh
            } catch (e) {
              Components.toast('Failed: ' + e.message, 'error');
            }
          });
          row.appendChild(removeCredBtn);
          credList.appendChild(row);
        }
        credBody.appendChild(credList);
      }

      // Show existing OAuth config if present
      if (detail.oauth_config) {
        const oauthInfo = document.createElement('div');
        oauthInfo.className = 'cred-row';
        const hasToken = existingCreds.some(c => c.credential_type === 'oauth_access_token');
        oauthInfo.innerHTML = `
          <div class="cred-row-info">
            <span class="cred-row-type">OAuth</span>
            <span class="cred-row-header">Client: ••••••••</span>
            <span class="cred-row-source">${detail.oauth_config.provider_name || 'oauth'}</span>
            ${hasToken ? '<span class="cred-row-source cred-row-source-ok">Authorized</span>' : ''}
          </div>
        `;

        const oauthBtns = document.createElement('div');
        oauthBtns.className = 'flex gap-2';

        // Authorize button — triggers the full OAuth flow
        if (!hasToken) {
          const authBtn = document.createElement('button');
          authBtn.className = 'btn btn-primary btn-sm';
          authBtn.textContent = 'Authorize';
          authBtn.addEventListener('click', async () => {
            authBtn.textContent = 'Opening browser...';
            authBtn.disabled = true;
            try {
              const result = await API.post(`/api/servers/${serverName}/oauth/authorize`);
              if (result.success) {
                Components.toast('Authorization complete! Token saved.', 'success');
                this._showDetail(serverName);
              } else {
                Components.toast(result.error || 'Authorization failed', 'error');
                authBtn.textContent = 'Authorize';
                authBtn.disabled = false;
              }
            } catch (e) {
              Components.toast('Auth failed: ' + e.message, 'error');
              authBtn.textContent = 'Authorize';
              authBtn.disabled = false;
            }
          });
          oauthBtns.appendChild(authBtn);
        }

        const removeOauthBtn = document.createElement('button');
        removeOauthBtn.className = 'btn btn-sm';
        removeOauthBtn.classList.add('status-error-text');
        removeOauthBtn.textContent = 'Remove';
        removeOauthBtn.addEventListener('click', async () => {
          try {
            await API.del(`/api/servers/${serverName}/oauth`);
            Components.toast('OAuth config removed', 'success');
            this._showDetail(serverName);
          } catch (e) { Components.toast('Failed: ' + e.message, 'error'); }
        });
        oauthBtns.appendChild(removeOauthBtn);

        oauthInfo.appendChild(oauthBtns);
        credBody.appendChild(oauthInfo);
      }

      // Add credential form
      const credForm = document.createElement('div');
      credForm.className = 'cred-form';
      credForm.innerHTML = `
        <div class="cred-form-row">
          <select class="cred-input cred-type-select">
            <option value="api_key">API Key</option>
            <option value="bearer_token">Bearer Token</option>
            <option value="oauth">OAuth (Client ID + Secret)</option>
            <option value="env_var">Environment Variable</option>
          </select>
        </div>
        <div class="cred-form-row cred-value-row">
          <input type="password" class="cred-input cred-value-input" placeholder="Paste token or API key" />
        </div>
        <div class="cred-form-row cred-env-row is-hidden">
          <input type="text" class="cred-input cred-env-input" placeholder="ENV_VAR_NAME (e.g. FIGMA_API_KEY)" />
        </div>
        <div class="cred-oauth-fields is-hidden">
          <div class="cred-form-row">
            <label class="cred-field-label">Client ID</label>
            <input type="text" class="cred-input cred-oauth-client-id" placeholder="Client ID" />
          </div>
          <div class="cred-form-row">
            <label class="cred-field-label">Client Secret</label>
            <input type="password" class="cred-input cred-oauth-client-secret" placeholder="Client Secret" />
          </div>
          <div class="cred-form-row">
            <label class="cred-field-label">Authorization URL <span class="cred-field-optional">(optional)</span></label>
            <input type="text" class="cred-input cred-oauth-auth-url" placeholder="https://example.com/oauth/authorize" />
          </div>
          <div class="cred-form-row">
            <label class="cred-field-label">Token URL <span class="cred-field-optional">(optional)</span></label>
            <input type="text" class="cred-input cred-oauth-token-url" placeholder="https://example.com/oauth/token" />
          </div>
        </div>
      `;

      const typeSelect = credForm.querySelector('.cred-type-select');
      const valueRow = credForm.querySelector('.cred-value-row');
      const envRow = credForm.querySelector('.cred-env-row');
      const oauthFields = credForm.querySelector('.cred-oauth-fields');
      typeSelect.addEventListener('change', () => {
        valueRow.classList.add('is-hidden');
        envRow.classList.add('is-hidden');
        oauthFields.classList.add('is-hidden');
        if (typeSelect.value === 'env_var') {
          envRow.classList.remove('is-hidden');
        } else if (typeSelect.value === 'oauth') {
          oauthFields.classList.remove('is-hidden');
        } else {
          valueRow.classList.remove('is-hidden');
        }
      });

      const saveCredBtn = document.createElement('button');
      saveCredBtn.className = 'btn btn-primary btn-sm';
      saveCredBtn.textContent = 'Save Credential';
      saveCredBtn.classList.add('mt-2');
      saveCredBtn.addEventListener('click', async () => {
        const credType = typeSelect.value;

        saveCredBtn.disabled = true;
        saveCredBtn.textContent = 'Saving...';

        try {
          if (credType === 'oauth') {
            const clientId = credForm.querySelector('.cred-oauth-client-id').value.trim();
            const clientSecret = credForm.querySelector('.cred-oauth-client-secret').value.trim();
            if (!clientId || !clientSecret) {
              Components.toast('Client ID and Client Secret are required', 'error');
              saveCredBtn.disabled = false;
              saveCredBtn.textContent = 'Save Credential';
              return;
            }
            const oauthPayload = {
              client_id: clientId,
              client_secret: clientSecret,
              authorization_endpoint: credForm.querySelector('.cred-oauth-auth-url').value.trim() || undefined,
              token_endpoint: credForm.querySelector('.cred-oauth-token-url').value.trim() || undefined,
            };
            await API.post(`/api/servers/${serverName}/oauth`, oauthPayload);
            Components.toast('OAuth config saved', 'success');
          } else if (credType === 'env_var') {
            const envName = credForm.querySelector('.cred-env-input').value.trim();
            if (!envName) { Components.toast('Enter an environment variable name', 'error'); saveCredBtn.disabled = false; saveCredBtn.textContent = 'Save Credential'; return; }
            await API.post(`/api/servers/${serverName}/credentials`, { credential_type: credType, env_var_name: envName });
            Components.toast('Credential saved', 'success');
          } else {
            const val = credForm.querySelector('.cred-value-input').value.trim();
            if (!val) { Components.toast('Enter a token or key', 'error'); saveCredBtn.disabled = false; saveCredBtn.textContent = 'Save Credential'; return; }
            await API.post(`/api/servers/${serverName}/credentials`, { credential_type: credType, credential_value: val });
            Components.toast('Credential saved', 'success');
          }
          this._showDetail(serverName);
        } catch (e) {
          Components.toast('Failed: ' + e.message, 'error');
          saveCredBtn.disabled = false;
          saveCredBtn.textContent = 'Save Credential';
        }
      });
      credForm.appendChild(saveCredBtn);

      credBody.appendChild(credForm);
      credSection.appendChild(credBody);
      card.appendChild(credSection);

      // Tools list with "Try It" capability
      if (detail.tools && detail.tools.length > 0) {
        const toolsSection = document.createElement('div');
        toolsSection.className = 'detail-section';

        const toolsHeader = document.createElement('div');
        toolsHeader.className = 'flex-between-center';
        toolsHeader.innerHTML = `<div class="detail-label">Tools (${detail.tools.length})</div>`;
        toolsSection.appendChild(toolsHeader);

        const toolsGrid = document.createElement('div');
        toolsGrid.className = 'tools-grid';
        for (const tool of detail.tools) {
          const chip = document.createElement('div');
          chip.className = 'tool-item cursor-pointer';
          chip.title = 'Click to expand — double-click to try it';
          chip.innerHTML = `
            <div class="flex-between-center gap-2">
              <span class="tool-item-name">${tool.name}</span>
              <button class="btn btn-sm tool-try-btn tool-try-btn-compact">Try It</button>
            </div>
            <span class="tool-item-desc">${(tool.description || '').substring(0, 120)}</span>
          `;

          // "Try It" button opens the tool execution modal
          const tryBtn = chip.querySelector('.tool-try-btn');
          tryBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._showToolModal(serverName, tool);
          });

          toolsGrid.appendChild(chip);
        }
        toolsSection.appendChild(toolsGrid);
        card.appendChild(toolsSection);
      }

      // Intent mappings
      if (detail.intents && detail.intents.length > 0) {
        const intentsSection = document.createElement('div');
        intentsSection.className = 'detail-section';
        intentsSection.innerHTML = `<div class="detail-label">Intent Mappings (${detail.intents.length})</div>`;

        const intentsList = document.createElement('div');
        intentsList.className = 'intents-chips';
        for (const intent of detail.intents) {
          const chip = document.createElement('span');
          chip.className = 'badge badge-accent m-2px';
          chip.textContent = `${intent.keyword} → ${intent.tool_name} (p${intent.priority})`;
          intentsList.appendChild(chip);
        }
        intentsSection.appendChild(intentsList);
        card.appendChild(intentsSection);
      }

      // Skills using this server
      if (detail.skills && detail.skills.length > 0) {
        const skillsSection = document.createElement('div');
        skillsSection.className = 'detail-section';
        skillsSection.innerHTML = `<div class="detail-label">Skills Using This Server (${detail.skills.length})</div>`;

        const skillsChips = document.createElement('div');
        skillsChips.className = 'intents-chips';
        for (const skill of detail.skills) {
          const chip = document.createElement('span');
          chip.className = 'badge badge-accent m-2px cursor-pointer';
          chip.textContent = skill.name;
          chip.title = skill.description || '';
          if (!skill.is_active) {
            chip.classList.add('opacity-50');
            chip.textContent += ' (inactive)';
          }
          chip.addEventListener('click', (e) => {
            e.stopPropagation();
            window.location.hash = '#/capabilities?tab=skills';
          });
          skillsChips.appendChild(chip);
        }
        skillsSection.appendChild(skillsChips);
        card.appendChild(skillsSection);
      }

      panel.appendChild(card);

    } catch (err) {
      panel.innerHTML = '';
      panel.appendChild(Components.errorState('Failed to load server detail: ' + err.message));
    }
  },

  /** Tool execution modal — JSON args input + live results */
  _showToolModal(serverName, tool) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const modal = document.createElement('div');
    modal.className = 'servers-tool-modal';

    // Header
    const header = document.createElement('div');
    header.className = 'mb-4';
    header.innerHTML = `
      <div class="flex-center gap-2 mb-1">
        <span class="servers-tool-modal-title">${tool.name}</span>
        <span class="badge badge-accent text-xs">${serverName}</span>
      </div>
      <div class="text-sm text-muted-color">${tool.description || 'No description'}</div>
    `;
    modal.appendChild(header);

    // Schema info
    const schema = tool.input_schema || tool.inputSchema || {};
    const props = schema.properties || {};
    const required = schema.required || [];
    const propKeys = Object.keys(props);

    if (propKeys.length > 0) {
      const schemaInfo = document.createElement('div');
      schemaInfo.className = 'mb-3';
      schemaInfo.innerHTML = '<div class="servers-tool-label">Parameters</div>';

      const paramGrid = document.createElement('div');
      paramGrid.className = 'servers-tool-param-grid';
      for (const [key, val] of Object.entries(props)) {
        const isRequired = required.includes(key);
        const paramEl = document.createElement('div');
        paramEl.className = 'servers-tool-param';
        paramEl.innerHTML = `<code class="text-primary-color">${key}</code>` +
          `<span class="servers-tool-param-type">${val.type || ''}${isRequired ? ' *' : ''}</span>`;
        paramEl.title = val.description || '';
        paramGrid.appendChild(paramEl);
      }
      schemaInfo.appendChild(paramGrid);
      modal.appendChild(schemaInfo);
    }

    // Args input
    const argsLabel = document.createElement('div');
    argsLabel.className = 'servers-tool-label';
    argsLabel.textContent = 'Arguments (JSON)';
    modal.appendChild(argsLabel);

    // Build default args from schema
    const defaultArgs = {};
    for (const [key, val] of Object.entries(props)) {
      if (val.default !== undefined) defaultArgs[key] = val.default;
      else if (required.includes(key)) {
        if (val.type === 'string') defaultArgs[key] = '';
        else if (val.type === 'number' || val.type === 'integer') defaultArgs[key] = 0;
        else if (val.type === 'boolean') defaultArgs[key] = false;
        else if (val.type === 'object') defaultArgs[key] = {};
        else if (val.type === 'array') defaultArgs[key] = [];
      }
    }

    const argsInput = document.createElement('textarea');
    argsInput.className = 'servers-tool-args';
    argsInput.value = JSON.stringify(Object.keys(defaultArgs).length ? defaultArgs : {}, null, 2);
    modal.appendChild(argsInput);

    // Run button row
    const btnRow = document.createElement('div');
    btnRow.className = 'servers-tool-btn-row';

    const runBtn = document.createElement('button');
    runBtn.className = 'btn btn-primary';
    runBtn.textContent = 'Run';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Close';
    cancelBtn.addEventListener('click', () => overlay.remove());

    const durationEl = document.createElement('span');
    durationEl.className = 'servers-tool-duration';

    btnRow.appendChild(runBtn);
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(durationEl);
    modal.appendChild(btnRow);

    // Results area
    const resultsLabel = document.createElement('div');
    resultsLabel.className = 'servers-tool-label mt-3 mb-1';
    resultsLabel.textContent = 'Result';
    resultsLabel.classList.add('is-hidden');
    modal.appendChild(resultsLabel);

    const resultsArea = document.createElement('pre');
    resultsArea.className = 'servers-tool-results is-hidden';
    modal.appendChild(resultsArea);

    // Run handler
    runBtn.addEventListener('click', async () => {
      let args;
      try {
        args = JSON.parse(argsInput.value || '{}');
      } catch (e) {
        Components.toast('Invalid JSON: ' + e.message, 'error');
        return;
      }

      runBtn.disabled = true;
      runBtn.textContent = 'Running...';
      durationEl.textContent = '';
      resultsLabel.classList.remove('is-hidden');
      resultsArea.classList.remove('is-hidden');
      resultsArea.textContent = 'Executing...';

      const startTime = Date.now();
      try {
        const data = await API.post('/api/tools/call', { server: serverName, tool: tool.name, args });
        const elapsed = Date.now() - startTime;
        durationEl.textContent = `${elapsed}ms`;

        // Try to pretty-print JSON results
        let displayText = data.result || JSON.stringify(data, null, 2);
        try {
          // If result is a string containing JSON, parse and re-format it
          const parsed = JSON.parse(displayText);
          displayText = JSON.stringify(parsed, null, 2);
        } catch {}

        resultsArea.textContent = displayText;
      } catch (e) {
        const elapsed = Date.now() - startTime;
        durationEl.textContent = `${elapsed}ms`;
        resultsArea.textContent = 'Error: ' + e.message;
        resultsArea.classList.add('status-error-text');
      }

      runBtn.disabled = false;
      runBtn.textContent = 'Run';
    });

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  },
};
