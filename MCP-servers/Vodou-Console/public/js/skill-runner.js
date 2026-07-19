/**
 * SkillRunner — Floating chat panel for interactive skill execution.
 * Reuses ChatView's WebSocket connection and renderMarkdown().
 * Any SKILL.md becomes an interactive guided conversation.
 */
const SkillRunner = {
  _panel: null,
  _skillName: null,
  _skillContent: null,
  _actions: null,            // parsed actions.json (or AGENT_ACTIONS fallback)
  _currentSP: null,          // index of current stopping_point
  _capturedVars: {},         // accumulated vars from captures + initial topic
  _conversationId: null,
  _messages: [],
  _currentMsg: null,
  _streamBuffer: '',
  _minimized: false,
  _sending: false,

  /**
   * Open a skill in the floating panel.
   * Fetches SKILL.md, creates a conversation, and auto-sends the first message.
   */
  async open(skillName) {
    // Close existing panel
    if (this._panel) this.close();

    // Fetch skill content
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(skillName)}/content`);
      if (!res.ok) throw new Error(await res.text() || 'Failed to load');
      this._skillContent = await res.text();
    } catch (err) {
      if (typeof Components !== 'undefined') Components.toast('Failed to load skill: ' + err.message, 'error');
      return;
    }

    // Fetch actions.json (best-effort — skills without one fall through to LLM-driven flow)
    try {
      const aRes = await fetch(`/api/skills/${encodeURIComponent(skillName)}/actions`);
      this._actions = aRes.ok ? await aRes.json() : null;
      if (this._actions && (!this._actions.stopping_points || this._actions.stopping_points.length === 0)) {
        this._actions = null;  // no menu → LLM mode
      }
    } catch {
      this._actions = null;
    }

    this._skillName = skillName;
    this._conversationId = 'skill-' + Date.now();
    this._messages = [];
    this._streamBuffer = '';
    this._sending = false;
    this._currentSP = this._actions ? 0 : null;
    this._capturedVars = {};

    // Render the panel
    this._renderPanel();

    // If we have actions.json, render the first stopping point client-side —
    // skip the LLM opener entirely. This makes the panel deterministic from
    // turn 1 and avoids any chance of an LLM hang blocking the menu.
    if (this._actions) {
      this._renderStoppingPointMenu(0);
    } else {
      // No actions.json — fall back to LLM-driven opener (prose-only skills).
      this._send("Let's begin. Start the skill from the top.");
    }
  },

  // openAsPersona() removed — personas now use the unified scoped-conversation
  // path. See skills.js Run-as-agent handler: it creates a workbench:skill:<name>
  // conversation via /api/workbench/ensure and routes the user to the chat tab.
  // SkillRunner stays for workflow-skill stopping-point execution only.

  /**
   * Render a stopping point's menu directly from actions.json — no LLM call.
   * Used for the opener and after each deterministic step run.
   */
  _renderStoppingPointMenu(spIndex) {
    if (!this._actions || !this._actions.stopping_points) return;
    const sp = this._actions.stopping_points[spIndex];
    if (!sp) return;
    this._currentSP = spIndex;

    const lines = [];
    lines.push(`### ${sp.title || 'Choose'}\n`);
    for (const [key, opt] of Object.entries(sp.options || {})) {
      lines.push(`**${key}.** ${opt.label || ''}`);
    }
    lines.push('\n_Reply with a number._');

    const text = lines.join('\n');
    // _startStream() resets _streamBuffer to '' — set buffer AFTER it.
    this._startStream();
    this._streamBuffer = text;
    this._finalizeStream();
  },

  /**
   * Check if a WebSocket event belongs to this skill runner.
   */
  isSkillEvent(data) {
    return this._conversationId && data.conversationId === this._conversationId;
  },

  /**
   * Handle WebSocket events routed from ChatView.
   */
  handleWsEvent(data) {
    switch (data.type) {
      case 'chunk':
        this._streamBuffer += data.content || '';
        this._updateStream(this._streamBuffer);
        break;

      case 'tool_start':
        this._addToolChip(data.tool, data.toolId, data.args);
        break;

      case 'tool_end':
        this._updateToolChip(data.toolId, data.result, data.success);
        break;

      case 'done':
        this._clearAllToolChips();
        this._finalizeStream();
        // If a deterministic-step run queued a next-menu advance, fire it now
        if (typeof this._postLlmAdvance === 'function') {
          this._postLlmAdvance();
        }
        break;

      case 'error':
        this._clearAllToolChips();
        this._finalizeStream();
        this._addSystemMsg('Error: ' + (data.message || 'Unknown error'));
        break;

      case 'stopped':
        this._clearAllToolChips();
        this._finalizeStream();
        this._addSystemMsg('Stopped.');
        break;
    }
  },

  // --- Panel rendering ---

  _renderPanel() {
    const panel = document.createElement('div');
    panel.className = 'skill-runner-panel';
    panel.id = 'skill-runner-panel';
    panel.innerHTML = `
      <div class="skill-runner-header" onmousedown="SkillRunner._startDrag(event)">
        <span class="skill-runner-title">${this._escapeHtml(this._skillName)}</span>
        <div class="skill-runner-controls">
          <button class="skill-runner-ctrl-btn" onclick="SkillRunner.toggleMinimize()" title="Minimize">&#8722;</button>
          <button class="skill-runner-ctrl-btn" onclick="SkillRunner.close()" title="Close">&times;</button>
        </div>
      </div>
      <div class="skill-runner-body">
        <div class="skill-runner-messages" id="skill-runner-messages"></div>
        <div class="skill-runner-input-area">
          <textarea id="skill-runner-input" class="skill-runner-input" placeholder="Reply..." rows="2"></textarea>
          <button id="skill-runner-send" class="skill-runner-send-btn" onclick="SkillRunner._sendFromInput()">Send</button>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
    this._panel = panel;

    // Enter to send
    const input = panel.querySelector('#skill-runner-input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._sendFromInput();
      }
    });
  },

  // --- Messaging ---

  _send(text) {
    if (!ChatView.ws || ChatView.ws.readyState !== WebSocket.OPEN) {
      this._addSystemMsg('Not connected. Please wait...');
      return;
    }
    if (this._sending) return;

    // Add user message to panel
    this._addUserMsg(text);

    // Deterministic stopping-point interception:
    // If we have actions.json AND we're at an active stopping point AND the
    // user's reply is a number matching a known option, run the option's
    // steps directly via /api/skills/run-steps (no LLM in the loop).
    if (this._actions && this._currentSP !== null) {
      const sp = this._actions.stopping_points[this._currentSP];
      if (sp && sp.options) {
        const trimmed = text.trim();
        const numMatch = trimmed.match(/^(\d+)$/);
        if (numMatch && sp.options[numMatch[1]]) {
          this._runStepsDirect(sp.options[numMatch[1]], trimmed);
          return;
        }
      }
    }

    this._sending = true;
    this._updateSendBtn();

    // Build payload
    const payload = {
      type: 'skill_message',
      content: text,
      conversationId: this._conversationId,
      skillName: this._skillName,
    };

    // Include skill content on first message only
    const userMsgCount = this._messages.filter(m => m.role === 'user').length;
    if (userMsgCount <= 1) {
      payload.skillContent = this._skillContent;
    }

    ChatView.ws.send(JSON.stringify(payload));

    // Start streaming placeholder
    this._startStream();
  },

  /**
   * Execute a stopping-point option's steps deterministically via
   * /api/skills/run-steps. Bypasses the LLM entirely.
   */
  async _runStepsDirect(option, userReplyText) {
    this._sending = true;
    this._updateSendBtn();
    const opt = option || {};
    const steps = Array.isArray(opt.steps) ? opt.steps : [];
    if (steps.length === 0) {
      this._addSystemMsg('No steps to run for this option.');
      this._sending = false;
      this._updateSendBtn();
      return;
    }

    // Use the first user message (after the auto-opener) as the topic for {{TOPIC}}
    const userMsgs = this._messages.filter(m => m.role === 'user');
    const topic = (userMsgs.length > 1 ? userMsgs[1].text : userReplyText) || '';

    // Pre-merge any vars declared on the option
    const vars = { ...(opt.vars || {}), ...this._capturedVars };

    this._startStream();
    this._streamBuffer = `_Running ${steps.length} step${steps.length > 1 ? 's' : ''}…_\n\n`;
    this._updateStream(this._streamBuffer);

    try {
      const res = await fetch('/api/skills/run-steps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steps, topic, vars }),
      });
      const data = await res.json();

      // Merge any captured vars for the next stopping point
      if (data.captured) Object.assign(this._capturedVars, data.captured);

      // Check if all steps succeeded — if any failed, show inline error UX,
      // skip the LLM summarization (no point summarizing a failure).
      const anyFailed = (data.results || []).some(r => !r.ok);
      if (anyFailed) {
        const errLines = [];
        for (const r of (data.results || [])) {
          if (r.ok) {
            errLines.push(`✓ ${r.server}::${r.tool}`);
          } else {
            errLines.push(`✗ ${r.server}::${r.tool} (exit ${r.exitCode})`);
            const err = (r.stderr || r.stdout || '').trim();
            if (err) errLines.push('```\n' + err.slice(0, 1500) + '\n```');
            if (/auth|401|unauthor|invalid_token/i.test(err)) {
              errLines.push('> _Looks like an auth issue. Reconnect at http://localhost:8765/#/apps if needed._');
            }
          }
        }
        this._streamBuffer = errLines.join('\n');
        this._finalizeStream();
        return;
      }

      // Build the summarization prompt — feeds raw tool results to the LLM
      // alongside the skill's prose so it can format/summarize conversationally
      // (same pattern as BrainLoader → chatWithSkill in main chat).
      const ctxBlocks = [];
      for (const r of (data.results || [])) {
        const out = (r.stdout || '').trim();
        ctxBlocks.push(`## ${r.server}::${r.tool}\n\`\`\`\n${out.length > 8000 ? out.slice(0, 8000) + '\n…(truncated)' : out}\n\`\`\``);
      }
      const toolContext = ctxBlocks.join('\n\n');
      const llmMessage = `The user picked option "${opt.label}". The skill's tool steps ran successfully. Summarize the results below for the user in the skill's voice — follow the formatting guidance from the SKILL.md (bullets, timezone-aware, group by day, etc.). Do NOT show raw JSON; just the human-readable summary.\n\n${toolContext}`;

      // Finalize the "running…" placeholder so the next stream creates a fresh bubble
      this._streamBuffer = '';
      if (this._currentMsg) {
        this._currentMsg.remove();
        this._currentMsg = null;
      }

      // Track the next stopping-point advance; fire after LLM stream completes.
      // Stash on the runner so handleWsEvent('done') can trigger it.
      this._postLlmAdvance = () => {
        this._postLlmAdvance = null;
        if (this._actions && this._currentSP !== null) {
          const nextSP = this._currentSP + 1;
          if (this._actions.stopping_points && nextSP < this._actions.stopping_points.length) {
            setTimeout(() => this._renderStoppingPointMenu(nextSP), 200);
          } else {
            this._currentSP = null;  // skill complete
          }
        }
      };

      // Send to LLM via the existing skill_message WS pipeline
      this._sending = true;
      this._updateSendBtn();
      const payload = {
        type: 'skill_message',
        content: llmMessage,
        conversationId: this._conversationId,
        skillName: this._skillName,
      };
      const userMsgCount = this._messages.filter(m => m.role === 'user').length;
      if (userMsgCount <= 1) {
        payload.skillContent = this._skillContent;
      }
      ChatView.ws.send(JSON.stringify(payload));
      this._startStream();
      return;  // Skip the local _finalizeStream and next-menu render — both happen on 'done' event
    } catch (err) {
      this._streamBuffer = `Error running steps: ${err.message || err}`;
      this._finalizeStream();
    }

    this._sending = false;
    this._updateSendBtn();
  },

  _sendFromInput() {
    const input = document.getElementById('skill-runner-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    this._send(text);
  },

  // --- Message rendering ---

  _addUserMsg(text) {
    this._messages.push({ role: 'user', text });
    const container = document.getElementById('skill-runner-messages');
    if (!container) return;

    const msg = document.createElement('div');
    msg.className = 'skill-runner-msg skill-runner-msg-user';
    msg.textContent = text;
    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;
  },

  _addSystemMsg(text) {
    const container = document.getElementById('skill-runner-messages');
    if (!container) return;

    const msg = document.createElement('div');
    msg.className = 'skill-runner-msg skill-runner-msg-system';
    msg.textContent = text;
    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;
  },

  _startStream() {
    this._streamBuffer = '';
    const container = document.getElementById('skill-runner-messages');
    if (!container) return;

    const msg = document.createElement('div');
    msg.className = 'skill-runner-msg skill-runner-msg-assistant';
    msg.innerHTML = '<span class="skill-runner-typing">Thinking...</span>';
    container.appendChild(msg);
    this._currentMsg = msg;
    container.scrollTop = container.scrollHeight;
  },

  _updateStream(text) {
    if (!this._currentMsg) return;
    // Use ChatView's markdown renderer
    this._currentMsg.innerHTML = ChatView.renderMarkdown(text);
    const container = document.getElementById('skill-runner-messages');
    if (container) container.scrollTop = container.scrollHeight;
  },

  _finalizeStream() {
    this._sending = false;
    this._updateSendBtn();

    if (this._currentMsg && this._streamBuffer) {
      this._messages.push({ role: 'assistant', text: this._streamBuffer });

      // Final render with markdown
      this._currentMsg.innerHTML = ChatView.renderMarkdown(this._streamBuffer);

      // Re-wire stopping point buttons to go through SkillRunner
      this._currentMsg.querySelectorAll('.sp-button').forEach(btn => {
        const num = btn.querySelector('.sp-number')?.textContent;
        if (!num) return;
        btn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          // Highlight selected, dim others
          const menu = btn.closest('.stopping-point-menu');
          if (menu) {
            menu.querySelectorAll('.sp-button').forEach(b => {
              b.classList.toggle('selected', b === btn);
              b.classList.toggle('dimmed', b !== btn);
            });
          }
          SkillRunner._send(num);
        };
      });
    } else if (this._currentMsg && !this._streamBuffer) {
      // No content received — remove the placeholder
      this._currentMsg.remove();
    }

    this._currentMsg = null;
    this._streamBuffer = '';

    // Focus input for next reply
    const input = document.getElementById('skill-runner-input');
    if (input) input.focus();
  },

  _addToolChip(toolName, toolId, args) {
    const container = document.getElementById('skill-runner-messages');
    if (!container) return;

    const label = this._describeToolCall(toolName, args);

    const chip = document.createElement('div');
    chip.className = 'skill-runner-tool-chip';
    chip.id = 'skill-tool-' + (toolId || toolName);
    chip.innerHTML = '<span class="skill-runner-tool-spinner"></span> ' + this._escapeHtml(label);
    container.appendChild(chip);
    container.scrollTop = container.scrollHeight;
  },

  _updateToolChip(toolId, result, success) {
    const chip = document.getElementById('skill-tool-' + toolId);
    if (!chip) return;
    const spinner = chip.querySelector('.skill-runner-tool-spinner');
    if (spinner) spinner.className = success !== false ? 'skill-runner-tool-ok' : 'skill-runner-tool-err';
    // Tool is done — brief flash of the result icon, then fade out
    chip.style.transition = 'opacity 0.3s ease';
    requestAnimationFrame(() => {
      chip.style.opacity = '0';
      setTimeout(() => chip.remove(), 300);
    });
  },

  /**
   * Generate a human-readable label for a tool call.
   * Turns "Bash { command: 'curl -X POST ...' }" into "Creating skill entry..."
   */
  _describeToolCall(toolName, args) {
    if (toolName !== 'Bash' || !args) return toolName;

    const cmd = args.command || args.cmd || '';
    if (!cmd) return toolName;

    // Match common patterns and give friendly labels
    if (/curl.*POST.*\/api\/skills(?:\s|$|\\)/i.test(cmd)) return 'Creating skill entry...';
    if (/curl.*PUT.*\/api\/skills/i.test(cmd)) return 'Writing skill content...';
    if (/cat\s*>.*SKILL\.md/i.test(cmd)) return 'Writing skill file...';
    if (/sqlite3.*intent_mappings/i.test(cmd)) return 'Installing intent mappings...';
    if (/sqlite3.*skills_registry/i.test(cmd)) return 'Registering skill...';
    if (/sqlite3.*mcp_servers/i.test(cmd)) return 'Registering server...';
    if (/wc -l/i.test(cmd)) return 'Verifying file...';
    if (/curl.*GET/i.test(cmd) || /curl\s+http/i.test(cmd)) return 'Fetching data...';
    if (/curl/i.test(cmd)) return 'API call...';
    if (/sqlite3/i.test(cmd)) return 'Database update...';
    if (/npm\s+(install|i)\b/i.test(cmd)) return 'Installing package...';
    if (/git\s+clone/i.test(cmd)) return 'Cloning repository...';
    if (/chmod/i.test(cmd)) return 'Setting permissions...';
    if (/mkdir/i.test(cmd)) return 'Creating directory...';
    if (/cat\s*>/i.test(cmd)) return 'Writing file...';
    if (/rm\s/i.test(cmd)) return 'Removing file...';
    if (/ls\b/i.test(cmd)) return 'Listing files...';

    // Fallback: show first ~50 chars of the command
    const short = cmd.replace(/\s+/g, ' ').trim();
    return short.length > 50 ? short.substring(0, 47) + '...' : short;
  },

  /** Remove all tool chips — called on done/error/stopped to clean up any strays */
  _clearAllToolChips() {
    const container = document.getElementById('skill-runner-messages');
    if (!container) return;
    container.querySelectorAll('.skill-runner-tool-chip').forEach(chip => chip.remove());
  },

  _updateSendBtn() {
    const btn = document.getElementById('skill-runner-send');
    if (btn) btn.disabled = this._sending;
  },

  // --- Panel controls ---

  toggleMinimize() {
    if (!this._panel) return;
    this._minimized = !this._minimized;
    this._panel.classList.toggle('minimized', this._minimized);
  },

  close() {
    if (this._panel) {
      this._panel.remove();
      this._panel = null;
    }
    this._skillContent = null;
    this._conversationId = null;
    this._messages = [];
    this._currentMsg = null;
    this._streamBuffer = '';
    this._sending = false;
    this._minimized = false;
    this._actions = null;
    this._currentSP = null;
    this._capturedVars = {};
  },

  // --- Drag support ---

  _dragOffset: null,

  _startDrag(e) {
    if (e.target.closest('.skill-runner-ctrl-btn')) return;
    e.preventDefault();
    const panel = this._panel;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    this._dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    document.addEventListener('mousemove', this._onDrag);
    document.addEventListener('mouseup', this._stopDrag);
  },

  _onDrag(e) {
    const panel = SkillRunner._panel;
    const offset = SkillRunner._dragOffset;
    if (!panel || !offset) return;
    const x = Math.max(0, Math.min(window.innerWidth - 100, e.clientX - offset.x));
    const y = Math.max(0, Math.min(window.innerHeight - 50, e.clientY - offset.y));
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  },

  _stopDrag() {
    document.removeEventListener('mousemove', SkillRunner._onDrag);
    document.removeEventListener('mouseup', SkillRunner._stopDrag);
    SkillRunner._dragOffset = null;
  },

  // --- Helpers ---

  // Shared escaper — safe.js loads first, so VodouSafe is always present.
  // (Old local copy skipped quotes — attribute-breakout risk.)
  _escapeHtml(t) {
    return window.VodouSafe.escapeHtml(t);
  },
};
