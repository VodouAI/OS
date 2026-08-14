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

(function () {
  if (window.__vodouNetCapInstalled) return;
  window.__vodouNetCapInstalled = true;

  // A streaming site can hand the same finished turn to the tap more than once —
  // Poe re-sent its completed reply on three subsequent subscription frames, and
  // each one satisfied the done-predicate, so the answer was stored three times.
  // Guarding here rather than in one adapter covers every present and future
  // adapter, and duplicate memory is worse than missing memory: it survives,
  // compounds on every re-read, and looks like corroboration.
  const postedOnce = new Set();
  const POST = (provider, conversationId, turns, backfill) => {
    if (!turns || !turns.length) return;
    try {
      const sig = provider + '|' + conversationId + '|' + turns
        .map((t) => t.role + ':' + String(t.content || '').length + ':' + String(t.content || '').slice(0, 64))
        .join('|');
      if (postedOnce.has(sig)) {
        console.debug(`[vodou-netcap] ${provider}: duplicate turn(s) suppressed`);
        return;
      }
      postedOnce.add(sig);
      // PLAN-CAPTURE-FEED P1 — the page IS the conversation, so location.href is
      // the link back to it. Captured generically here rather than rebuilt later
      // from a per-provider URL template: templates rot, and three providers moved
      // hosts in a single session on 2026-07-27 (duck.ai, grok.x.com,
      // notebook.google.com). Query strings are kept — several sites carry the
      // thread id there (x.com/i/grok?conversation=…) — but the hash is dropped
      // since it is UI state, not identity.
      let pageUrl = '';
      try { pageUrl = String(location.href || '').split('#')[0].slice(0, 2000); } catch (_) { /* ignore */ }
      // `sig` rides along so a relay that neither stored NOR held the turns can
      // un-mark it below — otherwise this Set permanently suppresses the natural
      // re-fetch that would have recovered them (PLAN-ENGINE-GATED-CAPTURE P0).
      // `backfill`: this batch is a whole HISTORIC transcript, not a live turn.
      // The gateway needs to know, because its duplicate-claim is time-bounded for
      // the live case (two relays seconds apart) and a backfilled turn can be
      // months old — see conversation-store's adopt-in-place.
      window.postMessage({ source: 'vodou-netcap', provider, conversationId, turns, url: pageUrl, sig, backfill: !!backfill }, '*');
      // This line used to read "captured N turn(s) → relayed to bridge" and was
      // printed HERE — before the content script, the extension worker or the
      // bridge socket had touched it. All three can drop the message. On
      // 2026-07-26 the gateway refused every socket for an hour while this line
      // reported success on every capture and nothing reached the database.
      // Now it states only what this layer actually knows; the outcome arrives
      // as an ack below.
      // Report SIZES, not just a count. A count cannot distinguish a captured reply
      // from a spliced fragment of one — Kimi 2026-07-31 printed "parsed 2 turn(s)"
      // over 186 characters cut out of a much longer answer, twice, and the only way
      // to see it was to read the stored row. A length next to each role makes the
      // mismatch obvious against what is on screen.
      const sizes = turns.map((t) => `${t.role} ${String(t.content || '').length}ch`).join(', ');
      console.debug(`[vodou-netcap] ${provider}: parsed ${turns.length} turn(s) [${sizes}] — sending to Vodou…`);
    } catch (_) { /* ignore */ }
  };

  // PLAN-HISTORY-BACKFILL P1 — backfill mode, pushed from the content script.
  //
  // OFF by default and it must stay that way: capture is forward-only unless the
  // user opts in per site, so this flag is the whole consent boundary. The page
  // shim cannot read chrome.storage (it runs in the MAIN world), so the content
  // script owns the setting and pushes it here.
  //
  // What it changes: a conversation-snapshot parser normally emits only the LAST
  // completed exchange. With backfill on it emits the WHOLE transcript once per
  // conversation. The bytes are already on the wire either way — the site fetched
  // them to render the thread — so this adds no request, no permission and no
  // scraping. It only stops us throwing the older turns away.
  const backfill = { enabled: false, sites: {} };
  const backfillOn = (provider) => !!backfill.enabled && backfill.sites[provider] !== false;

  try {
    window.addEventListener('message', (ev) => {
      if (ev.source !== window) return;
      const d = ev.data;
      if (d && d.source === 'vodou-netcap-config') {
        backfill.enabled = !!d.backfill;
        backfill.sites = (d.backfillSites && typeof d.backfillSites === 'object') ? d.backfillSites : {};
        try { console.debug(`[vodou-netcap] backfill ${backfill.enabled ? 'ON' : 'off'}`); } catch (_) {}
        return;
      }
      // What the gateway actually WROTE, as opposed to what we handed over.
      // Printed by the only layer that can observe it (the ack round-trip), which
      // is the rule the netcap ack exists to enforce in the first place.
      if (d && d.source === 'vodou-netcap-stored') {
        const stored = Number(d.stored) || 0;
        const sent = Number(d.sent) || 0;
        if (stored > 0 && stored < sent) {
          console.debug(`[vodou-netcap] ${d.provider}: ${stored} new turn(s) saved, ${sent - stored} already had ✓`);
        } else if (stored > 0) {
          console.debug(`[vodou-netcap] ${d.provider}: ${stored} turn(s) saved ✓`);
        } else {
          // Not a failure: a re-opened conversation re-sends its whole transcript
          // and every turn collapses on its provider id. Say so plainly, because
          // "0 stored" read as breakage is how a working dedup gets "fixed".
          console.debug(`[vodou-netcap] ${d.provider}: nothing new — all ${sent} turn(s) were already saved ✓`);
        }
        return;
      }
      if (!d || d.source !== 'vodou-netcap-ack') return;
      if (d.ok) {
        // RELAYED, not stored. This line used to say "STORED by Vodou ✓", which the
        // content script cannot know: it has only handed the batch to the worker.
        // The write result arrives separately, above.
        console.debug(`[vodou-netcap] ${d.provider}: ${d.n} turn(s) relayed to Vodou — awaiting write`);
      } else if (d.queued) {
        // Not lost — the extension is holding them until Vodou is reachable.
        console.warn(`[vodou-netcap] ${d.provider}: ${d.n} turn(s) HELD for retry — ${d.reason}`);
      } else {
        // Deliberately console.warn, not debug: this is the failure that looks
        // exactly like success from inside the page, and it must be visible at
        // the console's default level rather than only under Verbose.
        console.warn(`[vodou-netcap] ${d.provider}: ${d.n} turn(s) NOT stored — ${d.reason}`);
        // Nothing kept them, so forget we ever sent them. The next snapshot or
        // nudge for this conversation is then free to deliver the same turns
        // again instead of being suppressed as a duplicate of a turn that only
        // ever existed in this Set.
        if (d.sig) postedOnce.delete(d.sig);
      }
    });
    // Ask for the current config. The content script also pushes on load and on
    // change, but the two scripts race: whichever starts second would otherwise
    // miss the other's one-shot. Asking makes the handshake order-independent —
    // and a missed config means backfill silently stays OFF, which is the safe
    // way for this particular switch to fail.
    window.postMessage({ source: 'vodou-netcap-config-request' }, '*');
  } catch (_) { /* ignore */ }

  // Include a shape sample: "parsed 0 turns" alone does not say whether the body
  // arrived empty, arrived binary, or arrived fine and the parser looked in the
  // wrong place — and those need different fixes.
  const debugMiss = (name, url, body, reqBody) => {
    try {
      const b = String(body == null ? '' : body);
      const rb = String(reqBody == null ? '' : reqBody);
      // A STRUCTURAL census, not just a byte sample. "0 turns" plus 220 head bytes
      // cannot distinguish "the body never parsed" from "it parsed fine and the
      // owner resolution dropped everything" — and those need opposite fixes.
      // Kimi 2026-07-31: a reply arrived as 217 think frames + 33 text frames and
      // produced nothing, and the head bytes looked perfectly healthy, so the head
      // sample actively pointed away from the cause. Count what the parser SAW.
      let census = '(census unavailable)';
      try {
        const frames = scanJsonObjects(b);
        let msgFrames = 0, blockFrames = 0, degraded = false;
        const roles = Object.create(null);
        const ids = new Set();
        for (const f of frames) {
          if (f && f.message) {
            msgFrames++;
            if (f.message.id) ids.add(String(f.message.id));
            const r = f.message.role ? String(f.message.role) : '(no role)';
            roles[r] = (roles[r] || 0) + 1;
          }
          if (f && f.block) blockFrames++;
          if (f && f.notification && /DEGRADE/i.test(String(f.notification.type || ''))) degraded = true;
        }
        census = `frames=${frames.length} messageFrames=${msgFrames} blockFrames=${blockFrames} `
          + `distinctMessageIds=${ids.size} roles=${JSON.stringify(roles)}`
          + (degraded ? ' MODEL_DEGRADE=yes' : '');
      } catch (e) {
        census = `(census threw: ${(e && e.message) || e})`;
      }
      console.debug(
        `[vodou-netcap] ${name} adapter matched but parsed 0 turns — wire format may have changed`,
        '\n  url        :', redactUrl(url),
        '\n  census     :', census,
        '\n  resp bytes :', b.length, '| head:', JSON.stringify(b.slice(0, 220)),
        '\n  req  bytes :', rb.length, '| head:', JSON.stringify(rb.slice(0, 220)),
      );
    } catch (_) { /* ignore */ }
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

  // Decode a WebSocket text frame that may be Socket.IO / Engine.IO framed.
  //
  // Manus streams over Socket.IO (wss://…/socket.io/?EIO=4&transport=websocket),
  // whose frames look like `42["event",{…}]` — an Engine.IO packet type, then a
  // Socket.IO packet type, then the JSON. Feeding that to JSON.parse fails, so
  // the WS tap accumulated nothing and capture was silent on every Socket.IO
  // site. Plain-JSON frames (Copilot, Poe) still pass straight through.
  // WebSocket payloads are not always text. Meta AI's gateway sends a protobuf
  // envelope with JSON embedded as string fields, and every WS path here tested
  // `typeof data === 'string'` — so the socket looked silent (confirmed live
  // 2026-07-27). Decode bytes to UTF-8 and let the frame decoder try; a binary
  // protocol with no JSON in it simply yields nothing, as before.
  function wsFrameText(data) {
    try {
      if (typeof data === 'string') return data;
      if (data instanceof ArrayBuffer && typeof TextDecoder !== 'undefined') {
        return new TextDecoder('utf-8', { fatal: false }).decode(data);
      }
      if (ArrayBuffer.isView(data) && typeof TextDecoder !== 'undefined') {
        return new TextDecoder('utf-8', { fatal: false }).decode(data.buffer || data);
      }
    } catch (_) { /* ignore */ }
    return '';
  }

  function decodeWsFrame(data) {
    const str = String(data == null ? '' : data);
    if (!str) return null;
    const direct = safeJson(str);
    // Objects/arrays only: Socket.IO pings are the bare string "2", which
    // JSON.parse happily turns into the NUMBER 2 and would pollute the frame
    // list with junk the parsers then have to skip.
    if (direct && typeof direct === 'object') return direct;
    // <engine><socketio>[-<attachments>] then a JSON array or object.
    const m = /^\d{1,2}(?:\d+-)?\s*(\[[\s\S]*\]|\{[\s\S]*\})$/.exec(str.trim());
    if (!m) return null;
    const inner = safeJson(m[1]);
    if (!inner) return null;
    // Socket.IO events arrive as ["eventName", payload, …] — normalise so
    // parsers see a shape with a name and a body rather than a bare array.
    if (Array.isArray(inner)) return { event: inner[0], data: inner.slice(1), __socketio: true };
    return inner;
  }

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
        // AI SDK v5 messages carry `parts: [{type:'text', text:'…'}]` and no
        // `content` at all (t3.chat, live 2026-07-27). Without this the reply
        // captured and the PROMPT did not — one-sided capture that reads as a
        // half-broken parser rather than a missing message shape.
        if (Array.isArray(m.parts)) {
          const text = m.parts
            .filter((p) => p && p.type !== 'reasoning' && typeof p.text === 'string')
            .map((p) => p.text)
            .join('');
          if (text.trim()) return text.trim();
        }
      }
    }
    if (typeof req.prompt === 'string') return req.prompt.trim();
    if (typeof req.content === 'string') return req.content.trim();
    // Mistral (and others) post {content:[{type:'text',text:'…'}]} — an ARRAY of
    // parts rather than a string. The string-only check above silently returned
    // nothing, so the user turn was lost even when the adapter matched.
    if (Array.isArray(req.content)) {
      const parts = req.content
        .filter((c) => c && (typeof c.text === 'string' || typeof c.value === 'string'))
        .map((c) => c.text || c.value);
      if (parts.length) return parts.join('').trim();
    }
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
      // Z.ai / GLM streams the model's CHAIN OF THOUGHT on this exact field, with
      // nothing but `phase` to tell it from the answer ("thinking" | "answer" |
      // "other" (usage) | "done"). Confirmed live 2026-07-27: a 17KB response was
      // ~2/3 thinking, and it stored as the reply — the model's private analysis
      // OF THE USER, filed as if it had said it.
      //
      // Allowlisted, not blocklisted: `phase !== 'thinking'` would capture the next
      // phase name they invent. A frame with no phase at all is a plain OpenAI-style
      // build and still counts. Sixth distinct reasoning scheme across six sites.
      else if (obj.data && typeof obj.data.delta_content === 'string') {
        const phase = typeof obj.data.phase === 'string' ? obj.data.phase : '';
        if (!phase || phase === 'answer') assistant += obj.data.delta_content;
      }
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
    if (text) return text;

    // AI SDK v5 replaced the numbered-line protocol with typed SSE frames
    // (t3.chat, live 2026-07-27):
    //   data: {"type":"text-start","id":"gen-…"}
    //   data: {"type":"text-delta","id":"gen-…","delta":"Ack"}
    //   data: {"type":"text-end","id":"gen-…"}
    // The v4 scan finds nothing here, so the adapter reported "parsed 0 turns"
    // with a perfectly good reply on the wire.
    //
    // ALLOWLIST 'text-delta' — do not accept "any frame with a delta". v5 also
    // streams `reasoning-delta` frames on this same wire, and a shape-based match
    // would file the model's chain of thought as the reply. Seventh reasoning
    // scheme, and the first one we handled BEFORE it bit us.
    for (const payload of sseDataChunks(body)) {
      const obj = safeJson(payload);
      if (!obj || obj.type !== 'text-delta') continue;
      if (typeof obj.delta === 'string') text += obj.delta;
      else if (typeof obj.textDelta === 'string') text += obj.textDelta;   // early v5 betas
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
    // `quiet`: we understood the body and there is simply nothing new in it —
    // already captured, or no user turn yet. Distinct from `pending` (a reply
    // still generating) and from a genuine parse failure, which is the only thing
    // that should warn about wire drift.
    const none = { conversationId, turns: [], pending: false, quiet: true };
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

    // PLAN-HISTORY-BACKFILL P1 — ChatGPT is the biggest back catalogue of the lot,
    // and the endpoint the plan listed as "still not identified" is the one this
    // parser has been reading all along: GET /backend-api/conversation/<uuid>,
    // matched by the adapter above. `msgs` is already the WHOLE conversation tree,
    // flattened from `mapping`, role-filtered, non-text content dropped, unfinished
    // assistant turns skipped, and sorted by create_time. Forward-only capture then
    // keeps just the last exchange. With backfill armed we keep all of it.
    //
    // Each turn carries the ChatGPT message id, which is P0's dedup key — so
    // re-opening the thread (which re-fetches this same tree) collapses instead of
    // re-storing. That matters more here than anywhere: the worst duplicate case ever
    // measured was a ChatGPT thread holding the same turn TEN times.
    if (msgs.length && backfillOn('chatgpt')) {
      const allKey = 'chatgpt|all|' + conversationId + '|' + msgs.length + '|'
        + msgs.reduce((n, m) => n + m.text.length, 0);
      if (!emittedSnapshotKeys.has(allKey)) {
        if (emittedSnapshotKeys.size > 500) emittedSnapshotKeys.clear();
        emittedSnapshotKeys.add(allKey);
        try {
          console.debug(`[vodou-netcap] chatgpt BACKFILL: emitting ${msgs.length} turn(s) from history`);
        } catch (_) { /* ignore */ }
        return {
          conversationId,
          turns: msgs.map((m) => ({ role: m.role, content: m.text, id: m.id })),
          pending: false,
          backfill: true,
        };
      }
      return none;   // this exact transcript already went once
    }

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
    return { conversationId, turns: tail.map((m) => ({ role: m.role, content: m.text, id: m.id })), pending: false };
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

    // PLAN-HISTORY-BACKFILL P1 — the whole catalogue, not just the tail.
    //
    // Everything above already produced the FULL transcript: `msgs` holds every
    // human/assistant turn with its `uuid` (which is exactly P0's dedup key) and its
    // text pulled from `content[]`. Forward-only capture then throws all but the last
    // exchange away. With backfill armed we emit the lot ONCE per conversation, and
    // the gateway's dedup decides what is genuinely new — re-opening the thread
    // re-fetches the same transcript, and each turn's provider uuid collapses it.
    //
    // Keyed on the conversation + turn count + total length so a thread that GREW
    // since the last pass re-emits (same reasoning as the tail key below), rather
    // than the first pass being the only one that ever lands.
    if (msgs.length && backfillOn('claude')) {
      const allKey = 'claude|all|' + conversationId + '|' + msgs.length + '|'
        + msgs.reduce((n, m) => n + m.text.length, 0);
      if (!emittedSnapshotKeys.has(allKey)) {
        if (emittedSnapshotKeys.size > 500) emittedSnapshotKeys.clear();
        emittedSnapshotKeys.add(allKey);
        try {
          console.debug(`[vodou-netcap] claude BACKFILL: emitting ${msgs.length} turn(s) from history`);
        } catch (_) { /* ignore */ }
        return {
          conversationId,
          turns: msgs.map((m) => ({ role: m.role, content: m.text, id: m.id })),
          pending: false,
          backfill: true,
        };
      }
      return none;   // this exact transcript already went once
    }

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
    // P0 dedup: m.id is ChatGPT's message id / Claude's chat_messages[].uuid — the
    // exact key capture_turn wants. It was being dropped in this map.
    return { conversationId, turns: tail.map((m) => ({ role: m.role, content: m.text, id: m.id })), pending: false };
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
          // REASONING WARNING (verified 2026-07-27): Gemini streams its
          // chain-of-thought in this SAME response — "Contextualize the Info",
          // "I've successfully identified the user's intent…", "Refining the
          // Approach" — plus the user's coarse location (city, state, country)
          // and map tile URLs. None of it reaches memory today, but only because
          // the answer lives at inner[4] -> candidates[0][1] and the reasoning
          // sits in a different slot. That is a POSITIONAL accident, not a
          // filter: if Google reorders these arrays the reasoning lands in the
          // assistant turn silently. Re-run the leak check after any Gemini
          // change (see CAPTURE-ADAPTER-DEBUGGING.md "Things that bit us").
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
  // Perplexity (www.perplexity.ai) — POST /rest/sse/perplexity_ask, SSE.
  // Wire format confirmed from a live dump 2026-07-27. The answer is NOT a
  // top-level field any more; it lives inside a structured block tree:
  //
  //   blocks[] -> {intended_usage:"workflow_root", workflow_block:{
  //                  steps:[{ items:[{ type:"WORKFLOW_ITEM_TEXT",
  //                           payload:{text_payload:{ text:"…", chunks:[…],
  //                                                   variant:"answer" }},
  //                           variant:"answer" }] }] }}
  //
  // Frames are cumulative — each SSE message carries the whole document with
  // more of it filled in, ending with "final": true. So the answer is ASSIGNED
  // per frame (last complete one wins), never appended; appending would repeat
  // the reply once per frame.
  //
  // `variant` is the discriminator: only "answer" items are the reply. Other
  // usages in the same tree (answer_tabs, pending_followups, and any
  // plan/step/reasoning variants) are UI scaffolding, not speech. Taking every
  // text_payload would splice search-step chatter into the assistant's turn.
  function parsePerplexity(body, url, reqBody) {
    let conversationId = 'session';
    let assistant = '';
    let finalAnswer = '';          // from the frame that declares final:true
    // Collect the answer text out of one frame's block tree.
    const answerFromBlocks = (blocks) => {
      if (!Array.isArray(blocks)) return '';
      let out = '';
      const takeItem = (item) => {
        if (!item || typeof item !== 'object') return;
        const tp = item.payload && item.payload.text_payload;
        if (!tp || typeof tp.text !== 'string') return;
        const variant = String(item.variant || tp.variant || 'answer').toLowerCase();
        if (variant !== 'answer') return;      // plan / step / reasoning scaffolding
        out += tp.text;
      };
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        const wb = b.workflow_block;
        if (wb && Array.isArray(wb.steps)) {
          for (const step of wb.steps) {
            if (step && Array.isArray(step.items)) step.items.forEach(takeItem);
          }
        }
        // Legacy shapes kept as fallbacks — older builds put the answer here.
        if (b.markdown_block && typeof b.markdown_block.answer === 'string') out += b.markdown_block.answer;
        if (b.plan_block && Array.isArray(b.plan_block.goals)) { /* plan = scaffolding, skip */ }
      }
      return out;
    };

    for (const payload of sseDataChunks(body)) {
      const obj = safeJson(payload);
      if (!obj) continue;
      if (typeof obj.backend_uuid === 'string') conversationId = obj.backend_uuid;
      else if (typeof obj.context_uuid === 'string') conversationId = obj.context_uuid;

      const fromBlocks = answerFromBlocks(obj.blocks);
      if (fromBlocks.trim()) {
        // Frames are cumulative, so a later frame supersedes an earlier one —
        // but "later" is not the same as "complete". Perplexity ABORTS its own
        // stream when the SPA navigates to the thread URL after the first
        // message of a new thread (observed: "BodyStreamBuffer was aborted",
        // reply stored as just "Acknowledged."). Prefer the frame that declares
        // itself final; fall back to the newest one otherwise.
        if (obj.final === true || obj.final_sse_message === true) finalAnswer = fromBlocks;
        assistant = fromBlocks;
        continue;
      }

      // Legacy top-level shapes.
      if (typeof obj.answer === 'string' && obj.answer.trim()) assistant = obj.answer;
      else if (typeof obj.text === 'string') {
        const inner = safeJson(obj.text);
        if (inner && typeof inner.answer === 'string' && inner.answer.trim()) assistant = inner.answer;
      }
    }

    let user = '';
    const req = safeJson(reqBody || '');
    if (req) {
      const pr = req.params || {};
      for (const k of ['query_str', 'dsl_query']) {
        if (typeof req[k] === 'string' && req[k].trim()) { user = req[k].trim(); break; }
        if (typeof pr[k] === 'string' && pr[k].trim()) { user = pr[k].trim(); break; }
      }
    }
    // The response echoes the prompt too — use it if the request did not carry one.
    if (!user) {
      for (const payload of sseDataChunks(body)) {
        const obj = safeJson(payload);
        if (obj && typeof obj.query_str === 'string' && obj.query_str.trim()) { user = obj.query_str.trim(); break; }
      }
    }
    // Prefer the frame that declared itself final over merely the newest one.
    const reply = finalAnswer.trim() ? finalAnswer : assistant;
    const turns = [];
    if (user) turns.push({ role: 'user', content: user });
    if (reply.trim()) turns.push({ role: 'assistant', content: reply.trim() });
    return { conversationId, turns };
  }

  // Grok (grok.com) — POST /rest/app-chat/conversations/{id}/responses (and
  // /new). Response is JSON-lines: token deltas at result.response.token, and
  // a final result.response.modelResponse.message with the complete text.
  // User prompt rides the request body ({message}).
  // Grok (grok.com) — endpoint family confirmed from a live dump 2026-07-27.
  //
  //   POST .../conversations/<id>/load-responses   <- THE TRANSCRIPT
  //        {"responses":[{responseId, sender:"human"|"assistant", message, createTime,
  //                       steps:[…], thinkingStartTime, …}]}
  //   POST .../conversations/<id>/responses        <- legacy streaming (JSON lines)
  //   GET  .../conversations_v2/<id>               <- metadata only (title, timestamps)
  //   POST .../conversations/<id>/response-node    <- id graph only, no content
  //
  // Two things to get right here:
  //
  // 1. `sender` is "human" / "assistant" — key off it, never off position. The
  //    payload happened to arrive human-first, but response-node shows Grok
  //    models turns as a PARENT-POINTER GRAPH (parentResponseId), so array order
  //    is not a contract. Sorted by createTime.
  // 2. `steps[]` holds Grok's REASONING headers ("Thinking about your request",
  //    "Acknowledging the test completion record") in the SAME object as the
  //    answer. Only `message` is the reply. Same rule as Kimi's think blocks and
  //    DeepSeek's THINKING fragments: reasoning is the model deliberating about
  //    the user, and filing it as speech to the user is the worse failure.
  function parseGrok(body, url, reqBody) {
    let conversationId = 'session';
    const cm = /conversations(?:_v2)?\/([^/?#]+)/.exec(url || '');
    if (cm && cm[1] !== 'new') conversationId = cm[1];

    // --- Transcript form: load-responses -------------------------------------
    const doc = safeJson(body || '');
    if (doc && Array.isArray(doc.responses)) {
      const rows = doc.responses
        .filter((r) => r && typeof r.message === 'string' && r.message.trim())
        .slice()
        .sort((a, b) => String(a.createTime || '').localeCompare(String(b.createTime || '')));
      const turns = rows.map((r) => ({
        role: String(r.sender || '').toLowerCase() === 'human' ? 'user' : 'assistant',
        content: r.message,                 // NOT r.steps — that is the reasoning
        id: typeof r.responseId === 'string' ? r.responseId : undefined,
      }));

      // PLAN-HISTORY-BACKFILL P1c — Grok reached here ALREADY emitting the whole
      // transcript, because `load-responses` returns the whole conversation and this
      // branch never trimmed it. Two consequences, both fixed here:
      //
      //  1. CONSENT. Backfill is opt-in and OFF by default — that toggle is the whole
      //     consent boundary for reading conversations from before install. Grok
      //     ignored it: leaving backfill off still filed your entire Grok history the
      //     moment you opened a thread. Every other adapter honours the switch, and
      //     the one that silently didn't is the one that matters most.
      //  2. VOLUME. `/load-responses` fires on EVERY page load, so the full transcript
      //     re-crossed the wire each time. §2 of the plan records Grok as the site
      //     that made the duplicate problem obvious: "two page loads produced two
      //     complete copies". Dedup collapses them on `responseId`, but re-sending an
      //     entire history per page load is work nobody asked for.
      //
      // So: with backfill ARMED, emit the lot once per transcript (same key shape as
      // Claude/ChatGPT, so a GROWN thread re-emits). With it OFF, fall through to the
      // last completed exchange — forward-only, like every other adapter.
      if (turns.length && backfillOn('grok')) {
        const allKey = 'grok|all|' + conversationId + '|' + turns.length + '|'
          + turns.reduce((n, t) => n + t.content.length, 0);
        if (!emittedSnapshotKeys.has(allKey)) {
          if (emittedSnapshotKeys.size > 500) emittedSnapshotKeys.clear();
          emittedSnapshotKeys.add(allKey);
          try {
            console.debug(`[vodou-netcap] grok BACKFILL: emitting ${turns.length} turn(s) from history`);
          } catch (_) { /* ignore */ }
          return { conversationId, turns, pending: false, backfill: true };
        }
        return { conversationId, turns: [], pending: false, quiet: true };
      }
      if (turns.length) {
        // Forward-only: the last completed human→assistant exchange.
        let lastUserIdx = -1;
        for (let i = turns.length - 1; i >= 0; i--) {
          if (turns[i].role === 'user') { lastUserIdx = i; break; }
        }
        if (lastUserIdx < 0) return { conversationId, turns: [], pending: false, quiet: true };
        const tail = turns.slice(lastUserIdx);
        if (tail[tail.length - 1].role !== 'assistant') {
          return { conversationId, turns: [], pending: true };   // reply still generating
        }
        const key = 'grok|' + conversationId + '|' + tail.map((t) => `${t.id}:${t.content.length}`).join('|');
        if (emittedSnapshotKeys.has(key)) return { conversationId, turns: [], pending: false, quiet: true };
        if (emittedSnapshotKeys.size > 500) emittedSnapshotKeys.clear();
        emittedSnapshotKeys.add(key);
        return { conversationId, turns: tail, pending: false };
      }
    }

    // --- Legacy streaming form ----------------------------------------------
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
    let userId = '';
    let assistantId = '';
    for (const obj of jsonLines(body)) {
      // The opening frame names both turns: userChatItemId / agentChatItemId.
      if (obj && typeof obj.userChatItemId === 'string') userId = obj.userChatItemId;
      if (obj && typeof obj.agentChatItemId === 'string') assistantId = obj.agentChatItemId;
      if (obj && typeof obj.conversationId === 'string') conversationId = obj.conversationId;
      const r = obj && obj.result;
      if (!r) continue;
      if (typeof r.conversationId === 'string') conversationId = r.conversationId;
      const senderIsAssistant = r.sender === undefined || r.sender === 2 || String(r.sender).toUpperCase() === 'ASSISTANT';
      if (typeof r.message !== 'string' || !senderIsAssistant) continue;
      // REASONING IS ON THE SAME FIELD AS THE ANSWER. Grok-on-X tags every frame:
      //   messageTag:"header"   + isThinking:true → "Thinking about your request"
      //   messageTag:"thinking_start" / "response_start" → control frames, no text
      //   messageTag:"final"    → the reply
      // Accumulating every result.message welded the reasoning header onto the
      // front of the answer with no separator (live 2026-07-27), and it read as a
      // normal reply. Ninth scheme in nine thinking-capable sites; grok.com uses a
      // steps[] array instead, so the two Grok surfaces do NOT share a filter.
      //
      // Allowlist the answer rather than blocklisting the thinking: an untagged
      // frame from an older build still counts, but anything explicitly marked as
      // thinking never does.
      if (r.isThinking === true) continue;
      const tag = typeof r.messageTag === 'string' ? r.messageTag : '';
      if (tag && tag !== 'final') continue;
      assistant += r.message;
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
    if (user) {
      const t = { role: 'user', content: user };
      if (userId) t.id = userId;
      turns.push(t);
    }
    if (assistant.trim()) {
      const t = { role: 'assistant', content: assistant.trim() };
      if (assistantId) t.id = assistantId;
      turns.push(t);
    }
    return { conversationId, turns };
  }

  // DeepSeek (chat.deepseek.com) — POST /api/v0/chat/completion (SSE). Frames
  // are OpenAI-style choice deltas; newer builds also use a compact {v,p}
  // patch format. User prompt rides the request body ({prompt}).
  // DeepSeek (chat.deepseek.com) — POST /api/v0/chat/completion, SSE.
  // Wire format confirmed from a live dump 2026-07-27:
  //
  //   data: {"v":{"response":{…,"fragments":[{"id":2,"type":"RESPONSE","content":"Got"}]}}}
  //   data: {"p":"response/fragments/-1/content","o":"APPEND","v":" it"}
  //   data: {"v":"."}                       <- no path: continues the SAME fragment
  //   data: {"p":"response","o":"BATCH","v":[{"p":"quasi_status","v":"FINISHED"}]}
  //   data: {"p":"response/status","o":"SET","v":"FINISHED"}
  //
  // Two consequences that a naive reading of this stream gets wrong:
  //
  // 1. The reply's OPENING text ships inside the first frame's fragment object,
  //    not as an append. Handling only appends silently truncated the start of
  //    every reply ("Got it." -> " it.", "Understood." -> "stood.") while
  //    everything else about the capture looked correct.
  //
  // 2. Appends address `fragments/-1` — THE LAST FRAGMENT, whatever it is. With
  //    thinking_enabled the model emits a THINKING fragment and its reasoning
  //    deltas arrive on the SAME path as answer deltas. So the reasoning
  //    exclusion cannot be done by path; we track each fragment's declared type
  //    and concatenate only RESPONSE fragments at the end. Reasoning is the
  //    model deliberating about Chad — filing it as speech to Chad would be a
  //    worse failure than capturing nothing.
  function parseDeepSeek(body, url, reqBody) {
    let conversationId = 'session';
    const fragments = [];                 // [{ type, content }]
    let assistantId = null;               // P0 dedup — DeepSeek's response.message_id
    const lastFrag = () => (fragments.length ? fragments[fragments.length - 1] : null);
    const addFragment = (f) => {
      if (!f || typeof f !== 'object') return;
      fragments.push({
        type: String(f.type || 'RESPONSE').toUpperCase(),
        content: typeof f.content === 'string' ? f.content : '',
      });
    };
    const appendToCurrent = (text) => {
      if (typeof text !== 'string') return;
      const f = lastFrag();
      if (f) f.content += text;
      else fragments.push({ type: 'RESPONSE', content: text });  // append before any seed
    };

    const apply = (op) => {
      if (!op || typeof op !== 'object') return;
      const path = op.p === undefined || op.p === null ? '' : String(op.p);

      if (String(op.o || '').toUpperCase() === 'BATCH' && Array.isArray(op.v)) {
        for (const sub of op.v) apply(sub);
        return;
      }
      // Whole-response object: seeds the fragment list (and its opening text).
      if (op.v && typeof op.v === 'object' && !Array.isArray(op.v)) {
        const resp = op.v.response || (path === 'response' ? op.v : null);
        if (resp && resp.message_id != null && assistantId === null) assistantId = String(resp.message_id);
        if (resp && Array.isArray(resp.fragments)) { resp.fragments.forEach(addFragment); return; }
        if (/(^|\/)fragments$/.test(path)) { addFragment(op.v); return; }
        return;
      }
      if (Array.isArray(op.v) && /(^|\/)fragments$/.test(path)) { op.v.forEach(addFragment); return; }
      if (typeof op.v !== 'string') return;         // token counts, statuses, flags
      if (path === '') { appendToCurrent(op.v); return; }          // implied: current fragment
      if (/fragments\/-?\d+\/content$/.test(path)) { appendToCurrent(op.v); return; }
      // Any other string path (response/status, quasi_status, …) is metadata.
    };

    for (const payload of sseDataChunks(body)) {
      const obj = safeJson(payload);
      if (!obj) continue;
      const choice = Array.isArray(obj.choices) && obj.choices[0];
      if (choice && choice.delta && typeof choice.delta.content === 'string') {
        appendToCurrent(choice.delta.content);      // OpenAI-compatible builds
        continue;
      }
      apply(obj);
    }

    const assistant = fragments
      .filter((f) => f.type !== 'THINKING')         // never capture reasoning
      .map((f) => f.content)
      .join('');

    const req = safeJson(reqBody || '');
    let user = '';
    if (req) {
      if (typeof req.prompt === 'string') user = req.prompt.trim();
      if (typeof req.chat_session_id === 'string') conversationId = req.chat_session_id;
    }
    const turns = [];
    if (user) turns.push({ role: 'user', content: user });
    if (assistant.trim()) turns.push({ role: 'assistant', content: assistant.trim(), id: assistantId || undefined });
    return { conversationId, turns };
  }

  // Le Chat (chat.mistral.ai) — POST /api/chat. Streams the Vercel AI data
  // format: `0:"chunk"` lines (JSON-encoded string per line), with e:/d: end
  // frames. Some builds use plain SSE deltas — handle both. Prompt rides the
  // request body (content / messages).
  // Mistral Le Chat — POST chat.mistral.ai/api/chat.
  //
  // Numbered-line stream: each line is `<n>:<json>`, and the payload is wrapped
  // in {json:{…}}. Two frame types matter (confirmed 2026-07-27):
  //
  //   15:{"json":{"type":"bootstrap","chat":{"id":…},
  //               "messages":[{"role":"user","content":"…"}]}}
  //   15:{"json":{"type":"message","messageId":"bf3f…","patches":[
  //               {"op":"append","path":"/contentChunks/0/text","value":"26 July "}]}}
  //   8:null                                                     <- terminator
  //
  // The assistant reply is streamed as JSON-Patch APPEND operations against
  // /contentChunks/N/text, so it has to be assembled patch by patch — there is
  // no frame anywhere carrying the finished text. vercelStreamText() only
  // understood `0:"…"` lines and so accumulated nothing here.
  function parseLeChat(body, url, reqBody) {
    let conversationId = 'session';
    let user = '';
    const byMessage = new Map();   // messageId -> assembled text (insertion-ordered)

    for (const line of String(body || '').split(/\r?\n/)) {
      const m = /^\d+:(.*)$/.exec(line.trim());
      if (!m) continue;
      const outer = safeJson(m[1]);
      if (!outer || typeof outer !== 'object') continue;   // `8:null` lands here
      const j = (outer.json && typeof outer.json === 'object') ? outer.json : outer;

      if (j.type === 'bootstrap') {
        if (j.chat && typeof j.chat.id === 'string') conversationId = j.chat.id;
        // The bootstrap carries the conversation so far; the LAST user message is
        // the turn just sent.
        if (Array.isArray(j.messages)) {
          for (const msg of j.messages) {
            if (msg && msg.role === 'user' && typeof msg.content === 'string' && msg.content.trim()) {
              user = msg.content;
            }
          }
        }
      } else if (j.type === 'message' && Array.isArray(j.patches)) {
        const id = String(j.messageId || 'assistant');
        let acc = byMessage.has(id) ? byMessage.get(id) : '';
        for (const patch of j.patches) {
          if (!patch) continue;
          const path = String(patch.path || '');
          if (typeof patch.value === 'string') {
            if (!/\/text$/.test(path)) continue;                     // ignore /generationStatus etc.
            if (patch.op === 'append') acc += patch.value;
            else if (patch.op === 'replace') acc = patch.value;
          } else if (patch.value && typeof patch.value === 'object') {
            // The FIRST chunk arrives as a whole object added at /contentChunks/N
            // (or /-), not as an append to .../text. Skipping it clipped the
            // opening of every reply — the captured text began mid-word ("ed!
            // Here's the summary…" instead of "Logged! …").
            if (!/\/contentChunks(\/(\d+|-))?$/.test(path)) continue;
            const chunks = Array.isArray(patch.value) ? patch.value : [patch.value];
            for (const c of chunks) {
              if (c && typeof c.text === 'string') acc += c.text;
            }
          }
        }
        byMessage.set(id, acc);
      }
    }

    // Fallbacks for older/other wire shapes.
    let assistant = '';
    let assistantId = null;   // P0 dedup — Mistral's own messageId for the winning block
    for (const [mid, t] of byMessage.entries()) {
      if (t.length > assistant.length) { assistant = t; assistantId = mid !== 'assistant' ? mid : null; }
    }
    if (!assistant) {
      assistant = vercelStreamText(body);
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
    }

    if (!user) {
      const req = safeJson(reqBody || '');
      if (req) {
        if (typeof req.message === 'string') user = req.message.trim();
        else user = lastUserContent(req);
        if (typeof req.chatId === 'string' && conversationId === 'session') conversationId = req.chatId;
      }
    }

    const turns = [];
    if (user && user.trim()) turns.push({ role: 'user', content: user.trim() });
    if (assistant && assistant.trim()) turns.push({ role: 'assistant', content: assistant.trim(), id: assistantId || undefined });
    return { conversationId, turns };
  }

  // Meta AI (meta.ai) — GraphQL mutation useAbraSendMessageMutation. Response
  // is JSON-lines; streamed bot_response_message snippets supersede each other
  // (take the last / OVERALL_DONE). Prompt rides the form-encoded `variables`.
  // EXPERIMENTAL.
  // Meta AI over wss://gateway.meta.ai/ws/clippy — a protobuf envelope carrying
  // JSON as string fields (confirmed live 2026-07-27):
  //   {"seq":0,"type":"full","response":{"response_id":"…","sections":[{"view_model":
  //     {"primitive":{"__typename":"GenAIMarkdownTextUXPrimitive","text":"<CUMULATIVE>"}}}]}}
  //   {"seq":1,"type":"patch","operations":[{"op":"delta","path":"…/text","value":" keeping"}]}
  //
  // `full` frames are cumulative SNAPSHOTS. Assign, never append — appending a
  // cumulative frame repeats the reply once per frame and still looks like a
  // successful capture (the Perplexity lesson). The patches are ignored on
  // purpose: every one of them is also reflected in the next full frame, so
  // taking the longest snapshot is both simpler and immune to a missed delta.
  // Infrastructure strings that live in the same protobuf as the prompt. The
  // decoded payload is full of enum names, keys and ids; without this list the
  // "longest human-looking run" heuristic below would happily store
  // "KADABRA__CHAT__UNIFIED_INPUT_BAR" as something the user said.
  const META_PROTO_NOISE = /(KADABRA|HUMAN_AGENT|MODE_[A-Z]+|ECTO\d|Abra Web|Mac OS|Windows NT|Mozilla|MODEL_|__typename|GenAI[A-Za-z]*|application\/|utf-8)/;

  function parseMetaAIFrames(frames) {
    let conversationId = 'session';
    let assistant = '';
    let assistantId = '';
    let user = '';
    for (const f of frames || []) {
      const raw = f && typeof f.__raw === 'string' ? f.__raw : '';
      const objs = raw ? scanJsonObjects(raw) : [f];
      for (const o of objs) {
        if (!o || typeof o !== 'object') continue;
        // The client announces the thread in a header frame — the only place the
        // real conversation id appears. Keying on response_id instead would give
        // every REPLY its own conversation and no thread could accumulate.
        const hdr = o['x-dgw-app-x-ecto-conversation-id'];
        if (typeof hdr === 'string' && hdr) conversationId = hdr;
        const resp = o.response || (o.sections ? o : null);
        if (resp) {
          if (typeof resp.response_id === 'string' && resp.response_id) assistantId = resp.response_id;
          const sections = Array.isArray(resp.sections) ? resp.sections : [];
          for (const s of sections) {
            const t = s && s.view_model && s.view_model.primitive && s.view_model.primitive.text;
            if (typeof t === 'string' && t.length > assistant.length) assistant = t;   // snapshot wins by length
          }
        }
        // THE PROMPT IS BASE64 PROTOBUF. The outgoing frame is
        // {"req-id":…,"payload":"CsAGCssD…"} with the header
        // x-dgw-app-client-payload-type: PROTO_INSIDE_JSON, so there is no field
        // name to read. Decode, then take the longest human-looking run: protobuf
        // stores strings as plain UTF-8 between length prefixes, and a sentence
        // with spaces is trivially separable from enum names and ids.
        //
        // HEURISTIC, and marked as such — it recovers the prompt without a schema,
        // but a one-word prompt with no spaces will be missed. Failing that way
        // loses a turn visibly; the alternative (accept any run) would store
        // protobuf field names as user speech.
        if (f && f.__outgoing && !user && typeof o.payload === 'string' && o.payload.length > 32) {
          try {
            const bin = typeof atob === 'function' ? atob(o.payload.replace(/-/g, '+').replace(/_/g, '/')) : '';
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const text = typeof TextDecoder !== 'undefined'
              ? new TextDecoder('utf-8', { fatal: false }).decode(bytes) : bin;
            // PREFER A DELIMITED COPY. The payload type is literally
            // PROTO_INSIDE_JSON: the prompt appears twice, once bare between
            // protobuf length prefixes and once inside a JSON string. The JSON
            // copy has real boundaries, so it comes out clean \u2014 the bare copy
            // picked up a framing byte at each end and stored
            // `tFor the record: \u2026for sure."` (live 2026-07-27).
            let best = '';
            for (const o2 of scanJsonObjects(text)) {
              const walk = (v) => {
                if (typeof v === 'string') {
                  const s = v.trim();
                  if (s.length >= 20 && s.indexOf(' ') >= 0 && !META_PROTO_NOISE.test(s) && s.length > best.length) best = s;
                } else if (v && typeof v === 'object') {
                  for (const k of Object.keys(v)) walk(v[k]);
                }
              };
              walk(o2);
            }
            // Fall back to the bare copy only if no JSON carried it, and trim the
            // framing that inevitably clings to both ends.
            if (!best) {
              for (const run of text.split(/[^\x20-\x7E\u00A0-\uFFFD]+/)) {
                const s = run.trim().replace(/^[^A-Za-z0-9"'(\[]+/, '').replace(/["'\\\s]+$/, '');
                if (s.length < 20 || s.indexOf(' ') < 0) continue;   // needs to look like a sentence
                if (META_PROTO_NOISE.test(s)) continue;
                if (s.length > best.length) best = s;
              }
            }
            if (best) user = best;
          } catch (_) { /* a payload we cannot decode simply yields no prompt */ }
        }
        // Plain-JSON fallback: not every Meta build wraps the prompt in protobuf,
        // and a build that sends it as a field should not need a decoder.
        if (f && f.__outgoing && !user) {
          for (const k of ['prompt', 'message', 'text', 'query']) {
            if (typeof o[k] === 'string' && o[k].trim()) { user = o[k].trim(); break; }
          }
        }
      }
    }
    const turns = [];
    if (user) turns.push({ role: 'user', content: user });
    if (assistant.trim()) {
      const t = { role: 'assistant', content: assistant.trim() };
      if (assistantId) t.id = assistantId;
      turns.push(t);
    }
    return { conversationId, turns };
  }

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
    const parts = Object.create(null);
    const partOrder = [];
    let assistantId = null;    // P0 dedup — Copilot's own messageId
    for (const f of frames) {
      const obj = typeof f === 'string' ? safeJson(f) : f;
      if (!obj) continue;
      if (typeof obj.conversationId === 'string') conversationId = obj.conversationId;
      if (obj.event === 'send' && Array.isArray(obj.content)) {
        const t = obj.content.find((c) => c && c.type === 'text' && typeof c.text === 'string');
        if (t) user = t.text.trim();
      }
      // Copilot models a reply as an ORDERED LIST OF PARTS (partId /
      // parentPartId), not a single string. Accumulate per part and join in
      // first-seen order.
      //
      // The previous code did `assistant = obj.text` on partCompleted, which
      // REPLACED everything accumulated so far — with two parts the second would
      // have silently discarded the first. It never fired only because the
      // partCompleted frames observed carry no text field; the structure that
      // makes it wrong is right there in the wire format.
      if (typeof obj.messageId === 'string' && obj.messageId && assistantId === null
          && (obj.event === 'appendText' || obj.event === 'startMessage')) assistantId = obj.messageId;
      const partKey = typeof obj.partId === 'string' && obj.partId ? obj.partId : '_default';
      if ((obj.event === 'appendText' || obj.event === 'text') && typeof obj.text === 'string') {
        if (!(partKey in parts)) { parts[partKey] = ''; partOrder.push(partKey); }
        parts[partKey] += obj.text;
      }
      if (obj.event === 'partCompleted' && typeof obj.text === 'string' && obj.text.trim()) {
        if (!(partKey in parts)) partOrder.push(partKey);
        parts[partKey] = obj.text;          // authoritative final text FOR THIS PART only
      }
    }
    // Verified 2026-07-27 against a live `mode:"reasoning"` run: Copilot does NOT
    // stream a reasoning part on this socket — the only part carried the visible
    // answer. So there is no chain-of-thought to exclude here, unlike DeepSeek
    // (fragment types) and Kimi (block.think.*). If a future build starts sending
    // a part flagged as reasoning, exclude it HERE, by part, and re-verify.
    const assistant = partOrder.map((k) => parts[k]).join('');
    const turns = [];
    if (user) turns.push({ role: 'user', content: user });
    if (assistant.trim()) turns.push({ role: 'assistant', content: assistant.trim(), id: assistantId || undefined });
    return { conversationId, turns };
  }

  /**
   * PLAN-HISTORY-BACKFILL P1b — Copilot's TRANSCRIPT, not its stream.
   *
   *   GET /c/api/conversations/<id>/history?api-version=2
   *   { "results": [ { id, author:{type:'ai'|'human'}, createdAt,
   *                    content:[{type:'text', text, partId, parentPartId}] } ],
   *     "next": <cursor|null> }
   *
   * Unlike Claude and ChatGPT this is a genuinely different shape from the live lane
   * — the streaming parser above reads SSE/WS event frames, and none of that applies
   * to a static results array. Three traps, all recorded from the live dump:
   *
   *  1. `results` arrives NEWEST-FIRST. Sort ascending by createdAt or the transcript
   *     reads backwards — and a backwards transcript still looks like a clean capture.
   *  2. Role comes from `author.type` (`ai` / `human`) and must NEVER be inferred from
   *     position. That inference is what broke Poe.
   *  3. A reply is an ORDERED LIST OF PARTS, same as the stream. Join in order.
   *
   * `next` is a pagination cursor. We deliberately do NOT follow it: issuing our own
   * requests would turn a passive tap into scraping, which is the line this feature
   * stays on the right side of. When it is set we say so out loud rather than
   * silently capping — a quiet cap reads as "we got everything".
   */
  function parseCopilotHistory(body, url) {
    const doc = safeJson(String(body));
    if (!doc || !Array.isArray(doc.results)) return null;   // not this shape — let others try
    const um = /\/conversations\/([^/?#]+)\/history/.exec(url || '');
    const conversationId = (um && um[1]) || 'session';
    const none = { conversationId, turns: [], pending: false, quiet: true };

    const rows = doc.results.slice().sort((a, b) => {
      const ta = Date.parse((a && a.createdAt) || '') || 0;
      const tb = Date.parse((b && b.createdAt) || '') || 0;
      return ta - tb;
    });

    const msgs = [];
    for (const r of rows) {
      if (!r) continue;
      const at = r.author && r.author.type;
      const role = at === 'human' ? 'user' : at === 'ai' ? 'assistant' : null;
      if (!role) continue;
      const text = Array.isArray(r.content)
        ? r.content
          .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('')
          .trim()
        : '';
      if (!text) continue;
      msgs.push({ id: r.id || String(msgs.length), role, text });
    }
    if (!msgs.length) return none;

    if (doc.next) {
      try {
        console.debug(`[vodou-netcap] copilot BACKFILL: more history exists beyond this page — not followed by design`);
      } catch (_) { /* ignore */ }
    }

    const allKey = 'copilot|all|' + conversationId + '|' + msgs.length + '|'
      + msgs.reduce((n, m) => n + m.text.length, 0);
    if (emittedSnapshotKeys.has(allKey)) return none;
    if (emittedSnapshotKeys.size > 500) emittedSnapshotKeys.clear();
    emittedSnapshotKeys.add(allKey);
    try {
      console.debug(`[vodou-netcap] copilot BACKFILL: emitting ${msgs.length} turn(s) from history`);
    } catch (_) { /* ignore */ }
    return {
      conversationId,
      turns: msgs.map((m) => ({ role: m.role, content: m.text, id: m.id })),
      pending: false,
      backfill: true,
    };
  }

  // Manus (manus.im) — agent platform; event stream shapes are not publicly
  // documented, so this adapter is deliberately conservative: it only emits
  // frames that carry an explicit role+content/text shape, or accumulates
  // obvious message deltas. Works for both SSE bodies and WS frame lists.
  // EXPERIMENTAL.
  // Manus streams over Socket.IO. decodeWsFrame() has already unwrapped
  //   42["message", {payload}]   ->   { event:'message', data:[payload] }
  // so this walks the payloads. Confirmed shapes (2026-07-27):
  //
  //   sent    {type:'user_message', sessionId, contents:[{type:'text', value:'…'}]}
  //   recv    {type:'event', event:{type:'chat', sender:'user',  content:'…'}}
  //   recv    {type:'event', event:{type:'chatDelta', delta:{content:'…', thought:'…'},
  //                                 sender:'assistant', finished:false}}
  //   recv    {type:'event', event:{type:'chat', messageType:'text', content:'…'}}   <- final
  //   recv    {type:'event', event:{type:'statusUpdate', agentStatus:'stopped'}}     <- done
  //
  // `delta.thought` is the agent's REASONING and is never captured, same rule as
  // Kimi's think blocks: it is the model deliberating about the user, not a reply.
  function parseManus(bodyOrFrames, url, reqBody) {
    const raw = Array.isArray(bodyOrFrames)
      ? bodyOrFrames.map((f) => (typeof f === 'string' ? safeJson(f) : f)).filter(Boolean)
      : sseDataChunks(bodyOrFrames).map(safeJson).filter(Boolean).concat(jsonLines(bodyOrFrames));

    // Unwrap the Socket.IO envelope where present; tolerate bare payloads too.
    const payloads = [];
    for (const f of raw) {
      if (!f || typeof f !== 'object') continue;
      if (Array.isArray(f.data) && f.__socketio) { for (const d of f.data) if (d && typeof d === 'object') payloads.push(d); }
      else payloads.push(f);
    }

    let conversationId = 'session';
    let user = '';
    let assistantFinal = '';
    let assistantDelta = '';

    for (const pl of payloads) {
      const sid = pl.sessionId || pl.session_id || pl.conversation_id || pl.chat_id;
      if (typeof sid === 'string' && sid) conversationId = sid;

      // Outgoing user message (what the user actually typed).
      if (pl.type === 'user_message') {
        if (Array.isArray(pl.contents)) {
          for (const c of pl.contents) {
            if (c && c.type === 'text' && typeof c.value === 'string') user = user || c.value;
          }
        }
        if (!user && typeof pl.content === 'string' && pl.content) user = pl.content;
      }

      const ev = pl.event;
      if (!ev || typeof ev !== 'object') continue;

      if (ev.type === 'chat' && typeof ev.content === 'string' && ev.content) {
        // A completed message. sender:'user' echoes the prompt; anything else is
        // the assistant's finished reply (the final chat event omits sender).
        if (ev.sender === 'user') { if (!user) user = ev.content; }
        else if (ev.content.length > assistantFinal.length) assistantFinal = ev.content;
      } else if (ev.type === 'chatDelta' && ev.delta && typeof ev.delta.content === 'string') {
        assistantDelta += ev.delta.content;      // delta.thought deliberately ignored
      }
    }

    // Prefer the completed message; fall back to accumulated deltas if the final
    // frame never arrived (stream cut short).
    const assistant = assistantFinal || assistantDelta;
    const turns = [];
    if (user.trim()) turns.push({ role: 'user', content: user.trim() });
    if (assistant.trim()) turns.push({ role: 'assistant', content: assistant.trim() });
    return { conversationId, turns };
  }

  // Qwen (chat.qwen.ai) — OpenAI-style SSE chat completions.
  function parseQwen(body, url, reqBody) {
    return openAiSseParse(body, reqBody, ['chat_id', 'session_id', 'conversation_id']);
  }

  // Z.ai / GLM (chat.z.ai) — OpenAI-style SSE, with reasoning on the same field
  // as the answer (see the phase allowlist in openAiSseParse).
  //
  // Both message ids ride the REQUEST and were cross-checked against Z.ai's own
  // history endpoint (GET /api/v1/chats/<id>), which lists the same uuids:
  //   current_user_message_id → the prompt      (history: role 'user')
  //   id                      → the reply       (history: role 'assistant')
  // Without them the user turn fell back to a content hash, and re-sending the
  // same message inside the dedup window ATE the repeat — observed live
  // 2026-07-27: the transcript ended up with two assistant turns and one user
  // turn. A real id makes a genuine repeat storable.
  function parseZai(body, url, reqBody) {
    const r = openAiSseParse(body, reqBody, ['chat_id', 'conversation_id']);
    const req = safeJson(reqBody || '');
    if (req) {
      const userId = typeof req.current_user_message_id === 'string' ? req.current_user_message_id : '';
      const asstId = typeof req.id === 'string' ? req.id : '';
      for (const t of r.turns) {
        if (t.role === 'user' && userId) t.id = userId;
        else if (t.role === 'assistant' && asstId) t.id = asstId;
      }
    }
    return r;
  }

  // OpenRouter chatroom (openrouter.ai/chat) — plain OpenAI SSE.
  function parseOpenRouter(body, url, reqBody) {
    return openAiSseParse(body, reqBody, ['conversation_id', 'chat_id']);
  }

  // Kimi (kimi.com / kimi.moonshot.cn) — POST /api/chat/{id}/completion/stream.
  // SSE frames {"event":"cmpl","text":"chunk"}; prompt in request messages.
  // Kimi. Connect/gRPC-style RPC at /apiv2/…ChatService/Chat.
  //
  // The body is a run of length-prefixed JSON frames; decoded as text the binary
  // prefixes become junk between the objects, so scan for balanced JSON rather
  // than splitting on newlines. Confirmed shape (2026-07-27):
  //
  //   {"heartbeat":{}}
  //   {"op":"set","mask":"chat.lastRequest","chat":{…}}
  //   {"op":"set","mask":"message","message":{
  //       "id":"…","role":"user","status":"MESSAGE_STATUS_COMPLETED",
  //       "blocks":[{"text":{"content":"…"}}]}}
  //   {"op":"set","mask":"message","message":{
  //       "id":"…","role":"assistant","status":"MESSAGE_STATUS_GENERATING"}}
  //
  // BOTH turns arrive on the response stream — the user's message is echoed
  // back, which is why a naive "find some text" parser mislabelled the prompt as
  // the assistant reply. Key off message.role, never off position.
  //
  // Frames are `op:"set"` snapshots keyed by message id, so a later frame
  // supersedes an earlier one for the same id: keep the LONGEST content seen.
  function scanJsonObjects(src) {
    const out = [];
    const str = String(src || '');
    // Re-scanning a failed span is what recovers swallowed frames, but it is also
    // quadratic if a page serves a body engineered to fail everywhere (nested braces
    // that balance and never parse). This tap reads every response on 38 hosts, so a
    // crafted body must not be able to pin the tab. Real bodies need a handful:
    // kimi.com's worst measured case used 4. Past the cap, degrade to the old
    // skip-the-span behaviour, which is bounded and merely lossy.
    let rescans = 0;
    const MAX_RESCANS = 200;
    for (let i = 0; i < str.length; i++) {
      if (str[i] !== '{') continue;
      let depth = 0, inStr = false, esc = false;
      for (let j = i; j < str.length; j++) {
        const c = str[j];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) {
            let parsed = true;
            try { out.push(JSON.parse(str.slice(i, j + 1))); } catch (_) { parsed = false; }
            // Skip the span ONLY when it really was one object. A balanced span that
            // does not parse is usually not a frame at all: Connect/gRPC prefixes each
            // frame with a flag byte and a 4-byte length, and those bytes are data — a
            // length of 123 emits '{' and 125 emits '}'. A stray '{' opens a bogus
            // object that a later stray '}' closes, and jumping to `j` then discarded
            // every real frame in between, silently.
            //
            // Measured on kimi.com 2026-07-31: 82% byte coverage, 4 unparseable spans,
            // the largest swallowing 10,459 bytes — which is why a reply arrived as
            // coherent runs with the middles missing. Resuming at i+1 re-scans the
            // span and finds the frames that are actually in it.
            if (parsed || rescans >= MAX_RESCANS) i = j;
            else rescans++;
            break;
          }
        }
      }
    }
    return out;
  }

  function kimiBlockText(msg) {
    let t = '';
    const blocks = (msg && msg.blocks) || [];
    for (const b of blocks) {
      if (b && b.text && typeof b.text.content === 'string') t += b.text.content;
      else if (b && typeof b.content === 'string') t += b.content;
    }
    return t;
  }

  // The assistant's reply does NOT arrive inside its `message` frame — that frame
  // is created empty with status MESSAGE_STATUS_GENERATING, and the content then
  // streams as separate `block` frames:
  //
  //   {"op":"set",   "mask":"block.think",        "block":{"id":"3","parentId":"2","think":{"content":"The"}}}
  //   {"op":"append","mask":"block.think.content","block":{"id":"3","think":{"content":" user"}}}
  //
  // So blocks must be assembled by id WITH append semantics, then attached to a
  // message. Only the ROOT block of a chain carries `messageId`; children carry
  // `parentId`, so walk the chain to find the owning message.
  //
  // `think` blocks are the model's REASONING and are deliberately excluded. The
  // chain of thought is not the answer, and capturing it would file the model's
  // private deliberation into the user's memory as though it were a reply.
  const KIMI_SKIP_FIELDS = new Set(['think']);
  function kimiAssembleBlocks(frames) {
    const blocks = new Map();
    const get = (id) => {
      let b = blocks.get(id);
      if (!b) { b = { parentId: '', messageId: '', parts: {}, fallbackOwner: '' }; blocks.set(id, b); }
      return b;
    };
    // Frames arrive in order, so the assistant `message` frame always precedes
    // the blocks that belong to it. Track it: the answer block ("block.text")
    // streams its deltas with parentId:"" and NO messageId, so the parent-chain
    // walk cannot resolve an owner for it and the reply would be dropped —
    // which is exactly what left capture stuck at 1 turn.
    let lastAssistantMsg = '';
    // Some responses label NO message with a role — verified live 2026-07-31:
    // 440 frames, 419 of them block frames carrying the reply, and
    // roles={"system":1,"(no role)":1}. With `role` absent this never bound an
    // owner and every one of those 419 frames was discarded (0 turns captured).
    //
    // Kimi names the SYSTEM message with the same id as the chat itself, so an
    // unlabelled message frame whose id differs from the chat id is the assistant.
    // Only used as a fallback: an explicit role:"assistant" always wins.
    let chatId = '';
    let unlabelledMsg = '';
    for (const f of frames) {
      if (f && f.chat && typeof f.chat.id === 'string' && !chatId) chatId = f.chat.id;
      const mm = f && f.message;
      if (mm && mm.id && !mm.role && String(mm.id) !== chatId) unlabelledMsg = String(mm.id);
    }
    for (const f of frames) {
      const m = f && f.message;
      if (m && m.id && m.role === 'assistant') lastAssistantMsg = String(m.id);
      const blk = f && f.block;
      if (!blk || blk.id == null) continue;
      const rec = get(String(blk.id));
      if (!rec.fallbackOwner && lastAssistantMsg) rec.fallbackOwner = lastAssistantMsg;
      if (blk.parentId) rec.parentId = String(blk.parentId);
      if (blk.messageId) rec.messageId = String(blk.messageId);
      for (const [field, val] of Object.entries(blk)) {
        if (!val || typeof val !== 'object') continue;
        if (typeof val.content !== 'string') continue;
        if (f.op === 'append') { rec.parts[field] = (rec.parts[field] || '') + val.content; continue; }
        // Not labelled 'append'. The old rule here was "longest content wins", which
        // is only correct if an unlabelled frame carries a CUMULATIVE snapshot. When
        // the wire instead sends unlabelled DELTAS, longest-wins keeps exactly one
        // delta per block and throws the rest away — verified 2026-07-31, a reply
        // stored as 126 characters spliced from three blocks, while the console
        // reported "2 turn(s) STORED ✓". Decide by SHAPE instead of by the absent
        // label: a cumulative snapshot extends what we already have, so it starts
        // with it; a delta does not.
        const cur = rec.parts[field] || '';
        if (!cur) rec.parts[field] = val.content;
        else if (val.content.startsWith(cur)) rec.parts[field] = val.content;  // cumulative
        else if (cur.startsWith(val.content)) { /* stale re-send of a shorter snapshot */ }
        else rec.parts[field] = cur + val.content;                             // delta
      }
    }
    const ownerOf = (id, depth) => {
      if (depth > 20) return '';
      const b = blocks.get(id);
      if (!b) return '';
      if (b.messageId) return b.messageId;
      return b.parentId ? ownerOf(b.parentId, depth + 1) : '';
    };
    const byMessage = new Map();
    for (const [id, b] of blocks) {
      const owner = ownerOf(id, 0) || b.fallbackOwner || unlabelledMsg;
      if (!owner) continue;
      let text = '';
      for (const [field, val] of Object.entries(b.parts)) {
        if (KIMI_SKIP_FIELDS.has(field)) continue;
        text += val;
      }
      if (text) byMessage.set(owner, (byMessage.get(owner) || '') + text);
    }
    return byMessage;
  }

  function parseKimi(body, url, reqBody) {
    let conversationId = 'session';
    const m = /\/chat\/([^/?]+)/.exec(url || '');
    if (m) conversationId = m[1];
    else {
      // The RPC URL carries no chat id — the PAGE url does (/chat/<uuid>).
      try {
        const pm = /\/chat\/([^/?]+)/.exec(location.pathname || '');
        if (pm) conversationId = pm[1];
      } catch (_) { /* ignore */ }
    }

    const frames = scanJsonObjects(body);
    const seen = new Map();           // id -> { role, content }  (insertion-ordered)
    for (const f of frames) {
      const msg = f && f.message;
      if (!msg || !msg.id) continue;
      const role = msg.role === 'user' ? 'user' : (msg.role === 'assistant' ? 'assistant' : '');
      if (!role) continue;
      const text = kimiBlockText(msg);
      const prev = seen.get(msg.id);
      if (!prev) seen.set(msg.id, { role, content: text });
      else if (text.length > prev.content.length) prev.content = text;   // later snapshot wins
      if (conversationId === 'session' && f.chat && typeof f.chat.id === 'string') conversationId = f.chat.id;
    }

    // The prompt, recovered from the REQUEST when the response never labels it.
    //
    // Same 2026-07-31 failure: with roles={"system":1,"(no role)":1} the loop above
    // matched no user frame and the question was lost even though the reply was
    // recoverable. The request body always carries it with an explicit role —
    //   {"message":{"role":"user","blocks":[{"text":{"content":"…"}}]}}
    // — so it is the one place the prompt is guaranteed. Keyed by content hash, not
    // by a provider id, because the request's own message_id is "" (the server
    // assigns it); the gateway's no-id path handles that correctly.
    //
    // Only fills a GAP: if the response did label a user turn, that one is already
    // in `seen` and this is skipped, so the healthy path is untouched.
    let sawUser = false;
    for (const v of seen.values()) if (v.role === 'user') { sawUser = true; break; }
    if (!sawUser && reqBody) {
      try {
        for (const rf of scanJsonObjects(String(reqBody))) {
          const rm = rf && rf.message;
          if (!rm || rm.role !== 'user') continue;
          const qt = kimiBlockText(rm);
          // noId: this turn has NO provider id. The request's own message_id is ""
          // (the server assigns it), so any key invented here would be identical
          // for every prompt in the conversation — and the gateway dedupes id-keyed
          // turns on id alone, so the SECOND question would be silently suppressed
          // as a duplicate of the first. Let it fall to the content-hash path.
          if (qt && qt.trim()) { seen.set('req:user', { role: 'user', content: qt.trim(), noId: true }); break; }
        }
      } catch (_) { /* request unparseable — the reply alone is still worth keeping */ }
    }

    // Fold in block-streamed content — this is where the assistant's reply is.
    for (const [msgId, text] of kimiAssembleBlocks(frames)) {
      const rec = seen.get(msgId);
      if (rec) { if (text.length > rec.content.length) rec.content = text; }
      else seen.set(msgId, { role: 'assistant', content: text });
    }

    // Assembly census. Unlike debugMiss it fires on a SUCCESSFUL parse — debugMiss
    // only runs at zero turns, so a reply that assembles into the WRONG text was
    // invisible to every instrument we had.
    //
    // Unconditional, not dump-gated: this is the only instrument that can see a
    // capture which SUCCEEDS with the wrong text, and requiring a flag means it is
    // never on when it is needed. console.debug sits at Chrome's Verbose level, so
    // it costs nothing until someone goes looking.
    //
    // The load-bearing number is `carried vs assembled`. Every content string in
    // every frame is text the wire delivered; the assembled total is what survived.
    // If carried >> assembled the loss is in ASSEMBLY (ownership, append/replace).
    // If carried is already small the loss is UPSTREAM (transport, framing, or the
    // reply genuinely being short) and the assembler is innocent. Two opposite
    // fixes, and nothing we had could tell them apart.
    //
    // 2026-07-31 that reading came back carried(non-reasoning)=247, assembled=247:
    // lossless assembly of a reply that was still missing most of its text. So the
    // census also walks every block frame and totals string bytes BY KEY PATH. The
    // adapter only ever reads `<field>.content`; any answer text living somewhere
    // else is invisible to it and shows up here as a path it does not consume.
    try {
      const ops = Object.create(null);
      const fields = Object.create(null);
      const blockIds = new Set();
      let carried = 0;
      let carriedAnswer = 0;
      // path -> { n, chars }. Depth-capped, and ids are excluded because a
      // 1-character block id repeated a thousand times would outrank the answer.
      const paths = Object.create(null);
      const ID_KEYS = new Set(['id', 'parentId', 'messageId', 'chatId', 'groupId']);
      const walk = (o, prefix, depth) => {
        if (o == null || depth > 6) return;
        if (typeof o === 'string') {
          const key = prefix || '(root)';
          const rec = paths[key] || (paths[key] = { n: 0, chars: 0 });
          rec.n++; rec.chars += o.length;
          return;
        }
        if (Array.isArray(o)) { for (const v of o) walk(v, prefix + '[]', depth + 1); return; }
        if (typeof o !== 'object') return;
        for (const [k, v] of Object.entries(o)) {
          if (ID_KEYS.has(k)) continue;
          walk(v, prefix ? prefix + '.' + k : k, depth + 1);
        }
      };
      for (const f of frames) {
        const blk = f && f.block;
        if (!blk) continue;
        const op = f.op == null ? '(no op)' : String(f.op);
        ops[op] = (ops[op] || 0) + 1;
        if (blk.id != null) blockIds.add(String(blk.id));
        walk(blk, '', 0);
        for (const [field, val] of Object.entries(blk)) {
          if (!val || typeof val !== 'object') continue;
          if (typeof val.content !== 'string') continue;
          fields[field] = (fields[field] || 0) + 1;
          carried += val.content.length;
          if (!KIMI_SKIP_FIELDS.has(field)) carriedAnswer += val.content.length;
        }
      }
      const byChars = Object.entries(paths)
        .sort((a, b) => b[1].chars - a[1].chars)
        .slice(0, 14)
        .map(([p, r]) => p + '=' + r.chars + 'ch/' + r.n)
        .join('  ');
      let assembled = 0;
      const shape = [];
      for (const [k, v] of seen.entries()) {
        assembled += v.content.length;
        shape.push(String(k).slice(0, 10) + ':' + v.role + ':' + v.content.length + 'ch');
      }

      // BYTE COVERAGE. The path tally showed the body holds no answer text beyond
      // what we already read, so either the frames carrying it never parsed, or they
      // never arrived. scanJsonObjects discards an unparseable span in silence, so a
      // torn stream and a short reply are indistinguishable downstream.
      //
      // Measure how much of the body sits inside a SUCCESSFULLY parsed object. Near
      // 100% means the framing is intact and the answer genuinely is not in this
      // response — look at another transport. Well under that means we are dropping
      // frames, and the largest gap says where.
      let okFrames = 0, badFrames = 0, covered = 0, gapMax = 0, gapAt = -1;
      {
        const s = String(body || '');
        let cursor = 0;
        let rescans = 0;
        const MAX_RESCANS = 200;
        for (let i = 0; i < s.length; i++) {
          if (s[i] !== '{') continue;
          let depth = 0, inStr = false, esc = false;
          for (let j = i; j < s.length; j++) {
            const c = s[j];
            if (inStr) {
              if (esc) esc = false;
              else if (c === '\\') esc = true;
              else if (c === '"') inStr = false;
              continue;
            }
            if (c === '"') { inStr = true; continue; }
            if (c === '{') depth++;
            else if (c === '}') {
              depth--;
              if (depth === 0) {
                let good = true;
                try { JSON.parse(s.slice(i, j + 1)); } catch (_) { good = false; }
                if (good) {
                  okFrames++;
                  covered += (j - i + 1);
                  if (i - cursor > gapMax) { gapMax = i - cursor; gapAt = cursor; }
                  cursor = j + 1;
                } else badFrames++;
                // Mirror scanJsonObjects exactly, including the resume-on-failure.
                // This loop was written as a copy of the OLD scanner and kept the
                // unconditional `i = j`, so after the fix it reported 71% coverage
                // and parsed=282 for a body the real scanner read 382 frames out of
                // — a diagnostic describing code that no longer exists is worse than
                // none, because it sends the next person after a phantom.
                if (good || rescans >= MAX_RESCANS) i = j;
                else rescans++;
                break;
              }
            }
          }
        }
        if (s.length - cursor > gapMax) { gapMax = s.length - cursor; gapAt = cursor; }
      }
      const bodyLen = String(body || '').length;
      const pct = bodyLen ? Math.round((covered / bodyLen) * 100) : 0;
      // The gap sample goes through redact() — a debugging aid must not become a
      // disclosure tool, and this prints raw wire bytes.
      const gapSample = gapAt >= 0 ? redact(String(body || '').slice(gapAt, gapAt + 140)) : '';

      console.debug(
        '[vodou-netcap] kimi assembly census',
        '\n  body bytes     :', bodyLen,
        '\n  frames         :', frames.length, '| block frames carrying content:', Object.values(fields).reduce((a, b) => a + b, 0),
        '\n  block ops      :', JSON.stringify(ops),
        '\n  distinct blocks:', blockIds.size,
        '\n  content fields :', JSON.stringify(fields),
        '\n  carried chars  :', carried, '(excluding reasoning:', carriedAnswer + ')',
        '\n  chars by path  :', byChars,
        '\n  byte coverage  :', covered, 'of', bodyLen, '(' + pct + '%)  parsed=' + okFrames, 'unparseable=' + badFrames,
        '\n  largest gap    :', gapMax, 'bytes at', gapAt, JSON.stringify(gapSample),
        '\n  assembled chars:', assembled,
        '\n  assembled turns:', shape.join('  |  '),
      );
    } catch (_) { /* a diagnostic must never break the capture it is watching */ }

    const turns = [];
    // Carry the per-message key through as the turn id. `seen` is already keyed by
    // Kimi's own message id (msg.id / the block msgId that kimiAssembleBlocks groups
    // on), and it was being dropped here. Without an id the gateway falls back to a
    // TIME-BUCKETED content hash, which silently suppresses a genuine repeat inside
    // the window — ask the same thing twice in ten minutes and get the same short
    // answer, and the second one is discarded as a duplicate. A real id also earns
    // this adapter the truncation upgrade in handleCaptureTurn.
    for (const [msgId, t] of seen.entries()) {
      if (!t.content || !t.content.trim()) continue;
      const turn = { role: t.role, content: t.content.trim() };
      if (!t.noId && msgId && typeof msgId === 'string') turn.id = msgId;
      turns.push(turn);
    }

    // LEGACY WIRE. kimi.moonshot.cn is still matched on /completion/stream, which
    // streams {"event":"cmpl","text":"chunk"} — the shape kimi.com used before the
    // Connect RPC. The RPC rewrite (8d8110e) replaced this parser wholesale, so a
    // site still on the old wire captured NOTHING and said nothing about it: the
    // adapter kept promising support the parser no longer had. Only 'cmpl' events
    // are read, so a reasoning event on that wire can never ride along.
    if (!turns.length) {
      let legacy = '';
      for (const payload of sseDataChunks(body)) {
        const obj = safeJson(payload);
        if (obj && obj.event === 'cmpl' && typeof obj.text === 'string') legacy += obj.text;
      }
      if (legacy.trim()) {
        const user = lastUserContent(safeJson(reqBody || ''));
        if (user) turns.push({ role: 'user', content: user });
        turns.push({ role: 'assistant', content: legacy.trim() });
      }
    }
    return { conversationId, turns };
  }

  // Duck.ai (duckduckgo.com/duckchat) — SSE frames {"message":"chunk","role":…};
  // prompt in request messages.
  function parseDuckAI(body, url, reqBody) {
    let assistant = '';
    let assistantId = '';
    for (const payload of sseDataChunks(body)) {
      const obj = safeJson(payload);
      if (!obj) continue;
      if (typeof obj.message === 'string' && (obj.role === undefined || obj.role === 'assistant')) {
        assistant += obj.message;
        // Every delta of a reply carries the same msg_… id; keep the first.
        if (!assistantId && typeof obj.id === 'string' && obj.id) assistantId = obj.id;
      }
    }
    const req = safeJson(reqBody || '');
    const user = lastUserContent(req);
    // The real conversation id rides the REQUEST, in durableStream — it was there
    // all along while this returned the literal 'session', which collapsed every
    // Duck.ai chat anyone ever had into one thread that could never accumulate.
    // Observed 2026-07-27.
    let conversationId = 'session';
    const ds = req && req.durableStream;
    if (ds && typeof ds.conversationId === 'string' && ds.conversationId) {
      conversationId = ds.conversationId;
    }
    const turns = [];
    // The user turn deliberately gets NO id. durableStream.messageId identifies the
    // RESPONSE stream, not the prompt; keying the prompt on it would mint a fresh
    // key for a resend and store the same turn twice. The hash fallback handles a
    // repeat correctly, and an id may supersede a hash later — never the reverse.
    if (user) turns.push({ role: 'user', content: user });
    if (assistant.trim()) {
      const t = { role: 'assistant', content: assistant.trim() };
      // Attach `id` only when there is one — an explicit `id: undefined` is a
      // real own property, and the turn shape is compared as data downstream.
      if (assistantId) t.id = assistantId;
      turns.push(t);
    }
    return { conversationId, turns };
  }

  // HuggingChat (huggingface.co/chat) — POST /chat/conversation/{id}. JSON-line
  // events {"type":"stream","token":…} with a {"type":"finalAnswer","text":…}
  // that supersedes. Prompt in request {inputs}.
  // Inline reasoning: <think>…</think> INSIDE the reply text itself. No frame, no
  // field, no type — the eighth scheme in eight thinking-capable sites, and the
  // only one a wire-format filter cannot catch, because by the time you have the
  // text the reasoning is already in it (HuggingChat via the Kimi-K2.6 router,
  // confirmed live 2026-07-27: a 4,120-char "reply" opened with the model's
  // analysis of the user).
  //
  // An UNTERMINATED opener means the stream was cut mid-thought. Dropping the
  // remainder can lose a reply; keeping it always leaks one. Leak is worse: a
  // missing turn is visible, a reasoning turn masquerading as speech is not.
  function stripInlineReasoning(text) {
    let out = String(text == null ? '' : text);
    out = out.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
    const open = out.search(/<think(?:ing)?>/i);
    if (open >= 0) out = out.slice(0, open);
    return out.trim();
  }

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
    const assistant = stripInlineReasoning(finalText || tokens);
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
    // threadMetadata.id is what T3 itself calls the thread (live 2026-07-27); the
    // page URL happens to agree today, but reading the declared id beats parsing
    // a URL that a redesign can change.
    if (req && req.threadMetadata && typeof req.threadMetadata.id === 'string') conversationId = req.threadMetadata.id;
    else if (req && typeof req.threadId === 'string') conversationId = req.threadId;
    else if (req && typeof req.chatId === 'string') conversationId = req.chatId;
    else {
      // The POST goes to a bare /api/chat with the thread only in the page URL
      // (/chat/<uuid>). Without this every T3 conversation collapsed into
      // 'session' — the same defect Duck.ai had.
      try {
        const pm = /\/chat\/([^/?#]+)/.exec(location.pathname || '');
        if (pm) conversationId = pm[1];
      } catch (_) { /* ignore */ }
    }
    // Two ids name the reply, and they are NOT interchangeable:
    //   req.responseMessageId  — T3's own uuid, the one its sync/history uses
    //   stream {"type":"start","messageId"} — the AI SDK's per-stream id
    // Prefer T3's, so a turn captured live and the same turn seen later through
    // T3's history carry the SAME key and dedup instead of doubling. The stream id
    // is the fallback for a build that does not send responseMessageId.
    let assistantId = (req && typeof req.responseMessageId === 'string') ? req.responseMessageId : '';
    if (!assistantId) {
      for (const payload of sseDataChunks(body)) {
        const obj = safeJson(payload);
        if (obj && obj.type === 'start' && typeof obj.messageId === 'string') { assistantId = obj.messageId; break; }
      }
    }
    // The prompt's own id lives on the last user message — same uuid namespace.
    let userId = '';
    try {
      if (req && Array.isArray(req.messages)) {
        for (let i = req.messages.length - 1; i >= 0; i--) {
          const m = req.messages[i];
          if (m && m.role === 'user' && typeof m.id === 'string') { userId = m.id; break; }
        }
      }
    } catch (_) { /* ignore */ }
    const turns = [];
    if (user) {
      const t = { role: 'user', content: user };
      if (userId) t.id = userId;
      turns.push(t);
    }
    if (assistant) {
      const t = { role: 'assistant', content: assistant };
      if (assistantId) t.id = assistantId;
      turns.push(t);
    }
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
    // READ THE DECLARED TEXT SLOT — do not scavenge strings.
    //
    // Every wrb.fr frame carries one message tuple: [text, …, ids, …, meta].
    // `text` is the message; `meta`'s last element is a TYPE MARKER —
    //   2 = Gemini thought summary ("**Defining \"Most Useful\"**\n\nI'm currently…")
    //   1 = the actual reply
    // Everything else in the frame — citations, grounding passages, suggested
    // follow-ups — lives DEEPER in the structure, and that is exactly what the
    // previous "collect every string, keep the longest" approach kept picking up.
    //
    // Proven with two live dumps 2026-07-27: a long-answer question stored the
    // reply correctly by luck, then "…in one sentence only" — which makes the
    // model think long and answer short — stored an 850-char SOURCE PASSAGE (the
    // user's own document) as the assistant's words. Length was never a signal.
    let assistant = '';
    for (const line of String(body).split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith('[')) continue;
      const arr = safeJson(t);
      if (!Array.isArray(arr)) continue;
      for (const entry of arr) {
        if (!Array.isArray(entry) || entry[0] !== 'wrb.fr' || typeof entry[2] !== 'string') continue;
        const inner = safeJson(entry[2]);
        const msg = Array.isArray(inner) && Array.isArray(inner[0]) ? inner[0] : null;
        if (!msg || typeof msg[0] !== 'string' || !msg[0].trim()) continue;
        const meta = Array.isArray(msg[4]) ? msg[4] : null;
        const marker = meta && meta.length ? meta[meta.length - 1] : null;
        if (marker === 2) continue;                                   // thought summary
        // Belt and braces: the thought-summary FORMAT, in case the marker moves.
        if (/^\s*\*\*[^*\n]{3,80}\*\*\s*\n/.test(msg[0])) continue;
        // Frames are cumulative for a given reply; assign the longest rather than
        // appending, so a re-sent snapshot cannot duplicate the answer.
        if (msg[0].length > assistant.length) assistant = msg[0];
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
        // The prompt sits after the source-id array in f.req. Taking the FIRST
        // string stored a source UUID as the user's turn (live 2026-07-27) — ids
        // come first, and a uuid is a perfectly good string. Require something
        // sentence-shaped instead: long enough, contains a space, not a uuid.
        const candidates = more.concat(strings).filter((s) => (
          s.length >= 12 && s.length < 4000
          && !/^[[{]/.test(s)
          && s.indexOf(' ') >= 0
          && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim())
        ));
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
  const POE_SEEN_AUTHORS = new Set();
  function parsePoeFrames(frames) {
    // Poe's socket URL carries no chat id, and payload.unique_id is the
    // SUBSCRIPTION id ("messageAdded1487188720") — an event name plus a counter,
    // different every session. Using it filed each exchange under its own
    // meaningless conversation, so a Poe thread could never accumulate. The page
    // URL holds the real, stable id: poe.com/chat/<id>.
    let conversationId = 'session';
    try {
      const m = /\/chat\/([A-Za-z0-9_-]+)/.exec(location.pathname);
      if (m) conversationId = m[1];
    } catch (_) { /* fall through to the payload id below */ }
    let user = '';
    let assistant = '';
    let userId = null;          // P0 dedup — Poe's own messageId per turn
    let assistantId = null;
    for (const f of frames) {
      const outer = typeof f === 'string' ? safeJson(f) : f;
      if (!outer || !Array.isArray(outer.messages)) continue;
      for (const s of outer.messages) {
        const inner = typeof s === 'string' ? safeJson(s) : s;
        const added = inner && inner.payload && inner.payload.data && inner.payload.data.messageAdded;
        if (!added || typeof added.text !== 'string') continue;
        const chatId = inner.payload.unique_id || (added.messageId != null ? String(added.messageId) : null);
        if (chatId && conversationId === 'session') conversationId = String(chatId);
        // Role: the user's own prompt was being filed as the assistant's, which
        // is the single worst outcome here — it teaches memory that Chad said
        // what the model said. Poe does not consistently use author:"human", so
        // accept the known human markers and log any author value we do not
        // recognise instead of silently defaulting it to the assistant.
        const who = String(added.author || added.authorNickname || '').toLowerCase();
        const isHuman = who === 'human' || who === 'user'
          || (added.source && String(added.source.type || '').toLowerCase() === 'chat_input');
        const addedId = added.messageId != null ? String(added.messageId) : null;
        if (isHuman) { if (added.text.trim()) { user = added.text.trim(); userId = addedId; } }
        else if (added.state === 'complete') { assistant = added.text; assistantId = addedId; }
        else if (added.text.length > assistant.length) { assistant = added.text; assistantId = addedId; }
        if (!isHuman && who && who !== 'bot' && !POE_SEEN_AUTHORS.has(who)) {
          POE_SEEN_AUTHORS.add(who);
          try { console.debug('[vodou-netcap] poe: treating author "' + who + '" as the assistant — if that is wrong, this is why a turn is mislabelled'); } catch (_) {}
        }
      }
    }
    const turns = [];
    if (user) turns.push({ role: 'user', content: user, id: userId || undefined });
    if (assistant.trim()) turns.push({ role: 'assistant', content: assistant.trim(), id: assistantId || undefined });
    return { conversationId, turns };
  }

  // Character.AI — JSON-line turn updates from neo.character.ai; each carries
  // the full candidate text (last wins). EXPERIMENTAL.
  // Pick the candidate the USER ACTUALLY SAW. Character.AI generates alternates
  // ("swipes") and names the displayed one in primary_candidate_id; "last wins"
  // can store a reply that was never on screen — a plausible, well-formed,
  // untrue transcript, which is worse than a missing one.
  function caiCandidateText(turn) {
    const cands = Array.isArray(turn && turn.candidates) ? turn.candidates : [];
    if (!cands.length) return '';
    const primary = turn.primary_candidate_id;
    if (typeof primary === 'string') {
      const hit = cands.find((c) => c && c.candidate_id === primary);
      if (hit && typeof hit.raw_content === 'string') return hit.raw_content;
    }
    const last = cands[cands.length - 1];
    return last && typeof last.raw_content === 'string' ? last.raw_content : '';
  }

  function parseCharacterAI(bodyOrFrames, url, reqBody) {
    let conversationId = 'session';
    let user = '';
    let assistant = '';
    let userId = '';
    let assistantId = '';
    // Character.AI streams the SAME {turn:{…}} shape over its WebSocket that the
    // history endpoint returns in an array (confirmed live 2026-07-27), so one
    // parser serves both lanes — and both must key on turn_id, or a turn captured
    // live and the same turn seen on the next page load would store twice.
    const frames = Array.isArray(bodyOrFrames)
      ? bodyOrFrames.map((f) => (typeof f === 'string' ? safeJson(f) : f)).filter(Boolean)
      : jsonLines(bodyOrFrames).concat(sseDataChunks(bodyOrFrames).map(safeJson).filter(Boolean));
    // The history endpoint (GET /turns/<chat_id>/) answers with {"turns":[…]} —
    // an ARRAY, not the streamed {turn:{…}} frames. It matched and parsed nothing
    // (live 2026-07-27). Newest-first there, so sort by create_time rather than
    // trusting position: order is not a contract.
    for (const f of frames) {
      if (f && Array.isArray(f.turns)) {
        const sorted = f.turns.slice().sort((a, b) => String((a && a.create_time) || '').localeCompare(String((b && b.create_time) || '')));
        for (const t of sorted) frames.push({ turn: t });
      }
    }
    for (const obj of frames) {
      const turn = obj && obj.turn;
      if (!turn) continue;
      const key = turn.turn_key || {};
      if (typeof key.chat_id === 'string') conversationId = key.chat_id;
      const text = caiCandidateText(turn);
      if (!text) continue;
      const tid = typeof key.turn_id === 'string' ? key.turn_id : '';
      if (turn.author && turn.author.is_human) { user = text.trim(); userId = tid; }
      else { assistant = text; assistantId = tid; }   // frames are snapshots — last wins
    }
    if (!user) {
      const req = safeJson(reqBody || '');
      const rt = req && req.payload && req.payload.turn;
      const rc = rt && Array.isArray(rt.candidates) && rt.candidates[0];
      if (rc && typeof rc.raw_content === 'string') user = rc.raw_content.trim();
    }
    const turns = [];
    if (user) {
      const t = { role: 'user', content: user };
      if (userId) t.id = userId;
      turns.push(t);
    }
    if (assistant.trim()) {
      const t = { role: 'assistant', content: assistant.trim() };
      if (assistantId) t.id = assistantId;
      turns.push(t);
    }
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
      // Grok migrated its endpoint family (observed 2026-07-26): alongside the
      // old .../conversations/<id>/responses there are now conversations_v2/<id>,
      // .../response-node and .../load-responses. Claim the whole app-chat
      // conversation family EXCEPT the known non-transcript endpoints, so a
      // future rename lands in the parser (and the dump) instead of silently
      // falling through to "NO ADAPTER matched".
      // Only endpoints that can carry a transcript. conversations_v2 (metadata),
      // response-node (id graph) and sharing carry no message text; claiming them
      // just produced "matched but parsed 0 turns" on every page load. They still
      // surface via the NO-ADAPTER breadcrumb if Grok ever moves content into one.
      match: (url) => /grok\.com/.test(url)
        && /\/rest\/app-chat\/conversations\/[^/]+\/(load-responses|responses|new)\b/.test(url),
      parse: (body, url, reqBody) => parseGrok(body, url, reqBody),
    },
    {
      // Grok inside X — same provider namespace ('grok'), different surface.
      name: 'grok',
      // Moved to its own SUBDOMAIN and dropped the /i/api/ prefix (observed live
      // 2026-07-27): grok.x.com/2/grok/add_response.json. The old pattern required
      // the prefix, so the send stopped matching. The page is still x.com, so the
      // tap sees the request and no manifest change is needed.
      match: (url) => /(?:^|\/\/|\.)(x|twitter)\.com\/(?:i\/api\/)?2\/grok\/add_response\.json/.test(url),
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
      // `/c/api/(chat|conversations)` was too broad. Copilot hangs several
      // non-transcript resources off the same prefix, and matching them means the
      // adapter runs, parses nothing, and prints the multi-line "wire format may
      // have changed" warning — the one that should mean a real adapter is dying.
      // Measured 2026-08-09: typing a single sentence produced ~20 of them, because
      // `/autosuggest` fires on EVERY KEYSTROKE. A drift warning you scroll past is
      // worse than none, since the next genuine break is invisible in the flood.
      //
      // Keep: the live stream (`/c/api/chat`, incl. the SSE builds) and any
      // sub-resource of a SPECIFIC conversation (`/conversations/<id>/history` is
      // the transcript). Drop: typeahead, search status, activation, and the bare
      // conversation LIST — `/c/api/conversations[?…]` enumerates threads and
      // carries no turns.
      match: (url) => {
        if (!/copilot\.microsoft\.com/.test(url)) return false;
        if (/\/(autosuggest|search\/status|activation)\b/.test(url)) return false;
        return /\/c\/api\/chat\b/.test(url) || /\/c\/api\/conversations\/[^/?#]+\//.test(url);
      },
      // PLAN-HISTORY-BACKFILL P1b — the history GET is a JSON document
      // (`{results:[…]}`), not a frame stream, so it needs its own parser. Try it
      // FIRST and only for that URL: parseCopilotHistory returns null when the body
      // is not that shape, so the streaming path still handles everything else.
      // Gated on the backfill switch like the other two sites.
      parse: (body, url) => {
        if (backfillOn('copilot') && /\/c\/api\/conversations\/[^/]+\/history/.test(url || '')) {
          const hist = parseCopilotHistory(body, url);
          if (hist) return hist;
        }
        return parseCopilotFrames(sseDataChunks(body).concat(jsonLines(body)));
      },
    },
    {
      name: 'manus',
      // api.manus.im/session.v1.<Service>/<Method> — the old pattern demanded an
      // /api/ or /ws/ path SEGMENT, but "api" moved into the hostname, so this
      // never matched. Require a conversational method name so unrelated RPCs
      // (VideoEditingService/GetVideoEditing …) are not dragged in.
      match: (url) => /manus\.im/.test(url)
        && /(chat|message|conversation|completion|prompt)/i.test(url)
        // …but not the session-metadata endpoints that live under /api/chat/ too.
        // getSessionFilesV2 returns {"data":{"files":[]}} and matching it just
        // produced "parsed 0 turns" noise on every page load.
        && !/(getSessionFiles|getSession[A-Za-z]*V\d|files|upload|avatar|preference|settings)/i.test(url),
      parse: (body, url, reqBody) => parseManus(body, url, reqBody),
    },
    {
      name: 'qwen',
      match: (url) => /(^|\/\/|\.)qwen\.ai/.test(url) && /\/api\/(v\d+\/)?chat\/completions/.test(url),
      parse: (body, url, reqBody) => parseQwen(body, url, reqBody),
    },
    {
      name: 'kimi',
      // Kimi moved to a Connect/gRPC-style RPC (2026-07-26): the legacy
      // /completion/stream path is gone on kimi.com. Accept both.
      match: (url) => /(kimi\.com|kimi\.moonshot\.cn)/.test(url)
        && (/\/completion\/stream/.test(url) || /ChatService\/Chat/.test(url)),
      parse: (body, url, reqBody) => parseKimi(body, url, reqBody),
    },
    {
      name: 'duckai',
      // Duck.ai moved off the DuckDuckGo host onto its own (observed 2026-07-27):
      // the send is now https://duck.ai/duckchat/v1/chat, and the old match
      // demanded duckduckgo.com, so it never fired. Accept both hosts.
      // /auth/token and /status live under the same /duckchat/v1/ prefix and carry
      // no transcript — the \b keeps them out (and out of "parsed 0 turns" noise).
      match: (url) => /(duckduckgo\.com|duck\.ai)\/duckchat\/v\d+\/chat\b/.test(url),
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
      // Only the completions endpoint carries a transcript. The old pattern also
      // claimed GET /api/v1/chats/<id> — the conversation-history record — which
      // produced "matched but parsed 0 turns" on every page load. Same call as
      // Grok's: leave non-transcript endpoints to the NO-ADAPTER breadcrumb, where
      // they stay visible without pretending to be a capture failure.
      // (That history endpoint is a backfill candidate — see PLAN-HISTORY-BACKFILL.)
      match: (url) => /chat\.z\.ai/.test(url) && /\/api\/v\d+\/chat\/completions/.test(url),
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
      // Moved to notebook.google.com (observed live 2026-07-27) — and because the
      // MANIFEST only listed the old host, the content script never ran there at
      // all: no startup line, no breadcrumb, nothing. A manifest gap is the one
      // failure the in-page diagnostics cannot report, because none of them run.
      // Check the host in the address bar against manifest.matches whenever a site
      // produces no `taps installed` line.
      // ONLY the chat RPC. `batchexecute` was catastrophically wrong: on this site
      // it is EVERY page-load RPC, and the "longest string" heuristic then stored,
      // as conversation turns — verified live 2026-07-27, 14 junk rows in one page
      // load — the notebook's SOURCE TITLES and URLs, Google's prompt templates, an
      // upsell banner, the RPC method ids as "user" turns, and from the profile RPC
      // the owner's own avatar URL and account identity. The user's real question
      // was stored as the ASSISTANT.
      //
      // Meanwhile the actual conversation streams from
      // LabsTailwindOrchestrationService/GenerateFreeFormStreamed, which this
      // pattern never matched. Wrong endpoint AND a heuristic with no notion of
      // what a turn is: a parser that cannot fail visibly will fail silently, and
      // this one filed a user's documents and identity as speech.
      match: (url) => /notebook(lm)?\.google\.com/.test(url) && /GenerateFreeFormStreamed/.test(url),
      parse: (body, url, reqBody) => parseNotebookLM(body, url, reqBody),
    },
    {
      name: 'characterai',
      // /turns/<chat_id>/ carries the transcript; /turns/count carries turn COUNTS
      // and matched the old pattern, reporting "parsed 0 turns" on every page load.
      // Non-transcript endpoints belong in the NO-ADAPTER breadcrumb.
      match: (url) => /(neo\.)?character\.ai/.test(url)
        && (/streaming/.test(url) || /\/turns?\/[0-9a-f-]{8,}/i.test(url)),
      parse: (body, url, reqBody) => parseCharacterAI(body, url, reqBody),
    },
  ];

  // Resolve a possibly-RELATIVE request URL against the page origin before any
  // adapter sees it.
  //
  // This was silently breaking capture across the board: 24 of the adapters gate
  // on a hostname (/kimi\.com/, /chat\.deepseek\.com/, …), but a page that calls
  // fetch('/apiv2/…') hands us a path with no host in it, so EVERY one of those
  // checks failed and no adapter ever claimed the request. Kimi is simply the
  // first site where we looked closely enough to see it — the breadcrumb printed
  // "/apiv2/kimi.gateway.chat.v1.ChatService/Chat", host-less, which is the tell.
  function absUrl(u) {
    try {
      const str = String(u || '');
      if (!str) return '';
      if (/^[a-z]+:\/\//i.test(str)) return str;          // already absolute
      return new URL(str, location.href).href;
    } catch (_) { return String(u || ''); }
  }

  function adapterFor(url) {
    try { return ADAPTERS.find((a) => a.match(absUrl(url))) || null; } catch (_) { return null; }
  }

  // NOT exposed on `window`. This file runs in world:"MAIN", so `window` here is
  // the PAGE's window — assigning the parser table published ~30 internal functions
  // to chatgpt.com, claude.ai and 20 other origins, where any script could
  // enumerate them. That is a fingerprinting surface and a map of our capture
  // internals, shipped by a test hook whose own comment claimed it was a "no-op in
  // the browser". It never was. Node-side tests import the parsers from source.

  // A request on a supported host that no adapter claims is the failure mode that
  // costs the most: capture simply never happens, with nothing logged anywhere, and
  // it looks identical to "the extension isn't loaded". Sites move their endpoints
  // (Qwen went chat.qwen.ai -> qwen.ai/home), so this WILL happen again. Breadcrumb
  // the near-misses — requests that look like a chat API but matched no adapter —
  // so the next diagnosis is one Verbose console line instead of an afternoon.
  // Deliberately loose. The first version anchored on path SEGMENTS
  // (/\/(chat|message|…)(\/|\?|$)/), which silently ignored every Connect/gRPC
  // endpoint because those are named Service/Method — "TaskService/SendMessage"
  // has no /message/ segment, so Manus's send was never reported as a near-miss.
  // Over-reporting costs one deduped console.debug line; under-reporting costs a
  // debugging session, which is the trade we already paid twice tonight.
  // `stream` added 2026-07-27: You.com's endpoint is /api/streamingSearch, which
  // contains none of the other words, so a miss there produced NO breadcrumb at
  // all — the silent shape this list exists to prevent. Over-reporting costs one
  // deduped console line; under-reporting costs a debugging session.
  const LIKELY_CHAT_API = /(chat|completion|conversation|message|prompt|generate|inference|sendmsg|send_message|stream|response|grok)/i;
  // `response` and `grok` added 2026-07-27. X names its GraphQL operations in the
  // PATH (/i/api/graphql/<hash>/CreateGrokConversation), and Grok's send moved off
  // add_response.json to an op this list could not see — "AddResponse" contains
  // none of the earlier words. A provider name is a legitimate keyword here: it
  // catches every operation that provider adds, whatever they call it.
  // Housekeeping endpoints that match the heuristic but never carry a turn.
  // Without this the breadcrumb fires on every page load (Mistral emitted six
  // per load), and a diagnostic that cries wolf is one you stop reading.
  const NOISE_API = /(datalake|telemetry|analytics|satisfaction|limits|settings|version|feedback|\/legal\/|moderation|title|suggest)/i;
  const missReported = new Set();
  function reportUnmatched(rawUrl) {
    try {
      const url = absUrl(rawUrl);   // always log the ABSOLUTE url — a host-less
                                    // path in this message is what hid the
                                    // relative-URL bug for as long as it did.
      // Match on the PATH only. Testing the whole URL meant the hostname
      // decided the answer: every request on chat.mistral.ai / chatgpt.com
      // matched the word "chat" in its own host, so the breadcrumb reported
      // page-load noise as a missed chat endpoint.
      let path = String(url);
      try { path = new URL(url).pathname + new URL(url).search; } catch (_) { /* keep raw */ }
      if (!LIKELY_CHAT_API.test(path)) return;
      if (NOISE_API.test(path)) return;
      const key = String(url).split('?')[0];
      if (missReported.has(key)) return;      // once per endpoint per page
      missReported.add(key);
      console.debug('[vodou-netcap] NO ADAPTER matched a chat-looking request on this site — capture will not fire for it:', redactUrl(key));
    } catch (_) { /* ignore */ }
  }

  // Opt-in raw dump for adapter development. OFF unless the page sets
  //   localStorage.setItem('VODOU_NETCAP_DUMP','1')
  // Prints what the tap actually received, which is the only reliable way to
  // write a parser for a wire format we have not seen (Connect/gRPC frames do
  // not survive a look in the DevTools Response tab intact).
  function dumpEnabled() {
    try { return localStorage.getItem('VODOU_NETCAP_DUMP') === '1'; } catch (_) { return false; }
  }
  // Redact credentials before anything is printed. The dump exists to be pasted
  // into a bug report, and the first Manus dump printed a live JWT whose payload
  // decoded to the user's email, full name and account id. A debugging aid must
  // not be a credential-disclosure tool.
  function redact(str) {
    try {
      return String(str == null ? '' : str)
        // JWTs: three base64url segments
        .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '«JWT-REDACTED»')
        // A BARE base64 JSON blob — no dots, so the JWT pattern above misses it.
        // You.com's LaunchDarkly EventSource carries its user context this way, and
        // our own "EventSource opened" breadcrumb printed the owner's email inside
        // it (2026-07-27). `eyJ` is base64 for `{"`, so any long run starting that
        // way is an encoded JSON object — never something a parser author needs to
        // read, and routinely identity.
        .replace(/\beyJ[A-Za-z0-9_\-+/=]{20,}/g, '«B64-JSON-REDACTED»')
        // Credential-named keys: blank the value unconditionally.
        .replace(/("(?:access_token|refresh_token|authorization|auth|apiKey|api_key|sessionToken|cookie)"\s*:\s*")[^"]{8,}(")/gi, '$1«REDACTED»$2')
        // Bare "token" is AMBIGUOUS and used to be in the list above. HuggingChat
        // names its text deltas `token` — {"type":"stream","token":"Ack"} — so every
        // chunk of the reply printed as «REDACTED» and the dump was blank in exactly
        // the place we were reading it (live 2026-07-27, while chasing a leak on that
        // very site). Redact only a credential SHAPE: long, unbroken, base64/hex-ish.
        // Prose fails this test; an API key cannot.
        .replace(/("token"\s*:\s*")([A-Za-z0-9._\-+/=]{16,})(")/g, '$1«REDACTED»$3')
        .replace(/\b(sk-|ghp_|xox[baprs]-)[A-Za-z0-9_-]{10,}/g, '«KEY-REDACTED»');
    } catch (_) { return '«redaction failed — not printing»'; }
  }

  // Every URL we print goes through this. Sites put live credentials in query
  // strings — Copilot's chat socket carries an accessToken JWT that decodes to
  // the owner's email, full name and OAuth subject id, and the "WebSocket
  // opened" breadcrumb printed it verbatim into a console log whose whole
  // purpose is to be pasted into a bug report.
  //
  // redact() already handled JWTs; it was simply never applied to URLs. That is
  // the failure worth remembering: having the redaction function is not the
  // same as routing output through it, and the paths that print URLs are
  // exactly the diagnostics added in a hurry.
  function redactUrl(u) {
    try {
      let out = String(u == null ? '' : u);
      // Strip credential-bearing query parameters by name, whatever their shape.
      // `authorization` added 2026-07-27: Meta AI opens
      // wss://gateway.meta.ai/ws/clippy?…&Authorization=ecto1:<live session token>
      // and our own "WebSocket opened" breadcrumb printed it whole. Neither
      // `auth_?token` nor `token` matches the literal param name `Authorization`.
      out = out.replace(
        /([?&](?:access_?token|auth_?token|id_?token|token|authori[sz]ation|auth|bearer|credential|api_?key|apikey|key|sig|signature|password|secret|session|hash)=)[^&#\s]+/gi,
        '$1«REDACTED»');
      // SHAPE BACKSTOP. A list of parameter names will always lag whatever a
      // vendor invents next — this is the sixth credential-in-a-diagnostic bug
      // today, each one a name nobody had thought of. Any query value longer than
      // 60 characters with no spaces is redacted regardless of its name: uuids are
      // 36, conversation ids shorter still, so real debugging material survives
      // while opaque blobs do not.
      out = out.replace(/([?&][A-Za-z0-9_.\-]{1,40}=)([^&#\s]{60,})/g, '$1«LONG-VALUE-REDACTED»');
      return redact(out);   // JWT / key patterns anywhere else in the URL
    } catch (_) { return '«url redaction failed — not printing»'; }
  }

  function maybeDump(name, url, body, reqBody) {
    if (!dumpEnabled()) return;
    try {
      const b = String(body == null ? '' : body);
      const rb = String(reqBody == null ? '' : reqBody);
      // Redact the FULL string before slicing — a credential straddling the slice
      // boundary is invisible to a pattern that needs the whole token.
      const safeReq = redact(rb);
      const safeRes = redact(b);
      console.log('[vodou-netcap DUMP] ' + name + ' ← ' + redactUrl(url));
      console.log('[vodou-netcap]   REQ (' + rb.length + ' bytes):\n' + safeReq.slice(0, 1500));
      // A mask/field census beats pasting the whole body: for framed protocols
      // the question is always "which frames carry the answer", and 12KB of
      // deltas is mostly noise. Head + TAIL because the reply lands at the end.
      logFrameCensus(safeRes);
      console.log('[vodou-netcap]   RES (' + b.length + ' bytes) HEAD:\n' + safeRes.slice(0, 1200));
      console.log('[vodou-netcap]   RES TAIL:\n' + safeRes.slice(-2500));
    } catch (_) { /* ignore */ }
  }

  // Shared by the matched and unmatched dumps — one census, so a fix or a new
  // frame-kind heuristic lands in both instead of drifting apart.
  function logFrameCensus(text) {
    try {
      const counts = {};
      for (const f of scanJsonObjects(String(text == null ? '' : text))) {
        // Frame "kind" differs per protocol: Connect uses `mask`, Vercel-style
        // numbered lines wrap the real shape in {json:{type:…}}, others use a
        // bare `type`. Try each so the census is meaningful rather than a
        // column of "json".
        const k = (f && (
          f.mask ||
          (f.json && (f.json.type || Object.keys(f.json)[0])) ||
          f.type ||
          (f.heartbeat ? 'heartbeat' : Object.keys(f)[0])
        )) || '?';
        counts[k] = (counts[k] || 0) + 1;
      }
      console.log('[vodou-netcap]   RES frame masks:', JSON.stringify(counts, null, 1));
    } catch (_) { /* ignore */ }
  }

  // Dump the wire for a request NO adapter claimed. The dump was built for fixing
  // a parser, which assumes an adapter already matches — so the one case it could
  // not help with was the one that needs it most: an endpoint that MOVED. You get
  // a URL and nothing else, and DevTools shows a streamed body as pending or
  // empty. OpenRouter is the live example (2026-07-27): its chatroom posts to the
  // page URL itself rather than /api/v1/chat/completions, and the breadcrumb could
  // say the endpoint missed but never what it carried.
  //
  // Gated on the same flag, the same near-miss filter, and once per endpoint, so a
  // flagged session prints a handful of frames rather than every asset on the page.
  // An UNMATCHED body is not chat traffic by definition — we do not know what it
  // is. The first live use printed the owner's account record (email, auth user
  // id, real name, billing plan) from OpenRouter's page-data call, into a console
  // whose whole purpose is to be pasted into a bug report. redact() missed all of
  // it because none of it looks like a credential.
  //
  // So: redact by KEY NAME, not by value shape. Anything whose key smells like
  // identity or billing has its value replaced before printing. A parser author
  // needs the SHAPE of an unknown endpoint, never the values.
  const PII_KEY = /(e?mail|phone|address|first_?name|last_?name|full_?name|user_?name|nickname|avatar|image_url|picture|user_?id|account_?id|customer_?id|clerk|auth0|stripe|card|payment|ssn|dob|birth|licen[cs]e|ip_?addr|latitude|longitude|geo)/i;
  function redactRecord(str) {
    try {
      return String(str == null ? '' : str)
        // "key":"value" and "key":123 — value replaced, key kept so shape survives
        .replace(/("(?:[A-Za-z0-9_\-. ]*?)")(\s*:\s*)("(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?)/g,
          (m, k, sep, v) => (PII_KEY.test(k) ? k + sep + '"«redacted»"' : m));
    } catch (_) { return '«record redaction failed — not printing»'; }
  }

  const missDumped = new Set();
  function dumpUnmatched(url, resp, reqBody) {
    if (!dumpEnabled()) return;
    try {
      let path = String(url), search = '';
      try { const u = new URL(url); path = u.pathname + u.search; search = u.search; } catch (_) { /* keep raw */ }
      if (!LIKELY_CHAT_API.test(path) || NOISE_API.test(path)) return;
      // Analytics beacons wear obfuscated paths (`/537s/ag/g/c`) that no keyword
      // list will ever catch, but their query strings are unmistakable. They also
      // return nothing, so dumping them is pure noise carrying a region and a
      // referrer URL.
      if (/[?&](tid=G-|gtm=|en=page_view|_gaz=)/.test(search)) return;
      const key = String(url).split('?')[0];
      if (missDumped.has(key)) return;
      missDumped.add(key);
      readBodyThen(resp.clone(), url, (body) => {
        const b = String(body == null ? '' : body);
        if (!b) { missDumped.delete(key); return; }   // empty → learn nothing, and let a real body dump later
        try {
          // REDACT THE WHOLE BODY, THEN SLICE. Slicing first splits a
          // "key":"value" pair across the window boundary, and redactRecord needs
          // the key to decide — so the tail printed `l":"https://img.clerk.com/…`
          // in full: the slice had eaten the `image_ur` that would have matched.
          // Observed live 2026-07-27, on the fix for the leak from an hour before.
          const safeReq = redactRecord(redact(String(reqBody || '')));
          const safeRes = redactRecord(redact(b));
          console.log('[vodou-netcap DUMP] UNMATCHED ← ' + redactUrl(key));
          console.log('[vodou-netcap]   (unknown endpoint — values under identity/billing keys are redacted)');
          console.log('[vodou-netcap]   REQ (' + String(reqBody || '').length + ' bytes):\n' + safeReq.slice(0, 600));
          // The census is the most useful line in the dump — it says which frames
          // carry the answer without printing 12KB of deltas. Hand-rolling this
          // print block dropped it; restored 2026-07-27 after Chad noticed the
          // unmatched dumps had gone quieter than the matched ones.
          // Computed on the REDACTED body on purpose: redaction replaces values
          // and keeps keys, so the census is identical either way — and this way
          // the census can never become the path that prints something raw.
          logFrameCensus(safeRes);
          console.log('[vodou-netcap]   RES (' + b.length + ' bytes) HEAD:\n' + safeRes.slice(0, 900));
          console.log('[vodou-netcap]   RES TAIL:\n' + safeRes.slice(-900));
        } catch (_) { /* ignore */ }
      });
    } catch (_) { /* ignore */ }
  }

  // PLAN-CAPTURE-FEED P2 — which model answered.
  //
  // The plan said "the adapters that already parse it". None of them do — every
  // adapter throws the model name away, though the payloads carry it (ChatGPT:
  // "model_slug":"gpt-5-6-thinking"). Six per-provider parsers would be six more
  // wire formats to keep alive, and I have live payloads for one of them.
  //
  // So: one generic sniff over the body we already hold. It looks only at keys
  // providers actually use, requires a plausible-looking value, and returns null
  // rather than guessing — an absent chip is honest, a wrong one is not.
  const MODEL_KEY = /"(model_slug|default_model_slug|model_id|modelName|model_name|model)"\s*:\s*"([^"]{2,60})"/g;
  // Values that are a field name, a UI label, or an id — never a model.
  const MODEL_REJECT = /^(auto|default|null|none|true|false|user|assistant|system|text|chat)$/i;

  function sniffModel(body) {
    try {
      const s = String(body || '');
      if (!s || s.length > 2_000_000) return null;
      const seen = new Map();
      MODEL_KEY.lastIndex = 0;
      let m;
      while ((m = MODEL_KEY.exec(s)) !== null) {
        const val = m[2].trim();
        if (!val || MODEL_REJECT.test(val)) continue;
        // A model id looks like a slug/name, not a sentence or a UUID.
        if (/\s{2,}/.test(val)) continue;
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(val)) continue;
        seen.set(val, (seen.get(val) || 0) + 1);
      }
      if (!seen.size) return null;
      // The most frequently named model in the payload — streams repeat the
      // resolved model on many frames, while a one-off mention is usually the
      // account default rather than what actually answered.
      let best = null, bestN = 0;
      for (const [val, n] of seen) if (n > bestN) { best = val; bestN = n; }
      return best;
    } catch (_) {
      return null;
    }
  }

  function emit(url, body, reqBody) {
    const adapter = adapterFor(url);
    if (!adapter) { reportUnmatched(url); return; }
    maybeDump(adapter.name, url, body, reqBody);
    try {
      const { conversationId, turns, pending, quiet, backfill } = adapter.parse(body, url, reqBody) || {};
      const good = trimTurns(turns || []);
      if (!good.length) {
        // `pending` means the parser understood the body perfectly and there is
        // simply no finished exchange in it yet — the reply is still generating.
        // That is the NORMAL state of a snapshot taken mid-turn, and shouting
        // "wire format may have changed" at it trains you to ignore the warning
        // that matters. Observed on chatgpt 2026-07-28 during the P0 round-trip
        // test: every send produced one of these against a working parser.
        if (pending || quiet) {
          console.debug(`[vodou-netcap] ${adapter.name}: ${pending ? 'reply still generating' : 'nothing new in this body'} — nothing to capture`);
          return;
        }
        debugMiss(adapter.name, url, body, reqBody);
        return;
      }
      // Stamp the answering model on assistant turns only — a user turn has no
      // model, and claiming one would be a lie the feed then renders as fact.
      const model = sniffModel(body);
      if (model) {
        for (const t of good) if (t.role === 'assistant' && !t.model) t.model = model;
      }
      POST(adapter.name, conversationId || 'session', good, !!backfill);
    } catch (err) {
      // Swallowing the error is right — a capture bug must never break someone's
      // chat — but swallowing it SILENTLY made a throwing parser look identical
      // to "nothing happened", which cost a full test round. Report, then carry on.
      try {
        console.debug('[vodou-netcap] ' + adapter.name + ' parser THREW — capture skipped for this request:',
          (err && err.message) || err, '| url:', url);
      } catch (_) { /* ignore */ }
    }
  }

  // Extract a request body as text. The comment here used to say string bodies
  // "cover every current adapter" — t3.chat disproved that on 2026-07-27: it posts
  // a Request OBJECT, so this returned '' and the prompt vanished. The reply
  // captured fine, so the failure looked like a half-working parser rather than a
  // transport gap, and it would recur on any site using fetch(new Request(...)).
  //
  // Request-object bodies are handled in the fetch shim, which must clone BEFORE
  // the fetch consumes the stream. This covers the synchronous init.body forms.
  function requestBodyOf(init) {
    try {
      if (!init || init.body == null) return '';
      const b = init.body;
      if (typeof b === 'string') return b;
      if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) return b.toString();
      // Some clients encode JSON to bytes before sending.
      if (typeof TextDecoder !== 'undefined') {
        if (b instanceof ArrayBuffer) return new TextDecoder().decode(b);
        if (ArrayBuffer.isView(b)) return new TextDecoder().decode(b.buffer || b);
      }
      // multipart/form-data. HuggingChat posts the JSON payload as a `data` field
      // (with files alongside), so the prompt was invisible and only the reply
      // captured. Reading entries does not consume the FormData.
      if (typeof FormData !== 'undefined' && b instanceof FormData) {
        const d = b.get('data');
        if (typeof d === 'string' && d) return d;
        const parts = [];
        for (const [k, v] of b.entries()) if (typeof v === 'string') parts.push(k + '=' + v);
        return parts.join('&');
      }
      // Blob bodies are async-only; the shim's Request clone covers the cases that
      // matter, and guessing here would block the page's send.
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

  // ── Requests are never modified ───────────────────────────────────────────
  //
  // This shim exists only so the taps below can READ responses for the
  // conversation capture the user asks for. Arguments pass through untouched:
  // the extension does not add to, alter, or remove anything from a request the
  // page sends. Memory reaches a chat only through visible composer insertion,
  // which the user triggers and can edit before sending.
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

  // Read a cloned response body and hand the text to `done`.
  //
  // `.text()` looks simpler but resolves only when the stream CLOSES. A
  // long-lived streaming RPC (Kimi's Connect endpoint, for one) can stay open
  // well past the point the answer is complete, so .text() may never settle —
  // and with the old `.catch(() => {})` that produced total silence: no capture,
  // no miss, no error. Read incrementally instead, and flush on either end-of-
  // stream or a quiet gap, so a stream that never closes still gets captured.
  // 1.5s was too tight: Kimi's first frames arrive immediately (user echo +
  // an assistant record still MESSAGE_STATUS_GENERATING) and the model then
  // thinks for seconds before emitting reply text. Flushing on that early gap
  // captured the prompt and none of the answer. A stream that closes normally
  // still flushes instantly at end-of-stream; this longer gap only affects
  // streams that stay open.
  const READ_QUIET_MS = 12000;
  const READ_MAX_MS = 60000;
  function readBodyThen(cloned, url, done) {
    let settled = false;
    const finish = (text, why) => {
      if (settled) return;
      settled = true;
      try { console.debug(`[vodou-netcap] body read ${why}: ${text.length} bytes ←`, redactUrl(url)); } catch (_) {}
      try { done(text); } catch (_) { /* emit reports its own errors */ }
    };
    try {
      const body = cloned.body;
      if (!body || typeof body.getReader !== 'function') {
        cloned.text().then((t) => finish(t, 'via text()'))
          .catch((e) => { try { console.debug('[vodou-netcap] body read FAILED ←', redactUrl(url), (e && e.message) || e); } catch (_) {} });
        return;
      }
      const reader = body.getReader();
      const dec = new TextDecoder();
      let acc = '';
      let quiet = null;
      const bump = () => {
        if (quiet) clearTimeout(quiet);
        quiet = setTimeout(() => {
          // Stream still open but idle — the answer is almost certainly complete.
          if (acc) { try { reader.cancel(); } catch (_) {} finish(acc, 'on quiet gap'); }
        }, READ_QUIET_MS);
      };
      const hardStop = setTimeout(() => {
        if (acc) { try { reader.cancel(); } catch (_) {} finish(acc, 'on max duration'); }
      }, READ_MAX_MS);
      const pump = () => reader.read().then(({ done: fin, value }) => {
        if (fin) {
          if (quiet) clearTimeout(quiet);
          clearTimeout(hardStop);
          finish(acc, 'at end of stream');
          return;
        }
        acc += dec.decode(value, { stream: true });
        bump();
        pump();
      }).catch((e) => {
        if (quiet) clearTimeout(quiet);
        clearTimeout(hardStop);
        try { console.debug('[vodou-netcap] body read ERROR ←', redactUrl(url), (e && e.message) || e); } catch (_) {}
        if (acc) finish(acc, 'after read error');
      });
      pump();
    } catch (e) {
      try { console.debug('[vodou-netcap] body read SETUP FAILED ←', redactUrl(url), (e && e.message) || e); } catch (_) {}
    }
  }

  // ── fetch shim ─────────────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    try {
      args = await maybeInjectArgs(args);
    } catch (_) { /* an inject error must never break the send */ }
    // Snapshot a Request-OBJECT body before origFetch consumes it. clone() is only
    // legal while the body is undisturbed, so this cannot be deferred to after the
    // await — which is exactly why the prompt was missing on t3.chat.
    let reqBodyLater = null;
    try {
      const input = args[0];
      if (input && typeof input === 'object' && typeof input.clone === 'function' && input.body) {
        reqBodyLater = input.clone().text().then((t) => String(t || '')).catch(() => '');
      }
    } catch (_) { /* never let the snapshot break the send */ }
    const resp = await origFetch.apply(this, args);
    try {
      const url = absUrl((args[0] && args[0].url) || String(args[0] || ''));
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
        if (!reqBody && reqBodyLater) {
          // Request-object body: resolve the snapshot taken before the fetch.
          // The response read is started either way, so a slow clone cannot
          // cost us the stream.
          reqBodyLater.then((rb) => readBodyThen(resp.clone(), url, (body) => emit(url, body, rb)));
        } else {
          readBodyThen(resp.clone(), url, (body) => emit(url, body, reqBody));
        }
      } else {
        // The miss has to be reported HERE, not inside emit(): emit is only
        // reached when an adapter already matched, so a check in there can
        // never fire for an unmatched request. (My first attempt at this
        // breadcrumb was dead code for exactly that reason.)
        reportUnmatched(url);
        dumpUnmatched(url, resp, requestBodyOf(args[1]));   // no-op unless the dump flag is set
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
      this.__vodouUrl = absUrl(url);   // relative paths would miss every host-gated adapter
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
        } else if (this.__vodouUrl) {
          reportUnmatched(String(this.__vodouUrl));
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
      // Two sockets open on manus.im; the notifier one carries no conversation.
      match: (url) => /manus\.im/.test(url) && !/notifier/i.test(url),
      parse: (frames, url) => parseManus(frames, url, ''),
      // Manus signals completion with a statusUpdate event, not a 'done' frame.
      // The old predicate never fired, so the flush only happened on socket close.
      isDone: (obj) => {
        const pl = obj && Array.isArray(obj.data) ? obj.data[0] : obj;
        const ev = pl && pl.event;
        return !!(ev && ev.type === 'statusUpdate' && ev.agentStatus === 'stopped');
      },
    },
    {
      // Poe streams GraphQL subscription updates over wss://*.tch.poe.com/up/…
      name: 'poe',
      match: (url) => /(\.tch\.)?poe\.com\/up\//.test(url) || /poe\.com.*websocket/i.test(url),
      parse: (frames) => parsePoeFrames(frames),
      isDone: (obj) => !!(obj && Array.isArray(obj.messages)
        && obj.messages.some((s) => typeof s === 'string' && s.includes('"state":"complete"'))),
    },
    {
      // Character.AI sends over wss://neo.character.ai/ws/ — the SAME {turn:{…}}
      // frames its history endpoint returns, so parseCharacterAI serves both and
      // turn_id keys them identically. Without the WS lane, capture only happened
      // on the NEXT page load, when the history fetch replayed the thread.
      // Meta AI's chat is on this socket in a binary envelope — the fetch adapter
      // (/api/graphql) never fires on the current build.
      name: 'metaai',
      match: (url) => /gateway\.meta\.ai\/ws\//.test(url),
      parse: (frames) => parseMetaAIFrames(frames),
      // The stream ends with a full snapshot that carries no `seq`; flush on close
      // and quiet-gap regardless, so this only has to be a hint.
      isDone: (obj) => {
        const raw = obj && typeof obj.__raw === 'string' ? obj.__raw : '';
        return !!raw && raw.indexOf('"seq"') === -1 && raw.indexOf('"sections"') >= 0;
      },
    },
    {
      name: 'characterai',
      match: (url) => /(neo\.)?character\.ai/.test(url),
      parse: (frames) => parseCharacterAI(frames, ''),
      // Every frame is a cumulative snapshot of the same turn; the finished one
      // re-states create_time on the candidate. Close/quiet-gap flush is the real
      // backstop, so this only needs to be a good hint, not a contract.
      isDone: (obj) => {
        const c = obj && obj.turn && Array.isArray(obj.turn.candidates) && obj.turn.candidates[0];
        return !!(c && (c.is_final === true || typeof c.create_time === 'string'));
      },
    },
  ];

  const OrigWS = window.WebSocket;
  if (OrigWS) {
    const TappedWS = function (url, protocols) {
      const sock = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
      try {
        const u = String(url || '');
        const adapter = WS_ADAPTERS.find((a) => { try { return a.match(absUrl(u)); } catch (_) { return false; } });
        // A WebSocket nobody claims was previously invisible. If a site streams
        // its chat over WS (Manus, Copilot, Poe do) and the adapter's match is
        // wrong, capture dies with no trace — the same silent-failure shape that
        // cost several rounds on the fetch side.
        try {
          console.debug('[vodou-netcap] WebSocket opened' + (adapter ? ' — claimed by ' + adapter.name : ' — NO WS ADAPTER matched') + ':', redactUrl(u));
        } catch (_) { /* ignore */ }
        // An UNCLAIMED socket was a dead end: you learn a chat streams over WS and
        // nothing about what it carries, because frame dumping lives inside the
        // matched branch. Character.AI is the live case (2026-07-27) — its send is
        // on wss://neo.character.ai and no adapter claims it. Same gap the fetch
        // side had until dumpUnmatched; same fix, same flag, and capped so a busy
        // socket cannot flood the console.
        if (!adapter) {
          let seen = 0;
          const CAP = 40;
          sock.addEventListener('message', (ev) => {
            try {
              // dumpEnabled() is checked PER MESSAGE, not at open. A long-lived
              // socket opens on page load, so gating at construction meant setting
              // the flag did nothing until the socket happened to reconnect —
              // indistinguishable from "this site sends nothing".
              if (!dumpEnabled()) return;
              if (seen >= CAP) return;
              // BINARY FRAMES. Every WS path here tested `typeof data === 'string'`
              // and returned otherwise, so a socket on a binary protocol looked
              // completely silent — no frames, no breadcrumb, nothing to debug.
              // meta.ai's gateway is the live suspect (2026-07-27). Decoding is
              // dump-only: enough to see whether text is in there and what frames
              // it with, which is what decides if an adapter is even possible.
              let text = '';
              if (typeof ev.data === 'string') text = ev.data;
              else if (ev.data instanceof ArrayBuffer && typeof TextDecoder !== 'undefined') {
                text = '[binary ' + ev.data.byteLength + 'B] ' + new TextDecoder('utf-8', { fatal: false }).decode(ev.data);
              } else if (typeof Blob !== 'undefined' && ev.data instanceof Blob) {
                // Async, so report the shape now and the text when it resolves.
                const size = ev.data.size;
                ev.data.text().then((t) => {
                  try {
                    console.log('[vodou-netcap DUMP ws<- UNMATCHED] [blob ' + size + 'B] '
                      + redactRecord(redact(String(t).slice(0, 600))));
                  } catch (_) { /* ignore */ }
                }).catch(() => {});
                return;
              } else {
                text = '[non-text frame: ' + Object.prototype.toString.call(ev.data) + ']';
              }
              seen++;
              const safe = redactRecord(redact(text.slice(0, 600)));
              console.log('[vodou-netcap DUMP ws<- UNMATCHED] ' + safe + (seen === CAP ? '  …(cap reached)' : ''));
            } catch (_) { /* ignore */ }
          });
        }
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
            const raw = wsFrameText(ev.data);
            if (!raw) return;
            // A protobuf/binary envelope will not JSON.parse whole — hand the raw
            // text through so a parser can scan the JSON embedded inside it.
            const obj = decodeWsFrame(raw) || (raw.indexOf('{') >= 0 ? { __raw: raw } : null);
            if (dumpEnabled()) {
              // `raw`, not ev.data — stringifying the event gave "[object
              // ArrayBuffer]" on every binary frame, so the matched-branch dump
              // was blind on exactly the sites that need it (Meta AI, 2026-07-27).
              try { console.log('[vodou-netcap DUMP ws<-] ' + adapter.name + ': ' + redactRecord(redact(raw.slice(0, 400)))); } catch (_) {}
            }
            if (obj) frames.push(obj);
            try { if (obj && adapter.isDone(obj)) flush(); } catch (_) { /* ignore */ }
          });
          const origSend = sock.send.bind(sock);
          sock.send = function (data) {
            try {
              // The PROMPT goes out this way. Text-only here meant a site sending
              // binary frames captured a reply with no question attached — the
              // one-sided shape that reads as a broken parser rather than a
              // transport gap (three times over today).
              const raw = wsFrameText(data);
              if (raw) {
                const obj = decodeWsFrame(raw) || (raw.indexOf('{') >= 0 ? { __raw: raw, __outgoing: true } : null);
                if (dumpEnabled()) {
                  try { console.log('[vodou-netcap DUMP ws->] ' + adapter.name + ': ' + redactRecord(redact(raw.slice(0, 400)))); } catch (_) {}
                }
                if (obj) { obj.__outgoing = true; frames.push(obj); }
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

  // ── EventSource shim ────────────────────────────────────────────────────────
  // The fourth way a page can stream, and until 2026-07-27 the only one nobody
  // tapped: fetch, XHR and WebSocket were all covered, `new EventSource(url)` was
  // not. A site using it captured nothing AND logged nothing — no request, no
  // near-miss breadcrumb, no dump. Indistinguishable from "the extension is not
  // installed", which is the failure shape that has cost the most time here.
  //
  // EventSource is GET-only, so there is no request body: an adapter fed from
  // here gets the URL and the frames. Parsers that read the prompt from the URL
  // (You.com) work as-is; ones that need a request body will report
  // "parsed 0 turns", which is at least honest and visible.
  const OrigES = window.EventSource;
  if (OrigES) {
    const TappedES = function (url, config) {
      const es = config !== undefined ? new OrigES(url, config) : new OrigES(url);
      try {
        const u = absUrl(String(url || ''));
        const claimed = !!adapterFor(u);
        try {
          console.debug('[vodou-netcap] EventSource opened' + (claimed ? ' — claimed by an adapter' : ' — NO ADAPTER matched') + ':', redactUrl(u));
        } catch (_) { /* ignore */ }
        if (!claimed) reportUnmatched(u);
        if (claimed) {
          // Reassemble the SSE text the parsers already expect, so every existing
          // adapter works over this transport with no changes.
          let text = '';
          let timer = null;
          const flush = () => {
            if (timer) { clearTimeout(timer); timer = null; }
            const body = text;
            text = '';
            if (body) emit(u, body, '');
          };
          const arm = () => {
            if (timer) clearTimeout(timer);
            // Same quiet-gap logic as the streaming fetch reader: a reasoning
            // model can sit silent for seconds mid-answer.
            timer = setTimeout(flush, 12000);
          };
          es.addEventListener('message', (ev) => {
            try {
              if (typeof ev.data !== 'string') return;
              text += 'data: ' + ev.data + '\n\n';
              arm();
            } catch (_) { /* ignore */ }
          });
          es.addEventListener('error', flush);
          const origClose = es.close.bind(es);
          es.close = function () { try { flush(); } catch (_) { /* ignore */ } return origClose(); };
        }
      } catch (_) { /* the tap must never break the page's stream */ }
      return es;
    };
    try {
      TappedES.prototype = OrigES.prototype;
      for (const k of ['CONNECTING', 'OPEN', 'CLOSED']) {
        try { TappedES[k] = OrigES[k]; } catch (_) { /* ignore */ }
      }
      window.EventSource = TappedES;
    } catch (_) { /* ignore */ }
  }

  // Startup breadcrumb. Without it, "no [vodou-netcap] lines" is ambiguous
  // between "the tap never installed" and "the tap installed and matched
  // nothing" — two very different bugs that look identical in the console.
  try {
    console.debug(
      '[vodou-netcap] taps installed on ' + location.hostname +
      ' (fetch, XHR, WebSocket, EventSource). Nothing captures until a request matches an adapter.',
    );
  } catch (_) { /* ignore */ }
})();
