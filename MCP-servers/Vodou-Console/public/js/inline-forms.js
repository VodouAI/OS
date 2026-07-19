/**
 * Inline Forms — renders tool input schemas as editable forms in chat
 * Supports: text, number, boolean, select (enum), textarea (long strings)
 * Pre-fills from extracted parameters
 */

const InlineForms = {

  /**
   * Create a form element from a tool's JSON Schema
   * @param {string} server - server name
   * @param {string} tool - tool name
   * @param {object} schema - JSON Schema for the tool's input
   * @param {string} description - tool description
   * @param {object} prefill - pre-extracted parameters to fill in
   * @param {function} onSubmit - callback(params) when form is submitted
   * @param {function} onCancel - callback when cancelled
   * @returns {HTMLElement}
   */
  create(server, tool, schema, description, prefill, onSubmit, onCancel) {
    const form = document.createElement('div');
    form.className = 'tool-form';

    // Header
    const header = document.createElement('div');
    header.className = 'tool-form-header';
    header.innerHTML = '<span class="tf-icon">\u2699\uFE0F</span>' +
      '<span>' + this._escapeHtml(tool) + '</span>' +
      '<span class="tf-server">' + this._escapeHtml(server) + '</span>';
    form.appendChild(header);

    // Description
    if (description) {
      const desc = document.createElement('div');
      desc.className = 'tool-form-desc';
      desc.textContent = description;
      form.appendChild(desc);
    }

    // Fields
    const properties = schema.properties || {};
    const required = new Set(schema.required || []);
    const fieldEls = {};

    for (const [key, prop] of Object.entries(properties)) {
      const fieldEl = this._createField(key, prop, required.has(key), prefill?.[key]);
      form.appendChild(fieldEl.container);
      fieldEls[key] = fieldEl;
    }

    // Actions
    const actions = document.createElement('div');
    actions.className = 'tf-actions';

    const submitBtn = document.createElement('button');
    submitBtn.className = 'tf-submit';
    submitBtn.textContent = 'Run ' + tool;
    submitBtn.addEventListener('click', () => {
      const params = {};
      for (const [key, fieldEl] of Object.entries(fieldEls)) {
        const val = fieldEl.getValue();
        if (val !== undefined && val !== '') {
          params[key] = val;
        }
      }
      submitBtn.disabled = true;
      submitBtn.textContent = 'Running...';
      onSubmit(params);
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'tf-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      form.remove();
      if (onCancel) onCancel();
    });

    actions.appendChild(submitBtn);
    actions.appendChild(cancelBtn);
    form.appendChild(actions);

    return form;
  },

  /**
   * Create a single form field from a JSON Schema property
   */
  _createField(key, prop, isRequired, prefillValue) {
    const container = document.createElement('div');
    container.className = 'tf-field';

    const type = prop.type || 'string';
    const description = prop.description || '';
    const enumValues = prop.enum || null;

    // Label
    const label = document.createElement('label');
    label.className = 'tf-label';
    label.innerHTML = this._formatKey(key) +
      (isRequired ? '<span class="tf-required">*</span>' : '') +
      '<span class="tf-type">' + type + '</span>';
    container.appendChild(label);

    let input;
    let getValue;

    if (type === 'boolean') {
      // Checkbox
      const row = document.createElement('div');
      row.className = 'tf-checkbox-row';
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = prefillValue === true || prefillValue === 'true';
      const cbLabel = document.createElement('span');
      cbLabel.style.fontSize = '12px';
      cbLabel.style.color = 'var(--text-secondary)';
      cbLabel.textContent = description || key;
      row.appendChild(input);
      row.appendChild(cbLabel);
      container.appendChild(row);
      getValue = () => input.checked;

    } else if (enumValues && enumValues.length > 0) {
      // Select dropdown
      input = document.createElement('select');
      input.className = 'tf-select';
      for (const val of enumValues) {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = val;
        if (prefillValue === val) opt.selected = true;
        input.appendChild(opt);
      }
      container.appendChild(input);
      getValue = () => input.value;

    } else if (type === 'integer' || type === 'number') {
      // Number input
      input = document.createElement('input');
      input.className = 'tf-input';
      input.type = 'number';
      if (prop.minimum !== undefined) input.min = prop.minimum;
      if (prop.maximum !== undefined) input.max = prop.maximum;
      if (prefillValue !== undefined) input.value = String(prefillValue);
      if (prop.default !== undefined && !prefillValue) input.value = String(prop.default);
      container.appendChild(input);
      getValue = () => {
        const v = input.value;
        if (v === '') return undefined;
        return type === 'integer' ? parseInt(v) : parseFloat(v);
      };

    } else if (type === 'object' || type === 'array') {
      // JSON textarea
      input = document.createElement('textarea');
      input.className = 'tf-textarea';
      input.placeholder = type === 'object' ? '{"key": "value"}' : '[item1, item2]';
      if (prefillValue !== undefined) {
        input.value = typeof prefillValue === 'string' ? prefillValue : JSON.stringify(prefillValue, null, 2);
      }
      container.appendChild(input);
      getValue = () => {
        const v = input.value.trim();
        if (!v) return undefined;
        try { return JSON.parse(v); } catch { return v; }
      };

    } else {
      // String — use textarea for long descriptions, input for short
      const isLong = description.length > 80 || /content|body|text|thought|query|prompt|code|script|message/i.test(key);
      if (isLong) {
        input = document.createElement('textarea');
        input.className = 'tf-textarea';
      } else {
        input = document.createElement('input');
        input.className = 'tf-input';
        input.type = 'text';
      }
      if (prefillValue !== undefined) input.value = String(prefillValue);
      if (prop.default !== undefined && !prefillValue) input.value = String(prop.default);
      container.appendChild(input);
      getValue = () => input.value || undefined;
    }

    // Hint (description)
    if (description && type !== 'boolean') {
      const hint = document.createElement('div');
      hint.className = 'tf-hint';
      hint.textContent = description.substring(0, 150);
      container.appendChild(hint);
    }

    return { container, input, getValue };
  },

  /**
   * Show a form for a specific server/tool, fetching the schema from the API
   * Returns the form element (caller appends to DOM)
   */
  async showForTool(server, tool, prefill, onSubmit, onCancel) {
    try {
      const res = await fetch(`/api/intents/tool-schema?server=${encodeURIComponent(server)}&tool=${encodeURIComponent(tool)}`);
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.schema || !data.schema.properties || Object.keys(data.schema.properties).length === 0) {
        return null; // No schema = no form
      }
      return this.create(server, tool, data.schema, data.description, prefill, onSubmit, onCancel);
    } catch {
      return null;
    }
  },

  _formatKey(key) {
    return key
      .replace(/_/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, c => c.toUpperCase());
  },

  // Shared escaper — safe.js loads first, so VodouSafe is always present.
  // (Old local copy skipped quotes — attribute-breakout risk.)
  _escapeHtml(t) {
    return window.VodouSafe.escapeHtml(t);
  },
};
