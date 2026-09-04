/**
 * Work Logs View — reverse-chronological with category filter + search
 */
const LogsView = {
  currentOffset: 0,
  currentLimit: 50,
  currentCategory: '',
  currentSearch: '',
  categories: [],

  async render(container) {
    container.appendChild(Components.pageHeader('Work Logs', 'Session activity and history'));
    container.appendChild(Components.loading());

    try {
      const data = await this._fetch();
      container.innerHTML = '';

      const logsHeader = Components.pageHeader(
        'Work Logs',
        `${data.total} log entries`
      );
      logsHeader.querySelector('.page-title').appendChild(
        Components.helpTip('A history of everything Vodou has done \u2014 tasks completed, errors, and activity over time.')
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
      wrap.appendChild(Components.emptyState('No logs match your filters. Logs appear automatically as you use Vodou.'));
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

      wrap.appendChild(row);
    }
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
      // then toLocaleTimeString() converts to user's local timezone
      const normalized = ts.includes('T') || ts.includes('Z') ? ts : ts.replace(' ', 'T') + 'Z';
      const d = new Date(normalized);
      if (isNaN(d.getTime())) return ts;
      const now = new Date();
      const diff = now - d;

      // Today: show time only
      if (d.toDateString() === now.toDateString()) {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      }
      // This week: show day + time
      if (diff < 604800000) {
        return d.toLocaleDateString([], { weekday: 'short' }) + ' ' +
               d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      // Older
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return ts;
    }
  },
};
