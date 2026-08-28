// The site registry, loaded as a STATIC import.
//
// sites.js assigns to globalThis rather than exporting, so this runs it for the
// side effect — same as the content-script load. It was a lazy
// `await import(chrome.runtime.getURL('sites.js'))` until 2026-08-02 and that
// silently did nothing in the service worker: the registry stayed empty and every
// save answered `no built-in extractor for "web_conversation:<site>"`, which reads
// like the site is unsupported rather than like the loader failed. A static import
// is the documented form for an MV3 module worker and cannot fail quietly — if it
// breaks, the worker does not start at all.
import './sites.js';

// Vodou Bridge — service worker.
//
// Connects to the user's Vodou gateway over a localhost WebSocket and
// services three verbs:
//   - fetch:       fetch(url) from the extension's context (carries cookies)
//   - extract:     open a hidden tab, run a content script, return DOM fragments
//   - act_in_tab:  inject + run a script in a matching tab (consent-gated upstream)
//
// MV3 service workers auto-suspend after ~30s idle. We use chrome.alarms
// to keep the connection alive when there's no other activity — this is
// the only reliable way to maintain a persistent WS in MV3 today.

const DEFAULT_GATEWAY_URLS = [
  'ws://127.0.0.1:8765/api/vbb',
  'ws://localhost:8765/api/vbb',
];
const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const PROTOCOL_VERSION = { min: 1, max: 1 };

let ws = null;
let backoffIdx = 0;
let connectAttemptedAt = 0;
let lastBridgeReadyAt = 0;
let userGatewayUrl = null;
// Gateway-driven liveness (server_heartbeat every 20s, Chrome ≥116 keeps the SW
// alive on inbound WS traffic). If we've seen one on this socket but then hear
// nothing for 75s, the socket is half-dead — force a reconnect.
let lastServerMsgAt = 0;
let serverHeartbeatSeen = false;
// Polite-loser mode: when the gateway rejects us with 1013 ("bridge already
// connected", i.e. another instance of this extension holds the slot), don't
// hammer 1s-backoff reconnects forever. After 3 consecutive rejects, stand by
// for 5 minutes; explicit user actions (toolbar click / panel) override.
// Standby is PERSISTED in chrome.storage.session: MV3 suspension wipes module
// state, and without persistence a suspended loser woke every 30s with a
// fresh (zeroed) standby and resumed the reject storm (observed ~7/min).
let consecutiveRejects = 0;
let rejectStandbyUntil = 0;
// True once setStandby() ran in THIS SW instance — the restore must not clobber
// a fresher in-memory value (e.g. the panel's explicit setStandby(0) on user click).
let standbyTouched = false;
// connect() awaits this before dialing. Without the gate, an alarm-woken SW ran
// connect() while this get() was still in flight (rejectStandbyUntil still 0),
// so the persisted standby never took effect and the reject storm continued at
// the same ~7/min as before persistence existed.
const standbyRestored = (async () => {
  try {
    const { vodou_standby_until } = await chrome.storage.session.get(['vodou_standby_until']);
    if (!standbyTouched && typeof vodou_standby_until === 'number') rejectStandbyUntil = vodou_standby_until;
  } catch (_) { /* session storage unavailable — degrade to module state */ }
})();
function setStandby(untilMs) {
  standbyTouched = true;
  rejectStandbyUntil = untilMs;
  try { chrome.storage.session.set({ vodou_standby_until: untilMs }); } catch (_) { /* ignore */ }
}
// User-toggleable enable flag. When false, we don't auto-connect or reconnect.
// Defaults to true (preserves existing install behavior).
let enabled = true;

// ---------- Storage helpers ----------
async function getStoredGatewayUrl() {
  try {
    const { vodou_gateway_url } = await chrome.storage.local.get(['vodou_gateway_url']);
    return vodou_gateway_url || null;
  } catch { return null; }
}
async function setStoredGatewayUrl(url) {
  try { await chrome.storage.local.set({ vodou_gateway_url: url }); } catch {}
}
async function getStoredEnabled() {
  try {
    const { vodou_enabled } = await chrome.storage.local.get(['vodou_enabled']);
    return vodou_enabled !== false; // default true
  } catch { return true; }
}
async function setStoredEnabled(v) {
  try { await chrome.storage.local.set({ vodou_enabled: !!v }); } catch {}
}
(async () => { enabled = await getStoredEnabled(); })();

// ---------- Pairing (PLAN-MEMORY-EVERYWHERE-FRONTEND P4) ----------
// Optional shared pair code shown on the gateway's Sources card. Sent with
// bridge_ready; when the gateway enforces pairing (VODOU_VBB_REQUIRE_TOKEN /
// bridge_require_token) a mismatch closes the socket with code 4403 and the
// panel shows the pair prompt. Off by default — unpaired setups keep working.
let pairingRequired = false;

// Port of the brain mini console, learned from the gateway's `server_info`
// frame (it owns BRAIN_PORT; we can't derive it). Persisted so the panel still
// has it after an MV3 service-worker restart, before the next handshake.
let brainPort = null;
// True when THIS connection passed gateway-ENFORCED pairing (server_info.paired).
// Stays false when pairing is optional — connected-but-unpaired is the normal
// open state, and the panel must not claim "paired" for a check nobody ran.
let sessionPaired = false;
async function getStoredBrainPort() {
  if (brainPort) return brainPort;
  try {
    const { vodou_brain_port } = await chrome.storage.local.get(['vodou_brain_port']);
    brainPort = vodou_brain_port || null;
  } catch { /* ignore */ }
  return brainPort;
}
function setBrainPort(port) {
  const p = parseInt(port, 10);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return;
  brainPort = p;
  try { chrome.storage.local.set({ vodou_brain_port: p }); } catch { /* ignore */ }
}

async function getStoredPairCode() {
  try {
    const { vodou_bridge_token } = await chrome.storage.local.get(['vodou_bridge_token']);
    return vodou_bridge_token || null;
  } catch { return null; }
}
async function setStoredPairCode(code) {
  try { await chrome.storage.local.set({ vodou_bridge_token: code || '' }); } catch {}
}

// ---------- WebSocket connect ----------
async function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  if (!enabled) return; // user disabled the bridge from the panel
  await standbyRestored; // don't dial before the persisted slot-fight standby is loaded
  if (Date.now() < rejectStandbyUntil) return;
  if (!userGatewayUrl) userGatewayUrl = await getStoredGatewayUrl();
  const candidates = userGatewayUrl ? [userGatewayUrl] : DEFAULT_GATEWAY_URLS;
  const url = candidates[connectAttemptedAt % candidates.length];
  connectAttemptedAt++;
  let sock;
  try {
    sock = new WebSocket(url);
  } catch (err) {
    console.warn('[vbb] WebSocket construct failed:', err);
    scheduleReconnect();
    return;
  }
  ws = sock;

  // Closures capture `sock` (the socket this connect() call created) so a
  // stale handshake can't try to send on a newer still-CONNECTING socket if
  // the user toggled Disconnect/Connect or changed the gateway URL.
  sock.addEventListener('open', async () => {
    if (sock.readyState !== WebSocket.OPEN) return;
    // Fetch the pair code BEFORE the send commits. Doing it inline as
    // `token: await getStoredPairCode()` yields to the event loop between the
    // readyState guard above and the actual send — long enough for the gateway
    // to close this socket (a slot-fight loser gets 1013'd), so send() then
    // throws "WebSocket is already in CLOSING or CLOSED state". Re-check after.
    const token = await getStoredPairCode();
    if (sock.readyState !== WebSocket.OPEN) return; // closed during the await — abort quietly
    console.log('[vbb] connected to', url);
    backoffIdx = 0;
    lastBridgeReadyAt = Date.now();
    lastServerMsgAt = Date.now();
    serverHeartbeatSeen = false;
    sessionPaired = false; // re-learned from this socket's server_info
    try {
      sock.send(JSON.stringify({
        cmd: 'bridge_ready',
        version: chrome.runtime.getManifest().version,
        protocol: PROTOCOL_VERSION,
        browser_info: { ua: navigator.userAgent, vendor: navigator.vendor },
        token,
      }));
    } catch (err) {
      console.warn('[vbb] bridge_ready send failed:', err);
    }
    // Seed the active-tab cache right after handshake so the router has
    // context on the very first prompt after reconnect.
    sendActiveTab();
  });

  sock.addEventListener('message', async (evt) => {
    // Any inbound gateway message means pairing (if enforced) was accepted,
    // the slot fight (if any) is won, and the socket is demonstrably alive.
    pairingRequired = false;
    consecutiveRejects = 0;
    if (rejectStandbyUntil) setStandby(0);
    lastServerMsgAt = Date.now();
    let msg = null;
    try { msg = JSON.parse(evt.data); } catch { return; }
    if (!msg || !msg.cmd) return;
    if (msg.cmd === 'server_heartbeat') {
      // Reply so the gateway's lastMessageAt stays fresh; receiving this frame
      // already reset our MV3 idle timer (Chrome ≥116).
      serverHeartbeatSeen = true;
      sendOn(sock, { cmd: 'bridge_health', uptime_ms: Date.now() - lastBridgeReadyAt });
      return;
    }
    // Sibling local UIs the gateway knows about (sent right after bridge_ready).
    if (msg.cmd === 'server_info') { setBrainPort(msg.brain_port); sessionPaired = msg.paired === true; return; }
    // Auto-capture landed: the gateway confirms how many turns it actually
    // persisted. We log THIS, not the fire-and-forget send, so the count in the
    // panel is what's in memory rather than what we hoped.
    if (msg.cmd === 'capture_ack') {
      logActivity({
        kind: 'capture',
        mode: 'auto',
        provider: msg.provider || 'web',
        convId: msg.conversationId || '',
        messages: Number(msg.stored) || 0,
        ok: true,
      });
      return;
    }
    // Result of an extension-initiated capture_request (in-page button).
    if (msg.cmd === 'capture_result') { resolveCapture(msg); return; }
    if (msg.cmd === 'context_result') { resolveContext(msg); return; }
    handleCmd(msg);
  });

  sock.addEventListener('close', (evt) => {
    console.log('[vbb] disconnected', evt?.code || '');
    if (evt && evt.code === 4403) {
      // Gateway enforces pairing and our code didn't match — stop hammering
      // reconnects; the panel shows the pair prompt and reconnects on save.
      pairingRequired = true;
      if (ws === sock) ws = null;
      return;
    }
    if (evt && evt.code === 1013) {
      // Another install of this extension holds the gateway's single bridge
      // slot. Retrying at 1s backoff forever produced a 15k-connect log storm;
      // after 3 straight rejects, stand by and let the winner keep the slot.
      consecutiveRejects++;
      if (consecutiveRejects >= 3) {
        setStandby(Date.now() + 5 * 60_000);
        console.warn('[vbb] slot held by another bridge instance — standing by 5 min');
      }
    }
    // Only null out the module-level ref if this socket is still the active one.
    if (ws === sock) ws = null;
    scheduleReconnect();
  });

  sock.addEventListener('error', () => {
    // Errors fire alongside close — the close handler does the reconnect work.
  });
}

function scheduleReconnect() {
  if (!enabled) return;
  if (Date.now() < rejectStandbyUntil) return; // losing a slot fight — wait it out
  const delay = RECONNECT_BACKOFF_MS[Math.min(backoffIdx, RECONNECT_BACKOFF_MS.length - 1)];
  backoffIdx++;
  setTimeout(() => connect().catch(() => {}), delay);
}

// ---------- Active-tab change push (PLAN-ROUTER-LLM Phase 4) ----------
// Push `tab_changed` to the gateway when the user switches to, or finishes
// loading, one of the AI chat sites this extension operates on. The gateway
// caches URL+title and the daemon-side router uses it as context for prompts
// like "summarize this".
//
// SCOPED TO SUPPORTED HOSTS (2026-07-30). This used to fire for EVERY https page,
// filtered only by scheme — so the URL and title of every site the user visited
// went to the gateway. Localhost-only made it defensible, but it made three
// documents false at once: the `tabs` permission justification ("does not inspect
// tabs outside the supported sites"), the store listing's "Web history: No"
// certification, and the privacy policy, which never mentioned it. Narrowing the
// code was the smaller change and the honest one.
//
// The host list is READ FROM THE MANIFEST rather than restated here. A second
// hand-maintained copy is the drift bug sites.js exists to prevent — and
// STORE_HOST_SUFFIXES above has already drifted from host_permissions once.
let supportedHostMatchers = null;
function supportedHosts() {
  if (supportedHostMatchers) return supportedHostMatchers;
  const out = [];
  try {
    for (const cs of chrome.runtime.getManifest().content_scripts || []) {
      for (const m of cs.matches || []) {
        const host = /^https?:\/\/([^/]+)/.exec(m);
        if (host) out.push(host[1].toLowerCase());
      }
    }
  } catch (_) { /* manifest unavailable — matcher stays empty, nothing is sent */ }
  supportedHostMatchers = [...new Set(out)];
  return supportedHostMatchers;
}

/** True only for hosts this extension declares a content script on. */
function isSupportedTabHost(hostname) {
  if (!hostname) return false;
  const h = String(hostname).toLowerCase();
  return supportedHosts().some((p) => (p.startsWith('*.')
    ? (h === p.slice(2) || h.endsWith(p.slice(1)))   // "*.manus.im" -> manus.im | x.manus.im
    : h === p));
}

function sendActiveTab() {
  // The readyState check lives INSIDE the callback, not before the query.
  // chrome.tabs.query is async, so a check out here is stale by the time the
  // send runs — and this fires on every tab switch and every page load, which
  // made it by far the likeliest send to land on a socket that closed in the
  // gap. That is the "already in CLOSING or CLOSED state" console warning, and
  // no try/catch can swallow it (see sendOn). Re-read `ws` in the callback too:
  // a reconnect may have replaced the socket entirely.
  if (!ws || ws.readyState !== WebSocket.OPEN) return; // cheap early out
  try {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const t = tabs && tabs[0];
      if (!t || !t.url) return;
      // Skip chrome://, about:, file:, and other non-web schemes — they're
      // not useful for routing and could leak local file paths.
      if (!/^https?:\/\//.test(t.url)) return;
      // …and skip everything that is not one of our declared AI chat hosts.
      let host = '';
      try { host = new URL(t.url).hostname; } catch (_) { return; }
      if (!isSupportedTabHost(host)) return;
      sendOn(ws, { event: 'tab_changed', url: t.url, title: t.title || null });
    });
  } catch { /* ignore */ }
}
chrome.tabs.onActivated.addListener(() => sendActiveTab());
chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
  // Only fire when the URL changed or the page finished loading.
  if (!tab?.active) return;
  if (info.url || info.status === 'complete') sendActiveTab();
});

// ---------- Heartbeat ----------
// MV3 service workers auto-suspend after ~30s idle. chrome.alarms is the
// only reliable wake mechanism; the minimum allowed period is 30s (anything
// shorter gets clamped to 30s for unpacked extensions, 60s for packed).
// We set 30s and also re-fire from chrome.runtime.onStartup so a Chrome
// restart immediately attempts to reconnect.
chrome.alarms.create('vbb-heartbeat', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'vbb-heartbeat') return;
  if (!enabled) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if (Date.now() < rejectStandbyUntil) return; // standing by after 1013 rejects
    // Reset backoff so a long-idle SW that just woke up reconnects
    // immediately rather than waiting out a stale exponential delay.
    backoffIdx = 0;
    connect().catch(() => {});
    return;
  }
  // Half-dead detection: this gateway streams server_heartbeat every 20s. If
  // we've seen one on this socket but nothing at all for 75s, the socket is a
  // zombie (readyState still OPEN) — tear it down and reconnect. Gated on
  // serverHeartbeatSeen so older gateways that never push are unaffected.
  if (serverHeartbeatSeen && Date.now() - lastServerMsgAt > 75_000) {
    console.warn('[vbb] no gateway traffic for 75s — forcing reconnect');
    const dead = ws;
    ws = null;
    try { dead.close(); } catch { /* ignore */ }
    backoffIdx = 0;
    connect().catch(() => {});
    return;
  }
  // flushCaptureQueue() above is async; re-check at the moment of sending.
  sendOn(ws, { cmd: 'bridge_health', uptime_ms: Date.now() - lastBridgeReadyAt });
});

// The toolbar icon opens the memory panel — there is no popup (Chad, 2026-07-30).
// An icon click is a user gesture, and the gesture does not survive an await
// (PLAN-BRIDGE-SIDE-PANEL §5b), so openVodouPanel must be the first call and
// nothing async may precede it. The click still doubles as a reconnect kick —
// covers the "click the icon, nothing happens, click again" pattern.
if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener((tab) => {
    if (tab && tab.id) openVodouPanel(tab.id, 'icon click');
    else console.error('[vodou-panel] icon click with no tab — cannot open the panel');
    if (!enabled) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      backoffIdx = 0;
      setStandby(0); // explicit user action overrides slot-fight standby
      connect().catch(() => {});
    }
  });
}

// Kick off connection on startup + install
async function bootConnect() {
  enabled = await getStoredEnabled();
  if (enabled) connect().catch(() => {});
}
chrome.runtime.onStartup.addListener(() => { bootConnect(); });
chrome.runtime.onInstalled.addListener(() => { bootConnect(); });
bootConnect();

// ---------- W2b: "Send selection to Vodou" context menu (the capture floor) ----------
// PLAN-UNIVERSAL-MEMORY-V2 Phase C W2b. Any selected text on ANY page →
// capture:manual:<host>. Unlike auto-capture (W2a, opt-in flag), this is an
// explicit per-selection user action, so it's always available — the universal
// catch-all for surfaces with no network adapter (Gemini, Perplexity, an
// article, a random page).
function installContextMenu() {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: 'vodou-save-selection',
        title: 'Send selection to Vodou memory',
        contexts: ['selection'],
      });
    });
  } catch (_) { /* contextMenus unavailable — non-fatal */ }
}
chrome.runtime.onInstalled.addListener(installContextMenu);
chrome.runtime.onStartup.addListener(installContextMenu);
installContextMenu();

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'vodou-save-selection') return;
  const text = (info.selectionText || '').trim();
  if (!text) return;
  let host = 'page';
  try { host = new URL(info.pageUrl || tab?.url || '').hostname.replace(/^www\./, '') || 'page'; } catch (_) {}
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({
        cmd: 'capture_turn',
        lane: 'manual',
        provider: host,
        conversationId: 'clip-' + Date.now().toString(36),
        turns: [{ role: 'user', content: text }],
      }));
    } catch (_) { /* socket race — dropped */ }
  }
});

// ---------- Web auto-capture armed flag sync (PLAN-MEMORY-EVERYWHERE-FRONTEND P0) ----------
// The gateway's `capture.web.armed` setting and the panel checkbox stay
// converged: gateway → extension via the `set_capture_armed` command (below);
// extension → gateway via this storage listener when the user flips the panel
// checkbox. `suppressArmedEcho` stops a gateway-initiated write from echoing
// straight back as a `capture_armed_changed`.
let suppressArmedEcho = false;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !('vodou_auto_capture' in changes)) return;
  if (suppressArmedEcho) { suppressArmedEcho = false; return; }
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({
        cmd: 'capture_armed_changed',
        armed: !!changes.vodou_auto_capture.newValue,
      }));
    } catch (_) { /* dropped — gateway re-syncs on next bridge_ready */ }
  }
});

// ---------- Command dispatch ----------
async function handleCmd(msg) {
  const reply = (payload) => safeSend({ id: msg.id, ...payload });
  const replyError = (code, message, detail) => safeSend({ id: msg.id, error: { code, message, detail } });

  try {
    switch (msg.cmd) {
      case 'fetch': return await cmdFetch(msg, reply, replyError);
      case 'extract': return await cmdExtract(msg, reply, replyError);
      case 'act_in_tab': return await cmdActInTab(msg, reply, replyError);
      case 'list_tabs': return await cmdListTabs(msg, reply, replyError);
      case 'cookies_fetch': return await cmdCookiesFetch(msg, reply, replyError);
      case 'cache_get': return await cmdCacheGet(msg, reply, replyError);
      case 'cache_set': return await cmdCacheSet(msg, reply, replyError);
      case 'extract_builtin': return await cmdExtractBuiltin(msg, reply, replyError);
      case 'open_url': return await cmdOpenUrl(msg, reply, replyError);
      case 'set_capture_armed': {
        // PLAN-MEMORY-EVERYWHERE-FRONTEND P0 — gateway (Sources card /
        // gateway_settings) is the source of truth for web auto-capture; mirror
        // it into the local flag that inject.js/the panel consult.
        suppressArmedEcho = true;
        try { await chrome.storage.local.set({ vodou_auto_capture: !!msg.armed }); } catch (_) { /* ignore */ }
        return reply({ result: { armed: !!msg.armed } });
      }
      default:
        return replyError('UNKNOWN_CMD', `unknown command: ${msg.cmd}`);
    }
  } catch (err) {
    replyError('INTERNAL', err?.message || String(err));
  }
}

// THE guard for every outbound frame.
//
// A WebSocket send() on a CLOSING or CLOSED socket does NOT throw — per spec it
// silently discards the data, and Chrome logs "WebSocket is already in CLOSING
// or CLOSED state." straight to the console. So try/catch cannot suppress that
// message; only NOT CALLING send can. (CONNECTING is the state that throws, and
// the catch below is for that.) Every send must therefore re-check readyState at
// the moment of sending — a check separated from its send by an await or a
// callback is not a check at all.
function sendOn(sock, obj) {
  if (!sock || sock.readyState !== WebSocket.OPEN) return false;
  try { sock.send(JSON.stringify(obj)); return true; } catch { return false; }
}

function safeSend(obj) {
  return sendOn(ws, obj);
}

// ---------- fetch ----------
async function cmdFetch(msg, reply, replyError) {
  const { url, opts = {} } = msg;
  if (!url) return replyError('VALIDATION_FAILED', 'url required');
  try {
    const init = {
      method: opts.method || 'GET',
      headers: opts.headers || undefined,
      body: opts.body || undefined,
      credentials: 'include',
    };
    const res = await fetch(url, init);
    const body = await res.text();
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    reply({ body, status: res.status, headers });
  } catch (err) {
    replyError('FETCH_FAILED', err?.message || 'fetch failed');
  }
}

// ---------- extract ----------
async function cmdExtract(msg, reply, replyError) {
  const { url, selector, opts = {} } = msg;
  if (!url || !selector) return replyError('VALIDATION_FAILED', 'url + selector required');
  const timeoutMs = opts.timeout_ms || 15000;
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    await waitForTabComplete(tab.id, timeoutMs);
    const [{ result } = { result: [] }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractFromDom,
      args: [selector],
    });
    reply({ matches: result || [] });
  } catch (err) {
    replyError('EXTRACTION_FAILED', err?.message || 'extract failed');
  } finally {
    if (tab && tab.id) {
      try { await chrome.tabs.remove(tab.id); } catch { /* ignore */ }
    }
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`tab ${tabId} did not load within ${timeoutMs}ms`));
    }, timeoutMs);
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        // Give the page a moment to finish any client-side rendering
        setTimeout(resolve, 250);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Injected into the page — must be self-contained, no closures.
function extractFromDom(selector) {
  const nodes = Array.from(document.querySelectorAll(selector));
  return nodes.slice(0, 50).map(el => {
    const attrs = {};
    for (const a of el.attributes) attrs[a.name] = a.value;
    return {
      outerHTML: el.outerHTML.slice(0, 8192),
      text: (el.textContent || '').slice(0, 4096),
      attrs,
    };
  });
}

// ---------- act_in_tab ----------
async function cmdActInTab(msg, reply, replyError) {
  const { urlPattern, script, args = [] } = msg;
  if (!urlPattern || !script) return replyError('VALIDATION_FAILED', 'urlPattern + script required');
  try {
    // Find a matching tab the user already has open. Prefer the focused tab.
    const tabs = await chrome.tabs.query({ url: urlPatternToMatchUrl(urlPattern) });
    const tab = tabs.find(t => t.active) || tabs[0];
    if (!tab) {
      return replyError('NO_MATCHING_TAB', `no open tab matches ${urlPattern}`);
    }
    const [exec] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: runUserScript,
      args: [script, args],
    });
    reply({ result: exec?.result ?? null });
  } catch (err) {
    replyError('INTERNAL', err?.message || 'act_in_tab failed');
  }
}

// Injected — runs the user-supplied script string as a function.
function runUserScript(scriptSrc, args) {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(...['__args'], `return (${scriptSrc})`);
    return fn(args);
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

function urlPatternToMatchUrl(p) {
  // Glob patterns like "github.com/*/pull/*" → "*://github.com/*/pull/*"
  if (p.startsWith('http')) return p;
  return `*://${p.replace(/\*\*/g, '*')}`;
}

// ---------- list_tabs ----------
async function cmdListTabs(msg, reply, replyError) {
  try {
    const query = msg.urlPattern ? { url: urlPatternToMatchUrl(msg.urlPattern) } : {};
    const tabs = await chrome.tabs.query(query);
    reply({
      tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active })),
    });
  } catch (err) {
    replyError('INTERNAL', err?.message || 'list_tabs failed');
  }
}

// ---------- Capture trigger (in-page button) ----------
// PLAN-UNIVERSAL-MEMORY — a content-script button on chatgpt.com/claude.ai asks
// us to import the current chat. We forward it to the gateway over the
// CSRF-exempt WS as a `capture_request`; the gateway captures + ingests and replies
// with `capture_result`. Keyed by reqId so concurrent triggers don't cross wires.
const pendingCaptures = new Map();
function resolveCapture(msg) {
  const cb = pendingCaptures.get(msg.reqId);
  if (cb) { pendingCaptures.delete(msg.reqId); cb(msg); }
}

// ---------- Activity log (what left, what landed) ----------
// One capped ring buffer covering BOTH directions, because those are the only
// two questions a user has: did my memory reach the AI, and did this chat get
// saved. Two merge rules keep it one-line-per-real-event:
//   • supersedes — a network injection's `injected` confirmation replaces its
//     own `armed` row instead of stacking a second, vaguer one.
//   • auto-capture rollup — a chat saves turn-by-turn; rolling same-conversation
//     saves into one row within the window turns 30 rows of "saved 2 messages"
//     into "saved 46 messages" for the conversation you're actually in.
const ACTIVITY_KEY = 'vodou_activity_log';
// 500, not 200: the panel renders the whole buffer now (the popup's 8-row
// window is gone), so the ring is the real horizon of "did my chat get saved".
// ~100KB worst case against chrome.storage.local's 10MB quota.
const ACTIVITY_MAX = 500;
const MERGE_WINDOW_MS = 15 * 60 * 1000;

function logActivity(entry) {
  if (!entry || typeof entry !== 'object') return;
  const e = Object.assign({ at: Date.now() }, entry);
  try {
    chrome.storage.local.get([ACTIVITY_KEY], (v) => {
      const log = (v && v[ACTIVITY_KEY]) || [];
      const fresh = (row) => row && (e.at - (row.at || 0)) < MERGE_WINDOW_MS;

      if (e.supersedes) {
        const i = log.findIndex((row) => fresh(row)
          && row.kind === 'inject' && row.status === e.supersedes
          && row.convId === e.convId && row.site === e.site);
        if (i !== -1) {
          delete e.supersedes;
          log[i] = Object.assign({}, log[i], e);
          chrome.storage.local.set({ [ACTIVITY_KEY]: log });
          return;
        }
        delete e.supersedes;
      }

      if (e.kind === 'capture' && e.mode === 'auto') {
        const i = log.findIndex((row) => fresh(row)
          && row.kind === 'capture' && row.mode === 'auto'
          && row.convId === e.convId && row.provider === e.provider);
        if (i !== -1) {
          log[i] = Object.assign({}, log[i], e, {
            messages: (log[i].messages || 0) + (e.messages || 0),
          });
          chrome.storage.local.set({ [ACTIVITY_KEY]: log });
          return;
        }
      }

      log.unshift(e);
      while (log.length > ACTIVITY_MAX) log.pop();
      // Retire the inject-only predecessor: its rows carried a "+profile" flag
      // that meant "a profile existed", not "a profile was sent", so replaying
      // them in the new feed would keep telling the old lie.
      chrome.storage.local.set({ [ACTIVITY_KEY]: log });
      chrome.storage.local.remove('vodou_injection_log');
    });
  } catch (_) { /* best-effort */ }
}

// Provider label from a chat URL — the capture path knows the tab, not the site
// key the inject path uses.
function providerFromUrl(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    if (h.includes('chatgpt') || h.includes('openai')) return 'chatgpt';
    if (h.includes('claude')) return 'claude';
    if (h.includes('gemini') || h.includes('aistudio')) return 'gemini';
    return h.split('.')[0] || 'web';
  } catch { return 'web'; }
}

// PLAN-MEMORY-FOLLOWS-YOU — pending context_request callbacks (mirror of captures).
const pendingContexts = new Map();
function resolveContext(msg) {
  const cb = pendingContexts.get(msg.reqId);
  if (cb) { pendingContexts.delete(msg.reqId); cb(msg); }
}

// ---------- Popup-controlled gateway URL ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'trigger_capture') {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      sendResponse({ ok: false, error: 'Vodou Bridge not connected — is Vodou running?' });
      return true;
    }
    const reqId = 'cap_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    // Log what the gateway actually confirmed (message count, or the error) —
    // then hand the same reply on to whoever asked.
    pendingCaptures.set(reqId, (resp) => {
      const r = (resp && resp.result) || {};
      logActivity({
        kind: 'capture',
        mode: 'manual',
        provider: providerFromUrl(msg.url || ''),
        messages: Number(r.messages) || 0,
        title: r.title || '',
        ok: !!(resp && resp.ok),
        error: (resp && resp.ok) ? '' : String((resp && resp.error) || 'capture failed'),
      });
      sendResponse(resp);
    });
    try {
      ws.send(JSON.stringify({
        cmd: 'capture_request',
        reqId,
        url: msg.url || null,
        source: msg.source || null,
        // The sites.js KEY, which selects the web_conversation:<key> extractor.
        // Distinct from `source` above, which is the capture/adapter name and
        // becomes the import slug — the two differ on six sites.
        site: msg.site || null,
        extract: msg.extract || 'background',
      }));
    } catch (e) {
      pendingCaptures.delete(reqId);
      sendResponse({ ok: false, error: 'send failed: ' + (e?.message || e) });
      return true;
    }
    // Safety timeout so the caller never hangs.
    setTimeout(() => {
      if (pendingCaptures.has(reqId)) {
        pendingCaptures.get(reqId)({ ok: false, error: 'capture timed out' });
        pendingCaptures.delete(reqId);
      }
    }, 60000);
    return true; // async sendResponse
  }
  if (msg?.type === 'get_context') {
    // PLAN-MEMORY-FOLLOWS-YOU — content.js 🧠 button asks for a vault-scoped
    // context block; gateway answers via `mem context` (portable vault only).
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      sendResponse({ ok: false, error: 'Vodou Bridge not connected — is Vodou running?' });
      return true;
    }
    const reqId = 'ctx_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    pendingContexts.set(reqId, sendResponse);
    try {
      ws.send(JSON.stringify({
        cmd: 'context_request',
        reqId,
        query: msg.query || '',
        host: msg.host || '',
        all_memory: !!msg.all_memory,
        vault: msg.vault || '',
        conv_id: msg.conv_id || '',
        provider: msg.provider || '',
      }));
    } catch (e) {
      pendingContexts.delete(reqId);
      sendResponse({ ok: false, error: 'send failed: ' + (e?.message || e) });
      return true;
    }
    setTimeout(() => {
      if (pendingContexts.has(reqId)) {
        pendingContexts.get(reqId)({ ok: false, error: 'context request timed out' });
        pendingContexts.delete(reqId);
      }
    }, 25000);
    return true; // async sendResponse
  }
  if (msg?.type === 'inject_log') {
    logActivity(msg.entry || {});
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === 'net_capture') {
    // PLAN-UNIVERSAL-MEMORY-V2 Phase C (W2a) — fire-and-forget relay of a
    // network-intercepted turn to the gateway (capture_turn). No reply: the
    // page shim doesn't wait, and a dropped turn is re-sent on the next message.
    if (ws && ws.readyState === WebSocket.OPEN && Array.isArray(msg.turns) && msg.turns.length) {
      try {
        ws.send(JSON.stringify({
          cmd: 'capture_turn',
          provider: msg.provider || 'web',
          conversationId: msg.conversationId || 'session',
          turns: msg.turns,
        }));
      } catch (_) { /* socket race — dropped */ }
    }
    return false; // no async response
  }
  if (msg?.type === 'get_status') {
    getStoredBrainPort().then((port) => {
      sendResponse({
        connected: !!ws && ws.readyState === WebSocket.OPEN,
        paired: !!ws && ws.readyState === WebSocket.OPEN && sessionPaired,
        enabled,
        gateway_url: userGatewayUrl || DEFAULT_GATEWAY_URLS[0],
        protocol: PROTOCOL_VERSION,
        pairing_required: pairingRequired,
        // Null until the gateway's server_info lands; the panel falls back to 8767.
        brain_port: port || null,
        // True while backing off after 1013 rejects (another install holds the slot).
        slot_standby: Date.now() < rejectStandbyUntil,
      });
    });
    return true; // async sendResponse
  }
  if (msg?.type === 'set_pair_code') {
    setStoredPairCode(String(msg.code || '').trim()).then(() => {
      pairingRequired = false;
      if (ws) try { ws.close(); } catch {}
      ws = null;
      backoffIdx = 0;
      setStandby(0);
      if (enabled) connect().catch(() => {});
      sendResponse({ ok: true });
    });
    return true; // async sendResponse
  }
  if (msg?.type === 'set_gateway_url') {
    userGatewayUrl = msg.url || null;
    setStoredGatewayUrl(userGatewayUrl);
    if (ws) try { ws.close(); } catch {}
    setStandby(0);
    if (enabled) connect().catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === 'set_enabled') {
    enabled = !!msg.enabled;
    setStoredEnabled(enabled);
    if (enabled) {
      backoffIdx = 0;
      setStandby(0);
      connect().catch(() => {});
    } else {
      if (ws) try { ws.close(); } catch {}
      ws = null;
    }
    sendResponse({ ok: true, enabled });
    return true;
  }
});

// ---------- cookies_fetch (PLAN-ROUTER/Lens: tabless server-rendered fetch) ----------
// Read cookies for the URL's domain via chrome.cookies, build a Cookie header,
// fetch() with credentials, return body+status. NO tab is opened. Works for
// any server-rendered site (GitHub HTML, LinkedIn public, news sites, etc.).
// Won't work for SPA shells (Gmail, X) — those return JS-only shells.
async function cmdCookiesFetch(msg, reply, replyError) {
  const url = msg.url;
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    return replyError('VALIDATION_FAILED', 'url must be http(s)://');
  }
  const init = msg.init || {};
  try {
    const u = new URL(url);
    const cookies = await chrome.cookies.getAll({ domain: u.hostname });
    // Some cookies have leading dot domain — chrome.cookies returns matches
    // both for the bare host and any parent. Filter to those that apply to this URL.
    const applicable = cookies.filter((c) => {
      if (c.secure && u.protocol !== 'https:') return false;
      if (!u.pathname.startsWith(c.path)) return false;
      return true;
    });
    const cookieHeader = applicable.map((c) => `${c.name}=${c.value}`).join('; ');
    const headers = { ...(init.headers || {}) };
    if (cookieHeader) headers['Cookie'] = cookieHeader;
    // Spoof a real browser UA if caller didn't pin one — many sites reject default fetch UA.
    if (!headers['User-Agent'] && !headers['user-agent']) {
      headers['User-Agent'] = navigator.userAgent;
    }
    const res = await fetch(url, {
      method: init.method || 'GET',
      headers,
      body: init.body,
      credentials: 'include',
      redirect: init.redirect || 'follow',
    });
    const body = await res.text();
    const respHeaders = {};
    res.headers.forEach((v, k) => (respHeaders[k] = v));
    reply({
      status: res.status,
      body,
      headers: respHeaders,
      url: res.url,
      cookies_sent: applicable.length,
    });
  } catch (err) {
    replyError('FETCH_FAILED', err?.message || String(err));
  }
}

// ---------- cache_get / cache_set (observe() snapshot store) ----------
// Per-domain extension-storage bucket. Lenses use this to opportunistically
// cache state from the user's active sessions so reads don't need a tab.
// Format: `{ "vodou_lens_cache": { "<key>": { value, updated_at } } }`.
async function cmdCacheGet(msg, reply, replyError) {
  const key = msg.key;
  if (typeof key !== 'string' || !key) {
    return replyError('VALIDATION_FAILED', 'key required');
  }
  try {
    const { vodou_lens_cache } = await chrome.storage.local.get(['vodou_lens_cache']);
    const entry = (vodou_lens_cache || {})[key] || null;
    reply({ entry });
  } catch (err) {
    replyError('CACHE_GET_FAILED', err?.message || String(err));
  }
}
async function cmdCacheSet(msg, reply, replyError) {
  const key = msg.key;
  if (typeof key !== 'string' || !key) {
    return replyError('VALIDATION_FAILED', 'key required');
  }
  try {
    const { vodou_lens_cache } = await chrome.storage.local.get(['vodou_lens_cache']);
    const cache = vodou_lens_cache || {};
    cache[key] = { value: msg.value, updated_at: Date.now() };
    await chrome.storage.local.set({ vodou_lens_cache: cache });
    reply({ ok: true });
  } catch (err) {
    replyError('CACHE_SET_FAILED', err?.message || String(err));
  }
}

// ---------- Built-in extractors (CSP-safe page injections) ----------
//
// Some target sites (Gmail, X, banks) ship strict Content Security Policy
// headers that forbid `unsafe-eval` even in the extension's isolated world.
// That breaks the `act_in_tab` path because it relies on `new Function(src)`
// to invoke a lens-supplied script string. The CSP-safe alternative is
// `chrome.scripting.executeScript({func: <real function>})` — Chrome
// uses a privileged injection mechanism that doesn't trigger CSP eval rules.
//
// Trade-off: extractors must be defined here at extension build time, not
// shipped from the lens. Community lenses that need CSP-strict sites (Gmail,
// X, etc.) call `extract_builtin` with a known id; this file is the registry.

function extractor_gmailUnread() {
  // Runs in Gmail's page context (isolated world). Returns a plain object
  // that Chrome serializes back. Never uses eval / new Function.
  //
  // Extraction strategy for the modern Gmail inbox table:
  //   - Each row's accessible label (aria-label) is the canonical structured
  //     summary: "state, sender, [recipient], subject, time, snippet".
  //   - Sender is also exposed cleanly on `span[email]` / `span[name]`.
  //   - Avatars/badges occasionally insert extra comma-separated tokens —
  //     we detect time via regex and use it as a fixed anchor to slice
  //     subject before / snippet after.
  try {
    const dbg = {
      url: location.href,
      ready: document.readyState,
      title: document.title,
      variants: [],
    };
    const main = document.querySelector('div[role="main"]');
    dbg.has_role_main = !!main;
    const scopes = [main || document.body];
    function tryQ(q, label) {
      for (let s = 0; s < scopes.length; s++) {
        try {
          const r = scopes[s].querySelectorAll(q);
          dbg.variants.push(label + ':' + r.length);
          if (r.length > 0) return Array.from(r);
        } catch (_) { dbg.variants.push(label + ':err'); }
      }
      return [];
    }
    let rows = tryQ('tr[role="row"]', 'tr-role-row');
    if (rows.length === 0) rows = tryQ('[role="row"]', 'any-role-row');
    if (rows.length === 0) rows = tryQ('div[gh="tl"] [role="row"]', 'gh-tl-row');
    if (rows.length === 0) rows = tryQ('table.F.cf.zt tr', 'classic-tbl');
    if (rows.length === 0) rows = tryQ('li[role="listitem"]', 'listitem');
    dbg.row_count = rows.length;
    if (rows.length === 0) {
      if (main) {
        dbg.main_first_child_tag = main.firstElementChild ? main.firstElementChild.tagName : null;
        dbg.main_preview = (main.innerText || '').slice(0, 200);
      }
      return { count: 0, messages: [], diagnostic: dbg };
    }

    function isUnread(row) {
      try {
        if (/\bzE\b/.test(row.className || '')) return true;
        const els = row.querySelectorAll('span, div, b, strong');
        for (let i = 0; i < Math.min(els.length, 8); i++) {
          try {
            const w = getComputedStyle(els[i]).fontWeight;
            if (parseInt(w, 10) >= 600) return true;
            if (w === 'bold' || w === 'bolder') return true;
          } catch (_) { /* skip */ }
        }
      } catch (_) {}
      return false;
    }

    const unread = rows.filter(isUnread);
    dbg.unread_count = unread.length;
    const target = unread.length > 0 ? unread : rows.slice(0, 10);

    function cleanText(s) {
      return (s || '')
        // Strip Gmail's invisible padding chars (zero-width / soft-hyphen
        // family) that pad short snippets to fill column width.
        .replace(/[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁩　﻿]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function extractRow(row) {
      // Sender via the explicit attribute first.
      let sender = '';
      try {
        const e = row.querySelector('span[email], span[name]');
        if (e) {
          sender = e.getAttribute('email') || e.getAttribute('name') ||
            (e.textContent && e.textContent.trim()) || '';
        }
      } catch (_) {}

      // The row's accessible label (aria-label) is the canonical structured
      // summary Gmail computes for screen readers — sender, subject, time,
      // snippet, all in one string separated by ", ".
      let aria = '';
      try {
        aria = row.getAttribute('aria-label') || '';
        if (!aria) {
          // aria-labelledby chain — concatenate referenced text content.
          const ids = (row.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
          if (ids.length) {
            aria = ids.map(function (id) {
              const el = document.getElementById(id);
              return el ? (el.textContent || '') : '';
            }).filter(Boolean).join(', ');
          }
        }
      } catch (_) {}

      let subject = '', snippet = '', time = '';
      if (aria) {
        // Find the time token (e.g. "9:44 PM", "May 13", "Tue 8:21 AM").
        // Everything before it (after sender) is subject; everything after
        // is the snippet.
        const timeRe = /\b(\d{1,2}:\d{2}\s*(?:AM|PM)?|[A-Z][a-z]{2}\s+\d{1,2}|[A-Z][a-z]{2}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)\b/;
        const m = aria.match(timeRe);
        if (m) time = m[0];
        const cleaned = cleanText(aria);
        // Strip leading "Unread, " state token if present.
        const noState = cleaned.replace(/^(Unread|Read|Starred|Important|Snoozed)\s*,\s*/i, '');
        // If we have time, split aria around it.
        if (time) {
          const idx = noState.lastIndexOf(time);
          if (idx > 0) {
            const before = noState.slice(0, idx).replace(/\s*,\s*$/, '').trim();
            const after = noState.slice(idx + time.length).replace(/^\s*,\s*/, '').trim();
            // `before` = "sender_label, [recipient,] subject"
            // `after`  = "snippet"
            const parts = before.split(/\s*,\s*/);
            // Last comma-separated chunk = subject; everything else = sender or recipient noise.
            if (parts.length >= 1) subject = parts[parts.length - 1];
            snippet = after;
            // If we didn't get a sender from span[email], use the first part.
            if (!sender && parts.length >= 2) sender = parts[0];
          }
        }
        // Fallback if time-anchored slicing failed.
        if (!subject) {
          const parts = noState.split(/\s*,\s*/);
          if (parts.length >= 2) {
            if (!sender) sender = parts[0];
            subject = parts.slice(1, Math.min(parts.length, 3)).join(', ');
            snippet = parts.slice(3).join(', ');
          } else {
            subject = noState;
          }
        }
      }

      // Final fallback if aria parsing yielded nothing usable.
      if (!subject) {
        try {
          const subjEl = row.querySelector('.bog, .y6 span, [data-thread-id] [role="link"] > span');
          subject = subjEl ? cleanText(subjEl.textContent) : '';
        } catch (_) {}
      }
      if (!sender) sender = '(unknown)';
      if (!subject) subject = '(no subject)';
      subject = cleanText(subject).slice(0, 160);
      snippet = cleanText(snippet).slice(0, 180);
      // If the aria didn't carry a usable date, try the title attr on the time cell.
      if (!time) {
        try {
          const t = row.querySelector('span[title*=":"], td[role="gridcell"] [title*=":"]');
          if (t) time = t.getAttribute('title') || t.textContent || '';
          time = cleanText(time);
        } catch (_) {}
      }

      // Thread URL — make rows clickable to open the email in Gmail.
      // Tries every signal we can find. Defensive against null returns.
      let thread_url = '';
      try {
        // Helper: safely read an attribute from an element-or-null.
        function attr(el, name) {
          return el && el.getAttribute ? (el.getAttribute(name) || '') : '';
        }
        // Source 1: data-legacy-thread-id (modern Gmail puts this on the row).
        let threadId =
          attr(row, 'data-legacy-thread-id') ||
          attr(row.querySelector('[data-legacy-thread-id]'), 'data-legacy-thread-id') ||
          attr(row, 'data-thread-id') ||
          attr(row.querySelector('[data-thread-id]'), 'data-thread-id') ||
          '';
        if (threadId) {
          const cleanId = String(threadId).replace(/^#?thread-[fa]:?/i, '');
          const acctMatch = location.pathname.match(/\/mail\/u\/(\d+)/);
          const acct = acctMatch ? acctMatch[1] : '0';
          thread_url = location.origin + '/mail/u/' + acct + '/#inbox/' + cleanId;
        }
        // Source 2: an anchor inside the row that already points at a thread.
        if (!thread_url) {
          const a = row.querySelector('a[href*="#inbox/"], a[href*="#all/"], a[href*="#search/"]');
          if (a) {
            const href = a.getAttribute('href') || '';
            thread_url = href.startsWith('http') ? href : (location.origin + href);
          }
        }
        // Source 3: parse aria-haspopup'd link target via data-pid / data-tid.
        if (!thread_url) {
          const pid = attr(row, 'data-pid') || attr(row.querySelector('[data-pid]'), 'data-pid');
          if (pid) {
            const acctMatch = location.pathname.match(/\/mail\/u\/(\d+)/);
            const acct = acctMatch ? acctMatch[1] : '0';
            thread_url = location.origin + '/mail/u/' + acct + '/#inbox/' + pid;
          }
        }
      } catch (_) {}

      return {
        sender: sender,
        subject: subject,
        snippet: snippet,
        time: time,
        thread_url: thread_url,
      };
    }

    const messages = [];
    for (let i = 0; i < Math.min(target.length, 10); i++) {
      try { messages.push(extractRow(target[i])); }
      catch (e) {
        dbg.extract_errors = (dbg.extract_errors || []);
        dbg.extract_errors.push(String((e && e.message) || e));
      }
    }
    return { count: messages.length, messages: messages, diagnostic: dbg };
  } catch (e) {
    return { count: 0, messages: [], error: String((e && e.message) || e), diagnostic: { trapped: true } };
  }
}

// ---------- PLAN-UNIVERSAL-MEMORY Phase 4: conversation capture extractors ----------
// These run IN the page (injected via chrome.scripting.executeScript) and return the
// single-conversation shape `vodou-core mem import <src> --stdin-json` accepts:
//   { uuid, title, messages: [ { role: 'user'|'assistant', text, created_at? } ] }
// DOM scrapers are inherently selector-fragile; they're PR-maintained (like every
// built-in here). The PRIMARY ChatGPT path is cookies_fetch internal-API replay
// (content-shape, not selector-shape) — this DOM extractor is only a fallback.

function extractor_claudeConversation() {
  try {
    const uuid = (location.pathname.match(/\/chat\/([0-9a-f-]{8,})/i) || [])[1] || '';
    const title = (document.title || 'Claude chat').replace(/\s*[-|].*Claude.*$/i, '').trim() || 'Captured Claude chat';
    // E9 — per-message timestamp, when the page actually renders one.
    //
    // Most chat UIs render no per-message time at all, so this is best-effort by
    // design: a message with no readable time simply omits `created_at`, and the
    // Rust side falls back to the conversation's own time exactly as before
    // (webchat.rs -> conversation_writer.rs). What it fixes is the case where the
    // time IS in the DOM and we were throwing it away, so a whole saved chat
    // collapsed to a single save-time instant.
    //
    // Read from the ORIGINAL node, never a stripped clone: sites.js strips
    // timestamp nodes as visual noise (see its .text-hint note), so by clone time
    // the evidence is already gone.
    function readTimestamp(el) {
      try {
        const t = el.querySelector && el.querySelector('time[datetime]');
        if (t) {
          const iso = t.getAttribute('datetime');
          if (iso && !isNaN(Date.parse(iso))) return new Date(Date.parse(iso)).toISOString();
        }
        const holder =
          (el.querySelector && el.querySelector('[data-timestamp], [data-time]')) ||
          (el.closest && el.closest('[data-timestamp], [data-time]'));
        if (holder && holder.getAttribute) {
          const raw = holder.getAttribute('data-timestamp') || holder.getAttribute('data-time');
          if (raw) {
            const str = String(raw).trim();
            const n = Number(str);
            let ms;
            if (str !== '' && isFinite(n)) {
              // Purely numeric = epoch. Seconds vs milliseconds: under ~1e11 is
              // seconds. Non-positive is not a capture time.
              ms = n > 0 ? (n < 1e11 ? n * 1000 : n) : NaN;
            } else {
              ms = Date.parse(str);
            }
            // Plausibility floor (2000-01-01). Date.parse('0') is the YEAR 2000
            // and Number('2024') * 1000 is 1970 — both parse "successfully" and
            // would silently backdate a message by decades.
            if (isFinite(ms) && ms > 946684800000) return new Date(ms).toISOString();
          }
        }
      } catch (_) { /* a page that throws on DOM reads must not fail the capture */ }
      return null;
    }

    const messages = [];
    // Layered selectors: prefer explicit test ids, then Claude's message font classes.
    const nodes = document.querySelectorAll(
      '[data-testid="user-message"], [data-testid="assistant-message"], div.font-user-message, div.font-claude-message'
    );
    nodes.forEach((el) => {
      const isUser =
        el.matches('[data-testid="user-message"], .font-user-message') ||
        !!el.closest('[data-testid="user-message"]');
      const text = (el.innerText || el.textContent || '').trim();
      if (text) messages.push({ role: isUser ? 'user' : 'assistant', text, created_at: readTimestamp(el) });
    });
    return { uuid, title, messages, diagnostic: { selector_hits: nodes.length } };
  } catch (e) {
    return { uuid: '', title: 'Captured Claude chat', messages: [], error: String((e && e.message) || e) };
  }
}

function extractor_chatgptConversation() {
  try {
    const uuid = (location.pathname.match(/\/c\/([0-9a-f-]{8,})/i) || [])[1] || '';
    const title = (document.title || 'ChatGPT chat').replace(/\s*[-|].*$/, '').trim() || 'Captured ChatGPT chat';
    // E9 — per-message timestamp, when the page actually renders one.
    //
    // Most chat UIs render no per-message time at all, so this is best-effort by
    // design: a message with no readable time simply omits `created_at`, and the
    // Rust side falls back to the conversation's own time exactly as before
    // (webchat.rs -> conversation_writer.rs). What it fixes is the case where the
    // time IS in the DOM and we were throwing it away, so a whole saved chat
    // collapsed to a single save-time instant.
    //
    // Read from the ORIGINAL node, never a stripped clone: sites.js strips
    // timestamp nodes as visual noise (see its .text-hint note), so by clone time
    // the evidence is already gone.
    function readTimestamp(el) {
      try {
        const t = el.querySelector && el.querySelector('time[datetime]');
        if (t) {
          const iso = t.getAttribute('datetime');
          if (iso && !isNaN(Date.parse(iso))) return new Date(Date.parse(iso)).toISOString();
        }
        const holder =
          (el.querySelector && el.querySelector('[data-timestamp], [data-time]')) ||
          (el.closest && el.closest('[data-timestamp], [data-time]'));
        if (holder && holder.getAttribute) {
          const raw = holder.getAttribute('data-timestamp') || holder.getAttribute('data-time');
          if (raw) {
            const str = String(raw).trim();
            const n = Number(str);
            let ms;
            if (str !== '' && isFinite(n)) {
              // Purely numeric = epoch. Seconds vs milliseconds: under ~1e11 is
              // seconds. Non-positive is not a capture time.
              ms = n > 0 ? (n < 1e11 ? n * 1000 : n) : NaN;
            } else {
              ms = Date.parse(str);
            }
            // Plausibility floor (2000-01-01). Date.parse('0') is the YEAR 2000
            // and Number('2024') * 1000 is 1970 — both parse "successfully" and
            // would silently backdate a message by decades.
            if (isFinite(ms) && ms > 946684800000) return new Date(ms).toISOString();
          }
        }
      } catch (_) { /* a page that throws on DOM reads must not fail the capture */ }
      return null;
    }

    const messages = [];
    // ChatGPT tags each turn with data-message-author-role.
    const nodes = document.querySelectorAll('[data-message-author-role]');
    nodes.forEach((el) => {
      const role = el.getAttribute('data-message-author-role');
      if (role !== 'user' && role !== 'assistant') return;
      const text = (el.innerText || el.textContent || '').trim();
      if (text) messages.push({ role, text, created_at: readTimestamp(el) });
    });
    return { uuid, title, messages, diagnostic: { selector_hits: nodes.length } };
  } catch (e) {
    return { uuid: '', title: 'Captured ChatGPT chat', messages: [], error: String((e && e.message) || e) };
  }
}

// The other 20 sites, from one function.
//
// `extractor_claudeConversation` above is Claude's, hand-written, and it is the
// shape everything else copies: {uuid, title, messages:[{role, text}]}. Rather
// than twenty near-identical copies of it, this takes the one thing that actually
// differs — which nodes are messages, and which of those are the user's — as an
// argument from sites.js.
//
// That split matters for maintenance, not elegance. What breaks a chat extractor
// is a CSS class the site renames on any deploy. A selector set is DATA the
// extension can carry and we can fix in a patch release; twenty parsers would be
// twenty code paths, each needing its own release.
//
// Injected via chrome.scripting.executeScript, so this function is serialized and
// re-parsed in the page: it can close over NOTHING. Every value it needs arrives
// through `args`, and it must not call anything defined in this file.
async function extractor_webConversation(cfg) {
  try {
    // pathname AND search: You.com and OpenRouter both key the conversation on a
    // query parameter (?cid=, ?room=) rather than a path segment, so matching the
    // path alone left every conversation on those sites falling through to the
    // content hash — where two chats opening with the same message would collide.
    // Only the captured GROUP is kept, never the whole query string.
    const uuidRe = cfg.uuid ? new RegExp(cfg.uuid) : /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
    const uuid = ((location.pathname + location.search).match(uuidRe) || [])[1] || '';

    const title = (document.title || '').replace(/\s*[|\-–—]\s*[^|\-–—]*$/, '').trim()
      || (document.title || '').trim()
      || 'Captured chat';

    // ONE query for both roles, so the result is in DOCUMENT ORDER. Querying user
    // and assistant separately and concatenating produces every user turn followed
    // by every assistant turn — which reads as a coherent conversation to a count
    // check and is nonsense to a human or to extraction.
    // Virtualized lists keep only the visible window in the DOM.
    //
    // Measured on DeepSeek (2026-08-01): an EIGHT-message conversation had five
    // messages in the DOM. Scrolling its ds-virtual-list to the top brought all
    // eight back. Without this, better than a third of a short chat is missing —
    // and the failure is invisible, because what does get saved is real text in the
    // right order. It just starts in the middle.
    //
    // Scroll position is restored afterwards: this runs on a page the user is
    // looking at, and yanking them to the top of a long thread is not an acceptable
    // side effect of pressing Save.
    //
    // NOT a complete fix for very long threads, where even the top of the buffer
    // holds a window. That needs incremental scroll-and-collect; this is the cheap
    // 90%, and the button says "Save what's here" for the remaining case.
    let scroller = null;
    let prevScroll = 0;
    if (cfg.scroller) {
      scroller = document.querySelector(cfg.scroller);
      if (scroller) {
        prevScroll = scroller.scrollTop;
        scroller.scrollTop = 0;
        await new Promise((r) => setTimeout(r, cfg.settleMs || 500));
      }
    }

    // Scope the query when a site's turn selector also matches page chrome.
    //
    // HuggingChat marks turns with Tailwind's `group`, which its header uses too —
    // an unscoped query picked up the page title and the account badge
    // ("cpriest73 Get PRO") as if they were messages, so the USER's own username
    // would have been stored as something they said.
    //
    // Falls back to the document rather than returning nothing: a container that
    // stops matching should degrade to the old behaviour, not to silence.
    const root = cfg.container ? (document.querySelector(cfg.container) || document) : document;

    const sel = [cfg.user, cfg.assistant].filter(Boolean).join(',');
    const nodes = sel ? root.querySelectorAll(sel) : [];

    // Screen-reader-only labels sit INSIDE the message node on several sites and
    // land in innerText. Gemini prefixes every user turn with a visually-hidden
    // "You said"; captured verbatim, that becomes part of what Vodou believes the
    // user wrote, on every single turn.
    const STRIP = [
      '.cdk-visually-hidden', '.sr-only', '.visually-hidden', '.screen-reader-only',
      '[aria-hidden="true"]',
    ].concat(cfg.strip || []).join(',');

    // Reading the text needs a clone (so the strip does not touch the user's page)
    // that is nonetheless ATTACHED (so innerText has layout). A detached clone
    // falls back to textContent semantics and silently loses every block boundary:
    // "Noted for the record.\n\nI have registered" came back as
    // "Noted for the record.I have registered". Paragraphs welded together are the
    // kind of damage that passes a count check and reads as gibberish later.
    const box = document.createElement('div');
    box.setAttribute('aria-hidden', 'true');
    box.style.cssText = 'position:fixed;left:-99999px;top:0;width:800px;pointer-events:none;';
    (document.body || document.documentElement).appendChild(box);

    const messages = [];
    let skippedEmpty = 0;

    // Read ONE message node. Returns null for anything with no usable text.
    // E9 — per-message timestamp, when the page actually renders one.
    //
    // Most chat UIs render no per-message time at all, so this is best-effort by
    // design: a message with no readable time simply omits `created_at`, and the
    // Rust side falls back to the conversation's own time exactly as before
    // (webchat.rs -> conversation_writer.rs). What it fixes is the case where the
    // time IS in the DOM and we were throwing it away, so a whole saved chat
    // collapsed to a single save-time instant.
    //
    // Read from the ORIGINAL node, never a stripped clone: sites.js strips
    // timestamp nodes as visual noise (see its .text-hint note), so by clone time
    // the evidence is already gone.
    function readTimestamp(el) {
      try {
        const t = el.querySelector && el.querySelector('time[datetime]');
        if (t) {
          const iso = t.getAttribute('datetime');
          if (iso && !isNaN(Date.parse(iso))) return new Date(Date.parse(iso)).toISOString();
        }
        const holder =
          (el.querySelector && el.querySelector('[data-timestamp], [data-time]')) ||
          (el.closest && el.closest('[data-timestamp], [data-time]'));
        if (holder && holder.getAttribute) {
          const raw = holder.getAttribute('data-timestamp') || holder.getAttribute('data-time');
          if (raw) {
            const str = String(raw).trim();
            const n = Number(str);
            let ms;
            if (str !== '' && isFinite(n)) {
              // Purely numeric = epoch. Seconds vs milliseconds: under ~1e11 is
              // seconds. Non-positive is not a capture time.
              ms = n > 0 ? (n < 1e11 ? n * 1000 : n) : NaN;
            } else {
              ms = Date.parse(str);
            }
            // Plausibility floor (2000-01-01). Date.parse('0') is the YEAR 2000
            // and Number('2024') * 1000 is 1970 — both parse "successfully" and
            // would silently backdate a message by decades.
            if (isFinite(ms) && ms > 946684800000) return new Date(ms).toISOString();
          }
        }
      } catch (_) { /* a page that throws on DOM reads must not fail the capture */ }
      return null;
    }

    function readNode(el) {
        // A node counts as the user's only if it matches the user selector itself or
        // sits inside one. Assistant is everything else in the set — never guessed
        // from position, because a site that renders a system or tool block in the
        // same container would silently shift every subsequent role by one.
        const isUser = !!(cfg.user && (el.matches(cfg.user) || el.closest(cfg.user)));
        const clone = el.cloneNode(true);
        if (STRIP) clone.querySelectorAll(STRIP).forEach((n) => n.remove());
        // Role-scoped strips, for sites where the thing to remove can only be
        // identified STRUCTURALLY and the same structure means something else in the
        // other role. Duck.ai forced this: its model-name header ("Claude Haiku 4.5")
        // is the assistant element's first child and every wrapper class is a build
        // hash, so :first-child is the only handle — and the user message's first
        // child is the message itself. A shared strip would have deleted every user
        // turn's text while looking like it was tidying a header.
        const roleStrip = isUser ? cfg.stripUser : cfg.stripAssistant;
        if (roleStrip) {
          for (const sel of [].concat(roleStrip)) {
            try { clone.querySelectorAll(sel).forEach((n) => n.remove()); } catch (_) { /* bad selector — skip */ }
          }
        }
        box.textContent = '';
        box.appendChild(clone);
        const text = (clone.innerText || clone.textContent || '').trim();
        if (!text) { skippedEmpty++; return null; }
        return { role: isUser ? 'user' : 'assistant', text, key: el.getAttribute('data-message-id') || null, created_at: readTimestamp(el) };
    }

    try {
      if (scroller && cfg.scrollCollect) {
        // Incremental scroll-and-collect, for lists where ONE viewport is not most of
        // the conversation. OpenRouter renders 6 of 14+ turns and its scrollHeight is
        // 8988 against a 690 viewport, so scroll-to-top — which is enough for DeepSeek
        // — recovers one window and leaves the rest as empty placeholders.
        //
        // Walks top to bottom collecting as it goes, because the nodes it needs are
        // destroyed behind it. Keyed by data-message-id where the site provides one,
        // else by role plus a text prefix; insertion order IS conversation order,
        // since each viewport yields its nodes in document order and we only ever
        // move down.
        const seen = new Set();
        const step = Math.max(120, Math.floor(scroller.clientHeight * 0.75));
        let guard = 0;
        let last = -1;
        scroller.scrollTop = 0;
        await new Promise((r) => setTimeout(r, cfg.settleMs || 500));
        // Bounded: a list that grows as it loads (or a scroller that never reports a
        // stable scrollTop) must not spin forever on a page the user is waiting on.
        while (guard++ < 60) {
          for (const el of root.querySelectorAll(sel)) {
            const m = readNode(el);
            if (!m) continue;
            const key = m.key || (m.role + '|' + m.text.slice(0, 120));
            if (seen.has(key)) continue;
            seen.add(key);
            messages.push({ role: m.role, text: m.text, created_at: m.created_at });
          }
          if (scroller.scrollTop <= last) break;          // stopped moving: at the end
          last = scroller.scrollTop;
          scroller.scrollTop = Math.min(scroller.scrollTop + step, scroller.scrollHeight);
          await new Promise((r) => setTimeout(r, cfg.stepMs || 260));
        }
      } else {
        nodes.forEach((el) => {
          const m = readNode(el);
          if (m) messages.push({ role: m.role, text: m.text, created_at: m.created_at });
        });
      }
    } finally {
      box.remove();                                    // no scaffolding left behind
      if (scroller) scroller.scrollTop = prevScroll;   // and put their view back
    }

    // A conversation id that is not actually an id.
    //
    // AI Studio's unsaved chats all live at /prompts/new_chat, so the URL yields the
    // literal "new_chat" for EVERY one of them — every save would land on
    // import:aistudio:new_chat and overwrite the last. Several sites have a
    // placeholder route like this.
    //
    // The fallback hashes the title plus the FIRST user turn, which is stable as the
    // conversation grows: saving again after ten more messages updates the same
    // conversation instead of forking a new one, which is the idempotency the
    // ChatGPT and Claude lanes already have.
    let convId = uuid;
    if (!convId || /^(new|new_chat|new-chat|chat|index|home|app|prompts?)$/i.test(convId)) {
      const first = messages.find((m) => m.role === 'user');
      const basis = title + '\u0000' + ((first && first.text) || '');
      let h = 0x811c9dc5;                                   // FNV-1a, 32-bit
      for (let i = 0; i < basis.length; i++) {
        h ^= basis.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      convId = 'c' + h.toString(16);
    }

    // The diagnostic is the point of this returning at all when it finds nothing:
    // "0 messages" and "the selectors matched 40 nodes and every one was empty"
    // are different failures, and only one of them means the site changed.
    return {
      uuid: convId,
      title,
      messages,
      diagnostic: {
        strategy: 'selectors',
        uuid_from_url: uuid || null,
        uuid_synthesized: convId !== uuid,
        selector_hits: nodes.length,
        skipped_empty: skippedEmpty,
        user_selector: cfg.user || null,
        assistant_selector: cfg.assistant || null,
      },
    };
  } catch (e) {
    return { uuid: '', title: 'Captured chat', messages: [], error: String((e && e.message) || e) };
  }
}

const BUILTIN_EXTRACTORS = {
  'gmail.unread': {
    urlPattern: 'https://mail.google.com/*',
    fn: extractor_gmailUnread,
  },
  // PLAN-UNIVERSAL-MEMORY Phase 4 — chat capture (message-array shape).
  'claude_conversation': {
    urlPattern: 'https://claude.ai/*',
    fn: extractor_claudeConversation,
  },
  'chatgpt_conversation': {
    urlPattern: 'https://chatgpt.com/*',
    fn: extractor_chatgptConversation,
  },
};

// ---------- open_url ----------
// Navigate an existing tab matching `match_url` (or open a new one) to
// the given target URL. Used by lens renderers that want clicks to land
// in the user's already-logged-in session — e.g. clicking a row in
// gmail.unread navigates the existing Gmail tab to the thread, no popup,
// no separate window.
async function cmdOpenUrl(msg, reply, replyError) {
  const url = msg.url;
  const matchUrl = msg.match_url || null; // pattern for an existing tab to reuse
  const newTab = !!msg.new_tab;
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    return replyError('VALIDATION_FAILED', 'url must be http(s)://');
  }
  try {
    if (!newTab && matchUrl) {
      const tabs = await chrome.tabs.query({ url: matchUrl });
      const tab = tabs.find((t) => t.active) || tabs[0];
      if (tab) {
        await chrome.tabs.update(tab.id, { url, active: true });
        // Focus the window that holds it.
        if (tab.windowId) {
          try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
        }
        return reply({ tabId: tab.id, reused: true });
      }
    }
    // Fall through: open a new tab.
    const created = await chrome.tabs.create({ url, active: true });
    reply({ tabId: created.id, reused: false });
  } catch (err) {
    replyError('OPEN_URL_FAILED', err?.message || String(err));
  }
}

// One `web_conversation:<key>` entry per site that has a VERIFIED selector set.
//
// Generated from sites.js rather than hand-listed — a second copy of the host list
// is the drift bug sites.js exists to prevent, and supportedHosts() above already
// learned that lesson the hard way.
//
// A site with no `save` block gets NO entry, deliberately. The alternative is a
// Save button that always answers "no usable turns", which is worse than no button:
// it teaches the user the feature is broken rather than that it is not ready here.
// content.js consults the same field to decide whether to offer the menu item, so
// the button and the extractor can never disagree about which sites are covered.
let webExtractorsReady = null;
async function ensureWebExtractors() {
  if (webExtractorsReady) return webExtractorsReady;
  webExtractorsReady = (async () => {
    try {
      // VODOU_SITES is already present — the static import at the top of this file
      // put it there before anything could call this.
      for (const s of globalThis.VODOU_SITES || []) {
        if (!s.save || !s.save.user) continue;
        BUILTIN_EXTRACTORS[`web_conversation:${s.key}`] = {
          urlPattern: s.save.urlPattern || `https://*.${s.key}/*`,
          fn: extractor_webConversation,
          args: [s.save],
        };
      }
    } catch (e) {
      console.warn('[vodou] could not build web extractors from sites.js:', e);
    }
  })();
  return webExtractorsReady;
}

async function cmdExtractBuiltin(msg, reply, replyError) {
  const id = msg.id_extractor || msg.extractor;
  // The web_conversation:* entries are built lazily from sites.js, so the registry
  // has to be populated before the lookup below or every one of them 404s on the
  // first call after the service worker wakes.
  await ensureWebExtractors();
  if (typeof id !== 'string' || !BUILTIN_EXTRACTORS[id]) {
    // Say WHY. "No built-in extractor" alone reads as "this site is unsupported",
    // which sent the last debugging round looking at sites.js instead of at the
    // loader that had failed to read it.
    const registered = Object.keys(BUILTIN_EXTRACTORS).filter((k) => k.startsWith('web_conversation:'));
    const known = (globalThis.VODOU_SITES || []).length;
    return replyError(
      'UNKNOWN_EXTRACTOR',
      `no built-in extractor for "${id}" — ${registered.length} web extractor(s) registered ` +
      `from ${known} site(s) in the registry` +
      (known === 0 ? '; sites.js did not load in the service worker' : ''),
    );
  }
  const entry = BUILTIN_EXTRACTORS[id];
  try {
    const tabs = await chrome.tabs.query({ url: entry.urlPattern });
    const tab = tabs.find((t) => t.active) || tabs[0];
    if (!tab) {
      return replyError('NO_MATCHING_TAB', `no open tab matches ${entry.urlPattern}`);
    }
    const [exec] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: entry.fn,
      // Selector sets travel as args because entry.fn is serialized for injection
      // and can close over nothing.
      ...(entry.args ? { args: entry.args } : {}),
      // Default 'ISOLATED' world is fine — entry.fn is a real function,
      // not a string, so Chrome's injection path doesn't use eval.
    });
    reply({ result: exec?.result ?? null });
  } catch (err) {
    replyError('INTERNAL', err?.message || 'extract_builtin failed');
  }
}

// ── PLAN-BRIDGE-SIDE-PANEL P0 — side panel open path ─────────────────────────
// THE GATE THIS SPIKE EXISTS TO ANSWER: chrome.sidePanel.open() requires a user
// gesture. A `commands` handler is documented as gesture-carrying, but that has
// changed across Chrome versions — so the shortcut is tried and any failure is
// reported loudly rather than swallowed. If it throws, the fallback stands: the
// toolbar icon opens the panel (a click is unambiguously a gesture), and the
// shortcut is downgraded to a nice-to-have (see the plan §3.1b — the toolbar
// button is the guaranteed path by design, not as a consolation).
//
// `how` rides in the query string purely so the answer is visible IN the panel
// instead of only in a console nobody has open.
// How the panel was last opened, for the P0 diagnostic. A module variable rather
// than a query param because the param would require setOptions() to run BEFORE
// open() — see below for why that is fatal.
let lastPanelOpen = { how: 'unknown', tabId: null, at: 0 };

function openVodouPanel(tabId, how) {
  if (!chrome.sidePanel) return Promise.resolve({ ok: false, error: 'sidePanel unavailable (Chrome < 114?)' });

  // open() "may only be called in response to a user action", and Chrome's gesture
  // does NOT survive an await. The first version of this function awaited
  // setOptions() first and then open() — which spends the gesture on the way and
  // throws. So: nothing async may precede this call. Record state synchronously,
  // fire open() as the very first async thing, and do setOptions afterwards.
  lastPanelOpen = { how, tabId, at: Date.now() };
  let opening;
  try {
    opening = chrome.sidePanel.open({ tabId });
  } catch (e) {
    console.error(`[vodou-panel] open threw synchronously via ${how}:`, e && e.message);
    return Promise.resolve({ ok: false, error: String((e && e.message) || e) });
  }

  // Per-tab path AFTER opening. The panel resolves its own tab from
  // chrome.tabs.query when no param is present, so opening on default_path first
  // is not a degraded experience — it just means the params are cosmetic.
  chrome.sidePanel.setOptions({
    tabId,
    path: `sidepanel.html?tabId=${encodeURIComponent(tabId)}&how=${encodeURIComponent(how)}`,
    enabled: true,
  }).catch((e) => console.warn('[vodou-panel] setOptions after open failed:', e && e.message));

  return opening.then(
    () => { console.log(`[vodou-panel] opened for tab ${tabId} via ${how}`); return { ok: true }; },
    (e) => {
      // Loud on purpose. A silent failure here is indistinguishable from "the
      // shortcut isn't bound", and we would re-derive this gate next session.
      console.error(`[vodou-panel] open FAILED via ${how}:`, e && e.message);
      return { ok: false, error: String((e && e.message) || e) };
    },
  );
}

const INJECT_COMMANDS = { 'inject-context': false, 'inject-visible': true };

chrome.commands.onCommand.addListener((command, tab) => {
  // Registering inject-context / inject-visible as manifest commands made Chrome
  // capture Ctrl+B at browser level, which stopped the page's keydown listener from
  // ever seeing it — the hotkey went dead the moment it became discoverable. So the
  // commands must be handled here and relayed to the page.
  if (command in INJECT_COMMANDS) {
    const id = tab && tab.id;
    if (!id) { console.error('[vodou] inject command fired with no tab'); return; }
    chrome.tabs.sendMessage(id, { type: 'vodou_run_inject', visible: INJECT_COMMANDS[command] })
      .catch(async () => {
        // Orphaned content script after an extension reload — heal and retry once,
        // same as the panel does. Otherwise Ctrl+B stays dead until a page reload.
        try {
          await chrome.scripting.executeScript({ target: { tabId: id }, files: ['sites.js', 'content.js'] });
          await chrome.tabs.sendMessage(id, { type: 'vodou_run_inject', visible: INJECT_COMMANDS[command] });
        } catch (e) {
          console.error('[vodou] inject relay failed:', e && e.message);
        }
      });
    return;
  }
  if (command !== 'toggle-side-panel') return;
  // NOT async, and no await before open(). `tab` is supplied for command events;
  // if it is ever missing we would need chrome.tabs.query, whose await would spend
  // the gesture — so that case reports honestly instead of silently failing.
  if (tab && tab.id) { openVodouPanel(tab.id, 'keyboard shortcut'); return; }
  console.error('[vodou-panel] command fired with no tab — cannot open without spending the user gesture');
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'vodou_ensure_content') {
    // Self-healing injection. Reloading the extension orphans the content script in
    // every open tab, so the panel's probe and insert stop answering until the user
    // reloads the page — and telling a user to reload the page is not a fix, it is
    // an excuse. The panel calls this when a probe fails, then retries once.
    // Idempotent: content.js's mount guards are versioned, so re-injecting the same
    // build is a no-op and a newer build re-arms.
    if (!msg.tabId) { sendResponse({ ok: false, error: 'no tabId' }); return undefined; }
    chrome.scripting.executeScript({ target: { tabId: msg.tabId }, files: ['sites.js', 'content.js'] })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        // Restricted pages (chrome://, the Web Store) legitimately refuse injection.
        console.warn('[vodou-panel] content injection refused:', e && e.message);
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      });
    return true;   // async response
  }
  if (msg && msg.type === 'get_panel_context') {
    // The panel asks how it was opened, since the query param cannot be set before
    // open() without breaking the gesture.
    sendResponse(lastPanelOpen);
    return undefined;
  }
  return undefined;
});

// ── PLAN-CAPTURE-SAFETY P0-a — remote per-provider capture kill switch ───────
// A provider objection can disable that provider's capture within hours, with no
// Web Store review cycle. CWS-legal because this fetches DATA, not code: MV3 bans
// remotely hosted code, and Google's own guidance names "loads and caches a remote
// configuration (for example a JSON file) at runtime" as the permitted pattern.
// What keeps it on the right side of that line is that all the logic lives here in
// the package — the file only flips flags this file already understands.
//
// Three properties, each enforced in code below rather than left to convention:
//
//  1. REMOTE CAN ONLY TAKE AWAY. Only `capture:false` entries are kept. A file
//     saying capture:true is not "re-enable", it is dropped — so no remote value
//     can override a user's own off switch or widen what the manifest declares.
//     A structural guarantee rather than a promise in a doc.
//  2. FAIL OPEN. Any failure — offline, DNS, 404, CORS, malformed JSON — leaves
//     the last cached policy in place and capture continues. A plane or a hotel
//     portal must never silently stop capture.
//  3. NOT A BEACON. credentials:'omit', no query string, no install id, no
//     telemetry — a plain GET of a static asset. "Captured data is local-only and
//     never touches Vodou infrastructure" has to stay true, and a poll carrying
//     identity would quietly make it false.
const POLICY_URL = 'https://policy.vodou.ai/capture-policy.json';
const POLICY_KEY = 'vodou_capture_policy';
const POLICY_ALARM = 'vbb-capture-policy';

async function fetchCapturePolicy() {
  try {
    const res = await fetch(POLICY_URL, { cache: 'no-cache', credentials: 'omit' });
    if (!res.ok) return;                        // fail open on the cached copy
    const body = await res.json();
    if (!body || typeof body !== 'object' || !body.providers || typeof body.providers !== 'object') return;
    // Normalise to the minimum shape we act on. Anything else in the file is
    // ignored rather than interpreted — that is what keeps it data, not logic.
    const providers = {};
    for (const [name, v] of Object.entries(body.providers)) {
      if (v && v.capture === false) providers[name] = { capture: false };
    }
    chrome.storage.local.set({ [POLICY_KEY]: { providers, fetchedAt: Date.now() } });
  } catch (_) { /* offline / DNS / CORS / bad JSON — fail open, keep the cache */ }
}

chrome.alarms.create(POLICY_ALARM, { when: Date.now() + 5000, periodInMinutes: 720 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === POLICY_ALARM) fetchCapturePolicy();
});
chrome.runtime.onStartup.addListener(fetchCapturePolicy);
chrome.runtime.onInstalled.addListener(fetchCapturePolicy);
