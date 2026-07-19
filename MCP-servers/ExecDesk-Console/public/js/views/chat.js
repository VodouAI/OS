/**
 * Chat View — WebSocket streaming chat with Vodou
 * Phase 1: Clickable commands, stopping point buttons, code block actions
 */

// Mermaid is loaded on-demand (first diagram render) to keep the ~2.8 MB
// bundle off cold boots for pages that never render diagrams.
async function ensureMermaid() {
  if (window.mermaid) return window.mermaid;
  await lazyScript('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js');
  window.mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    themeVariables: {
      primaryColor: '#0d9488',
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

    this.messagesEl = document.getElementById('chat-messages');
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

    // Left-nav channel integration: clicking a channel in the sidebar lands
    // the user at #/chat?channel=<type>. On hashchange (or initial load),
    // find the workbench:channel:<type> tab and switch to it so the main
    // chat view shows that channel's unified conversation.
    window.addEventListener('hashchange', () => this._maybeHandleChannelRoute());
    // Also fire once on init in case the page loaded directly at #/chat?channel=X.
    setTimeout(() => this._maybeHandleChannelRoute(), 0);
  },

  _maybeHandleChannelRoute() {
    const hash = location.hash || '';
    const pathOnly = hash.split('?')[0];
    if (pathOnly !== '#/chat') return;
    const qs = hash.indexOf('?') >= 0 ? hash.slice(hash.indexOf('?') + 1) : '';
    const channel = new URLSearchParams(qs).get('channel');
    if (!channel) return;
    this._switchToChannelTab(channel);
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
    // Route skill runner events to the floating panel
    if (typeof SkillRunner !== 'undefined' && SkillRunner.isSkillEvent(data)) {
      SkillRunner.handleWsEvent(data);
      return;
    }

    switch (data.type) {
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
          break;
        case 'channel_activity': {
          // Auto-create tab when a channel message arrives (Telegram, Slack, etc.)
          const existingTab = this._tabs.find(t => t.conversationId === data.conversationId);
          if (!existingTab) {
            const channelNames = { telegram: 'Telegram', slack: 'Slack', discord: 'Discord', voice: 'Voice', web: 'Web' };
            const title = channelNames[data.source] || data.source;
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
        case 'heartbeat_activity': {
          // Ensure Vodou heartbeat tab exists
          const vTab = this._tabs.find(t => t.conversationId === data.conversationId);
          if (!vTab) {
            this._tabs.unshift({
              id: 'tab-vodou',
              title: 'BRIEFING',
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
          // Show the channel user's message in the tab (live update)
          if (data.conversationId === this._getConversationId()) {
            this.addMessage(data.content, 'user');
          } else {
            this._bufferEvent({ type: 'channel_user_message', conversationId: data.conversationId, content: data.content });
          }
          break;
        }
        case 'history': {
          // Clear and replay — handles initial connect + tab switches
          this.messagesEl.innerHTML = '';
          const convId = data.conversationId || this._getConversationId();
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
                this.addMessage(msg.text, 'user', msg.timestamp, { ...histOpts, dbId: msg.id });
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
            this._bufferEvent(data);
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
          break;
        case 'error':
          if (data.conversationId && data.conversationId !== this._getConversationId()) {
            this._bufferEvent(data);
            break;
          }
          this.endStreaming();
          this._hideStopBtn();
          this.addMessage('Error: ' + data.message, 'system');
          this.sendBtn.disabled = false;
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
      el.title = memory.items && memory.items.length > 0
        ? 'Memories used:\n' + memory.items.map(i => i.replace(/^-\s*/, '')).join('\n')
        : `${total} total memories, ${used} used this conversation`;
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
    const lastMsg = this.messagesEl ? this.messagesEl.querySelector('.message.assistant:last-of-type') : null;
    const anchor = lastMsg || this.messagesEl;
    if (!anchor) return;
    // Idempotency: don't double-render for the same done event.
    if (anchor.querySelector('.chat-memrecall-chip')) return;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chat-memrecall-chip';
    const n = memory.debug.results.length;
    chip.textContent = `\u{1F9E0} ${n} memor${n === 1 ? 'y' : 'ies'} recalled · see why`;
    chip.title = 'Click to see which chunks surfaced and why';
    chip.addEventListener('click', () => {
      this._openMemoryRecallModal(memory.debug);
    });
    anchor.appendChild(chip);
  },

  _openMemoryRecallModal(debug) {
    if (typeof Components === 'undefined' || !Components.openModal) {
      console.warn('[chat] Components.openModal not available');
      return;
    }
    const modal = Components.openModal({
      title: 'Memories used in this response',
      subtitle: `query:&nbsp;<code>${(debug.query || '').slice(0, 120)}</code>` + (debug.active_scope ? ` &middot; scope:&nbsp;<code>${debug.active_scope}</code>` : ''),
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
    for (const chunk of debug.results) {
      modal.body.appendChild(window.MemoryRow.render(chunk, { allowPin: true }));
    }
  },

  /** Empty non-briefing chat tab: single line, no starter chips. */
  _showWelcomeSuggestions() {
    const wrapper = document.createElement('div');
    wrapper.className = 'chat-welcome chat-welcome-minimal';
    wrapper.innerHTML = '<p class="welcome-prompt">Type below to get started.</p>';
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
          <button class="hb-directive-close">&times;</button>
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
    textarea.focus();
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
            const dataAttr = done ? '' : ' data-task-text="' + text.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"';
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
          '<div class="briefing-feedback">' +
            '<button onclick="ChatView._sendFeedback(\'up\')" title="Useful">&#128077;</button>' +
            '<button onclick="ChatView._sendFeedback(\'down\')" title="Not useful">&#128078;</button>' +
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

  sendMessage(overrideText) {
    let text = (overrideText || this.input.value).trim();
    // P19: Clear skill pills on send
    this._clearSkillPills();

    // If there's a pending file, build the message with file content.
    // Delegates to ChatFileDrop.embedInText so workbench produces identical output.
    const pending = this._fileDrop ? this._fileDrop.getPending() : null;
    if (pending && !overrideText) {
      text = ChatFileDrop.embedInText(pending, text);
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
      }));
    } else {
      this.ws.send(JSON.stringify({ type: 'message', content: text, conversationId: convId }));
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
    return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  escapeAttr(t) {
    return String(t)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  },

  _autoResizeInput() {
    if (!this.input) return;
    const lines = Math.max(1, this.input.value.split('\n').length);
    this.input.rows = Math.min(8, lines + 1);
  },

  /**
   * Render markdown with rich interactive elements:
   * - Clickable `oi "..."` commands
   * - Code blocks with copy/run actions
   * - Stopping point menus as buttons
   */
  renderMarkdown(text) {
    let html = this.escapeHtml(text);

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
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

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
        const label = optMatch[2]
          .replace(/<\/?strong>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>');
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
        // Show the channel user's message first
        this.addMessage(ev.content, 'user');
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
      this._hideStopBtn();
      this.sendBtn.disabled = false;
      if (doneEvent.activeModel) this._updateModelIndicator(doneEvent.activeModel);
    }
  },

  _initTabs() {
    this._tabs = [];           // { id, title, conversationId }
    this._activeTabId = null;
    this._tabMessages = {};    // conversationId → saved innerHTML
    this._tabBar = document.getElementById('chat-tabs');
    this._messagingTabBar = document.getElementById('chat-tabs-messaging');
    this._messagingTierWrap = document.getElementById('chat-tabs-messaging-wrap');
    this._integrationTabBar = document.getElementById('chat-tabs-apps');
    this._appsTierWrap = document.getElementById('chat-tabs-apps-wrap');
    this._bindTabTierHeaders();

    // Re-render messaging + apps tiers whenever surfaced workbenches change
    if (typeof WorkbenchSurfaces !== 'undefined') {
      WorkbenchSurfaces.onChange(() => this._renderIntegrationTabs());
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
        this._tabs = saved.tabs;
        this._activeTabId = saved.activeTabId || saved.tabs[0].id;
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
        title: 'BRIEFING',
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
      // Skip empty conversations (no messages)
      if (conv.messageCount === 0) continue;
      // Skip workbench-scoped conversations — except `workbench:channel:*`,
      // which collapses all inbound channel traffic into one conversation per
      // channel type and IS surfaced as a main chat tab (Apps parity).
      if (conv.source && conv.source.startsWith('workbench:') && !conv.id.startsWith('workbench:channel:')) continue;

      const channelNames = { telegram: 'Telegram', slack: 'Slack', discord: 'Discord', teams: 'Teams', googlechat: 'Google Chat', signal: 'Signal', whatsapp: 'WhatsApp', imessage: 'iMessage', voice: 'Voice', web: 'Web' };
      const isChannel = conv.source && conv.source !== 'web';
      const title = isChannel
        ? (channelNames[conv.source] || conv.source)
        : conv.title || 'Chat';

      this._tabs.push({
        id: 'tab-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
        title,
        conversationId: conv.id,
        source: conv.source || 'web',
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
    const tab = { id, title: 'Chat ' + num, conversationId: convId };
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

    if (tabId === this._activeTabId) return;

    // Save current tab's messages
    const currentTab = this._tabs.find(t => t.id === this._activeTabId);
    if (currentTab && this.messagesEl) {
      this._tabMessages[currentTab.conversationId] = this.messagesEl.innerHTML;
    }

    // Switch
    this._activeTabId = tabId;
    const newTab = this._tabs.find(t => t.id === tabId);
    if (!newTab) return;

    // Show cached messages instantly (if available), then request server history
    if (this._tabMessages[newTab.conversationId]) {
      this.messagesEl.innerHTML = this._tabMessages[newTab.conversationId];
      this._scrollToBottomAfterLayout();
    } else {
      this.messagesEl.innerHTML = '';
    }

    // Replay any events that arrived while this tab was in the background
    this._replayBufferedEvents(newTab.conversationId);

    // Always tell server to switch — server sends history event which replays messages
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'switch_conversation',
        conversationId: newTab.conversationId,
      }));
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
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const convId = String(tab.conversationId || '');
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
            // Match the dock treatment: colored letter on the shared tile background
            iconHtml = `<span class="sw-icon-emoji sw-icon-avatar" data-tab-id="${esc(tab.id)}" title="Click to change icon" style="color:${esc(id.color)};">${esc(id.text)}</span>`;
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
      const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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

    (async () => {
      try {
        await API.del('/api/gateway/conversation/' + encodeURIComponent(convId));
      } catch (e) {
        if (typeof Components !== 'undefined') {
          Components.toast('Could not remove chat from server', 'error');
        }
      }
    })();
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

  _isChannelConversationTab(tab) {
    return !tab.integration && !!tab.source && tab.source !== 'web' && tab.source !== 'heartbeat';
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
        // Letter avatar — colored letters on the shared tile background.
        // Same visual weight as brand icons (no filled square).
        iconSpan.className = 'chat-tab-icon chat-tab-icon-avatar';
        iconSpan.textContent = id.text;
        iconSpan.style.color = id.color;
      }
      el.appendChild(iconSpan);
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

    if (this._tabs.length > 1 && !tab.pinned) {
      const close = document.createElement('span');
      close.className = 'chat-tab-close';
      close.textContent = '\u00D7';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        this._closeTab(tab.id);
      });
      el.appendChild(close);
    }

    el.addEventListener('click', () => this._switchTab(tab.id));
    return el;
  },

  _renderTabs() {
    if (!this._tabBar) return;
    this._tabBar.innerHTML = '';

    const sorted = this._sortTabsStable();
    const primaryTabs = sorted.filter((t) => this._isPrimaryConversationTab(t));

    for (const tab of primaryTabs) {
      this._tabBar.appendChild(this._createStandardTabElement(tab));
    }

    const sep = document.createElement('span');
    sep.className = 'chat-tab-sep';
    this._tabBar.appendChild(sep);

    const addBtn = document.createElement('span');
    addBtn.className = 'chat-tab-add';
    addBtn.textContent = '+';
    addBtn.title = 'New chat';
    addBtn.addEventListener('click', () => this._addTab(true));
    this._tabBar.appendChild(addBtn);

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

  /** Row 3 — surfaced workbenches except channel scopes.
   *  Visually grouped as: [integrations + automations]  ·  [skills/subagents]
   *  with a divider so subagents read as a distinct kind. */
  _renderAppsTier(allEntries) {
    if (!this._integrationTabBar) return;
    this._integrationTabBar.innerHTML = '';

    const appEntries = (allEntries || []).filter((e) => !(e.scope || '').startsWith('workbench:channel:'));
    const skillEntries = appEntries.filter((e) => (e.scope || '').startsWith('workbench:skill:'));
    const otherEntries = appEntries.filter((e) => !(e.scope || '').startsWith('workbench:skill:'));

    for (const entry of otherEntries) {
      this._appendSurfacedWorkbenchTab(this._integrationTabBar, entry);
    }
    if (otherEntries.length > 0 && skillEntries.length > 0) {
      const sep = document.createElement('span');
      sep.className = 'chat-tab-tier-divider';
      sep.setAttribute('aria-hidden', 'true');
      this._integrationTabBar.appendChild(sep);
    }
    for (const entry of skillEntries) {
      this._appendSurfacedWorkbenchTab(this._integrationTabBar, entry);
    }

    const hasApps = appEntries.length > 0;
    if (this._appsTierWrap) {
      this._appsTierWrap.classList.toggle('is-empty', !hasApps);
      if (hasApps) this._syncTierCollapsedFromLs(this._appsTierWrap, this._tabTierLsKeyApps, 'chat-tabs-apps-toggle');
    }
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
          '<div class="mermaid-error">Diagram render failed: ' + (err.message || err) + '</div>' +
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
    'none':        { text: true, image: false, pdf: false, document: false, audio: false, video: false },
  },

  _modelDisplayName(provider, settings) {
    if (provider === 'claude-cli') {
      const m = (settings.cli_model || 'sonnet').toLowerCase();
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
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  },

  /** After history hydrate / briefing / async previews — pin to bottom once layout catches up */
  _scrollToBottomAfterLayout() {
    if (!this.messagesEl) return;
    const run = () => {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    };
    run();
    requestAnimationFrame(() => {
      run();
      requestAnimationFrame(run);
    });
    setTimeout(run, 0);
    setTimeout(run, 100);
    setTimeout(run, 400);
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
        const userAv = this._userAvatar || this._userName.charAt(0).toUpperCase();
        el = this.createMsgEl(this._userName, 'user-name', 'user-av', userAv, this.escapeHtml(text), '', timestamp, undefined, dbId);
      }
    } else if (type === 'system') {
      el = this.createMsgEl('System', 'system-name', 'system-av', 'S', this.escapeHtml(text), 'system-text', timestamp);
    } else {
      el = this.createMsgEl(this._aiName, 'assistant-name', 'assistant-av', this._aiEmoji, this.renderMarkdown(text), '', timestamp, this._aiAvatarColor, dbId);
    }
    this.messagesEl.appendChild(el.msg);
    this._renderMermaids();
    if (type === 'assistant') this._renderLinkPreviews(el.content);
    if (!skipScroll) this.scrollToBottom();
    return { msg: el.msg, content: el.content };
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
    this.messagesEl.appendChild(el.msg);
    this.currentMessage = el.content;
    this.currentMessage._rawText = '';
    const dots = document.createElement('span');
    dots.className = 'streaming-dots';
    dots.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
    el.content.parentNode.appendChild(dots);
    this.currentMessage._streamDots = dots;
    return this.currentMessage;
  },

  appendToStream(text) {
    if (this.currentMessage) {
      this.currentMessage._rawText += text;
      this.currentMessage.innerHTML = this.renderMarkdown(this.currentMessage._rawText);
      // Don't render mermaids during streaming — wait for endStreaming
      // (partial code blocks will fail and get marked as permanently broken)
      this._scrollToStreamStart();
    }
  },

  endStreaming() {
    this._removeStatusPhase();
    if (this.currentMessage) {
      this.currentMessage.classList.remove('streaming');
      if (this.currentMessage._streamDots) { this.currentMessage._streamDots.remove(); this.currentMessage._streamDots = null; }
      const msgContent = this.currentMessage;
      this.currentMessage = null;
      // Scroll to bottom so stopping point buttons are visible
      this.scrollToBottom();
      // Now that streaming is complete, render diagrams and link previews
      this._renderMermaids();
      this._renderLinkPreviews(msgContent);
    }
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

    // Model
    if (usage.model) {
      const short = usage.model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
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
