// Shared extension controls — the side panel's settings renderers.
//
// Extracted 2026-07-29 when settings moved into the panel (PLAN-BRIDGE-SIDE-PANEL,
// revising §3.3: a panel VIEW rather than a separate options page). 266 of popup.js's
// 421 lines were these two renderers; duplicating them into the panel would have been
// yet another uncoordinated copy in an extension that has already produced six.
// sites.js set the precedent — one definition, several consumers, guarded by test.
//
// Both take element ids so the same code renders in either surface.

// Per-site toggles for BOTH lanes, rendered from sites.js so the panel can never
// offer a different set of sites than the extension actually serves. Two
// checkboxes used to be hard-coded for inject while the list carried 22, leaving
// the other 20 live with no way to switch them off short of the master toggle.
//
// One implementation for both lanes on purpose: the merge-on-save below is the
// only thing standing between a 22-key map and a partial overwrite, and it should
// not exist in two places to drift apart.
function vodouSiteToggles(opts) {
  const master = document.getElementById(opts.masterId);
  const host = document.getElementById(opts.hostId);
  if (!master || !host) return;
  const SITES = globalThis.VODOU_SITES || [];
  if (!SITES.length) return; // list failed to load — leave the master toggle alone

  const boxes = new Map();
  for (const s of SITES) {
    const label = document.createElement('label');
    label.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer;margin-top:0;';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.style.cssText = 'width:auto;margin:0;';
    // textContent, never innerHTML — label strings are ours today, but this is
    // the store build and a DOM sink here is exactly what CWS review looks for.
    label.append(box, document.createTextNode(' ' + s.label));
    host.appendChild(label);
    boxes.set(opts.keyOf(s), { box, label });
  }

  function paint(state) {
    master.checked = state.master;
    const veto = state.veto || {};
    // Default ON: a site the user has never touched keeps behaving as it did.
    // Only an explicit false disables — the same test content.js applies, and
    // the reason no existing install changes behaviour when this ships.
    for (const [key, { box, label }] of boxes) {
      // A remotely disabled provider (PLAN-CAPTURE-SAFETY P0-a) must LOOK
      // disabled. Showing it ticked while capture silently does nothing is the
      // failure mode that costs a day; showing it unticked without saying why
      // makes the user think they did it.
      if (veto[key]) {
        box.checked = false;
        box.disabled = true;
        label.style.opacity = '0.5';
        label.title = 'Vodou has disabled capture for this site at the provider’s request. '
          + 'Your own setting is unchanged and will apply again if it is re-enabled.';
        continue;
      }
      label.style.opacity = '';
      label.title = '';
      box.checked = state.sites[key] !== false;
      box.disabled = !master.checked;
    }
  }
  function save() {
    // MERGE, never replace. A replace drops any key this surface does not know
    // about — an older build against newer storage, or a site added while the
    // panel is open.
    opts.read((state) => {
      const veto = state.veto || {};
      const sites = Object.assign({}, state.sites);
      // Never write a vetoed site's box state — the box reads false because the
      // policy forced it, not because the user chose it. Persisting that would
      // turn a temporary provider block into a permanent user preference.
      for (const [key, { box }] of boxes) if (!veto[key]) sites[key] = box.checked;
      opts.write(master.checked, sites, state.raw);
      paint(Object.assign({}, state, { master: master.checked, sites }));
    });
  }
  opts.read(paint);
  master.addEventListener('change', save);
  for (const { box } of boxes.values()) box.addEventListener('change', save);
}

// Recent activity — both directions of the bridge in one feed. Every row answers
// one of the only two questions a user actually has: did my memory reach the AI,
// and did this chat get saved. Counts are what was really sent/stored (the
// entries carry post-hoc numbers, never "what was available").
function vodouActivityLog(opts) {
  const o = opts || {};
  const logEl = document.getElementById(o.logId || 'activity-log');
  const clearEl = document.getElementById(o.clearId || 'activity-clear');
  if (!logEl) return;

  const SITE_NAMES = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', grok: 'Grok', perplexity: 'Perplexity' };
  const siteName = (s) => SITE_NAMES[s] || (s ? s.charAt(0).toUpperCase() + s.slice(1) : 'this chat');

  function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.round(h / 24);
    return d === 1 ? 'yesterday' : `${d}d ago`;
  }

  // "3 memories + 2 profile facts" — omits whatever wasn't actually included.
  function payload(e) {
    const parts = [];
    if (e.facts) parts.push(`${e.facts} ${e.facts === 1 ? 'memory' : 'memories'}`);
    if (e.profileLines) parts.push(`${e.profileLines} profile ${e.profileLines === 1 ? 'fact' : 'facts'}`);
    return parts.join(' + ');
  }

  function describe(e) {
    const who = siteName(e.site || e.provider);
    if (e.kind === 'capture') {
      const n = e.messages || 0;
      // PLAN-ENGINE-GATED-CAPTURE P3a — a lease refusal is a PAUSE, not a loss:
      // the turns are already in the retry queue and go the moment Vodou is back.
      // Rendering it with the ✗ bad-news treatment would say "your chat is gone"
      // about turns that are safe, which is worse than saying nothing.
      if (!e.ok && e.held) {
        const msgs = n ? `${n} ${n === 1 ? 'message' : 'messages'}` : 'your chat';
        return { icon: '⏸', tone: 'wait', text: `Holding ${msgs} from ${who} — ${e.note || 'will save when Vodou is back'}` };
      }
      if (!e.ok) return { icon: '✗', tone: 'bad', text: `Couldn't save your ${who} chat — ${e.error || e.note || 'failed'}` };
      const msgs = `${n} ${n === 1 ? 'message' : 'messages'}`;
      return e.mode === 'manual'
        ? { icon: '↓', tone: 'save', text: `Saved your ${who} chat to memory — ${msgs}` }
        : { icon: '↓', tone: 'save', text: `Saved ${msgs} from ${who} to memory` };
    }
    const what = payload(e);
    // 'injected' / 'armed' are produced ONLY by the sideload builds, which have the
    // network mechanism; the store build logs just 'nothing' | 'inserted' |
    // 'clipboard'. controls.js is shared verbatim, so both branches stay — but the
    // wording no longer says "invisibly, inside your message", which described a
    // capability the store build does not have in a panel a reviewer can open.
    switch (e.status) {
      case 'injected':
        return { icon: '↑', tone: 'send', text: `Sent ${what} to ${who} with your message` };
      case 'armed':
        return { icon: '⏱', tone: 'wait', text: `${what} ready — attaches to your next ${who} message` };
      case 'inserted':
        return { icon: '↑', tone: 'send', text: `Added ${what} to your ${who} draft` };
      case 'clipboard':
        return { icon: '!', tone: 'warn', text: `Couldn't type into ${who} — ${what} copied, paste it yourself` };
      case 'nothing':
        return { icon: '–', tone: 'muted', text: `Nothing in your memory matched this ${who} chat — nothing sent` };
      default:
        return { icon: '·', tone: 'muted', text: `${who} — ${e.status || 'unknown'}` };
    }
  }

  // Panel theme variables, with the old dark-popup literals as fallbacks. The
  // rows render inside sidepanel.html, which follows the browser's light/dark —
  // hard-coded grays tuned for a dark popup are unreadable on the light scheme.
  const TONE = {
    send: 'var(--success, #4ade80)',
    save: 'var(--link, #60a5fa)',
    wait: 'var(--warn-text, #fbbf24)',
    warn: 'var(--warn-text, #fbbf24)',
    bad: 'var(--error, #f87171)',
    muted: 'var(--text-muted, #6b7280)',
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function paintLog() {
    chrome.storage.local.get(['vodou_activity_log'], (v) => {
      const log = (v && v.vodou_activity_log) || [];
      if (!log.length) {
        logEl.innerHTML = '<div style="color:var(--text-muted, #6b7280);">Nothing yet. Press <b>Ctrl+B</b> in a chat to send your memory, or turn on auto-capture to save chats.</div>';
        return;
      }
      // The whole buffer, not a head. The 8-row cap existed because the popup was
      // 280px tall; the panel scrolls, and cutting the feed at 8 made "did that
      // chat from this morning get saved?" unanswerable from the only surface
      // that exists to answer it.
      logEl.innerHTML = log.map((e) => {
        const d = describe(e);
        return `<div style="display:flex;gap:6px;align-items:baseline;margin-bottom:4px;">`
          + `<span style="color:${TONE[d.tone]};width:10px;flex:none;">${d.icon}</span>`
          + `<span style="color:var(--text-primary, #d1d5db);flex:1;">${esc(d.text)}</span>`
          + `<span style="color:var(--text-muted, #6b7280);flex:none;font-size:10px;">${esc(ago(e.at))}</span>`
          + `</div>`;
      }).join('');
    });
  }

  if (clearEl) {
    clearEl.addEventListener('click', (ev) => {
      ev.preventDefault();
      try { chrome.storage.local.remove('vodou_activity_log', paintLog); } catch (_) { paintLog(); }
    });
  }
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.vodou_activity_log) paintLog();
    });
  } catch (_) { /* ignore */ }
  paintLog();
}
