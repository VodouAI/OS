/**
 * History (Activity → History) — what Vodou DID, reverse-chronological, with a
 * category filter + search. Reads work_logs.
 *
 * Not to be confused with Memory → Receipts, which reads turn_receipts and
 * answers what Vodou KNEW on a turn. The two share no id yet
 * (PLAN-TURN-IS-THE-UNIT); scheduled runs link across by task name.
 */
const LogsView = {
  currentOffset: 0,
  currentLimit: 50,
  currentCategory: '',
  currentSearch: '',
  categories: [],
  // Nine of every ten rows are tool calls and install events. Hidden by
  // default so the overnight question ("what ran?") is answered on screen one.
  NOISE: ['tool_call', 'installation'],
  showNoise: false,

  _hashParams() {
    const h = location.hash || '';
    return new URLSearchParams(h.includes('?') ? h.slice(h.indexOf('?') + 1) : '');
  },

  async render(container) {
    // Deep link: #/activity?tab=history&q=blog-freshness (from a receipt row).
    const q = this._hashParams();
    if (q.has('q')) { this.currentSearch = q.get('q') || ''; this.currentOffset = 0; }
    if (q.has('category')) { this.currentCategory = q.get('category') || ''; this.currentOffset = 0; }
    try { this.showNoise = localStorage.getItem('vodou.history.showNoise') === '1'; } catch (_) {}

    container.appendChild(Components.pageHeader('History', 'What Vodou did'));
    container.appendChild(Components.loading());

    try {
      const data = await this._fetch();
      container.innerHTML = '';

      const logsHeader = Components.pageHeader(
        'History',
        `${data.total} entries \u2014 scheduled runs, tool calls, installs, and notes from coding sessions`
      );
      logsHeader.querySelector('.page-title').appendChild(
        Components.helpTip('What Vodou did, newest first. For what it knew on a given turn, see Memory \u2192 Receipts.')
      );
      container.appendChild(logsHeader);

      this.categories = data.categories || [];

      // Controls
      container.appendChild(this._buildControls());

      // Logs list
      const listWrap = document.createElement('div');
      listWrap.id = 'logs-list-wrap';
      container.appendChild(listWrap);

      // Pagination
      const pagWrap = document.createElement('div');
      pagWrap.id = 'logs-pagination';
      container.appendChild(pagWrap);

      this._renderList(listWrap, data);
      this._renderPagination(pagWrap, data);

    } catch (err) {
      container.innerHTML = '';
      container.appendChild(Components.errorState('Failed to load logs: ' + err.message));
    }
  },

  async _fetch() {
    let url = `/api/logs?offset=${this.currentOffset}&limit=${this.currentLimit}`;
    if (this.currentCategory) url += `&category=${encodeURIComponent(this.currentCategory)}`;
    else if (!this.showNoise) url += `&exclude=${encodeURIComponent(this.NOISE.join(','))}`;
    if (this.currentSearch) url += `&search=${encodeURIComponent(this.currentSearch)}`;
    return API.get(url);
  },

  _buildControls() {
    const bar = document.createElement('div');
    bar.className = 'logs-controls';

    // Search
    const search = document.createElement('input');
    search.type = 'text';
    search.placeholder = 'Search logs...';
    search.value = this.currentSearch;
    search.className = 'logs-control-input';
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

    // Category filter
    const select = document.createElement('select');
    select.className = 'logs-control-select';
    select.innerHTML = '<option value="">All Categories</option>';
    for (const c of this.categories) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      if (c === this.currentCategory) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      this.currentCategory = select.value;
      this.currentOffset = 0;
      this._refresh();
    });
    bar.appendChild(select);

    // Noise toggle — a picked category always shows, whatever the toggle says.
    const noise = document.createElement('label');
    noise.className = 'logs-noise-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this.showNoise;
    cb.addEventListener('change', () => {
      this.showNoise = cb.checked;
      try { localStorage.setItem('vodou.history.showNoise', cb.checked ? '1' : '0'); } catch (_) {}
      this.currentOffset = 0;
      this._refresh();
    });
    noise.appendChild(cb);
    noise.appendChild(document.createTextNode(' show tool calls and installs'));
    noise.title = 'Every MCP tool call and server install is logged. They are most of the rows and rarely what you came for.';
    bar.appendChild(noise);

    return bar;
  },

  async _refresh() {
    try {
      const data = await this._fetch();
      const listWrap = document.getElementById('logs-list-wrap');
      const pagWrap = document.getElementById('logs-pagination');
      if (listWrap) this._renderList(listWrap, data);
      if (pagWrap) this._renderPagination(pagWrap, data);
    } catch (err) {
      Components.toast('Refresh failed: ' + err.message, 'error');
    }
  },

  _renderList(wrap, data) {
    wrap.innerHTML = '';
    const logs = data.logs || [];

    if (logs.length === 0) {
      wrap.appendChild(Components.emptyState(this.showNoise || this.currentCategory
        ? 'Nothing matches these filters. Entries appear automatically as you use Vodou.'
        : 'Nothing besides tool calls and installs matches. Tick "show tool calls and installs" to see those.'));
      return;
    }

    const categoryColors = {
      tool_call: 'accent',
      feature: 'success',
      bugfix: 'error',
      analysis: 'default',
      general: 'default',
      performance: 'accent',
      security: 'error',
      config: 'default',
      maintenance: 'default',
    };

    for (const log of logs) {
      const row = document.createElement('div');
      row.className = 'logs-row';

      // Timestamp
      const ts = document.createElement('span');
      ts.className = 'logs-ts';
      ts.textContent = this._formatTimestamp(log.timestamp);
      row.appendChild(ts);

      // Category badge
      const catBadge = Components.badge(log.category || 'general', categoryColors[log.category] || 'default');
      catBadge.classList.add('logs-cat-badge');
      row.appendChild(catBadge);

      // Source badge (small)
      if (log.source && log.source !== 'bt4') {
        const srcBadge = Components.badge(log.source, 'default');
        srcBadge.classList.add('logs-src-badge');
        row.appendChild(srcBadge);
      }

      // Message
      const msg = document.createElement('span');
      msg.className = 'logs-msg';
      msg.textContent = log.message;
      row.appendChild(msg);

      // A scheduled run has a twin in Memory → Receipts (what reached the AI
      // on that run). No shared id yet — the task name is the bridge; the
      // Receipts tab narrows to that skill's conversation.
      const task = this._scheduledTaskName(log);
      if (task) {
        const link = document.createElement('a');
        link.className = 'logs-receipt-link';
        link.href = '#/memory?tab=receipts&lane=skill-console&q=' + encodeURIComponent(task);
        link.textContent = 'receipt';
        link.title = 'What memory reached the AI on this run (Memory \u2192 Receipts)';
        row.appendChild(link);
      }

      wrap.appendChild(row);
    }
  },

  /**
   * `[scheduler] Ran task "skill:morning-briefing" (task_id:26): ok (…)` →
   * morning-briefing. Only skill tasks get a receipt: they are the ones that
   * run an LLM turn (receipts live under workbench:skill-console:<name>). A
   * plain mcp_tool task like blog-freshness never reaches the AI, so it has
   * nothing to link to.
   */
  _scheduledTaskName(log) {
    if (!log || log.category !== 'scheduler' || typeof log.message !== 'string') return null;
    const m = /Ran task "skill:([^"]+)"/.exec(log.message);
    return m ? m[1] : null;
  },

  _renderPagination(wrap, data) {
    wrap.innerHTML = '';
    if (data.total <= data.limit) return;

    const pag = Components.pagination(
      data.offset,
      data.limit,
      data.total,
      (newOffset) => {
        this.currentOffset = newOffset;
        this._refresh();
      }
    );
    wrap.appendChild(pag);
  },

  _formatTimestamp(ts) {
    if (!ts) return '—';
    try {
      // SQLite CURRENT_TIMESTAMP is UTC — append 'Z' so JS Date parses it as UTC
      // then VodouTime renders it in the PERSON's zone, not the browser's
      const normalized = ts.includes('T') || ts.includes('Z') ? ts : ts.replace(' ', 'T') + 'Z';
      const d = new Date(normalized);
      if (isNaN(d.getTime())) return ts;
      const now = new Date();
      const diff = now - d;

      // Today / Yesterday: said in words, and decided on the person's clock —
      // the same one the time is rendered on. A bare time with no day read as
      // "missing a date" right after midnight, beside rows that carried one.
      const day = window.VodouTime.dayLabel(d, now);
      if (day === 'Today') {
        return `Today, ${window.VodouTime._fmt(d, { hour: '2-digit', minute: '2-digit', second: '2-digit' }, '')}`;
      }
      if (day === 'Yesterday') {
        return `Yesterday, ${window.VodouTime.time(d, '')}`;
      }
      // This week: show day + time
      if (diff < 604800000) {
        return window.VodouTime.dateTime(d, '');
      }
      // Older
      return window.VodouTime.full(d, '');
    } catch {
      return ts;
    }
  },
};
