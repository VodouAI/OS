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

  function showEmpty() {
    if (log.childElementCount) return;
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'Ask anything. I have your memory, your apps, and this page if you want it.';
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
        if (f.memory && f.memory.used) bits.push(`${f.memory.used} ${f.memory.used === 1 ? 'memory' : 'memories'}`);
        if (f.activeModel) bits.push(f.activeModel);
        const tin = u && (u.input_tokens ?? u.prompt_tokens);
        const tout = u && (u.output_tokens ?? u.completion_tokens);
        if (tin != null || tout != null) bits.push(`${tin ?? '?'}→${tout ?? '?'} tok`);
        if (bits.length && assistantEl) {
          const p = document.createElement('div');
          p.className = 'provenance';
          p.textContent = bits.join(' · ');
          log.appendChild(p);
          scroll();
        }
        turnUsage = null;
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
      setStatus('Vodou isn’t running. Start it from the menu bar.');
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
