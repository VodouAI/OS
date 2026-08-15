/**
 * Chat View — WebSocket streaming chat with Vodou
 * Phase 1: Clickable commands, stopping point buttons, code block actions
 */
// chat.js cache-debug stamp — bump alongside index.html ?v=NN.
// Visible in DevTools console at page load — use to confirm which build
// the browser actually fetched (vs. a cached old copy).
console.log('[chat.js] loaded — v=56 (2026-06-07, lens-fence entity-decode fix)');

// Mermaid is loaded on-demand (first diagram render) to keep the ~2.8 MB
// bundle off cold boots for pages that never render diagrams.
async function ensureMermaid() {
  if (window.mermaid) return window.mermaid;
  await lazyScript('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js');
  window.mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    themeVariables: {
      primaryColor: '#2563EB',
      primaryTextColor: '#e2e8f0',
      primaryBorderColor: '#818cf8',
      lineColor: '#94a3b8',
      secondaryColor: '#1e293b',
      tertiaryColor: '#0f172a',
      fontFamily: 'inherit',
    },
    securityLevel: 'loose',
    suppressErrorRendering: true,
  });
  return window.mermaid;
}

const ChatView = {
  ws: null,
  currentMessage: null,
  typingEl: null,
  toolRow: null,
  initialized: false,
  _toolData: {},
  _historyPanel: null,
  _userName: 'You',
  _userAvatar: '',
  _aiName: 'VODOU',
  _aiEmoji: '/icons/vodou-icon.png',
  _aiAvatarColor: '#6B7280',

  /**
   * Initialize chat (called once on page load)
   */
  init() {
    if (this.initialized) return;
    this.initialized = true;

    // Stop the browser from restoring the previous scroll position on reload.
    // Native scroll-restoration fires before our history hydrate, so the page
    // would land mid-conversation and then our snap-to-bottom would visibly
    // jump. 'manual' means WE own scroll position — _scrollToBottomAfterLayout
    // is the single source of truth.
    try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch { /* older browser */ }

    this.messagesEl = document.getElementById('chat-messages');
    // The CSS sets `scroll-behavior: smooth` on #chat-messages, which makes
    // every programmatic `scrollTop = …` animate over ~300ms. That's the
    // "it loads and scrolls" the user saw on tab/page load: our snap-to-bottom
    // animated into view instead of being instant. Force instant scrolling
    // for all JS-driven scrolls by overriding the property inline. User-driven
    // wheel/trackpad scrolling is unaffected by this property.
    if (this.messagesEl) this.messagesEl.style.scrollBehavior = 'auto';

    // Stick-to-bottom intent: load/send snap to the bottom, but the moment the
    // user scrolls away from it we stop auto-snapping so they can read history;
    // we re-stick when they return to the bottom. Guards scrollToBottom() and
    // _scrollToBottomAfterLayout() — fixes "scroll up keeps yanking to bottom".
    this._stickToBottom = true;
    if (this.messagesEl) {
      this.messagesEl.addEventListener('scroll', () => {
        const el = this.messagesEl;
        const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        this._stickToBottom = distFromBottom < 40; // within 40px of bottom = stuck
        this._schedulePinnedPromptUpdate();
      }, { passive: true });
    }

    this.input = document.getElementById('chat-input');
    this.sendBtn = document.getElementById('chat-send');
    this.clearBtn = document.getElementById('chat-clear');
    this.statusEl = document.getElementById('ws-status');
    this.statusText = document.getElementById('ws-status-text');

    // Auto-resize + Enter-to-send + send-click wired via shared ChatComposer.
    // Keeps existing textarea/button DOM + IDs intact (voice/autocomplete/
    // shortcut-footer all reference `chat-input` directly).
    this._composer = ChatComposer.adopt({
      input: this.input,
      send: this.sendBtn,
      shouldSend: () => {
        // Suppress send when autocomplete has an active suggestion
        if (typeof ChatAutocomplete !== 'undefined' &&
            ChatAutocomplete._visible && ChatAutocomplete._activeIdx >= 0) {
          return false;
        }
        if (typeof ChatAutocomplete !== 'undefined') ChatAutocomplete._hide();
        return true;
      },
      onSend: () => this.sendMessage(),
    });
    this.clearBtn.addEventListener('click', () => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'clear' }));
        this.messagesEl.innerHTML = '';
      }
    });

    this.sendBtn.disabled = true;

    // Footer shortcut kbd clicks
    document.querySelectorAll('[data-shortcut]').forEach(kbd => {
      // preventDefault on mousedown keeps input focused (no blur before click fires)
      kbd.addEventListener('mousedown', (e) => e.preventDefault());
      kbd.addEventListener('click', (e) => {
        // stopPropagation so the document-level autocomplete hide listener doesn't fire
        e.stopPropagation();
        const action = kbd.dataset.shortcut;
        if (action === 'cmdk') {
          if (typeof CommandPalette !== 'undefined') CommandPalette.open();
        } else {
          this.input.value = action + ' ';
          this.input.focus();
          this.input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
    });

    // Auto-speak toggle — only visible when voice channel is available
    this._autoSpeak = localStorage.getItem('vodou-auto-speak') === 'true';
    this._speakToggle = document.getElementById('speak-toggle');
    if (this._speakToggle) {
      if (this._autoSpeak) this._speakToggle.classList.add('active');
      this._speakToggle.addEventListener('click', () => {
        this._autoSpeak = !this._autoSpeak;
        this._speakToggle.classList.toggle('active', this._autoSpeak);
        localStorage.setItem('vodou-auto-speak', this._autoSpeak ? 'true' : 'false');
        if (this._autoSpeak) {
          this._setVoiceState('idle');
        } else {
          // Stop speech and mic immediately when toggling off
          fetch('/api/channels/voice/stop', { method: 'POST' }).catch(() => {});
          if (this._isRecording) this._stopVoice();
          this._setVoiceState(null);
        }
      });
    }
    this._streamedText = '';

    // Fetch identity names from config
    fetch('/api/identity').then(r => r.ok ? r.json() : null).then(id => {
      if (id) {
        this._userName = id.userName || 'You';
        this._userAvatar = id.userAvatar || '';
        this._aiName = id.aiName || 'VODOU';
        // Dual-mode avatar: prefer uploaded image, fall back to emoji, finally
        // the bundled VODOU icon so fresh installs always show branding.
        this._aiEmoji = id.aiAvatar || id.aiEmoji || '/icons/vodou-icon.png';
        this._aiAvatarColor = id.aiAvatarColor || '#6B7280';
      }
    }).catch(() => {});

    this.connect();

    if (typeof ChatAutocomplete !== 'undefined') ChatAutocomplete.init();
    if (typeof CommandPalette !== 'undefined') CommandPalette.init();

    // Drag & drop file support — delegated to shared ChatFileDrop module
    this._currentProvider = 'none';
    this._fetchProvider();
    this._fileDrop = ChatFileDrop.attach({
      container: document.getElementById('chat-container'),
      overlay: document.getElementById('drop-overlay'),
      previewArea: document.getElementById('file-preview-area'),
      input: this.input,
      placeholder: 'Message Vodou...',
      getFileWarning: (cat) => this._getFileWarning(cat),
      toast: (msg, level) => Components.toast(msg, level),
      systemMessage: (msg) => this.addMessage(msg, 'system'),
      onInlineImage: (path) => this._showInlineImage(path, 'dropped', ''),
    });

    // Voice input
    this._initVoice();

    // Chat tabs
    this._initTabs();

    const navAutoSkill = document.getElementById('nav-automated-skill');
    if (navAutoSkill && !navAutoSkill.dataset.scwBound) {
      navAutoSkill.dataset.scwBound = '1';
      navAutoSkill.addEventListener('click', () => {
        if (location.hash.split('?')[0] !== '#/chat') {
          window.location.hash = '#/chat';
          setTimeout(() => this._openNewSkillConsoleWizard(), 30);
        } else {
          this._openNewSkillConsoleWizard();
        }
      });
    }

    // Left-nav channel integration: clicking a channel in the sidebar lands
    // the user at #/chat?channel=<type>. On hashchange (or initial load),
    // find the workbench:channel:<type> tab and switch to it so the main
    // chat view shows that channel's unified conversation.
    window.addEventListener('hashchange', () => this._maybeHandleChannelRoute());
    // Also fire once on init in case the page loaded directly at #/chat?channel=X.
    setTimeout(() => this._maybeHandleChannelRoute(), 0);
    // PLAN-GATEWAY-PROJECTS — render the active-project switcher chip.
    setTimeout(() => this._renderProjectSwitcher(), 0);
    // The switcher reads _projectsCache, which was fetched once and never
    // invalidated — so a project created on #/projects did not appear in this
    // menu until a full reload. Manage projects → add one → come back → it's
    // missing is a bug report waiting to happen.
    //
    // Deliberately a DIFFERENT event from 'project:changed'. That one means
    // "the ACTIVE project changed, re-scope yourself" and skills.js/scheduler.js
    // listen for it to re-filter. This one means "the SET of projects changed,
    // anyone holding a list should drop it" — overloading the first would make
    // those two re-filter for no reason and blur what either event means.
    window.addEventListener('project:list-changed', () => {
      this._projectsCache = null;
      this._renderProjectSwitcher();
    });
    // PLAN-CLAUDE-RECONNECT-BANNER — show a banner if the Claude CLI is signed out.
    setTimeout(() => this._checkClaudeAuthBanner(), 800);
    this._claudeAuthPoll = setInterval(() => this._checkClaudeAuthBanner(), 30000);
  },

  /** Poll the gateway for Claude CLI auth state; show/hide the Reconnect banner. */
  async _checkClaudeAuthBanner() {
    try {
      const r = await fetch('/api/claude-auth/status');
      if (!r.ok) return;
      const s = await r.json();
      if (s.provider === 'claude-cli' && s.ok === false) this._renderClaudeAuthBanner(s.message);
      else this._removeClaudeAuthBanner();
    } catch (_) { /* best-effort */ }
  },

  _removeClaudeAuthBanner() {
    document.getElementById('claude-auth-banner')?.remove();
  },

  _renderClaudeAuthBanner(message) {
    if (document.getElementById('claude-auth-banner')) return; // already shown
    const host = document.getElementById('chat-container');
    if (!host) return;
    const bar = document.createElement('div');
    bar.id = 'claude-auth-banner';
    bar.className = 'claude-auth-banner';
    const text = document.createElement('span');
    text.className = 'claude-auth-banner-text';
    text.textContent = '🔑 Claude CLI is signed out — chat can’t run until you reconnect.';
    if (message) text.title = message;
    const reconnect = document.createElement('button');
    reconnect.type = 'button';
    reconnect.className = 'btn btn-primary btn-sm';
    reconnect.textContent = 'Reconnect';
    reconnect.title = 'Open the in-app terminal and start Claude so you can run /login';
    reconnect.onclick = () => {
      // Hand the terminal a command to auto-run once its PTY is ready.
      try { sessionStorage.setItem('vodou.terminalAutoRun', 'claude'); } catch (_) {}
      location.hash = '#/terminal';
    };
    const settings = document.createElement('button');
    settings.type = 'button';
    settings.className = 'btn btn-sm';
    settings.textContent = 'Switch provider';
    settings.onclick = () => { location.hash = '#/settings'; };
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'claude-auth-banner-x';
    dismiss.textContent = '✕';
    dismiss.title = 'Dismiss (reappears on the next failed turn)';
    dismiss.onclick = () => this._removeClaudeAuthBanner();
    bar.append(text, reconnect, settings, dismiss);
    host.insertBefore(bar, host.firstChild);
  },

  _maybeHandleChannelRoute() {
    const hash = location.hash || '';
    const pathOnly = hash.split('?')[0];
    if (pathOnly !== '#/chat') return;
    const qs = hash.indexOf('?') >= 0 ? hash.slice(hash.indexOf('?') + 1) : '';
    const params = new URLSearchParams(qs);
    // PLAN-GATEWAY-PROJECTS — #/chat?project=<id> sets the active project.
    const project = params.get('project');
    if (project) this._setActiveProjectId(project);
    const channel = params.get('channel');
    if (channel) { this._switchToChannelTab(channel); return; }
    const boardTask = params.get('board');
    if (boardTask) this._switchToBoardTask(boardTask);
  },

  // ─────────── PLAN-GATEWAY-PROJECTS — active project + switcher chip ───────────
  _getActiveProjectId() {
    if (!this._activeProjectId) {
      this._activeProjectId = localStorage.getItem('vodou.activeProject') || 'proj_default';
    }
    return this._activeProjectId;
  },

  _setActiveProjectId(id) {
    this._activeProjectId = id || 'proj_default';
    try { localStorage.setItem('vodou.activeProject', this._activeProjectId); } catch (_) {}
    this._renderProjectSwitcher();
    // Re-scope the dock tab strip to the new project, landing on one of its tabs.
    this._reconcileActiveProjectTabs();
    // Tell the rest of the dock (skills sidebar, scheduler filter) to re-filter.
    try { window.dispatchEvent(new CustomEvent('project:changed', { detail: { id: this._activeProjectId } })); } catch (_) {}
  },

  /** After a project switch, re-render the (now project-filtered) tab strip and
   *  make sure the active tab belongs to the new project — switch to its first
   *  chat, or open a fresh one if the project has none yet. Heartbeat/Board are
   *  global and never count as "the project's chat". */
  _reconcileActiveProjectTabs() {
    if (!Array.isArray(this._tabs)) return;
    this._renderTabs();
    const active = this._getActiveProjectId();
    const isGlobalSystemTab = (t) =>
      t.conversationId === 'vodou-heartbeat' || t.source === 'heartbeat' ||
      t.conversationId === 'board-chat' || t.source === 'board';
    const isProjectChat = (t) =>
      t && !isGlobalSystemTab(t) && this._isPrimaryConversationTab(t) &&
      (t.projectId || 'proj_default') === active;
    const current = this._tabs.find((t) => t.id === this._activeTabId);
    if (isProjectChat(current)) return; // already on a tab in this project
    const firstChat = this._tabs.find(isProjectChat);
    if (firstChat) this._switchTab(firstChat.id);
    else this._addTab(true); // empty project → start it with a fresh chat
  },

  /** Color for a tab's project chip, or null for Default/unknown (→ no chip rendered). */
  _projectColor(projectId) {
    if (!projectId || projectId === 'proj_default') return null;
    const p = (this._projectsCache || []).find((x) => x.id === projectId);
    return p ? (p.color || '#6b7280') : null;
  },

  _projectName(projectId) {
    const p = (this._projectsCache || []).find((x) => x.id === projectId);
    return p ? p.name : null;
  },

  async _renderProjectSwitcher() {
    const host = document.getElementById('chat-project-switcher-host');
    if (!host) return;
    let projects = this._projectsCache;
    if (!projects) {
      try { projects = (await API.get('/api/projects')).projects; this._projectsCache = projects; }
      catch { return; }
    }
    const activeId = this._getActiveProjectId();
    const active = projects.find((p) => p.id === activeId) || projects.find((p) => p.id === 'proj_default') || projects[0];
    if (!active) return;
    // The fallback above was display-only: when the scoped project was archived
    // elsewhere, the chip read "Default" while _activeProjectId (and every new
    // chat) stayed pointed at a project that had left the list. Adopt the
    // fallback for real. _setActiveProjectId re-enters here, but the ids match
    // on that pass so it stops at depth 2, and the first thing this function
    // does is clear `host` — so no double render.
    if (active.id !== activeId) { this._setActiveProjectId(active.id); return; }
    host.innerHTML = '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-project-switcher';
    btn.title = 'Active project — new chats are scoped here';
    // Active-project chip is gold — same "active = gold" language as the dock's
    // active pill and the title-bar avatar. The dropdown below keeps each
    // project's own color so they stay distinguishable. (CSS owns the gold.)
    const chip = document.createElement('span');
    chip.className = 'project-chip project-chip--active';
    const label = document.createElement('span');
    label.textContent = active.name;
    const caret = document.createElement('span');
    caret.textContent = '▾';
    caret.style.opacity = '0.6';
    btn.append(chip, label, caret);
    btn.onclick = (e) => { e.stopPropagation(); this._openProjectMenu(btn, projects); };
    host.appendChild(btn);
  },

  _openProjectMenu(anchor, projects) {
    document.getElementById('chat-project-menu')?.remove();
    const menu = document.createElement('div');
    menu.id = 'chat-project-menu';
    menu.className = 'chat-project-menu';
    for (const p of projects) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'chat-project-menu-item';
      const chip = document.createElement('span');
      chip.className = 'project-chip';
      chip.style.background = p.color || '#6b7280';
      const label = document.createElement('span');
      label.textContent = p.name;
      item.append(chip, label);
      item.onclick = () => { this._setActiveProjectId(p.id); menu.remove(); };
      menu.appendChild(item);
    }
    const manage = document.createElement('button');
    manage.type = 'button';
    manage.className = 'chat-project-menu-item chat-project-menu-manage';
    manage.textContent = '⚙ Manage projects';
    manage.onclick = () => { menu.remove(); location.hash = '#/projects'; };
    menu.appendChild(manage);
    const rect = anchor.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.left = rect.left + 'px';
    menu.style.visibility = 'hidden'; // measure before placing
    document.body.appendChild(menu);
    // Flip above the anchor when opening downward would push the menu off the
    // bottom of the viewport — e.g. the dock pinned to the bottom (body.dock-bottom),
    // where the switcher sits at the screen edge and a downward menu was clipped.
    const menuH = menu.offsetHeight;
    const fitsBelow = rect.bottom + 4 + menuH <= window.innerHeight - 8;
    menu.style.top = (fitsBelow ? rect.bottom + 4 : Math.max(8, rect.top - 4 - menuH)) + 'px';
    menu.style.visibility = '';
    const closer = (ev) => {
      if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', closer, true); }
    };
    setTimeout(() => document.addEventListener('click', closer, true), 0);
  },

  /**
   * Deep-link target for the board card's "View in Board chat ↗": open (or
   * create) the Board tab, then scroll to + flash-highlight that task's run
   * block. Tagging happens in _tagBoardRunMessage as messages render.
   */
  _switchToBoardTask(taskId) {
    if (!this._tabs) return;
    const convId = 'board-chat';
    let tab = this._tabs.find(t => t.conversationId === convId);
    if (!tab) {
      tab = { id: 'tab-board', title: 'BOARD', conversationId: convId, source: 'board', pinned: true };
      this._tabs.push(tab);
      this._saveTabs();
      this._renderTabs();
    }
    if (tab.id !== this._activeTabId) this._switchTab(tab.id);
    // History loads async after the switch — retry the scroll a few times.
    let tries = 0;
    const tryScroll = () => {
      const el = this.messagesEl && this.messagesEl.querySelector(`[data-board-task="${taskId}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.add('board-run-flash');
        setTimeout(() => el.classList.remove('board-run-flash'), 1600);
        return;
      }
      if (tries++ < 12) setTimeout(tryScroll, 250);
    };
    setTimeout(tryScroll, 200);
  },

  /**
   * Tag a board-chat run message (`▶ <taskId>` header) with its task id for
   * deep-link scrolling, and inject a small "↗ card" link that opens the task's
   * card on the board. No-op for non-board messages.
   */
  _tagBoardRunMessage(msgEl, rawText) {
    if (!msgEl || typeof rawText !== 'string') return;
    const m = rawText.match(/^\s*\*\*▶\s*(t_[a-z0-9]+)\*\*/i);
    if (!m) return;
    const taskId = m[1];
    msgEl.dataset.boardTask = taskId;
    msgEl.classList.add('board-run-msg');
    // Back-link to the board card (chat → card direction).
    const hdr = msgEl.querySelector('.msg-header');
    if (hdr && !hdr.querySelector('.board-run-cardlink')) {
      const a = document.createElement('a');
      a.className = 'board-run-cardlink';
      a.href = `#/board`;
      a.title = `Open ${taskId} on the board`;
      a.textContent = '↗ card';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        location.hash = '#/board';
        // Let the board view mount, then open this task's drawer.
        setTimeout(() => { try { window.BoardView && window.BoardView._openDrawer(taskId); } catch {} }, 250);
      });
      hdr.appendChild(a);
    }
  },

  /**
   * Switch the main chat view to the channel's unified conversation tab.
   * Conversation id is `workbench:channel:<type>` — one per channel type,
   * containing all inbound+outbound Slack/Telegram/etc. traffic. The tab
   * is auto-created here if it doesn't exist yet (user hasn't received a
   * message on this channel since the gateway started).
   */
  _switchToChannelTab(channel) {
    if (!this._tabs) return;
    const convId = `workbench:channel:${channel}`;
    const existing = this._tabs.find(t => t.conversationId === convId);
    if (existing) {
      if (existing.id !== this._activeTabId) this._switchTab(existing.id);
      return;
    }
    // No tab yet — create it pre-emptively so the user lands in the right
    // place even before the first inbound message arrives.
    const channelNames = { telegram: 'Telegram', slack: 'Slack', discord: 'Discord', teams: 'Teams', googlechat: 'Google Chat', signal: 'Signal', whatsapp: 'WhatsApp', imessage: 'iMessage' };
    const tab = {
      id: this._generateTabId(),
      title: channelNames[channel] || channel,
      conversationId: convId,
      source: channel,
    };
    this._tabs.push(tab);
    this._saveTabs();
    this._renderTabs();
    this._switchTab(tab.id);
  },

  /**
   * Connect WebSocket — migrated to shared WsBus (DO/8 Phase 4).
   * The `this.ws` shim keeps every existing `.send()` / `.readyState` call site
   * working unchanged; inbound events route through a WsBus.subscribeAll()
   * handler. No second socket is opened; ScopedWorkbench shares this one.
   */
  connect() {
    // If WsBus is missing (e.g. stale cache / half-migrated state), fall back
    // to the legacy direct-WebSocket path. Everything still works — we just
    // can't share the socket with ScopedWorkbench until the page reloads.
    if (typeof WsBus === 'undefined') {
      console.warn('[ChatView] WsBus not loaded — falling back to direct WebSocket (hard-refresh to get the shared bus).');
      return this._connectLegacy();
    }

    // Thin shim — preserves the legacy `this.ws` API surface used across this
    // file. Every `this.ws.send(...)` forwards to the bus (which auto-queues
    // if the socket isn't open yet). `this.ws.readyState` reports OPEN when
    // the bus is connected, CONNECTING otherwise, so existing guards still work.
    this.ws = {
      get readyState() { return WsBus.isReady() ? WebSocket.OPEN : WebSocket.CONNECTING; },
      send: (msg) => WsBus.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    };

    // Flush memory on tab/window close (equivalent to CLI SessionEnd)
    window.addEventListener('beforeunload', () => {
      if (WsBus.isReady()) {
        WsBus.send({ type: 'flush' });
      }
    });

    // Route inbound events. The server emits `{type:'connected'}` on open;
    // the `connected` case in `_handleWsMessage` drives the status pill AND
    // sends `switch_conversation` (which must happen AFTER init has populated
    // `this._tabs` — firing it up here would crash on `undefined.find()`).
    // subscribeAll() internally triggers WsBus._connect(), so this also dials
    // the socket — no separate kick needed.
    if (this._wsUnsub) this._wsUnsub();
    this._wsUnsub = WsBus.subscribeAll((data) => this._handleWsMessage(data));
  },

  /**
   * Shared inbound WS handler — called from both WsBus.subscribeAll and the
   * legacy direct-WebSocket fallback. `data` is the parsed message object.
   */
  _handleWsMessage(data) {
    // Seq-based dedup: drop events we've already rendered (can fire twice when
    // a ScopedWorkbench WsBus.subscribe + chat.js subscribeAll both handle the
    // same event, or during a WsBus resume race). Only applies to stamped events
    // (chunk/done/tool_start/tool_end) — connection handshakes don't have seq.
    if (data.seq && data.conversationId) {
      if (!this._seenSeq) this._seenSeq = new Map();
      const prev = this._seenSeq.get(data.conversationId) || 0;
      if (data.seq <= prev) return;
      this._seenSeq.set(data.conversationId, data.seq);
    }

    // Route skill runner events to the floating panel
    if (typeof SkillRunner !== 'undefined' && SkillRunner.isSkillEvent(data)) {
      SkillRunner.handleWsEvent(data);
      return;
    }

    switch (data.type) {
        case '_ws_status': {
          // Synthetic transport-state event from WsBus (not from the gateway).
          // The server's `connected` message confirms the app-level handshake;
          // this one tracks the raw socket so the pill stays honest when the
          // socket drops, retries, or comes back — and so the composer can't be
          // used while we're offline.
          if (data.state === 'connected') {
            // Don't claim "Connected" yet — wait for the gateway `connected`
            // handshake below to enable the composer. Just clear any error state.
            this.statusText.textContent = 'Connecting…';
            this.statusEl.className = 'sidebar-status';
          } else if (data.state === 'reconnecting') {
            this.statusText.textContent = 'Reconnecting…';
            this.statusEl.className = 'sidebar-status disconnected';
            this.sendBtn.disabled = true;
          } else { // 'disconnected'
            this.statusText.textContent = 'Disconnected';
            this.statusEl.className = 'sidebar-status disconnected';
            this.sendBtn.disabled = true;
          }
          break;
        }
        case 'connected': {
          // Gateway acknowledged the connection — drive the status pill here
          // (legacy `onopen` is gone now that WsBus owns the socket).
          this.statusText.textContent = 'Connected';
          this.statusEl.className = 'sidebar-status connected';
          this.sendBtn.disabled = false;
          if (data.activeModel) this._updateModelIndicator(data.activeModel);
          // Now that init has finished (tabs are populated) tell the server
          // which conversation this client is viewing. Guard against `_tabs`
          // still being undefined — in that case the server's default conv
          // from the initial `connected` payload is fine.
          if (Array.isArray(this._tabs)) {
            const convId = this._getConversationId();
            if (convId && convId !== data.conversationId) {
              (this.ws || WsBus).send({ type: 'switch_conversation', conversationId: convId });
            }
          }
          break;
        }
        case 'conversations_list':
          // Hydrate tabs from DB — merge any conversations not already in localStorage
          this._hydrateTabsFromDb(data.conversations || []);
          clearTimeout(this._skillMetaDebounce);
          this._skillMetaDebounce = setTimeout(() => this._refreshSkillConsoleMeta(), 400);
          break;
        case 'channel_activity': {
          // Auto-create tab when a channel message arrives (Telegram, Slack, etc.)
          const existingTab = this._tabs.find(t => t.conversationId === data.conversationId);
          if (!existingTab && !this._isDockExcludedSource(data.source)) {
            const channelNames = { telegram: 'Telegram', slack: 'Slack', discord: 'Discord', voice: 'Voice', web: 'Web' };
            // Unknown channels open one conversation per thread — label by
            // conversationId so N threads don't render as N identical tiles.
            // Mirrors _hydrateTabsFromDb's channelLabel().
            const title = channelNames[data.source]
              || (data.conversationId && data.conversationId !== data.source
                    ? data.conversationId
                    : data.source);
            this._tabs.push({
              id: this._generateTabId(),
              title,
              conversationId: data.conversationId,
              source: data.source,
            });
            this._saveTabs();
            this._renderTabs();
          }
          break;
        }
        case 'board_task_activity': {
          // All board worker output streams to ONE dedicated "Board" tab (a single
          // conversation, like a channel). Auto-create/reopen it if the user closed
          // it; never steal focus — just flag unread.
          const boardConvId = data.conversationId || 'board-chat';
          if (!this._tabs.find(t => t.conversationId === boardConvId)) {
            this._tabs.push({
              id: 'tab-board',
              title: 'BOARD',
              conversationId: boardConvId,
              source: 'board',
              pinned: true,
            });
            this._saveTabs();
            this._renderTabs();
          }
          // Quiet reopen: show an unread dot when not currently viewing the Board tab.
          if (this._getConversationId() !== boardConvId) {
            const tabEl = document.querySelector('[data-conversation-id="' + boardConvId + '"]');
            if (tabEl && !tabEl.querySelector('.tab-unread')) {
              const badge = document.createElement('span');
              badge.className = 'tab-unread';
              tabEl.appendChild(badge);
            }
          }
          break;
        }
        case 'skill_console_created': {
          // PLAN-SKILL-CONSOLE-LOOP §33 → Phase 4 — auto-tab-open for LLM-created skills.
          // Gateway poller broadcasts this when a new row lands in skills_meta.
          // Mirror channel_activity: insert a tab if not already present.
          const existing = this._tabs.find(t => t.conversationId === data.conversationId);
          if (!existing && data.conversationId) {
            this._tabs.push({
              id: this._generateTabId(),
              title: data.displayName || data.skillName || 'Skill',
              conversationId: data.conversationId,
              source: 'skill-console',
              skillId: data.skillId,
              skillName: data.skillName,
            });
            this._saveTabs();
            this._renderTabs();
            console.log('[skill-console] auto-opened tab for', data.skillName, '(id=' + data.skillId + ')');
            this._refreshSkillConsoleMeta();
          }
          break;
        }
        case 'skill_console_updated': {
          // PLAN-SKILL-CONSOLE-LOOP §33 → Phase 4 — fired by the slash-command
          // intercept (handleSlashCommand) when a skill mutates. Re-fetch the
          // tab's metadata so the title/state reflects the change. For now we
          // just trigger a re-render — a fuller pickup would refresh the
          // sidebar Skills group's settings panel.
          const tab = this._tabs.find(t => t.conversationId === data.conversationId);
          if (tab) {
            // Add/refresh a transient indicator so the user sees the change landed.
            tab._lastUpdatedAt = Date.now();
            this._renderTabs();
            console.log('[skill-console] tab refreshed for', data.skillName, '(id=' + data.skillId + ')');
            this._refreshSkillConsoleMeta();
          }
          break;
        }
        case 'heartbeat_activity': {
          // Ensure Vodou heartbeat tab exists
          const vTab = this._tabs.find(t => t.conversationId === data.conversationId);
          if (!vTab) {
            this._tabs.unshift({
              id: 'tab-vodou',
              title: 'Heartbeat',
              conversationId: data.conversationId,
              source: 'heartbeat',
              pinned: true,
            });
            this._saveTabs();
            this._renderTabs();
          }
          // A5f: unread badge when not viewing heartbeat tab
          if (this._getConversationId() !== 'vodou-heartbeat') {
            const tabEl = document.querySelector('[data-conversation-id="vodou-heartbeat"]');
            if (tabEl && !tabEl.querySelector('.tab-unread')) {
              const badge = document.createElement('span');
              badge.className = 'tab-unread';
              tabEl.appendChild(badge);
            }
          }
          break;
        }
        case 'heartbeat_pulse': {
          // A5: idle pulse — lightweight status update, no LLM involved
          if (this._getConversationId() === 'vodou-heartbeat') {
            let pulse = this.messagesEl.querySelector('.idle-pulse');
            if (!pulse) {
              pulse = document.createElement('div');
              pulse.className = 'idle-pulse';
              this.messagesEl.appendChild(pulse);
            }
            pulse.textContent = data.message || 'Pulse received';
          }
          break;
        }
        case 'channel_user_message': {
          const chLabel = data.senderName ? { senderLabel: data.senderName } : {};
          if (data.source === 'slack' && data.conversationId && data.senderName) {
            const tab = this._tabs.find(t => t.conversationId === data.conversationId);
            if (tab) {
              tab.title = ('Slack · ' + String(data.senderName)).substring(0, 80);
              this._saveTabs();
              this._renderTabs();
            }
          }
          // Show the channel user's message in the tab (live update)
          if (data.conversationId === this._getConversationId()) {
            this.addMessage(data.content, 'user', undefined, chLabel);
          } else {
            this._bufferEvent({
              type: 'channel_user_message',
              conversationId: data.conversationId,
              content: data.content,
              senderName: data.senderName,
              source: data.source,
            });
          }
          break;
        }
        case 'history': {
          // Clear and replay — handles initial connect + tab switches
          this.messagesEl.innerHTML = '';
          // Discard any stale streaming reference — history is always a clean slate.
          this.currentMessage = null;
          const convId = data.conversationId || this._getConversationId();
          // Reset seq dedup for this conv so replayed/resumed events after a
          // server restart (where seq numbering may restart) aren't silently dropped.
          // Must clear BOTH cursors: chat.js's local _seenSeq AND the shared
          // WsBus._lastSeq (the bus drops events at the transport layer before
          // they ever reach this handler — the root of the seq-reset data loss).
          if (convId && this._seenSeq) this._seenSeq.delete(convId);
          if (convId && typeof WsBus !== 'undefined') WsBus.resetSeq(convId);
          const isVodouHistory = convId === 'vodou-heartbeat';
          if (data.messages && data.messages.length > 0) {
            if (data.hasMore) {
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'load-more-runs';
              btn.textContent = isVodouHistory ? 'Load earlier runs' : 'Load earlier messages';
              btn.addEventListener('click', () => this._loadEarlierChatHistory(btn, convId));
              this.messagesEl.appendChild(btn);
            }
            const histOpts = { skipScroll: true };
            for (const msg of data.messages) {
              if (msg.role === 'user') {
                const histUserOpts = { ...histOpts, dbId: msg.id };
                if (msg.senderLabel) histUserOpts.senderLabel = msg.senderLabel;
                this.addMessage(msg.text, 'user', msg.timestamp, histUserOpts);
              } else if (msg.role === 'assistant') {
                this.addMessage(msg.text, 'assistant', msg.timestamp, { ...histOpts, dbId: msg.id });
              }
            }
            // For heartbeat tab, render latest assistant message as Briefing card (before scroll — it changes layout)
            if (isVodouHistory) {
              const lastAssistant = [...data.messages].reverse().find(m =>
                m.role === 'assistant' && m.text.trim() !== 'HEARTBEAT_OK'
              );
              if (lastAssistant) {
                const lensMatch = lastAssistant.text.match(/\[Heartbeat\s*\|\s*Lens:\s*(\w+)/);
                this._renderBriefing(lastAssistant.text, lastAssistant.timestamp, lensMatch ? lensMatch[1] : 'briefing');
              }
            }
            this._scrollToBottomAfterLayout();
          } else {
            // Show heartbeat welcome for Vodou tab, generic for others
            if (isVodouHistory) {
              this._showHeartbeatWelcome();
            } else {
              this._showWelcomeSuggestions();
            }
          }
          // Refresh today strip when history loads for Vodou tab
          if (isVodouHistory) {
            this._loadTodayStrip();
          }
          break;
        }
        case 'chunk': {
          // Track channel text for auto-speak even on background tabs
          if (this._autoSpeak && data.conversationId && data.content) {
            if (!this._channelSpeechBuffers) this._channelSpeechBuffers = {};
            if (!this._channelSpeechBuffers[data.conversationId]) this._channelSpeechBuffers[data.conversationId] = '';
            this._channelSpeechBuffers[data.conversationId] += data.content;
          }
          // Buffer events for background tabs instead of dropping them
          if (data.conversationId && data.conversationId !== this._getConversationId()) {
            try {
              if (typeof localStorage !== 'undefined' && localStorage.getItem('VODOU_DEBUG_WS') === '1') {
                console.warn('[VODOU_DEBUG_WS] chunk not applied to active tab (buffered for background conv)', {
                  eventConv: data.conversationId,
                  activeConv: this._getConversationId(),
                });
              }
            } catch (_) { /* */ }
            // Accumulate text separately for seamless streaming resume on return
            if (!this._tabStreamAccum[data.conversationId]) this._tabStreamAccum[data.conversationId] = '';
            this._tabStreamAccum[data.conversationId] += data.content || '';
            this._bufferEvent(data);
            break;
          }
          // A5j: Buffer heartbeat chunks instead of streaming to DOM
          // BUT: if user initiated a message (currentMessage exists or _userSentHeartbeat flag),
          // stream normally so "Run" suggestions show live output
          if (data.conversationId === 'vodou-heartbeat' && !this.currentMessage && !this._userSentHeartbeat) {
            this._heartbeatBuffer = (this._heartbeatBuffer || '') + (data.content || '');
            break;
          }
          if (!this.currentMessage) { this.startStreaming(); this._streamedText = ''; this._thinkBuffer = ''; this._inThinkBlock = false; }
          // Strip <think>...</think> blocks (DeepSeek, Qwen chain-of-thought)
          let chunk = data.content || '';
          if (this._inThinkBlock) {
            this._thinkBuffer += chunk;
            const endIdx = this._thinkBuffer.indexOf('</think>');
            if (endIdx >= 0) {
              chunk = this._thinkBuffer.substring(endIdx + 8);
              this._inThinkBlock = false;
              this._thinkBuffer = '';
            } else {
              chunk = ''; // still inside think block, swallow
            }
          } else if (chunk.includes('<think>')) {
            const startIdx = chunk.indexOf('<think>');
            const before = chunk.substring(0, startIdx);
            const rest = chunk.substring(startIdx + 7);
            const endIdx = rest.indexOf('</think>');
            if (endIdx >= 0) {
              chunk = before + rest.substring(endIdx + 8);
            } else {
              this._inThinkBlock = true;
              this._thinkBuffer = rest;
              chunk = before;
            }
          }
          if (chunk) {
            this._streamedText += chunk;
            this.appendToStream(chunk);
          }
          break;
        }
        case 'status': {
          if (data.conversationId && data.conversationId !== this._getConversationId()) break;
          this._showStatusPhase(data.status);
          break;
        }
        case 'usage': {
          if (data.conversationId && data.conversationId !== this._getConversationId()) break;
          this._updateUsageBar(data.usage);
          break;
        }
        case 'tool_start': {
          if (data.conversationId && data.conversationId !== this._getConversationId()) {
            this._bufferEvent(data);
            break;
          }
          const toolKey = data.toolId || data.tool + '_' + Date.now();
          if (this._toolData[toolKey]) {
            // Chip already exists — update args (content_block_start sent empty, now we have full args)
            if (data.args && Object.keys(data.args).length > 0) {
              this._toolData[toolKey].args = data.args;
            }
          } else {
            this._toolData[toolKey] = { tool: data.tool, server: data.server, args: data.args, startTime: Date.now() };
            this.addToolMessage(data.tool, toolKey);
            // PLAN-CHAT-SILENT-FIX — bump the phase indicator count.
            this._phaseUpdateToolCount(data.tool);
          }
          break;
        }
        case 'tool_end': {
          if (data.conversationId && data.conversationId !== this._getConversationId()) {
            this._bufferEvent(data);
            break;
          }
          const endKey = data.toolId || Object.keys(this._toolData).reverse().find(k =>
            this._toolData[k].tool === data.tool && !this._toolData[k].result
          );
          if (endKey && this._toolData[endKey]) {
            this._toolData[endKey].result = data.result;
            this._toolData[endKey].executionTime = data.executionTime;
            this._toolData[endKey].success = data.success;
          }
          // Mark the individual chip as done + stop elapsed timer
          // Clear from _toolData first (always works, no DOM dependency)
          if (endKey && this._toolData[endKey]?._elapsedTimer) {
            clearInterval(this._toolData[endKey]._elapsedTimer);
            this._toolData[endKey]._elapsedTimer = null;
          }
          const doneChip = document.querySelector('.inline-tool-chip[data-tool-key="' + (endKey || '') + '"]');
          if (doneChip) {
            doneChip.classList.add('done');
            if (doneChip._elapsedTimer) {
              clearInterval(doneChip._elapsedTimer);
              doneChip._elapsedTimer = null;
            }
            // Show final execution time from backend
            const elapsedEl = doneChip.querySelector('.tool-elapsed');
            if (elapsedEl && data.executionTime) {
              const ms = parseInt(data.executionTime, 10);
              elapsedEl.textContent = ms >= 1000 ? ' ' + (ms / 1000).toFixed(1) + 's' : ' ' + ms + 'ms';
            } else if (elapsedEl && endKey && this._toolData[endKey]?.startTime) {
              // No executionTime from backend — use client-side elapsed
              const ms = Date.now() - this._toolData[endKey].startTime;
              elapsedEl.textContent = ms >= 1000 ? ' ' + (ms / 1000).toFixed(1) + 's' : ' ' + ms + 'ms';
            }
          }
          // Auto-render images from tool results (HTTPS CDN, data URIs, local absolute paths)
          if (data.result && typeof data.result === 'string') {
            const td = endKey && this._toolData[endKey];
            const server = td?.server;
            const tool = (data.tool || td?.tool || '').trim();
            const images = this._extractRenderableImages(data.result);
            let n = 0;
            const maxImg = 6;
            for (const im of images) {
              if (n >= maxImg) break;
              if (im.type === 'data') this._showInlineDataImage(im.data, tool, server);
              else if (im.type === 'http') this._showInlineHttpImage(im.url, tool, server);
              else this._showInlineImage(im.path, tool, server);
              n++;
            }
            if (n === 0) {
              const b64Match = data.result.match(/(data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]{100,})/);
              if (b64Match) this._showInlineDataImage(b64Match[1], tool, server);
              else {
                const rawB64 = data.result.match(/([A-Za-z0-9+/=]{500,})/);
                if (rawB64 && /screenshot|capture|image|png/i.test(tool || '')) {
                  this._showInlineDataImage('data:image/png;base64,' + rawB64[1], tool, server);
                }
              }
            }
          }
          this.scrollToBottom();
          break;
        }
        case 'approval_requested': {
          // Bet #2 Phase 2b — a gated tool was parked server-side; show an
          // approve/deny card. Buffer for the right tab if we're not on it.
          if (data.conversationId && data.conversationId !== this._getConversationId()) {
            this._bufferEvent(data);
            break;
          }
          this._showApprovalCard(data);
          break;
        }
        case 'thinking_start': {
          if (data.conversationId && data.conversationId !== this._getConversationId()) {
            this._bufferEvent(data);
            break;
          }
          this._startThinkingSection(data.sessionId, data.topic, data.estimatedSteps);
          break;
        }
        case 'thinking_step': {
          if (data.conversationId && data.conversationId !== this._getConversationId()) {
            this._bufferEvent(data);
            break;
          }
          this._addThinkingStep(data.sessionId, data.thoughtNumber, data.totalThoughts, data.thought);
          break;
        }
        case 'thinking_complete': {
          if (data.conversationId && data.conversationId !== this._getConversationId()) {
            this._bufferEvent(data);
            break;
          }
          this._completeThinkingSection(data.sessionId);
          // A5: populate Briefing thinking row if synthesis available
          if (data.synthesis && data.conversationId === 'vodou-heartbeat') {
            const thinkRow = document.getElementById('briefing-thinking');
            if (thinkRow) {
              thinkRow.innerHTML =
                '<span class="briefing-thinking-label">Deep Think</span>' +
                '<span class="briefing-thinking-synthesis">' + this.escapeHtml(data.synthesis) + '</span>' +
                '<span>' + (data.totalThoughts || 0) + ' thoughts</span>';
            }
          }
          break;
        }
        case 'done':
          // Speak channel responses from background tabs when auto-speak is ON
          if (this._autoSpeak && data.conversationId && data.conversationId !== this._getConversationId()) {
            const buf = this._channelSpeechBuffers && this._channelSpeechBuffers[data.conversationId];
            if (buf && buf.trim()) {
              const chText = buf.replace(/```[\s\S]*?```/g, ' code block ')
                .replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FEFF}]|[\u{1F900}-\u{1F9FF}]|[\u{200D}\u{20E3}\u{FE0F}]|[\u{2702}-\u{27B0}]|[\u{E000}-\u{F8FF}]/gu, '')
                .replace(/[#*`_~\[\]()>|]/g, '').replace(/\n{2,}/g, '. ')
                .replace(/https?:\/\/\S+/g, 'link').replace(/\s{2,}/g, ' ').trim();
              if (chText.length > 0 && chText.length < 5000) {
                fetch('/api/channels/voice/speak', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ text: chText }),
                }).catch(() => {});
              }
            }
            delete this._channelSpeechBuffers[data.conversationId];
          }
          if (data.conversationId && data.conversationId !== this._getConversationId()) {
            try {
              if (typeof localStorage !== 'undefined' && localStorage.getItem('VODOU_DEBUG_WS') === '1') {
                console.warn('[VODOU_DEBUG_WS] done not applied to active tab (buffered for background conv)', {
                  eventConv: data.conversationId,
                  activeConv: this._getConversationId(),
                });
              }
            } catch (_) { /* */ }
            this._bufferEvent(data);
            if (this._tabStreamAccum) delete this._tabStreamAccum[data.conversationId];
            break;
          }
          // A5j: Render buffered heartbeat as Briefing card (only for scheduled runs, not user-initiated)
          if (data.source === 'heartbeat' && this._heartbeatBuffer && !this._userSentHeartbeat) {
            const lens = ''; // extracted from context if needed
            this._renderBriefing(this._heartbeatBuffer, new Date().toISOString(), lens);
            this._heartbeatBuffer = '';
            this._loadTodayStrip();
            this._hideStopBtn();
            this.sendBtn.disabled = false;
            break;
          }
          this._userSentHeartbeat = false;
          this._heartbeatBuffer = '';
          this.finalizeToolRow();
          this.endStreaming();
          // Finalize thinking section if heartbeat had one
          if (data.thinkingSessionId && this._activeThinkingSection) {
            this._completeThinkingSection(data.thinkingSessionId);
          }
          this._hideStopBtn();
          this.sendBtn.disabled = false;
          this._flushPendingSwitch();
          // Update persistent memory indicator in footer bar
          if (data.memory) {
            this._updateMemoryIndicator(data.memory);
            // PLAN-MEMORY-VISIBILITY-UI Phase D — append "🧠 N — see why" chip
            // below the assistant message bubble when structured debug payload arrived.
            this._renderMemoryRecallChip(data.memory);
          }
          // Auto-speak the response if toggle is ON
          if (this._autoSpeak && this._streamedText.trim()) {
            // Mute mic during playback to prevent echo loop
            if (this._isRecording) {
              this._isRecording = false;
              try { this._recognition.stop(); } catch {}
              this._voiceBtn.classList.remove('recording');
            }
            this._setVoiceState('speaking');
            // Strip markdown/emoji for cleaner speech
            const speakText = this._streamedText.replace(/```[\s\S]*?```/g, ' code block ')
              .replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FEFF}]|[\u{1F900}-\u{1F9FF}]|[\u{200D}\u{20E3}\u{FE0F}]|[\u{2702}-\u{27B0}]|[\u{E000}-\u{F8FF}]/gu, '')
              .replace(/[#*`_~\[\]()>|]/g, '').replace(/\n{2,}/g, '. ')
              .replace(/https?:\/\/\S+/g, 'link').replace(/\s{2,}/g, ' ').trim();
            if (speakText.length > 0 && speakText.length < 5000) {
              // Estimate speech duration (~150 words/min = ~2.5 words/sec)
              const wordCount = speakText.split(/\s+/).length;
              const estimatedMs = Math.max(2000, (wordCount / 2.5) * 1000);
              fetch('/api/channels/voice/speak', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: speakText }),
              }).catch(() => {});
              // After speech finishes, auto-restart mic for next turn
              setTimeout(() => {
                if (this._autoSpeak && !this._isRecording) {
                  this._setVoiceState('idle');
                  // Small pause before re-listening so mic doesn't catch tail end
                  setTimeout(() => {
                    if (this._autoSpeak) this._startVoice();
                  }, 800);
                }
              }, estimatedMs);
            } else {
              this._setVoiceState('idle');
            }
          } else {
            this._setVoiceState(this._autoSpeak ? 'idle' : null);
          }
          this._streamedText = '';
          if (this._channelSpeechBuffers && data.conversationId) delete this._channelSpeechBuffers[data.conversationId];
          break;
        case 'stopped':
          this.finalizeToolRow();
          this.endStreaming();
          this._hideStopBtn();
          this.addMessage('Stopped.', 'system');
          this.sendBtn.disabled = false;
          this._flushPendingSwitch();
          break;
        case 'error':
          if (data.conversationId && data.conversationId !== this._getConversationId()) {
            this._bufferEvent(data);
            if (this._tabStreamAccum) delete this._tabStreamAccum[data.conversationId];
            break;
          }
          this.endStreaming();
          this._hideStopBtn();
          this.addMessage('Error: ' + data.message, 'system');
          this.sendBtn.disabled = false;
          this._flushPendingSwitch();
          break;
        case 'cleared':
          this.addMessage('Conversation cleared', 'system');
          break;
        case 'terminal_output':
          if (typeof TerminalView !== 'undefined') TerminalView.handleOutput(data.data);
          break;
        case 'terminal_exit':
          if (typeof TerminalView !== 'undefined') TerminalView.handleExit(data.exitCode);
          break;
      }
  },

  /**
   * Legacy direct-WebSocket connect — used only when WsBus isn't available
   * (stale cache during a Phase 4 mid-transition state). Everything works
   * exactly as before; the only downside is no socket sharing with
   * ScopedWorkbench until the page is hard-refreshed.
   */
  _connectLegacy() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(protocol + '//' + location.host);

    window.addEventListener('beforeunload', () => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'flush' }));
      }
    });

    this.ws.onopen = () => {
      this.statusText.textContent = 'Connected';
      this.statusEl.className = 'sidebar-status connected';
      this.sendBtn.disabled = false;
      const convId = this._getConversationId();
      if (convId) {
        this.ws.send(JSON.stringify({ type: 'switch_conversation', conversationId: convId }));
      }
    };

    this.ws.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      this._handleWsMessage(data);
    };

    this.ws.onclose = () => {
      this.statusText.textContent = 'Disconnected';
      this.statusEl.className = 'sidebar-status disconnected';
      this.sendBtn.disabled = true;
      setTimeout(() => this.connect(), 3000);
    };

    this.ws.onerror = () => {
      this.statusText.textContent = 'Error';
      this.statusEl.className = 'sidebar-status disconnected';
    };
    // sticky — server reply latency (chunk/done events) is the real health
    // signal users care about.
  },

  /** Update the chat header memory pill from gateway memory stats. */
  _updateMemoryIndicator(memory) {
    const el = document.getElementById('chat-memory-indicator');
    if (!el) return;

    // Track cumulative memories used this conversation
    if (!this._memoriesUsedThisConv) this._memoriesUsedThisConv = 0;
    this._memoriesUsedThisConv += (memory.used || 0);

    const total = memory.total || 0;
    const used = this._memoriesUsedThisConv;

    el.classList.add('opacity-100');
    if (total === 0 && used === 0) {
      el.textContent = '\u{1F9E0} Learning...';
      el.title = 'Memory is empty \u2014 the system will learn from your conversations';
    } else {
      el.textContent = `\u{1F9E0} ${total.toLocaleString()} memories` + (used > 0 ? ` \u00B7 ${used} used` : '');
      // Temporarily disabled: the hover that listed the specific memories used
      // this turn. Keep a generic tooltip; re-enable the `memory.items` listing
      // when we revisit the memory-visibility UI.
      el.title = `${total} total memories, ${used} used this conversation`;
      // el.title = memory.items && memory.items.length > 0
      //   ? 'Memories used:\n' + memory.items.map(i => i.replace(/^-\s*/, '')).join('\n')
      //   : `${total} total memories, ${used} used this conversation`;
    }
  },

  /**
   * PLAN-MEMORY-VISIBILITY-UI Phase D — append a "🧠 N memories — see why" chip
   * below the assistant message bubble when the daemon returned a structured
   * debug payload. Click opens a modal listing the actual chunks injected
   * into THIS turn, with score breakdowns rendered by MemoryRow.
   */
  _renderMemoryRecallChip(memory) {
    if (!memory || !memory.debug || !Array.isArray(memory.debug.results) || !memory.debug.results.length) return;
    // Anchor under the just-finalized assistant message.
    // createMsgEl sets data-role="assistant", not class "assistant" — the old
    // `.message.assistant` selector never matched, so the chip never rendered.
    const lastMsg = this.messagesEl
      ? this.messagesEl.querySelector('.message[data-role="assistant"]:last-of-type')
      : null;
    if (!lastMsg) return;
    // Insert into .msg-body (column-flex) so the chip flows below the message
    // text and inherits the correct indent — not into .message (row-flex) where
    // it would become a third sibling next to the avatar and body.
    const msgBody = lastMsg.querySelector('.msg-body') || lastMsg;
    // Idempotency: don't double-render for the same done event.
    if (msgBody.querySelector('.chat-memrecall-chip')) return;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chat-memrecall-chip';
    const n = memory.debug.results.length;
    chip.textContent = `\u{1F9E0} ${n} memor${n === 1 ? 'y' : 'ies'} recalled · see why`;
    chip.title = 'Click to see which chunks surfaced and why';
    chip.addEventListener('click', () => {
      this._openMemoryRecallModal(memory.debug);
    });
    msgBody.appendChild(chip);
  },

  _openMemoryRecallModal(debug) {
    if (typeof Components === 'undefined' || !Components.openModal) {
      console.warn('[chat] Components.openModal not available');
      return;
    }
    const modal = Components.openModal({
      title: 'Memories used in this response',
      subtitle: `query:&nbsp;<code>${window.VodouSafe.escapeHtml((debug.query || '').slice(0, 120))}</code>` + (debug.active_scope ? ` &middot; scope:&nbsp;<code>${window.VodouSafe.escapeHtml(debug.active_scope)}</code>` : ''),
    });
    modal.body.style.maxHeight = '70vh';
    modal.body.style.overflow = 'auto';
    if (!debug.results || !debug.results.length) {
      modal.body.innerHTML = '<p style="opacity:.7">No structured debug data available for this turn.</p>';
      return;
    }
    if (typeof window.MemoryRow !== 'object' || typeof window.MemoryRow.render !== 'function') {
      modal.body.innerHTML = '<p style="opacity:.7">memory-row component not loaded.</p>';
      return;
    }
    const meta = document.createElement('div');
    meta.style.fontSize = '12px';
    meta.style.color = 'var(--content-muted)';
    meta.style.marginBottom = '12px';
    meta.textContent = `${debug.results.length} chunks injected into the prompt for this response. Click a chevron to see the score breakdown.`;
    modal.body.appendChild(meta);

    // PLAN-CONTINUITY-PRIMITIVE Phase 4 — surface rollup line above the chunk
    // list. Mirrors the daemon's hook `<continuity-source>` block but surfaced
    // visually for the chat user. Skipped silently when no chunks have a
    // parseable surface (file-indexed only).
    const parseSurface = window.MemoryRow_parseSurfaceFromScope;
    if (typeof parseSurface === 'function') {
      const surfaceSet = new Set();
      for (const c of debug.results) {
        const s = parseSurface(c.chunk_scope);
        if (s) surfaceSet.add(s);
      }
      if (surfaceSet.size > 0) {
        const rollup = document.createElement('div');
        rollup.style.fontSize = '12px';
        rollup.style.color = 'var(--accent, #6c8cff)';
        rollup.style.marginBottom = '12px';
        rollup.style.fontFamily = 'ui-monospace, SFMono-Regular, monospace';
        rollup.style.opacity = '0.9';
        rollup.textContent = '↳ recalled from: ' + Array.from(surfaceSet).sort().join(', ');
        rollup.title = 'continuity primitive — surfaces present in this turn';
        modal.body.appendChild(rollup);
      }
    }

    for (const chunk of debug.results) {
      modal.body.appendChild(window.MemoryRow.render(chunk, { allowPin: true }));
    }
  },

  _countSkillConsoleTabs() {
    return this._tabs.filter(
      (t) =>
        t.source === 'skill-console' ||
        (t.conversationId && String(t.conversationId).startsWith('workbench:skill-console:')),
    ).length;
  },

  /** Kebab id for Skill Console — mirrors server `slugifySkillConsoleName`. */
  _slugifySkillConsoleName(title) {
    const NAME_RE = /^[a-z][a-z0-9-]{2,40}$/;
    let slug = String(title || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-+/g, '-');
    if (!slug.length) return 'my-skill';
    if (!/^[a-z]/.test(slug)) slug = 'x-' + slug.replace(/^[^a-z0-9]+/, '');
    if (slug.length < 3) slug = slug + '-bot';
    if (slug.length > 41) slug = slug.slice(0, 41).replace(/-+$/g, '');
    if (!NAME_RE.test(slug)) slug = 'skill-' + Math.random().toString(36).slice(2, 10);
    return slug.slice(0, 41);
  },

  _closeNewSkillConsoleWizard() {
    const el = document.querySelector('.skill-console-wizard-overlay');
    if (el) el.remove();
  },

  _openNewSkillConsoleWizard() {
    if (document.querySelector('.skill-console-wizard-overlay')) return;
    const self = this;
    const DEFAULT_TPL =
      'You are an automated skill in the user\'s Vodou Skill Console. Follow their instructions. Be concise and actionable.\n\n{{user_message}}';

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay skill-console-wizard-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'scw-title');

    const content = document.createElement('div');
    content.className = 'modal-content modal-content-lg skill-console-wizard-content';
    content.onclick = (e) => e.stopPropagation();

    let nameManual = false;
    content.innerHTML =
      '<div class="modal-header">' +
      '<div class="modal-title" id="scw-title">Automated Skill</div>' +
      '<button type="button" class="modal-close skill-console-wizard-close" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="modal-body skill-console-wizard-body">' +
      '<p class="scw-lead">You get a dedicated tab and an optional schedule (same rules as <code>vc_skills_create</code>). Describe the skill below, then <strong>Draft with AI</strong> to fill in the technical fields — or open <strong>Advanced</strong> to edit everything by hand.</p>' +
      '<div class="scw-field scw-primary-field">' +
      '<label for="scw-idea">Describe your skill</label>' +
      '<textarea id="scw-idea" rows="5" class="scw-idea-main" placeholder="Be specific: what outcome you want, when it should run (e.g. every weekday 9am, @daily, or only when you open the tab), and any context — repos, people, tools, or channels. Example: each morning list open GitHub issues assigned to me in this repo and suggest the top three to tackle first."></textarea>' +
      '<p class="scw-hint">This is the main input. The more detail you give, the better the draft.</p>' +
      '<div class="scw-draft-actions">' +
      '<button type="button" class="btn btn-secondary scw-draft-btn" id="scw-draft">Draft with AI</button>' +
      '</div></div>' +
      '<details class="scw-advanced">' +
      '<summary>Advanced</summary>' +
      '<p class="scw-advanced-intro">Prompt template, display title, short name, schedule, delivery, and optional JSON. Open this after drafting to review, or skip drafting and fill these fields manually.</p>' +
      '<div class="scw-field"><label for="scw-template">Prompt template <span class="scw-help" tabindex="0" data-tooltip="The instruction Vodou follows each time the skill runs. Must include {{user_message}} where the user input is inserted. Example: Summarize today&#39;s news and format as bullets. User asked: {{user_message}}">?</span></label>' +
      '<textarea id="scw-template" rows="9"></textarea>' +
      '<p class="scw-hint">Include <code>{{user_message}}</code>; 20–8000 characters.</p></div>' +
      '<div class="scw-field"><label for="scw-display">Display name (title) <span class="scw-help" tabindex="0" data-tooltip="The label users see on the skill card and tab. Plain English, max 80 chars. Example: Daily News Digest or Morning System Check.">?</span></label>' +
      '<input type="text" id="scw-display" maxlength="80" placeholder="My daily digest" /></div>' +
      '<div class="scw-field"><label for="scw-name">Short name (kebab-case, auto from title) <span class="scw-help" tabindex="0" data-tooltip="Internal identifier used in URLs and CLI commands. Auto-derived from the title. Lowercase, dashes only, 3–40 chars. Example: daily-news-digest.">?</span></label>' +
      '<input type="text" id="scw-name" pattern="[a-z][a-z0-9-]{2,40}" spellcheck="false" title="^[a-z][a-z0-9-]{2,40}$" /></div>' +
      '<div class="scw-field"><label for="scw-schedule">Schedule (optional) <span class="scw-help" tabindex="0" data-tooltip="When this skill auto-runs. Accepts cron format (0 9 * * *), shortcuts (@daily, @hourly), or natural language (every weekday at 9am). Leave blank for on-demand only.">?</span></label>' +
      '<input type="text" id="scw-schedule" placeholder="@daily, 0 9 * * *, or every weekday at 9am" /></div>' +
      '<div class="scw-field"><label for="scw-stopping">stopping_points (JSON object or array, optional) <span class="scw-help" tabindex="0" data-tooltip="Checkpoints where the skill pauses for user input. JSON object/array. Example: {&quot;after_data_pull&quot;:&quot;Review data before proceeding?&quot;}. Use {} or leave blank for no stops.">?</span></label>' +
      '<textarea id="scw-stopping" rows="3" placeholder="{}"></textarea></div>' +
      '<div class="scw-field"><label for="scw-required-tools">required_tools (JSON array of tool names, optional) <span class="scw-help" tabindex="0" data-tooltip="MCP tools this skill depends on. JSON array of server/tool strings. Example: [&quot;mcp-monitor/get_cpu_info&quot;,&quot;context7/query-docs&quot;]. Empty array = no requirements. The skill will block if a required tool is unavailable.">?</span></label>' +
      '<textarea id="scw-required-tools" rows="2" placeholder=\'["gmail/messages_list", "gmail/message_modify"]\'></textarea></div>' +
      '<div class="scw-field"><label for="scw-delivery-mode">delivery_mode <span class="scw-help" tabindex="0" data-tooltip="Where the skill output goes. console = the Skill Console tab inside Vodou. channel = a specific Slack/Telegram/Discord channel (set delivery_target). broadcast = every connected channel.">?</span></label>' +
      '<select id="scw-delivery-mode"><option value="console" selected>console</option><option value="channel">channel</option><option value="broadcast">broadcast</option></select></div>' +
      '<div class="scw-field"><label for="scw-delivery-target">delivery_target (required if not console) <span class="scw-help" tabindex="0" data-tooltip="The channel address when delivery_mode = channel. Format: platform:id. Examples: slack:C0123ABC, telegram:-1001234567890, discord:987654321. Leave blank for console mode.">?</span></label>' +
      '<input type="text" id="scw-delivery-target" placeholder="slack:C123 or leave empty" /></div>' +
      '<div class="scw-field"><label for="scw-prefer-model">prefer_model (optional) <span class="scw-help" tabindex="0" data-tooltip="Override the default LLM model for this skill. Examples: opus (best reasoning, slower), sonnet (balanced), haiku (fast, cheap). Leave blank to use the gateway default.">?</span></label>' +
      '<input type="text" id="scw-prefer-model" /></div>' +
      '<div class="scw-field"><label for="scw-history">history_window (0–50) <span class="scw-help" tabindex="0" data-tooltip="How many prior conversation turns to include as context. 0 = every run is fresh (no history). Higher values = more context, more tokens spent. Typical: 0 for digests, 5–10 for ongoing assistants.">?</span></label>' +
      '<input type="number" id="scw-history" min="0" max="50" value="0" /></div>' +
      '<div class="scw-field scw-check"><label><input type="checkbox" id="scw-ephemeral" /> ephemeral (one-shot) <span class="scw-help" tabindex="0" data-tooltip="If checked, the skill runs ONCE then auto-deletes. Useful for tests, one-off jobs, or temporary workflows. Leave unchecked for persistent skills.">?</span></label></div>' +
      '<div class="scw-field"><label for="scw-params">parameters_json (optional) <span class="scw-help" tabindex="0" data-tooltip="Variables you can reference in the prompt template as {{param:NAME}}. JSON object. Example: {&quot;topic&quot;:&quot;AI news&quot;,&quot;max_items&quot;:5}. Lets one template power many skills with different inputs.">?</span></label>' +
      '<textarea id="scw-params" rows="2" placeholder="{}"></textarea></div>' +
      '<p class="scw-hint scw-advanced-note">Completion hooks are not on <code>vc_skills_create</code> in core yet; use delivery fields above or MCP follow-up.</p>' +
      '</details>' +
      '<p class="scw-error" id="scw-error" hidden></p>' +
      '</div>' +
      '<div class="modal-footer">' +
      '<button type="button" class="btn btn-secondary skill-console-wizard-close">Cancel</button>' +
      '<button type="button" class="btn btn-primary" id="scw-submit">Create</button></div>';

    overlay.appendChild(content);
    document.body.appendChild(overlay);

    const $ = (id) => /** @type {HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement|null} */ (content.querySelector('#' + id));
    $('scw-template').value = DEFAULT_TPL;

    const displayEl = $('scw-display');
    const nameEl = $('scw-name');
    const syncName = () => {
      if (!nameManual && displayEl.value.trim()) {
        nameEl.value = self._slugifySkillConsoleName(displayEl.value);
      }
    };
    displayEl.addEventListener('input', syncName);
    nameEl.addEventListener('input', () => { nameManual = true; });

    const errEl = content.querySelector('#scw-error');
    const showErr = (msg) => {
      errEl.textContent = msg || '';
      errEl.hidden = !msg;
    };

    const draftBtn = content.querySelector('#scw-draft');
    const ideaEl = $('scw-idea');
    if (!draftBtn || !ideaEl || !errEl) {
      console.error('[skill-console-wizard] missing draft controls');
    } else {
      draftBtn.addEventListener('click', async () => {
        const idea = ideaEl.value.trim();
        if (idea.length < 5) {
          showErr('Add at least 5 characters describing the skill, or open Advanced and fill the form manually.');
          return;
        }
        showErr('');
        const label = draftBtn.textContent;
        const ac = new AbortController();
        const abortT = setTimeout(() => ac.abort(), 95_000);
        draftBtn.disabled = true;
        draftBtn.textContent = 'Drafting…';
        try {
          const r = await fetch('/api/skill-console/draft', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idea }),
            signal: ac.signal,
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) {
            const hint =
              r.status === 404
                ? ' Restart the gateway after `npm run build` in MCP-servers/Vodou-Console.'
                : '';
            throw new Error((data.error || r.statusText) + hint);
          }
          if (data.display_name) displayEl.value = data.display_name;
          if (data.name) {
            nameManual = true;
            nameEl.value = data.name;
          }
          if (data.prompt_template) $('scw-template').value = data.prompt_template;
          if (data.schedule_cron) $('scw-schedule').value = data.schedule_cron;
          // Populate required_tools from the draft (real Vodou server/tool
          // names, e.g. ["gmail/messages_list"]) so the field reflects what the
          // skill actually uses instead of the generic placeholder example.
          if (Array.isArray(data.required_tools) && data.required_tools.length) {
            $('scw-required-tools').value = JSON.stringify(data.required_tools);
          }
          // Advanced fields — only apply when the draft returned a non-default
          // value, so we never clobber a field the user already touched with an
          // empty guess. Each is pre-validated server-side.
          if (data.delivery_mode && data.delivery_mode !== 'console') {
            $('scw-delivery-mode').value = data.delivery_mode;
          }
          if (data.delivery_target) $('scw-delivery-target').value = data.delivery_target;
          if (data.ephemeral === true) $('scw-ephemeral').checked = true;
          if (typeof data.history_window === 'number' && data.history_window > 0) {
            $('scw-history').value = String(data.history_window);
          }
          if (data.stopping_points) $('scw-stopping').value = data.stopping_points;
          if (data.prefer_model) $('scw-prefer-model').value = data.prefer_model;
          if (data.parameters_json) $('scw-params').value = data.parameters_json;
          // If the draft filled a schedule, required_tools, or any advanced
          // field, pop the Advanced section open so the user can see + review
          // what got filled (these all live under Advanced).
          if (
            data.schedule_cron ||
            (Array.isArray(data.required_tools) && data.required_tools.length) ||
            (data.delivery_mode && data.delivery_mode !== 'console') ||
            data.ephemeral === true || data.stopping_points ||
            data.prefer_model || data.parameters_json ||
            (typeof data.history_window === 'number' && data.history_window > 0)
          ) {
            const adv = content.querySelector('details.scw-advanced') || content.querySelector('details');
            if (adv && adv.tagName === 'DETAILS') adv.open = true;
          }
          if (typeof Components !== 'undefined' && Components.toast) {
            Components.toast('Draft applied — review then click Create.', 'success');
            // Non-fatal advisories from the draft (unparsed schedule, a tool
            // whose server isn't installed, etc.) — show each so the user can
            // fix it before creating instead of hitting a silent runtime fail.
            if (Array.isArray(data.warnings)) {
              for (const w of data.warnings) {
                if (typeof w === 'string' && w.trim()) Components.toast(w, 'warning');
              }
            }
          }
        } catch (e) {
          const msg = e && e.name === 'AbortError'
            ? 'Draft timed out (~95s). Check gateway LLM or try again.'
            : (e.message || String(e));
          showErr(msg);
          try {
            errEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          } catch { /* ignore */ }
        } finally {
          clearTimeout(abortT);
          draftBtn.disabled = false;
          draftBtn.textContent = label;
        }
      });
    }

    content.querySelector('#scw-submit').addEventListener('click', async () => {
      showErr('');
      const display_name = displayEl.value.trim();
      const name = nameEl.value.trim().toLowerCase();
      let prompt_template = $('scw-template').value;
      const schedule_cron = $('scw-schedule').value.trim();
      const delivery_mode = $('scw-delivery-mode').value;
      const delivery_target = $('scw-delivery-target').value.trim();
      const prefer_model = $('scw-prefer-model').value.trim();
      const history_window = parseInt($('scw-history').value, 10) || 0;
      const ephemeral = $('scw-ephemeral').checked;
      const parameters_json = $('scw-params').value.trim();
      const stoppingRaw = $('scw-stopping').value.trim();
      const requiredToolsRaw = $('scw-required-tools').value.trim();
      let stopping_points = undefined;
      let required_tools = undefined;
      if (stoppingRaw) {
        try {
          stopping_points = JSON.parse(stoppingRaw);
        } catch {
          showErr('stopping_points must be valid JSON.');
          return;
        }
      }
      if (requiredToolsRaw) {
        try {
          const rt = JSON.parse(requiredToolsRaw);
          if (!Array.isArray(rt)) {
            showErr('required_tools must be a JSON array.');
            return;
          }
          required_tools = rt;
        } catch {
          showErr('required_tools must be valid JSON array.');
          return;
        }
      }
      if (!display_name || !name) {
        showErr('Display name and short name are required — use Draft with AI from your description, or open Advanced and enter them.');
        return;
      }
      const body = {
        name,
        display_name,
        prompt_template,
        schedule_cron: schedule_cron || undefined,
        delivery_mode,
        delivery_target: delivery_target || undefined,
        prefer_model: prefer_model || undefined,
        history_window,
        ephemeral,
        parameters_json: parameters_json || undefined,
        // Scope the new console to the project you are standing in. Without
        // this the conversation is created with no project, so the skill shows
        // under Default no matter which project you built it from — the reason
        // a skill made in VODOU SOCIAL could not be found under VODOU SOCIAL.
        project_id: this._getActiveProjectId ? this._getActiveProjectId() : undefined,
      };
      if (stopping_points !== undefined) body.stopping_points = stopping_points;
      if (required_tools !== undefined) body.required_tools = required_tools;
      try {
        const r = await fetch('/api/skill-console/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || r.statusText);
        self._closeNewSkillConsoleWizard();
        if (typeof Components !== 'undefined' && Components.toast) {
          // The server now reports whether this will actually run. A skill with
          // no schedule, or one whose cron failed to register, used to produce
          // the same cheerful "Skill created" as a working automation.
          if (data.warning) {
            Components.toast(data.warning, 'error');
          } else {
            Components.toast('Skill created — tab should appear within a few seconds.', 'success');
          }
        }
      } catch (e) {
        showErr(e.message || String(e));
      }
    });

    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) self._closeNewSkillConsoleWizard();
    });
    content.querySelectorAll('.skill-console-wizard-close').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        self._closeNewSkillConsoleWizard();
      });
    });
  },

  /** Empty chat tab: a branded invitation to act — sigil, operator-voice
   *  headline, and real starter prompts that prefill the composer (never
   *  auto-send, so a click never spends tokens by surprise). */
  _showWelcomeSuggestions() {
    const wrapper = document.createElement('div');
    wrapper.className = 'chat-welcome chat-welcome-v2';

    // Starters span Vodou's four jobs — recall, automate, build, connect — so the
    // empty state shows what it does beyond being a chat box.
    const starters = [
      { eyebrow: 'Recall',   text: 'What did I work on this week?' },
      { eyebrow: 'Automate', text: 'Every weekday at 8am, brief me on my day' },
      { eyebrow: 'Build',    text: 'Plan this on the board: ' },
      { eyebrow: 'Connect',  text: 'Summarize my unread Slack and email' },
    ];

    // Crossroads sigil (veve-inspired) — the one signature flourish; gold, quiet.
    const sigil =
      '<svg class="welcome-sigil" viewBox="0 0 48 48" fill="none" stroke="currentColor" ' +
      'stroke-width="1.4" stroke-linecap="round" aria-hidden="true">' +
      '<path d="M24 5V43M5 24H43"/><circle cx="24" cy="24" r="6"/>' +
      '<circle cx="24" cy="5" r="1.6" fill="currentColor" stroke="none"/>' +
      '<circle cx="24" cy="43" r="1.6" fill="currentColor" stroke="none"/>' +
      '<circle cx="5" cy="24" r="1.6" fill="currentColor" stroke="none"/>' +
      '<circle cx="43" cy="24" r="1.6" fill="currentColor" stroke="none"/></svg>';

    let html =
      sigil +
      '<h2 class="welcome-title">What do you need done?</h2>' +
      '<p class="welcome-sub">Ask anything below — or start with one of these.</p>' +
      '<div class="welcome-grid">' +
      starters.map((s, i) =>
        '<button type="button" class="welcome-chip" data-starter="' + i + '">' +
          '<span class="chip-badge">' + s.eyebrow + '</span>' +
          '<span class="chip-text">' + s.text.replace(/</g, '&lt;') + '</span>' +
        '</button>'
      ).join('') +
      '</div>';

    if (this._countSkillConsoleTabs() === 0) {
      html +=
        '<p class="welcome-skill-console-cta">Want a recurring automated skill with its own tab? ' +
        '<button type="button" class="link-btn scw-open-from-welcome">Create an automated skill</button> ' +
        '<span class="welcome-muted">or type <kbd>/new-skill</kbd></span></p>';
    }
    wrapper.innerHTML = html;

    wrapper.querySelectorAll('.welcome-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const s = starters[+chip.dataset.starter];
        if (!s || !this.input) return;
        this.input.value = s.text;
        this.input.focus();
        this.input.dispatchEvent(new Event('input', { bubbles: true }));
        try { this.input.setSelectionRange(this.input.value.length, this.input.value.length); } catch (_) {}
      });
    });
    const btn = wrapper.querySelector('.scw-open-from-welcome');
    if (btn) btn.addEventListener('click', () => this._openNewSkillConsoleWizard());
    this.messagesEl.appendChild(wrapper);
    this.scrollToBottom();
  },

  /**
   * Send a message
   */
  async _showHeartbeatWelcome() {
    let stats = {};
    try { const res = await fetch('/api/heartbeat/stats'); if (res.ok) stats = await res.json(); } catch {}

    // Check if we have any briefing history
    try {
      const res = await fetch('/api/heartbeat/briefing');
      if (res.ok) {
        const data = await res.json();
        if (data && data.content && data.content.trim() !== 'HEARTBEAT_OK') {
          const lensMatch = data.content.match(/\[Heartbeat\s*\|\s*Lens:\s*(\w+)/);
          this._renderBriefing(data.content, data.timestamp, lensMatch ? lensMatch[1] : 'briefing');
          this._loadTodayStrip();
          return;
        }
      }
    } catch {}

    // Stage 0: static welcome card (no LLM cost)
    const wrapper = document.createElement('div');
    wrapper.className = 'briefing-transition';
    const enabled = stats.task?.enabled !== false;
    const interval = stats.task?.nextRunAt ? this._timeUntil(stats.task.nextRunAt) : '—';

    wrapper.innerHTML =
      '<div class="briefing-transition-title">Your Daily Briefing</div>' +
      '<p>This tab shows autonomous insights about your work.<br>' +
      'The more you use Vodou, the smarter it gets.</p>' +
      '<p class="briefing-transition-status">' +
      (enabled ? 'Status: Active &mdash; next run in ' + interval : 'Status: Disabled') + '</p>';

    this.messagesEl.appendChild(wrapper);
    this._loadDirectiveSummary(wrapper);
    this.scrollToBottom();
  },

  async _loadDirectiveSummary(container) {
    try {
      const res = await fetch('/api/heartbeat/directive');
      if (!res.ok) return;
      const { content } = await res.json();

      // Parse key info from the template
      const lenses = [];
      const rules = [];
      let tier = '0';
      let maxTasks = '5';

      for (const line of content.split('\n')) {
        const t = line.trim();
        if (t.startsWith('- **') && t.includes('**') && (t.includes('awareness') || t.includes('suggestions') || t.includes('connections') || t.includes('review'))) {
          const match = t.match(/\*\*(\w+)\*\*/);
          if (match) lenses.push(match[1]);
        }
        if (t.startsWith('Current autonomy tier:')) {
          const m = t.match(/tier:\s*(\d)/);
          if (m) tier = m[1];
        }
        if (t.includes('Max') && t.includes('items')) {
          const m = t.match(/Max\s+(\d+)/i);
          if (m) maxTasks = m[1];
        }
        if (t.startsWith('- **') && t.includes('Do not') || t.startsWith('- Read-only') || t.startsWith('- Be concise')) {
          rules.push(t.replace(/^-\s*/, '').replace(/\*\*/g, ''));
        }
      }

      const summary = document.createElement('div');
      summary.className = 'hb-directive-summary';

      const header = document.createElement('div');
      header.className = 'hb-directive-summary-header';
      header.innerHTML = '<span class="hb-directive-summary-title">Directive</span>';

      const editBtn = document.createElement('button');
      editBtn.className = 'hb-directive-edit-btn';
      editBtn.textContent = 'Customize';
      editBtn.addEventListener('click', () => this._openDirectiveEditor());
      header.appendChild(editBtn);
      summary.appendChild(header);

      const chips = document.createElement('div');
      chips.className = 'hb-directive-chips';
      chips.innerHTML = [
        ...lenses.map(l => `<span class="hb-directive-chip">${l}</span>`),
        `<span class="hb-directive-chip">Tier ${tier}</span>`,
        `<span class="hb-directive-chip">Max ${maxTasks} tasks</span>`,
      ].join('');
      summary.appendChild(chips);

      // Insert before the settings section
      const settingsEl = container.querySelector('.hb-welcome-settings');
      if (settingsEl) {
        container.insertBefore(summary, settingsEl);
      } else {
        container.appendChild(summary);
      }
    } catch (e) {
      console.error('[Directive] Failed to load summary:', e);
    }
  },

  async _openDirectiveEditor() {
    // Fetch current directive
    let content = '';
    try {
      const res = await fetch('/api/heartbeat/directive');
      if (res.ok) {
        const data = await res.json();
        content = data.content || '';
      }
    } catch { return; }

    const overlay = document.createElement('div');
    overlay.className = 'hb-directive-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    overlay.innerHTML = `
      <div class="hb-directive-modal">
        <div class="hb-directive-header">
          <span class="hb-directive-title">Heartbeat Directive</span>
          <button type="button" class="hb-directive-close" aria-label="Close">&times;</button>
        </div>
        <div class="hb-directive-body">
          <textarea class="hb-directive-editor"></textarea>
        </div>
        <div class="hb-directive-footer">
          <span class="hb-directive-status"></span>
          <button class="hb-directive-cancel">Cancel</button>
          <button class="hb-directive-save">Save</button>
        </div>
      </div>
    `;

    const textarea = overlay.querySelector('.hb-directive-editor');
    textarea.value = content;

    overlay.querySelector('.hb-directive-close').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.hb-directive-cancel').addEventListener('click', () => overlay.remove());

    overlay.querySelector('.hb-directive-save').addEventListener('click', async () => {
      const statusEl = overlay.querySelector('.hb-directive-status');
      try {
        const res = await fetch('/api/heartbeat/directive', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: textarea.value }),
        });
        if (res.ok) {
          statusEl.textContent = 'Saved';
          setTimeout(() => overlay.remove(), 800);
        } else {
          statusEl.textContent = 'Failed to save';
          statusEl.classList.add('status-error-text');
        }
      } catch {
        statusEl.textContent = 'Error saving';
        statusEl.classList.add('status-error-text');
      }
    });

    // Escape key to close
    const escHandler = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); } };
    document.addEventListener('keydown', escHandler);

    document.body.appendChild(overlay);
    textarea.scrollTop = 0;
    textarea.focus();
    textarea.setSelectionRange(0, 0);
  },

  _timeUntil(isoStr) {
    try {
      const diff = new Date(isoStr) - new Date();
      if (diff < 0) return 'due now';
      const mins = Math.floor(diff / 60000);
      if (mins < 60) return mins + 'm';
      const hrs = Math.floor(mins / 60);
      return hrs + 'h ' + (mins % 60) + 'm';
    } catch { return '—'; }
  },

  // A5: time ago helper
  _timeAgo(isoStr) {
    try {
      const diff = Date.now() - new Date(isoStr).getTime();
      if (diff < 60000) return 'just now';
      const mins = Math.floor(diff / 60000);
      if (mins < 60) return mins + 'm ago';
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      const days = Math.floor(hrs / 24);
      return days + 'd ago';
    } catch { return ''; }
  },

  // A5a: 3-tier Briefing parser
  _parseBriefing(text) {
    const clean = text.replace(/```[\s\S]*?```/g, '');
    const extractSection = (t, name) => {
      const re = new RegExp('## ' + name + '\\s*\\n([\\s\\S]*?)(?=\\n## |$)', 'i');
      const m = t.match(re);
      return m ? m[1].trim() : null;
    };
    let headline = extractSection(clean, 'Headline');
    let details = extractSection(clean, 'Details');
    let summary = extractSection(clean, 'Summary');
    let tasks = extractSection(clean, 'Tasks');
    if (headline) return { headline, details, summary, tasks, tier: 1 };

    // Tier 2: fuzzy heading match
    const fuzzy = [/^#+\s*Headline[:\s]*(.*)/im, /^\*\*Headline\*\*[:\s]*(.*)/im, /^Headline[:\s]+(.*)/im];
    for (const pat of fuzzy) { const m = clean.match(pat); if (m) { headline = m[1].trim(); break; } }
    if (headline) return { headline, details, summary, tasks, tier: 2 };

    // Tier 3: heuristic (always succeeds)
    const lines = clean.split('\n').map(l => l.trim()).filter(l =>
      l && !l.startsWith('[Heartbeat') && l !== '---' && l !== 'HEARTBEAT_OK' && !l.startsWith('##')
    );
    headline = lines[0] || 'Briefing complete';
    details = lines.slice(1).filter(l => l.startsWith('-') && !l.match(/^- \[[ xX]\]/)).slice(0, 3).join('\n') || null;
    tasks = lines.filter(l => /^- \[[ xX]\]/.test(l)).join('\n') || null;
    return { headline, details, summary: null, tasks, tier: 3 };
  },

  // A5b: task type inference (frontend, not LLM)
  _inferTaskType(text) {
    const t = text.toLowerCase();
    if (/\b(remember|check on|follow up|revisit|circle back)\b/.test(t)) return 'reminder';
    if (/\b(consider|try|explore|might want|could)\b/.test(t)) return 'suggestion';
    if (/\b(you said|you mentioned|haven't started|haven't touched|still pending)\b/.test(t)) return 'nudge';
    return 'action';
  },

  /** Heartbeat-only chrome: experimental label + briefing strip (hidden on other tabs). */
  _ensureHeartbeatBriefingChrome() {
    let chrome = document.getElementById('heartbeat-briefing-chrome');
    if (chrome) return chrome;
    chrome = document.createElement('div');
    chrome.id = 'heartbeat-briefing-chrome';
    chrome.className = 'is-hidden';
    const title = document.createElement('div');
    title.className = 'heartbeat-experimental-title';
    title.textContent = 'Heartbeat — Experimental';
    chrome.appendChild(title);
    const anchor = document.getElementById('today-strip') || this.messagesEl;
    this.messagesEl.parentNode.insertBefore(chrome, anchor);
    return chrome;
  },

  _updateHeartbeatBriefingChromeVisibility() {
    const strip = document.getElementById('briefing-strip');
    const onHb = this._getConversationId() === 'vodou-heartbeat';
    if (onHb) {
      const chrome = this._ensureHeartbeatBriefingChrome();
      if (strip && strip.parentNode !== chrome) chrome.appendChild(strip);
      chrome.classList.remove('is-hidden');
      if (strip) strip.classList.remove('is-hidden');
      return;
    }
    const chrome = document.getElementById('heartbeat-briefing-chrome');
    if (chrome) chrome.classList.add('is-hidden');
    if (strip && !strip.closest('#heartbeat-briefing-chrome')) strip.classList.add('is-hidden');
  },

  // A5c: Briefing card renderer
  _renderBriefing(response, timestamp, lens) {
    const { headline, details, summary, tasks, tier } = this._parseBriefing(response);
    if (tier === 3 && headline === 'Briefing complete') {
      this._showTransitionCard();
      return;
    }

    const typeIcons = { action: '&#9744;', reminder: '&#128339;', nudge: '&#10132;', suggestion: '&#128161;' };

    // Details
    let detailsHtml = '';
    if (details) {
      detailsHtml = '<div class="briefing-strip-details">' +
        details.split('\n').filter(l => l.trim().startsWith('-'))
          .map(l => '<div class="briefing-strip-detail-item"><span class="briefing-strip-dot"></span><span>' +
            this.escapeHtml(l.trim().replace(/^-\s*/, '')) + '</span></div>').join('') +
        '</div>';
    }

    // Summary (prose narrative above tasks)
    let summaryHtml = '';
    if (summary) {
      summaryHtml = '<div class="briefing-strip-summary">' + this.escapeHtml(summary) + '</div>';
    }

    // Tasks
    let tasksHtml = '';
    if (tasks) {
      const taskLines = tasks.split('\n').filter(l => l.trim().match(/^- \[[ xX]\]/));
      if (taskLines.length) {
        tasksHtml = '<div class="briefing-strip-tasks">' +
          taskLines.map(l => {
            const done = /\[[xX]\]/.test(l);
            const text = l.replace(/^- \[[ xX]\]\s*/, '');
            const type = this._inferTaskType(text);
            const dataAttr = done ? '' : ' data-task-text="' + this.escapeAttr(text) + '"';
            return '<div class="briefing-strip-task' + (done ? ' done' : '') + '"' + dataAttr + '>' +
              '<span class="briefing-task-icon">' + typeIcons[type] + '</span>' +
              '<span class="briefing-strip-task-text">' + this.escapeHtml(text) + '</span></div>';
          }).join('') +
          '</div>';
      }
    }

    const chrome = this._ensureHeartbeatBriefingChrome();
    let strip = document.getElementById('briefing-strip');
    const isNew = !strip;
    if (isNew) {
      strip = document.createElement('div');
      strip.id = 'briefing-strip';
      strip.className = 'briefing-strip collapsed';
      chrome.appendChild(strip);
    } else if (strip.parentNode !== chrome) {
      chrome.appendChild(strip);
    }

    strip.innerHTML =
      '<div class="briefing-strip-header">' +
        '<span class="briefing-strip-toggle">&#9660;</span>' +
        '<span class="briefing-strip-label">Briefing</span>' +
        (lens ? '<span class="briefing-strip-lens">' + this.escapeHtml(lens) + '</span>' : '') +
        '<span class="briefing-strip-preview">' + this.escapeHtml(headline) + '</span>' +
        '<span class="briefing-strip-time">' + this._timeAgo(timestamp) + '</span>' +
      '</div>' +
      '<div class="briefing-strip-body">' +
        '<div class="briefing-strip-headline">' + this.escapeHtml(headline) + '</div>' +
        detailsHtml + summaryHtml + tasksHtml +
        '<div id="briefing-thinking" class="briefing-thinking-row"></div>' +
        '<div class="briefing-strip-footer">' +
          '<span class="briefing-strip-source">Based on: conversations, daily log, active plans</span>' +
          '<div class="briefing-footer-actions">' +
            '<button class="briefing-manage-btn" onclick="ChatView._openDirectiveEditor()" title="Manage briefing settings">Manage</button>' +
            '<div class="briefing-feedback">' +
              '<button onclick="ChatView._sendFeedback(\'up\')" title="Useful">&#128077;</button>' +
              '<button onclick="ChatView._sendFeedback(\'down\')" title="Not useful">&#128078;</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    // Toggle on header click
    strip.querySelector('.briefing-strip-header').addEventListener('click', () => {
      strip.classList.toggle('collapsed');
    });

    // Flash amber on new run
    strip.classList.add('new-run');
    setTimeout(() => strip.classList.remove('new-run'), 2000);

    // Wire done buttons on open tasks
    this._wireTaskDoneBtns(strip);

    this._updateHeartbeatBriefingChromeVisibility();
  },

  // Round 3: add hover-reveal ✓ Done button to each open task in the Briefing strip/card.
  // Uses [data-task-text] selector — works on both briefing-strip-task and briefing-task elements.
  _wireTaskDoneBtns(container) {
    container.querySelectorAll('[data-task-text]:not(.done)').forEach(el => {
      const taskText = el.dataset.taskText;
      if (!taskText) return;
      const btn = document.createElement('button');
      btn.className = 'briefing-task-done-btn';
      btn.title = 'Mark done';
      btn.textContent = '✓ Done';
      btn.addEventListener('click', async (e) => {
        e.stopPropagation(); // don't toggle collapse
        btn.disabled = true;
        try {
          await fetch('/api/heartbeat/tasks/complete', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: taskText }),
          });
          el.classList.add('done');
          btn.remove();
          // Sync today strip
          const todayStrip = document.getElementById('today-strip');
          if (todayStrip) {
            const targetTitle = this._taskTitle(taskText);
            todayStrip.querySelectorAll('.today-strip-item').forEach(item => {
              const textEl = item.querySelector('.today-strip-text');
              if (textEl && this._taskTitle(textEl.textContent) === targetTitle) {
                item.classList.add('done');
              }
            });
          }
        } catch { btn.disabled = false; }
      });
      el.appendChild(btn);
    });
  },

  // A5d: replace _showHeartbeatWelcome is done below in separate edit

  // A5e: Transition card for pre-update messages
  _showTransitionCard() {
    const card = document.createElement('div');
    card.className = 'briefing-transition';
    card.innerHTML =
      '<div class="briefing-transition-title">Your Daily Briefing has been upgraded</div>' +
      '<p>Your next scheduled run will use the new format with structured insights.</p>';
    const existing = this.messagesEl.querySelector('.briefing-card, .briefing-transition');
    if (existing) existing.remove();
    this.messagesEl.insertBefore(card, this.messagesEl.firstChild);
  },

  // A5h: Feedback handler
  async _sendFeedback(reaction) {
    try {
      await fetch('/api/heartbeat/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run: 0, reaction }),
      });
      const btns = this.messagesEl.querySelectorAll('.briefing-feedback button');
      btns.forEach(b => b.classList.remove('active'));
      const activeBtn = reaction === 'up' ? btns[0] : btns[1];
      if (activeBtn) activeBtn.classList.add('active');
    } catch {}
  },

  // --- P19: Skill pill rendering ---
  _addSkillPill(skillName) {
    let area = document.getElementById('skill-pill-area');
    if (!area) {
      area = document.createElement('div');
      area.id = 'skill-pill-area';
      area.className = 'skill-pill-area';
      const wrapper = this.input.closest('.autocomplete-wrapper') || this.input.parentElement;
      wrapper.insertBefore(area, this.input);
    }
    // Don't add duplicate
    if (area.querySelector('[data-skill="' + skillName + '"]')) return;

    const pill = document.createElement('span');
    pill.className = 'skill-pill';
    pill.dataset.skill = skillName;
    pill.innerHTML = '<span class="skill-pill-text">/' + this.escapeHtml(skillName) + '</span><span class="skill-pill-remove">\u00d7</span>';
    pill.querySelector('.skill-pill-remove').addEventListener('click', () => {
      pill.remove();
      // Remove /skill-name from textarea
      this.input.value = this.input.value.replace(new RegExp('/?\\/' + skillName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'g'), '').trim();
      if (area.children.length === 0) area.remove();
    });
    area.appendChild(pill);
  },

  _clearSkillPills() {
    const area = document.getElementById('skill-pill-area');
    if (area) area.remove();
  },

  /** Myers-style line LCS for /refine modal; null if too large. */
  _refineLineDiffOps(oldText, newText) {
    const a = String(oldText || '').split('\n');
    const b = String(newText || '').split('\n');
    const MAX = 480;
    if (a.length > MAX || b.length > MAX) return null;
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) {
        ops.push({ t: 'eq', o: a[i], n: b[j] });
        i++;
        j++;
      } else if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) {
        ops.push({ t: 'del', o: a[i], n: '' });
        i++;
      } else {
        ops.push({ t: 'ins', o: '', n: b[j] });
        j++;
      }
    }
    return ops;
  },

  _renderRefineLineMatrix(matrixEl, oldText, newText) {
    const ops = this._refineLineDiffOps(oldText, newText);
    matrixEl.innerHTML = '';
    matrixEl.className = 'refine-diff-matrix-scroll';
    if (!ops) {
      const fb = document.createElement('div');
      fb.className = 'refine-diff-fallback-split';
      const po = document.createElement('pre');
      const pn = document.createElement('pre');
      po.className = 'refine-diff-pane';
      pn.className = 'refine-diff-pane refine-diff-pane-new';
      po.textContent = oldText;
      pn.textContent = newText;
      fb.appendChild(po);
      fb.appendChild(pn);
      matrixEl.appendChild(fb);
      return;
    }
    let lnO = 1;
    let lnN = 1;
    for (let k = 0; k < ops.length; k++) {
      const op = ops[k];
      const row = document.createElement('div');
      row.className = 'refine-diff-mrow refine-diff-mrow-' + op.t;
      const co = document.createElement('div');
      const cn = document.createElement('div');
      co.className = 'refine-diff-mcell refine-diff-mcell-old';
      cn.className = 'refine-diff-mcell refine-diff-mcell-new';
      const lo = document.createElement('span');
      const ln = document.createElement('span');
      lo.className = 'refine-diff-ln';
      ln.className = 'refine-diff-ln';
      let showO = '';
      let showN = '';
      if (op.t === 'eq') {
        showO = String(lnO++);
        showN = String(lnN++);
      } else if (op.t === 'del') {
        showO = String(lnO++);
      } else {
        showN = String(lnN++);
      }
      lo.textContent = showO;
      ln.textContent = showN;
      const to = document.createElement('span');
      const tn = document.createElement('span');
      to.className = 'refine-diff-mtext';
      tn.className = 'refine-diff-mtext';
      to.textContent = op.o;
      tn.textContent = op.n;
      if (op.t === 'eq') {
        co.classList.add('is-same');
        cn.classList.add('is-same');
      } else if (op.t === 'del') co.classList.add('is-del');
      else cn.classList.add('is-ins');
      co.appendChild(lo);
      co.appendChild(to);
      cn.appendChild(ln);
      cn.appendChild(tn);
      row.appendChild(co);
      row.appendChild(cn);
      matrixEl.appendChild(row);
    }
  },

  async _openRefineTemplateModal(convId, fullUserMessage, newTemplate) {
    if (document.querySelector('.refine-template-modal-overlay')) return;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay refine-template-modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'refine-modal-title');
    const content = document.createElement('div');
    content.className = 'modal-content modal-content-lg refine-template-modal-content';
    content.addEventListener('click', (e) => e.stopPropagation());

    const note = 'Previous version is saved to prompt_history. The live template updates when you confirm.';
    content.innerHTML =
      '<div class="modal-header refine-modal-header">'
      + '<div><div class="modal-title" id="refine-modal-title">Replace skill template?</div>'
      + '<div class="refine-modal-sub">' + this.escapeHtml(note) + '</div></div></div>'
      + '<div class="modal-body refine-modal-body">'
      + '<div class="refine-modal-stats" data-refine-stats></div>'
      + '<div class="refine-diff-pane-label refine-diff-matrix-hint">Current (server) · left — New (/refine) · right</div>'
      + '<div class="refine-diff-matrix-scroll" data-refine-matrix>Loading…</div>'
      + '</div>'
      + '<div class="modal-footer">'
      + '<button type="button" class="btn" data-refine-cancel>Cancel</button>'
      + '<button type="button" class="btn btn-primary" data-refine-apply>Replace template</button>'
      + '</div>';

    const matrixEl = content.querySelector('[data-refine-matrix]');
    const statsEl = content.querySelector('[data-refine-stats]');
    const applyBtn = content.querySelector('[data-refine-apply]');
    const cancelBtn = content.querySelector('[data-refine-cancel]');
    const setStats = (oldStr, newStr) => {
      const ol = oldStr ? oldStr.split('\n').length : 0;
      const nl = newStr ? newStr.split('\n').length : 0;
      statsEl.textContent = 'Lines ' + ol + ' → ' + nl + ' · Chars ' + oldStr.length + ' → ' + newStr.length;
    };

    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    cancelBtn.addEventListener('click', close);
    applyBtn.addEventListener('click', () => {
      if (applyBtn.disabled) return;
      close();
      this.sendMessage(fullUserMessage, { skipRefineGuard: true });
    });

    overlay.appendChild(content);
    document.body.appendChild(overlay);

    try {
      const r = await fetch('/api/skill-console/prompt-template?' + new URLSearchParams({ conversationId: convId }));
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
      const cur = j.promptTemplate != null ? String(j.promptTemplate) : '';
      this._renderRefineLineMatrix(matrixEl, cur, newTemplate);
      setStats(cur, newTemplate);
      try { applyBtn.focus(); } catch { /* ignore */ }
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      matrixEl.textContent = '(Could not load current template: ' + msg + ')';
      applyBtn.disabled = true;
      applyBtn.title = 'Fix the error above or retry; replace is blocked without a loaded baseline.';
      setStats('', newTemplate);
      try { cancelBtn.focus(); } catch { /* ignore */ }
    }
  },

  sendMessage(overrideText, opts) {
    let text = (overrideText || this.input.value).trim();
    // Sending is an explicit "follow along" — re-arm sticking so the new turn
    // and its streamed response scroll into view (until the user scrolls up).
    this._stickToBottom = true;
    // P19: Clear skill pills on send
    this._clearSkillPills();

    // If there's a pending file, build the message with file content.
    // Delegates to ChatFileDrop.embedInText so workbench produces identical output.
    // Also capture a proper ChannelAttachmentMeta so the server can read the file
    // bytes and pass them to vision-capable LLMs as image_url content (not just
    // a text path reference). Mirrors the REST /chat `attachments` shape.
    const pendingList = this._fileDrop ? this._fileDrop.getPendingList() : [];
    let pendingAttachments = [];
    if (pendingList.length && !overrideText) {
      text = ChatFileDrop.embedAllInText(pendingList, text);
      pendingAttachments = ChatFileDrop.buildAttachmentMetas(pendingList);
      this._fileDrop.clear();
    }

    if (!text) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Clear input even when WS is down — don't leave stale text
      if (!overrideText) {
        this.input.value = '';
        this._autoResizeInput();
      }
      return;
    }

    // New Skill Console wizard (any tab — opens modal, no LLM round-trip).
    if (/^\s*\/new-skill\b/i.test(text)) {
      if (!overrideText) {
        this.input.value = '';
        this._autoResizeInput();
      }
      this._openNewSkillConsoleWizard();
      return;
    }

    // Skill Console tab — /refine and /edit replace the server prompt template (PLAN risk #10).
    const skipRefine = opts && opts.skipRefineGuard;
    const convForRefine = this._getConversationId();
    if (!skipRefine && typeof convForRefine === 'string' && convForRefine.startsWith('workbench:skill-console:')) {
      const refineMatch = text.match(/^\/(refine|edit)\s+([\s\S]+)$/i);
      if (refineMatch) {
        const newTpl = refineMatch[2].trim();
        if (newTpl.length >= 20) {
          void this._openRefineTemplateModal(convForRefine, text, newTpl);
          return;
        }
      }
    }

    // Check for /server command — show inline form for a tool
    const formMatch = text.match(/^\/server\s+(\S+)\s+(\S+)\s*$/);
    if (formMatch && typeof InlineForms !== 'undefined') {
      this.input.value = '';
      this._autoResizeInput();
      this._showToolFormInChat(formMatch[1], formMatch[2]);
      return;
    }

    // /run in an automation-scoped conversation rewrites the message so the
    // LLM actually executes the automation's trigger (and downstream actions)
    // as a tool-call chain. The LLM streams its summary back into this tab
    // just like any other workbench chat — same tool_start/tool_end pills,
    // same assistant bubble, same memory. We also queue the real engine run
    // in the background so automation_runs + last_seen_ids stay authoritative
    // for scheduled runs.
    if (/^\s*\/run\s*$/i.test(text)) {
      const convId = this._getConversationId();
      const m = /^workbench:automation:(\d+)$/.exec(convId || '');
      if (m) {
        this.input.value = '';
        this._autoResizeInput();
        const automationId = m[1];
        // Fetch the automation config, build an LLM prompt, submit it
        (async () => {
          try {
            const data = await API.get(`/api/automations/${automationId}`);
            const auto = data.automation || {};
            const trig = auto.trigger || {};
            const actions = Array.isArray(auto.actions) ? auto.actions : [];
            const notify = auto.notify || null;

            const argsJson = JSON.stringify(trig.args || {}, null, 2);
            let prompt = `Run this automation's trigger now and summarize the result briefly for me in chat.\n\n`;
            prompt += `Call the tool **${trig.tool}** on server **${trig.integration}** with these arguments:\n\n`;
            prompt += '```json\n' + argsJson + '\n```\n\n';
            if (actions.length > 0) {
              prompt += `After the trigger returns, if there are any new events worth acting on, also chain these ${actions.length} action(s):\n`;
              actions.forEach((a, i) => {
                prompt += `${i + 1}. \`${a.integration}.${a.tool}\` — substitute any \`{{trigger.X}}\` placeholders in its args using the trigger's result.\n`;
              });
              prompt += '\n';
            }
            if (notify && notify.url) {
              prompt += `Note: this automation normally posts to a webhook (${(notify.url || '').substring(0, 60)}…) on its scheduled runs. For this manual /run, just summarize in chat — don't post.\n\n`;
            }
            prompt += `Keep the summary tight: how many results, what they are, and any action outcomes. This run is user-initiated (not on schedule) so skip the dedup logic — the engine still tracks last_seen_ids separately.`;

            // Send that prompt as if the user typed it — re-enters sendMessage
            this.sendMessage(prompt);

            // Also kick the real engine in the background so the authoritative
            // run history stays in sync with the chat-driven run.
            API.post(`/api/automations/${automationId}/run`, {}).catch(() => {});
          } catch (err) {
            this.addMessage(text, 'user');
            this.addMessage(`⚠️ Could not load automation config: ${err.message}`, 'system');
          }
        })();
        return;
      }
      // If /run was typed outside an automation conversation, fall through
      // to normal send — the LLM will respond to it as plain text.
    }
    // Record non-trivial messages to command palette recents
    if (text.length > 2 && text.length < 200 && typeof CommandPalette !== 'undefined') CommandPalette.recordRecent(text);

    // Show truncated version with expand option for long messages
    if (text.length > 500) {
      const preview = text.substring(0, 200);
      const { content: el } = this.addMessage(preview + '...', 'user');
      const toggle = document.createElement('span');
      toggle.className = 'msg-expand-toggle';
      toggle.textContent = 'Show more';
      toggle._fullText = text;
      toggle._preview = preview;
      toggle._expanded = false;
      toggle.addEventListener('click', () => {
        toggle._expanded = !toggle._expanded;
        if (toggle._expanded) {
          el.innerHTML = this.escapeHtml(toggle._fullText);
          el.appendChild(toggle);
          toggle.textContent = 'Show less';
        } else {
          el.innerHTML = this.escapeHtml(toggle._preview + '...');
          el.appendChild(toggle);
          toggle.textContent = 'Show more';
        }
      });
      el.appendChild(toggle);
    } else {
      this.addMessage(text, 'user');
    }
    const convId = this._getConversationId();
    // Pin this prompt to the top of the viewport when its response starts
    // streaming. Consumed (and cleared) by startStreaming so only genuine
    // user sends anchor the view — heartbeat/automation/tool-only streams
    // leave the scroll position alone.
    this._pinPromptOnNextStream = true;
    // Track user-initiated sends on heartbeat tab so stream buffering doesn't swallow the response
    if (convId === 'vodou-heartbeat') this._userSentHeartbeat = true;
    // workbench:skill:<name> conversations route through skill_message →
    // chatWithSkill (SKILL.md as full system prompt). Server-side disk fallback
    // loads SKILL.md from skills_registry when skillContent isn't shipped.
    if (typeof convId === 'string' && convId.startsWith('workbench:skill:')) {
      const skillName = convId.slice('workbench:skill:'.length);
      this.ws.send(JSON.stringify({
        type: 'skill_message',
        content: text,
        conversationId: convId,
        skillName,
        ...(pendingAttachments.length ? { attachments: pendingAttachments } : {}),
      }));
    } else {
      this.ws.send(JSON.stringify({
        type: 'message',
        content: text,
        conversationId: convId,
        // PLAN-GATEWAY-PROJECTS — bind a NEW conversation to its tab's project (server
        // ignores this once a conversation already has a stored project). Use the active
        // TAB's project, not the global switcher, so a Default tab stays Default.
        project_id: (this._tabs.find((t) => t.id === this._activeTabId) || {}).projectId || this._getActiveProjectId(),
        ...(pendingAttachments.length ? { attachments: pendingAttachments } : {}),
      }));
    }

    // Auto-title the tab from first message
    this._autoTitleTab(text);
    if (!overrideText) {
      this.input.value = '';
      this._autoResizeInput();
    }
    this.sendBtn.disabled = true;
    this._showStopBtn();
    this.showTyping();
  },

  _showStopBtn() {
    if (this._stopBtn) return;
    const btn = document.createElement('button');
    btn.className = 'chat-stop-btn';
    btn.textContent = 'Stop';
    btn.title = 'Stop generation';
    btn.addEventListener('click', () => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'stop', conversationId: this._getConversationId() }));
      }
    });
    this._stopBtn = btn;
    // Insert next to send button
    this.sendBtn.parentNode.insertBefore(btn, this.sendBtn);
  },

  _hideStopBtn() {
    if (this._stopBtn) {
      this._stopBtn.remove();
      this._stopBtn = null;
    }
  },

  // Send switch_conversation after a seamless mid-stream resume so the server's
  // conversationId pointer catches up and history loads correctly.
  _flushPendingSwitch() {
    if (!this._pendingSwitch) return;
    const convId = this._pendingSwitch;
    this._pendingSwitch = null;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'switch_conversation', conversationId: convId }));
    }
  },

  // ============================================================
  // Message rendering
  // ============================================================

  getTime(dateStr) {
    const d = dateStr ? new Date(dateStr) : new Date();
    let h = d.getHours(), m = d.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
  },

  escapeHtml(t) {
    return (window.VodouSafe ? window.VodouSafe.escapeHtml(t)
      : String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  },

  escapeAttr(t) {
    return (window.VodouSafe ? window.VodouSafe.escapeAttr(t)
      : String(t == null ? '' : t)
        .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  },

  _autoResizeInput() {
    if (!this.input) return;
    // Grow to fit actual content height (including soft-wrapped long lines,
    // which a newline-count alone misses). Reset to auto first so shrinking
    // works, then clamp to the CSS max-height (240px) — past that the textarea
    // scrolls internally.
    const el = this.input;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 240) + 'px';
  },

  /**
   * Render markdown with rich interactive elements:
   * - Clickable `oi "..."` commands
   * - Code blocks with copy/run actions
   * - Stopping point menus as buttons
   */
  renderMarkdown(text) {
    const lensesOn = this._lensesEnabledForActiveConv();
    const md = lensesOn ? text : this._stripLensMarkdown(text);
    let html = this.escapeHtml(md);

    if (lensesOn) {
    // PLAN-CARDS-MVP — card fenced blocks come FIRST so the generic
    // code-fence handler below doesn't swallow them. ```card\n{JSON}\n```
    // becomes a placeholder div that endStreaming() mounts as a real card.
    // chat.js version stamp for cache-debug: 53 — base64 fix 2026-05-17
    // We BASE64-ENCODE the JSON for the attribute. HTML-entity escaping
    // proved unreliable (Chad reproduced raw JSON leaking through the
    // attribute boundary repeatedly — either entity decoding misfires or
    // some upstream pass touches the value). Base64 chars [A-Za-z0-9+/=]
    // can't break out of an HTML attribute, period. _renderLensSlots()
    // decodes via atob() on mount.
    html = html.replace(/```lens\s*\n([\s\S]*?)```/g, (m, body) => {
      // `body` was captured from the already-escapeHtml'd `html` (line above),
      // so it holds entities, NOT raw chars. escapeHtml used to skip " and ',
      // but the CONSOLE-AUDIT XSS sweep tightened it to escape [&<>"'] — so
      // `body` now contains &quot;/&#39; and the base64 below would carry
      // INVALID JSON, making JSON.parse fail at mount → the raw-JSON-leak.
      // Decode entities back to real chars here (decode &amp; LAST) so the
      // b64 payload is clean parseable JSON.
      const raw = body
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .trim();
      try {
        const b64 = btoa(unescape(encodeURIComponent(raw)));
        return '<div class="lens-pending" data-lens-block-b64="' + b64 + '" data-state="pending">[loading lens…]</div>';
      } catch (e) {
        return '<pre class="lens-block-invalid">' + this.escapeHtml(raw) + '</pre>';
      }
    });

    // PLAN-LENSES-MVP — during streaming, an UN-CLOSED ```lens\n... fence
    // would otherwise leak raw JSON into the visible chat (the closing
    // ``` hasn't arrived yet, so the regex above doesn't match). Mask the
    // open-fence-to-EOF region with a single "streaming lens" placeholder
    // until the close lands and the regex above takes over. The prose
    // before the fence opens is preserved as-is.
    html = html.replace(/```lens\s*\n[\s\S]*$/, '<div class="lens-pending" data-state="streaming">[lens streaming…]</div>');
    }

    // Code blocks (fenced) — wrap with action bar container
    // Mermaid blocks get special treatment — rendered as diagrams
    html = html.replace(/```(\w*)?\s*\n([\s\S]*?)```/g, (m, lang, code) => {
      const trimmed = code.trim();
      const langLabel = lang || '';

      // Mermaid diagram — use a placeholder, render after streaming completes
      // Encode newlines as ␊ in the data attribute so the \n→<br> replacement doesn't corrupt them
      if (/^mermaid$/i.test(langLabel)) {
        const encoded = trimmed.replace(/"/g, '&quot;').replace(/\n/g, '␊');
        return '<div class="mermaid-wrapper">' +
          '<div class="mermaid-actions">' +
          '<button class="code-action-btn" onclick="ChatView._copyCode(this)">Copy Source</button>' +
          '</div>' +
          '<div class="mermaid-pending" data-mermaid-code="' + encoded + '">' +
          '<code data-code="' + trimmed.replace(/"/g, '&quot;').replace(/\n/g, '␊') + '" class="is-hidden">' + trimmed + '</code>' +
          '<pre class="mermaid-rendering">Rendering diagram...</pre>' +
          '</div></div>';
      }

      const isShell = /^(bash|sh|shell|zsh|terminal)$/i.test(langLabel) || /^[\$#]\s/.test(trimmed);
      const runBtn = isShell
        ? '<button class="code-action-btn" onclick="ChatView._runCode(this)">Run</button>'
        : '';
      return '<div class="code-block-wrapper">' +
        '<div class="code-actions">' +
        '<button class="code-action-btn" onclick="ChatView._copyCode(this)">Copy</button>' +
        runBtn +
        '</div>' +
        '<pre><code data-code="' + trimmed.replace(/"/g, '&quot;') + '">' + trimmed + '</code></pre>' +
        '</div>';
    });

    // Inline code
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

    // Bold
    html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

    // Clickable oi commands: oi "..." or oi '...'
    html = html.replace(/oi\s+(&quot;|&amp;quot;)(.*?)\1/g, (m, q, cmd) => {
      const full = 'oi "' + cmd + '"';
      return '<span class="cmd-chip" onclick="ChatView._fillCommand(this)" data-cmd="' + full.replace(/"/g, '&quot;') + '">' + full + '</span>';
    });

    // Clickable vodou-core commands
    html = html.replace(/(\..\/vodou-core\s+[^\s<]+(?:\s+[^\s<]+)*)/g, (m, cmd) => {
      return '<span class="cmd-chip" onclick="ChatView._fillCommand(this)" data-cmd="' + cmd.replace(/"/g, '&quot;') + '">' + cmd + '</span>';
    });

    // Markdown links
    // XSS: the captured URL lands in a double-quoted href. escapeHtml already ran
    // on the whole string (~line 2304) so & is pre-encoded — quote-escape ONLY "
    // to stop attribute breakout (full escapeAttr would double-encode & and break
    // legit ?a=1&b=2 URLs). The label is likewise already-escaped.
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
      (_m, label, url) => '<a href="' + url.replace(/"/g, '&quot;') + '" target="_blank" rel="noopener">' + label + '</a>');

    // Bare URLs (not already in href)
    html = html.replace(/(^|[^"=])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');

    // Headers
    html = html.replace(/^#### (.+)$/gm, '<strong class="chat-h4">$1</strong>');
    html = html.replace(/^### (.+)$/gm, '<strong class="chat-h3">$1</strong>');
    html = html.replace(/^## (.+)$/gm, '<strong class="chat-h2">$1</strong>');
    html = html.replace(/^# (.+)$/gm, '<strong class="chat-h1">$1</strong>');

    // Horizontal rules
    html = html.replace(/^---+$/gm, '<hr class="chat-rule">');

    // Markdown tables
    html = html.replace(/^(\|.+\|)\s*\n(\|\s*[-:]+[-|:\s]*\|)\s*\n((?:\|.+\|\s*\n?)*)/gm, (match, headerRow, sepRow, bodyRows) => {
      const headers = headerRow.split('|').filter(c => c.trim());
      const rows = bodyRows.trim().split('\n').map(r => r.split('|').filter(c => c.trim()));
      let table = '<table class="chat-md-table">';
      table += '<tr>' + headers.map(h => '<th class="chat-md-th">' + h.trim() + '</th>').join('') + '</tr>';
      for (const row of rows) {
        table += '<tr>' + row.map(c => '<td class="chat-md-td">' + c.trim() + '</td>').join('') + '</tr>';
      }
      table += '</table>';
      return table;
    });

    // Inline images — detect file paths and URLs to images
    // file:///path/to/image.png or bare /path/to/image.png
    html = html.replace(/file:\/\/(\/[^\s<"']+\.(?:png|jpg|jpeg|gif|webp))/gi, (m, p) => {
      return this._inlineImage(p);
    });
    // Absolute file paths to images (not already in an href or src)
    html = html.replace(/(^|[^"=\/])(\/([\w.\-\/]+)\.(?:png|jpg|jpeg|gif|webp))/gim, (m, pre, fullPath) => {
      return pre + this._inlineImage(fullPath);
    });
    // data:image base64
    html = html.replace(/(data:image\/(?:png|jpeg|gif|svg\+xml|webp);base64,[A-Za-z0-9+\/=]+)/g, (m, dataUri) => {
      return '<img class="chat-image" src="' + dataUri + '" onclick="ChatView._openLightbox(this.src)" alt="image" />';
    });
    // https:// image URLs
    html = html.replace(/(https?:\/\/[^\s<"']+\.(?:png|jpg|jpeg|gif|svg|webp))(?=[<\s"']|$)/gi, (m, url) => {
      return '<img class="chat-image" src="' + url + '" onclick="ChatView._openLightbox(this.src)" alt="image" loading="lazy" />';
    });

    // Bullet lists
    html = html.replace(/^- (.+)$/gm, '• $1');

    // Stopping point menus — detect numbered option lists
    html = this._renderStoppingPoints(html);

    // Line breaks
    html = html.replace(/\n/g, '<br>');
    return html;
  },

  /**
   * Detect and render numbered option menus as interactive buttons.
   * Works on post-markdown HTML — handles <strong>, emojis, etc.
   *
   * Strategy: find blocks of 2+ sequential numbered lines AND require a
   * menu-intent signal phrase ("pick one", "next step", "reply with", etc.)
   * within 3 lines before or after the block. Prevents informational numbered
   * lists (reviews, plans, summaries) from rendering as clickable buttons.
   * Processes from bottom-up so we catch multiple menus in one response.
   */
  _renderStoppingPoints(html) {
    const lines = html.split('\n');
    const menuBlocks = []; // collect { startIdx, endIdx, options[] }

    const SIGNAL_RE = /(reply with|pick (?:a number|one)|choose (?:one|an?)|which (?:would|option|one)|next steps?|your (?:choice|options?|picks?)|select (?:one|an?)|what would you like|how would you like|your pick)/i;
    const stripTags = (s) => s.replace(/<[^>]+>/g, ' ');
    const hasMenuSignal = (start, end) => {
      for (let i = Math.max(0, start - 3); i < start; i++) {
        if (SIGNAL_RE.test(stripTags(lines[i] || ''))) return true;
      }
      for (let i = end + 1; i < Math.min(lines.length, end + 4); i++) {
        if (SIGNAL_RE.test(stripTags(lines[i] || ''))) return true;
      }
      return false;
    };

    let currentOptions = [];
    let blockStartIdx = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // Match: "1. text" or "1) text" — allow leading HTML tags, emojis, bullets, etc.
      const optMatch = line.match(/^(?:<[^>]+>)*\s*(\d+)[\.\)]\s+(.+)/);
      if (optMatch) {
        if (currentOptions.length === 0) blockStartIdx = i;
        // XSS: label is sliced from already-escapeHtml'd markdown and lands in a
        // <span> innerHTML below — do NOT entity-decode it (that re-introduces the
        // XSS escapeHtml already neutralized). Keep only the legit <strong> strip.
        const label = optMatch[2]
          .replace(/<\/?strong>/g, '');
        currentOptions.push({ num: optMatch[1], label, lineIdx: i });
      } else if (line === '') {
        // Blank line — allow spacing within option blocks
      } else {
        // Non-option line — finalize block if we have enough AND signal is nearby
        if (currentOptions.length >= 2) {
          const endIdx = currentOptions[currentOptions.length - 1].lineIdx;
          if (hasMenuSignal(blockStartIdx, endIdx)) {
            menuBlocks.push({ startIdx: blockStartIdx, endIdx, options: [...currentOptions] });
          }
        }
        currentOptions = [];
        blockStartIdx = -1;
      }
    }
    // Catch trailing block at end of text
    if (currentOptions.length >= 2) {
      const endIdx = currentOptions[currentOptions.length - 1].lineIdx;
      if (hasMenuSignal(blockStartIdx, endIdx)) {
        menuBlocks.push({ startIdx: blockStartIdx, endIdx, options: [...currentOptions] });
      }
    }

    if (menuBlocks.length === 0) return html;

    // Process blocks bottom-up so indices stay valid
    for (let b = menuBlocks.length - 1; b >= 0; b--) {
      const block = menuBlocks[b];
      let buttons = '<div class="stopping-point-menu">';
      for (const opt of block.options) {
        buttons += '<button class="sp-button" onclick="ChatView._selectOption(this, \'' + opt.num + '\')">' +
          '<span class="sp-number">' + opt.num + '</span>' +
          '<span>' + opt.label + '</span>' +
          '</button>';
      }
      buttons += '</div>';

      // Clean up "Reply with..." / "Pick a number..." footer if it follows
      const afterIdx = block.endIdx + 1;
      if (afterIdx < lines.length) {
        lines[afterIdx] = lines[afterIdx].replace(/^\s*(?:<[^>]*>)*\s*(?:Reply with[\s\S]*?[\d.!]|Pick a number[^!]*!?|Pick one[^!]*!?)\.?\s*$/i, '');
      }

      // Replace option lines with buttons
      lines.splice(block.startIdx, block.endIdx - block.startIdx + 1, buttons);
    }

    return lines.join('\n');
  },

  /** Show an inline tool form in the chat */
  async _showToolFormInChat(server, tool) {
    if (typeof InlineForms === 'undefined') return;

    const form = await InlineForms.showForTool(server, tool, {},
      async (params) => {
        const argsJson = JSON.stringify(params);
        this.sendMessage(`./vodou-core call ${server} ${tool} '${argsJson}'`);
      },
      null
    );

    if (form) {
      const el = this.createMsgEl('Server', 'tool-name', 'tool-av', '⚙', '', '');
      el.content.appendChild(form);
      this.messagesEl.appendChild(el.msg);
      this.scrollToBottom();
      const firstInput = form.querySelector('.tf-input, .tf-textarea, .tf-select');
      if (firstInput) firstInput.focus();
    } else {
      this.addMessage('No input schema found for ' + server + '/' + tool, 'system');
    }
  },

  // ============================================================
  // Chat Tabs
  // ============================================================

  // Buffer events for background tabs so work continues while you're on another tab
  _tabEventBuffers: {},  // conversationId → [event, event, ...]
  _tabStreamAccum:  {},  // conversationId → full streamed text captured while tab is in background

  _bufferEvent(event) {
    const convId = event.conversationId;
    if (!convId) return;
    if (!this._tabEventBuffers[convId]) this._tabEventBuffers[convId] = [];
    this._tabEventBuffers[convId].push(event);
  },

  _replayBufferedEvents(conversationId) {
    const events = this._tabEventBuffers[conversationId];
    if (!events || events.length === 0) return;
    delete this._tabEventBuffers[conversationId];

    // Replay buffered events: user messages from channels + assistant chunks
    let fullText = '';
    for (const ev of events) {
      if (ev.type === 'channel_user_message') {
        const chLabel = ev.senderName ? { senderLabel: ev.senderName } : {};
        if (ev.source === 'slack' && ev.conversationId && ev.senderName) {
          const tab = this._tabs.find(t => t.conversationId === ev.conversationId);
          if (tab) {
            tab.title = ('Slack · ' + String(ev.senderName)).substring(0, 80);
            this._saveTabs();
            this._renderTabs();
          }
        }
        this.addMessage(ev.content, 'user', undefined, chLabel);
      } else if (ev.type === 'chunk') {
        fullText += ev.content || '';
      }
    }

    // Replay thinking events
    const thinkingStarts = events.filter(ev => ev.type === 'thinking_start');
    const thinkingSteps = events.filter(ev => ev.type === 'thinking_step');
    const thinkingCompletes = events.filter(ev => ev.type === 'thinking_complete');
    for (const ev of thinkingStarts) {
      this._startThinkingSection(ev.sessionId, ev.topic, ev.estimatedSteps);
    }
    for (const ev of thinkingSteps) {
      this._addThinkingStep(ev.sessionId, ev.thoughtNumber, ev.totalThoughts, ev.thought);
    }
    for (const ev of thinkingCompletes) {
      this._completeThinkingSection(ev.sessionId);
    }

    // Render the accumulated assistant response as a single message
    if (fullText) {
      this.addMessage(fullText, 'assistant');
    }

    // Check if it finished (done event was in buffer)
    const doneEvent = events.find(e => e.type === 'done' || e.type === 'stopped' || e.type === 'error');
    if (doneEvent) {
      if (doneEvent.type === 'error' && doneEvent.message) {
        this.addMessage('Error: ' + doneEvent.message, 'system');
      }
      this._hideStopBtn();
      this.sendBtn.disabled = false;
      if (doneEvent.activeModel) this._updateModelIndicator(doneEvent.activeModel);
    }

    // Replay any parked approval cards (higher-stakes than tool chips — the
    // user needs to act, so surface them on tab switch rather than drop them).
    for (const ev of events.filter(e => e.type === 'approval_requested')) {
      this._showApprovalCard(ev);
    }
  },

  // Bet #2 Phase 2b — render an approve/deny card for a parked ('ask') tool.
  // The buttons POST the single-use token to /chat/approve; the result comes
  // back in the HTTP response (the run is not re-streamed), so we update the
  // card in place. Idempotent per token (a duplicate event won't double-render).
  _showApprovalCard(data) {
    if (!data || !data.token) return;
    this._approvalCards = this._approvalCards || {};
    if (this._approvalCards[data.token]) return; // already shown
    this._injectApprovalStyles();

    const esc = (s) => this.escapeHtml(String(s == null ? '' : s));
    const tool = data.tool || 'tool';
    const category = data.category || 'action';
    const convId = data.conversationId || this._getConversationId();

    // Compact args preview (server already truncated long strings to "…[N chars]").
    let argsHtml = '';
    const args = data.args && typeof data.args === 'object' ? data.args : null;
    if (args) {
      const rows = Object.keys(args).slice(0, 6).map((k) => {
        const v = args[k];
        const vs = (v && typeof v === 'object') ? JSON.stringify(v) : String(v);
        return '<div class="approval-arg"><span class="approval-arg-k">' + esc(k) +
          '</span><span class="approval-arg-v">' + esc(vs.slice(0, 240)) + '</span></div>';
      }).join('');
      if (rows) argsHtml = '<div class="approval-card-args">' + rows + '</div>';
    }

    const card = document.createElement('div');
    card.className = 'approval-card';
    card.dataset.token = data.token;
    card.innerHTML =
      '<div class="approval-card-head">' +
        '<span class="approval-card-icon">⚠️</span>' +
        '<span class="approval-card-title">Approval needed</span>' +
        '<span class="approval-card-cat">' + esc(category) + '</span>' +
      '</div>' +
      '<div class="approval-card-body">The assistant wants to run <code>' + esc(tool) + '</code>.</div>' +
      argsHtml +
      '<div class="approval-card-btns">' +
        '<button type="button" class="approval-btn approval-btn-deny" data-decision="deny">Deny</button>' +
        '<button type="button" class="approval-btn approval-btn-approve" data-decision="approve">Approve</button>' +
      '</div>' +
      '<div class="approval-card-result" hidden></div>';

    this.messagesEl.appendChild(card);
    this.scrollToBottom();
    this._approvalCards[data.token] = card;

    let submitting = false;
    const resultEl = card.querySelector('.approval-card-result');
    const btns = card.querySelectorAll('.approval-btn');
    const finish = (cls, text) => {
      card.classList.add('resolved');
      btns.forEach((b) => { b.disabled = true; });
      card.querySelector('.approval-card-btns').hidden = true;
      resultEl.hidden = false;
      resultEl.className = 'approval-card-result ' + cls;
      resultEl.textContent = text;
      this.scrollToBottom();
    };

    btns.forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (submitting) return;
        submitting = true;
        const decision = btn.dataset.decision;
        btns.forEach((b) => { b.disabled = true; });
        btn.textContent = decision === 'approve' ? 'Approving…' : 'Denying…';
        try {
          const r = await API.post('/chat/approve', { conversationId: convId, token: data.token, decision });
          if (decision === 'deny') {
            finish('denied', '✕ Denied — ' + tool + ' was not run.');
          } else if (r && r.success === false) {
            finish('failed', '⚠️ Approved, but ' + tool + ' failed: ' + (r.error || 'unknown error'));
          } else {
            const out = (r && (r.output || '')).toString().slice(0, 400);
            finish('approved', '✓ Approved — ' + tool + (out ? ': ' + out : ' ran.'));
          }
        } catch (err) {
          const status = err && err.status;
          const msg = (err && err.message) || String(err);
          if (status === 404 || /no pending approval/i.test(msg)) {
            // Token expired / already handled / gateway restarted — terminal.
            finish('failed', '⚠️ This approval is no longer valid (expired or already handled).');
          } else {
            // Transient (network / 5xx) — re-enable so the user can retry.
            resultEl.hidden = false;
            resultEl.className = 'approval-card-result failed';
            resultEl.textContent = '⚠️ Could not submit (' + msg + '). Try again.';
            btns.forEach((b) => { b.disabled = false; });
            btn.textContent = decision === 'approve' ? 'Approve' : 'Deny';
            submitting = false;
            this.scrollToBottom();
          }
        }
      });
    });
  },

  _injectApprovalStyles() {
    if (this._approvalStylesInjected) return;
    this._approvalStylesInjected = true;
    const css =
      '.approval-card{border:1px solid var(--border-primary);border-left:3px solid #f59e0b;' +
        'border-radius:8px;padding:12px 14px;margin:10px 0;background:var(--surface-2,rgba(245,158,11,0.06));max-width:680px;}' +
      '.approval-card.resolved{border-left-color:var(--border-primary);opacity:0.85;}' +
      '.approval-card-head{display:flex;align-items:center;gap:8px;font-weight:600;margin-bottom:6px;}' +
      '.approval-card-cat{margin-left:auto;font-size:11px;font-weight:500;padding:2px 8px;border-radius:10px;' +
        'background:rgba(245,158,11,0.18);color:#f59e0b;text-transform:lowercase;}' +
      '.approval-card-body{font-size:13px;margin-bottom:6px;}' +
      '.approval-card-body code{background:rgba(127,127,127,0.18);padding:1px 5px;border-radius:4px;}' +
      '.approval-card-args{font-size:12px;font-family:var(--font-mono,monospace);background:var(--code-bg);' +
        'border-radius:6px;padding:6px 8px;margin-bottom:8px;max-height:160px;overflow:auto;}' +
      '.approval-arg{display:flex;gap:8px;padding:1px 0;}' +
      '.approval-arg-k{color:#9ca3af;min-width:90px;flex-shrink:0;}' +
      '.approval-arg-v{white-space:pre-wrap;word-break:break-word;}' +
      '.approval-card-btns{display:flex;gap:8px;justify-content:flex-end;}' +
      '.approval-btn{cursor:pointer;border:none;border-radius:6px;padding:6px 16px;font-size:13px;font-weight:600;}' +
      '.approval-btn:disabled{cursor:default;opacity:0.6;}' +
      '.approval-btn-approve{background:#16a34a;color:#fff;}' +
      '.approval-btn-deny{background:transparent;color:#ef4444;border:1px solid #ef4444;}' +
      '.approval-card-result{font-size:13px;margin-top:4px;}' +
      '.approval-card-result.approved{color:#16a34a;}' +
      '.approval-card-result.denied{color:#9ca3af;}' +
      '.approval-card-result.failed{color:#ef4444;}';
    const styleEl = document.createElement('style');
    styleEl.textContent = css;
    document.head.appendChild(styleEl);
  },

  _initTabs() {
    this._tabs = [];           // { id, title, conversationId }
    this._skillConsoleMeta = Object.create(null); // conversationId → /api/skill-console/meta row
    this._activeTabId = null;
    this._tabMessages = {};    // conversationId → saved innerHTML
    this._tabStreamAccum = {}; // conversationId → accumulated text while streaming in background
    this._pendingSwitch = null;
    this._tabBar = document.getElementById('chat-tabs');
    this._messagingTabBar = document.getElementById('chat-tabs-messaging');
    this._messagingTierWrap = document.getElementById('chat-tabs-messaging-wrap');
    this._integrationTabBar = document.getElementById('chat-tabs-apps');
    this._appsTierWrap = document.getElementById('chat-tabs-apps-wrap');
    this._skillsTabBar = document.getElementById('chat-tabs-skills');
    this._skillsTierWrap = document.getElementById('chat-tabs-skills-wrap');
    this._bindTabTierHeaders();
    this._initDockOverflow();

    // Re-render messaging + apps tiers whenever surfaced workbenches change
    if (typeof WorkbenchSurfaces !== 'undefined') {
      WorkbenchSurfaces.onChange(() => this._renderIntegrationTabs());
      // Recover expert personas whose surfacing was lost with localStorage.
      // Fire-and-forget: each add() fires onChange above, so the Skills tier
      // renders as they land — no need to await before the rest of init.
      if (typeof WorkbenchSurfaces.seedSkillsOnce === 'function') {
        const skillsBefore = WorkbenchSurfaces.list()
          .filter((e) => (e.scope || '').startsWith('workbench:skill:')).length;
        WorkbenchSurfaces.seedSkillsOnce().then(() => {
          const skillsAfter = WorkbenchSurfaces.list()
            .filter((e) => (e.scope || '').startsWith('workbench:skill:')).length;
          // Only force the tier open when recovery actually restored something.
          // The tier defaults to collapsed, and a silently-collapsed group is
          // indistinguishable from the bug we just fixed.
          if (skillsAfter > skillsBefore) {
            try { localStorage.setItem(this._tabTierLsKeySkills, '0'); } catch {}
            this._renderIntegrationTabs();
          }
        });
      }
    }

    // Restore tabs from localStorage or create initial tab
    try {
      const saved = JSON.parse(localStorage.getItem('vodou-chat-tabs') || 'null');
      if (saved && saved.tabs && saved.tabs.length > 0) {
        // Migrate: strip SVG markup from tab titles (legacy format stored SVG+text)
        for (const tab of saved.tabs) {
          if (tab.title && tab.title.includes('<svg')) {
            tab.title = tab.title.replace(/<svg[^>]*>[\s\S]*?<\/svg>\s*/g, '').trim() || tab.source || 'Chat';
          }
        }
        // Migrate: collapse legacy per-task board windows. Board output now streams
        // to a single 'board-chat' tab; drop any stale 'board-task-<id>' /
        // 'workbench:board-worker:<id>' tabs left in localStorage from older builds,
        // and de-dupe 'board-chat' so only one Board window ever exists.
        let migrated = saved.tabs.filter(t => {
          const cid = t.conversationId || '';
          const src = t.source || '';
          // Drop stale per-task board windows, board-worker windows, and any
          // skill-curriculum practice tab persisted from before the gateway fix
          // (those were mislabeled source='heartbeat' and rendered as a phantom
          // second Briefing/heartbeat tab). Curriculum runs are background work.
          //
          // Also purge every non-chat source that older builds let into the
          // Messaging tier (see _isDockExcludedSource): capture:*/import:* memory
          // buffers and openai-compat BYOK API sessions. The server stopped
          // listing captures in conversations_list (loadConversations'
          // `NOT LIKE 'capture:%'`) and the BYOK rows aged out of its 7-day
          // window, but tabs hydrated BEFORE that live in localStorage forever —
          // one per captured IDE session, hundreds of them. localStorage is the
          // only place they can be removed from.
          return !cid.startsWith('board-task-')
            && !cid.startsWith('workbench:board-worker:')
            && !cid.startsWith('curriculum-practice-')
            && !this._isDockExcludedSource(src)
            && t.source !== 'curriculum';
        });
        const seenBoardChat = new Set();
        migrated = migrated.filter(t => {
          if (t.conversationId !== 'board-chat') return true;
          if (seenBoardChat.has(1)) return false;
          seenBoardChat.add(1);
          return true;
        });
        // Collapse unused "New Chat" shells — a persisted default-titled web chat
        // is a never-used new-tab placeholder. Keep at most one (the active, else
        // the most recent) so they don't accumulate as a row of "NC" tiles. Real
        // chats with content re-surface from the DB via _hydrateTabsFromDb.
        const isDefaultShell = (t) =>
          (!t.source || t.source === 'web') && !t.pinned &&
          /^(new chat|chat\s*\d*)$/i.test((t.title || '').trim());
        const shells = migrated.filter(isDefaultShell);
        if (shells.length > 1) {
          const keepId = shells.some((t) => t.id === saved.activeTabId)
            ? saved.activeTabId
            : shells[shells.length - 1].id;
          migrated = migrated.filter((t) => !isDefaultShell(t) || t.id === keepId);
        }
        const removedCount = saved.tabs.length - migrated.length;
        // Rename the heartbeat tab's legacy 'BRIEFING' label → 'Heartbeat'.
        let renamed = 0;
        for (const t of migrated) {
          if (t.conversationId === 'vodou-heartbeat' && (t.title === 'BRIEFING' || !t.title)) {
            t.title = 'Heartbeat'; renamed++;
          }
        }
        this._tabs = migrated;
        const activeStillValid = this._tabs.some(t => t.id === saved.activeTabId);
        this._activeTabId = activeStillValid ? saved.activeTabId : (this._tabs[0] && this._tabs[0].id) || null;
        if (removedCount > 0 || renamed > 0) {
          try { localStorage.setItem('vodou-chat-tabs', JSON.stringify({ tabs: this._tabs, activeTabId: this._activeTabId })); } catch {}
          if (removedCount > 0) console.log('[board] migrated away ' + removedCount + ' stale per-task board tab(s)');
        }
      }
    } catch {}

    if (this._tabs.length === 0) {
      this._addTab(false); // create first tab without rendering
    }

    // Ensure pinned Vodou heartbeat tab exists (always first)
    const vodouExists = this._tabs.some(t => t.conversationId === 'vodou-heartbeat');
    if (!vodouExists) {
      this._tabs.unshift({
        id: 'tab-vodou',
        title: 'Heartbeat',
        conversationId: 'vodou-heartbeat',
        source: 'heartbeat',
        pinned: true,
      });
      this._saveTabs();
    }

    this._renderTabs();
    this._updateHeartbeatBriefingChromeVisibility();

    // Load today strip if starting on Vodou tab
    const activeTab = this._tabs.find(t => t.id === this._activeTabId);
    if (activeTab && (activeTab.source === 'heartbeat' || activeTab.conversationId === 'vodou-heartbeat')) {
      setTimeout(() => this._loadTodayStrip(), 500);
    }
    // Render the scope header if initial tab is a channel workbench.
    if (activeTab) setTimeout(() => this._renderScopeHeader(activeTab), 0);
    setTimeout(() => this._refreshSkillConsoleMeta(), 0);
    if (!this._skillMetaTick) {
      this._skillMetaTick = setInterval(() => {
        if (this._tabs.some(t => t.source === 'skill-console')) this._refreshSkillConsoleMeta();
      }, 120000);
    }
  },

  /**
   * Merge DB conversations into tabs — fills in anything not in localStorage.
   * Called on WebSocket connect with the full conversations_list from gateway.db.
   */
  _hydrateTabsFromDb(conversations) {
    if (!conversations || conversations.length === 0) return;

    const existingConvIds = new Set(this._tabs.map(t => t.conversationId));
    let added = false;

    for (const conv of conversations) {
      if (existingConvIds.has(conv.id)) continue;
      // Skip empty conversations (no messages) — except skill console
      // conversations, which the user explicitly created and expects to see
      // as a tab even before sending the first message.
      if (conv.messageCount === 0 && conv.source !== 'skill-console') continue;
      // Don't surface abandoned / failed default-titled chats as persistent dock
      // tabs (the "NC" pile-up). A real chat the user wants back has either a
      // completed turn (user + assistant ≥ 2 messages) or a title they/we gave it;
      // a lone "New Chat" with one stray message is noise. Skill consoles + named
      // chats are unaffected.
      const isDefaultTitle = !conv.title || /^(new chat|chat\s*\d*)$/i.test(String(conv.title).trim());
      if (conv.source !== 'skill-console' && isDefaultTitle && conv.messageCount < 2) continue;
      // Skip workbench-scoped conversations — except `workbench:channel:*`,
      // which collapses all inbound channel traffic into one conversation per
      // channel type and IS surfaced as a main chat tab (Apps parity).
      if (conv.source && conv.source.startsWith('workbench:') && !conv.id.startsWith('workbench:channel:')) continue;
      // Skip per-task board worker conversations. Board output surfaces in the
      // SINGLE `board-chat` tab; `board-task-<id>` / `workbench:board-worker:<id>`
      // are isolated per-task LLM context and must NEVER become their own window.
      if (conv.id.startsWith('board-task-') || conv.id.startsWith('workbench:board-worker:')) continue;
      // Skip autonomous skill-curriculum practice runs — background trajectory
      // capture, never a user-facing chat tab. (Also defends against legacy rows
      // mislabeled source='heartbeat' before the gateway fix, hence the id check.)
      if (conv.source === 'curriculum' || conv.id.startsWith('curriculum-practice-')) continue;
      // Captures, imports, BYOK API sessions and curriculum runs are not chats.
      // The server already filters captures out of conversations_list; this is
      // the client-side half of the same invariant, so a surface that ever
      // passes includeCaptures (or a BYOK row inside the 7-day window) can't
      // repopulate the dock with hundreds of capture:ide:* tiles.
      if (this._isDockExcludedSource(conv.source)) continue;

      const channelNames = { telegram: 'Telegram', slack: 'Slack', discord: 'Discord', teams: 'Teams', googlechat: 'Google Chat', signal: 'Signal', whatsapp: 'WhatsApp', imessage: 'iMessage', voice: 'Voice', web: 'Web' };
      // PLAN-SKILL-CONSOLE-LOOP §33 — skill console conversations are LLM-created
      // skills with their own chat tab. Use conv.title (the display_name, often
      // with an emoji like ☀️) instead of treating them like channels.
      const isSkillConsole = conv.source === 'skill-console';
      const isChannel = !isSkillConsole && conv.source && conv.source !== 'web';
      // Known channels (Slack, Telegram, …) collapse to one workbench
      // conversation each, so the friendly name IS the tab and stays.
      //
      // Unknown channels — anything a channel SDK package registered — get one
      // conversation PER thread, so labelling them all by raw source produced a
      // wall of identical tiles (eight 'testchannel'). Prefer the DB title, but
      // only when it actually discriminates: these rows are created with
      // `title = senderName`, so every thread from one person carries the same
      // title ('Chad'). When the title is just the sender again, the id is the
      // only distinct thing we have ('env-fix-2', 'envA1').
      const channelLabel = () => {
        if (channelNames[conv.source]) return channelNames[conv.source];
        const t = (conv.title || '').trim();
        const sender = (conv.senderName || '').trim();
        if (t && t !== sender && t !== conv.source) return t;
        return conv.id || conv.source;
      };
      const title = isSkillConsole
        ? (conv.title || 'Skill')
        : isChannel
          ? channelLabel()
          : conv.title || 'Chat';

      this._tabs.push({
        id: 'tab-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
        title,
        conversationId: conv.id,
        source: conv.source || 'web',
        projectId: conv.project_id || 'proj_default',
      });
      added = true;
    }

    if (added) {
      this._saveTabs();
      this._renderTabs();
    }
  },

  _generateTabId() {
    return 'tab-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6);
  },

  _addTab(switchTo = true) {
    const id = this._generateTabId();
    const convId = 'conv-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
    const num = this._tabs.length + 1;
    // PLAN-GATEWAY-PROJECTS — a new chat belongs to the active project.
    const tab = { id, title: 'Chat ' + num, conversationId: convId, projectId: this._getActiveProjectId() };
    this._tabs.push(tab);

    if (switchTo) {
      this._switchTab(id);
    } else {
      this._activeTabId = id;
    }

    this._saveTabs();
    this._renderTabs();
    return tab;
  },

  _switchTab(tabId) {
    // Global tab bar: click from any route should navigate to #/chat first
    // so the chat container becomes visible. We still run the switch so
    // conversation state/history is loaded by the time the route arrives.
    const hashPath = (location.hash || '').split('?')[0];
    if (hashPath !== '#/chat' && hashPath !== '') {
      location.hash = '#/chat';
      // fall through — continue with the switch so history hydrates in parallel
    }

    // Already on this tab — still ensure #/chat is active so the panel stays
    // visible (e.g. user clicked a dock tab while on #/heartbeat or #/memory).
    if (tabId === this._activeTabId) {
      if (hashPath !== '#/chat' && hashPath !== '') location.hash = '#/chat';
      return;
    }

    // Switching to a tab is an explicit "show me this conversation" — re-arm
    // sticking so its history snaps to the bottom even if the user had scrolled
    // up in the previous tab.
    this._stickToBottom = true;

    // Save current tab's messages
    const currentTab = this._tabs.find(t => t.id === this._activeTabId);
    if (currentTab && this.messagesEl) {
      if (this.currentMessage) {
        // Mid-stream: snapshot the accumulated text so we can resume seamlessly,
        // and save the message list WITHOUT the in-progress bubble so the restore
        // point is clean (prior messages only, no half-finished response).
        this._tabStreamAccum[currentTab.conversationId] = this.currentMessage._rawText || '';
        const streamBubble = this.currentMessage.closest('.message');
        if (streamBubble) {
          streamBubble.remove();
          this._tabMessages[currentTab.conversationId] = this.messagesEl.innerHTML;
          this.messagesEl.appendChild(streamBubble);
        } else {
          this._tabMessages[currentTab.conversationId] = this.messagesEl.innerHTML;
        }
      } else {
        this._tabMessages[currentTab.conversationId] = this.messagesEl.innerHTML;
      }
    }

    // Release streaming reference so the incoming tab can stream normally.
    // Background chunks accumulate in _tabStreamAccum for seamless resume.
    if (this.currentMessage) {
      this.currentMessage = null;
      this._hideStopBtn();
      if (this.sendBtn) this.sendBtn.disabled = false;
    }

    // Switch
    this._activeTabId = tabId;
    const newTab = this._tabs.find(t => t.id === tabId);
    if (!newTab) return;

    // Show cached messages instantly (if available), then request server history
    if (this._tabMessages[newTab.conversationId]) {
      this.messagesEl.innerHTML = this._tabMessages[newTab.conversationId];
      this._schedulePinnedPromptUpdate();
      this._scrollToBottomAfterLayout();
    } else {
      this.messagesEl.innerHTML = '';
    }

    // Decide whether to resume a live stream or do the standard replay+history path
    const _swBuf   = this._tabEventBuffers[newTab.conversationId] || [];
    const _swAccum = this._tabStreamAccum[newTab.conversationId] || '';
    const _swDone  = _swBuf.some(e => e.type === 'done' || e.type === 'stopped' || e.type === 'error');

    if (_swAccum && !_swDone) {
      // Stream still live — resume directly into a streaming bubble so the user
      // sees continuous output rather than a static-replay flash + history wipe.
      delete this._tabEventBuffers[newTab.conversationId];
      delete this._tabStreamAccum[newTab.conversationId];
      this.startStreaming();
      if (_swAccum.trim()) {
        this._phaseClear();
        this.currentMessage._rawText = _swAccum;
        this.currentMessage.innerHTML = this.renderMarkdown(_swAccum);
        this.scrollToBottom();
      }
      // Server still routes via activeConvId — skip switch_conversation here.
      // _pendingSwitch fires a history sync once endStreaming() completes.
      this._pendingSwitch = newTab.conversationId;
    } else {
      // Stream finished or no background stream — static replay then fresh history.
      // Clear any pending switch — this explicit switch_conversation supersedes it.
      this._pendingSwitch = null;
      this._replayBufferedEvents(newTab.conversationId);
      delete this._tabStreamAccum[newTab.conversationId];
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'switch_conversation',
          conversationId: newTab.conversationId,
        }));
      }
    }

    this._saveTabs();
    this._renderTabs();

    if (this._isPrimaryConversationTab(newTab)) {
      this._collapseMessagingAndAppsTiers();
    }

    // I6: Show today strip for Vodou heartbeat tab
    if (newTab.source === 'heartbeat' || newTab.conversationId === 'vodou-heartbeat') {
      this._loadTodayStrip();
      // A5f: clear unread badge
      const tabEl = document.querySelector('[data-conversation-id="vodou-heartbeat"]');
      const badge = tabEl && tabEl.querySelector('.tab-unread');
      if (badge) badge.remove();
      // A5g: update input placeholder
      if (this.input) this.input.placeholder = 'Reply to this briefing...';
    } else {
      this._hideTodayStrip();
      if (this.input) this.input.placeholder = 'Message Vodou...';
    }

    // URL sync for channel workbench tabs so the sidebar highlights the active channel.
    // Guarded to avoid recursion — hashchange doesn't retrigger _switchTab
    // because _maybeHandleChannelRoute checks `existing.id !== activeTabId`.
    try {
      const wantedHash = newTab.conversationId && newTab.conversationId.startsWith('workbench:channel:')
        ? `#/chat?channel=${newTab.source}`
        : '#/chat';
      const currentHash = location.hash || '';
      if (currentHash !== wantedHash && currentHash.split('?')[0] === '#/chat') {
        // Use replaceState so we don't pollute browser history with tab clicks.
        const base = location.href.split('#')[0];
        history.replaceState(null, '', base + wantedHash);
        // Manually trigger sidebar rerender since replaceState doesn't fire hashchange.
        if (window.ChannelsView && ChannelsView._lastStatuses) {
          ChannelsView.renderSidebarChannels(ChannelsView._lastStatuses, ChannelsView._lastStandalone);
        }
        if (typeof Router !== 'undefined' && typeof Router.syncNavFromHash === 'function') {
          Router.syncNavFromHash();
        }
      }
    } catch {}

    // Chat-window scope header (mirrors Apps' .sw-header + .sw-tool-rail).
    // Shows the channel icon, display name, scope badge, and a horizontal
    // row of tool chips that prefill the main chat input on click.
    this._renderScopeHeader(newTab);

    this._updateHeartbeatBriefingChromeVisibility();
  },

  /**
   * Paint the in-chat scope header for a channel workbench tab. Matches
   * Apps workbench chrome visually — same header icon + title +
   * scope badge + tool chips. Tool click prefills `#chat-input`.
   *
   * Hidden for non-channel tabs (briefing, web chat, heartbeat).
   */
  async _renderScopeHeader(tab) {
    const host = document.getElementById('chat-scope-header');
    if (!host) return;
    if (!tab) {
      host.classList.add('is-hidden');
      host.innerHTML = '';
      return;
    }
    const esc = (s) => window.VodouSafe.escapeHtml(s);
    const convId = String(tab.conversationId || '');
    const isSkillConsoleTab = convId.startsWith('workbench:skill-console:');
    const isChannelWorkbench = convId.startsWith('workbench:channel:');
    const isIntegrationWorkbench = convId.startsWith('workbench:integration:');
    const isSkillWorkbench = convId.startsWith('workbench:skill:');
    const isAutomationWorkbench = convId.startsWith('workbench:automation:');
    const isAnyWorkbench = isChannelWorkbench || isIntegrationWorkbench || isSkillWorkbench || isAutomationWorkbench;

    // ── Non-channel tabs: render a uniform title bar ─────────────────────────
    if (!isChannelWorkbench) {
      try {
        let iconHtml = '';
        let displayName = (tab.title || 'Vodou').trim();
        let actions = '';

        if (isAnyWorkbench && window.ScopeRegistry) {
          const descriptor = await window.ScopeRegistry.resolve(convId).catch(() => null);
          if (descriptor) {
            iconHtml = descriptor.iconHtml || '';
            displayName = descriptor.displayName || displayName;
          }
        }

        // Integration workbench → Manage opens the integration modal in #/apps
        if (isIntegrationWorkbench) {
          const appId = convId.slice('workbench:integration:'.length);
          actions = `<button type="button" class="sw-manage-btn" data-app="${esc(appId)}" title="Manage ${esc(displayName)}">Manage</button>`;
        }

        // Primary chat tab — per-tab identity (avatar default, picker overrides), editable title
        const isPrimaryChat = !isAnyWorkbench;
        if (isPrimaryChat) {
          const id = this._identityForTab(tab);
          if (id.kind === 'svg') {
            iconHtml = `<span class="sw-icon-emoji sw-icon-svg" data-tab-id="${esc(tab.id)}" title="Click to change icon">${id.html}</span>`;
          } else if (id.kind === 'emoji') {
            iconHtml = `<span class="sw-icon-emoji" data-tab-id="${esc(tab.id)}" title="Click to change icon">${esc(id.text)}</span>`;
          } else {
            // The title bar always represents the CURRENT chat, so its letter
            // avatar is gold — tying it to the active gold pill in the dock.
            // CSS owns the color (no per-tab hashed rainbow).
            iconHtml = `<span class="sw-icon-emoji sw-icon-avatar" data-tab-id="${esc(tab.id)}" title="Click to change icon">${esc(id.text)}</span>`;
          }
        } else if (isSkillWorkbench) {
          // Skill (subagent) — same priority chain as the dock so they can't diverge:
          //   1) WorkbenchSurfaces entry.icon (persisted, raw emoji only)
          //   2) tab.icon in-memory override
          //   3) deterministic person from skill id hash
          const skillId = (/^workbench:skill:(.+)$/.exec(convId) || [])[1] || convId;
          let personIcon = null;
          if (typeof WorkbenchSurfaces !== 'undefined') {
            const surfaceEntry = WorkbenchSurfaces.list().find(e => e.scope === convId);
            const ent = String(surfaceEntry?.icon || '').trim();
            if (ent && !ent.startsWith('<')) personIcon = ent;
          }
          if (!personIcon && tab.icon && !this._isSvgIcon(tab.icon)) personIcon = tab.icon;
          if (!personIcon) personIcon = this._personIconForSkill(skillId);
          iconHtml = `<span class="sw-icon-emoji" data-tab-id="${esc(tab.id)}" data-skill-picker="1" title="Click to change person">${esc(personIcon)}</span>`;
        }
        const canRename = isPrimaryChat && !tab.pinned;
        const titleAttrs = canRename
          ? `class="sw-title sw-title-editable" data-tab-id="${esc(tab.id)}" title="Click to rename"`
          : `class="sw-title"`;

        // Close button — works for any non-pinned tab and refuses the last one.
        const closeBtnHtml = (this._tabs.length > 1 && !tab.pinned)
          ? `<button type="button" class="sw-close-btn" data-tab-id="${esc(tab.id)}" title="Close tab" aria-label="Close tab">×</button>`
          : '';

        host.innerHTML = `
          <div class="sw-header">
            <div class="sw-header-icon ${(isPrimaryChat || isSkillWorkbench) ? 'sw-header-icon-clickable' : ''}">${iconHtml}</div>
            <div class="sw-header-text">
              <div ${titleAttrs}>${esc(displayName)}</div>
              ${isSkillConsoleTab ? `<div class="sw-subtitle sw-skill-sched-hint">${esc(this._skillSchedSubtitle(convId))}</div>` : ''}
            </div>
            <div class="chat-scope-header-actions">${actions}${closeBtnHtml}</div>
          </div>`;
        host.classList.remove('is-hidden');

        // Wire close button (header)
        const closeHdrBtn = host.querySelector('.sw-close-btn[data-tab-id]');
        if (closeHdrBtn) {
          closeHdrBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this._closeTab(closeHdrBtn.getAttribute('data-tab-id'));
          });
        }

        // Wire integration Manage button
        const manageAppBtn = host.querySelector('.sw-manage-btn[data-app]');
        if (manageAppBtn) {
          manageAppBtn.addEventListener('click', () => {
            const appId = manageAppBtn.getAttribute('data-app');
            if (appId) location.hash = `#/apps?provider=${encodeURIComponent(appId)}`;
          });
        }

        // Icon picker — click the title-bar icon to open a small emoji popover.
        // Reuses _setTabIcon so localStorage + dock + title bar all sync.
        // Available on primary chat tabs and skill (subagent) tabs.
        const iconBtn = host.querySelector('.sw-icon-emoji');
        if (iconBtn && (isPrimaryChat || isSkillWorkbench)) {
          iconBtn.style.cursor = 'pointer';
          iconBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            // Skills get a person-only picker; primary chats get the full palette.
            const flavor = isSkillWorkbench ? 'persons' : 'all';
            this._openIconPicker(iconBtn, iconBtn.dataset.tabId, flavor);
          });
        }

        // Inline rename — click the title to edit; Enter saves, Esc cancels.
        // Reuses _renameTab so localStorage, dock re-render, and WS sync all happen.
        const editableTitle = host.querySelector('.sw-title-editable');
        if (editableTitle) {
          const startEdit = () => {
            if (editableTitle.dataset.editing === '1') return;
            editableTitle.dataset.editing = '1';
            const original = editableTitle.textContent || '';
            editableTitle.setAttribute('contenteditable', 'plaintext-only');
            editableTitle.classList.add('sw-title-editing');
            editableTitle.focus();
            const range = document.createRange();
            range.selectNodeContents(editableTitle);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);

            const finish = (commit) => {
              editableTitle.removeEventListener('blur', onBlur);
              editableTitle.removeEventListener('keydown', onKey);
              editableTitle.removeAttribute('contenteditable');
              editableTitle.classList.remove('sw-title-editing');
              delete editableTitle.dataset.editing;
              const next = (editableTitle.textContent || '').trim();
              if (commit && next && next !== original) {
                this._renameTab(editableTitle.dataset.tabId, next);
              } else {
                editableTitle.textContent = original;
              }
            };
            const onBlur = () => finish(true);
            const onKey = (ev) => {
              if (ev.key === 'Enter') { ev.preventDefault(); editableTitle.blur(); }
              else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
            };
            editableTitle.addEventListener('blur', onBlur);
            editableTitle.addEventListener('keydown', onKey);
          };
          editableTitle.addEventListener('click', startEdit);
          editableTitle.addEventListener('dblclick', startEdit);
        }
      } catch (err) {
        console.error('[ChatView] generic scope header render failed:', err);
        host.classList.add('is-hidden');
        host.innerHTML = '';
      }
      return;
    }
    // `tab.source` is usually `telegram` / `whatsapp`, but surfaced workbench tabs
    // historically stored the full `workbench:channel:*` string — normalize so
    // ScopeRegistry.resolve + /api/channels/status lookups hit the right row.
    let channel = tab.source;
    const wb = String(tab.conversationId || '').match(/^workbench:channel:(.+)$/);
    if (wb) channel = wb[1];
    else if (String(channel || '').startsWith('workbench:channel:')) {
      channel = String(channel).slice('workbench:channel:'.length);
    }
    if (!channel) {
      host.classList.add('is-hidden');
      host.innerHTML = '';
      return;
    }
    if (!window.ScopeRegistry) {
      host.classList.add('is-hidden');
      host.innerHTML = '';
      return;
    }
    const scopeRaw = `workbench:channel:${channel}`;
    try {
      const descriptor = await window.ScopeRegistry.resolve(scopeRaw);
      if (!descriptor) {
        host.classList.add('is-hidden');
        host.innerHTML = '';
        return;
      }
      const esc = (s) => window.VodouSafe.escapeHtml(s);
      const conn = descriptor.connection || {};
      // No chrome when this channel is not in use — avoids a WhatsApp (etc.) bar
      // when nothing is connected, no standalone bridge, and no setup error/QR flow.
      const showChrome = !!(conn.connected || conn.waitingForQr || conn.standaloneRunning || conn.error);
      if (!showChrome) {
        host.classList.add('is-hidden');
        host.innerHTML = '';
        return;
      }
      let dotClass = 'off';
      let dotTitle = 'Disconnected';
      if (conn.error) {
        dotClass = 'warn';
        const err = String(conn.error);
        dotTitle = err.length > 140 ? err.slice(0, 137) + '…' : err;
      } else if (conn.waitingForQr) {
        dotClass = 'warn';
        dotTitle = 'Waiting for QR scan…';
      } else if (conn.connected) {
        dotClass = 'ok';
        dotTitle = 'Connected';
      }
      const canDisconnect = !!(conn.standaloneRunning || conn.mcpConnected);
      const disconnectBtnHtml = canDisconnect
        ? `<button type="button" class="sw-disconnect-btn" data-channel="${esc(channel)}" title="Stop standalone process and/or disconnect MCP for this channel">Disconnect</button>`
        : '';
      const channelCloseBtnHtml = (this._tabs.length > 1 && !tab.pinned)
        ? `<button type="button" class="sw-close-btn" data-tab-id="${esc(tab.id)}" title="Close tab" aria-label="Close tab">×</button>`
        : '';
      // Header only — no pills (scope-badge/tool-count removed per Chad);
      // tool rail lives in the left sidebar (nav-integration-context block).
      // Clicking a sidebar tool prefills #chat-input.
      host.innerHTML = `
        <div class="sw-header">
          <div class="sw-header-icon">${descriptor.iconHtml || ''}</div>
          <div class="sw-header-text">
            <div class="sw-title"><span class="sw-conn-dot sw-conn-dot-${dotClass}" title="${esc(dotTitle)}"></span>${esc(descriptor.displayName)}</div>
          </div>
          <div class="chat-scope-header-actions">
            ${disconnectBtnHtml}
            ${channelCloseBtnHtml}
            <button type="button" class="sw-manage-btn" data-channel="${esc(channel)}" title="Manage channel">Manage</button>
          </div>
        </div>`;
      host.classList.remove('is-hidden');

      // Manage button → open the channel details modal (same as sidebar gear)
      const manageBtn = host.querySelector('.sw-manage-btn');
      if (manageBtn && window.ChannelsView && typeof ChannelsView._openModalByChannel === 'function') {
        manageBtn.addEventListener('click', () => {
          ChannelsView._openModalByChannel(channel);
        });
      }
      // Header close button — same _closeTab path used by the dock tile ×
      const closeBtnCh = host.querySelector('.sw-close-btn[data-tab-id]');
      if (closeBtnCh) {
        closeBtnCh.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this._closeTab(closeBtnCh.getAttribute('data-tab-id'));
        });
      }
      const disconnectBtn = host.querySelector('.sw-disconnect-btn');
      if (disconnectBtn && canDisconnect) {
        disconnectBtn.addEventListener('click', async () => {
          disconnectBtn.disabled = true;
          if (manageBtn) manageBtn.disabled = true;
          try {
            if (conn.standaloneRunning) {
              await API.post('/api/channels/standalone/stop', { channels: [channel] });
            }
            if (conn.mcpConnected) {
              await API.post('/api/channels/disconnect', { channels: [channel] });
            }
            if (window.Components && Components.toast) {
              Components.toast(`${descriptor.displayName || channel} disconnected`, 'success');
            }
            if (window.ChannelsView && typeof ChannelsView._refreshSidebar === 'function') {
              await ChannelsView._refreshSidebar().catch(() => {});
            }
            const mc = document.getElementById('main-content');
            if (mc && (location.hash || '').startsWith('#/messaging') && ChannelsView.render) {
              await ChannelsView.render(mc).catch(() => {});
            }
            await this._renderScopeHeader(tab);
          } catch (e) {
            const raw = (e && e.message ? e.message : e) + '';
            let msg = raw;
            try {
              const j = JSON.parse(raw);
              if (j && typeof j.error === 'string') msg = j.error;
            } catch (_) {}
            if (window.Components && Components.toast) Components.toast(msg, 'error');
            disconnectBtn.disabled = false;
            if (manageBtn) manageBtn.disabled = false;
          }
        });
      }
    } catch (err) {
      console.error('[ChatView] scope header render failed:', err);
      host.classList.add('is-hidden');
      host.innerHTML = '';
    }
  },

  _closeTab(tabId) {
    if (this._tabs.length <= 1) return; // can't close last tab

    const idx = this._tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;

    const tab = this._tabs[idx];
    const convId = tab.conversationId;
    delete this._tabMessages[convId];
    if (this._tabEventBuffers && this._tabEventBuffers[convId]) {
      delete this._tabEventBuffers[convId];
    }

    this._tabs.splice(idx, 1);

    // Switch first so WebSocket default conversationId updates before server deletes rows
    if (tabId === this._activeTabId) {
      const newIdx = Math.min(idx, this._tabs.length - 1);
      this._activeTabId = null;
      this._switchTab(this._tabs[newIdx].id);
    }

    this._saveTabs();
    this._renderTabs();

    // Server-side this is a SOFT delete (deleted_at stamp) — messages survive,
    // so the undo toast / recently-closed menu can bring the chat back intact.
    const delPromise = (async () => {
      try {
        await API.del('/api/gateway/conversation/' + encodeURIComponent(convId));
      } catch (e) {
        if (typeof Components !== 'undefined') {
          Components.toast('Could not remove chat from server', 'error');
        }
      }
    })();

    if (typeof Components !== 'undefined' && Components.toastAction) {
      const title = tab.title || 'Chat';
      // Sequence the undo behind the DELETE so restore can't race ahead of it.
      Components.toastAction(`Closed "${title}"`, 'Undo', () => {
        delPromise.then(() => this._restoreClosedTab(tab));
      });
    }
  },

  /** Undo a tab close — un-soft-deletes the conversation, then re-opens its tab. */
  async _restoreClosedTab(tab) {
    try {
      await API.post('/api/gateway/conversation/' + encodeURIComponent(tab.conversationId) + '/restore');
    } catch (e) {
      if (typeof Components !== 'undefined') {
        Components.toast('Could not restore chat', 'error');
      }
      return;
    }
    let existing = this._tabs.find(t => t.conversationId === tab.conversationId);
    if (!existing) {
      this._tabs.push(tab);
      existing = tab;
    }
    // _switchTab saves + re-renders tabs and requests history from the server.
    this._switchTab(existing.id);
  },

  /** Popover listing soft-deleted chats; click an entry to restore + reopen it. */
  async _openRecentlyClosedMenu(anchorEl) {
    // Same container class as the icon picker — shared glass styling and the
    // mutual "only one popover at a time" sweep.
    document.querySelectorAll('.tab-icon-picker').forEach(el => el.remove());

    let conversations = [];
    try {
      const resp = await API.get('/api/gateway/conversations/recently-closed');
      conversations = (resp && resp.conversations) || [];
    } catch (e) {
      if (typeof Components !== 'undefined') {
        Components.toast('Could not load recently closed chats', 'error');
      }
      return;
    }
    // Skip chats already open in a tab — nothing to restore.
    const openConvIds = new Set(this._tabs.map(t => t.conversationId));
    conversations = conversations.filter(c => !openConvIds.has(c.id));

    const pop = document.createElement('div');
    pop.className = 'tab-icon-picker recently-closed-menu';
    const sec = document.createElement('div');
    sec.className = 'tab-icon-picker-section';
    sec.innerHTML = '<div class="tab-icon-picker-label">Recently closed</div>';

    if (conversations.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'recently-closed-empty';
      empty.textContent = 'No recently closed chats';
      sec.appendChild(empty);
    } else {
      for (const conv of conversations) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'recently-closed-item';
        const title = document.createElement('span');
        title.className = 'recently-closed-title';
        title.textContent = conv.title || 'Chat';
        const when = document.createElement('span');
        when.className = 'recently-closed-when';
        when.textContent = this._timeAgo(String(conv.deletedAt || '').replace(' ', 'T') + 'Z');
        item.appendChild(title);
        item.appendChild(when);
        item.addEventListener('click', (ev) => {
          ev.stopPropagation();
          pop.remove();
          this._restoreClosedTab({
            id: this._generateTabId(),
            title: conv.title || 'Chat',
            conversationId: conv.id,
            source: conv.source || 'web',
          });
        });
        sec.appendChild(item);
      }
    }
    pop.appendChild(sec);

    document.body.appendChild(pop);
    const r = anchorEl.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.top = `${Math.round(r.bottom + 8)}px`;
    pop.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)))}px`;

    const onDocClick = (ev) => {
      if (!pop.contains(ev.target) && ev.target !== anchorEl) {
        pop.remove();
        document.removeEventListener('click', onDocClick, true);
        document.removeEventListener('keydown', onKey);
      }
    };
    const onKey = (ev) => { if (ev.key === 'Escape') { pop.remove(); document.removeEventListener('click', onDocClick, true); document.removeEventListener('keydown', onKey); } };
    setTimeout(() => {
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onKey);
    }, 0);
  },

  // Curated Lucide-style monochrome SVG palette — uniform stroke, system-design feel.
  // Each entry is the inner contents of a 24×24 SVG (no <svg> wrapper).
  // Render via _iconSvg() which wraps + tints to currentColor.
  _tabIconSvgPalette: [
    'M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z',                                 // chat bubble
    'M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z',     // book
    'M9 2v6l-3 5a4 4 0 0 0 4 6h4a4 4 0 0 0 4-6l-3-5V2',                                          // flask
    'M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z', // brush
    'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z', // wrench
    'M14.7 14.7L10 19.4 4.6 14a2 2 0 0 1 0-2.8L13 2.8a2 2 0 0 1 2.8 0L21 8m-9 7l1 1m-1-1l-3 3m4-4l3-3m-3 3l-1-1', // pencil
    'M22 12h-4l-3 9L9 3l-3 9H2',                                                                  // activity
    'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09zM12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2zm-1.96-1.04L8 16M16 9a1 1 0 1 0 2 0 1 1 0 0 0-2 0z', // rocket
    'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',  // star
    'M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.74V17h8v-2.26A7 7 0 0 0 12 2z',                          // lightbulb
    'M9 18V5l12-2v13M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm15-3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',       // music
    'M12 20V10M18 20V4M6 20v-4',                                                                  // bar chart
    'M6 11h.01M10 11h.01M14 11h.01M18 11h.01M6 15h12a4 4 0 0 0 4-4 7 7 0 0 0-7-7H9a7 7 0 0 0-7 7 4 4 0 0 0 4 4z', // gamepad
    'M18 8h1a4 4 0 0 1 0 8h-1M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8zM6 1v3M10 1v3M14 1v3',    // coffee
    'M12 2L9.91 8.26L3 9l5.46 4.73L7 22l5-3 5 3-1.46-8.27L21 9l-6.91-.74z',                       // sparkle/star
    'M12 2c1.1 0 2 .9 2 2v6.59l4.95 4.95-1.41 1.41L13 12.41V20a2 2 0 1 1-4 0v-7.59l-4.54 4.54-1.41-1.41L8 10.59V4c0-1.1.9-2 2-2z', // compass-ish
    'M5 22h14M5 2h14M17 22v-4.17a2 2 0 0 0-.59-1.41L12 12l-4.41 4.42A2 2 0 0 0 7 17.83V22M7 2v4.17c0 .53.21 1.04.59 1.41L12 12l4.41-4.42A2 2 0 0 0 17 6.17V2', // hourglass
    'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 22V12h6v10',                                // home
    'M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18ZM12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z', // brain
    'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.27 6.96L12 12.01 20.73 6.96M12 22.08V12', // package
    'M11 11h.01M11 15h.01M16 16l3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1zM2 16l3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1zM7 21h10M12 3v18M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2', // scales
    'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',               // folder
    'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 9h18M9 22V12h6v10',                         // building
    'M2 3h20v14H2zM8 21h8M12 17v4',                                                                // monitor
  ],

  /** Wrap a path-d string into a stroked SVG that inherits text color. */
  _iconSvg(d) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  },

  // Letter-avatar color palette — soft saturated tones that read well on dark + light bgs.
  // Deterministically picked by hashing the tab id.
  _avatarColorPalette: [
    '#0d9488', '#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c',
    '#ca8a04', '#16a34a', '#0891b2', '#4f46e5', '#9333ea', '#e11d48',
    '#65a30d', '#0284c7', '#7e22ce', '#be185d',
  ],

  /** First 1–2 initial chars of a tab title, uppercased. Strips emoji/symbols. */
  _initialsForTab(tab) {
    const raw = (tab && tab.title ? String(tab.title) : '').trim();
    if (!raw) return '?';
    // Pull alphanumerics in word order; fall back to first character if none
    const words = raw.split(/[\s\-_/.]+/).filter(Boolean);
    const letters = (words[0]?.match(/\p{L}|\p{N}/u)?.[0] || raw[0] || '?').toUpperCase()
      + (words.length > 1 ? (words[1].match(/\p{L}|\p{N}/u)?.[0] || '').toUpperCase() : '');
    return letters || '?';
  },

  /** Deterministic accent color for a tab from the palette. */
  _colorForTab(tab) {
    const id = String((tab && (tab.id || tab.conversationId || tab.title)) || 'x');
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return this._avatarColorPalette[h % this._avatarColorPalette.length];
  },

  /**
   * Resolve the visual identity for a tab.
   * Returns one of:
   *   { kind: 'svg',    html }   — picker override using a curated line SVG
   *   { kind: 'emoji',  text }   — picker override using an emoji
   *   { kind: 'avatar', text, color } — default: letter avatar in a colored circle
   */
  _identityForTab(tab) {
    if (!tab) return { kind: 'avatar', text: '?', color: this._avatarColorPalette[0] };
    if (tab.icon) {
      if (this._isSvgIcon(tab.icon)) return { kind: 'svg', html: tab.icon };
      return { kind: 'emoji', text: tab.icon };
    }
    return { kind: 'avatar', text: this._initialsForTab(tab), color: this._colorForTab(tab) };
  },

  /** Backwards-compat: returns a string the picker can compare against tab.icon. */
  _iconForTab(tab) {
    if (!tab) return this._iconSvg(this._tabIconSvgPalette[0]);
    if (tab.icon) return tab.icon;
    const id = String(tab.id || tab.conversationId || tab.title || 'x');
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return this._iconSvg(this._tabIconSvgPalette[h % this._tabIconSvgPalette.length]);
  },

  /** True if `s` looks like an SVG icon string (vs a single-emoji override). */
  _isSvgIcon(s) { return typeof s === 'string' && s.charAt(0) === '<'; },

  /** Persist a custom icon for a tab (called from the picker).
   *  Mirrors the icon to every tab sharing the same conversationId — surfaced
   *  workbench tabs and routing tabs can coexist for one scope; dock and title
   *  bar each find them by different keys, so we keep both in sync. */
  _setTabIcon(tabId, icon) {
    const tab = this._tabs.find(t => t.id === tabId);
    if (!tab) return;
    const siblings = tab.conversationId
      ? this._tabs.filter(t => t.conversationId === tab.conversationId)
      : [tab];
    if (icon === null || icon === undefined || icon === '') {
      for (const s of siblings) delete s.icon;
    } else {
      const s = String(icon);
      // SVG strings store verbatim. Non-SVG values are validated/capped using
      // Intl.Segmenter so we cap by *grapheme* (one visible glyph), not by raw
      // code units — slicing at code-unit boundaries inside a ZWJ emoji
      // sequence breaks it into a fallback baby/question-mark render.
      let value;
      if (this._isSvgIcon(s)) {
        value = s;
      } else {
        let firstGrapheme = s;
        try {
          if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
            const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
            const it = seg.segment(s)[Symbol.iterator]();
            const first = it.next();
            if (!first.done) firstGrapheme = first.value.segment;
          } else {
            firstGrapheme = s.slice(0, 16);
          }
        } catch {}
        value = firstGrapheme;
      }
      for (const sib of siblings) sib.icon = value;
      // For surfaced workbench tabs (skills, integrations, etc.) also push the
      // override into WorkbenchSurfaces so the dock's `_iconForSurfacedEntry`
      // sees the same source-of-truth and the override survives reload.
      if (tab.conversationId && typeof WorkbenchSurfaces !== 'undefined' && WorkbenchSurfaces.has(tab.conversationId)) {
        try { WorkbenchSurfaces.update(tab.conversationId, { icon: value }); } catch {}
      }
    }
    this._saveTabs();
    this._renderTabs();
    if (typeof this._renderIntegrationTabs === 'function') {
      try { this._renderIntegrationTabs(); } catch {}
    }
    // Re-render the active scope header so the title bar reflects the new icon
    const activeTab = this._tabs.find(t => t.id === this._activeTabId);
    if (activeTab) this._renderScopeHeader(activeTab);
  },

  // Emoji set the picker offers as alternative overrides (in addition to the curated SVG set).
  _tabIconEmojiOptions: ['💬','📚','🧪','🎨','🔧','📝','🎯','🚀','⭐','💡','🎵','📊','🎮','☕','🌟','🔥','🌱','🪐','🧠','📦','🛰️','🪄','🗂️','🍿'],

  /** Open the icon picker popover anchored to `anchorEl`.
   *  flavor: 'all' (default — letter avatar + SVG icons + emoji)
   *          'persons' (skill/subagent — person emoji only) */
  _openIconPicker(anchorEl, tabId, flavor) {
    document.querySelectorAll('.tab-icon-picker').forEach(el => el.remove());
    const tab = this._tabs.find(t => t.id === tabId);
    if (!tab) return;
    flavor = flavor || 'all';

    const pop = document.createElement('div');
    pop.className = 'tab-icon-picker';

    // ── Person-only picker (used by skill/subagent tabs) ──
    if (flavor === 'persons') {
      const sec = document.createElement('div');
      sec.className = 'tab-icon-picker-section';
      sec.innerHTML = '<div class="tab-icon-picker-label">Pick a person</div>';
      const grid = document.createElement('div');
      grid.className = 'tab-icon-picker-grid';
      for (const ic of this._personIconPalette) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tab-icon-picker-item' + (tab.icon === ic ? ' is-active' : '');
        b.textContent = ic;
        b.title = ic;
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this._setTabIcon(tabId, ic);
          pop.remove();
        });
        grid.appendChild(b);
      }
      sec.appendChild(grid);
      pop.appendChild(sec);

      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'tab-icon-picker-reset';
      reset.textContent = 'Reset to default';
      reset.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._setTabIcon(tabId, null);
        pop.remove();
      });
      pop.appendChild(reset);

      // Position + dismiss handlers (shared with full-palette path below)
      document.body.appendChild(pop);
      const r = anchorEl.getBoundingClientRect();
      pop.style.position = 'fixed';
      pop.style.top = `${Math.round(r.bottom + 8)}px`;
      pop.style.left = `${Math.round(r.left)}px`;

      const onDocClick = (ev) => {
        if (!pop.contains(ev.target) && ev.target !== anchorEl) {
          pop.remove();
          document.removeEventListener('click', onDocClick, true);
          document.removeEventListener('keydown', onKey);
        }
      };
      const onKey = (ev) => { if (ev.key === 'Escape') { pop.remove(); document.removeEventListener('click', onDocClick, true); document.removeEventListener('keydown', onKey); } };
      setTimeout(() => {
        document.addEventListener('click', onDocClick, true);
        document.addEventListener('keydown', onKey);
      }, 0);
      return;
    }

    // ── Section 0: preview of the default letter avatar ──
    const preview = document.createElement('div');
    preview.className = 'tab-icon-picker-section tab-icon-picker-preview';
    const defAvatar = { text: this._initialsForTab(tab), color: this._colorForTab(tab) };
    preview.innerHTML = `<div class="tab-icon-picker-label">Default</div>
      <div class="tab-icon-picker-avatar-row">
        <span class="tab-icon-picker-avatar" style="background:${defAvatar.color};color:#fff;">${defAvatar.text}</span>
        <span class="tab-icon-picker-avatar-hint">Letter avatar — auto-updates with the name</span>
      </div>`;
    pop.appendChild(preview);

    // ── Section 1: curated line-style SVG icons (override) ──
    const sec1 = document.createElement('div');
    sec1.className = 'tab-icon-picker-section';
    sec1.innerHTML = '<div class="tab-icon-picker-label">Icons</div>';
    const grid1 = document.createElement('div');
    grid1.className = 'tab-icon-picker-grid';
    this._tabIconSvgPalette.forEach((d) => {
      const svg = this._iconSvg(d);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tab-icon-picker-item tab-icon-picker-item-svg' + (tab.icon === svg ? ' is-active' : '');
      b.innerHTML = svg;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._setTabIcon(tabId, svg);
        pop.remove();
      });
      grid1.appendChild(b);
    });
    sec1.appendChild(grid1);
    pop.appendChild(sec1);

    // ── Section 2: emoji overrides ──
    const sec2 = document.createElement('div');
    sec2.className = 'tab-icon-picker-section';
    sec2.innerHTML = '<div class="tab-icon-picker-label">Emoji</div>';
    const grid2 = document.createElement('div');
    grid2.className = 'tab-icon-picker-grid';
    for (const ic of this._tabIconEmojiOptions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tab-icon-picker-item' + (tab.icon === ic ? ' is-active' : '');
      b.textContent = ic;
      b.title = ic;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._setTabIcon(tabId, ic);
        pop.remove();
      });
      grid2.appendChild(b);
    }
    sec2.appendChild(grid2);
    pop.appendChild(sec2);

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'tab-icon-picker-reset';
    reset.textContent = 'Reset to default';
    reset.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this._setTabIcon(tabId, null);
      pop.remove();
    });
    pop.appendChild(reset);

    document.body.appendChild(pop);
    const r = anchorEl.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.top = `${Math.round(r.bottom + 8)}px`;
    pop.style.left = `${Math.round(r.left)}px`;

    const onDocClick = (ev) => {
      if (!pop.contains(ev.target) && ev.target !== anchorEl) {
        pop.remove();
        document.removeEventListener('click', onDocClick, true);
        document.removeEventListener('keydown', onKey);
      }
    };
    const onKey = (ev) => { if (ev.key === 'Escape') { pop.remove(); document.removeEventListener('click', onDocClick, true); document.removeEventListener('keydown', onKey); } };
    setTimeout(() => {
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onKey);
    }, 0);
  },

  _renameTab(tabId, newTitle) {
    const tab = this._tabs.find(t => t.id === tabId);
    if (tab) {
      tab.title = newTitle.substring(0, 30);
      this._saveTabs();
      this._renderTabs();
      // The dock icon recomputes via _renderTabs, but the scope-header icon
      // (letter-avatar from the title's initials) does not — re-render the
      // header too when the renamed tab is the active one, so its icon updates
      // to match the new name (and the dock) instead of keeping stale initials.
      if (tab.id === this._activeTabId) this._renderScopeHeader(tab);
      // Persist to gateway.db
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'update_title',
          conversationId: tab.conversationId,
          title: tab.title,
        }));
      }
    }
  },

  // Channel tab icons — keyed by source
  _channelIcons: {
    heartbeat: '<svg class="chat-channel-icon-svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
    telegram: '<svg class="chat-channel-icon-svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.492-1.302.48-.428-.013-1.252-.242-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>',
    slack: '<svg class="chat-channel-icon-svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z"/><path d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z"/><path d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.27 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.163 0a2.528 2.528 0 0 1 2.523 2.522v6.312z"/><path d="M15.163 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.163 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.27a2.527 2.527 0 0 1-2.52-2.523 2.527 2.527 0 0 1 2.52-2.52h6.315A2.528 2.528 0 0 1 24 15.163a2.528 2.528 0 0 1-2.522 2.523h-6.315z"/></svg>',
    discord: '<svg class="chat-channel-icon-svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.8733.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189z"/></svg>',
    whatsapp: '<svg class="chat-channel-icon-svg chat-channel-icon-whatsapp" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z"/></svg>',
    teams: '<svg class="chat-channel-icon-svg chat-channel-icon-teams" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path fill="#6264A7" d="M20.625 8.127q-.55 0-1.025-.205-.475-.205-.832-.563-.358-.357-.563-.832Q18 6.053 18 5.502q0-.54.205-1.02t.563-.837q.357-.358.832-.563.474-.205 1.025-.205.54 0 1.02.205t.837.563q.358.357.563.837.205.48.205 1.02 0 .55-.205 1.025-.205.475-.563.832-.357.358-.837.563-.48.205-1.02.205zm0-3.75q-.469 0-.797.328-.328.328-.328.797 0 .469.328.797.328.328.797.328.469 0 .797-.328.328-.328.328-.797 0-.469-.328-.797-.328-.328-.797-.328zM24 10.002v5.578q0 .774-.293 1.46-.293.685-.803 1.194-.51.51-1.195.803-.686.293-1.459.293-.445 0-.908-.105-.463-.106-.85-.329-.293.95-.855 1.729-.563.78-1.319 1.336-.756.557-1.67.861-.914.305-1.898.305-1.148 0-2.162-.398-1.014-.399-1.805-1.102-.79-.703-1.312-1.664t-.674-2.086h-5.8q-.411 0-.704-.293T0 16.881V6.873q0-.41.293-.703t.703-.293h8.59q-.34-.715-.34-1.5 0-.727.275-1.365.276-.639.75-1.114.475-.474 1.114-.75.638-.275 1.365-.275t1.365.275q.639.276 1.114.75.474.475.75 1.114.275.638.275 1.365t-.275 1.365q-.276.639-.75 1.113-.475.475-1.114.75-.638.276-1.365.276-.188 0-.375-.024-.188-.023-.375-.058v1.078h10.875q.469 0 .797.328.328.328.328.797zM12.75 2.373q-.41 0-.78.158-.368.158-.638.434-.27.275-.428.639-.158.363-.158.773 0 .41.158.78.159.368.428.638.27.27.639.428.369.158.779.158.41 0 .773-.158.364-.159.64-.428.274-.27.433-.639.158-.369.158-.779 0-.41-.158-.773-.159-.364-.434-.64-.275-.275-.639-.433-.363-.158-.773-.158zM6.937 9.814h2.25V7.94H2.814v1.875h2.25v6h1.875zm10.313 7.313v-6.75H12v6.504q0 .41-.293.703t-.703.293H8.309q.152.809.556 1.5.405.691.985 1.19.58.497 1.318.779.738.281 1.582.281.926 0 1.746-.352.82-.351 1.436-.966.615-.616.966-1.43.352-.815.352-1.752zm5.25-1.547v-5.203h-3.75v6.855q.305.305.691.452.387.146.809.146.469 0 .879-.176.41-.175.715-.48.304-.305.48-.715t.176-.879Z"/></svg>',
    googlechat: '<svg class="chat-channel-icon-svg chat-channel-icon-googlechat" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path fill="#00832d" d="M1.637 0C.733 0 0 .733 0 1.637v16.5c0 .904.733 1.636 1.637 1.636h3.955v3.323c0 .804.97 1.207 1.539.638l3.963-3.96h11.27c.903 0 1.636-.733 1.636-1.637V5.592L18.408 0Zm3.955 5.592h12.816v8.59H8.455l-2.863 2.863Z"/></svg>',
    signal: '<svg class="chat-channel-icon-svg chat-channel-icon-signal" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path fill="#2592E3" d="M12.012 2.598c-5.22 0-9.452 4.233-9.452 9.452 0 5.22 4.232 9.452 9.452 9.452 5.22 0 9.452-4.232 9.452-9.452 0-5.219-4.232-9.452-9.452-9.452zm0 1.769c4.243 0 7.682 3.439 7.682 7.683 0 4.243-3.439 7.682-7.682 7.682-4.244 0-7.683-3.439-7.683-7.682 0-4.244 3.439-7.683 7.683-7.683zm3.031 4.025c-.15 0-.274.124-.274.274v2.134c0 .15.124.274.274.274h1.526c.15 0 .274-.124.274-.274V8.666c0-.15-.124-.274-.274-.274zm-3.031.548c-2.147 0-3.888 1.741-3.888 3.888 0 2.147 1.741 3.888 3.888 3.888 2.147 0 3.888-1.741 3.888-3.888 0-2.147-1.741-3.888-3.888-3.888zm0 1.098c1.541 0 2.79 1.249 2.79 2.79 0 1.541-1.249 2.79-2.79 2.79-1.541 0-2.79-1.249-2.79-2.79 0-1.541 1.249-2.79 2.79-2.79z"/></svg>',
    imessage: '<svg class="chat-channel-icon-svg chat-channel-icon-imessage" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#34C759"/><path fill="#fff" transform="translate(4,4)" d="M8 15c4.418 0 8-3.134 8-7s-3.582-7-8-7-8 3.134-8 7c0 1.76.743 3.37 1.97 4.6-.097 1.016-.417 2.13-.771 2.966-.079.186.074.394.273.362 2.256-.37 3.597-.938 4.18-1.234A9 9 0 0 0 8 15"/></svg>',
    voice: '<svg class="chat-channel-icon-svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>',
    web: '<svg class="chat-channel-icon-svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>',
  },

  _tabTierLsKeyMessaging: 'vodou-tab-tier-messaging-collapsed',
  _tabTierLsKeyApps: 'vodou-tab-tier-apps-collapsed',
  _tabTierLsKeySkills: 'vodou-tab-tier-skills-collapsed',

  /**
   * Sources that carry a non-'web' tag but are not conversations with a person,
   * so they must never become a dock tab at all.
   *
   * The channel test is a denylist (anything not 'web' is a channel), which is
   * right for the channel SDK — custom channels register arbitrary names like
   * 'testchannel' and must keep working without a registry here. But it swept
   * three source families into the Messaging tier that don't belong in the dock:
   *   capture:* / import:*  — memory-source buffers (Sources panel owns them)
   *   openai-compat         — BYOK API sessions from aider / Cursor / etc.
   *                           hitting /v1/chat/completions
   *   curriculum            — background skill-practice runs
   * Keep this the ONE place that answers "does this source belong in the dock?".
   */
  _isDockExcludedSource(source) {
    const src = String(source || '');
    return src.startsWith('capture:')
      || src.startsWith('import:')
      || src === 'openai-compat'
      || src === 'curriculum';
  },

  _isChannelConversationTab(tab) {
    // Skill console tabs (PLAN-SKILL-CONSOLE-LOOP §33) get their own treatment
    // — render as primary chat tabs so users can talk to LLM-created skills
    // alongside their regular chats, not buried in the messaging tier.
    return !tab.integration
      && !!tab.source
      && tab.source !== 'web'
      && tab.source !== 'heartbeat'
      && tab.source !== 'board'
      && tab.source !== 'skill-console'
      && !this._isDockExcludedSource(tab.source);
  },

  /** Visual lenses only in primary gateway web chat (mirrors server lenses-policy.ts). */
  _lensesEnabledForConversation(convId) {
    if (!convId || String(convId).startsWith('workbench:')) return false;
    const tab = this._tabs.find(t => t.conversationId === convId);
    const src = String(tab?.source || 'web').trim().toLowerCase();
    if (src && src !== 'web') return false;
    return true;
  },

  _lensesEnabledForActiveConv() {
    return this._lensesEnabledForConversation(this._getConversationId());
  },

  _stripLensMarkdown(text) {
    if (!text || text.indexOf('```lens') === -1) return text;
    return String(text)
      .replace(/```lens\s*\n[\s\S]*?```/g, '')
      .replace(/```lens\s*\n[\s\S]*$/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  },

  _isPrimaryConversationTab(tab) {
    return !tab.integration && !this._isChannelConversationTab(tab);
  },

  _sortTabsStable() {
    return [...this._tabs].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      const aChannel = this._isChannelConversationTab(a);
      const bChannel = this._isChannelConversationTab(b);
      if (aChannel && !bChannel) return -1;
      if (!aChannel && bChannel) return 1;
      return 0;
    });
  },

  /** Edge-fade + chevrons for #global-chat-tabs-bar when surfaced tabs
   *  overflow horizontally. Idempotent — safe to call once on init.
   *  Maps mouse-wheel-Y to scroll-X so users without trackpad horizontal
   *  swipe can still reach hidden tabs. */
  _initDockOverflow() {
    if (this._dockOverflowBound) return;
    const bar = document.getElementById('global-chat-tabs-bar');
    const chevL = document.getElementById('dock-overflow-chevron-left');
    const chevR = document.getElementById('dock-overflow-chevron-right');
    if (!bar) return;
    this._dockOverflowBound = true;

    const update = () => {
      const max = bar.scrollWidth - bar.clientWidth;
      bar.classList.toggle('has-overflow-left', bar.scrollLeft > 1);
      bar.classList.toggle('has-overflow-right', bar.scrollLeft < max - 1);
    };

    bar.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(update);
      ro.observe(bar);
      // Re-measure when tier content changes — surfaced tabs add/remove async.
      for (const el of bar.querySelectorAll('.chat-tabs')) ro.observe(el);
    }

    // Wheel-Y → scroll-X (only when we're actually overflowing). Don't
    // hijack horizontal trackpad gestures; let the browser handle those.
    bar.addEventListener('wheel', (e) => {
      const max = bar.scrollWidth - bar.clientWidth;
      if (max <= 0) return;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        bar.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });

    const scrollByPage = (dir) => {
      const step = Math.max(120, bar.clientWidth - 80);
      bar.scrollBy({ left: dir * step, behavior: 'smooth' });
    };
    if (chevL) chevL.addEventListener('click', () => scrollByPage(-1));
    if (chevR) chevR.addEventListener('click', () => scrollByPage(+1));

    // Initial measurement after layout settles.
    requestAnimationFrame(update);
    setTimeout(update, 250);
    this._updateDockOverflow = update;
  },

  _bindTabTierHeaders() {
    if (this._tabTierHeadersBound) return;
    this._tabTierHeadersBound = true;
    const bind = (btnId, wrapId, lsKey) => {
      const btn = document.getElementById(btnId);
      const wrap = document.getElementById(wrapId);
      if (!btn || !wrap) return;
      btn.addEventListener('click', () => {
        wrap.classList.toggle('is-collapsed');
        const collapsed = wrap.classList.contains('is-collapsed');
        try { localStorage.setItem(lsKey, collapsed ? '1' : '0'); } catch {}
        btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      });
    };
    bind('chat-tabs-messaging-toggle', 'chat-tabs-messaging-wrap', this._tabTierLsKeyMessaging);
    bind('chat-tabs-apps-toggle', 'chat-tabs-apps-wrap', this._tabTierLsKeyApps);
    bind('chat-tabs-skills-toggle', 'chat-tabs-skills-wrap', this._tabTierLsKeySkills);
  },

  _syncTierCollapsedFromLs(wrap, lsKey, btnId) {
    if (!wrap) return;
    // Default: collapsed (saves vertical space). Explicit '0' = user expanded.
    let collapsed = true;
    try {
      const v = localStorage.getItem(lsKey);
      if (v === '0') collapsed = false;
      else if (v === '1') collapsed = true;
      else collapsed = true;
    } catch {}
    wrap.classList.toggle('is-collapsed', collapsed);
    const btn = document.getElementById(btnId);
    if (btn) btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  },

  /** Row 1 (heartbeat + web chats): tuck messaging + apps tiers away. Must run after _renderTabs (re-sync would undo if earlier). */
  _collapseMessagingAndAppsTiers() {
    const apply = (wrap, btnId, lsKey) => {
      if (!wrap || wrap.classList.contains('is-empty')) return;
      wrap.classList.add('is-collapsed');
      try { localStorage.setItem(lsKey, '1'); } catch {}
      const btn = document.getElementById(btnId);
      if (btn) btn.setAttribute('aria-expanded', 'false');
    };
    apply(this._messagingTierWrap, 'chat-tabs-messaging-toggle', this._tabTierLsKeyMessaging);
    apply(this._appsTierWrap, 'chat-tabs-apps-toggle', this._tabTierLsKeyApps);
    apply(this._skillsTierWrap, 'chat-tabs-skills-toggle', this._tabTierLsKeySkills);
  },

  /** Primary + channel conversation tabs (not surfaced-only integration rows). */
  _createStandardTabElement(tab) {
    const el = document.createElement('div');
    el.className = 'chat-tab' + (tab.id === this._activeTabId ? ' active' : '');
    if (tab.conversationId) el.setAttribute('data-conversation-id', tab.conversationId);
    if (tab.source && tab.source !== 'web') el.setAttribute('data-source', tab.source);
    if (tab.pinned) el.setAttribute('data-pinned', 'true');

    // 'web' is the default source for plain chat tabs — treat as no-source so
    // they get the personalizable per-tab icon (palette SVG or custom emoji).
    // Real channel sources (telegram/slack/etc.) and 'heartbeat' (briefing) keep
    // their distinctive brand glyphs.
    const useSourceIcon = tab.source && tab.source !== 'web' && this._channelIcons[tab.source];
    if (useSourceIcon) {
      const iconSpan = document.createElement('span');
      iconSpan.className = 'chat-tab-icon';
      iconSpan.innerHTML = this._channelIcons[tab.source];
      el.appendChild(iconSpan);
    } else {
      const iconSpan = document.createElement('span');
      const id = this._identityForTab(tab);
      if (id.kind === 'svg') {
        iconSpan.className = 'chat-tab-icon chat-tab-icon-svg';
        iconSpan.innerHTML = id.html;
      } else if (id.kind === 'emoji') {
        iconSpan.className = 'chat-tab-icon chat-tab-icon-emoji';
        iconSpan.textContent = id.text;
      } else {
        // Letter avatar — one quiet aged-bronze tone for every idle tile
        // (CSS owns the color so the dock reads as one calm family, not a
        // rainbow). The active pill is the only loud element. Brightens on
        // hover + active via 05-shell.css.
        iconSpan.className = 'chat-tab-icon chat-tab-icon-avatar';
        iconSpan.textContent = id.text;
      }
      el.appendChild(iconSpan);
    }

    // PLAN-GATEWAY-PROJECTS — per-tab project color chip. Only useful to flag a
    // tab from a DIFFERENT project than the one you're in; since the dock now
    // filters tabs to the active project, the chip would otherwise tag every tab
    // with the same color (redundant noise). Show it only for cross-project tabs.
    const tabProj = tab.projectId || 'proj_default';
    const projColor = tabProj !== this._getActiveProjectId() ? this._projectColor(tab.projectId) : null;
    if (projColor) {
      const pchip = document.createElement('span');
      pchip.className = 'tab-project-chip';
      pchip.style.background = projColor;
      pchip.title = 'Project: ' + (this._projectName(tab.projectId) || tab.projectId);
      el.appendChild(pchip);
    }

    const title = document.createElement('span');
    title.className = 'chat-tab-title';
    title.textContent = tab.title;
    if (!tab.pinned) {
      title.addEventListener('dblclick', () => {
        const newName = prompt('Rename tab:', tab.title);
        if (newName && newName.trim()) this._renameTab(tab.id, newName.trim());
      });
    }
    el.appendChild(title);
    // Dock tiles hide .chat-tab-title (tooltip-only). Surface schedule on hover + dot.
    if (tab.source === 'skill-console') {
      const m = this._skillConsoleMeta && this._skillConsoleMeta[tab.conversationId];
      const hasSched = !!(
        m &&
        (m.scheduleCron || m.nextRunAt) &&
        m.scheduleEnabled !== false
      );
      if (hasSched) {
        const dot = document.createElement('span');
        dot.className = 'chat-tab-sched-dot';
        dot.setAttribute('aria-hidden', 'true');
        el.appendChild(dot);
      }
      const hint = (this._skillSchedHintLine(tab.conversationId) || '').replace(/^ ·\s*/, '');
      const sub = this._skillSchedSubtitle(tab.conversationId);
      el.title = hint ? `${tab.title} — ${hint}` : sub;
    }

    if (this._tabs.length > 1 && !tab.pinned) {
      const close = document.createElement('span');
      close.className = 'chat-tab-close';
      close.textContent = '\u00D7';
      close.setAttribute('aria-label', 'Close tab');
      close.title = 'Close tab';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        this._closeTab(tab.id);
      });
      el.appendChild(close);
    }

    el.addEventListener('click', () => this._switchTab(tab.id));
    return el;
  },

  _skillSchedHintLine(convId) {
    const m = this._skillConsoleMeta && this._skillConsoleMeta[convId];
    if (!m) return '';
    if (m.scheduleEnabled === false) return ' · paused';
    if (!m.scheduleCron && !m.nextRunAt) return '';
    if (m.nextRunAt) {
      try {
        const d = new Date(m.nextRunAt);
        if (Number.isFinite(d.getTime())) {
          const diff = d.getTime() - Date.now();
          if (diff < 0) return ' · overdue';
          if (diff < 3600000) return ` · ${Math.max(1, Math.round(diff / 60000))}m`;
          return ` · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
        }
      } catch { /* ignore */ }
    }
    if (m.scheduleCron) return ` · ${m.scheduleCron.length > 18 ? m.scheduleCron.slice(0, 16) + '…' : m.scheduleCron}`;
    return '';
  },

  _skillSchedSubtitle(convId) {
    const m = this._skillConsoleMeta && this._skillConsoleMeta[convId];
    if (!m) return 'Schedule: …';
    if (m.scheduleEnabled === false) return `Paused · ${m.scheduleCron || 'cron'}`;
    if (!m.scheduleCron && !m.nextRunAt) return 'No schedule — type /cron';
    let line = '';
    if (m.nextRunAt) {
      try {
        const d = new Date(m.nextRunAt);
        if (Number.isFinite(d.getTime())) {
          line = `Next: ${d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
        }
      } catch { /* ignore */ }
    }
    if (!line && m.scheduleCron) line = `Cron: ${m.scheduleCron}`;
    else if (line && m.scheduleCron) line += ` · ${m.scheduleCron}`;
    return line || 'Scheduled';
  },

  async _refreshSkillConsoleMeta() {
    try {
      const r = await fetch('/api/skill-console/meta');
      if (!r.ok) return;
      const j = await r.json();
      const map = Object.create(null);
      for (const it of j.items || []) {
        if (it && it.conversationId) map[it.conversationId] = it;
      }
      this._skillConsoleMeta = map;
      this._renderTabs();
      const tab = this._tabs.find(t => t.id === this._activeTabId);
      if (tab) this._renderScopeHeader(tab);
    } catch (e) {
      console.warn('[skill-console] meta fetch failed', e);
    }
  },

  _renderTabs() {
    if (!this._tabBar) return;
    this._tabBar.innerHTML = '';

    const sorted = this._sortTabsStable();
    const primaryTabs = sorted.filter((t) => this._isPrimaryConversationTab(t));

    // Split the primary bar into two visual clusters so the dock reads as
    // distinct groupings (parity with messaging/apps/skills tiers):
    //   Group 1 — automated/system tabs: Heartbeat, Board, and scheduled skill
    //             runs (skill-console tabs, e.g. the daily-competitor-intel /
    //             morning-briefing scheduler `skill_run` jobs). Surfaced
    //             automations are also hoisted here in _renderAppsTier.
    //   Group 2 — the user's own chats
    const isSystemTab = (t) =>
      t.conversationId === 'vodou-heartbeat' || t.source === 'heartbeat' ||
      t.conversationId === 'board-chat' || t.source === 'board' ||
      t.source === 'skill-console';
    // Heartbeat + Board are global infra tabs (shown in every project, like the
    // System scheduled-task group). Skill-console + chat tabs belong to a project
    // and are filtered to the active one (PLAN-PROJECT-SCOPED-DOCK — dock tabs
    // follow the active project; the server already tags each tab's projectId).
    const activeProject = this._getActiveProjectId();
    const isGlobalSystemTab = (t) =>
      t.conversationId === 'vodou-heartbeat' || t.source === 'heartbeat' ||
      t.conversationId === 'board-chat' || t.source === 'board';
    const inActiveProject = (t) => (t.projectId || 'proj_default') === activeProject;
    const systemTabs = primaryTabs.filter(isSystemTab).filter((t) => isGlobalSystemTab(t) || inActiveProject(t));
    const chatTabs = primaryTabs.filter((t) => !isSystemTab(t)).filter(inActiveProject);

    // System cluster (Heartbeat + Board) renders in #chat-tabs; it's first, so
    // no leading divider. Chats render in their own #chat-tabs-chats tier whose
    // `.chat-tab-tier::before` draws the boundary divider — byte-identical to the
    // Messaging/Apps/Skills group dividers (a standalone span between tiles
    // antialiased fainter / sat at a different edge, which read as "wrong color").
    for (const tab of systemTabs) {
      this._tabBar.appendChild(this._createStandardTabElement(tab));
    }
    const chatsBar = document.getElementById('chat-tabs-chats');
    if (chatsBar) chatsBar.innerHTML = '';
    const chatsTarget = chatsBar || this._tabBar; // fallback if HTML is stale
    for (const tab of chatTabs) {
      chatsTarget.appendChild(this._createStandardTabElement(tab));
    }

    const addBtn = document.createElement('span');
    addBtn.className = 'chat-tab-add';
    addBtn.textContent = '+';
    addBtn.title = 'New chat';
    addBtn.addEventListener('click', () => this._addTab(true));
    chatsTarget.appendChild(addBtn);

    const recentBtn = document.createElement('span');
    recentBtn.className = 'chat-tab-add chat-tab-recently-closed';
    recentBtn.textContent = '↺';
    recentBtn.title = 'Recently closed chats';
    recentBtn.addEventListener('click', () => this._openRecentlyClosedMenu(recentBtn));
    chatsTarget.appendChild(recentBtn);

    // Keep the chats tier visible (it always has at least the + button) so its
    // ::before divider always renders.
    const chatsWrap = document.getElementById('chat-tabs-chats-wrap');
    if (chatsWrap) chatsWrap.classList.remove('is-empty', 'is-collapsed');

    this._renderIntegrationTabs();
  },

  /** Icon HTML for a surfaced workbench row entry (pinned apps / automations / legacy rows missing `icon`). */
  _iconForSurfacedEntry(entry) {
    const scope = entry.scope || '';
    // For integrations, ALWAYS prefer the live preset's logo over `entry.icon`
    // \u2014 entry.icon was snapshotted when first pinned and may point at an old
    // file path that's since been renamed (e.g. Zoho .svg \u2192 .png after preset
    // edit). Live preset is the source of truth.
    const int = /^workbench:integration:(.+)$/.exec(scope);
    if (int) {
      const id = int[1];
      const presets = (typeof window !== 'undefined') ? window._integrationPresets : null;
      const preset = presets?.get?.(id);
      if (preset?.logo) {
        const mono = preset.logoColor ? '' : ' icon-logo-mono-img';
        const safeLogo = String(preset.logo).replace(/[<>"']/g, '');
        const safeName = String(preset.name || id).replace(/[<>"']/g, '');
        return `<img src="${safeLogo}" class="sw-icon-img${mono}" alt="${safeName}" />`;
      }
      // No preset cached yet \u2014 fall through to whatever entry.icon has, then letter fallback
      const raw = entry.icon && String(entry.icon).trim();
      if (raw) return raw;
      const letter = (id.charAt(0) || '?').toUpperCase();
      return `<span class="chat-tab-icon-fallback">${letter}</span>`;
    }

    const raw = entry.icon && String(entry.icon).trim();
    if (raw) return raw;
    const ch = /^workbench:channel:(.+)$/.exec(scope);
    if (ch) {
      const key = ch[1];
      if (this._channelIcons[key]) return this._channelIcons[key];
      if (typeof ChannelsView !== 'undefined' && ChannelsView.getIconHtml) {
        const h = ChannelsView.getIconHtml(key);
        if (h) return h;
      }
    }
    if (/^workbench:automation:/.test(scope)) return '\u26A1';
    // Skill scopes \u2014 pick from this priority chain so dock + title bar always
    // agree:  user-picked WorkbenchSurfaces entry.icon (raw emoji)
    //   \u2192    user-picked tab.icon (in-memory override)
    //   \u2192    deterministic person from skill id hash
    const sk = /^workbench:skill:(.+)$/.exec(scope);
    if (sk) {
      const entryIcon = String(entry.icon || '').trim();
      // Treat entry.icon as a user override if it's a plain emoji (no HTML tag).
      // The legacy SkillScopeAdapter wrote `<span ...>\uD83D\uDEE0</span>` HTML which we
      // ignore here \u2014 too easy to disagree with the title bar.
      if (entryIcon && !entryIcon.startsWith('<')) {
        return `<span class="chat-tab-icon-emoji">${entryIcon}</span>`;
      }
      const matchingTab = this._tabs?.find?.(t => t.conversationId === scope);
      if (matchingTab?.icon && !this._isSvgIcon(matchingTab.icon)) {
        return `<span class="chat-tab-icon-emoji">${matchingTab.icon}</span>`;
      }
      return `<span class="chat-tab-icon-emoji">${this._personIconForSkill(sk[1])}</span>`;
    }
    return '<span class="chat-tab-icon-fallback">?</span>';
  },

  /** Deterministic person emoji for a skill id \u2014 shared by dock + title bar + picker. */
  _personIconPalette: ['\uD83E\uDDD1\u200D\uD83D\uDCBC','\uD83D\uDC69\u200D\uD83D\uDCBC','\uD83D\uDC68\u200D\uD83D\uDCBC','\uD83E\uDDD1\u200D\uD83D\uDD2C','\uD83D\uDC69\u200D\uD83D\uDD2C','\uD83D\uDC68\u200D\uD83D\uDD2C','\uD83E\uDDD1\u200D\uD83C\uDFA8','\uD83D\uDC69\u200D\uD83C\uDFA8','\uD83D\uDC68\u200D\uD83C\uDFA8','\uD83E\uDDD1\u200D\uD83D\uDCBB','\uD83D\uDC69\u200D\uD83D\uDCBB','\uD83D\uDC68\u200D\uD83D\uDCBB','\uD83E\uDDD1\u200D\uD83D\uDE80','\uD83D\uDC69\u200D\uD83D\uDE80','\uD83D\uDC68\u200D\uD83D\uDE80','\uD83E\uDDD1\u200D\uD83C\uDFEB','\uD83D\uDC69\u200D\uD83C\uDFEB','\uD83D\uDC68\u200D\uD83C\uDFEB','\uD83E\uDDD1\u200D\u2695\uFE0F','\uD83D\uDC69\u200D\u2695\uFE0F','\uD83D\uDC68\u200D\u2695\uFE0F','\uD83E\uDDD1\u200D\uD83C\uDF73','\uD83D\uDC69\u200D\uD83C\uDF73','\uD83D\uDC68\u200D\uD83C\uDF73','\uD83E\uDDD1\u200D\uD83D\uDD27','\uD83E\uDDD1\u200D\uD83C\uDF3E','\uD83E\uDDD1\u200D\uD83C\uDFA4','\uD83E\uDDB8','\uD83E\uDDB9','\uD83E\uDDD9','\uD83E\uDDDD','\uD83E\uDDDA','\uD83E\uDDDE','\uD83E\uDD77','\uD83D\uDD75\uFE0F','\uD83D\uDC64'],
  _personIconForSkill(skillId) {
    const id = String(skillId || '');
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return this._personIconPalette[h % this._personIconPalette.length];
  },

  /**
   * Prune + render messaging tier (channel chats + surfaced channel workbenches)
   * and apps tier (surfaced integrations / automations / skills — not channel).
   */
  _renderIntegrationTabs() {
    const entries = typeof WorkbenchSurfaces !== 'undefined' ? WorkbenchSurfaces.list() : [];
    const surfacedConvIds = new Set(entries.map((e) => e.scope));
    this._tabs = this._tabs.filter((t) => !t.integration || surfacedConvIds.has(t.conversationId));

    this._renderMessagingTier(entries);
    this._renderAppsTier(entries);
  },

  _appendSurfacedWorkbenchTab(container, entry) {
    const convId = entry.scope;
    const isAutomation = entry.kind === 'automation';

    let tab = this._tabs.find((t) => t.conversationId === convId);
    if (tab && tab.conversationId && tab.conversationId.startsWith('workbench:channel:')) {
      const fix = /^workbench:channel:(.+)$/.exec(tab.conversationId);
      if (fix) tab.source = fix[1];
    }
    if (!tab) {
      const ch = /^workbench:channel:(.+)$/.exec(convId);
      const shortSource = ch ? ch[1] : convId;
      tab = {
        id: 'tab-wb-' + convId.replace(/[^a-zA-Z0-9_-]/g, '_'),
        title: entry.title || convId,
        conversationId: convId,
        source: shortSource,
        integration: true,
      };
      this._tabs.push(tab);
    }

    const el = document.createElement('div');
    el.className = 'chat-tab chat-tab-integration'
      + (isAutomation ? ' chat-tab-automation' : '')
      + (tab.id === this._activeTabId ? ' active' : '');
    el.setAttribute('data-source', tab.source);
    if (tab.conversationId) el.setAttribute('data-conversation-id', tab.conversationId);
    if (isAutomation) el.setAttribute('title', 'Automation chat — ask questions or type /run to trigger');

    const tabIcon = this._iconForSurfacedEntry(entry);
    if (tabIcon) {
      const iconSpan = document.createElement('span');
      iconSpan.className = 'chat-tab-icon';
      iconSpan.innerHTML = tabIcon;
      // Diagnostic: surface the tab.icon source so DevTools inspection shows
      // whether the dock got the user override or the deterministic default.
      const matchTab = this._tabs.find((t) => t.conversationId === convId);
      if (matchTab?.icon) el.setAttribute('data-tab-icon', matchTab.icon);
      el.setAttribute('data-icon-html', tabIcon.replace(/<[^>]+>/g, '').slice(0, 16));
      el.appendChild(iconSpan);
    }

    const title = document.createElement('span');
    title.className = 'chat-tab-title';
    title.textContent = entry.title || convId;
    el.appendChild(title);

    const close = document.createElement('span');
    close.className = 'chat-tab-close';
    close.textContent = '\u00D7';
    const isPersona = typeof convId === 'string' && convId.startsWith('workbench:skill:');
    close.title = isAutomation
      ? 'Hide from main chat (keeps the automation in Activity)'
      : isPersona
      ? 'Close persona — soft-deletes the conversation (recoverable)'
      : 'Hide from main chat (keeps the workbench in #/apps)';
    close.setAttribute('aria-label', close.title);
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      // If closing the active tab, switch to the first standard tab first so
      // the chat panel doesn't keep rendering the now-deleted conversation.
      if (this._activeTabId === tab.id && this._tabs && this._tabs.length > 0) {
        try { this._switchTab(this._tabs[0].id); } catch {}
      }
      WorkbenchSurfaces.remove(convId);
      if (isPersona) {
        // Keep the greet flag set across X-delete. Re-opening loads the prior
        // intro from history (soft-delete preserves messages); firing a second
        // auto-greet would race the tab-switch and pollute the conversation.
        // Drop cached messages/buffers so a future re-open re-fetches cleanly.
        try { if (this._tabMessages) delete this._tabMessages[convId]; } catch {}
        try { if (this._tabEventBuffers) delete this._tabEventBuffers[convId]; } catch {}
        API.del('/api/gateway/conversation/' + encodeURIComponent(convId)).catch((err) => {
          console.warn('[chat] soft-delete persona conv failed:', err);
        });
      }
    });
    el.appendChild(close);

    el.addEventListener('click', () => this._switchTab(tab.id));
    container.appendChild(el);
  },

  /** Row 2 — Slack/Telegram/… conversation tabs + surfaced `workbench:channel:*` only. */
  _renderMessagingTier(allEntries) {
    if (!this._messagingTabBar) return;
    this._messagingTabBar.innerHTML = '';

    const sorted = this._sortTabsStable();
    const channelTabs = sorted.filter((t) => this._isChannelConversationTab(t));
    const seenConv = new Set(channelTabs.map((t) => t.conversationId));

    for (const tab of channelTabs) {
      this._messagingTabBar.appendChild(this._createStandardTabElement(tab));
    }

    const chSurfaces = (allEntries || []).filter((e) => (e.scope || '').startsWith('workbench:channel:'));
    let addedFromSurfaces = 0;
    for (const entry of chSurfaces) {
      if (seenConv.has(entry.scope)) continue;
      seenConv.add(entry.scope);
      addedFromSurfaces++;
      this._appendSurfacedWorkbenchTab(this._messagingTabBar, entry);
    }

    const hasMessaging = channelTabs.length > 0 || addedFromSurfaces > 0;

    if (this._messagingTierWrap) {
      this._messagingTierWrap.classList.toggle('is-empty', !hasMessaging);
      if (hasMessaging) this._syncTierCollapsedFromLs(this._messagingTierWrap, this._tabTierLsKeyMessaging, 'chat-tabs-messaging-toggle');
    }
  },

  /** Row 3 — surfaced workbenches except channel scopes. Integrations live in
   *  the Apps tier; `workbench:skill:*` personas live in the Skills tier (dock
   *  label "Skills"); scheduled **automations** are hoisted into the Group-1
   *  system cluster (#chat-tabs) alongside Heartbeat + Board — every scheduled
   *  automatic run reads as one grouping. Skill-console tabs stay on row 1. */
  _renderAppsTier(allEntries) {
    if (!this._integrationTabBar) return;
    this._integrationTabBar.innerHTML = '';
    if (this._skillsTabBar) this._skillsTabBar.innerHTML = '';

    const isAutomationEntry = (e) =>
      e.kind === 'automation' || (e.scope || '').startsWith('workbench:automation:');

    const appEntries = (allEntries || []).filter((e) => !(e.scope || '').startsWith('workbench:channel:'));
    const skillEntries = appEntries.filter((e) => (e.scope || '').startsWith('workbench:skill:'));
    const automationEntries = appEntries.filter(isAutomationEntry);
    const otherEntries = appEntries.filter(
      (e) => !(e.scope || '').startsWith('workbench:skill:') && !isAutomationEntry(e)
    );

    // Group 1 (system cluster): Heartbeat + Board are already rendered into
    // #chat-tabs by _renderTabs; append scheduled automations right after them.
    // Idempotent — clear any previously-hoisted automation tabs first, because
    // _renderIntegrationTabs() also runs standalone on WorkbenchSurfaces changes
    // (not just at the end of _renderTabs), so a naive append would duplicate.
    if (this._tabBar) {
      this._tabBar.querySelectorAll('.chat-tab-automation').forEach((el) => el.remove());
      for (const entry of automationEntries) {
        this._appendSurfacedWorkbenchTab(this._tabBar, entry);
      }
    }

    for (const entry of otherEntries) {
      this._appendSurfacedWorkbenchTab(this._integrationTabBar, entry);
    }
    if (this._skillsTabBar) {
      for (const entry of skillEntries) {
        this._appendSurfacedWorkbenchTab(this._skillsTabBar, entry);
      }
    }

    const hasApps = otherEntries.length > 0;
    const hasSkills = !!(this._skillsTabBar && this._skillsTabBar.childElementCount > 0);
    if (this._appsTierWrap) {
      this._appsTierWrap.classList.toggle('is-empty', !hasApps);
      if (hasApps) this._syncTierCollapsedFromLs(this._appsTierWrap, this._tabTierLsKeyApps, 'chat-tabs-apps-toggle');
    }
    if (this._skillsTierWrap) {
      this._skillsTierWrap.classList.toggle('is-empty', !hasSkills);
      if (hasSkills) this._syncTierCollapsedFromLs(this._skillsTierWrap, this._tabTierLsKeySkills, 'chat-tabs-skills-toggle');
    }
    if (this._updateDockOverflow) requestAnimationFrame(this._updateDockOverflow);
  },

  _saveTabs() {
    // Don't persist surfaced-workbench tabs — WorkbenchSurfaces owns that list.
    const persistable = this._tabs.filter((t) => !t.integration);
    localStorage.setItem('vodou-chat-tabs', JSON.stringify({
      tabs: persistable,
      activeTabId: this._activeTabId,
    }));
  },

  /** Get the active tab's conversation ID for sending messages */
  _getConversationId() {
    const tab = this._tabs.find(t => t.id === this._activeTabId);
    return tab ? tab.conversationId : null;
  },

  /** Auto-title a tab based on the first user message */
  _autoTitleTab(text) {
    const tab = this._tabs.find(t => t.id === this._activeTabId);
    if (tab && tab.title.startsWith('Chat ')) {
      const title = text.substring(0, 25) + (text.length > 25 ? '...' : '');
      tab.title = title;
      this._saveTabs();
      this._renderTabs();
      // Persist title to gateway.db so it survives server restarts
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'update_title',
          conversationId: tab.conversationId,
          title: title,
        }));
      }
    }
  },

  // ============================================================
  // Interactive action handlers
  // ============================================================

  /** Fetch and render link preview cards for URLs in a message */
  async _renderLinkPreviews(msgContent) {
    if (!msgContent) return;

    const urls = new Set();

    // 1. Find <a> tags with http URLs
    msgContent.querySelectorAll('a[href^="http"]').forEach(a => {
      const href = a.href;
      if (!/\.(png|jpg|jpeg|gif|svg|webp|mp4|mp3|pdf)$/i.test(href)) {
        urls.add(href);
      }
    });

    // 2. Also detect bare domain names in text (e.g. "GitHub.com", "anthropic.com")
    const text = msgContent.innerText || '';
    const domainPattern = /\b([a-zA-Z0-9-]+\.(?:com|org|net|io|ai|dev|co|app|xyz|me|us|uk|de))\b/gi;
    let match;
    while ((match = domainPattern.exec(text)) !== null) {
      const domain = match[1].toLowerCase();
      // Skip if we already have a full URL for this domain
      const alreadyHave = [...urls].some(u => u.includes(domain));
      if (!alreadyHave) {
        urls.add('https://' + domain);
      }
    }

    if (urls.size === 0) return;

    const maxPreviews = 3;
    let count = 0;

    for (const url of urls) {
      if (count >= maxPreviews) break;

      // Sanity-check the URL before hitting the preview API. `a.href` can
      // return malformed values when the underlying HTML had unescaped
      // `<` characters inside href attributes (e.g. from tool-call result
      // panels) — the parser cuts at the `<`, producing things like
      // `http://localhost:8765<img class=` that 400 on the API.
      try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
        if (/[<>"'`\s]/.test(url)) continue; // stray markup chars = malformed
      } catch {
        continue; // URL constructor rejected it
      }

      try {
        const res = await fetch('/api/link-preview?url=' + encodeURIComponent(url));
        if (!res.ok) continue;
        const data = await res.json();
        if (!data.title) continue;

        const card = document.createElement('a');
        card.className = 'link-preview';
        card.href = url;
        card.target = '_blank';
        card.rel = 'noopener';

        let html = '';
        if (data.favicon) {
          html += '<img class="link-preview-favicon" src="' + data.favicon + '" onerror="this.remove()" />';
        }
        html += '<div class="link-preview-body">';
        html += '<div class="link-preview-title">' + this.escapeHtml(data.title) + '</div>';
        if (data.description) {
          html += '<div class="link-preview-desc">' + this.escapeHtml(data.description) + '</div>';
        }
        html += '<div class="link-preview-domain">' + this.escapeHtml(data.domain) + '</div>';
        html += '</div>';
        if (data.image) {
          html += '<img class="link-preview-image" src="' + data.image + '" onerror="this.remove()" />';
        }

        card.innerHTML = html;
        msgContent.appendChild(card);
        count++;
      } catch {
        // Skip failed previews silently
      }
    }
    if (count > 0) this.scrollToBottom();
  },

  /** Render any pending mermaid diagrams by scanning the DOM */
  async _renderMermaids() {
    if (typeof mermaid === 'undefined') return;

    const pendingEls = document.querySelectorAll('.mermaid-pending');
    if (pendingEls.length === 0) return;

    // Lazy-load mermaid on first diagram — ~2.8 MB bundle kept off every non-chat page.
    const m = await ensureMermaid();

    let counter = 0;
    for (const el of pendingEls) {
      const rawCode = el.dataset.mermaidCode;
      if (!rawCode) continue;
      // Decode the encoded newlines back
      const code = rawCode.replace(/␊/g, '\n');

      const renderId = 'mermaid-render-' + Date.now() + '-' + (counter++);

      try {
        const { svg } = await m.render(renderId, code);
        el.className = 'mermaid-rendered';
        el.removeAttribute('data-mermaid-code');
        el.innerHTML = '<code data-code="' + code.replace(/"/g, '&quot;') + '" class="is-hidden">' + code + '</code>' + svg;
      } catch (err) {
        el.className = 'mermaid-rendered';
        el.removeAttribute('data-mermaid-code');
        // Clean up error SVGs
        const errEl = document.getElementById('d' + renderId);
        if (errEl) errEl.remove();

        el.innerHTML = '<code data-code="' + code.replace(/"/g, '&quot;') + '" class="is-hidden">' + code + '</code>' +
          '<div class="mermaid-error">Diagram render failed: ' + this.escapeHtml(String(err.message || err)) + '</div>' +
          '<pre class="mermaid-code-preview">' + this.escapeHtml(code) + '</pre>' +
          '<button class="code-action-btn mt-2" onclick="ChatView._fixDiagram(this)">Ask Vodou to fix</button>';
      }
    }
  },

  /** Ask Vodou to fix a broken mermaid diagram */
  _fixDiagram(btn) {
    const wrapper = btn.closest('.mermaid-wrapper');
    const code = wrapper?.querySelector('code')?.dataset?.code;
    if (!code) return;
    this.sendMessage('The mermaid diagram had a syntax error. Fix this mermaid code and give me a corrected version:\n```mermaid\n' + code + '\n```');
  },

  /** Click a command chip → fill the input */
  _fillCommand(el) {
    const cmd = el.dataset.cmd;
    if (!cmd) return;
    this.input.value = cmd;
    this.input.focus();
    this._autoResizeInput();
  },

  /** Copy code block content */
  _copyCode(btn) {
    const wrapper = btn.closest('.code-block-wrapper');
    const code = wrapper.querySelector('code');
    const text = code.dataset.code || code.textContent;
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('copied');
      }, 1500);
    }).catch(() => {
      // Clipboard write can reject (insecure context / denied permission) —
      // show a failure state rather than leaving the button stuck on "Copy".
      btn.textContent = 'Copy failed';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
  },

  /** Run a shell code block */
  _runCode(btn) {
    const wrapper = btn.closest('.code-block-wrapper');
    const code = wrapper.querySelector('code');
    let text = code.dataset.code || code.textContent;
    // Strip leading $ or # prompts
    text = text.replace(/^\$\s+/, '').replace(/^#\s+/, '');
    // Preserve scroll position — don't jump when clicking Run mid-page
    const scrollPos = this.messagesEl.scrollTop;
    this.sendMessage(text);
    this.messagesEl.scrollTop = scrollPos;
  },

  /** Click a stopping point option button */
  _selectOption(btn, num) {
    // Highlight selected, dim others
    const menu = btn.closest('.stopping-point-menu');
    menu.querySelectorAll('.sp-button').forEach(b => {
      if (b === btn) {
        b.classList.add('selected');
      } else {
        b.classList.add('dimmed');
      }
    });
    // Preserve scroll position — don't jump when clicking a button mid-page
    const scrollPos = this.messagesEl.scrollTop;
    const label = btn.textContent.replace(/^\s*\d+[\.\):\s]*/, '').trim();
    this.sendMessage(num + '. ' + label);
    this.messagesEl.scrollTop = scrollPos;
  },

  /** Collect images from tool output: data URIs, https URLs, then absolute local paths (paths not inside stripped URLs). */
  _extractRenderableImages(resultText) {
    if (!resultText || typeof resultText !== 'string') return [];
    const out = [];
    const seen = new Set();
    const add = (item) => {
      const key = item.type + '\0' + (item.url || item.path || item.data).slice(0, 500);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(item);
    };
    let m;
    const dataRe = /data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+/gi;
    while ((m = dataRe.exec(resultText)) !== null) add({ type: 'data', data: m[0] });
    const urlRe = /https?:\/\/[^\s"'<>[\]()]+?\.(?:png|jpg|jpeg|gif|svg|webp)(?:\?[^\s"'<>[\]()]+)?/gi;
    while ((m = urlRe.exec(resultText)) !== null) add({ type: 'http', url: m[0] });
    // Local absolute-path auto-render disabled — was spamming the chat with
    // broken inline "Image" messages for every icon/logo path (e.g. /icons/brands/*.svg,
    // /icons/oi-512.png) found in tool result JSON. HTTP URLs + data URIs still render.
    // const cleaned = resultText
    //   .replace(/https?:\/\/[^\s"'<>[\]()]+?\.(?:png|jpg|jpeg|gif|svg|webp)(?:\?[^\s"'<>[\]()]+)?/gi, ' ')
    //   .replace(/data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+/gi, ' ');
    // const pathRe = /(\/[^\s"']+\.(?:png|jpg|jpeg|gif|webp))/gi;
    // while ((m = pathRe.exec(cleaned)) !== null) add({ type: 'local', path: m[1] });
    return out;
  },

  _toolImageAuthor(toolName, server) {
    const parts = [server, toolName].filter(Boolean).map(String).map((s) => s.trim()).filter(Boolean);
    const joined = parts.join(': ');
    if (joined && joined !== 'tool' && joined.length < 52) return joined;
    return 'Image';
  },

  /** Remote image (e.g. Monday CDN) — no /api/files proxy */
  _showInlineHttpImage(url, toolName, server) {
    const author = this._toolImageAuthor(toolName, server);
    const el = this.createMsgEl(author, 'tool-name', 'tool-av', '🖼', '', '');
    const wrap = document.createElement('div');
    const img = document.createElement('img');
    img.className = 'chat-image';
    img.src = url;
    img.referrerPolicy = 'no-referrer';
    img.loading = 'lazy';
    img.alt = (url.split('/').pop() || 'image').split('?')[0];
    img.onclick = function () {
      ChatView._openLightbox(this.src);
    };
    img.onerror = function () {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'chat-image-fallback-link';
      a.textContent = 'Image could not be embedded — open in new tab';
      img.replaceWith(a);
    };
    const cap = document.createElement('div');
    cap.className = 'chat-image-caption';
    cap.textContent = img.alt + (author !== 'Image' ? ' — ' + author : '');
    wrap.appendChild(img);
    wrap.appendChild(cap);
    el.content.appendChild(wrap);
    this.messagesEl.appendChild(el.msg);
    this.scrollToBottom();
  },

  /** Show a base64 image inline in the chat */
  _showInlineDataImage(dataUri, toolName, server) {
    const author = this._toolImageAuthor(toolName, server);
    const el = this.createMsgEl(author, 'tool-name', 'tool-av', '🖼', '', '');
    const imgContainer = document.createElement('div');
    imgContainer.innerHTML =
      '<img class="chat-image" src="' +
      dataUri +
      '" onclick="ChatView._openLightbox(this.src)" alt="image" />' +
      '<div class="chat-image-caption">Embedded image' +
      (author !== 'Image' ? ' — ' + this.escapeHtml(author) : '') +
      '</div>';
    el.content.appendChild(imgContainer);
    this.messagesEl.appendChild(el.msg);
    this.scrollToBottom();
  },

  /** Show an image inline in the chat from a tool result */
  _showInlineImage(filePath, toolName, server) {
    const src = '/api/files?path=' + encodeURIComponent(filePath);
    const name = filePath.split('/').pop() || 'image';
    const author = this._toolImageAuthor(toolName, server);
    const el = this.createMsgEl(author, 'tool-name', 'tool-av', '🖼', '', '');
    const imgContainer = document.createElement('div');
    imgContainer.innerHTML =
      '<img class="chat-image" src="' +
      src +
      '" onclick="ChatView._openLightbox(this.src)" alt="' +
      this.escapeAttr(name) +
      '" loading="lazy" />' +
      '<div class="chat-image-caption">' +
      this.escapeHtml(name) +
      (author !== 'Image' ? ' — ' + this.escapeHtml(author) : '') +
      '</div>';
    el.content.appendChild(imgContainer);
    this.messagesEl.appendChild(el.msg);
    this.scrollToBottom();
  },

  /** Render a local file path as an inline image (for markdown rendering) */
  _inlineImage(filePath) {
    const src = '/api/files?path=' + encodeURIComponent(filePath);
    const name = filePath.split('/').pop();
    return '<img class="chat-image" src="' + src + '" onclick="ChatView._openLightbox(this.src)" alt="' + name + '" loading="lazy" />' +
      '<div class="chat-image-caption">' + name + '</div>';
  },

  /** Open lightbox with full-size image */
  _openLightbox(src) {
    const overlay = document.getElementById('lightbox-overlay');
    const img = document.getElementById('lightbox-img');
    if (!overlay || !img) return;
    img.src = src;
    overlay.classList.add('visible');
    // Close on Escape
    this._lightboxEscHandler = (e) => {
      if (e.key === 'Escape') this._closeLightbox();
    };
    document.addEventListener('keydown', this._lightboxEscHandler);
  },

  /** Close lightbox */
  _closeLightbox() {
    const overlay = document.getElementById('lightbox-overlay');
    if (overlay) overlay.classList.remove('visible');
    if (this._lightboxEscHandler) {
      document.removeEventListener('keydown', this._lightboxEscHandler);
      this._lightboxEscHandler = null;
    }
  },

  // ============================================================
  // Active Model Indicator
  // ============================================================

  _lastModelLabel: null,
  _modelInitCount: 0,

  _updateModelIndicator(label) {
    if (!label) return;
    // Update the persistent indicator at bottom of chat
    const el = document.getElementById('chat-model-indicator');
    if (el) el.textContent = label;
    // Post a system message only for real mid-session switches, not initial connect.
    // First 2 calls are connect + stats refresh with slightly different labels — skip both.
    this._modelInitCount = (this._modelInitCount || 0) + 1;
    if (this._modelInitCount > 2 && this._lastModelLabel && label !== this._lastModelLabel) {
      this.addMessage(`Model switched to **${label}**`, 'system');
    }
    this._lastModelLabel = label;
    // Phase 5.1: refresh hosted-token meter when provider/model changes. Only
    // shown when on a hosted provider (Fireworks/Together) and the backend
    // reports a real monthly token limit.
    void this._refreshTokenMeter();
  },

  /** Phase 5.1: fetch /api/usage/limits and render the meter. */
  async _refreshTokenMeter() {
    const el = document.getElementById('chat-token-meter');
    if (!el) return;
    const provider = this._currentProvider || '';
    // Only hosted providers get the meter — BYOK doesn't count against our quota.
    if (provider !== 'fireworks' && provider !== 'together') {
      el.classList.add('is-hidden');
      el.textContent = '';
      return;
    }
    try {
      const resp = await fetch('/api/usage/limits');
      if (!resp.ok) { el.classList.add('is-hidden'); return; }
      const body = await resp.json();
      const d = body?.data || body;
      const limit = d?.monthly_token_limit ?? 0;
      const used = d?.tokens_used ?? 0;
      if (limit <= 0) {
        // No hosted plan = nothing to meter.
        el.classList.add('is-hidden');
        return;
      }
      const pct = Math.min(100, Math.round((used / limit) * 100));
      const fmt = (n) => n >= 1_000_000 ? (n / 1_000_000).toFixed(2) + 'M'
        : n >= 1_000 ? (n / 1_000).toFixed(1) + 'K' : String(n);
      el.textContent = `${fmt(used)} / ${fmt(limit)} (${pct}%)`;
      el.classList.remove('chat-token-meter--warn', 'chat-token-meter--crit');
      if (pct >= 100) el.classList.add('chat-token-meter--crit');
      else if (pct >= 80) el.classList.add('chat-token-meter--warn');
      el.classList.remove('is-hidden');
      el.onclick = () => {
        const base = (window.VODOU_APP_BASE || 'https://app.vodou.ai').replace(/\/$/, '');
        window.open(base + '/dashboard/billing', '_blank');
      };
    } catch {
      el.classList.add('is-hidden');
    }
  },

  // ============================================================
  // Voice Input
  // ============================================================

  _initVoice() {
    this._voiceBtn = document.getElementById('voice-btn');
    if (!this._voiceBtn) return;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      this._voiceBtn.classList.add('unsupported');
      return;
    }

    this._recognition = new SpeechRecognition();
    this._recognition.continuous = true;
    this._recognition.interimResults = true;
    this._recognition.lang = 'en-US';
    this._isRecording = false;
    this._voiceTextBefore = '';
    this._voiceFinal = '';       // accumulated final transcription
    this._voiceSilenceTimer = null;

    this._recognition.onresult = (event) => {
      let interim = '';
      let allFinal = '';
      for (let i = 0; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          allFinal += transcript;
        } else {
          interim += transcript;
        }
      }
      this._voiceFinal = allFinal;

      // Show transcription in textarea
      this.input.value = this._voiceTextBefore + this._voiceFinal + interim;
      this._autoResizeInput();

      // Reset silence timer — stop after 3s of no new results
      if (this._voiceSilenceTimer) clearTimeout(this._voiceSilenceTimer);
      this._voiceSilenceTimer = setTimeout(() => {
        if (this._isRecording) this._stopVoice();
      }, 3000);
    };

    this._recognition.onend = () => {
      // Don't auto-restart — natural pause means done
      if (this._isRecording) {
        this._stopVoice();
      }
    };

    this._recognition.onerror = (event) => {
      if (event.error === 'not-allowed') {
        this.addMessage('Microphone access denied. Allow it in browser settings.', 'system');
      }
      this._stopVoice();
    };

    this._voiceBtn.addEventListener('click', () => {
      if (this._isRecording) {
        this._stopVoice();
      } else {
        this._startVoice();
      }
    });
  },

  _startVoice() {
    if (!this._recognition) return;
    this._isRecording = true;
    this._voiceTextBefore = this.input.value;
    this._voiceFinal = '';
    this._voiceBtn.classList.add('recording');
    this._voiceBtn.title = 'Recording... click to stop';
    this.input.placeholder = 'Listening...';
    this._setVoiceState('listening');
    try {
      this._recognition.start();
    } catch {
      this._stopVoice();
    }
  },

  _stopVoice() {
    if (!this._recognition) return;
    this._isRecording = false;
    if (this._voiceSilenceTimer) {
      clearTimeout(this._voiceSilenceTimer);
      this._voiceSilenceTimer = null;
    }
    this._voiceBtn.classList.remove('recording');
    this._voiceBtn.title = 'Voice input (click to speak)';
    this.input.placeholder = 'Message Vodou...';
    try {
      this._recognition.stop();
    } catch {}

    // Voice loop: auto-send when auto-speak is ON and we have transcribed text
    const transcribed = this.input.value.trim();
    if (this._autoSpeak && transcribed) {
      this._setVoiceState('thinking');
      this.sendMessage();
    } else {
      this._setVoiceState(this._autoSpeak ? 'idle' : null);
      this.input.focus();
    }
  },

  /** Update voice mode bar state: 'listening' | 'thinking' | 'speaking' | 'idle' | null (hidden) */
  _setVoiceState(state) {
    const bar = document.getElementById('voice-mode-bar');
    const dot = bar ? bar.querySelector('.voice-state-dot') : null;
    const label = document.getElementById('voice-mode-label');
    if (!bar) return;

    if (!state || !this._autoSpeak) {
      bar.classList.remove('visible');
      return;
    }

    bar.classList.add('visible');
    if (dot) {
      dot.className = 'voice-state-dot ' + state;
    }
    if (label) {
      const labels = {
        listening: 'Listening...',
        thinking: 'Thinking...',
        speaking: 'Speaking...',
        idle: 'Voice mode ready',
      };
      label.textContent = labels[state] || state;
    }
  },

  // ============================================================
  // Drag & Drop — extracted to /js/chat-file-drop.js (ChatFileDrop.attach)
  // ============================================================

  // Provider file capability map
  _FILE_CAPS: {
    // What each provider can actually process (not just receive a path reference)
    'claude-cli':  { text: true, image: true, pdf: true,  document: 'tools', audio: false, video: false },
    'anthropic':   { text: true, image: true, pdf: true,  document: false,   audio: false, video: false },
    'openai':      { text: true, image: true, pdf: false, document: false,   audio: false, video: false },
    'google':      { text: true, image: true, pdf: true,  document: false,   audio: true,  video: true  },
    'groq':        { text: true, image: 'some models', pdf: false, document: false, audio: 'whisper', video: false },
    'deepseek':    { text: true, image: false, pdf: false, document: false,  audio: false, video: false },
    'kimi-cli':    { text: true, image: 'model-dependent', pdf: false, document: false, audio: false, video: false },
    'kimi':        { text: true, image: 'model-dependent', pdf: false, document: false, audio: false, video: false },
    'xai':         { text: true, image: true, pdf: false, document: false,   audio: false, video: false },
    'mistral':     { text: true, image: 'pixtral', pdf: false, document: false, audio: false, video: false },
    'openrouter':  { text: true, image: 'model-dependent', pdf: false, document: false, audio: false, video: false },
    'ollama':      { text: true, image: 'some models', pdf: false, document: false, audio: false, video: false },
    'custom':      { text: true, image: 'unknown', pdf: 'unknown', document: 'unknown', audio: 'unknown', video: 'unknown' },
    // Fireworks: Kimi K2.6 (default) + Llama 3.2 Vision + Qwen3 VL all support images.
    // Default to true since the catalog we ship in the dropdown is all vision-capable.
    'fireworks':   { text: true, image: true, pdf: false, document: false, audio: false, video: false },
    // Together: Kimi K2.6 (default) + Llama 3.2 Vision + Qwen3.6 Plus all support images.
    'together':    { text: true, image: true, pdf: false, document: false, audio: false, video: false },
    'none':        { text: true, image: false, pdf: false, document: false, audio: false, video: false },
  },

  _modelDisplayName(provider, settings) {
    if (provider === 'claude-cli') {
      const m = (settings.cli_model || 'sonnet').toLowerCase();
      if (m.includes('fable')) return 'Claude Fable';
      if (m.includes('opus')) return 'Claude Opus';
      if (m.includes('haiku')) return 'Claude Haiku';
      return 'Claude Sonnet';
    }
    const names = {
      'anthropic': 'Anthropic API', 'openai': settings.openai_model || 'OpenAI',
      'google': settings.google_model || 'Gemini', 'groq': settings.groq_model || 'Groq',
      'deepseek': settings.deepseek_model || 'DeepSeek', 'xai': settings.xai_model || 'xAI',
      'kimi-cli': settings.kimi_cli_model || 'Kimi CLI',
      'kimi': settings.kimi_model || 'Kimi',
      'mistral': settings.mistral_model || 'Mistral',
      'openrouter': settings.openrouter_model || 'OpenRouter',
      'fireworks': settings.fireworks_model || 'Fireworks',
      'together': settings.together_model || 'Together',
      'ollama': 'Ollama',
      'custom': 'Custom LLM',
    };
    return names[provider] || provider;
  },

  async _fetchProvider() {
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      this._currentProvider = data.provider || 'none';
      // Show model name immediately from settings — don't wait for ensure
      if (this._currentProvider !== 'none') {
        this._updateModelIndicator(this._modelDisplayName(this._currentProvider, data));
      }
    } catch { this._currentProvider = 'none'; }

    // Canonical label from server (matches WebSocket `activeModel` — DB-synced provider)
    await this._refreshFooterModel();

    // Silently verify LLM readiness in background
    this._ensureProvider();
  },

  /** Footer text from GET /stats — same source as WS `connected` / `done` activeModel */
  async _refreshFooterModel() {
    try {
      const res = await fetch('/stats');
      const data = await res.json();
      if (data.authType) this._currentProvider = data.authType;
      if (data.activeModelLabel) this._updateModelIndicator(data.activeModelLabel);
    } catch {}
  },

  async _ensureProvider() {
    try {
      const res = await fetch('/api/settings/ensure', { method: 'POST' });
      const data = await res.json();

      if (data.ready) {
        if (data.action) {
          Components.toast(data.message, 'success');
        }
      } else {
        // Show what's wrong and how to fix it
        const level = data.status === 'starting' ? 'warning' : 'error';
        Components.toast(data.message, level);

        // Update model indicator to show the problem
        this._updateModelIndicator(data.message);

        // If starting (e.g. Ollama spin-up), re-check after a delay
        if (data.status === 'starting') {
          setTimeout(() => this._ensureProvider(), 5000);
        }
      }
    } catch {
      // Gateway itself is down — WebSocket will handle reconnection
    }
  },

  _getFileWarning(fileCategory) {
    const caps = this._FILE_CAPS[this._currentProvider] || this._FILE_CAPS['none'];
    const support = caps[fileCategory];
    const providerName = {
      'claude-cli': 'Claude CLI', 'anthropic': 'Anthropic API', 'openai': 'OpenAI',
      'google': 'Google Gemini', 'groq': 'Groq', 'deepseek': 'DeepSeek',
      'kimi-cli': 'Kimi CLI', 'kimi': 'Kimi (Moonshot)',
      'xai': 'xAI (Grok)', 'mistral': 'Mistral', 'openrouter': 'OpenRouter',
      'fireworks': 'Fireworks.ai', 'together': 'Together.ai',
      'ollama': 'Ollama',
      'custom': 'Custom', 'none': 'No provider',
    }[this._currentProvider] || this._currentProvider;

    if (support === true) return null; // Fully supported
    if (support === false) return providerName + ' cannot process ' + fileCategory + ' files. The file path will be shared, but the LLM cannot read its contents. Switch to a supported provider in Settings.';
    if (support === 'tools') return providerName + ' can process ' + fileCategory + ' files via MCP tools (not natively).';
    if (typeof support === 'string') return providerName + ': ' + fileCategory + ' support depends on model (' + support + '). File will be uploaded — results may vary.';
    return null;
  },

  /** Copy full message text */
  _copyMessage(btn) {
    const msgContent = btn.closest('.message').querySelector('.msg-content');
    const text = msgContent.innerText || msgContent.textContent;
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    }).catch(() => {
      // Clipboard can reject in insecure contexts or when permission is denied —
      // surface a failure state instead of leaving the button silently unchanged.
      btn.textContent = 'Copy failed';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
  },

  /** Regenerate — find the user message before this assistant message and resend it */
  _regenerateMessage(btn) {
    const assistantMsg = btn.closest('.message');
    // Walk backwards through messages to find the preceding user message
    let prev = assistantMsg.previousElementSibling;
    while (prev) {
      if (prev.querySelector('.user-name')) {
        const userText = prev.querySelector('.msg-content')?.innerText?.trim();
        if (userText) {
          this.sendMessage(userText);
          return;
        }
      }
      prev = prev.previousElementSibling;
    }
  },

  /** Save this response to memory */
  async _pinMessage(btn) {
    const msgContent = btn.closest('.message').querySelector('.msg-content');
    const text = msgContent.innerText || msgContent.textContent;
    if (!text || text.length < 5) return;

    btn.textContent = 'Saving...';
    btn.disabled = true;

    try {
      await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: text.substring(0, 5000),
          source: 'gateway-pin',
        }),
      });
      btn.textContent = 'Saved!';
      btn.classList.add('status-ok-text');
      setTimeout(() => {
        btn.textContent = 'Add to memory';
        btn.classList.remove('status-ok-text');
        btn.disabled = false;
      }, 2000);
    } catch {
      btn.textContent = 'Failed';
      btn.classList.add('status-error-text');
      setTimeout(() => {
        btn.textContent = 'Add to memory';
        btn.classList.remove('status-error-text');
        btn.disabled = false;
      }, 2000);
    }
  },

  // ============================================================
  // Message elements
  // ============================================================

  createMsgEl(author, authorClass, avatarClass, avatarText, contentHtml, contentClass, timestamp, avatarColor, dbMessageId) {
    const msg = document.createElement('div');
    msg.className = 'message';
    const role = authorClass.includes('assistant') ? 'assistant' : authorClass.includes('user') ? 'user' : 'system';
    msg.dataset.role = role;
    if (dbMessageId != null && Number.isFinite(Number(dbMessageId))) {
      msg.dataset.id = String(dbMessageId);
    }

    const av = document.createElement('div');
    av.className = 'msg-avatar ' + avatarClass;
    if (avatarText && (avatarText.startsWith('/') || avatarText.startsWith('http'))) {
      const img = document.createElement('img');
      img.src = avatarText;
      img.className = 'msg-avatar-image';
      av.appendChild(img);
    } else {
      const initials = avatarText || author.slice(0, 2).toUpperCase();
      av.textContent = initials;
      av.classList.add(initials.length > 1 ? 'msg-avatar-initials-wide' : 'msg-avatar-initials-narrow');
      if (avatarColor && role === 'assistant') {
        av.classList.add(this._ensureAvatarColorClass(avatarColor));
      }
    }

    const hdr = document.createElement('div');
    hdr.className = 'msg-header';
    const name = document.createElement('span');
    name.className = 'msg-author ' + authorClass;
    name.textContent = author;
    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = this.getTime(timestamp);
    hdr.appendChild(name);
    hdr.appendChild(time);

    // Avatar + name on same row
    const hdrRow = document.createElement('div');
    hdrRow.className = 'msg-header-row';
    hdrRow.appendChild(av);
    hdrRow.appendChild(hdr);

    const content = document.createElement('div');
    content.className = 'msg-content' + (contentClass ? ' ' + contentClass : '');
    content.innerHTML = contentHtml;

    const body = document.createElement('div');
    body.className = 'msg-body';
    body.appendChild(hdrRow);
    body.appendChild(content);
    msg.appendChild(body);

    // Add response action bar for assistant messages
    if (authorClass === 'assistant-name') {
      const actions = document.createElement('div');
      actions.className = 'msg-actions';
      actions.innerHTML =
        '<button class="msg-action-btn" onclick="ChatView._copyMessage(this)">Copy</button>' +
        '<button class="msg-action-btn" onclick="ChatView._regenerateMessage(this)">Regenerate</button>' +
        '<button class="msg-action-btn" onclick="ChatView._pinMessage(this)">Add to memory</button>';
      msg.appendChild(actions);
    }

    return { msg, content };
  },

  scrollToBottom() {
    // Respect the user's scroll: once they've scrolled up, auto-scrolls
    // (streaming chunks, re-renders, the load snap) stop yanking them down.
    if (this._stickToBottom === false) return;
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  },

  /** Force the view to the bottom and re-arm sticking — for explicit user
   *  actions (sending a message, switching to a tab) where bottom is intended. */
  _forceScrollToBottom() {
    this._stickToBottom = true;
    if (this.messagesEl) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  },

  /**
   * Snap a freshly-loaded tab/history to the bottom with NO visible scroll.
   * Masks the container with visibility:hidden, jumps scrollTop to the
   * bottom across a couple of layout frames (so markdown/briefing height
   * changes are caught), then reveals — so the content simply appears
   * already at the bottom instead of loading at the top and visibly
   * scrolling down. Dropped the old 400ms delayed re-scroll, which was the
   * late "jump to bottom" the user saw on tab load.
   */
  _scrollToBottomAfterLayout() {
    if (!this.messagesEl) return;
    const el = this.messagesEl;
    // Abort any remaining snap once the user has scrolled away — otherwise the
    // staggered snaps across load (cached msgs → server history → briefing) keep
    // pulling them back. The reveal still always runs so the view never stays hidden.
    const snap = () => { if (this._stickToBottom !== false) el.scrollTop = el.scrollHeight; };
    el.style.visibility = 'hidden';
    snap();
    requestAnimationFrame(() => {
      snap();
      requestAnimationFrame(() => {
        snap();
        el.style.visibility = '';
      });
    });
    // Safety net: if rAF is throttled (e.g. background tab), never leave the
    // container hidden — reveal after a short timeout regardless.
    setTimeout(() => {
      snap();
      el.style.visibility = '';
    }, 150);
  },

  /** Scroll so the start of the current streaming message stays visible at the top */
  _scrollToStreamStart() {
    if (!this.currentMessage) {
      this.scrollToBottom();
      return;
    }
    const msgEl = this.currentMessage.closest('.message');
    if (!msgEl) { this.scrollToBottom(); return; }

    const containerRect = this.messagesEl.getBoundingClientRect();
    const msgRect = msgEl.getBoundingClientRect();
    const msgTop = msgRect.top - containerRect.top + this.messagesEl.scrollTop;

    // If the message start is above the viewport, pin it to the top with a small offset
    // If the user has manually scrolled up (away from the message), don't fight them
    const currentScroll = this.messagesEl.scrollTop;
    const msgStartScroll = msgTop - 12; // 12px padding from top

    // Only auto-scroll if user hasn't scrolled up significantly above the message
    const viewportBottom = currentScroll + this.messagesEl.clientHeight;
    const isUserScrolledAway = currentScroll < msgStartScroll - this.messagesEl.clientHeight;

    if (isUserScrolledAway) return; // user scrolled up to read something else — leave them alone

    // Pin message start at top of viewport (don't scroll past it)
    if (msgStartScroll > currentScroll) {
      // Message start is below current scroll — only scroll down if content overflows viewport
      const msgHeight = msgRect.height;
      if (msgHeight > this.messagesEl.clientHeight * 0.7) {
        // Long message — pin the start at top
        this.messagesEl.scrollTop = msgStartScroll;
      } else {
        // Short message — scroll to bottom as usual
        this.scrollToBottom();
      }
    }
  },

  addMessage(text, type, timestamp, opts) {
    const dbId = opts && typeof opts.dbId === 'number' ? opts.dbId : (opts && opts.dbId != null ? Number(opts.dbId) : undefined);
    const skipScroll = opts && opts.skipScroll === true;
    const senderLabel = opts && typeof opts.senderLabel === 'string' && opts.senderLabel.trim() ? opts.senderLabel.trim() : '';
    this.removeTyping();
    let el;
    if (type === 'user') {
      // Collapse heartbeat prompts into a clean summary card
      const hbMatch = text.match(/^\[Heartbeat\s*\|\s*Lens:\s*(\w+)\s*\|\s*Run:\s*(\d+)/);
      if (hbMatch) {
        const lens = hbMatch[1];
        const run = hbMatch[2];
        const summary = '<span class="hb-prompt-card cursor-pointer" title="Click to expand run details">' +
          '<span class="hb-prompt-icon">&#x1F50E;</span> ' +
          'Heartbeat Run #' + this.escapeHtml(run) +
          ' <span class="hb-prompt-lens">' + this.escapeHtml(lens) + '</span>' +
          '<span class="hb-expand-arrow">&#9660;</span>' +
          '</span>' +
          '<div class="hb-run-details is-hidden">' +
            '<div class="opacity-60">Loading...</div>' +
          '</div>';
        el = this.createMsgEl(this._aiName, 'user-name', 'user-av', this._aiEmoji, summary, '', timestamp, undefined, dbId);
        el.msg.classList.add('heartbeat-prompt');
        // Click to expand/collapse run details
        const card = el.msg.querySelector('.hb-prompt-card');
        const details = el.msg.querySelector('.hb-run-details');
        const arrow = el.msg.querySelector('.hb-expand-arrow');
        if (card && details) {
          card.addEventListener('click', async () => {
            const visible = !details.classList.contains('is-hidden');
            details.classList.toggle('is-hidden', visible);
            if (arrow) arrow.innerHTML = visible ? '&#9660;' : '&#9650;';
            if (!visible && !details.dataset.loaded) {
              details.dataset.loaded = '1';
              try {
                const res = await fetch('/api/heartbeat/stats');
                const stats = await res.json();
                // Find this run in recent work logs
                const runNum = parseInt(run);
                const elapsed = stats.avgResponseMs ? Math.round(stats.avgResponseMs / 1000) + 's avg' : '';
                const lastRun = stats.lastRun;
                const runTime = lastRun && lastRun.timestamp ? new Date(lastRun.timestamp.replace(' ', 'T') + 'Z').toLocaleString() : '';
                details.innerHTML =
                  '<div class="hb-details-grid">' +
                    '<span class="opacity-60">Lens</span><span>' + this.escapeHtml(lens) + '</span>' +
                    '<span class="opacity-60">Run</span><span>#' + this.escapeHtml(run) + ' of ' + (stats.totalRuns || '?') + ' total</span>' +
                    '<span class="opacity-60">Today</span><span>' + (stats.runsToday || 0) + ' runs, ' + (stats.failuresToday || 0) + ' failures</span>' +
                    (elapsed ? '<span class="opacity-60">Avg time</span><span>' + elapsed + '</span>' : '') +
                    '<span class="opacity-60">Next run</span><span>' + (stats.task?.nextRunAt ? this._timeUntil(stats.task.nextRunAt) : '—') + '</span>' +
                  '</div>';
              } catch {
                details.innerHTML = '<div class="opacity-50">Could not load details</div>';
              }
            }
          });
        }
      } else {
        const dispName = senderLabel || this._userName;
        const userAv = senderLabel
          ? (senderLabel.charAt(0).toUpperCase())
          : (this._userAvatar || this._userName.charAt(0).toUpperCase());
        el = this.createMsgEl(dispName, 'user-name', 'user-av', userAv, this.escapeHtml(text), '', timestamp, undefined, dbId);
      }
    } else if (type === 'system') {
      el = this.createMsgEl('System', 'system-name', 'system-av', 'S', this.escapeHtml(text), 'system-text', timestamp);
    } else {
      el = this.createMsgEl(this._aiName, 'assistant-name', 'assistant-av', this._aiEmoji, this.renderMarkdown(text), '', timestamp, this._aiAvatarColor, dbId);
    }
    this.messagesEl.appendChild(el.msg);
    this._renderMermaids();
    if (type === 'assistant') {
      // Board run messages: tag with their task id so a card deep-link can
      // scroll/highlight them, and add a back-link to open the task's card.
      this._tagBoardRunMessage(el.msg, text);
      this._renderLinkPreviews(el.content);
      // PLAN-CARDS-MVP — mount any card placeholders left by renderMarkdown
      // when this message was rendered from history (page reload, history
      // pagination, etc.). Without this, historical card-blocks stay as
      // "[loading card…]" forever since endStreaming() doesn't fire.
      this._renderLensSlots(el.content);
    }
    if (!skipScroll) this.scrollToBottom();
    if (el.msg.dataset.role === 'user') this._schedulePinnedPromptUpdate();
    return { msg: el.msg, content: el.content };
  },

  // Sticky user prompts — "snap to top" so the question you're reading the answer to
  // stays in view. Only ONE prompt is sticky at a time: the latest one you've scrolled
  // past (the `.pin-active` row). Earlier prompts stay static and scroll away normally.
  //
  // Why not just `position: sticky` on every user message? Multiple simultaneous sticky
  // rows all pin at top:0, so a taller earlier prompt pokes out below a shorter newer one
  // (the "overhang"). Keeping a single active pin means the previous prompt un-pins and
  // leaves the screen the moment the next one reaches the top — clean handoff, no overhang.
  _schedulePinnedPromptUpdate() {
    if (this._pinRaf) return;
    this._pinRaf = requestAnimationFrame(() => {
      this._pinRaf = 0;
      this._updatePinnedPrompt();
    });
  },

  _updatePinnedPrompt() {
    if (!this.messagesEl) return;
    const users = this.messagesEl.querySelectorAll('.message[data-role="user"]');
    if (!users.length) return;
    // The pinned prompt is the last user message whose top has scrolled to/above the
    // container top. Compare layout position (offsetTop) against scroll position — NOT
    // getBoundingClientRect, whose top reports the *pinned* offset for the active row and
    // would never let it release on scroll-up. offsetTop is unaffected by sticky.
    // (.message and #chat-messages share #chat-container as offsetParent, so the bases
    // cancel.) Scan newest-first and stop at the first match: at the bottom (common case)
    // that's the last prompt, so it's O(1) rather than measuring every row each frame.
    const passedLine = this.messagesEl.scrollTop + this.messagesEl.offsetTop + 1;
    let active = null;
    for (let i = users.length - 1; i >= 0; i--) {
      if (users[i].offsetTop <= passedLine) { active = users[i]; break; }
    }
    for (const u of users) u.classList.toggle('pin-active', u === active);
  },

  _CHAT_HISTORY_PAGE: 20,

  async _loadEarlierChatHistory(btn, conversationId) {
    const firstMsg = this.messagesEl.querySelector('.message');
    const oldest = firstMsg && firstMsg.dataset && firstMsg.dataset.id;
    if (!oldest || !conversationId) return;
    const prevH = this.messagesEl.scrollHeight;
    const prevT = this.messagesEl.scrollTop;
    btn.disabled = true;
    try {
      const r = await fetch(
        '/api/chat/history?conversationId=' + encodeURIComponent(conversationId) +
        '&before=' + encodeURIComponent(oldest) + '&limit=' + this._CHAT_HISTORY_PAGE
      );
      const d = await r.json();
      const batch = d.messages || [];
      let anchor = this.messagesEl.querySelector('.message');
      for (let i = batch.length - 1; i >= 0; i--) {
        const msg = batch[i];
        if (msg.role !== 'user' && msg.role !== 'assistant') continue;
        const row = this.addMessage(msg.text || msg.content, msg.role, msg.timestamp, { dbId: msg.id, skipScroll: true });
        this.messagesEl.insertBefore(row.msg, anchor);
        anchor = row.msg;
      }
      this.messagesEl.scrollTop = prevT + (this.messagesEl.scrollHeight - prevH);
      this._renderMermaids();
      if (!d.hasMore) btn.remove();
    } catch {
    } finally {
      if (btn.parentNode) btn.disabled = false;
    }
  },

  addToolMessage(toolName, toolKey) {
    this.removeTyping();
    const key = toolKey || toolName;

    // Ensure we have an active assistant message to attach tools to
    if (!this.currentMessage) {
      this.startStreaming();
      this._streamedText = '';
    }

    // Get or create the inline tool strip + chip via shared ChatHelpers
    const msgBody = this.currentMessage.parentElement;
    const strip = ChatHelpers.getOrCreateToolStrip(msgBody, this.currentMessage);
    const { chip } = ChatHelpers.createToolChip(toolName, key);
    ChatHelpers.startChipTimer(chip);
    // Mirror the timer id onto _toolData so tool_end can also clear by key
    if (this._toolData[key]) this._toolData[key]._elapsedTimer = chip._elapsedTimer;

    chip.addEventListener('click', (e) => { e.stopPropagation(); this._toggleToolDetail(chip); });

    const detail = this._createToolDetail(key);
    const wrap = document.createElement('span');
    wrap.className = 'inline-tool-wrap';
    wrap.appendChild(chip);
    wrap.appendChild(detail);
    strip.appendChild(wrap);

    this.scrollToBottom();
  },

  _createToolDetail(toolKey) {
    const detail = document.createElement('div');
    detail.className = 'tool-detail';
    detail.dataset.toolKey = toolKey;
    return detail;
  },

  _toggleToolDetail(chip) {
    const toolKey = chip.dataset.toolKey;
    const wasExpanded = chip.classList.contains('expanded');

    document.querySelectorAll('.inline-tool-chip.expanded, .tool-chip.expanded').forEach(c => c.classList.remove('expanded'));

    if (!wasExpanded) {
      chip.classList.add('expanded');
      const detail = chip.nextElementSibling;
      if (detail && detail.classList.contains('tool-detail')) {
        const data = this._toolData[toolKey] || {};
        let html = '';
        if (data.server) {
          html += '<div class="tool-detail-row"><div class="tool-detail-label">Server</div><div class="tool-detail-value">' + this.escapeHtml(data.server) + '</div></div>';
        }
        if (data.args) {
          const command = data.args.command || data.args.input;
          if (command) {
            html += '<div class="tool-detail-row"><div class="tool-detail-label">Command</div><div class="tool-detail-value"><pre class="tool-detail-pre">' + this.escapeHtml(String(command)) + '</pre></div></div>';
          } else {
            html += '<div class="tool-detail-row"><div class="tool-detail-label">Parameters</div><div class="tool-detail-value"><pre class="tool-detail-pre">' + this.escapeHtml(JSON.stringify(data.args, null, 2)) + '</pre></div></div>';
          }
        }
        if (data.result !== undefined && data.result !== null && data.result !== '') {
          const resultText = String(data.result);
          const imgs = this._extractRenderableImages(resultText);
          for (const im of imgs.slice(0, 6)) {
            if (im.type === 'http') {
              const u = this.escapeAttr(im.url);
              html +=
                '<div class="tool-detail-row"><div class="tool-detail-label">Image</div><div class="tool-detail-value"><img class="chat-image" src="' +
                u +
                '" referrerpolicy="no-referrer" loading="lazy" onclick="ChatView._openLightbox(this.src)" alt="" /></div></div>';
            } else if (im.type === 'local') {
              const imgSrc = '/api/files?path=' + encodeURIComponent(im.path);
              html +=
                '<div class="tool-detail-row"><div class="tool-detail-label">Image</div><div class="tool-detail-value"><img class="chat-image" src="' +
                this.escapeAttr(imgSrc) +
                '" loading="lazy" onclick="ChatView._openLightbox(this.src)" alt="" /></div></div>';
            } else {
              const d = this.escapeAttr(im.data);
              html +=
                '<div class="tool-detail-row"><div class="tool-detail-label">Image</div><div class="tool-detail-value"><img class="chat-image" src="' +
                d +
                '" onclick="ChatView._openLightbox(this.src)" alt="" /></div></div>';
            }
          }
          // Smart render: try to render as table, metrics, collapsible, etc.
          const smart = typeof SmartRender !== 'undefined'
            ? SmartRender.render(resultText, data.tool, data.server)
            : { html: '', isRich: false };
          if (smart.isRich) {
            html += '<div class="tool-detail-row"><div class="tool-detail-label">Output</div><div class="tool-detail-value">' + smart.html + '</div></div>';
          } else {
            const truncated = resultText.length > 2000 ? resultText.substring(0, 2000) + '\n... (truncated)' : resultText;
            html += '<div class="tool-detail-row"><div class="tool-detail-label">Output</div><div class="tool-detail-value"><pre class="tool-detail-pre tool-detail-pre-lg">' + this.escapeHtml(truncated) + '</pre></div></div>';
          }
        }
        if (data.executionTime !== undefined) {
          html += '<div class="tool-detail-row"><div class="tool-detail-label">Time</div><div class="tool-detail-value">' + data.executionTime + 'ms</div></div>';
        }
        if (data.success !== undefined) {
          const cls = data.success ? 'success' : 'error';
          html += '<div class="tool-detail-row"><div class="tool-detail-status ' + cls + '">' + (data.success ? 'Success' : 'Failed') + '</div></div>';
        }
        if (!html) {
          html = '<div class="tool-detail-row"><div class="tool-detail-value text-muted-color">Waiting for result...</div></div>';
        }
        detail.innerHTML = html;
      }
    }
    this.scrollToBottom();
  },

  finalizeToolRow() {
    // Clear all remaining timers from both DOM and _toolData
    for (const [key, data] of Object.entries(this._toolData || {})) {
      if (data._elapsedTimer) { clearInterval(data._elapsedTimer); data._elapsedTimer = null; }
    }
    document.querySelectorAll('.inline-tool-chip:not(.done)').forEach(c => {
      c.classList.add('done');
      if (c._elapsedTimer) { clearInterval(c._elapsedTimer); c._elapsedTimer = null; }
    });
    this.toolRow = null;
  },

  // --- Thinking Timeline ---
  _activeThinkingSection: null,
  _activeThinkingSessionId: null,

  _startThinkingSection(sessionId, topic, estimatedSteps) {
    const section = document.createElement('div');
    section.className = 'thinking-section expanded';
    section.dataset.sessionId = sessionId;

    const header = document.createElement('div');
    header.className = 'thinking-header';
    header.innerHTML =
      '<span class="thinking-chevron">&#9654;</span>' +
      '<span class="thinking-label">Thinking</span>' +
      '<span class="thinking-live-dot"></span>' +
      '<span class="thinking-count"></span>';
    header.addEventListener('click', () => section.classList.toggle('expanded'));

    const body = document.createElement('div');
    body.className = 'thinking-body';

    if (topic) {
      const topicEl = document.createElement('div');
      topicEl.className = 'thinking-topic';
      topicEl.textContent = topic;
      body.appendChild(topicEl);
    }

    const timeline = document.createElement('div');
    timeline.className = 'thinking-timeline';
    body.appendChild(timeline);

    section.appendChild(header);
    section.appendChild(body);

    // Insert before the current streaming message or at end
    const streamEl = this.messagesEl.querySelector('.msg-streaming');
    if (streamEl) {
      const msgEl = streamEl.closest('.message');
      if (msgEl) {
        this.messagesEl.insertBefore(section, msgEl);
      } else {
        this.messagesEl.appendChild(section);
      }
    } else {
      this.messagesEl.appendChild(section);
    }

    this._activeThinkingSection = section;
    this._activeThinkingSessionId = sessionId;
    this.scrollToBottom();
  },

  _addThinkingStep(sessionId, number, total, text) {
    if (!this._activeThinkingSection) {
      this._startThinkingSection(sessionId, '', total);
    }

    const timeline = this._activeThinkingSection.querySelector('.thinking-timeline');
    if (!timeline) return;

    // Remove active pulse from previous step
    const prevActive = timeline.querySelector('.thinking-step.active');
    if (prevActive) prevActive.classList.remove('active');

    const step = document.createElement('div');
    step.className = 'thinking-step active';

    const numEl = document.createElement('div');
    numEl.className = 'thinking-step-number';
    numEl.textContent = 'Thought ' + number + (total ? ' of ' + total : '');

    const textEl = document.createElement('div');
    textEl.className = 'thinking-step-text';
    textEl.textContent = text;

    step.appendChild(numEl);
    step.appendChild(textEl);
    timeline.appendChild(step);

    // Update count in header
    const countEl = this._activeThinkingSection.querySelector('.thinking-count');
    if (countEl) {
      countEl.textContent = number + (total ? ' of ' + total + ' thoughts' : ' thoughts');
    }

    this.scrollToBottom();
  },

  _completeThinkingSection(sessionId) {
    const section = this._activeThinkingSection;
    if (!section) return;

    // Remove live indicator
    const liveDot = section.querySelector('.thinking-live-dot');
    if (liveDot) liveDot.remove();

    // Remove active pulse from last step
    const active = section.querySelector('.thinking-step.active');
    if (active) active.classList.remove('active');

    // Update header
    const countEl = section.querySelector('.thinking-count');
    const stepCount = section.querySelectorAll('.thinking-step').length;
    if (countEl) countEl.textContent = stepCount + ' thoughts completed';

    // Collapse after short delay
    setTimeout(() => section.classList.remove('expanded'), 1500);

    // Add "View session" link
    const header = section.querySelector('.thinking-header');
    if (header && sessionId) {
      const viewLink = document.createElement('a');
      viewLink.className = 'thinking-view-link';
      viewLink.textContent = 'View session';
      viewLink.addEventListener('click', (e) => {
        e.stopPropagation();
        this._loadThinkingSession(sessionId);
      });
      header.appendChild(viewLink);
    }

    section.dataset.sessionId = sessionId;
    this._activeThinkingSection = null;
    this._activeThinkingSessionId = null;
  },

  async _loadThinkingSession(sessionId) {
    try {
      const res = await fetch('/api/thinking/' + encodeURIComponent(sessionId));
      if (!res.ok) return;
      const data = await res.json();

      let section = this.messagesEl.querySelector('.thinking-section[data-session-id="' + sessionId + '"]');
      if (section) {
        section.classList.add('expanded');
        const timeline = section.querySelector('.thinking-timeline');
        if (timeline && data.thoughts) {
          timeline.innerHTML = '';
          for (const t of data.thoughts) {
            const step = document.createElement('div');
            step.className = 'thinking-step';
            step.classList.add('thinking-step-visible');

            const numEl = document.createElement('div');
            numEl.className = 'thinking-step-number';
            numEl.textContent = 'Thought ' + t.number + (t.totalThoughts ? ' of ' + t.totalThoughts : '');

            const textEl = document.createElement('div');
            textEl.className = 'thinking-step-text';
            textEl.textContent = t.text;

            step.appendChild(numEl);
            step.appendChild(textEl);
            timeline.appendChild(step);
          }
        }
      }
    } catch (e) {
      console.error('[Thinking] Failed to load session:', e);
    }
  },

  // Extract canonical title from a heartbeat task line — mirrors src/task_ledger.rs::task_title.
  // Rules: first **bold**, first __underscore__, before " — ", before ":", whole line.
  // Then strip emoji/markdown, trim, lowercase.
  _taskTitle(text) {
    if (!text) return '';
    let s = text.trim().replace(/^-\s*\[[ xX]?\]\s*/, '');

    // Rule 1: **bold**
    const bold = s.match(/\*\*([^*]+)\*\*/);
    if (bold && bold[1] && bold[1].trim()) return this._normalizeTitle(bold[1]);

    // Rule 2: __underscore__
    const under = s.match(/__([^_]+)__/);
    if (under && under[1] && under[1].trim()) return this._normalizeTitle(under[1]);

    // Rule 3: before em-dash ( — )
    const dashIdx = s.indexOf(' \u2014 ');
    if (dashIdx > 0) return this._normalizeTitle(s.slice(0, dashIdx));

    // Rule 4: before colon
    const colonIdx = s.indexOf(':');
    if (colonIdx > 0) return this._normalizeTitle(s.slice(0, colonIdx));

    return this._normalizeTitle(s);
  },

  _normalizeTitle(s) {
    return s
      .replace(/[*_`#]/g, '')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  },

  // --- I6: Today Strip ---
  async _loadTodayStrip() {
    try {
      const res = await fetch('/api/heartbeat/tasks');
      if (!res.ok) return;
      let tasks = await res.json();
      if (!tasks || tasks.length === 0) { this._hideTodayStrip(); return; }

      // Dedup by title — fixes Cause 5 (LLM rephrasings of same task show as duplicates)
      const seen = new Set();
      tasks = tasks.filter(t => {
        const key = this._taskTitle(t.text);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      let strip = document.getElementById('today-strip');
      const isNew = !strip;
      if (isNew) {
        strip = document.createElement('div');
        strip.id = 'today-strip';
        strip.className = 'today-strip collapsed'; // collapsed by default
        this.messagesEl.parentNode.insertBefore(strip, this.messagesEl);
      }

      const openCount = tasks.filter(t => t.status !== 'done').length;
      strip.innerHTML = '';

      const label = document.createElement('div');
      label.className = 'today-strip-label';
      label.innerHTML = '<span class="today-strip-toggle">&#9660;</span> Suggested Tasks <span class="today-strip-count">(' + openCount + ')</span>';
      label.addEventListener('click', () => strip.classList.toggle('collapsed'));
      strip.appendChild(label);

      const list = document.createElement('div');
      list.className = 'today-strip-list';

      for (const task of tasks) {
        const item = document.createElement('div');
        item.className = 'today-strip-item' + (task.status === 'done' ? ' done' : '');

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = task.status === 'done';
        cb.disabled = true;

        const text = document.createElement('span');
        text.className = 'today-strip-text';
        text.textContent = task.text;

        // I5: Confirm-to-run button for runnable suggestions
        const runBtn = document.createElement('button');
        runBtn.className = 'today-strip-run';
        runBtn.textContent = 'Run';
        runBtn.title = 'Execute this suggestion';
        runBtn.addEventListener('click', () => this._confirmAndRun(task.text));

        // Done button (marks complete without running)
        const doneBtn = document.createElement('button');
        doneBtn.className = 'today-strip-done';
        doneBtn.textContent = '✓';
        doneBtn.title = 'Mark done';
        doneBtn.addEventListener('click', async () => {
          doneBtn.disabled = true;
          try {
            await fetch('/api/heartbeat/tasks/complete', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: task.text }),
            });
            item.classList.add('done');
            doneBtn.remove();
            runBtn.remove();
            const remaining = list.querySelectorAll('.today-strip-item:not(.done)').length;
            const countEl = strip.querySelector('.today-strip-count');
            if (countEl) countEl.textContent = '(' + remaining + ')';
            // Sync briefing strip
            const briefingStrip = document.getElementById('briefing-strip');
            if (briefingStrip) {
              const targetTitle = this._taskTitle(task.text);
              briefingStrip.querySelectorAll('[data-task-text]').forEach(el => {
                if (this._taskTitle(el.dataset.taskText) === targetTitle) {
                  el.classList.add('done');
                  el.querySelector('.briefing-task-done-btn')?.remove();
                }
              });
            }
          } catch { doneBtn.disabled = false; }
        });

        // Dismiss button
        const dismissBtn = document.createElement('button');
        dismissBtn.className = 'today-strip-dismiss';
        dismissBtn.textContent = '\u00d7';
        dismissBtn.title = 'Remove this task';
        dismissBtn.addEventListener('click', async () => {
          item.classList.add('opacity-30');
          try {
            await fetch('/api/heartbeat/tasks/dismiss', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: task.text }),
            });
            item.remove();
            // Update count
            const remaining = list.querySelectorAll('.today-strip-item:not(.done)').length;
            const countEl = strip.querySelector('.today-strip-count');
            if (countEl) countEl.textContent = '(' + remaining + ')';
            if (list.children.length === 0) this._hideTodayStrip();
          } catch { item.classList.remove('opacity-30'); }
        });

        item.appendChild(cb);
        item.appendChild(text);
        if (task.status !== 'done') item.appendChild(runBtn);
        if (task.status !== 'done') item.appendChild(doneBtn);
        item.appendChild(dismissBtn);
        list.appendChild(item);
      }
      strip.appendChild(list);
      strip.classList.remove('is-hidden');
    } catch (e) {
      console.error('[TodayStrip] Failed to load:', e);
    }
  },

  _hideTodayStrip() {
    const strip = document.getElementById('today-strip');
    if (strip) strip.classList.add('is-hidden');
  },

  _ensureAvatarColorClass(color) {
    const safe = String(color).replace(/[^a-zA-Z0-9_-]/g, '_');
    const cls = `assistant-avatar-color-${safe}`;
    if (!document.getElementById(`avatar-color-style-${safe}`)) {
      const styleEl = document.createElement('style');
      styleEl.id = `avatar-color-style-${safe}`;
      styleEl.textContent = `.${cls}{background:${color};}`;
      document.head.appendChild(styleEl);
    }
    return cls;
  },

  // I5: Confirm and run a heartbeat suggestion
  async _confirmAndRun(suggestion) {
    if (!confirm('Run this suggestion?\n\n' + suggestion)) return;
    // Flag so heartbeat stream buffering doesn't swallow the response
    this._userSentHeartbeat = true;
    this.startStreaming();
    this._streamedText = '';
    try {
      const res = await fetch('/api/heartbeat/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestion }),
      });
      if (res.ok) {
        // Mark task done in ledger + update the today strip
        fetch('/api/heartbeat/tasks/complete', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: suggestion }),
        }).catch(() => {});
        // Update strip visually — mark ALL items with matching title done (fixes Cause 6 dupe marks)
        const strip = document.getElementById('today-strip');
        if (strip) {
          const targetTitle = this._taskTitle(suggestion);
          const items = strip.querySelectorAll('.today-strip-item');
          for (const item of items) {
            const textEl = item.querySelector('.today-strip-text');
            if (textEl && this._taskTitle(textEl.textContent) === targetTitle) {
              item.classList.add('done');
              const cb = item.querySelector('input[type="checkbox"]');
              if (cb) cb.checked = true;
              const runBtn = item.querySelector('.today-strip-run');
              if (runBtn) runBtn.remove();
              // No break — mark all matching items
            }
          }
          // Update count
          const remaining = strip.querySelectorAll('.today-strip-item:not(.done)').length;
          const countEl = strip.querySelector('.today-strip-count');
          if (countEl) countEl.textContent = '(' + remaining + ')';
        }
      } else {
        const err = await res.json();
        alert('Failed: ' + (err.error || 'unknown error'));
      }
    } catch (e) {
      console.error('[ConfirmRun] Failed:', e);
    }
  },

  showTyping() {
    if (this.typingEl) return;
    const el = this.createMsgEl(this._aiName, 'assistant-name', 'assistant-av', this._aiEmoji, '', '', undefined, this._aiAvatarColor);
    el.content.className = 'msg-content typing-indicator';
    el.content.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
    this.messagesEl.appendChild(el.msg);
    this.typingEl = el.msg;
    this.scrollToBottom();
  },

  removeTyping() {
    if (this.typingEl) { this.typingEl.remove(); this.typingEl = null; }
    this._removeStatusPhase();
  },

  _showStatusPhase(status) {
    // Show a lightweight status label below the typing dots or streaming message
    if (!this.typingEl && !this.currentMessage) return;
    const parent = this.typingEl || (this.currentMessage && this.currentMessage.closest('.message'));
    if (!parent) return;
    let el = parent.querySelector('.chat-status-phase');
    if (!el) {
      el = document.createElement('div');
      el.className = 'chat-status-phase';
      const body = parent.querySelector('.msg-body') || parent;
      body.appendChild(el);
    }
    el.textContent = status;
    this.scrollToBottom();
  },

  _removeStatusPhase() {
    document.querySelectorAll('.chat-status-phase').forEach(el => el.remove());
  },

  startStreaming() {
    this.removeTyping();
    const el = this.createMsgEl(this._aiName, 'assistant-name', 'assistant-av', this._aiEmoji, '', 'streaming', undefined, this._aiAvatarColor);
    const convId = typeof this._getConversationId === 'function' ? this._getConversationId() : '';
    if (convId && String(convId).startsWith('workbench:skill-console:')) {
      el.msg.classList.add('sw-skill-console-stream');
    }
    this.messagesEl.appendChild(el.msg);
    this.currentMessage = el.content;
    this.currentMessage._rawText = '';
    // PLAN-CHAT-SILENT-FIX — persistent phase indicator: shows what Vodou
    // is doing during the gap between "user submitted" and "text starts
    // streaming". Replaces the user-perceived silence with concrete signal.
    // Starts as "🧠 Thinking…"; flips to "🛠 Using <N> tools (names)" as
    // tool chips fire; auto-removes when the first text token arrives.
    const phase = document.createElement('div');
    phase.className = 'msg-phase-indicator';
    phase.style.cssText = 'font-size:12px;color:var(--text-muted,#888);margin-bottom:6px;display:flex;align-items:center;gap:6px;padding-left:var(--chat-msg-indent);';
    phase.innerHTML = '<span class="phase-spinner" style="display:inline-block;width:10px;height:10px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:phase-spin 0.8s linear infinite;"></span><span class="phase-text">🧠 Thinking…</span>';
    el.content.parentNode.insertBefore(phase, el.content);
    this.currentMessage._phaseIndicator = phase;
    this.currentMessage._phaseToolNames = [];
    const dots = document.createElement('span');
    dots.className = 'streaming-dots';
    dots.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
    el.content.parentNode.appendChild(dots);
    this.currentMessage._streamDots = dots;
    // Pin the user's prompt to the top of the viewport once, as the stream
    // begins — but ONLY for user-initiated sends (flag set in sendMessage).
    // The response then grows downward beneath it. rAF so the new assistant
    // bubble is laid out first (otherwise scrollHeight is stale and the
    // prompt lands a few px off).
    if (this._pinPromptOnNextStream) {
      this._pinPromptOnNextStream = false;
      requestAnimationFrame(() => this._scrollPromptToTop());
    }
    return this.currentMessage;
  },

  /**
   * Scroll so the most recent USER message sits at the top of the chat
   * viewport. Used at stream start so the turn the user just sent anchors the
   * view (ChatGPT/Claude-style), instead of chasing the streaming text to the
   * bottom. Falls back to scrollToBottom if no user message is found.
   */
  _scrollPromptToTop() {
    if (!this.messagesEl) return;
    const userMsgs = this.messagesEl.querySelectorAll('.message[data-role="user"]');
    const lastUser = userMsgs[userMsgs.length - 1];
    if (!lastUser) { this.scrollToBottom(); return; }
    const containerRect = this.messagesEl.getBoundingClientRect();
    const msgRect = lastUser.getBoundingClientRect();
    const msgTop = msgRect.top - containerRect.top + this.messagesEl.scrollTop;
    // 12px breathing room above the prompt.
    this.messagesEl.scrollTop = Math.max(0, msgTop - 12);
  },

  _phaseUpdateToolCount(toolName) {
    if (!this.currentMessage || !this.currentMessage._phaseIndicator) return;
    const names = this.currentMessage._phaseToolNames;
    names.push(toolName);
    const phaseText = this.currentMessage._phaseIndicator.querySelector('.phase-text');
    if (phaseText) {
      const uniq = [...new Set(names)];
      const preview = uniq.slice(0, 4).join(', ') + (uniq.length > 4 ? ', …' : '');
      phaseText.textContent = `🛠 Using ${names.length} tool${names.length === 1 ? '' : 's'} (${preview})`;
    }
  },

  _phaseClear() {
    if (this.currentMessage && this.currentMessage._phaseIndicator) {
      this.currentMessage._phaseIndicator.remove();
      this.currentMessage._phaseIndicator = null;
    }
  },

  appendToStream(text) {
    if (this.currentMessage) {
      // PLAN-CHAT-SILENT-FIX — first real text means the model is done
      // thinking/tooling; clear the phase indicator so the bubble doesn't
      // double up on signals.
      if (text && text.trim() && this.currentMessage._phaseIndicator) {
        this._phaseClear();
      }
      this.currentMessage._rawText += text;
      this.currentMessage.innerHTML = this.renderMarkdown(this.currentMessage._rawText);
      // Don't render mermaids during streaming — wait for endStreaming
      // (partial code blocks will fail and get marked as permanently broken)
      //
      // NO auto-scroll during streaming. startStreaming() already pinned the
      // user's prompt to the top of the viewport; from here the response grows
      // downward and we leave the scroll position alone so it stays wherever
      // the user put it. (Previously this called _scrollToStreamStart() on
      // every chunk, which yanked the view to the bottom while the message
      // was still short — the "bouncing to the bottom" the user reported.)
    }
  },

  endStreaming() {
    this._removeStatusPhase();
    if (this.currentMessage) {
      this.currentMessage.classList.remove('streaming');
      if (this.currentMessage._streamDots) { this.currentMessage._streamDots.remove(); this.currentMessage._streamDots = null; }
      // PLAN-CHAT-SILENT-FIX — clean up the phase indicator if it survived
      // the stream (e.g. response was all tools, no text). Don't leave it
      // spinning forever.
      this._phaseClear();
      const msgContent = this.currentMessage;
      this.currentMessage = null;
      // Scroll to bottom so stopping point buttons are visible
      this.scrollToBottom();
      // Now that streaming is complete, render diagrams and link previews
      this._renderMermaids();
      this._renderLinkPreviews(msgContent);
      // PLAN-CARDS-MVP — mount any ```card``` placeholders
      this._renderLensSlots(msgContent);
    }
  },

  /**
   * PLAN-CARDS-MVP — find every .lens-pending placeholder inserted by
   * renderMarkdown() and hand it to LensShell.mountSlot to fetch+render.
   * Runs ONCE per message, after stream end. Idempotent: already-mounted
   * cards are skipped via the data-state attribute.
   */
  _renderLensSlots(msgEl) {
    if (!msgEl || !window.LensShell || !this._lensesEnabledForActiveConv()) return;
    // Idempotent: only mount slots that are still pending. Already-mounted
    // shells from history reload are skipped (their data-state has changed).
    const slots = msgEl.querySelectorAll('.lens-pending[data-state="pending"]');
    slots.forEach(slot => {
      slot.setAttribute('data-state', 'mounting');
      // Prefer the new `data-lens-block-b64` (post-rename, 2026-05-17).
      // Fall back to `data-card-block-b64` for cached chat history
      // rendered before the rename, and the even-older HTML-entity-escaped
      // `data-card-block` for messages from before the base64 cutover.
      const b64 = slot.getAttribute('data-lens-block-b64')
               || slot.getAttribute('data-card-block-b64')
               || '';
      const legacyRaw = slot.getAttribute('data-lens-block')
                     || slot.getAttribute('data-card-block')
                     || '';
      let decoded = '';
      if (b64) {
        try {
          decoded = decodeURIComponent(escape(atob(b64)));
        } catch (e) {
          console.warn('[cards] base64 decode failed', e);
          slot.outerHTML = '<pre class="lens-block-invalid">[bad base64]</pre>';
          return;
        }
      } else {
        // Legacy: HTML-entity-escaped JSON from older messages.
        decoded = legacyRaw
          .replace(/&quot;/g, '"')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&');
      }
      let block = null;
      try { block = JSON.parse(decoded); } catch (e) {
        // Defensive: if `decoded` still carries HTML entities (encoded by an
        // older build before the renderMarkdown entity-decode fix), un-escape
        // and retry once before falling back to text. Decode &amp; LAST.
        try {
          block = JSON.parse(decoded
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&'));
        } catch (e2) {
          console.warn('[lenses] invalid lens JSON, leaving as text', e2);
          slot.outerHTML = '<pre class="lens-block-invalid">' + window.VodouSafe.escapeHtml(decoded) + '</pre>';
          return;
        }
      }
      // Text fallback = previous sibling text content (the one-sentence
      // answer the LLM was told to put above every card block).
      const fallbackText = (() => {
        const prev = slot.previousSibling;
        if (!prev) return '';
        const t = (prev.textContent || '').trim();
        return t.split('\n').pop().slice(0, 200);
      })();
      try {
        window.LensShell.mountSlot(slot, block, fallbackText);
      } catch (e) {
        console.error('[cards] mountSlot failed', e);
      }
    });
  },

  _updateUsageBar(usage) {
    if (!usage) return;
    // Find or create the usage bar on the current (or last) assistant message
    const msgs = this.messagesEl.querySelectorAll('.message');
    const lastMsg = msgs[msgs.length - 1];
    if (!lastMsg) return;

    let bar = lastMsg.querySelector('.msg-usage-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'msg-usage-bar';
      lastMsg.querySelector('.msg-body').appendChild(bar);
    }

    const parts = [];

    // Duration
    if (usage.durationMs) {
      const secs = usage.durationMs / 1000;
      if (secs >= 60) {
        const m = Math.floor(secs / 60);
        const s = Math.round(secs % 60);
        parts.push(m + 'm ' + s + 's');
      } else {
        parts.push(secs.toFixed(1) + 's');
      }
    }

    // Tokens
    const tokParts = [];
    if (usage.inputTokens) tokParts.push('↑ ' + this._fmtNum(usage.inputTokens));
    if (usage.outputTokens) tokParts.push('↓ ' + this._fmtNum(usage.outputTokens));
    if (usage.cacheReadTokens) {
      let cacheLabel = '⚡ ' + this._fmtNum(usage.cacheReadTokens) + ' cached';
      const budget = usage.tokenBudget || 500000;
      if (budget > 0) {
        const pct = Math.round((usage.cacheReadTokens / budget) * 100);
        cacheLabel += ' (' + pct + '%)';
        if (pct >= 90) cacheLabel = '🔴 ' + cacheLabel;
        else if (pct >= 70) cacheLabel = '🟡 ' + cacheLabel;
      }
      tokParts.push(cacheLabel);
    }
    if (tokParts.length) parts.push(tokParts.join(' · '));

    // Cost
    if (usage.costUsd !== undefined && usage.costUsd !== null) {
      parts.push('$' + usage.costUsd.toFixed(4));
    }

    // Model — show just the model name, not the full provider path
    // (accounts/fireworks/models/kimi-k2p6 → kimi-k2p6, moonshotai/Kimi-K2.6 → Kimi-K2.6).
    if (usage.model) {
      const short = usage.model.split('/').pop().replace(/^claude-/, '').replace(/-\d{8}$/, '');
      parts.push(short);
    }

    bar.textContent = parts.join('  ·  ');
  },

  _fmtNum(n) {
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  },

  /** Also render link previews for non-streamed messages (history replay) */
};
