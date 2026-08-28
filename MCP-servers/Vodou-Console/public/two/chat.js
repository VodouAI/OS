/**
 * Console Two chat — the center of the product (PLAN-CONSOLE-TWO §4.3).
 *
 * Wire handling follows the proven consumer (Store-vodou-bridge/sidepanel.js
 * :646-790): per-conversation seq guard, history that never wipes live rows,
 * inline approvals, one-line tool rows. Plus the two things that panel never
 * had: resume actually SENT on reconnect (the shipped panel maps chat_resume
 * but never posts it — found 2026-08-09), and the staged answer (§4.5.1):
 * stage-1 recall cards paint fast, the agentic stream lands beneath them.
 */

export function initChat(transport, ui) {
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const stopBtn = document.getElementById('stop');
  const chipModel = document.getElementById('chip-model');
  const chipStatus = document.getElementById('chip-status');

  let convId = localStorage.getItem('two_conversation') || null; // warm-open (§4.5.6)
  let lastSeq = 0;
  let assistantEl = null;
  let cardsEl = null;
  let turnOpen = false;
  let turnUsage = null; // last usage frame this turn — rendered in the provenance footer
  let turnReceipt = null; // turn_receipt frame — what the turn USED (F30)
  const toolRows = new Map();

  const scroll = () => { log.scrollTop = log.scrollHeight; };
  const clearEmpty = () => { const e = log.querySelector('.empty'); if (e) e.remove(); };

  function addMsg(role, text) {
    clearEmpty();
    const d = document.createElement('div');
    d.className = 'msg ' + role;
    d.textContent = text || '';
    log.appendChild(d);
    scroll();
    return d;
  }

  // The empty state is the console's first touch, so it TEACHES rather than
  // greets: one line of what this is, then three things worth asking that each
  // prove a different capability (memory recall / continuity / page awareness).
  // Tapping one sends it — the first turn costs a tap, not a blank page and a
  // guess about what this thing can do.
  const STARTERS = [
    { label: 'What do you know about me?', why: 'your memory' },
    { label: 'What was I working on?', why: 'picks up where you left off' },
    { label: 'Summarise this page', why: 'reads the tab you are on', needsPage: true },
  ];
  function showEmpty() {
    if (log.childElementCount) return;
    const d = document.createElement('div');
    d.className = 'empty';

    const h = document.createElement('div');
    h.className = 'empty-head';
    h.textContent = 'Everything you have told Vodou is here';
    const sub = document.createElement('div');
    sub.className = 'empty-sub';
    sub.textContent = 'Ask anything — it answers with your memory, your apps and your skills, on your machine.';
    d.append(h, sub);

    const list = document.createElement('div');
    list.className = 'starters';
    for (const st of STARTERS) {
      if (st.needsPage && document.getElementById('page-strip')?.classList.contains('is-hidden')) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'starter';
      const t = document.createElement('span');
      t.className = 'starter-t';
      t.textContent = st.label;
      const w = document.createElement('span');
      w.className = 'starter-w';
      w.textContent = st.why;
      b.append(t, w);
      b.addEventListener('click', () => {
        input.value = st.label;
        input.dispatchEvent(new Event('input'));
        send();
      });
      list.appendChild(b);
    }
    d.appendChild(list);
    log.appendChild(d);
  }

  function setStatus(text) { chipStatus.textContent = text || ''; }
  function startTurn() {
    turnOpen = true; assistantEl = null; cardsEl = null; toolRows.clear();
    sendBtn.disabled = true; stopBtn.hidden = false;
    ui.seamLive(true);
  }
  function endTurn() {
    turnOpen = false;
    sendBtn.disabled = false; stopBtn.hidden = true;
    ui.seamLive(false);
  }

  // ── Frames ────────────────────────────────────────────────────────────────
  // COHERENCE F30 — what the turn USED, in the extension panel's exact words.
  //
  // These two surfaces describe the same turn, so they must describe it the
  // same way; the finding was that they did not. The wording here is kept
  // byte-identical to renderReceipt() in the extension's sidepanel.js, and a
  // test asserts that equality rather than trusting it to survive edits.
  //
  // Extracted as a pure function so it can be tested at all — the bug this
  // whole finding turns on (a receipt read off a frame that never carried it)
  // survived for exactly as long as nobody could run the code in isolation.
  function usedBits(receipt, doneMemory) {
    const bits = [];
    // Prefer the receipt: it is the record every other surface reads. Fall back
    // to `done` for a gateway too old to send one.
    const mem = (receipt && receipt.memories && receipt.memories.used) || (doneMemory && doneMemory.used) || 0;
    const tools = (receipt && Array.isArray(receipt.tools)) ? receipt.tools : [];
    const skills = (receipt && Array.isArray(receipt.skills)) ? receipt.skills : [];
    if (mem) bits.push(`${mem} ${mem === 1 ? 'memory' : 'memories'}`);
    if (tools.length) bits.push(`${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}`);
    if (skills.length) bits.push(`${skills.length} ${skills.length === 1 ? 'skill' : 'skills'}`);
    // A turn whose context pipeline missed its budget says so. The server sends
    // a receipt for that case even when the turn used nothing, precisely so a
    // degraded turn is not mistaken for an empty one.
    if (receipt && receipt.degraded) bits.push('limited context');
    // P4/P7a — an eviction is shown without expanding anything; the lane rows
    // ride on the footer's title so both consoles show the same lane set.
    const lanes = (receipt && Array.isArray(receipt.lanes)) ? receipt.lanes : [];
    const evictedTok = lanes.reduce((n, l) => n + ((l && l.evicted_tok) || 0), 0);
    if (evictedTok) bits.push(`${evictedTok} tok evicted`);
    return bits;
  }

  transport.onFrame((f) => {
    switch (f.type) {
      case 'connected': {
        // First boot with no stored conversation: adopt the server's.
        if (!convId) {
          convId = f.conversationId;
          localStorage.setItem('two_conversation', convId);
        } else if (f.conversationId !== convId) {
          transport.send({ type: 'switch_conversation', conversationId: convId });
        }
        if (f.activeModel) chipModel.textContent = f.activeModel;
        // Resume the tail of a turn that streamed across the drop — the fix
        // the shipped panel is missing.
        if (turnOpen && lastSeq > 0) {
          transport.send({ type: 'resume', conversationId: convId, lastSeq });
        }
        setStatus('');
        return;
      }
      case '_transport': {
        if (f.state === 'reconnecting') setStatus('connecting to Vodou…');
        ui.seamAlive(f.state === 'connected');
        return;
      }
      case 'history': {
        if (f.conversationId !== convId) return;
        // Replace chat bubbles only — live tool rows / cards survive (the
        // shared-log discipline from the proven consumer).
        for (const el of log.querySelectorAll('.msg')) el.remove();
        const first = log.querySelector('.toolrow, .cards, .approval');
        for (const m of f.messages || []) {
          const d = document.createElement('div');
          d.className = 'msg ' + (m.role === 'user' ? 'user' : 'assistant');
          d.textContent = m.text || '';
          log.insertBefore(d, first || null);
          // COHERENCE F8 / D-6 — a reloaded turn keeps its receipt.
          //
          // The server has recorded what every turn used since migration 086
          // and nothing read it back, so reopening a conversation silently
          // dropped every "3 memories · 2 tools" the turns had shown while
          // live. Same words as the live footer, through the same usedBits(),
          // because the same turn describing itself two ways IS the finding.
          //
          // Only assistant rows that CARRY one: history predating the turn_id
          // column has no receipt, and inventing an empty one would say "this
          // turn used nothing" about a turn we simply cannot describe.
          if (m.role !== 'user' && m.receipt) {
            const bits = usedBits(m.receipt, null);
            if (bits.length) {
              const p = document.createElement('div');
              p.className = 'provenance';
              p.textContent = bits.join(' · ');
              log.insertBefore(p, first || null);
            }
          }
        }
        if (f.messages && f.messages.length) clearEmpty(); else showEmpty();
        scroll();
        return;
      }
      case 'approval_requested': {
        // Broadcast frame (no seq). §4.5.5's surface: inline row, never a dialog.
        if (f.conversationId && f.conversationId !== convId) return;
        renderApproval(f);
        return;
      }
    }

    if (f.conversationId !== convId) return;
    if (typeof f.seq === 'number') {
      if (f.seq <= lastSeq) return; // duplicate/replayed frame
      lastSeq = f.seq;
    }

    switch (f.type) {
      case 'chunk':
        if (!assistantEl) assistantEl = addMsg('assistant', '');
        assistantEl.textContent += f.content || '';
        scroll();
        break;
      case 'status':
        setStatus(f.status || '');
        break;
      case 'tool_start': {
        clearEmpty();
        const row = document.createElement('details');
        row.className = 'toolrow';
        const sum = document.createElement('summary');
        sum.textContent = `${f.tool || 'tool'}${f.server ? ' · ' + f.server : ''} …`;
        row.appendChild(sum);
        log.appendChild(row);
        if (f.toolId) toolRows.set(f.toolId, row);
        scroll();
        break;
      }
      case 'tool_end': {
        const row = f.toolId && toolRows.get(f.toolId);
        if (row) {
          const secs = f.executionTime ? (f.executionTime / 1000).toFixed(1) + 's · ' : '';
          row.querySelector('summary').textContent =
            `${f.tool || 'tool'}${f.server ? ' · ' + f.server : ''} · ${secs}${f.success === false ? '✗' : '✓'}`;
          const pre = document.createElement('pre');
          pre.textContent = String(f.result || '').slice(0, 2000);
          row.appendChild(pre);
        }
        break;
      }
      case 'error':
        setStatus('✗ ' + (f.message || 'error'));
        endTurn();
        break;
      // COHERENCE F30 — the server has always emitted a complete receipt
      // (memories, tools, skills, degraded) as its own frame just before `done`.
      // This client never handled it, so the footer could only report what `done`
      // happened to carry — memories, model, tokens — and the same turn described
      // itself differently here than in the extension panel. Stash it and fold it
      // into the footer, using the panel's exact wording so the two agree.
      case 'turn_receipt':
        turnReceipt = f.receipt || turnReceipt;
        break;
      case 'usage':
        turnUsage = f.usage || turnUsage;
        break;
      case 'done': {
        if (f.activeModel) chipModel.textContent = f.activeModel;
        setStatus(chipModel.textContent || 'ready');
        // Cards were a preview of the turn's context; the answer has landed —
        // fold them away so the reply is the record.
        if (cardsEl) { cardsEl.remove(); cardsEl = null; }
        // Provenance footer (§4.3, §4.5.8): what the turn used, quietly.
        const u = f.usage || turnUsage;
        const bits = [];
        bits.push(...usedBits(f.receipt || turnReceipt, f.memory));
        if (f.activeModel) bits.push(f.activeModel);
        const tin = u && (u.input_tokens ?? u.prompt_tokens);
        const tout = u && (u.output_tokens ?? u.completion_tokens);
        if (tin != null || tout != null) bits.push(`${tin ?? '?'}→${tout ?? '?'} tok`);
        if (bits.length && assistantEl) {
          const p = document.createElement('div');
          p.className = 'provenance';
          p.textContent = bits.join(' · ');
          const rcp = f.receipt || turnReceipt;
          const lanes = (rcp && Array.isArray(rcp.lanes)) ? rcp.lanes : [];
          if (lanes.length) p.title = 'Context:\n' + lanes.filter((l) => l && l.lane).map((l) => `${l.lane.replace(/_/g, ' ')} · ${l.state || 'ran'}${l.chars ? ` · ${l.chars} chars` : ''}${l.evicted_tok ? ` · ${l.evicted_tok} tok evicted` : ''}`).join('\n');
          log.appendChild(p);
          scroll();
        }
        turnUsage = null;
        turnReceipt = null;
        endTurn();
        break;
      }
      default:
        break; // thinking_*, conversations_list … — not rendered in V1
    }
  });

  function renderApproval(f) {
    clearEmpty();
    const row = document.createElement('div');
    row.className = 'approval';
    row.textContent = `Approve running ${f.tool || 'this tool'}?`;
    const actions = document.createElement('div');
    actions.className = 'approval-actions';
    const yes = document.createElement('button');
    yes.className = 'approve';
    yes.textContent = 'Approve';
    const no = document.createElement('button');
    no.textContent = 'Deny';
    const decide = (decision) => async () => {
      yes.disabled = no.disabled = true;
      const ok = await transport.approve(convId, f.token, decision);
      row.remove();
      if (!ok) setStatus('approval failed — try again');
    };
    yes.onclick = decide('approve');
    no.onclick = decide('deny');
    actions.append(yes, no);
    row.appendChild(actions);
    log.appendChild(row);
    scroll();
  }

  // ── Staged answer (§4.5.1): cards paint fast, stream lands beneath ────────
  async function paintCards(query) {
    const chunks = await transport.fastRecall(query);
    if (!chunks.length || !turnOpen) return; // empty fast lane is fine (0.72 floor)
    cardsEl = document.createElement('div');
    cardsEl.className = 'cards';
    for (const c of chunks) {
      const card = document.createElement('div');
      card.className = 'card';
      card.textContent = c.text;
      cardsEl.appendChild(card);
    }
    // Cards sit above the (not-yet-started) assistant bubble.
    log.insertBefore(cardsEl, assistantEl || null);
    scroll();
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  async function send() {
    const text = input.value.trim();
    if (!text || turnOpen) return;
    // Page lane (§6.1): read the page ONLY if Use is armed, only at send time.
    // The text rides in a separate field — the gateway fences it for the model
    // and never persists it (src/page-context.ts).
    let pageContext = null;
    if (ui.pageUseArmed && ui.pageUseArmed()) {
      const page = await transport.pageRead();
      if (page && page.text) {
        pageContext = { url: page.url, title: page.title, text: page.text };
      } else {
        setStatus('couldn’t read this page — sending without it');
      }
    }
    const msg = { type: 'message', content: text, conversationId: convId };
    if (pageContext) msg.pageContext = pageContext;
    if (!transport.send(msg)) {
      // COHERENCE F18 — this used to say "Start it from the menu bar." There
      // is no menu bar: no NSStatusItem, no tray, nothing in the tree (every
      // "menubar" in this repo is the web console's own CSS shell element). A
      // user whose app had stopped was told to do something impossible, in the
      // exact moment they are deciding whether to trust the product. The
      // wording now matches what the CLI says for the same condition, and says
      // the true thing about reconnection (transport.js schedules its own
      // retry, so the page really does come back on its own).
      setStatus('Vodou isn’t running — start it with ./start-vodou-services.sh. This page reconnects on its own.');
      return;
    }
    addMsg('user', text);
    input.value = '';
    input.style.height = 'auto';
    startTurn();
    setStatus(pageContext ? 'reading page + thinking…' : 'thinking…');
    paintCards(text); // fire-and-forget; the stream does not wait for it
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(140, input.scrollHeight) + 'px';
  });
  stopBtn.addEventListener('click', () => {
    transport.send({ type: 'stop', conversationId: convId });
    endTurn();
  });

  showEmpty();

  return {
    newConversation() {
      convId = 'two:' + Date.now().toString(36);
      localStorage.setItem('two_conversation', convId);
      lastSeq = 0;
      for (const el of log.querySelectorAll('.msg, .toolrow, .cards, .approval')) el.remove();
      showEmpty();
      transport.send({ type: 'switch_conversation', conversationId: convId });
      setStatus('new chat');
    },
  };
}
