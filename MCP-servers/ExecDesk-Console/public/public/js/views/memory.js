/**
 * Memory View — tabbed: Timeline | Mind Map (jsMind) | Atlas (D3)
 */

// jsMind (CSS + JS) is loaded only when the memory view mounts — keeps
// ~300 KB off every page that never renders the mind map.
async function ensureJsMind() {
  if (window.jsMind) return window.jsMind;
  await Promise.all([
    lazyStyle('https://cdn.jsdelivr.net/npm/jsmind/style/jsmind.css'),
    lazyScript('https://cdn.jsdelivr.net/npm/jsmind/js/jsmind.js'),
  ]);
  return window.jsMind;
}

const MemoryView = {
  jm: null,
  _searchTimer: null,
  _currentPath: null,
  _editing: false,
  _activeTab: 'timeline',
  _atlasDestroy: null,

  async render(container) {
    container.innerHTML = '';
    this.jm = null;
    this._currentPath = null;
    this._editing = false;
    if (typeof this._atlasDestroy === 'function') {
      try {
        this._atlasDestroy();
      } catch (e) {
        console.error('[memory] atlas destroy', e);
      }
    }
    this._atlasDestroy = null;

    // Page header with tabs
    const headerRow = document.createElement('div');
    headerRow.className = 'memory-header-row';

    const title = document.createElement('h2');
    title.className = 'page-title';
    title.textContent = 'Memory';
    title.appendChild(Components.helpTip("Vodou's brain \u2014 files where it stores what it learns about you, your projects, and past conversations."));
    headerRow.appendChild(title);

    const tabs = document.createElement('div');
    tabs.className = 'memory-tabs';

    const timelineTab = document.createElement('button');
    timelineTab.className = 'memory-tab active';
    timelineTab.textContent = 'Timeline';
    timelineTab.dataset.tab = 'timeline';

    const mapTab = document.createElement('button');
    mapTab.className = 'memory-tab';
    mapTab.textContent = 'Mind Map';
    mapTab.dataset.tab = 'mindmap';

    const atlasTab = document.createElement('button');
    atlasTab.className = 'memory-tab memory-tab-atlas';
    atlasTab.dataset.tab = 'atlas';
    atlasTab.innerHTML = '<span class="memory-tab-atlas-orb" aria-hidden="true">🔮</span> Atlas';

    tabs.appendChild(timelineTab);
    tabs.appendChild(mapTab);
    tabs.appendChild(atlasTab);
    headerRow.appendChild(tabs);
    container.appendChild(headerRow);

    // PLAN-MEMORY-VISIBILITY-UI Phase C — live search panel above tabs.
    // Available regardless of which tab is active. Wrapped in try/catch so any
    // failure here can't block the Timeline/MindMap render below.
    try {
      this._renderLiveSearchPanel(container);
    } catch (err) {
      console.error('[memory] live search panel render failed:', err);
    }

    // Tab content area
    const tabContent = document.createElement('div');
    tabContent.id = 'memory-tab-content';
    container.appendChild(tabContent);

    // Tab click handlers
    const self = this;
    function setAtlasChrome(on) {
      headerRow.classList.toggle('memory-header-row--atlas', on);
      tabs.classList.toggle('memory-tabs--atlas-active', on);
    }
    [mapTab, timelineTab, atlasTab].forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.querySelectorAll('.memory-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        self._activeTab = tab.dataset.tab;
        setAtlasChrome(tab.dataset.tab === 'atlas');
        if (tab.dataset.tab === 'mindmap') {
          if (typeof self._atlasDestroy === 'function') {
            try {
              self._atlasDestroy();
            } catch (e) {
              /* noop */
            }
            self._atlasDestroy = null;
          }
          self._renderMindMap(tabContent);
        } else if (tab.dataset.tab === 'atlas') {
          if (typeof self._atlasDestroy === 'function') {
            try {
              self._atlasDestroy();
            } catch (e) {
              /* noop */
            }
            self._atlasDestroy = null;
          }
          self._renderAtlas(tabContent);
          try {
            if (!sessionStorage.getItem('atlas_tab_icon_pulsed')) {
              atlasTab.querySelector('.memory-tab-atlas-orb')?.classList.add('memory-tab-atlas-orb--pulse');
              sessionStorage.setItem('atlas_tab_icon_pulsed', '1');
              setTimeout(() => {
                atlasTab.querySelector('.memory-tab-atlas-orb')?.classList.remove('memory-tab-atlas-orb--pulse');
              }, 900);
            }
          } catch (e) {
            /* private mode */
          }
        } else {
          if (typeof self._atlasDestroy === 'function') {
            try {
              self._atlasDestroy();
            } catch (e) {
              /* noop */
            }
            self._atlasDestroy = null;
          }
          self._renderTimeline(tabContent);
        }
      });
    });

    // Render default tab
    this._renderTimeline(tabContent);
  },

  // ===== PHASE C — Live search panel =====
  // Wired to /api/memory/search-chunks which hits the daemon's debug-enabled
  // ranking pipeline. Each result row uses MemoryRow for consistent rendering
  // with the chat "see why" modal.
  _liveSearchState: { q: '', scope: '', tags: new Set(), since: '' },
  _liveSearchTimer: null,
  // Monotonic counter so an earlier slow daemon response can't clobber a
  // later fast one. The fire ID is captured at request time and compared at
  // response time; mismatched IDs bail out before rendering.
  _liveSearchFireId: 0,

  _renderLiveSearchPanel(parent) {
    const panel = document.createElement('div');
    panel.id = 'memory-live-search-panel';
    panel.style.padding = '12px 16px';
    panel.style.borderBottom = '1px solid var(--border-subtle, rgba(255,255,255,0.08))';

    // Sparkline (tag distribution over last 7 days)
    const spark = document.createElement('div');
    spark.id = 'memory-tag-sparkline';
    spark.style.marginBottom = '12px';
    panel.appendChild(spark);
    setTimeout(() => this._renderTagSparkline(spark), 0);

    // Search input
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'memory-live-search-input';
    input.placeholder = 'Search memories — semantic + keyword (live ranked)...';
    input.id = 'memory-live-search-input';
    input.addEventListener('input', () => {
      this._liveSearchState.q = input.value;
      clearTimeout(this._liveSearchTimer);
      // 350ms debounce — long enough that mid-typing keystrokes don't fire
      // intermediate searches with partial queries; short enough to feel live.
      this._liveSearchTimer = setTimeout(() => this._fireLiveSearch(), 350);
    });
    panel.appendChild(input);

    // Filter chips: tag, scope, date range
    const chipsRow = document.createElement('div');
    chipsRow.className = 'memory-filter-chips';
    chipsRow.id = 'memory-filter-chips';
    panel.appendChild(chipsRow);
    setTimeout(() => this._renderFilterChips(chipsRow), 0);

    // Results panel
    const results = document.createElement('div');
    results.className = 'memory-live-results';
    results.id = 'memory-live-results';
    panel.appendChild(results);

    parent.appendChild(panel);
  },

  async _renderTagSparkline(container) {
    container.innerHTML = '';
    let data;
    try {
      data = await API.get('/api/memory/tag-distribution?days=7');
    } catch { return; }
    if (!data || !data.tags || !data.tags.length) return;
    const max = Math.max(...data.tags.map(t => t.count));
    const wrap = document.createElement('div');
    wrap.className = 'memory-sparkline';
    for (const t of data.tags) {
      const bar = document.createElement('div');
      bar.className = 'memory-sparkline-bar';
      bar.title = `${t.tag} · ${t.count} (${t.pct}%)`;
      const fill = document.createElement('div');
      fill.className = 'memory-sparkline-bar-fill';
      const h = max > 0 ? Math.round((t.count / max) * 50) : 0;
      fill.style.height = h + 'px';
      const label = document.createElement('div');
      label.className = 'memory-sparkline-bar-label';
      label.textContent = t.tag.length > 8 ? t.tag.slice(0, 7) + '…' : t.tag;
      bar.appendChild(fill);
      bar.appendChild(label);
      bar.addEventListener('click', () => {
        if (t.tag === 'UNTAGGED') return;
        const tags = this._liveSearchState.tags;
        if (tags.has(t.tag)) tags.delete(t.tag); else tags.add(t.tag);
        this._renderFilterChips(document.getElementById('memory-filter-chips'));
        this._fireLiveSearch();
      });
      wrap.appendChild(bar);
    }
    container.appendChild(wrap);
  },

  async _renderFilterChips(container) {
    if (!container) return;
    container.innerHTML = '';
    const allTags = ['DONE','PLANNED','ISSUE','PREF','DECISION','GOTCHA','DEAD_END','METRIC','PATTERN','DEPENDENCY','EXAMPLE','RESEARCH'];
    for (const tag of allTags) {
      const chip = document.createElement('span');
      chip.className = 'memory-chip' + (this._liveSearchState.tags.has(tag) ? ' memory-chip-active' : '');
      chip.textContent = tag;
      chip.addEventListener('click', () => {
        if (this._liveSearchState.tags.has(tag)) this._liveSearchState.tags.delete(tag);
        else this._liveSearchState.tags.add(tag);
        chip.classList.toggle('memory-chip-active');
        this._fireLiveSearch();
      });
      container.appendChild(chip);
    }
    // Date range
    const dateLabel = document.createElement('span');
    dateLabel.style.marginLeft = '12px';
    dateLabel.style.color = 'var(--content-muted)';
    dateLabel.style.fontSize = '11px';
    dateLabel.textContent = 'date:';
    container.appendChild(dateLabel);
    const presets = [['all',''],['today',new Date().toISOString().slice(0,10)],['7d', new Date(Date.now()-7*86400000).toISOString().slice(0,10)],['30d', new Date(Date.now()-30*86400000).toISOString().slice(0,10)]];
    for (const [name, since] of presets) {
      const chip = document.createElement('span');
      chip.className = 'memory-chip' + (this._liveSearchState.since === since ? ' memory-chip-active' : '');
      chip.textContent = name;
      chip.addEventListener('click', () => {
        this._liveSearchState.since = since;
        this._renderFilterChips(container);
        this._fireLiveSearch();
      });
      container.appendChild(chip);
    }
  },

  async _fireLiveSearch() {
    const out = document.getElementById('memory-live-results');
    if (!out) return;
    const q = this._liveSearchState.q.trim();
    if (!q) { out.innerHTML = ''; return; }
    // Race-condition guard: capture this fire's ID. If a later keystroke
    // fires while we're awaiting, it will increment the counter and our
    // response will be discarded.
    const myFire = ++this._liveSearchFireId;
    out.innerHTML = '<div class="memory-live-results-meta">searching…</div>';
    const params = new URLSearchParams();
    params.set('q', q);
    params.set('top_k', '20');
    if (this._liveSearchState.scope) params.set('scope', this._liveSearchState.scope);
    if (this._liveSearchState.tags.size > 0) params.set('tag', [...this._liveSearchState.tags].join(','));
    if (this._liveSearchState.since) params.set('since', this._liveSearchState.since);
    let data;
    try {
      data = await API.get('/api/memory/search-chunks?' + params.toString());
    } catch (err) {
      if (myFire !== this._liveSearchFireId) return;
      out.innerHTML = '<div class="memory-live-results-meta">search error: ' + (err.message || err) + '</div>';
      return;
    }
    // Stale response — a newer search has fired since this one started.
    if (myFire !== this._liveSearchFireId) return;
    out.innerHTML = '';
    const meta = document.createElement('div');
    meta.className = 'memory-live-results-meta';
    meta.textContent = `${(data.results || []).length} chunks · q="${q}"` + (this._liveSearchState.scope ? ` · scope=${this._liveSearchState.scope}` : '') + (this._liveSearchState.tags.size ? ` · tags=${[...this._liveSearchState.tags].join(',')}` : '');
    out.appendChild(meta);
    if (!(data.results || []).length) {
      const empty = document.createElement('div');
      empty.className = 'memory-search-empty';
      empty.textContent = 'No matches.';
      out.appendChild(empty);
      return;
    }
    for (const chunk of data.results) {
      out.appendChild(window.MemoryRow.render(chunk, { allowPin: true }));
    }
  },

  // ===== ATLAS TAB (D3) =====
  _renderAtlas(container) {
    container.innerHTML = '';
    if (typeof window.MemoryAtlas === 'undefined' || !window.MemoryAtlas.init) {
      container.innerHTML =
        '<div class="error-state">Atlas module not loaded. Ensure <code>memory-atlas.js</code> is included before <code>memory.js</code>.</div>';
      return;
    }
    this._atlasDestroy = window.MemoryAtlas.init(container, { API });
  },

  // ===== MIND MAP TAB =====
  async _renderMindMap(container) {
    container.innerHTML = '';

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'memory-toolbar';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.id = 'memory-search';
    searchInput.name = 'memory-search';
    searchInput.placeholder = 'Search memory files...';
    searchInput.className = 'memory-search-input';
    searchInput.addEventListener('input', () => {
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => this._search(searchInput.value), 300);
    });
    toolbar.appendChild(searchInput);

    // Phase B (PLAN-UNIFIED-SCOPED-CONVERSATIONS): scope filter dropdown.
    // Populated from /api/memory/scopes; default "All scopes" preserves existing behavior.
    const scopeSelect = document.createElement('select');
    scopeSelect.id = 'memory-scope-filter';
    scopeSelect.name = 'memory-scope-filter';
    scopeSelect.className = 'memory-scope-select';
    scopeSelect.title = 'Filter by conversation scope';
    scopeSelect.innerHTML = '<option value="">All scopes</option>';
    scopeSelect.addEventListener('change', () => {
      this._activeScope = scopeSelect.value || '';
      this._renderScopedChunks();
    });
    toolbar.appendChild(scopeSelect);
    this._scopeSelectEl = scopeSelect;
    // Lazy populate on next tick — DB query is cheap.
    setTimeout(() => this._populateScopeSelect(), 0);

    const btnGroup = document.createElement('div');
    btnGroup.className = 'flex gap-2';

    const zoomOutBtn = document.createElement('button');
    zoomOutBtn.className = 'btn btn-sm';
    zoomOutBtn.textContent = '\u2212';
    zoomOutBtn.title = 'Zoom out';
    zoomOutBtn.addEventListener('click', () => { if (this.jm) this.jm.view.zoomOut(); });
    btnGroup.appendChild(zoomOutBtn);

    const zoomResetBtn = document.createElement('button');
    zoomResetBtn.className = 'btn btn-sm';
    zoomResetBtn.textContent = '100%';
    zoomResetBtn.title = 'Reset zoom';
    zoomResetBtn.addEventListener('click', () => { if (this.jm) this.jm.view.setZoom(1); });
    btnGroup.appendChild(zoomResetBtn);

    const zoomInBtn = document.createElement('button');
    zoomInBtn.className = 'btn btn-sm';
    zoomInBtn.textContent = '+';
    zoomInBtn.title = 'Zoom in';
    zoomInBtn.addEventListener('click', () => { if (this.jm) this.jm.view.zoomIn(); });
    btnGroup.appendChild(zoomInBtn);

    const expandBtn = document.createElement('button');
    expandBtn.className = 'btn btn-sm';
    expandBtn.textContent = 'Expand All';
    expandBtn.addEventListener('click', () => { if (this.jm) this.jm.expand_all(); });
    btnGroup.appendChild(expandBtn);

    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'btn btn-sm';
    collapseBtn.textContent = 'Collapse';
    collapseBtn.addEventListener('click', () => { if (this.jm) this.jm.collapse_all(); });
    btnGroup.appendChild(collapseBtn);

    const fitBtn = document.createElement('button');
    fitBtn.className = 'btn btn-sm';
    fitBtn.textContent = 'Fit';
    fitBtn.addEventListener('click', () => {
      if (this.jm) {
        try { this.jm.view._center_root(); } catch(e) {}
      }
    });
    btnGroup.appendChild(fitBtn);

    toolbar.appendChild(btnGroup);
    container.appendChild(toolbar);

    // Split pane
    const splitPane = document.createElement('div');
    splitPane.className = 'memory-split';

    const mapPane = document.createElement('div');
    mapPane.className = 'memory-map-pane';
    mapPane.id = 'memory-jsmind-container';
    splitPane.appendChild(mapPane);

    const editorPane = document.createElement('div');
    editorPane.className = 'memory-editor-pane';
    editorPane.id = 'memory-editor-pane';
    editorPane.innerHTML = '<div class="memory-editor-placeholder">Click a file node to view its content</div>';
    splitPane.appendChild(editorPane);

    container.appendChild(splitPane);

    // Search results overlay
    const searchResults = document.createElement('div');
    searchResults.id = 'memory-search-results';
    searchResults.className = 'memory-search-results';
    searchResults.classList.remove('memory-search-results-visible');
    container.appendChild(searchResults);

    await this._loadTree();
  },

  async _loadTree() {
    try {
      // Lazy-load jsmind (CSS + JS) only when the memory view actually mounts.
      await ensureJsMind();
      const tree = await API.get('/api/memory/tree');
      const jsmindData = {
        meta: { name: 'Vodou Memory', author: 'Vodou', version: '1.0' },
        format: 'node_tree',
        data: tree,
      };

      const options = {
        container: 'memory-jsmind-container',
        editable: false,
        theme: document.documentElement.getAttribute('data-theme') === 'light' ? 'primary' : 'dark',
        view: {
          engine: 'canvas',
          hmargin: 120,
          vmargin: 50,
          line_width: 2,
          line_color: 'rgba(88, 101, 242, 0.4)',
          draggable: true,
        },
        layout: {
          hspace: 60,
          vspace: 20,
          pspace: 13,
        },
      };

      this.jm = new jsMind(options);
      this.jm.show(jsmindData);

      this.jm.add_event_listener((type, evtData) => {
        if (type === jsMind.event_type.select) {
          const nodeId = evtData.node;
          const node = this.jm.get_node(nodeId);
          if (node && node.data && node.data.file_path) {
            this._onNodeSelect(node);
          }
        }
      });
    } catch (err) {
      const mapEl = document.getElementById('memory-jsmind-container');
      if (mapEl) {
        mapEl.innerHTML = '<div class="error-state">Failed to load memory tree: ' + err.message + '</div>';
      }
    }
  },

  // ===== TIMELINE TAB =====
  async _renderTimeline(container) {
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'memory-timeline-wrapper';

    // Loading
    wrapper.appendChild(Components.loading());
    container.appendChild(wrapper);

    try {
      const data = await API.get('/api/memory/timeline');
      wrapper.innerHTML = '';

      if (data.days.length === 0) {
        wrapper.innerHTML = '<div class="empty-state">No daily memory logs found</div>';
        return;
      }

      // Workspace files summary bar
      if (data.workspaceFiles && data.workspaceFiles.length > 0) {
        const wsBar = document.createElement('div');
        wsBar.className = 'memory-tl-workspace-bar';
        const wsLabel = document.createElement('span');
        wsLabel.className = 'memory-tl-workspace-label';
        wsLabel.textContent = 'Workspace Files';
        wsBar.appendChild(wsLabel);
        const wsChips = document.createElement('div');
        wsChips.className = 'memory-tl-workspace-chips';
        for (const f of data.workspaceFiles) {
          const chip = document.createElement('span');
          chip.className = 'memory-tl-ws-chip';
          chip.textContent = f.name.replace(/\.md$/, '');
          chip.title = f.path;
          chip.addEventListener('click', () => this._showFileViewer(f.path, wrapper));
          wsChips.appendChild(chip);
        }
        wsBar.appendChild(wsChips);
        wrapper.appendChild(wsBar);
      }

      // Timeline
      const timeline = document.createElement('div');
      timeline.className = 'memory-timeline';

      for (const day of data.days) {
        const card = document.createElement('div');
        card.className = 'memory-tl-card';

        // Date header
        const dateRow = document.createElement('div');
        dateRow.className = 'memory-tl-date-row';

        const dot = document.createElement('div');
        dot.className = 'memory-tl-dot';
        dateRow.appendChild(dot);

        const dateLabel = document.createElement('div');
        dateLabel.className = 'memory-tl-date';
        const d = new Date(day.date + 'T12:00:00');
        const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
        const monthDay = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        dateLabel.textContent = dayName + ', ' + monthDay;
        dateRow.appendChild(dateLabel);

        const meta = document.createElement('div');
        meta.className = 'memory-tl-meta';
        meta.textContent = day.lineCount + ' lines \u00B7 ' + this._formatSize(day.size);
        dateRow.appendChild(meta);

        card.appendChild(dateRow);

        // Headings as section chips
        if (day.headings.length > 0) {
          const headingsRow = document.createElement('div');
          headingsRow.className = 'memory-tl-headings';
          for (const h of day.headings) {
            const chip = document.createElement('span');
            chip.className = 'badge badge-accent';
            chip.classList.add('memory-tl-chip');
            chip.textContent = h;
            headingsRow.appendChild(chip);
          }
          card.appendChild(headingsRow);
        }

        // Highlights (bullet points)
        if (day.highlights.length > 0) {
          const highlightsEl = document.createElement('div');
          highlightsEl.className = 'memory-tl-highlights';
          for (const hl of day.highlights) {
            const item = document.createElement('div');
            item.className = 'memory-tl-highlight';
            item.textContent = hl;
            highlightsEl.appendChild(item);
          }
          card.appendChild(highlightsEl);
        }

        // Click to view full file
        card.addEventListener('click', () => this._showFileViewer(day.path, wrapper));
        card.classList.add('memory-tl-card-clickable');

        timeline.appendChild(card);
      }

      wrapper.appendChild(timeline);
    } catch (err) {
      wrapper.innerHTML = '';
      wrapper.appendChild(Components.errorState('Failed to load timeline: ' + err.message));
    }
  },

  _formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  },

  async _showFileViewer(filePath, parentEl) {
    // Show file in a modal overlay
    const overlay = document.createElement('div');
    overlay.className = 'memory-file-overlay';

    const modal = document.createElement('div');
    modal.className = 'memory-file-modal';

    // Modal header
    const header = document.createElement('div');
    header.className = 'memory-editor-header';
    header.classList.add('memory-editor-header-modal');

    const titleSpan = document.createElement('span');
    titleSpan.className = 'memory-editor-title';
    titleSpan.textContent = filePath.split('/').pop().replace(/\.md$/, '');
    header.appendChild(titleSpan);

    const pathSpan = document.createElement('span');
    pathSpan.className = 'memory-editor-path';
    pathSpan.textContent = filePath;
    header.appendChild(pathSpan);

    const btnRow = document.createElement('div');
    btnRow.className = 'memory-editor-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-sm';
    editBtn.textContent = 'Edit';
    btnRow.appendChild(editBtn);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-sm';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => overlay.remove());
    btnRow.appendChild(closeBtn);

    header.appendChild(btnRow);
    modal.appendChild(header);

    // Content area
    const contentArea = document.createElement('div');
    contentArea.className = 'memory-editor-viewer memory-editor-viewer-modal';
    contentArea.innerHTML = '<div class="loading-container"><div class="loading-spinner"></div></div>';
    modal.appendChild(contentArea);

    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);

    try {
      const res = await fetch('/api/memory/file?path=' + encodeURIComponent(filePath));
      if (!res.ok) throw new Error(await res.text() || 'Failed to load');
      const content = await res.text();
      contentArea.innerHTML = this._renderMarkdown(content);

      // Edit button handler
      editBtn.addEventListener('click', () => {
        contentArea.innerHTML = '';
        const textarea = document.createElement('textarea');
        textarea.className = 'memory-editor-textarea';
        textarea.classList.add('memory-editor-textarea-modal');
        textarea.value = content;
        contentArea.appendChild(textarea);

        editBtn.textContent = 'Save';
        editBtn.replaceWith(editBtn.cloneNode(true));
        const newEditBtn = header.querySelector('.btn.btn-sm');
        newEditBtn.textContent = 'Save';
        newEditBtn.addEventListener('click', async () => {
          newEditBtn.disabled = true;
          newEditBtn.textContent = 'Saving...';
          try {
            await API.put('/api/memory/file?path=' + encodeURIComponent(filePath), { content: textarea.value });
            Components.toast('Saved', 'success');
            overlay.remove();
          } catch (e) {
            Components.toast('Save failed: ' + (e.message || e), 'error');
            newEditBtn.disabled = false;
            newEditBtn.textContent = 'Save';
          }
        });
        textarea.focus();
      });
    } catch (err) {
      contentArea.innerHTML = '<div class="error-state">Failed to load: ' + err.message + '</div>';
    }
  },

  // ===== SHARED: Node select / editor =====
  async _onNodeSelect(node) {
    const filePath = node.data.file_path;
    if (filePath === this._currentPath && !this._editing) return;
    this._currentPath = filePath;
    this._editing = false;

    const pane = document.getElementById('memory-editor-pane');
    if (!pane) return;

    pane.innerHTML = '<div class="loading-container"><div class="loading-spinner"></div></div>';

    try {
      const res = await fetch('/api/memory/file?path=' + encodeURIComponent(filePath));
      if (!res.ok) throw new Error(await res.text() || 'Failed to load');
      const content = await res.text();

      pane.innerHTML = '';

      const header = document.createElement('div');
      header.className = 'memory-editor-header';

      const title = document.createElement('span');
      title.className = 'memory-editor-title';
      title.textContent = filePath.split('/').pop().replace(/\.md$/, '');
      header.appendChild(title);

      const pathLabel = document.createElement('span');
      pathLabel.className = 'memory-editor-path';
      pathLabel.textContent = filePath;
      header.appendChild(pathLabel);

      const btnRow = document.createElement('div');
      btnRow.className = 'memory-editor-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-sm';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => this._enterEditMode(content, filePath, pane));
      btnRow.appendChild(editBtn);

      header.appendChild(btnRow);
      pane.appendChild(header);

      const viewer = document.createElement('div');
      viewer.className = 'memory-editor-viewer';
      viewer.innerHTML = this._renderMarkdown(content);

      if (node.data.file_line) {
        requestAnimationFrame(() => {
          const el = viewer.querySelector('[data-line="' + node.data.file_line + '"]');
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      }

      pane.appendChild(viewer);
    } catch (err) {
      pane.innerHTML = '<div class="error-state">Failed to load file: ' + err.message + '</div>';
    }
  },

  _renderMarkdown(content) {
    const lines = content.split('\n');
    let html = '';
    let inCode = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      if (line.startsWith('```')) {
        if (inCode) {
          html += '</code></pre>';
          inCode = false;
        } else {
          html += '<pre data-line="' + lineNum + '"><code>';
          inCode = true;
        }
        continue;
      }

      if (inCode) {
        html += this._escapeHtml(line) + '\n';
        continue;
      }

      if (line.match(/^#{1,3}\s/)) {
        const level = line.match(/^(#+)/)[1].length;
        const text = line.replace(/^#+\s+/, '');
        html += '<h' + (level + 1) + ' data-line="' + lineNum + '">' + this._escapeHtml(text) + '</h' + (level + 1) + '>';
      } else if (line.match(/^[-*]\s/)) {
        html += '<div class="md-list-item" data-line="' + lineNum + '">' + this._escapeHtml(line) + '</div>';
      } else if (line.trim() === '') {
        html += '<br>';
      } else {
        html += '<p data-line="' + lineNum + '">' + this._escapeHtml(line) + '</p>';
      }
    }

    if (inCode) html += '</code></pre>';
    return html;
  },

  _escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  _enterEditMode(content, filePath, pane) {
    this._editing = true;
    pane.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'memory-editor-header';

    const title = document.createElement('span');
    title.className = 'memory-editor-title';
    title.textContent = 'Editing: ' + filePath.split('/').pop().replace(/\.md$/, '');
    header.appendChild(title);

    const btnRow = document.createElement('div');
    btnRow.className = 'memory-editor-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-sm';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      this._editing = false;
      this._currentPath = null;
      if (this.jm) {
        const sel = this.jm.get_selected_node();
        if (sel) this._onNodeSelect(sel);
      }
    });
    btnRow.appendChild(cancelBtn);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-sm btn-primary';
    saveBtn.textContent = 'Save';
    btnRow.appendChild(saveBtn);

    header.appendChild(btnRow);
    pane.appendChild(header);

    const textarea = document.createElement('textarea');
    textarea.className = 'memory-editor-textarea';
    textarea.value = content;
    pane.appendChild(textarea);

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      try {
        await API.put('/api/memory/file?path=' + encodeURIComponent(filePath), { content: textarea.value });
        Components.toast('Saved', 'success');
        this._editing = false;
        this._currentPath = null;
        const mapEl = document.getElementById('memory-jsmind-container');
        if (mapEl) mapEl.innerHTML = '';
        await this._loadTree();
      } catch (e) {
        Components.toast('Save failed: ' + (e.message || e), 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
    });

    textarea.focus();
  },

  async _search(query) {
    const resultsEl = document.getElementById('memory-search-results');
    if (!resultsEl) return;

    if (!query || query.trim().length < 2) {
      resultsEl.classList.remove('memory-search-results-visible');
      this._clearHighlights();
      return;
    }

    try {
      const results = await API.get('/api/memory/search?q=' + encodeURIComponent(query));

      if (results.length === 0) {
        resultsEl.classList.add('memory-search-results-visible');
        resultsEl.innerHTML = '<div class="memory-search-empty">No matches found</div>';
        this._clearHighlights();
        return;
      }

      this._highlightNodes(results);

      resultsEl.classList.add('memory-search-results-visible');
      resultsEl.innerHTML = '<div class="memory-search-header">' + results.length + ' match' + (results.length > 1 ? 'es' : '') + '</div>';

      const list = document.createElement('div');
      for (const r of results.slice(0, 30)) {
        const item = document.createElement('div');
        item.className = 'memory-search-item';
        item.innerHTML =
          '<div class="memory-search-item-file">' + this._escapeHtml(r.file) + (r.heading ? ' &gt; ' + this._escapeHtml(r.heading) : '') + '</div>' +
          '<div class="memory-search-item-text">' + this._escapeHtml(r.text) + '</div>';
        item.addEventListener('click', () => {
          resultsEl.classList.remove('memory-search-results-visible');
          if (this.jm) {
            const prefix = r.type === 'daily' ? 'dl_' : 'ws_';
            const nodeId = prefix + r.file;
            const node = this.jm.get_node(nodeId);
            if (node) {
              this.jm.select_node(nodeId);
              this._onNodeSelect(node);
            }
          }
        });
        list.appendChild(item);
      }
      resultsEl.appendChild(list);
    } catch (err) {
      resultsEl.classList.add('memory-search-results-visible');
      resultsEl.innerHTML = '<div class="memory-search-empty">Search error: ' + err.message + '</div>';
    }
  },

  _highlightNodes(results) {
    this._clearHighlights();
    if (!this.jm) return;
    const matchedFiles = new Set(results.map(r => (r.type === 'daily' ? 'dl_' : 'ws_') + r.file));
    for (const nodeId of matchedFiles) {
      const el = document.querySelector('jmnode[nodeid="' + nodeId + '"]');
      if (el) el.classList.add('memory-node-match');
    }
  },

  _clearHighlights() {
    document.querySelectorAll('.memory-node-match').forEach(el => el.classList.remove('memory-node-match'));
  },

  // Phase B (PLAN-UNIFIED-SCOPED-CONVERSATIONS): scope filter helpers
  async _populateScopeSelect() {
    if (!this._scopeSelectEl) return;
    try {
      const rows = await API.get('/api/memory/scopes');
      if (!Array.isArray(rows)) return;
      const sel = this._scopeSelectEl;
      const current = sel.value;
      sel.innerHTML = '<option value="">All scopes</option>';
      for (const r of rows) {
        const opt = document.createElement('option');
        opt.value = r.scope;
        opt.textContent = r.scope + ' (' + r.count + ')';
        sel.appendChild(opt);
      }
      if (current) sel.value = current;
    } catch { /* ignore */ }
  },

  async _renderScopedChunks() {
    const resultsEl = document.getElementById('memory-search-results');
    if (!resultsEl) return;
    const scope = this._activeScope || '';
    if (!scope) {
      resultsEl.classList.remove('memory-search-results-visible');
      resultsEl.innerHTML = '';
      return;
    }
    try {
      const rows = await API.get('/api/memory/chunks?scope=' + encodeURIComponent(scope) + '&limit=30');
      resultsEl.classList.add('memory-search-results-visible');
      if (!rows.length) {
        resultsEl.innerHTML = '<div class="memory-search-empty">No memories yet for scope <code>' + this._escapeHtml(scope) + '</code></div>';
        return;
      }
      resultsEl.innerHTML = '<div class="memory-search-header">' + rows.length + ' memor' + (rows.length === 1 ? 'y' : 'ies') + ' in <code>' + this._escapeHtml(scope) + '</code></div>';
      const list = document.createElement('div');
      for (const r of rows) {
        const item = document.createElement('div');
        item.className = 'memory-search-item';
        const when = (r.created_at || '').slice(0, 10);
        item.innerHTML =
          '<div class="memory-search-item-file">' + this._escapeHtml(r.path || '') + (when ? ' · ' + when : '') + '</div>' +
          '<div class="memory-search-item-text">' + this._escapeHtml(String(r.text || '').slice(0, 240)) + '</div>';
        list.appendChild(item);
      }
      resultsEl.appendChild(list);
    } catch (err) {
      resultsEl.classList.add('memory-search-results-visible');
      resultsEl.innerHTML = '<div class="memory-search-empty">Scope load error: ' + this._escapeHtml(err.message || String(err)) + '</div>';
    }
  },
};
