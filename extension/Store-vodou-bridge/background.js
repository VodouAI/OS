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
// A memory companion: it captures conversations on the listed AI chat sites and
// inserts memory the user picks back into them, over a WebSocket to Vodou running
// on this machine. Plus host-scoped cookies_fetch and packaged extractors used by
// the import path.
//
// What it does NOT do, by design:
//   - run any script supplied by the gateway in a page (MV3 remote-code ban)
//   - fetch arbitrary URLs — hosts are the AI list plus localhost, and nothing else
//   - modify an outgoing request; requests pass through untouched
//
// MV3 service workers auto-suspend after ~30s idle. We use chrome.alarms
// to keep the connection alive when there's no other activity — this is
// the only reliable way to maintain a persistent WS in MV3 today.

const DEFAULT_GATEWAY_URLS = [
  'ws://127.0.0.1:8765/api/vbb',
  'ws://localhost:8765/api/vbb',
];
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const PROTOCOL_VERSION = { min: 1, max: 1 };
/** Advertised on bridge_ready so the gateway knows which build it is talking to. */
const BRIDGE_CHANNEL = 'store';

// Hosts allowed for cookies_fetch / fetch / open_url / list_tabs filtering.
// Must stay aligned with manifest host_permissions (AI sites + localhost).
const STORE_HOST_SUFFIXES = [
  'chatgpt.com',
  'chat.openai.com',
  'claude.ai',
  'gemini.google.com',
  'aistudio.google.com',
  'perplexity.ai',
  'www.perplexity.ai',
  'grok.com',
  'chat.deepseek.com',
  'copilot.microsoft.com',
  'chat.mistral.ai',
  'meta.ai',
  'www.meta.ai',
  'manus.im',
  'x.com',
  'twitter.com',
  'chat.qwen.ai',
  'kimi.com',
  'www.kimi.com',
  'kimi.moonshot.cn',
  'notebooklm.google.com',
  'poe.com',
  'duckduckgo.com',
  'duck.ai',
  'huggingface.co',
  'you.com',
  'chat.z.ai',
  't3.chat',
  'openrouter.ai',
  'character.ai',
  'old.character.ai',
  'notebook.google.com',
  'qwen.ai',
  'www.qwen.ai',
  'localhost',
  '127.0.0.1',
];

function hostnameAllowed(hostname) {
  if (!hostname) return false;
  const h = String(hostname).toLowerCase();
  return STORE_HOST_SUFFIXES.some((s) => h === s || h.endsWith('.' + s));
}

function urlAllowed(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return hostnameAllowed(u.hostname);
  } catch {
    return false;
  }
}

/** Store default: only local Vodou. Unlock via "Allow custom gateway". */
function isLocalGatewayUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
  } catch {
    return false;
  }
}

// Says what this build does, not where to get one that does more. The previous
// wording named an off-store distribution channel, in a string that reaches the
// console — the same mistake commit 9bdbbc85 fixed in comments.
const STORE_UNSUPPORTED_MSG =
  'This command is not available in Vodou Bridge. This extension reads conversations ' +
  'and inserts memory you choose; it does not run actions in pages.';

let ws = null;
let backoffIdx = 0;
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
async function getAllowCustomGateway() {
  try {
    const { vodou_allow_custom_gateway } = await chrome.storage.local.get(['vodou_allow_custom_gateway']);
    return !!vodou_allow_custom_gateway; // default OFF = locked to localhost
  } catch { return false; }
}
async function setAllowCustomGateway(v) {
  try { await chrome.storage.local.set({ vodou_allow_custom_gateway: !!v }); } catch {}
}

// ---------- WebSocket connect ----------
async function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  if (!enabled) return; // user disabled the bridge from the panel
  await standbyRestored; // don't dial before the persisted slot-fight standby is loaded
  if (Date.now() < rejectStandbyUntil) return;
  if (!userGatewayUrl) userGatewayUrl = await getStoredGatewayUrl();
  const allowCustom = await getAllowCustomGateway();
  // Store lock: ignore non-local stored URLs unless the user unlocked custom gateway.
  if (!allowCustom && userGatewayUrl && !isLocalGatewayUrl(userGatewayUrl)) {
    console.warn('[vbb] ignoring non-local gateway (custom URL locked):', userGatewayUrl);
    userGatewayUrl = null;
  }
  const candidates = (allowCustom && userGatewayUrl) ? [userGatewayUrl] : DEFAULT_GATEWAY_URLS;
  // Extra safety: never dial a non-local URL while locked.
  const url = candidates.find((c) => allowCustom || isLocalGatewayUrl(c));
  if (!url) {
    console.warn('[vbb] no allowed gateway URL to dial');
    return;
  }
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
        channel: BRIDGE_CHANNEL,
        store_build: true,
        browser_info: { ua: navigator.userAgent, vendor: navigator.vendor },
        token,
      }));
    } catch (err) {
      console.warn('[vbb] bridge_ready send failed:', err);
    }
    // Seed the active-tab cache right after handshake so the router has
    // context on the very first prompt after reconnect.
    sendActiveTab();
    // Anything captured while Vodou was away goes now, oldest first
    // (PLAN-ENGINE-GATED-CAPTURE P0).
    flushCaptureQueue();
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
    if (msg.cmd === 'server_info') {
      setBrainPort(msg.brain_port);
      sessionPaired = msg.paired === true;
      // PLAN-BRAIN-INJECT-LANE — a (re)connect just completed; replay any panel Chat
      // streams past their last-seen seq so a suspended-then-woken SW loses nothing.
      resumeChatStreams();
      return;
    }
    // Auto-capture landed: the gateway confirms how many turns it actually
    // persisted. We log THIS, not the fire-and-forget send, so the count in the
    // panel is what's in memory rather than what we hoped.
    // PLAN-ENGINE-GATED-CAPTURE P2 — the gateway has no live lease from the engine,
    // so it refused to store this batch. NOT an error: hold the turns in the same
    // queue a disconnect uses and replay them once the engine is back. Without
    // this, gating capture would reintroduce exactly the silent loss P0 fixed.
    if (msg.cmd === 'capture_refused') {
      captureBlockedReason = typeof msg.reason === 'string' ? msg.reason : 'engine_unreachable';
      // A replayed batch is refused the same way a fresh one is, and the refusal
      // carries no batch identity — so put everything in flight back up for retry
      // rather than assuming this refusal was only about `lastSentBatch`.
      unmarkInFlight();
      const pending = lastSentBatch;
      lastSentBatch = null;
      if (pending) {
        // The tab id is routing for the message below, not part of the batch —
        // it must not be persisted into a queue that outlives the tab.
        const { tabId: _drop, ...durable } = pending;
        queueCapture(durable);
      }
      const note = leaseMessage(captureBlockedReason);
      const n = (pending && pending.turns && pending.turns.length) || 0;
      logActivity({
        kind: 'capture',
        mode: 'auto',
        provider: msg.provider || 'web',
        convId: msg.conversationId || '',
        messages: n,
        ok: false,
        // `held` is what stops the panel rendering this as a failure. The turns
        // are in the queue; this is a pause with a reason.
        held: true,
        reason: captureBlockedReason,
        note,
      });
      // Tell the PAGE too. capture_turn is fire-and-forget, so by the time the
      // gateway's verdict arrives the in-page console has already printed a
      // success line — leaving it uncorrected is the "looks exactly like success"
      // failure mode that cost an hour on 2026-07-26.
      if (pending && pending.tabId) {
        try {
          chrome.tabs.sendMessage(pending.tabId, {
            type: 'vodou_capture_refused',
            provider: msg.provider || 'web',
            n,
            reason: captureBlockedReason,
            note,
          }, () => void chrome.runtime.lastError);
        } catch (_) { /* tab closed */ }
      }
      console.warn(`[vbb] capture refused by gateway (${captureBlockedReason}) — holding for retry`);
      return;
    }
    if (msg.cmd === 'capture_ack') {
      // A batch that landed is no longer a candidate for the refusal queue, and
      // anything queued for this conversation has now been stored. stored=0 is
      // a real ack too (whole batch was duplicates, safely stored earlier) —
      // it must clear the queue or the batch replays every heartbeat for 24h,
      // but it earns no activity row (nothing new was saved).
      lastSentBatch = null;
      captureBlockedReason = null;
      // Precise clear when the gateway echoed the batch id; conversation-level
      // clear as the legacy fallback (pre-batch-id gateways).
      if (msg.batchId) clearQueuedBatch(msg.batchId);
      else clearQueuedFor(msg.conversationId);
      if (!(Number(msg.stored) > 0)) return;
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
    // PLAN-BRAIN-INJECT-LANE — the agentic lane. brain_result answers a one-shot
    // get_brain_context; chat_event/chat_ack/chat_history_result stream to the panel
    // Chat tab over the long-lived `vodou-chat` Port. These MUST be branched BEFORE
    // handleCmd, which would otherwise UNKNOWN_CMD them back to the gateway.
    if (msg.cmd === 'brain_result') { resolveBrain(msg); return; }
    if (msg.cmd === 'chat_event' || msg.cmd === 'chat_ack' || msg.cmd === 'chat_history_result') {
      routeChatFrame(msg);
      return;
    }
    // PLAN-VODOU-TASKS-CHANNEL — the async task lane. Dispatch acks immediately, the
    // job runs locally on the gateway, and these frames stream progress + the result.
    if (msg.cmd === 'task_ack' || msg.cmd === 'task_event' || msg.cmd === 'task_done' ||
        msg.cmd === 'task_list_result' || msg.cmd === 'task_status_result') {
      routeTaskFrame(msg);
      return;
    }
    handleCmd(msg);
  });

  sock.addEventListener('close', (evt) => {
    console.log('[vbb] disconnected', evt?.code || '');
    if (evt && evt.code === 4403) {
      // Gateway enforces pairing and our code didn't match — stop hammering
      // reconnects; the panel shows the pair prompt and reconnects on save.
      // Soft re-probe once: require may have been a temporary flip (settings/tests).
      pairingRequired = true;
      if (ws === sock) ws = null;
      setTimeout(() => {
        if (!enabled || (ws && ws.readyState === WebSocket.OPEN)) return;
        pairingRequired = false;
        backoffIdx = 0;
        connect().catch(() => {});
      }, 20_000);
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
  // PLAN-ENGINE-GATED-CAPTURE P4 — drain anything still held.
  //
  // flushCaptureQueue() also runs on bridge_ready, which covers a disconnect. It
  // does NOT cover the case enforcement introduced: a batch refused for want of a
  // lease WHILE the socket stays open. Nothing reconnects, so without this the
  // held turns would sit in the queue until the next restart. Every 30s on a live
  // socket, and a no-op when the queue is empty.
  flushCaptureQueue();
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
      case 'extract':
        return replyError('UNSUPPORTED', STORE_UNSUPPORTED_MSG, { cmd: 'extract', channel: BRIDGE_CHANNEL });
      case 'act_in_tab':
        return replyError('UNSUPPORTED', STORE_UNSUPPORTED_MSG, { cmd: 'act_in_tab', channel: BRIDGE_CHANNEL });
      case 'list_tabs': return await cmdListTabs(msg, reply, replyError);
      case 'cookies_fetch': return await cmdCookiesFetch(msg, reply, replyError);
      case 'extract_builtin': return await cmdExtractBuiltin(msg, reply, replyError);
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

// ---------- fetch (store: AI / localhost hosts only) ----------
async function cmdFetch(msg, reply, replyError) {
  const { url, opts = {} } = msg;
  if (!url) return replyError('VALIDATION_FAILED', 'url required');
  if (!urlAllowed(url)) {
    return replyError('HOST_NOT_ALLOWED', 'Store build may only fetch allowlisted AI / localhost hosts', { url });
  }
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

function urlPatternToMatchUrl(p) {
  // Glob patterns like "chatgpt.com/*" → "*://chatgpt.com/*"
  if (p.startsWith('http')) return p;
  return `*://${p.replace(/\*\*/g, '*')}`;
}

// ---------- list_tabs (store: filter to allowlisted hosts) ----------
async function cmdListTabs(msg, reply, replyError) {
  try {
    const query = msg.urlPattern ? { url: urlPatternToMatchUrl(msg.urlPattern) } : {};
    const tabs = await chrome.tabs.query(query);
    const filtered = tabs.filter((t) => t.url && urlAllowed(t.url));
    reply({
      tabs: filtered.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active })),
    });
  } catch (err) {
    replyError('INTERNAL', err?.message || 'list_tabs failed');
  }
}

// ---------- Capture retry queue (PLAN-ENGINE-GATED-CAPTURE P0) ----------
//
// A captured turn used to be DROPPED whenever the bridge was down: the handler
// answered `{ok:false, reason:'bridge not connected'}` and nothing kept the text.
// The loss was permanent, not merely delayed, because inject.js records a turn in
// `postedOnce` at SEND time — so the natural re-fetch that would have caught it
// (ChatGPT's and Claude's conversation snapshots re-deliver the whole thread)
// was suppressed as a duplicate of something that had never been stored.
//
// Restarting Vodou, a gateway redeploy, or laptop sleep were all enough. Hold the
// turns instead and send them when the socket comes back.
//
// chrome.storage.local, not memory: an MV3 service worker is killed after ~30s
// idle, which is exactly the window a disconnect lives in.
const CAPTURE_QUEUE_KEY = 'vodou_capture_queue';
const CAPTURE_QUEUE_MAX_ITEMS = 100;
const CAPTURE_QUEUE_MAX_BYTES = 1000000;   // ~1MB — chrome.storage.local's quota is 10MB
const CAPTURE_QUEUE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Serialise read-modify-write. Two captures landing in the same tick would
// otherwise each read the queue, append, and write — losing one of them, which is
// the exact failure this queue exists to prevent.
let captureQueueLock = Promise.resolve();

// PLAN-ENGINE-GATED-CAPTURE P2 — the last batch handed to the socket but not yet
// acked, and the reason the engine last refused capture (null = allowed).
let lastSentBatch = null;
let captureBlockedReason = null;

// PLAN-ENGINE-GATED-CAPTURE P3a — the ONE place a refusal code becomes English.
//
// Three surfaces show this (panel activity log, the page console, and the
// gateway's /api/vbb/state), and they must not drift into three different
// explanations of the same state. The gateway sends a CODE; this turns it into a
// sentence exactly once, and both extension surfaces render the same string.
//
// Every one of these is a PAUSE, not a loss — the turns are already in the retry
// queue. Say so, because "couldn't save your chat" when nothing was lost is the
// error message that makes people stop trusting the product.
const LEASE_MESSAGE = {
  engine_unreachable: "Vodou isn't running — held for now, will save when it's back",
  no_account: 'Connect your Vodou account to save chats — held until you do',
  invalid_credentials: 'Your Vodou account was rejected — reconnect in Settings; chats are held',
  over_limit: 'Account limit reached — held; upgrade to keep saving',
  engine_error: 'Vodou could not confirm your account — held, will retry',
};
const leaseMessage = (code) => LEASE_MESSAGE[code] || LEASE_MESSAGE.engine_error;
const withCaptureQueue = (fn) => (captureQueueLock = captureQueueLock.then(fn, fn));

async function readCaptureQueue() {
  try {
    const got = await chrome.storage.local.get(CAPTURE_QUEUE_KEY);
    const q = got && got[CAPTURE_QUEUE_KEY];
    return Array.isArray(q) ? q : [];
  } catch (_) { return []; }
}

/** Hold a batch the socket could not take. Returns true if it is safely stored. */
function queueCapture(item) {
  return withCaptureQueue(async () => {
    try {
      const q = await readCaptureQueue();
      // Batch identity + retry bookkeeping (2026-08-06 hardening): the id lets
      // an ack clear EXACTLY this batch (conversation-level clearing left
      // siblings behind), attempts feeds the backoff/drop cap in the flusher.
      if (!item.id) item.id = 'cb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      if (!item.attempts) item.attempts = 0;
      q.push(item);
      // Bound by count AND bytes, oldest first. An unbounded queue on a machine
      // whose gateway never comes back would grow until storage writes started
      // failing — at which point NEW captures are lost to protect old ones.
      let dropped = 0;
      while (q.length > CAPTURE_QUEUE_MAX_ITEMS) { q.shift(); dropped++; }
      while (q.length > 1 && JSON.stringify(q).length > CAPTURE_QUEUE_MAX_BYTES) { q.shift(); dropped++; }
      if (dropped) console.warn(`[vbb] capture queue full — dropped ${dropped} oldest batch(es)`);
      await chrome.storage.local.set({ [CAPTURE_QUEUE_KEY]: q });
      console.log(`[vbb] capture held for retry (${q.length} batch(es) waiting)`);
      return true;
    } catch (e) {
      console.warn('[vbb] could not hold capture for retry:', (e && e.message) || e);
      return false;
    }
  });
}

/** How long a replayed batch is considered in flight before it is sent again. */
const CAPTURE_MAX_ATTEMPTS = 10;   // unacked resends before a batch is dropped for good

/**
 * Drain the queue. Called after bridge_ready AND on the 30s heartbeat.
 *
 * A batch is NOT removed when it is sent — only when the gateway acks it.
 * `capture_turn` is fire-and-forget, so a replay can still be REFUSED (no lease),
 * and the refusal arrives with no way to identify which batch it belonged to.
 * Dropping on send therefore lost exactly the turns this queue exists to protect,
 * and only once enforcement made refusals reachable. Keeping them until an ack
 * means the worst case is a resend, which the gateway dedupes by provider message
 * id — the right direction to fail.
 */
function flushCaptureQueue() {
  return withCaptureQueue(async () => {
    const q = await readCaptureQueue();
    if (!q.length) return;
    const now = Date.now();
    let sent = 0, stale = 0, inflight = 0, capped = 0;
    // Exponential backoff per batch: 1m → 5m → 30m for every retry after
    // that, hard-dropped at CAPTURE_MAX_ATTEMPTS. The flat 60s window meant
    // an unacked batch re-sent ~1400×/day for its 24h lifetime (the
    // 2026-08-05 gateway flood was one duplicate batch doing exactly this —
    // the missing-ack bug is fixed, this cap is the belt for the next
    // unforeseen ack gap).
    const backoffMs = (attempts) => (attempts <= 1 ? 60_000 : attempts === 2 ? 300_000 : 1_800_000);
    const left = [];
    for (const item of q) {
      // An ancient replay is likelier to duplicate than to help: the gateway's
      // no-provider-id fallback dedup is time-bucketed, so a day-old resend can
      // no longer be recognised as the same turn.
      if (!item || (item.at && now - item.at > CAPTURE_QUEUE_MAX_AGE_MS)) { stale++; continue; }
      if ((item.attempts || 0) >= CAPTURE_MAX_ATTEMPTS) {
        capped++;
        console.warn(`[vbb] capture batch ${item.id || '?'} dropped after ${item.attempts} unacked attempts (${item.provider}/${item.conversationId})`);
        continue;
      }
      if (!ws || ws.readyState !== WebSocket.OPEN) { left.push(item); continue; }
      // Already sent and awaiting a verdict — back off progressively.
      if (item.sentAt && now - item.sentAt < backoffMs(item.attempts || 1)) { left.push(item); inflight++; continue; }
      try {
        ws.send(JSON.stringify({
          cmd: 'capture_turn',
          batchId: item.id || '',
          provider: item.provider,
          conversationId: item.conversationId,
          turns: item.turns,
          url: item.url || '',
        }));
        // Deliberately NOT item.tabId: the tab that produced this turn may be
        // long closed, and a replay has no page console to correct.
        left.push({ ...item, sentAt: now, attempts: (item.attempts || 0) + 1 });
        sent++;
      } catch (_) {
        left.push(item);   // socket died mid-drain — keep the rest for next time
      }
    }
    await chrome.storage.local.set({ [CAPTURE_QUEUE_KEY]: left });
    if (sent || stale || capped) {
      console.log(`[vbb] capture queue: sent ${sent}${stale ? `, dropped ${stale} stale` : ''}${capped ? `, ${capped} dropped at attempt cap` : ''}${inflight ? `, ${inflight} backing off` : ''}`);
    }
  });
}

/** The gateway stored this conversation — anything queued for it is done. */
function clearQueuedFor(conversationId) {
  if (!conversationId) return;
  return withCaptureQueue(async () => {
    const q = await readCaptureQueue();
    const left = q.filter((i) => i && i.conversationId !== conversationId);
    if (left.length !== q.length) {
      await chrome.storage.local.set({ [CAPTURE_QUEUE_KEY]: left });
      console.log(`[vbb] capture queue: ${q.length - left.length} batch(es) confirmed stored`);
    }
  });
}

/** Precise variant: the ack named the exact batch it covers. */
function clearQueuedBatch(batchId) {
  if (!batchId) return;
  return withCaptureQueue(async () => {
    const q = await readCaptureQueue();
    const left = q.filter((i) => i && i.id !== batchId);
    if (left.length !== q.length) {
      await chrome.storage.local.set({ [CAPTURE_QUEUE_KEY]: left });
      console.log(`[vbb] capture queue: batch ${batchId} confirmed stored`);
    }
  });
}

/** A refusal is not an ack — put everything in flight back up for retry. */
function unmarkInFlight() {
  return withCaptureQueue(async () => {
    const q = await readCaptureQueue();
    if (!q.some((i) => i && i.sentAt)) return;
    await chrome.storage.local.set({ [CAPTURE_QUEUE_KEY]: q.map(({ sentAt, ...rest }) => rest) });
  });
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
      // The ONLY write for a brand-new row. Deleting it does not break anything
      // loudly — every capture and inject still works, the feed just silently
      // stops growing, which is indistinguishable from "nothing happened".
      chrome.storage.local.set({ [ACTIVITY_KEY]: log });
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

// ── PLAN-BRAIN-INJECT-LANE — agentic lane plumbing ─────────────────────────────
// One-shot brain_request/brain_result (the Face): content.js sends a draft, the
// gateway runs a full Vodou turn and returns a context pack. Same reqId→callback
// pattern as contexts, but with a slightly-longer timeout than the server budget.
const pendingBrain = new Map();
function resolveBrain(msg) {
  const cb = pendingBrain.get(msg.reqId);
  if (cb) { pendingBrain.delete(msg.reqId); cb(msg); }
}

// Long-lived panel Chat streams. The panel connects a `vodou-chat` Port; we fan
// gateway chat_event/chat_ack/chat_history_result frames to every port watching
// that conversation. `lastSeq` per conversation is persisted so a suspended MV3
// service worker can resume the stream via chat_resume on reconnect.
const chatPorts = new Set();            // all connected panel ports
const chatLastSeq = new Map();          // conversationId → highest seq delivered
function routeChatFrame(msg) {
  const convId = msg.conversationId;
  if (msg.cmd === 'chat_event' && typeof msg.seq === 'number' && convId) {
    const prev = chatLastSeq.get(convId) || 0;
    if (msg.seq > prev) chatLastSeq.set(convId, msg.seq);
  }
  for (const port of chatPorts) {
    try { port.postMessage(msg); } catch { /* port gone; onDisconnect cleans up */ }
  }
}

// Re-arm the in-flight stream after a socket reconnect (SW wake). For every
// conversation we were streaming, ask the gateway to replay events past lastSeq.
function resumeChatStreams() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  for (const [convId, lastSeq] of chatLastSeq) {
    try { ws.send(JSON.stringify({ cmd: 'chat_resume', conversationId: convId, lastSeq })); } catch { /* */ }
  }
}

// ── PLAN-VODOU-TASKS-CHANNEL — async task lane ───────────────────────────────
// The extension is a CHANNEL: dispatch a task, the gateway runs it to completion
// locally, and the result is delivered to the composer and/or the panel's Tasks view.
// Nothing holds the send, so a 40s deep-thinking run and a 2s lookup use one lane.
const taskPorts = new Set();          // panel Tasks views listening
const taskJobs = new Map();           // jobId → { tabId, deliver, draftAtDispatch, title, startedAt }
const TASK_NOTIFY_KEY = 'vodou_task_notify';

function routeTaskFrame(msg) {
  const job = msg.jobId ? taskJobs.get(msg.jobId) : null;

  if (msg.cmd === 'task_ack' && msg.jobId && msg.accepted && job) {
    // The panel can't know the title of a task dispatched from a PAGE (Ctrl+B /
    // run-task), so enrich the ack with what we recorded at dispatch — otherwise its
    // card would read "(task)" until the next task_list hydration.
    msg = { ...msg, title: job.title, startedAt: job.startedAt };
  }

  if (msg.cmd === 'task_event' && job) {
    // Progress → the originating page's pill (best-effort; the tab may be gone).
    if (job.tabId != null) {
      chrome.tabs.sendMessage(job.tabId, {
        type: 'vodou_task_progress', jobId: msg.jobId, heavy: !!msg.heavy, event: msg.event,
      }).catch(() => { /* tab closed/navigated — the panel still has it */ });
    }
  }

  if (msg.cmd === 'task_done' && job) {
    deliverTaskResult(msg, job);
    taskJobs.delete(msg.jobId);
  }

  // Everything goes to any open Tasks view (live cards + hydration).
  for (const p of taskPorts) {
    try { p.postMessage(msg); } catch { /* port gone; onDisconnect cleans up */ }
  }
}

/**
 * Deliver a finished task. Injection is GUARDED: content.js re-reads the composer and
 * only writes if it still holds the draft we dispatched with — never clobber a draft
 * the user has since sent, cleared or rewritten (the async composer race).
 */
async function deliverTaskResult(msg, job) {
  const text = (msg.ok && msg.result && msg.result.text) || '';
  // `narration`: the gateway detected the agent reported on its work instead of
  // delivering it ("Now the synthesis thought (5)."). Real analysis exists but is not
  // in this text, so putting it in the composer would be worse than putting nothing —
  // keep it to the panel, where the card can say what happened.
  const wantsCompose = (job.deliver === 'compose' || job.deliver === 'both') && !msg.narration;
  let injected = false;

  if (text && wantsCompose && job.tabId != null) {
    try {
      const resp = await chrome.tabs.sendMessage(job.tabId, {
        type: 'vodou_task_deliver',
        jobId: msg.jobId,
        text,
        expectDraft: msg.draftAtDispatch || job.draftAtDispatch || '',
        heavy: !!msg.heavy,
      });
      injected = !!(resp && resp.ok);
    } catch { injected = false; }   // tab closed / content script gone
  }

  // Notify when we could NOT put it in front of the user: the tab is gone, the draft
  // moved on, or the window isn't focused. The panel always has it either way.
  if (text && !injected) notifyTaskDone(msg.jobId, job, text);
}

function notifyTaskDone(jobId, job, text) {
  try {
    chrome.storage.local.get([TASK_NOTIFY_KEY], (v) => {
      if (v && v[TASK_NOTIFY_KEY] === false) return;      // opt-out
      if (!chrome.notifications) return;
      chrome.notifications.create(`vodou_task_${jobId}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: '🧠 Vodou finished your task',
        message: (job && job.title ? job.title.slice(0, 60) + ' — ' : '') + text.slice(0, 120),
        priority: 1,
      }, () => void chrome.runtime.lastError);
    });
  } catch { /* notifications unavailable */ }
}

// A notification CLICK is a user gesture — so it may legally open the side panel.
// This closes the fire-and-forget loop: task finishes → notification → click → the
// Tasks view opens with the result waiting.
chrome.notifications?.onClicked.addListener((notifId) => {
  if (!notifId.startsWith('vodou_task_')) return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const id = tabs && tabs[0] && tabs[0].id;
    if (id != null) openVodouPanel(id, 'task-notification');
  });
  chrome.notifications.clear(notifId);
});

/** Send a task to the gateway. Returns the jobId immediately — never awaits the work. */
function dispatchTask({ tabId, draft, page, deliver = 'both', tools }) {
  const jobId = 'job_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if (tabId != null) {
      chrome.tabs.sendMessage(tabId, { type: 'vodou_task_progress', jobId, event: { type: 'error', message: 'Vodou not connected' } }).catch(() => {});
    }
    return { ok: false, error: 'Vodou Bridge not connected — is Vodou running?' };
  }
  taskJobs.set(jobId, {
    tabId: tabId ?? null, deliver, draftAtDispatch: draft,
    title: String(draft || '').slice(0, 120), startedAt: Date.now(),
  });
  try {
    ws.send(JSON.stringify({
      cmd: 'task_dispatch', reqId: jobId, jobId, draft, deliver,
      tools: tools === 'read' ? 'read' : 'all',
      page: { ...(page || {}), tabId: tabId ?? null },
    }));
  } catch (e) {
    taskJobs.delete(jobId);
    return { ok: false, error: 'send failed: ' + (e && e.message) };
  }
  return { ok: true, jobId };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'vodou-tasks') {
    taskPorts.add(port);
    port.onMessage.addListener((m) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        try { port.postMessage({ cmd: 'bridge_down' }); } catch { /* */ }
        return;
      }
      const map = { task_list: 'task_list', task_status: 'task_status', task_cancel: 'task_cancel' };
      if (m && m.type === 'task_run') {           // dispatch from the panel itself
        const r = dispatchTask({ tabId: m.tabId ?? null, draft: m.draft, page: m.page || {}, deliver: m.deliver || 'both' });
        try { port.postMessage({ cmd: 'task_dispatched', ...r }); } catch { /* */ }
        return;
      }
      const cmd = map[m && m.type];
      if (!cmd) return;
      try { ws.send(JSON.stringify({ ...m, type: undefined, cmd })); } catch { /* */ }
    });
    port.onDisconnect.addListener(() => { taskPorts.delete(port); });
    return;
  }
  if (port.name !== 'vodou-chat') return;
  chatPorts.add(port);
  port.onMessage.addListener((m) => {
    // Panel → gateway. Translate 1:1 to WS frames; re-check readiness at send time.
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      try { port.postMessage({ cmd: 'bridge_down' }); } catch { /* */ }
      return;
    }
    const map = {
      chat_send: 'chat_request',
      chat_stop: 'chat_stop',
      chat_resume: 'chat_resume',
      chat_approve: 'chat_approve',
      chat_history: 'chat_history',
    };
    const cmd = map[m?.type];
    if (!cmd) return;
    try { ws.send(JSON.stringify({ ...m, type: undefined, cmd })); } catch { /* */ }
  });
  port.onDisconnect.addListener(() => { chatPorts.delete(port); });
});

// ---------- Popup-controlled gateway URL ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
  if (msg?.type === 'run_task_from_page') {
    // Ctrl+B / FAB / panel button on a page → dispatch an async task. Returns the
    // jobId immediately; the result is delivered later under the draft guard.
    const tabId = sender && sender.tab && sender.tab.id;
    sendResponse(dispatchTask({
      tabId: tabId ?? null,
      draft: String(msg.draft || ''),
      page: msg.page || {},
      deliver: msg.deliver || 'both',
      tools: msg.tools,
    }));
    return undefined;
  }
  if (msg?.type === 'vodou_open_panel_from_page') {
    // The in-page task pill was clicked. A click IS a user gesture and it survives the
    // hop to the background here, so sidePanel.open() is legal — this is how a
    // page-initiated task (Ctrl+B) can still surface the live Tasks view.
    const id = sender && sender.tab && sender.tab.id;
    if (id != null) openVodouPanel(id, 'task-pill');
    sendResponse({ ok: id != null });
    return undefined;
  }
  if (msg?.type === 'get_brain_context') {
    // PLAN-BRAIN-INJECT-LANE — content.js asks the Face to run a full agentic turn
    // for the current draft and return a context pack (or a direct answer). Same
    // reqId→callback shape as get_context; timeout is 2s past the server budget so
    // the gateway's own degrade-to-retrieval path wins the race, not this timer.
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      sendResponse({ ok: false, error: 'Vodou Bridge not connected — is Vodou running?' });
      return true;
    }
    const reqId = 'brain_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const budgetMs = Number(msg.budget_ms) || 10000;
    pendingBrain.set(reqId, sendResponse);
    try {
      ws.send(JSON.stringify({
        cmd: 'brain_request',
        reqId,
        draft: msg.draft || '',
        intent: msg.intent === 'answer' ? 'answer' : 'pack',
        tools: msg.tools === 'read' ? 'read' : 'all',
        page: {
          host: msg.host || '',
          provider: msg.provider || '',
          convId: msg.conv_id || '',
          url: msg.url || '',
        },
        budget_ms: budgetMs,
      }));
    } catch (e) {
      pendingBrain.delete(reqId);
      sendResponse({ ok: false, error: 'send failed: ' + (e?.message || e) });
      return true;
    }
    setTimeout(() => {
      if (pendingBrain.has(reqId)) {
        pendingBrain.get(reqId)({ ok: false, error: 'brain request timed out' });
        pendingBrain.delete(reqId);
      }
    }, budgetMs + 2000);
    return true; // async sendResponse
  }
  if (msg?.type === 'inject_log') {
    logActivity(msg.entry || {});
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === 'net_capture') {
    // PLAN-UNIVERSAL-MEMORY-V2 Phase C (W2a) — relay a network-intercepted turn
    // to the gateway (capture_turn).
    //
    // This used to be fire-and-forget, and it had three silent drop points: no
    // socket, a send that threw, and an empty turn list. Meanwhile the page shim
    // printed "captured N turn(s) → relayed to bridge" the moment it handed the
    // message over. On 2026-07-26 the gateway spent an hour refusing every
    // socket ("rejected 7-8 newcomer socket(s) per minute") while the console
    // cheerfully reported success on every capture and NOTHING reached the
    // database. Report the outcome instead.
    if (!Array.isArray(msg.turns) || !msg.turns.length) {
      sendResponse({ ok: false, reason: 'no turns to send' });
      return false;
    }
    // Bridge down: hold the turns rather than lose them (see the queue above).
    // Answering asynchronously, so return true to keep the channel open.
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // Answer SYNCHRONOUSLY. Returning true and resolving sendResponse from a
      // promise leaves the message channel open across a chrome.storage write, and
      // an MV3 worker can be torn down in that window — which printed
      // "A listener indicated an asynchronous response … the message channel closed"
      // in the page console on every held capture (observed 2026-07-28).
      //
      // The write is still awaited, just not by this reply: on the rare failure the
      // tab is corrected afterwards, the same way a lease refusal is. Optimistic
      // here is safe because the failure path is loud rather than silent.
      const tabId = (sender && sender.tab && sender.tab.id) || null;
      queueCapture({
        provider: msg.provider || 'web',
        conversationId: msg.conversationId || 'session',
        turns: msg.turns,
        url: typeof msg.url === 'string' ? msg.url : '',
        at: Date.now(),
      }).then((held) => {
        if (held || !tabId) return;
        try {
          chrome.tabs.sendMessage(tabId, {
            type: 'vodou_capture_refused',
            provider: msg.provider || 'web',
            n: msg.turns.length,
            reason: 'engine_error',
            note: 'could not be held for retry — this exchange was not saved',
          }, () => void chrome.runtime.lastError);
        } catch (_) { /* tab closed */ }
      });
      sendResponse({ ok: false, queued: true, reason: 'Vodou not reachable — held for retry, will send when it is back' });
      return false;
    }
    try {
      const batch = {
        provider: msg.provider || 'web',
        conversationId: msg.conversationId || 'session',
        turns: msg.turns,
        // PLAN-CAPTURE-FEED P1 — the page the turn was captured from, so the feed
        // can link back to the real thread. Pass-through; inject.js owns it.
        url: typeof msg.url === 'string' ? msg.url : '',
        at: Date.now(),
        // Where to send a late refusal. Stripped before queueing — a tab id is
        // meaningless by the time the queue replays.
        tabId: (sender && sender.tab && sender.tab.id) || null,
      };
      // capture_turn is fire-and-forget, so the gateway's verdict arrives AFTER
      // this returns. Keep the batch until it is acked or refused
      // (PLAN-ENGINE-GATED-CAPTURE P2) — one batch deep, because that is how many
      // can be un-adjudicated at once on a single socket.
      lastSentBatch = batch;
      ws.send(JSON.stringify({ cmd: 'capture_turn', ...batch }));
      sendResponse({ ok: true });
      return false; // responded synchronously
    } catch (e) {
      // The socket looked OPEN and still refused the frame (it closes between the
      // readyState check and the send often enough to matter). Same treatment as
      // a known-down bridge: hold it.
      queueCapture({
        provider: msg.provider || 'web',
        conversationId: msg.conversationId || 'session',
        turns: msg.turns,
        url: typeof msg.url === 'string' ? msg.url : '',
        at: Date.now(),
      }).then((held) => {
        sendResponse({
          ok: false,
          queued: held,
          reason: 'socket send failed: ' + ((e && e.message) || e) + (held ? ' — held for retry' : ''),
        });
      });
      return true; // responding asynchronously
    }
  }
  if (msg?.type === 'get_status') {
    Promise.all([getAllowCustomGateway(), getStoredBrainPort()]).then(([allowCustom, port]) => {
      const effectiveUrl = (!allowCustom)
        ? DEFAULT_GATEWAY_URLS[0]
        : (userGatewayUrl || DEFAULT_GATEWAY_URLS[0]);
      sendResponse({
        // Null until the gateway's server_info lands; the panel falls back to 8767.
        brain_port: port || null,
        connected: !!ws && ws.readyState === WebSocket.OPEN,
        paired: !!ws && ws.readyState === WebSocket.OPEN && sessionPaired,
        enabled,
        gateway_url: effectiveUrl,
        allow_custom_gateway: allowCustom,
        protocol: PROTOCOL_VERSION,
        channel: BRIDGE_CHANNEL,
        store_build: true,
        pairing_required: pairingRequired,
        // True while backing off after 1013 rejects (another install holds the slot).
        slot_standby: Date.now() < rejectStandbyUntil,
      });
    });
    return true;
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
  if (msg?.type === 'set_allow_custom_gateway') {
    const allow = !!msg.allow;
    setAllowCustomGateway(allow).then(async () => {
      if (!allow) {
        // Relock: clear non-local URL so we can't reconnect off-machine.
        const cur = userGatewayUrl || await getStoredGatewayUrl();
        if (cur && !isLocalGatewayUrl(cur)) {
          userGatewayUrl = null;
          await setStoredGatewayUrl(null);
        }
      }
      if (ws) try { ws.close(); } catch {}
      ws = null;
      backoffIdx = 0;
      setStandby(0);
      if (enabled) connect().catch(() => {});
      sendResponse({ ok: true, allow_custom_gateway: allow });
    });
    return true;
  }
  if (msg?.type === 'set_gateway_url') {
    (async () => {
      const allowCustom = await getAllowCustomGateway();
      const url = msg.url || null;
      if (url && !allowCustom && !isLocalGatewayUrl(url)) {
        sendResponse({
          ok: false,
          error: 'Custom gateway URLs are locked. Enable “Allow custom gateway URL” first.',
        });
        return;
      }
      if (url && allowCustom && !isLocalGatewayUrl(url) && !/^wss?:\/\//.test(url)) {
        sendResponse({ ok: false, error: 'URL must start with ws:// or wss://' });
        return;
      }
      userGatewayUrl = url;
      await setStoredGatewayUrl(userGatewayUrl);
      if (ws) try { ws.close(); } catch {}
      setStandby(0);
      if (enabled) connect().catch(() => {});
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg?.type === 'set_enabled') {
    enabled = !!msg.enabled;
    setStoredEnabled(enabled);
    if (enabled) {
      // Explicit Connect clears pairing/standby stuck state (e.g. after a
      // temporary require flip or a lost slot fight with another install).
      pairingRequired = false;
      consecutiveRejects = 0;
      backoffIdx = 0;
      setStandby(0);
      if (ws) try { ws.close(); } catch {}
      ws = null;
      connect().catch(() => {});
    } else {
      if (ws) try { ws.close(); } catch {}
      ws = null;
    }
    sendResponse({ ok: true, enabled });
    return true;
  }
});

// ---------- cookies_fetch (store: allowlisted AI / localhost hosts only) ----------
// Read cookies for the URL's domain via chrome.cookies, build a Cookie header,
// fetch() with credentials, return body+status. Used for ChatGPT import replay.
async function cmdCookiesFetch(msg, reply, replyError) {
  const url = msg.url;
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    return replyError('VALIDATION_FAILED', 'url must be http(s)://');
  }
  if (!urlAllowed(url)) {
    return replyError('HOST_NOT_ALLOWED', 'Store build may only cookies_fetch allowlisted AI / localhost hosts', { url });
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

// ---------- Built-in extractors (CSP-safe page injections) ----------
//
// Packaged functions only — invoked by id via extract_builtin. Chrome injects
// a real function reference (not a string), which stays CWS-compliant.
// This build ships ONLY the Claude/ChatGPT conversation extractors, matching
// exactly the surfaces the store listing describes.

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
      if (text) messages.push({ role: isUser ? 'user' : 'assistant', text });
    });
    return { uuid, title, messages, diagnostic: { selector_hits: nodes.length } };
  } catch (e) {
    return { uuid: '', title: 'Captured Claude chat', messages: [], error: String((e && e.message) || e) };
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
        return { role: isUser ? 'user' : 'assistant', text, key: el.getAttribute('data-message-id') || null };
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
            messages.push({ role: m.role, text: m.text });
          }
          if (scroller.scrollTop <= last) break;          // stopped moving: at the end
          last = scroller.scrollTop;
          scroller.scrollTop = Math.min(scroller.scrollTop + step, scroller.scrollHeight);
          await new Promise((r) => setTimeout(r, cfg.stepMs || 260));
        }
      } else {
        nodes.forEach((el) => {
          const m = readNode(el);
          if (m) messages.push({ role: m.role, text: m.text });
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
  // PLAN-UNIVERSAL-MEMORY Phase 4 — chat capture (message-array shape).
  'claude_conversation': {
    urlPattern: 'https://claude.ai/*',
    fn: extractor_claudeConversation,
  },
};

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
      // and can close over nothing. Omitted entirely for the hand-written
      // extractors, which take none.
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
// chrome.sidePanel.open() requires a user gesture, and the gesture does NOT
// survive an await — so nothing async may run before it (see openVodouPanel).
// Both callers are gestures: the toolbar icon and the keyboard command.
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
  // PLAN-VODOU-TASKS-CHANNEL §3.1 — dispatch a task AND open the panel to watch it.
  // openVodouPanel() MUST be the first thing: chrome.sidePanel.open() requires a user
  // gesture and the gesture does NOT survive an await, so nothing async may precede it.
  // Everything after (fetching the draft, dispatching) is free to be async.
  if (command === 'run-task') {
    const id = tab && tab.id;
    if (!id) { console.error('[vodou-task] run-task fired with no tab'); return; }
    openVodouPanel(id, 'task');                       // sync, spends the gesture
    const askDraft = () => chrome.tabs.sendMessage(id, { type: 'vodou_get_draft' });
    askDraft()
      .catch(async () => {
        // Orphaned content script after an extension reload — heal and retry once,
        // same pattern as the inject relay above. Otherwise run-task silently no-ops.
        await chrome.scripting.executeScript({ target: { tabId: id }, files: ['sites.js', 'content.js'] });
        return askDraft();
      })
      .then((r) => {
        const draft = (r && r.draft || '').trim();
        if (!draft) {
          chrome.tabs.sendMessage(id, { type: 'vodou_task_progress', jobId: 'none', event: { type: 'error', message: 'type what you want Vodou to do first' } }).catch(() => {});
          return;
        }
        dispatchTask({ tabId: id, draft, page: (r && r.page) || {}, deliver: 'both' });
      })
      .catch((e) => console.error('[vodou-task] run-task failed:', e && e.message));
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
