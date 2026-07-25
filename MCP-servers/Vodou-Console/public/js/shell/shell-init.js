/**
 * Shell v2 — desktop-style chrome (menu bar + Dock).
 *
 * Plan: PLANS/0.5.38/PLAN-VODOU-CONSOLE-MACOS-SHELL.md
 *
 * Activation (default ON as of 2026-05-04 — opt-out via ?shell=0):
 *   - default: ON (no setting needed)
 *   - URL ?shell=0 → off (persists)
 *   - URL ?shell=1 → explicitly on (persists; same as default)
 *   - localStorage 'vodou-shell-v2' = '0' → off
 *   - localStorage 'vodou-shell-v2' = '1' or absent → on
 *
 * Strategy for the experiment: zero changes to existing DOM/JS producers.
 * We append a menubar header, decorate the existing #global-chat-tabs-bar as
 * the Dock (CSS-only), and mirror the existing model/memory/WS indicator DOM
 * into the menubar via MutationObserver → IndicatorBus.
 */
(function () {
  'use strict';

  // ─── Activation ─────────────────────────────────────────────────────────────
  const params = new URLSearchParams(location.search);
  if (params.get('shell') === '1') {
    try { localStorage.setItem('vodou-shell-v2', '1'); } catch {}
  } else if (params.get('shell') === '0') {
    try { localStorage.setItem('vodou-shell-v2', '0'); } catch {}
  }
  // Default ON: only OFF if explicitly opted out.
  let enabled = true;
  try {
    if (localStorage.getItem('vodou-shell-v2') === '0') enabled = false;
  } catch {}
  if (!enabled) return;

  document.documentElement.classList.add('shell-v2');
  document.body && document.body.classList.add('shell-v2');
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', () => document.body.classList.add('shell-v2'), { once: true });
  }

  // ─── Menubar markup ─────────────────────────────────────────────────────────
  const MENUS = [
    { id: 'vodou', label: 'Vodou', items: [
      { label: 'About Vodou',         hash: '#/settings?tab=about' },
      { label: 'System status',       hash: '#/system' },
      { sep: true },
      { label: 'Settings…',           hash: '#/settings?tab=profile' },
    ]},
    { id: 'view', label: 'View', items: [
      { label: 'Toggle theme',        action: 'toggle-theme' },
      { label: 'Toggle sidebar',      action: 'toggle-sidebar' },
      { label: 'Dock at bottom',      action: 'dock-toggle' },
      { sep: true },
      { label: 'Reload',              action: 'reload' },
    ]},
    { id: 'window', label: 'Window', items: [
      { label: 'Chat',                hash: '#/chat' },
      { label: 'Memory',              hash: '#/memory' },
      { label: 'Kanban board',        hash: '#/board' },
      { label: 'Apps',                hash: '#/apps' },
      { label: 'Messaging',           hash: '#/messaging' },
      { label: 'Capabilities',        hash: '#/capabilities?tab=skills' },
      { label: 'Activity',            hash: '#/activity?tab=scheduled' },
      { label: 'Settings',            hash: '#/settings?tab=profile' },
      { label: 'Terminal',            hash: '#/terminal' },
    ]},
    { id: 'help', label: 'Help', items: [
      { label: 'Documentation',       hash: '#/docs' },
      { label: 'Keyboard shortcuts',  action: 'shortcuts' },
      { sep: true },
      { label: 'Open command palette',action: 'open-palette' },
    ]},
  ];

  function buildMenubar() {
    const bar = document.createElement('header');
    bar.id = 'shell-menubar';
    bar.className = 'shell-menubar';
    bar.setAttribute('role', 'menubar');

    // Left: menus only — the first menu's trigger renders the Vodou logo instead
    // of the word "Vodou", so clicking the logo opens the dropdown (no separate brand button).
    const left = document.createElement('div');
    left.className = 'shell-menubar-left';

    for (const m of MENUS) {
      const wrap = document.createElement('div');
      wrap.className = 'shell-menu' + (m.id === 'vodou' ? ' shell-menu-brand' : '');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'shell-menu-trigger' + (m.id === 'vodou' ? ' shell-menu-trigger-brand' : '');
      if (m.id === 'vodou') {
        btn.innerHTML = '<img src="/icons/vodou-logo.png" alt="Vodou" class="shell-brand-logo" onerror="this.outerHTML=\'<span style=&quot;font-size:14px&quot;>🔮</span>\'" />';
        btn.setAttribute('aria-label', 'Vodou menu');
      } else {
        btn.textContent = m.label;
      }
      btn.setAttribute('aria-haspopup', 'true');
      btn.setAttribute('aria-expanded', 'false');
      const list = document.createElement('div');
      list.className = 'shell-menu-list';
      list.setAttribute('role', 'menu');
      for (const it of m.items) {
        if (it.sep) {
          const s = document.createElement('div');
          s.className = 'shell-menu-sep';
          list.appendChild(s);
          continue;
        }
        const a = document.createElement('button');
        a.type = 'button';
        a.className = 'shell-menu-item';
        a.setAttribute('role', 'menuitem');
        a.textContent = it.label;
        a.addEventListener('click', () => {
          closeAllMenus();
          if (it.hash) location.hash = it.hash;
          else if (it.action) handleAction(it.action);
        });
        list.appendChild(a);
      }
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const open = wrap.classList.toggle('is-open');
        btn.setAttribute('aria-expanded', String(open));
        if (open) closeOtherMenus(wrap);
      });
      btn.addEventListener('mouseenter', () => {
        // If any other menu is open, follow the macOS-style behavior of switching focus
        const anyOpen = bar.querySelector('.shell-menu.is-open');
        if (anyOpen && anyOpen !== wrap) {
          closeAllMenus();
          wrap.classList.add('is-open');
          btn.setAttribute('aria-expanded', 'true');
        }
      });
      wrap.appendChild(btn);
      wrap.appendChild(list);
      left.appendChild(wrap);
    }

    // Center: route title
    const center = document.createElement('div');
    center.className = 'shell-menubar-center';
    center.id = 'shell-menubar-title';

    // Right: status cluster (mirrors of existing indicators)
    const right = document.createElement('div');
    right.className = 'shell-menubar-right';
    right.innerHTML = `
      <a class="shell-status shell-status-kernel" id="shell-ind-kernel" href="#/system" title="Kernel status"><span class="shell-status-dot shell-kernel-dot" data-state="unknown"></span><span class="shell-status-text">…</span></a>
      <a class="shell-status shell-status-memory" id="shell-ind-memory" href="#/memory" title="Memory — what Vodou remembers"><span class="shell-status-icon shell-mem-icon"></span><span class="shell-status-text">—</span></a>
      <a class="shell-status shell-status-model" id="shell-ind-model" href="#/settings?tab=model" title="Active LLM model — click to change"><span class="shell-status-icon shell-model-icon"></span><span class="shell-status-text">—</span></a>
      <button type="button" class="shell-status shell-status-palette" id="shell-ind-palette" title="Command palette (${window.vodouModChord ? window.vodouModChord('K') : '⌘K'})"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button>
      <button type="button" class="shell-status shell-status-help" id="shell-ind-help" title="Help &amp; guided tour"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></button>
    `;

    bar.appendChild(left);
    bar.appendChild(center);
    bar.appendChild(right);

    // Wire the palette pill — opens the command palette overlay
    setTimeout(() => {
      const paletteBtn = bar.querySelector('#shell-ind-palette');
      if (paletteBtn) paletteBtn.addEventListener('click', openPalette);
      const helpBtn = bar.querySelector('#shell-ind-help');
      if (helpBtn) helpBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.OnboardingTour) window.OnboardingTour.openHelpMenu(helpBtn);
      });
    }, 0);

    return bar;
  }

  function closeAllMenus() {
    document.querySelectorAll('#shell-menubar .shell-menu.is-open').forEach((el) => {
      el.classList.remove('is-open');
      el.querySelector('.shell-menu-trigger')?.setAttribute('aria-expanded', 'false');
    });
  }
  function closeOtherMenus(keep) {
    document.querySelectorAll('#shell-menubar .shell-menu.is-open').forEach((el) => {
      if (el === keep) return;
      el.classList.remove('is-open');
      el.querySelector('.shell-menu-trigger')?.setAttribute('aria-expanded', 'false');
    });
  }

  function handleAction(action) {
    switch (action) {
      case 'toggle-theme':
        document.getElementById('theme-toggle')?.click();
        break;
      case 'toggle-sidebar':
        document.body.classList.toggle('shell-sidebar-collapsed');
        try { localStorage.setItem('vodou-shell-sidebar-collapsed', document.body.classList.contains('shell-sidebar-collapsed') ? '1' : '0'); } catch {}
        break;
      case 'reload':
        location.reload();
        break;
      case 'dock-toggle': {
        const next = !document.body.classList.contains('dock-bottom');
        document.body.classList.toggle('dock-bottom', next);
        try { localStorage.setItem('vodou-shell-dock-pos', next ? 'bottom' : 'top'); } catch {}
        // Reflect in menu label without re-rendering the whole menu
        document.querySelectorAll('#shell-menubar .shell-menu-item').forEach((el) => {
          if (/^Dock at /.test(el.textContent || '')) el.textContent = next ? 'Dock at top' : 'Dock at bottom';
        });
        break;
      }
      case 'open-palette':
        openPalette();
        break;
      case 'shortcuts':
        { const M = window.vodouModKey ? window.vodouModKey() : '⌘';
          const j = (k) => (M === '⌘' ? '⌘' + k : 'Ctrl+' + k);
          alert(`Shortcuts:\n\n${j('K')} — Command palette\n${j('.')} — Command palette (same)\n${j('B')} — Toggle sidebar\n${j(',')} — Settings\nEsc — Close menus / palette`); }
        break;
    }
  }

  function openPalette() {
    // Existing CommandPalette uses class `visible` (not `is-open`) and is
    // accessible via the global `CommandPalette` symbol (declared in command-palette.js
    // as a top-level const — visible to other classic scripts).
    try {
      if (typeof CommandPalette !== 'undefined' && typeof CommandPalette.open === 'function') {
        CommandPalette.open();
        return;
      }
    } catch {}
    // Fallback: directly add the .visible class the palette CSS responds to
    const overlay = document.getElementById('cmd-palette-overlay');
    if (overlay) {
      overlay.classList.add('visible');
      document.getElementById('cmd-palette-input')?.focus();
    }
  }

  // ─── Indicator mirroring (MutationObserver → IndicatorBus → menubar) ─────────
  function mirrorIndicators() {
    const Bus = window.IndicatorBus;
    if (!Bus) return;

    const memSrc = document.getElementById('chat-memory-indicator');
    const modSrc = document.getElementById('chat-model-indicator');
    const wsSrc  = document.getElementById('ws-status');
    const wsTxt  = document.getElementById('ws-status-text');

    const memDst = document.querySelector('#shell-ind-memory .shell-status-text');
    const modDst = document.querySelector('#shell-ind-model .shell-status-text');
    const wsDot  = document.querySelector('#shell-ind-ws .shell-status-dot');
    const wsDst  = document.querySelector('#shell-ind-ws .shell-status-text');

    function syncMemory() {
      if (!memSrc) return;
      const txt = (memSrc.textContent || '').replace(/^[^\d]*/, '').trim();
      const tip = memSrc.getAttribute('title') || '';
      Bus.publish('memory', { text: txt || '0', title: tip });
    }
    function syncModel() {
      if (!modSrc) return;
      Bus.publish('model', { text: (modSrc.textContent || '').trim(), title: modSrc.getAttribute('title') || '' });
    }
    function syncWs() {
      if (!wsSrc) return;
      const cls = wsSrc.className || '';
      const state = cls.includes('connected') && !cls.includes('disconnected') ? 'connected'
        : cls.includes('disconnected') ? 'disconnected'
        : 'connecting';
      Bus.publish('ws', { state, text: (wsTxt?.textContent || '').trim() });
    }

    Bus.subscribe('memory', (v) => { if (memDst) { memDst.textContent = v.text; memDst.parentElement.title = v.title || 'Memory hits this turn'; } });
    Bus.subscribe('model',  (v) => { if (modDst) { modDst.textContent = v.text || '—'; modDst.parentElement.title = v.title || 'Active LLM model'; } });
    Bus.subscribe('ws',     (v) => {
      if (wsDst) wsDst.textContent = v.text || v.state;
      if (wsDot) {
        wsDot.dataset.state = v.state;
      }
    });

    if (memSrc) new MutationObserver(syncMemory).observe(memSrc, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['title'] });
    if (modSrc) new MutationObserver(syncModel ).observe(modSrc, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['title'] });
    if (wsSrc)  new MutationObserver(syncWs    ).observe(wsSrc,  { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    syncMemory(); syncModel(); syncWs();
  }

  // ─── Route title sync ───────────────────────────────────────────────────────
  function routeTitle() {
    const h = location.hash || '#/chat';
    const route = h.replace(/^#\//, '').split('?')[0].split('/')[0] || 'chat';
    const map = { chat: 'Chat', memory: 'Memory', apps: 'Apps', messaging: 'Messaging', capabilities: 'Capabilities', activity: 'Activity', settings: 'Settings', terminal: 'Terminal', system: 'System', docs: 'Docs', builder: 'Builder', onboarding: 'Welcome', setup: 'Setup', board: 'Kanban Board' };
    return map[route] || route.charAt(0).toUpperCase() + route.slice(1);
  }
  function syncTitle() {
    const t = document.getElementById('shell-menubar-title');
    if (t) t.textContent = routeTitle();
    document.title = window.VODOU_TITLE || 'VODOU - ALPHA';
  }

  // Instance label (VODOU_INSTANCE_LABEL) — cloud/dev installs brand the tab
  // title (e.g. "VODOU - CLOUD"). Unset label = identical to today.
  (function initInstanceLabel() {
    fetch('/health').then((r) => r.json()).then((h) => {
      if (h && h.instanceLabel) {
        window.VODOU_TITLE = 'VODOU - ' + String(h.instanceLabel).toUpperCase();
        document.title = window.VODOU_TITLE;
      }
    }).catch(() => {});
  })();

  // ─── Dock magnification + tooltips ──────────────────────────────────────────
  // macOS-style magnification: tiles near the cursor scale up smoothly. CSS
  // handles hover state; JS handles the falloff for neighbors.
  function initDock() {
    const dock = document.getElementById('global-chat-tabs-bar');
    if (!dock) return;

    const MAX_SCALE = 1.25;       // subtle peak — dock stays low-profile, no big bloom
    const INFLUENCE = 60;         // px radius where magnification falls off
    let raf = 0;
    let lastX = -9999;

    function tiles() { return Array.from(dock.querySelectorAll('.chat-tab, .chat-tab-add')); }

    function applyMagnify(clientX) {
      const els = tiles();
      for (const el of els) {
        const r = el.getBoundingClientRect();
        const center = r.left + r.width / 2;
        const dist = Math.abs(clientX - center);
        if (dist > INFLUENCE) {
          el.style.transform = '';
          continue;
        }
        // Cosine falloff so the curve is smooth
        const t = 1 - dist / INFLUENCE;
        const scale = 1 + (MAX_SCALE - 1) * Math.cos((1 - t) * Math.PI / 2);
        // Top dock: grow downward (positive Y); bottom dock: grow upward (negative Y).
        const dir = document.body.classList.contains('dock-bottom') ? -1 : 1;
        el.style.transform = `translateY(${dir * (scale - 1) * 4}px) scale(${scale})`;
      }
    }
    function clearMagnify() { for (const el of tiles()) el.style.transform = ''; }

    dock.addEventListener('mousemove', (ev) => {
      lastX = ev.clientX;
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; applyMagnify(lastX); });
    });
    dock.addEventListener('mouseleave', clearMagnify);

    // Dock tooltips: `#global-chat-tabs-bar` uses horizontal overflow scroll; that
    // forces overflow-y to clip absolutely positioned children, and inline tips
    // with pointer-events:none lose :hover when the cursor moves over the pill.
    // Use one `position:fixed` label on <body> anchored to the hovered tile.
    let dockFloatTip = document.getElementById('dock-float-tip');
    if (!dockFloatTip) {
      dockFloatTip = document.createElement('div');
      dockFloatTip.id = 'dock-float-tip';
      dockFloatTip.className = 'dock-float-tip';
      dockFloatTip.setAttribute('role', 'tooltip');
      dockFloatTip.setAttribute('aria-hidden', 'true');
      document.body.appendChild(dockFloatTip);
    }
    let dockTipHideT = 0;
    let activeDockTipEl = null;

    function positionDockFloatTip(el) {
      const label = el.getAttribute('data-dock-label') || '';
      if (!label || !dockFloatTip) return;
      dockFloatTip.textContent = label;
      dockFloatTip.classList.add('is-visible');
      dockFloatTip.setAttribute('aria-hidden', 'false');
      const r = el.getBoundingClientRect();
      const gap = 10;
      const bottomDock = document.body.classList.contains('dock-bottom');
      dockFloatTip.style.left = `${Math.round(r.left + r.width / 2)}px`;
      dockFloatTip.style.transform = 'translateX(-50%)';
      dockFloatTip.style.visibility = 'hidden';
      const h = dockFloatTip.offsetHeight || 28;
      dockFloatTip.style.visibility = '';
      if (bottomDock) {
        dockFloatTip.style.top = `${Math.max(8, Math.round(r.top - h - gap))}px`;
        dockFloatTip.style.bottom = 'auto';
      } else {
        dockFloatTip.style.top = `${Math.round(r.bottom + gap)}px`;
        dockFloatTip.style.bottom = 'auto';
      }
    }

    function hideDockFloatTip() {
      dockFloatTip.classList.remove('is-visible');
      dockFloatTip.setAttribute('aria-hidden', 'true');
      activeDockTipEl = null;
    }

    function onDockTileEnter(ev) {
      const el = ev.currentTarget;
      const label = el.getAttribute('data-dock-label');
      if (!label) return;
      window.clearTimeout(dockTipHideT);
      activeDockTipEl = el;
      positionDockFloatTip(el);
    }

    function onDockTileLeave() {
      dockTipHideT = window.setTimeout(hideDockFloatTip, 80);
    }

    dock.addEventListener(
      'scroll',
      () => {
        if (activeDockTipEl && dockFloatTip.classList.contains('is-visible')) {
          positionDockFloatTip(activeDockTipEl);
        }
      },
      { passive: true },
    );
    window.addEventListener('resize', () => {
      if (activeDockTipEl && dockFloatTip.classList.contains('is-visible')) {
        positionDockFloatTip(activeDockTipEl);
      }
    });

    function ensureTips() {
      for (const el of tiles()) {
        const fromSpan = el.querySelector('.chat-tab-title')?.textContent?.trim();
        const fromTitleAttr = el.getAttribute('title');
        const titleSrc = el.classList.contains('chat-tab-add')
          ? (fromTitleAttr?.trim() || el.getAttribute('data-dock-label') || 'New chat')
          : (fromTitleAttr?.trim() || fromSpan || el.getAttribute('data-dock-label') || '');
        el.querySelector('.chat-tab-tip')?.remove();
        el.removeAttribute('title');
        el.querySelector('.chat-tab-title')?.removeAttribute('title');
        if (!titleSrc) {
          el.removeAttribute('data-dock-label');
          continue;
        }
        el.setAttribute('data-dock-label', titleSrc);
        if (!el.dataset.dockFloatBound) {
          el.dataset.dockFloatBound = '1';
          el.addEventListener('mouseenter', onDockTileEnter);
          el.addEventListener('mouseleave', onDockTileLeave);
        }
      }
    }
    ensureTips();
    new MutationObserver(ensureTips).observe(dock, { childList: true, subtree: true });
  }

  // ─── Sidebar reopen handle (visible only when collapsed) ────────────────────
  function buildSidebarHandle() {
    const handle = document.createElement('button');
    handle.id = 'shell-sidebar-handle';
    handle.type = 'button';
    handle.setAttribute('aria-label', 'Open sidebar');
    handle.title = `Open sidebar (${window.vodouModChord ? window.vodouModChord('B') : '⌘B'})`;
    handle.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';
    handle.addEventListener('click', () => handleAction('toggle-sidebar'));
    return handle;
  }

  // ─── Boot ───────────────────────────────────────────────────────────────────
  function boot() {
    if (document.getElementById('shell-menubar')) return;
    document.body.prepend(buildMenubar());
    document.body.appendChild(buildSidebarHandle());

    // Sidebar collapsed memory
    try { if (localStorage.getItem('vodou-shell-sidebar-collapsed') === '1') document.body.classList.add('shell-sidebar-collapsed'); } catch {}
    // Dock position preference (default: BOTTOM for fresh installs). Bottom
    // unless the user has explicitly chosen 'top'; a never-set value (fresh
    // install) lands on bottom.
    try {
      if (localStorage.getItem('vodou-shell-dock-pos') !== 'top') {
        document.body.classList.add('dock-bottom');
        document.querySelectorAll('#shell-menubar .shell-menu-item').forEach((el) => {
          if (/^Dock at /.test(el.textContent || '')) el.textContent = 'Dock at top';
        });
      }
    } catch {}

    // Click-outside closes menus
    document.addEventListener('click', (ev) => {
      if (!ev.target.closest('#shell-menubar .shell-menu')) closeAllMenus();
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') closeAllMenus();
      // ⌘. or Ctrl+. → palette (⌘K is registered in command-palette.js)
      if ((ev.metaKey || ev.ctrlKey) && ev.key === '.') {
        ev.preventDefault();
        openPalette();
      }
      // ⌘B → toggle sidebar
      if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'b' || ev.key === 'B')) {
        ev.preventDefault();
        handleAction('toggle-sidebar');
      }
    });

    syncTitle();
    window.addEventListener('hashchange', syncTitle);

    mirrorIndicators();
    initDock();

    // Progressive onboarding — guided tour (offers itself once, then on demand
    // via the menubar "?" button). Runs after chrome is stable.
    try { if (window.OnboardingTour) window.OnboardingTour.init(); } catch (_) {}

    // Pre-warm the integration preset cache so the dock can re-derive integration
    // icons from live preset data even before the user visits the Apps view.
    // Without this, dock tiles for pinned integrations fall back to entry.icon
    // (stale snapshot from when first pinned).
    (async () => {
      try {
        if (!window._integrationPresets) window._integrationPresets = new Map();
        if (window._integrationPresets.size > 0) return;
        const res = await fetch('/api/oauth/status');
        if (!res.ok) return;
        const { providers } = await res.json();
        if (!Array.isArray(providers)) return;
        for (const p of providers) window._integrationPresets.set(p.id, p);
        // Re-render the dock now that we have fresh icons.
        if (window.ChatView && typeof ChatView._renderTabs === 'function') {
          try { ChatView._renderTabs(); } catch {}
        }
      } catch {}
    })();

    console.log('[shell-v2] active — disable with ?shell=0 or localStorage.removeItem("vodou-shell-v2")');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
