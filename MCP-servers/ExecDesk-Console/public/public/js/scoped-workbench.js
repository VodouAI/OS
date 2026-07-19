/**
 * ScopedWorkbench — reusable per-scope chat surface.
 *
 * Mount one into any container; it handles conversation ensure, history
 * rehydration, WS streaming via WsBus, tool-rail clicks, and composer input.
 *
 * Rendering delegates to the global `ChatView` so the workbench chat is
 * pixel-identical to the main `#/chat` surface: same markdown pipeline,
 * same avatars, same action bar, same link previews, same mermaid. When
 * ChatView isn't available (shouldn't happen in practice — load order
 * guarantees it), we fall back to a simple renderer so the workbench
 * still works, just plainer.
 *
 * Usage:
 *   const wb = await ScopedWorkbench.mount({
 *     mount: document.getElementById('my-panel'),
 *     scopeDescriptor: await ScopeRegistry.resolve('workbench:integration:linear'),
 *     prefill: 'optional initial composer text',
 *     chromeless: true,
 *   });
 */
const ScopedWorkbench = (() => {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
    );
  }
  function attr(s) { return esc(s); }

  /**
   * Return the live ChatView, or null if it hasn't initialized yet.
   *
   * NOTE: ChatView is declared `const ChatView = {...}` at script-top (see
   * chat.js:29). `const` declarations are NOT added to `window`, but they ARE
   * in the shared script global lexical scope — so we can reference `ChatView`
   * directly by name. The earlier check against `window.ChatView` always
   * returned null, which is why the workbench was silently falling back to
   * its plain renderer (no names / no avatars).
   */
  function cv() {
    try {
      return typeof ChatView !== 'undefined' ? ChatView : null;
    } catch (_) {
      return null;
    }
  }

  /** Markdown: prefer ChatView's full pipeline; fall back to smartRender; then minimal. */
  function renderMarkdown(text) {
    const c = cv();
    if (c && typeof c.renderMarkdown === 'function') {
      try { return c.renderMarkdown(text); } catch (_) {}
    }
    if (typeof window.smartRender === 'function') {
      try { return window.smartRender(text); } catch (_) {}
    }
    return esc(text).replace(/\n/g, '<br>');
  }

  // Render the empty-state area for a scope. Priority order:
  //   1. mountEmptyState callback — adapter renders directly (used by the
  //      Integration adapter to drop in the full setup/management panel from
  //      window._integrationUi.renderSetupPanel so the user can view + edit
  //      every field and connect/disconnect/test inline).
  //   2. emptyStateHtml — static HTML; we wire [data-action] buttons to the
  //      Apps view's handlers as a fallback.
  //   3. emptyStateHint — plain text.
  function renderEmptyState(body, s) {
    if (typeof s.mountEmptyState === 'function') {
      const wrap = document.createElement('div');
      wrap.className = 'sw-empty-rich';
      body.appendChild(wrap);
      try {
        s.mountEmptyState(wrap);
      } catch (err) {
        console.error('[ScopedWorkbench] mountEmptyState failed:', err);
        wrap.innerHTML = `<div class="sw-empty-hint">Setup panel failed to load.</div>`;
      }
      return;
    }
    if (s.emptyStateHtml) {
      const wrap = document.createElement('div');
      wrap.className = 'sw-empty-rich';
      wrap.innerHTML = s.emptyStateHtml;
      body.appendChild(wrap);
      const ui = window._integrationUi;
      if (ui) {
        wrap.querySelectorAll('[data-action="connect"]').forEach((btn) => {
          btn.addEventListener('click', () => ui.connectProvider?.(btn.dataset.provider));
        });
        wrap.querySelectorAll('[data-action="open-modal"]').forEach((btn) => {
          btn.addEventListener('click', () => ui.openProviderModal?.(btn.dataset.provider));
        });
      }
      return;
    }
    if (s.emptyStateHint) {
      const hint = document.createElement('div');
      hint.className = 'sw-empty-hint';
      hint.textContent = s.emptyStateHint;
      body.appendChild(hint);
    }
  }

  function scrollToBottom(body) {
    requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
  }

  function removeEmptyHint(body) {
    const hint = body.querySelector('.sw-empty-hint');
    if (hint) hint.remove();
  }

  /**
   * Append a message via ChatView.createMsgEl (full parity with main chat).
   * Falls back to a minimal bubble if ChatView isn't loaded.
   *
   * @param {HTMLElement} body — the .sw-body container
   * @param {'user'|'assistant'} role
   * @param {string} textOrHtml — raw text for user, markdown-rendered HTML for assistant
   * @param {string} [timestamp]
   * @returns {{msg: HTMLElement, content: HTMLElement}|null}
   */
  function appendMessage(body, role, textOrHtml, timestamp) {
    removeEmptyHint(body);
    const c = cv();

    if (c && typeof c.createMsgEl === 'function') {
      // ChatView's renderer — identical to main chat
      let el;
      if (role === 'user') {
        const userAv = c._userAvatar || (c._userName ? c._userName.charAt(0).toUpperCase() : 'U');
        const escaped = String(textOrHtml).replace(/[&<>"]/g, (ch) =>
          ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])
        );
        el = c.createMsgEl(
          c._userName || 'You',
          'user-name',
          'user-av',
          userAv,
          escaped,
          '',
          timestamp || new Date().toISOString()
        );
      } else {
        el = c.createMsgEl(
          c._aiName || 'Vodou',
          'assistant-name',
          'assistant-av',
          c._aiEmoji || '',
          textOrHtml,
          '',
          timestamp || new Date().toISOString(),
          c._aiAvatarColor || undefined
        );
      }
      body.appendChild(el.msg);
      // Mermaid + link previews (mirrors chat.js:2933-2934)
      if (typeof c._renderMermaids === 'function') { try { c._renderMermaids(); } catch (_) {} }
      if (role === 'assistant' && typeof c._renderLinkPreviews === 'function') {
        try { c._renderLinkPreviews(el.content); } catch (_) {}
      }
      scrollToBottom(body);
      return el;
    }

    // Fallback: minimal bubble (ChatView missing)
    const msg = document.createElement('div');
    msg.className = 'message';
    msg.dataset.role = role;
    const content = document.createElement('div');
    content.className = 'msg-content';
    content.innerHTML = role === 'user'
      ? esc(textOrHtml).replace(/\n/g, '<br>')
      : textOrHtml;
    msg.appendChild(content);
    body.appendChild(msg);
    scrollToBottom(body);
    return { msg, content };
  }

  /** Create an empty assistant shell for streaming chunks into. */
  function createAssistantShell(body) {
    return appendMessage(body, 'assistant', '', new Date().toISOString());
  }

  /** Append a raw chunk of text to a streaming assistant message. */
  function appendChunk(shell, chunk) {
    if (!shell || !shell.content) return;
    const el = shell.content;
    el._rawText = (el._rawText || '') + chunk;
    el.innerHTML = renderMarkdown(el._rawText);
  }

  /** Finalize a streaming message — re-render mermaid + link previews. */
  function finalizeStream(shell) {
    if (!shell || !shell.content) return;
    const c = cv();
    if (c && typeof c._renderMermaids === 'function') {
      try { c._renderMermaids(); } catch (_) {}
    }
    if (c && typeof c._renderLinkPreviews === 'function') {
      try { c._renderLinkPreviews(shell.content); } catch (_) {}
    }
  }

  /**
   * Rebind the Regenerate action button on every assistant message in the
   * body to call a workbench-local handler instead of ChatView.sendMessage
   * (which would route through the main chat's composer).
   *
   * @param {HTMLElement} body — the .sw-body container
   * @param {(text: string) => void} sendFn — workbench's own send path
   */
  function rebindRegenerateButtons(body, sendFn) {
    body.querySelectorAll('.msg-action-btn').forEach((btn) => {
      const inline = btn.getAttribute('onclick') || '';
      if (!inline.includes('_regenerateMessage') || btn._swRebound) return;
      btn._swRebound = true;
      btn.removeAttribute('onclick');
      btn.addEventListener('click', () => {
        const assistantMsg = btn.closest('.message');
        if (!assistantMsg) return;
        // Walk backwards to find the preceding user message text
        let prev = assistantMsg.previousElementSibling;
        while (prev) {
          if (prev.querySelector?.('.user-name')) {
            const text = prev.querySelector('.msg-content')?.innerText?.trim();
            if (text) { sendFn(text); return; }
          }
          prev = prev.previousElementSibling;
        }
      });
    });
  }

  /**
   * Update the header's memory pill from a `done` event's memory payload.
   * Mirrors ChatView._updateMemoryIndicator — same count logic, same text
   * format. Scoped to the workbench's own .sw-header.
   */
  function updateMemoryPill(state, memory) {
    const pill = state.root?.querySelector?.('.sw-memory-pill');
    if (!pill) return;
    if (!state.memoryUsedThisConv) state.memoryUsedThisConv = 0;
    if (!Array.isArray(state.memoryItems)) state.memoryItems = [];
    state.memoryUsedThisConv += (memory?.used || 0);
    // Accumulate items across turns to match the cumulative count above.
    // Previously this assigned `memory.items || state.memoryItems` which wiped
    // the list whenever a turn returned an empty array (`[] || x` → `[]`),
    // leaving a non-zero count with an empty list — the "4 used / nothing to
    // show" mismatch users were seeing.
    if (Array.isArray(memory?.items) && memory.items.length > 0) {
      for (const item of memory.items) {
        if (!state.memoryItems.includes(item)) state.memoryItems.push(item);
      }
    }
    const countEl = pill.querySelector('.sw-memory-count');
    if (countEl) countEl.textContent = state.memoryUsedThisConv.toLocaleString();
    if (state.memoryUsedThisConv > 0) {
      pill.classList.add('is-active');
    }
  }

  /**
   * Open a minimal Apple-style modal listing the memories this workbench
   * conversation has pulled in. Backdrop blur, spring scale-in, dismissed
   * on backdrop tap.
   */
  function openMemoryModal(state) {
    const existing = document.querySelector('.sw-memory-modal');
    if (existing) { existing.remove(); return; }

    const total = state.memoryUsedThisConv || 0;
    const items = state.memoryItems || [];

    const overlay = document.createElement('div');
    overlay.className = 'sw-memory-modal';
    overlay.innerHTML = `
      <div class="sw-memory-modal-content" role="dialog" aria-label="Memory usage">
        <div class="sw-memory-modal-header">
          <div class="sw-memory-modal-label">Memory</div>
          <div class="sw-memory-modal-title">${total} ${total === 1 ? 'memory' : 'memories'} used this conversation</div>
        </div>
        <div class="sw-memory-modal-body">
          ${items.length === 0
            ? '<div class="sw-memory-modal-empty">No specific memories recorded for this turn yet. Send a message to see what Vodou pulls in.</div>'
            : '<ul class="sw-memory-modal-list">' + items.map((it) =>
                `<li class="sw-memory-modal-item">${esc(String(it).replace(/^-\s*/, ''))}</li>`
              ).join('') + '</ul>'}
        </div>
        <div class="sw-memory-modal-footer">
          <button type="button" class="btn btn-sm sw-memory-modal-close">Close</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('.sw-memory-modal-close').addEventListener('click', close);
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
  }

  /* ---------------------------------------------------------------------- *
   *  Per-workbench UI chrome — typing dots, status phase pill, tool chips.
   *  These produce the exact same DOM structure as main chat's ChatView
   *  helpers so all the existing CSS (`.typing-indicator`, `.typing-dot`,
   *  `.chat-status-phase`, `.inline-tool-strip`, `.inline-tool-chip`)
   *  applies identically inside the workbench body.
   * ---------------------------------------------------------------------- */

  /** Append typing-dots placeholder bubble. Returns the shell for later removal. */
  function showTyping(state, body) {
    if (state.typingEl) return;
    const c = cv();
    if (!c || typeof c.createMsgEl !== 'function') return;
    const shell = c.createMsgEl(
      c._aiName || 'Vodou', 'assistant-name', 'assistant-av',
      c._aiEmoji || '', '', '', undefined, c._aiAvatarColor
    );
    shell.content.className = 'msg-content typing-indicator';
    shell.content.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
    body.appendChild(shell.msg);
    state.typingEl = shell.msg;
    scrollToBottom(body);
  }

  function removeTyping(state) {
    if (state.typingEl) { state.typingEl.remove(); state.typingEl = null; }
    removeStatusPhase(state);
  }

  /** Add/update a "Thinking..." / "Compacting..." status pill under the current bubble. */
  function showStatusPhase(state, body, status) {
    const parent = state.typingEl || (state.currentShell && state.currentShell.msg);
    if (!parent) return;
    let el = parent.querySelector('.chat-status-phase');
    if (!el) {
      el = document.createElement('div');
      el.className = 'chat-status-phase';
      const bodyEl = parent.querySelector('.msg-body') || parent;
      bodyEl.appendChild(el);
    }
    el.textContent = status;
    scrollToBottom(body);
  }

  function removeStatusPhase(state) {
    const root = state.root || document;
    root.querySelectorAll('.chat-status-phase').forEach((el) => el.remove());
  }

  /** Ensure an assistant message bubble exists to host tool chips + streaming text. */
  function ensureCurrentShell(state, body) {
    if (state.currentShell) return state.currentShell;
    state.currentShell = createAssistantShell(body);
    return state.currentShell;
  }

  /** Append a tool chip (name + live timer) inside the active assistant message.
   *  Uses shared ChatHelpers so DOM + CSS hooks match main chat exactly.
   *  Chip is wrapped so clicking expands a detail panel (server, args, result,
   *  time, status) — same behavior as main chat's inline pills. */
  function addToolChip(state, body, toolName, toolKey) {
    removeTyping(state);
    ensureCurrentShell(state, body);
    const shell = state.currentShell;
    if (!shell || !shell.msg) return;
    const msgBody = shell.content.parentElement;  // .msg-body
    const strip = ChatHelpers.getOrCreateToolStrip(msgBody, shell.content);
    const { chip } = ChatHelpers.createToolChip(toolName, toolKey);
    ChatHelpers.startChipTimer(chip);
    const wrap = ChatHelpers.wrapChipForExpand(
      chip,
      toolKey,
      () => state.toolData[toolKey] || {},
      state.root,
    );
    strip.appendChild(wrap);
    scrollToBottom(body);
  }

  /** Mark a tool chip as finished, stop its timer, write final execution time. */
  function finishToolChip(state, toolKey, executionTime) {
    const chip = ChatHelpers.findChipByKey(state.root || document, toolKey);
    ChatHelpers.stopChipTimer(chip, executionTime);
  }

  /** Rehydrate a single historical message from the server's `history` event. */
  function rehydrateMessage(body, m) {
    if (m.role === 'user') {
      appendMessage(body, 'user', m.text, m.timestamp);
    } else if (m.role === 'assistant') {
      appendMessage(body, 'assistant', renderMarkdown(m.text || ''), m.timestamp);
    }
  }

  async function mount(opts) {
    const { mount: parent, scopeDescriptor: s, prefill, chromeless = false } = opts || {};
    if (!parent || !s || !s.raw) {
      throw new Error('ScopedWorkbench.mount requires { mount, scopeDescriptor }');
    }

    // 1. Ensure conversation exists server-side (idempotent).
    try {
      await fetch('/api/workbench/ensure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: s.raw, title: s.displayName }),
      });
    } catch (err) {
      console.error('[ScopedWorkbench] ensure failed:', err);
    }

    const conversationId = s.raw;

    // 2. Build DOM — header + tool rail + body + composer.
    //    Body uses #chat-messages-like class so main chat's .message CSS
    //    applies directly; composer mirrors main chat's input structure
    //    so the same styling rules hit it.
    const root = document.createElement('div');
    root.className = 'scoped-workbench' + (chromeless ? ' scoped-workbench--chromeless' : '');

    // Connection dot + Manage link for integration scopes. Click opens a
    // modal wrapping the same renderSetupPanel that the empty-chat surface
    // uses, so connected + not-connected share one piece of UI.
    const conn = s.connection || null;
    let dotClass = '';
    let dotTitle = '';
    if (s.scopeType === 'integration' && conn) {
      const healthy = conn.connected && !conn.expired && !conn.blocked && conn.mcpEnabled && conn.mcpHealth === 'healthy';
      dotClass = healthy ? 'ok'
        : (conn.expired || conn.blocked || conn.mcpHealth === 'unhealthy') ? 'warn'
        : conn.connected ? 'idle'
        : 'off';
      dotTitle = conn.blocked ? 'Blocked'
        : !conn.connected ? 'Not connected'
        : conn.expired ? 'Expired'
        : !conn.mcpEnabled ? 'Connected · MCP off'
        : conn.mcpHealth === 'unhealthy' ? 'Connected · MCP error'
        : healthy ? 'Connected · healthy'
        : 'Connected';
    }
    const dotHtml = (s.scopeType === 'integration' && conn)
      ? `<span class="sw-conn-dot sw-conn-dot-${dotClass}" title="${attr(dotTitle)}"></span>`
      : '';
    // Manage button only for CONNECTED app scopes. Unconnected servers
    // already surface the same setup panel in their empty-chat state, so a
    // separate Manage toggle would be redundant.
    const manageBtnHtml = (s.scopeType === 'integration' && conn && conn.connected)
      ? `<button type="button" class="sw-manage-btn" data-sw-manage="${attr(s.scopeId)}" title="Manage connection">Manage</button>`
      : '';

    root.innerHTML = `
      <div class="sw-header">
        <div class="sw-header-icon">${s.iconHtml || ''}</div>
        <div class="sw-header-text">
          <div class="sw-title">${dotHtml}${esc(s.displayName)}${manageBtnHtml}</div>
          <div class="sw-subtitle">
            <span class="sw-scope-badge sw-scope-badge-${esc(s.scopeType)}">${esc(s.scopeType)}</span>
            <span class="sw-tool-count">${s.toolRail.length} tool${s.toolRail.length === 1 ? '' : 's'}</span>
          </div>
        </div>
        <button type="button" class="sw-pin-btn" title="Show this chat as a tab in the main Chat view" aria-label="Surface to main chat">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>
        </button>
        <button type="button" class="sw-memory-pill" title="Memories used this conversation" aria-label="Memory usage">
          <span class="sw-memory-icon">\u{1F9E0}</span>
          <span class="sw-memory-count">0</span>
        </button>
      </div>
      <div class="sw-tool-rail">
        ${s.toolRail.length
          ? s.toolRail.map((t) => `
              <button type="button" class="sheet-tool-chip sw-tool-chip"
                      data-prefill="${attr(t.prefill || '')}"
                      title="${attr(t.description || '')}">
                ${esc(t.name)}
              </button>
            `).join('')
          : '<div class="sw-tool-hint">No tools in this scope yet.</div>'}
      </div>
      <div class="sw-manage-pane is-hidden" aria-hidden="true"></div>
      <div class="sw-body" role="log" aria-live="polite"></div>
      <div class="sw-file-preview-area is-hidden"></div>
      <div class="sw-composer-wrap">
        <div class="sw-ac-dropdown autocomplete-dropdown"></div>
        <div class="sw-composer-slot"></div>
      </div>
      <div class="sw-drop-overlay">
        <div class="sw-drop-overlay-inner">Drop file to attach to ${esc(s.displayName)}</div>
      </div>
    `;
    parent.innerHTML = '';
    parent.appendChild(root);

    // Auto-surface integration + skill workbenches to the global Chat "Apps" tab
    // row (WorkbenchSurfaces). Pin still toggles removal; without this, users
    // who only open #/apps?…&mode=chat never see a tab unless they discover pin.
    try {
      if (typeof WorkbenchSurfaces !== 'undefined' && (s.scopeType === 'integration' || s.scopeType === 'skill')) {
        if (!WorkbenchSurfaces.has(conversationId)) {
          WorkbenchSurfaces.add({
            scope: conversationId,
            title: s.displayName || s.scopeId || conversationId,
            icon: s.iconHtml || '',
          });
        }
      }
    } catch (e) {
      console.warn('[ScopedWorkbench] auto-surface skipped:', e);
    }

    const body = root.querySelector('.sw-body');
    const composerSlot = root.querySelector('.sw-composer-slot');
    const filePreviewArea = root.querySelector('.sw-file-preview-area');
    const dropOverlay = root.querySelector('.sw-drop-overlay');
    const acDropdown = root.querySelector('.sw-ac-dropdown');

    // 3. Subscribe to WS stream for this conversation.
    //    Per-workbench state — isolated from ChatView's own state so the main
    //    chat and this workbench can stream simultaneously without collision.
    const state = {
      root,                    // scope DOM queries to this workbench
      typingEl: null,
      currentShell: null,
      toolData: {},            // toolKey → { tool, startTime }
    };

    // 3a. Composer — built by shared ChatComposer. The onSend callback runs
    //     when the user hits Enter or clicks Send. We render the user message
    //     via ChatView's pipeline (appendMessage) so it lines up pixel-perfect
    //     with main chat bubbles, then send the text over WsBus scoped to
    //     this conversationId.
    const SVG_AC = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    const SVG_CLEAR = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/></svg>';

    const composer = ChatComposer.create({
      mount: composerSlot,
      placeholder: 'Message ' + s.displayName + '…',
      prefill: prefill || '',
      classes: { root: 'sw-composer', input: 'sw-input', send: 'sw-send' },
      actions: [
        {
          id: null,
          title: 'Toggle autocomplete suggestions',
          className: 'sw-ac-toggle ac-on',
          html: SVG_AC,
          onClick: (e) => {
            const btn = e.currentTarget;
            const on = !btn.classList.contains('ac-on');
            btn.classList.toggle('ac-on', on);
            localStorage.setItem('vodou-autocomplete', on ? 'on' : 'off');
            btn.title = on ? 'Autocomplete ON — click to disable'
                           : 'Autocomplete OFF — click to enable';
          },
        },
        {
          title: 'Clear conversation in this workbench',
          className: 'sw-clear',
          html: SVG_CLEAR,
          onClick: () => {
            if (!confirm('Clear this workbench conversation?')) return;
            body.innerHTML = '';
            WsBus.send({ type: 'clear', conversationId });
          },
        },
      ],
      shortcuts: [
        { label: '/server', prefill: '/server' },
        { label: '/skill',  prefill: '/skill' },
        { label: '↑↓' },
        { label: 'Tab' },
        { label: 'Shift+Enter' },
      ],
      onSend: async (content) => {
        // If a file was dropped, embed it into the text exactly like main chat
        const pending = fileDrop && fileDrop.getPending();
        if (pending) {
          content = ChatFileDrop.embedInText(pending, content);
          fileDrop.clear();
        }
        appendMessage(body, 'user', content);
        // Immediate visual feedback — typing dots before server streams.
        showTyping(state, body);
        showStopBtn();
        await WsBus.send({ type: 'message', content, conversationId });
      },
    });

    // 3a-stop. Stop button — inserted next to send while a turn is streaming,
    //          removed on `done`/`error`. Same protocol as main chat: emits
    //          `{ type: 'stop', conversationId }` via WsBus.
    let stopBtn = null;
    function showStopBtn() {
      if (stopBtn) return;
      stopBtn = document.createElement('button');
      stopBtn.type = 'button';
      stopBtn.className = 'chat-stop-btn sw-stop-btn';
      stopBtn.textContent = 'Stop';
      stopBtn.title = 'Stop generation';
      stopBtn.addEventListener('click', () => {
        WsBus.send({ type: 'stop', conversationId });
      });
      composer.sendButton.parentNode.insertBefore(stopBtn, composer.sendButton);
    }
    function hideStopBtn() {
      if (stopBtn) { stopBtn.remove(); stopBtn = null; }
    }

    // 3b. Drag-and-drop file handling — same module as main chat, so
    //     embedded text payload is identical. Server already accepts it.
    const fileDrop = (typeof ChatFileDrop !== 'undefined') ? ChatFileDrop.attach({
      container: root,
      overlay: dropOverlay,
      previewArea: filePreviewArea,
      input: composer.input,
      placeholder: 'Message ' + s.displayName + '…',
      systemMessage: (msg) => appendMessage(body, 'assistant', renderMarkdown(msg)),
    }) : null;

    // 3c. Autocomplete — factory instance scoped to this workbench's textarea.
    //     Suggestion cache is shared across all instances at the module level.
    const autocomplete = (typeof ChatAutocomplete !== 'undefined' && acDropdown)
      ? ChatAutocomplete.attach({ input: composer.input, dropdown: acDropdown })
      : null;

    const unsub = WsBus.subscribe(conversationId, (msg) => {
      switch (msg.type) {
        case 'history':
          if (Array.isArray(msg.messages)) {
            body.innerHTML = '';
            msg.messages.forEach((m) => rehydrateMessage(body, m));
            if (!body.children.length) {
              renderEmptyState(body, s);
            }
            rebindRegenerateButtons(body, (text) => {
              composer.setValue(text);
              composer.send();
            });
            scrollToBottom(body);
          }
          break;

        case 'status':
          // "Thinking...", "Compacting...", "Searching memory..." etc.
          showStatusPhase(state, body, msg.status || '');
          break;

        case 'tool_start': {
          // Inline tool chip with live timer — same DOM + classes as main chat
          const toolKey = msg.toolId || (msg.tool + '_' + Date.now());
          if (state.toolData[toolKey]) {
            // Chip already created — server sent follow-up with full args
            if (msg.args && Object.keys(msg.args).length > 0) {
              state.toolData[toolKey].args = msg.args;
            }
          } else {
            state.toolData[toolKey] = {
              tool: msg.tool,
              server: msg.server,
              args: msg.args,
              startTime: Date.now(),
            };
            addToolChip(state, body, msg.tool || 'tool', toolKey);
          }
          break;
        }

        case 'tool_end': {
          // Find the matching chip and finalize its timer
          const endKey = msg.toolId || Object.keys(state.toolData).reverse().find((k) =>
            state.toolData[k].tool === msg.tool && !state.toolData[k].result
          );
          if (endKey && state.toolData[endKey]) {
            state.toolData[endKey].result = msg.result;
            state.toolData[endKey].executionTime = msg.executionTime;
            state.toolData[endKey].success = msg.success;
            finishToolChip(state, endKey, msg.executionTime);
          }
          break;
        }

        case 'chunk':
          removeTyping(state);
          if (!state.currentShell) state.currentShell = createAssistantShell(body);
          appendChunk(state.currentShell, msg.content || '');
          scrollToBottom(body);
          break;

        case 'done':
        case 'stopped':
          removeTyping(state);
          finalizeStream(state.currentShell);
          state.currentShell = null;
          // NOTE: don't wipe state.toolData — chip expand reads from it
          // when the user clicks a past turn's pill. Entries are keyed by
          // toolId so new turns can't collide with old ones.
          composer.enable();
          hideStopBtn();
          // Memory indicator: same payload shape as main chat's `done` event
          if (msg.memory) updateMemoryPill(state, msg.memory);
          // Rebind Regenerate on any newly-appended assistant messages
          rebindRegenerateButtons(body, (text) => {
            composer.setValue(text);
            composer.send();
          });
          break;

        case 'error': {
          removeTyping(state);
          const errShell = createAssistantShell(body);
          if (errShell && errShell.msg) errShell.msg.classList.add('message-error');
          if (errShell && errShell.content) {
            errShell.content.innerHTML = renderMarkdown('**Error:** ' + (msg.message || 'Unknown error'));
          }
          state.currentShell = null;
          composer.enable();
          hideStopBtn();
          break;
        }

        default:
          break;
      }
    });

    // 4. Initial history load — tell the server to hydrate this conv.
    WsBus.send({ type: 'switch_conversation', conversationId });

    // 5. Show empty-state (rich HTML if provided — install steps for unconnected
    //    app scopes; plain hint otherwise) immediately while awaiting history.
    renderEmptyState(body, s);

    // 6a. Memory pill — click opens the memory modal
    const memPill = root.querySelector('.sw-memory-pill');
    if (memPill) {
      memPill.addEventListener('click', () => openMemoryModal(state));
    }

    // Manage-connection: toggles the .sw-manage-pane above the chat body.
    // Renders the same setup panel that unconnected servers get in their empty
    // state — one UI surface for both connect and manage flows.
    const manageBtn = root.querySelector('.sw-manage-btn');
    const managePane = root.querySelector('.sw-manage-pane');
    if (manageBtn && managePane) {
      manageBtn.addEventListener('click', () => {
        const ui = window._integrationUi;
        if (!ui || typeof ui.renderSetupPanel !== 'function') {
          console.error('[ScopedWorkbench] _integrationUi.renderSetupPanel unavailable');
          return;
        }
        const open = managePane.classList.toggle('is-hidden') === false;
        managePane.setAttribute('aria-hidden', open ? 'false' : 'true');
        manageBtn.classList.toggle('is-active', open);
        manageBtn.textContent = open ? 'Close' : 'Manage';
        if (open) {
          managePane.innerHTML = '';
          ui.renderSetupPanel(manageBtn.dataset.swManage, managePane);
        }
      });
    }

    // 6b. Pin button — surfaces this workbench into the main chat tab strip
    //     via WorkbenchSurfaces (localStorage). Toggle state reflected by
    //     `.is-pinned` class so CSS can tint the icon.
    const pinBtn = root.querySelector('.sw-pin-btn');
    let surfaceUnsub = null;
    if (pinBtn && typeof WorkbenchSurfaces !== 'undefined') {
      const syncPinned = () => {
        const on = WorkbenchSurfaces.has(conversationId);
        pinBtn.classList.toggle('is-pinned', on);
        pinBtn.title = on
          ? 'Remove from main Chat tabs'
          : 'Show this chat as a tab in the main Chat view';
      };
      syncPinned();
      pinBtn.addEventListener('click', () => {
        WorkbenchSurfaces.toggle({
          scope: conversationId,
          title: s.displayName,
          icon: s.iconHtml || '',
        });
        syncPinned();
      });
      surfaceUnsub = WorkbenchSurfaces.onChange(syncPinned);
    }

    // 6. Tool chip prefill — click prefills the composer and focuses it
    root.querySelectorAll('.sw-tool-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        composer.setValue(chip.dataset.prefill || '');
        composer.focus();
        const el = composer.input;
        el.selectionStart = el.selectionEnd = el.value.length;
      });
    });

    // 7. Initial focus (prefill cursor positioning handled inside ChatComposer)
    if (!prefill) composer.focus();

    return {
      unmount: () => {
        unsub();
        if (fileDrop) fileDrop.destroy();
        if (autocomplete) autocomplete.destroy();
        if (surfaceUnsub) surfaceUnsub();
        composer.destroy();
        parent.innerHTML = '';
      },
      focus: () => composer.focus(),
      conversationId,
    };
  }

  return { mount };
})();

window.ScopedWorkbench = ScopedWorkbench;
