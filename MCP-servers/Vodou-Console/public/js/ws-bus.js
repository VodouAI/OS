/**
 * WsBus — shared WebSocket singleton for the whole gateway frontend.
 *
 * Today chat.js owns its own `this.ws`. This bus is the new path; components
 * like ScopedWorkbench subscribe here. In Phase 4, chat.js migrates from its
 * own socket to WsBus too (removes the duplicate socket). Until then, WsBus
 * coexists — the gateway server treats each socket as its own client.
 *
 * Routing:
 *   WsBus.subscribe(conversationId, handler) — get events tagged with that convId
 *   WsBus.subscribeAll(handler)               — get every event (health, etc.)
 *   WsBus.send(msg)                           — send (auto-connects, queues until open)
 *   WsBus.resetSeq(conversationId)            — clear resume cursor (e.g. on a history snapshot)
 *   WsBus.getConversations()                  — reconciled conversation snapshot (B8)
 *
 * Activity reconcile (B8): `channel_activity` / `*_activity` notifications are
 * sent by the gateway via raw `ws.send` with NO seq, so they are never buffered
 * and never replayed on resume — a tab blip silently loses the "tab should
 * appear / unread dot" cue. The gateway re-emits the authoritative
 * `conversations_list` snapshot on every reconnect; the bus reconciles that
 * snapshot by conversation id (idempotent merge that preserves any local
 * unread/activity flag the server omits) so a dropped live cue self-heals on
 * reconnect. The merged snapshot is what subscribers receive.
 *
 * Connection state: the bus emits a synthetic `{type:'_ws_status', state}` event
 * to ALL subscribers (per-conv + global) on open/close/error so views can show
 * honest connection state. `state` is 'connected' | 'reconnecting' | 'disconnected'.
 *
 * The bus auto-reconnects on close with true exponential backoff (base 1s,
 * ×2 per attempt, capped at 30s, ±25% jitter).
 */
const WsBus = (() => {
  let _ws = null;
  let _connectPromise = null;
  /** @type {Map<string, Set<function>>} conversationId → handlers */
  const _subscribers = new Map();
  /** @type {Set<function>} handlers that want every inbound event */
  const _globalSubscribers = new Set();
  /** @type {string[]} messages queued while socket isn't open */
  let _queue = [];
  /** @type {Map<string, number>} conversationId → last seq received (for resume on reconnect) */
  const _lastSeq = new Map();
  /** Gateway process epoch from the last `connected` handshake; a change means a restart. */
  let _gatewayEpoch = null;
  /** Set on socket open; consumed by the `connected` handshake once the epoch is known. */
  let _pendingResume = false;
  /**
   * @type {Map<string, object>} conversationId → reconciled conversation record.
   * B8: holds the merged authoritative `conversations_list` snapshot so a raw
   * (non-seq'd) activity notification dropped during a blip self-heals when the
   * gateway re-sends the snapshot on reconnect.
   */
  const _conversations = new Map();
  /** Whether a previous socket existed — first connect doesn't need resume. */
  let _hadPriorSocket = false;
  /** Consecutive failed/closed connects — drives exponential backoff. */
  let _reconnectAttempts = 0;
  /** Pending reconnect timer, so we never stack multiple. */
  let _reconnectTimer = null;

  // Backoff tuning.
  const _BACKOFF_BASE_MS = 1000;   // first retry ≈ 1s
  const _BACKOFF_CAP_MS = 30000;   // never wait longer than 30s
  const _CONNECT_TIMEOUT_MS = 10000; // give up on a hung opening socket after 10s

  function _url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/`;
  }

  /** Broadcast a synthetic connection-state event to every subscriber. */
  function _emitStatus(state) {
    const evt = { type: '_ws_status', state };
    _subscribers.forEach((set) => {
      set.forEach((h) => {
        try { h(evt); } catch (err) { console.error('[WsBus] status handler error:', err); }
      });
    });
    _globalSubscribers.forEach((h) => {
      try { h(evt); } catch (err) { console.error('[WsBus] global status handler error:', err); }
    });
  }

  /**
   * B8: idempotently merge the authoritative `conversations_list` snapshot into
   * `_conversations` by id. The server snapshot is authoritative for fields it
   * reports; for `unread` (the transient activity dot set by a raw, non-seq'd
   * notification) we keep the local value when the server omits the field, so a
   * cue dropped during a disconnect isn't silently cleared on reconnect.
   * Returns the merged array (insertion order preserves the server's ordering).
   */
  function _reconcileConversations(incoming) {
    const merged = [];
    const seen = new Set();
    for (const sc of incoming) {
      if (!sc || sc.id == null) { merged.push(sc); continue; }
      const existing = _conversations.get(sc.id) || {};
      const next = {
        ...existing,
        ...sc,
        // Server snapshot wins for unread when present; otherwise preserve the
        // last local cue so a dropped raw activity notification isn't lost.
        unread: sc.unread != null ? sc.unread : (existing.unread != null ? existing.unread : false),
      };
      _conversations.set(sc.id, next);
      merged.push(next);
      seen.add(sc.id);
    }
    // Drop any locally-cached conversation the authoritative snapshot no longer
    // lists (e.g. deleted server-side) so the cache can't grow unbounded.
    for (const id of Array.from(_conversations.keys())) {
      if (!seen.has(id)) _conversations.delete(id);
    }
    return merged;
  }

  /** Exponential backoff with cap + ±25% jitter, based on attempt count. */
  function _backoffDelay() {
    const exp = Math.min(_BACKOFF_CAP_MS, _BACKOFF_BASE_MS * Math.pow(2, _reconnectAttempts));
    const jitter = exp * 0.25 * (Math.random() * 2 - 1); // ±25%
    return Math.max(0, Math.round(exp + jitter));
  }

  /** Schedule a reconnect, announcing 'reconnecting' so views can show it. */
  function _scheduleReconnect() {
    if (_reconnectTimer) return; // already pending
    const delay = _backoffDelay();
    _reconnectAttempts++;
    _emitStatus('reconnecting');
    _reconnectTimer = setTimeout(() => {
      _reconnectTimer = null;
      _connect();
    }, delay);
  }

  function _connect() {
    if (_ws && _ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (_connectPromise) return _connectPromise;
    _connectPromise = new Promise((resolve) => {
      let settled = false;
      // settle() resolves the connect promise exactly once. We resolve (never
      // reject) on close/error/timeout too — callers `await send()` and must not
      // hang when the socket can't open; the message stays queued for next open.
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        _connectPromise = null;
        resolve();
      };

      let ws;
      try {
        ws = new WebSocket(_url());
      } catch (err) {
        // Construction itself can throw (bad URL, blocked). Treat as a failed
        // connect: settle so awaiters proceed, then schedule a retry.
        console.error('[WsBus] WebSocket construction failed:', err);
        _ws = null;
        settle();
        _emitStatus('disconnected');
        _scheduleReconnect();
        return;
      }
      _ws = ws;

      // Guard against a socket that opens neither nor errors (proxy black-hole).
      const connectTimer = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          console.warn('[WsBus] connect timed out — closing and retrying');
          try { ws.close(); } catch {}
          // The close handler below will settle + schedule the retry. If for some
          // reason close doesn't fire, settle here so awaiters never hang.
          settle();
        }
      }, _CONNECT_TIMEOUT_MS);

      ws.addEventListener('open', () => {
        _reconnectAttempts = 0; // healthy — reset backoff
        // After a reconnect, ask the gateway to replay any events we missed
        // for conversations we were tracking. Server-side buffer holds 10 min
        // / 200 events per conv — plenty for a long Canva tool call.
        // 2026-09-02: the resume is DEFERRED to the `connected` handshake, which
        // carries the gateway's process epoch. Resuming against a restarted
        // gateway with the old cursors was the seq-reset data-loss bug: the new
        // process numbers from a lower seq, and every chunk up to the stale
        // high-water mark was dropped as a duplicate.
        _pendingResume = _hadPriorSocket && _lastSeq.size > 0;
        _hadPriorSocket = true;
        const pending = _queue.splice(0);
        pending.forEach((m) => ws.send(m));
        settle();
        _emitStatus('connected');
      });

      ws.addEventListener('message', (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'connected') {
          const restarted = !!(_gatewayEpoch && msg.epoch && msg.epoch !== _gatewayEpoch);
          if (restarted) {
            // A different process: its seqs start over. Forget every cursor
            // and do not ask it to replay a buffer it never had.
            _lastSeq.clear();
            msg.gatewayRestarted = true;
            console.warn('[WsBus] gateway restarted (epoch changed) — stream cursors cleared');
          } else if (_pendingResume) {
            for (const [convId, lastSeq] of _lastSeq) {
              try { ws.send(JSON.stringify({ type: 'resume', conversationId: convId, lastSeq })); } catch {}
            }
          }
          _pendingResume = false;
          if (msg.epoch) _gatewayEpoch = msg.epoch;
        }
        // Track + dedupe sequenced events (resume can replay events we
        // already saw on the prior socket — drop those silently).
        if (msg.seq && msg.conversationId) {
          const prev = _lastSeq.get(msg.conversationId) || 0;
          if (msg.seq <= prev) return;
          _lastSeq.set(msg.conversationId, msg.seq);
        }
        // B8: reconcile the authoritative conversation snapshot the gateway
        // re-sends on every (re)connect. Merge by id so a raw activity
        // notification dropped during a blip self-heals, and subscribers
        // receive the reconciled `conversations` list (idempotent).
        if (msg.type === 'conversations_list' && Array.isArray(msg.conversations)) {
          msg.conversations = _reconcileConversations(msg.conversations);
        }
        const convId = msg.conversationId;
        if (convId && _subscribers.has(convId)) {
          _subscribers.get(convId).forEach((h) => {
            try { h(msg); } catch (err) { console.error('[WsBus] handler error:', err); }
          });
        }
        _globalSubscribers.forEach((h) => {
          try { h(msg); } catch (err) { console.error('[WsBus] global handler error:', err); }
        });
      });

      ws.addEventListener('close', () => {
        // Only react if this is still the live socket (a timed-out socket we
        // already replaced should not stomp newer state).
        if (_ws === ws) _ws = null;
        settle(); // unblock any awaiter that was waiting on this open
        _emitStatus('disconnected');
        // Reconnect with backoff. _lastSeq is preserved so the next open() can
        // request a resume from the gateway buffer.
        _scheduleReconnect();
      });

      ws.addEventListener('error', (err) => {
        console.error('[WsBus] socket error:', err);
        // `error` is typically followed by `close` (which handles retry +
        // status). But settle here too so a connect that errors before ever
        // opening doesn't leave `await send()` hanging.
        settle();
      });
    });
    return _connectPromise;
  }

  async function send(msg) {
    const s = typeof msg === 'string' ? msg : JSON.stringify(msg);
    await _connect();
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      _ws.send(s);
    } else {
      // Socket couldn't open (closed/errored/timed out). Queue so it flushes on
      // the next successful open instead of being lost. _connect()'s close
      // handler has already scheduled a reconnect.
      _queue.push(s);
    }
  }

  function subscribe(conversationId, handler) {
    _connect();
    if (!_subscribers.has(conversationId)) _subscribers.set(conversationId, new Set());
    _subscribers.get(conversationId).add(handler);
    return () => {
      const set = _subscribers.get(conversationId);
      if (set) {
        set.delete(handler);
        if (!set.size) {
          _subscribers.delete(conversationId);
          // Last subscriber gone — drop the resume cursor so it can't leak.
          _lastSeq.delete(conversationId);
        }
      }
    };
  }

  function subscribeAll(handler) {
    _connect();
    _globalSubscribers.add(handler);
    return () => _globalSubscribers.delete(handler);
  }

  /**
   * Clear the resume cursor for a conversation. Call this whenever the client
   * gets a fresh full snapshot (a `history` event): the gateway may restart and
   * renumber seqs, and a stale `_lastSeq` would silently drop every event whose
   * seq is ≤ the old high-water mark — the seq-reset data-loss bug.
   */
  function resetSeq(conversationId) {
    if (conversationId) _lastSeq.delete(conversationId);
  }

  function isReady() {
    return !!_ws && _ws.readyState === WebSocket.OPEN;
  }

  /**
   * B8: the reconciled conversation snapshot (merged across reconnects). Views
   * can read this as the authoritative activity state instead of relying on a
   * raw, non-replayable notification that may have been dropped during a blip.
   */
  function getConversations() {
    return Array.from(_conversations.values());
  }

  return { send, subscribe, subscribeAll, resetSeq, isReady, getConversations };
})();

window.WsBus = WsBus;
