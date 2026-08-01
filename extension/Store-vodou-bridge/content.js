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
  mountContextButton(); // PLAN-MEMORY-FOLLOWS-YOU — 🧠 context on ALL hosts
  if (!BUTTON_HOSTS.test(location.hostname)) { mountRelayOnly(); return; }

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
  // A <style> element rather than inline styles: hover/focus states cannot be
  // expressed inline, and !important on the load-bearing properties keeps a stray
  // `button {}` rule in someone else's page from unsticking it.
  //
  // The pill is WHITE because the mark is mostly brand blue on transparent — on a
  // blue pill it disappeared. White also does the job Chad asked for (2026-07-30,
  // "the button should be highlighted more"): against ChatGPT's dark grey it is
  // the highest-contrast thing available, and on Claude's light background the
  // border plus shadow keep it a distinct object rather than a smudge.
  //
  // The label no longer hides on hover. An icon-only disc communicated nothing —
  // to a new user, or to anyone looking at a store screenshot.
  const STYLE_ID = 'vodou-capture-btn-style';
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
#vodou-capture-btn {
  position: fixed !important; bottom: 16px !important; right: 16px !important;
  z-index: 2147483647 !important;
  display: flex !important; align-items: center !important; justify-content: flex-start !important;
  gap: 0 !important;
  height: 40px !important; min-height: 40px !important; width: auto !important;
  padding: 0 8px !important; margin: 0 !important;
  border: 1px solid rgba(0,0,0,.10) !important; border-radius: 999px !important;
  background: #fff !important; color: #111827 !important;
  font: 600 12.5px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
  letter-spacing: .01em !important;
  cursor: pointer !important; opacity: 1 !important;
  box-shadow: 0 4px 14px rgba(0,0,0,.22), 0 1px 3px rgba(0,0,0,.12) !important;
  transition: box-shadow .16s ease, padding .18s ease, gap .18s ease;
}
/* At rest this is a true 40px CIRCLE. The sites we run on set box-sizing:border-box
   globally, so the 1px border sits INSIDE the 40px height — the width therefore has
   to be 8 + 22 + 8 + 2 = 40 to match it. At 9px padding it measured 42x40, i.e. a
   slightly wide oval. Measured in the browser, not assumed. */
#vodou-capture-btn > span {
  max-width: 0; overflow: hidden; white-space: nowrap;
  transition: max-width .18s ease;
}
#vodou-capture-btn:hover, #vodou-capture-btn:focus-visible, #vodou-capture-btn.vodou-busy {
  gap: 8px !important; padding: 0 16px 0 8px !important;
  box-shadow: 0 7px 20px rgba(0,0,0,.28), 0 1px 3px rgba(0,0,0,.14) !important;
}
#vodou-capture-btn:hover > span,
#vodou-capture-btn:focus-visible > span,
#vodou-capture-btn.vodou-busy > span { max-width: 180px; }
#vodou-capture-btn:focus-visible { outline: 2px solid ${VODOU_BLUE}; outline-offset: 2px; }
#vodou-capture-btn[disabled] { cursor: default !important; }
/* Result states recolour the TEXT, not the pill — repainting the background green
   or red would bury the blue mark in it. The vodou-busy class holds the pill open
   so the result is readable without hovering.
   NOTE: no backticks in here — this whole block lives inside a JS template literal,
   and one backtick ends it early. See the guard in sites.test.mjs. */
#vodou-capture-btn.vodou-ok   > span { color: #15803d; }
#vodou-capture-btn.vodou-fail > span { color: #b91c1c; }
@media (prefers-reduced-motion: reduce) {
  #vodou-capture-btn, #vodou-capture-btn > span { transition: none; }
}`;
    (document.head || document.documentElement).appendChild(style);
  }
  const btn = document.createElement('button');
  btn.id = 'vodou-capture-btn';
  btn.type = 'button';
  // “Save what’s here”, not “Save chat” (Chad, 2026-07-30). The gateway extractor reads
  // RENDERED message nodes, and ChatGPT/Claude virtualise long threads — so on a long
  // conversation this reaches what is loaded, not the whole thing. The panel’s
  // history-import button was removed for promising exactly that (2d030982); this one
  // survives by describing what it actually does. The accessible name says it longer.
  btn.setAttribute('aria-label', 'Save the messages loaded on this page to Vodou memory');
  btn.title = 'Save the messages loaded on this page to Vodou memory';
  const btnLabel = document.createElement('span');
  btnLabel.textContent = 'Save what\u2019s here';
  btn.append(vodouMark(22), btnLabel);

  // Only the label span is rewritten — the old flash() set btn.textContent, which
  // would now delete the icon with it.
  function flash(text, good) {
    btnLabel.textContent = text;
    btn.classList.remove('vodou-ok', 'vodou-fail');
    if (good === true) btn.classList.add('vodou-ok');
    else if (good === false) btn.classList.add('vodou-fail');
    btn.classList.add('vodou-busy');   // hold it open — a result nobody can read is not a result
    if (good !== undefined) {
      setTimeout(() => {
        btnLabel.textContent = 'Save what\u2019s here';
        btn.classList.remove('vodou-ok', 'vodou-fail', 'vodou-busy');
        btn.disabled = false;
      }, 3200);
    }
  }

  btn.addEventListener('click', () => {
    btn.disabled = true;
    flash('Saving…');
    try {
      chrome.runtime.sendMessage(
        { type: 'trigger_capture', url: location.href, extract: 'background' },
        (resp) => {
          if (chrome.runtime.lastError) { flash('✗ ' + chrome.runtime.lastError.message.slice(0, 40), false); return; }
          if (resp && resp.ok) {
            const r = resp.result || {};
            flash(`✓ Saved${r.messages != null ? ' (' + r.messages + ' msgs)' : ''}`, true);
          } else {
            flash('✗ ' + ((resp && resp.error) || 'failed').slice(0, 40), false);
          }
        },
      );
    } catch (e) {
      flash('✗ ' + String(e && e.message).slice(0, 40), false);
    }
  });

  const mount = () => { if (document.body && !document.getElementById('vodou-capture-btn')) document.body.appendChild(btn); };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
  // SPA route changes (chatgpt/claude are SPAs) can wipe the body subtree — re-mount.
  setInterval(mount, 3000);

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

    function toast(text, ok) {
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
    // name?" returned this on 2026-07-27:
    //
    //   User's dog is named Lucy; Dr. Patel on Grand River in Fenton, MI is Chad's
    //   sleep apnea doctor — NOT Lucy's vet; the earlier memory record incorrectly
    //   listed Dr. Patel as Lucy's eval vet, which is wrong.; Dr. Patel is Chad's
    //   sleep apnea doctor (NOT Lucy's vet), and his office is located at …;
    //   PHASE2 dog named LucyZZZ
    //
    // The answer is one word and it is buried. Three defects, all repairable here:
    //
    //   1. CORRECTION RECORDS. Notes ABOUT memory ("the earlier record incorrectly
    //      listed…", "not as previously recorded") are maintenance metadata. They
    //      matched because they mention Lucy, and they read to another model as
    //      facts about the user. Internal search may want them; external inject
    //      never does.
    //   2. LEAKED FRONTMATTER. Some chunks carry their YAML header — `name:`,
    //      `metadata: node_type:`, `originSessionId` — straight into the paste.
    //   3. NEAR-DUPLICATES joined with "; " into one unreadable sentence, with the
    //      "…which is wrong.; Dr. Patel…" seam where a period met a semicolon.
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
        // fact — the two Dr. Patel entries were each other's restatement.
        if (seen.some((s) => s === norm || s.includes(norm) || norm.includes(s))) continue;
        seen.push(norm);
        out.push(f.replace(/\s*[;.]\s*$/, ''));
      }
      return out;
    }

    function composerFraming(profile, selected, items, query) {
      const facts = cleanFacts((Array.isArray(selected) && selected.length)
        ? selected.map((t) => String(t || '').replace(/^[-•]\s*/, '').trim()).filter(Boolean)
        : relevantItems(items, 4));
      let body;
      let profileLines = 0;
      if (facts.length) {
        // One fact per line. The semicolon run-on made a three-fact answer read as
        // a single malformed sentence; a pasted block is read by a human first.
        body = facts.length === 1 ? facts[0] + '.' : facts.map((f) => '- ' + f).join('\n');
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
    function runInject(site, forceComposer, composer) {
      if (!injectSettings.master || injectSettings.sites[site] === false) {
        toast('Vodou auto-inject is off — click the Vodou icon and enable it under Settings', false);
        return;
      }
      // `composer` was captured at keypress (focus = the box the user typed in).
      // Reuse it for BOTH the retrieval seed and the insert so an async focus
      // change between them can't split them onto different elements.
      const seed = chatContextQuery(composer);
      if (DIAG()) console.log('[vodou-inject] seed query:', JSON.stringify((seed || '').slice(0, 80)), '| from', elDesc(composer));
      toast('🧠 pulling your context…', true);
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
          if (!text) { toast('nothing suitable to inject', false); return; }
          // Reuse the keypress-captured composer; re-find only if it went away.
          const target = (composer && composer.isConnected) ? composer : findComposer();
          registerStrip(text.trim()); // register regardless of insert path (paste too gets loop-stripped)
          insertTextVerified(target, text, (ok) => {
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
        runInject(site, !!e.shiftKey, composer);
      } catch (_) { /* the hotkey must never break the page */ }
    }, true);

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
