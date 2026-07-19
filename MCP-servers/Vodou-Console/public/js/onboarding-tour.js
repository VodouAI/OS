/**
 * Progressive onboarding — guided spotlight tour (Layer A).
 * PLANS/0.6.9/PLAN-PROGRESSIVE-ONBOARDING.md
 *
 * A replayable, multi-chapter coachmark tour that dims the app and spotlights
 * real UI elements with an anchored coach card. Navigates between routes,
 * waits for lazy-rendered anchors, and persists progress so it can be resumed
 * and replayed. Pure vanilla JS; reuses the app's palette + easing tokens.
 *
 * Public API (window.OnboardingTour):
 *   init()      — call once at boot; syncs progress, maybe offers the tour
 *   start(i)    — start from flat-stop index i (default 0)
 *   replay()    — restart from the beginning (Help → "Take the tour")
 *   reset()     — clear all onboarding flags (server + local), then no-op
 *   openHelpMenu(anchorEl) — small "tour / reset" menu under the ? button
 */
(function () {
  'use strict';

  // ─────────────────────────── Progress store ───────────────────────────
  // Server-backed (gateway_settings via /api/onboarding/progress) with a
  // localStorage mirror for instant first-paint and graceful degradation when
  // the API isn't live yet (e.g. before a gateway restart picks up the router).
  var LS_KEY = 'vodou-onboarding-cache';
  var cache = {};
  function loadCache() { try { cache = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (_) { cache = {}; } }
  function saveCache() { try { localStorage.setItem(LS_KEY, JSON.stringify(cache)); } catch (_) {} }
  function getFlag(key) { return cache[key] != null ? cache[key] : null; }
  function setFlag(key, value) {
    cache[key] = String(value); saveCache();
    fetch('/api/onboarding/progress', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key, value: String(value) }),
    }).catch(function () {});
  }
  function nowISO() { return new Date().toISOString(); }
  function syncFromServer() {
    return fetch('/api/onboarding/progress', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.raw) {
          // Server is authoritative — it wins over the local first-paint mirror.
          // (sync runs once at init, before any user writes, so nothing is lost.)
          cache = Object.assign({}, cache, data.raw); saveCache();
        }
      })
      .catch(function () {});
  }
  function resetServer() {
    return fetch('/api/onboarding/progress/reset', { method: 'POST' }).catch(function () {});
  }

  // ─────────────────────────── Tour content ───────────────────────────
  var CHAPTERS = [
    // Chapter 1 — the basics, in context on the Chat view.
    {
      id: 'core', title: 'The basics',
      stops: [
        { anchor: '#chat-input', route: '#/chat', placement: 'top',
          title: 'Talk to Vodou', body: 'Ask anything in plain language right here — questions, tasks, “summarize my unread Slack.” This is home base.' },
        { anchor: '.chat-shortcuts', route: '#/chat', placement: 'top',
          title: 'Slash commands', body: 'Type <b>/server</b> to call a connected tool or <b>/skill</b> to run an automation directly — no menus.' },
        { anchor: '#shell-ind-palette', route: null, placement: 'bottom',
          title: `Jump anywhere — ${window.vodouModChord ? window.vodouModChord('K') : '⌘K'}`, body: `The command palette fuzzy-searches every view, skill, and setting. Press <b>${window.vodouModChord ? window.vodouModChord('K') : '⌘K'}</b> anytime.` },
        { anchor: '#global-chat-tabs-bar', route: null, placement: 'bottom',
          title: 'Your dock', body: 'Tabs live here, grouped into trays: <b>Runs</b> (briefings &amp; board), <b>Chats</b>, <b>Messaging</b>, <b>Apps</b>, and <b>Skills</b>.' },
      ],
    },
    // Chapter 2 — a full walk down the left sidebar. route:null keeps us put;
    // each stop spotlights the nav entry and explains it in detail.
    {
      id: 'sidebar', title: 'Your sidebar',
      stops: [
        { anchor: 'a.nav-item[href="#/chat"]', route: null, placement: 'right',
          title: 'Chat', body: 'Home base — every conversation starts here. Ask questions, hand off tasks, or pick one of the starter prompts.' },
        { anchor: '#nav-kanban-board', route: null, placement: 'right',
          title: 'Kanban board', body: 'Hand work to multiple AI agents and watch it move across columns — Plan → Todo → Running → Done — with approvals and a live cost meter.' },
        { anchor: 'a.nav-item[href="#/memory"]', route: null, placement: 'right',
          title: 'Memory', body: 'Everything Vodou remembers about you and your projects, as a timeline and an interactive mind-map. It keeps learning as you work.' },
        { anchor: '#nav-projects > summary', route: null, placement: 'right',
          title: 'Projects', body: 'Separate workspaces — each project keeps its own chats, files, and instructions, all sharing one Vodou brain. Switch between them from the dock.' },
        { anchor: '#nav-messaging > summary', route: null, placement: 'right',
          title: 'Messaging', body: `Connect Slack, Telegram, WhatsApp, ${(window.VODOU_OS || 'mac') === 'mac' ? 'iMessage, ' : ''}Discord and more, so Vodou reaches you where you already talk.` },
        { anchor: '#nav-apps > summary', route: null, placement: 'right',
          title: 'Apps', body: 'Connect Google Calendar, GitHub, Linear and other apps via secure OAuth — Vodou can then read from and act on them for you.' },
        { anchor: '#nav-capabilities > summary', route: null, placement: 'right',
          title: 'Skills & Tools', body: 'The toolkit: reusable <b>Skills</b>, background <b>Scripts</b>, keyword <b>Routing rules</b>, and rich-rendering <b>Lenses</b>. Toggle what’s on, or build your own.' },
        { anchor: '#nav-activity > summary', route: null, placement: 'right',
          title: 'Activity', body: 'What’s running and what ran: <b>Scheduled</b> tasks, event-driven <b>Automations</b>, and a searchable work-log <b>History</b>.' },
        { anchor: '#nav-settings > summary', route: null, placement: 'right',
          title: 'Settings', body: 'Your profile, the <b>LLM model &amp; provider</b>, environment secrets, and memory tuning — all configured here.' },
        { anchor: '#nav-advanced > summary', route: null, placement: 'right',
          title: 'Advanced', body: 'Power tools — a visual workflow <b>Builder</b> and an embedded <b>Terminal</b> for running any CLI right inside Vodou.' },
        { anchor: 'a.system-status-link[href="#/docs"]', route: null, placement: 'right',
          title: 'Docs & API', body: 'The API explorer, app guides, and full documentation — read the docs or fire live API calls with Try-It.' },
        { anchor: '#system-status-link', route: null, placement: 'right',
          title: 'System status', body: 'Health, diagnostics, database counts, and update checks — the pulse of your Vodou install.' },
      ],
    },
  ];

  // Flatten chapters → a single ordered list of stops (with chapter back-refs).
  function flatten() {
    var out = [];
    CHAPTERS.forEach(function (ch, ci) {
      ch.stops.forEach(function (s, si) {
        out.push(Object.assign({ chapterIndex: ci, stopInChapter: si, chapterId: ch.id }, s));
      });
    });
    return out;
  }
  var STOPS = flatten();

  // ─────────────────────────── Engine state ───────────────────────────
  var els = null;       // overlay DOM refs while running
  var current = -1;     // flat-stop index
  var reposition = null; // bound scroll/resize handler
  function reduceMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
  }

  // Wait for a lazy-rendered anchor to appear (MutationObserver + poll fallback).
  function waitForEl(selector, timeout) {
    timeout = timeout || 4000;
    return new Promise(function (resolve) {
      var found = document.querySelector(selector);
      if (found && isVisible(found)) { resolve(found); return; }
      var done = false;
      function finish(el) { if (done) return; done = true; try { obs.disconnect(); } catch (_) {} clearInterval(poll); clearTimeout(timer); resolve(el); }
      var obs = new MutationObserver(function () {
        var el = document.querySelector(selector);
        if (el && isVisible(el)) finish(el);
      });
      try { obs.observe(document.body, { childList: true, subtree: true, attributes: true }); } catch (_) {}
      var poll = setInterval(function () {
        var el = document.querySelector(selector);
        if (el && isVisible(el)) finish(el);
      }, 120);
      var timer = setTimeout(function () { finish(document.querySelector(selector) || null); }, timeout);
    });
  }
  function isVisible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden';
  }

  // Make sure an anchor can be measured: expand a collapsed sidebar if needed.
  function revealAnchor(el) {
    try {
      if (document.body.classList.contains('shell-sidebar-collapsed') && el.closest('#sidebar')) {
        document.body.classList.remove('shell-sidebar-collapsed');
      }
    } catch (_) {}
  }

  // ─────────────────────────── Overlay DOM ───────────────────────────
  function buildOverlay() {
    if (els) return els;
    var root = document.createElement('div');
    root.id = 'ob-tour-overlay';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Guided tour');
    root.innerHTML =
      '<div class="ob-tour-scrim"></div>' +
      '<div class="ob-tour-spotlight" aria-hidden="true"></div>' +
      '<div class="ob-tour-card" role="document">' +
        '<div class="ob-tour-card-step"></div>' +
        '<div class="ob-tour-card-title"></div>' +
        '<div class="ob-tour-card-body"></div>' +
        '<div class="ob-tour-card-actions">' +
          '<button type="button" class="ob-tour-skip">Skip tour</button>' +
          '<span class="ob-tour-spacer"></span>' +
          '<button type="button" class="ob-tour-back">Back</button>' +
          '<button type="button" class="ob-tour-next">Next</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);
    els = {
      root: root,
      scrim: root.querySelector('.ob-tour-scrim'),
      spot: root.querySelector('.ob-tour-spotlight'),
      card: root.querySelector('.ob-tour-card'),
      step: root.querySelector('.ob-tour-card-step'),
      title: root.querySelector('.ob-tour-card-title'),
      body: root.querySelector('.ob-tour-card-body'),
      skip: root.querySelector('.ob-tour-skip'),
      back: root.querySelector('.ob-tour-back'),
      next: root.querySelector('.ob-tour-next'),
    };
    els.skip.addEventListener('click', function () { skip(); });
    els.back.addEventListener('click', function () { go(current - 1); });
    els.next.addEventListener('click', function () { go(current + 1); });
    // Clicking the dim area = pause (keep progress, close overlay).
    els.scrim.addEventListener('click', function () { pause(); });
    document.addEventListener('keydown', onKey, true);
    return els;
  }
  function onKey(e) {
    if (!els) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); skip(); }
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(current + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(current - 1); }
  }
  function teardown() {
    if (reposition) { window.removeEventListener('scroll', reposition, true); window.removeEventListener('resize', reposition); reposition = null; }
    document.removeEventListener('keydown', onKey, true);
    if (els && els.root) els.root.remove();
    els = null; current = -1;
  }

  // ─────────────────────────── Positioning ───────────────────────────
  function placeSpotlight(rect) {
    var pad = 6;
    var top = Math.max(0, rect.top - pad), left = Math.max(0, rect.left - pad);
    var w = rect.width + pad * 2, h = rect.height + pad * 2;
    var s = els.spot.style;
    s.top = top + 'px'; s.left = left + 'px'; s.width = w + 'px'; s.height = h + 'px';
  }
  function placeCard(rect, placement) {
    var card = els.card, gap = 14;
    card.style.visibility = 'hidden';
    card.style.left = '0px'; card.style.top = '0px';
    var cw = card.offsetWidth, ch = card.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    var left, top;

    if (placement === 'right' || placement === 'left') {
      // Beside the target (used for left-sidebar items), vertically centered.
      var fitsRight = rect.right + gap + cw <= vw - 12;
      var onRight = placement === 'right' ? (fitsRight || rect.left - gap - cw < 12) : !(rect.left - gap - cw >= 12);
      left = onRight ? rect.right + gap : rect.left - gap - cw;
      left = Math.max(12, Math.min(left, vw - cw - 12));
      top = rect.top + rect.height / 2 - ch / 2;
      top = Math.max(12, Math.min(top, vh - ch - 12));
    } else {
      // Above/below the target.
      var preferBelow = placement !== 'top';
      var fitsBelow = rect.bottom + gap + ch <= vh - 12;
      var fitsAbove = rect.top - gap - ch >= 12;
      var below = preferBelow ? (fitsBelow || !fitsAbove) : (!fitsAbove && fitsBelow);
      top = below ? rect.bottom + gap : rect.top - gap - ch;
      top = Math.max(12, Math.min(top, vh - ch - 12));
      left = rect.left + rect.width / 2 - cw / 2;
      left = Math.max(12, Math.min(left, vw - cw - 12));
    }

    card.style.left = Math.round(left) + 'px';
    card.style.top = Math.round(top) + 'px';
    card.style.visibility = '';
  }
  function positionTo(el, placement) {
    if (!el) return;
    var rect = el.getBoundingClientRect();
    placeSpotlight(rect);
    placeCard(rect, placement);
  }

  // ─────────────────────────── Flow ───────────────────────────
  function start(fromIndex) {
    if (!STOPS.length) return;
    buildOverlay();
    current = -1;
    go(typeof fromIndex === 'number' ? fromIndex : 0);
  }
  function go(index) {
    if (!els) return;
    if (index < 0) index = 0;
    if (index >= STOPS.length) { finish(); return; }
    current = index;
    var stop = STOPS[index];

    // Update card chrome immediately (so it feels responsive while we navigate).
    els.step.textContent = (index + 1) + ' / ' + STOPS.length;
    els.title.textContent = stop.title;
    els.body.innerHTML = stop.body;
    els.back.style.visibility = index === 0 ? 'hidden' : 'visible';
    els.next.textContent = index === STOPS.length - 1 ? 'Done' : 'Next';
    els.card.classList.remove('ob-anim'); void els.card.offsetWidth;
    if (!reduceMotion()) els.card.classList.add('ob-anim');

    // Navigate if the stop lives on another route, then wait for the anchor.
    var needNav = stop.route && location.hash !== stop.route;
    if (needNav) location.hash = stop.route;

    // Hide spotlight while we wait so it doesn't flash at the old position.
    els.spot.style.opacity = '0';
    waitForEl(stop.anchor, 4500).then(function (el) {
      if (!els || current !== index) return; // moved on / torn down
      if (!el) { // anchor never appeared — skip gracefully
        if (index < STOPS.length - 1) { go(index + 1); } else { finish(); }
        return;
      }
      revealAnchor(el);
      // Let layout settle (route swap, sidebar expand) before measuring.
      requestAnimationFrame(function () {
        if (!els || current !== index) return;
        try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' }); } catch (_) {}
        setTimeout(function () {
          if (!els || current !== index) return;
          els.spot.style.opacity = '1';
          positionTo(el, stop.placement);
          // Keep it glued during scroll/resize.
          if (reposition) { window.removeEventListener('scroll', reposition, true); window.removeEventListener('resize', reposition); }
          reposition = function () { var t = document.querySelector(stop.anchor); if (t) positionTo(t, stop.placement); };
          window.addEventListener('scroll', reposition, true);
          window.addEventListener('resize', reposition);
        }, reduceMotion() ? 0 : 180);
      });
    });
    setFlag('onboarding.tour.last_chapter', String(stop.chapterIndex));
  }
  function finish() {
    setFlag('onboarding.tour.completed_at', nowISO());
    setFlag('onboarding.checklist.take_the_tour', nowISO());
    teardown();
    refreshChecklistUI();
    toast('🎉 You\'re all set — explore away. Reopen the tour anytime from the ? menu.', 'success');
  }
  function skip() { teardown(); }      // explicit dismissal; progress (last_chapter) already saved
  function pause() { teardown(); }     // click-away; same as skip but semantically "later"

  // ─────────────────────────── Offer + Help ───────────────────────────
  function inSetupFlow() {
    var h = location.hash || '';
    return h.indexOf('#/onboarding') === 0 || h.indexOf('#/setup') === 0;
  }
  function maybeOffer() {
    if (getFlag('onboarding.tour.offered_at')) return;     // offer once, ever
    if (getFlag('onboarding.tour.completed_at')) return;   // already done it
    if (inSetupFlow()) return;                             // don't interrupt setup
    setFlag('onboarding.tour.offered_at', nowISO());
    setTimeout(function () {
      if (inSetupFlow()) return;
      offerToast();
    }, 3500);
  }
  function offerToast() {
    var t = document.createElement('div');
    t.className = 'toast ob-offer-toast';
    t.innerHTML =
      '<span class="ob-offer-text">New here? Take a quick guided tour of Vodou.</span>' +
      '<button type="button" class="ob-offer-yes">Take the tour</button>' +
      '<button type="button" class="ob-offer-no" aria-label="Dismiss">Later</button>';
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    var dismiss = function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 240); };
    t.querySelector('.ob-offer-yes').addEventListener('click', function () { dismiss(); start(0); });
    t.querySelector('.ob-offer-no').addEventListener('click', dismiss);
    setTimeout(function () { if (t.isConnected) dismiss(); }, 15000);
  }

  // Minimal toast (mirrors the app's .toast pattern; self-contained).
  function toast(msg, kind) {
    var t = document.createElement('div');
    t.className = 'toast ' + (kind === 'success' ? 'toast-success' : 'toast-info');
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 240); }, 4200);
  }

  // Small Help menu anchored under the menubar "?" button.
  function openHelpMenu(anchor) {
    var existing = document.getElementById('ob-help-menu');
    if (existing) { existing.remove(); return; }
    var menu = document.createElement('div');
    menu.id = 'ob-help-menu';
    menu.className = 'ob-help-menu';
    menu.innerHTML =
      '<button type="button" data-act="tour">Take the guided tour</button>' +
      '<button type="button" data-act="checklist">Show get-started checklist</button>' +
      '<button type="button" data-act="reset">Reset onboarding tips</button>';
    document.body.appendChild(menu);
    var r = anchor.getBoundingClientRect();
    menu.style.visibility = 'hidden';
    var mw = menu.offsetWidth;
    menu.style.top = (r.bottom + 6) + 'px';
    menu.style.left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8)) + 'px';
    menu.style.visibility = '';
    menu.addEventListener('click', function (e) {
      var act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
      if (act === 'tour') { menu.remove(); replay(); }
      else if (act === 'checklist') { menu.remove(); showChecklist(); }
      else if (act === 'reset') { menu.remove(); doReset(); }
    });
    var closer = function (ev) { if (!menu.contains(ev.target) && ev.target !== anchor) { menu.remove(); document.removeEventListener('click', closer, true); } };
    setTimeout(function () { document.addEventListener('click', closer, true); }, 0);
  }

  function replay() { teardown(); start(0); }
  function doReset() {
    cache = {}; saveCache(); resetServer();
    serverChecklist = {};
    clearCoach();
    // Unify reset with the Board's own inline intro (legacy localStorage flag).
    try { localStorage.removeItem('vodou-board-intro-dismissed'); } catch (_) {}
    refreshChecklistUI();
    toast('Onboarding tips reset — they\'ll show again.', 'info');
  }

  // ───────────────────── Layer B: Get-started checklist ─────────────────────
  // A dismissible launchpad of milestones that auto-check from real signals.
  // Server-derived items come from GET /checklist; client items are flagged on
  // observed actions (⌘K pressed, a channel connected, Apps browsed).
  var CHECK_ITEMS = [
    { id: 'send_first_message',  src: 'server', route: '#/chat',
      label: 'Send your first message', hint: 'Ask Vodou anything in chat.' },
    { id: 'try_command_palette', src: 'client', action: 'palette',
      label: 'Try the command palette', hint: `Press ${window.vodouModChord ? window.vodouModChord('K') : '⌘K'} to jump anywhere.` },
    { id: 'take_the_tour',       src: 'server', action: 'tour',
      label: 'Take the guided tour', hint: 'A quick spin through every feature.' },
    { id: 'connect_messaging',   src: 'client', route: '#/messaging',
      label: 'Connect a messaging channel', hint: 'Slack, Telegram, WhatsApp & more.' },
    { id: 'run_board_task',      src: 'server', route: '#/board',
      label: 'Run a task on the Board', hint: 'Hand work off to an AI agent.' },
    { id: 'browse_apps',         src: 'client', route: '#/apps',
      label: 'Browse apps & integrations', hint: 'Connect Calendar, GitHub, Linear…' },
  ];
  var serverChecklist = {}; // id → bool from the server endpoint

  function ckFlag(id) { return 'onboarding.checklist.' + id; }
  function ckDone(item) {
    if (getFlag(ckFlag(item.id))) return true;
    if (item.src === 'server') return !!serverChecklist[item.id];
    return false;
  }
  function ckCount() { var n = 0; CHECK_ITEMS.forEach(function (i) { if (ckDone(i)) n++; }); return n; }
  function markClient(id) {
    if (getFlag(ckFlag(id))) return;
    setFlag(ckFlag(id), nowISO());
    refreshChecklistUI();
  }
  function fetchServerChecklist() {
    return fetch('/api/onboarding/progress/checklist', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.server) serverChecklist = d.server; })
      .catch(function () {});
  }
  function checkMessagingConnected() {
    if (getFlag(ckFlag('connect_messaging'))) return Promise.resolve();
    return fetch('/api/channels', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var n = d && Array.isArray(d.connected) ? d.connected.length : 0;
        if (n > 0) markClient('connect_messaging');
      }).catch(function () {});
  }

  function renderLauncher() {
    var existing = document.getElementById('ob-checklist-launcher');
    var dismissed = getFlag('onboarding.checklist.dismissed_at');
    var done = ckCount(), total = CHECK_ITEMS.length;
    if (dismissed || done >= total) { if (existing) existing.remove(); return; }
    if (existing) { var c = existing.querySelector('.ob-cl-count'); if (c) c.textContent = done + '/' + total; return; }
    var b = document.createElement('button');
    b.id = 'ob-checklist-launcher';
    b.className = 'ob-checklist-launcher';
    b.type = 'button';
    b.innerHTML = '<span class="ob-cl-spark">✨</span><span class="ob-cl-label">Get started</span><span class="ob-cl-count">' + done + '/' + total + '</span>';
    b.addEventListener('click', openChecklist);
    document.body.appendChild(b);
  }

  function ringSVG(done, total) {
    var R = 13, C = 2 * Math.PI * R, frac = total ? done / total : 0;
    return '<svg class="ob-cl-ring" width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">' +
      '<circle cx="17" cy="17" r="' + R + '" class="ob-cl-ring-track"></circle>' +
      '<circle cx="17" cy="17" r="' + R + '" class="ob-cl-ring-fill" ' +
      'stroke-dasharray="' + C.toFixed(1) + '" stroke-dashoffset="' + (C * (1 - frac)).toFixed(1) + '"></circle>' +
      '<text x="17" y="17" class="ob-cl-ring-num">' + done + '</text></svg>';
  }
  function buildPanelHTML() {
    var done = ckCount(), total = CHECK_ITEMS.length;
    var rows = CHECK_ITEMS.map(function (item) {
      var d = ckDone(item);
      var cta = item.action === 'tour' ? '<span class="ob-cl-go">Start →</span>'
        : item.route ? '<span class="ob-cl-go">Open →</span>' : '';
      return '<button type="button" class="ob-cl-item' + (d ? ' is-done' : '') + '" data-id="' + item.id + '">' +
        '<span class="ob-cl-check" aria-hidden="true">' + (d ? '✓' : '') + '</span>' +
        '<span class="ob-cl-text"><span class="ob-cl-item-label">' + item.label + '</span>' +
        '<span class="ob-cl-item-hint">' + item.hint + '</span></span>' +
        (d ? '' : cta) + '</button>';
    }).join('');
    return '<div class="ob-cl-head">' + ringSVG(done, total) +
      '<div class="ob-cl-headtext"><div class="ob-cl-title">Get started with Vodou</div>' +
      '<div class="ob-cl-sub">' + (done >= total ? 'All done — nice.' : done + ' of ' + total + ' complete') + '</div></div>' +
      '<button type="button" class="ob-cl-x" aria-label="Close">×</button></div>' +
      '<div class="ob-cl-list">' + rows + '</div>' +
      '<div class="ob-cl-foot"><button type="button" class="ob-cl-replay">Replay tour</button>' +
      '<button type="button" class="ob-cl-dismiss">Dismiss</button></div>';
  }
  function openChecklist() {
    closeChecklist();
    var panel = document.createElement('div');
    panel.id = 'ob-checklist-panel';
    panel.className = 'ob-checklist-panel';
    panel.innerHTML = buildPanelHTML();
    document.body.appendChild(panel);
    wireChecklistPanel(panel);
    // Refresh signals, then re-render contents in place.
    fetchServerChecklist().then(checkMessagingConnected).then(function () {
      var p = document.getElementById('ob-checklist-panel');
      if (p) { p.innerHTML = buildPanelHTML(); wireChecklistPanel(p); }
      renderLauncher();
    });
  }
  function closeChecklist() {
    var p = document.getElementById('ob-checklist-panel');
    if (p) p.remove();
  }
  function wireChecklistPanel(panel) {
    panel.querySelectorAll('.ob-cl-item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        var item = CHECK_ITEMS.filter(function (i) { return i.id === id; })[0];
        if (!item) return;
        closeChecklist();
        if (item.action === 'tour') { replay(); }
        else if (item.route) { location.hash = item.route; }
      });
    });
    panel.querySelector('.ob-cl-x').addEventListener('click', closeChecklist);
    panel.querySelector('.ob-cl-replay').addEventListener('click', function () { closeChecklist(); replay(); });
    panel.querySelector('.ob-cl-dismiss').addEventListener('click', function () {
      setFlag('onboarding.checklist.dismissed_at', nowISO());
      closeChecklist(); renderLauncher();
    });
  }
  function showChecklist() {
    // From the Help menu — clears the dismissed flag so it sticks around again.
    if (getFlag('onboarding.checklist.dismissed_at')) { cache['onboarding.checklist.dismissed_at'] = ''; saveCache(); setFlag('onboarding.checklist.dismissed_at', ''); }
    openChecklist(); renderLauncher();
  }
  function refreshChecklistUI() {
    renderLauncher();
    var p = document.getElementById('ob-checklist-panel');
    if (p) { p.innerHTML = buildPanelHTML(); wireChecklistPanel(p); }
  }
  function initChecklist() {
    // Client signals.
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) markClient('try_command_palette');
    }, true);
    window.addEventListener('hashchange', function () {
      if ((location.hash || '').indexOf('#/apps') === 0) markClient('browse_apps');
    });
    fetchServerChecklist().then(checkMessagingConnected).then(renderLauncher);
  }

  // ───────────────────── Layer C: first-visit coachmarks ─────────────────────
  // The first time you open a view, a small non-blocking tip points at its hero.
  // One per view, ever (until reset). The Board keeps its own richer inline intro
  // (reset is unified below), so it's intentionally absent here.
  var COACH = [
    { id: 'memory', match: '/memory', anchor: '.memory-header-row', fallback: 'a.nav-item[href="#/memory"]',
      title: 'Memory', body: 'Switch between Timeline and Mind-map to see what Vodou has learned about you — it keeps building as you work.' },
    { id: 'messaging', match: '/messaging', anchor: '#main-content h1', fallback: '#nav-messaging > summary',
      title: 'Messaging', body: 'Pick a platform to connect. Once linked, Vodou can read and reply where you already chat.' },
    { id: 'apps', match: '/apps', anchor: '#main-content h1', fallback: '#nav-apps > summary',
      title: 'Apps', body: 'Connect an app via OAuth and Vodou can act on it — your calendar, repos, issues, and more.' },
    { id: 'capabilities', match: '/capabilities', anchor: '#main-content h1', fallback: '#nav-capabilities > summary',
      title: 'Skills & Tools', body: 'Toggle skills on/off, write routing rules, register scripts, and manage lenses — this is Vodou’s toolkit.' },
    { id: 'activity', match: '/activity', anchor: '#main-content h1', fallback: '#nav-activity > summary',
      title: 'Activity', body: 'See what’s scheduled, what has run, and your work-log history. Add a recurring task right here.' },
    { id: 'projects', match: '/projects', anchor: '#main-content h1', fallback: '#nav-projects > summary',
      title: 'Projects', body: 'Create a workspace with its own files and instructions. Switch the active project from the dock.' },
    { id: 'settings', match: '/settings', anchor: '#main-content h1', fallback: '#nav-settings > summary',
      title: 'Settings', body: 'Set your model & provider, profile, environment secrets, and memory tuning here.' },
  ];
  function coachSeen(id) { return !!getFlag('onboarding.coach.' + id + '_seen_at'); }
  function pathFromHash() {
    var raw = (location.hash || '').slice(1) || '/chat';
    var q = raw.indexOf('?'); var p = q >= 0 ? raw.slice(0, q) : raw;
    if (p.length > 1 && p.charAt(p.length - 1) === '/') p = p.slice(0, -1);
    return p.charAt(0) === '/' ? p : '/' + p;
  }
  var coachEls = null;
  function clearCoach() {
    if (coachEls) { if (coachEls.card) coachEls.card.remove(); if (coachEls.ring) coachEls.ring.remove(); coachEls = null; }
  }
  function maybeCoach() {
    if (els) return;              // never while the full tour is running
    clearCoach();
    var path = pathFromHash();
    var c = null;
    for (var i = 0; i < COACH.length; i++) { if (path.indexOf(COACH[i].match) === 0) { c = COACH[i]; break; } }
    if (!c || coachSeen(c.id)) return;
    var sel = c.anchor;
    waitForEl(sel, 3500).then(function (el) {
      if (!el && c.fallback) { el = document.querySelector(c.fallback); }
      if (!el || els) return;
      if (pathFromHash().indexOf(c.match) !== 0) return; // user navigated away
      showCoach(c, el);
    });
  }
  function showCoach(c, el) {
    clearCoach();
    var ring = document.createElement('div');
    ring.className = 'ob-coach-ring';
    var card = document.createElement('div');
    card.className = 'ob-coach';
    card.innerHTML = '<div class="ob-coach-title">' + c.title + '</div>' +
      '<div class="ob-coach-body">' + c.body + '</div>' +
      '<div class="ob-coach-actions"><button type="button" class="ob-coach-got">Got it</button></div>';
    document.body.appendChild(ring);
    document.body.appendChild(card);
    coachEls = { ring: ring, card: card };
    positionCoach(el);
    var onScroll = function () { var t = document.querySelector(c.anchor) || (c.fallback && document.querySelector(c.fallback)); if (t) positionCoach(t); };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    function done() {
      window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onScroll);
      setFlag('onboarding.coach.' + c.id + '_seen_at', nowISO());
      clearCoach();
    }
    card.querySelector('.ob-coach-got').addEventListener('click', done);
  }
  function positionCoach(el) {
    if (!coachEls) return;
    var rect = el.getBoundingClientRect();
    var pad = 5;
    var rs = coachEls.ring.style;
    rs.top = Math.max(0, rect.top - pad) + 'px'; rs.left = Math.max(0, rect.left - pad) + 'px';
    rs.width = (rect.width + pad * 2) + 'px'; rs.height = (rect.height + pad * 2) + 'px';
    var card = coachEls.card, gap = 12;
    card.style.visibility = 'hidden'; card.style.left = '0px'; card.style.top = '0px';
    var cw = card.offsetWidth, ch = card.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    var below = rect.bottom + gap + ch <= vh - 12 || rect.top - gap - ch < 12;
    var top = below ? rect.bottom + gap : rect.top - gap - ch;
    var left = rect.left;
    if (left + cw > vw - 12) left = vw - cw - 12;
    card.style.top = Math.max(12, Math.min(top, vh - ch - 12)) + 'px';
    card.style.left = Math.max(12, left) + 'px';
    card.style.visibility = '';
  }

  // ───────────────────── "What's new" since last visit ─────────────────────
  // Returning users who've added MCP servers / skills since their last visit get
  // a one-time nudge naming the new capabilities. Directly serves the "ongoing
  // sync for onboarding" goal. Baseline is established silently on first run.
  var WN_KEY = 'onboarding.whatsnew.snapshot';
  // Shared escaper — safe.js loads first, so VodouSafe is always present.
  function escHtml(s) { return window.VodouSafe.escapeHtml(s); }
  function fetchCaps() {
    return fetch('/api/onboarding/progress/capabilities', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  function readSnapshot() { try { return JSON.parse(getFlag(WN_KEY) || 'null'); } catch (_) { return null; } }
  function saveSnapshot(caps) { setFlag(WN_KEY, JSON.stringify({ servers: caps.servers || [], skills: caps.skills || [] })); }
  function diffNew(curr, prev) {
    var ps = {}, pk = {};
    (prev.servers || []).forEach(function (n) { ps[n] = 1; });
    (prev.skills || []).forEach(function (n) { pk[n] = 1; });
    return {
      servers: (curr.servers || []).filter(function (n) { return !ps[n]; }),
      skills: (curr.skills || []).filter(function (n) { return !pk[n]; }),
    };
  }
  function initWhatsNew() {
    if (!getFlag('onboarding.tour.completed_at')) return; // only returning users
    fetchCaps().then(function (caps) {
      if (!caps) return;
      var prev = readSnapshot();
      if (!prev) { saveSnapshot(caps); return; } // first run → silent baseline
      var d = diffNew(caps, prev);
      if (d.servers.length + d.skills.length === 0) return;
      saveSnapshot(caps); // update so each addition nudges only once
      if (els) return;    // not during the tour
      whatsNewToast(d);
    });
  }
  function whatsNewToast(d) {
    var names = d.servers.concat(d.skills);
    var shown = names.slice(0, 3).map(escHtml).join(', ');
    var extra = names.length > 3 ? ' +' + (names.length - 3) + ' more' : '';
    var dest = d.servers.length ? '#/apps' : '#/capabilities?tab=skills';
    var t = document.createElement('div');
    t.className = 'toast ob-offer-toast';
    t.innerHTML =
      '<span class="ob-offer-text">✨ New since your last visit: <b>' + shown + '</b>' + extra + '</span>' +
      '<button type="button" class="ob-offer-yes">Show me</button>' +
      '<button type="button" class="ob-offer-no" aria-label="Dismiss">Dismiss</button>';
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    var dismiss = function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 240); };
    t.querySelector('.ob-offer-yes').addEventListener('click', function () { dismiss(); location.hash = dest; });
    t.querySelector('.ob-offer-no').addEventListener('click', dismiss);
    setTimeout(function () { if (t.isConnected) dismiss(); }, 16000);
  }

  // Demo/diagnostic: force the what's-new toast with sample data, ignoring the
  // snapshot/diff. Reachable via /?whatsnew=demo or OnboardingTour.demoWhatsNew().
  function demoWhatsNew() { whatsNewToast({ servers: ['Google Calendar', 'Linear'], skills: ['daily-standup'] }); }

  function init() {
    loadCache();
    initChecklist();
    window.addEventListener('hashchange', function () { setTimeout(maybeCoach, 350); });
    syncFromServer().then(function () {
      // Deep link: /?tour=1 starts the tour (docs links, re-share). /?tour=N
      // (1-based) jumps to stop N — handy for sharing a specific feature.
      if (/[?&]whatsnew=demo(&|$)/.test(location.search)) { setTimeout(demoWhatsNew, 700); return; }
      if (/[?&]checklist=1(&|$)/.test(location.search)) { setTimeout(openChecklist, 600); return; }
      var m = /[?&]tour=(\d+)(&|$)/.exec(location.search);
      if (m) { var idx = Math.max(0, Math.min(parseInt(m[1], 10) - 1, STOPS.length - 1)); setTimeout(function () { start(idx); }, 600); return; }
      maybeOffer();
      setTimeout(maybeCoach, 900);     // first-visit coachmark for the landing view
      setTimeout(initWhatsNew, 5000);  // returning-user "what's new" nudge
    });
  }

  window.OnboardingTour = {
    init: init, start: start, replay: replay, reset: doReset, openHelpMenu: openHelpMenu,
    openChecklist: openChecklist, showChecklist: showChecklist,
    demoWhatsNew: demoWhatsNew,
    version: 7, // bump with the ?v= query so you can confirm the loaded build
    _stops: STOPS, // exposed for debugging
  };
})();
