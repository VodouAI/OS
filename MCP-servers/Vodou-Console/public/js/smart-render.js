/**
 * Smart Tool Result Renderer
 * Detects content type and renders appropriately instead of raw text dumps.
 */

const SmartRender = {

  /**
   * Render a tool result string into rich HTML.
   * Returns { html, isRich } — isRich = true if we did something beyond plain text.
   */
  render(resultText, toolName, serverName) {
    if (!resultText || typeof resultText !== 'string') {
      return { html: '', isRich: false };
    }

    const text = resultText.trim();

    // 1. Try JSON
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        return this._renderJSON(parsed, toolName, serverName);
      } catch {}
    }

    // 2. Check for mcp-monitor style output (key: value lines)
    if (serverName === 'mcp-monitor' || /^(cpu|memory|disk|network|system)/i.test(toolName || '')) {
      const metrics = this._parseMetrics(text);
      if (metrics) return metrics;
    }

    // 3. Error detection
    if (/^(error|exception|failed|fatal)/i.test(text) || /stack trace|traceback|panic/i.test(text)) {
      return { html: '<div class="smart-error">' + this._escapeHtml(text) + '</div>', isRich: true };
    }

    // 4. Long text — make collapsible
    if (text.length > 500) {
      return this._renderCollapsible(text);
    }

    // 5. Plain text — just format it nicely
    return { html: '', isRich: false };
  },

  /**
   * Render parsed JSON smartly
   */
  _renderJSON(data, toolName, serverName) {
    // Array of objects → table
    if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && data[0] !== null) {
      return { html: this._renderTable(data), isRich: true };
    }

    // Array of primitives → simple list
    if (Array.isArray(data)) {
      const items = data.map(d => '<li>' + this._escapeHtml(String(d)) + '</li>').join('');
      return { html: '<div class="smart-result"><ul style="margin:4px 0;padding-left:20px">' + items + '</ul></div>', isRich: true };
    }

    // Object — check if it's metric-like data (mcp-monitor)
    if (typeof data === 'object' && data !== null) {
      // Check for nested content array (MCP response format)
      if (data.content && Array.isArray(data.content)) {
        const textBlocks = data.content.filter(b => b.type === 'text' && b.text);
        if (textBlocks.length > 0) {
          const innerText = textBlocks.map(b => b.text).join('\n');
          return this.render(innerText, toolName, serverName);
        }
      }

      // Flat object with mostly primitive values → key-value card
      const keys = Object.keys(data);
      if (keys.length > 0 && keys.length <= 30) {
        const hasNestedObjects = keys.some(k => typeof data[k] === 'object' && data[k] !== null && !Array.isArray(data[k]));

        // If values look like metrics (numbers with recognizable names)
        if (this._looksLikeMetrics(data)) {
          return { html: this._renderMetricCards(data), isRich: true };
        }

        // Simple key-value pairs
        if (!hasNestedObjects || keys.length <= 10) {
          return { html: this._renderKeyValue(data), isRich: true };
        }
      }

      // Complex object — collapsible formatted JSON
      const formatted = JSON.stringify(data, null, 2);
      if (formatted.length > 500) {
        return this._renderCollapsible(formatted);
      }
      return { html: '<div class="smart-result"><pre style="margin:0;font-size:0.85em">' + this._escapeHtml(formatted) + '</pre></div>', isRich: true };
    }

    return { html: '', isRich: false };
  },

  /** Render array of objects as a table */
  _renderTable(data) {
    const keys = [...new Set(data.flatMap(Object.keys))];
    let html = '<div class="smart-result"><table>';
    html += '<tr>' + keys.map(k => '<th>' + this._escapeHtml(k) + '</th>').join('') + '</tr>';
    for (const row of data.slice(0, 50)) { // cap at 50 rows
      html += '<tr>' + keys.map(k => {
        const val = row[k];
        const display = val === null || val === undefined ? '' :
          typeof val === 'object' ? JSON.stringify(val) : String(val);
        return '<td>' + this._escapeHtml(display) + '</td>';
      }).join('') + '</tr>';
    }
    if (data.length > 50) {
      html += '<tr><td colspan="' + keys.length + '" style="text-align:center;color:var(--text-muted)">... ' + (data.length - 50) + ' more rows</td></tr>';
    }
    html += '</table></div>';
    return html;
  },

  /** Render flat object as key-value pairs */
  _renderKeyValue(data) {
    let html = '<div class="smart-result">';
    for (const [key, val] of Object.entries(data)) {
      const display = val === null || val === undefined ? '<em>null</em>' :
        typeof val === 'object' ? JSON.stringify(val) :
        typeof val === 'boolean' ? (val ? 'Yes' : 'No') :
        String(val);
      html += '<div class="smart-kv-row">' +
        '<span class="smart-kv-key">' + this._escapeHtml(this._formatKey(key)) + '</span>' +
        '<span class="smart-kv-val">' + this._escapeHtml(display) + '</span>' +
        '</div>';
    }
    html += '</div>';
    return html;
  },

  /** Render metric-like data as visual cards */
  _renderMetricCards(data) {
    let html = '<div class="smart-metrics">';
    for (const [key, val] of Object.entries(data)) {
      if (val === null || val === undefined || typeof val === 'object') continue;

      const numVal = parseFloat(val);
      const isPercent = /percent|usage|utilization|pct|%/i.test(key) ||
        (typeof val === 'string' && val.includes('%'));
      const displayVal = typeof val === 'number'
        ? (isPercent ? val.toFixed(1) + '%' : this._formatNumber(val))
        : String(val);

      // Color based on percentage thresholds
      let color = 'var(--text-primary)';
      if (isPercent && !isNaN(numVal)) {
        if (numVal > 90) color = '#ef4444';
        else if (numVal > 70) color = '#f59e0b';
        else color = '#22c55e';
      }

      html += '<div class="smart-metric-card">' +
        '<span class="smart-metric-value" style="color:' + color + '">' + this._escapeHtml(displayVal) + '</span>' +
        '<span class="smart-metric-label">' + this._escapeHtml(this._formatKey(key)) + '</span>' +
        '</div>';
    }
    html += '</div>';
    return html;
  },

  /** Render a gauge ring (circular progress) */
  _renderGauge(value, label) {
    const pct = Math.min(100, Math.max(0, value));
    const color = pct > 90 ? '#ef4444' : pct > 70 ? '#f59e0b' : '#22c55e';
    const deg = (pct / 100) * 360;
    return '<div class="smart-gauge">' +
      '<div class="smart-gauge-ring" style="background:conic-gradient(' + color + ' ' + deg + 'deg, rgba(255,255,255,0.08) ' + deg + 'deg)">' +
      pct.toFixed(0) + '%</div>' +
      '<span class="smart-gauge-label">' + this._escapeHtml(label) + '</span>' +
      '</div>';
  },

  /** Render long text as collapsible */
  _renderCollapsible(text) {
    const id = 'sc-' + Math.random().toString(36).substring(2, 8);
    const html = '<div class="smart-result">' +
      '<div class="smart-collapsible" id="' + id + '">' +
      '<pre style="margin:0;white-space:pre-wrap;font-size:0.85em">' + this._escapeHtml(text) + '</pre>' +
      '</div>' +
      '<span class="smart-toggle" onclick="SmartRender._toggle(\'' + id + '\', this)">Show more</span>' +
      '</div>';
    return { html, isRich: true };
  },

  _toggle(id, el) {
    const container = document.getElementById(id);
    if (!container) return;
    const expanded = container.classList.toggle('expanded');
    el.textContent = expanded ? 'Show less' : 'Show more';
  },

  /** Check if object looks like system metrics */
  _looksLikeMetrics(data) {
    const keys = Object.keys(data);
    const metricPatterns = /cpu|memory|mem|disk|load|usage|percent|uptime|cores|swap|network|bytes|packets|temp|frequency|speed|available|total|used|free/i;
    const metricKeyCount = keys.filter(k => metricPatterns.test(k)).length;
    return metricKeyCount >= 2 || (keys.length <= 8 && keys.some(k => typeof data[k] === 'number'));
  },

  /** Parse key: value style text (common in CLI output) */
  _parseMetrics(text) {
    const lines = text.split('\n').filter(l => l.trim());
    const kvPairs = [];
    for (const line of lines) {
      const match = line.match(/^\s*([^:]+?):\s+(.+)$/);
      if (match) kvPairs.push({ key: match[1].trim(), val: match[2].trim() });
    }
    if (kvPairs.length >= 2 && kvPairs.length / lines.length > 0.6) {
      const obj = {};
      for (const { key, val } of kvPairs) obj[key] = val;
      return { html: this._renderKeyValue(obj), isRich: true };
    }
    return null;
  },

  /** Format a camelCase or snake_case key into readable label */
  _formatKey(key) {
    return key
      .replace(/_/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, c => c.toUpperCase());
  },

  /** Format large numbers with commas */
  _formatNumber(n) {
    if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e4) return n.toLocaleString();
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(2);
  },

  // Shared escaper — safe.js loads first, so VodouSafe is always present.
  // (Old local copy skipped quotes — attribute-breakout risk.)
  _escapeHtml(t) {
    return window.VodouSafe.escapeHtml(t);
  },
};
