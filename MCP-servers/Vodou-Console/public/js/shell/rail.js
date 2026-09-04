/**
 * rail.js — the 0.6.31 shell. Renders `VodouNav` as a fixed rail, keeps the
 * active tile in step with the hash, and folds every existing health signal
 * into ONE status dot at the bottom of the rail.
 *
 * Nothing here knows about views. Views never reach into the rail. The only
 * contract is `window.VodouNav` (data) and a handful of DOM ids that already
 * existed and are now hidden: #ws-status, #state-activity, #state-messaging.
 */
(function () {
  'use strict';

  // ── Escape hatch: ?shell=classic shows the old sidebar instead of the rail.
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('shell') === 'classic') localStorage.setItem('vodou-next-shell', 'classic');
    else if (q.get('shell') === 'rail') localStorage.removeItem('vodou-next-shell');
    if (localStorage.getItem('vodou-next-shell') === 'classic') {
      document.documentElement.setAttribute('data-shell', 'classic');
    }
  } catch (_) {}

  // ── Embedded mode (kept from shell-init.js): a host framing one view wants
  //    the view, not our chrome. `embedded=1` in the hash query hides it.
  function applyEmbedded() {
    const h = location.hash || '';
    const q = new URLSearchParams(h.includes('?') ? h.slice(h.indexOf('?') + 1) : '');
    const on = q.get('embedded') === '1';
    document.documentElement.classList.toggle('vodou-embedded', on);
    if (document.body) document.body.classList.toggle('vodou-embedded', on);
  }
  applyEmbedded();
  window.addEventListener('hashchange', applyEmbedded);

  function pathOnly() {
    let raw = (location.hash || '#/chat').slice(1);
    const i = raw.indexOf('?');
    if (i >= 0) raw = raw.slice(0, i);
    if (!raw.startsWith('/')) raw = '/' + raw;
    return raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw;
  }

  function tile(d) {
    const a = document.createElement('a');
    a.className = 'rail-item';
    a.href = d.href;
    a.dataset.dest = d.id;
    a.title = d.hint || d.label;
    a.setAttribute('aria-label', d.label);
    a.innerHTML = '<span class="rail-icon">' + d.icon + '</span><span class="rail-label"></span>';
    a.querySelector('.rail-label').textContent = d.label;
    if (d.badge) {
      const b = document.createElement('span');
      b.className = 'rail-badge';
      b.dataset.mirror = d.badge;
      a.appendChild(b);
    }
    return a;
  }

  function render() {
    const rail = document.getElementById('rail');
    const Nav = window.VodouNav;
    if (!rail || !Nav) return;
    rail.innerHTML = '';

    // Brand: the logo links to Chat. Not a destination, not an action.
    // (Chad 2026-09-02: "New" and "Search" tiles dropped — the rail is the
    // six destinations plus Status, Settings and Help. New chat is the + in
    // the thread column; the palette is ⌘K.)
    const brand = document.createElement('a');
    brand.className = 'rail-item rail-brand';
    brand.href = '#/chat';
    brand.title = 'Vodou';
    brand.setAttribute('aria-label', 'Vodou');
    brand.innerHTML = '<img src="/icons/vodou-icon.png" alt="" width="22" height="22">';
    rail.appendChild(brand);

    const sep = document.createElement('div');
    sep.className = 'rail-sep';
    rail.appendChild(sep);

    for (const d of Nav.destinations) rail.appendChild(tile(d));

    const spacer = document.createElement('div');
    spacer.className = 'rail-spacer';
    rail.appendChild(spacer);

    // Status: ONE dot. runtime-badge.js already polls /api/system and writes
    // into #shell-ind-kernel (.shell-kernel-dot / .shell-status-text); giving
    // the rail that id makes it the kernel source with no new poll.
    const status = document.createElement('a');
    status.className = 'rail-item rail-status';
    status.id = 'shell-ind-kernel';
    status.href = '#/system';
    status.title = 'Status';
    status.setAttribute('aria-label', 'System status');
    status.innerHTML = '<span class="rail-icon"><span class="shell-kernel-dot rail-status-dot" data-state="unknown"></span></span><span class="rail-label">Status</span><span class="shell-status-text" hidden></span>';
    rail.appendChild(status);

    for (const d of Nav.utility) rail.appendChild(tile(d));

    // Help: the guided tour and its menu (was the menubar's "?" button).
    const help = document.createElement('button');
    help.type = 'button';
    help.className = 'rail-item rail-help';
    help.title = 'Help & guided tour';
    help.setAttribute('aria-label', 'Help');
    help.innerHTML = '<span class="rail-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7"/><path d="M12 17h.01"/></svg></span><span class="rail-label">Help</span>';
    help.addEventListener('click', (e) => {
      e.stopPropagation();
      if (window.OnboardingTour && typeof OnboardingTour.openHelpMenu === 'function') OnboardingTour.openHelpMenu(help);
    });
    rail.appendChild(help);

    syncActive();
    mirrorSignals();
    // Guided tour + first-run checklist (shell-init.js used to call this).
    try { if (window.OnboardingTour && typeof OnboardingTour.init === 'function') OnboardingTour.init(); } catch (_) {}
  }

  function syncActive() {
    const Nav = window.VodouNav;
    if (!Nav) return;
    const id = Nav.resolve(pathOnly());
    document.querySelectorAll('#rail .rail-item[data-dest]').forEach((el) => {
      const on = el.dataset.dest === id;
      el.classList.toggle('is-active', on);
      if (on) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
    });
    const status = document.getElementById('shell-ind-kernel');
    if (status) status.classList.toggle('is-active', pathOnly() === '/system');
  }

  // ── Signals. The old sidebar still exists (hidden) and every existing
  //    writer keeps writing into it. We mirror, we do not re-poll.
  function mirrorSignals() {
    const levelOf = (el) => !el ? '' : el.classList.contains('error') ? 'error' : el.classList.contains('warn') ? 'warn' : '';
    const mirrors = document.querySelectorAll('#rail .rail-badge[data-mirror]');
    const syncBadges = () => {
      mirrors.forEach((b) => {
        const src = document.getElementById(b.dataset.mirror);
        const lvl = levelOf(src);
        if (lvl) b.dataset.state = lvl; else delete b.dataset.state;
      });
      syncStatus();
    };
    mirrors.forEach((b) => {
      const src = document.getElementById(b.dataset.mirror);
      if (src) new MutationObserver(syncBadges).observe(src, { attributes: true, attributeFilter: ['class'] });
    });

    const ws = document.getElementById('ws-status');
    if (ws) new MutationObserver(syncStatus).observe(ws, { attributes: true, attributeFilter: ['class'] });
    const kernel = document.querySelector('#shell-ind-kernel .shell-kernel-dot');
    if (kernel) new MutationObserver(syncStatus).observe(kernel, { attributes: true, attributeFilter: ['data-state'] });

    function syncStatus() {
      const status = document.getElementById('shell-ind-kernel');
      const dot = status && status.querySelector('.rail-status-dot');
      if (!status || !dot) return;
      const k = dot.getAttribute('data-state') || 'unknown';
      const wsCls = ws ? ws.className : '';
      const wsDown = wsCls.includes('disconnected');
      const worstBadge = Array.from(mirrors).map((b) => b.dataset.state || '').reduce((a, v) => (v === 'error' || a === 'error') ? 'error' : (v === 'warn' || a === 'warn') ? 'warn' : '', '');
      let level = 'ok';
      const reasons = [];
      if (k === 'down') { level = 'error'; reasons.push('kernel down'); }
      else if (k === 'degraded') { level = 'warn'; reasons.push('kernel degraded'); }
      else if (k === 'unknown') { level = 'unknown'; }
      if (wsDown) { level = 'error'; reasons.push('gateway connection lost'); }
      if (worstBadge === 'error') { level = 'error'; reasons.push('a channel or task is failing'); }
      else if (worstBadge === 'warn' && level !== 'error') { level = 'warn'; reasons.push('a channel or task needs attention'); }
      status.dataset.level = level;
      status.title = level === 'ok' ? 'All systems normal' : level === 'unknown' ? 'Status unknown' : reasons.join(' · ') + ' — open System';
    }
    syncBadges();
  }

  // ── Instance label (from shell-init.js): cloud/dev installs brand the title.
  fetch('/health').then((r) => r.json()).then((h) => {
    if (h && h.instanceLabel) {
      window.VODOU_TITLE = 'VODOU - ' + String(h.instanceLabel).toUpperCase();
      document.title = window.VODOU_TITLE;
    }
  }).catch(() => {});

  window.addEventListener('hashchange', syncActive);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render, { once: true });
  else render();
})();
