/**
 * System View — version, stats, health overview (+ home dashboard sections)
 */

const SystemView = {
  destroy() {
    if (typeof HomeView !== 'undefined' && typeof HomeView.destroy === 'function') {
      HomeView.destroy();
    }
  },

  async render(container) {
    container.appendChild(Components.pageHeader('System', 'Vodou overview and stats'));
    container.appendChild(Components.loading());

    try {
      const [data, logsData] = await Promise.all([
        API.get('/api/system'),
        API.get('/api/logs?limit=200').catch(() => ({ logs: [] })),
      ]);
      container.innerHTML = '';
      container.appendChild(Components.pageHeader('System', 'Vodou overview and stats'));

      const runtimeSection = this._renderRuntimeSection(data.runtime);
      container.appendChild(runtimeSection);

      if (typeof HomeView !== 'undefined' && HomeView.renderDashboardInto) {
        await HomeView.renderDashboardInto(container, { sysData: data, logsData, embedded: true });
        HomeView._startPolling();
      }

      const diagTitle = document.createElement('h3');
      diagTitle.className = 'section-title';
      diagTitle.classList.add('mt-7');
      diagTitle.textContent = 'Diagnostics';
      container.appendChild(diagTitle);

      // Info cards grid
      const grid = document.createElement('div');
      grid.className = 'card-grid';

      // Version card
      grid.appendChild(this.infoCard('Version', data.version, 'accent'));
      grid.appendChild(this.infoCard('Auth Mode', data.authMode, 'default'));
      grid.appendChild(this.infoCard('Uptime', this.formatUptime(data.uptime), 'default'));
      grid.appendChild(this.infoCard('Model', data.gateway?.model || 'unknown', 'default'));
      container.appendChild(grid);

      // Counts section
      const countsHeader = document.createElement('h3');
      countsHeader.className = 'section-title';
      countsHeader.textContent = 'Database';
      container.appendChild(countsHeader);

      const countsGrid = document.createElement('div');
      countsGrid.className = 'card-grid';

      const labels = {
        mcp_servers: 'MCP Servers',
        tools: 'Tools',
        intent_mappings: 'Intents',
        skills_registry: 'Skills',
        scheduled_tasks: 'Schedules',
        script_registry: 'Scripts',
        work_logs: 'Work Logs',
        parameter_rules: 'Param Rules',
        conversation_sessions: 'Sessions',
        memory_chunks: 'Memory Chunks',
      };

      for (const [key, label] of Object.entries(labels)) {
        if (data.counts[key] !== undefined) {
          countsGrid.appendChild(this.infoCard(label, String(data.counts[key]), 'default'));
        }
      }
      container.appendChild(countsGrid);

      // Update sidebar version
      const versionLabel = document.getElementById('version-label');
      if (versionLabel) versionLabel.textContent = data.version;

      // Updates section
      const updatesSection = this._renderUpdatesSection(data);
      container.appendChild(updatesSection);

      // Server Health Grid
      try {
        const rawServers = await API.get('/api/servers');
        const servers = Array.isArray(rawServers) ? rawServers : (rawServers.servers || []);

        const healthHeader = document.createElement('h3');
        healthHeader.className = 'section-title';
        healthHeader.textContent = 'Server Health';
        container.appendChild(healthHeader);

        const healthGrid = document.createElement('div');
        healthGrid.className = 'card-grid';

        for (const srv of servers) {
          const card = document.createElement('div');
          card.className = 'info-card';
          card.classList.add('system-health-card');

          const dot = Components.statusDot(srv.health_status === 'healthy' || srv.active);
          card.appendChild(dot);

          const info = document.createElement('div');
          info.classList.add('system-health-info');

          const name = document.createElement('div');
          name.classList.add('system-health-name');
          name.textContent = srv.name;
          info.appendChild(name);

          const meta = document.createElement('div');
          meta.classList.add('system-health-meta');
          meta.textContent = `${srv.tool_count} tools · ${srv.intent_count} intents`;
          info.appendChild(meta);

          card.appendChild(info);

          const statusText = document.createElement('span');
          statusText.className = srv.active ? 'system-health-status status-ok-text' : 'system-health-status status-error-text';
          statusText.textContent = srv.active ? 'active' : 'inactive';
          card.appendChild(statusText);

          card.addEventListener('click', () => {
            location.hash = '#/servers/' + encodeURIComponent(srv.name);
          });
          healthGrid.appendChild(card);
        }

        container.appendChild(healthGrid);
      } catch (e) {
        // Server health is non-critical, silently skip
      }

    } catch (err) {
      container.innerHTML = '';
      container.appendChild(Components.errorState('Failed to load system info: ' + err.message));
    }
  },

  infoCard(label, value, variant) {
    const card = document.createElement('div');
    card.className = 'info-card';
    card.innerHTML = `
      <div class="info-card-value ${variant === 'accent' ? 'accent' : ''}">${value}</div>
      <div class="info-card-label">${label}</div>
    `;
    return card;
  },

  formatUptime(seconds) {
    if (seconds < 60) return seconds + 's';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h + 'h ' + m + 'm';
  },

  _renderRuntimeSection(rt) {
    const wrap = document.createElement('div');
    const title = document.createElement('h3');
    title.className = 'section-title';
    title.textContent = 'Kernel / Runtime';
    wrap.appendChild(title);

    if (!rt || typeof rt !== 'object') {
      const p = document.createElement('p');
      p.className = 'text-muted';
      p.textContent = 'Runtime status unavailable — ensure vodou-core is built and run ./vodou-core daemon ensure.';
      wrap.appendChild(p);
      return wrap;
    }

    const overall = rt.overall || 'unknown';
    const row = document.createElement('div');
    row.className = 'runtime-overall-line';
    row.style.marginBottom = '12px';
    const dotClass = overall === 'healthy' ? 'status-ok-dot' : overall === 'degraded' ? 'status-warn-dot' : 'status-error-dot';
    row.innerHTML = `<span class="system-status-dot ${dotClass}"></span> <strong>${overall}</strong> <span class="text-muted" style="margin-left:8px">schema v${rt.schema_version ?? '?'}</span>`;
    wrap.appendChild(row);

    const grid = document.createElement('div');
    grid.className = 'card-grid';
    const c = rt.components || {};

    const daemon = c.daemon || {};
    grid.appendChild(this.infoCard('Daemon', daemon.ok ? 'OK' : 'No', daemon.ok ? 'accent' : 'default'));

    const worker = c.worker || {};
    const wLabel = worker.ok ? 'OK' : (worker.reason || 'down');
    grid.appendChild(this.infoCard('Worker', wLabel, worker.ok ? 'accent' : 'default'));

    const inj = c.memory_injection || {};
    grid.appendChild(this.infoCard('Memory inject', inj.ok ? 'OK' : 'No', inj.ok ? 'accent' : 'default'));

    const mem = c.memory_db || {};
    const memLabel = mem.chunks != null ? String(mem.chunks) + ' chunks' : '—';
    grid.appendChild(this.infoCard('memory.db', memLabel, 'default'));

    const ge = c.gateway_extractor || {};
    const wm = ge.watermark_row_id != null ? String(ge.watermark_row_id) : '—';
    grid.appendChild(this.infoCard('Extractor WM', wm, 'default'));

    const mcp = c.mcp_summary || {};
    grid.appendChild(this.infoCard('MCP healthy', `${mcp.healthy ?? 0} / ${mcp.total_active ?? 0}`, 'default'));

    wrap.appendChild(grid);

    const hints = rt.hints;
    if (Array.isArray(hints) && hints.length > 0) {
      const ul = document.createElement('ul');
      ul.className = 'runtime-hints';
      ul.style.marginTop = '10px';
      ul.style.paddingLeft = '1.2em';
      for (const h of hints) {
        const li = document.createElement('li');
        li.textContent = typeof h === 'string' ? h : String(h);
        ul.appendChild(li);
      }
      wrap.appendChild(ul);
    }

    return wrap;
  },

  _renderUpdatesSection(data) {
    const wrap = document.createElement('div');

    const title = document.createElement('h3');
    title.className = 'section-title';
    title.classList.add('mt-7');
    title.textContent = 'Updates';
    wrap.appendChild(title);

    const card = document.createElement('div');
    card.className = 'info-card';
    card.classList.add('system-updates-card');

    const upd = data.updateAvailable;
    const statusLine = document.createElement('div');
    statusLine.className = 'system-updates-status-line';

    if (upd) {
      statusLine.innerHTML = `
        <span class="system-status-dot status-warn-dot"></span>
        <span class="status-warn-text fw-600">${upd.is_forced ? '🔒 Security update' : 'Update'} available: ${upd.version}</span>`;
    } else {
      statusLine.innerHTML = `
        <span class="system-status-dot status-ok-dot"></span>
        <span class="status-ok-text fw-600">Up to date (${data.version})</span>`;
    }
    card.appendChild(statusLine);

    // Status message area
    const statusMsg = document.createElement('div');
    statusMsg.id = 'update-status-msg';
    statusMsg.className = 'system-status-msg';
    card.appendChild(statusMsg);

    // Binary update buttons
    const btnRow = document.createElement('div');
    btnRow.className = 'system-btn-row';

    const checkBtn = document.createElement('button');
    checkBtn.className = 'btn btn-secondary';
    checkBtn.textContent = 'Check Now';
    checkBtn.onclick = () => this._checkUpdate(statusMsg, checkBtn);
    btnRow.appendChild(checkBtn);

    if (upd) {
      const installBtn = document.createElement('button');
      installBtn.className = 'btn btn-primary';
      installBtn.textContent = upd.is_forced ? '🔒 Install Security Update' : 'Install Update';
      installBtn.onclick = () => this._installUpdate(statusMsg, installBtn);
      btnRow.appendChild(installBtn);
    }

    const rollbackBtn = document.createElement('button');
    rollbackBtn.className = 'btn btn-secondary';
    rollbackBtn.textContent = 'Rollback';
    rollbackBtn.title = 'Restore databases + binaries from most recent backup';
    rollbackBtn.onclick = () => this._rollbackUpdate(statusMsg, rollbackBtn);
    btnRow.appendChild(rollbackBtn);

    card.appendChild(btnRow);

    // Component updates section
    const compTitle = document.createElement('div');
    compTitle.className = 'system-comp-title';
    compTitle.textContent = 'Component Updates (MCP Servers, Skills, Scripts)';
    card.appendChild(compTitle);

    const compMsg = document.createElement('div');
    compMsg.id = 'comp-status-msg';
    compMsg.className = 'system-comp-msg';
    card.appendChild(compMsg);

    const compBtnRow = document.createElement('div');
    compBtnRow.className = 'system-btn-row';

    const compCheckBtn = document.createElement('button');
    compCheckBtn.className = 'btn btn-secondary';
    compCheckBtn.textContent = 'Check Components';
    compCheckBtn.onclick = () => this._checkComponents(compMsg, compBtnRow, compCheckBtn);
    compBtnRow.appendChild(compCheckBtn);
    card.appendChild(compBtnRow);

    wrap.appendChild(card);
    return wrap;
  },

  async _checkUpdate(statusEl, btn) {
    btn.disabled = true;
    btn.textContent = 'Checking…';
    statusEl.textContent = '';
    try {
      const data = await API.post('/api/system/update-check', {});
      if (data.update_available) {
        statusEl.innerHTML = `<span class="status-warn-text">Update available: ${data.available_version}${data.is_forced ? ' (security)' : ''}</span>`;
        // If the Install Update button isn't already in the DOM (cold page
        // where metadata hadn't been persisted yet), inject it inline right
        // next to Check Now so the user can install without a page reload.
        const btnRow = btn.parentElement;
        if (btnRow && !btnRow.querySelector('[data-install-update]')) {
          const installBtn = document.createElement('button');
          installBtn.className = 'btn btn-primary';
          installBtn.dataset.installUpdate = '1';
          installBtn.textContent = data.is_forced ? '🔒 Install Security Update' : 'Install Update';
          installBtn.onclick = () => this._installUpdate(statusEl, installBtn);
          btn.insertAdjacentElement('afterend', installBtn);
        }
      } else {
        statusEl.innerHTML = `<span class="status-ok-text">Up to date. ${data.output || ''}</span>`;
        // Remove a stale Install button if the check now says we're current.
        const btnRow = btn.parentElement;
        const stale = btnRow && btnRow.querySelector('[data-install-update]');
        if (stale) stale.remove();
      }
    } catch (err) {
      statusEl.innerHTML = `<span class="status-error-text">Check failed: ${err.message}</span>`;
    }
    btn.disabled = false;
    btn.textContent = 'Check Now';
  },

  async _installUpdate(statusEl, btn) {
    if (!confirm('Install the update now? The system will restart (~30 seconds).')) return;
    btn.disabled = true;
    btn.textContent = 'Installing…';
    statusEl.textContent = 'Update started. Page will reconnect after restart…';
    try {
      await API.post('/api/system/update-install', {});
    } catch (err) {
      statusEl.innerHTML = `<span class="status-error-text">Failed: ${err.message}</span>`;
      btn.disabled = false;
      btn.textContent = 'Install Update';
    }
  },

  async _rollbackUpdate(statusEl, btn) {
    if (!confirm('Roll back to the previous version? This restores databases and binaries from the last backup.')) return;
    btn.disabled = true;
    btn.textContent = 'Rolling back…';
    statusEl.textContent = 'Rollback started. Page will reconnect after restart…';
    try {
      await API.post('/api/system/update-rollback', {});
    } catch (err) {
      statusEl.innerHTML = `<span class="status-error-text">Failed: ${err.message}</span>`;
      btn.disabled = false;
      btn.textContent = 'Rollback';
    }
  },

  async _checkComponents(statusEl, btnRow, btn) {
    btn.disabled = true;
    btn.textContent = 'Checking…';
    statusEl.textContent = 'Downloading release and comparing components…';
    try {
      const data = await API.post('/api/system/update-components-check', {});
      const components = data.components || [];

      if (components.length === 0) {
        statusEl.innerHTML = `<span class="status-ok-text">All components up to date.</span>`;
        btn.disabled = false;
        btn.textContent = 'Check Components';
        return;
      }

      statusEl.innerHTML = `<strong>${components.length} component${components.length > 1 ? 's' : ''} with changes:</strong>`;

      // Build checkbox list
      const listEl = document.createElement('div');
      listEl.className = 'system-comp-list';
      components.forEach(c => {
        const row = document.createElement('label');
        row.className = 'system-comp-row';
        row.innerHTML = `<input type="checkbox" data-idx="${c.index}" checked class="m-0">
          <span class="text-primary-color fw-600">${c.name}</span>
          <span class="text-muted-color">${c.category} · ${c.changed_files} file${c.changed_files !== 1 ? 's' : ''}</span>`;
        listEl.appendChild(row);
      });
      btnRow.insertBefore(listEl, btn.nextSibling);

      // Apply button
      const applyBtn = document.createElement('button');
      applyBtn.className = 'btn btn-primary';
      applyBtn.textContent = 'Apply Selected';
      applyBtn.classList.add('mt-2');
      applyBtn.onclick = () => this._applyComponents(statusEl, applyBtn, listEl);
      btnRow.appendChild(applyBtn);

      btn.disabled = false;
      btn.textContent = 'Re-check';
    } catch (err) {
      statusEl.innerHTML = `<span class="status-error-text">Failed: ${err.message}</span>`;
      btn.disabled = false;
      btn.textContent = 'Check Components';
    }
  },

  async _applyComponents(statusEl, btn, listEl) {
    const checkboxes = listEl.querySelectorAll('input[type="checkbox"]:checked');
    const selected = Array.from(checkboxes).map(cb => parseInt(cb.dataset.idx));
    if (selected.length === 0) {
      statusEl.innerHTML = `<span class="status-warn-text">No components selected.</span>`;
      return;
    }
    if (!confirm(`Apply updates to ${selected.length} component${selected.length > 1 ? 's' : ''}?`)) return;
    btn.disabled = true;
    btn.textContent = 'Applying…';
    statusEl.textContent = 'Component update started…';
    try {
      await API.post('/api/system/update-components-apply', { selected });
      statusEl.innerHTML = `<span class="status-ok-text">Component update in progress. Refresh in ~15 seconds.</span>`;
    } catch (err) {
      statusEl.innerHTML = `<span class="status-error-text">Failed: ${err.message}</span>`;
      btn.disabled = false;
      btn.textContent = 'Apply Selected';
    }
  },
};
