/**
 * Console Two transport — the ONE host seam (PLAN-CONSOLE-TWO §4.1, revised).
 *
 * SIMPLIFICATION over the original plan: chat does NOT go through an extension
 * relay in either host. The shell is always served from 127.0.0.1:8765 — as a
 * plain tab OR framed by the extension — so its own origin can open the
 * gateway's web-chat WebSocket directly. One WS client, one lane, the same
 * persistence/resume/approvals the desktop console uses. The relay (postMessage
 * to the extension page) exists ONLY for what genuinely needs chrome.* APIs:
 * page metadata and on-demand page reads (P2).
 *
 * Wire contract (verified against src/index.ts 2026-08-09):
 *   recv  connected{conversationId, activeModel}
 *         history{conversationId, messages[{role,text,timestamp,senderLabel}], hasMore}
 *         chunk{content} tool_start{tool,toolId,server,args}
 *         tool_end{tool,toolId,result,executionTime,success}
 *         status{status} usage{usage} error{message} done{}
 *         approval_requested{tool,category,token,args}    (broadcast, no seq)
 *         (everything streamed carries {conversationId, seq})
 *   send  {type:'message', content, conversationId}
 *         {type:'switch_conversation', conversationId}
 *         {type:'resume', conversationId, lastSeq}
 *   REST  POST /chat/approve {conversationId, token, decision}
 *         GET  /api/memory/search-chunks?q=&top_k=   (stage-1 fast recall)
 *         GET  /health                               (seam heartbeat)
 */

const HOST_PANEL = window.parent !== window;

export function makeTransport() {
  const listeners = new Set();
  let ws = null;
  let attempts = 0;
  let timer = null;
  let alive = false; // gateway reachability, drives the seam

  const emit = (frame) => { for (const fn of listeners) { try { fn(frame); } catch { /* listener bug — keep streaming */ } } };

  function connect() {
    if (ws || timer) return;
    let sock;
    try { sock = new WebSocket(`ws://${location.host}/`); } catch { schedule(); return; }
    ws = sock;
    sock.onopen = () => { attempts = 0; alive = true; emit({ type: '_transport', state: 'connected' }); };
    sock.onmessage = (ev) => {
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      emit(frame);
    };
    sock.onclose = () => { ws = null; alive = false; emit({ type: '_transport', state: 'reconnecting' }); schedule(); };
    sock.onerror = () => { try { sock.close(); } catch { /* already closing */ } };
  }

  function schedule() {
    if (timer) return;
    // Same shape as WsBus: exponential backoff, 1s base, 30s cap.
    const delay = Math.min(30000, 1000 * 2 ** attempts++);
    timer = setTimeout(() => { timer = null; connect(); }, delay);
  }

  connect();

  return {
    host: HOST_PANEL ? 'panel' : 'tab',
    get alive() { return alive; },

    onFrame(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(msg)); return true; } catch { /* fallthrough */ }
      }
      return false; // caller shows the degraded state; no silent queue for user text
    },

    async approve(conversationId, token, decision) {
      const r = await fetch('/chat/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, token, decision }),
      });
      return r.ok;
    },

    /** Stage-1 fast recall (§4.5.1) — reranked daemon search, 0.72 floor applied here. */
    async fastRecall(query) {
      try {
        const r = await fetch(`/api/memory/search-chunks?q=${encodeURIComponent(query)}&top_k=3`);
        if (!r.ok) return [];
        const data = await r.json();
        return (data.results || [])
          .filter((c) => typeof c.score !== 'number' || c.score >= 0.72)
          .map((c) => ({ text: c.text || c.chunk_text || c.content || '', score: c.score }))
          .filter((c) => c.text);
      } catch { return []; }
    },

    async health() {
      try { const r = await fetch('/health'); return r.ok; } catch { return false; }
    },

    /** Pane iframe src for a console route. Same-origin in both hosts —
     *  the /ext-session cookie handoff happened before the shell loaded. */
    paneSrc(route) { return `/panel/#${route}`; },
    tabHref(route) { return `/#${route}`; },

    // ── Page lane (panel host only; P2 wires the extension side) ────────────
    async pageMeta() {
      if (!HOST_PANEL) return null;
      return relayRequest({ type: 'page_meta' });
    },
    async pageRead() {
      if (!HOST_PANEL) return null;
      const r = await relayRequest({ type: 'page_read' }, 6000);
      return r && r.text ? r : null;
    },
    /** Manual save — the extension relays this as the existing capture lane
     *  (capture_request → import:web:<uuid>), never a new verb. */
    async pageSave() {
      if (!HOST_PANEL) return null;
      return relayRequest({ type: 'page_save' }, 15000);
    },
    /** Extension-local settings (§10 Q2) — chrome.storage keys only an
     *  extension page can write; the shell renders them via the relay. */
    async extSettingsGet() {
      if (!HOST_PANEL) return null;
      return relayRequest({ type: 'ext_settings_get' });
    },
    async extSettingsSet(key, value) {
      if (!HOST_PANEL) return null;
      return relayRequest({ type: 'ext_settings_set', key, value });
    },
  };
}

// postMessage request/response with the framing extension page. P2 builds the
// other side; until then requests resolve null after a short timeout so the
// page strip simply stays hidden.
let relaySeq = 0;
function relayRequest(msg, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const reqId = 'two_' + (++relaySeq) + '_' + Date.now().toString(36);
    const onReply = (ev) => {
      const m = ev.data && ev.data.vodouTwo;
      if (!m || m.reqId !== reqId) return;
      window.removeEventListener('message', onReply);
      resolve(m);
    };
    window.addEventListener('message', onReply);
    try { window.parent.postMessage({ vodouTwo: { ...msg, reqId } }, '*'); } catch { /* no parent listener */ }
    setTimeout(() => { window.removeEventListener('message', onReply); resolve(null); }, timeoutMs);
  });
}
