/**
 * Builder Properties Panel — context-sensitive right panel for editing selected node.
 * Shows ALL available fields for each node type so the user knows what they can configure.
 */
const BuilderProperties = {
  container: null,
  currentNodeId: null,
  availableTools: null,
  _toolsLoading: false,

  init(containerEl) {
    this.container = containerEl;
    this._showEmpty();
    this._preloadTools();

    document.addEventListener('builder:nodeSelected', (e) => {
      this.currentNodeId = e.detail.nodeId;
      this._render();
    });
    document.addEventListener('builder:nodeDeselected', () => {
      this.currentNodeId = null;
      this._showEmpty();
    });
    document.addEventListener('builder:nodeRemoved', (e) => {
      if (this.currentNodeId === e.detail.nodeId) {
        this.currentNodeId = null;
        this._showEmpty();
      }
    });
  },

  async _preloadTools() {
    if (this.availableTools || this._toolsLoading) return;
    this._toolsLoading = true;
    try {
      // Use orchestration API — canonical tool list with schemas
      const data = await API.get('/api/tools');
      // Group by server to match old format
      this.availableTools = {};
      for (const tool of (data.tools || [])) {
        if (!this.availableTools[tool.server]) {
          this.availableTools[tool.server] = { description: '', tools: [] };
        }
        this.availableTools[tool.server].tools.push({
          name: tool.name,
          description: tool.description || '',
          input_schema: tool.input_schema || null,
        });
      }
    } catch (e) {
      console.error('Failed to preload tools:', e);
      this.availableTools = {};
    }
    this._toolsLoading = false;
  },

  _showEmpty() {
    this.container.innerHTML = `
      <div style="padding:32px 20px;text-align:center;color:var(--text-muted);">
        <div style="font-size:36px;margin-bottom:12px;opacity:0.5;">&#9881;</div>
        <div style="font-size:14px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;">Node Properties</div>
        <div style="font-size:12px;line-height:1.5;">Click any node on the canvas to see and edit all its configuration options here.</div>
        <div style="margin-top:16px;padding:12px;background:var(--bg-tertiary);border-radius:6px;text-align:left;font-size:11px;line-height:1.6;">
          <div style="font-weight:600;margin-bottom:4px;color:var(--text-secondary);">Quick Tips:</div>
          <div>&#8226; Drag nodes from the left palette</div>
          <div>&#8226; Connect outputs to inputs by dragging</div>
          <div>&#8226; Double-click palette items to add to center</div>
          <div>&#8226; Delete key removes selected node</div>
        </div>
      </div>`;
  },

  _render() {
    if (!this.currentNodeId || !BuilderCanvas.editor) return;
    const node = BuilderCanvas.editor.getNodeFromId(this.currentNodeId);
    if (!node) { this._showEmpty(); return; }

    const type = node.name;
    const data = node.data;
    const def = BuilderNodes.types[type];

    this.container.innerHTML = '';

    // Header with node type and color
    const header = document.createElement('div');
    header.className = 'builder-props-header';
    header.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="width:12px;height:12px;border-radius:50%;background:${def?.color || '#888'};flex-shrink:0;"></span>
        <span style="font-weight:600;color:var(--text-primary);font-size:14px;">${def?.label || type}</span>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Node #${this.currentNodeId}</div>`;
    this.container.appendChild(header);

    const form = document.createElement('div');
    form.className = 'builder-props-form';

    switch (type) {
      case 'sp': this._renderSP(form, data); break;
      case 'option': this._renderOption(form, data); break;
      case 'tool': this._renderTool(form, data); break;
      case 'var': this._renderVarSet(form, data); break;
      case 'textinput': this._renderTextInput(form, data); break;
      case 'llm': this._renderLLM(form, data); break;
      case 'condition': this._renderCondition(form, data); break;
      case 'script': this._renderScript(form, data); break;
      case 'subworkflow': this._renderSubworkflow(form, data); break;
      case 'schedule': this._renderSchedule(form, data); break;
      default:
        form.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">Unknown node type</div>';
    }

    this.container.appendChild(form);

    // Delete button at bottom
    const deleteSection = document.createElement('div');
    deleteSection.style.cssText = 'padding:16px;border-top:1px solid var(--border-primary);margin-top:8px;';
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn';
    deleteBtn.style.cssText = 'width:100%;background:var(--error-bg);color:var(--error-text);font-size:12px;';
    deleteBtn.textContent = 'Delete Node';
    deleteBtn.addEventListener('click', () => {
      if (this.currentNodeId) {
        BuilderCanvas.editor.removeNodeId('node-' + this.currentNodeId);
        this.currentNodeId = null;
        this._showEmpty();
      }
    });
    deleteSection.appendChild(deleteBtn);
    this.container.appendChild(deleteSection);
  },

  // ── Stopping Point ──────────────────────────────────────────────

  _renderSP(form, data) {
    this._addSectionHeader(form, 'Configuration', 'The menu title users see when they reach this stopping point.');

    this._addField(form, 'Title', 'text', data.title || '', (v) => {
      data.title = v;
      this._syncNode();
    }, 'e.g. "Choose analysis depth" or "What would you like to do?"');

    this._addSelect(form, 'Input Type', ['menu', 'text_input'], data.type || 'menu', (v) => {
      data.type = v;
      this._syncNode();
      this._render();
    }, ['Menu — numbered options', 'Text Input — free-text capture']);

    if (data.type === 'text_input') {
      this._addSectionHeader(form, 'Text Capture', 'The user\'s response is stored in this variable for use in later steps.');
      this._addField(form, 'Variable Name', 'text', data.capture_as || '', (v) => {
        data.capture_as = v.toUpperCase().replace(/[^A-Z0-9_]/g, '');
        this._syncNode();
      }, 'UPPERCASE, e.g. DESCRIPTION, USER_INPUT, SKILL_NAME');
    } else {
      this._addHint(form, 'Connect Menu Option nodes to this stopping point\'s outputs to define user choices.');
    }
  },

  // ── Menu Option ─────────────────────────────────────────────────

  _renderOption(form, data) {
    this._addSectionHeader(form, 'Option Display', 'What the user sees in the numbered menu.');

    this._addField(form, 'Label', 'text', data.label || '', (v) => {
      data.label = v;
      this._syncNode();
    }, 'e.g. "Quick Analysis" or "Run full audit"');

    this._addField(form, 'Option Number', 'text', data.number || '', (v) => {
      data.number = v;
      this._syncNode();
    }, 'Auto-assigned during export if left empty');

    this._addSectionHeader(form, 'Variables', 'Set variables when this option is selected. Available in all subsequent steps as {{VAR_NAME}}.');

    this._addKeyValueEditor(form, 'Set Variables', data.vars || {}, (vars) => {
      data.vars = vars;
      this._syncNode();
    }, 'KEY', 'value');

    // Goto dropdown
    this._addSectionHeader(form, 'Flow Control', 'By default, the workflow advances to the next stopping point. Use Go To to jump to a different one.');

    const sps = BuilderCanvas.getNodesOfType('sp');
    const gotoOptions = [''];
    const gotoLabels = ['(default — next stopping point)'];
    sps.forEach((sp, idx) => {
      gotoOptions.push(String(sp.id));
      gotoLabels.push(`SP ${idx + 1}: ${sp.data.title || 'Untitled'}`);
    });
    this._addSelect(form, 'Go To', gotoOptions, data._goto || '', (v) => {
      data._goto = v;
    }, gotoLabels);
  },

  // ── Tool Call ───────────────────────────────────────────────────

  _renderTool(form, data) {
    this._addSectionHeader(form, 'MCP Tool', 'Select the server and tool to call when this step executes.');

    const servers = Object.keys(this.availableTools || {});

    // Server
    this._addSelect(form, 'Server', ['', ...servers], data.server || '', (v) => {
      data.server = v;
      data.tool = '';
      this._syncNode();
      this._render();
    }, ['(select server)', ...servers]);

    // Tool (filtered by server)
    if (data.server && this.availableTools?.[data.server]) {
      const serverTools = this.availableTools[data.server].tools;
      this._addSelect(form, 'Tool', ['', ...serverTools.map(t => t.name)], data.tool || '', (v) => {
        data.tool = v;
        this._syncNode();
        this._render();
      }, ['(select tool)', ...serverTools.map(t => t.name + (t.description ? ' — ' + t.description.substring(0, 40) : ''))]);
    } else if (!data.server) {
      this._addHint(form, 'Select a server first to see available tools.');
    }

    // Browse button
    const browseBtn = document.createElement('button');
    browseBtn.className = 'btn btn-sm';
    browseBtn.style.cssText = 'margin-bottom:12px;font-size:11px;width:100%;';
    browseBtn.textContent = 'Browse All Tools...';
    browseBtn.addEventListener('click', () => {
      ToolBrowser.open((server, tool, schema) => {
        data.server = server;
        data.tool = tool;
        this._syncNode();
        this._render();
      });
    });
    form.appendChild(browseBtn);

    // Tool description
    if (data.server && data.tool && this.availableTools?.[data.server]) {
      const selectedTool = this.availableTools[data.server].tools.find(t => t.name === data.tool);
      if (selectedTool?.description) {
        const desc = document.createElement('div');
        desc.style.cssText = 'font-size:11px;color:var(--text-muted);margin:-4px 0 12px;padding:8px;background:var(--bg-tertiary);border-radius:4px;line-height:1.4;';
        desc.textContent = selectedTool.description;
        form.appendChild(desc);
      }

      // Args from schema
      if (selectedTool?.input_schema?.properties) {
        this._addSectionHeader(form, 'Arguments', 'Configure the tool\'s parameters. Use {{TOPIC}}, {{VAR_NAME}}, or {{i}} for dynamic values.');
        this._renderArgsFromSchema(form, data, selectedTool.input_schema);
      } else {
        this._addSectionHeader(form, 'Arguments', 'Enter tool arguments as JSON. Use {{TOPIC}}, {{VAR_NAME}} for dynamic values.');
        this._addTextarea(form, 'Args (JSON)', JSON.stringify(data.args || {}, null, 2), (v) => {
          try { data.args = JSON.parse(v); } catch {}
          this._syncNode();
        });
      }
    } else if (data.server && data.tool) {
      // Server/tool set but no schema available
      this._addSectionHeader(form, 'Arguments', 'Enter tool arguments as JSON.');
      this._addTextarea(form, 'Args (JSON)', JSON.stringify(data.args || {}, null, 2), (v) => {
        try { data.args = JSON.parse(v); } catch {}
        this._syncNode();
      });
    }

    // Capture section
    this._addSectionHeader(form, 'Capture Response', 'Extract fields from the tool response into variables for later steps.');
    this._addKeyValueEditor(form, 'Capture', data.capture || {}, (cap) => {
      data.capture = cap;
      this._syncNode();
    }, 'VARIABLE', 'response_field');
    this._addHint(form, 'Example: SESSION_ID captures "session_id" from the response.');

    // Loop section
    this._addSectionHeader(form, 'Loop', 'Repeat this tool call N times. {{i}} is the 1-based iteration counter.');
    this._addField(form, 'Repeat Count', 'number', data.loop || '', (v) => {
      data.loop = v ? Number(v) : null;
      this._syncNode();
    }, 'Leave empty for no looping');

    this._addCheckbox(form, 'Stream progress updates', data.stream_progress || false, (v) => {
      data.stream_progress = v;
      this._syncNode();
    });

    // Step ID
    this._addSectionHeader(form, 'Advanced');
    this._addField(form, 'Step ID', 'text', data.id || '', (v) => {
      data.id = v;
      this._syncNode();
    }, 'Optional identifier for this step (for debugging)');
  },

  // ── Variable Set ────────────────────────────────────────────────

  _renderVarSet(form, data) {
    this._addSectionHeader(form, 'Set Variables', 'Define key-value pairs. These become available as {{KEY}} in all subsequent steps and stopping point titles.');

    this._addKeyValueEditor(form, 'Variables', data.vars || {}, (vars) => {
      data.vars = vars;
      this._syncNode();
    }, 'KEY', 'value');

    this._addHint(form, 'Keys are automatically UPPERCASED. Values can include {{OTHER_VAR}} references.');
  },

  // ── Text Input ──────────────────────────────────────────────────

  _renderTextInput(form, data) {
    this._addSectionHeader(form, 'User Prompt', 'This text is shown to the user. Their response is captured into the variable below.');

    this._addField(form, 'Prompt Text', 'text', data.prompt || '', (v) => {
      data.prompt = v;
      this._syncNode();
    }, 'e.g. "Describe what your skill should do"');

    this._addSectionHeader(form, 'Capture Variable', 'The user\'s free-text response is stored in this variable.');

    this._addField(form, 'Variable Name', 'text', data.capture_as || '', (v) => {
      data.capture_as = v.toUpperCase().replace(/[^A-Z0-9_]/g, '');
      this._syncNode();
    }, 'UPPERCASE, e.g. DESCRIPTION, QUERY, USER_NAME');

    if (data.capture_as) {
      this._addHint(form, `Use {{${data.capture_as}}} in subsequent tool args or stopping point titles.`);
    }
  },

  // ── LLM Prompt ──────────────────────────────────────────────────

  _renderLLM(form, data) {
    this._addSectionHeader(form, 'LLM Prompt', 'This prompt is sent to the active LLM at execution time. The response replaces the {{LLM:...}} template in the connected tool\'s arguments.');

    this._addTextarea(form, 'Prompt', data.prompt || '', (v) => {
      data.prompt = v;
      this._syncNode();
    });

    this._addSectionHeader(form, 'Target Argument', 'Which tool argument should receive the LLM\'s response. Leave blank to auto-detect (tries thought, topic, message, prompt).');

    this._addField(form, 'Arg Name', 'text', data.target_arg || '', (v) => {
      data.target_arg = v;
      this._syncNode();
    }, 'e.g. thought, topic, message — leave blank for auto');

    this._addHint(form, 'Supports {{TOPIC}}, {{VAR_NAME}}, {{i}} inside the prompt. Connect this node\'s output to a Tool Call node to inject the LLM\'s response.');

    if (data.prompt) {
      const preview = document.createElement('div');
      preview.style.cssText = 'margin-top:8px;padding:8px;background:var(--code-bg);border-radius:4px;font-size:11px;font-family:monospace;color:var(--text-muted);white-space:pre-wrap;word-break:break-word;max-height:100px;overflow-y:auto;';
      preview.textContent = '{{LLM:' + data.prompt + '}}';
      form.appendChild(preview);
    }
  },

  // ── Schema-driven Args Form ─────────────────────────────────────

  _renderArgsFromSchema(form, data, schema) {
    const props = schema.properties || {};
    const required = new Set(schema.required || []);
    if (!data.args) data.args = {};

    for (const [key, prop] of Object.entries(props)) {
      const p = prop;
      const isReq = required.has(key);
      const label = key + (isReq ? ' *' : '');
      const currentVal = data.args[key];

      if (p.type === 'boolean') {
        this._addCheckbox(form, label, currentVal === true, (v) => {
          data.args[key] = v;
          this._syncNode();
        });
      } else if (p.enum) {
        this._addSelect(form, label, ['', ...p.enum], currentVal || '', (v) => {
          data.args[key] = v || undefined;
          this._syncNode();
        });
      } else if (p.type === 'number' || p.type === 'integer') {
        this._addField(form, label, 'number', currentVal ?? '', (v) => {
          data.args[key] = v ? Number(v) : undefined;
          this._syncNode();
        }, p.description ? p.description.substring(0, 100) : undefined);
      } else if (p.type === 'object' || p.type === 'array') {
        this._addTextarea(form, label, typeof currentVal === 'object' ? JSON.stringify(currentVal, null, 2) : (currentVal || '{}'), (v) => {
          try { data.args[key] = JSON.parse(v); } catch { data.args[key] = v; }
          this._syncNode();
        });
        if (p.description) this._addHint(form, p.description.substring(0, 120));
      } else {
        const isLong = /content|body|text|prompt|query|code|script|message|thought|description/i.test(key) || (p.description || '').length > 80;
        if (isLong) {
          this._addTextarea(form, label, currentVal || '', (v) => {
            data.args[key] = v;
            this._syncNode();
          });
        } else {
          this._addField(form, label, 'text', currentVal || '', (v) => {
            data.args[key] = v;
            this._syncNode();
          }, p.description ? p.description.substring(0, 100) : undefined);
        }
        if (p.description && !isLong) this._addHint(form, p.description.substring(0, 120));
      }
    }

    // Also show raw JSON editor for any extra args not in schema
    const schemaKeys = new Set(Object.keys(props));
    const extraArgs = {};
    for (const [k, v] of Object.entries(data.args || {})) {
      if (!schemaKeys.has(k)) extraArgs[k] = v;
    }
    if (Object.keys(extraArgs).length > 0) {
      this._addSectionHeader(form, 'Extra Arguments', 'Additional arguments not in the tool schema.');
      this._addTextarea(form, 'Extra Args (JSON)', JSON.stringify(extraArgs, null, 2), (v) => {
        try {
          const parsed = JSON.parse(v);
          // Remove old extras, add new
          for (const k of Object.keys(extraArgs)) delete data.args[k];
          Object.assign(data.args, parsed);
        } catch {}
        this._syncNode();
      });
    }
  },

  // ── UI Helpers ──────────────────────────────────────────────────

  _addSectionHeader(container, title, description) {
    const header = document.createElement('div');
    header.style.cssText = 'margin:16px 0 8px;padding-top:8px;border-top:1px solid var(--border-subtle);';
    header.innerHTML = `<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);letter-spacing:0.5px;">${title}</div>`;
    if (description) {
      header.innerHTML += `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;line-height:1.4;">${description}</div>`;
    }
    container.appendChild(header);
  },

  _addHint(container, text) {
    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:10px;color:var(--text-muted);margin:-4px 0 8px;line-height:1.4;font-style:italic;';
    hint.textContent = text;
    container.appendChild(hint);
  },

  _addField(container, label, type, value, onChange, placeholder) {
    const group = this._createGroup(label);
    const input = document.createElement('input');
    input.type = type;
    input.value = value;
    input.className = 'builder-props-input';
    if (placeholder) input.placeholder = placeholder;
    input.addEventListener('change', () => onChange(input.value));
    input.addEventListener('input', () => onChange(input.value));
    group.appendChild(input);
    container.appendChild(group);
  },

  _addTextarea(container, label, value, onChange) {
    const group = this._createGroup(label);
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.className = 'builder-props-textarea';
    ta.rows = 4;
    ta.addEventListener('change', () => onChange(ta.value));
    group.appendChild(ta);
    container.appendChild(group);
  },

  _addSelect(container, label, options, value, onChange, labels) {
    const group = this._createGroup(label);
    const select = document.createElement('select');
    select.className = 'builder-props-input';
    options.forEach((opt, i) => {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = labels ? labels[i] : opt || '(none)';
      if (opt === value) o.selected = true;
      select.appendChild(o);
    });
    select.addEventListener('change', () => onChange(select.value));
    group.appendChild(select);
    container.appendChild(group);
  },

  _addCheckbox(container, label, checked, onChange) {
    const group = document.createElement('div');
    group.style.cssText = 'margin-bottom:8px;display:flex;align-items:center;gap:8px;padding:4px 0;';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.style.cssText = 'width:16px;height:16px;accent-color:var(--accent);';
    cb.addEventListener('change', () => onChange(cb.checked));
    group.appendChild(cb);
    const lbl = document.createElement('span');
    lbl.style.cssText = 'font-size:12px;color:var(--text-secondary);';
    lbl.textContent = label;
    group.appendChild(lbl);
    container.appendChild(group);
  },

  _addKeyValueEditor(container, label, obj, onChange, keyPlaceholder, valPlaceholder) {
    const group = this._createGroup(label);
    const list = document.createElement('div');

    const renderEntries = () => {
      list.innerHTML = '';
      const entries = Object.entries(obj);

      if (entries.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'font-size:11px;color:var(--text-muted);font-style:italic;margin-bottom:4px;';
        empty.textContent = 'No entries yet';
        list.appendChild(empty);
      }

      entries.forEach(([k, v]) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:4px;margin-bottom:4px;align-items:center;';

        const keyInput = document.createElement('input');
        keyInput.className = 'builder-props-input';
        keyInput.style.cssText = 'flex:1;font-size:11px;padding:4px 6px;font-family:monospace;';
        keyInput.value = k;
        keyInput.placeholder = keyPlaceholder || 'KEY';

        const valInput = document.createElement('input');
        valInput.className = 'builder-props-input';
        valInput.style.cssText = 'flex:1;font-size:11px;padding:4px 6px;';
        valInput.value = String(v);
        valInput.placeholder = valPlaceholder || 'value';

        const removeBtn = document.createElement('button');
        removeBtn.className = 'btn btn-sm';
        removeBtn.innerHTML = '&times;';
        removeBtn.style.cssText = 'padding:2px 6px;font-size:14px;color:var(--error);line-height:1;min-width:24px;';
        removeBtn.addEventListener('click', () => {
          delete obj[k];
          onChange(obj);
          renderEntries();
        });

        keyInput.addEventListener('change', () => {
          const newKey = keyInput.value.toUpperCase().replace(/[^A-Z0-9_]/g, '');
          if (newKey && newKey !== k) {
            const val = obj[k];
            delete obj[k];
            obj[newKey] = val;
            onChange(obj);
            renderEntries();
          }
        });
        valInput.addEventListener('change', () => {
          obj[k] = valInput.value;
          onChange(obj);
        });

        row.appendChild(keyInput);
        row.appendChild(valInput);
        row.appendChild(removeBtn);
        list.appendChild(row);
      });
    };

    renderEntries();
    group.appendChild(list);

    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-sm';
    addBtn.textContent = '+ Add Entry';
    addBtn.style.cssText = 'font-size:11px;padding:3px 10px;margin-top:4px;';
    addBtn.addEventListener('click', () => {
      const newKey = 'NEW_KEY_' + (Object.keys(obj).length + 1);
      obj[newKey] = '';
      onChange(obj);
      renderEntries();
    });
    group.appendChild(addBtn);
    container.appendChild(group);
  },

  // ── Schedule Trigger Node ──────────────────────────────────
  _renderSchedule(form, data) {
    const typeGroup = this._createGroup('Schedule Type');
    const typeSelect = document.createElement('select');
    typeSelect.className = 'builder-props-input';
    const types = [
      { value: 'every', label: 'Every (recurring interval)', hint: 'e.g. 1h, 30m, 2d' },
      { value: 'cron', label: 'Cron (Unix cron expression)', hint: 'e.g. 0 9 * * MON-FRI' },
      { value: 'at', label: 'At (specific time daily)', hint: 'e.g. 09:00, 14:30' },
      { value: 'in', label: 'In (one-time delay)', hint: 'e.g. 5m, 2h' },
    ];
    for (const t of types) {
      const o = document.createElement('option');
      o.value = t.value; o.textContent = t.label;
      if (data.schedule_type === t.value) o.selected = true;
      typeSelect.appendChild(o);
    }
    typeSelect.addEventListener('change', () => {
      data.schedule_type = typeSelect.value;
      this._syncNode();
      hintEl.textContent = types.find(t => t.value === typeSelect.value)?.hint || '';
    });
    typeGroup.appendChild(typeSelect);
    form.appendChild(typeGroup);

    const schedGroup = this._createGroup('Schedule');
    const schedInput = document.createElement('input');
    schedInput.type = 'text';
    schedInput.className = 'builder-props-input';
    schedInput.placeholder = types.find(t => t.value === data.schedule_type)?.hint || '';
    schedInput.value = data.schedule || '';
    schedInput.addEventListener('change', () => { data.schedule = schedInput.value; this._syncNode(); });
    schedGroup.appendChild(schedInput);
    const hintEl = document.createElement('div');
    hintEl.style.cssText = 'font-size:10px;color:var(--text-muted);margin-top:3px;font-style:italic;';
    hintEl.textContent = types.find(t => t.value === data.schedule_type)?.hint || '';
    schedGroup.appendChild(hintEl);
    form.appendChild(schedGroup);

    const queryGroup = this._createGroup('Query (what to run)');
    const queryInput = document.createElement('textarea');
    queryInput.className = 'builder-props-input';
    queryInput.rows = 2;
    queryInput.placeholder = 'e.g. check system health, run backup, send daily report';
    queryInput.value = data.query || '';
    queryInput.addEventListener('change', () => { data.query = queryInput.value; this._syncNode(); });
    queryGroup.appendChild(queryInput);
    form.appendChild(queryGroup);

    const hint = document.createElement('div');
    hint.style.cssText = 'padding:8px;background:var(--bg-tertiary);border-radius:6px;font-size:11px;color:var(--text-muted);line-height:1.5;margin-top:8px;';
    hint.innerHTML = 'Schedule triggers auto-run the connected workflow on a timer via <code>vodou-core schedule</code>. Supports 4 types: cron, every, at, in.';
    form.appendChild(hint);
  },

  // ── Condition Node ──────────────────────────────────────────
  _renderCondition(form, data) {
    // Variable to check
    const varGroup = this._createGroup('Variable');
    const varInput = document.createElement('input');
    varInput.type = 'text';
    varInput.className = 'builder-props-input';
    varInput.placeholder = 'e.g. DEPTH, SESSION_ID, TOPIC';
    varInput.value = data.variable || '';
    varInput.addEventListener('change', () => { data.variable = varInput.value; this._syncNode(); });
    varGroup.appendChild(varInput);
    form.appendChild(varGroup);

    // Operator
    const opGroup = this._createGroup('Operator');
    const opSelect = document.createElement('select');
    opSelect.className = 'builder-props-input';
    const operators = [
      { value: 'contains', label: 'contains' },
      { value: 'equals', label: 'equals (==)' },
      { value: 'not_equals', label: 'not equals (!=)' },
      { value: 'greater_than', label: 'greater than (>)' },
      { value: 'less_than', label: 'less than (<)' },
      { value: 'exists', label: 'exists (not empty)' },
      { value: 'not_exists', label: 'not exists (empty)' },
    ];
    for (const op of operators) {
      const o = document.createElement('option');
      o.value = op.value; o.textContent = op.label;
      if (data.operator === op.value) o.selected = true;
      opSelect.appendChild(o);
    }
    opSelect.addEventListener('change', () => { data.operator = opSelect.value; this._syncNode(); });
    opGroup.appendChild(opSelect);
    form.appendChild(opGroup);

    // Value to compare against
    const valGroup = this._createGroup('Value');
    const valInput = document.createElement('input');
    valInput.type = 'text';
    valInput.className = 'builder-props-input';
    valInput.placeholder = 'Value to compare (supports {{VAR}})';
    valInput.value = data.value || '';
    valInput.addEventListener('change', () => { data.value = valInput.value; this._syncNode(); });
    valGroup.appendChild(valInput);
    form.appendChild(valGroup);

    // Output labels
    const trueGroup = this._createGroup('True Branch Label');
    const trueInput = document.createElement('input');
    trueInput.type = 'text';
    trueInput.className = 'builder-props-input';
    trueInput.value = data.label_true || 'Yes';
    trueInput.addEventListener('change', () => { data.label_true = trueInput.value; this._syncNode(); });
    trueGroup.appendChild(trueInput);
    form.appendChild(trueGroup);

    const falseGroup = this._createGroup('False Branch Label');
    const falseInput = document.createElement('input');
    falseInput.type = 'text';
    falseInput.className = 'builder-props-input';
    falseInput.value = data.label_false || 'No';
    falseInput.addEventListener('change', () => { data.label_false = falseInput.value; this._syncNode(); });
    falseGroup.appendChild(falseInput);
    form.appendChild(falseGroup);

    // Hint
    const hint = document.createElement('div');
    hint.style.cssText = 'padding:8px;background:var(--bg-tertiary);border-radius:6px;font-size:11px;color:var(--text-muted);line-height:1.5;margin-top:8px;';
    hint.textContent = 'Output 1 = true branch, Output 2 = false branch. Connect each to different tool chains or stopping points.';
    form.appendChild(hint);
  },

  // ── Script Node ──────────────────────────────────────────────
  _renderScript(form, data) {
    const cmdGroup = this._createGroup('Shell Command');
    const cmdInput = document.createElement('textarea');
    cmdInput.className = 'builder-props-input';
    cmdInput.rows = 3;
    cmdInput.style.fontFamily = 'monospace';
    cmdInput.style.fontSize = '12px';
    cmdInput.placeholder = 'e.g. curl -s https://api.example.com/data\nor: ls -la {{TOPIC}}';
    cmdInput.value = data.command || '';
    cmdInput.addEventListener('change', () => { data.command = cmdInput.value; this._syncNode(); });
    cmdGroup.appendChild(cmdInput);
    form.appendChild(cmdGroup);

    const captureGroup = this._createGroup('Capture Output As');
    const captureInput = document.createElement('input');
    captureInput.type = 'text';
    captureInput.className = 'builder-props-input';
    captureInput.placeholder = 'Variable name (e.g. SCRIPT_OUTPUT)';
    captureInput.value = data.capture_as || '';
    captureInput.addEventListener('change', () => { data.capture_as = captureInput.value; this._syncNode(); });
    captureGroup.appendChild(captureInput);
    form.appendChild(captureGroup);

    const timeoutGroup = this._createGroup('Timeout (seconds)');
    const timeoutInput = document.createElement('input');
    timeoutInput.type = 'number';
    timeoutInput.className = 'builder-props-input';
    timeoutInput.min = '1';
    timeoutInput.max = '300';
    timeoutInput.value = data.timeout || 30;
    timeoutInput.addEventListener('change', () => { data.timeout = parseInt(timeoutInput.value) || 30; this._syncNode(); });
    timeoutGroup.appendChild(timeoutInput);
    form.appendChild(timeoutGroup);

    const hint = document.createElement('div');
    hint.style.cssText = 'padding:8px;background:var(--bg-tertiary);border-radius:6px;font-size:11px;color:var(--text-muted);line-height:1.5;margin-top:8px;';
    hint.textContent = 'Runs via the script-executor MCP server. Supports {{VAR}} templates in the command. Output is captured as a variable.';
    form.appendChild(hint);
  },

  // ── Sub-Workflow Node ────────────────────────────────────────
  _renderSubworkflow(form, data) {
    const skillGroup = this._createGroup('Skill Name');
    const skillSelect = document.createElement('select');
    skillSelect.className = 'builder-props-input';
    skillSelect.innerHTML = '<option value="">Loading skills...</option>';

    // Fetch workflow-capable skills
    API.get('/api/workflows').then(wf => {
      skillSelect.innerHTML = '<option value="">Select a skill...</option>';
      for (const s of (wf.skills || [])) {
        const o = document.createElement('option');
        o.value = s.name;
        o.textContent = `${s.name} \u2014 ${(s.description || '').substring(0, 40)}`;
        if (data.skill_name === s.name) o.selected = true;
        skillSelect.appendChild(o);
      }
    }).catch(() => {
      skillSelect.innerHTML = '<option value="">Failed to load</option>';
    });

    skillSelect.addEventListener('change', () => { data.skill_name = skillSelect.value; this._syncNode(); });
    skillGroup.appendChild(skillSelect);
    form.appendChild(skillGroup);

    const passGroup = this._createGroup('Pass Variables');
    const passLabel = document.createElement('label');
    passLabel.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-secondary);cursor:pointer;';
    const passCheck = document.createElement('input');
    passCheck.type = 'checkbox';
    passCheck.checked = data.pass_vars !== false;
    passCheck.addEventListener('change', () => { data.pass_vars = passCheck.checked; this._syncNode(); });
    passLabel.appendChild(passCheck);
    passLabel.appendChild(document.createTextNode('Forward current variables to sub-workflow'));
    passGroup.appendChild(passLabel);
    form.appendChild(passGroup);

    const hint = document.createElement('div');
    hint.style.cssText = 'padding:8px;background:var(--bg-tertiary);border-radius:6px;font-size:11px;color:var(--text-muted);line-height:1.5;margin-top:8px;';
    hint.textContent = 'Runs another skill as a step. Only skills with actions.json (WORKFLOW badge) can be embedded. Variables from the parent workflow are forwarded if enabled.';
    form.appendChild(hint);
  },

  _createGroup(label) {
    const group = document.createElement('div');
    group.style.cssText = 'margin-bottom:10px;';
    const lbl = document.createElement('label');
    lbl.style.cssText = 'display:block;font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text-muted);margin-bottom:3px;letter-spacing:0.3px;';
    lbl.textContent = label;
    group.appendChild(lbl);
    return group;
  },

  _syncNode() {
    if (!this.currentNodeId) return;
    const node = BuilderCanvas.editor.getNodeFromId(this.currentNodeId);
    if (!node) return;
    BuilderCanvas.updateNode(this.currentNodeId, node.data);
  }
};
