/**
 * Home Dashboard View — system overview, quick actions, recent activity, getting started
 */
const HomeView = {
  _pollInterval: null,

  // FE-6: `HomeView.render()` used to be the standalone `#/home` dashboard, with
  // its own "Welcome to Vodou" hero. `#/home` has legacy-redirected to `#/system`
  // since the redesign, so the only callers left were setup.js's Finish and Skip
  // buttons — and they rendered it into `#main-content` and set `location.hash`
  // in the same breath, racing the router's own render of `#/system`. Whichever
  // API call returned last won the container. Deleted; setup navigates and lets
  // the router render, which is the one path every other view already takes.


  // The PLAN-CONSOLE-SHOWS-ITS-WORK §4.4 "state home" (briefing excerpt, memory /
  // scheduler / integrations / board counts, vaults, documents, cross-surface
  // timeline) used to be prepended here. Removed 2026-09-09: every card but one
  // duplicated a surface that already existed (the briefing renders properly in
  // Chat's Vodou tab; the counts are the sidebar's state dots and their own pages;
  // vaults and documents are Memory's), and it made System — a diagnostics page —
  // open on a dashboard it had nothing to do with. The one card with no other
  // home, the cross-surface timeline, now lives under the briefing in Chat's
  // Vodou tab (`chat.js` `_loadTodayTimeline`), which is the surface §1.1 wanted.

  /**
   * The dashboard body, rendered into the System view.
   * @param {{ sysData: object, logsData: object }} opts
   */
  async renderDashboardInto(container, opts) {
    const sysData = opts.sysData;
    const logsData = opts.logsData || { logs: [] };
    const counts = sysData.counts || {};

    const overview = document.createElement('h3');
    overview.className = 'section-title';
    overview.textContent = 'Overview';
    container.appendChild(overview);

    // Top row: Health + Quick Actions
    const topRow = document.createElement('div');
      topRow.className = 'home-top-row';

      // System Health
      const healthCard = document.createElement('div');
      healthCard.className = 'home-card';
      healthCard.id = 'home-health-card';

      const healthTitle = document.createElement('div');
      healthTitle.className = 'home-card-title';
      healthTitle.id = 'home-health-title';
      healthTitle.innerHTML = '<span class="status-pulse green"></span>System Health';
      healthCard.appendChild(healthTitle);

      // Fetch tool count from orchestration API
      let toolCount = 0;
      try {
        const toolsData = await API.get('/api/tools');
        toolCount = toolsData.count || 0;
      } catch {}

      const healthItems = [
        { label: 'Servers', value: counts.mcp_servers || 0, href: '#/capabilities?tab=tools', id: 'health-servers' },
        { label: 'Tools', value: toolCount, href: '#/capabilities?tab=tools', id: 'health-tools' },
        { label: 'Skills', value: counts.skills_registry || 0, href: '#/capabilities?tab=skills', id: 'health-skills' },
        { label: 'Intents', value: counts.intent_mappings || 0, href: '#/capabilities?tab=routing-rules', id: 'health-intents' },
        { label: 'Uptime', value: this._formatUptime(sysData.uptime), href: '#/system', id: 'health-uptime' },
        {
          label: 'Mem health',
          value: sysData.memoryHealth?.pct != null
            ? `${Math.round(sysData.memoryHealth.pct)}%`
            : '—',
          href: '#/system',
          id: 'health-mem',
        },
      ];

      const healthGrid = document.createElement('div');
      healthGrid.className = 'home-health-grid';
      for (const item of healthItems) {
        const el = document.createElement('a');
        el.className = 'home-health-item';
        el.href = item.href;
        el.innerHTML = `
          <span class="home-health-value" id="${item.id}">${item.value}</span>
          <span class="home-health-label">${item.label}</span>
        `;
        healthGrid.appendChild(el);
      }
      healthCard.appendChild(healthGrid);
      topRow.appendChild(healthCard);

      // Quick Actions
      const actionsCard = document.createElement('div');
      actionsCard.className = 'home-card';
      actionsCard.innerHTML = `<div class="home-card-title">Quick Actions</div>`;

      const actions = [
        { label: 'Add Server', href: '#/capabilities?tab=tools', icon: '+' },
        { label: 'Messaging', href: '#/messaging', icon: '📢' },
        { label: 'Browse Memory', href: '#/memory', icon: 'M' },
        { label: 'Open Terminal', href: '#/terminal', icon: '>' },
        { label: 'Ask Vodou Something', href: '#/chat', icon: '?' },
      ];

      const actionsGrid = document.createElement('div');
      actionsGrid.className = 'home-actions-grid';
      for (const action of actions) {
        const btn = document.createElement('a');
        btn.href = action.href;
        btn.className = 'home-action-btn';
        btn.innerHTML = `<span class="home-action-icon">${action.icon}</span><span>${action.label}</span>`;
        actionsGrid.appendChild(btn);
      }
      actionsCard.appendChild(actionsGrid);
      topRow.appendChild(actionsCard);

      container.appendChild(topRow);

      // Recent Activity
      const activityCard = document.createElement('div');
      activityCard.className = 'home-card';
      activityCard.innerHTML = `<div class="home-card-title">Recent Activity</div>`;

      const logs = logsData.logs || [];
      if (logs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'home-activity-empty';
        empty.textContent = 'No activity recorded yet. Start chatting with Vodou to see activity here.';
        activityCard.appendChild(empty);
      } else {
        const summary = this._buildActivitySummary(logs);
        const summaryEl = document.createElement('div');
        summaryEl.className = 'home-activity-summary';
        for (const line of summary) {
          const row = document.createElement('a');
          row.className = 'home-activity-row';
          row.href = '#/activity?tab=history';
          row.innerHTML = `<span class="home-activity-date">${line.label}</span><span class="home-activity-text">${line.text}</span>`;
          summaryEl.appendChild(row);
        }
        activityCard.appendChild(summaryEl);
      }
      container.appendChild(activityCard);

      // Getting Started checklist
      const checklist = this._buildChecklist(counts, logs);
      const complete = checklist.filter(c => c.done).length;
      if (complete < checklist.length && !localStorage.getItem('vodou-getting-started-dismissed')) {
        const startedCard = document.createElement('div');
        startedCard.className = 'home-card';

        const startedHeader = document.createElement('div');
        startedHeader.className = 'home-started-header';
        startedHeader.innerHTML = `<div class="home-card-title">Getting Started</div>`;

        const dismissBtn = document.createElement('button');
        dismissBtn.className = 'btn btn-sm';
        dismissBtn.textContent = 'Dismiss';
        dismissBtn.addEventListener('click', () => {
          localStorage.setItem('vodou-getting-started-dismissed', '1');
          startedCard.remove();
        });
        startedHeader.appendChild(dismissBtn);
        startedCard.appendChild(startedHeader);

        const checklistEl = document.createElement('div');
        checklistEl.className = 'home-checklist';
        for (const item of checklist) {
          const row = document.createElement('div');
          row.className = 'home-checklist-item' + (item.done ? ' done' : '');
          row.innerHTML = `
            <span class="home-check">${item.done ? '&#10003;' : ''}</span>
            <span class="home-checklist-label">${item.label}</span>
            ${item.href && !item.done ? '<span class="home-checklist-arrow">&#8594;</span>' : ''}
          `;
          if (item.href && !item.done) {
            row.classList.add('home-checklist-clickable');
            row.addEventListener('click', () => { location.hash = item.href; });
          }
          checklistEl.appendChild(row);
        }
        startedCard.appendChild(checklistEl);
        container.appendChild(startedCard);
      }

  },

  destroy() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  },

  _startPolling() {
    this.destroy(); // Clear any existing
    this._pollInterval = setInterval(() => this._refreshHealth(), 30000);
  },

  async _refreshHealth() {
    try {
      const data = await API.get('/api/system');
      const counts = data.counts || {};

      // Update values in-place
      const el = (id, val) => {
        const e = document.getElementById(id);
        if (e) e.textContent = val;
      };
      el('health-servers', counts.mcp_servers || 0);
      el('health-skills', counts.skills_registry || 0);
      el('health-intents', counts.intent_mappings || 0);
      el('health-uptime', this._formatUptime(data.uptime));
      // Refresh tools count
      try {
        const toolsData = await API.get('/api/tools');
        el('health-tools', toolsData.count || 0);
      } catch {}

      // Update pulse color based on alerts
      try {
        const alertData = await API.get('/api/system/alerts');
        const titleEl = document.getElementById('home-health-title');
        if (titleEl) {
          const alerts = alertData.alerts || [];
          const hasError = alerts.some(a => a.level === 'error');
          const hasWarning = alerts.length > 0;
          const pulse = titleEl.querySelector('.status-pulse');
          if (pulse) {
            pulse.className = 'status-pulse ' + (hasError ? 'red' : hasWarning ? 'yellow' : 'green');
          }
        }
      } catch {}
    } catch {}
  },

  _formatUptime(seconds) {
    if (!seconds) return '0s';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  },

  _buildActivitySummary(logs) {
    const now = new Date();
    const today = now.toDateString();
    const yesterday = new Date(now - 86400000).toDateString();

    const buckets = { today: [], yesterday: [], week: [] };
    for (const log of logs) {
      const ts = log.timestamp;
      const normalized = ts.includes('T') || ts.includes('Z') ? ts : ts.replace(' ', 'T') + 'Z';
      const d = new Date(normalized);
      const ds = d.toDateString();
      if (ds === today) buckets.today.push(log);
      else if (ds === yesterday) buckets.yesterday.push(log);
      else if (now - d < 7 * 86400000) buckets.week.push(log);
    }

    const summary = [];
    if (buckets.today.length > 0) {
      const cats = this._countCategories(buckets.today);
      summary.push({ label: 'Today', text: cats });
    }
    if (buckets.yesterday.length > 0) {
      const cats = this._countCategories(buckets.yesterday);
      summary.push({ label: 'Yesterday', text: cats });
    }
    if (buckets.week.length > 0) {
      summary.push({ label: 'This week', text: `${buckets.week.length} log entries` });
    }
    if (summary.length === 0) {
      summary.push({ label: 'Recent', text: `${logs.length} total log entries` });
    }
    return summary;
  },

  _countCategories(logs) {
    const counts = {};
    for (const l of logs) {
      const cat = l.category || 'general';
      counts[cat] = (counts[cat] || 0) + 1;
    }
    const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}`);
    return parts.join(', ');
  },

  _buildChecklist(counts, logs) {
    return [
      { label: 'System running', done: true },
      { label: 'MCP servers connected', done: (counts.mcp_servers || 0) > 0, href: '#/capabilities?tab=tools' },
      { label: 'Try chatting with Vodou', done: (counts.conversation_sessions || 0) > 0 || logs.length > 0, href: '#/chat' },
      { label: 'Create a scheduled task', done: (counts.scheduled_tasks || 0) > 0, href: '#/activity?tab=scheduled' },
    ];
  },
};
