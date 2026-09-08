/**
 * EX-5 — the page-to-extension capture channel had no authentication.
 *
 * `inject.js` runs in the MAIN world (it has to: it tees the page's own network
 * traffic, which an isolated world cannot see) and therefore cannot reach
 * `chrome.runtime`. It hands captured turns to `content.js` by
 * `window.postMessage({ source: 'vodou-netcap', ... })`, and content.js
 * forwarded anything carrying that string straight into memory.
 *
 * The string is not a secret. It is in the shipped source of a public
 * extension. So ANY script co-resident on one of the 35 chat sites — a
 * third-party tag, an injected ad, an XSS on the site — could post one message
 * and write a conversation that never happened into the user's memory. Memory
 * is later injected into other AI chats, so a forged turn is a prompt injection
 * with persistence: it survives the tab, the browser and the site.
 *
 * This mints a per-page nonce in the ISOLATED world and gives it to inject.js,
 * so content.js can tell its own injector from anything else on the page.
 *
 * WHY A SEPARATE FILE AT document_start
 * -------------------------------------
 * content.js runs at `document_idle` — after the page's own scripts. A nonce
 * handed over then is observable by anything that registered a message listener
 * in between, which is every script on the page. The handshake has to complete
 * before page scripts run at all, and only a `document_start` content script
 * does that.
 *
 * Content scripts from one extension share ONE isolated world per frame, so the
 * nonce this file puts on `window` is readable by content.js later and is not
 * reachable from the page.
 *
 * WHAT THIS DOES AND DOES NOT BUY
 * -------------------------------
 * It stops a page-resident script from forging a capture: such a script cannot
 * have run before `document_start`, so it cannot have seen the handshake, and
 * inject.js keeps the value in a closure rather than on `window`.
 *
 * It is NOT a defence against another extension injecting into the MAIN world
 * at document_start, which could observe the same exchange. Nothing available
 * to a MAIN-world script can be: the MAIN world is the page. That is the reason
 * inject.js is kept as small as it is.
 */
(() => {
  'use strict';

  // 128 bits from the CSPRNG. Not a counter, not a timestamp: a predictable
  // value would let a page script produce a valid message without ever having
  // seen one.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

  // The isolated world's own global — shared with content.js, invisible to the
  // page. Frozen so a later bug (or a later content script) cannot swap it for
  // a value the page chose.
  Object.defineProperty(window, '__vodouNetcapNonce', {
    value: nonce,
    writable: false,
    configurable: false,
    enumerable: false,
  });

  const send = () => {
    try {
      window.postMessage({ source: 'vodou-netcap-nonce', nonce }, '*');
    } catch (_) { /* page gone */ }
  };

  // Both orders have to work. This file and inject.js are both document_start
  // and Chrome does not promise which of the two worlds goes first, so: answer
  // a request (inject.js first), and also announce once (this file first).
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (d && d.source === 'vodou-netcap-nonce-request') send();
  });
  send();
})();
