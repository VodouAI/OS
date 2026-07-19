/**
 * ExecDesk mode — SMB-positioned product surface.
 *
 * Plan: PLANS/0.5.38/PLAN-SMB-EXEC-CONSOLE.md (§0.10.6 build strategy).
 *
 * Activation (default OFF — non-flagged users see exactly the current Vodou Console):
 *   - localStorage 'vodou-execdesk-mode' = '1'
 *   - or URL ?execdesk=1 (also persists)
 *   - or URL ?execdesk=0 (clears + reverts immediately)
 *   - or build-time EXECDESK_MODE=1 env injected by gateway as window.__EXECDESK_BUILD
 *
 * Mitigation #1 of §0.10.8: only adds `body.execdesk-mode`. Every CSS change in
 * `06-execdesk.css` is scoped under that class, so when off the file is a no-op.
 *
 * Strategy: identical pattern to shell-v2 (zero changes to existing DOM producers).
 * The home view (execdesk.js), approval queue (execdesk-approval.js), and
 * onboarding flow (execdesk-onboarding.js) attach themselves to existing route
 * containers when the body class is present.
 */
(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  if (params.get('execdesk') === '1') {
    try { localStorage.setItem('vodou-execdesk-mode', '1'); } catch {}
  } else if (params.get('execdesk') === '0') {
    try { localStorage.removeItem('vodou-execdesk-mode'); } catch {}
  }

  let enabled = false;
  try { enabled = localStorage.getItem('vodou-execdesk-mode') === '1'; } catch {}
  if (!enabled && window.__EXECDESK_BUILD === true) enabled = true;
  if (!enabled) return;

  const apply = () => {
    document.documentElement.classList.add('execdesk-mode');
    if (document.body) document.body.classList.add('execdesk-mode');
  };
  apply();
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', apply, { once: true });
  }

  // Default route swap — when ExecDesk mode is on and no hash route is set,
  // land on /#/execdesk instead of /#/chat (per §0.10.6).
  if (!location.hash || location.hash === '#/' || location.hash === '#/chat') {
    if (window.__EXECDESK_BUILD === true || params.get('execdesk') === '1') {
      location.hash = '#/execdesk';
    }
  }

  // Pro mode toggle (lets ExecDesk power users see hidden Vodou views)
  if (params.get('pro') === '1') {
    try { localStorage.setItem('vodou-execdesk-pro', '1'); } catch {}
  } else if (params.get('pro') === '0') {
    try { localStorage.removeItem('vodou-execdesk-pro'); } catch {}
  }
  try {
    if (localStorage.getItem('vodou-execdesk-pro') === '1') {
      const apply2 = () => document.body && document.body.classList.add('pro-mode');
      apply2();
      if (!document.body) document.addEventListener('DOMContentLoaded', apply2, { once: true });
    }
  } catch {}

  // Approval queue badge initialization — read pending count from localStorage
  // and reflect it on the sidebar's #nav-execdesk-approval entry.
  const updateApprovalBadge = () => {
    try {
      const items = JSON.parse(localStorage.getItem('execdesk-approval-queue') || '[]');
      const pending = items.filter((i) => i.status === 'pending').length;
      document.querySelectorAll('.execdesk-approval-pending').forEach((el) => {
        el.dataset.count = pending > 0 ? String(pending) : '';
      });
    } catch {}
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateApprovalBadge, { once: true });
  } else {
    updateApprovalBadge();
  }
  // Re-check on storage events (other tabs) and on hash change (post-action)
  window.addEventListener('storage', (e) => {
    if (e.key === 'execdesk-approval-queue') updateApprovalBadge();
  });
  window.addEventListener('hashchange', updateApprovalBadge);

  console.log('[execdesk] active — disable with ?execdesk=0');
})();
