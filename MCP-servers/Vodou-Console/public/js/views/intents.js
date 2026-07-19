/**
 * Intents View — paginated table with search, filter, CRUD
 */
const IntentsView = {
  currentOffset: 0,
  currentLimit: 50,
  currentServer: '',
  currentSearch: '',
  servers: [],
  editingKeyword: null,

  async render(container) {
    container.appendChild(Components.pageHeader('Routing Rules', 'Manage keyword → tool routing'));
    container.appendChild(Components.loading());

    try {
      const data = await this._fetch();
      container.innerHTML = '';

      const intentsHeader = Components.pageHeader(
        'Routing Rules',
        `${data.total} total rules`
      );
      intentsHeader.querySelector('.page-title').appendChild(
        Components.helpTip('Each routing rule maps a keyword to a tool. When that word appears in what you say, Vodou can call that tool automatically.')
      );
      container.appendChild(intentsHeader);

      // Examples banner
      const examplesBanner = document.createElement('div');
      examplesBanner.className = 'intents-examples-banner';
      examplesBanner.innerHTML = '<strong>How routing rules work:</strong> When you say "search for cats", the keyword "search" can route to the web-search tool automatically.';
      container.appendChild(examplesBanner);

      // Intent test panel
      container.appendChild(this._buildTestPanel());

      this.servers = data.servers || [];

      // Controls bar: search + filter + add button
      container.appendChild(this._buildControls());

      // Table
      const tableWrap = document.createElement('div');
      tableWrap.id = 'intents-table-wrap';
      container.appendChild(tableWrap);

      // Pagination
      const pagWrap = document.createElement('div');
      pagWrap.id = 'intents-pagination';
      container.appendChild(pagWrap);

      this._renderTable(tableWrap, data);
      this._renderPagination(pagWrap, data);

    } catch (err) {
      container.innerHTML = '';
      container.appendChild(Components.errorState('Failed to load intents: ' + err.message));
    }
  },

  async _fetch() {
    let url = `/api/intents?offset=${this.currentOffset}&limit=${this.currentLimit}`;
    if (this.currentServer) url += `&server=${encodeURIComponent(this.currentServer)}`;
    if (this.currentSearch) url += `&search=${encodeURIComponent(this.currentSearch)}`;
    return API.get(url);
  },

  _buildControls() {
    const bar = document.createElement('div');
    bar.className = 'intents-controls';

    // Search input
    const search = document.createElement('input');
    search.type = 'text';
    search.placeholder = 'Search keywords or tools...';
    search.value = this.currentSearch;
    search.className = 'intents-control-input';
    let searchTimeout;
    search.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        this.currentSearch = search.value;
        this.currentOffset = 0;
        this._refresh();
      }, 300);
    });
    bar.appendChild(search);

    // Server filter
    const select = document.createElement('select');
    select.className = 'intents-control-select';
    select.innerHTML = '<option value="">All Servers</option>';
    for (const s of this.servers) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      if (s === this.currentServer) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      this.currentServer = select.value;
      this.currentOffset = 0;
      this._refresh();
    });
    bar.appendChild(select);

    // Add button
    const addBtn = document.createElement('button');
    addBtn.className = 'btn';
    addBtn.textContent = '+ Add Intent';
    addBtn.addEventListener('click', () => this._showAddForm());
    bar.appendChild(addBtn);

    return bar;
  },

  async _refresh() {
    try {
      const data = await this._fetch();
      const tableWrap = document.getElementById('intents-table-wrap');
      const pagWrap = document.getElementById('intents-pagination');
      if (tableWrap) this._renderTable(tableWrap, data);
      if (pagWrap) this._renderPagination(pagWrap, data);
    } catch (err) {
      Components.toast('Refresh failed: ' + err.message, 'error');
    }
  },

  _renderTable(wrap, data) {
    wrap.innerHTML = '';
    const intents = data.intents || [];

    if (intents.length === 0) {
      wrap.appendChild(Components.emptyState('No routing rules match your filters. Rules map keywords to tools \u2014 add one to get started.', '+ Add Intent'));
      return;
    }

    const table = Components.table(
      [
        { label: 'Keyword', render: (i) => {
          const span = document.createElement('span');
          span.className = 'intents-keyword';
          span.textContent = i.keyword;
          return span;
        }},
        { label: 'Server', key: 'server_name', render: (i) => {
          const badge = Components.badge(i.server_name, 'accent');
          return badge;
        }},
        { label: 'Tool', render: (i) => {
          const span = document.createElement('span');
          span.className = 'intents-tool';
          span.textContent = i.tool_name || '—';
          return span;
        }},
        { label: 'Priority', width: '80px', render: (i) => {
          const span = document.createElement('span');
          span.className = 'secondary-text';
          span.textContent = String(i.priority);
          return span;
        }},
        { label: 'Type', width: '80px', render: (i) => {
          const span = document.createElement('span');
          span.className = 'secondary-text';
          span.textContent = i.execution_type || 'mcp';
          return span;
        }},
        { label: '', width: '90px', render: (i) => {
          const actions = document.createElement('div');
          actions.className = 'intents-row-actions';

          const editBtn = document.createElement('button');
          editBtn.className = 'btn btn-sm';
          editBtn.textContent = 'Edit';
          editBtn.classList.add('intents-row-btn');
          editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._showEditForm(i);
          });
          actions.appendChild(editBtn);

          const delBtn = document.createElement('button');
          delBtn.className = 'btn btn-sm';
          delBtn.textContent = '✕';
          delBtn.classList.add('intents-row-btn', 'status-error-text');
          delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (await Components.confirm(`Delete intent "${i.keyword}"?`)) {
              try {
                await API.del(`/api/intents/${encodeURIComponent(i.keyword)}`);
                Components.toast(`"${i.keyword}" deleted`, 'success');
                if (window.refreshSidebarCounts) window.refreshSidebarCounts();
                this._refresh();
              } catch (err) {
                Components.toast('Delete failed: ' + err.message, 'error');
              }
            }
          });
          actions.appendChild(delBtn);

          return actions;
        }},
      ],
      intents
    );
    wrap.appendChild(table);
  },

  _renderPagination(wrap, data) {
    wrap.innerHTML = '';
    if (data.total <= data.limit) return;

    const pag = Components.pagination(
      data.total,
      data.offset,
      data.limit,
      (newOffset) => {
        this.currentOffset = newOffset;
        this._refresh();
      }
    );
    wrap.appendChild(pag);
  },

  _buildTestPanel() {
    const panel = document.createElement('div');
    panel.className = 'intent-test-panel';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Test routing: type a natural language query...';
    panel.appendChild(input);

    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = 'Route';
    panel.appendChild(btn);

    const testBtn = document.createElement('button');
    testBtn.className = 'btn';
    testBtn.textContent = 'Intent Match';
    testBtn.title = 'Test keyword intent matching only';
    panel.appendChild(testBtn);

    const resultsWrap = document.createElement('div');
    resultsWrap.className = 'intent-test-results';
    resultsWrap.id = 'intent-test-results';

    const wrapper = document.createElement('div');
    wrapper.appendChild(panel);
    wrapper.appendChild(resultsWrap);

    // Full routing test (uses POST /api/route — BrainLoader dry-run)
    const doRoute = async () => {
      const query = input.value.trim();
      if (!query) return;
      resultsWrap.innerHTML = '';

      const startTime = Date.now();
      try {
        const data = await API.post('/api/route', { query });
        const elapsed = Date.now() - startTime;

        if (!data.matched) {
          resultsWrap.innerHTML = `<div class="intent-test-no-match">No route matched for "${this._escapeHtml(query)}". <span class="intents-test-meta">${elapsed}ms</span></div>`;
          return;
        }

        // Header showing match type
        const header = document.createElement('div');
        header.className = 'intents-test-header';
        header.innerHTML = `
          <span class="badge badge-success text-xs">MATCHED</span>
          <span class="intents-test-meta">${data.type || 'tools'} &middot; ${elapsed}ms</span>
        `;
        resultsWrap.appendChild(header);

        // Show matches
        const matches = data.matches || [];
        for (let i = 0; i < matches.length; i++) {
          const m = matches[i];
          const el = document.createElement('div');
          el.className = 'intent-test-match' + (i === 0 ? ' winner' : '');
          el.innerHTML = `
            <span class="keyword intents-test-server">${this._escapeHtml(m.server)}</span>
            <span class="arrow">\u2192</span>
            <span class="target fw-600">${this._escapeHtml(m.tool)}</span>
          `;
          if (i === 0) {
            const badge = document.createElement('span');
            badge.className = 'badge badge-success intents-badge-inline';
            badge.textContent = 'PRIMARY';
            el.appendChild(badge);
          }
          resultsWrap.appendChild(el);
        }
      } catch (err) {
        resultsWrap.innerHTML = '<div class="intent-test-no-match">Routing failed: ' + err.message + '</div>';
      }
    };

    // Keyword intent match test (original behavior)
    const doIntentTest = async () => {
      const query = input.value.trim();
      if (!query) return;
      resultsWrap.innerHTML = '';
      try {
        const data = await API.post('/api/intents/test', { query });
        if (!data.matches || data.matches.length === 0) {
          resultsWrap.innerHTML = '<div class="intent-test-no-match">No keyword matches. Try creating an intent for a keyword in your phrase.</div>';
          return;
        }
        for (let i = 0; i < data.matches.length; i++) {
          const m = data.matches[i];
          const el = document.createElement('div');
          el.className = 'intent-test-match' + (i === 0 ? ' winner' : '');
          el.innerHTML = `
            <span class="keyword">${this._escapeHtml(m.keyword)}</span>
            <span class="arrow">\u2192</span>
            <span class="target">${this._escapeHtml(m.server)}.${this._escapeHtml(m.tool || '*')}</span>
            <span class="priority">priority ${m.priority}</span>
          `;
          if (i === 0) {
            const badge = document.createElement('span');
            badge.className = 'badge badge-success intents-badge-inline';
            badge.textContent = 'WINNER';
            el.appendChild(badge);
          }
          resultsWrap.appendChild(el);
        }
      } catch (err) {
        resultsWrap.innerHTML = '<div class="intent-test-no-match">Test failed: ' + err.message + '</div>';
      }
    };

    btn.addEventListener('click', doRoute);
    testBtn.addEventListener('click', doIntentTest);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doRoute(); });

    return wrapper;
  },

  // Shared escaper — safe.js loads first, so VodouSafe is always present.
  // (Old local copy skipped quotes — attribute-breakout risk.)
  _escapeHtml(t) {
    if (!t) return '';
    return window.VodouSafe.escapeHtml(t);
  },

  _showAddForm() {
    this._showFormModal('Add Intent', {}, async (form) => {
      try {
        await API.post('/api/intents', form);
        Components.toast(`Intent "${form.keyword}" added`, 'success');
        if (window.refreshSidebarCounts) window.refreshSidebarCounts();
        this._refresh();
        return true;
      } catch (err) {
        Components.toast('Add failed: ' + err.message, 'error');
        return false;
      }
    });
  },

  _showEditForm(intent) {
    this._showFormModal('Edit Intent', intent, async (form) => {
      try {
        await API.put(`/api/intents/${encodeURIComponent(intent.keyword)}`, form);
        Components.toast(`Intent "${intent.keyword}" updated`, 'success');
        this._refresh();
        return true;
      } catch (err) {
        Components.toast('Update failed: ' + err.message, 'error');
        return false;
      }
    });
  },

  _showFormModal(title, defaults, onSubmit) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'intents-modal';

    const heading = document.createElement('h3');
    heading.className = 'intents-modal-title';
    heading.textContent = title;
    modal.appendChild(heading);

    const isEdit = !!defaults.keyword;

    const fields = [
      { name: 'keyword', label: 'Keyword', value: defaults.keyword || '', disabled: isEdit },
      { name: 'server_name', label: 'Server Name', value: defaults.server_name || '' },
      { name: 'tool_name', label: 'Tool Name', value: defaults.tool_name || '' },
      { name: 'priority', label: 'Priority', value: defaults.priority || 1, type: 'number' },
    ];

    const inputs = {};
    for (const f of fields) {
      const group = document.createElement('div');
      group.className = 'intents-form-group';

      const label = document.createElement('label');
      label.className = 'intents-form-label';
      label.textContent = f.label;
      group.appendChild(label);

      const input = document.createElement('input');
      input.type = f.type || 'text';
      input.value = f.value;
      input.disabled = !!f.disabled;
      input.className = 'intents-form-input';
      if (f.disabled) input.classList.add('opacity-50');
      group.appendChild(input);
      inputs[f.name] = input;

      modal.appendChild(group);
    }

    // Live preview
    const preview = document.createElement('div');
    preview.className = 'intent-live-preview';
    preview.textContent = 'When you say "[keyword]", Vodou will use [tool] from [server]';
    modal.appendChild(preview);

    function updatePreview() {
      const kw = inputs.keyword.value.trim() || '[keyword]';
      const srv = inputs.server_name.value.trim() || '[server]';
      const tool = inputs.tool_name.value.trim() || '[tool]';
      preview.textContent = `When you say "${kw}", Vodou will use ${tool} from ${srv}`;
    }
    for (const key of ['keyword', 'server_name', 'tool_name']) {
      inputs[key].addEventListener('input', updatePreview);
    }
    updatePreview();

    const btnRow = document.createElement('div');
    btnRow.className = 'intents-modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => overlay.remove());
    btnRow.appendChild(cancelBtn);

    const submitBtn = document.createElement('button');
    submitBtn.className = 'btn';
    submitBtn.classList.add('btn-primary');
    submitBtn.textContent = isEdit ? 'Save' : 'Add';
    submitBtn.addEventListener('click', async () => {
      const form = {
        keyword: inputs.keyword.value.trim(),
        server_name: inputs.server_name.value.trim(),
        tool_name: inputs.tool_name.value.trim() || null,
        priority: parseInt(inputs.priority.value) || 1,
      };
      if (!form.keyword || !form.server_name) {
        Components.toast('Keyword and server name are required', 'error');
        return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving...';
      const ok = await onSubmit(form);
      if (ok) overlay.remove();
      else { submitBtn.disabled = false; submitBtn.textContent = isEdit ? 'Save' : 'Add'; }
    });
    btnRow.appendChild(submitBtn);
    modal.appendChild(btnRow);

    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);

    // Focus first editable input
    const firstInput = isEdit ? inputs.server_name : inputs.keyword;
    setTimeout(() => firstInput.focus(), 50);
  },
};
