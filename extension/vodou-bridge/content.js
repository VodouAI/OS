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
    function toast(text, ok) {
      // isConnected, not just non-null: between an SPA wiping the body and the
      // 3-second remount, this still references the OLD detached pill, and
      // reporting into a node that is not in the document is a silent drop. Fall
      // back to the floating div for that window.
      if (fabReport && fabReport.isConnected) { fabReport.__vodouReport(text, ok); return; }
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
      setTimeout(() => { try { t.remove(); } catch (_) {} }, 4000);
    }

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
      return editorText(el).trim().slice(0, 300);
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
    function insertText(el, text) {
      if (!el) { if (DIAG()) console.log('[vodou-inject] no composer element found'); return false; }
      const before = editorText(el);
      const changed = () => editorText(el) !== before;
      if (DIAG()) console.log('[vodou-inject] target composer:', elDesc(el), '| before len', before.length);
      try { el.focus(); } catch (_) { /* ignore */ }
      // Put the caret at the very start so context prepends the user's draft.
      try {
        const sel = window.getSelection();
        if (sel && el.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        } else if (el.setSelectionRange) {
          el.setSelectionRange(0, 0);
        }
      } catch (_) { /* ignore */ }
      let attempted = false;
      // 1) execCommand — works for textareas and simple contenteditables.
      try {
        const r = document.execCommand('insertText', false, text);
        attempted = true;
        if (DIAG()) console.log('[vodou-inject] 1 execCommand →', r, '| changed', changed());
        if (r && changed()) return true;
      } catch (e) { if (DIAG()) console.log('[vodou-inject] 1 execCommand threw', e && e.message); }
      // 2) native value setter (React-controlled textarea/input, e.g. old ChatGPT).
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        try {
          const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set;
          const next = text + (el.value || '');
          if (setter) setter.call(el, next); else el.value = next;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          attempted = true;
          if (DIAG()) console.log('[vodou-inject] 2 value-setter | changed', changed());
          if (changed()) return true;
        } catch (e) { if (DIAG()) console.log('[vodou-inject] 2 value-setter threw', e && e.message); }
      }
      // 3) beforeinput InputEvent — ProseMirror (Claude) / Lexical apply from
      //    their own handler (often async — see verified re-check).
      try {
        el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
        attempted = true;
        if (DIAG()) console.log('[vodou-inject] 3 beforeinput | changed(sync)', changed());
        if (changed()) return true;
      } catch (e) { if (DIAG()) console.log('[vodou-inject] 3 beforeinput threw', e && e.message); }
      // 4) synthetic paste with a DataTransfer.
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
        attempted = true;
        if (DIAG()) console.log('[vodou-inject] 4 paste | changed(sync)', changed());
        if (changed()) return true;
      } catch (e) { if (DIAG()) console.log('[vodou-inject] 4 paste threw', e && e.message); }
      // No SYNCHRONOUS change — but an async editor may still apply it. Signal
      // "attempted" so the caller re-checks after a tick before falling back.
      return attempted ? 'async' : false;
    }

    // Wrap insertText with an async re-verification: rich editors apply the edit
    // on a later tick, so we confirm the composer actually changed before
    // reporting success. cb(true) = text is in the composer; cb(false) = truly
    // failed (caller does clipboard fallback).
    function insertTextVerified(el, text, cb) {
      const before = editorText(el);
      const r = insertText(el, text);
      if (r === true) { cb(true); return; }
      if (r === false) { cb(false); return; }
      // 'async' — re-read shortly; the editor's own handler may have applied it.
      setTimeout(() => {
        const ok = editorText(el) !== before;
        if (DIAG()) console.log('[vodou-inject] async re-check →', ok ? 'LANDED' : 'still empty');
        cb(ok);
      }, 60);
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
    }

    // ── PLAN-AUTO-INJECT-P4 Phase A: Ctrl+B auto-inject ────────────────────────
    // One hotkey, two mechanisms picked per provider by WHERE it dispatches its
    // send (§2.0 of the plan):
    //   chatgpt → network body-rewrite (page-fetch — invisible; fenced block,
    //             stripped again on recapture; inject.js does the splice)
    //   claude  → composer injection (Service-Worker realm unreachable from page
    //             fetch — visible, honest; FENCE-LESS natural first-person prose,
    //             because a machine-fenced "retrieved memory" block trips
    //             Claude's injection resistance — spike finding 2026-07-15)
    // Context comes from a live vault-scoped `mem context` pull seeded by the
    // draft/conversation (same disclosure boundary as the 🧠 picker). Toggles:
    // chrome.storage vodou_inject_settings {master, sites:{…}}.
    // Sites come from sites.js, loaded as the first content script so
    // this lookup and the panel's per-site toggles cannot drift apart. Keyed
    // here for O(1) access by the rest of the file.
    const INJECT_SITES = {};
    for (const s of (globalThis.VODOU_SITES || [])) INJECT_SITES[s.key] = s;
    function injectSiteKey() {
      for (const [k, v] of Object.entries(INJECT_SITES)) if (v.host.test(location.hostname)) return k;
      return null;
    }
    let injectSettings = { master: true, sites: {} };
    try {
      chrome.storage.local.get(['vodou_inject_settings'], (v) => {
        if (v && v.vodou_inject_settings) injectSettings = Object.assign(injectSettings, v.vodou_inject_settings);
      });
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && ch.vodou_inject_settings) {
          injectSettings = Object.assign({ master: true, sites: {} }, ch.vodou_inject_settings.newValue || {});
        }
      });
    } catch (_) { /* storage unavailable — defaults stand */ }

    function logInjection(entry) {
      try { chrome.runtime.sendMessage({ type: 'inject_log', entry }); } catch (_) { /* ignore */ }
    }

    // Counts from the last armed network block, replayed onto the `injected`
    // confirmation (inject.js only reports that the send happened, not what was
    // in it — it never saw the parts).
    let lastArmed = { facts: 0, profileLines: 0 };

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
    // tangential matches (2026-07-18: "what's my dog's name" returned Lucy at
    // 0.978 AND four dog-name *debugging* notes — scope capture:ide:claude-code,
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
    // plus the profile lines whose words overlap the question. The invisible
    // network path injects the WHOLE profile (no size cost) — see fencedBlock.
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
    function composerFraming(profile, selected, items, query) {
      const facts = (Array.isArray(selected) && selected.length)
        ? selected.map((t) => String(t || '').replace(/^[-•]\s*/, '').trim()).filter(Boolean)
        : relevantItems(items, 4);
      let body;
      let profileLines = 0;
      if (facts.length) {
        body = facts.join('; ') + '.';            // specific answer only
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
      return { text: s + '\n\n', facts: facts.length, profileLines };
    }

    // Network providers: fenced block assembled from the gateway's own parts
    // (single producer for the fence format); profile rides inside the fence.
    // Same contract as composerFraming: { text, facts, profileLines } counting
    // only what the block actually carries. This path DOES ship the whole
    // profile, so profileLines is its real line count.
    function fencedBlock(resp) {
      const facts = (Array.isArray(resp.selected) && resp.selected.length)
        ? resp.selected.map((t) => String(t || '').replace(/^[-•]\s*/, '').trim()).filter(Boolean)
        : relevantItems(resp.items, 6);
      const prof = String(resp.profile || '').trim();
      const empty = { text: '', facts: 0, profileLines: 0 };
      if (!prof && !facts.length) return empty;
      const lines = [];
      if (resp.open) lines.push(resp.open);
      if (resp.header) lines.push(resp.header);
      if (prof) lines.push(prof);
      for (const t of facts) lines.push('- ' + t);
      if (resp.close) lines.push(resp.close);
      if (lines.length <= 2) return empty;
      const profileLines = prof ? prof.split('\n').filter((l) => l.trim()).length : 0;
      return { text: lines.join('\n'), facts: facts.length, profileLines };
    }

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
    // default mechanism so ANY site — including ChatGPT — inserts VISIBLY into
    // the composer instead of the invisible network rewrite. ChatGPT's composer
    // is already a proven insert target (the 🧠 button uses it), so "make
    // ChatGPT work like Claude" is just routing to the composer path.
    function runInject(site, forceComposer, composer, onDone) {
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
      toast('🧠 pulling your context…');   // progress: holds until a result lands
      // scope 'all' → search the ENTIRE store, not just the portable vault
      // (2026-07-18, Chad: any external-LLM lookup must reach all memory — the
      // old vault-scoped pull hid basic personal facts like "my dog is Lucy",
      // which are tagged RESEARCH/etc., not PREF, so the PREF-only portable
      // vault excluded them and inject fell back to the generic profile blurb).
      // Trade-off accepted: this widens what can travel to a third-party AI
      // from vault-eligible only to any above-floor match. The relevance floor
      // (INJECT_REL_FLOOR) still gates noise; the profile fallback still covers
      // "tell me about myself". Matches the 🧠 button, which already uses 'all'.
      fetchCandidates(seed, 'all', (resp) => {
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
        const mech = forceComposer ? 'composer' : INJECT_SITES[site].mechanism;
        if (mech === 'network') {
          const built = fencedBlock(resp);
          const block = built.text;
          if (!block) { toast('nothing suitable to inject', false); return; }
          window.postMessage({ source: 'vodou-inject', op: 'arm', block }, '*');
          lastArmed = { facts: built.facts, profileLines: built.profileLines };
          logInjection({
            kind: 'inject', site, mechanism: 'network', status: 'armed', chars: block.length,
            facts: built.facts, profileLines: built.profileLines,
            convId: convRef().convId, at: Date.now(),
          });
        } else {
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
                convId: convRef().convId, at: Date.now(),
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
                convId: convRef().convId, at: Date.now(),
              });
            }
          });
        }
      });
    }

    window.addEventListener('keydown', (e) => {
      try {
        // Ctrl+B         → site default (invisible network on ChatGPT, composer on Claude)
        // Ctrl+Shift+B   → force VISIBLE composer injection on ANY site
        // (physical KeyB; Cmd+B stays the site's bold on macOS.)
        if (!(e.ctrlKey && !e.altKey && !e.metaKey && e.code === 'KeyB')) return;
        const site = injectSiteKey();
        if (!site) return; // unsupported host — leave the hotkey to the page
        // Capture the composer NOW, while focus is still the box the user typed
        // in — before preventDefault/async can shift focus. Used for seed+insert.
        const composer = findComposer();
        e.preventDefault();
        e.stopPropagation();
        runInject(site, !!e.shiftKey, composer);
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
          try { runInject(site, true, findComposer()); }
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
    const AUTOSEND_WATCHDOG_MS = 12000;
    let autoSendPassthrough = false;   // set while WE re-fire the user's send

    function autoSendEnabled(site) {
      return injectSettings.autoSend === true
        && (injectSettings.autoSendSites || {})[site] !== false
        && injectSettings.master !== false
        && (injectSettings.sites || {})[site] !== false;
    }

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
      const watchdog = setTimeout(() => {
        // Something never reported. Send what the user actually typed rather than
        // leaving them staring at a composer that swallowed their message.
        try { toast('memory took too long — sending your message as typed', false); } catch (_) {}
        try { resend(); } finally { autoSendPassthrough = false; }
      }, AUTOSEND_WATCHDOG_MS);

      try {
        runInject(site, true, composer, () => {
          clearTimeout(watchdog);
          // A tick, so the site's editor commits the inserted text to its own state
          // before the send reads it. Sending in the same task can read the pre-
          // insert value on React-controlled editors.
          setTimeout(() => {
            try { resend(); } finally { autoSendPassthrough = false; }
          }, 60);
        });
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

    mountFab();
    // SPAs tear their DOM down on navigation; re-mount if the control goes with it.
    // Cheap: mountFab returns immediately when the node is still present.
    setInterval(() => { try { mountFab(); } catch (_) {} }, 3000);

    // Status back-channel from inject.js (network mechanism): disclosure toasts.
    window.addEventListener('message', (ev) => {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || d.source !== 'vodou-inject-status') return;
      if (d.op === 'armed') {
        toast('🧠 context armed — attaches invisibly to your next send', true);
      } else if (d.op === 'injected') {
        toast('🧠 context attached to your message (invisible)', true);
        // Carries the armed block's real counts and `supersedes` so the log ends
        // up with ONE line per injection that advances armed → sent, instead of
        // two half-informative rows.
        logInjection({
          kind: 'inject', site: injectSiteKey(), mechanism: 'network', status: 'injected',
          facts: lastArmed.facts, profileLines: lastArmed.profileLines,
          supersedes: 'armed', how: d.how || '', convId: convRef().convId, at: Date.now(),
        });
      }
    });

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
      if (msg.type === 'vodou_run_inject') {
        const site = injectSiteKey();
        if (!site) { sendResponse({ ok: false, error: 'not a supported site' }); return undefined; }
        runInject(site, !!msg.visible, findComposer());
        sendResponse({ ok: true });
        return undefined;
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
            if (c.startsWith(r.text)) { c = c.slice(r.text.length).replace(/^\s+/, ''); break; }
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
    });

    window.addEventListener('message', (ev) => {
      if (ev.source !== window) return;
      const d = ev.data;
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
