// Vodou Bridge — network-interception capture (PLAN-UNIVERSAL-MEMORY-V2 Phase C W2a).
//
// Runs in the PAGE's MAIN world at document_start (see manifest world:"MAIN").
// Monkey-patches fetch / XMLHttpRequest / WebSocket so we can tee the JSON/SSE
// streams the web app exchanges with its OWN backend — no DOM scraping (which
// rots on every UI ship). Each provider is a small ADAPTER: match the streaming
// endpoint, then assemble canonical {role, content} turns from the envelope.
//
// The REQUEST body is captured alongside the response: for most providers the
// user's prompt travels in the request, not the reply stream (Claude, Grok,
// DeepSeek, Perplexity, …), so parse() receives (respBody, url, reqBody).
//
// On a completed turn we window.postMessage(...) to content.js (isolated world),
// which relays it to the background service worker → gateway over the WS. The
// page never talks to the gateway directly (a chatgpt.com origin is CSRF-blocked).
//
// Robustness: network endpoints change far less than DOM class names; when they
// do it's a one-adapter fix. Everything here is best-effort and wrapped so a
// parser error can never break the host page's own request. Adapters marked
// EXPERIMENTAL were written from known wire formats but not yet verified against
// live traffic — a matched-but-zero-turns parse logs a console.debug breadcrumb.


// ---------- E12: per-turn real-world timestamps from the provider's own API ----------
//
// The snapshot parsers below already read each message's true creation time to
// SORT the transcript (ChatGPT `create_time`, a float epoch; Claude `created_at`,
// an ISO string) and then dropped it when building `turns`. Same class of bug as
// the `id` that used to be dropped in these maps — the data was parsed, used once,
// and thrown away one line before it was sent.
//
// It matters most for BACKFILL: a historic transcript relayed today would other-
// wise be stamped with arrival time, dating a months-old conversation to now. The
// relay already flags `backfill` for exactly this reason.
//
// Returns a naive-UTC `YYYY-MM-DD HH:MM:SS` (gateway's stored form) or null. Null
// is a real answer — it means "no time known", and the gateway keeps its existing
// CURRENT_TIMESTAMP fallback rather than inventing one.
function vodouTurnTime(t) {
  try {
    if (t === null || t === undefined || t === '') return null;
    let ms = null;
    if (typeof t === 'number') {
      if (!isFinite(t) || t <= 0) return null;
      ms = t < 1e11 ? t * 1000 : t;      // epoch seconds vs milliseconds
    } else {
      const s = String(t).trim();
      if (!s) return null;
      const n = Number(s);
      if (isFinite(n) && n > 0) ms = n < 1e11 ? n * 1000 : n;
      else ms = Date.parse(s);
    }
    // Plausibility floor (2000-01-01): Date.parse('0') is the YEAR 2000 and
    // Number('2024')*1000 is 1970. Both parse, both would backdate by decades.
    if (!isFinite(ms) || ms <= 946684800000) return null;
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  } catch (_) { return null; }
}
(function () {
  if (window.__vodouNetCapInstalled) return;
  window.__vodouNetCapInstalled = true;

  const POST = (provider, conversationId, turns) => {
    if (!turns || !turns.length) return;
    try {
      window.postMessage({ source: 'vodou-netcap', provider, conversationId, turns }, '*');
      // Verification breadcrumb (visible with the console's Verbose level on).
      console.debug(`[vodou-netcap] ${provider}: captured ${turns.length} turn(s) → relayed to bridge`);
    } catch (_) { /* ignore */ }
  };

  const debugMiss = (name, url) => {
    try { console.debug(`[vodou-netcap] ${name} adapter matched but parsed 0 turns — wire format may have changed`, url); } catch (_) {}
  };

  // ── Shared helpers ─────────────────────────────────────────────────────────

  // Split an SSE body into the JSON payloads of its `data:` lines.
  function sseDataChunks(body) {
    const out = [];
    for (const line of String(body).split(/\r?\n/)) {
      const m = /^data:\s?(.*)$/.exec(line);
      if (!m) continue;
      const payload = m[1];
      if (payload === '[DONE]' || payload === '') continue;
      out.push(payload);
    }
    return out;
  }

  // Parse a body of newline-delimited JSON objects (Grok, Meta AI style).
  function jsonLines(body) {
    const out = [];
    for (const line of String(body).split(/\r?\n/)) {
      const t = line.trim();
      if (!t || (t[0] !== '{' && t[0] !== '[')) continue;
      try { out.push(JSON.parse(t)); } catch (_) { /* partial/garbage line */ }
    }
    return out;
  }

  const safeJson = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };

  const trimTurns = (turns) => turns.filter((t) => t && t.content && t.content.trim().length >= 2);

  // Pull the newest user prompt out of an OpenAI-shaped request body
  // ({messages:[{role,content}]} with string or parts-array content, or {prompt}).
  function lastUserContent(req) {
    if (!req) return '';
    if (Array.isArray(req.messages)) {
      for (let i = req.messages.length - 1; i >= 0; i--) {
        const m = req.messages[i];
        if (!m || m.role !== 'user') continue;
        if (typeof m.content === 'string') return m.content.trim();
        if (Array.isArray(m.content)) {
          const t = m.content.find((p) => p && typeof p.text === 'string');
          if (t) return t.text.trim();
        }
      }
    }
    if (typeof req.prompt === 'string') return req.prompt.trim();
    if (typeof req.content === 'string') return req.content.trim();
    return '';
  }

  // Generic OpenAI-style SSE chat stream (choices[0].delta.content), shared by
  // Qwen / Z.ai / OpenRouter-style web apps. cidFields: request-body keys that
  // may carry the conversation id, checked in order.
  function openAiSseParse(body, reqBody, cidFields) {
    let assistant = '';
    for (const payload of sseDataChunks(body)) {
      const obj = safeJson(payload);
      if (!obj) continue;
      const c = Array.isArray(obj.choices) && obj.choices[0];
      if (c && c.delta && typeof c.delta.content === 'string') assistant += c.delta.content;
      else if (c && c.message && typeof c.message.content === 'string') assistant = c.message.content;
      else if (obj.data && typeof obj.data.delta_content === 'string') assistant += obj.data.delta_content;
    }
    const req = safeJson(reqBody || '');
    let conversationId = 'session';
    for (const f of cidFields || []) {
      if (req && typeof req[f] === 'string' && req[f]) { conversationId = req[f]; break; }
    }
    const user = lastUserContent(req);
    const turns = [];
    if (user) turns.push({ role: 'user', content: user });
    if (assistant.trim()) turns.push({ role: 'assistant', content: assistant.trim() });
    return { conversationId, turns };
  }

  // Vercel AI SDK data-stream (`0:"chunk"` lines) — Le Chat, T3 Chat, and most
  // Vercel-templated chat apps.
  function vercelStreamText(body) {
    let text = '';
    for (const line of String(body).split(/\r?\n/)) {
      const m = /^0:(".*")\s*$/.exec(line.trim());
      if (m) {
        const chunk = safeJson(m[1]);
        if (typeof chunk === 'string') text += chunk;
      }
    }
    return text;
  }

  // ── Provider parsers (pure — exposed on window for node tests) ─────────────

  // ChatGPT — POST chatgpt.com/backend-api/(f/)conversation (SSE). Two wire
  // generations, both handled:
  //   • legacy: each `data:` frame carries a full message snapshot with
  //     author.role + content.parts — the last assistant snapshot wins.
  //   • delta encoding (current): one initial frame embeds the assistant
  //     message shell ({v:{message, conversation_id}}), then bare {v:"chunk"}
  //     frames and {o:"append"/"patch", p:"/message/content/parts/0", …}
  //     operations append text. Thought/reasoning patches target other paths
  //     and are skipped. The user prompt is NOT in the reply stream — it rides
  //     the request body's messages[].content.parts (hence reqBody here).
  // ChatGPT conversation-snapshot dedup: snapshots repeat the whole history and
  // are re-fetched several times per turn (init/textdocs/revisit), so remember
  // which final exchanges we've already relayed this page-lifetime.
  const emittedSnapshotKeys = new Set();

  // GET /backend-api/conversation/<uuid> — full conversation tree. The async
  // streaming flow (stream_status) delivers tokens outside the POST body, so
  // this snapshot is the reliable source of finished turns. Emit only the LAST
  // completed user→assistant exchange, once.
  // Returns { conversationId, turns, pending }. `pending: true` means the last
  // user turn has no finished assistant reply yet (reply still generating —
  // worth a retry). Every other empty result (deduped, no user turn) is
  // pending:false so the nudge does NOT re-fetch + re-parse the whole history.
  function parseChatGPTSnapshot(snap) {
    const conversationId = typeof snap.conversation_id === 'string' ? snap.conversation_id : 'session';
    const none = { conversationId, turns: [], pending: false };
    const msgs = [];
    for (const nodeId of Object.keys(snap.mapping)) {
      const m = snap.mapping[nodeId] && snap.mapping[nodeId].message;
      if (!m || !m.author) continue;
      const role = m.author.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const c = m.content || {};
      if (c.content_type && c.content_type !== 'text') continue; // skip thoughts/tool payloads
      if (role === 'assistant' && m.status && m.status !== 'finished_successfully') continue;
      const text = Array.isArray(c.parts) ? c.parts.filter((p) => typeof p === 'string').join('\n').trim() : '';
      if (!text) continue;
      msgs.push({ id: m.id || nodeId, role, text, status: m.status, t: typeof m.create_time === 'number' ? m.create_time : 0 });
    }
    msgs.sort((a, b) => a.t - b.t);
    let lastUserIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx < 0) return none;
    const tail = msgs.slice(lastUserIdx);
    // A user-only tail means the reply is still generating — retry-worthy.
    if (tail[tail.length - 1].role !== 'assistant') return { conversationId, turns: [], pending: true };
    // …and so does an assistant tail that is not explicitly finished.
    //
    // The filter above skips assistant messages whose status says they are
    // unfinished, but `m.status &&` short-circuits: a message with NO status yet —
    // exactly what an in-flight reply looks like for its first moments — passes
    // through with whatever text has been generated so far. On 2026-07-30 that
    // stored a long ChatGPT answer as the three characters "Vod", permanently,
    // because both the emit key below and the gateway's dedupe key are keyed on
    // message id and the stub therefore won forever.
    //
    // Only the TAIL is held to this. Older assistant messages in a long-lived
    // conversation may legitimately predate the field, and demanding it of them
    // would turn a rare truncation into a silent capture-nothing bug — strictly
    // worse. `pending: true` is the existing retry path.
    const last = tail[tail.length - 1];
    if (last.status !== 'finished_successfully') {
      return { conversationId, turns: [], pending: true };
    }
    // Length is part of the key ON PURPOSE. Keyed on ids alone, a message that
    // GREW since the last snapshot looks identical to one already captured, so a
    // completed reply is dropped here and a partial sent earlier stays the only
    // version that ever left the browser. Including the length lets growth
    // re-emit; the gateway then upgrades the stored row (see handleCaptureTurn).
    const key = conversationId + '|' + tail.map((m) => `${m.id}:${m.text.length}`).join('|');
    if (emittedSnapshotKeys.has(key)) return none; // already captured — do NOT retry
    if (emittedSnapshotKeys.size > 500) emittedSnapshotKeys.clear();
    emittedSnapshotKeys.add(key);
    // P0 dedup: m.id is ChatGPT's message id / Claude's chat_messages[].uuid — the
    // exact key capture_turn wants. It was being dropped in this map.
    return { conversationId, turns: tail.map((m) => ({ role: m.role, content: m.text, id: m.id, created_at: vodouTurnTime(m.t) })), pending: false };
  }

  function parseChatGPT(body, url, reqBody) {
    // Snapshot GET returns a plain JSON conversation tree, not SSE.
    const snap = safeJson(String(body));
    if (snap && snap.mapping && typeof snap.mapping === 'object') {
      return parseChatGPTSnapshot(snap);
    }
    let conversationId = 'session';
    let snapshot = '';    // last full assistant snapshot (legacy frames)
    let appended = '';    // text accumulated from delta appends
    let deltaRole = '';   // role of the message the deltas belong to
    let lastPath = '';    // most recent explicit patch path
    let streamUser = '';  // user echo in legacy streams
    const isPartsPath = (p) => p === '' || String(p).includes('/content/parts');
    const applyMessage = (message) => {
      if (!message) return;
      const role = message.author && message.author.role;
      if (role) deltaRole = role;
      const parts = message.content && message.content.parts;
      const text = Array.isArray(parts)
        ? parts.filter((p) => typeof p === 'string').join('\n').trim()
        : '';
      if (!text) return;
      if (role === 'assistant') { snapshot = text; appended = ''; } // later snapshots supersede
      else if (role === 'user' && !streamUser) streamUser = text;
    };
    const applyOp = (op) => {
      if (!op || typeof op !== 'object') return;
      if (op.p !== undefined) lastPath = String(op.p);
      if (op.o === 'append' && typeof op.v === 'string') {
        if (isPartsPath(lastPath) && deltaRole === 'assistant') appended += op.v;
      } else if (op.o === 'patch' && Array.isArray(op.v)) {
        for (const sub of op.v) applyOp(sub);
      } else if (!op.o && op.v && typeof op.v === 'object' && !Array.isArray(op.v) && op.v.message) {
        // initial delta frame: {v:{message:{…}, conversation_id:"…"}}
        applyMessage(op.v.message);
        if (typeof op.v.conversation_id === 'string') conversationId = op.v.conversation_id;
        lastPath = '';
      }
    };
    for (const payload of sseDataChunks(body)) {
      const obj = safeJson(payload);
      if (!obj || typeof obj !== 'object') continue;
      if (typeof obj.conversation_id === 'string') conversationId = obj.conversation_id;
      if (obj.message) { applyMessage(obj.message); lastPath = ''; continue; } // legacy frame
      if (typeof obj.v === 'string' && obj.o === undefined && obj.p === undefined) {
        // bare append — continues the last explicit path (parts by default)
        if (isPartsPath(lastPath) && deltaRole === 'assistant') appended += obj.v;
        continue;
      }
      applyOp(obj);
    }
    // User prompt from the request body (delta-encoding streams never echo it).
    let userText = '';
    const req = safeJson(reqBody || '');
    if (req) {
      if (conversationId === 'session' && typeof req.conversation_id === 'string') {
        conversationId = req.conversation_id;
      }
      if (Array.isArray(req.messages)) {
        for (const m of req.messages) {
          const role = m && m.author && m.author.role;
          const parts = m && m.content && m.content.parts;
          if (role === 'user' && Array.isArray(parts)) {
            const t = parts.filter((p) => typeof p === 'string').join('\n').trim();
            if (t) userText = t; // last user message wins
          }
        }
      }
    }
    if (!userText) userText = streamUser;
    const assistant = (snapshot + appended).trim();
    const turns = [];
    if (userText) turns.push({ role: 'user', content: userText });
    if (assistant) turns.push({ role: 'assistant', content: assistant });
    return { conversationId, turns };
  }

  // Claude — POST claude.ai/api/organizations/*/chat_conversations/*/completion
  // (SSE). Frames carry `completion` text deltas; concatenate them. The USER
  // prompt is not in the reply stream — it rides the request body (`prompt`),
  // so we pull it from reqBody.
  // Claude conversation snapshot — GET .../chat_conversations/<uuid>?tree=True
  // returns the full conversation as `chat_messages: [{sender, text, content,
  // created_at, uuid}]`. Durable capture source (mirrors the ChatGPT snapshot
  // approach): parse the last completed human→assistant exchange, deduped, so
  // capture doesn't depend on the completion stream's envelope staying stable.
  function parseClaudeSnapshot(snap, url) {
    let conversationId = typeof snap.uuid === 'string' ? snap.uuid : 'session';
    const um = /chat_conversations\/([0-9a-f-]{36})/.exec(url || '');
    if (conversationId === 'session' && um) conversationId = um[1];
    // `quiet`: we understood the body and there is simply nothing new in it —
    // already captured, or no user turn yet. Distinct from `pending` (a reply
    // still generating) and from a genuine parse failure, which is the only thing
    // that should warn about wire drift.
    const none = { conversationId, turns: [], pending: false, quiet: true };
    const arr = Array.isArray(snap.chat_messages) ? snap.chat_messages : [];
    const msgs = [];
    for (const cm of arr) {
      if (!cm) continue;
      const role = cm.sender === 'human' ? 'user' : cm.sender === 'assistant' ? 'assistant' : null;
      if (!role) continue;
      // Prefer structured content parts; fall back to the flat `text`.
      let text = '';
      if (Array.isArray(cm.content)) {
        text = cm.content
          .filter((p) => p && (p.type === 'text' || typeof p.text === 'string'))
          .map((p) => (typeof p.text === 'string' ? p.text : ''))
          .join('\n')
          .trim();
      }
      if (!text && typeof cm.text === 'string') text = cm.text.trim();
      if (!text) continue;
      msgs.push({ id: cm.uuid || String(msgs.length), role, text, t: cm.created_at || '' });
    }
    // chat_messages already arrives in order; keep it stable.
    let lastUserIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx < 0) return none;
    const tail = msgs.slice(lastUserIdx);
    if (tail[tail.length - 1].role !== 'assistant') return { conversationId, turns: [], pending: true }; // reply still generating
    // Length is part of the key ON PURPOSE. Keyed on ids alone, a message that
    // GREW since the last snapshot looks identical to one already captured, so a
    // completed reply is dropped here and a partial sent earlier stays the only
    // version that ever left the browser. Including the length lets growth
    // re-emit; the gateway then upgrades the stored row (see handleCaptureTurn).
    const key = 'claude|' + conversationId + '|' + tail.map((m) => `${m.id}:${m.text.length}`).join('|');
    if (emittedSnapshotKeys.has(key)) return none; // already captured — do NOT retry
    if (emittedSnapshotKeys.size > 500) emittedSnapshotKeys.clear();
    emittedSnapshotKeys.add(key);
    return { conversationId, turns: tail.map((m) => ({ role: m.role, content: m.text })), pending: false };
  }

  function parseClaude(body, url, reqBody) {
    // Snapshot GET returns a JSON conversation doc (chat_messages), not SSE.
    const snap = safeJson(String(body));
    if (snap && Array.isArray(snap.chat_messages)) {
      return parseClaudeSnapshot(snap, url);
    }
    // conversation id sits in the URL: .../chat_conversations/<uuid>/completion
    let conversationId = 'session';
    const m = /chat_conversations\/([^/]+)\/completion/.exec(url || '');
    if (m) conversationId = m[1];
    let assistant = '';
    for (const payload of sseDataChunks(body)) {
      const obj = safeJson(payload);
      if (!obj) continue;
      // Claude streams `completion` deltas; some frames use content_block deltas.
      if (typeof obj.completion === 'string') assistant += obj.completion;
      else if (obj.delta && typeof obj.delta.text === 'string') assistant += obj.delta.text;
    }
    assistant = assistant.trim();
    let user = '';
    const req = safeJson(reqBody || '');
    if (req) {
      if (typeof req.prompt === 'string') user = req.prompt.trim();
      else if (Array.isArray(req.messages) && req.messages.length) {
        const last = req.messages[req.messages.length - 1];
        if (last && typeof last.content === 'string') user = last.content.trim();
      }
    }
    const turns = [];
    if (user) turns.push({ role: 'user', content: user });
    if (assistant) turns.push({ role: 'assistant', content: assistant });
    return { conversationId, turns };
  }

  // Gemini — POST gemini.google.com /_/BardChatUi/.../StreamGenerate. Response
  // is `)]}'`-guarded batchexecute framing: JSON array lines whose entries look
  // like ["wrb.fr", null, "<escaped inner json>"]. Inner json: candidates at
  // [4], each candidate's text at [1][0]; conversation ids at [1]. The user
  // prompt rides the request's form-encoded `f.req` envelope.
  function parseGemini(body, url, reqBody) {
    let conversationId = 'session';
    let assistant = '';
    for (const line of String(body).split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith('[[') && !t.startsWith('[')) continue;
      const arr = safeJson(t);
      if (!Array.isArray(arr)) continue;
      for (const entry of arr) {
        if (!Array.isArray(entry) || entry[0] !== 'wrb.fr' || typeof entry[2] !== 'string') continue;
        const inner = safeJson(entry[2]);
        if (!Array.isArray(inner)) continue;
        try {
          const ids = inner[1];
          if (Array.isArray(ids) && typeof ids[0] === 'string' && ids[0]) conversationId = ids[0];
          const candidates = inner[4];
          if (Array.isArray(candidates) && candidates[0] && Array.isArray(candidates[0][1])) {
            const text = candidates[0][1].filter((s) => typeof s === 'string').join('\n').trim();
            if (text) assistant = text; // later frames supersede (streaming updates)
          }
        } catch (_) { /* frame variant — skip */ }
      }
    }
    let user = '';
    try {
      // reqBody: form-encoded `f.req=<urlencoded json>&at=…`
      const m = /(?:^|&)f\.req=([^&]+)/.exec(String(reqBody || ''));
      if (m) {
        const outer = safeJson(decodeURIComponent(m[1].replace(/\+/g, ' ')));
        // outer = [null, "<inner json string>"] ; inner[0][0] = prompt
        const inner = Array.isArray(outer) && typeof outer[1] === 'string' ? safeJson(outer[1]) : outer;
        if (Array.isArray(inner) && Array.isArray(inner[0]) && typeof inner[0][0] === 'string') {
          user = inner[0][0].trim();
        }
      }
    } catch (_) { /* prompt extraction is best-effort */ }
    const turns = [];
    if (user) turns.push({ role: 'user', content: user });
    if (assistant) turns.push({ role: 'assistant', content: assistant });
    return { conversationId, turns };
  }

  // Perplexity — POST perplexity.ai/rest/sse/perplexity_ask (SSE). Streaming
  // frames carry partials; the final frame embeds the full answer as a JSON
  // string (obj.text → {answer}). Query rides the request body (query_str).
  function parsePerplexity(body, url, reqBody) {
    let conversationId = 'session';
    let assistant = '';
    for (const payload of sseDataChunks(body)) {
      const obj = safeJson(payload);
      if (!obj) continue;
      if (typeof obj.backend_uuid === 'string') conversationId = obj.backend_uuid;
      else if (typeof obj.context_uuid === 'string') conversationId = obj.context_uuid;
      if (typeof obj.answer === 'string' && obj.answer.trim()) assistant = obj.answer;
      else if (typeof obj.text === 'string') {
        const inner = safeJson(obj.text);
        if (inner && typeof inner.answer === 'string' && inner.answer.trim()) assistant = inner.answer;
      }
    }
    let user = '';
    const req = safeJson(reqBody || '');
    if (req) {
      if (typeof req.query_str === 'string') user = req.query_str.trim();
      else if (req.params && typeof req.params.query_str === 'string') user = req.params.query_str.trim();
    }
    const turns = [];
    if (user) turns.push({ role: 'user', content: user });
    if (assistant) turns.push({ role: 'assistant', content: assistant.trim() });
    return { conversationId, turns };
  }

  // Grok (grok.com) — POST /rest/app-chat/conversations/{id}/responses (and
  // /new). Response is JSON-lines: token deltas at result.response.token, and
  // a final result.response.modelResponse.message with the complete text.
  // User prompt rides the request body ({message}).
  function parseGrok(body, url, reqBody) {
    let conversationId = 'session';
    const m = /conversations\/([^/]+)\/responses/.exec(url || '');
    if (m && m[1] !== 'new') conversationId = m[1];
    let tokens = '';
    let finalMsg = '';
    for (const obj of jsonLines(body)) {
      const r = obj && obj.result;
      if (!r) continue;
      const resp = r.response || r;
      if (resp && typeof resp.token === 'string') tokens += resp.token;
      const mr = (resp && resp.modelResponse) || r.modelResponse;
      if (mr && typeof mr.message === 'string' && mr.message.trim()) finalMsg = mr.message;
      const conv = r.conversation || (resp && resp.conversation);
      if (conv && typeof conv.conversationId === 'string') conversationId = conv.conversationId;
    }
    const assistant = (finalMsg || tokens).trim();
    let user = '';
    const req = safeJson(reqBody || '');
    if (req && typeof req.message === 'string') user = req.message.trim();
    const turns = [];
    if (user) turns.push({ role: 'user', content: user });
    if (assistant) turns.push({ role: 'assistant', content: assistant });
    return { conversationId, turns };
  }

  // Grok on X (x.com/i/grok) — POST x.com/i/api/2/grok/add_response.json.
  // Response is JSON-lines of {result:{message:"chunk", sender:…}} deltas —
  // accumulate assistant chunks. The user prompt and conversation id ride the
  // request body ({responses:[{message, sender:1}], conversationId}).
  function parseGrokX(body, url, reqBody) {
    let conversationId = 'session';
    let assistant = '';
    for (const obj of jsonLines(body)) {
      const r = obj && obj.result;
      if (!r) continue;
      if (typeof r.conversationId === 'string') conversationId = r.conversationId;
      const senderIsAssistant = r.sender === undefined || r.sender === 2 || String(r.sender).toUpperCase() === 'ASSISTANT';
      if (typeof r.message === 'string' && senderIsAssistant) assistant += r.message;
    }
    let user = '';
    const req = safeJson(reqBody || '');
    if (req) {
      if (typeof req.conversationId === 'string') conversationId = req.conversationId;
      if (Array.isArray(req.responses)) {
        // Last user-sent entry is the current prompt (sender 1 = user).
        for (let i = req.responses.length - 1; i >= 0; i--) {
          const it = req.responses[i];
          if (it && typeof it.message === 'string' && (it.sender === 1 || String(it.sender).toUpperCase() === 'USER')) {
            user = it.message.trim();
            break;
          }
        }
      }
    }
    const turns = [];
    if (user) turns.push({ role: 'user', content: user });
    if (assistant.trim()) turns.push({ role: 'assistant', content: assistant.trim() });
    return { conversationId, turns };
  }

  // DeepSeek (chat.deepseek.com) — POST /api/v0/chat/completion (SSE). Frames
  // are OpenAI-style choice deltas; newer builds also use a compact {v,p}
  // patch format. User prompt rides the request body ({prompt}).
  function parseDeepSeek(body, url, reqBody) {
    let conversationId = 'session';
    let assistant = '';
    for (const payload of sseDataChunks(body)) {
      const obj = safeJson(payload);
      if (!obj) continue;
      const choice = Array.isArray(obj.choices) && obj.choices[0];
      if (choice && choice.delta && typeof choice.delta.content === 'string') {
        assistant += choice.delta.content;
        continue;
      }
      // Compact patch format: {"v":"chunk"} appends to the response content
      // path; {"v":…,"p":"response/…"} targets other fields — only take
      // content-path (or path-less) string patches.
      if (typeof obj.v === 'string' && (obj.p === undefined || /(^|\/)content$/.test(String(obj.p)))) {
        assistant += obj.v;
      }
    }
    const req = safeJson(reqBody || '');
    let user = '';
    if (req) {
      if (typeof req.prompt === 'string') user = req.prompt.trim();
      if (typeof req.chat_session_id === 'string') conversationId = req.chat_session_id;
    }
    const turns = [];
    if (user) turns.push({ role: 'user', content: user });
    if (assistant.trim()) turns.push({ role: 'assistant', content: assistant.trim() });
    return { conversationId, turns };
  }

  // Le Chat (chat.mistral.ai) — POST /api/chat. Streams the Vercel AI data
  // format: `0:"chunk"` lines (JSON-encoded string per line), with e:/d: end
  // frames. Some builds use plain SSE deltas — handle both. Prompt rides the
  // request body (content / messages).
  function parseLeChat(body, url, reqBody) {
    let conversationId = 'session';
    let assistant = vercelStreamText(body);
    if (!assistant) {
      for (const payload of sseDataChunks(body)) {
        const obj = safeJson(payload);
        if (!obj) continue;
        if (typeof obj.text === 'string') assistant += obj.text;
        else if (obj.choices && obj.choices[0] && obj.choices[0].delta && typeof obj.choices[0].delta.content === 'string') {
          assistant += obj.choices[0].delta.content;
        }
      }
    }
    let user = '';
    const req = safeJson(reqBody || '');
    if (req) {
      if (typeof req.message === 'string') user = req.message.trim();
      else user = lastUserContent(req);
      if (typeof req.chatId === 'string') conversationId = req.chatId;
    }
    const turns = [];
    if (user) turns.push({ role: 'user', content: user });
    if (assistant.trim()) turns.push({ role: 'assistant', content: assistant.trim() });
    return { conversationId, turns };
  }

  // Meta AI (meta.ai) — GraphQL mutation useAbraSendMessageMutation. Response
  // is JSON-lines; streamed bot_response_message snippets supersede each other
  // (take the last / OVERALL_DONE). Prompt rides the form-encoded `variables`.
  // EXPERIMENTAL.
  function parseMetaAI(body, url, reqBody) {
    if (!/useAbraSendMessageMutation|AbraSendMessage/i.test(String(reqBody || ''))) {
      return { conversationId: 'session', turns: [] };
    }
    let conversationId = 'session';
    let assistant = '';
    for (const obj of jsonLines(body)) {
      const node = obj && obj.data && (obj.data.node || (obj.data.xfb_abra_message_stream && obj.data.xfb_abra_message_stream.node));
      const msg = node && (node.bot_response_message || node.message);
      if (!msg) continue;
      if (typeof msg.snippet === 'string' && msg.snippet.trim()) assistant = msg.snippet;
      const tid = msg.conversation && (msg.conversation.thread_key || msg.conversation.id);
      if (typeof tid === 'string') conversationId = tid;
    }
    let user = '';
    try {
      const m = /(?:^|&)variables=([^&]+)/.exec(String(reqBody || ''));
      if (m) {
        const vars = safeJson(decodeURIComponent(m[1].replace(/\+/g, ' ')));
        const msg = vars && vars.message;
        if (msg && typeof msg.sensitive_string_value === 'string') user = msg.sensitive_string_value.trim();
      }
    } catch (_) { /* best-effort */ }
    const turns = [];
    if (user) turns.push({ role: 'user', content: user });
    if (assistant.trim()) turns.push({ role: 'assistant', content: assistant.trim() });
    return { conversationId, turns };
  }

  // Google AI Studio (aistudio.google.com) — GenerateContent RPC to the
  // alkalimakersuite endpoint. Response is chunked proto-JSON arrays; text
  // fields appear as [null, "chunk"] pairs — deep-collect them in order.
  // EXPERIMENTAL.
  function parseAIStudio(body, url, reqBody) {
    const root = safeJson(body);
    let assistant = '';
    (function walk(node) {
      if (!Array.isArray(node)) return;
      if (node.length === 2 && node[0] === null && typeof node[1] === 'string') {
        assistant += node[1];
        return;
      }
      for (const child of node) walk(child);
    })(root);
    let user = '';
    const req = safeJson(reqBody || '');
    // Request mirrors the same proto-JSON shape; first [null,"text"] pair is the
    // latest user chunk in most captures — reuse the walker on the request and
    // take the LAST collected string as the prompt candidate.
    if (Array.isArray(req)) {
      const found = [];
      (function walk(node) {
        if (!Array.isArray(node)) return;
        if (node.length === 2 && node[0] === null && typeof node[1] === 'string') { found.push(node[1]); return; }
        for (const child of node) walk(child);
      })(req);
      if (found.length) user = found[found.length - 1].trim();
    }
    const turns = [];
    if (user) turns.push({ role: 'user', content: user });
    if (assistant.trim()) turns.push({ role: 'assistant', content: assistant.trim() });
    return { conversationId: 'session', turns };
  }

  // Copilot (copilot.microsoft.com) — JSON event frames, over WebSocket (and
  // some builds over SSE). send: {event:'send', content:[{type:'text',text}]},
  // receive: {event:'appendText', text} … {event:'done'}. This pure function
  // parses a full frame LIST (the WS tap accumulates frames; the fetch path
  // splits SSE). EXPERIMENTAL.
  function parseCopilotFrames(frames) {
    let conversationId = 'session';
    let user = '';
    let assistant = '';
    for (const f of frames) {
      const obj = typeof f === 'string' ? safeJson(f) : f;
      if (!obj) continue;
      if (typeof obj.conversationId === 'string') conversationId = obj.conversationId;
      if (obj.event === 'send' && Array.isArray(obj.content)) {
        const t = obj.content.find((c) => c && c.type === 'text' && typeof c.text === 'string');
        if (t) user = t.text.trim();
      }
      if ((obj.event === 'appendText' || obj.event === 'text') && typeof obj.text === 'string') assistant += obj.text;
      if (obj.event === 'partCompleted' && typeof obj.text === 'string' && obj.text.trim()) assistant = obj.text;
    }
    const turns = [];
    if (user) turns.push({ role: 'user', content: user });
    if (assistant.trim()) turns.push({ role: 'assistant', content: assistant.trim() });
    return { conversationId, turns };
  }

  // Manus (manus.im) — agent platform; event stream shapes are not publicly
  // documented, so this adapter is deliberately conservative: it only emits
  // frames that carry an explicit role+content/text shape, or accumulates
  // obvious message deltas. Works for both SSE bodies and WS frame lists.
  // EXPERIMENTAL.
  function parseManus(bodyOrFrames, url, reqBody) {
    const frames = Array.isArray(bodyOrFrames)
      ? bodyOrFrames.map((f) => (typeof f === 'string' ? safeJson(f) : f)).filter(Boolean)
      : sseDataChunks(bodyOrFrames).map(safeJson).filter(Boolean).concat(jsonLines(bodyOrFrames));
    let conversationId = 'session';
    let assistant = '';
    let user = '';
    for (const obj of frames) {
      const cid = obj.conversation_id || obj.session_id || obj.task_id || obj.chat_id;
      if (typeof cid === 'string' && cid) conversationId = cid;
      const role = obj.role || (obj.message && obj.message.role);
      const content = typeof obj.content === 'string' ? obj.content
        : typeof obj.text === 'string' ? obj.text
        : obj.message && typeof obj.message.content === 'string' ? obj.message.content
        : '';
      if (role === 'assistant' && content) assistant = content; // full messages supersede
      else if (role === 'user' && content && !user) user = content;
      else if (!role && obj.type === 'message' && content) assistant += content;
      else if (!role && obj.delta && typeof obj.delta.content === 'string') assistant += obj.delta.content;
    }
    if (!user) {
      const req = safeJson(reqBody || '');
      if (req) {
        if (typeof req.prompt === 'string') user = req.prompt.trim();
        else if (typeof req.message === 'string') user = req.message.trim();
        else if (typeof req.content === 'string') user = req.content.trim();
      }
    }
    const turns = [];
    if (user) turns.push({ role: 'user', content: user });
    if (assistant.trim()) turns.push({ role: 'assistant', content: assistant.trim() });
    return { conversationId, turns };
  }

  // Qwen (chat.qwen.ai) — OpenAI-style SSE chat completions.
  function parseQwen(body, url, reqBody) {
    return openAiSseParse(body, reqBody, ['chat_id', 'session_id', 'conversation_id']);
  }

  // Z.ai / GLM (chat.z.ai) — OpenAI-style SSE (plus a data.delta_content
  // variant handled by the shared parser). EXPERIMENTAL.
  function parseZai(body, url, reqBody) {
    return openAiSseParse(body, reqBody, ['chat_id', 'conversation_id']);
  }

  // OpenRouter chatroom (openrouter.ai/chat) — plain OpenAI SSE.
  function parseOpenRouter(body, url, reqBody) {
    return openAiSseParse(body, reqBody, ['conversation_id', 'chat_id']);
  }

  // Kimi (kimi.com / kimi.moonshot.cn) — POST /api/chat/{id}/completion/stream.
  // SSE frames {"event":"cmpl","text":"chunk"}; prompt in request messages.
  function parseKimi(body, url, reqBody) {
    let conversationId = 'session';
    const m = /\/chat\/([^/]+)\/completion/.exec(url || '');
    if (m) conversationId = m[1];
    let assistant = '';
    for (const payload of sseDataChunks(body)) {
      const obj = safeJson(payload);
      if (!obj) continue;
      if (obj.event === 'cmpl' && typeof obj.text === 'string') assistant += obj.text;
    }
    const user = lastUserContent(safeJson(reqBody || ''));
    const turns = [];
    if (user) turns.push({ role: 'user', content: user });
    if (assistant.trim()) turns.push({ role: 'assistant', content: assistant.trim() });
    return { conversationId, turns };
  }

  // Duck.ai (duckduckgo.com/duckchat) — SSE frames {"message":"chunk","role":…};
  // prompt in request messages.
  function parseDuckAI(body, url, reqBody) {
    let assistant = '';
    for (const payload of sseDataChunks(body)) {
      const obj = safeJson(payload);
      if (!obj) continue;
      if (typeof obj.message === 'string' && (obj.role === undefined || obj.role === 'assistant')) {
        assistant += obj.message;
      }
    }
    const user = lastUserContent(safeJson(reqBody || ''));
    const turns = [];
    if (user) turns.push({ role: 'user', content: user });
    if (assistant.trim()) turns.push({ role: 'assistant', content: assistant.trim() });
    return { conversationId: 'session', turns };
  }

  // HuggingChat (huggingface.co/chat) — POST /chat/conversation/{id}. JSON-line
  // events {"type":"stream","token":…} with a {"type":"finalAnswer","text":…}
  // that supersedes. Prompt in request {inputs}.
  function parseHuggingChat(body, url, reqBody) {
    let conversationId = 'session';
    const m = /\/chat\/conversation\/([^/?]+)/.exec(url || '');
    if (m) conversationId = m[1];
    let tokens = '';
    let finalText = '';
    const frames = jsonLines(body).concat(sseDataChunks(body).map(safeJson).filter(Boolean));
    for (const obj of frames) {
      if (obj.type === 'stream' && typeof obj.token === 'string') tokens += obj.token.replace(/\u0000/g, '');
      if (obj.type === 'finalAnswer' && typeof obj.text === 'string') finalText = obj.text;
    }
    const assistant = (finalText || tokens).trim();
    const req = safeJson(reqBody || '');
    let user = '';
    if (req && typeof req.inputs === 'string') user = req.inputs.trim();
    else user = lastUserContent(req);
    const turns = [];
    if (user) turns.push({ role: 'user', content: user });
    if (assistant) turns.push({ role: 'assistant', content: assistant });
    return { conversationId, turns };
  }

  // You.com — GET /api/streamingSearch?q=… (SSE, youChatToken chunks). The
  // prompt rides the URL, not the body.
  function parseYouCom(body, url) {
    let assistant = '';
    for (const payload of sseDataChunks(body)) {
      const obj = safeJson(payload);
      if (!obj) continue;
      if (typeof obj.youChatToken === 'string') assistant += obj.youChatToken;
    }
    let user = '';
    let conversationId = 'session';
    try {
      const q = /[?&]q=([^&]+)/.exec(url || '');
      if (q) user = decodeURIComponent(q[1].replace(/\+/g, ' ')).trim();
      const c = /[?&](?:chatId|chat_id)=([^&]+)/.exec(url || '');
      if (c) conversationId = decodeURIComponent(c[1]);
    } catch (_) { /* ignore */ }
    const turns = [];
    if (user) turns.push({ role: 'user', content: user });
    if (assistant.trim()) turns.push({ role: 'assistant', content: assistant.trim() });
    return { conversationId, turns };
  }

  // T3 Chat (t3.chat) — Vercel AI data stream.
  function parseT3Chat(body, url, reqBody) {
    const assistant = vercelStreamText(body).trim();
    const req = safeJson(reqBody || '');
    const user = lastUserContent(req);
    let conversationId = 'session';
    if (req && typeof req.threadId === 'string') conversationId = req.threadId;
    else if (req && typeof req.chatId === 'string') conversationId = req.chatId;
    const turns = [];
    if (user) turns.push({ role: 'user', content: user });
    if (assistant) turns.push({ role: 'assistant', content: assistant });
    return { conversationId, turns };
  }

  // NotebookLM (notebooklm.google.com) — batchexecute framing like Gemini but
  // with an undocumented inner shape: deep-collect strings from the wrb.fr
  // payloads and keep the longest as the answer; prompt from f.req's first
  // long-ish string. EXPERIMENTAL — expect tuning against live traffic.
  function parseNotebookLM(body, url, reqBody) {
    const collect = (node, out) => {
      if (typeof node === 'string') { out.push(node); return; }
      if (Array.isArray(node)) for (const c of node) collect(c, out);
    };
    let assistant = '';
    for (const line of String(body).split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith('[')) continue;
      const arr = safeJson(t);
      if (!Array.isArray(arr)) continue;
      for (const entry of arr) {
        if (!Array.isArray(entry) || entry[0] !== 'wrb.fr' || typeof entry[2] !== 'string') continue;
        const inner = safeJson(entry[2]);
        const strings = [];
        collect(inner, strings);
        for (const s of strings) {
          if (s.length >= 40 && s.length > assistant.length) assistant = s;
        }
      }
    }
    let user = '';
    try {
      const m = /(?:^|&)f\.req=([^&]+)/.exec(String(reqBody || ''));
      if (m) {
        const outer = safeJson(decodeURIComponent(m[1].replace(/\+/g, ' ')));
        const strings = [];
        collect(outer, strings);
        const inner = strings.map(safeJson).filter(Boolean);
        const more = [];
        for (const i of inner) collect(i, more);
        const candidates = more.concat(strings).filter((s) => s.length >= 2 && s.length < 4000 && !/^[[{]/.test(s));
        if (candidates.length) user = candidates[0].trim();
      }
    } catch (_) { /* best-effort */ }
    const turns = [];
    if (user) turns.push({ role: 'user', content: user });
    if (assistant.trim()) turns.push({ role: 'assistant', content: assistant.trim() });
    return { conversationId: 'session', turns };
  }

  // Poe (poe.com) — GraphQL subscription frames over WebSocket. Outer frames:
  // {"messages":["<json string>", …]}; inner payload.data.messageAdded carries
  // {text, author, state} — Poe echoes the human message as a messageAdded too,
  // and assistant updates carry the FULL text each time (supersede, not append).
  function parsePoeFrames(frames) {
    let conversationId = 'session';
    let user = '';
    let assistant = '';
    for (const f of frames) {
      const outer = typeof f === 'string' ? safeJson(f) : f;
      if (!outer || !Array.isArray(outer.messages)) continue;
      for (const s of outer.messages) {
        const inner = typeof s === 'string' ? safeJson(s) : s;
        const added = inner && inner.payload && inner.payload.data && inner.payload.data.messageAdded;
        if (!added || typeof added.text !== 'string') continue;
        const chatId = inner.payload.unique_id || (added.messageId != null ? String(added.messageId) : null);
        if (chatId && conversationId === 'session') conversationId = String(chatId);
        if (added.author === 'human') { if (added.text.trim()) user = added.text.trim(); }
        else if (added.state === 'complete') assistant = added.text;
        else if (added.text.length > assistant.length) assistant = added.text; // streaming full-text updates
      }
    }
    const turns = [];
    if (user) turns.push({ role: 'user', content: user });
    if (assistant.trim()) turns.push({ role: 'assistant', content: assistant.trim() });
    return { conversationId, turns };
  }

  // Character.AI — JSON-line turn updates from neo.character.ai; each carries
  // the full candidate text (last wins). EXPERIMENTAL.
  function parseCharacterAI(body, url, reqBody) {
    let conversationId = 'session';
    let user = '';
    let assistant = '';
    const frames = jsonLines(body).concat(sseDataChunks(body).map(safeJson).filter(Boolean));
    for (const obj of frames) {
      const turn = obj && obj.turn;
      if (!turn) continue;
      const key = turn.turn_key || {};
      if (typeof key.chat_id === 'string') conversationId = key.chat_id;
      const cand = Array.isArray(turn.candidates) && turn.candidates[0];
      const text = cand && typeof cand.raw_content === 'string' ? cand.raw_content : '';
      if (!text) continue;
      if (turn.author && turn.author.is_human) user = text.trim();
      else assistant = text; // full text per update — last wins
    }
    if (!user) {
      const req = safeJson(reqBody || '');
      const rt = req && req.payload && req.payload.turn;
      const rc = rt && Array.isArray(rt.candidates) && rt.candidates[0];
      if (rc && typeof rc.raw_content === 'string') user = rc.raw_content.trim();
    }
    const turns = [];
    if (user) turns.push({ role: 'user', content: user });
    if (assistant.trim()) turns.push({ role: 'assistant', content: assistant.trim() });
    return { conversationId, turns };
  }

  // ── Adapter registry (fetch/XHR) ───────────────────────────────────────────
  // Each adapter: { name, match(url), parse(respBody, url, reqBody) }.
  const ADAPTERS = [
    {
      name: 'chatgpt',
      // Three real sources; everything else under /backend-api/conversation*
      // (init, prepare, stream_status, textdocs, feedback…) is noise:
      //   POST /backend-api/f/conversation        — send (SSE or async-ack)
      //   POST /backend-api/conversation           — legacy send
      //   GET  /backend-api/conversation/<uuid>    — snapshot (async-stream flow)
      match: (url) => /chatgpt\.com|chat\.openai\.com/.test(url) && (
        /\/backend-api\/f\/conversation(\?|$)/.test(url)
        || /\/backend-api\/conversation(\?|$)/.test(url)
        || /\/backend-api\/conversation\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\?|$)/.test(url)
      ),
      parse: (body, url, reqBody) => parseChatGPT(body, url, reqBody),
    },
    {
      name: 'claude',
      // completion POST (SSE) OR the conversation snapshot GET (JSON tree —
      // fires on conversation open and via our own nudge). Both route to
      // parseClaude, which detects which shape it got.
      match: (url) => /claude\.ai/.test(url) && (
        /\/chat_conversations\/[^/]+\/completion\b/.test(url)
        || /\/chat_conversations\/[0-9a-f-]{36}(\?|$)/.test(url)
      ),
      parse: (body, url, reqBody) => parseClaude(body, url, reqBody),
    },
    {
      name: 'gemini',
      match: (url) => /gemini\.google\.com/.test(url) && /BardFrontendService\/StreamGenerate/.test(url),
      parse: (body, url, reqBody) => parseGemini(body, url, reqBody),
    },
    {
      name: 'perplexity',
      match: (url) => /perplexity\.ai/.test(url) && /\/rest\/sse\/perplexity_ask|\/api\/rest\/sse/.test(url),
      parse: (body, url, reqBody) => parsePerplexity(body, url, reqBody),
    },
    {
      name: 'grok',
      match: (url) => /grok\.com/.test(url) && /\/rest\/app-chat\/conversations\/[^/]+\/(responses|new)\b/.test(url),
      parse: (body, url, reqBody) => parseGrok(body, url, reqBody),
    },
    {
      // Grok inside X — same provider namespace ('grok'), different surface.
      name: 'grok',
      match: (url) => /(?:^|\/\/|\.)(x|twitter)\.com\/i\/api\/2\/grok\/add_response\.json/.test(url),
      parse: (body, url, reqBody) => parseGrokX(body, url, reqBody),
    },
    {
      name: 'deepseek',
      match: (url) => /chat\.deepseek\.com/.test(url) && /\/api\/v\d+\/chat\/completion\b/.test(url),
      parse: (body, url, reqBody) => parseDeepSeek(body, url, reqBody),
    },
    {
      name: 'lechat',
      match: (url) => /chat\.mistral\.ai/.test(url) && /\/api\/chat\b/.test(url),
      parse: (body, url, reqBody) => parseLeChat(body, url, reqBody),
    },
    {
      name: 'metaai',
      match: (url) => /(?:^|\.)meta\.ai/.test(url) && /\/api\/graphql/.test(url),
      parse: (body, url, reqBody) => parseMetaAI(body, url, reqBody),
    },
    {
      name: 'aistudio',
      match: (url) => /alkalimakersuite|aistudio\.google\.com/.test(url) && /GenerateContent/.test(url),
      parse: (body, url, reqBody) => parseAIStudio(body, url, reqBody),
    },
    {
      // Some Copilot builds stream over HTTPS/SSE instead of WS.
      name: 'copilot',
      match: (url) => /copilot\.microsoft\.com/.test(url) && /\/c\/api\/(chat|conversations)/.test(url),
      parse: (body) => parseCopilotFrames(sseDataChunks(body).concat(jsonLines(body))),
    },
    {
      name: 'manus',
      match: (url) => /manus\.im/.test(url) && /\/(api|ws)\/.*(chat|message|session|task|event|stream)/i.test(url),
      parse: (body, url, reqBody) => parseManus(body, url, reqBody),
    },
    {
      name: 'qwen',
      match: (url) => /chat\.qwen\.ai/.test(url) && /\/api\/(v\d+\/)?chat\/completions/.test(url),
      parse: (body, url, reqBody) => parseQwen(body, url, reqBody),
    },
    {
      name: 'kimi',
      match: (url) => /(kimi\.com|kimi\.moonshot\.cn)/.test(url) && /\/completion\/stream/.test(url),
      parse: (body, url, reqBody) => parseKimi(body, url, reqBody),
    },
    {
      name: 'duckai',
      match: (url) => /duckduckgo\.com\/duckchat\/v\d+\/chat/.test(url),
      parse: (body, url, reqBody) => parseDuckAI(body, url, reqBody),
    },
    {
      name: 'huggingchat',
      match: (url) => /huggingface\.co\/chat\/conversation\/[^/?]+/.test(url) && !/__data\.json/.test(url),
      parse: (body, url, reqBody) => parseHuggingChat(body, url, reqBody),
    },
    {
      name: 'youcom',
      match: (url) => /you\.com\/api\/streaming/.test(url),
      parse: (body, url) => parseYouCom(body, url),
    },
    {
      name: 'zai',
      match: (url) => /chat\.z\.ai/.test(url) && /\/api\/(v\d+\/)?chat/.test(url),
      parse: (body, url, reqBody) => parseZai(body, url, reqBody),
    },
    {
      name: 't3chat',
      match: (url) => /t3\.chat/.test(url) && /\/api\/chat/.test(url),
      parse: (body, url, reqBody) => parseT3Chat(body, url, reqBody),
    },
    {
      name: 'openrouter',
      match: (url) => /openrouter\.ai\/api\/v\d+\/chat\/completions/.test(url),
      parse: (body, url, reqBody) => parseOpenRouter(body, url, reqBody),
    },
    {
      name: 'notebooklm',
      match: (url) => /notebooklm\.google\.com/.test(url) && /batchexecute/.test(url),
      parse: (body, url, reqBody) => parseNotebookLM(body, url, reqBody),
    },
    {
      name: 'characterai',
      match: (url) => /(neo\.)?character\.ai/.test(url) && /(streaming|\/turn)/.test(url),
      parse: (body, url, reqBody) => parseCharacterAI(body, url, reqBody),
    },
  ];

  function adapterFor(url) {
    try { return ADAPTERS.find((a) => a.match(url)) || null; } catch (_) { return null; }
  }

  // NOT exposed on `window`. This file runs in world:"MAIN", so `window` here is
  // the PAGE's window — assigning the parser table published ~30 internal functions
  // to chatgpt.com, claude.ai and 20 other origins, where any script could
  // enumerate them. That is a fingerprinting surface and a map of our capture
  // internals, shipped by a test hook whose own comment claimed it was a "no-op in
  // the browser". It never was. Node-side tests import the parsers from source.

  function emit(url, body, reqBody) {
    const adapter = adapterFor(url);
    if (!adapter) return;
    try {
      const { conversationId, turns } = adapter.parse(body, url, reqBody) || {};
      const good = trimTurns(turns || []);
      if (!good.length) { debugMiss(adapter.name, url); return; }
      POST(adapter.name, conversationId || 'session', good);
    } catch (_) { /* never let capture break the page */ }
  }

  // Extract a request body as text where cheaply possible (string bodies cover
  // every current adapter; Request-object and stream bodies are skipped).
  function requestBodyOf(init) {
    try {
      if (init && typeof init.body === 'string') return init.body;
    } catch (_) { /* ignore */ }
    return '';
  }

  // ── ChatGPT async-stream nudge ─────────────────────────────────────────────
  // With async streaming (wss://ws.chatgpt.com) the page only re-fetches the
  // conversation snapshot on load/navigation — passive capture would miss every
  // turn until a reload (observed live 2026-07-13). The stream_status polls
  // carry the conversation uuid; each poll re-arms a quiet-window timer, and
  // when polling stops (turn finished) we fetch the snapshot OURSELVES through
  // the tapped fetch — the normal adapter path parses it, and the snapshot
  // dedup keeps repeats harmless.
  const GPT_STREAM_STATUS_RE = /chatgpt\.com|chat\.openai\.com/;
  const gptStreamStatusUuid = (url) => {
    if (!GPT_STREAM_STATUS_RE.test(url)) return null;
    const m = /\/backend-api\/conversation\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/stream_status/.exec(url);
    return m ? m[1] : null;
  };
  const gptSnapshotTimers = new Map(); // uuid → timeout id
  const GPT_SNAPSHOT_QUIET_MS = 4000;
  const GPT_SNAPSHOT_RETRIES = 6; // unfinished reply → retry every 5s, ~30s cover
  // Latest Authorization header the page sent to backend-api — the snapshot GET
  // needs it (cookie-only can 401); we replay exactly what the app uses.
  let gptAuthHeader = '';
  function rememberGptAuth(input, init) {
    try {
      const readAuth = (h) => {
        if (!h) return '';
        if (typeof h.get === 'function') return h.get('authorization') || '';
        for (const k of Object.keys(h)) {
          if (k.toLowerCase() === 'authorization') return h[k] || '';
        }
        return '';
      };
      const a = readAuth(init && init.headers) || (input && typeof input === 'object' && readAuth(input.headers));
      if (a) gptAuthHeader = a;
    } catch (_) { /* ignore */ }
  }
  function pullGptSnapshot(uuid, attempt) {
    const headers = { accept: 'application/json' };
    if (gptAuthHeader) headers.authorization = gptAuthHeader;
    origFetch(`/backend-api/conversation/${uuid}`, { credentials: 'include', headers })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error('http ' + r.status))))
      .then((body) => {
        const snap = safeJson(body);
        if (!snap || !snap.mapping) return;
        const { conversationId, turns, pending } = parseChatGPTSnapshot(snap);
        if (turns.length) { POST('chatgpt', conversationId, turns); return; }
        // Retry ONLY while the reply is still generating. A deduped/empty
        // result must NOT retry — otherwise every already-captured turn would
        // re-fetch + re-parse the whole history 6x, janking the page.
        if (pending && attempt < GPT_SNAPSHOT_RETRIES) {
          setTimeout(() => pullGptSnapshot(uuid, attempt + 1), 5000);
        }
      })
      .catch((e) => {
        try { console.debug(`[vodou-netcap] chatgpt snapshot pull failed (${e && e.message}) — attempt ${attempt}`); } catch (_) {}
      });
  }
  function scheduleGptSnapshot(uuid) {
    try {
      const prev = gptSnapshotTimers.get(uuid);
      if (prev) clearTimeout(prev);
      gptSnapshotTimers.set(uuid, setTimeout(() => {
        gptSnapshotTimers.delete(uuid);
        pullGptSnapshot(uuid, 0);
      }, GPT_SNAPSHOT_QUIET_MS));
    } catch (_) { /* ignore */ }
  }

  // ── Claude completion-nudge ────────────────────────────────────────────────
  // Same durability play as ChatGPT: after the completion POST, re-fetch the
  // conversation snapshot so capture doesn't hinge on the SSE stream envelope.
  // claude.ai is cookie-authed, so the tapped fetch (which flows through the
  // adapter → parseClaude → parseClaudeSnapshot) is enough — no header replay.
  const claudeSnapTimers = new Map(); // uuid → timeout id
  const CLAUDE_SNAP_QUIET_MS = 4000;
  const CLAUDE_SNAP_RETRIES = 6;
  // org+uuid parsed from a completion URL: /api/organizations/<org>/chat_conversations/<uuid>/completion
  const claudeCompletionRef = (url) => {
    const m = /\/api\/organizations\/([0-9a-f-]{36})\/chat_conversations\/([0-9a-f-]{36})\/completion/.exec(url || '');
    return m ? { org: m[1], uuid: m[2] } : null;
  };
  function pullClaudeSnapshot(org, uuid, attempt) {
    const snapUrl = `/api/organizations/${org}/chat_conversations/${uuid}?tree=True&rendering_mode=messages&render_all_tools=true`;
    origFetch(snapUrl, { credentials: 'include', headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error('http ' + r.status))))
      .then((body) => {
        const snap = safeJson(body);
        if (!snap || !Array.isArray(snap.chat_messages)) return;
        const { conversationId, turns, pending } = parseClaudeSnapshot(snap, snapUrl);
        if (turns.length) { POST('claude', conversationId, turns); return; }
        if (pending && attempt < CLAUDE_SNAP_RETRIES) {
          setTimeout(() => pullClaudeSnapshot(org, uuid, attempt + 1), 5000);
        }
      })
      .catch((e) => {
        try { console.debug(`[vodou-netcap] claude snapshot pull failed (${e && e.message}) — attempt ${attempt}`); } catch (_) {}
      });
  }
  function scheduleClaudeSnapshot(org, uuid) {
    try {
      const prev = claudeSnapTimers.get(uuid);
      if (prev) clearTimeout(prev);
      claudeSnapTimers.set(uuid, setTimeout(() => {
        claudeSnapTimers.delete(uuid);
        pullClaudeSnapshot(org, uuid, 0);
      }, CLAUDE_SNAP_QUIET_MS));
    } catch (_) { /* ignore */ }
  }

  // ── PLAN-AUTO-INJECT-P4 mechanism #1: network body-rewrite ─────────────────
  // For page-fetch providers (ChatGPT — spike-proven 2026-07-15). content.js
  // arms a fenced context block (Ctrl+B → live vault-scoped `mem context`
  // pull); the next prompt-bearing request gets the block spliced into the
  // user turn, invisible to the page UI. The fence is stripped again on
  // recapture (client relay + gateway_extractor::strip_vodou_context), so the
  // injection never re-enters memory. One-shot per arm; auto-expires.
  // Claude is NOT a target here: its /completion dispatches from a
  // Service-Worker realm page fetch can't reach — it uses mechanism #2
  // (composer injection in content.js).
  try { window.__vodouInjectBuild = 'p4-a-2026-07-16'; } catch (_) {}
  const NET_INJECT = { block: null, armedAt: 0, TTL_MS: 10 * 60 * 1000 };
  const NET_INJECT_TARGETS = [
    { name: 'chatgpt', host: /chatgpt\.com|chat\.openai\.com/, path: /\/backend-api\/(f\/)?conversation(\?|$)/ },
  ];
  function netInjectTarget(url) {
    const u = String(url || '');
    const t = NET_INJECT_TARGETS.find((x) => x.host.test(u) && x.path.test(u));
    return t ? t.name : null;
  }
  function armedBlock() {
    if (!NET_INJECT.block) return null;
    if (Date.now() - NET_INJECT.armedAt > NET_INJECT.TTL_MS) { NET_INJECT.block = null; return null; }
    return NET_INJECT.block;
  }
  const injectStatus = (op, extra) => {
    try { window.postMessage(Object.assign({ source: 'vodou-inject-status', op }, extra || {}), '*'); } catch (_) {}
  };
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== 'vodou-inject') return;
    if (d.op === 'arm' && typeof d.block === 'string' && d.block.length) {
      NET_INJECT.block = d.block;
      NET_INJECT.armedAt = Date.now();
      injectStatus('armed');
    } else if (d.op === 'disarm') {
      NET_INJECT.block = null;
      injectStatus('disarmed');
    }
  });
  // Splice `block` ahead of the user turn in a JSON body STRING; return the new
  // string, or null if no known prompt field was found (→ request untouched).
  function injectRewriteBody(bodyStr, block) {
    try {
      const req = JSON.parse(bodyStr);
      let hit = false;
      if (Array.isArray(req.messages)) {                 // ChatGPT shape
        for (let i = req.messages.length - 1; i >= 0; i--) {
          const m = req.messages[i];
          const role = m && (m.role || (m.author && m.author.role));
          if (role !== 'user') continue;
          if (m.content && Array.isArray(m.content.parts) && typeof m.content.parts[0] === 'string') {
            m.content.parts[0] = block + '\n\n' + m.content.parts[0]; hit = true; break;
          }
          if (typeof m.content === 'string') { m.content = block + '\n\n' + m.content; hit = true; break; }
        }
      }
      if (!hit && typeof req.prompt === 'string') {       // generic prompt-field shape
        req.prompt = block + '\n\n' + req.prompt; hit = true;
      }
      return hit ? JSON.stringify(req) : null;
    } catch (_) { return null; }
  }
  // Returns possibly-rewritten fetch args. Handles all body shapes seen live:
  //   A) fetch(url, {body:"<json string>"})       B) fetch(new Request(url,{body}))
  //   C) fetch(url, {body: Blob|ArrayBuffer|TypedArray|URLSearchParams})
  async function maybeInjectArgs(args) {
    const block = armedBlock();
    if (!block) return args;
    const input = args[0];
    const init = args[1];
    const url = (input && input.url) || String(input || '');
    const provider = netInjectTarget(url);
    if (!provider) return args;
    const consumed = (how) => {
      NET_INJECT.block = null;                            // one-shot per arm
      injectStatus('injected', { provider, how, url });
      try { console.debug('[vodou-inject] context attached (' + how + ') → ' + url); } catch (_) {}
    };
    // Case A — string body on the init object (ChatGPT's usual shape).
    if (init && typeof init.body === 'string') {
      const nb = injectRewriteBody(init.body, block);
      if (nb == null) return args;
      consumed('init-string');
      return [input, Object.assign({}, init, { body: nb })];
    }
    // Case B — args[0] is a Request carrying the body (clone → read → rebuild).
    if (input && typeof Request !== 'undefined' && input instanceof Request) {
      let bodyText = '';
      try { bodyText = await input.clone().text(); } catch (_) { return args; }
      if (bodyText) {
        const nb = injectRewriteBody(bodyText, block);
        if (nb != null) {
          try {
            const rewritten = new Request(input, { body: nb });
            consumed('request-clone');
            return [rewritten, init];
          } catch (_) { return args; }
        }
      }
      return args;
    }
    // Case C — non-string body on init.
    if (init && init.body != null && typeof init.body !== 'string') {
      let bodyText = '';
      try {
        const b = init.body;
        if (typeof b.text === 'function') bodyText = await b.text();          // Blob / File
        else if (b instanceof ArrayBuffer) bodyText = new TextDecoder().decode(b);
        else if (b && b.buffer instanceof ArrayBuffer) bodyText = new TextDecoder().decode(b); // TypedArray/DataView
        else if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) bodyText = b.toString();
      } catch (_) { return args; }
      if (bodyText) {
        const nb = injectRewriteBody(bodyText, block);
        if (nb != null) {
          consumed('init-nonstring');
          return [input, Object.assign({}, init, { body: nb })];
        }
      }
      return args;
    }
    return args;
  }
  // Test hook (parsers.test.mjs pattern) — pure functions only.
  try { window.__vodouInjectInternals = { injectRewriteBody, netInjectTarget }; } catch (_) {}

  // ── fetch shim ─────────────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    try {
      args = await maybeInjectArgs(args);
    } catch (_) { /* an inject error must never break the send */ }
    const resp = await origFetch.apply(this, args);
    try {
      const url = (args[0] && args[0].url) || String(args[0] || '');
      if (/chatgpt\.com|chat\.openai\.com/.test(url) && url.includes('/backend-api/')) {
        rememberGptAuth(args[0], args[1]);
        // Nudge triggers: stream_status polls (each re-arms the quiet timer)…
        const gptUuid = gptStreamStatusUuid(url);
        if (gptUuid) scheduleGptSnapshot(gptUuid);
        // …and the send itself, so turns capture even when stream_status
        // never polls (fast non-thinking replies).
        if (/\/backend-api\/(f\/)?conversation(\?|$)/.test(url)) {
          const req = safeJson(requestBodyOf(args[1]));
          if (req && typeof req.conversation_id === 'string') scheduleGptSnapshot(req.conversation_id);
        }
      }
      const cref = claudeCompletionRef(url);
      if (cref) scheduleClaudeSnapshot(cref.org, cref.uuid);
      if (adapterFor(url)) {
        const reqBody = requestBodyOf(args[1]);
        // Clone so the page still consumes its own stream untouched.
        resp.clone().text().then((body) => emit(url, body, reqBody)).catch(() => {});
      }
    } catch (_) { /* ignore */ }
    return resp;
  };

  // ── XHR shim (some clients still use XHR for the streaming endpoint) ─────────
  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__vodouUrl = url;
      return open.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      try {
        const gptUuid = this.__vodouUrl && gptStreamStatusUuid(String(this.__vodouUrl));
        if (gptUuid) scheduleGptSnapshot(gptUuid);
        if (this.__vodouUrl && adapterFor(this.__vodouUrl)) {
          const reqBody = typeof body === 'string' ? body : '';
          this.addEventListener('load', () => {
            try { emit(this.__vodouUrl, this.responseText || '', reqBody); } catch (_) {}
          });
        }
      } catch (_) { /* ignore */ }
      return send.apply(this, arguments);
    };
  }

  // ── WebSocket tap (Copilot, Manus stream over WS — invisible to fetch/XHR) ──
  // Each WS adapter: { name, match(url), isDone(frameObj) } — frames (sent and
  // received) accumulate per-socket; on a done-signal (or socket close) the
  // frame list is handed to the provider's frame parser.
  const WS_ADAPTERS = [
    {
      name: 'copilot',
      match: (url) => /copilot\.microsoft\.com/.test(url) && /\/c\/api\/chat/.test(url),
      parse: (frames) => parseCopilotFrames(frames),
      isDone: (obj) => obj && obj.event === 'done',
    },
    {
      name: 'manus',
      match: (url) => /manus\.im/.test(url),
      parse: (frames, url) => parseManus(frames, url, ''),
      isDone: (obj) => obj && (obj.event === 'done' || obj.type === 'finish' || obj.finished === true),
    },
    {
      // Poe streams GraphQL subscription updates over wss://*.tch.poe.com/up/…
      name: 'poe',
      match: (url) => /(\.tch\.)?poe\.com\/up\//.test(url) || /poe\.com.*websocket/i.test(url),
      parse: (frames) => parsePoeFrames(frames),
      isDone: (obj) => !!(obj && Array.isArray(obj.messages)
        && obj.messages.some((s) => typeof s === 'string' && s.includes('"state":"complete"'))),
    },
  ];

  const OrigWS = window.WebSocket;
  if (OrigWS) {
    const TappedWS = function (url, protocols) {
      const sock = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
      try {
        const u = String(url || '');
        const adapter = WS_ADAPTERS.find((a) => { try { return a.match(u); } catch (_) { return false; } });
        if (adapter) {
          const frames = [];
          const flush = () => {
            if (!frames.length) return;
            try {
              const { conversationId, turns } = adapter.parse(frames.splice(0), u) || {};
              const good = trimTurns(turns || []);
              if (good.length) POST(adapter.name, conversationId || 'session', good);
              else debugMiss(adapter.name, u);
            } catch (_) { /* ignore */ }
          };
          sock.addEventListener('message', (ev) => {
            if (typeof ev.data !== 'string') return;
            const obj = safeJson(ev.data);
            if (obj) frames.push(obj);
            try { if (obj && adapter.isDone(obj)) flush(); } catch (_) { /* ignore */ }
          });
          const origSend = sock.send.bind(sock);
          sock.send = function (data) {
            try {
              if (typeof data === 'string') {
                const obj = safeJson(data);
                if (obj) frames.push(obj);
              }
            } catch (_) { /* ignore */ }
            return origSend(data);
          };
          sock.addEventListener('close', flush);
        }
      } catch (_) { /* tap must never break the page's socket */ }
      return sock;
    };
    TappedWS.prototype = OrigWS.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
      try { TappedWS[k] = OrigWS[k]; } catch (_) { /* ignore */ }
    }
    window.WebSocket = TappedWS;
  }
})();
