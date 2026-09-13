// Per-site capture tallies for the bridge_health heartbeat.
// PLAN-CAPTURE-GRADED-PER-SITE P1 (PLANS/0.6.31/01-…).
//
// The extension declares 22 capture sites and, until this file, reported only
// "I am alive" every 30 s. On 2026-09-03 one site had captured anything in a
// week, fifteen had last been seen inside one 36-minute canary window, three
// never — and nothing could say which of those were BROKEN and which were
// simply never visited. The two look identical from the gateway: no rows.
//
// This keeps six integers and two short signatures per site, accumulated in the
// service worker between heartbeats and drained onto the next `bridge_health`
// message. No URLs, no titles, no text — a CWS reviewer reads it as counters.
//
//   visited        1 if a tab for the site was the active tab since the last send
//   turns_seen     turns handed to the worker by the page shim (before any persistence)
//   turns_stored   turns the gateway acked as written (capture_ack.stored)
//   miss_unmatched chat-looking requests on the site that NO adapter claimed
//   miss_empty     requests an adapter claimed and parsed to zero turns (not "pending")
//   matched_sig    "<adapter>:<endpoint path>" of the last successful parse, ≤200 chars
//   miss_sig       endpoint path of the last miss, ≤200 chars
//
// Keyed by the sites.js `capture` name — the adapter name, which is what arrives
// as `provider` on a captured turn and what the gateway files rows under
// (`webcap:<capture>:<conv>`). Six sites spell `key` and `capture` differently
// (mistral/lechat, …); grading by `key` would silently mis-file exactly those.
//
// Loaded as a static import from background.js, like sites.js: a module worker
// import cannot fail quietly. Assigns to globalThis so a Node test can run this
// file in a vm context and call the same functions the worker calls.
globalThis.VodouCaptureHeartbeat = (() => {
  const SIG_MAX = 200;
  const sites = Object.create(null);

  function cell(site) {
    const k = String(site || '').trim();
    if (!k) return null;
    if (!sites[k]) {
      sites[k] = {
        visited: 0, turns_seen: 0, turns_stored: 0, turns_dup: 0,
        miss_unmatched: 0, miss_empty: 0,
        matched_sig: '', miss_sig: '',
        disabled: 0,
      };
    }
    return sites[k];
  }

  const count = (n) => Math.max(0, Math.floor(Number(n) || 0));
  const sig = (s) => String(s || '').slice(0, SIG_MAX);

  /** The site's `capture` name for a hostname, from the shared registry; null when unsupported. */
  function siteFor(hostname) {
    const h = String(hostname || '').toLowerCase();
    if (!h) return null;
    for (const s of globalThis.VODOU_SITES || []) {
      try { if (s && s.host && s.host.test(h)) return s.capture || s.key || null; } catch (_) { /* bad regex — skip */ }
    }
    return null;
  }

  function noteVisited(site) { const c = cell(site); if (c) c.visited = 1; }
  /** Remote policy (capture:false) switched this site off — its own cell, never graded. */
  function noteDisabled(site) { const c = cell(site); if (c) c.disabled = 1; }
  function noteSeen(site, n) { const c = cell(site); if (c) c.turns_seen += count(n); }
  function noteStored(site, n) { const c = cell(site); if (c) c.turns_stored += count(n); }
  /** Turns the gateway already had. A fully-deduped batch is healthy, and without
   *  this the grader reads stored=0 as a dead adapter. */
  function noteDuplicate(site, n) { const c = cell(site); if (c) c.turns_dup += count(n); }
  function noteMatched(site, signature) { const c = cell(site); if (c && signature) c.matched_sig = sig(signature); }
  function noteMiss(site, kind, signature) {
    const c = cell(site);
    if (!c) return;
    if (kind === 'empty') c.miss_empty += 1; else c.miss_unmatched += 1;
    if (signature) c.miss_sig = sig(signature);
  }

  /** Everything accumulated since the last drain, or null when nothing happened. Resets. */
  function drain() {
    const out = {};
    let any = false;
    for (const k of Object.keys(sites)) {
      const c = sites[k];
      if (c.visited || c.turns_seen || c.turns_stored || c.turns_dup || c.miss_unmatched || c.miss_empty || c.disabled) {
        out[k] = c;
        any = true;
      }
      delete sites[k];
    }
    return any ? out : null;
  }

  /** Read-only look, for tests and the panel. Does not reset. */
  function peek() {
    const out = {};
    for (const k of Object.keys(sites)) out[k] = Object.assign({}, sites[k]);
    return out;
  }

  return { siteFor, noteVisited, noteDisabled, noteSeen, noteStored, noteDuplicate, noteMatched, noteMiss, drain, peek };
})();
