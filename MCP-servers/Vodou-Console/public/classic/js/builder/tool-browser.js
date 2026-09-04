/**
 * Tool Browser — command-palette style modal for browsing MCP servers and tools
 */
const ToolBrowser = {
  _overlay: null,
  _tools: null,
  _onSelect: null,

  async open(onSelect) {
    this._onSelect = onSelect;

    if (!this._tools) {
      try {
        // Use orchestration API for canonical tool list with schemas
        const data = await API.get('/api/tools');
        // Group tools by server (matching the old format)
        this._tools = {};
        for (const tool of (data.tools || [])) {
          if (!this._tools[tool.server]) {
            this._tools[tool.server] = { description: '', tools: [] };
          }
          this._tools[tool.server].tools.push({
            name: tool.name,
            description: tool.description || '',
            input_schema: tool.input_schema || null,
          });
        }
      } catch (e) {
        Components.toast('Failed to load tools: ' + e.message, 'error');
        return;
      }
    }

    this._overlay = document.createElement('div');
    this._overlay.className = 'builder-tool-browser-overlay';
    this._overlay.addEventListener('click', (e) => {
      if (e.target === this._overlay) this.close();
    });

    const modal = document.createElement('div');
    modal.className = 'builder-tool-browser';

    // Search
    const search = document.createElement('input');
    search.type = 'text';
    search.placeholder = 'Search tools...';
    search.className = 'builder-tool-browser-search';
    search.addEventListener('input', () => this._renderList(list, search.value.toLowerCase()));
    modal.appendChild(search);

    // List
    const list = document.createElement('div');
    list.className = 'builder-tool-browser-list';
    this._renderList(list, '');
    modal.appendChild(list);

    // Footer
    const footer = document.createElement('div');
    footer.className = 'builder-tool-browser-footer';
    const totalTools = Object.values(this._tools).reduce((sum, s) => sum + s.tools.length, 0);
    footer.textContent = `${totalTools} tools from ${Object.keys(this._tools).length} servers`;
    modal.appendChild(footer);

    this._overlay.appendChild(modal);
    document.body.appendChild(this._overlay);
    search.focus();

    // Escape to close
    const onKey = (e) => {
      if (e.key === 'Escape') { this.close(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);
  },

  close() {
    if (this._overlay) {
      this._overlay.remove();
      this._overlay = null;
    }
  },

  _renderList(container, query) {
    container.innerHTML = '';

    for (const [serverName, server] of Object.entries(this._tools)) {
      const matchingTools = server.tools.filter(t =>
        !query ||
        serverName.toLowerCase().includes(query) ||
        t.name.toLowerCase().includes(query) ||
        (t.description || '').toLowerCase().includes(query)
      );

      if (matchingTools.length === 0) continue;

      const serverHeader = document.createElement('div');
      serverHeader.className = 'builder-tool-browser-server';
      serverHeader.textContent = serverName;
      if (server.description) {
        const desc = document.createElement('span');
        desc.style.cssText = 'font-size:10px;color:var(--text-muted);margin-left:8px;';
        desc.textContent = server.description.substring(0, 60);
        serverHeader.appendChild(desc);
      }
      container.appendChild(serverHeader);

      for (const tool of matchingTools) {
        const item = document.createElement('div');
        item.className = 'builder-tool-browser-item';
        item.innerHTML = `<span class="builder-tool-browser-name">${BuilderNodes._esc(tool.name)}</span>` +
          (tool.description ? `<span class="builder-tool-browser-desc">${BuilderNodes._esc(tool.description.substring(0, 80))}</span>` : '');
        item.addEventListener('click', () => {
          if (this._onSelect) {
            this._onSelect(serverName, tool.name, tool.input_schema || null);
          }
          this.close();
        });
        container.appendChild(item);
      }
    }

    if (container.children.length === 0) {
      container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);">No matching tools</div>';
    }
  }
};
