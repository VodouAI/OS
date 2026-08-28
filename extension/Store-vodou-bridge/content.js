// Vodou Bridge — in-page capture button + netcap relay (PLAN-UNIVERSAL-MEMORY).
// Injected on every supported AI-chat host. Two independent jobs:
//   1. The floating save button (Vodou mark, expands on hover) — ONLY on
//      chatgpt.com / claude.ai, where the gateway's trigger_capture import
//      path has an extractor.
//   2. The netcap relay (bottom of file) — on ALL hosts; forwards turns that
//      inject.js teed from the page's own network traffic (opt-in toggle).
// The page itself never talks to the gateway (a chatgpt.com origin would be
// CSRF-blocked); it only messages our own extension.

(function () {
  // A content script can be EVALUATED in a context whose extension bridge is
  // already dead — an extension reload/update racing the injection leaves
  // chrome.runtime undefined, and every job in this file needs it (the button
  // and relay sendMessage; the panel bridge registers onMessage). Bail before
  // touching anything, and BEFORE claiming the mount token, so the next healthy
  // injection still arms. Observed 2026-07-30 as an uncaught TypeError
  // ("reading 'onMessage'") in the extensions error console after a reload.
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;

  // …and the OTHER order, which is the common one. The guard above catches a
  // script INJECTED into a dead context. This catches a script that mounted into
  // a healthy one, ran for hours, and had the context die underneath it when the
  // extension updated — which happens to every open chatgpt.com / claude.ai tab
  // on every single update. Chrome then throws "Extension context invalidated"
  // from any chrome.runtime.* call, and the user gets a raw stack trace at the
  // moment they pressed a button (observed 2026-08-27 at content.js:503, right
  // after an extension reload).
  //
  // Cure is a tab reload. The point of this is to SAY that, on the control the
  // user just pressed, instead of in a console they will never open.
  function bridgeAlive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }
  // Checked AND caught at every call site: the check makes the message specific,
  // and the try is what makes it airtight, because the context can die between
  // the check and the call.
  const BRIDGE_STALE = 'Vodou was updated — reload this tab';

  // Mount guards are versioned, not boolean. Reloading the extension orphans the
  // content script in every already-open tab; re-injecting the new build into such
  // a tab used to hit a `=== true` guard and return before registering anything, so
  // the panel's probe/insert handlers never existed and the panel looked broken
  // while reporting nothing. Comparing against the build version means a new build
  // re-arms; the same build stays idempotent.
  const MOUNT_TOKEN = (() => {
    try { return chrome.runtime.getManifest().version; } catch (_) { return 'unknown'; }
  })();
  if (window.__vodouCaptureButtonMounted === MOUNT_TOKEN) return;
  window.__vodouCaptureButtonMounted = MOUNT_TOKEN;

  // Hosts where the one-click full-conversation import works today.
  const BUTTON_HOSTS = /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$|(^|\.)claude\.ai$/;

  // ── The in-page save control (redesigned 2026-07-30, Chad) ─────────────────
  //
  // Was a green 🧠 pill reading "Save to Vodou", parked at bottom-right over the
  // composer. Three problems: the emoji is not our mark, green is the colour this
  // button turns on SUCCESS (so the resting state already looked like a result),
  // and a permanently-expanded pill sits in the user's way on a surface we do not
  // own.
  //
  // Now: the Vodou mark at rest in a 40px disc, expanding to a labelled pill on
  // hover/focus. Parked in the true bottom-right corner (Chad, 2026-07-30, after
  // seeing it in situ): both ChatGPT and Claude centre their composer, so the
  // corner is empty and the earlier 88px lift was buying clearance nothing needed.
  //
  // The mark is INLINE SVG rather than icons/icon128.png on purpose — an <img>
  // from the extension needs the icon in `web_accessible_resources`, which hands
  // every page a fingerprintable URL and adds a manifest surface CWS review asks
  // about. An inline path costs nothing and stays sharp at any size.
  const VODOU_BLUE = '#2563EB';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // The REAL brand mark, not an approximation of it.
  //
  // The two paths below are lifted verbatim from app-vodou-ai/public/images/
  // vodou-bimi.svg — the BIMI logo, which is the canonical Vodou mark. The first
  // hand-drawn stand-in looked close at 18px and was still the wrong logo.
  //
  // It has to be INLINE SVG, and that is not a style preference: claude.ai serves
  // `img-src 'self' https://challenges.cloudflare.com`, so an <img> pointed at a
  // data: URI — or at a chrome-extension:// URL via web_accessible_resources — is
  // refused by the page's CSP and renders as nothing. Inline SVG is drawn, not
  // fetched, so no img-src rule applies. (Verified against the live CSP header,
  // 2026-07-30.) Built with createElementNS, never innerHTML, per the store-build
  // discipline in controls.js.
  // NOT the BIMI file's own viewBox. That file declares `550 540 3510 3510`
  // because the BIMI spec demands a square box, and the artwork is 4611 x 4461 —
  // so the declared box crops roughly 550 units off each side and the mark loses
  // its edges and the pin. Measured with getBBox() in a real renderer rather than
  // eyeballed: bbox = 0 0 4610.9 4460.7, squared off and padded 4% here.
  const MARK_VIEWBOX = '-184.4 -259.6 4979.8 4979.8';
  const MARK_WHITE_D = 'M1970.93 1494.22c-256.36,74.69 -459,247.62 -578.75,465.88 -119.71,218.29 -156.71,482.02 -82.02,738.45 38.17,130.94 101.52,247.47 182.95,345.75 185.97,224.49 786.79,530.63 1050.06,569.14 -26.27,-43.09 -53.52,-93.66 -75.97,-148.24l-33.87 -82.25 1318.14 -384.12c256.35,-74.73 458.96,-247.67 578.75,-465.88 119.74,-218.25 156.75,-482.02 81.98,-738.41 -74.69,-256.36 -247.58,-459 -465.88,-578.79 -218.25,-119.74 -481.98,-156.75 -738.41,-82.02l-1236.98 360.49z';
  const MARK_BLUE_D = 'M4350.83 2125.88c-31.59,54.55 -101.78,73.29 -156.34,41.84l-156.1 -90.18 -90.23 156.09c-31.45,54.56 -101.73,73.25 -156.24,41.79 -54.51,-31.54 -73.39,-101.83 -41.79,-156.29l90.18 -156.14 -156.05 -90.24c-54.56,-31.45 -73.24,-101.73 -41.84,-156.29 31.55,-54.46 101.84,-73.34 156.3,-41.74l156.14 90.18 90.18 -156.05c31.51,-54.41 101.84,-73.24 156.25,-41.84 54.55,31.6 73.29,101.84 41.79,156.34l-90.09 156.1 156.01 90.18c54.45,31.46 73.24,101.84 41.83,156.25zm-1718.92 -338.02c-267.1,77.85 -420.54,357.48 -342.68,624.59 77.86,267.05 357.49,420.53 624.59,342.68 267.05,-77.86 420.53,-357.49 342.68,-624.59 -77.86,-267.06 -357.49,-420.54 -624.59,-342.68zm497.37 689.63c-31.7,54.94 -102.37,73.73 -157.31,42.08l-157.07 -90.81 -90.82 157.11c-31.6,54.95 -102.46,73.78 -157.31,42.09 -54.85,-31.7 -73.82,-102.42 -42.08,-157.31l90.86 -157.17 -157.07 -90.77c-54.94,-31.65 -73.78,-102.41 -42.08,-157.36 31.7,-54.8 102.42,-73.78 157.26,-41.98l157.12 90.81 90.77 -157.02c31.64,-54.89 102.51,-73.78 157.31,-42.13 54.9,31.75 73.73,102.42 42.03,157.31l-90.71 157.07 157.02 90.82c54.84,31.59 73.77,102.41 42.08,157.26zm-1299.6 -1924.39c-184.06,53.59 -354.43,131.54 -508.64,229.05l-591.09 -387.43c11.06,-139.01 -58.44,-278.12 -188.57,-349.57 -177.02,-97.12 -399.18,-32.37 -496.25,144.6 -97.08,176.97 -32.38,399.12 144.59,496.2 130.23,71.4 284.87,55.29 396.17,-28.73l557.75 251.37c-438.54,350.25 -711.91,873.88 -746.42,1436.39 -17.67,2.43 -35.38,6.16 -52.86,11.26 -264.24,77.03 -393.54,430.78 -288.84,790.1 104.74,359.38 403.83,588.28 668.07,511.3 17.52,-5.14 34.46,-11.5 50.72,-18.93 480.53,661.28 1340.82,983.72 2170.76,741.86 764.43,-222.74 1293.4,-863.35 1411.15,-1600.79 43.15,-53.2 81.35,-110.13 114.21,-169.98 139.45,-254.14 182.5,-561.34 95.48,-860.09 -87.08,-298.7 -288.47,-534.74 -542.61,-674.24 -104.74,-57.47 -218.62,-98.59 -337.1,-120.96 -493.97,-423.49 -1185.25,-597.07 -1856.52,-401.41zm141.29 941.06l1236.94 -360.49c256.43,-74.7 520.18,-37.72 738.46,82.02 218.23,119.8 391.16,322.44 465.87,578.82 74.7,256.38 37.71,520.13 -82.03,738.36 -119.8,218.28 -322.39,391.17 -578.77,465.92l-1318.1 384.08 33.83 82.27c22.48,54.56 49.75,105.18 76.01,148.28 -263.31,-38.58 -864.07,-344.67 -1050.07,-569.15 -81.44,-98.29 -144.79,-214.83 -182.94,-345.79 -74.7,-256.38 -37.71,-520.18 82.03,-738.46 119.74,-218.22 322.34,-391.16 578.77,-465.86z';

  function vodouMark(px) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', MARK_VIEWBOX);
    svg.setAttribute('width', String(px));
    svg.setAttribute('height', String(px));
    svg.setAttribute('aria-hidden', 'true');
    svg.style.flex = 'none';
    svg.style.display = 'block';
    const bubble = document.createElementNS(SVG_NS, 'path');
    bubble.setAttribute('d', MARK_WHITE_D);
    bubble.setAttribute('fill', '#fff');
    const body = document.createElementNS(SVG_NS, 'path');
    body.setAttribute('d', MARK_BLUE_D);
    body.setAttribute('fill', VODOU_BLUE);
    svg.append(bubble, body);
    return svg;
  }

  // Mounted HERE, not at the top of the IIFE, because mountContextButton also
  // mounts the inject button and that reads the brand constants above. Calling it
  // before them threw "Cannot access 'VODOU_BLUE' before initialization"
  // (2026-08-01) — a plain temporal-dead-zone reference. The damage was not the
  // inject button: the exception escaped the IIFE, so the SAVE button below never
  // got created either and the page showed NO Vodou controls at all. One
  // out-of-order const took out every in-page control on 22 hosts.
  //
  // Recorded rather than rethrown, so a future failure in one control can never
  // again take the others with it. The vm test asserts this stays unset — and it
  // only can, now that the test loads sites.js first; without VODOU_SITES the
  // inject button returns at `if (!site)` and its whole body is unreachable,
  // which is exactly why 69 green tests missed this.
  try {
    mountContextButton(); // PLAN-MEMORY-FOLLOWS-YOU — 🧠 context on ALL hosts
  } catch (e) {
    window.__vodouBootstrapError = (e && e.message) || String(e);
    console.warn('[vodou] in-page controls failed to mount:', e);
  }
  if (!BUTTON_HOSTS.test(location.hostname)) { mountRelayOnly(); return; }
  // The in-page control lives in mountContextButton() above — one disc that fans
  // open into the actions this host supports. This is the SAVE action it calls.
  //
  // A hoisted function DECLARATION on purpose: mountContextButton runs earlier in
  // the file than this line, and only a declaration is fully hoisted. A const arrow
  // here would be in its temporal dead zone at that point — which is exactly the
  // bug that removed every in-page button on 2026-08-01.
  //
  // "Save what's here", not "Save chat" (Chad, 2026-07-30). The gateway extractor
  // reads RENDERED message nodes, and ChatGPT/Claude virtualise long threads, so on
  // a long conversation this reaches what is loaded rather than the whole thing.
  // The panel's history-import button was removed for promising exactly that
  // (2d030982); this one survives by describing what it actually does.
  function triggerCapture(source, site, report) {
    try {
      chrome.runtime.sendMessage(
        { type: 'trigger_capture', url: location.href, source, site, extract: 'background' },
        (resp) => {
          if (chrome.runtime.lastError) {
            report('✗ ' + chrome.runtime.lastError.message.slice(0, 40), false);
            return;
          }
          if (resp && resp.ok) {
            const r = resp.result || {};
            report('✓ Saved' + (r.messages != null ? ' (' + r.messages + ' msgs)' : ''), true);
          } else {
            report('✗ ' + ((resp && resp.error) || 'failed').slice(0, 40), false);
          }
        },
      );
    } catch (e) {
      report('✗ ' + String(e && e.message).slice(0, 40), false);
    }
  }


  mountRelayOnly();

  // ── PLAN-MEMORY-FOLLOWS-YOU: 🧠 context button ─────────────────────────────
  // Fetches a vault-scoped context block from the local gateway and inserts it
  // into the site's composer. Three-tier insertion: (1) the focused/likely
  // composer via execCommand insertText (works for textarea AND contenteditable
  // in Chrome), (2) native value setter for stubborn textareas, (3) clipboard +
  // toast — the fallback that can never break on a DOM change. Alt+V shortcut.
  function mountContextButton() {
    if (window.__vodouContextButtonMounted === MOUNT_TOKEN) return;
    window.__vodouContextButtonMounted = MOUNT_TOKEN;

    // Where inject reports. Once the in-page control is mounted this points at its
    // "Add my memory" label, so progress and results land ON the button instead of
    // in a box floating beside it (Chad, 2026-08-01). It is wired after MOUNT, not
    // per click, so the Ctrl+B shortcut reports to the same place a click does.
    // Null only where no control mounted — then toast() keeps the floating div,
    // because reporting nothing at all is worse than reporting it in an ugly box.
    let fabReport = null;

    // ok === undefined means "still working": the line holds until something
    // replaces it. A boolean is terminal and restores the label after a beat.
    /**
     * PLAN-INJECT-RECEIPT-UI — "4 memories · 2 tools · 1 skill" from a receipt.
     *
     * COHERENCE F8 — the rules (what counts, how it pluralises, and the silent
     * case) live in receipt.js now, which the manifest loads into this bundle
     * ahead of content.js. This was the third copy of them.
     */
    function receiptLabel(r) {
      return globalThis.VodouReceipt.label(r);
    }

    function toast(text, ok, opts) {
      // opts.float: always the floating bubble — never routed into the disc's
      // collapsed report pill (a confirmation nobody saw, 2026-08-18).
      // isConnected, not just non-null: between an SPA wiping the body and the
      // 3-second remount, this still references the OLD detached pill, and
      // reporting into a node that is not in the document is a silent drop. Fall
      // back to the floating div for that window.
      const float = !!(opts && opts.float);
      if (!float) if (fabReport && fabReport.isConnected) { fabReport.__vodouReport(text, ok); return; }
      const t = document.createElement('div');
      t.textContent = text;
      Object.assign(t.style, {
        position: 'fixed', bottom: '100px', right: '18px', zIndex: '2147483647',
        padding: '8px 12px', fontSize: '12px', borderRadius: '8px', color: '#fff',
        background: ok === false ? '#b91c1c' : '#1f2937',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        boxShadow: '0 2px 10px rgba(0,0,0,.35)', maxWidth: '340px',
      });
      document.body.appendChild(t);
      setTimeout(() => { try { t.remove(); } catch (_) {} }, float ? 5000 : 4000);
    }

    // ── PLAN-VODOU-TASKS-CHANNEL — the in-page task pill ───────────────────────
    // A task runs asynchronously (a deep-thinking session is ~40s), so the page needs
    // a persistent "Vodou is working on your machine" indicator — not a 4s toast that
    // vanishes while the work continues. It shows live steps, and on a heavy task
    // offers a one-click "open panel" (a CLICK is a user gesture, which is the only
    // way the panel may be opened from a page-initiated task).
    // NOTE: deliberately NO setInterval here. content.js runs on all 22 hosts and a
    // standing guard (test/sites.test.mjs) allows exactly ONE interval — the FAB
    // remount loop — so a second timer would put a recurring loop on every AI site for
    // something transient. The pill updates on each streamed event instead (the gateway
    // emits one per tool/step), computing elapsed at paint time.
    const taskPill = (() => {
      let el = null, label = null, btn = null, jobId = null, steps = 0, startedAt = 0;
      const ensure = () => {
        if (el && el.isConnected) return el;
        el = document.createElement('div');
        Object.assign(el.style, {
          position: 'fixed', bottom: '100px', right: '18px', zIndex: '2147483647',
          padding: '8px 12px', fontSize: '12px', borderRadius: '999px', color: '#fff',
          background: '#111827', display: 'flex', alignItems: 'center', gap: '8px',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          boxShadow: '0 2px 12px rgba(0,0,0,.4)', maxWidth: '360px',
        });
        label = document.createElement('span');
        btn = document.createElement('button');
        btn.textContent = 'open';
        Object.assign(btn.style, {
          background: '#2563eb', color: '#fff', border: 'none', borderRadius: '999px',
          padding: '3px 9px', fontSize: '11px', cursor: 'pointer', fontFamily: 'inherit',
        });
        btn.hidden = true;
        // The click is the gesture that lets the background open the side panel.
        btn.addEventListener('click', () => {
          try { chrome.runtime.sendMessage({ type: 'vodou_open_panel_from_page' }); } catch (_) {}
        });
        el.append(label, btn);
        try { document.body.appendChild(el); } catch (_) {}
        return el;
      };
      const elapsed = () => (startedAt ? ` · ${Math.round((Date.now() - startedAt) / 1000)}s` : '');
      return {
        start(id) {
          jobId = id; steps = 0; startedAt = Date.now();
          ensure();
          label.textContent = '🧠 Vodou working locally…';
          btn.hidden = true;
        },
        update(id, event, heavy) {
          if (!el || !el.isConnected) ensure();
          if (id && jobId && id !== jobId) return;
          if (!startedAt) { jobId = id; startedAt = Date.now(); }
          const e = event || {};
          if (e.type === 'tool_start') { steps++; label.textContent = `🧠 running ${e.tool || 'a tool'}…${elapsed()} · ${steps} steps`; }
          else if (e.type === 'status' && e.status) label.textContent = `🧠 ${String(e.status).slice(0, 50)}${elapsed()}`;
          else if (e.type === 'chunk') label.textContent = `🧠 writing…${elapsed()}${steps ? ` · ${steps} steps` : ''}`;
          else if (e.type === 'error') { label.textContent = `✗ ${String(e.message || 'failed').slice(0, 80)}`; }
          if (heavy) btn.hidden = false;   // heavy work → offer the live Tasks view
        },
        done(id, ok, note) {
          startedAt = 0;
          if (!el || !el.isConnected) return;
          label.textContent = (ok ? '✓ ' : '🧠 ') + (note || (ok ? 'done' : 'result ready in the Vodou panel'));
          btn.hidden = ok;                  // if we couldn't inject, keep "open" available
          const dead = el;
          setTimeout(() => { try { if (dead === el) { dead.remove(); el = null; } } catch (_) {} }, ok ? 3500 : 9000);
          jobId = null;
        },
      };
    })();

    // Find the site's composer. Site-specific selectors first (a ProseMirror /
    // Lexical root survives DOM churn better than geometry and is the RIGHT
    // element to feed the editor's own input pipeline), then the focused
    // editable, then the visible editable nearest the bottom of the viewport.
    const COMPOSER_SELECTORS = [
      'div.ProseMirror[contenteditable="true"]',        // Claude
      '#prompt-textarea',                                // ChatGPT (contenteditable or textarea)
      'textarea[data-testid="chat-input"]',              // ChatGPT (older)
      'div[contenteditable="true"][role="textbox"]',     // generic rich composer
    ];
    // A composer is a sizable textarea or contenteditable — NOT a plain <input>
    // (those are search/title fields; inserting a paragraph there is the
    // "landed in an edit box" bug 2026-07-16).
    function isComposerish(el) {
      if (!el || !(el.tagName === 'TEXTAREA' || el.isContentEditable)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 120 && r.height > 18;
    }
    function findComposer() {
      // 1) The element the user is TYPING IN wins — when they hit the hotkey,
      //    focus is in the prompt box they just typed the question into. This
      //    fixes both the wrong-target insert AND the empty-seed retrieval
      //    (the seed is read from this same element).
      const ae = document.activeElement;
      if (isComposerish(ae)) return ae;
      // 2) Known composer selectors.
      for (const sel of COMPOSER_SELECTORS) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null && isComposerish(el)) return el;
      }
      // 3) Geometry: largest visible editable nearest the bottom of the viewport.
      const candidates = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 120 && r.height > 20 && r.top > 0 && r.top < window.innerHeight;
        });
      candidates.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
      return candidates[0] || null;
    }

    function editorText(el) {
      if (!el) return '';
      return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? (el.value || '') : (el.textContent || '');
    }
    function draftText(el) {
      // 500 to match chatContextQuery's cap — at 300 this pre-truncated the
      // seed and made the downstream .slice(0, 500) dead code, so long prompts
      // lost their tail before the query embedding ever saw it.
      return editorText(el).trim().slice(0, 500);
    }

    // Insert `text` at the START of the composer. Returns synchronously with the
    // best signal we have; because Lexical (ChatGPT) / ProseMirror (Claude) apply
    // programmatic edits ASYNCHRONOUSLY, a strategy can succeed even when the
    // immediate `changed()` check is still false — so the caller re-verifies
    // after a tick (insertTextVerified) and only then decides success vs
    // clipboard fallback. Always logs each strategy so a live failure is
    // diagnosable in one test (console: [vodou-inject]).
    // Opt-IN. This was opt-out, so every Ctrl+B printed the seed query — up to 80
    // characters of the user's draft — into the host page's console by default.
    const DIAG = () => { try { return localStorage.getItem('vodouInjectDebug') === '1'; } catch (_) { return false; } };
    function elDesc(el) {
      if (!el) return 'null';
      return `<${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}${el.isContentEditable ? ' [contenteditable]' : ''}>`;
    }
    const settle = () => new Promise((r) => setTimeout(r, 90));

    // Insert `text` at the END of the composer, trying progressively more
    // forceful methods until the text is actually visible in the editor.
    //
    // ASYNC ON PURPOSE. Every method is followed by an await + re-check before
    // the next one is attempted, because a synchronous check lies on React /
    // Lexical / ProseMirror composers: they accept the edit and apply it a tick
    // later. Two bugs came out of getting this wrong (both 2026-07-26):
    //   * checking only synchronously and falling through inserted the text
    //     TWICE on Perplexity;
    //   * bailing out early when execCommand returned true broke Claude, where
    //     ProseMirror returns true and ignores it and method 3 does the work.
    // Waiting between attempts fixes both: nothing is tried a second time until
    // we have actually looked, and no method is skipped just because an earlier
    // one claimed success.
    async function insertText(el, text) {
      if (!el) { if (DIAG()) console.log('[vodou-inject] no composer element found'); return false; }
      const before = editorText(el);
      const changed = () => editorText(el) !== before;
      if (DIAG()) console.log('[vodou-inject] target composer:', elDesc(el), '| before len', before.length);
      try { el.focus(); } catch (_) { /* ignore */ }
      // Caret to the END: context goes AFTER what the user typed (Chad, 2026-07-26).
      // Their question should read first; supporting context belongs underneath.
      try {
        const sel = window.getSelection();
        if (sel && el.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(false);          // false = collapse to END
          sel.removeAllRanges();
          sel.addRange(range);
        } else if (el.setSelectionRange) {
          const end = (el.value || '').length;
          el.setSelectionRange(end, end);
        }
      } catch (_) { /* ignore */ }

      let attempted = false;
      const tryStep = async (label, fn) => {
        try {
          fn();
          attempted = true;
          if (changed()) { if (DIAG()) console.log('[vodou-inject] ' + label + ' → landed (sync)'); return true; }
          await settle();
          if (changed()) { if (DIAG()) console.log('[vodou-inject] ' + label + ' → landed (async)'); return true; }
          if (DIAG()) console.log('[vodou-inject] ' + label + ' → no change');
        } catch (e) {
          if (DIAG()) console.log('[vodou-inject] ' + label + ' threw', e && e.message);
        }
        return false;
      };

      // 1) execCommand — textareas and simple contenteditables.
      if (await tryStep('1 execCommand', () => document.execCommand('insertText', false, text))) return true;

      // 2) native value setter (React-controlled textarea/input).
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        if (await tryStep('2 value-setter', () => {
          const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set;
          const next = (el.value || '') + text;   // append, not prepend
          if (setter) setter.call(el, next); else el.value = next;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        })) return true;
      }

      // 3) beforeinput InputEvent — ProseMirror (Claude) / Lexical.
      if (await tryStep('3 beforeinput', () => {
        el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
      })) return true;

      // 4) synthetic paste with a DataTransfer.
      if (await tryStep('4 paste', () => {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
      })) return true;

      // Nothing visibly landed. 'async' = something was attempted and a very slow
      // editor may still apply it; the caller re-checks before falling back.
      return attempted ? 'async' : false;
    }

    // Wrap insertText with an async re-verification: rich editors apply the edit
    // on a later tick, so we confirm the composer actually changed before
    // reporting success. cb(true) = text is in the composer; cb(false) = truly
    // failed (caller does clipboard fallback).
    function insertTextVerified(el, text, cb) {
      const before = editorText(el);
      // insertText is ASYNC (it waits between attempts) — must be awaited, or the
      // returned Promise reads as truthy and we report success for nothing.
      insertText(el, text).then((r) => {
        if (r === true) { cb(true); return; }
        if (r === false) { cb(false); return; }
        // 'async' — a slow editor may still apply it. Poll before giving up, so
        // we don't drop the user into the clipboard fallback prematurely.
        let tries = 0;
        const poll = () => {
          tries += 1;
          if (editorText(el) !== before) {
            if (DIAG()) console.log('[vodou-inject] async re-check → LANDED (try ' + tries + ')');
            cb(true);
            return;
          }
          if (tries >= 5) {
            if (DIAG()) console.log('[vodou-inject] async re-check → still empty after ' + tries);
            cb(false);
            return;
          }
          setTimeout(poll, 60);
        };
        setTimeout(poll, 60);
      }).catch(() => cb(false));
    }

    // Insert an assembled block via the three-tier strategy (composer →
    // native setter → clipboard). Shared by the picker and the legacy path.
    function chatContextQuery(composer) {
      const draft = draftText(composer || findComposer());
      if (draft && draft.length > 3) return draft.slice(0, 500);
      try {
        const sel = [
          '[data-message-author-role]',            // ChatGPT
          '[data-testid="user-message"]',          // Claude
          '.font-claude-message', '.prose',        // Claude / generic
        ].join(',');
        const nodes = document.querySelectorAll(sel);
        let tail = '';
        for (let i = nodes.length - 1; i >= 0 && tail.length < 600; i--) {
          const t = (nodes[i].innerText || '').trim();
          if (t.length > 10) tail = t + '  ' + tail;
        }
        tail = tail.trim();
        if (tail.length > 10) return tail.slice(-800);
      } catch (_) { /* selector drift — fall through to the gateway seed */ }
      return ''; // gateway seeds from captured turns, else host
    }

    // Conversation identity from the URL (stable — not DOM markup). Lets the
    // gateway find the turns we already captured under webcap:<provider>:<uuid>.
    //   ChatGPT: /c/<uuid> or /g/.../c/<uuid>   Claude: /chat/<uuid>
    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    function convRef() {
      try {
        const h = location.hostname;
        if (/chatgpt\.com|chat\.openai\.com/.test(h)) {
          const m = /\/c\/([0-9a-f-]{36})/i.exec(location.pathname);
          if (m) return { provider: 'chatgpt', convId: m[1] };
        } else if (/claude\.ai/.test(h)) {
          const m = /\/chat\/([0-9a-f-]{36})/i.exec(location.pathname);
          if (m) return { provider: 'claude', convId: m[1] };
        }
        const any = UUID_RE.exec(location.pathname);
        if (any) return { provider: '', convId: any[0] };
      } catch (_) { /* ignore */ }
      return { provider: '', convId: '' };
    }

    function fetchCandidates(query, scope, cb) {
      const ref = convRef();
      const allMemory = !scope || scope === 'all';
      // This is the line that threw on 2026-08-27. It has a cb, so the caller
      // renders the sentence — no toast from here.
      if (!bridgeAlive()) { cb({ ok: false, error: BRIDGE_STALE }); return; }
      try {
      chrome.runtime.sendMessage(
        {
          type: 'get_context',
          query,
          host: location.hostname,
          all_memory: allMemory,
          vault: allMemory ? '' : scope,
          conv_id: ref.convId,
          provider: ref.provider,
        },
        (resp) => {
          if (chrome.runtime.lastError) { cb({ ok: false, error: chrome.runtime.lastError.message }); return; }
          cb(resp || { ok: false, error: 'no response' });
        },
      );
      } catch (_) { cb({ ok: false, error: BRIDGE_STALE }); }
    }

    // ── PLAN-AUTO-INJECT-P4 Phase A: Ctrl+B auto-inject ────────────────────────
    // One hotkey, two mechanisms picked per provider by WHERE it dispatches its
    // send (§2.0 of the plan):
    // DEFAULT IS 'composer' EVERYWHERE (changed 2026-07-26, Chad): the user sees
    // exactly what is about to be sent, in the box, and can edit or delete it
    // before hitting send — which is what the store listing describes, and the
    // only way memory reaches a chat in this build. ChatGPT's composer was
    // already a proven insert target (the memory picker uses it).
    //
    // Claude framing note (spike 2026-07-15, still applies to every composer
    // site): FENCE-LESS natural first-person prose. A machine-fenced "retrieved
    // memory" block trips model injection resistance; composerFraming() is
    // site-agnostic and already emits plain prose.
    //
    // Every site below uses the SAME generic composer path that Ctrl+Shift+B has
    // always used on any site, and it degrades safely: if no composer is found
    // the text is copied to the clipboard with a toast, so context is never
    // lost. That is why widening this list is low-risk — a site whose composer
    // we can't find falls back to paste rather than failing silently.
    // Context comes from a live vault-scoped `mem context` pull seeded by the
    // draft/conversation (same disclosure boundary as the 🧠 picker). Toggles:
    // chrome.storage vodou_inject_settings {master, sites:{...}}.
    // Sites come from sites.js, loaded as the first content script so
    // this lookup and the panel's per-site toggles cannot drift apart. Keyed
    // here for O(1) access by the rest of the file.
    const INJECT_SITES = {};
    for (const s of (globalThis.VODOU_SITES || [])) INJECT_SITES[s.key] = s;
    /** P2 — strip the provenance run the extractor writes (`scope:x page:y | body`)
     *  and the inline no-bar shape, so a fact reads as a fact in the composer. */
    function factBody(t) {
      const s0 = String(t || '').replace(/^-\s*/, '');
      const bar = s0.indexOf('|');
      const after = bar > 0 && bar < 200 ? s0.slice(bar + 1) : s0;
      return after.replace(/(^|\s)(?:scope|project|page):[^\s|]+/g, '$1').replace(/\s{2,}/g, ' ').trim();
    }

    /** P2 — hotkey inject on a page with NO site adapter. Returns {ok, ...}.
     *  P6: if the page has a real FORM (two or more fillable fields), the
     *  shortcut hands off to the fill flow instead of pasting facts into one
     *  box — Chad, 2026-08-18: Ctrl+B put every "Form answer on httpbin.org…"
     *  row into Delivery instructions. The background opens the panel (gesture)
     *  and runs fillFormFromMemory when we answer wantsFill. */
    async function runAnyPageInject() {
      // Chad, 2026-08-18: "I added wife's name to the delivery instructions
      // and hit control b — nothing happened like on chatgpt or claude." A
      // DRAFT in the focused multi-line box is the user writing something and
      // asking for the memories that go with it — ChatGPT behaviour, seeded by
      // the draft. Only an EMPTY / non-text focus on a real form means "fill
      // the form".
      const active = document.activeElement;
      const drafting = !!(active && active !== document.body && isComposerish(active)
        && (active.tagName === 'TEXTAREA' || active.isContentEditable) && draftText(active).length >= 4);
      if (!drafting) {
        try {
          const model = readFormModel();
          const fillable = (model.fields || []).filter((f) => f.type !== 'contenteditable');
          if (fillable.length >= 2) {
            toast('Filling this form from your memory — review in the Vodou panel', true);
            return { ok: true, wantsFill: true, fields: fillable.length };
          }
        } catch (_) { /* fall through to insert */ }
      }
      const target = drafting ? active : findComposer();
      if (!target) {
        toast('No text box to insert into here — open the Vodou panel (⌃⇧M) to copy instead', false);
        return { ok: false, error: 'no composer found on this page' };
      }
      const ask = (m) => new Promise((res) => { try { chrome.runtime.sendMessage(m, (r) => res(r || null)); } catch (_) { res(null); } });
      let facts = [];
      let from = '';
      // With a draft, retrieval is seeded by the draft (what ChatGPT/Claude get);
      // the page's own facts lead only when the box is empty.
      const pg = drafting ? null : await ask({ type: 'get_page_context', url: location.href });
      // Learn-back rows ("Form answer on …") are form memory, never insert text.
      const notFormAnswer = (t) => !/^(?:\[[A-Z_]+\]\s*)?Form answer on /.test(t);
      if (pg && pg.ok && Array.isArray(pg.facts) && pg.facts.map((f) => factBody(f.text)).filter(notFormAnswer).length) {
        facts = pg.facts.map((f) => factBody(f.text)).filter(Boolean).filter(notFormAnswer).slice(0, 8);
        from = 'this page';
      }
      let text = '';
      if (facts.length) {
        // Page facts: same framing as the panel insert — the facts, joined.
        let body = facts.map((t) => t.replace(/^[-•]\s*/, '').trim()).filter(Boolean).join('; ');
        if (body && !/[.!?]$/.test(body)) body += '.';
        if (body.length > 700) body = body.slice(0, 697) + '…';
        text = body + '\n\n';
      } else {
        // Nothing stamped here (or page memory is off) — do EXACTLY what the
        // supported sites do: all-memory retrieval seeded by the draft, and the
        // gateway's own selection (`resp.selected`) framed by composerFraming.
        // Live 2026-08-17: a vault-only pull with a hand filter here inserted a
        // preferences summary instead of the codename the draft asked about.
        const seed = draftText(target) || ('context for ' + location.hostname);
        const r = await new Promise((res) => fetchCandidates(seed, 'all', res));
        if (!r || !r.ok) {
          const why = (r && r.error) || 'Vodou not reachable';
          toast('✗ ' + why, false);
          return { ok: false, error: why };
        }
        const built = composerFraming(r.profile, r.selected, Array.isArray(r.items) ? r.items : [], seed);
        text = built.text || '';
        facts = new Array(built.facts || built.profileLines || 0);
        from = 'memory';
      }
      if (!text.trim()) {
        toast(pg && pg.disabled ? 'Nothing found — turn on "Show what I know about the page I\'m on" in the panel to use page memory here' : 'Nothing relevant in memory for this yet', false);
        return { ok: false, error: 'nothing to insert' };
      }
      registerStrip(text.trim());
      return new Promise((res) => {
        insertTextVerified(target, text, (ok) => {
          if (ok) toast('🧠 added ' + facts.length + ' from ' + from + ' — review before sending', true);
          else toast('The text box refused the insert — open the panel to copy instead', false);
          res(ok ? { ok: true, count: facts.length } : { ok: false, error: 'the composer refused the text' });
        });
      });
    }

    // ── P6 helpers ────────────────────────────────────────────────────────
    const FILL_SENSITIVE_RE = /password|passcode|cvv|cvc|card ?number|ssn|social security|otp|one[- ]time|verification code|security code|routing|account number|pin\b/i;
    function fieldLabelFor(el) {
      const byFor = el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
      const wrap = el.closest('label');
      const aria = el.getAttribute('aria-label') || '';
      const labelledBy = el.getAttribute('aria-labelledby');
      const byId = labelledBy ? [...labelledBy.split(/\s+/)].map((id) => document.getElementById(id)).filter(Boolean).map((n) => n.textContent).join(' ') : '';
      let text = (byFor && byFor.textContent) || (wrap && wrap.textContent) || byId || aria || '';
      if (!text.trim()) {
        // Nearest preceding text-ish sibling / cell header — common in table forms.
        const prev = el.previousElementSibling || (el.parentElement && el.parentElement.previousElementSibling);
        if (prev && /^(LABEL|SPAN|DIV|TD|TH|P|B|STRONG|DT)$/.test(prev.tagName) && (prev.textContent || '').trim().length <= 80) text = prev.textContent;
      }
      return String(text || '').replace(/\s+/g, ' ').replace(/[*:]\s*$/, '').trim().slice(0, 200);
    }
    function stableSelector(el) {
      if (el.id) return '#' + CSS.escape(el.id);
      const name = el.getAttribute('name');
      if (name) {
        const tag = el.tagName.toLowerCase();
        const same = document.querySelectorAll(tag + '[name="' + CSS.escape(name) + '"]');
        if (same.length === 1) return tag + '[name="' + CSS.escape(name) + '"]';
      }
      // Fallback: path of nth-of-type from the nearest id'd ancestor / body.
      const parts = [];
      let node = el;
      while (node && node !== document.body && parts.length < 8) {
        const tag = node.tagName.toLowerCase();
        if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
        let i = 1, sib = node;
        while ((sib = sib.previousElementSibling)) if (sib.tagName === node.tagName) i++;
        parts.unshift(tag + ':nth-of-type(' + i + ')');
        node = node.parentElement;
      }
      return parts.join(' > ');
    }
    function readFormModel() {
      const els = [...document.querySelectorAll('input, textarea, select, [contenteditable="true"]')];
      const out = [];
      let n = 0;
      for (const el of els) {
        if (out.length >= 60) break;
        const tag = el.tagName;
        const type = (el.getAttribute('type') || (tag === 'TEXTAREA' ? 'textarea' : tag === 'SELECT' ? 'select' : el.isContentEditable ? 'contenteditable' : 'text')).toLowerCase();
        if (['password', 'hidden', 'submit', 'button', 'reset', 'image', 'file', 'checkbox', 'radio', 'range', 'color'].includes(type)) continue;
        if (el.disabled || el.readOnly) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 10) continue;                 // not a real field
        const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
        if (/^cc-|one-time-code|password/.test(ac)) continue;
        const label = fieldLabelFor(el);
        const name = el.getAttribute('name') || '';
        const placeholder = el.getAttribute('placeholder') || '';
        if (FILL_SENSITIVE_RE.test(label + ' ' + name + ' ' + placeholder)) continue;
        // Search boxes are not forms to fill.
        if (type === 'search' || /^(q|query|search)$/i.test(name)) continue;
        const id = 'f' + (++n);
        el.dataset.vodouFillId = id;
        const options = tag === 'SELECT' ? [...el.options].map((o) => o.textContent.trim()).filter(Boolean).slice(0, 60) : [];
        const currentValue = tag === 'SELECT' ? (el.selectedOptions[0] && el.selectedOptions[0].textContent.trim()) || '' : (el.isContentEditable ? el.textContent : el.value) || '';
        out.push({
          id, sel: stableSelector(el), label, name, type, autocomplete: ac, placeholder,
          required: !!el.required, options, multiline: tag === 'TEXTAREA' || el.isContentEditable,
          hasValue: !!String(currentValue).trim(),
          maxlength: el.maxLength > 0 ? el.maxLength : null,
        });
      }
      return { url: location.href, title: document.title || '', fields: out };
    }
    async function applyFields(items) {
      let applied = 0; const failed = [];
      for (const it of items) {
        try {
          const el = (it.id && document.querySelector('[data-vodou-fill-id="' + CSS.escape(it.id) + '"]')) || (it.sel && document.querySelector(it.sel));
          if (!el) { failed.push({ id: it.id, why: 'field not found' }); continue; }
          const value = String(it.value == null ? '' : it.value);
          const tag = el.tagName;
          if (tag === 'SELECT') {
            const opt = [...el.options].find((o) => o.textContent.trim().toLowerCase() === value.trim().toLowerCase() || o.value.toLowerCase() === value.trim().toLowerCase());
            if (!opt) { failed.push({ id: it.id, why: 'no such option' }); continue; }
            el.value = opt.value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            applied++;
            continue;
          }
          if (tag === 'INPUT' || tag === 'TEXTAREA') {
            const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set;
            try { el.focus(); } catch (_) {}
            if (setter) setter.call(el, value); else el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if ((el.value || '') !== value) {
              // Framework swallowed the set — fall back to the verified inserter (appends).
              const ok = await new Promise((res) => insertTextVerified(el, value, res));
              if (!ok) { failed.push({ id: it.id, why: 'refused' }); continue; }
            }
            applied++;
            continue;
          }
          if (el.isContentEditable) {
            const ok = await new Promise((res) => insertTextVerified(el, value, res));
            if (ok) applied++; else failed.push({ id: it.id, why: 'refused' });
            continue;
          }
          failed.push({ id: it.id, why: 'unsupported field' });
        } catch (e) { failed.push({ id: it.id, why: String(e && e.message || e) }); }
      }
      if (applied) toast('Filled ' + applied + ' field' + (applied === 1 ? '' : 's') + ' from your memory — review before you submit', true);
      return { ok: applied > 0, applied, failed };
    }

    function injectSiteKey() {
      for (const [k, v] of Object.entries(INJECT_SITES)) if (v.host.test(location.hostname)) return k;
      return null;
    }
    let injectSettings = { master: true, sites: {} };

    // PLAN-HISTORY-BACKFILL P1 — push the backfill switch down to the page shim.
    //
    // inject.js runs in the MAIN world and cannot read chrome.storage, so the
    // content script owns the setting and relays it. `backfill !== true` means OFF:
    // a missing value can only ever mean off, the same convention as autoSend and
    // brain mode, because this one decides whether YEARS of old conversation get
    // read rather than just the next turn.
    const pushBackfillConfig = () => {
      try {
        window.postMessage({
          source: 'vodou-netcap-config',
          backfill: injectSettings.backfill === true,
          backfillSites: injectSettings.backfillSites || {},
        }, '*');
      } catch (_) { /* page gone */ }
    };

    try {
      chrome.storage.local.get(['vodou_inject_settings'], (v) => {
        if (v && v.vodou_inject_settings) injectSettings = Object.assign(injectSettings, v.vodou_inject_settings);
        pushBackfillConfig();
      });
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && ch.vodou_inject_settings) {
          injectSettings = Object.assign({ master: true, sites: {} }, ch.vodou_inject_settings.newValue || {});
          pushBackfillConfig();
        }
      });
    } catch (_) { /* storage unavailable — defaults stand */ }

    function logInjection(entry) {
      try { chrome.runtime.sendMessage({ type: 'inject_log', entry }); } catch (_) { /* ignore */ }
    }

    // Counts from the last armed network block, replayed onto the `injected`
    // confirmation (inject.js only reports that the send happened, not what was
    // in it — it never saw the parts).

    // Per-query items only ride if they ACTUALLY match the query. Precision-first
    // floor for EXTERNAL inject: 0.30 was calibrated for internal recall and was
    // far too low here — genuine answers score 0.85–1.0 while pure noise scores
    // 0.60–0.72, so "what's my blood type" injected random SQL notes (2026-07-18
    // inject-quality sweep). 0.72 silences the clear-noise band while keeping
    // legit mid-confidence facts (IP 0.72, SUTE 0.76). This is the knob the
    // inject-bench (PLAN follow-on) will tune; it's better-than-nothing precision
    // until extraction quality closes the 0.72–0.78 signal/noise overlap.
    // Profile is exempt — it's the always-applicable "who I am" baseline.
    const INJECT_REL_FLOOR = 0.72;
    // Pointed-question gap cut. When one fact dominates, don't drag in weaker
    // tangential matches (2026-07-18: "what's my dog's name" returned the right
    // fact at 0.978 AND four dog-name *debugging* notes — scope capture:ide:claude-code,
    // tags METRIC/PATTERN — at 0.68–0.81, a clear 0.17 gap below). Keep only
    // items within this band of the top hit. A diffuse query ("tell me about
    // myself") keeps its whole cluster because its items sit near each other.
    const INJECT_REL_GAP = 0.15;
    // System/plumbing scopes that must never travel to a third-party AI even
    // when they match — our own capture/skill telemetry, not the user's facts.
    const INJECT_SCOPE_DENY = /^(capture:ide:|skill$|workbench:)/i;
    // Extraction reasoning-leak guard. Some early chunks stored the extractor's
    // own deliberation verbatim ("... But that's a personal fact ... Not really",
    // "— not in this conversation.") which then scores at the TOP because it
    // contains the query words — a floor can't catch it. Belt at the inject
    // boundary; the matching vault rows are also purged (reversible).
    const INJECT_LEAK_RE = /not in this conversation|but that'?s a personal fact|it'?s a preference\? not really|we should only include|actually it'?s in the instructions|could be useful for addressing/i;
    function relevantItems(items, max) {
      const passed = (items || []).filter(
        (i) =>
          (typeof i.relevance === 'number' ? i.relevance : 0) >= INJECT_REL_FLOOR &&
          !INJECT_SCOPE_DENY.test(String(i.scope || '')) &&
          !INJECT_LEAK_RE.test(String(i.text || '')),
      );
      if (!passed.length) return [];
      const top = Math.max(...passed.map((i) => i.relevance || 0));
      return passed
        .filter((i) => (i.relevance || 0) >= top - INJECT_REL_GAP)
        .slice(0, max)
        .map((i) => String(i.text || '').replace(/^[-•]\s*/, '').trim())
        .filter(Boolean);
    }

    // Query-relevant profile selection. The profile is ~20 durable one-line
    // facts; injecting an arbitrary slice (old bug: first 2 lines) meant "what's
    // my dog's name" got the role/mission lines, not the dog line. For the
    // VISIBLE composer we keep it tight: a one-line identity anchor (line 1)
    // plus the profile lines whose words overlap the question.
    const PROFILE_STOP = new Set(['the', 'a', 'an', 'my', 'me', 'is', 'are', 'was', 'what', 'who', 'how', 'do', 'does', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'with', 'your', 'you', 'we', 'our', 'at', 'it', 'this', 'that', 'about', 'can', 'could', 'would', 'should', 'where', 'when', 'why', 'am', 'be', 'have', 'has', 'get', 'name', 'names']);
    function tokenize(s) {
      return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !PROFILE_STOP.has(t));
    }
    function relevantProfileLines(profile, query, max) {
      const lines = String(profile || '').split('\n').map((s) => s.trim()).filter(Boolean);
      if (!lines.length) return [];
      const anchor = lines[0];
      const qtok = tokenize(query);
      const scored = lines.slice(1).map((line) => {
        const lt = tokenize(line);
        let score = 0;
        for (const q of qtok) if (lt.some((w) => w === q || w.startsWith(q) || q.startsWith(w))) score++;
        // Substring catch for the un-tokenized query words the stoplist dropped
        // (e.g. "dog" in a bare "dog?" query) — belt on top of token overlap.
        return { line, score };
      }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, max);
      return [anchor, ...scored.map((x) => x.line)];
    }

    // Composer providers: natural first-person prose, NO fence (§0.1). Short and
    // TIGHT — it's visible in the user's draft. Philosophy (2026-07-16, Chad):
    // a pointed question deserves a pointed answer, not the whole dossier.
    //   • If specific vault facts match the question (embedding-ranked, above
    //     floor) → inject ONLY those. No identity anchor, no keyword-matched
    //     profile lines (crude overlap false-matches, e.g. "flat WHITE" →
    //     "WHITE-label" SUTE line). The matched fact IS the context.
    //   • Only when NOTHING specific matched → fall back to identity grounding
    //     from the profile (so "tell me about myself" still works).
    // `selected` = server-decomposed + per-sub-question-selected facts (compound
    // prompts split server-side so each fact matches its own question instead of
    // blurring below the floor). Falls back to client-side relevantItems when an
    // older gateway doesn't send `selected`.
    // Returns { text, facts, profileLines } — the counts are what ACTUALLY went
    // into the text, not what was available. The activity log and the toast both
    // read them, so neither can claim a profile that this branch never included
    // (the old code logged `profile: hasProfile`, i.e. "a profile exists", which
    // read as "+profile" on every fact-only injection — 2026-07-25, Chad).
    // What the user PASTES INTO ANOTHER AI is the product. "What is my dog's
    // name?" returned this shape on 2026-07-27 (names here are synthetic — the
    // real run used the operator's actual records):
    //
    //   User's dog is named Rex; Dr. Sable on Main Street in Rivertown is the
    //   user's sleep specialist — NOT Rex's vet; the earlier memory record
    //   incorrectly listed Dr. Sable as Rex's eval vet, which is wrong.; Dr. Sable
    //   is the user's sleep specialist (NOT Rex's vet), and their office is at …;
    //   PHASE2 dog named RexZZZ
    //
    // The answer is one word and it is buried. Three defects, all repairable here:
    //
    //   1. CORRECTION RECORDS. Notes ABOUT memory ("the earlier record incorrectly
    //      listed…", "not as previously recorded") are maintenance metadata. They
    //      matched because they mention the dog's name, and they read to another model as
    //      facts about the user. Internal search may want them; external inject
    //      never does.
    //   2. LEAKED FRONTMATTER. Some chunks carry their YAML header — `name:`,
    //      `metadata: node_type:`, `originSessionId` — straight into the paste.
    //   3. NEAR-DUPLICATES joined with "; " into one unreadable sentence, with the
    //      "…which is wrong.; Dr. Sable…" seam where a period met a semicolon.
    // Deliberately NARROW. The first draft matched a bare "incorrectly listed",
    // which would have silenced a legitimate memory — "Bug fixed: README
    // incorrectly listed only 4 providers". Only phrases that talk about the
    // MEMORY RECORD ITSELF qualify; a fact may say something was wrong in the
    // world without being maintenance metadata.
    const CORRECTION_RE = /(\[CORRECTION\]|earlier (memory )?record|as previously recorded|previously recorded[,.]|the earlier record)/i;
    function stripFrontmatter(s) {
      let t = String(s || '');
      t = t.replace(/^\s*-{2,3}\s*name:[\s\S]*?-{2,3}\s*/i, '');   // flattened header
      t = t.replace(/^\s*-{3}[\s\S]*?-{3}\s*/, '');                 // real --- block
      return t.trim();
    }
    function cleanFacts(list) {
      const out = [];
      const seen = [];
      for (const raw of list) {
        // Frontmatter FIRST, bullet prefix second. The other order eats the first
        // hyphen of `-- name:` and the header then slips through as content.
        const f = stripFrontmatter(String(raw || '')).replace(/^[-•]\s*/, '').trim();
        if (!f) continue;
        if (CORRECTION_RE.test(f)) continue;
        const norm = f.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (!norm) continue;
        // Drop anything already said, and anything wholly contained in a kept
        // fact — the two sleep-specialist entries were each other's restatement.
        if (seen.some((s) => s === norm || s.includes(norm) || norm.includes(s))) continue;
        seen.push(norm);
        out.push(f.replace(/\s*[;.]\s*$/, ''));
      }
      return out;
    }

    function composerFraming(profile, selected, items, query) {
      // `selected` PRESENT means the gateway ran the canonical server-side
      // selection (floor + gap-cut + silence-when-ignorant, PLAN-INJECT-QUALITY).
      // An EMPTY array is a deliberate verdict — "memory has nothing for this
      // prompt" — and must stay empty: the old `[] → relevantItems(items)`
      // fallback re-injected exactly the junk the server had just filtered
      // out (observed 2026-08-06: "what's my blood type" silent server-side,
      // items resurrected client-side). Items remain the fallback ONLY when
      // `selected` is absent entirely (a pre-quality-bundle gateway).
      const serverSelected = Array.isArray(selected);
      const facts = cleanFacts(serverSelected
        ? selected.map((t) => String(t || '').replace(/^[-•]\s*/, '').trim()).filter(Boolean)
        : relevantItems(items, 4));
      let body;
      let profileLines = 0;
      if (facts.length) {
        // One fact per line. The semicolon run-on made a three-fact answer read as
        // a single malformed sentence; a pasted block is read by a human first.
        body = facts.length === 1 ? facts[0] + '.' : facts.map((f) => '- ' + f).join('\n');
      } else if (serverSelected) {
        // Server said "nothing worthy" — do not dredge the profile either;
        // an identity blurb on "what's my blood type" is still wrong context.
        return { text: '', facts: 0, profileLines: 0 };
      } else {
        const prof = relevantProfileLines(profile, query, 3);
        if (!prof.length) return { text: '', facts: 0, profileLines: 0 };
        body = prof.join(' ');                     // identity grounding fallback
        profileLines = prof.length;
      }
      // No "For context about me:" preamble (2026-07-18, Chad) — the fact
      // stands on its own; the framing added length and read as boilerplate.
      let s = body;
      if (s.length > 700) s = s.slice(0, 697) + '…';
      // Separator LEADS the block: the text is appended after the user's draft,
      // so the blank line has to sit between their words and ours.
      return { text: '\n\n' + s, facts: facts.length, profileLines };
    }

    // Network providers: fenced block assembled from the gateway's own parts
    // (single producer for the fence format); profile rides inside the fence.
    // Same contract as composerFraming: { text, facts, profileLines } counting
    // only what the block actually carries. This path DOES ship the whole
    // profile, so profileLines is its real line count.
    // fencedBlock() removed with the network mechanism — the composer path
    // uses composerFraming() (plain prose, no machine fence).

    // Out-of-band loop-strip registry for composer injections (§0.1: no fence
    // means no marker — track the injected text and strip it at capture time).
    function registerStrip(text) {
      try {
        chrome.storage.local.get(['vodou_inject_registry'], (v) => {
          const reg = (v && v.vodou_inject_registry) || [];
          reg.unshift({ text, ts: Date.now(), host: location.hostname });
          while (reg.length > 40) reg.pop();
          chrome.storage.local.set({ vodou_inject_registry: reg });
        });
      } catch (_) { /* ignore */ }
    }

    // Run one injection. `forceComposer` (Ctrl+Shift+B) overrides a site's
    // default mechanism. Every site in this build inserts VISIBLY into the
    // composer; ChatGPT's composer is a proven insert target (the memory picker
    // uses it).
    function runInject(site, forceComposer, composer, onDone, manual, ctl) {
      // `manual` = a user-initiated trigger (Ctrl+B, the FAB, the panel "add brain"
      // button). These run the FULL Vodou brain by default — the user is in the loop
      // and reviews the result before sending, so the agentic path (memory + tools +
      // skills) is both safe and the smart default here. The unattended auto-send
      // path leaves `manual` falsy and stays gated on the explicit Brain-mode toggle.
      // Runs EXACTLY once, on every exit path. Auto-attach hangs the user's send on
      // this callback, so a path that forgets to report would swallow the message —
      // which is far worse than attaching nothing. Never make this conditional on
      // success.
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        if (typeof onDone === 'function') { try { onDone(); } catch (_) {} }
      };
      if (!injectSettings.master || injectSettings.sites[site] === false) {
        toast('Vodou auto-inject is off — click the Vodou icon and enable it under Settings', false);
        done();
        return;
      }
      // `composer` was captured at keypress (focus = the box the user typed in).
      // Reuse it for BOTH the retrieval seed and the insert so an async focus
      // change between them can't split them onto different elements.
      const seed = chatContextQuery(composer);
      if (DIAG()) console.log('[vodou-inject] seed query:', JSON.stringify((seed || '').slice(0, 80)), '| from', elDesc(composer));

      // PLAN-BRAIN-INJECT-LANE — Brain mode: instead of a retrieval lookup, run a FULL
      // agentic Vodou turn (memory + tools + skills) and insert the distilled pack. The
      // gateway degrades to retrieval server-side if the turn overruns its budget, so a
      // failure here still yields a useful pack. "never eat the message" still holds:
      // done() fires on every path exactly as the retrieval branch guarantees.
      // PLAN-VODOU-TASKS-CHANNEL — MANUAL triggers (Ctrl+B / FAB / panel button) go
      // through the ASYNC task lane: dispatch, return immediately, let the agent run
      // locally for as long as it needs, and deliver the result under the draft guard
      // (vodou_task_deliver). Nothing is held — verified: every manual caller passes
      // onDone === undefined, so the "optimistic sync window" the plan sketched is
      // unnecessary here; only the AUTO-SEND lane holds a send, and that stays sync.
      //
      // GATED on the Brain toggle (2026-08-05, Chad): manual used to run the full
      // brain unconditionally, so "Add my memory" took 5–22s (one observed CLI turn:
      // 18.5s, $0.43) with every toggle off — while the settings copy promised "a
      // plain memory lookup" unless Brain is on. The toggle now means what it says
      // on BOTH lanes: off → fast retrieval, on → agentic turn.
      if (manual && brainModeEnabled(site)) {
        if (!bridgeAlive()) { toast(BRIDGE_STALE, false); done(); return; }
        try {
        chrome.runtime.sendMessage({
          type: 'run_task_from_page',
          draft: seed,
          deliver: 'both',
          tools: injectSettings.brainTools || 'all',
          page: { host: location.host, provider: convRef().provider || '', convId: convRef().convId || '', url: location.href },
        }, (r) => {
          if (!r || !r.ok) {
            toast('✗ ' + ((r && r.error) || 'could not start the task'), false);
            done();
            return;
          }
          taskPill.start(r.jobId, seed);
          done();   // nothing to hold — the task runs on its own from here
        });
        } catch (_) { toast(BRIDGE_STALE, false); done(); }
        return;
      }

      if (brainModeEnabled(site)) {
        // AUTO-SEND with Brain mode → 'pack': append passive context to the outgoing
        // message. Stays SYNCHRONOUS (the send is held) — see §7 of the plan. Manual
        // triggers never reach here; they returned above on the async task lane.
        toast('🧠 thinking with your context…');
        const cachedPack = prefetchTake(seed, convRef().convId);
        const useBrainPack = (resp) => {
          // Same late-result guard as the retrieval lane (see handleResp).
          if (ctl && ctl.cancelled) { done(); return; }
          if (!resp || !resp.ok) {
            // Fall back to plain retrieval rather than losing the send's context.
            if (DIAG()) console.log('[vodou-inject] brain failed, falling back to retrieval:', resp && resp.error);
            runRetrievalInject(site, forceComposer, composer, seed, done);
            return;
          }
          if (resp.mode === 'answer' && resp.text) {
            // Pure-recall on the auto-send lane: the Face answered outright. Show it and
            // leave the outgoing message alone (the user's own question still sends).
            toast('🧠 ' + String(resp.text).slice(0, 240), true);
            logInjection({ kind: 'brain', site, mechanism: 'answer', status: 'answered',
              convId: convRef().convId, at: Date.now() });
            done();
            return;
          }
          const packText = (resp.pack && String(resp.pack.text || '').trim()) || '';
          if (!packText) { toast('brain found nothing to add — sending as-is', false); done(); return; }
          const target = (composer && composer.isConnected) ? composer : findComposer();
          // The Face already distilled the pack; frame it the same way composerFraming
          // does (append after the user's draft) without re-running fact selection.
          const framed = '\n\n' + packText;
          registerStrip(framed.trim());
          insertTextVerified(target, framed, (ok) => {
            done();
            const tools = (resp.pack && resp.pack.tools_run && resp.pack.tools_run.length) || 0;
            // PLAN-INJECT-RECEIPT-UI — say what the brain actually DID, in the one
            // place a user sees while working inside ChatGPT/Claude with the panel
            // shut. Counts only here: the named items live in the panel, and this
            // toast sits on top of a third-party page.
            const label = resp.degraded ? 'context (quick)' : (receiptLabel(resp.receipt)
              || (tools ? `context + ${tools} tool${tools === 1 ? '' : 's'}` : 'context'));
            if (ok) {
              toast(`🧠 brain added ${label} to your draft — review & send`, true);
              logInjection({ kind: 'brain', site, mechanism: 'composer', status: 'inserted',
                chars: framed.length, degraded: !!resp.degraded, tools, convId: convRef().convId, at: Date.now() });
            } else {
              navigator.clipboard.writeText(packText).then(
                () => toast('🧠 brain context copied — paste it in (Cmd/Ctrl+V)', true),
                () => toast('✗ could not insert or copy — click into the composer, then retry', false),
              );
              logInjection({ kind: 'brain', site, mechanism: 'composer', status: 'clipboard',
                chars: framed.length, degraded: !!resp.degraded, tools, convId: convRef().convId, at: Date.now() });
            }
          });
        };
        if (cachedPack) { useBrainPack(cachedPack); return; }
        if (!bridgeAlive()) { toast(BRIDGE_STALE, false); return; }
        try {
        chrome.runtime.sendMessage({
          type: 'get_brain_context', draft: seed, host: location.host,
          intent: 'pack',
          tools: injectSettings.brainTools || 'all',
          provider: convRef().provider || '', conv_id: convRef().convId || '',
          url: location.href, budget_ms: 10000,   // pack lane holds the send — keep it tight
        }, useBrainPack);
        } catch (_) { toast(BRIDGE_STALE, false); }
        return;
      }

      runRetrievalInject(site, forceComposer, composer, seed, done, ctl);
    }

    // The original retrieval lane, factored out so Brain mode can fall back to it.
    function runRetrievalInject(site, forceComposer, composer, seed, done, ctl) {
      toast('🧠 pulling your context…');   // progress: holds until a result lands
      // scope 'all' → search the ENTIRE store, not just the portable vault
      // (2026-07-18, Chad: any external-LLM lookup must reach all memory — the
      // old vault-scoped pull hid basic personal facts like the dog's name,
      // which are tagged RESEARCH/etc., not PREF, so the PREF-only portable
      // vault excluded them and inject fell back to the generic profile blurb).
      // Trade-off accepted: this widens what can travel to a third-party AI
      // from vault-eligible only to any above-floor match. The relevance floor
      // (INJECT_REL_FLOOR) still gates noise; the profile fallback still covers
      // "tell me about myself". Matches the 🧠 button, which already uses 'all'.
      const handleResp = (resp, prefetched) => {
        // Watchdog abandoned this run (message already sent as-typed) — a late
        // result must NOT touch the composer; it would strand a context block
        // in the box after the send.
        if (ctl && ctl.cancelled) { done(); return; }
        if (!resp || !resp.ok) {
          toast('✗ context pull failed: ' + ((resp && resp.error) || 'no response'), false);
          done();
          return;
        }
        const items = Array.isArray(resp.items) ? resp.items : [];
        const hasProfile = String(resp.profile || '').trim().length > 0;
        if (!items.length && !hasProfile) {
          toast('no vault memories matched this chat — nothing to inject', false);
          logInjection({
            kind: 'inject', site, mechanism: forceComposer ? 'composer' : INJECT_SITES[site].mechanism,
            status: 'nothing', facts: 0, profileLines: 0, convId: convRef().convId, at: Date.now(),
          });
          done();
          return;
        }
        // Describe ONLY what the chosen branch actually packs (see composerFraming).
        const describe = (facts, profileLines) => {
          const f = facts ? `${facts} ${facts === 1 ? 'memory' : 'memories'}` : '';
          const p = profileLines ? `${profileLines} profile ${profileLines === 1 ? 'fact' : 'facts'}` : '';
          if (f && p) return `${f} + ${p}`;
          return f || p || 'nothing';
        };
        // Composer insertion is the only mechanism in this build: the text is
        // placed in the visible draft for the user to review, edit or delete.
        {
          const built = composerFraming(resp.profile, resp.selected, items, seed);
          const text = built.text;
          const summary = describe(built.facts, built.profileLines);
          if (!text) { toast('nothing suitable to inject', false); done(); return; }
          // Reuse the keypress-captured composer; re-find only if it went away.
          const target = (composer && composer.isConnected) ? composer : findComposer();
          registerStrip(text.trim()); // register regardless of insert path (paste too gets loop-stripped)
          insertTextVerified(target, text, (ok) => {
            done();
            if (ok) {
              toast(`🧠 added ${summary} to your draft — review & send`, true);
              logInjection({
                kind: 'inject', site, mechanism: 'composer', status: 'inserted', chars: text.length,
                forced: !!forceComposer, facts: built.facts, profileLines: built.profileLines,
                prefetched: !!prefetched, convId: convRef().convId, at: Date.now(),
              });
            } else {
              // Insert genuinely failed — never lose the context: copy it so the
              // user can paste (a pasted-then-sent block is still loop-stripped).
              navigator.clipboard.writeText(text.trim()).then(
                () => toast(`🧠 ${summary} copied — paste it into the composer (Cmd/Ctrl+V)`, true),
                () => toast('✗ could not insert or copy — click into the composer, then retry', false),
              );
              logInjection({
                kind: 'inject', site, mechanism: 'composer', status: 'clipboard', chars: text.length,
                forced: !!forceComposer, facts: built.facts, profileLines: built.profileLines,
                prefetched: !!prefetched, convId: convRef().convId, at: Date.now(),
              });
            }
          });
        }
      };
      // PLAN-INJECT-FAST-LANE P0 — consume the typed-while-warm cache first; a
      // hit skips the gateway round-trip entirely (perceived ~0ms). Miss →
      // exactly the old path.
      const warm = ctxPrefetchTake(seed, convRef().convId || '');
      if (warm) { handleResp(warm, true); return; }
      fetchCandidates(seed, 'all', (resp) => handleResp(resp, false));
    }

    window.addEventListener('keydown', (e) => {
      try {
        // Ctrl+B         → insert into the composer on a supported site
        // Ctrl+Shift+B   → force composer insertion on ANY site
        // (physical KeyB; Cmd+B stays the site's bold on macOS.)
        if (!(e.ctrlKey && !e.altKey && !e.metaKey && e.code === 'KeyB')) return;
        const site = injectSiteKey();
        if (!site) return; // unsupported host — leave the hotkey to the page
        // Capture the composer NOW, while focus is still the box the user typed
        // in — before preventDefault/async can shift focus. Used for seed+insert.
        const composer = findComposer();
        e.preventDefault();
        e.stopPropagation();
        runInject(site, !!e.shiftKey, composer, undefined, true); // Ctrl+B → agentic brain
      } catch (_) { /* the hotkey must never break the page */ }
    }, true);

    // ── PLAN-INPAGE-INJECT-BUTTON — the visible twin of Ctrl+B ─────────────────
    //
    // Ctrl+B is invisible. Nobody reads a shortcut list, so a large share of users
    // never learn that injection exists at all — they get the save half of the
    // product and miss the half that makes it worth installing. This button teaches
    // the feature by existing.
    //
    // It is NOT a new capability. It calls the same runInject() the hotkey calls,
    // with the same per-site gating and the same relevance floor, which is the whole
    // reason it is cheap and safe to add: no send interception, no request rewriting,
    // no new promise. The listing says nothing reaches the chat unless you press
    // Ctrl+B or insert from the picker; this adds a clause to that sentence instead
    // of contradicting it.
    //
    // forceComposer=true — a click carries no shift modifier to read, so it takes the
    // Ctrl+Shift+B path: always visible in the composer, never the network mechanism
    // (which the store build does not ship at all).
    //
    // Mounted on ALL 22 hosts, unlike the save button. Injection works everywhere;
    // saving needs a gateway DOM extractor and only two exist (ChatGPT, Claude).
    // ── The in-page control: ONE disc that fans open ──────────────────────────
    //
    // Was TWO identical 40px discs stacked in the corner at 16px and 64px, both
    // painted with the same Vodou mark and distinguishable only by hovering each
    // one (Chad, 2026-08-01: "I don't like that there are two buttons"). The same
    // mark twice does not read as two controls; it reads as one control that is
    // drawing itself wrong.
    //
    // Now: one disc. Where both actions exist — ChatGPT and Claude — it anchors a
    // menu that fans upward on hover, on focus, or on click. Where only inject
    // exists, which is the other 20 hosts, there is no menu at all and the disc
    // stays the expanding labelled pill it already was, because a menu of one is a
    // worse button than a button.
    //
    // Hover AND click both open it: hover is the affordance the old buttons taught,
    // click is what works on touch, and focus-within is what a keyboard gets.
    function mountFab() {
      const site = injectSiteKey();
      if (!site) return;                       // unsupported host — no control
      if (document.getElementById('vodou-fab-wrap')) return;

      // What this host can actually do. Save is ChatGPT/Claude-only because it
      // round-trips through the gateway extractor, which has a reader for those two
      // and nothing else — offering it elsewhere would be a button that always fails.
      const actions = [{
        key: 'inject',
        label: 'Add my memory',
        name: 'Add my memory to this chat as an editable draft (Ctrl+B)',
        run(report) {
          report('🧠 pulling your context…');
          // Re-read the composer at CLICK time, not at mount: these are SPAs and the
          // element the user is typing into is routinely replaced under us.
          try { runInject(site, true, findComposer(), undefined, true); } // FAB → agentic brain
          catch (e) { report('✗ inject failed: ' + ((e && e.message) || e), false); }
          // Everything past this point is reported by runInject through toast(), which
          // now lands in THIS label — including the ordinary "nothing suitable to
          // inject". No fixed-duration guess here any more: the old 2.5s restore was
          // racing the pull it was describing, so a slow pull cleared the button and
          // then repainted it from the toast.
        },
      }];
      // Save is offered where the site has a VERIFIED selector set, not where a
      // hardcoded host list says. Until 2026-08-01 this was BUTTON_HOSTS —
      // ChatGPT and Claude — because those were the only two the gateway could
      // extract. sites.js now carries a `save` block for each site whose
      // extraction was checked against a real conversation, and the extractor
      // registry in background.js is built from the SAME field. One source, so
      // the button and the thing behind it cannot disagree about coverage.
      //
      // A site without a verified block gets no menu item at all. That is the
      // point: a Save button that reliably answers "no usable turns" teaches
      // people the feature is broken rather than that it is not ready here.
      const siteCfg = INJECT_SITES[site];
      if (siteCfg && siteCfg.save && siteCfg.save.user) {
        actions.push({
          key: 'save',
          label: 'Save what’s here',
          name: 'Save the messages loaded on this page to Vodou memory',
          run(report) {
            report('Saving…');
            // BOTH names travel. `source` is the capture/adapter name and becomes
            // the import slug; `site` is the sites.js key and selects the
            // extractor. They differ on six sites (mistral/lechat, t3/t3chat,
            // you/youcom, duck/duckai, huggingface/huggingchat,
            // character/characterai) and sending one for the other silently
            // routes to the wrong extractor.
            triggerCapture(siteCfg.capture, site, (text, good) => {
              report(text, good);
              if (good !== undefined) setTimeout(() => report(null), 3200);
            });
          },
        });
      }

      const SID = 'vodou-fab-style';
      if (!document.getElementById(SID)) {
        const st = document.createElement('style');
        st.id = SID;
        st.textContent = `
#vodou-fab-wrap {
  position: fixed !important; bottom: 16px !important; right: 16px !important;
  z-index: 2147483647 !important; margin: 0 !important; padding: 0 !important;
  display: flex !important; flex-direction: column !important;
  align-items: flex-end !important; gap: 8px !important;
  /* The WRAP must not be a hit target. It is as wide as its widest child — the
     "Save what's here" pill, ~170px — and visibility:hidden on the closed menu
     still occupies layout, so the box spans roughly 170x90 in the corner. A
     transparent div with default pointer-events swallows every click inside it,
     and on 2026-08-02 that was landing on Perplexity's own Submit button: the
     user could not send at all, on a site where the send control sits
     bottom-right. ChatGPT and Claude centre their composer, which is why this
     hid for as long as it did. Only the real controls take pointer events. */
  pointer-events: none !important;
}
#vodou-fab, .vodou-fab-item, .vodou-fab-solo { pointer-events: auto !important; }
/* Once the menu is OPEN the wrap becomes a hit target again, so the 8px gap between
   the disc and the items does not drop :hover and snap the menu shut halfway to the
   thing you are reaching for. At rest it stays inert, which is the state that was
   eating the page's own buttons. */
#vodou-fab-wrap:hover, #vodou-fab-wrap:focus-within, #vodou-fab-wrap.vodou-open {
  pointer-events: auto !important;
}
#vodou-fab-menu {
  display: flex !important; flex-direction: column !important;
  align-items: flex-end !important; gap: 6px !important;
  opacity: 0; visibility: hidden; pointer-events: none; transform: translateY(6px);
  transition: opacity .16s ease, transform .16s ease, visibility .16s ease;
}
#vodou-fab-wrap:hover > #vodou-fab-menu,
#vodou-fab-wrap:focus-within > #vodou-fab-menu,
#vodou-fab-wrap.vodou-open > #vodou-fab-menu {
  opacity: 1; visibility: visible; pointer-events: auto; transform: none;
}
/* A result nobody can read is not a result: while an item is reporting, the menu
   stays open even if the pointer has left it. */
#vodou-fab-wrap:has(.vodou-busy) > #vodou-fab-menu {
  opacity: 1; visibility: visible; pointer-events: auto; transform: none;
}
#vodou-fab, .vodou-fab-item, .vodou-fab-solo {
  display: flex !important; align-items: center !important; margin: 0 !important;
  border: 1px solid rgba(0,0,0,.10) !important; border-radius: 999px !important;
  background: #fff !important; color: #111827 !important;
  font: 600 12.5px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
  letter-spacing: .01em !important; cursor: pointer !important; opacity: 1 !important;
  box-shadow: 0 4px 14px rgba(0,0,0,.22), 0 1px 3px rgba(0,0,0,.12) !important;
}
/* The disc is a true 40px CIRCLE. The sites we run on set box-sizing:border-box
   globally, so the 1px border sits INSIDE the 40px height — the width has to be
   8 + 22 + 8 + 2 = 40 to match it. Measured in a browser, not assumed. */
#vodou-fab {
  height: 40px !important; min-height: 40px !important; width: 40px !important;
  padding: 0 8px !important; justify-content: center !important;
  transition: box-shadow .16s ease;
}
.vodou-fab-item {
  height: 36px !important; min-height: 36px !important; width: auto !important;
  padding: 0 14px 0 10px !important; gap: 8px !important; white-space: nowrap !important;
  transition: box-shadow .16s ease;
}
/* Reported lines are sentences, not labels — "no vault memories matched this chat
   — nothing to inject" is 54 characters. Cap the width and ellipsise; the full
   string is on title and aria-label. */
.vodou-fab-item > span {
  max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#vodou-fab:hover, .vodou-fab-item:hover {
  box-shadow: 0 7px 20px rgba(0,0,0,.28), 0 1px 3px rgba(0,0,0,.14) !important;
}
/* Single-action hosts keep the expanding pill the inject button already was. */
.vodou-fab-solo {
  height: 40px !important; min-height: 40px !important; width: auto !important;
  padding: 0 8px !important; gap: 0 !important; justify-content: flex-start !important;
  transition: box-shadow .16s ease, padding .18s ease, gap .18s ease;
}
.vodou-fab-solo > span {
  max-width: 0; overflow: hidden; white-space: nowrap;
  transition: max-width .18s ease;
}
.vodou-fab-solo:hover, .vodou-fab-solo:focus-visible, .vodou-fab-solo.vodou-busy {
  gap: 8px !important; padding: 0 16px 0 8px !important;
  box-shadow: 0 7px 20px rgba(0,0,0,.28), 0 1px 3px rgba(0,0,0,.14) !important;
}
.vodou-fab-solo:hover > span,
.vodou-fab-solo:focus-visible > span { max-width: 200px; }
/* Wider while reporting: a result clipped at 200px reads as a different result. */
.vodou-fab-solo.vodou-busy > span { max-width: 320px; text-overflow: ellipsis; }
/* Result states recolour the TEXT, not the pill — repainting the background green
   or red would bury the blue mark in it.
   NOTE: no backticks in here — this whole block lives inside a JS template literal,
   and one backtick ends it early. See the guard in sites.test.mjs. */
.vodou-ok > span   { color: #15803d !important; }
.vodou-fail > span { color: #b91c1c !important; }
#vodou-fab:focus-visible, .vodou-fab-item:focus-visible, .vodou-fab-solo:focus-visible {
  outline: 2px solid ${VODOU_BLUE}; outline-offset: 2px;
}
#vodou-fab[disabled], .vodou-fab-item[disabled], .vodou-fab-solo[disabled] {
  cursor: default !important; opacity: .7 !important;
}
@media (prefers-reduced-motion: reduce) {
  #vodou-fab-menu, #vodou-fab, .vodou-fab-item, .vodou-fab-solo,
  .vodou-fab-solo > span { transition: none; }
}`;
        (document.head || document.documentElement).appendChild(st);
      }

      // One builder for both shapes. `report(text, good)` rewrites ONLY the label
      // span — writing textContent on the button would delete the mark with it.
      // report(null) restores the resting label and re-enables.
      function makePill(a, cls, markPx) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = cls;
        b.setAttribute('aria-label', a.name);
        b.title = a.name;
        const span = document.createElement('span');
        span.textContent = a.label;
        span.setAttribute('aria-live', 'polite');   // announce results, do not interrupt
        b.append(vodouMark(markPx), span);
        // report(text, good):
        //   text null      → back to the resting label, re-enabled
        //   good undefined → still working; holds until something replaces it
        //   good boolean   → a result; holds long enough to read, then restores
        // The full string also goes on title and aria-label, because the pill
        // ellipsises at 320px and some of these lines run to 75 characters.
        let restoreT = null, stallT = null;
        function report(text, good) {
          if (restoreT) { clearTimeout(restoreT); restoreT = null; }
          if (stallT) { clearTimeout(stallT); stallT = null; }
          span.textContent = text == null ? a.label : text;
          b.title = text == null ? a.name : text;
          b.setAttribute('aria-label', text == null ? a.name : text);
          b.classList.remove('vodou-ok', 'vodou-fail');
          if (good === true) b.classList.add('vodou-ok');
          else if (good === false) b.classList.add('vodou-fail');
          if (text == null) { b.disabled = false; b.classList.remove('vodou-busy'); return; }
          b.classList.add('vodou-busy');
          // A progress line whose result never arrives would strand the button
          // disabled for the life of the tab. Bounded, generously.
          if (good === undefined) stallT = setTimeout(() => { stallT = null; report(null); }, 20000);
          else restoreT = setTimeout(() => { restoreT = null; report(null); }, 3600);
        }
        b.__vodouReport = report;
        b.addEventListener('click', () => {
          if (b.disabled) return;
          b.disabled = true;
          try { a.run(report); }
          catch (e) { report('✗ ' + String((e && e.message) || e).slice(0, 40), false); setTimeout(() => report(null), 3200); }
        });
        return b;
      }

      const wrap = document.createElement('div');
      wrap.id = 'vodou-fab-wrap';

      if (actions.length === 1) {
        const solo = makePill(actions[0], 'vodou-fab-solo', 22);
        fabReport = solo;
        wrap.append(solo);
      } else {
        const menu = document.createElement('div');
        menu.id = 'vodou-fab-menu';
        menu.setAttribute('role', 'menu');
        for (const a of actions) {
          const item = makePill(a, 'vodou-fab-item', 16);
          item.setAttribute('role', 'menuitem');
          // Inject is where runInject's reporting lands. When it reports while the
          // menu is shut, the :has(.vodou-busy) rule above fans the menu open so the
          // line is actually visible — otherwise Ctrl+B would report into a hidden node.
          if (a.key === 'inject') fabReport = item;
          menu.append(item);
        }
        const disc = document.createElement('button');
        disc.id = 'vodou-fab';
        disc.type = 'button';
        disc.setAttribute('aria-haspopup', 'menu');
        disc.setAttribute('aria-expanded', 'false');
        disc.setAttribute('aria-label', 'Vodou memory actions');
        disc.title = 'Vodou memory actions';
        disc.append(vodouMark(22));
        disc.addEventListener('click', () => {
          const open = !wrap.classList.contains('vodou-open');
          wrap.classList.toggle('vodou-open', open);
          disc.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        wrap.append(menu, disc);
      }

      (document.body || document.documentElement).appendChild(wrap);
    }

    // Dismissal is bound ONCE per page, not once per mount — the re-mount timer
    // below would otherwise stack a fresh pair of document listeners every 3
    // seconds for as long as the tab is open. It reads the DOM instead of closing
    // over a wrap, so it keeps working after a re-mount replaces that node.
    // Capture phase, so a page that swallows clicks cannot wedge the menu open.
    if (!window.__vodouFabDismissBound) {
      window.__vodouFabDismissBound = true;
      const dismiss = (ev) => {
        const w = document.getElementById('vodou-fab-wrap');
        if (!w) return;
        // A click INSIDE the control is the disc toggling or an item running — both
        // need the menu to stay put, the latter so its result is readable.
        if (ev && ev.type === 'click' && w.contains(ev.target)) return;
        w.classList.remove('vodou-open');
        const d = document.getElementById('vodou-fab');
        if (d) d.setAttribute('aria-expanded', 'false');
      };
      document.addEventListener('click', dismiss, true);
      document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') dismiss(ev); }, true);
    }

    // ── Auto-attach on send (opt-in, default OFF) ─────────────────────────────
    //
    // Approved by Chad on 2026-08-01 with the cost stated plainly: this variant
    // FIRES THE SEND ITSELF, so "nothing is ever sent on your behalf" stops being
    // true while it is on. The panel copy is conditioned to match, and the toggle
    // defaults off for anyone who never opens the panel.
    //
    // The rejected alternative was insert-then-let-the-original-send-through. It
    // keeps the promise intact and does not work: Lexical, ProseMirror and plain
    // textareas each commit state differently, and when the send wins the race the
    // message goes WITHOUT the memory and nothing says so. A memory feature that
    // silently attaches nothing is worse than one that is honestly labelled as
    // acting for you.
    //
    // THE MESSAGE IS NEVER LOST. Every path resends: pull failed, nothing matched,
    // insert failed, or the whole thing hung past the watchdog. Eating someone's
    // message would be the one unforgivable failure here, so the resend is wired to
    // runInject's guaranteed-once callback rather than to its success.
    // 4s (was 12s): the retrieval lane is sub-second since Bundle A (vector
    // cache + prefetch), so 4s already means something is genuinely wrong —
    // send as-typed rather than holding the user's message hostage.
    const AUTOSEND_WATCHDOG_MS = 4000;
    let autoSendPassthrough = false;   // set while WE re-fire the user's send

    // ONE site list answers "where Vodou works" (injectSettings.sites); these answer
    // "what it does there". The retired autoSendSites/brainSites maps are deliberately
    // NOT read any more — their grids are gone from Settings, so honouring them would
    // leave a site silently disabled with no way to see or undo it.
    function autoSendEnabled(site) {
      return injectSettings.autoSend === true
        && injectSettings.master !== false
        && (injectSettings.sites || {})[site] !== false;
    }

    // PLAN-BRAIN-INJECT-LANE — Brain mode is the agentic upgrade to inject. Like
    // autoSend it must be EXPLICITLY on (=== true): it runs tools/skills and can act,
    // so a missing value can only ever mean off. Per-site gate mirrors the others.
    function brainModeEnabled(site) {
      return injectSettings.brain === true
        && injectSettings.master !== false
        && (injectSettings.sites || {})[site] !== false;
    }

    // Prefetch cache (PLAN-AUTO-INJECT-P4 §2.5 lever, finally built): run the brain
    // speculatively while the user types so the pack is warm at send time. Keyed by
    // {draftHash, convId}; TTL 5 min; small LRU. prefetchTake() consumes a fresh entry.
    const PREFETCH_TTL_MS = 5 * 60000;
    const PREFETCH_MAX = 8;
    const prefetchCache = new Map(); // key → { pack, ts }
    let prefetchTimer = null;
    const draftHash = (s) => { let h = 0; const str = String(s || ''); for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) | 0; } return h + ':' + str.length; };
    const prefetchKey = (seed, convId) => draftHash(seed) + '@' + (convId || '');
    function prefetchTake(seed, convId) {
      const key = prefetchKey(seed, convId);
      const hit = prefetchCache.get(key);
      if (!hit) return null;
      prefetchCache.delete(key);
      if (Date.now() - hit.ts > PREFETCH_TTL_MS) return null;
      return hit.pack;
    }
    function schedulePrefetch(site, composer) {
      if (!brainModeEnabled(site)) return;
      clearTimeout(prefetchTimer);
      prefetchTimer = setTimeout(() => {
        const seed = chatContextQuery(composer);
        if (!seed || seed.trim().length < 4) return;
        const convId = convRef().convId || '';
        const key = prefetchKey(seed, convId);
        if (prefetchCache.has(key)) return; // already warming/warm
        // Background prefetch on a typing timer — SILENT when the bridge is
        // stale. Nobody pressed anything, so a toast here would interrupt someone
        // mid-sentence to report a failure they did not ask for. The user meets
        // the sentence at the next deliberate action instead.
        if (!bridgeAlive()) return;
        try {
        chrome.runtime.sendMessage({
          type: 'get_brain_context', draft: seed, host: location.host,
          tools: injectSettings.brainTools || 'all',
          provider: convRef().provider || '', conv_id: convId, url: location.href, budget_ms: 10000,
        }, (resp) => {
          if (!resp || !resp.ok || resp.mode === 'answer') return; // only cache inject packs
          if (prefetchCache.size >= PREFETCH_MAX) { const k = prefetchCache.keys().next().value; prefetchCache.delete(k); }
          prefetchCache.set(key, { pack: resp, ts: Date.now() });
          // Proactive nudge: auto-send off but we have something good → invite Ctrl+B.
          if (!autoSendEnabled(site) && resp.pack && String(resp.pack.text || '').trim()) {
            toast('🧠 I have context for this — Ctrl+B to attach', false);
          }
        });
        } catch (_) { /* bridge died mid-prefetch — silent, as above */ }
      }, 1200);
    }

    // PLAN-INJECT-FAST-LANE P0 — the same prefetch lever for the RETRIEVAL lane
    // (Brain mode off, the default). Bundle A took the pull to ~0.7-0.9s; this
    // hides the rest: warm the context while the user types, so the button /
    // auto-attach consumes a cache hit instead of waiting on the gateway.
    // Same shape as the brain cache above (draft-hash+conv key, TTL, LRU),
    // kept SEPARATE because the cached value is a get_context response, not a
    // brain pack — sharing the Map would let one lane serve the other's shape.
    const ctxPrefetchCache = new Map(); // key → { resp, ts }
    let ctxPrefetchTimer = null;
    let ctxPrefetchPendingKey = null;   // one in-flight warm at a time
    function ctxPrefetchTake(seed, convId) {
      const key = prefetchKey(seed, convId);
      const hit = ctxPrefetchCache.get(key);
      if (!hit) return null;
      ctxPrefetchCache.delete(key);
      if (Date.now() - hit.ts > PREFETCH_TTL_MS) return null;
      return hit.resp;
    }
    function scheduleCtxPrefetch(site, composer) {
      // Self-gates: inject on, Brain OFF (Brain mode has its own prefetch above).
      if (brainModeEnabled(site)) return;
      if (!injectSettings.master || injectSettings.sites[site] === false) return;
      clearTimeout(ctxPrefetchTimer);
      ctxPrefetchTimer = setTimeout(() => {
        const seed = chatContextQuery(composer);
        if (!seed || seed.trim().length < 4) return;
        const convId = convRef().convId || '';
        const key = prefetchKey(seed, convId);
        if (ctxPrefetchCache.has(key) || ctxPrefetchPendingKey === key) return; // warm/warming
        ctxPrefetchPendingKey = key;
        fetchCandidates(seed, 'all', (resp) => {
          if (ctxPrefetchPendingKey === key) ctxPrefetchPendingKey = null;
          if (!resp || !resp.ok) return; // never cache failures
          if (ctxPrefetchCache.size >= PREFETCH_MAX) { const k = ctxPrefetchCache.keys().next().value; ctxPrefetchCache.delete(k); }
          ctxPrefetchCache.set(key, { resp, ts: Date.now() });
        });
      }, 1200);
    }

    // ── PLAN-MEMORY-ON-EVERY-PAGE P2b — "Related to what you're typing" ──────
    // Publishes retrieval results for the CURRENT DRAFT to the side panel as a
    // `typing_context` runtime message (extension pages receive it directly).
    // Same 1.2 s debounce and draft-hash dedup as the prefetch lanes; serves
    // from the ctx prefetch cache when it already holds this draft. Gates:
    //   • adapter host → inject on for this site (the prefetch lanes already
    //     send drafts there);
    //   • any other page → the page-memory toggle, whose disclosure names it.
    // Never on password / one-time-code / payment fields (isComposerish already
    // excludes <input>; this is belt for contenteditable with those semantics).
    let typingTimer = null;
    let typingLastKey = '';
    let typingPageMemOn = false;
    try {
      chrome.storage.local.get(['vodou_page_memory_enabled'], (v) => { typingPageMemOn = !!(v && v.vodou_page_memory_enabled === true); });
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && 'vodou_page_memory_enabled' in ch) typingPageMemOn = ch.vodou_page_memory_enabled.newValue === true;
      });
    } catch (_) { /* storage unavailable — stays off */ }
    // P4 — per-site mode (gateway-resolved). Unknown = not allowed: on a page
    // that has not answered yet nothing is sent, which is the right default for
    // exactly the sites the sensitive list exists for.
    let siteMode = null;
    let siteModeAsked = false;
    function askSiteMode() {
      if (siteModeAsked) return;
      siteModeAsked = true;
      try {
        chrome.runtime.sendMessage({ type: 'get_site_mode', host: location.hostname }, (r) => {
          void chrome.runtime.lastError;
          siteMode = (r && r.ok && r.mode) ? r.mode : 'off';
        });
      } catch (_) { siteMode = 'off'; }
    }
    function typingAllowed(site) {
      if (site) return !!injectSettings.master && injectSettings.sites[site] !== false;
      if (!typingPageMemOn) return false;
      if (siteMode === null) { askSiteMode(); return false; }
      return siteMode !== 'off';
    }
    // Ask once up front where the lane is on, so the first pause already knows.
    try { chrome.storage.local.get(['vodou_page_memory_enabled'], (v) => { if (v && v.vodou_page_memory_enabled === true && !injectSiteKey()) askSiteMode(); }); } catch (_) {}
    try { chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && 'vodou_site_modes' in ch) { siteMode = null; siteModeAsked = false; } }); } catch (_) {}
    function sensitiveField(el) {
      const ac = String((el && el.getAttribute && el.getAttribute('autocomplete')) || '').toLowerCase();
      return /^(cc-|one-time-code|new-password|current-password)/.test(ac);
    }
    function publishTyping(payload) {
      try { chrome.runtime.sendMessage(Object.assign({ type: 'typing_context', host: location.hostname, url: location.href }, payload), () => { void chrome.runtime.lastError; }); } catch (_) { /* panel closed */ }
    }
    function scheduleTypingContext(site, el) {
      if (!typingAllowed(site) || sensitiveField(el)) return;
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => {
        const seed = draftText(el);
        if (!seed || seed.trim().length < 4) { if (typingLastKey) { typingLastKey = ''; publishTyping({ clear: true }); } return; }
        const key = draftHash(seed);
        if (key === typingLastKey) return;
        typingLastKey = key;
        const cached = ctxPrefetchCache.get(prefetchKey(seed, convRef().convId || ''));
        const emit = (resp) => {
          if (!resp || !resp.ok || !Array.isArray(resp.items)) return;
          publishTyping({ seed: seed.slice(0, 120), items: resp.items.slice(0, 8).map((i) => ({ id: i.id, text: i.text, scope: i.scope, created_at: i.created_at, relevance: i.relevance, in_vault: i.in_vault })) });
        };
        if (cached && Date.now() - cached.ts <= PREFETCH_TTL_MS) { emit(cached.resp); return; }
        fetchCandidates(seed, 'all', emit);
      }, 1200);
    }
    // ── P5 — save what I write on THIS site (opt-in per site, default OFF) ─
    // On a site the user enabled Vodou for, and additionally switched capture
    // on for, a submitted composer/textarea (Enter without Shift in a
    // composerish element, or its form's submit) is filed as a manual capture
    // with the page stamped — the same shape as a right-click clip. Never on
    // adapter hosts (their capture is the network lane), never on password /
    // one-time-code / payment fields, never below 8 characters.
    let siteCaptureOn = null;
    function refreshSiteCapture() {
      try { chrome.storage.local.get(['vodou_site_capture'], (v) => { const m = (v && v.vodou_site_capture) || {}; siteCaptureOn = !!m[location.hostname.replace(/^www\./, '')]; }); } catch (_) { siteCaptureOn = false; }
    }
    refreshSiteCapture();
    try { chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && 'vodou_site_capture' in ch) refreshSiteCapture(); }); } catch (_) {}
    let lastSiteCaptureKey = '';
    function siteCapture(el) {
      // DIAG (kept): each bail-out names itself in the page console — the
      // first live test (2026-08-18) produced no capture and no clue.
      const why = (r) => { if (DIAG() || true) console.log('[vodou-site-capture]', r); };
      if (siteCaptureOn === null) { refreshSiteCapture(); why('setting not loaded yet — try once more'); return; }
      if (!siteCaptureOn) { why('off for this site (tick "Also save what I write on this site" in the panel)'); return; }
      if (injectSiteKey()) { why('adapter host — the network lane captures here'); return; }
      if (!isComposerish(el)) { why('not a composer-ish element: ' + (el && el.tagName)); return; }
      if (sensitiveField(el)) { why('sensitive field — never captured'); return; }
      const text = (editorText(el) || '').trim();
      if (text.length < 8) { why('too short (' + text.length + ' chars)'); return; }
      const key = draftHash(text);
      if (key === lastSiteCaptureKey) { why('same text already sent'); return; }
      lastSiteCaptureKey = key;
      try {
        chrome.runtime.sendMessage({ type: 'site_capture_turn', host: location.hostname, url: location.href, title: document.title || '', text }, (r) => {
          void chrome.runtime.lastError;
          why(r && r.ok ? 'sent → saved with this page' : ('not saved: ' + ((r && r.reason) || 'no answer')));
          if (r && r.ok) toast('\u2713 Saved what you wrote to your Vodou memory \u2014 with this page', true, { float: true });
          else toast('Not saved: ' + ((r && r.reason) || 'Vodou did not answer'), false, { float: true });
        });
      } catch (e) { why('send failed: ' + (e && e.message)); }
    }
    // Remember the composer the user was last typing in: on Ctrl/Cmd+Enter
    // focus can already have moved (live 2026-08-18: activeElement was BODY).
    let lastComposer = null;
    document.addEventListener('focusin', (ev) => { if (ev.target && isComposerish(ev.target)) lastComposer = ev.target; }, true);
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' || ev.shiftKey || ev.altKey) return;
      let el = document.activeElement;
      if (!el || el === document.body || !isComposerish(el)) el = (lastComposer && lastComposer.isConnected) ? lastComposer : el;
      // Enter submits in single-line-ish composers; textareas submit on Ctrl/Cmd+Enter.
      if (el && el.tagName === 'TEXTAREA' && !(ev.ctrlKey || ev.metaKey)) return;
      if (el) siteCapture(el);
    }, true);
    document.addEventListener('submit', (ev) => {
      const form = ev.target;
      if (!form || !form.querySelectorAll) return;
      const el = [...form.querySelectorAll('textarea, [contenteditable="true"]')].find((n) => isComposerish(n));
      if (el) siteCapture(el);
    }, true);

    // Leaving the field: tell the panel to fold the section.
    document.addEventListener('focusout', (ev) => {
      if (ev.target && isComposerish(ev.target) && typingLastKey) { typingLastKey = ''; publishTyping({ clear: true }); }
    }, true);

    // A send button, without a per-site list. Site-specific selectors would be a
    // second registry to keep in step with sites.js; these attributes are what the
    // sites already expose to assistive tech, so they move with the UI rather than
    // against it.
    // "Submit" as well as "Send", and role=button as well as <button>.
    //
    // Perplexity's is aria-label="Submit" with type="button" — it matched NOTHING in
    // the first version, so a click sent the message with no memory attached and no
    // error, because the interceptor simply never ran. That is the quiet half of this
    // feature's failure surface: the Enter path and the click path fail
    // independently, and a site can have a perfectly good composer and an unmatched
    // button.
    //
    // Matching on the accessible name rather than a per-site list is still the right
    // call — it is what these buttons expose to screen readers and it moves with the
    // UI — but the vocabulary is wider than "send".
    const SEND_BTN = [
      'button[data-testid="send-button"]',
      'button[data-testid*="send" i]',
      'button[data-testid*="submit" i]',
      'button[aria-label*="send" i]',
      'button[aria-label*="submit" i]',
      'button[title*="send" i]',
      'button[title*="submit" i]',
      'button[type="submit"]',
      '[role="button"][aria-label*="send" i]',
      '[role="button"][aria-label*="submit" i]',
      // Kimi's is a plain <div class="send-button-container"> — no button element, no
      // role, no aria-label, no test id. Nothing an accessible-name match can reach.
      // These are deliberately "send-button"/"send-btn" and not a bare "send": a
      // substring match on send alone would catch "sender", "sending", "resend" and
      // start intercepting clicks that are not sends at all.
      '[class*="send-button" i]',
      '[class*="send-btn" i]',
      '[class*="sendbutton" i]',
    ].join(',');

    // Is this element the composer's send control, judged by POSITION?
    //
    // The fallback for sites that mark their send button with nothing at all. Manus
    // is the case that forced it: a <button> with only Tailwind utility classes — no
    // aria-label, no test id, no type, no "send" anywhere, and an SVG with an empty
    // class. Three sites in, three different schemes, and this one has no attribute
    // to match on in any vocabulary. Attribute matching was never going to converge.
    //
    // Guarded three ways, because a false positive here is worse than a miss: missing
    // means the message sends without memory, hijacking means clicking the mic or the
    // model picker silently stuffs memory into the draft.
    //   1. it must be the LAST visible enabled button in the composer's own container
    //   2. its centre must be right of the composer's centre
    //   3. the composer must actually contain text — nobody presses send on an empty
    //      box, and every non-send button in that row is reachable with an empty one
    function looksLikeSendByPosition(el, composer) {
      if (!el || !composer) return null;
      const btn = el.closest('button,[role="button"]');
      if (!btn) return null;
      const draft = (composer.value !== undefined ? composer.value : composer.innerText) || '';
      if (!draft.trim()) return null;                       // guard 3

      // The composer's container: walk up until we find the block that holds buttons.
      let box = composer;
      for (let i = 0; i < 5 && box; i++) {
        box = box.parentElement;
        if (box && box.querySelectorAll('button,[role="button"]').length) break;
      }
      if (!box || !box.contains(btn)) return null;

      const visible = [...box.querySelectorAll('button,[role="button"]')]
        .filter((b) => b.getBoundingClientRect().width > 0 && !isDisabledish(b));
      if (!visible.length || visible[visible.length - 1] !== btn) return null;   // guard 1

      const cr = composer.getBoundingClientRect();
      const br = btn.getBoundingClientRect();
      if (br.left + br.width / 2 <= cr.left + cr.width / 2) return null;         // guard 2
      return btn;
    }

    function isDisabledish(btn) {
      const cls = String(btn.className && btn.className.baseVal !== undefined ? btn.className.baseVal : (btn.className || ''));
      return btn.disabled === true
        || btn.getAttribute('aria-disabled') === 'true'
        || /(^|\s)(is-)?disabled(\s|$)/.test(cls);
    }

    // siteSel is the per-site override from sites.js `send:`, tried FIRST. Only for
    // sites where neither an attribute nor position can reach the control — Manus is
    // the only one so far, and needed its icon's path data.
    function sendButtonFrom(node, composer, siteSel) {
      if (!node || !node.closest) return null;
      let bySite = null;
      if (siteSel) { try { bySite = node.closest(siteSel); } catch (_) { /* bad selector — fall through */ } }
      const btn = bySite || node.closest(SEND_BTN) || looksLikeSendByPosition(node, composer);
      if (!btn) return null;
      // Ignore anything not currently actionable — a disabled send control means the
      // composer is empty and there is nothing to attach to.
      //
      // Three ways to be disabled, because only one of them is the DOM property. A
      // <div> send button cannot have `disabled` at all: Kimi marks its state with a
      // CLASS, and `div.disabled` is undefined, which reads as ENABLED. Intercepting
      // a click on a disabled control would swallow it and leave the user pressing a
      // dead button.
      return isDisabledish(btn) ? null : btn;
    }

    function attachThenSend(site, composer, resend) {
      autoSendPassthrough = true;                 // guard the re-fire below
      // Brain mode runs an agentic turn (server budget 10s + transport), so give it a
      // longer leash than the retrieval lane before the watchdog sends as-typed.
      const watchdogMs = brainModeEnabled(site) ? 15000 : AUTOSEND_WATCHDOG_MS;
      // Cancel token: when the watchdog gives up and sends as-typed, the pull
      // it abandoned is still in flight (background timeout 25s) — without
      // this, its LATE result landed in the composer AFTER the message went
      // out, stranding a context block in the box (observed 2026-08-05).
      const ctl = { cancelled: false };
      const watchdog = setTimeout(() => {
        // Something never reported. Send what the user actually typed rather than
        // leaving them staring at a composer that swallowed their message.
        ctl.cancelled = true;
        try { toast('memory took too long — sending your message as typed', false); } catch (_) {}
        try { resend(); } finally { autoSendPassthrough = false; }
      }, watchdogMs);

      try {
        runInject(site, true, composer, () => {
          if (ctl.cancelled) return;   // watchdog already sent — this run is void
          clearTimeout(watchdog);
          // A tick, so the site's editor commits the inserted text to its own state
          // before the send reads it. Sending in the same task can read the pre-
          // insert value on React-controlled editors.
          setTimeout(() => {
            try { resend(); } finally { autoSendPassthrough = false; }
          }, 60);
        }, false, ctl);
      } catch (e) {
        clearTimeout(watchdog);
        try { resend(); } finally { autoSendPassthrough = false; }
      }
    }

    // Capture phase on BOTH: a page that stops propagation on its own send handler
    // would otherwise never let us see the event.
    document.addEventListener('keydown', (ev) => {
      if (autoSendPassthrough) return;
      if (ev.key !== 'Enter' || ev.shiftKey || ev.altKey || ev.ctrlKey || ev.metaKey) return;
      if (ev.isComposing) return;               // IME candidate selection, not a send
      const site = injectSiteKey();
      if (!site || !autoSendEnabled(site)) return;
      const composer = findComposer();
      if (!composer || !composer.contains(ev.target) && composer !== ev.target) return;
      ev.preventDefault();
      ev.stopPropagation();
      attachThenSend(site, composer, () => {
        composer.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
        }));
      });
    }, true);

    document.addEventListener('click', (ev) => {
      if (autoSendPassthrough) return;
      const site = injectSiteKey();
      if (!site || !autoSendEnabled(site)) return;
      const composer = findComposer();
      if (!composer) return;
      const btn = sendButtonFrom(ev.target, composer, (INJECT_SITES[site] || {}).send);
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      attachThenSend(site, composer, () => { try { btn.click(); } catch (_) {} });
    }, true);

    // Prefetch-while-typing, both lanes. Debounced per keystroke; each scheduler
    // self-gates (Brain mode → brain pack warm, else → retrieval context warm),
    // so this costs nothing on sites/users with inject off. Warm results make
    // the button / Ctrl+B / auto-attach consume a cache hit instead of waiting
    // ~0.7-0.9s on the gateway (PLAN-BRAIN-INJECT-LANE + PLAN-INJECT-FAST-LANE).
    document.addEventListener('input', (ev) => {
      if (ev.target && isComposerish(ev.target)) lastComposer = ev.target;   // P5 site-capture fallback
      const site = injectSiteKey();
      const composer = findComposer();
      if (!composer || (!composer.contains(ev.target) && composer !== ev.target)) return;
      if (site) {
        if (brainModeEnabled(site)) schedulePrefetch(site, composer);
        else scheduleCtxPrefetch(site, composer);
      }
      // P2b — the panel's "Related to what you're typing", on any page.
      scheduleTypingContext(site, composer);
    }, true);

    mountFab();
    // SPAs tear their DOM down on navigation; re-mount if the control goes with it.
    // Cheap: mountFab returns immediately when the node is still present.
    setInterval(() => { try { mountFab(); } catch (_) {} }, 3000);

    // (The 'vodou-inject-status' back-channel belonged to the network mechanism
    // and is gone with it — composer insertion reports its own result inline.)

    // ── PLAN-BRIDGE-SIDE-PANEL P1 — the panel is the picker now ────────────────
    // The side panel hosts this picker outside the page, so the in-page 🧠 button
    // and its 3-second remount loop are retired. That loop existed only because
    // ChatGPT and Claude wipe the body subtree on SPA navigation and delete our
    // button — a timer running forever on 22 hosts to fight the page. The panel is
    // a document in our own origin; nothing can delete it.
    //

    // What the panel needs from the page, and the one thing only the page can do.
    // The panel can call the gateway itself through background — but it cannot read
    // this page's composer draft or its conversation id, and it cannot type into the
    // composer. Those two jobs stay here.
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg) return undefined;

      if (msg.type === 'vodou_panel_probe') {
        // Seed + identity, read fresh at ask-time: the user may have typed since the
        // panel opened, and an SPA route change may have moved them to another chat.
        const ref = convRef();
        sendResponse({
          ok: true,
          host: location.hostname,
          title: document.title || '',
          provider: ref.provider,
          convId: ref.convId,
          seed: chatContextQuery(null),
        });
        return undefined;
      }

      // Ctrl+B / Ctrl+Shift+B come through here now. Registering them as manifest
      // `commands` made Chrome capture the keystroke at browser level, so the page's
      // keydown listener stopped seeing it and the hotkey went dead — a regression
      // from making them discoverable in chrome://extensions/shortcuts. The listener
      // stays as a fallback for when a user clears the binding.
      // ── PLAN-VODOU-TASKS-CHANNEL — the async task lane ─────────────────────
      // The background needs the composer text to dispatch a task (the `run-task`
      // command fires in the background context, which cannot read the page).
      if (msg.type === 'vodou_get_draft') {
        const composer = findComposer();
        sendResponse({
          draft: composer ? chatContextQuery(composer) : '',
          page: { host: location.host, provider: convRef().provider || '', convId: convRef().convId || '', url: location.href },
        });
        return undefined;
      }

      // Live progress for a running task → the in-page pill.
      if (msg.type === 'vodou_task_progress') {
        taskPill.update(msg.jobId, msg.event, !!msg.heavy);
        sendResponse({ ok: true });
        return undefined;
      }

      // A task finished. GUARD (the async composer race): only write into the
      // composer if it STILL holds the draft we dispatched with. If the user has
      // sent it, cleared it, or typed something else, injecting would drop text into
      // an unrelated (possibly empty) box — so we refuse and let the panel /
      // notification deliver instead. Never clobber a draft the user moved on from.
      if (msg.type === 'vodou_task_deliver') {
        const composer = findComposer();
        const current = composer ? chatContextQuery(composer) : '';
        const expect = String(msg.expectDraft || '').trim();
        if (!composer || (expect && !current.includes(expect))) {
          taskPill.done(msg.jobId, false, 'result ready in the Vodou panel');
          sendResponse({ ok: false, error: 'composer changed — not injecting' });
          return undefined;
        }
        const framed = '\n\n' + String(msg.text || '').trim();
        registerStrip(framed.trim());
        insertTextVerified(composer, framed, (ok) => {
          taskPill.done(msg.jobId, ok, ok ? 'added to your draft' : 'copied — paste it in');
          if (!ok) navigator.clipboard.writeText(String(msg.text || '')).catch(() => {});
          logInjection({
            kind: 'task', site: injectSiteKey() || 'web', mechanism: 'composer',
            status: ok ? 'inserted' : 'clipboard', chars: framed.length,
            convId: convRef().convId, at: Date.now(),
          });
        });
        sendResponse({ ok: true });
        return undefined;
      }

      if (msg.type === 'vodou_ping') { sendResponse({ ok: true }); return undefined; }
      // P7 — find text on the page and scroll to it (a tool the brain can call).
      if (msg.type === 'vodou_page_find') {
        const needle = String(msg.text || '').trim();
        if (!needle) { sendResponse({ found: false }); return undefined; }
        try {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
          let node; const lower = needle.toLowerCase();
          while ((node = walker.nextNode())) {
            const t = node.nodeValue || '';
            const i = t.toLowerCase().indexOf(lower);
            if (i >= 0 && node.parentElement && node.parentElement.offsetParent !== null) {
              node.parentElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
              try { const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + needle.length); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); } catch (_) {}
              sendResponse({ found: true, snippet: t.slice(Math.max(0, i - 80), i + needle.length + 80).trim() });
              return undefined;
            }
          }
        } catch (_) {}
        sendResponse({ found: false });
        return undefined;
      }
      // PLAN-ALPHA 11c — the first-run demo's pre-fill. The GATEWAY composes
      // the full text (memory block + demo question); this handler only
      // performs a VERIFIED insertion. Deliberately independent of the inject
      // lane's settings: runInject bails when the auto-inject master toggle is
      // off — the DEFAULT on a fresh install — and the demo must not die on a
      // default. The reply is the insert-confirmation the walkthrough renders.
      if (msg.type === 'vodou_demo_prefill') {
        const composer = findComposer();
        if (!composer) {
          sendResponse({ ok: false, error: 'no composer found — is the page fully loaded and logged in?' });
          return undefined;
        }
        try { composer.focus(); } catch (_) {}
        insertTextVerified(composer, String(msg.text || ''), (landed) => {
          sendResponse({ ok: true, verified: landed === true });
        });
        return true; // async sendResponse (insertTextVerified re-checks at 60ms)
      }

      if (msg.type === 'vodou_run_inject') {
        const site = injectSiteKey();
        if (!site) {
          // PLAN-MEMORY-ON-EVERY-PAGE P2 — the shortcut works on ANY page now.
          // No adapter means no network rewrite, so both hotkeys do the visible
          // insert: memories from THIS page first, else retrieval seeded by the
          // draft, into whatever editable the generic finder settles on.
          runAnyPageInject().then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
          return true;
        }
        runInject(site, !!msg.visible, findComposer(), undefined, true); // hotkey cmd / panel button → agentic brain
        sendResponse({ ok: true });
        return undefined;
      }

      // ── PLAN-MEMORY-ON-EVERY-PAGE P6 — Page Actions: fill from memory ──────
      // `vodou_read_form` returns the page's form MODEL: labels/names/types/
      // options of fillable fields, with a stable selector per field. Password,
      // hidden, payment and one-time-code fields are excluded HERE, before
      // anything leaves the page; current values are read only to know which
      // fields are already filled (they are dropped again by the gateway).
      if (msg.type === 'vodou_read_form') {
        try { sendResponse({ ok: true, model: readFormModel() }); }
        catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
        return undefined;
      }
      // `vodou_apply_fields` writes the values the user ACCEPTED in the panel's
      // review card into the page — React-safe setter + input/change events,
      // selects by option match, contenteditable via the verified inserter.
      // It never clicks submit and never touches a field it was not given.
      if (msg.type === 'vodou_apply_fields') {
        applyFields(Array.isArray(msg.items) ? msg.items : []).then((r) => sendResponse(r));
        return true;
      }

      if (msg.type === 'vodou_panel_insert') {
        const target = findComposer();
        if (!target) {
          sendResponse({ ok: false, error: 'no composer found on this page' });
          return undefined;
        }
        // FENCE-LESS on purpose. The picker used to insert the gateway's
        // ⟦vodou:context v1⟧ block, which is right for the INVISIBLE network path and
        // wrong for anything a human reads: PLAN-AUTO-INJECT-P4 §0.1 found a
        // machine-fenced "retrieved memory" block trips Claude's injection
        // resistance, and Chad saw the raw fence land in his composer.
        //
        // Same shape the composer inject settled on (2026-07-18): the facts, joined,
        // no preamble — "the fact stands on its own; the framing added length and
        // read as boilerplate". Framed HERE rather than in the panel so one place
        // owns how injected text reads.
        //
        // Fence-less means no marker to strip, so it must be registered for the
        // out-of-band loop-strip — otherwise the insert re-enters memory at capture
        // as though the user had typed it.
        const picked = Array.isArray(msg.items) ? msg.items : [];
        if (picked.length) {
          const facts = picked.map((t) => String(t || '').replace(/^[-•]\s*/, '').trim()).filter(Boolean);
          let body = facts.join('; ');
          if (body && !/[.!?]$/.test(body)) body += '.';
          if (body.length > 700) body = body.slice(0, 697) + '…';
          msg = Object.assign({}, msg, { text: body + '\n\n' });
          registerStrip((body + '').trim());
        }
        // insertTextVerified, not insertText: rich editors (ProseMirror, Lexical)
        // return true from execCommand while silently dropping the edit, and apply
        // programmatic changes a tick later. Verified insert is the 2026-07-16
        // finding — see the plan §5b lineage.
        //
        // No strip registration needed: the picker's block is FENCED, and the
        // capture path strips ⟦vodou:context⟧ unconditionally. The registry exists
        // only for the fence-less composer inject.
        insertTextVerified(target, String(msg.text || ''), (ok) => {
          sendResponse(ok
            ? { ok: true }
            : { ok: false, error: 'the composer refused the text — copy it instead' });
        });
        return true;   // async response
      }

      return undefined;
    });
  }

  // PLAN-UNIVERSAL-MEMORY-V2 Phase C (W2a) — relay network-intercepted turns.
  // inject.js (MAIN world) can't reach chrome.runtime; it window.postMessage's
  // captured turns and we forward them to the background service worker, which
  // sends them to the gateway over the WS. Passive capture is OPT-IN: only relay
  // when the user has enabled it (chrome.storage flag, default off), so simply
  // installing the extension never starts silently recording every AI chat.
  function mountRelayOnly() {
    if (window.__vodouNetcapRelayMounted === MOUNT_TOKEN) return;
    window.__vodouNetcapRelayMounted = MOUNT_TOKEN;
    let autoCaptureOn = false;
    // PLAN-AUTO-INJECT-P4 — loop-strip at the capture boundary. Injected context
    // must never re-enter memory as if the user typed it:
    //   • network mechanism: fenced ⟦vodou:context…⟧ blocks (belt here, and the
    //     gateway extractor strips them again — suspenders);
    //   • composer mechanism: NO fence (it trips provider injection resistance),
    //     so we match against the registry of injected texts (out-of-band strip).
    let stripRegistry = [];
    // Per-site capture, keyed by the ADAPTER name (sites.js `capture`), because
    // that is what arrives as d.provider below — not the inject `key`. Six of the
    // 22 disagree between the two vocabularies.
    //
    // Deliberately a SEPARATE storage key from vodou_auto_capture rather than a
    // restructure of it, so there is no migration and no way to silently enable
    // anything: vodou_auto_capture stays the master switch with its existing
    // value, and an absent entry here means "on" — exactly today's behaviour for
    // every existing install. The user opts a site OUT; nothing opts them in.
    let captureSites = {};
    // PLAN-CAPTURE-SAFETY P0-a — the remote policy is a VETO layer, never a grant.
    // background.js stores only explicit `capture:false` entries, so this can turn a
    // provider off but can never turn one back on over the user's choice. Precedence:
    // policy veto > user's per-site toggle > master > default-on.
    let capturePolicy = {};
    const captureAllowedFor = (provider) => autoCaptureOn
      && captureSites[provider] !== false
      && !(capturePolicy[provider] && capturePolicy[provider].capture === false);
    try {
      chrome.storage.local.get(['vodou_auto_capture', 'vodou_capture_sites', 'vodou_capture_policy', 'vodou_inject_registry'], (v) => {
        autoCaptureOn = !!(v && v.vodou_auto_capture);
        captureSites = (v && v.vodou_capture_sites) || {};
        capturePolicy = ((v && v.vodou_capture_policy) || {}).providers || {};
        stripRegistry = (v && v.vodou_inject_registry) || [];
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.vodou_auto_capture) autoCaptureOn = !!changes.vodou_auto_capture.newValue;
        if (changes.vodou_capture_sites) captureSites = changes.vodou_capture_sites.newValue || {};
        if (changes.vodou_capture_policy) capturePolicy = (changes.vodou_capture_policy.newValue || {}).providers || {};
        if (changes.vodou_inject_registry) stripRegistry = changes.vodou_inject_registry.newValue || [];
      });
    } catch (_) { /* ignore */ }

    const STRIP_TTL_MS = 7 * 86400000;
    const FENCE_RE = /⟦vodou:context[^⟧]*⟧[\s\S]*?⟦\/vodou:context⟧\s*/g;
    function stripInjected(turns) {
      try {
        return (turns || []).map((t) => {
          if (!t || t.role !== 'user' || typeof t.content !== 'string') return t;
          let c = t.content.replace(FENCE_RE, '');
          for (const r of stripRegistry) {
            if (!r || !r.text || Date.now() - (r.ts || 0) > STRIP_TTL_MS) continue;
            // PLAN-BRAIN-INJECT-LANE D4 — match ANYWHERE, not just as a prefix.
            // composerFraming APPENDS the pack after the user's draft ('\n\n'+text),
            // so the old startsWith() never matched and injected context was
            // re-entering memory as if the user typed it, on every auto-send. Remove
            // the block wherever it sits and keep the surrounding draft.
            const at = c.indexOf(r.text);
            if (at !== -1) {
              c = (c.slice(0, at) + c.slice(at + r.text.length)).replace(/\s+$/, '').replace(/^\s+/, '');
              break;
            }
          }
          return c === t.content ? t : Object.assign({}, t, { content: c });
        }).filter((t) => !t || typeof t.content !== 'string' || t.content.trim().length > 0);
      } catch (_) { return turns; }
    }

    // Tell the page what actually happened. The page shim cannot see the bridge
    // socket, so without this ack its "relayed to bridge" line is a guess — and
    // it was wrong for an hour on 2026-07-26 while the gateway refused every
    // connection.
    const ackPage = (provider, n, ok, reason, extra) => {
      try {
        window.postMessage({
          source: 'vodou-netcap-ack', provider, n, ok, reason,
          // `queued`: the worker is holding these until the bridge is back.
          // `sig`: lets inject.js un-suppress turns that were neither stored nor
          // held (PLAN-ENGINE-GATED-CAPTURE P0).
          queued: !!(extra && extra.queued), sig: (extra && extra.sig) || '',
        }, '*');
      } catch (_) { /* page gone */ }
    };

    // PLAN-ENGINE-GATED-CAPTURE P3a — the gateway's verdict lands after the page
    // has already logged a send, so correct the record when a batch is refused.
    // Same ack channel the success path uses, with queued:true so inject.js says
    // HELD rather than NOT STORED and does not un-suppress the turns (they are in
    // the retry queue and will be replayed from there).
    chrome.runtime.onMessage.addListener((m) => {
      if (m && m.type === 'vodou_capture_refused') {
        ackPage(m.provider, m.n || 0, false, m.note || m.reason || 'held', { queued: true });
      }
      // The gateway's verdict on what it actually WROTE. Arrives after the relay ack,
      // so the page can correct its own optimistic line rather than leaving a claim
      // nothing checked. `stored: 0` is a normal, healthy outcome — a re-opened
      // conversation re-sends its whole transcript and dedup collapses it.
      if (m && m.type === 'vodou_capture_stored') {
        try {
          window.postMessage({
            source: 'vodou-netcap-stored',
            provider: m.provider, stored: Number(m.stored) || 0, sent: Number(m.sent) || 0,
          }, '*');
        } catch (_) { /* page gone */ }
      }
    });

    window.addEventListener('message', (ev) => {
      if (ev.source !== window) return;
      const d = ev.data;
      // PLAN-HISTORY-BACKFILL P1 — the shim starting after us asks for the config.
      if (d && d.source === 'vodou-netcap-config-request') { pushBackfillConfig(); return; }
      if (!d || d.source !== 'vodou-netcap') return;
      const turns = stripInjected(d.turns) || [];
      // Two refusals, two reasons. A silent or vague "off" is the failure mode
      // that costs a day of debugging — the page log has to name which switch.
      if (!autoCaptureOn) {
        ackPage(d.provider, turns.length, false, 'auto-capture is OFF — click the Vodou icon and turn it on under Settings', { sig: d.sig });
        return;
      }
      if (!captureAllowedFor(d.provider)) {
        ackPage(d.provider, turns.length, false,
          `capture is OFF for ${d.provider} — re-enable it per site under Settings (click the Vodou icon)`,
          { sig: d.sig });
        return;
      }
      try {
        chrome.runtime.sendMessage({
          type: 'net_capture',
          provider: d.provider,
          conversationId: d.conversationId,
          turns,
          // PLAN-CAPTURE-FEED P1 — pass-through only; inject.js owns the value.
          url: typeof d.url === 'string' ? d.url : '',
          // PLAN-HISTORY-BACKFILL — a whole historic transcript, not a live turn.
          // Pass-through; the gateway's duplicate-claim needs it (old rows fall
          // outside the live claim window).
          backfill: !!d.backfill,
        }, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) { ackPage(d.provider, turns.length, false, 'extension worker asleep or reloaded (' + err.message + ')', { sig: d.sig }); return; }
          if (resp && resp.ok) ackPage(d.provider, turns.length, true, '', { sig: d.sig });
          else ackPage(d.provider, turns.length, false, (resp && resp.reason) || 'no response from the extension', { sig: d.sig, queued: resp && resp.queued });
        });
      } catch (e) {
        ackPage(d.provider, turns.length, false, 'could not reach the extension: ' + ((e && e.message) || e), { sig: d.sig });
      }
    });
  }
})();
