(function () {
  'use strict';
  // DI-2 (ALPHA-READINESS §9 D) — say it out loud when the database is damaged.
  //
  // gateway.db has corrupted itself four times with no identified cause. The
  // gateway already KNOWS: db-health.ts runs quick_check and watches every write
  // for corruption errors, and /health has reported `dbHealthy` the whole time.
  // Nothing in the UI has ever read it. So the observable symptom of "messages
  // are being lost" was messages quietly not being there.
  //
  // This is deliberately the VISIBILITY half of DI-2 and not the automatic
  // fail-over half. Recovery for a corruption whose cause is unknown risks
  // papering over the one signal that would identify it; telling the operator,
  // immediately and unmissably, costs nothing and loses nothing. The root cause
  // stays open (§9.3).
  //
  // Faster poll than runtime-badge's 25s: this is data loss in progress, and the
  // gap between "it broke" and "you know" is the whole point.
  //
  // ── Dismissal (2026-09-04) ───────────────────────────────────────────────
  //
  // The 2026-09-04 incident was a correct alarm that stayed up for hours of
  // legitimate diagnosis and repair, across every tab, with no way to move it
  // out of the way. A warning you cannot put down gets worked around — people
  // stop opening the console, which is the same blindness this banner exists to
  // end, arrived at from the other direction.
  //
  // So it closes. But a data-loss alarm that can be turned into NOTHING is the
  // 46-hour silence again, one click away, so `×` collapses it to a chip rather
  // than removing it: the bar gets out of the way, the fact stays on screen.
  // Three things re-open it, because each is new information the dismissal never
  // covered — a CHANGED verdict (on 2026-09-04 the error moved from "2nd
  // reference to page 56933" to "Rowid 687194767425 out of order" under the same
  // latched flag), a reload, and damage that returns after a recovery.
  var POLL_MS = 15000;
  var BANNER_ID = 'vodou-db-health-banner';
  var wasUnhealthy = false;

  /** Collapsed to the chip? And the verdict that was dismissed, so a NEW one re-opens. */
  var collapsed = false;
  var dismissedFor = null;
  /** The verdict currently on screen, and the last HTML written — the poll runs
   *  every 15s and rewriting an unchanged `role="alert"` re-announces it. */
  var currentKey = '';
  var lastRender = '';

  // Inline styles on purpose: this must render even if a stylesheet failed to
  // load, which is exactly the kind of morning where the database is also bad.
  var EXPANDED_CSS = [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483646',
    'background:#7f1d1d', 'color:#fff', 'padding:10px 44px 10px 16px',
    'font:600 13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'box-shadow:0 2px 8px rgba(0,0,0,.4)', 'text-align:left'
  ].join(';');

  var COLLAPSED_CSS = [
    'position:fixed', 'top:8px', 'right:8px', 'left:auto', 'z-index:2147483646',
    'background:#7f1d1d', 'color:#fff', 'padding:0', 'border-radius:999px',
    'font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'box-shadow:0 2px 8px rgba(0,0,0,.4)', 'text-align:left'
  ].join(';');

  var BTN_CSS = 'position:absolute;top:6px;right:8px;width:28px;height:28px;' +
    'background:transparent;border:0;color:#fff;font:400 20px/1 sans-serif;' +
    'cursor:pointer;opacity:.8;padding:0';

  var CHIP_CSS = 'background:transparent;border:0;color:#fff;cursor:pointer;' +
    'font:600 12px/1 inherit;padding:7px 13px';

  function expandedHtml(detail) {
    return '<strong>Vodou’s database reports damage — new messages may not be saved.</strong> ' +
      '<span style="font-weight:400">' +
      'Stop using this window for anything you need kept. ' +
      'Your memory files on disk are unaffected; this is the gateway’s own conversation store. ' +
      'Details are in the gateway log on lines beginning <code>[db-health]</code>.' +
      (detail ? ' <span style="opacity:.85">(' + String(detail).slice(0, 160) + ')</span>' : '') +
      '</span>' +
      '<button type="button" data-db-health="dismiss" aria-label="Dismiss this warning" ' +
      'title="Dismiss — comes back on a new error, a reload, or if damage returns" ' +
      'style="' + BTN_CSS + '">×</button>';
  }

  function collapsedHtml() {
    return '<button type="button" data-db-health="expand" ' +
      'title="Vodou’s database reports damage — click to reopen" ' +
      'style="' + CHIP_CSS + '">⚠ Database damaged</button>';
  }

  function ensureBanner() {
    var el = document.getElementById(BANNER_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = BANNER_ID;
    el.setAttribute('role', 'alert');
    el.style.cssText = EXPANDED_CSS;
    // Delegated once, on the container: the poll rewrites innerHTML every time
    // the verdict changes, and a handler bound to the button itself would be
    // thrown away with it.
    el.addEventListener('click', onClick);
    document.body.appendChild(el);
    return el;
  }

  function onClick(ev) {
    var target = ev && ev.target;
    var act = target && target.getAttribute && target.getAttribute('data-db-health');
    if (act !== 'dismiss' && act !== 'expand') return;
    collapsed = act === 'dismiss';
    // Remember WHICH verdict was dismissed, not merely that one was.
    dismissedFor = collapsed ? currentKey : null;
    lastRender = '';
    render();
  }

  function render() {
    var el = ensureBanner();
    el.hidden = false;
    var html = collapsed ? collapsedHtml() : expandedHtml(currentKey);
    if (html === lastRender) return;   // do not re-announce an unchanged alert
    lastRender = html;
    el.style.cssText = collapsed ? COLLAPSED_CSS : EXPANDED_CSS;
    el.innerHTML = html;
  }

  function show(detail) {
    var key = String(detail == null ? '' : detail);
    // A CHANGED verdict is information the dismissal never covered.
    if (collapsed && dismissedFor !== key) collapsed = false;
    currentKey = key;
    render();
  }

  function hide() {
    var el = document.getElementById(BANNER_ID);
    if (el) el.hidden = true;
    // Recovery resets the dismissal: damage that comes BACK is news, and must
    // not inherit the shrug that saw off the last one.
    collapsed = false;
    dismissedFor = null;
    lastRender = '';
  }

  async function tick() {
    try {
      var res = await fetch('/health', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!res.ok) return;              // an unreachable gateway is a different problem
      var data = await res.json();
      // Absent means an older gateway that does not report it. Treat only an
      // EXPLICIT false as damage — inferring corruption from a missing field
      // would put a red banner on every older install.
      if (data && data.dbHealthy === false) {
        if (!wasUnhealthy) {
          console.error('[db-health] gateway reports dbHealthy:false', data.db || '');
        }
        wasUnhealthy = true;
        show(data.db && (data.db.reason || data.db.error));
      } else if (wasUnhealthy) {
        // Recovered (usually a restart onto a repaired file). Say so rather than
        // vanishing silently, so nobody wonders whether they imagined it.
        wasUnhealthy = false;
        console.warn('[db-health] gateway now reports the database healthy again');
        hide();
      }
    } catch (_) { /* transient fetch failure is not evidence of corruption */ }
  }

  document.addEventListener('DOMContentLoaded', function () {
    tick();
    setInterval(tick, POLL_MS);
  });
})();
