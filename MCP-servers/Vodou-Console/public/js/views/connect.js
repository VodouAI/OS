/**
 * Connect — Messaging | Apps | MCP servers (brief §4: one outcome, one destination).
 * Hash: #/connect?tab=messaging|apps|servers
 * Same host pattern as CapabilitiesView / ActivityView: the tab bar is the only
 * thing this file owns; each panel is the existing view, unchanged.
 */
const ConnectView = {
  destroy() {},

  TABS: [
    { id: 'messaging', label: 'Messaging' },
    { id: 'apps', label: 'Apps' },
    { id: 'servers', label: 'MCP servers' },
  ],

  _activeTab() {
    const q = location.hash.includes('?') ? location.hash.split('?')[1] : '';
    const tab = new URLSearchParams(q).get('tab') || 'messaging';
    const allowed = new Set(this.TABS.map((t) => t.id));
    return allowed.has(tab) ? tab : 'messaging';
  },

  async render(container) {
    const tab = this._activeTab();
    container.innerHTML = '';

    const bar = document.createElement('div');
    bar.className = 'settings-tab-bar connect-tab-bar';
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
        const next = `#/connect?tab=${encodeURIComponent(t.id)}`;
        if (location.hash !== next) location.hash = next;
        else void this._mountPanel(panel, t.id);
      });
      bar.appendChild(btn);
    }
    container.appendChild(bar);

    const panel = document.createElement('div');
    panel.id = 'connect-tab-panel';
    panel.className = 'connect-tab-panel';
    container.appendChild(panel);

    await this._mountPanel(panel, tab);
    document.title = window.VODOU_TITLE || 'VODOU - ALPHA';
  },

  async _mountPanel(panel, tab) {
    panel.innerHTML = '';
    const mount = async (View, name) => {
      if (typeof View === 'undefined' || typeof View.render !== 'function') {
        panel.innerHTML = '<div class="empty-state">' + name + ' is not loaded</div>';
        return;
      }
      await View.render(panel);
    };
    if (tab === 'messaging') await mount(typeof ChannelsView !== 'undefined' ? ChannelsView : undefined, 'Messaging');
    else if (tab === 'apps') await mount(typeof AppsView !== 'undefined' ? AppsView : undefined, 'Apps');
    else if (tab === 'servers') await mount(typeof ServersView !== 'undefined' ? ServersView : undefined, 'MCP servers');

    const bar = panel.previousElementSibling;
    if (bar && bar.classList.contains('connect-tab-bar')) {
      bar.querySelectorAll('.settings-tab').forEach((b) => {
        const on = b.dataset.tab === tab;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
  },
};

if (typeof Router !== 'undefined') {
  Router.register('/connect', (el) => ConnectView.render(el), ConnectView);
}
