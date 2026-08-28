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

// Same shape, same reason: gateway-errors.js assigns to globalThis, and a static
// import is the only load form that cannot fail quietly in a module worker.
import './gateway-errors.js';

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
// PLAN-BRAIN-INTO-CONSOLE: false → the map is in the console (#/memory?tab=map);
// true → this install runs the standalone :8767 twin. Sent on server_info.
let brainStandalone = false;
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
    // PLAN-ALPHA 11e — a skill finished; land it where the user looks. Store a
    // small rolling list (the conversation holds the archive) and light the
    // badge. setBadgeText needs no permission — but it is only VISIBLE on a
    // pinned icon, which is why pinning has its own readiness rung.
    if (msg.cmd === 'skill_result') {
      (async () => {
        try {
          const { vodou_briefings = [] } = await chrome.storage.local.get('vodou_briefings');
          vodou_briefings.unshift({
            name: msg.name || '', display_name: msg.display_name || msg.name || 'Skill',
            response: String(msg.response || '').slice(0, 4000),
            // COHERENCE F28 — a run that failed or produced nothing now arrives
            // too, and must not be shown as an ordinary briefing whose contents
            // happen to read badly. Absent `ok` means an older gateway, which
            // only ever sent successes: treat it as one.
            ok: msg.ok !== false,
            at: msg.at || new Date().toISOString(), seen: false,
          });
          await chrome.storage.local.set({ vodou_briefings: vodou_briefings.slice(0, 10) });
          const unseen = vodou_briefings.filter((b) => !b.seen).length;
          chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
          chrome.action.setBadgeText({ text: String(Math.min(unseen, 9)) });
        } catch (_) { /* storage unavailable — result still lives gateway-side */ }
      })();
      return;
    }
    // Sibling local UIs the gateway knows about (sent right after bridge_ready).
    if (msg.cmd === 'server_info') {
      setBrainPort(msg.brain_port);
      // PLAN-BRIDGE-BRAIN-LINK §3.1 option B — `undefined` is NOT `false`. A
      // gateway that sends no flag predates the console map, and its twin was
      // always running (the opt-in guard arrived with the move, 99ec6f61), so
      // its graph really is at brain_port. Preserve the distinction here; the
      // panel's brainLinkFor() is what interprets it.
      brainStandalone = msg.brain_standalone === true
        ? true
        : (msg.brain_standalone === undefined && msg.brain_port != null ? undefined : false);
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
      const ackedBatch = lastSentBatch;
      lastSentBatch = null;
      captureBlockedReason = null;
      // Precise clear when the gateway echoed the batch id; conversation-level
      // clear as the legacy fallback (pre-batch-id gateways).
      if (msg.batchId) clearQueuedBatch(msg.batchId);
      else clearQueuedFor(msg.conversationId);

      // Tell the PAGE what was actually WRITTEN — mirrors the refusal path above.
      //
      // The page prints its line from the RELAY result ("we handed it over"), which
      // is all the content script knows at that moment; the gateway's insert count
      // arrives here, later, and used to stop at this listener. So a fully-deduped
      // batch printed "N turn(s) STORED by Vodou ✓" while storing nothing — observed
      // 2026-08-09 re-opening a backfilled Claude thread: 4 re-sent, 0 written, and
      // the console claimed all four were stored. Same class as the 2026-07-26 bug
      // this file's other comments describe: only the layer that can observe the
      // outcome may report it.
      if (ackedBatch && ackedBatch.tabId) {
        try {
          chrome.tabs.sendMessage(ackedBatch.tabId, {
            type: 'vodou_capture_stored',
            provider: msg.provider || 'web',
            stored: Number(msg.stored) || 0,
            sent: (ackedBatch.turns && ackedBatch.turns.length) || 0,
          }, () => void chrome.runtime.lastError);
        } catch (_) { /* tab closed */ }
      }

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
    if (msg.cmd === 'title_probe_result') { resolveProbe(msg); return; }
    if (msg.cmd === 'page_probe_result') { resolveProbe(msg); return; }
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
chrome.tabs.onActivated.addListener(() => { sendActiveTab(); probeActiveTab(); });
chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
  // Only fire when the URL changed or the page finished loading.
  if (!tab?.active) return;
  if (info.url || info.status === 'complete') { sendActiveTab(); probeActiveTab(); }
});

// ---------- PLAN-MEMORY-ON-EVERY-PAGE P5 — "Enable Vodou on this site" ----------
// The Store build's content scripts run only on the 35 declared AI hosts; on any
// other page Vodou acts on a GESTURE (activeTab). P5 lets the user lift that per
// site: the panel asks Chrome for the site's host permission (Chrome shows its
// own prompt — the gesture is the user's click in the panel; permissions.request
// must run THERE, in the panel's own context), then tells us here to register
// our packaged content scripts for that origin so they run there automatically
// from now on — typing suggestions, the panel's Fill button, Ctrl+B, capture of
// what the user writes (its own opt-in), all without a right-click first.
// `optional_host_permissions` in the manifest is what makes the per-site prompt
// possible; nothing is granted at install, and no update ever widens access.
// Registered scripts persist across sessions; on startup we reconcile them with
// what Chrome still grants (a user can revoke in chrome://extensions).
const SITE_SCRIPT_PREFIX = 'vodou-site-';
function siteOrigins(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  return h ? ['https://' + h + '/*', 'https://*.' + h + '/*', 'http://' + h + '/*', 'http://*.' + h + '/*'] : [];
}
async function enabledSites() {
  try {
    const all = await chrome.permissions.getAll();
    const hosts = new Set();
    for (const o of (all.origins || [])) {
      const m = /^https?:\/\/(\*\.)?([^/*]+)\/\*$/.exec(o);
      if (m && !isSupportedTabHost(m[2]) && !/^(localhost|127\.0\.0\.1|policy\.vodou\.ai)$/.test(m[2])) hosts.add(m[2]);
    }
    return [...hosts].sort();
  } catch (_) { return []; }
}
async function enableSite(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  const origins = siteOrigins(h);
  if (!origins.length) return { ok: false, error: 'not a host' };
  const has = await chrome.permissions.contains({ origins: [origins[0]] }).catch(() => false);
  if (!has) return { ok: false, error: 'Chrome did not grant access to ' + h };
  const id = SITE_SCRIPT_PREFIX + h;
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] }).catch(() => []);
    const spec = { id, matches: origins, js: ['sites.js', 'content.js'], runAt: 'document_idle', persistAcrossSessions: true, allFrames: false };
    if (existing && existing.length) await chrome.scripting.updateContentScripts([spec]);
    else await chrome.scripting.registerContentScripts([spec]);
  } catch (e) { return { ok: false, error: 'could not register the site script: ' + (e && e.message) }; }
  // Bring the open tabs of that host to life now, not on their next load.
  let injected = 0;
  try {
    const tabs = await chrome.tabs.query({ url: origins });
    for (const t of tabs) {
      try { await chrome.tabs.sendMessage(t.id, { type: 'vodou_ping' }); }
      catch (_) { try { await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['sites.js', 'content.js'] }); injected++; } catch (_) {} }
    }
  } catch (_) {}
  console.log('[site] enabled', h, '| injected into', injected, 'open tab(s)');
  logActivity({ kind: 'site', mode: 'enabled', host: h, at: Date.now() });
  return { ok: true, host: h, injected };
}
async function disableSite(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  const id = SITE_SCRIPT_PREFIX + h;
  try { await chrome.scripting.unregisterContentScripts({ ids: [id] }); } catch (_) {}
  let removed = false;
  try { removed = await chrome.permissions.remove({ origins: siteOrigins(h) }); } catch (_) {}
  try { chrome.storage.local.get(['vodou_site_capture'], (v) => { const m = (v && v.vodou_site_capture) || {}; if (m[h]) { delete m[h]; chrome.storage.local.set({ vodou_site_capture: m }); } }); } catch (_) {}
  console.log('[site] disabled', h, '| permission removed', removed);
  logActivity({ kind: 'site', mode: 'disabled', host: h, at: Date.now() });
  return { ok: true, host: h, removed };
}
// Reconcile on startup: a script registered for an origin Chrome no longer grants is dropped.
async function reconcileSiteScripts() {
  try {
    const regs = await chrome.scripting.getRegisteredContentScripts();
    for (const r of regs || []) {
      if (!r.id || !r.id.startsWith(SITE_SCRIPT_PREFIX)) continue;
      const host = r.id.slice(SITE_SCRIPT_PREFIX.length);
      const ok = await chrome.permissions.contains({ origins: [siteOrigins(host)[0]] }).catch(() => false);
      if (!ok) { await chrome.scripting.unregisterContentScripts({ ids: [r.id] }).catch(() => {}); console.log('[site] dropped stale script for', host); }
    }
  } catch (_) {}
}
chrome.runtime.onStartup?.addListener(() => { reconcileSiteScripts(); });
chrome.runtime.onInstalled?.addListener(() => { reconcileSiteScripts(); });
chrome.permissions?.onRemoved?.addListener(() => { reconcileSiteScripts(); });

// ---------- PLAN-MEMORY-ON-EVERY-PAGE P3 — the badge: "this page has memory" ----------
// On every tab switch / load, ask the gateway whether the page has memory
// behind it (exact-page facts, site facts, saved documents, or a title match)
// and put the count on the toolbar icon FOR THAT TAB. Metadata only (url +
// title). The consent gate comes FIRST, before chrome.tabs.query — the same
// rule as the panel's lane: with page memory OFF this reads nothing.
// Per-tab badge (chrome.action tabId) so switching tabs shows each tab's own
// count and a page with nothing shows nothing. The Library ⋯/✓/! badge is
// global and transient; it wins for its 8 s, then this reasserts on the next
// tab event.
const PAGE_MEM_KEY = 'vodou_page_memory_enabled';
const siteModeCache = new Map(); // host → { at, mode, source }
// The panel writes `vodou_site_modes` when the user changes a rule; drop the
// cache so the next ask reflects it (the gateway is still the authority).
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && 'vodou_site_modes' in ch) siteModeCache.clear(); });
let lastProbeKey = '';
function probeActiveTab() {
  try {
    chrome.storage.local.get([PAGE_MEM_KEY], (v) => {
      if (!(v && v[PAGE_MEM_KEY] === true)) return;             // gate BEFORE the read
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        const t = tabs && tabs[0];
        if (!t || !t.id || !/^https?:\/\//.test(t.url || '')) return;
        const key = t.id + '|' + t.url;
        if (key === lastProbeKey) return;
        lastProbeKey = key;
        const reqId = 'pp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const tabId = t.id;
        const timer = setTimeout(() => pendingProbes.delete(reqId), 6000);
        pendingProbes.set(reqId, (r) => {
          clearTimeout(timer);
          // THIS PAGE only: facts stamped here + documents saved from here.
          // Not the site tier (a host like chatgpt.com has dozens) and not the
          // title-only semantic hit (Google search titles overlap memory too
          // easily). The mark means "you have memory FROM this page"; the
          // panel shows the softer tiers.
          //
          // NO BADGE. Chrome's badge is a fixed-size overlay — even a single
          // "1" ate a third of the 16px icon (Chad's screenshot, 2026-08-17).
          // Instead the ICON itself gets a small corner dot, drawn at runtime
          // from our own artwork, and the count rides on the hover tooltip.
          const n = (r && ((r.exact | 0) + (r.pageDocs | 0))) || 0;
          markIconForTab(tabId, n, r && r.label);
        });
        try { ws.send(JSON.stringify({ cmd: 'page_probe', reqId, url: t.url, title: t.title || '' })); }
        catch (_) { pendingProbes.delete(reqId); }
      });
    });
  } catch (_) { /* ignore */ }
}
// The icon as the signal. Chrome's text badge is a fixed-size overlay that ate
// the 16px icon (Chad's screenshot, 2026-08-17), so this lane never sets one.
// Instead the ICON is redrawn per tab from our own artwork on a transparent
// OffscreenCanvas (available in the MV3 worker; the source is the packaged
// icon, fetched at its own extension URL — no web_accessible_resources).
//
// MARK_MODE — how a tab whose page has memory FROM it is shown (Chad, 2026-08-17,
// after trying all three):
//   'green' — the icon is drawn GREEN instead of blue. Steady, no motion, no
//             overlay; "green = you have memory from this page". Chad's pick.
//   'dot'   — the normal icon with a small green bottom-right dot.
//   'pulse' — three fades (~1.8 s) then the normal icon.
// Pages with nothing get the normal (blue) icon. The count is in the tooltip.
const MARK_MODE = 'green';
const MARK_GREEN = '#10B981';                          // the panel's "saved" green
const iconFrameCache = new Map(); // `${size}|${alpha}|${variant}` → ImageData
async function iconFrame(size, alpha, variant) {
  const key = size + '|' + alpha + '|' + variant;
  const hit = iconFrameCache.get(key);
  if (hit) return hit;
  const src = size > 32 ? 'icons/icon128.png' : 'icons/icon48.png';
  const blob = await (await fetch(chrome.runtime.getURL(src))).blob();
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(size, size);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);                     // transparent — no backing box
  ctx.globalAlpha = alpha;
  ctx.drawImage(bmp, 0, 0, size, size);
  ctx.globalAlpha = 1;
  if (variant === 'green') {
    // Recolour ONLY the blue pixels: hue-shift blue → green per pixel, keeping
    // saturation and lightness. A flat source-atop fill painted over the
    // icon's white details too — "the green icon is missing its eyes" (Chad,
    // 2026-08-17). Whites, greys and edge alpha are untouched.
    const img = ctx.getImageData(0, 0, size, size);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (a === 0) continue;
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const l = (max + min) / 2;
      const delta = max - min;
      if (delta < 0.08) continue;                        // grey/white — leave alone
      const sat = delta / (1 - Math.abs(2 * l - 1) || 1);
      let h;
      if (max === r) h = ((g - b) / delta) % 6;
      else if (max === g) h = (b - r) / delta + 2;
      else h = (r - g) / delta + 4;
      h = (h * 60 + 360) % 360;
      if (h < 190 || h > 260) continue;                  // not the brand blue — leave alone
      const nh = 158;                                    // #10B981's hue
      const c1 = (1 - Math.abs(2 * l - 1)) * sat;
      const x = c1 * (1 - Math.abs(((nh / 60) % 2) - 1));
      const m = l - c1 / 2;
      let rr, gg, bb;
      const hs = nh / 60;
      if (hs < 1) { rr = c1; gg = x; bb = 0; } else if (hs < 2) { rr = x; gg = c1; bb = 0; }
      else if (hs < 3) { rr = 0; gg = c1; bb = x; } else if (hs < 4) { rr = 0; gg = x; bb = c1; }
      else if (hs < 5) { rr = x; gg = 0; bb = c1; } else { rr = c1; gg = 0; bb = x; }
      d[i] = Math.round((rr + m) * 255); d[i + 1] = Math.round((gg + m) * 255); d[i + 2] = Math.round((bb + m) * 255);
    }
    ctx.putImageData(img, 0, 0);
  } else if (variant === 'dot') {
    const r = Math.max(2, Math.round(size * 0.17));    // 16 → 3px, 32 → 5px
    const cx = size - r - 1, cy = size - r - 1;
    ctx.beginPath(); ctx.arc(cx, cy, r + Math.max(1, size / 16), 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = MARK_GREEN; ctx.fill();
  }
  const data = ctx.getImageData(0, 0, size, size);
  iconFrameCache.set(key, data);
  return data;
}
async function setIconFrame(tabId, alpha, variant) {
  const [i16, i32] = await Promise.all([iconFrame(16, alpha, variant), iconFrame(32, alpha, variant)]);
  await chrome.action?.setIcon({ tabId, imageData: { 16: i16, 32: i32 } });
}
const PLAIN_ICON = { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };
const markTokens = new Map(); // tabId → token, so a newer probe cancels an older pulse
async function markIconForTab(tabId, n, label) {
  try {
    const token = Date.now() + Math.random();
    markTokens.set(tabId, token);
    // Belt: this lane never leaves a text badge behind (older builds set one).
    chrome.action?.setBadgeText({ tabId, text: '' });
    if (n <= 0) {
      await chrome.action?.setIcon({ tabId, path: PLAIN_ICON });
      await chrome.action?.setTitle({ tabId, title: 'Vodou Bridge' });
      return;
    }
    await chrome.action?.setTitle({ tabId, title: `Vodou — ${n} ${n === 1 ? 'memory' : 'memories'} from this page${label ? ' · ' + label : ''}` });
    if (MARK_MODE === 'green') { await setIconFrame(tabId, 1, 'green'); return; }
    if (MARK_MODE === 'dot') { await setIconFrame(tabId, 1, 'dot'); return; }
    // 'pulse': 1 → 0.3 → 1, three times, then rest on the normal icon.
    const frames = [1, 0.75, 0.5, 0.3, 0.5, 0.75, 1];
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const a of frames) {
        if (markTokens.get(tabId) !== token) return;     // superseded (tab moved on)
        await setIconFrame(tabId, a, 'plain');
        await new Promise((r) => setTimeout(r, 85));
      }
    }
    if (markTokens.get(tabId) === token) await chrome.action?.setIcon({ tabId, path: PLAIN_ICON });
  } catch (_) { /* action API unavailable, or the tab closed mid-flight */ }
}
// Turning page memory off clears every mark this lane set; on re-probes.
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local' || !(PAGE_MEM_KEY in ch)) return;
  lastProbeKey = '';
  if (ch[PAGE_MEM_KEY].newValue === true) { probeActiveTab(); return; }
  try {
    chrome.tabs.query({}, (tabs) => {
      for (const t of tabs || []) { try { markIconForTab(t.id, 0, ''); } catch (_) {} }
    });
  } catch (_) {}
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
      // PLAN-DOCUMENT-LIBRARY §3.7.1 Lane A — "Add to Library" by URL.
      //
      // Adds ZERO permissions. We never read the page: the URL is already ours
      // from the click info, and localhost does the fetch and extraction. That
      // also covers Chrome's built-in PDF viewer, whose contents a content
      // script cannot read anyway — don't scrape the viewer, hand over the URL.
      //
      // 'link' so you can file a document you haven't opened; 'page' so you can
      // file the one you are looking at.
      // ONE item per context, each doing the only sensible thing there.
      //
      // There used to be two page items — "Add to Vodou Library" (fetch the URL)
      // and "Add THIS PAGE's text" (read the DOM) — and choosing wrong produced
      // "cannot tell what kind of document this is" on any ordinary web page.
      // Which lane applies is OUR problem, not the operator's: a URL ending
      // .pdf/.docx is fetched, anything else is read. Same click either way.
      //
      // `frame` matters: Chrome renders a PDF inside its own internal extension,
      // so a right-click over the document never reports the `page` context.
      chrome.contextMenus.create({
        id: 'vodou-add-page',
        title: 'Add this page to Vodou Library',
        contexts: ['page', 'frame', 'selection', 'image'],
      });
      chrome.contextMenus.create({
        id: 'vodou-add-link',
        title: 'Add linked file to Vodou Library',
        contexts: ['link'],
      });
      // PLAN-MEMORY-ON-EVERY-PAGE P6 — fill the form on this page from memory.
      // The click grants activeTab for that tab; the form MODEL (labels, not
      // values) is read once and shown in the panel for review. Never submits.
      chrome.contextMenus.create({
        id: 'vodou-fill-form',
        title: 'Fill this form from Vodou',
        contexts: ['page', 'editable', 'frame'],
      });
    });
  } catch (_) { /* contextMenus unavailable — non-fatal */ }
}

/**
 * POST a URL to the local gateway for ingestion. Fire-and-report: the operator
 * gets one notification either way, because an ingest that silently failed looks
 * exactly like one that silently succeeded.
 */
// The "your app is too old" wording used to live here as libraryError(), with the
// Library's name baked into it. It moved to gateway-errors.js the moment a second
// surface needed the same sentence — see that file for why a 404 means what it
// means, and for the precondition on which routes may use it.

/** The gateway as an http origin. The socket URL is the one configured place. */
function gatewayHttpBase() {
  return (userGatewayUrl || DEFAULT_GATEWAY_URLS[0])
    .replace(/^ws/, 'http')
    .replace(/\/api\/vbb.*$/, '');
}

async function addUrlToLibrary(url, tabId) {
  pendingLibrary(tabId, 'Adding to Vodou Library\u2026');
  const base = gatewayHttpBase();
  try {
    const res = await fetch(base + '/api/library/url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || ('HTTP ' + res.status));
      err.httpStatus = res.status;
      throw err;
    }
    const line = String(data.output || url).split('\n')[0].trim();
    notifyLibrary('Added to Vodou Library', line);
    toastInTab(tabId, 'Added to Vodou Library — ' + line, 'ok',
      data.id ? base + '/library/#' + data.id : '');
  } catch (e) {
    // Named plainly: the common causes are "gateway is down" and "that URL is
    // not a document", and the operator can act on either.
    const why = await globalThis.VodouGatewayError.describe(
      e, e && e.httpStatus, 'the Library', base);
    notifyLibrary('Could not add to Library', why, false);
    toastInTab(tabId, 'Could not add to Library — ' + why, 'err');
  }
}

/**
 * Lane B — read the ACTIVE TAB on a gesture and file its text.
 *
 * `activeTab` is granted by the user's click on our menu item, covers only that
 * tab, and lapses on navigation. No host permission, no content script left
 * running, nothing read that the operator did not just ask us to read.
 *
 * The extraction runs in the page and returns a string; the page text is posted
 * straight to localhost and is never stored by the extension itself.
 */
// P6 — read the form model (healing content.js in first if the page has never
// seen it — the gesture covers that), ask the gateway for a plan, and hand
// both to the panel. The panel owns review + apply.
let lastFillPlan = null;   // { tabId, model, plan, at } — the panel pulls it on open
// opts.autoApply — the HOTKEY path (Chad, 2026-08-18: "control b doesn't auto
// fill in the form"). A form under the cursor + an explicit gesture = fill the
// EMPTY fields with what memory answers (≥50% confidence), right away, and
// keep the card up for edits and learn-back. Never overwrites a value the user
// typed, never touches a field the page model excluded, never submits. The
// context-menu / panel path stays review-first (autoApply off).
async function fillFormFromMemory(tab, opts) {
  const autoApply = !!(opts && opts.autoApply);
  const tabId = tab.id;
  const applied = new Set();
  const applyNow = async (model, plan) => {
    if (!autoApply || !plan || !Array.isArray(plan.proposals)) return;
    const empty = new Map(model.fields.filter((f) => !f.hasValue).map((f) => [f.id, f]));
    const items = plan.proposals
      .filter((p) => p && p.id && !applied.has(p.id) && empty.has(p.id) && String(p.value || '').trim() && (p.confidence || 0) >= 0.5)
      .map((p) => ({ id: p.id, sel: empty.get(p.id).sel, value: String(p.value) }));
    if (!items.length) return;
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'vodou_apply_fields', items });
      // applyFields answers { ok, applied: <count>, failed: [{id, why}] }.
      const failedIds = new Set(((r && r.failed) || []).map((f) => f && f.id).filter(Boolean));
      const okIds = r ? items.map((i) => i.id).filter((id) => !failedIds.has(id)) : [];
      okIds.forEach((id) => applied.add(id));
      console.log('[fill] auto-applied', okIds.length, 'of', items.length, 'proposals');
      if (okIds.length) notify({ applied: [...applied] });
      if (okIds.length) toastInTab(tabId, 'Filled ' + okIds.length + ' field' + (okIds.length === 1 ? '' : 's') + ' from your Vodou memory \u2014 review or edit in the panel; nothing was submitted', 'ok');
    } catch (e) { console.warn('[fill] auto-apply failed:', e && e.message); }
  };
  const ask = () => chrome.tabs.sendMessage(tabId, { type: 'vodou_read_form' });
  let r;
  try { r = await ask(); }
  catch (_) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['sites.js', 'content.js'] });
    r = await ask();
  }
  const notify = (payload) => { try { chrome.runtime.sendMessage(Object.assign({ type: 'fill_plan', tabId }, payload), () => { void chrome.runtime.lastError; }); } catch (_) {} };
  if (!r || !r.ok || !r.model || !r.model.fields || !r.model.fields.length) {
    lastFillPlan = { tabId, at: Date.now(), error: 'No fillable form fields on this page' };
    notify({ error: 'No fillable form fields on this page' });
    return;
  }
  const model = r.model;
  console.log('[fill] model:', model.fields.length, 'fields on', model.url);
  notify({ pending: true, model: { url: model.url, title: model.title, fields: model.fields } });
  const body = (noLlm) => JSON.stringify({ url: model.url, title: model.title, noLlm,
    fields: model.fields.map((f) => ({ id: f.id, label: f.label, name: f.name, type: f.type, autocomplete: f.autocomplete, placeholder: f.placeholder, required: f.required, options: f.options, multiline: f.multiline })) });
  const askPlan = async (noLlm) => {
    const res = await fetch(gatewayHttpBase() + '/api/page-match/fill-plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(noLlm) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data;
  };
  // Two phases (Chad, 2026-08-18: "asking your memory… takes a LONG time"):
  //  1. instant — learn-back + deterministic identity, no model; shown at once;
  //  2. the model for whatever is left, merged into the card when it arrives.
  // If phase 1 answered every field, phase 2 is skipped entirely.
  try {
    const first = await askPlan(true);
    console.log('[fill] phase 1:', (first.proposals || []).length, 'of', model.fields.length);
    const answered = new Set((first.proposals || []).map((p) => p.id));
    const allDone = model.fields.every((f) => answered.has(f.id) || f.hasValue);
    lastFillPlan = { tabId, at: Date.now(), model, plan: first, pending: !allDone };
    notify({ model, plan: first, pending: !allDone });
    await applyNow(model, first);
    if (allDone) return;
    const full = await askPlan(false);
    console.log('[fill] phase 2:', (full.proposals || []).length, 'proposals, askedLlm', full.askedLlm);
    // Merge: phase-1 answers stay authoritative; the model fills the rest.
    const merged = Object.assign({}, full, { proposals: [...(first.proposals || []), ...(full.proposals || []).filter((p) => !answered.has(p.id))] });
    lastFillPlan = { tabId, at: Date.now(), model, plan: merged };
    notify({ model, plan: merged, phase2: true });
    await applyNow(model, merged);
  } catch (e) {
    const why = (e && e.message) || 'Vodou not reachable';
    if (lastFillPlan && lastFillPlan.tabId === tabId && lastFillPlan.plan) { notify({ model, plan: lastFillPlan.plan, note: why }); return; }
    lastFillPlan = { tabId, at: Date.now(), model, error: why };
    notify({ model, error: why });
  }
}

async function addPageTextToLibrary(tab) {
  if (!tab?.id) { console.warn('[library] add-page: no tab id in the click — nothing read'); return { ok: false, why: 'no tab' }; }
  console.log('[library] add-page: reading tab', tab.id, tab.url || '');

  // Google Workspace: tell the operator the route that WORKS, immediately.
  //
  // Docs renders to a canvas so the DOM holds only menus, and every attempt to
  // read the export endpoint failed — from the page (cross-origin redirect) and
  // from the worker (host permission, then still Failed to fetch). Rather than
  // ask for a permission that does not deliver, or file a page of menus, this
  // says the one thing that does work. `File → Download` costs two clicks and
  // has no failure modes.
  if (/^https:\/\/docs\.google\.com\/(document|spreadsheets|presentation)\/d\//.test(tab.url || '')) {
    const cmd = './vodou-core mem library add ~/Downloads/<name>.txt';
    const msg = "Google Docs can't be read from the browser yet.\n\n" +
      'File → Download → Plain text (.txt), then run:\n' + cmd;
    notifyLibrary('Use File → Download for Google Docs', msg, false);
    toastInTab(tab.id, msg, 'err', '', cmd);
    return { ok: false, why: 'Google Docs cannot be read from the browser — File → Download instead' };
  }

  // Before the page read AND before the upload — the read itself is
  // instant, but extraction, embedding and the card call are not.
  pendingLibrary(tab.id, 'Reading this page for Vodou\u2026');
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const host = location.hostname;

        // ── Google Workspace: the document is NOT in the DOM ────────────────
        //
        // Docs/Slides render to a CANVAS, so innerText can only ever return the
        // app shell — menus, the font list, every language name. Filed once and
        // it looked like a resume had been captured when nothing had.
        //
        // The export endpoint returns the real thing, and fetching it from the
        // PAGE context means it rides the user's own session cookies. localhost
        // cannot do this; the extension can only do it because the user just
        // asked it to, on this tab.
        const gsuite = location.pathname.match(/^\/(document|spreadsheets|presentation)\/d\/([\w-]+)/);
        if (host === 'docs.google.com' && gsuite) {
          // Identify only. The export endpoint redirects to another Google host,
          // and a page-context fetch cannot follow that (CORS) — "Failed to
          // fetch". The service worker can, using the activeTab grant this very
          // click produced.
          return {
            title: (document.title || '').replace(/ - Google (Docs|Sheets|Slides)$/, '').trim(),
            url: location.href,
            text: '',
            via: 'gsuite',
            gsuite: { kind: gsuite[1], id: gsuite[2], tab: new URLSearchParams(location.search).get('tab') || '' },
          };
        }

        // ── Ordinary pages ──────────────────────────────────────────────────
        const el = document.querySelector('main, article, [role="main"], .doc-content') || document.body;
        const clone = el.cloneNode(true);
        // Strip the furniture. Without this a site's nav and mega-footer become
        // "content" and the card ends up describing a menu. `[role=button]`
        // matters for app-style pages: Notion's toolbar is divs, not <button>,
        // so it survived the tag list and landed in the document as
        // "View siteSite settingsAdd iconAdd cover".
        // Attach FIRST, then strip using computed layout.
        //
        // `innerText` on a DETACHED node degrades to `textContent` — no layout,
        // so no line breaks between blocks ("3 steps1. InstallVodou runs...").
        // Attaching also lets us ask what is actually BLOCK-level.
        clone.style.cssText = 'position:absolute;left:-99999px;top:0;width:800px';
        document.body.appendChild(clone);

        let text = '';
        try {
          const SEL =
            'script, style, noscript, nav, header, footer, aside, form, button, select, ' +
            '[role="navigation"], [role="banner"], [role="contentinfo"], [role="menu"], ' +
            '[role="menubar"], [role="toolbar"], [role="tablist"], [role="dialog"], [role="button"]';
          clone.querySelectorAll(SEL).forEach((n) => {
            // ONLY remove block-level furniture. An INLINE match sits inside a
            // sentence, and deleting it eats characters mid-word — measured on a
            // real Notion page: "notion.site" stored as ".ion.site", "smarter" as
            // "ter". Silent, and worse than missing text because the document
            // still looks complete.
            const tag = n.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') { n.remove(); return; }
            let d = '';
            try { d = getComputedStyle(n).display; } catch (_) { d = ''; }
            if (d && !d.startsWith('inline') && d !== 'contents') n.remove();
          });
          text = (clone.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
        } finally {
          clone.remove();
        }

        // Strip a leading unread-count like "(1) " that apps put in the title.
        const title = (document.title || '').replace(/^\(\d+\)\s*/, '').trim();
        return { title, url: location.href, text, via: 'dom' };
      },
    });
    let payload = result?.result;
    console.log('[library] add-page: page read →', payload ? ((payload.text || '').length + ' chars via ' + payload.via) : 'no payload');

    if (payload && payload.via === 'gsuite-export-failed') {
      // Be specific. The generic "too little text" would send the user to wait
      // for the page to load, when the real fix is access or a sign-in.
      const msg = 'Could not export this Google file (' + (payload.why || 'unknown') +
        ') — check you have access, or use File → Download instead.';
      notifyLibrary('Could not add page', msg, false);
      toastInTab(tab.id, msg, 'err');
      return { ok: false, why: msg };
    }
    if (!payload || !payload.text || payload.text.length < 200) {
      // Named honestly: the usual cause is a page that had not finished
      // rendering, and the fix is "try again", not "file an empty document".
      notifyLibrary('Nothing to add', 'That page had too little text to file — let it finish loading and try again.', false);
      toastInTab(tab.id, 'Nothing to add — that page had too little text to file.', 'err');
      return { ok: false, why: 'too little text on the page to file (under 200 characters)' };
    }
    // Chrome-detector. A canvas-rendered app or a nav-heavy page yields text made
    // of menu labels: hundreds of very short lines and almost no sentences. Filing
    // that produces a document that LOOKS captured and contains nothing — the
    // worst outcome, because nobody goes back to check. Refusing is correct.
    if (payload.via === 'dom') {
      const lines = payload.text.split('\n').map((l) => l.trim()).filter(Boolean);
      const sentences = (payload.text.match(/[.!?]["')\]]?(\s|$)/g) || []).length;
      const shortLines = lines.filter((l) => l.length < 25).length;
      const uiShaped = lines.length > 40 && shortLines / lines.length > 0.7 && sentences < lines.length / 12;
      if (uiShaped) {
        const msg = "That looked like the page's menus rather than its content — nothing was filed.";
        notifyLibrary('Nothing to add', msg, false);
        toastInTab(tab.id, msg, 'err');
        return { ok: false, why: msg };
      }
    }
    const base = gatewayHttpBase();
    const res = await fetch(base + '/api/library/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || ('HTTP ' + res.status));
      err.httpStatus = res.status;
      throw err;
    }
    const line2 = String(data.output || payload.title).split('\n')[0].trim();
    console.log('[library] add-page: filed', res.status, data && data.id, line2);
    notifyLibrary('Added to Vodou Library', line2);
    toastInTab(tab.id, 'Added to Vodou Library — ' + line2, 'ok',
      data.id ? base + '/library/#' + data.id : '');
    return { ok: true, id: data.id, name: line2 };
  } catch (e) {
    // gatewayHttpBase() rather than `base`: that const is declared inside the try
    // above, so it does not exist in this scope.
    console.warn('[library] add-page failed:', e && (e.message || e), '| http', e && e.httpStatus);
    const why2 = await globalThis.VodouGatewayError.describe(
      e, e && e.httpStatus, 'the Library', gatewayHttpBase());
    notifyLibrary('Could not add page', why2, false);
    toastInTab(tab.id, 'Could not add page — ' + why2, 'err');
    return { ok: false, why: why2 };
  }
}

/**
 * Report a library action.
 *
 * TWO channels on purpose. A desktop notification is the nicer one, but it is
 * silently suppressible outside the browser entirely — macOS notification
 * settings, Focus, Do Not Disturb — and `chrome.notifications.create` reports
 * that failure only through `lastError` in its callback, which is easy to never
 * read. Observed 2026-08-10: a Lane A ingest that genuinely succeeded (21 chunks
 * indexed) produced no visible feedback at all, which reads as "nothing
 * happened".
 *
 * So the toolbar BADGE is the primary signal — it is drawn by Chrome, cannot be
 * turned off by the OS, and is visible exactly where the user just clicked. The
 * notification rides along when it can.
 */
/**
 * In-page toast — the only feedback channel that appears where the user is
 * actually looking.
 *
 * The badge needs the icon PINNED (Chrome hides unpinned extensions in the
 * puzzle-piece overflow, and greys the icon on sites outside host_permissions),
 * and desktop notifications need OS permission. Both can be silently off, which
 * is how a successful ingest came to look like nothing happening.
 *
 * This uses the `activeTab` grant the user's own click just produced, so it needs
 * no host permission. It cannot reach Chrome's internal PDF viewer — an
 * extension may not script another extension's pages — so PDFs still rely on the
 * badge. Best-effort by design: it never throws into the caller.
 */
/**
 * @param {'pending'|'ok'|'err'} state
 *
 * Reuses ONE element id, so the pending toast is replaced in place by the
 * result rather than stacking two. Pending never auto-dismisses on its own
 * timer — it is cleared by the outcome — because a "working…" that vanishes
 * before the work finishes is worse than no message at all. A long safety
 * timeout still clears it if the worker dies mid-flight.
 */
function toastInTab(tabId, text, state, link, copyText) {
  if (!tabId) return;
  chrome.scripting
    .executeScript({
      target: { tabId },
      args: [String(text || ''), String(state || 'ok'), link || '', copyText || ''],
      func: (msg, st, href, copy) => {
        const ID = 'vodou-library-toast';
        document.getElementById(ID)?.remove();
        const bg = st === 'err' ? '#b4322a' : '#2563EB';
        const el = document.createElement('div');
        el.id = ID;
        el.textContent = (st === 'pending' ? '⋯ ' : '') + msg;
        if (copy) {
          const b = document.createElement('button');
          b.textContent = 'Copy command';
          b.style.cssText = 'display:block;margin-top:9px;padding:5px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.45);' +
            'background:transparent;color:#fff;font:inherit;font-size:12px;cursor:pointer';
          b.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            try { await navigator.clipboard.writeText(copy); b.textContent = 'Copied ✓'; }
            catch (_) { b.textContent = 'Press ⌘C'; }
          });
          el.appendChild(b);
        }
        if (href) {
          // Land ON the document just filed, not on a list to search through.
          const a = document.createElement('a');
          a.textContent = 'Open in Library ↗';
          a.href = href;
          a.target = '_blank';
          a.rel = 'noopener';
          a.style.cssText = 'display:block;margin-top:7px;color:#fff;font-weight:600;text-decoration:underline';
          el.appendChild(a);
          el.style.cursor = 'default';
        }
        el.style.cssText = [
          'position:fixed', 'z-index:2147483647', 'top:16px', 'right:16px',
          'max-width:360px', 'padding:11px 15px', 'border-radius:10px',
          'font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
          'color:#fff', 'box-shadow:0 8px 28px rgba(0,0,0,.28)', 'white-space:pre-line',
          `background:${bg}`, 'opacity:0', 'transition:opacity .18s',
        ].join(';');
        document.documentElement.appendChild(el);
        requestAnimationFrame(() => { el.style.opacity = '1'; });
        const life = st === 'pending' ? 120000 : (copy ? 30000 : href ? 12000 : 4200);
        setTimeout(() => {
          if (!el.isConnected) return;
          el.style.opacity = '0';
          setTimeout(() => el.remove(), 300);
        }, life);
      },
    })
    .catch(() => { /* PDF viewer, chrome:// page, or tab gone — badge covers it */ });
}

/** Immediate acknowledgement, before any network or LLM work starts. */
function pendingLibrary(tabId, what) {
  try {
    chrome.action?.setBadgeBackgroundColor({ color: '#2563EB' });
    chrome.action?.setBadgeText({ text: '⋯' });
    chrome.action?.setTitle({ title: `Vodou — ${what}` });
  } catch (_) { /* action unavailable */ }
  toastInTab(tabId, what, 'pending');
}

function notifyLibrary(title, message, ok = true) {
  const badge = ok ? '✓' : '!';
  try {
    chrome.action?.setBadgeBackgroundColor({ color: ok ? '#2563EB' : '#d8443b' });
    chrome.action?.setBadgeText({ text: badge });
    chrome.action?.setTitle({ title: `${title}${message ? ' — ' + message : ''}` });
    // Clear after long enough to notice, short enough not to look like state.
    setTimeout(() => {
      try {
        chrome.action?.setBadgeText({ text: '' });
        chrome.action?.setTitle({ title: 'Vodou Bridge' });
      } catch (_) { /* worker may have been recycled — harmless */ }
    }, 8000);
  } catch (_) { /* action API unavailable — fall through to the notification */ }

  try {
    chrome.notifications?.create(
      {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title,
        message: message || '',
      },
      () => {
        // Read lastError explicitly: unread, Chrome logs nothing and the failure
        // is invisible. This is the line that would have named the problem.
        if (chrome.runtime.lastError) {
          console.warn('[library] desktop notification suppressed:', chrome.runtime.lastError.message,
            '— badge shown instead. Check macOS System Settings → Notifications → Chrome.');
        }
      },
    );
  } catch (e) {
    console.warn('[library] notification failed:', e);
  }
}
chrome.runtime.onInstalled.addListener(installContextMenu);
chrome.runtime.onStartup.addListener(installContextMenu);
installContextMenu();

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  // DIAG (kept on purpose): the Library menu items failed SILENTLY on
  // 2026-08-17 — no badge, no request, no error — and nothing in this path
  // said which step died. One line per click is cheap and names the branch.
  console.log('[library] menu click', info && info.menuItemId, '| tab', tab && tab.id, (tab && tab.url) || info.pageUrl || '(no url)');
  if (info.menuItemId === 'vodou-add-link') {
    // A link is a file reference — fetch it. We are not on that page, so
    // reading it is not an option.
    const url = info.linkUrl || '';
    if (/^https?:/i.test(url)) addUrlToLibrary(url, tab && tab.id);
    else notifyLibrary('Could not add to Library', 'Only http(s) links can be added.', false);
    return;
  }
  if (info.menuItemId === 'vodou-add-page') {
    const url = info.pageUrl || (tab && tab.url) || '';
    if (!/^https?:/i.test(url)) {
      notifyLibrary('Could not add to Library', 'Only http(s) pages can be added.', false);
      return;
    }
    // A document URL is fetched (no page read at all); anything else is read
    // from the page. `activeTab` from this very click covers the read.
    if (/\.(pdf|docx|pptx|xlsx|xlsm|xls|ods|epub|csv|tsv|md|txt)(\?|#|$)/i.test(url)) {
      addUrlToLibrary(url, tab && tab.id);
    } else {
      addPageTextToLibrary(tab);
    }
    return;
  }
  if (info.menuItemId === 'vodou-fill-form') {
    if (!tab || !tab.id) return;
    // open() first — the gesture does not survive an await (see openVodouPanel).
    openVodouPanel(tab.id, 'fill');
    fillFormFromMemory(tab).catch((e) => console.warn('[fill] failed:', e && e.message));
    return;
  }
  if (info.menuItemId !== 'vodou-save-selection') return;
  const text = (info.selectionText || '').trim();
  if (!text) return;
  let host = 'page';
  const pageUrl = info.pageUrl || tab?.url || '';
  try { host = new URL(pageUrl).hostname.replace(/^www\./, '') || 'page'; } catch (_) {}
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({
        cmd: 'capture_turn',
        lane: 'manual',
        provider: host,
        conversationId: 'clip-' + Date.now().toString(36),
        // PLAN-MEMORY-ON-EVERY-PAGE P1 — the page this was clipped FROM. The
        // gateway files it as gateway_conversations.source_url and the extractor
        // stamps the fact with it, which is what makes the clip show up under
        // "From this page" the next time the user is on that page. Live
        // 2026-08-17: two Wikipedia clips landed with source_url EMPTY because
        // this message carried no url — the panel could never find them again.
        // Tab metadata only (the URL and title of the tab the user right-clicked
        // in); the selection itself is the only page content sent.
        url: /^https?:/i.test(pageUrl) ? pageUrl : undefined,
        title: (tab && tab.title) || undefined,
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
      case 'tool_call': return await cmdToolCall(msg, reply, replyError);
      case 'tool_list': return reply({ tools: BROWSER_TOOL_CATALOGUE });
      case 'cookies_fetch': return await cmdCookiesFetch(msg, reply, replyError);
      case 'extract_builtin': return await cmdExtractBuiltin(msg, reply, replyError);
      case 'set_backfill': {
        // PLAN-HISTORY-BACKFILL — the gateway (onboarding / Sources card) can now own
        // this choice too, so it can be asked on day one instead of hiding in the
        // panel. Mirrors set_capture_armed: write the same key the panel toggle
        // writes, so both surfaces converge on one value rather than disagreeing.
        try {
          const cur = (await chrome.storage.local.get(['vodou_inject_settings']))?.vodou_inject_settings || {};
          await chrome.storage.local.set({
            vodou_inject_settings: Object.assign({}, cur, { backfill: !!msg.enabled }),
          });
        } catch (_) { /* ignore */ }
        return reply({ result: { backfill: !!msg.enabled } });
      }
      case 'set_capture_armed': {
        // PLAN-MEMORY-EVERYWHERE-FRONTEND P0 — gateway (Sources card /
        // gateway_settings) is the source of truth for web auto-capture; mirror
        // it into the local flag that inject.js/the panel consult.
        suppressArmedEcho = true;
        try { await chrome.storage.local.set({ vodou_auto_capture: !!msg.armed }); } catch (_) { /* ignore */ }
        return reply({ result: { armed: !!msg.armed } });
      }
      case 'demo_prefill': {
        // PLAN-ALPHA 11c — deliver the composed demo text (memory block +
        // question) into the target site's composer, with confirmation. Finds
        // the tab by URL pattern, self-heals the content script first (after an
        // extension reload the content script is orphaned in every open tab),
        // then asks content.js for a VERIFIED insert.
        const pattern = String(msg.url_pattern || '');
        const text = String(msg.text || '');
        if (!pattern || !text) return replyError('VALIDATION_FAILED', 'url_pattern and text required');
        const tabs = await chrome.tabs.query({ url: pattern });
        const tab = tabs.find((t) => t.active) || tabs[0];
        if (!tab?.id) return replyError('NO_TAB', `no open tab matches ${pattern}`);
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['sites.js', 'content.js'] });
        } catch (_) { /* injection refused — the sendMessage below reports it */ }
        try {
          const r = await chrome.tabs.sendMessage(tab.id, { type: 'vodou_demo_prefill', text });
          return reply({ result: { ...r, tabId: tab.id } });
        } catch (e) {
          return replyError('NO_CONTENT_SCRIPT', e?.message || 'content script did not answer');
        }
      }
      case 'set_inject_autosend': {
        // PLAN-ALPHA 11f — "keep this on for every chat?" The demo's convert:
        // one click flips auto-inject-at-submit ON, so every future ChatGPT/
        // Claude message carries memory without pressing anything. Mirrors the
        // set_capture_armed pattern: gateway is the consent surface, this just
        // applies the answer. autoSend is deliberately explicit (=== true
        // semantics in content.js) — this writes exactly that flag and nothing
        // else in the settings object.
        try {
          const { vodou_inject_settings = {} } = await chrome.storage.local.get('vodou_inject_settings');
          vodou_inject_settings.autoSend = msg.enabled === true;
          await chrome.storage.local.set({ vodou_inject_settings });
          return reply({ result: { autoSend: vodou_inject_settings.autoSend } });
        } catch (e) {
          return replyError('STORAGE_FAILED', e?.message || 'could not persist inject settings');
        }
      }
      case 'readiness_probe': {
        // PLAN-ALPHA 11b — the L2 readiness check. A WS ping is answered by
        // Chrome's network stack even when this worker is suspended, so
        // "connected" can be true while nothing here runs. THIS reply is
        // composed in JS — receiving it proves the worker executed code just
        // now — and carries the capabilities the first-run demo tiers on:
        // side_panel (Tier A vs B) and icon_pinned (an unpinned icon hides the
        // badge in the puzzle menu, killing beat 3's return lure).
        let iconPinned = null;
        try {
          const us = await chrome.action.getUserSettings();
          iconPinned = typeof us?.isOnToolbar === 'boolean' ? us.isOnToolbar : null;
        } catch (_) { /* API absent (< Chrome 91) — report unknown, never guess */ }
        return reply({ result: {
          version: chrome.runtime.getManifest().version,
          side_panel: !!chrome.sidePanel,
          icon_pinned: iconPinned,
          answered_at: Date.now(),
        } });
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

// ---------- PLAN-MEMORY-ON-EVERY-PAGE P7 — the browser as a tool catalogue ----------
// The brain, skills and `./vodou-core call vodou-browser …` reach the page
// through a FIXED set of packaged tools called with parameters only — the
// CWS-legal replacement for `act_in_tab`, which shipped script strings from
// the gateway (remotely hosted code) and is UNSUPPORTED in this build. Every
// page tool: (1) resolves the tab (active by default), (2) refuses when the
// site's page-memory mode is `off`, (3) needs our content script — present on
// the declared AI hosts, on sites the user enabled (P5), and on any tab a
// gesture opened; otherwise it fails with the instruction, never widening
// access on its own, (4) writes a receipt to the Activity tab. Nothing here
// submits forms, clicks buttons, or navigates except tabs_open/tabs_activate,
// which the user sees happen.
const BROWSER_TOOL_CATALOGUE = [
  { name: 'tabs_list', description: 'List open http(s) tabs (id, url, title, active).', inputSchema: { type: 'object', properties: {} } },
  { name: 'tabs_open', description: 'Open a URL in a new tab and return its id.', inputSchema: { type: 'object', properties: { url: { type: 'string' }, active: { type: 'boolean' } }, required: ['url'] } },
  { name: 'tabs_activate', description: 'Bring a tab to the front.', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] } },
  { name: 'page_read', description: "The readable text of a page (active tab unless tabId). Same reader as 'Add this page to Vodou Library'.", inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, maxChars: { type: 'number' } } } },
  { name: 'page_model', description: 'The form model of a page: fillable fields with id, label, name, type, options (never password/payment/code fields, never current values).', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } } },
  { name: 'page_insert', description: "Insert text into the page's text box (the focused editable, else the largest visible one). Never sends.", inputSchema: { type: 'object', properties: { text: { type: 'string' }, tabId: { type: 'number' } }, required: ['text'] } },
  { name: 'page_fill', description: 'Write values into fields by id/selector from page_model. Never submits.', inputSchema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, sel: { type: 'string' }, value: { type: 'string' } } } }, tabId: { type: 'number' } }, required: ['items'] } },
  { name: 'page_find', description: 'Find text on the page and scroll to it; returns whether it was found and a snippet around it.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, tabId: { type: 'number' } }, required: ['text'] } },
  { name: 'page_save', description: "File the page into the Vodou Library (same as 'Add this page to Vodou Library').", inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } } },
];
async function toolTab(args) {
  if (args && Number.isFinite(args.tabId)) { try { return await chrome.tabs.get(args.tabId); } catch (_) { return null; } }
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t || null;
}
function toolSiteMode(host) {
  return new Promise((res) => {
    const h = String(host || '').toLowerCase().replace(/^www\./, '');
    // No cache here: the gateway is the authority and a mode can be flipped by
    // any client (the 60 s typing cache is for keystrokes; a tool call is rare
    // and must see the current answer — sweep 2026-08-18: `off` did not refuse).
    fetch(gatewayHttpBase() + '/api/page-match/site-mode?host=' + encodeURIComponent(h))
      .then((r) => r.json()).then((d) => { const mode = d && d.ok && d.mode ? d.mode : 'collect'; siteModeCache.set(h, { at: Date.now(), mode, source: d && d.source }); res(mode); })
      .catch(() => res('collect'));
  });
}
async function toolPageMessage(tab, message) {
  // Content script present? Else try to place it (works only where Chrome
  // lets us: declared hosts, enabled sites, gesture-granted tabs).
  try { return await chrome.tabs.sendMessage(tab.id, message); }
  catch (_) {
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['sites.js', 'content.js'] }); }
    catch (_) { throw new Error('no access to this page — right-click Vodou on it once, or turn on "Enable Vodou on this site" in the panel'); }
    return await chrome.tabs.sendMessage(tab.id, message);
  }
}
async function runBrowserTool(tool, args) {
  args = args && typeof args === 'object' ? args : {};
  switch (tool) {
    case 'tabs_list': {
      const tabs = await chrome.tabs.query({});
      return { tabs: tabs.filter((t) => /^https?:/i.test(t.url || '')).map((t) => ({ id: t.id, url: t.url, title: t.title || '', active: !!t.active })) };
    }
    case 'tabs_open': {
      const url = String(args.url || '');
      if (!/^https?:\/\//i.test(url)) throw new Error('url must be http(s)');
      const t = await chrome.tabs.create({ url, active: args.active !== false });
      return { tabId: t.id, url };
    }
    case 'tabs_activate': {
      const t = await chrome.tabs.update(Number(args.tabId), { active: true });
      return { ok: true, tabId: t && t.id };
    }
    default: break;
  }
  // Page tools.
  const tab = await toolTab(args);
  if (!tab || !tab.id || !/^https?:/i.test(tab.url || '')) throw new Error('no http(s) tab to act on');
  let host = ''; try { host = new URL(tab.url).hostname; } catch (_) {}
  const mode = await toolSiteMode(host);
  if (mode === 'off') throw new Error(`page memory is off for ${host} — Vodou does not look at this site`);
  switch (tool) {
    case 'page_read': {
      const [exec] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPageSafely }).catch(() => [null]);
      if (!exec || !exec.result) throw new Error('no access to this page — right-click Vodou on it once, or turn on "Enable Vodou on this site" in the panel');
      const max = Math.min(Math.max(Number(args.maxChars) || 20000, 500), 200000);
      return { url: tab.url, title: tab.title || '', text: String(exec.result.text || '').slice(0, max) };
    }
    case 'page_model': {
      const r = await toolPageMessage(tab, { type: 'vodou_read_form' });
      if (!r || !r.ok) throw new Error((r && r.error) || 'could not read the form');
      return { url: r.model.url, title: r.model.title, fields: r.model.fields };
    }
    case 'page_insert': {
      const text = String(args.text || '');
      if (!text.trim()) throw new Error('text is required');
      const r = await toolPageMessage(tab, { type: 'vodou_panel_insert', items: [text] });
      if (!r || !r.ok) throw new Error((r && r.error) || 'the page refused the insert');
      return { ok: true, chars: text.length };
    }
    case 'page_fill': {
      const items = Array.isArray(args.items) ? args.items.slice(0, 60) : [];
      if (!items.length) throw new Error('items is required');
      const r = await toolPageMessage(tab, { type: 'vodou_apply_fields', items });
      return { applied: (r && r.applied) || 0, failed: (r && r.failed) || [] };
    }
    case 'page_find': {
      const r = await toolPageMessage(tab, { type: 'vodou_page_find', text: String(args.text || '') });
      return r || { found: false };
    }
    case 'page_save': {
      const r = await addPageTextToLibrary(tab);
      if (!r || !r.ok) throw new Error((r && r.why) || 'could not file the page');
      return { ok: true, url: tab.url, id: r.id, name: r.name };
    }
    default:
      throw new Error('unknown tool: ' + tool);
  }
}
async function cmdToolCall(msg, reply, replyError) {
  const tool = String(msg.tool || '');
  const t0 = Date.now();
  let host = '';
  try {
    const result = await runBrowserTool(tool, msg.args);
    try { const tab = await toolTab(msg.args || {}); host = tab && tab.url ? new URL(tab.url).hostname : ''; } catch (_) {}
    logActivity({ kind: 'tool', tool, host, ok: true, ms: Date.now() - t0, at: Date.now() });
    reply({ result });
  } catch (e) {
    logActivity({ kind: 'tool', tool, host, ok: false, error: String(e && e.message || e).slice(0, 160), ms: Date.now() - t0, at: Date.now() });
    replyError('TOOL_FAILED', String(e && e.message || e));
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

// PLAN-CONSOLE-TWO §4.5.2 — pending title_probe callbacks (same reqId pattern).
// The LRU/TTL live gateway-side (title-probe.ts); this is transport only.
const pendingProbes = new Map();
function resolveProbe(msg) {
  const cb = pendingProbes.get(msg.reqId);
  if (cb) { pendingProbes.delete(msg.reqId); cb(msg); }
}

// PLAN-CONSOLE-TWO §6.1 — on-demand page reader for the panel's `Use`.
// Injected via executeScript: closes over nothing. Strips what must never
// leave the page: input/textarea values, password fields, and the element the
// user is actively typing in. Same-document only (no cross-frame slurp).
function readPageSafely() {
  try {
    const active = document.activeElement;
    const clone = document.body ? document.body.cloneNode(true) : null;
    if (!clone) return { text: '' };
    for (const el of clone.querySelectorAll('input, textarea, select, [contenteditable]')) {
      el.replaceWith(el.ownerDocument.createTextNode(''));
    }
    for (const el of clone.querySelectorAll('script, style, noscript')) el.remove();
    void active; // the live activeElement never entered the clone; kept for clarity
    const text = (clone.innerText || clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    return { text: text.slice(0, 20000) };
  } catch (e) {
    return { text: '', error: String((e && e.message) || e) };
  }
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
  if (port.name === 'vodou-two') {
    // PLAN-CONSOLE-TWO §5.2 — Console Two page-lane relay. Chat does NOT pass
    // through here (the framed shell speaks the web-chat WS itself); this port
    // carries only what needs chrome.* APIs.
    port.onMessage.addListener(async (m) => {
      const reply = (payload) => { try { port.postMessage({ ...payload, reqId: m.reqId }); } catch { /* port gone */ } };
      try {
        if (m && m.type === 'page_meta') {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (!tab || !tab.url || !/^https?:/.test(tab.url)) { reply({ cmd: 'page_meta_result' }); return; }
          const host = (() => { try { return new URL(tab.url).hostname; } catch { return ''; } })();
          const site = (globalThis.VODOU_SITES || []).find((s) => s.host && s.host.test(host));
          const { vodou_auto_capture } = await chrome.storage.local.get(['vodou_auto_capture']);
          // §4.5.2 — the anticipation dot: metadata-only probe, cached gateway-side.
          let probe = null;
          if (ws && ws.readyState === WebSocket.OPEN && tab.title) {
            probe = await new Promise((resolve) => {
              const reqId = 'tp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
              pendingProbes.set(reqId, resolve);
              try { ws.send(JSON.stringify({ cmd: 'title_probe', reqId, host, title: tab.title })); }
              catch { pendingProbes.delete(reqId); resolve(null); }
              setTimeout(() => { if (pendingProbes.has(reqId)) { pendingProbes.delete(reqId); resolve(null); } }, 3000);
            });
          }
          reply({
            cmd: 'page_meta_result',
            url: tab.url,
            title: tab.title || '',
            favIconUrl: tab.favIconUrl || '',
            siteKey: site ? site.key : null,
            // §6.1 rule 5 — Save defers where the capture lane already writes.
            autoCaptured: !!(site && vodou_auto_capture),
            probe: probe && probe.hit ? { hit: true, label: probe.label || '' } : null,
          });
          return;
        }
        if (m && m.type === 'page_read') {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (!tab || !tab.id || !/^https?:/.test(tab.url || '')) { reply({ cmd: 'page_read_result', text: '' }); return; }
          const [exec] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPageSafely });
          reply({ cmd: 'page_read_result', url: tab.url, title: tab.title || '', text: (exec && exec.result && exec.result.text) || '' });
          return;
        }
        if (m && m.type === 'page_save') {
          // The EXISTING manual-capture lane — same handler the in-page Save
          // button uses (idempotent, lands under import:<src>:<uuid>).
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (!tab || !tab.url) { reply({ cmd: 'page_save_result', ok: false, error: 'no active tab' }); return; }
          const host = (() => { try { return new URL(tab.url).hostname; } catch { return ''; } })();
          const site = (globalThis.VODOU_SITES || []).find((s) => s.host && s.host.test(host));
          if (!site) { reply({ cmd: 'page_save_result', ok: false, error: 'Save works on chat sites for now' }); return; }
          if (!ws || ws.readyState !== WebSocket.OPEN) { reply({ cmd: 'page_save_result', ok: false, error: 'Vodou not connected' }); return; }
          const reqId = 'cap_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          pendingCaptures.set(reqId, (resp) => reply({ cmd: 'page_save_result', ok: !!(resp && resp.ok), error: resp && resp.error }));
          try {
            ws.send(JSON.stringify({ cmd: 'capture_request', reqId, url: tab.url, source: site.capture || null, site: site.key || null, extract: 'background' }));
          } catch (e) {
            pendingCaptures.delete(reqId);
            reply({ cmd: 'page_save_result', ok: false, error: String((e && e.message) || e) });
          }
          setTimeout(() => { if (pendingCaptures.has(reqId)) { pendingCaptures.get(reqId)({ ok: false, error: 'timed out' }); pendingCaptures.delete(reqId); } }, 60000);
          return;
        }
        if (m && m.type === 'ext_settings_get') {
          // PLAN-CONSOLE-TWO §10 Q2 — the native Extension section. These keys
          // live in chrome.storage.local and are writable ONLY from extension
          // context; the shell renders them via this relay. sidepanelUrl lets
          // the shell link "All site settings" at the legacy panel page.
          const st = await chrome.storage.local.get(['vodou_auto_capture', 'vodou_inject_settings']);
          const inj = st.vodou_inject_settings || {};
          reply({
            cmd: 'ext_settings_result',
            autoCapture: !!st.vodou_auto_capture,
            injectMaster: inj.master !== false,      // default-on, matching the panel
            brain: inj.brain === true,               // default-off (sends on your behalf)
            autoSend: inj.autoSend === true,         // default-off
            sidepanelUrl: chrome.runtime.getURL('sidepanel.html'),
          });
          return;
        }
        if (m && m.type === 'ext_settings_set') {
          // Allowlisted keys only; same merge semantics as the panel's
          // simpleToggle (never clobber sites{} or unknown keys).
          const k = String(m.key || '');
          const val = !!m.value;
          if (k === 'autoCapture') {
            await chrome.storage.local.set({ vodou_auto_capture: val });
          } else if (k === 'injectMaster' || k === 'brain' || k === 'autoSend') {
            const { vodou_inject_settings } = await chrome.storage.local.get(['vodou_inject_settings']);
            const raw = vodou_inject_settings || {};
            const storageKey = k === 'injectMaster' ? 'master' : k;
            await chrome.storage.local.set({ vodou_inject_settings: Object.assign({}, raw, { [storageKey]: val }) });
          } else {
            reply({ cmd: 'ext_settings_result', ok: false, error: 'unknown key' });
            return;
          }
          reply({ cmd: 'ext_settings_result', ok: true });
          return;
        }
      } catch (e) {
        reply({ cmd: 'relay_error', error: String((e && e.message) || e) });
      }
    });
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
  if (msg?.type === 'site_enable') { enableSite(msg.host).then(sendResponse); return true; }
  if (msg?.type === 'site_disable') { disableSite(msg.host).then(sendResponse); return true; }
  if (msg?.type === 'site_list') { enabledSites().then((hosts) => sendResponse({ ok: true, hosts })); return true; }
  if (msg?.type === 'site_capture_turn') {
    // P5 — opt-in per site: what the user WROTE on an enabled site (a submitted
    // textarea/composer), filed like a right-click clip with the page stamped.
    // The gate (per-site toggle) is checked in the content script AND here.
    const host = String(msg.host || '').toLowerCase().replace(/^www\./, '');
    const text = String(msg.text || '').trim();
    if (!host || !text) { sendResponse({ ok: false }); return true; }
    chrome.storage.local.get(['vodou_site_capture'], (v) => {
      const on = !!(v && v.vodou_site_capture && v.vodou_site_capture[host]);
      if (!on || !ws || ws.readyState !== WebSocket.OPEN) { sendResponse({ ok: false, reason: on ? 'not connected' : 'capture off for this site' }); return; }
      try {
        ws.send(JSON.stringify({ cmd: 'capture_turn', lane: 'manual', provider: host, conversationId: 'site-' + Date.now().toString(36),
          url: /^https?:/i.test(String(msg.url || '')) ? String(msg.url) : undefined, title: msg.title || undefined,
          turns: [{ role: 'user', content: text.slice(0, 20000) }] }));
        logActivity({ kind: 'capture', mode: 'site', host, chars: text.length, at: Date.now() });
        sendResponse({ ok: true });
      } catch (_) { sendResponse({ ok: false, reason: 'socket' }); }
    });
    return true;
  }
  if (msg?.type === 'get_fill_plan') {
    // The panel opened after the gesture — hand it the plan (or its error).
    sendResponse(lastFillPlan && Date.now() - lastFillPlan.at < 10 * 60_000 ? lastFillPlan : null);
    return true;
  }
  if (msg?.type === 'fill_this_page') {
    // Panel button. No activeTab from a panel click, so this only works where
    // content.js is already present (AI hosts, or a page a gesture healed).
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const t = tabs && tabs[0];
      if (!t || !t.id) { sendResponse({ ok: false, error: 'no active tab' }); return; }
      chrome.tabs.sendMessage(t.id, { type: 'vodou_read_form' })
        .then(() => { fillFormFromMemory(t).catch(() => {}); sendResponse({ ok: true }); })
        .catch(() => sendResponse({ ok: false, error: 'Right-click the page → “Fill this form from Vodou” (this page has not been opened by Vodou yet)' }));
    });
    return true;
  }
  if (msg?.type === 'get_site_mode') {
    // P4 — the content script's typing gate asks which mode this site is in.
    // Gateway is the authority; cached here 60 s per host so typing costs nothing.
    const host = String(msg.host || '').toLowerCase().replace(/^www\./, '');
    if (!host) { sendResponse({ ok: false, mode: 'off' }); return true; }
    const hit = siteModeCache.get(host);
    if (hit && Date.now() - hit.at < 60_000) { sendResponse({ ok: true, mode: hit.mode, source: hit.source }); return true; }
    fetch(gatewayHttpBase() + '/api/page-match/site-mode?host=' + encodeURIComponent(host))
      .then((r) => r.json())
      .then((d) => {
        const mode = d && d.ok && d.mode ? d.mode : 'collect';
        siteModeCache.set(host, { at: Date.now(), mode, source: d && d.source });
        sendResponse({ ok: true, mode, source: d && d.source });
      })
      .catch(() => sendResponse({ ok: false, mode: 'off' }));   // unreachable gateway → treat as off (read nothing)
    return true;
  }
  if (msg?.type === 'get_page_context') {
    // PLAN-MEMORY-ON-EVERY-PAGE P2 — the hotkey on a page WITHOUT a site adapter
    // asks for the memories stamped with this page (T1) and this site (T2).
    // Same consent gate as the panel: if page memory is OFF, this reads nothing
    // and says so, and the caller falls back to plain retrieval.
    const pageUrl = typeof msg.url === 'string' ? msg.url : '';
    chrome.storage.local.get(['vodou_page_memory_enabled'], async (v) => {
      if (!(v && v.vodou_page_memory_enabled === true)) { sendResponse({ ok: true, disabled: true, facts: [] }); return; }
      if (!/^https?:/i.test(pageUrl)) { sendResponse({ ok: true, facts: [] }); return; }
      try {
        const res = await fetch(gatewayHttpBase() + '/api/page-match', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: pageUrl, topK: 8 }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data || !data.ok) { sendResponse({ ok: false, error: (data && data.error) || ('HTTP ' + res.status), facts: [] }); return; }
        // Page facts first, then site facts; the content script frames them.
        const facts = [].concat(
          (data.page || []).map((r) => ({ text: r.text, tier: 'page' })),
          (data.site || []).map((r) => ({ text: r.text, tier: 'site' })),
        );
        sendResponse({ ok: true, facts, host: data.host || '', docs: (data.docs || []).map((d) => d.name) });
      } catch (e) {
        sendResponse({ ok: false, error: 'Vodou not reachable', facts: [] });
      }
    });
    return true;
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
        // PLAN-HISTORY-BACKFILL — historic transcript flag. Forwarded to the gateway
        // so its duplicate-claim can reach rows older than the live claim window;
        // carried on the queued paths too, or a batch that waits for the bridge
        // loses the flag and re-duplicates on replay.
        backfill: !!msg.backfill,
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
        // PLAN-HISTORY-BACKFILL — historic transcript flag. Forwarded to the gateway
        // so its duplicate-claim can reach rows older than the live claim window;
        // carried on the queued paths too, or a batch that waits for the bridge
        // loses the flag and re-duplicates on replay.
        backfill: !!msg.backfill,
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
        // PLAN-HISTORY-BACKFILL — historic transcript flag. Forwarded to the gateway
        // so its duplicate-claim can reach rows older than the live claim window;
        // carried on the queued paths too, or a batch that waits for the bridge
        // loses the flag and re-duplicates on replay.
        backfill: !!msg.backfill,
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
        brain_standalone: brainStandalone,
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

// ── Which panel does the icon open? (2026-08-09) ──────────────────────────────
// `sidepanel.html` is the default and stays the default while Console Two is
// being made workable. Console Two is opt-in per install via
// `vodou_console_two`, toggled from the classic panel's Settings tab.
//
// CACHED IN A MODULE VARIABLE ON PURPOSE. `chrome.sidePanel.open()` may only be
// called in response to a user gesture, and the gesture does NOT survive an
// await — so `openVodouPanel` cannot read storage on its way in. Reading it
// here, ahead of time, is what lets the choice be honoured without spending the
// gesture. Same constraint that shaped `open()`-before-`setOptions()` below.
//
// Note for anyone reading the manifest: `side_panel.default_path` barely
// matters. Every open through the toolbar icon or the keyboard command calls
// setOptions() immediately afterwards and re-points the panel, so the declared
// default only shows for the first frame, or when Chrome's own side-panel
// dropdown opens it. It was left pointing at console2.html by 7e0cdeb6 while
// this function still forced sidepanel.html — declared config and real
// behaviour disagreeing, which is how you get a "flip" that does nothing.
let useConsoleTwo = false;
function refreshPanelChoice() {
  try {
    chrome.storage.local.get(['vodou_console_two'], (v) => {
      useConsoleTwo = !!(v && v.vodou_console_two === true);
    });
  } catch (_) { /* storage unavailable — stay on the classic panel */ }
}
refreshPanelChoice();
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'vodou_console_two' in changes) {
      useConsoleTwo = changes.vodou_console_two.newValue === true;
    }
  });
} catch (_) { /* no storage events — the next SW wake re-reads it */ }

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
  const panelPage = useConsoleTwo ? 'console2.html' : 'sidepanel.html';
  chrome.sidePanel.setOptions({
    tabId,
    path: `${panelPage}?tabId=${encodeURIComponent(tabId)}&how=${encodeURIComponent(how)}`,
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
  // PLAN-DOCUMENT-LIBRARY §3.7.1 Lane B — the escape hatch for pages that own
  // their right-click.
  //
  // Google Docs calls preventDefault() on contextmenu inside its editing canvas
  // and draws its own menu, so NO extension's items can appear there. A keyboard
  // command grants `activeTab` exactly like a context-menu click does, so this
  // reaches the pages the menu cannot — which happen to be the pages Lane B
  // exists for. Ships unbound: Chrome allows only four suggested keys and all
  // four are already spoken for by shortcuts people use.
  if (command === 'fill-from-memory') {
    if (!tab || !tab.id) return;
    openVodouPanel(tab.id, 'fill');
    fillFormFromMemory(tab, { autoApply: true }).catch(() => {});
    return;
  }
  if (command === 'add-page-to-library') {
    if (tab && tab.id) { addPageTextToLibrary(tab); return; }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) addPageTextToLibrary(tabs[0]);
    });
    return;
  }

  // Registering inject-context / inject-visible as manifest commands made Chrome
  // capture Ctrl+B at browser level, which stopped the page's keydown listener from
  // ever seeing it — the hotkey went dead the moment it became discoverable. So the
  // commands must be handled here and relayed to the page.
  if (command in INJECT_COMMANDS) {
    const id = tab && tab.id;
    if (!id) { console.error('[vodou] inject command fired with no tab'); return; }
    // P6/P5 — on a page WITHOUT a site adapter the shortcut may turn into the
    // fill flow (a real form under the cursor → review card in the panel).
    // The panel must be open for that, and open() needs THIS gesture, before
    // any await — so open it now on non-AI hosts; the content script decides
    // fill-vs-insert and tells us.
    let host = '';
    try { host = new URL(tab.url || '').hostname; } catch (_) {}
    const nonAi = host && !isSupportedTabHost(host);
    if (nonAi) openVodouPanel(id, 'inject');
    chrome.tabs.sendMessage(id, { type: 'vodou_run_inject', visible: INJECT_COMMANDS[command] })
      .then((r) => { if (r && r.wantsFill && tab) fillFormFromMemory(tab, { autoApply: true }).catch(() => {}); })
      .catch(async () => {
        // Orphaned content script after an extension reload — heal and retry once,
        // same as the panel does. Otherwise Ctrl+B stays dead until a page reload.
        try {
          await chrome.scripting.executeScript({ target: { tabId: id }, files: ['sites.js', 'content.js'] });
          const r = await chrome.tabs.sendMessage(id, { type: 'vodou_run_inject', visible: INJECT_COMMANDS[command] });
          if (r && r.wantsFill && tab) fillFormFromMemory(tab, { autoApply: true }).catch(() => {});
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
  // PLAN-ALPHA 11e — the panel viewed the briefings: clear the badge, mark
  // stored items seen, tell the gateway (G5 — "noticed", not merely
  // "delivered"). Fire-and-forget toward the gateway; the badge clear is local.
  if (msg && msg.type === 'vodou_briefings_seen') {
    (async () => {
      try {
        const { vodou_briefings = [] } = await chrome.storage.local.get('vodou_briefings');
        await chrome.storage.local.set({ vodou_briefings: vodou_briefings.map((b) => ({ ...b, seen: true })) });
      } catch (_) { /* list stays unseen — badge below still clears */ }
      try { chrome.action.setBadgeText({ text: '' }); } catch (_) { /* no badge to clear */ }
      try { safeSend({ cmd: 'skill_result_seen', at: new Date().toISOString() }); } catch (_) { /* G5 lost, UX unaffected */ }
    })();
    sendResponse({ ok: true });
    return undefined;
  }
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
