/**
 * Activity shell — Scheduled | Automations | History
 * Hash: #/activity?tab=scheduled|automations|history
 */
const ActivityView = {
  // 0.6.31 — Board lives here (brief §4: a kanban of what agents are doing IS
  // activity). BoardView keeps its own timers, so its destroy() runs when this
  // host is torn down or another tab is chosen.
  _mounted: null,
  destroy() {
    if (this._mounted && typeof this._mounted.destroy === 'function') {
      try { this._mounted.destroy(); } catch (_) {}
    }
    this._mounted = null;
  },

  TABS: [
    { id: 'history', label: 'History' },
    { id: 'scheduled', label: 'Scheduled' },
    { id: 'automations', label: 'Automations' },
    { id: 'board', label: 'Board' },
  ],

  _activeTab() {
    const q = location.hash.includes('?') ? location.hash.split('?')[1] : '';
    const tab = new URLSearchParams(q).get('tab') || 'history';
    const allowed = new Set(this.TABS.map(t => t.id));
    return allowed.has(tab) ? tab : 'history';
  },

  async render(container) {
    const tab = this._activeTab();
    container.innerHTML = '';

    const bar = document.createElement('div');
    bar.className = 'settings-tab-bar activity-tab-bar';
    bar.setAttribute('role', 'tablist');
    for (const t of this.TABS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'settings-tab' + (t.id === tab ? ' active' : '');
      btn.textContent = t.label;
      btn.dataset.tab = t.id;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', t.id === tab ? 'true' : 'false');
      btn.addEventListener('click', () => {
        const next = `#/activity?tab=${encodeURIComponent(t.id)}`;
        if (location.hash !== next) location.hash = next;
        else void this._mountPanel(panel, t.id);
      });
      bar.appendChild(btn);
    }
    container.appendChild(bar);

    const panel = document.createElement('div');
    panel.id = 'activity-tab-panel';
    panel.className = 'activity-tab-panel';
    container.appendChild(panel);

    await this._mountPanel(panel, tab);
  },

  async _mountPanel(panel, tab) {
    panel.innerHTML = '';
    if (this._mounted && typeof this._mounted.destroy === 'function') {
      try { this._mounted.destroy(); } catch (_) {}
    }
    this._mounted = null;
    if (tab === 'history') { await LogsView.render(panel); this._mounted = LogsView; }
    else if (tab === 'automations') { await AutomationsView.render(panel); this._mounted = AutomationsView; }
    else if (tab === 'board') {
      if (typeof BoardView !== 'undefined') { await BoardView.render(panel); this._mounted = BoardView; }
      else panel.innerHTML = '<div class="empty-state">Board not loaded</div>';
    }
    else { await SchedulerView.render(panel); this._mounted = SchedulerView; }

    const bar = panel.previousElementSibling;
    if (bar && bar.classList.contains('activity-tab-bar')) {
      bar.querySelectorAll('.settings-tab').forEach(b => {
        const on = b.dataset.tab === tab;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
  },
};

if (typeof Router !== 'undefined') {
  Router.register('/activity', (el) => ActivityView.render(el), ActivityView);
}
