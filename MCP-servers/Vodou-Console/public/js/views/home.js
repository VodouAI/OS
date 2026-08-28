/**
 * Home Dashboard View — system overview, quick actions, recent activity, getting started
 */
const HomeView = {
  _pollInterval: null,

  async render(container) {
    container.innerHTML = '';
    container.appendChild(Components.loading());

    try {
      const [sysData, logsData] = await Promise.all([
        API.get('/api/system'),
        API.get('/api/logs?limit=200'),
      ]);
      container.innerHTML = '';
      await this.renderDashboardInto(container, { sysData, logsData, embedded: false });
      this._startPolling();
    } catch (err) {
      container.innerHTML = '';
      container.appendChild(Components.errorState('Failed to load dashboard: ' + err.message));
    }
  },

  /**
   * Shared dashboard body (welcome + health + actions + activity + checklist).
   * @param {{ sysData: object, logsData: object, embedded?: boolean }} opts — embedded skips hero when nested under System
   */

  /**
   * PLAN-CONSOLE-SHOWS-ITS-WORK §4.4 — "what Vodou did while you weren't looking."
   *
   * §1.1 is the test: if the user never typed anything, would the console still be
   * worth opening? Everything here was ALREADY computed and already logged — the
   * defect was that it only ever reached stderr. This is routing, not capability.
   *
   * Cards render only when their section has something to say. A grid of "0" tiles
   * would be the same silence in a smarter costume.
   */
  _renderStateHome(d) {
    const wrap = document.createElement('div');
    wrap.className = 'state-home';

    const card = (title, bodyEl, meta) => {
      const c = document.createElement('div');
      c.className = 'state-card';
      const h = document.createElement('div');
      h.className = 'state-card-head';
      h.textContent = title;
      if (meta) {
        const m = document.createElement('span');
        m.className = 'state-card-meta';
        m.textContent = meta;
        h.appendChild(m);
      }
      c.append(h, bodyEl);
      return c;
    };
    const lines = (items) => {
      const el = document.createElement('div');
      el.className = 'state-lines';
      for (const t of items) {
        const row = document.createElement('div');
        row.className = 'state-line';
        row.textContent = t;
        el.appendChild(row);
      }
      return el;
    };
    const ago = (iso) => {
      if (!iso) return '';
      // PLANS/PLAN-TIME-CANON.md — SQLite instants are NAIVE UTC
      // ('2026-08-17 05:18:55'), and Date.parse reads a naive string as LOCAL.
      // That put a briefing from an hour ago 3 hours into the FUTURE ("in 3h").
      // Values that already carry Z/offset (the scheduler's ISO strings) are
      // left alone.
      const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso);
      const t = Date.parse(hasZone ? iso : iso.replace(' ', 'T') + 'Z');
      if (!Number.isFinite(t)) return '';
      const s = Math.round((Date.now() - t) / 1000);
      if (Math.abs(s) < 90) return s >= 0 ? 'just now' : 'in <2m';
      const m = Math.round(s / 60);
      if (Math.abs(m) < 90) return m >= 0 ? `${m}m ago` : `in ${-m}m`;
      const h = Math.round(m / 60);
      if (Math.abs(h) < 36) return h >= 0 ? `${h}h ago` : `in ${-h}h`;
      return new Date(t).toLocaleDateString();
    };

    // Heartbeat — Vodou's own briefing, the single most "it did something" artifact.
    if (d.heartbeat) {
      const body = document.createElement('div');
      body.className = 'state-briefing';
      body.textContent = d.heartbeat.excerpt;
      wrap.appendChild(card('Latest briefing', body, ago(d.heartbeat.at)));
    }

    // Memory — §3.2: extraction and the janitor run constantly and the user has
    // never once seen a thing get learned.
    if (d.memory) {
      const bits = [`${d.memory.added} learned today`];
      if (d.memory.superseded) bits.push(`${d.memory.superseded} superseded`);
      bits.push(`${d.memory.total.toLocaleString()} total`);
      wrap.appendChild(card('Memory', lines(bits)));
    }

    if (d.scheduler) {
      const bits = [];
      if (d.scheduler.overdue) bits.push(`⚠ ${d.scheduler.overdue} overdue`);
      for (const n of (d.scheduler.next || []).slice(0, 3)) bits.push(`next: ${n.name} ${ago(n.at)}`);
      for (const r of (d.scheduler.recent || []).slice(0, 2)) bits.push(`ran: ${r.name} ${ago(r.at)}`);
      if (bits.length) wrap.appendChild(card('Scheduler', lines(bits), `${d.scheduler.enabled}/${d.scheduler.total} on`));
    }

    if (d.integrations && d.integrations.enabled) {
      const bits = [`${d.integrations.connected} of ${d.integrations.enabled} healthy`];
      if (d.integrations.disconnected.length) bits.push(`down: ${d.integrations.disconnected.join(', ')}`);
      wrap.appendChild(card('Integrations', lines(bits)));
    }

    if (d.board && d.board.total) {
      const bits = Object.entries(d.board.byStatus).map(([k, v]) => `${v} ${k}`);
      wrap.appendChild(card('Board', lines(bits), `${d.board.total} tasks`));
    }

    // PLAN-PROJECT-VAULTS §4.4 — what each project currently exposes, plus §4.5's
    // loud-failure invariant: a project vault with almost nothing in it promises a
    // project's brain and delivers a rounding error. Better seen here than
    // discovered when someone points a Slack room at it.
    if (d.projectVaults && d.projectVaults.vaults && d.projectVaults.vaults.length) {
      const body = document.createElement('div');
      body.className = 'state-lines';
      for (const v of d.projectVaults.vaults) {
        const row = document.createElement('div');
        row.className = 'state-line';
        row.textContent = `${v.name} — ${v.members.toLocaleString()} memories`
          + (v.thin ? '  ⚠ very few — check its pinned scopes' : '');
        if (v.thin) row.style.color = 'var(--warning, #d97706)';
        body.appendChild(row);
      }
      wrap.appendChild(card('Shared vaults', body));
    }

    if (d.library && d.library.recent && d.library.recent.length) {
      wrap.appendChild(card('Documents', lines(d.library.recent.map((r) => r.name))));
    }

    // §3.3/§4.5 — the cross-surface timeline. The dock renders these as TABS, a
    // filing metaphor answering "what surfaces exist", which is a question nobody
    // asks. This answers "what did I do today, across everything" — and no
    // competitor can render it, because nobody else has the data in one place.
    const tl = d._timeline;
    if (tl && tl.items && tl.items.length) {
      const body = document.createElement('div');
      body.className = 'state-lines';
      for (const it of tl.items.slice(0, 12)) {
        const row = document.createElement('div');
        row.className = 'state-line state-timeline-row';
        const when = document.createElement('span');
        when.className = 'state-tl-when';
        // lastAt is naive UTC from SQLite — same canon trap as ago().
        const t = Date.parse(String(it.lastAt).replace(' ', 'T') + 'Z');
        when.textContent = Number.isFinite(t)
          ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : '';
        const surf = document.createElement('span');
        surf.className = 'state-tl-surface';
        surf.textContent = it.surface;
        const title = document.createElement('span');
        title.className = 'state-tl-title';
        title.textContent = it.title;
        const n = document.createElement('span');
        n.className = 'state-tl-count';
        n.textContent = it.messages + ' msg';
        row.append(when, surf, title, n);
        body.appendChild(row);
      }
      const c = card('Today, across every surface', body,
        Object.entries(tl.bySurface).map(([k, v]) => `${v} ${k}`).join(' · '));
      c.classList.add('state-card-wide');
      wrap.appendChild(c);
    }

    // Nothing to say is a legitimate answer — say it once rather than render an
    // empty grid.
    if (!wrap.children.length) {
      const p = document.createElement('p');
      p.className = 'settings-note';
      p.textContent = 'No background activity recorded yet.';
      wrap.appendChild(p);
    }
    return wrap;
  },

  async renderDashboardInto(container, opts) {
    const sysData = opts.sysData;
    const logsData = opts.logsData || { logs: [] };
    const embedded = !!opts.embedded;
    const counts = sysData.counts || {};

    // PLAN-CONSOLE-SHOWS-ITS-WORK §4.4 — the state home leads the dashboard.
    // Hooked HERE rather than in render(), because #/home legacy-redirects to
    // #/system and system.js calls this body directly — render() never runs on
    // the path a user actually takes. Failure-tolerant: a state-home error must
    // never blank a dashboard that worked before it existed.
    try {
      const [stateData, timelineData] = await Promise.all([
        API.get('/api/home/state'),
        API.get('/api/timeline?days=1&limit=40').catch(() => null),
      ]);
      if (timelineData) stateData._timeline = timelineData;
      // PREPEND, not append: system.js renders its own header and Kernel/Runtime
      // sections BEFORE calling this body, so appending buried the state home
      // under two screens of stats. §4.4's whole claim is that this is what you
      // should see first.
      if (stateData) container.prepend(this._renderStateHome(stateData));
    } catch (e) {
      console.warn('[state-home] unavailable:', e && e.message);
    }

    if (!embedded) {
      const welcome = document.createElement('div');
      welcome.className = 'home-welcome';
      welcome.innerHTML = `
        <div>
          <h2 class="home-welcome-title">Welcome to Vodou</h2>
          <p class="home-welcome-sub">Your intelligent operating system is running. Use the sidebar to manage servers, channels, chat, and more.</p>
          <p class="home-welcome-learn">
            <a href="#/system" class="home-welcome-link">System &amp; about</a> · <a href="#/chat" class="home-welcome-link">Chat</a> · <a href="#/messaging" class="home-welcome-link">Messaging</a>
          </p>
        </div>
        <button class="btn btn-primary" id="home-go-chat">Open Chat</button>
      `;
      container.appendChild(welcome);
      document.getElementById('home-go-chat').addEventListener('click', () => {
        location.hash = '#/chat';
      });
    } else {
      const overview = document.createElement('h3');
      overview.className = 'section-title';
      overview.textContent = 'Overview';
      container.appendChild(overview);
    }

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
