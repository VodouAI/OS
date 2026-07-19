/**
 * Builder View — Visual Workflow Builder (n8n-style drag & drop skill builder)
 * Phase 1: Canvas, nodes, properties, serialization, validation
 * Phase 2: Template gallery, live JSON preview, undo/redo
 */
const BuilderView = {
  editor: null,
  skillName: null,
  metadata: { name: '', description: '', triggers: '', category: 'my-skills' },
  _previewVisible: false,
  _minimapVisible: false,
  _undoStack: [],
  _redoStack: [],
  _undoListenerAttached: false,
  _changeDebounce: null,
  _versionHistory: [],

  async render(container, skillName) {
    this.skillName = skillName || null;
    this._undoStack = [];
    this._redoStack = [];
    container.innerHTML = '';

    // Main 3-panel layout
    const wrapper = document.createElement('div');
    wrapper.className = 'builder-container';

    // Left palette
    const palette = this._buildPalette();
    wrapper.appendChild(palette);

    // Center: canvas + optional preview
    const centerCol = document.createElement('div');
    centerCol.className = 'builder-center-col';

    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'builder-canvas';
    canvasWrap.classList.add('flex-1');
    const canvasEl = document.createElement('div');
    canvasEl.id = 'builder-drawflow';
    canvasEl.className = 'builder-canvas-el';
    canvasWrap.appendChild(canvasEl);

    // Minimap (bottom-right corner of canvas)
    const minimap = document.createElement('div');
    minimap.id = 'builder-minimap';
    minimap.className = 'builder-minimap';
    minimap.classList.add('is-hidden');
    canvasWrap.classList.add('relative');
    canvasWrap.appendChild(minimap);

    centerCol.appendChild(canvasWrap);

    // Live JSON Preview panel (hidden by default)
    const previewPanel = document.createElement('div');
    previewPanel.id = 'builder-preview-panel';
    previewPanel.className = 'builder-preview-panel';
    previewPanel.classList.add('is-hidden');
    previewPanel.innerHTML = `
      <div class="builder-preview-header">
        <span class="builder-preview-label">actions.json preview</span>
        <span id="builder-preview-stats" class="builder-preview-label"></span>
      </div>
      <pre id="builder-preview-code" class="builder-preview-code"></pre>
    `;
    centerCol.appendChild(previewPanel);

    wrapper.appendChild(centerCol);

    // Right properties panel
    const propsPanel = document.createElement('div');
    propsPanel.className = 'builder-properties';
    wrapper.appendChild(propsPanel);

    container.appendChild(wrapper);

    // Bottom toolbar
    const toolbar = this._buildToolbar();
    container.appendChild(toolbar);

    // Initialize Drawflow (lazy-loaded on first builder mount)
    this.editor = await BuilderCanvas.init(canvasEl);
    BuilderCanvas.initPaletteDrag(palette);
    BuilderCanvas.initKeyboard();
    BuilderProperties.init(propsPanel);

    // Set up undo/redo tracking
    this._setupUndoRedo();

    // Load existing skill if name provided, otherwise show template gallery
    if (this.skillName) {
      await this._loadSkill(this.skillName);
    } else {
      this._showTemplateGallery(canvasWrap);
    }
  },

  destroy() {
    BuilderCanvas.destroy();
    this.editor = null;
    this.skillName = null;
    this._undoStack = [];
    this._redoStack = [];
  },

  // ── Template Gallery ─────────────────────────────────────────

  _showTemplateGallery(canvasWrap) {
    const gallery = document.createElement('div');
    gallery.id = 'builder-template-gallery';
    gallery.className = 'builder-template-gallery';

    gallery.innerHTML = `
      <div class="template-gallery-header">
        <h3 class="builder-gallery-title">Start Building</h3>
        <p class="builder-gallery-desc">Pick a template or start from scratch. Drag nodes from the left palette to customize.</p>
      </div>
      <div class="template-gallery-grid" id="template-gallery-grid"></div>
    `;

    const grid = gallery.querySelector('#template-gallery-grid');

    const templates = [
      {
        name: 'Blank Canvas',
        icon: '\u2795',
        desc: 'Start from scratch',
        color: 'var(--text-muted)',
        actions: null
      },
      {
        name: 'Simple Menu',
        icon: '\u{1F4CB}',
        desc: '1 stopping point, 3 options with tool calls',
        color: '#0d9488',
        actions: {
          stopping_points: [{
            id: 1, title: 'What would you like to do?',
            options: {
              '1': { label: 'Option A', steps: [{ server: '', tool: '', args: {} }] },
              '2': { label: 'Option B', steps: [{ server: '', tool: '', args: {} }] },
              '3': { label: 'Option C', steps: [{ server: '', tool: '', args: {} }] }
            }
          }]
        }
      },
      {
        name: 'Deep Thinking',
        icon: '\u{1F9E0}',
        desc: 'Start a thinking session, add thoughts in a loop',
        color: '#20c997',
        actions: {
          initial_steps: [
            { server: 'Vodou-Enhanced-Thinking', tool: 'start_thinking_session', args: { topic: '{{TOPIC}}', depth: 5 }, capture: { SESSION_ID: 'session_id' } }
          ],
          stopping_points: [{
            id: 1, title: 'Thinking session started. How deep should I go?',
            options: {
              '1': { label: 'Quick analysis (3 thoughts)', vars: { DEPTH: '3' }, steps: [
                { server: 'Vodou-Enhanced-Thinking', tool: 'add_thought', args: { session_id: '{{SESSION_ID}}', thought: '{{LLM:Analyze {{TOPIC}} from a new angle}}' }, loop: 3, stream_progress: true }
              ]},
              '2': { label: 'Deep dive (5 thoughts)', vars: { DEPTH: '5' }, steps: [
                { server: 'Vodou-Enhanced-Thinking', tool: 'add_thought', args: { session_id: '{{SESSION_ID}}', thought: '{{LLM:Think deeply about {{TOPIC}}}}' }, loop: 5, stream_progress: true }
              ]}
            }
          }]
        }
      },
      {
        name: 'System Monitor',
        icon: '\u{1F4CA}',
        desc: 'Parallel CPU, memory, disk checks',
        color: '#23a559',
        actions: {
          stopping_points: [{
            id: 1, title: 'What system info do you need?',
            options: {
              '1': { label: 'Full system scan', steps: [
                { server: 'mcp-monitor', tool: 'get_cpu_info', args: {} },
                { server: 'mcp-monitor', tool: 'get_memory_info', args: {} },
                { server: 'mcp-monitor', tool: 'get_disk_info', args: {} }
              ]},
              '2': { label: 'CPU only', steps: [
                { server: 'mcp-monitor', tool: 'get_cpu_info', args: {} }
              ]},
              '3': { label: 'Memory only', steps: [
                { server: 'mcp-monitor', tool: 'get_memory_info', args: {} }
              ]}
            }
          }]
        }
      },
      {
        name: 'Multi-Phase Wizard',
        icon: '\u{1F9D9}',
        desc: '3 stopping points with text input and goto',
        color: '#e67700',
        actions: {
          stopping_points: [
            { id: 1, title: 'What topic should I explore?', type: 'text_input', capture_as: 'TOPIC', options: {} },
            { id: 2, title: 'Got it. What depth?',
              options: {
                '1': { label: 'Quick overview', vars: { DEPTH: '3' }, steps: [] },
                '2': { label: 'Detailed analysis', vars: { DEPTH: '7' }, steps: [] },
                '3': { label: 'Change topic', goto: 1, steps: [] }
              }
            },
            { id: 3, title: 'Done! What next?',
              options: {
                '1': { label: 'Start over', goto: 1, steps: [] },
                '2': { label: 'Finish', steps: [] }
              }
            }
          ]
        }
      },
      {
        name: 'Import Existing',
        icon: '\u{1F4E5}',
        desc: 'Load an existing skill into the builder',
        color: 'var(--accent)',
        actions: 'import'
      }
    ];

    for (const tmpl of templates) {
      const card = document.createElement('div');
      card.className = 'template-card';
      card.innerHTML = `
        <div class="template-card-icon" data-color="${tmpl.color}">${tmpl.icon}</div>
        <div class="template-card-name">${tmpl.name}</div>
        <div class="template-card-desc">${tmpl.desc}</div>
      `;
      const iconEl = card.querySelector('.template-card-icon');
      if (iconEl) iconEl.classList.add(this._ensureColorClass('fg', tmpl.color));
      card.addEventListener('click', () => {
        gallery.remove();
        if (tmpl.actions === 'import') {
          this._import();
        } else if (tmpl.actions) {
          // Deserialize template into canvas
          BuilderDeserializer.fromActions(BuilderCanvas.editor, tmpl.actions);
          this._updateValidation();
          this._pushUndo();
          Components.toast(`Loaded "${tmpl.name}" template`, 'success');
        }
        // Blank canvas — just remove gallery, canvas is already empty
      });
      grid.appendChild(card);
    }

    // Overlay on top of the canvas
    canvasWrap.classList.add('relative');
    gallery.classList.add('builder-template-gallery-overlay');
    canvasWrap.appendChild(gallery);
  },

  _ensureColorClass(mode, color) {
    const safe = String(color).replace(/[^a-zA-Z0-9_-]/g, '_');
    const cls = `builder-color-${mode}-${safe}`;
    if (!document.getElementById(`builder-color-style-${mode}-${safe}`)) {
      const styleEl = document.createElement('style');
      styleEl.id = `builder-color-style-${mode}-${safe}`;
      styleEl.textContent = mode === 'bg'
        ? `.${cls}{background:${color};}`
        : `.${cls}{color:${color};}`;
      document.head.appendChild(styleEl);
    }
    return cls;
  },

  _ensureMinimapNodeClass(x, y, w, h, color) {
    const sig = `${x.toFixed(2)}_${y.toFixed(2)}_${w.toFixed(2)}_${h.toFixed(2)}_${String(color).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const safe = sig.replace(/[^a-zA-Z0-9_-]/g, '_');
    const cls = `builder-minimap-node-${safe}`;
    if (!document.getElementById(`builder-minimap-style-${safe}`)) {
      const styleEl = document.createElement('style');
      styleEl.id = `builder-minimap-style-${safe}`;
      styleEl.textContent = `.${cls}{left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:${color};}`;
      document.head.appendChild(styleEl);
    }
    return cls;
  },

  // ── Live JSON Preview ────────────────────────────────────────

  _togglePreview() {
    this._previewVisible = !this._previewVisible;
    const panel = document.getElementById('builder-preview-panel');
    if (panel) {
      panel.classList.toggle('is-hidden', !this._previewVisible);
      if (this._previewVisible) this._refreshPreview();
    }
  },

  _refreshPreview() {
    if (!this._previewVisible || !BuilderCanvas.editor) return;
    const codeEl = document.getElementById('builder-preview-code');
    const statsEl = document.getElementById('builder-preview-stats');
    if (!codeEl) return;

    try {
      const { actions } = BuilderSerializer.serialize(BuilderCanvas.editor, this.metadata);
      const json = JSON.stringify(actions, null, 2);
      codeEl.textContent = json;

      // Stats
      const spCount = (actions.stopping_points || []).length;
      const toolCount = (actions.stopping_points || []).reduce((sum, sp) => {
        return sum + Object.values(sp.options || {}).reduce((s2, opt) => s2 + (opt.steps || []).length, 0);
      }, 0) + (actions.initial_steps || []).length;
      const varCount = (actions.stopping_points || []).reduce((sum, sp) => {
        return sum + Object.values(sp.options || {}).reduce((s2, opt) => s2 + Object.keys(opt.vars || {}).length, 0);
      }, 0);

      if (statsEl) statsEl.textContent = `${spCount} SPs \u00B7 ${toolCount} tools \u00B7 ${varCount} vars`;
    } catch (e) {
      codeEl.textContent = '// Error generating preview: ' + e.message;
    }
  },

  // ── Undo / Redo ──────────────────────────────────────────────

  _setupUndoRedo() {
    if (!this._undoListenerAttached) {
      document.addEventListener('keydown', (e) => {
        // Only handle when builder is active
        if (!BuilderCanvas.editor) return;
        if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
          e.preventDefault();
          this._undo();
        } else if ((e.metaKey || e.ctrlKey) && e.key === 'z' && e.shiftKey) {
          e.preventDefault();
          this._redo();
        }
      });
      this._undoListenerAttached = true;
    }

    // Track changes for undo
    const trackChange = () => {
      clearTimeout(this._changeDebounce);
      this._changeDebounce = setTimeout(() => {
        this._pushUndo();
        this._refreshPreview();
        this._updateValidation();
        this._refreshMinimap();
      }, 500);
    };

    if (BuilderCanvas.editor) {
      BuilderCanvas.editor.on('nodeCreated', trackChange);
      BuilderCanvas.editor.on('nodeRemoved', trackChange);
      BuilderCanvas.editor.on('nodeMoved', trackChange);
      BuilderCanvas.editor.on('connectionCreated', trackChange);
      BuilderCanvas.editor.on('connectionRemoved', trackChange);
    }
  },

  _pushUndo() {
    if (!BuilderCanvas.editor) return;
    const state = JSON.stringify(BuilderCanvas.editor.export());
    // Don't push if identical to top of stack
    if (this._undoStack.length > 0 && this._undoStack[this._undoStack.length - 1] === state) return;
    this._undoStack.push(state);
    if (this._undoStack.length > 50) this._undoStack.shift();
    this._redoStack = [];
  },

  _undo() {
    if (this._undoStack.length <= 1) {
      Components.toast('Nothing to undo', 'info');
      return;
    }
    // Current state goes to redo
    this._redoStack.push(this._undoStack.pop());
    // Restore previous state
    const prev = this._undoStack[this._undoStack.length - 1];
    BuilderCanvas.editor.import(JSON.parse(prev));
    this._refreshPreview();
    this._updateValidation();
  },

  _redo() {
    if (this._redoStack.length === 0) {
      Components.toast('Nothing to redo', 'info');
      return;
    }
    const next = this._redoStack.pop();
    this._undoStack.push(next);
    BuilderCanvas.editor.import(JSON.parse(next));
    this._refreshPreview();
    this._updateValidation();
  },

  // ── Palette ──────────────────────────────────────────────────

  _buildPalette() {
    const palette = document.createElement('div');
    palette.className = 'builder-palette';

    // Search filter
    const search = document.createElement('input');
    search.type = 'text';
    search.placeholder = 'Filter nodes...';
    search.className = 'builder-palette-search';
    search.addEventListener('input', () => {
      const q = search.value.toLowerCase();
      palette.querySelectorAll('.builder-palette-item').forEach(item => {
        const match = item.textContent.toLowerCase().includes(q) || !q;
        item.classList.toggle('is-hidden', !match);
      });
    });
    palette.appendChild(search);

    // Node types by category
    const cats = BuilderNodes.getCategories();
    for (const [catName, items] of Object.entries(cats)) {
      const catLabel = document.createElement('div');
      catLabel.className = 'builder-palette-category';
      catLabel.textContent = catName;
      palette.appendChild(catLabel);

      for (const item of items) {
        const el = document.createElement('div');
        el.className = 'builder-palette-item';
        el.dataset.type = item.key;
        el.dataset.category = catName;
        el.innerHTML = `<span class="builder-palette-dot" data-color="${item.color}"></span><span>${item.label}</span>`;
        const dotEl = el.querySelector('.builder-palette-dot');
        if (dotEl) dotEl.classList.add(this._ensureColorClass('bg', item.color));
        el.setAttribute('draggable', 'true');
        el.title = 'Click to add to canvas, or drag onto the canvas';
        el.classList.add('cursor-pointer');
        el.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('builder-node-type', item.key);
        });
        const addPaletteNodeToCanvas = () => {
          const gallery = document.getElementById('builder-template-gallery');
          if (gallery) gallery.remove();
          const canvasEl = document.getElementById('builder-drawflow');
          if (!canvasEl || !BuilderCanvas.editor) return;
          const rect = canvasEl.getBoundingClientRect();
          if (!this._paletteClickStagger) this._paletteClickStagger = 0;
          this._paletteClickStagger = (this._paletteClickStagger + 1) % 16;
          const ox = (this._paletteClickStagger % 4) * 32;
          const oy = Math.floor(this._paletteClickStagger / 4) * 28;
          BuilderCanvas.addNode(item.key, rect.width / 2 - 80 + ox, rect.height / 2 - 40 + oy);
        };
        el.addEventListener('click', (e) => {
          if (e.detail !== 1) return;
          addPaletteNodeToCanvas();
        });
        palette.appendChild(el);
      }
    }

    // Divider
    const divider = document.createElement('div');
    divider.className = 'builder-palette-divider';
    palette.appendChild(divider);

    // Skill metadata
    const metaSection = document.createElement('div');
    metaSection.className = 'builder-palette-meta';

    const metaTitle = document.createElement('div');
    metaTitle.className = 'builder-palette-category';
    metaTitle.textContent = 'Skill Metadata';
    metaSection.appendChild(metaTitle);

    const fields = [
      { key: 'name', label: 'Name', placeholder: 'my-skill-name' },
      { key: 'description', label: 'Description', placeholder: 'What does it do?' },
      { key: 'triggers', label: 'Triggers', placeholder: 'trigger phrase, another phrase' },
    ];

    for (const f of fields) {
      const group = document.createElement('div');
      group.className = 'builder-meta-group';
      const label = document.createElement('label');
      label.className = 'builder-meta-label';
      label.textContent = f.label;
      group.appendChild(label);
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = f.placeholder;
      input.value = this.metadata[f.key] || '';
      input.className = 'builder-palette-input';
      input.addEventListener('change', () => { this.metadata[f.key] = input.value; });
      group.appendChild(input);
      metaSection.appendChild(group);
    }

    // Category select
    const catGroup = document.createElement('div');
    catGroup.className = 'builder-meta-group';
    const catLbl = document.createElement('label');
    catLbl.className = 'builder-meta-label';
    catLbl.textContent = 'Category';
    catGroup.appendChild(catLbl);
    const catSelect = document.createElement('select');
    catSelect.className = 'builder-palette-input';
    ['my-skills', 'vodou-core', 'oi-core', 'community'].forEach(c => {
      const o = document.createElement('option');
      o.value = c; o.textContent = c;
      if (c === this.metadata.category) o.selected = true;
      catSelect.appendChild(o);
    });
    catSelect.addEventListener('change', () => { this.metadata.category = catSelect.value; });
    catGroup.appendChild(catSelect);
    metaSection.appendChild(catGroup);

    palette.appendChild(metaSection);
    return palette;
  },

  // ── Toolbar ──────────────────────────────────────────────────

  _buildToolbar() {
    const toolbar = document.createElement('div');
    toolbar.className = 'builder-toolbar';

    // Save
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn';
    saveBtn.classList.add('btn-primary');
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => this._save());
    toolbar.appendChild(saveBtn);

    // Export JSON
    const exportBtn = document.createElement('button');
    exportBtn.className = 'btn';
    exportBtn.textContent = 'Export JSON';
    exportBtn.addEventListener('click', () => this._export());
    toolbar.appendChild(exportBtn);

    // Import
    const importBtn = document.createElement('button');
    importBtn.className = 'btn';
    importBtn.textContent = 'Import';
    importBtn.addEventListener('click', () => this._import());
    toolbar.appendChild(importBtn);

    // Test
    const testBtn = document.createElement('button');
    testBtn.className = 'btn';
    testBtn.textContent = '\u25B6 Test';
    testBtn.addEventListener('click', () => this._test());
    toolbar.appendChild(testBtn);

    // Preview toggle
    const previewBtn = document.createElement('button');
    previewBtn.className = 'btn';
    previewBtn.textContent = '{ } Preview';
    previewBtn.title = 'Toggle live actions.json preview';
    previewBtn.addEventListener('click', () => this._togglePreview());
    toolbar.appendChild(previewBtn);

    // Minimap toggle
    const minimapBtn = document.createElement('button');
    minimapBtn.className = 'btn';
    minimapBtn.textContent = '\u{1F5FA} Map';
    minimapBtn.title = 'Toggle minimap';
    minimapBtn.addEventListener('click', () => this._toggleMinimap());
    toolbar.appendChild(minimapBtn);

    // Version history
    const historyBtn = document.createElement('button');
    historyBtn.className = 'btn';
    historyBtn.textContent = '\u{1F4CB} History';
    historyBtn.title = 'Version history';
    historyBtn.addEventListener('click', () => this._showVersionHistory());
    toolbar.appendChild(historyBtn);

    // AI Assist
    const aiBtn = document.createElement('button');
    aiBtn.className = 'btn';
    aiBtn.classList.add('builder-ai-btn');
    aiBtn.textContent = '\u2728 AI Assist';
    aiBtn.title = 'Describe what you want and AI will add nodes';
    aiBtn.addEventListener('click', () => this._showAIAssist());
    toolbar.appendChild(aiBtn);

    // Undo/Redo
    const undoBtn = document.createElement('button');
    undoBtn.className = 'btn btn-sm';
    undoBtn.textContent = '\u21A9';
    undoBtn.title = 'Undo (Cmd+Z)';
    undoBtn.classList.add('builder-undo-redo-btn');
    undoBtn.addEventListener('click', () => this._undo());
    toolbar.appendChild(undoBtn);

    const redoBtn = document.createElement('button');
    redoBtn.className = 'btn btn-sm';
    redoBtn.textContent = '\u21AA';
    redoBtn.title = 'Redo (Cmd+Shift+Z)';
    redoBtn.classList.add('builder-undo-redo-btn');
    redoBtn.addEventListener('click', () => this._redo());
    toolbar.appendChild(redoBtn);

    // Spacer
    const spacer = document.createElement('div');
    spacer.className = 'flex-1';
    toolbar.appendChild(spacer);

    // Validation badge
    const badge = document.createElement('span');
    badge.id = 'builder-validation-badge';
    badge.className = 'builder-toolbar-meta';
    badge.textContent = 'No nodes';
    toolbar.appendChild(badge);

    // Summary
    const summary = document.createElement('span');
    summary.id = 'builder-summary';
    summary.className = 'builder-toolbar-meta builder-toolbar-summary';
    toolbar.appendChild(summary);

    return toolbar;
  },

  // ── Existing methods (unchanged) ─────────────────────────────

  async _loadSkill(name) {
    try {
      const skill = await API.get(`/api/skills/${encodeURIComponent(name)}`);
      if (skill) {
        this.metadata.name = skill.name || name;
        this.metadata.description = skill.description || '';
        this.metadata.category = skill.directory_path?.split('/')[0] || 'my-skills';
        document.querySelectorAll('.builder-palette-input').forEach(inp => {
          if (inp.previousElementSibling?.textContent === 'Name') inp.value = this.metadata.name;
          if (inp.previousElementSibling?.textContent === 'Description') inp.value = this.metadata.description;
        });
      }

      const result = await BuilderDeserializer.load(BuilderCanvas.editor, name);
      if (result.success) {
        Components.toast(`Loaded ${name} (from ${result.source})`, 'success');
        this._updateValidation();
        this._pushUndo();
      } else {
        Components.toast('Failed to load: ' + result.error, 'error');
      }
    } catch (e) {
      Components.toast('Error loading skill: ' + e.message, 'error');
    }
  },

  async _save() {
    const name = this.metadata.name?.trim();
    if (!name) {
      Components.toast('Skill name is required', 'error');
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      Components.toast('Name: letters, numbers, hyphens, underscores only', 'error');
      return;
    }

    const errors = BuilderValidator.validate(BuilderCanvas.editor);
    BuilderValidator.highlightErrors(errors);
    if (errors.length > 0) {
      Components.toast(`${errors.length} validation error${errors.length > 1 ? 's' : ''} \u2014 fix before saving`, 'error');
      return;
    }

    const { actions, skillMd, layout } = BuilderSerializer.serialize(BuilderCanvas.editor, this.metadata);

    try {
      if (!this.skillName) {
        await API.post('/api/skills', {
          name,
          description: this.metadata.description,
          category: this.metadata.category
        });
        this.skillName = name;
      }

      await API.put(`/api/skills/${encodeURIComponent(this.skillName)}/actions`, {
        actions,
        layout,
        skillMd
      });

      Components.toast(`Saved ${this.skillName}`, 'success');
      if (location.hash !== `#/builder/${this.skillName}`) {
        history.replaceState(null, '', `#/builder/${this.skillName}`);
      }
    } catch (e) {
      Components.toast('Save failed: ' + e.message, 'error');
    }
  },

  _export() {
    const { actions } = BuilderSerializer.serialize(BuilderCanvas.editor, this.metadata);
    const json = JSON.stringify(actions, null, 2);

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const modal = document.createElement('div');
    modal.className = 'builder-modal builder-modal-lg';

    const header = document.createElement('div');
    header.className = 'builder-modal-header';
    header.innerHTML = '<span class="builder-modal-title">actions.json</span>';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn-sm';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(json);
      Components.toast('Copied to clipboard', 'success');
    });
    header.appendChild(copyBtn);
    modal.appendChild(header);

    const pre = document.createElement('pre');
    pre.className = 'builder-export-pre';
    pre.textContent = json;
    modal.appendChild(pre);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  },

  _import() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const modal = document.createElement('div');
    modal.className = 'builder-modal builder-modal-sm';
    modal.innerHTML = '<div class="builder-modal-title mb-3">Import from existing skill</div>';

    const select = document.createElement('select');
    select.className = 'builder-palette-input';
    select.classList.add('builder-import-select');
    select.innerHTML = '<option value="">Loading skills...</option>';

    API.get('/api/skills').then(skills => {
      select.innerHTML = '<option value="">Select a skill...</option>';
      for (const s of skills) {
        const o = document.createElement('option');
        o.value = s.name;
        o.textContent = `${s.name} \u2014 ${(s.description || '').substring(0, 40)}`;
        select.appendChild(o);
      }
    });
    modal.appendChild(select);

    const loadBtn = document.createElement('button');
    loadBtn.className = 'btn';
    loadBtn.classList.add('btn-primary');
    loadBtn.textContent = 'Load';
    loadBtn.addEventListener('click', async () => {
      if (select.value) {
        overlay.remove();
        // Remove template gallery if visible
        const gallery = document.getElementById('builder-template-gallery');
        if (gallery) gallery.remove();
        await this._loadSkill(select.value);
      }
    });
    modal.appendChild(loadBtn);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  },

  _test() {
    if (typeof SkillRunner === 'undefined') {
      Components.toast('SkillRunner not available', 'error');
      return;
    }
    const name = this.metadata.name || 'builder-test';
    const { skillMd } = BuilderSerializer.serialize(BuilderCanvas.editor, this.metadata);
    SkillRunner.open(name, skillMd);
  },

  // ── Minimap ───────────────────────────────────────────────

  _toggleMinimap() {
    this._minimapVisible = !this._minimapVisible;
    const minimap = document.getElementById('builder-minimap');
    if (minimap) {
      minimap.classList.toggle('is-hidden', !this._minimapVisible);
      if (this._minimapVisible) this._refreshMinimap();
    }
  },

  _refreshMinimap() {
    if (!this._minimapVisible || !BuilderCanvas.editor) return;
    const minimap = document.getElementById('builder-minimap');
    if (!minimap) return;

    const exported = BuilderCanvas.editor.export();
    const nodes = Object.values(exported.drawflow.Home.data);
    if (nodes.length === 0) {
      minimap.innerHTML = '<div class="builder-minimap-empty">Empty canvas</div>';
      return;
    }

    // Calculate bounds
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.pos_x);
      minY = Math.min(minY, n.pos_y);
      maxX = Math.max(maxX, n.pos_x + 160);
      maxY = Math.max(maxY, n.pos_y + 60);
    }

    const padding = 20;
    const width = maxX - minX + padding * 2;
    const height = maxY - minY + padding * 2;
    const mapW = 180;
    const mapH = 120;
    const scaleX = mapW / width;
    const scaleY = mapH / height;
    const scale = Math.min(scaleX, scaleY);

    const colors = {
      sp: '#0d9488', option: '#5b9bd5', tool: '#23a559', var: '#faa61a',
      textinput: '#e67700', llm: '#20c997', condition: '#f23f43', script: '#9b59b6',
      subworkflow: '#3498db', schedule: '#e74c3c'
    };

    let html = '';
    for (const n of nodes) {
      const x = (n.pos_x - minX + padding) * scale;
      const y = (n.pos_y - minY + padding) * scale;
      const w = 160 * scale;
      const h = 40 * scale;
      const color = colors[n.name] || '#888';
      html += `<div class="builder-minimap-node ${this._ensureMinimapNodeClass(x, y, w, h, color)}"></div>`;
    }
    minimap.innerHTML = html;
  },

  // ── Version History ──────────────────────────────────────

  _showVersionHistory() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const modal = document.createElement('div');
    modal.className = 'builder-modal builder-modal-md builder-modal-scroll-col';

    const header = document.createElement('div');
    header.className = 'builder-modal-header mb-4';
    header.innerHTML = '<span class="builder-modal-title-lg">Version History</span>';

    // Save current as snapshot
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-sm';
    saveBtn.classList.add('btn-primary');
    saveBtn.textContent = '+ Save Snapshot';
    saveBtn.addEventListener('click', () => {
      if (!BuilderCanvas.editor) return;
      const state = BuilderCanvas.editor.export();
      const exported = BuilderSerializer.serialize(BuilderCanvas.editor, this.metadata);
      const spCount = (exported.actions.stopping_points || []).length;
      const toolCount = Object.values(exported.actions.stopping_points || []).reduce((s, sp) =>
        s + Object.values(sp.options || {}).reduce((s2, o) => s2 + (o.steps || []).length, 0), 0);

      this._versionHistory.push({
        timestamp: new Date().toISOString(),
        label: `${spCount} SPs, ${toolCount} tools`,
        state: JSON.stringify(state),
        name: this.metadata.name || 'untitled'
      });
      renderList();
      Components.toast('Snapshot saved', 'success');
    });
    header.appendChild(saveBtn);
    modal.appendChild(header);

    const list = document.createElement('div');
    list.className = 'builder-version-list';

    const renderList = () => {
      list.innerHTML = '';
      if (this._versionHistory.length === 0) {
        list.innerHTML = '<div class="builder-version-empty">No snapshots yet. Click "Save Snapshot" to capture the current state.</div>';
        return;
      }

      for (let i = this._versionHistory.length - 1; i >= 0; i--) {
        const v = this._versionHistory[i];
        const row = document.createElement('div');
        row.className = 'builder-version-row';

        const info = document.createElement('div');
        const time = new Date(v.timestamp);
        info.innerHTML = `
          <div class="builder-version-label">${v.label}</div>
          <div class="builder-version-meta">${time.toLocaleTimeString()} \u2014 ${v.name}</div>
        `;
        row.appendChild(info);

        const restoreBtn = document.createElement('button');
        restoreBtn.className = 'btn btn-sm';
        restoreBtn.textContent = 'Restore';
        restoreBtn.addEventListener('click', () => {
          BuilderCanvas.editor.import(JSON.parse(v.state));
          this._pushUndo();
          this._refreshPreview();
          this._updateValidation();
          this._refreshMinimap();
          Components.toast('Restored snapshot', 'success');
          overlay.remove();
        });
        row.appendChild(restoreBtn);
        list.appendChild(row);
      }
    };

    renderList();
    modal.appendChild(list);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn';
    closeBtn.textContent = 'Close';
    closeBtn.classList.add('mt-3');
    closeBtn.addEventListener('click', () => overlay.remove());
    modal.appendChild(closeBtn);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  },

  // ── AI Assist ────────────────────────────────────────────

  _showAIAssist() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const modal = document.createElement('div');
    modal.className = 'builder-modal builder-modal-ai';

    modal.innerHTML = `
      <div class="builder-ai-header">
        <span class="builder-ai-icon">\u2728</span>
        <div>
          <div class="builder-modal-title-lg">AI Assist</div>
          <div class="builder-ai-sub">Describe what you want and I'll add nodes to the canvas.</div>
        </div>
      </div>
    `;

    const input = document.createElement('textarea');
    input.className = 'builder-ai-input';
    input.placeholder = 'Examples:\n\u2022 "Add a deep thinking step with 5 loops"\n\u2022 "Add CPU and memory monitoring tools"\n\u2022 "Create a 3-option menu for deployment"\n\u2022 "Add a condition that checks if DEPTH > 3"';
    modal.appendChild(input);

    // Quick action buttons
    const quickActions = document.createElement('div');
    quickActions.className = 'builder-ai-quick-actions';

    const presets = [
      { label: 'Deep Thinking', desc: 'start_thinking_session + add_thought loop', nodes: [
        { type: 'tool', data: { server: 'Vodou-Enhanced-Thinking', tool: 'start_thinking_session', args: { topic: '{{TOPIC}}', depth: 5 }, capture: { SESSION_ID: 'session_id' } } },
        { type: 'tool', data: { server: 'Vodou-Enhanced-Thinking', tool: 'add_thought', args: { session_id: '{{SESSION_ID}}', thought: '{{LLM:Analyze {{TOPIC}} from a new angle}}' }, loop: 5, stream_progress: true } },
      ]},
      { label: 'System Monitor', desc: 'CPU + memory + disk', nodes: [
        { type: 'tool', data: { server: 'mcp-monitor', tool: 'get_cpu_info', args: {} } },
        { type: 'tool', data: { server: 'mcp-monitor', tool: 'get_memory_info', args: {} } },
        { type: 'tool', data: { server: 'mcp-monitor', tool: 'get_disk_info', args: {} } },
      ]},
      { label: 'Screenshot', desc: 'Capture current screen', nodes: [
        { type: 'tool', data: { server: 'vodou-mac-control', tool: 'screenshot', args: {} } },
      ]},
      { label: 'Condition Check', desc: 'If/else branch', nodes: [
        { type: 'condition', data: { variable: 'RESULT', operator: 'contains', value: 'error', label_true: 'Has Error', label_false: 'OK' } },
      ]},
      { label: 'Menu (3 options)', desc: 'Stopping point with 3 choices', nodes: [
        { type: 'sp', data: { title: 'What would you like to do?', type: 'menu' } },
        { type: 'option', data: { number: '1', label: 'Option A', vars: {} } },
        { type: 'option', data: { number: '2', label: 'Option B', vars: {} } },
        { type: 'option', data: { number: '3', label: 'Option C', vars: {} } },
      ]},
      { label: 'Schedule (hourly)', desc: 'Recurring trigger', nodes: [
        { type: 'schedule', data: { schedule_type: 'every', schedule: '1h', query: 'check system health' } },
      ]},
    ];

    for (const preset of presets) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm';
      btn.classList.add('builder-ai-quick-btn');
      btn.textContent = preset.label;
      btn.title = preset.desc;
      btn.addEventListener('click', () => {
        this._addNodesFromPreset(preset.nodes);
        overlay.remove();
        Components.toast(`Added ${preset.label}`, 'success');
      });
      quickActions.appendChild(btn);
    }
    modal.appendChild(quickActions);

    // Generate button (for custom descriptions)
    const btnRow = document.createElement('div');
    btnRow.className = 'builder-ai-btn-row';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => overlay.remove());
    btnRow.appendChild(cancelBtn);

    const genBtn = document.createElement('button');
    genBtn.className = 'btn';
    genBtn.classList.add('btn-primary');
    genBtn.textContent = 'Generate';
    genBtn.addEventListener('click', async () => {
      const description = input.value.trim();
      if (!description) { Components.toast('Describe what you want', 'error'); return; }

      genBtn.disabled = true;
      genBtn.textContent = 'Generating...';

      try {
        // Use the chat API to generate nodes via BrainLoader
        const res = await fetch('/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: `Generate a JSON array of builder nodes for this workflow description: "${description}". Each node should have: type (sp, option, tool, var, textinput, llm, condition, script, schedule, subworkflow) and data matching the node schema. Return ONLY the JSON array, no explanation.`,
            conversationId: 'builder-ai-assist-' + Date.now()
          })
        });
        const data = await res.json();
        const text = data.response || data.text || '';

        // Try to extract JSON array from response
        const jsonMatch = text.match(/\[[\s\S]*?\]/);
        if (jsonMatch) {
          const nodes = JSON.parse(jsonMatch[0]);
          if (Array.isArray(nodes) && nodes.length > 0) {
            this._addNodesFromPreset(nodes);
            Components.toast(`Added ${nodes.length} nodes from AI`, 'success');
            overlay.remove();
            return;
          }
        }
        Components.toast('AI could not generate nodes. Try a quick action button instead.', 'error');
      } catch (e) {
        Components.toast('Generation failed: ' + e.message, 'error');
      }
      genBtn.disabled = false;
      genBtn.textContent = 'Generate';
    });
    btnRow.appendChild(genBtn);
    modal.appendChild(btnRow);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    setTimeout(() => input.focus(), 50);
  },

  _addNodesFromPreset(nodeSpecs) {
    if (!BuilderCanvas.editor) return;

    // Remove template gallery if visible
    const gallery = document.getElementById('builder-template-gallery');
    if (gallery) gallery.remove();

    // Find a clear area on the canvas
    const exported = BuilderCanvas.editor.export();
    const existing = Object.values(exported.drawflow.Home.data);
    let startX = 200;
    let startY = 100;
    if (existing.length > 0) {
      const maxX = Math.max(...existing.map(n => n.pos_x));
      startX = maxX + 250;
    }

    let y = startY;
    let prevId = null;
    for (const spec of nodeSpecs) {
      const id = BuilderCanvas.addNode(spec.type, startX, y, spec.data);
      // Auto-connect sequential nodes
      if (prevId && spec.type !== 'option') {
        try { BuilderCanvas.editor.addConnection(prevId, id, 'output_1', 'input_1'); } catch {}
      }
      // Connect options to previous SP
      if (spec.type === 'option' && prevId) {
        const prevNode = BuilderCanvas.editor.getNodeFromId(prevId);
        if (prevNode && prevNode.name === 'sp') {
          const optNum = parseInt(spec.data?.number) || 1;
          try { BuilderCanvas.editor.addConnection(prevId, id, `output_${optNum}`, 'input_1'); } catch {}
        }
      }
      if (spec.type !== 'option') prevId = id;
      y += 100;
    }

    this._pushUndo();
    this._refreshPreview();
    this._updateValidation();
    this._refreshMinimap();
  },

  _updateValidation() {
    if (!BuilderCanvas.editor) return;
    const errors = BuilderValidator.validate(BuilderCanvas.editor);
    BuilderValidator.highlightErrors(errors);

    const badge = document.getElementById('builder-validation-badge');
    if (badge) {
      if (errors.length === 0) {
        badge.textContent = '\u2713 Valid';
        badge.classList.remove('status-error-text');
        badge.classList.add('status-ok-text');
      } else {
        badge.textContent = `${errors.length} error${errors.length > 1 ? 's' : ''}`;
        badge.classList.remove('status-ok-text');
        badge.classList.add('status-error-text');
      }
    }
    const summary = document.getElementById('builder-summary');
    if (summary) {
      summary.textContent = BuilderValidator.summary(BuilderCanvas.editor);
    }
  }
};
