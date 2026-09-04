/**
 * Capabilities shell — Skills | Scripts | Routing rules (MCP Servers moved to Connect, 0.6.31)
 * Hash: #/capabilities?tab=skills|tools|scripts|routing-rules
 */
const CapabilitiesView = {
  destroy() {},

  TABS: [
    { id: 'skills', label: 'Skills' },
    // 0.6.31 — 'tools' (MCP Servers) lives under Connect; the router redirects.
    { id: 'scripts', label: 'Scripts' },
    { id: 'routing-rules', label: 'Routing rules' },
  ],

  _activeTab() {
    const q = location.hash.includes('?') ? location.hash.split('?')[1] : '';
    const tab = new URLSearchParams(q).get('tab') || 'skills';
    const allowed = new Set(this.TABS.map(t => t.id));
    return allowed.has(tab) ? tab : 'skills';
  },

  async render(container) {
    const tab = this._activeTab();
    container.innerHTML = '';

    const bar = document.createElement('div');
    bar.className = 'settings-tab-bar capabilities-tab-bar';
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
        const next = `#/capabilities?tab=${encodeURIComponent(t.id)}`;
        if (location.hash !== next) location.hash = next;
        else void this._mountPanel(panel, t.id);
      });
      bar.appendChild(btn);
    }
    container.appendChild(bar);

    const panel = document.createElement('div');
    panel.id = 'capabilities-tab-panel';
    panel.className = 'capabilities-tab-panel';
    container.appendChild(panel);

    await this._mountPanel(panel, tab);

    const tabMeta = this.TABS.find((t) => t.id === tab);
    document.title = window.VODOU_TITLE || 'VODOU - ALPHA';
  },

  async _mountPanel(panel, tab) {
    panel.innerHTML = '';
    if (tab === 'tools') await ServersView.render(panel);
    else if (tab === 'skills') await SkillsView.render(panel);
    else if (tab === 'routing-rules') await IntentsView.render(panel);
    else if (tab === 'scripts') await ScriptsView.render(panel);

    const bar = panel.previousElementSibling;
    if (bar && bar.classList.contains('capabilities-tab-bar')) {
      bar.querySelectorAll('.settings-tab').forEach(b => {
        const on = b.dataset.tab === tab;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
  },
};

if (typeof Router !== 'undefined') {
  Router.register('/capabilities', (el) => CapabilitiesView.render(el), CapabilitiesView);
}
