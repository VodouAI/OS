/**
 * ExecDesk Home View — Phase 1 day 12–13 deliverable.
 *
 * Plan: PLANS/0.5.38/PLAN-SMB-EXEC-CONSOLE.md §0.11.6
 *
 * Renders:
 *   - Welcome header + tier badge
 *   - 2×2 exec card grid (CEO, CFO, CMO, CHRO) — driven by registered execdesk-* skills
 *   - "Start a conversation" team-mode input
 *   - "What your team did this week" feed (placeholder — populated when scheduled actions land)
 *   - Value-props bar
 *
 * Intentionally NOT done in v0.2.0 (deferred to Phase 2):
 *   - Live team-mode dispatch (orchestrator endpoint not built — §0.11.1)
 *   - Real "what your team did" data (no scheduled actions yet)
 *   - Onboarding gate (Chief-of-Staff interview routing)
 */
const ExecDeskView = {
  // Static defaults — overridden by skill metadata when present
  ROLE_DEFAULTS: {
    chief_of_staff: { color: '#7c3aed', label: 'Chief of Staff', subtitle: 'Onboarding & company brief',  cta: 'Start onboarding',     order: 0 },
    ceo:            { color: '#6366f1', label: 'CEO',            subtitle: 'Strategy & Growth',           cta: 'Chat with CEO →',      order: 1 },
    cfo:            { color: '#2563eb', label: 'CFO',            subtitle: 'Finance & Operations',        cta: 'Chat with CFO →',      order: 2 },
    cmo:            { color: '#16a34a', label: 'CMO',            subtitle: 'Marketing & Growth',          cta: 'Chat with CMO →',      order: 3 },
    chro:           { color: '#ea580c', label: 'CHRO',           subtitle: 'People & Culture',            cta: 'Chat with CHRO →',     order: 4 },
  },

  async render(el) {
    el.innerHTML = '';

    let allSkills = [];
    try {
      const r = await fetch('/api/skills');
      const data = await r.json();
      allSkills = (data && (data.skills || data)) || [];
      if (!Array.isArray(allSkills)) allSkills = [];
    } catch (e) {
      console.error('[execdesk] failed to load skills', e);
    }

    const execs = allSkills.filter((s) => s.name && s.name.startsWith('execdesk-'));

    // Build the 2×2 grid card list (CEO/CFO/CMO/CHRO only — Chief-of-Staff goes in onboarding rail)
    const cardRoles = ['ceo', 'cfo', 'cmo', 'chro'];
    const chiefOfStaff = execs.find((s) => this._roleOf(s) === 'chief_of_staff');

    const wrap = document.createElement('div');
    wrap.className = 'execdesk-home';

    wrap.appendChild(this._renderHeader());

    if (chiefOfStaff) {
      wrap.appendChild(this._renderOnboardingBanner(chiefOfStaff));
    }

    wrap.appendChild(this._renderCardGrid(execs, cardRoles));
    wrap.appendChild(this._renderTeamConsult(execs));
    // List all 10 action skills grouped by owning persona — each clickable to seed
    // the team-consult input with the skill's primary trigger phrase.
    const actionSkills = allSkills.filter((s) => s.name && s.name.startsWith('execdesk-action-'));
    if (actionSkills.length > 0) {
      wrap.appendChild(this._renderActionSkills(actionSkills));
    }
    wrap.appendChild(this._renderActivityFeed());
    wrap.appendChild(this._renderValueProps());

    el.appendChild(wrap);

    // Inject one-off scoped layout — keeps style cohesion without bloating 06-execdesk.css
    this._injectStyles();
  },

  // Per-browser-session tenant id so rate-limit windows don't carry over reloads.
  // Persists for one tab session via sessionStorage.
  _getTenantId() {
    try {
      let t = sessionStorage.getItem('execdesk-tenant-id');
      if (!t) {
        t = 'session-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
        sessionStorage.setItem('execdesk-tenant-id', t);
      }
      return t;
    } catch {
      return 'fallback-' + Date.now();
    }
  },

  _escapeHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  _roleOf(s) {
    const meta = s.metadata && s.metadata.vodou;
    if (meta && meta.execdesk_role) return meta.execdesk_role;
    return s.name.replace(/^execdesk-/, '').replace(/-/g, '_');
  },

  _renderHeader() {
    const header = document.createElement('div');
    header.className = 'execdesk-header';
    header.innerHTML = `
      <div class="execdesk-header-row">
        <div>
          <h1>Welcome to ExecDesk</h1>
          <p class="execdesk-subtitle">Your AI executive team is ready to help your business grow.</p>
        </div>
        <div class="execdesk-header-actions">
          <span class="execdesk-tier-badge">Starter · v0.1</span>
        </div>
      </div>
    `;
    return header;
  },

  _renderOnboardingBanner(cosSkill) {
    const banner = document.createElement('div');
    banner.className = 'execdesk-onboarding-banner';
    banner.innerHTML = `
      <div class="execdesk-onboarding-icon">📋</div>
      <div class="execdesk-onboarding-body">
        <div class="execdesk-onboarding-title">Start with your Chief of Staff</div>
        <div class="execdesk-onboarding-text">
          A 20-minute interview produces the company brief that conditions every other exec.
          Without it, your CEO and CMO sound like generic ChatGPT.
        </div>
      </div>
      <button class="execdesk-onboarding-cta" id="execdesk-start-onboarding">Start interview</button>
    `;
    banner.querySelector('#execdesk-start-onboarding').addEventListener('click', () => {
      // Solo-mode call to the Chief of Staff with an opener that triggers the
      // interview. The CoS persona responds with the depth-selection question.
      const input = document.querySelector('#execdesk-team-input');
      if (input) {
        input.value = "Let's set up my exec team — start the onboarding interview.";
        input.dataset.execOverride = cosSkill.name;
        input.focus();
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
        let chip = document.querySelector('#execdesk-solo-chip');
        if (!chip) {
          chip = document.createElement('div');
          chip.id = 'execdesk-solo-chip';
          chip.style.cssText = 'font-size:11px; color:#7c3aed; margin-top:6px;';
          input.parentElement.appendChild(chip);
        }
        chip.textContent = '🎯 Solo-mode: only Chief of Staff will respond. Hit → to start the interview.';
      }
    });
    return banner;
  },

  _renderCardGrid(execs, roleOrder) {
    const section = document.createElement('div');
    section.className = 'execdesk-card-section';

    const sectionHeader = document.createElement('h2');
    sectionHeader.className = 'execdesk-section-title';
    sectionHeader.textContent = 'Your executive team';
    section.appendChild(sectionHeader);

    const grid = document.createElement('div');
    grid.className = 'execdesk-card-grid';

    for (const role of roleOrder) {
      const skill = execs.find((s) => this._roleOf(s) === role);
      grid.appendChild(this._renderCard(role, skill));
    }
    section.appendChild(grid);
    return section;
  },

  _renderCard(role, skill) {
    const defaults = this.ROLE_DEFAULTS[role] || { color: '#6366f1', label: role.toUpperCase(), subtitle: '', cta: 'Chat →' };
    const installed = !!skill;
    const card = document.createElement('div');
    card.className = `execdesk-card ${installed ? '' : 'execdesk-card-locked'}`;
    card.dataset.role = role;
    card.style.setProperty('--role-color', defaults.color);

    card.innerHTML = `
      <div class="execdesk-card-avatar" style="background:${defaults.color}1a; color:${defaults.color};">
        ${defaults.label[0]}
      </div>
      <div class="execdesk-card-role-badge" style="background:${defaults.color}; color:white;">${defaults.label}</div>
      <div class="execdesk-card-subtitle">${defaults.subtitle}</div>
      <div class="execdesk-card-description">
        ${installed ? (skill.description || 'Specialized AI executive ready to help.') : 'Phase 2 — install to unlock.'}
      </div>
      <button class="execdesk-card-cta" ${installed ? '' : 'disabled'}>
        ${installed ? defaults.cta : 'Locked'}
      </button>
    `;

    if (installed) {
      card.querySelector('.execdesk-card-cta').addEventListener('click', () => {
        // Solo-mode: scope the next team-consult to ONLY this exec by setting an override
        // that the team-consult input handler picks up. Also seeds the input so the user
        // sees what's about to happen.
        const input = document.querySelector('#execdesk-team-input');
        if (input) {
          input.value = `Hey ${defaults.label}, `;
          input.dataset.execOverride = skill.name;
          input.focus();
          input.scrollIntoView({ behavior: 'smooth', block: 'center' });
          // Show a small chip indicating solo-mode is active for the next call.
          let chip = document.querySelector('#execdesk-solo-chip');
          if (!chip) {
            chip = document.createElement('div');
            chip.id = 'execdesk-solo-chip';
            chip.style.cssText = 'font-size:11px; color:#4338ca; margin-top:6px;';
            input.parentElement.appendChild(chip);
          }
          chip.textContent = `🎯 Solo-mode: only ${defaults.label} will respond. Click another card or clear input to reset.`;
        }
      });
    }
    return card;
  },

  _renderTeamConsult(execs) {
    const installed = execs.filter((s) => ['ceo', 'cfo', 'cmo', 'chro'].includes(this._roleOf(s)));
    const section = document.createElement('div');
    section.className = 'execdesk-team-consult';
    section.innerHTML = `
      <h2 class="execdesk-section-title">Start a conversation</h2>
      <p class="execdesk-section-subtitle">
        Ask anything. Your team works together to give you the best answer.
      </p>
      <div class="execdesk-team-row">
        <div class="execdesk-team-avatars">
          ${installed.map((s) => {
            const role = this._roleOf(s);
            const def = this.ROLE_DEFAULTS[role] || { color:'#6366f1', label: role };
            return `<span class="execdesk-team-avatar" style="background:${def.color};" title="${def.label}">${def.label[0]}</span>`;
          }).join('')}
          <span class="execdesk-team-label">${installed.length} executive${installed.length === 1 ? '' : 's'} collaborating</span>
        </div>
      </div>
      <div class="execdesk-team-input-wrap">
        <input type="text" class="execdesk-team-input" placeholder="Ask your executive team anything..." id="execdesk-team-input" />
        <button class="execdesk-team-send" id="execdesk-team-send">→</button>
      </div>
      <div class="execdesk-team-chips">
        <button class="execdesk-chip">To-do list</button>
        <button class="execdesk-chip">Budget planning</button>
        <button class="execdesk-chip">Team review</button>
        <button class="execdesk-chip">Customer strategy</button>
      </div>
      <div class="execdesk-team-result" id="execdesk-team-result" style="display:none;"></div>
    `;

    const installedIds = installed.map((s) => s.name);
    const synthesizable = installedIds.length > 1;

    // Conversation state — accumulates messages across turns. Cleared on "New conversation".
    // Stored on the section node so re-renders don't lose it within this view instance.
    section._convo = section._convo || [];

    const renderThread = () => {
      const r = section.querySelector('#execdesk-team-result');
      const inputWrap = section.querySelector('.execdesk-team-input-wrap');
      const chipsRow = section.querySelector('.execdesk-team-chips');
      const teamRow = section.querySelector('.execdesk-team-row');
      if (section._convo.length === 0) {
        r.style.display = 'none';
        r.innerHTML = '';
        // Restore default position of the input above the result area
        if (inputWrap) inputWrap.classList.remove('execdesk-input-in-thread');
        // Remove the sticky reply bar when no conversation
        const oldReplyBar = section.querySelector('.execdesk-thread-reply');
        if (oldReplyBar) oldReplyBar.remove();
        return;
      }
      r.style.display = '';
      r.innerHTML = '';

      // Header with "Start over" button (renamed from "New conversation" — clearer)
      const head = document.createElement('div');
      head.className = 'execdesk-thread-head';
      const soloLabel = (section.querySelector('#execdesk-team-input')?.dataset.execOverride || '').replace(/^execdesk-/, '').replace(/-/g, ' ').toUpperCase();
      head.innerHTML = `
        <span class="execdesk-thread-meta">
          ${section._convo.length} message${section._convo.length === 1 ? '' : 's'}${soloLabel ? ` · talking to ${soloLabel}` : ''}
        </span>
        <button class="execdesk-thread-clear" id="execdesk-thread-clear">↻ Start over</button>
      `;
      r.appendChild(head);
      head.querySelector('#execdesk-thread-clear').addEventListener('click', () => {
        section._convo = [];
        const input = section.querySelector('#execdesk-team-input');
        if (input) {
          delete input.dataset.execOverride;
          input.value = '';
          input.placeholder = 'Ask your executive team anything...';
        }
        const chip = document.querySelector('#execdesk-solo-chip');
        if (chip) chip.remove();
        renderThread();
      });

      // Render each turn as a chat bubble
      for (const m of section._convo) {
        const bubble = document.createElement('div');
        if (m.role === 'user') {
          bubble.className = 'execdesk-chat-user';
          bubble.innerHTML = `<div class="execdesk-chat-bubble execdesk-chat-bubble-user">${this._escapeHtml(m.content)}</div>`;
        } else {
          const def = ExecDeskView.ROLE_DEFAULTS[m.fromRole] || { color: '#6366f1', label: (m.from || 'EXEC').toUpperCase() };
          bubble.className = 'execdesk-chat-exec';
          const lines = (m.content || '').replace(/\n/g, '<br/>');
          bubble.innerHTML = `
            <div class="execdesk-chat-exec-head" style="color:${def.color};">${def.label} ${m.ms ? `<span class="execdesk-chat-exec-time">${m.ms}ms</span>` : ''}</div>
            <div class="execdesk-chat-bubble execdesk-chat-bubble-exec" style="border-left:3px solid ${def.color};">${lines}</div>
            ${m.error ? '' : `
              <div class="execdesk-chat-actions">
                <button class="execdesk-chat-action" data-action="copy" data-text="${this._escapeHtml(m.content)}">⧉ Copy</button>
                <button class="execdesk-chat-action" data-action="approvals" data-source="${m.from || 'exec'}" data-color="${def.color}" data-label="${def.label}" data-text="${this._escapeHtml(m.content)}">→ Send to approvals</button>
              </div>
            `}
          `;
        }
        r.appendChild(bubble);
      }

      // Wire copy/approvals actions on rendered bubbles
      r.querySelectorAll('.execdesk-chat-action').forEach((btn) => {
        btn.addEventListener('click', () => {
          const text = (btn.dataset.text || '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
          if (btn.dataset.action === 'copy') {
            navigator.clipboard.writeText(text);
            btn.textContent = '✓ Copied';
            setTimeout(() => { btn.textContent = '⧉ Copy'; }, 1500);
          } else if (btn.dataset.action === 'approvals' && window.ExecDeskApproval) {
            const titleSnippet = text.split('\n').find((l) => l.trim().length > 10) || text;
            window.ExecDeskApproval.enqueue({
              source: btn.dataset.source,
              source_label: btn.dataset.label,
              source_color: btn.dataset.color,
              action: 'manual-queue',
              title: `${btn.dataset.label}: "${titleSnippet.slice(0, 60)}${titleSnippet.length > 60 ? '…' : ''}"`,
              summary: 'Manual queue from chat thread.',
              payload_preview: text.slice(0, 600),
              gate_reason: 'Manual queue — review before acting',
            });
            btn.textContent = '✓ Queued';
            btn.disabled = true;
            try {
              const items = JSON.parse(localStorage.getItem('execdesk-approval-queue') || '[]');
              const pending = items.filter((i) => i.status === 'pending').length;
              document.querySelectorAll('.execdesk-approval-pending').forEach((el) => {
                el.dataset.count = pending > 0 ? String(pending) : '';
              });
            } catch {}
          }
        });
      });

      // Auto-scroll to bottom of thread
      r.scrollTop = r.scrollHeight;

      // Sticky reply bar inside the thread (separate from the team-mode input above)
      // — gives the founder a clear "reply here" affordance.
      let replyBar = section.querySelector('.execdesk-thread-reply');
      if (!replyBar) {
        replyBar = document.createElement('div');
        replyBar.className = 'execdesk-thread-reply';
        const placeholder = soloLabel ? `Reply to ${soloLabel}…` : 'Reply…';
        replyBar.innerHTML = `
          <input type="text" class="execdesk-thread-reply-input" placeholder="${placeholder}" />
          <button class="execdesk-thread-reply-send">→</button>
        `;
        // `section` itself is the .execdesk-team-consult element — append directly.
        section.appendChild(replyBar);

        const replyInput = replyBar.querySelector('.execdesk-thread-reply-input');
        const replySend = replyBar.querySelector('.execdesk-thread-reply-send');
        const submitReply = () => {
          const v = (replyInput.value || '').trim();
          if (!v) return;
          // Forward to the main team-input + trigger the same handleSubmit flow
          // so solo-mode override and history payload semantics are unified.
          const mainInput = section.querySelector('#execdesk-team-input');
          mainInput.value = v;
          replyInput.value = '';
          // Reuse the main send handler
          section.querySelector('#execdesk-team-send').click();
        };
        replySend.addEventListener('click', submitReply);
        replyInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') submitReply();
        });
      } else {
        // Update placeholder if solo target changed
        const replyInput = replyBar.querySelector('.execdesk-thread-reply-input');
        replyInput.placeholder = soloLabel ? `Reply to ${soloLabel}…` : 'Reply…';
      }
      replyBar.querySelector('.execdesk-thread-reply-input')?.focus();
    };

    const appendLoading = (label) => {
      const r = section.querySelector('#execdesk-team-result');
      r.style.display = '';
      const loader = document.createElement('div');
      loader.id = 'execdesk-pending-loader';
      loader.className = 'execdesk-team-loading';
      loader.innerHTML = `<div class="execdesk-spinner"></div><div>Asking ${label}…</div>`;
      r.appendChild(loader);
      r.scrollTop = r.scrollHeight;
    };
    const removeLoading = () => {
      const l = document.getElementById('execdesk-pending-loader');
      if (l) l.remove();
    };

    const setResult = (html) => {
      // Legacy fallback for error paths — appends an error bubble to the thread.
      const r = section.querySelector('#execdesk-team-result');
      r.style.display = '';
      const errBubble = document.createElement('div');
      errBubble.innerHTML = html;
      r.appendChild(errBubble);
      r.scrollTop = r.scrollHeight;
    };

    // Stream a solo-mode call via the /api/exec/stream SSE endpoint.
    // Creates a bubble that fills token-by-token, then commits to the conversation
    // when 'done' fires. The endpoint now routes through chatWithSkill which
    // gives us MCP tool access + real BrainLoader memory + gateway-side conversation
    // history. Tool-use events render inline as small status chips.
    const streamSoloCall = async (execId, prompt, _historyUnusedNow, sectionEl) => {
      const r = section.querySelector('#execdesk-team-result');
      r.style.display = '';

      // Create live-updating bubble; populate as tokens arrive.
      const role = (execId.replace(/^execdesk-/, '').replace(/-/g, '_'));
      const def = ExecDeskView.ROLE_DEFAULTS[role] || { color: '#6366f1', label: role.toUpperCase() };
      const bubble = document.createElement('div');
      bubble.className = 'execdesk-chat-exec';
      bubble.innerHTML = `
        <div class="execdesk-chat-exec-head" style="color:${def.color};">
          ${def.label} <span class="execdesk-chat-exec-time" data-ms-slot>streaming…</span>
        </div>
        <div class="execdesk-chat-tool-strip" data-tool-slot></div>
        <div class="execdesk-chat-bubble execdesk-chat-bubble-exec" style="border-left:3px solid ${def.color};" data-text-slot></div>
      `;
      r.appendChild(bubble);
      const textSlot = bubble.querySelector('[data-text-slot]');
      const msSlot = bubble.querySelector('[data-ms-slot]');
      const toolSlot = bubble.querySelector('[data-tool-slot]');
      const toolChips = new Map(); // tool name → chip element while in-flight
      r.scrollTop = r.scrollHeight;

      let accumulated = '';
      let finalMs = 0;

      try {
        const resp = await fetch('/api/exec/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            exec_id: execId,
            history,
            tenant_id: ExecDeskView._getTenantId(),
            tier: 'scale',
          }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          textSlot.innerHTML = `<em style="color:#991b1b;">Error: ${err.error || resp.statusText}</em>`;
          msSlot.textContent = '';
          return;
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const events = buf.split('\n\n');
          buf = events.pop();
          for (const evt of events) {
            const line = evt.trim();
            if (!line.startsWith('data:')) continue;
            try {
              const data = JSON.parse(line.slice(5).trim());
              if (data.type === 'token' && data.text) {
                accumulated += data.text;
                textSlot.innerHTML = accumulated.replace(/\n/g, '<br/>');
                r.scrollTop = r.scrollHeight;
              } else if (data.type === 'tool_start') {
                const chip = document.createElement('span');
                chip.className = 'execdesk-tool-chip execdesk-tool-chip-running';
                chip.textContent = `⏳ ${data.tool}`;
                toolSlot.appendChild(chip);
                toolChips.set(data.tool, chip);
                r.scrollTop = r.scrollHeight;
              } else if (data.type === 'tool_end') {
                const chip = toolChips.get(data.tool);
                if (chip) {
                  chip.className = 'execdesk-tool-chip execdesk-tool-chip-' + (data.success ? 'ok' : 'err');
                  chip.textContent = `${data.success ? '✓' : '✗'} ${data.tool}${data.ms ? ` · ${data.ms}ms` : ''}`;
                  toolChips.delete(data.tool);
                }
              } else if (data.type === 'status' && data.content) {
                // BrainLoader / debug status messages — render dim
                const status = document.createElement('div');
                status.className = 'execdesk-chat-status';
                status.textContent = data.content;
                toolSlot.appendChild(status);
              } else if (data.type === 'done') {
                finalMs = data.ms || 0;
                msSlot.textContent = `${finalMs}ms`;
              } else if (data.type === 'error') {
                textSlot.innerHTML += `<br/><em style="color:#991b1b;">${data.error}</em>`;
              }
            } catch { /* ignore parse errors */ }
          }
        }
      } catch (err) {
        textSlot.innerHTML = `<em style="color:#991b1b;">Network error: ${err.message || err}</em>`;
        msSlot.textContent = '';
      }

      // Commit the streamed message to conversation state for next turn's history.
      if (accumulated && accumulated.length >= 5) {
        sectionEl._convo.push({
          role: 'assistant',
          content: accumulated,
          from: execId,
          fromRole: role,
          ms: finalMs,
        });
        // Replace the placeholder bubble with the committed render so action buttons are wired.
        bubble.remove();
        renderThread();
      }

      // Bring the input back to focus and into view so the user can immediately reply.
      const replyInput = section.querySelector('#execdesk-team-input');
      if (replyInput) {
        replyInput.placeholder = `Reply to ${def.label}…`;
        replyInput.focus();
        replyInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    };

    const handleSubmit = async () => {
      const input = section.querySelector('#execdesk-team-input');
      const sendBtn = section.querySelector('#execdesk-team-send');
      const v = (input.value || '').trim();
      if (!v) return;
      if (installedIds.length === 0) {
        setResult(`<div class="execdesk-team-error">No execs installed yet. Set up the Chief of Staff first.</div>`);
        return;
      }

      // Solo-mode override: if a persona card was clicked, only that exec gets the call.
      const override = input.dataset.execOverride;
      const execsForCall = override ? [override] : installedIds;
      const synthesizeForCall = override ? false : synthesizable;

      // Append user message to conversation, render, build history payload for the call
      section._convo.push({ role: 'user', content: v });
      input.value = '';
      renderThread();
      const labelForLoader = execsForCall.map((id) => id.replace('execdesk-', '').replace('action-', 'action ').toUpperCase()).join(' + ');
      appendLoading(labelForLoader);

      // History sent to backend: just role + content + from-role for assistant messages,
      // omit ms/error/internal fields. Last 20 turns (server also clamps).
      const historyPayload = section._convo.slice(0, -1).slice(-20).map((m) => ({
        role: m.role,
        content: m.content,
        from: m.fromRole || undefined,
      }));

      sendBtn.disabled = true;
      sendBtn.textContent = '…';

      // Solo-mode → streaming endpoint for token-by-token UX (no spinner wall).
      // Team-mode (multi-exec + synthesis) stays one-shot for now.
      if (override) {
        await streamSoloCall(override, v, historyPayload, section);
        sendBtn.disabled = false;
        sendBtn.textContent = '→';
        removeLoading();
        return;
      }

      try {
        const r = await fetch('/api/exec/team-consult', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: v,
            execs: execsForCall,
            tenant_id: ExecDeskView._getTenantId(),
            tier: 'scale',
            synthesize: synthesizeForCall,
            history: historyPayload,
          }),
        });
        const data = await r.json();

        removeLoading();
        if (!r.ok) {
          setResult(`
            <div class="execdesk-team-error">
              <strong>${r.status === 429 ? 'Rate limit hit.' : 'Request failed.'}</strong>
              ${data.error ? data.error : ''}
              ${data.reset_at ? `<div style="font-size:11px; margin-top:4px;">Resets at ${new Date(data.reset_at).toLocaleTimeString()}</div>` : ''}
            </div>
          `);
          return;
        }

        // Append each exec's response as a chat bubble in the thread
        for (const exec of (data.execs || [])) {
          if (exec.error) {
            section._convo.push({
              role: 'assistant',
              content: `Error: ${exec.error}`,
              from: exec.id,
              fromRole: exec.role,
              error: true,
              ms: exec.ms,
            });
          } else {
            section._convo.push({
              role: 'assistant',
              content: exec.text,
              from: exec.id,
              fromRole: exec.role,
              ms: exec.ms,
            });
          }
        }
        if (data.synthesis) {
          section._convo.push({
            role: 'assistant',
            content: '**[CEO synthesis]** ' + data.synthesis,
            from: 'execdesk-ceo',
            fromRole: 'ceo',
            ms: null,
          });
        }
        renderThread();

        // Auto-enqueue: scan each exec response for the locked signal phrase
        // "Auto-queued to /#/execdesk-approval" emitted by approval-gate-ON
        // action skills (twitter-thread-drafter, future customer-email-drafter, etc.).
        // When detected, push to approval queue with role attribution.
        const AUTO_QUEUE_SIGNAL = /auto-queued to .*?execdesk-approval/i;
        const autoEnqueued = [];
        if (window.ExecDeskApproval) {
          for (const exec of (data.execs || [])) {
            if (exec.error || !exec.text) continue;
            if (!AUTO_QUEUE_SIGNAL.test(exec.text)) continue;
            const role = (exec.role || '').toUpperCase();
            const color = ExecDeskView.ROLE_DEFAULTS[exec.role]?.color || '#6b7280';
            // Strip the signal line itself from the persisted preview.
            const cleanText = exec.text.replace(AUTO_QUEUE_SIGNAL, '').trim();
            // Detect skill-action type from common output patterns (cheap heuristic).
            const action =
              /^\*\*\[?Thread/im.test(cleanText) || /^\d+\/\s/m.test(cleanText) ? 'twitter-thread' :
              /^Subject:/im.test(cleanText) ? 'email-draft' :
              'cmo-draft';
            const titleSnippet = (cleanText.split('\n').find((l) => l.trim().length > 10) || '').slice(0, 60);
            window.ExecDeskApproval.enqueue({
              source: exec.id,
              source_label: role,
              source_color: color,
              action,
              title: `${role} ${action}: "${titleSnippet}${titleSnippet.length === 60 ? '…' : ''}"`,
              summary: `Auto-drafted by ${role}. Queued by skill default-ON gate (§0.7 #9).`,
              payload_preview: cleanText.slice(0, 600),
              gate_reason: 'External publish — default-ON per §0.7 #9',
            });
            autoEnqueued.push(role);
          }
          // Bump the sidebar approval badge
          try {
            const items = JSON.parse(localStorage.getItem('execdesk-approval-queue') || '[]');
            const pending = items.filter((i) => i.status === 'pending').length;
            document.querySelectorAll('.execdesk-approval-pending').forEach((el) => {
              el.dataset.count = pending > 0 ? String(pending) : '';
            });
          } catch {}
        }
        // If anything auto-enqueued, surface a banner above the result so the founder knows.
        if (autoEnqueued.length > 0) {
          const banner = document.createElement('div');
          banner.style.cssText = 'background:#ecfdf5; border:1px solid #6ee7b7; color:#065f46; padding:10px 14px; border-radius:8px; font-size:13px; margin-bottom:12px;';
          banner.innerHTML = `<strong>✓ Auto-queued for approval</strong> — ${autoEnqueued.join(', ')} draft${autoEnqueued.length === 1 ? ' is' : 's are'} waiting in <a href="#/execdesk-approval" style="color:#065f46; font-weight:600; text-decoration:underline;">/#/execdesk-approval</a> for your review before publish.`;
          const r = section.querySelector('#execdesk-team-result');
          r.insertBefore(banner, r.firstChild);
        }

      } catch (err) {
        setResult(`<div class="execdesk-team-error"><strong>Network error.</strong> ${err.message || err}</div>`);
      } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = '→';
        removeLoading();
        // Auto-focus the input + scroll into view so reply is one tap away.
        input.placeholder = 'Reply…';
        input.focus();
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // NOTE: solo-mode override stays sticky during the conversation so follow-up
        // turns route to the same exec. Cleared by "↻ New conversation" button.
      }
    };

    section.querySelector('#execdesk-team-send').addEventListener('click', handleSubmit);
    section.querySelector('#execdesk-team-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSubmit();
    });
    section.querySelectorAll('.execdesk-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        section.querySelector('#execdesk-team-input').value = chip.textContent;
        section.querySelector('#execdesk-team-input').focus();
      });
    });
    return section;
  },

  _renderActionSkills(actionSkills) {
    // Group by which persona owns each action skill.
    const byOwner = {};
    for (const s of actionSkills) {
      const owner = (s.metadata && s.metadata.vodou && s.metadata.vodou.called_by) || 'execdesk-ceo';
      if (!byOwner[owner]) byOwner[owner] = [];
      byOwner[owner].push(s);
    }

    const section = document.createElement('div');
    section.className = 'execdesk-actions-section';

    const header = document.createElement('h2');
    header.className = 'execdesk-section-title';
    header.textContent = 'Run an action';
    section.appendChild(header);

    const sub = document.createElement('p');
    sub.className = 'execdesk-section-subtitle';
    sub.textContent = 'Click any card to seed the team chat with that skill — your team will pick up the prompt and run.';
    section.appendChild(sub);

    for (const [owner, skills] of Object.entries(byOwner)) {
      const ownerRole = owner.replace(/^execdesk-/, '');
      const def = ExecDeskView.ROLE_DEFAULTS[ownerRole] || { color: '#6366f1', label: ownerRole.toUpperCase() };

      const subhead = document.createElement('div');
      subhead.className = 'execdesk-actions-owner';
      subhead.innerHTML = `<span class="execdesk-actions-owner-badge" style="background:${def.color}1a; color:${def.color};">${def.label}</span> <span class="execdesk-actions-owner-count">${skills.length} action${skills.length === 1 ? '' : 's'}</span>`;
      section.appendChild(subhead);

      const grid = document.createElement('div');
      grid.className = 'execdesk-actions-grid';

      for (const s of skills) {
        const trigger = (s.trigger_phrases && s.trigger_phrases[0])
          || (s.metadata && s.metadata.trigger_phrases && s.metadata.trigger_phrases[0])
          || (s.name.replace(/^execdesk-action-/, '').replace(/-/g, ' '));
        const card = document.createElement('div');
        card.className = 'execdesk-action-card';
        card.style.borderLeft = `3px solid ${def.color}`;
        card.dataset.skillName = s.name;
        card.dataset.trigger = trigger;
        const friendlyName = s.name.replace(/^execdesk-action-/, '').replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
        card.innerHTML = `
          <div class="execdesk-action-card-name">${friendlyName}</div>
          <div class="execdesk-action-card-desc">${s.description || ''}</div>
          <div class="execdesk-action-card-trigger">→ "${trigger}"</div>
        `;
        card.addEventListener('click', () => {
          const input = document.querySelector('#execdesk-team-input');
          if (input) {
            input.value = trigger;
            input.focus();
            input.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        });
        grid.appendChild(card);
      }
      section.appendChild(grid);
    }

    return section;
  },

  _renderActivityFeed() {
    const section = document.createElement('div');
    section.className = 'execdesk-activity';
    section.innerHTML = `
      <div class="execdesk-activity-head">
        <h2 class="execdesk-section-title">What your team did this week</h2>
        <button class="execdesk-activity-refresh" id="execdesk-activity-refresh" title="Refresh">↻</button>
      </div>
      <div class="execdesk-activity-list" id="execdesk-activity-list">
        <div class="execdesk-activity-empty">Loading recent activity…</div>
      </div>
    `;
    // Async-fetch + render after section is in DOM
    setTimeout(() => this._loadActivityFeed(), 100);
    section.querySelector('#execdesk-activity-refresh').addEventListener('click', () => this._loadActivityFeed());
    return section;
  },

  async _loadActivityFeed() {
    const list = document.getElementById('execdesk-activity-list');
    if (!list) return;
    try {
      const r = await fetch('/api/exec/activity?limit=15');
      if (!r.ok) {
        list.innerHTML = '<div class="execdesk-activity-empty">Failed to load activity.</div>';
        return;
      }
      const { runs } = await r.json();
      if (!runs || runs.length === 0) {
        list.innerHTML = '<div class="execdesk-activity-empty">No activity yet. Scheduled actions run on cron — first ones fire next Monday at 7am (CEO competitor monitor) and 8am (CEO weekly brief).</div>';
        return;
      }
      list.innerHTML = '';
      for (const run of runs) {
        const item = document.createElement('div');
        item.className = 'execdesk-activity-item';
        const ts = new Date(run.ts);
        const when = ts.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        const execLabels = (run.execs || []).map((id) => {
          const role = id.replace(/^execdesk-/, '').replace(/-/g, '_');
          const def = ExecDeskView.ROLE_DEFAULTS[role] || { color: '#6366f1', label: role.toUpperCase() };
          return `<span class="execdesk-activity-exec" style="background:${def.color}1a; color:${def.color};">${def.label}</span>`;
        }).join('');
        const sourceTag = run.source === 'scheduled'
          ? `<span class="execdesk-activity-source-cron">⏱ scheduled</span>`
          : `<span class="execdesk-activity-source-manual">manual</span>`;
        const responseLen = (run.response_lengths || []).reduce((a, b) => a + b, 0);
        item.innerHTML = `
          <div class="execdesk-activity-item-head">
            ${execLabels}
            ${sourceTag}
            <span class="execdesk-activity-when">${when}</span>
          </div>
          <div class="execdesk-activity-prompt">${this._escapeHtml(run.prompt || '')}</div>
          <div class="execdesk-activity-meta">${run.total_ms}ms · ${responseLen} chars</div>
        `;
        list.appendChild(item);
      }
    } catch (err) {
      list.innerHTML = `<div class="execdesk-activity-empty">Error loading: ${err.message}</div>`;
    }
  },

  _renderValueProps() {
    const bar = document.createElement('div');
    bar.className = 'execdesk-valueprops';
    bar.innerHTML = `
      <div class="execdesk-vp">
        <div class="execdesk-vp-icon">🤝</div>
        <div class="execdesk-vp-title">AI Exec Team</div>
        <div class="execdesk-vp-text">Multi-modal executives with expertise across every business function.</div>
      </div>
      <div class="execdesk-vp">
        <div class="execdesk-vp-icon">📊</div>
        <div class="execdesk-vp-title">Business Intelligence</div>
        <div class="execdesk-vp-text">Analysis grounded in your real data — Stripe, QuickBooks, HubSpot.</div>
      </div>
      <div class="execdesk-vp">
        <div class="execdesk-vp-icon">⏰</div>
        <div class="execdesk-vp-title">Acts While You Sleep</div>
        <div class="execdesk-vp-text">Scheduled actions run in the background. Twitter threads, growth scrapes, weekly briefs.</div>
      </div>
    `;
    return bar;
  },

  _injectStyles() {
    if (document.getElementById('execdesk-home-styles')) return;
    const s = document.createElement('style');
    s.id = 'execdesk-home-styles';
    s.textContent = `
      body.execdesk-mode .execdesk-home { padding: 32px 40px; max-width: 1200px; margin: 0 auto; }
      body.execdesk-mode .execdesk-header { margin-bottom: 28px; }
      body.execdesk-mode .execdesk-header-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
      body.execdesk-mode .execdesk-header h1 { margin: 0 0 6px; font-size: 28px; font-weight: 700; color: var(--color-text, #1a1a2e); }
      body.execdesk-mode .execdesk-subtitle { margin: 0; color: var(--color-text-muted, #6b7280); font-size: 15px; }
      body.execdesk-mode .execdesk-header-actions { display: flex; gap: 8px; align-items: center; }

      body.execdesk-mode .execdesk-onboarding-banner {
        display: flex; gap: 16px; align-items: center;
        background: linear-gradient(135deg, #f5f3ff, #ede9fe);
        border: 1px solid #ddd6fe; border-radius: 14px;
        padding: 18px 22px; margin-bottom: 28px;
      }
      body.execdesk-mode .execdesk-onboarding-icon { font-size: 28px; }
      body.execdesk-mode .execdesk-onboarding-body { flex: 1; }
      body.execdesk-mode .execdesk-onboarding-title { font-weight: 700; color: #5b21b6; margin-bottom: 4px; }
      body.execdesk-mode .execdesk-onboarding-text { font-size: 13px; color: #6d28d9; line-height: 1.5; }
      body.execdesk-mode .execdesk-onboarding-cta {
        background: #7c3aed; color: white; border: none; padding: 10px 18px;
        border-radius: 8px; font-weight: 600; cursor: pointer;
      }
      body.execdesk-mode .execdesk-onboarding-cta:hover { background: #6d28d9; }

      body.execdesk-mode .execdesk-section-title { font-size: 18px; font-weight: 600; margin: 0 0 10px; color: var(--color-text, #1a1a2e); }
      body.execdesk-mode .execdesk-section-subtitle { margin: 0 0 16px; color: var(--color-text-muted, #6b7280); font-size: 13px; }

      body.execdesk-mode .execdesk-card-section { margin-bottom: 32px; }
      body.execdesk-mode .execdesk-card-grid {
        display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px;
      }
      body.execdesk-mode .execdesk-card {
        background: #fff; border-radius: 14px; padding: 22px;
        box-shadow: 0 2px 12px rgba(20,20,60,0.06);
        display: flex; flex-direction: column; gap: 8px;
        border-top: 3px solid var(--role-color, #6366f1);
        transition: box-shadow 0.18s ease, transform 0.18s ease;
      }
      body.execdesk-mode .execdesk-card:hover { box-shadow: 0 6px 20px rgba(20,20,60,0.10); transform: translateY(-1px); }
      body.execdesk-mode .execdesk-card-locked { opacity: 0.55; }
      body.execdesk-mode .execdesk-card-avatar {
        width: 56px; height: 56px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-weight: 700; font-size: 22px; margin-bottom: 4px;
      }
      body.execdesk-mode .execdesk-card-role-badge {
        align-self: flex-start; padding: 3px 10px; border-radius: 999px;
        font-size: 11px; font-weight: 700; letter-spacing: 0.6px;
      }
      body.execdesk-mode .execdesk-card-subtitle { font-size: 13px; color: #6b7280; }
      body.execdesk-mode .execdesk-card-description {
        font-size: 13px; color: #374151; line-height: 1.5; flex: 1; margin-bottom: 10px;
      }
      body.execdesk-mode .execdesk-card-cta {
        background: transparent; color: var(--role-color, #6366f1);
        border: 1px solid var(--role-color, #6366f1);
        padding: 8px 14px; border-radius: 8px; font-weight: 600; cursor: pointer;
        text-align: left;
      }
      body.execdesk-mode .execdesk-card-cta:hover:not(:disabled) {
        background: var(--role-color, #6366f1); color: white;
      }
      body.execdesk-mode .execdesk-card-cta:disabled { cursor: not-allowed; opacity: 0.55; }

      body.execdesk-mode .execdesk-team-consult {
        background: #fff; border-radius: 14px; padding: 24px;
        box-shadow: 0 2px 12px rgba(20,20,60,0.06); margin-bottom: 32px;
      }
      body.execdesk-mode .execdesk-team-row { margin-bottom: 14px; }
      body.execdesk-mode .execdesk-team-avatars { display: flex; align-items: center; gap: 6px; }
      body.execdesk-mode .execdesk-team-avatar {
        width: 28px; height: 28px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-size: 12px; font-weight: 700; color: white;
        margin-right: -8px; border: 2px solid #fff;
      }
      body.execdesk-mode .execdesk-team-label { margin-left: 16px; font-size: 12px; color: #6b7280; }
      body.execdesk-mode .execdesk-team-input-wrap { display: flex; gap: 8px; margin-bottom: 12px; }
      body.execdesk-mode .execdesk-team-input {
        flex: 1; padding: 12px 14px; border: 1px solid #e5e7eb; border-radius: 10px;
        font-size: 14px; outline: none;
      }
      body.execdesk-mode .execdesk-team-input:focus { border-color: #6366f1; }
      body.execdesk-mode .execdesk-team-send {
        background: #6366f1; color: white; border: none; padding: 0 18px;
        border-radius: 10px; font-size: 18px; cursor: pointer;
      }
      body.execdesk-mode .execdesk-team-send:hover { background: #4f46e5; }
      body.execdesk-mode .execdesk-team-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
      body.execdesk-mode .execdesk-chip {
        background: #f3f4f6; border: 1px solid #e5e7eb; padding: 6px 12px;
        border-radius: 999px; font-size: 12px; cursor: pointer; color: #374151;
      }
      body.execdesk-mode .execdesk-chip:hover { background: #e0e7ff; border-color: #c7d2fe; color: #4338ca; }
      body.execdesk-mode .execdesk-team-result {
        margin-top: 12px; padding: 16px; background: #f9fafb; border-radius: 10px; border: 1px solid #e5e7eb;
        max-height: 600px; overflow-y: auto; scroll-behavior: smooth;
      }
      body.execdesk-mode .execdesk-thread-head {
        display: flex; justify-content: space-between; align-items: center;
        padding-bottom: 10px; border-bottom: 1px solid #e5e7eb; margin-bottom: 14px;
      }
      body.execdesk-mode .execdesk-thread-meta { font-size: 11px; color: #6b7280; }
      body.execdesk-mode .execdesk-thread-clear {
        background: transparent; border: 1px solid #e5e7eb; color: #4338ca;
        padding: 4px 10px; border-radius: 6px; font-size: 11px; cursor: pointer;
      }
      body.execdesk-mode .execdesk-thread-clear:hover {
        background: #eef2ff;
      }
      body.execdesk-mode .execdesk-chat-user {
        display: flex; justify-content: flex-end; margin-bottom: 12px;
      }
      body.execdesk-mode .execdesk-chat-bubble-user {
        background: #6366f1; color: white; padding: 10px 14px; border-radius: 14px 14px 4px 14px;
        max-width: 80%; font-size: 13px; line-height: 1.5;
      }
      body.execdesk-mode .execdesk-chat-exec {
        margin-bottom: 14px;
      }
      body.execdesk-mode .execdesk-chat-exec-head {
        font-weight: 700; font-size: 11px; letter-spacing: 0.6px; margin-bottom: 4px;
      }
      body.execdesk-mode .execdesk-chat-exec-time {
        font-weight: 400; font-size: 10px; color: #9ca3af; margin-left: 6px;
      }
      body.execdesk-mode .execdesk-chat-bubble-exec {
        background: #fff; padding: 12px 14px; border-radius: 4px 14px 14px 14px;
        font-size: 13px; line-height: 1.6; color: #1f2937; max-width: 90%;
      }
      body.execdesk-mode .execdesk-chat-actions {
        margin-top: 6px; display: flex; gap: 8px;
      }
      body.execdesk-mode .execdesk-chat-action {
        background: transparent; border: 1px solid #e5e7eb; color: #6b7280;
        padding: 3px 8px; border-radius: 6px; font-size: 10px; cursor: pointer;
      }
      body.execdesk-mode .execdesk-chat-action:hover:not(:disabled) {
        background: #eef2ff; border-color: #c7d2fe; color: #4338ca;
      }
      body.execdesk-mode .execdesk-chat-action:disabled {
        opacity: 0.7; cursor: default;
      }

      body.execdesk-mode .execdesk-chat-tool-strip {
        display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px;
      }
      body.execdesk-mode .execdesk-tool-chip {
        display: inline-flex; align-items: center; gap: 4px;
        padding: 2px 8px; border-radius: 999px; font-size: 11px;
        background: #f3f4f6; color: #374151;
      }
      body.execdesk-mode .execdesk-tool-chip-running {
        background: #fef3c7; color: #92400e;
        animation: execdesk-pulse 1.4s ease-in-out infinite;
      }
      body.execdesk-mode .execdesk-tool-chip-ok {
        background: #d1fae5; color: #065f46;
      }
      body.execdesk-mode .execdesk-tool-chip-err {
        background: #fee2e2; color: #991b1b;
      }
      @keyframes execdesk-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.55; }
      }
      body.execdesk-mode .execdesk-chat-status {
        font-size: 10px; color: #9ca3af; padding: 2px 4px;
      }

      body.execdesk-mode .execdesk-thread-reply {
        display: flex; gap: 8px; margin-top: 14px;
        padding-top: 14px; border-top: 1px solid #e5e7eb;
      }
      body.execdesk-mode .execdesk-thread-reply-input {
        flex: 1; padding: 12px 14px; border: 1px solid #e5e7eb;
        border-radius: 10px; font-size: 14px; outline: none;
      }
      body.execdesk-mode .execdesk-thread-reply-input:focus {
        border-color: #6366f1;
      }
      body.execdesk-mode .execdesk-thread-reply-send {
        background: #6366f1; color: white; border: none; padding: 0 18px;
        border-radius: 10px; font-size: 18px; cursor: pointer;
      }
      body.execdesk-mode .execdesk-thread-reply-send:hover {
        background: #4f46e5;
      }
      body.execdesk-mode .execdesk-team-loading { display: flex; align-items: center; gap: 12px; color: #6b7280; font-size: 13px; }
      body.execdesk-mode .execdesk-spinner {
        width: 16px; height: 16px; border: 2px solid #e5e7eb; border-top-color: #6366f1;
        border-radius: 50%; animation: execdesk-spin 0.8s linear infinite;
      }
      @keyframes execdesk-spin { to { transform: rotate(360deg); } }
      body.execdesk-mode .execdesk-team-error {
        background: #fef2f2; color: #991b1b; padding: 10px 14px; border-radius: 8px;
        font-size: 13px; border: 1px solid #fecaca;
      }
      body.execdesk-mode .execdesk-team-exec-block {
        background: #fff; padding: 14px 16px; border-radius: 0 8px 8px 0; margin-bottom: 10px;
      }
      body.execdesk-mode .execdesk-team-exec-head {
        font-weight: 700; font-size: 11px; letter-spacing: 0.6px; margin-bottom: 8px;
      }
      body.execdesk-mode .execdesk-team-exec-time {
        font-weight: 400; font-size: 10px; color: #9ca3af; margin-left: 6px;
      }
      body.execdesk-mode .execdesk-team-exec-body {
        font-size: 13px; line-height: 1.6; color: #1f2937;
      }
      body.execdesk-mode .execdesk-team-exec-actions {
        margin-top: 10px; display: flex; gap: 8px;
      }
      body.execdesk-mode .execdesk-team-exec-action {
        background: #f3f4f6; border: 1px solid #e5e7eb; color: #374151;
        padding: 4px 10px; border-radius: 6px; font-size: 11px; cursor: pointer;
      }
      body.execdesk-mode .execdesk-team-exec-action:hover:not(:disabled) {
        background: #e0e7ff; border-color: #c7d2fe; color: #4338ca;
      }
      body.execdesk-mode .execdesk-team-exec-action:disabled {
        opacity: 0.7; cursor: default;
      }
      body.execdesk-mode .execdesk-team-synthesis {
        background: linear-gradient(135deg, #eef2ff, #f5f3ff);
        border: 1px solid #c7d2fe; border-radius: 10px;
        padding: 14px 16px; margin-bottom: 12px;
        font-size: 13px; line-height: 1.6; color: #1e1b4b;
      }
      body.execdesk-mode .execdesk-team-synthesis-head {
        font-weight: 700; color: #4338ca; font-size: 11px; letter-spacing: 0.5px; margin-bottom: 6px;
      }
      body.execdesk-mode .execdesk-team-meta {
        font-size: 11px; color: #9ca3af; margin-top: 8px; text-align: right;
      }

      body.execdesk-mode .execdesk-actions-section {
        background: #fff; border-radius: 14px; padding: 24px;
        box-shadow: 0 2px 12px rgba(20,20,60,0.06); margin-bottom: 32px;
      }
      body.execdesk-mode .execdesk-actions-owner {
        display: flex; align-items: center; gap: 10px; margin: 18px 0 10px;
      }
      body.execdesk-mode .execdesk-actions-owner-badge {
        font-weight: 700; font-size: 11px; letter-spacing: 0.6px;
        padding: 3px 10px; border-radius: 999px;
      }
      body.execdesk-mode .execdesk-actions-owner-count {
        font-size: 12px; color: #6b7280;
      }
      body.execdesk-mode .execdesk-actions-grid {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px;
      }
      body.execdesk-mode .execdesk-action-card {
        background: #f9fafb; padding: 12px 14px; border-radius: 8px;
        cursor: pointer; transition: background 0.15s ease, transform 0.15s ease;
      }
      body.execdesk-mode .execdesk-action-card:hover {
        background: #eef2ff; transform: translateX(2px);
      }
      body.execdesk-mode .execdesk-action-card-name {
        font-weight: 600; font-size: 13px; color: #1a1a2e; margin-bottom: 4px;
      }
      body.execdesk-mode .execdesk-action-card-desc {
        font-size: 12px; color: #6b7280; line-height: 1.4; margin-bottom: 6px;
      }
      body.execdesk-mode .execdesk-action-card-trigger {
        font-size: 11px; color: #4338ca; font-family: ui-monospace, monospace;
      }

      body.execdesk-mode .execdesk-activity {
        background: #fff; border-radius: 14px; padding: 24px;
        box-shadow: 0 2px 12px rgba(20,20,60,0.06); margin-bottom: 32px;
      }
      body.execdesk-mode .execdesk-activity-empty {
        font-size: 13px; color: #6b7280; padding: 24px;
        background: #f9fafb; border-radius: 10px; text-align: center; line-height: 1.6;
      }
      body.execdesk-mode .execdesk-activity-head {
        display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;
      }
      body.execdesk-mode .execdesk-activity-refresh {
        background: transparent; border: 1px solid #e5e7eb; color: #6b7280;
        padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 13px;
      }
      body.execdesk-mode .execdesk-activity-refresh:hover {
        background: #eef2ff; color: #4338ca;
      }
      body.execdesk-mode .execdesk-activity-list {
        display: flex; flex-direction: column; gap: 8px;
      }
      body.execdesk-mode .execdesk-activity-item {
        background: #f9fafb; padding: 10px 14px; border-radius: 8px;
      }
      body.execdesk-mode .execdesk-activity-item-head {
        display: flex; align-items: center; gap: 8px; margin-bottom: 4px;
      }
      body.execdesk-mode .execdesk-activity-exec {
        font-size: 10px; padding: 2px 8px; border-radius: 999px; font-weight: 700; letter-spacing: 0.4px;
      }
      body.execdesk-mode .execdesk-activity-source-cron {
        font-size: 10px; color: #4338ca; background: #eef2ff; padding: 2px 8px; border-radius: 999px;
      }
      body.execdesk-mode .execdesk-activity-source-manual {
        font-size: 10px; color: #6b7280; background: #f3f4f6; padding: 2px 8px; border-radius: 999px;
      }
      body.execdesk-mode .execdesk-activity-when {
        font-size: 11px; color: #9ca3af; margin-left: auto;
      }
      body.execdesk-mode .execdesk-activity-prompt {
        font-size: 12px; color: #374151; line-height: 1.4;
      }
      body.execdesk-mode .execdesk-activity-meta {
        font-size: 10px; color: #9ca3af; margin-top: 4px;
      }

      body.execdesk-mode .execdesk-valueprops {
        display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px;
        background: #f3f4f6; border-radius: 14px; padding: 24px;
      }
      body.execdesk-mode .execdesk-vp { text-align: left; }
      body.execdesk-mode .execdesk-vp-icon { font-size: 22px; margin-bottom: 6px; }
      body.execdesk-mode .execdesk-vp-title { font-weight: 700; margin-bottom: 4px; color: #1a1a2e; }
      body.execdesk-mode .execdesk-vp-text { font-size: 12px; color: #6b7280; line-height: 1.5; }

      @media (max-width: 900px) {
        body.execdesk-mode .execdesk-card-grid { grid-template-columns: 1fr; }
        body.execdesk-mode .execdesk-valueprops { grid-template-columns: 1fr; }
      }
    `;
    document.head.appendChild(s);
  },
};

if (typeof Router !== 'undefined') {
  Router.register('/execdesk', (el) => ExecDeskView.render(el), ExecDeskView);
}
