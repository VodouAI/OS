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
 *
 * The bus auto-reconnects on close with exponential-ish backoff (1.5s).
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

  function _url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/`;
  }

  function _connect() {
    if (_ws && _ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (_connectPromise) return _connectPromise;
    _connectPromise = new Promise((resolve) => {
      _ws = new WebSocket(_url());
      _ws.addEventListener('open', () => {
        const pending = _queue.splice(0);
        pending.forEach((m) => _ws.send(m));
        _connectPromise = null;
        resolve();
      });
      _ws.addEventListener('message', (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
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
      _ws.addEventListener('close', () => {
        _ws = null;
        _connectPromise = null;
        // Reconnect after a short delay; real-time handlers will re-attach themselves
        setTimeout(_connect, 1500);
      });
      _ws.addEventListener('error', (err) => {
        console.error('[WsBus] socket error:', err);
      });
    });
    return _connectPromise;
  }

  async function send(msg) {
    await _connect();
    const s = typeof msg === 'string' ? msg : JSON.stringify(msg);
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      _ws.send(s);
    } else {
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
        if (!set.size) _subscribers.delete(conversationId);
      }
    };
  }

  function subscribeAll(handler) {
    _connect();
    _globalSubscribers.add(handler);
    return () => _globalSubscribers.delete(handler);
  }

  function isReady() {
    return !!_ws && _ws.readyState === WebSocket.OPEN;
  }

  return { send, subscribe, subscribeAll, isReady };
})();

window.WsBus = WsBus;
