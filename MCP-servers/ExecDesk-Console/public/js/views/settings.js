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

  _esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
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

  TABS: ['profile', 'model', 'env', 'memory', 'about'],

  _activeTab() {
    const q = location.hash.includes('?') ? location.hash.split('?')[1] : '';
    const tab = new URLSearchParams(q).get('tab') || 'profile';
    return this.TABS.includes(tab) ? tab : 'profile';
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
    container.innerHTML = '<div class="page-header"><h1>Settings</h1><p class="page-subtitle">Profile, LLM/Model, environment, and about</p></div><div id="settings-root" class="loading-state">Loading...</div>';

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
          ${mk('profile', 'Profile')}
          ${mk('model', 'LLM/Model')}
          ${mk('env', 'Environment')}
          ${mk('memory', 'Memory')}
          ${mk('about', 'About')}
        </div>
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
        <div id="settings-panel-about" class="settings-panel"${tab === 'about' ? '' : ' hidden'}>
          <div class="loading-state">Loading…</div>
        </div>`;
      this._bindTabs(root);
      void this._loadProfilePanel();
      this._renderModelPanel();
      void this._loadAboutPanel();
      void this._loadEnvPanel();
      void this._loadMemoryPanel();
    } catch (err) {
      document.getElementById('settings-root').innerHTML = `<div class="empty-state">Failed to load settings: ${err.message}</div>`;
    }
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
      const status = await API.get('/api/memory/extractor/status');
      this._memoryStatus = status;
      panel.innerHTML = this._renderMemoryPanel(status);
      this._bindMemoryPanel(panel);
    } catch (err) {
      panel.innerHTML = `<div class="empty-state">Failed to load memory settings: ${this._esc(err.message || String(err))}</div>`;
    }
  },

  _renderMemoryPanel(status) {
    const override = status.override || '';
    const backends = status.backends || [];
    const lastBench = status.lastBench || null;
    const opts = ['<option value="">(none — use memory.toml)</option>']
      .concat(backends.map(b => `<option value="${this._esc(b)}"${b === override ? ' selected' : ''}>${this._esc(b)}</option>`))
      .join('');

    const lastBenchHtml = lastBench ? `
      <div class="settings-section settings-section-tight">
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

    return `
      <div class="settings-section">
        <h3 class="settings-section-title">Memory extraction</h3>
        <p class="settings-note">Controls which LLM backend writes new long-term memories at session end.
          Priority: <code>VODOU_MEMORY_EXTRACTION_PROVIDER</code> env var → this override → <code>memory.toml</code>.
          The bench compares a test backend against a reference (typically <code>anthropic</code>) using cosine similarity
          on the extracted bullets; pass threshold is ≥80% of prompts scoring ≥0.85.</p>

        <div class="settings-row settings-row-gap-md">
          <span class="settings-current-label settings-label-fixed">Override</span>
          <select id="memext-override" class="settings-input">${opts}</select>
          <button type="button" class="btn btn-primary" id="memext-save">Save</button>
          <button type="button" class="btn btn-secondary" id="memext-clear">Clear</button>
        </div>
        <div id="memext-save-status" class="settings-note settings-note-tight"></div>
      </div>

      <div class="settings-section">
        <h3 class="settings-section-title">Run benchmark</h3>
        <p class="settings-note">Runs the 50-prompt extraction fixture end-to-end. Structure-only mode is a cheap
          sanity check; compare mode runs both providers and scores cosine similarity. Long-running (minutes) —
          keep this page open.</p>

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
        <div id="memext-bench-results" class="settings-section settings-section-tight" style="display:none"></div>
      </div>

      ${lastBenchHtml}
    `;
  },

  _bindMemoryPanel(panel) {
    panel.querySelector('#memext-save')?.addEventListener('click', async () => {
      const sel = panel.querySelector('#memext-override');
      const val = sel?.value || '';
      const statusEl = panel.querySelector('#memext-save-status');
      if (statusEl) { statusEl.textContent = 'Saving…'; statusEl.className = 'settings-note settings-note-tight'; }
      try {
        await API.post('/api/memory/extractor/set-backend', { provider: val || null });
        if (statusEl) {
          statusEl.textContent = val
            ? `Saved — vodou-core will use "${val}" for new extractions (daemon restart not required, but verify with bench).`
            : 'Cleared — vodou-core falls back to memory.toml.';
          statusEl.className = 'settings-note settings-note-tight settings-ok';
        }
      } catch (e) {
        if (statusEl) {
          statusEl.textContent = 'Failed: ' + (e.message || e);
          statusEl.className = 'settings-note settings-note-tight settings-warn';
        }
      }
    });

    panel.querySelector('#memext-clear')?.addEventListener('click', () => {
      const sel = panel.querySelector('#memext-override');
      if (sel) sel.value = '';
      panel.querySelector('#memext-save')?.click();
    });

    panel.querySelector('#memext-bench-run')?.addEventListener('click', async () => {
      const backend = panel.querySelector('#memext-bench-backend')?.value || '';
      const reference = panel.querySelector('#memext-bench-reference')?.value || '';
      const statusEl = panel.querySelector('#memext-bench-status');
      const resultsEl = panel.querySelector('#memext-bench-results');
      const btn = panel.querySelector('#memext-bench-run');
      if (!backend) { if (statusEl) statusEl.textContent = 'Pick a test backend first.'; return; }
      if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
      if (statusEl) { statusEl.textContent = 'Running 50 prompts…'; statusEl.className = 'settings-note settings-note-tight'; }
      if (resultsEl) resultsEl.style.display = 'none';
      try {
        const body = reference ? { backend, reference } : { backend };
        const report = await API.post('/api/memory/extractor/bench', body);
        if (statusEl) {
          statusEl.textContent = `${report.passed}/${report.total} passed (${(report.pass_rate * 100).toFixed(0)}%) — ${report.pass ? 'PASS' : 'FAIL'}`;
          statusEl.className = 'settings-note settings-note-tight ' + (report.pass ? 'settings-ok' : 'settings-warn');
        }
        if (resultsEl) {
          resultsEl.style.display = '';
          resultsEl.innerHTML = SettingsView._renderBenchResults(report);
        }
      } catch (e) {
        if (statusEl) {
          statusEl.textContent = 'Benchmark failed: ' + (e.message || e);
          statusEl.className = 'settings-note settings-note-tight settings-warn';
        }
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Run benchmark'; }
      }
    });
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

  async _loadAboutPanel() {
    const panel = document.getElementById('settings-panel-about');
    if (!panel) return;
    try {
      const data = await API.get('/api/system');
      const cfg = data.configured ? 'Ready' : 'Not fully configured';
      panel.innerHTML = `
        <div class="settings-section">
          <div class="settings-row settings-row-gap-sm"><span class="settings-current-label settings-label-fixed">Version</span><span>${data.version || '—'}</span></div>
          <div class="settings-row settings-row-gap-sm"><span class="settings-current-label settings-label-fixed">Auth</span><span>${data.authMode || '—'}</span></div>
          <div class="settings-row settings-row-gap-md"><span class="settings-current-label settings-label-fixed">Status</span><span>${cfg}</span></div>
          <p class="settings-note settings-note-block-sm">Diagnostics, uptime, and database counts live on System.</p>
          <a href="#/system" class="btn btn-primary btn-link-inline">Open System status</a>
        </div>`;
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

    el.innerHTML = `
      <div class="settings-current">
        <span class="settings-current-label">Active Provider</span>
        <span class="settings-current-value">${activeLabel}${activeModel ? ' — ' + activeModel : ''}</span>
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

    ['claude-cli', 'kimi-cli', 'anthropic', 'kimi', 'openai', 'google', 'groq', 'deepseek', 'xai', 'mistral', 'openrouter', 'ollama'].forEach(p => this._fetchModels(p, true));
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
                <code class="cli-install-cmd cli-install-cmd-select">curl -fsSL https://claude.ai/install.sh | bash</code>
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
                ${this._modelCombo('provider-claude-cli-model', data.cli_model || 'sonnet', ['opus', 'sonnet', 'haiku'], cliDisabled)}
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
                <div class="cli-status-desc">Install Moonshot Kimi Code CLI for terminal + OAuth</div>
                <code class="cli-install-cmd cli-install-cmd-select">curl -LsSf https://code.kimi.com/install.sh | bash</code>
                <a href="#/terminal" class="cli-open-terminal">Open Terminal to install</a>
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
                ${this._modelCombo('provider-kimi-cli-model', data.kimi_cli_model || 'kimi-k2.6', [
                  'kimi-k2.6', 'kimi-k2.5', 'kimi-k2-0905-preview', 'kimi-k2-0711-preview', 'kimi-k2-turbo-preview',
                  'kimi-k2-thinking-turbo', 'kimi-k2-thinking',
                  'moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k', 'moonshot-v1-auto',
                  'moonshot-v1-8k-vision-preview', 'moonshot-v1-32k-vision-preview', 'moonshot-v1-128k-vision-preview',
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
      case 'google': case 'groq': case 'deepseek': case 'xai': case 'mistral': case 'kimi': case 'openrouter': {
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
          kimi:     { keyId: 'kimi', keyField: 'kimi_api_key', modelField: 'kimi_model', placeholder: 'sk-...', defaultModel: 'kimi-k2.6',
                      models: [
                        'kimi-k2.6', 'kimi-k2.5', 'kimi-k2-0905-preview', 'kimi-k2-0711-preview', 'kimi-k2-turbo-preview',
                        'kimi-k2-thinking-turbo', 'kimi-k2-thinking',
                        'moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k', 'moonshot-v1-auto',
                        'moonshot-v1-8k-vision-preview', 'moonshot-v1-32k-vision-preview', 'moonshot-v1-128k-vision-preview',
                      ] },
          openrouter: { keyId: 'openrouter', keyField: 'openrouter_api_key', modelField: 'openrouter_model', placeholder: 'sk-or-...', defaultModel: 'openai/gpt-4o',
                      models: [
                        'openai/gpt-4o', 'openai/gpt-4o-mini',
                        'anthropic/claude-3.5-sonnet',
                        'google/gemini-2.0-flash-001',
                        'meta-llama/llama-3.3-70b-instruct',
                        'deepseek/deepseek-chat',
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
              <code class="cli-install-cmd">brew install ollama && ollama pull llama3</code>
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
          </div>`;
        break;
      case 'custom':
        fields = `
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
      'ollama': 'Run models locally — no API key needed <span class="provider-note-warn">Requires 16GB+ RAM. Responses will be slower than cloud providers.</span>',
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
      case 'google': case 'groq': case 'deepseek': case 'xai': case 'mistral': case 'kimi': case 'openrouter': {
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

  async _activateProvider(providerId) {
    const body = { provider: providerId };

    // Find the button that was clicked and show saving state
    const card = document.querySelector(`.provider-card[data-provider="${providerId}"]`);
    const btn = card?.querySelector('.btn-primary');
    const origText = btn?.textContent;
    if (btn) { btn.textContent = 'Saving...'; btn.disabled = true; }

    switch (providerId) {
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
      case 'google': case 'groq': case 'deepseek': case 'xai': case 'mistral': case 'kimi': case 'openrouter': {
        const presetKey = document.getElementById('provider-' + providerId + '-key')?.value?.replace(/\r/g, '')?.trim();
        if (presetKey) body[providerId + '_api_key'] = presetKey;
        body[providerId + '_model'] = this._getModelValue('provider-' + providerId + '-model');
        break;
      }
      case 'ollama':
        body.ollama_base_url = document.getElementById('provider-ollama-url')?.value;
        body.ollama_model = this._getModelValue('provider-ollama-model');
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
        testEl.innerHTML = `<span class="status-error-text">Save failed: ${err.message}</span>`;
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
      }

      const result = await API.get('/api/settings/models/' + providerId);
      if (!result.models?.length) return;

      // Update the <select> with fresh models
      const select = document.getElementById('provider-' + providerId + '-model');
      if (!select || select.tagName !== 'SELECT') return;

      const currentVal = this._getModelValue('provider-' + providerId + '-model');
      let options = result.models.map(m => `<option value="${m}" ${m === currentVal ? 'selected' : ''}>${m}</option>`).join('');
      const isCustom = currentVal && !result.models.includes(currentVal);
      options += `<option value="__other__" ${isCustom ? 'selected' : ''}>Other (type model name)...</option>`;
      select.innerHTML = options;

      if (result.error && !silent) {
        const testEl = document.getElementById('test-result-' + providerId);
        if (testEl) testEl.innerHTML = `<span class="status-warn-text">${result.error}</span>`;
      }
    } catch (err) {
      if (!silent) console.error('Failed to fetch models:', err);
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
              <input type="text" id="profile-timezone" class="settings-input" value="${this._esc(d.timezone)}" placeholder="e.g. America/New_York">
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

  async _saveUserProfile() {
    const userName = document.getElementById('profile-username')?.value?.trim();
    const pronouns = document.getElementById('profile-pronouns')?.value?.trim();
    const timezone = document.getElementById('profile-timezone')?.value?.trim();
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
