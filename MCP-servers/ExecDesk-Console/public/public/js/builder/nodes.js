/**
 * Builder Node Types — HTML templates, defaults, and port configs for each node type
 */
const BuilderNodes = {

  types: {
    sp: {
      label: 'Stopping Point',
      category: 'Flow',
      color: '#0d9488',
      inputs: 1,
      outputs: 4,
      defaultData: { title: '', type: 'menu' },
      html(data) {
        return `<div class="builder-node-inner">
          <div class="builder-node-header" style="background:rgba(13,148,136,0.2);color:#5eead4;">STOPPING POINT</div>
          <div class="builder-node-body">
            <div class="builder-node-title">${BuilderNodes._esc(data.title || 'Untitled')}</div>
            ${data.type === 'text_input' ? '<span class="builder-node-badge" style="background:#e67700;color:#fff;">text input</span>' : ''}
          </div>
        </div>`;
      }
    },

    option: {
      label: 'Menu Option',
      category: 'Flow',
      color: '#5b9bd5',
      inputs: 1,
      outputs: 1,
      defaultData: { number: '', label: '', vars: {} },
      html(data) {
        const varKeys = Object.keys(data.vars || {});
        return `<div class="builder-node-inner">
          <div class="builder-node-header" style="background:rgba(91,155,213,0.2);color:#5b9bd5;">OPTION ${BuilderNodes._esc(data.number || '?')}</div>
          <div class="builder-node-body">
            <div class="builder-node-title">${BuilderNodes._esc(data.label || 'Unnamed')}</div>
            ${varKeys.length ? varKeys.map(k => `<span class="builder-node-badge">${BuilderNodes._esc(k)}=${BuilderNodes._esc(String(data.vars[k]))}</span>`).join('') : ''}
          </div>
        </div>`;
      }
    },

    tool: {
      label: 'Tool Call',
      category: 'Actions',
      color: '#23a559',
      inputs: 1,
      outputs: 1,
      defaultData: { id: '', server: '', tool: '', args: {}, capture: {}, loop: null, stream_progress: false },
      html(data) {
        const captureKeys = Object.keys(data.capture || {});
        return `<div class="builder-node-inner">
          <div class="builder-node-header" style="background:rgba(35,165,89,0.2);color:#57f287;">TOOL</div>
          <div class="builder-node-body">
            <div class="builder-node-title">${BuilderNodes._esc(data.server || '?')}::${BuilderNodes._esc(data.tool || '?')}</div>
            ${data.loop ? `<span class="builder-node-badge" style="background:#0d9488;color:#fff;">loop:${data.loop}</span>` : ''}
            ${captureKeys.length ? captureKeys.map(k => `<span class="builder-node-badge" style="background:#23a559;color:#fff;">${BuilderNodes._esc(k)}</span>`).join('') : ''}
          </div>
        </div>`;
      }
    },

    var: {
      label: 'Variable Set',
      category: 'Data',
      color: '#faa61a',
      inputs: 1,
      outputs: 1,
      defaultData: { vars: {} },
      html(data) {
        const entries = Object.entries(data.vars || {});
        return `<div class="builder-node-inner">
          <div class="builder-node-header" style="background:rgba(250,166,26,0.2);color:#faa61a;">VARIABLES</div>
          <div class="builder-node-body">
            ${entries.length
              ? entries.map(([k, v]) => `<div style="font-size:11px;">${BuilderNodes._esc(k)} = ${BuilderNodes._esc(String(v))}</div>`).join('')
              : '<div style="color:var(--text-muted);font-size:11px;">No variables set</div>'}
          </div>
        </div>`;
      }
    },

    textinput: {
      label: 'Text Input',
      category: 'Flow',
      color: '#e67700',
      inputs: 1,
      outputs: 1,
      defaultData: { prompt: '', capture_as: '' },
      html(data) {
        return `<div class="builder-node-inner">
          <div class="builder-node-header" style="background:rgba(230,119,0,0.2);color:#e67700;">TEXT INPUT</div>
          <div class="builder-node-body">
            <div class="builder-node-title">${BuilderNodes._esc(data.prompt || 'Enter text...')}</div>
            ${data.capture_as ? `<span class="builder-node-badge" style="background:#e67700;color:#fff;">\u2192 ${BuilderNodes._esc(data.capture_as)}</span>` : ''}
          </div>
        </div>`;
      }
    },

    llm: {
      label: 'LLM Prompt',
      category: 'AI',
      color: '#20c997',
      inputs: 1,
      outputs: 1,
      defaultData: { prompt: '', target_arg: '' },
      html(data) {
        const preview = (data.prompt || '').substring(0, 60) + ((data.prompt || '').length > 60 ? '...' : '');
        return `<div class="builder-node-inner">
          <div class="builder-node-header" style="background:rgba(32,201,151,0.2);color:#20c997;">LLM PROMPT</div>
          <div class="builder-node-body">
            <div class="builder-node-title">${BuilderNodes._esc(preview || 'Empty prompt')}</div>
          </div>
        </div>`;
      }
    },

    condition: {
      label: 'Condition',
      category: 'Flow',
      color: '#f23f43',
      inputs: 1,
      outputs: 2,
      defaultData: { variable: '', operator: 'contains', value: '', label_true: 'Yes', label_false: 'No' },
      html(data) {
        const expr = data.variable ? `${BuilderNodes._esc(data.variable)} ${data.operator || '=='} ${BuilderNodes._esc(data.value || '?')}` : 'Configure condition';
        return `<div class="builder-node-inner">
          <div class="builder-node-header" style="background:rgba(242,63,67,0.2);color:#f23f43;">IF / ELSE</div>
          <div class="builder-node-body">
            <div class="builder-node-title">${expr}</div>
            <div style="display:flex;gap:8px;margin-top:4px;">
              <span class="builder-node-badge" style="background:rgba(35,165,89,0.2);color:var(--success);">\u2713 ${BuilderNodes._esc(data.label_true || 'Yes')}</span>
              <span class="builder-node-badge" style="background:rgba(242,63,67,0.2);color:#f23f43;">\u2717 ${BuilderNodes._esc(data.label_false || 'No')}</span>
            </div>
          </div>
        </div>`;
      }
    },

    script: {
      label: 'Script',
      category: 'Actions',
      color: '#9b59b6',
      inputs: 1,
      outputs: 1,
      defaultData: { command: '', capture_as: '', timeout: 30 },
      html(data) {
        const preview = (data.command || '').substring(0, 50) + ((data.command || '').length > 50 ? '...' : '');
        return `<div class="builder-node-inner">
          <div class="builder-node-header" style="background:rgba(155,89,182,0.2);color:#9b59b6;">SCRIPT</div>
          <div class="builder-node-body">
            <div class="builder-node-title" style="font-family:monospace;font-size:11px;">${BuilderNodes._esc(preview || '$ command')}</div>
            ${data.capture_as ? `<span class="builder-node-badge" style="background:#9b59b6;color:#fff;">\u2192 ${BuilderNodes._esc(data.capture_as)}</span>` : ''}
          </div>
        </div>`;
      }
    },

    schedule: {
      label: 'Schedule Trigger',
      category: 'Triggers',
      color: '#e74c3c',
      inputs: 0,
      outputs: 1,
      defaultData: { schedule_type: 'every', schedule: '1h', query: '' },
      html(data) {
        const typeLabels = { cron: 'CRON', every: 'EVERY', at: 'AT', in: 'IN' };
        const typeLabel = typeLabels[data.schedule_type] || data.schedule_type;
        return `<div class="builder-node-inner">
          <div class="builder-node-header" style="background:rgba(231,76,60,0.2);color:#e74c3c;">SCHEDULE</div>
          <div class="builder-node-body">
            <div class="builder-node-title">${BuilderNodes._esc(typeLabel)}: ${BuilderNodes._esc(data.schedule || '?')}</div>
            ${data.query ? `<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${BuilderNodes._esc(data.query.substring(0, 40))}</div>` : ''}
          </div>
        </div>`;
      }
    },

    subworkflow: {
      label: 'Sub-Workflow',
      category: 'Flow',
      color: '#3498db',
      inputs: 1,
      outputs: 1,
      defaultData: { skill_name: '', pass_vars: true },
      html(data) {
        return `<div class="builder-node-inner">
          <div class="builder-node-header" style="background:rgba(52,152,219,0.2);color:#3498db;">SUB-WORKFLOW</div>
          <div class="builder-node-body">
            <div class="builder-node-title">${BuilderNodes._esc(data.skill_name || 'Select a skill...')}</div>
            ${data.pass_vars ? '<span class="builder-node-badge" style="background:#3498db;color:#fff;">pass vars</span>' : ''}
          </div>
        </div>`;
      }
    }
  },

  /** Get category groups for palette */
  getCategories() {
    const cats = {};
    for (const [key, def] of Object.entries(this.types)) {
      if (!cats[def.category]) cats[def.category] = [];
      cats[def.category].push({ key, ...def });
    }
    return cats;
  },

  _esc(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
};
