/**
 * Vodou Browser Bridge — gateway-side handle to the user's Chrome extension.
 *
 * The extension establishes a WebSocket back to the gateway (see ws.ts).
 * This module exposes a BridgeApi that cards can call. When no extension
 * is connected, getBridge() returns null and cards fall back to cheerio.
 *
 * Wire protocol (v1):
 *   gateway → extension: { id, cmd: "fetch"|"extract"|"act_in_tab"|"list_tabs", ...args }
 *   extension → gateway: { id, body|matches|tabs|result, status?, headers? }
 *                        { id, error: { code, message } }
 *
 * Heartbeat (both directions):
 *   extension → gateway: { cmd: "bridge_health" } every 30s (alarm-driven).
 *   gateway → extension: { cmd: "server_heartbeat", t } every 20s — the inbound
 *     message resets Chrome's MV3 service-worker idle timer (Chrome ≥116) so the
 *     SW stays alive while connected; the extension replies with bridge_health.
 *   Silence past 75s in either direction ⇒ that side treats the socket as dead.
 */

import type { BridgeApi } from '../lenses/types.js';

interface PendingReq {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  cmd: string;
  startedAt: number;
}

// Server-driven heartbeat: an INBOUND WebSocket message resets the MV3 service
// worker's ~30s idle timer (Chrome ≥116). The extension's own 30s alarm races
// that timer and loses constantly; pushing from this side every 20s is the only
// reliable way to keep the SW — and therefore the socket — alive while connected.
const SERVER_HEARTBEAT_MS = 20_000;
// A healthy extension replies to every heartbeat (≤20s) and legacy extensions
// send bridge_health every 30s, so 75s of silence means the socket is dead even
// though TCP never delivered a close (SW killed hard, sleep/wake, etc.).
const STALE_SOCKET_MS = 75_000;

class BridgeConn {
  private ws: any | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingReq>();
  private connectedAt: number | null = null;
  private version: string | null = null;
  private browserInfo: any = null;
  /** `store` | `full` | null — from extension bridge_ready.channel */
  private channel: string | null = null;
  // PLAN-MEMORY-EVERYWHERE-FRONTEND P4 — pairing config, loaded per attach so a
  // rotated code / flipped enforcement applies to the next connection without
  // a gateway restart. Checked synchronously in the bridge_ready branch.
  private pairing: { required: boolean; token: string | null } = { required: false, token: null };
  // True once this socket passed pairing (or pairing is off). While false under
  // enforcement, EVERY inbound frame except bridge_ready is dropped — a rogue
  // extension can't skip the handshake and push capture_turn directly.
  private verified = false;
  // Last time the active socket sent us anything (bridge_ready/health/tab_changed/
  // command replies). Used to tell a healthy connection from a dead orphan.
  private lastMessageAt = 0;
  // PLAN-ROUTER-LLM Phase 4 — active-tab cache fed by `tab_changed` events.
  private activeTab: { url: string; title?: string; updated_at: number } | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  // Rejected-newcomer telemetry: a sustained reject stream means the extension
  // is loaded in a second browser/profile fighting for the single slot.
  private rejectsInWindow = 0;
  private rejectWindowStart = 0;
  private rejectOrigins = new Set<string>();

  async attach(ws: any, origin = '(unknown)'): Promise<void> {
    this.ensureLivenessLoop();
    // Anti-flap + anti-orphan (PLAN-UNIVERSAL-MEMORY). An MV3 service-worker restart
    // can leave an orphaned socket open while a fresh one connects. Two failure modes:
    //   • "newer wins" → two live SWs fight forever (flap; getBridge() ~always null).
    //   • "reject newer" (time-based) → a DEAD orphan we still think is "healthy"
    //     blocks the live new SW from ever connecting (connected at gateway, but the
    //     extension can't get in → popup shows disconnected).
    // Fix: when a newcomer arrives and we hold an OPEN socket, actively PING the
    // incumbent. If it pongs (genuinely alive) → reject the newcomer (no flap). If it
    // doesn't pong within 1.5s (dead orphan) → replace it with the newcomer.
    if (this.ws && this.ws.readyState === 1 /* OPEN */) {
      const alive = await this.pingIncumbent(1500);
      if (alive) {
        try { ws.close?.(1013 /* try again later */, 'bridge already connected'); } catch { /* ignore */ }
        // Throttled: one line per minute no matter how hard a second install hammers.
        const now = Date.now();
        this.rejectOrigins.add(origin);
        if (now - this.rejectWindowStart > 60_000) {
          if (this.rejectsInWindow > 0) {
            // Say what is MEASURED, and put the likeliest cause first. This used to
            // assert "a second extension context (incognito? another profile?)",
            // which is a guess — and on 2026-07-31 it was the wrong one, costing a
            // hunt for a duplicate install that did not exist. With one install,
            // repeated rejects from a SINGLE origin mean the incumbent is answering
            // the liveness probe while doing nothing else: a suspended MV3 worker.
            console.warn(
              `[vbb] rejected ${this.rejectsInWindow} newcomer socket(s) in the last minute from ` +
              `${[...this.rejectOrigins].join(', ')}; incumbent last spoke ` +
              `${Math.round((Date.now() - this.lastMessageAt) / 1000)}s ago. One origin = the ` +
              `same extension reconnecting (a suspended service worker holding the slot); two or ` +
              `more = a genuine second context (incognito window, another profile).`,
            );
          }
          this.rejectWindowStart = now;
          this.rejectsInWindow = 0;
          this.rejectOrigins.clear();
          this.rejectOrigins.add(origin);
        }
        this.rejectsInWindow++;
        return;
      }
      // Incumbent is unresponsive — drop it and take the newcomer.
      console.log('[vbb] incumbent unresponsive — replaced by newcomer');
      try { this.ws.close?.(1000, 'replaced (incumbent unresponsive)'); } catch { /* ignore */ }
      this.rejectAllPending(new Error('bridge reconnected'));
    }
    // Load pairing config BEFORE wiring handlers so bridge_ready can check it
    // synchronously (no command can sneak through pre-verification).
    try {
      const env = process.env.VODOU_VBB_REQUIRE_TOKEN;
      const { getSetting } = await import('../db.js');
      const required = env !== undefined && env.trim() !== ''
        ? env.trim() === '1'
        : getSetting('bridge_require_token') === '1';
      this.pairing = { required, token: required ? getSetting('bridge_token') : null };
    } catch {
      this.pairing = { required: false, token: null };
    }

    this.ws = ws;
    this.connectedAt = Date.now();
    this.lastMessageAt = Date.now();
    this.verified = !this.pairing.required;

    ws.on('message', (raw: any) => this.handleMessage(raw));
    ws.on('close', () => this.handleClose(ws));
    ws.on('error', (err: any) => {
      console.warn('[vbb] websocket error:', err?.message || err);
    });
  }

  /**
   * One process-lifetime loop that (a) pushes a server_heartbeat every 20s so
   * the extension's MV3 service worker never idles out while connected, and
   * (b) reaps sockets that have been silent past STALE_SOCKET_MS so a dead
   * orphan can't sit there reporting "connected" while every lens call burns
   * a 30s timeout.
   */
  private ensureLivenessLoop(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws) return;
      const silentFor = Date.now() - this.lastMessageAt;
      if (silentFor > STALE_SOCKET_MS) {
        console.warn(`[vbb] reaping stale bridge socket (silent ${Math.round(silentFor / 1000)}s)`);
        const sock = this.ws;
        this.ws = null;
        this.connectedAt = null;
        this.rejectAllPending(new Error('bridge connection stale'));
        try { sock.terminate?.() ?? sock.close?.(); } catch { /* ignore */ }
        return;
      }
      try { this.ws.send(JSON.stringify({ cmd: 'server_heartbeat', t: Date.now() })); } catch { /* ignore */ }
    }, SERVER_HEARTBEAT_MS);
    // Never keep the gateway process alive just for this loop.
    (this.heartbeatTimer as any)?.unref?.();
  }

  /** Resolve true if the current socket answers a WS ping within `timeoutMs`. */
  private pingIncumbent(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const inc = this.ws;
      if (!inc || inc.readyState !== 1) { resolve(false); return; }
      let done = false;
      const finish = (v: boolean) => { if (!done) { done = true; resolve(v); } };
      const t = setTimeout(() => finish(false), timeoutMs);
      try {
        // APPLICATION-level probe, not `inc.ping()`.
        //
        // A WebSocket ping/pong is an RFC 6455 control frame answered by Chrome's
        // network stack in the browser process — it never wakes, and never
        // involves, the extension's service-worker JavaScript. So a SUSPENDED OR
        // DEAD MV3 worker pongs perfectly, and the old check declared it alive.
        //
        // What that cost (measured 2026-07-31, one install, 2 hours): the worker
        // suspends, its socket lingers as a zombie that still pongs, the live
        // worker reconnects and is rejected 1013 because the zombie "answered",
        // the extension's polite-loser mode then stands by for FIVE MINUTES after
        // 3 rejects, and the zombie is only reaped once 75s of silence passes —
        // by which time the live worker is still standing by. 18 connects, 14
        // stale reaps, silences up to 806s, and not one capture_turn reaching the
        // gateway the whole time. The log blamed "a second extension context
        // (incognito? another profile?)" and sent the user hunting a duplicate
        // install that did not exist.
        //
        // server_heartbeat is the liveness contract that already exists: the
        // extension answers it with bridge_health FROM JS (background.js), so only
        // a running worker can advance lastMessageAt. Any inbound frame counts —
        // handleMessage stamps it before parsing, so an older extension that
        // replies with something else still passes.
        const before = this.lastMessageAt;
        const iv = setInterval(() => {
          if (this.lastMessageAt > before) { clearInterval(iv); clearTimeout(t); finish(true); }
        }, 50);
        const stop = () => { clearInterval(iv); clearTimeout(t); };
        setTimeout(stop, timeoutMs + 10);
        inc.send(JSON.stringify({ cmd: 'server_heartbeat', t: Date.now() }));
      } catch {
        clearTimeout(t);
        finish(false);
      }
    });
  }

  private handleMessage(raw: any): void {
    // Any inbound frame means the current socket is alive.
    this.lastMessageAt = Date.now();
    let msg: any;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch {
      return;
    }

    // Pairing gate (P4): an unverified socket may ONLY send bridge_ready.
    if (!this.verified && msg?.cmd !== 'bridge_ready') return;

    // Unsolicited messages from extension (bridge_ready, bridge_health, event push)
    if (!msg.id) {
      if (msg.cmd === 'bridge_ready') {
        // Pairing enforcement (P4): wrong/missing code → close 4403 so the
        // extension shows its pair prompt instead of retry-hammering.
        if (this.pairing.required) {
          const offered = typeof msg.token === 'string' ? msg.token.trim() : '';
          if (!this.pairing.token || offered !== this.pairing.token) {
            console.warn('[vbb] bridge_ready rejected — pairing code mismatch');
            const sock = this.ws;
            this.ws = null;
            this.connectedAt = null;
            try { sock?.close?.(4403, 'pairing required'); } catch { /* ignore */ }
            return;
          }
        }
        this.verified = true;
        this.version = msg.version || null;
        this.browserInfo = msg.browser_info || null;
        this.channel = msg.channel || (msg.store_build ? 'store' : null);
        console.log(`[vbb] bridge_ready v${this.version}`, this.channel || 'full', this.browserInfo);
        // PLAN-MEMORY-EVERYWHERE-FRONTEND P0 — the gateway (gateway_settings
        // `capture.web.armed`) is the source of truth for web auto-capture;
        // converge the extension's local checkbox on every (re)connect so the
        // Sources card and the popup can never disagree.
        syncCaptureArmedToExtension().catch(() => { /* setting/store unavailable */ });
        // Tell the extension where our sibling local UIs live so its popup can
        // link straight at them. The brain mini console runs in its own process
        // on BRAIN_PORT (start-vodou-services.sh passes it through), so the
        // extension can't derive the port — only we know it.
        try {
          // Port only, not a full URL: the extension composes the origin from
          // whatever host it dialled, so a remote/tunnelled gateway doesn't hand
          // out a link to the *viewer's* 127.0.0.1.
          const brainPort = parseInt(process.env.BRAIN_PORT || '8767', 10) || 8767;
          // `paired`: this socket passed ENFORCED pairing. False when pairing is
          // optional — connected-but-unpaired is the normal open state, and the
          // extension's panel should not claim "paired" for a check nobody ran.
          this.ws?.send(JSON.stringify({ cmd: 'server_info', brain_port: brainPort, paired: this.pairing.required }));
        } catch { /* socket race — extension falls back to the default port */ }
        return;
      }
      if (msg.cmd === 'capture_armed_changed') {
        // Popup toggle flowed the other way — persist it as the shared truth.
        import('../db.js')
          .then(({ setSetting }) => setSetting('capture.web.armed', msg.armed ? '1' : '0'))
          .catch(() => { /* ignore */ });
        return;
      }
      if (msg.cmd === 'bridge_health') {
        // Liveness credit only — lastMessageAt was already bumped above; the
        // liveness loop uses it to decide whether this socket is still alive.
        return;
      }
      if (msg.cmd === 'capture_request') {
        // PLAN-UNIVERSAL-MEMORY — the extension (in-page button / popup) asks us to
        // capture the chat it's on. Runs the same capture as POST /api/import/capture
        // but over the CSRF-exempt WS, so a chatgpt.com/claude.ai page can trigger it.
        const reqId = msg.reqId;
        const sock = this.ws;
        const api = this.api();
        import('../api/memory-import.js')
          .then(({ captureFromBridge }) =>
            captureFromBridge(api, {
              url: msg.url,
              source: msg.source,
              // sites.js key — selects which web_conversation:<key> extractor runs.
              site: msg.site,
              conversationId: msg.conversationId,
              extract: msg.extract || 'background',
            }),
          )
          .then((result) => {
            this.replyOn(sock, { cmd: 'capture_result', reqId, ...result });
          })
          .catch((e) => {
            this.replyOn(sock, { cmd: 'capture_result', reqId, ok: false, error: String(e?.message || e) });
          });
        return;
      }
      if (msg.cmd === 'context_request') {
        // PLAN-MEMORY-FOLLOWS-YOU Lane A — the extension's 🧠 button asks for a
        // vault-scoped context block to insert into a third-party composer.
        // Disclosure invariant: the block comes from `vodou-core mem context`,
        // which refuses to read outside the configured vault. Vault name comes
        // from gateway_settings (`memory.follow.vault`), default "portable".
        const reqId = msg.reqId;
        const sock = this.ws;
        handleContextRequest(
          String(msg.query || ''),
          String(msg.host || ''),
          !!msg.all_memory,
          String(msg.vault || ''),
          String(msg.conv_id || ''),
          String(msg.provider || ''),
        )
          .then((result) => {
            this.replyOn(sock, { cmd: 'context_result', reqId, ...result });
          })
          .catch((e) => {
            this.replyOn(sock, { cmd: 'context_result', reqId, ok: false, error: String(e?.message || e) });
          });
        return;
      }
      if (msg.cmd === 'capture_turn') {
        // PLAN-UNIVERSAL-MEMORY-V2 Phase C (W2a) — the network-interception
        // shim tee'd a completed turn from a third-party web UI (ChatGPT,
        // Claude, …). Append it to a `webcap:<provider>:<conv>` conversation;
        // gateway_extractor::derive_scope maps that id to `capture:web:<provider>`
        // so the normal extractor distils it at the capture trust tier. Runs over
        // the CSRF-exempt WS (a chatgpt.com page can't POST to the gateway directly).
        // Ack with the number of turns we actually persisted (post strip/dedupe
        // filtering) so the extension's activity log can say "saved 4 messages"
        // truthfully instead of counting what it optimistically sent.
        handleCaptureTurn(msg)
          .then((stored) => {
            if (!stored) return;
            // Send on the LIVE socket, and say so when there isn't one.
            //
            // This was `this.ws?.send(...)`. Optional chaining on a null socket is
            // not a no-op you notice — it throws nothing, the catch never runs, and
            // the ack simply evaporates. The turns are safely stored; the extension
            // just never hears, so its activity feed silently under-reports and the
            // user is told nothing was saved when it was. Observed 2026-07-30:
            // "[vbb] capture_turn: +2 stored" with no matching row in the panel.
            //
            // Deliberately NOT the `sock` captured at message time (the pattern the
            // capture_result/context_result handlers use): if the extension has
            // reconnected while the write was in flight, the OLD socket is dead and
            // the new one is exactly where this ack should go.
            this.sendAck({
              cmd: 'capture_ack',
              provider: msg.provider || 'web',
              conversationId: msg.conversationId || 'session',
              stored,
            }, msg.conversationId);
          })
          .catch((e) => {
            // PLAN-ENGINE-GATED-CAPTURE P2 — a lease refusal is not a failure, and
            // must not be logged as one. Tell the extension why, in a code, so it
            // holds the batch in the P0 retry queue instead of losing it.
            if (e?.leaseReason) {
              this.sendAck({
                cmd: 'capture_refused',
                provider: msg.provider || 'web',
                conversationId: msg.conversationId || 'session',
                reason: e.leaseReason,
              }, msg.conversationId);
              return;
            }
            console.warn('[vbb] capture_turn failed:', e?.message || e);
          });
        return;
      }
      if (msg.event === 'tab_changed' || msg.event === 'tabs_changed') {
        // PLAN-ROUTER-LLM Phase 4 — feed the active-tab cache. The router
        // reads this via getActiveTab() through the /api/vbb/state HTTP route.
        const url = typeof msg.url === 'string' ? msg.url : null;
        if (url) {
          this.activeTab = {
            url,
            title: typeof msg.title === 'string' ? msg.title : undefined,
            updated_at: Date.now(),
          };
        }
        return;
      }
      return;
    }

    // Response to a pending request
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);

    if (msg.error) {
      pending.reject(Object.assign(new Error(msg.error.message || 'bridge error'), {
        code: msg.error.code || 'BRIDGE_ERROR',
      }));
      return;
    }
    pending.resolve(msg);
  }

  private handleClose(closedWs?: any): void {
    // Ignore a late close from a socket we already replaced — otherwise an orphan's
    // delayed close event would null out the healthy current connection.
    if (closedWs && this.ws && closedWs !== this.ws) {
      return;
    }
    console.log('[vbb] bridge disconnected');
    this.ws = null;
    this.connectedAt = null;
    this.channel = null;
    this.rejectAllPending(new Error('bridge disconnected'));
  }

  /** Drop the current extension socket (e.g. after toggling pairing require). */
  forceDisconnect(reason = 'gateway policy changed'): void {
    const sock = this.ws;
    if (!sock) return;
    try { sock.close?.(1000, reason); } catch { /* ignore */ }
    this.handleClose(sock);
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  /**
   * Deliver a fire-and-forget notification to the extension, or report that we
   * could not. Used for capture_ack / capture_refused, which the extension turns
   * into the user's activity feed — a dropped one is invisible to everybody
   * unless it is logged here.
   */
  /**
   * Deliver a REPLY on the socket that asked for it.
   *
   * Replies are not interchangeable with acks: they must go back to the socket that
   * issued the reqId, so the caller captures it at request time rather than reading
   * this.ws at reply time (a reconnect in between would send someone else's answer
   * to a new socket that never asked).
   *
   * The dropped case has to be LOUD. send() on a CLOSING or CLOSED socket does not
   * throw — it discards — so `sock?.send(...)` inside a try/catch caught nothing and
   * the extension waited out its 25s timeout, reporting "context request timed out"
   * as though the gateway had been slow. The work was done and the answer was thrown
   * away, which is a different problem with a different fix.
   */
  private replyOn(sock: any | null, payload: Record<string, unknown>): void {
    if (sock && sock.readyState === 1 /* OPEN */) {
      try {
        sock.send(JSON.stringify(payload));
        return;
      } catch (e) {
        console.warn(`[vbb] ${payload.cmd} reply failed:`, (e as Error)?.message);
        return;
      }
    }
    console.warn(
      `[vbb] ${payload.cmd} dropped — the socket that asked (reqId ${String(payload.reqId)}) is ` +
      `${sock ? 'no longer open' : 'gone'}. The request WAS served; the extension will ` +
      'time out instead of showing the result.',
    );
  }

  private sendAck(payload: Record<string, unknown>, convId?: string): void {
    if (this.ws && this.ws.readyState === 1 /* OPEN */) {
      try {
        this.ws.send(JSON.stringify(payload));
        return;
      } catch (e) {
        console.warn(`[vbb] ${payload.cmd} send failed:`, (e as Error)?.message);
        return;
      }
    }
    console.warn(
      `[vbb] ${payload.cmd} dropped — no live extension socket` +
      (convId ? ` (${convId})` : '') +
      '. The turns ARE stored; the extension activity log will under-report them.',
    );
  }

  isConnected(): boolean {
    // A socket we haven't heard from past the stale window is dead even if TCP
    // never delivered a close — report it honestly instead of letting callers
    // discover it via a 30s request timeout. The liveness loop reaps it shortly.
    return this.ws !== null && Date.now() - this.lastMessageAt < STALE_SOCKET_MS;
  }

  status() {
    return {
      connected: this.isConnected(),
      version: this.version,
      channel: this.channel,
      browser_info: this.browserInfo,
      connected_at: this.connectedAt,
      last_seen_ms: this.ws ? Date.now() - this.lastMessageAt : null,
      pending_count: this.pending.size,
      active_tab: this.activeTab,
    };
  }

  /** PLAN-ROUTER-LLM Phase 4 — last known active tab the extension reported. */
  getActiveTab(): { url: string; title?: string; updated_at: number } | null {
    return this.activeTab;
  }

  /** PLAN-MEMORY-EVERYWHERE-FRONTEND P0 — push web-capture armed state to the extension. */
  setCaptureArmed(armed: boolean): Promise<any> {
    return this.request('set_capture_armed', { armed }, 5000);
  }

  private request(cmd: string, args: Record<string, any>, timeoutMs = 30000): Promise<any> {
    if (!this.ws) return Promise.reject(Object.assign(new Error('Vodou Bridge not connected'), { code: 'BRIDGE_REQUIRED' }));
    const id = this.nextId++;
    const msg = JSON.stringify({ id, cmd, ...args });
    return new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, cmd, startedAt: Date.now() });
      try {
        this.ws.send(msg);
      } catch (err: any) {
        this.pending.delete(id);
        reject(err);
        return;
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(Object.assign(new Error(`bridge ${cmd} timeout`), { code: 'TIMEOUT' }));
        }
      }, timeoutMs);
    });
  }

  // -------- BridgeApi surface --------

  api(): BridgeApi {
    const self = this;
    return {
      async fetch(url, opts) {
        const res = await self.request('fetch', { url, opts: opts || {} });
        return {
          body: res.body,
          status: res.status,
          headers: res.headers || {},
        };
      },
      async extract(url, selector, opts) {
        const res = await self.request('extract', { url, selector, opts: opts || {} }, opts?.timeout_ms || 30000);
        return { matches: res.matches || [] };
      },
      async actInTab(urlPattern, fn, args) {
        const res = await self.request('act_in_tab', { urlPattern, script: fn, args: args || [] });
        return { result: res.result };
      },
      async listTabs(urlPattern) {
        const res = await self.request('list_tabs', { urlPattern });
        return res.tabs || [];
      },
      /**
       * PLAN-LENSES bridge:cookies path — fetch a URL using the user's
       * Chrome session cookies, no tab opened. Works for server-rendered
       * sites; useless for SPAs that return JS shells. Same response shape
       * as `fetch()`.
       */
      async cookiesFetch(url, init) {
        const res = await self.request('cookies_fetch', { url, init: init || {} });
        return {
          body: res.body,
          status: res.status,
          headers: res.headers || {},
          url: res.url,
          cookies_sent: res.cookies_sent || 0,
        };
      },
      /**
       * PLAN-LENSES observe() cache — opportunistic snapshots stored in
       * chrome.storage.local. Lenses that observe() write snapshots while
       * the user is on the page; reads serve from cache when available.
       */
      async cacheGet(key) {
        const res = await self.request('cache_get', { key });
        return res.entry || null;
      },
      async cacheSet(key, value) {
        await self.request('cache_set', { key, value });
      },
      /**
       * CSP-safe extraction via an extension-side built-in function.
       * Use this for sites whose CSP forbids unsafe-eval (Gmail, X, banks).
       * Lens authors who need a new built-in PR their extractor function
       * into `extension/vodou-bridge/background.js` BUILTIN_EXTRACTORS.
       */
      async extractBuiltin(id) {
        const res = await self.request('extract_builtin', { id_extractor: id });
        return res.result ?? null;
      },
      /**
       * Navigate an existing tab matching `match_url` to `url`. If none
       * matches (or `new_tab: true`), opens a new tab. Used for lens
       * row-click actions that should land the user in their already-
       * logged-in session.
       */
      async openUrl(url, opts) {
        const res = await self.request('open_url', {
          url,
          match_url: opts?.match_url || null,
          new_tab: !!opts?.new_tab,
        });
        return { tab_id: res.tabId, reused: !!res.reused };
      },
    };
  }
}

const conn = new BridgeConn();

/** Sanitize a provider/id token for use inside a conversation id (scope-safe). */
function safeToken(s: unknown, fallback: string): string {
  const t = String(s ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  return t || fallback;
}

/**
 * PLAN-UNIVERSAL-MEMORY-V2 Phase C (W2a/W2b) — persist a captured turn.
 * `msg` shape from the extension:
 *   { cmd:'capture_turn', lane?:'web'|'manual', provider, conversationId, url?, turns:[{role, content, ts?}] }
 * lane 'web' (W2a network interception) → `webcap:<provider>:<conv>` →
 * `capture:web:<provider>`. lane 'manual' (W2b right-click floor) →
 * `manual:<host>:<conv>` → `capture:manual:<host>`. Idempotency rides the
 * extractor's daily-log dedup + the Phase-0 hash-skip (a regenerated/edited
 * turn re-sends but collapses).
 */
/** Returns how many turns were actually persisted (0 if the batch was all noise). */
async function handleCaptureTurn(msg: any): Promise<number> {
  const provider = safeToken(msg.provider, 'web');
  const conv = safeToken(msg.conversationId, 'session');
  const turns = Array.isArray(msg.turns) ? msg.turns : [];
  if (turns.length === 0) return 0;

  // PLAN-ENGINE-GATED-CAPTURE P2 — capture requires a live lease from the engine.
  // Synchronous read of the lease the renewal loop maintains; never awaits, so
  // this adds nothing to the capture path. Enforcement is opt-in until P3 ships
  // the user-facing messages (see capture-lease.ts).
  const { captureAllowed } = await import('./capture-lease.js');
  const verdict = captureAllowed();
  if (!verdict.ok) {
    // Throwing would be logged as "capture_turn failed", which reads as a bug. A
    // refusal is a decision, and the caller relays the reason code to the
    // extension so it can hold the batch exactly like a disconnect.
    const err: any = new Error(`capture refused: ${verdict.reason}`);
    err.leaseReason = verdict.reason;
    throw err;
  }
  const { ensureConversation, saveMessage, setConversationSourceUrl } = await import('../conversation-store.js');
  const manual = msg.lane === 'manual';
  const convId = manual ? `manual:${provider}:${conv}` : `webcap:${provider}:${conv}`;
  const source = manual ? `capture:manual:${provider}` : `capture:web:${provider}`;
  const title = manual ? `Saved from ${provider}` : `Web capture · ${provider}`;
  ensureConversation(convId, title, source);
  // PLAN-CAPTURE-FEED P1 — remember the page this came from so the feed can link
  // back to the live thread. Recorded before the turn loop: even a batch that is
  // entirely duplicates still tells us where the conversation lives, and rows
  // captured before this field existed get backfilled the next time the user
  // visits the thread.
  if (typeof msg.url === 'string' && msg.url) setConversationSourceUrl(convId, msg.url);
  let n = 0;
  let dupes = 0;
  let sawAssistant = false;
  const { stripVodouContext } = await import('./context-markers.js');
  const { createHash } = await import('node:crypto');
  const sha = (v: string) => createHash('sha256').update(v).digest('hex');

  // PLAN-HISTORY-BACKFILL P0 — idempotency key.
  //
  // PREFER THE PROVIDER'S OWN MESSAGE ID. Every adapter has one (Grok responseId,
  // Claude chat_messages[].uuid, Copilot results[].id, Poe messageId, DeepSeek
  // message_id, Mistral messageId). It is exact, survives reloads and restarts,
  // and — critically — it distinguishes two turns whose text is identical.
  //
  // DO NOT dedup on content alone. A user genuinely repeats themselves: three
  // identical canary sends sit in webcap:grok:* right now, each a real turn. A
  // by-hand `GROUP BY (conversation, role, content)` cleanup on 2026-07-26 deleted
  // one of them. Content hashing cannot tell a re-store from a repeat.
  //
  // When no id is available, fall back to a hash that includes a coarse TIME
  // BUCKET. Re-opening a conversation minutes later lands in the same bucket and
  // is suppressed; a genuine repeat hours later lands in a different bucket and is
  // kept. At a bucket boundary the failure mode is storing a duplicate, never
  // eating a real turn — the right direction to fail.
  const windowSecs = Math.max(60, Number(process.env.VODOU_CAPTURE_DEDUPE_WINDOW_SECS || 600));
  const bucket = Math.floor(Date.now() / 1000 / windowSecs);

  for (const t of turns) {
    const role = t?.role === 'assistant' ? 'assistant' : t?.role === 'user' ? 'user' : null;
    // PLAN-MEMORY-FOLLOWS-YOU loop guard: a turn that echoes an injected
    // ⟦vodou:context⟧ block gets the block stripped BEFORE persistence, so
    // memory never re-captures its own disclosed context. (The Rust extractor
    // strips again at row-load — belt and suspenders.)
    const content = typeof t?.content === 'string' ? stripVodouContext(t.content).trim() : '';
    if (!role || content.length < 2) continue;
    // Cap per-turn size the same way the openai-compat path does.
    const body = content.slice(0, 100000);
    const srcId = typeof t?.id === 'string' && t.id.trim() ? t.id.trim() : null;
    const ident = srcId ? `id:${srcId}` : `h:${bucket}:${sha(`${role}\u0000${body}`)}`;
    const dedupeKey = sha(`${convId}\u0000${ident}`);
    // PLAN-CAPTURE-FEED P2 — the adapter's model sniff, assistant turns only.
    const model = typeof t?.model === 'string' && t.model.trim() ? t.model.trim() : null;
    const stored = saveMessage(convId, role, body, null, null, dedupeKey, srcId, windowSecs, model);
    if (!stored) {
      dupes++;
      if (!srcId) {
        // Visible because the fallback path is the one that can be WRONG — a
        // genuine repeat inside the window looks identical to a re-store.
        console.log(`[vbb] capture_turn: suppressed a ${role} turn by CONTENT hash (no provider id) in ${convId}`);
      }
      continue;
    }
    if (role === 'assistant') sawAssistant = true;
    n++;
  }
  // A manual snippet is inherently one-sided (user selection, no reply). The
  // gateway extractor DEFERS — and after the stall window SKIPS — conversations
  // with no assistant turn ("reply never coming"), so a user-only capture would
  // never become memory. Append a minimal provenance turn to make it a complete
  // exchange the extractor will distil (the snippet is the durable content; this
  // ack yields no bullet of its own).
  //
  // MANUAL ONLY. A streaming web capture may deliver the user turn and the reply
  // in SEPARATE relays — Poe does — and the ack was landing between them, so the
  // stored conversation read:
  //   user       "For the record: we completed the Vodou capture test…"
  //   assistant  "(saved to Vodou memory from poe)"   <- Vodou talking to itself
  //   assistant  "Acknowledged for the record ✅ …"
  // For the web lane the reply genuinely is still coming, so deferring is the
  // correct behaviour and fabricating a turn is not: a placeholder in the
  // assistant's voice is indistinguishable from something the model said once it
  // is a row in the transcript.
  if (n > 0 && !sawAssistant && manual) {
    saveMessage(convId, 'assistant', `(saved to Vodou memory from ${provider})`);
  }
  if (n > 0 || dupes > 0) {
    console.log(`[vbb] capture_turn: +${n} stored${dupes ? `, ${dupes} duplicate suppressed` : ''} → ${convId}`);
  }
  return n;
}

/**
 * PLAN-MEMORY-FOLLOWS-YOU — resolve a context_request by shelling the single
 * formatter: `vodou-core mem context <query> --vault <v> --json`. One producer
 * means the block format (and the strip markers) can never drift between the
 * browser lane and the MCP lane.
 */
// A1 — server-side conversation seed. When the picker opens with no typed query,
// seed the search from the LAST few captured turns of the current tab's
// conversation instead of scraping the page DOM (which rots on UI ships). The
// tab's conversation uuid comes in as `convId` + `provider`; we read the turns
// we already captured under `webcap:<provider>:<convId>`.
function seedFromConversation(provider: string, convId: string): string {
  try {
    if (!provider || !convId) return '';
    const cid = `webcap:${provider}:${convId}`;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getDb } = require('../db.js');
    const rows = getDb()
      .prepare(
        `SELECT content FROM gateway_messages
          WHERE conversation_id = ? AND role IN ('user','assistant') AND length(content) > 1
          ORDER BY id DESC LIMIT 6`,
      )
      .all(cid) as Array<{ content: string }>;
    if (!rows || !rows.length) return '';
    // Oldest→newest of the tail, capped so the query embed stays cheap.
    return rows.reverse().map((r) => r.content).join('\n').slice(0, 1500);
  } catch { return ''; }
}

// A3 — vault list for the picker's scope dropdown.
//
// This was `execFileSync`, which is a whole-gateway stall dressed up as a
// dropdown: Node is single-threaded, so the spawn held the event loop for as
// long as the binary took — normally ~8ms, but up to the full 8s timeout if the
// binary is wedged, mid-swap, or waiting on a daemon that isn't answering.
// Every chat turn, SSE stream and capture relay froze with it. Async now, and
// cached, because the answer changes only when a user creates a vault.
let _vaultNamesCache: { at: number; names: string[] } | null = null;
const VAULT_NAMES_TTL_MS = 30_000;

async function listVaultNames(): Promise<string[]> {
  if (_vaultNamesCache && Date.now() - _vaultNamesCache.at < VAULT_NAMES_TTL_MS) {
    return _vaultNamesCache.names;
  }
  const { getProjectRoot } = await import('../db.js');
  const path = await import('path');
  const { execFile } = await import('child_process');
  return new Promise((resolve) => {
    execFile(
      path.join(getProjectRoot(), 'vodou-core'),
      ['mem', 'vault', 'list', '--json'],
      { cwd: getProjectRoot(), timeout: 8000, maxBuffer: 512 * 1024 },
      (err, stdout) => {
        // Never reject: the caller awaits this to finish a context_result, so a
        // rejection here would strand the extension's request until its timeout.
        if (err) { resolve(_vaultNamesCache?.names ?? []); return; }
        try {
          const data = JSON.parse(stdout);
          const names = Array.isArray(data.vaults)
            ? data.vaults.map((v: any) => String(v.name)).filter(Boolean)
            : [];
          _vaultNamesCache = { at: Date.now(), names };
          resolve(names);
        } catch { resolve(_vaultNamesCache?.names ?? []); }
      },
    );
  });
}

async function handleContextRequest(
  query: string,
  host: string,
  allMemory = false,
  vaultOverride = '',
  convId = '',
  provider = '',
): Promise<any> {
  // Query precedence: what the user typed > the conversation seed (A1) > host.
  const seed = query.trim() || seedFromConversation(provider, convId);
  const q = seed || (host ? `context for ${host}` : '');
  if (!q) return { ok: false, error: 'empty query' };
  let vaultName = vaultOverride.trim() || 'portable';
  if (!vaultOverride.trim()) {
    try {
      const { getSetting } = await import('../db.js');
      const v = getSetting('memory.follow.vault');
      if (v && v.trim()) vaultName = v.trim();
    } catch { /* settings unavailable — keep default */ }
  }

  const { getProjectRoot } = await import('../db.js');
  const path = await import('path');
  const { execFile } = await import('child_process');
  const bin = path.join(getProjectRoot(), 'vodou-core');

  // Picker v2: `all_memory` searches the whole store and marks non-vault items
  // in_vault=false so the extension can flag them "private". Over-fetch to 25
  // (vs 15) since all-memory has a bigger pool to rank + browse.
  const args = ['mem', 'context', q, '--vault', vaultName, '--top-k', allMemory ? '25' : '15', '--json'];
  if (allMemory) args.push('--all-memory');

  // Kick the vault list off alongside the context search instead of after it —
  // the picker needs both, and they don't depend on each other.
  const vaultsP = listVaultNames();

  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { cwd: getProjectRoot(), timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message || '');
          if (/no vault named|not found/i.test(msg)) {
            resolve({
              ok: false,
              code: 'NO_PORTABLE_VAULT',
              error: `vault '${vaultName}' doesn't exist — create it with: ./vodou-core mem vault create ${vaultName} --tags PREF (then curate in the brain console)`,
            });
            return;
          }
          resolve({ ok: false, error: msg.slice(0, 300) || 'mem context failed' });
          return;
        }
        try {
          const data = JSON.parse(stdout);
          vaultsP.then((vaults) => resolve({
            ok: true,
            context: data.context || '',
            vault: data.vault,
            bullets: data.bullets || 0,
            // Picker support (PLAN-MEMORY-FOLLOWS-YOU): individual candidates +
            // the block parts, so content.js can assemble a user-chosen subset
            // without re-deriving the fence format.
            items: Array.isArray(data.items) ? data.items : [],
            // PLAN-INJECT-QUALITY — server-decomposed + selected facts to inject
            // (compound prompts split into sub-questions server-side). The
            // extension renders these directly instead of re-selecting client-side.
            selected: Array.isArray(data.selected) ? data.selected : [],
            all_memory: !!data.all_memory,
            vaults,
            open: data.open || '',
            header: data.header || '',
            close: data.close || '',
            // PLAN-AUTO-INJECT-P4 — the reflected pinned profile, present ONLY
            // when the vault opted in (VaultRules.include_profile); auto-inject
            // prepends it so every external chat opens with "who I am".
            profile: data.profile || '',
          }));
        } catch {
          resolve({ ok: false, error: 'bad mem context output' });
        }
      },
    );
  });
}

/**
 * PLAN-MEMORY-FOLLOWS-YOU Lane B — persist a capture turn arriving over HTTP
 * (the vodou-memory MCP server's `remember` tool) through the exact same
 * pipeline as WS capture_turn: same lanes, same trust tier, same loop-guard
 * strip, same one-sided-capture provenance ack.
 */
export async function persistCaptureTurn(msg: {
  lane?: 'web' | 'manual';
  provider?: string;
  conversationId?: string;
  /** Page the turn came from, if the caller knows it (PLAN-CAPTURE-FEED P1). */
  url?: string;
  turns: Array<{ role: string; content: string }>;
}): Promise<number> {
  return handleCaptureTurn(msg);
}

/** Called by the WS handler when an extension connects. */
export function attachBridge(ws: any, origin = '(unknown)'): void {
  // Fire-and-forget — attach() probes any incumbent asynchronously.
  conn.attach(ws, origin).catch((e) => console.warn('[vbb] attach failed:', e?.message || e));
  // PLAN-ENGINE-GATED-CAPTURE P2 — an extension is connected, so capture is now
  // possible and the gateway needs a live lease. Idempotent; the loop renews
  // every 15 minutes from here on.
  void import('./capture-lease.js').then((m) => m.startLeaseLoop()).catch(() => { /* lease is opt-in */ });
}

/** Cards call this. Returns null when no extension is connected. */
export function getBridge(): BridgeApi | null {
  return conn.isConnected() ? conn.api() : null;
}

export function bridgeStatus() {
  return conn.status();
}

/** PLAN-ENGINE-GATED-CAPTURE P2 — lease state for /api/vbb/state. */
export async function captureLeaseStatus() {
  const { leaseStatus } = await import('./capture-lease.js');
  return leaseStatus();
}

/** Kick the connected extension (pairing policy change, etc.). */
export function disconnectBridge(reason?: string): void {
  conn.forceDisconnect(reason || 'gateway policy changed');
}

/** PLAN-ROUTER-LLM Phase 4 — exposed via GET /api/vbb/state. */
export function bridgeActiveTab() {
  return conn.getActiveTab();
}

// ── Web-capture armed state (PLAN-MEMORY-EVERYWHERE-FRONTEND P0) ─────────────
// gateway_settings `capture.web.armed` is the source of truth; the extension
// mirrors it into chrome.storage.local (which inject.js/content.js consult).

/** Push the armed flag to the connected extension. No-op if offline. */
export async function pushCaptureArmed(armed: boolean): Promise<void> {
  if (!conn.isConnected()) return;
  await conn.setCaptureArmed(armed);
}

/** Converge the extension on the stored setting (called on bridge_ready). */
async function syncCaptureArmedToExtension(): Promise<void> {
  const env = process.env.VODOU_CAPTURE_WEB_ARMED;
  let armed: boolean;
  if (env !== undefined && env.trim() !== '') {
    armed = ['1', 'true', 'TRUE', 'yes', 'YES', 'on'].includes(env.trim());
  } else {
    const { getSetting } = await import('../db.js');
    const v = getSetting('capture.web.armed');
    if (v === null) return; // never set — leave the extension's local choice alone
    armed = ['1', 'true', 'TRUE', 'yes', 'YES', 'on'].includes(v.trim());
  }
  await pushCaptureArmed(armed);
}
