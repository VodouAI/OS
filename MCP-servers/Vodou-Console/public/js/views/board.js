/**
 * Vodou Board view — 6-column kanban with drawer + live event polling.
 * Mirrors the existing SchedulerView shape (vanilla JS, Components.*, API.*).
 *
 * Phase 1 baseline:
 *   - 6 columns: triage | todo | ready | running | blocked | done (+ pending_approval, archived toggle)
 *   - Click card → drawer with full detail (runs, comments, events, parents/children)
 *   - Drag-drop a card between columns → PATCH /tasks/:id { status }
 *   - "+ New" inline composer in each column
 *   - Cmd+K opens a quick-create palette
 *   - Long-poll /api/board/events every 3s for live updates
 *   - Cost meter on cards (Phase 1 = display-only)
 *
 * Phase 2-3 (deferred):
 *   - Graph / Timeline / Metrics views
 *   - WebSocket instead of long-poll
 *   - Drag-to-reorder within column
 *   - Inline drawer editing (markdown)
 *   - Workflow template panel
 *   - AI Replay panel
 */

const BoardView = {
  // ── state ───────────────────────────────────────────────────
  _state: {
    boardId: 'default',
    tasks: [],
    columns: {},
    filters: { assignees: [], tenants: [] },
    activeDrawerId: null,
    pollSince: 0,
    pollHandle: null,
    showArchived: false,
    // Board Planner drawer
    planStream: null,    // AbortController for the in-flight SSE plan (or null)
    planSessionId: null, // server-issued id, threads refine + commit
    planDraft: null,     // last draft streamed back (what Commit materializes)
    planPollHandle: null, // issue #3 — re-attach poll timer (or null)
  },

  _STATUS_ORDER: ['plan', 'triage', 'todo', 'ready', 'running', 'blocked', 'pending_approval', 'done'],
  _STATUS_LABELS: {
    plan:             'Plan',
    triage:           'Triage',
    todo:             'Todo',
    ready:            'Ready',
    running:          'In Progress',
    blocked:          'Blocked',
    pending_approval: 'Awaiting Approval',
    done:             'Done',
    archived:         'Archived',
  },

  // ── lifecycle ───────────────────────────────────────────────
  async render(container) {
    this._stopPolling();
    container.innerHTML = '';
    container.classList.add('board-view');
    // The router set #main-content's inline display:block (beats the stylesheet's
    // .board-view{display:flex}). Re-assert flex inline so the board's flex-height
    // chain activates — otherwise .board-body grows to content height and the plan
    // drawer stretches "super tall" (1359px in an 813px viewport). The next view's
    // render resets the inline display.
    container.style.display = 'flex';

    const header = this._renderHeader();
    container.appendChild(header);

    const body = document.createElement('div');
    body.className = 'board-body';
    container.appendChild(body);

    const columns = document.createElement('div');
    columns.className = 'board-columns';
    body.appendChild(columns);

    const drawer = document.createElement('aside');
    drawer.className = 'board-drawer';
    drawer.id = 'board-drawer';
    drawer.style.display = 'none';
    body.appendChild(drawer);

    const planDrawer = document.createElement('aside');
    planDrawer.className = 'board-plan-drawer';
    planDrawer.id = 'board-plan-drawer';
    planDrawer.style.display = 'none';
    body.appendChild(planDrawer);

    await this._loadAndRender(columns);
    this._startPolling(columns);

    // Cmd+K quick-create
    this._installQuickCreate();

    // Issue #3 — if a plan kept running server-side while we were on another
    // view, re-open its drawer and replay it (log + draft) now that we're back.
    this._reattachPlan();
  },

  // ── rendering ───────────────────────────────────────────────
  _renderHeader() {
    const header = document.createElement('div');
    header.className = 'board-header';
    header.innerHTML = `
      <div class="board-title-row">
        <h1>Kanban Board</h1>
        <div class="board-summary" id="board-summary">…</div>
      </div>
      ${localStorage.getItem('vodou-board-intro-dismissed') ? '' : `
      <div class="board-intro" id="board-intro">
        <p><strong>Hand off work to Vodou's autonomous AI workers.</strong> Add a task — a sentence
        describing what you want done — to <em>Todo</em>, and the board promotes it to <em>Ready</em>,
        assigns a worker, and runs it. Each worker runs through Vodou's full brain with access to your
        skills and connected MCP apps, so it can search, message, generate, and call tools to actually
        complete the task. Watch cards move across the columns (Triage → Todo → Ready → Running → Done);
        the worker's live output streams into the <em>Board</em> chat tab, and each card's drawer shows its
        runs, comments, and events. Use Delete on a card or Clear done to tidy up.</p>
        <button class="board-intro-dismiss" id="board-intro-dismiss" title="Dismiss" aria-label="Dismiss">×</button>
      </div>`}
      <div class="board-actions">
        <input
          type="text"
          id="board-search"
          placeholder="search (or ${window.vodouModChord ? window.vodouModChord('K') : '⌘K'} for quick-create)"
          class="board-search-input"
        />
        <label class="board-checkbox">
          <input type="checkbox" id="board-show-archived" />
          <span>Show archived</span>
        </label>
        <button id="board-plan" class="btn btn-primary" title="Plan a goal into ordered tasks">🧭 Plan</button>
        <button id="board-dispatch" class="btn">Dispatch tick</button>
        <button id="board-clear" class="btn btn-secondary" title="Permanently delete all done + archived tasks">Clear done</button>
        <button id="board-refresh" class="btn btn-secondary">Refresh</button>
      </div>
    `;
    header.querySelector('#board-show-archived').addEventListener('change', (e) => {
      this._state.showArchived = e.target.checked;
      this._refresh();
    });
    header.querySelector('#board-refresh').addEventListener('click', () => this._refresh());
    header.querySelector('#board-plan').addEventListener('click', () => this._openPlanDrawer());
    header.querySelector('#board-dispatch').addEventListener('click', () => this._dispatchTick());
    header.querySelector('#board-clear').addEventListener('click', async () => {
      if (!confirm('Permanently delete ALL done + archived tasks?\nThis cannot be undone.')) return;
      try {
        // Always name the board being cleared. The server defaults to 'default'
        // when this is absent, so an un-scoped caller could only ever clear the
        // default board — but being explicit here is what keeps this correct
        // once _state.boardId stops being a constant.
        const r = await API.post('/api/board/tasks/clear', {
          statuses: ['done', 'archived'],
          board_id: this._state.boardId,
        });
        this._refresh();
        alert(`Cleared ${r.deleted ?? 0} task(s).`);
      } catch (e) {
        alert(`Clear failed: ${e.message ?? e}`);
      }
    });
    header.querySelector('#board-search').addEventListener('input', (e) => this._applySearch(e.target.value));
    const introDismiss = header.querySelector('#board-intro-dismiss');
    if (introDismiss) {
      introDismiss.addEventListener('click', () => {
        localStorage.setItem('vodou-board-intro-dismissed', '1');
        header.querySelector('#board-intro')?.remove();
      });
    }
    return header;
  },

  async _loadAndRender(columnsEl) {
    try {
      const url = `/api/board?board=${encodeURIComponent(this._state.boardId)}` +
                  (this._state.showArchived ? '&include_archived=1' : '');
      const resp = await API.get(url);
      this._state.tasks = [];
      this._state.columns = resp.columns ?? {};
      this._state.filters = resp.filters ?? { assignees: [], tenants: [] };

      const total = resp.total ?? 0;
      const summary = document.getElementById('board-summary');
      if (summary) summary.textContent = `${total} task${total === 1 ? '' : 's'}`;

      this._renderColumns(columnsEl);

      // Seed pollSince to the true HEAD (global max event id). Must use `head`,
      // NOT `last_id`: last_id is the max of the returned page, so with limit=1
      // it's the OLDEST event — seeding from it leaves pollSince behind the real
      // head, so every poll re-fetches the same backlog and the board flickers.
      try {
        const events = await API.get('/api/board/events?since=0&limit=1');
        this._state.pollSince = events.head ?? events.last_id ?? 0;
      } catch {
        /* ignore */
      }
    } catch (e) {
      const msg = String(e.message ?? e);
      // Friendly first-run: board.db missing → offer one-click init
      if (msg.includes('board.db not initialized')) {
        columnsEl.innerHTML = this._renderFirstRunHTML();
        const initBtn = columnsEl.querySelector('#board-init-btn');
        if (initBtn) {
          initBtn.addEventListener('click', async () => {
            initBtn.disabled = true;
            initBtn.textContent = 'Initializing…';
            try {
              await API.post('/api/board/init', {});
              await this._refresh();
            } catch (err) {
              alert(`Init failed: ${err.message ?? err}\n\nTry from the shell:\n  ./do board migrate --init`);
              initBtn.disabled = false;
              initBtn.textContent = '✨ Initialize Vodou Board';
            }
          });
        }
        return;
      }
      columnsEl.innerHTML = `<div class="board-error">Failed to load board: ${this._esc(msg)}</div>`;
    }
  },

  _renderFirstRunHTML() {
    return `
      <div class="board-first-run">
        <div class="board-first-run-card">
          <div class="board-first-run-icon">🗂</div>
          <h2>Welcome to Vodou Board</h2>
          <p>
            Vodou Board is a multi-agent task board — durable, MCP-native, channel-aware.
            Workers spawn as OS processes, claim tasks atomically, and report back via the same
            board you're looking at now.
          </p>
          <p>
            Your board hasn't been initialized yet. Click below to create
            <code>board.db</code> at your project root (one-time setup).
          </p>
          <button id="board-init-btn" class="btn btn-primary board-first-run-btn">
            ✨ Initialize Vodou Board
          </button>
          <p class="board-first-run-note">
            Or run from the shell: <code>./do board migrate --init</code>
          </p>
          <details class="board-first-run-details">
            <summary>What will happen?</summary>
            <ul>
              <li>Creates <code>board.db</code> at your project root (WAL-mode SQLite)</li>
              <li>Applies migration 001: 10 tables, 23 indexes, FTS5 virtual table</li>
              <li>Seeds the default board (<code>id=default</code>)</li>
              <li>Adds 11 keys to <code>vodou-core.db::board_config</code> (dispatcher tunables)</li>
              <li>No data is sent off-device; the board lives entirely on your machine</li>
            </ul>
          </details>
        </div>
      </div>
    `;
  },

  _renderColumns(columnsEl) {
    // Preserve an in-progress composer across the full DOM rebuild below.
    // Polling refreshes (every 3s) otherwise wipe whatever you're typing.
    const active = document.activeElement;
    let restore = null;
    if (active && active.classList?.contains('board-composer-input')) {
      const col = active.closest('.board-col');
      restore = {
        status: col?.dataset.status,
        value: active.value,
        selStart: active.selectionStart,
        selEnd: active.selectionEnd,
      };
    }

    columnsEl.innerHTML = '';
    const showCols = [...this._STATUS_ORDER];
    if (this._state.showArchived) showCols.push('archived');

    for (const status of showCols) {
      const tasks = this._state.columns[status] ?? [];
      const col = this._renderColumn(status, tasks);
      columnsEl.appendChild(col);
    }

    if (restore && restore.status) {
      const input = columnsEl.querySelector(
        `.board-col[data-status="${restore.status}"] .board-composer-input`
      );
      if (input) {
        input.value = restore.value;
        input.focus();
        try { input.setSelectionRange(restore.selStart, restore.selEnd); } catch { /* noop */ }
      }
    }
  },

  _renderColumn(status, tasks) {
    const col = document.createElement('div');
    col.className = `board-col board-col-${status}`;
    col.dataset.status = status;

    const header = document.createElement('div');
    header.className = 'board-col-header';
    header.innerHTML = `
      <span class="board-col-title">${this._STATUS_LABELS[status] ?? status}</span>
      <span class="board-col-count">${tasks.length}</span>
    `;
    col.appendChild(header);

    const body = document.createElement('div');
    body.className = 'board-col-body';

    // Drag-drop accept
    body.addEventListener('dragover', (e) => {
      e.preventDefault();
      body.classList.add('drag-over');
    });
    body.addEventListener('dragleave', () => body.classList.remove('drag-over'));
    body.addEventListener('drop', (e) => {
      e.preventDefault();
      body.classList.remove('drag-over');
      const taskId = e.dataTransfer.getData('text/board-task-id');
      const oldStatus = e.dataTransfer.getData('text/board-task-status');
      if (taskId && oldStatus !== status) {
        this._moveTask(taskId, status);
      }
    });

    for (const t of tasks) {
      body.appendChild(this._renderCard(t, status));
    }

    // Inline composer
    const composer = this._renderComposer(status);
    body.appendChild(composer);

    col.appendChild(body);
    return col;
  },

  _renderCard(task, status) {
    const card = document.createElement('div');
    card.className = `board-card status-${status}`;
    card.dataset.taskId = task.id;
    card.draggable = true;

    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/board-task-id', task.id);
      e.dataTransfer.setData('text/board-task-status', status);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('click', () => this._openDrawer(task.id));

    const assigneeChip = task.assignee
      ? `<span class="board-chip board-chip-assignee">@${this._esc(task.assignee)}</span>`
      : '';
    const priorityChip = `<span class="board-chip board-chip-pri pri-${this._priBucket(task.priority)}">${task.priority}</span>`;
    const idChip = `<span class="board-chip board-chip-id">${this._esc(task.id)}</span>`;

    card.innerHTML = `
      <div class="board-card-title">${this._esc(task.title)}</div>
      <div class="board-card-meta">
        ${assigneeChip}
        ${priorityChip}
        ${idChip}
      </div>
    `;
    return card;
  },

  _renderComposer(status) {
    const wrap = document.createElement('div');
    wrap.className = 'board-composer';
    wrap.innerHTML = `
      <input
        type="text"
        class="board-composer-input"
        placeholder="+ new task in ${this._STATUS_LABELS[status]}"
      />
    `;
    const input = wrap.querySelector('input');
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        const title = input.value.trim();
        input.value = '';
        await this._createTask(title, status);
      }
    });
    return wrap;
  },

  // ── drawer ──────────────────────────────────────────────────
  async _openDrawer(taskId) {
    this._state.activeDrawerId = taskId;
    const drawer = document.getElementById('board-drawer');
    drawer.style.display = 'block';
    drawer.innerHTML = '<div class="board-drawer-loading">Loading…</div>';

    try {
      const data = await API.get(`/api/board/tasks/${encodeURIComponent(taskId)}`);
      drawer.innerHTML = this._renderDrawerHTML(data);
      this._bindDrawerHandlers(drawer, data);
    } catch (e) {
      // Task gone (deleted/cleared from another tab or out-of-band) — drop the
      // stale card and close the drawer rather than showing a raw error.
      const msg = String(e.message ?? e);
      if (/not found/i.test(msg) || /\b404\b/.test(msg)) {
        this._closeDrawer();
        this._refresh();
        return;
      }
      drawer.innerHTML = `<div class="board-error">Failed to load task: ${this._esc(msg)}</div>`;
    }
  },

  // Find the active skill stopping-point gate for a parked task: the most
  // recent `approval_requested` event carrying a skill_stopping_point payload.
  // Only surfaced while the task is actually parked (pending_approval).
  _latestSkillStoppingPoint(data) {
    if (data.task?.status !== 'pending_approval') return null;
    const events = data.events ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.kind !== 'approval_requested') continue;
      let p;
      try { p = JSON.parse(e.payload_json ?? '{}'); } catch { continue; }
      if (p.kind === 'skill_stopping_point') {
        return { skill: p.skill, title: p.title, options: p.options ?? {}, menu: p.menu };
      }
    }
    return null;
  },

  // Reconstruct the skill run timeline from durable task_events:
  //   approval_requested (stopping point reached) + skill_choice (option picked)
  //   + skill_step (tool/step output) + completed/blocked (terminal).
  // Returns '' for non-skill tasks (no skill events present).
  _renderRunView(data) {
    const events = data.events ?? [];
    const order = [];                 // phases in the sequence they were reached
    const byPhase = {};               // phase -> { title, picked, output }
    let summary = null, blockedReason = null, skillName = null;
    const get = (p) => { try { return JSON.parse(p ?? '{}'); } catch { return {}; } };

    for (const e of events) {
      const p = get(e.payload_json);
      if (e.kind === 'approval_requested' && p.kind === 'skill_stopping_point') {
        skillName = skillName ?? p.skill;
        if (!(p.phase in byPhase)) { byPhase[p.phase] = { title: p.title }; order.push(p.phase); }
        else { byPhase[p.phase].title = p.title; }
      } else if (e.kind === 'skill_choice') {
        skillName = skillName ?? p.skill;
        if (!(p.phase in byPhase)) { byPhase[p.phase] = { title: p.title }; order.push(p.phase); }
        byPhase[p.phase].picked = p.label ?? p.choice;
      } else if (e.kind === 'skill_step') {
        if (!(p.phase in byPhase)) { byPhase[p.phase] = {}; order.push(p.phase); }
        byPhase[p.phase].output = p.output;
      } else if (e.kind === 'completed' && p.via === 'skill_workflow') {
        summary = p.summary ?? null;
      } else if (e.kind === 'blocked' && /skill/i.test(JSON.stringify(p))) {
        blockedReason = p.reason ?? null;
      }
    }

    if (!order.length && !skillName) return '';   // not a skill run

    const steps = order.map((ph) => {
      const s = byPhase[ph] || {};
      const done = s.picked != null;
      const mark = done ? '✓' : '●';
      const out = s.output ? `
        <details class="run-step-out"><summary>output</summary><pre>${this._esc(String(s.output))}</pre></details>` : '';
      return `
        <div class="run-step ${done ? 'done' : 'current'}">
          <span class="run-step-mark">${mark}</span>
          <span class="run-step-title">${this._esc(s.title ?? `Step ${ph + 1}`)}</span>
          ${s.picked != null ? `<span class="run-step-arrow">→</span><span class="run-step-pick">${this._esc(String(s.picked))}</span>` : '<span class="run-step-wait">awaiting choice</span>'}
          ${out}
        </div>`;
    }).join('');

    const terminal = summary
      ? `<div class="run-summary-final">✅ ${this._esc(summary)}</div>`
      : blockedReason
      ? `<div class="run-blocked-final">⛔ ${this._esc(blockedReason)}</div>`
      : '';

    return `
      <div class="board-drawer-section board-runview">
        <h3>Run${skillName ? ` — <span class="runview-skill">${this._esc(skillName)}</span>` : ''}</h3>
        <div class="run-steps">${steps}</div>
        ${terminal}
        <button class="btn btn-secondary run-open-chat" data-action="view-chat">View in Board chat ↗</button>
      </div>`;
  },

  _renderDrawerHTML(data) {
    const t = data.task;
    const runs = (data.runs ?? []).map(r => `
      <div class="board-drawer-run outcome-${r.outcome ?? 'open'}">
        <div class="run-header">
          <span class="run-num">#${r.attempt_no}</span>
          <span class="run-outcome">${this._esc(r.outcome ?? '(open)')}</span>
          <span class="run-profile">@${this._esc(r.profile ?? '-')}</span>
          <span class="run-elapsed">${this._renderElapsed(r.started_at, r.ended_at)}</span>
        </div>
        ${r.summary ? `<div class="run-summary">${this._esc(r.summary)}</div>` : ''}
        ${r.error ? `<div class="run-error">${this._esc(r.error)}</div>` : ''}
      </div>
    `).join('') || '<div class="empty">no runs</div>';

    // item 14 — the mini-run card: what the GRAPH did for this task.
    // Rendered only when a graph actually ran, so an ordinary card is unchanged.
    // Every number here is read from the recorded run (`counts_json`), never
    // from a summary a model wrote — Coherence Rule 9.
    const graphRuns = (data.graphRuns ?? []).map(r => {
      let counts = {};
      try { counts = JSON.parse(r.counts_json || '{}'); } catch { counts = {}; }
      let ask = null;
      try { ask = r.pending_ask_json ? JSON.parse(r.pending_ask_json) : null; } catch { ask = null; }
      const bits = [];
      if (counts.expected != null) bits.push(`${counts.ok ?? 0}/${counts.expected} branches`);
      if (counts.failed) bits.push(`${counts.failed} failed`);
      const elapsed = (r.started_at && r.ended_at)
        ? `${((r.ended_at - r.started_at) / 1000).toFixed(1)}s` : '';
      return `
      <div class="board-drawer-run graphrun outcome-${this._esc(r.outcome ?? 'running')}">
        <div class="run-header">
          <span class="run-num">⋔</span>
          <span class="run-outcome">${this._esc(r.outcome ?? 'running')}</span>
          <span class="run-profile">${this._esc(r.skill ?? '')}</span>
          <span class="run-elapsed">${this._esc(elapsed)}</span>
        </div>
        ${bits.length ? `<div class="run-summary">${this._esc(bits.join(' · '))}</div>` : ''}
        ${ask && ask.title ? `<div class="run-ask">⏸ waiting on you — ${this._esc(ask.title)}</div>` : ''}
      </div>`;
    }).join('');

    const comments = (data.comments ?? []).map(c => `
      <div class="board-drawer-comment">
        <div class="comment-meta">${this._esc(c.author_label ?? c.author_principal_id ?? '?')} · ${this._renderTime(c.created_at)}</div>
        <div class="comment-body">${this._esc(c.body)}</div>
      </div>
    `).join('') || '<div class="empty">no comments yet</div>';

    const events = (data.events ?? []).slice(0, 30).map(e => `
      <div class="board-drawer-event">
        <span class="event-kind">${this._esc(e.kind)}</span>
        <span class="event-time">${this._renderTime(e.created_at)}</span>
      </div>
    `).join('');

    const parents = (data.parents ?? []).map(p => `<span class="board-chip">${this._esc(p)}</span>`).join(' ');
    const children = (data.children ?? []).map(c => `<span class="board-chip">${this._esc(c)}</span>`).join(' ');

    // Skill stopping-point approval gate: if the task is parked awaiting a
    // choice, surface the menu as buttons that resume the workflow.
    const approval = this._latestSkillStoppingPoint(data);
    const approvalSection = approval ? `
        <div class="board-drawer-section board-approval">
          <h3>Approval needed${approval.skill ? ` — <span class="board-approval-skill">${this._esc(approval.skill)}</span>` : ''}</h3>
          <div class="board-approval-title">${this._esc(approval.title ?? 'Choose an option')}</div>
          <div class="board-approval-options">
            ${Object.entries(approval.options ?? {}).map(([k, opt]) =>
              `<button class="btn board-approval-choice" data-choice="${this._esc(k)}">${this._esc(k)}. ${this._esc(opt.label ?? '')}</button>`
            ).join('')}
          </div>
        </div>` : '';

    return `
      <div class="board-drawer-header">
        <div class="board-drawer-title">${this._esc(t.title)}</div>
        <button class="board-drawer-close" aria-label="Close">×</button>
      </div>
      <div class="board-drawer-body">
        <div class="board-drawer-meta">
          <div><b>ID:</b> ${this._esc(t.id)}</div>
          <div><b>Status:</b> <span class="status-pill status-${t.status}">${t.status}</span></div>
          <div><b>Assignee:</b> @${this._esc(t.assignee ?? '-')}</div>
          <div><b>Priority:</b> ${t.priority}</div>
          <div><b>Workspace:</b> ${this._esc(t.workspace)}</div>
          ${t.workflow_template_id ? `<div><b>Template:</b> ${this._esc(t.workflow_template_id)}</div>` : ''}
          ${parents ? `<div><b>Parents:</b> ${parents}</div>` : ''}
          ${children ? `<div><b>Children:</b> ${children}</div>` : ''}
        </div>

        ${t.body ? `<div class="board-drawer-section"><h3>Body</h3><div class="board-drawer-body-md">${this._esc(t.body)}</div></div>` : ''}

        ${approvalSection}

        ${this._renderRunView(data)}

        <div class="board-drawer-section">
          <h3>Actions</h3>
          <div class="board-drawer-actions">
            <button class="btn" data-action="complete">Complete</button>
            <button class="btn" data-action="block">Block…</button>
            ${t.status === 'blocked' ? '<button class="btn" data-action="unblock">Unblock</button>' : ''}
            ${t.status !== 'archived' ? '<button class="btn btn-secondary" data-action="archive">Archive</button>' : ''}
            <button class="btn btn-secondary" data-action="heartbeat">Heartbeat</button>
            <button class="btn btn-danger" data-action="delete" style="margin-left:auto">Delete</button>
          </div>
        </div>

        <div class="board-drawer-section">
          <h3>Runs (${(data.runs ?? []).length})</h3>
          <div class="board-drawer-runs">${runs}</div>
          ${graphRuns ? `<h3>Graph runs (${(data.graphRuns ?? []).length})</h3>
          <div class="board-drawer-runs">${graphRuns}</div>` : ''}
        </div>

        <div class="board-drawer-section">
          <h3>Comments (${(data.comments ?? []).length})</h3>
          <div class="board-drawer-comments">${comments}</div>
          <div class="board-drawer-comment-add">
            <input type="text" id="drawer-comment-input" placeholder="add a comment…" />
            <button class="btn btn-secondary" data-action="comment">Post</button>
          </div>
        </div>

        <div class="board-drawer-section">
          <h3>Events (${(data.events ?? []).length})</h3>
          <div class="board-drawer-events">${events}</div>
        </div>
      </div>
    `;
  },

  _bindDrawerHandlers(drawer, data) {
    const taskId = data.task.id;
    drawer.querySelector('.board-drawer-close')?.addEventListener('click', () => this._closeDrawer());

    // Skill stopping-point choices — resume the parked workflow.
    drawer.querySelectorAll('.board-approval-choice').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const choice = btn.dataset.choice;
        drawer.querySelectorAll('.board-approval-choice').forEach(b => { b.disabled = true; });
        btn.textContent = `${btn.textContent} …`;
        try {
          await API.post(`/api/board/tasks/${taskId}/skill-choice`, { choice });
          await this._openDrawer(taskId); // re-render — shows next gate or done
          this._refresh();
        } catch (e) {
          alert(`Choice failed: ${e.message ?? e}`);
          drawer.querySelectorAll('.board-approval-choice').forEach(b => { b.disabled = false; });
        }
      });
    });

    drawer.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        try {
          if (action === 'view-chat') {
            // Deep-link to the Board chat tab, scrolled to this task's run block.
            this._closeDrawer();
            location.hash = `#/chat?board=${encodeURIComponent(taskId)}`;
            return;
          } else if (action === 'complete') {
            const summary = prompt('Summary (one paragraph):', 'completed via dashboard');
            if (summary === null) return;
            await API.post(`/api/board/tasks/${taskId}/complete`, { summary, metadata: {} });
          } else if (action === 'block') {
            const reason = prompt('Block reason:');
            if (!reason) return;
            await API.post(`/api/board/tasks/${taskId}/block`, { reason });
          } else if (action === 'unblock') {
            await API.post(`/api/board/tasks/${taskId}/unblock`, {});
          } else if (action === 'archive') {
            if (!confirm(`Archive ${taskId}?`)) return;
            await API.patch(`/api/board/tasks/${taskId}`, { status: 'archived' });
          } else if (action === 'heartbeat') {
            await API.post(`/api/board/tasks/${taskId}/heartbeat`, {});
          } else if (action === 'delete') {
            if (!confirm(`Permanently delete ${taskId} and all its history?\nThis cannot be undone.`)) return;
            await API.del(`/api/board/tasks/${taskId}`);
            this._closeDrawer();   // task is gone — don't re-open it
            this._refresh();
            return;
          } else if (action === 'comment') {
            const inp = drawer.querySelector('#drawer-comment-input');
            const body = inp?.value.trim();
            if (!body) return;
            await API.post(`/api/board/tasks/${taskId}/comments`, { body });
            inp.value = '';
          }
          await this._openDrawer(taskId); // re-render
          this._refresh();
        } catch (e) {
          alert(`Action failed: ${e.message ?? e}`);
        }
      });
    });
  },

  _closeDrawer() {
    this._state.activeDrawerId = null;
    const drawer = document.getElementById('board-drawer');
    if (drawer) drawer.style.display = 'none';
  },

  // ── actions ─────────────────────────────────────────────────
  async _moveTask(taskId, newStatus) {
    try {
      await API.patch(`/api/board/tasks/${encodeURIComponent(taskId)}`, { status: newStatus });
      this._refresh();
    } catch (e) {
      alert(`Move failed: ${e.message ?? e}`);
    }
  },

  async _createTask(title, status) {
    try {
      await API.post('/api/board/tasks', { title, status });
      this._refresh();
    } catch (e) {
      alert(`Create failed: ${e.message ?? e}`);
    }
  },

  async _dispatchTick() {
    try {
      const r = await API.post('/api/board/dispatch', {});
      console.info('[board] dispatch:', r);
      this._refresh();
    } catch (e) {
      alert(`Dispatch failed: ${e.message ?? e}`);
    }
  },

  _applySearch(query) {
    const q = query.trim().toLowerCase();
    document.querySelectorAll('.board-card').forEach((card) => {
      const text = card.textContent.toLowerCase();
      card.style.display = (!q || text.includes(q)) ? '' : 'none';
    });
  },

  async _refresh() {
    const cols = document.querySelector('.board-columns');
    if (cols) {
      await this._loadAndRender(cols);
      // Re-render drawer if open
      if (this._state.activeDrawerId) {
        await this._openDrawer(this._state.activeDrawerId);
      }
    }
  },

  // ── live polling ────────────────────────────────────────────
  _startPolling() {
    this._stopPolling();
    this._state._reconcileTicks = 0;
    this._state.pollHandle = setInterval(async () => {
      try {
        const url = `/api/board/events?since=${this._state.pollSince}&limit=50`;
        const r = await API.get(url);
        let refreshed = false;
        if (r.count > 0) {
          this._state.pollSince = r.last_id;
          // If any event indicates a state change, refresh
          const refresher = ['created', 'completed', 'blocked', 'unblocked', 'reclaimed',
                            'promoted', 'spawned', 'crashed', 'timed_out', 'archived',
                            'edited', 'commented', 'linked', 'unlinked',
                            'approval_requested', 'approval_granted', 'approval_denied',
                            'skill_fabrication_suspected', 'status_changed'];
          if (r.events.some(e => refresher.includes(e.kind))) {
            this._refresh();
            refreshed = true;
          }
        }
        // Safety reconcile: some completions don't emit a refresher event (the
        // worker/gateway set status='done' without a `completed` event), so the
        // card would stay in the wrong column until a manual reload. Force a full
        // re-fetch from the DB every ~30s so the board always converges to truth
        // regardless of missed events — skipped while the user is interacting.
        this._state._reconcileTicks = refreshed ? 0 : (this._state._reconcileTicks + 1);
        if (this._state._reconcileTicks >= 10 && !this._isUserInteracting()) {
          this._state._reconcileTicks = 0;
          this._refresh();
        }
      } catch {
        /* swallow; next tick retries */
      }
    }, 3000);
  },

  /** Skip the periodic background reconcile while the user is mid-interaction
   *  (dragging a card, drawer open, or typing in a composer) so it doesn't blow
   *  away in-flight state. Event-driven refreshes still fire. */
  _isUserInteracting() {
    if (document.querySelector('.board-card.dragging')) return true;
    if (document.querySelector('.board-drawer.open, #board-drawer.open, .board-drawer[data-open="1"]')) return true;
    const ae = document.activeElement;
    if (ae && (ae.classList.contains('board-composer-input') || ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) return true;
    return false;
  },

  _stopPolling() {
    if (this._state.pollHandle) {
      clearInterval(this._state.pollHandle);
      this._state.pollHandle = null;
    }
  },

  // ── Cmd+K quick-create ──────────────────────────────────────
  _installQuickCreate() {
    if (this._quickCreateInstalled) return;
    this._quickCreateInstalled = true;
    this._onQuickCreateKeydown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        if (location.hash.startsWith('#/board')) {
          e.preventDefault();
          const title = prompt('New task title:');
          if (title?.trim()) {
            this._createTask(title.trim(), 'ready');
          }
        }
      }
    };
    window.addEventListener('keydown', this._onQuickCreateKeydown);
    if (window.ViewLifecycle) window.ViewLifecycle.onCleanup(() => this.destroy());
  },

  // ── Board Planner (the `plan` column) ───────────────────────
  /** Open the planning drawer (lazily builds its DOM once). */
  _openPlanDrawer() {
    // Hide the task-detail drawer if open — they share the body flex row.
    const task = document.getElementById('board-drawer');
    if (task) { task.style.display = 'none'; this._state.activeDrawerId = null; }
    const d = document.getElementById('board-plan-drawer');
    if (!d) return;
    d.style.display = 'flex';
    if (!d.dataset.ready) {
      d.innerHTML = `
        <div class="board-drawer-header">
          <span class="board-drawer-title">🧭 Plan</span>
          <span style="flex:1"></span>
          <button class="btn" id="board-plan-new" title="Start a fresh plan (clears the current draft)">＋ New plan</button>
          <button class="board-drawer-close" id="board-plan-close" aria-label="Close planner">×</button>
        </div>
        <div class="board-plan-intro">Describe a goal. Vodou researches your connected tools, skills &amp; the web,
          runs a deep-think loop, then drafts an ordered plan you can refine and drop into the board.</div>
        <div class="board-plan-log" id="board-plan-log" aria-live="polite"></div>
        <div class="board-plan-draft" id="board-plan-draft"></div>
        <form class="board-plan-composer" id="board-plan-form">
          <div class="board-plan-project-row">
            <label for="board-plan-project">Plan against:</label>
            <select id="board-plan-project" title="Point the planner at a codebase so it reads the real files">
              <option value="">General — sandboxed (no files)</option>
              <option value="__custom__">Custom folder…</option>
            </select>
          </div>
          <input id="board-plan-project-dir" type="text" style="display:none"
            placeholder="/absolute/path/to/any/folder — type, paste, or drop a folder here"
            title="Any directory on your machine (not limited to Vodou projects)" />
          <div class="board-plan-send-row">
            <textarea id="board-plan-input" rows="2"
              placeholder="e.g. build a CRM sync that posts a nightly summary to Slack"></textarea>
            <button type="submit" class="btn btn-primary" id="board-plan-send">Plan ↵</button>
          </div>
        </form>`;
      d.dataset.ready = '1';
      this._populatePlanProjects();
      d.querySelector('#board-plan-close').addEventListener('click', () => this._closePlanDrawer());
      d.querySelector('#board-plan-new').addEventListener('click', () => this._newPlan());
      d.querySelector('#board-plan-form').addEventListener('submit', (e) => {
        e.preventDefault();
        this._submitPlanPrompt();
      });
      d.querySelector('#board-plan-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._submitPlanPrompt(); }
      });
      // Drag-and-drop files → insert their paths. A Finder drag carries the full
      // path in `text/uri-list` as file:// URIs (browsers hide it on File.name);
      // Electron also exposes File.path. Decode either and insert at the cursor.
      const planInput = d.querySelector('#board-plan-input');
      const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
      planInput.addEventListener('dragover', (e) => { stop(e); e.dataTransfer.dropEffect = 'copy'; planInput.classList.add('board-plan-dragover'); });
      planInput.addEventListener('dragleave', () => planInput.classList.remove('board-plan-dragover'));
      planInput.addEventListener('drop', (e) => {
        stop(e);
        planInput.classList.remove('board-plan-dragover');
        const paths = [];
        const uriList = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '';
        uriList.split(/\r?\n/).forEach((raw) => {
          const line = raw.trim();
          if (!line || line.startsWith('#')) return;
          if (line.startsWith('file://')) {
            try { paths.push(decodeURIComponent(new URL(line).pathname)); } catch (_) { paths.push(line); }
          } else { paths.push(line); }
        });
        if (!paths.length && e.dataTransfer.files) {
          for (const f of e.dataTransfer.files) paths.push(f.path || f.name); // Electron path, else basename
        }
        if (!paths.length) return;
        const insert = paths.join(' ');
        const val = planInput.value;
        const start = planInput.selectionStart ?? val.length;
        const end = planInput.selectionEnd ?? val.length;
        const before = val.slice(0, start);
        const sep = before && !/\s$/.test(before) ? ' ' : '';
        planInput.value = before + sep + insert + ' ' + val.slice(end);
        planInput.focus();
        const caret = (before + sep + insert + ' ').length;
        planInput.setSelectionRange(caret, caret);
      });

      // "Custom folder…" → reveal a free-form path input (any dir on the
      // machine, not just registered Vodou projects).
      const projSel = d.querySelector('#board-plan-project');
      const dirInput = d.querySelector('#board-plan-project-dir');
      projSel.addEventListener('change', () => {
        const custom = projSel.value === '__custom__';
        dirInput.style.display = custom ? '' : 'none';
        if (custom) dirInput.focus();
      });
      // Drop a folder onto the path input to fill its full path (file:// URI).
      dirInput.addEventListener('dragover', (e) => { stop(e); e.dataTransfer.dropEffect = 'copy'; dirInput.classList.add('board-plan-dragover'); });
      dirInput.addEventListener('dragleave', () => dirInput.classList.remove('board-plan-dragover'));
      dirInput.addEventListener('drop', (e) => {
        stop(e);
        dirInput.classList.remove('board-plan-dragover');
        const uriList = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '';
        const first = uriList.split(/\r?\n/).map((s) => s.trim()).find((s) => s && !s.startsWith('#'));
        if (first && first.startsWith('file://')) {
          try { dirInput.value = decodeURIComponent(new URL(first).pathname); } catch (_) { dirInput.value = first; }
        } else if (e.dataTransfer.files && e.dataTransfer.files[0]) {
          dirInput.value = e.dataTransfer.files[0].path || e.dataTransfer.files[0].name;
        } else if (first) { dirInput.value = first; }
      });
    }
    setTimeout(() => { const i = document.getElementById('board-plan-input'); if (i) i.focus(); }, 0);
  },

  /** Fill the "Plan against:" dropdown with registered projects so the planner
   *  can read a real codebase (project-scoped planning). Best-effort. */
  async _populatePlanProjects() {
    const sel = document.getElementById('board-plan-project');
    if (!sel) return;
    try {
      const r = await API.get('/api/projects');
      const projects = (r && r.projects) || [];
      const prev = sel.value;
      for (const p of projects) {
        if (p.id === 'proj_default') continue; // "Default" has no real codebase to read
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name + (p.rootPath ? ` (${p.rootPath.replace(/^.*\//, '')})` : '');
        sel.appendChild(opt);
      }
      if (prev) sel.value = prev;
    } catch (_) { /* projects unavailable — dropdown just shows "General" */ }
  },

  /** Reset the planner to a clean slate — a NEW plan, not a refine of the last
   *  one. Fixes "typed a fresh goal, clicked Plan, nothing happened": a stuck
   *  or done session no longer blocks or silently refines. */
  _newPlan() {
    if (this._state.planStream) { try { this._state.planStream.abort(); } catch { /* noop */ } this._state.planStream = null; }
    if (this._state.planPollHandle) { clearTimeout(this._state.planPollHandle); this._state.planPollHandle = null; }
    this._state.planSessionId = null;
    this._state.planDraft = null;
    try { localStorage.removeItem('vodou_board_plan_session'); } catch (_) { /* noop */ }
    const log = document.getElementById('board-plan-log'); if (log) log.innerHTML = '';
    const draft = document.getElementById('board-plan-draft'); if (draft) draft.innerHTML = '';
    const sendBtn = document.getElementById('board-plan-send'); if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Plan ↵'; }
    const input = document.getElementById('board-plan-input'); if (input) input.focus();
  },

  _closePlanDrawer() {
    if (this._state.planStream) {
      try { this._state.planStream.abort(); } catch { /* noop */ }
      this._state.planStream = null;
    }
    if (this._state.planPollHandle) { clearTimeout(this._state.planPollHandle); this._state.planPollHandle = null; }
    // Explicit close (X or after commit) = done with this plan → stop re-attaching.
    try { localStorage.removeItem('vodou_board_plan_session'); } catch (_) { /* noop */ }
    this._state.planSessionId = null;
    const d = document.getElementById('board-plan-drawer');
    if (d) d.style.display = 'none';
  },

  /** Issue #3 — on returning to the board, re-attach to a plan that kept running
   *  server-side while we were away. Replays the buffered run (log + draft) via
   *  /plan/:id/status and keeps polling until it's no longer 'running'. */
  async _reattachPlan() {
    let sid = null;
    try { sid = localStorage.getItem('vodou_board_plan_session'); } catch (_) { sid = null; }
    if (!sid) return;
    const clear = () => { try { localStorage.removeItem('vodou_board_plan_session'); } catch (_) { /* noop */ } };
    // Check status FIRST — never pop the drawer claiming "reattaching to your
    // running plan" for a run that already finished, errored, or is gone.
    let r;
    try {
      const resp = await fetch(`/api/board/plan/${encodeURIComponent(sid)}/status`, { headers: { 'Content-Type': 'application/json' } });
      if (!resp.ok) { clear(); return; } // 404 (server restarted) / any error → drop it
      r = await resp.json();
    } catch (_) { return; } // transient network — leave the session, try again next visit
    if (r.status === 'error') { clear(); return; } // failed run → nothing to restore
    this._state.planSessionId = sid;
    this._openPlanDrawer();
    const running = r.status === 'running';
    const status = this._planLog(running ? '⟳ reattaching to your running plan…' : '↩ restored your plan', 'board-plan-status');
    const draftEl = document.getElementById('board-plan-draft');
    let seen = 0;
    const apply = (data) => {
      const events = Array.isArray(data.events) ? data.events : [];
      for (let i = seen; i < events.length; i++) this._onPlanEvent(events[i], status, draftEl);
      seen = events.length;
    };
    apply(r);
    if (!running) return; // done — draft is on screen, ready to commit; no polling
    const poll = async () => {
      try {
        const resp = await fetch(`/api/board/plan/${encodeURIComponent(sid)}/status`, { headers: { 'Content-Type': 'application/json' } });
        if (resp.status === 404) { clear(); return; }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const d = await resp.json();
        apply(d);
        this._state.planPollHandle = d.status === 'running' ? setTimeout(poll, 2000) : null;
      } catch (_) {
        this._state.planPollHandle = setTimeout(poll, 4000); // transient — retry slower
      }
    };
    this._state.planPollHandle = setTimeout(poll, 2000);
  },

  /** Append a line to the streaming log; returns it so callers can mutate it. */
  _planLog(html, cls) {
    const log = document.getElementById('board-plan-log');
    if (!log) return null;
    const line = document.createElement('div');
    line.className = 'board-plan-line' + (cls ? ' ' + cls : '');
    line.innerHTML = html;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
    return line;
  },

  async _submitPlanPrompt() {
    if (this._state.planStream) return; // a plan is already streaming
    const input = document.getElementById('board-plan-input');
    const prompt = (input && input.value || '').trim();
    if (!prompt) return;
    input.value = '';
    this._planLog(`<span class="board-plan-you">You:</span> ${this._esc(prompt)}`, 'board-plan-user');
    await this._runPlannerStream(prompt);
  },

  /** POST the prompt and consume the SSE plan stream (fetch-stream, so we can
   *  send a body + abort on teardown — EventSource can't do either). */
  async _runPlannerStream(prompt) {
    const sendBtn = document.getElementById('board-plan-send');
    const draftEl = document.getElementById('board-plan-draft');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = 'Planning…'; }
    const ac = new AbortController();
    this._state.planStream = ac;
    const status = this._planLog('⟳ starting…', 'board-plan-status');
    try {
      const projSel = document.getElementById('board-plan-project');
      const selVal = projSel ? projSel.value : '';
      const custom = selVal === '__custom__';
      const projectId = custom ? '' : selVal;
      const projectDir = custom ? (document.getElementById('board-plan-project-dir')?.value || '').trim() : '';
      const resp = await fetch('/api/board/plan/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          planSessionId: this._state.planSessionId,
          project_id: projectId || undefined,
          project_dir: projectDir || undefined,
        }),
        signal: ac.signal,
      });
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          let evt;
          try { evt = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
          this._onPlanEvent(evt, status, draftEl);
        }
      }
    } catch (e) {
      if (!ac.signal.aborted && status) {
        status.className = 'board-plan-line board-plan-err';
        status.textContent = `⚠ ${e.message || e}`;
      }
    } finally {
      this._state.planStream = null;
      if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Plan ↵'; }
    }
  },

  _onPlanEvent(evt, status, draftEl) {
    switch (evt.phase) {
      case 'session':
        this._state.planSessionId = evt.planSessionId;
        // Persist so navigating away + back can re-attach (issue #3). The run
        // keeps going server-side; on return we replay via /plan/:id/status.
        try { localStorage.setItem('vodou_board_plan_session', evt.planSessionId); } catch (_) { /* noop */ }
        break;
      case 'reattached':
        break;
      case 'enumerate':
        if (status) { status.className = 'board-plan-line board-plan-status'; status.innerHTML = `⟳ ${this._esc(evt.note)}`; }
        break;
      case 'research':
      case 'note':
      case 'synthesize':
        this._planLog(`⟳ ${this._esc(evt.note)}`, 'board-plan-status');
        break;
      case 'think':
        this._planLog(`⟳ deep-think ${evt.step}/${evt.total}`, 'board-plan-status');
        break;
      case 'draft':
        this._renderDraft(evt.draft, draftEl);
        break;
      case 'done':
        this._planLog(`✓ ${evt.taskCount} task(s) ready — review &amp; commit`, 'board-plan-done');
        break;
      case 'error':
        this._planLog(`⚠ ${this._esc(evt.note)}`, 'board-plan-err');
        // A failed run has nothing to review — don't re-attach to it on return.
        try { localStorage.removeItem('vodou_board_plan_session'); } catch (_) { /* noop */ }
        break;
    }
  },

  _renderDraft(draft, draftEl) {
    this._state.planDraft = draft;
    draftEl = draftEl || document.getElementById('board-plan-draft');
    if (!draftEl || !draft) return;
    const tasks = Array.isArray(draft.tasks) ? draft.tasks : [];
    const items = tasks.map((t, i) => {
      const dep = i > 0 ? `<span class="board-plan-dep">needs #${i}</span>` : '';
      const skills = Array.isArray(t.skills) && t.skills.length
        ? `<div class="board-plan-skills">${t.skills.map((s) => `<span class="board-chip">${this._esc(s)}</span>`).join(' ')}</div>` : '';
      const bodyTxt = t.body ? `<div class="board-plan-task-body">${this._esc(String(t.body).slice(0, 240))}</div>` : '';
      return `<li class="board-plan-task">
        <div class="board-plan-task-head">
          <span class="board-plan-num">${i + 1}</span>
          <span class="board-plan-task-title">${this._esc(t.title)}</span>${dep}
        </div>${bodyTxt}${skills}
      </li>`;
    }).join('');
    draftEl.innerHTML = `
      ${draft.summary ? `<div class="board-plan-summary">${this._esc(draft.summary)}</div>` : ''}
      <ol class="board-plan-tasks">${items}</ol>
      <div class="board-plan-commit-row">
        <button class="btn btn-primary" id="board-plan-commit">Commit ${tasks.length} task${tasks.length === 1 ? '' : 's'} to board</button>
        ${draft.researched ? '<span class="board-plan-badge">🔎 web-researched</span>' : ''}
      </div>`;
    const btn = draftEl.querySelector('#board-plan-commit');
    if (btn) btn.addEventListener('click', () => this._commitPlan());
  },

  async _commitPlan() {
    const btn = document.getElementById('board-plan-commit');
    if (btn) { btn.disabled = true; btn.textContent = 'Committing…'; }
    try {
      const r = await API.post('/api/board/plan/commit', { planSessionId: this._state.planSessionId });
      this._state.planDraft = null;
      this._state.planSessionId = null;
      this._closePlanDrawer();
      await this._refresh();
      const sum = document.getElementById('board-summary');
      if (sum) sum.textContent = `✓ ${r.count ?? 0} planned task${(r.count ?? 0) === 1 ? '' : 's'} added`;
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Commit to board'; }
      alert(`Commit failed: ${e.message ?? e}`);
    }
  },

  // ── lifecycle teardown ──────────────────────────────────────
  /** Called by the router on route change: stop the 3s poll loop and remove
   *  the window-level Cmd+K listener so nothing fires while off the board. */
  destroy() {
    this._stopPolling();
    // Issue #3 — leaving the board no longer kills a running plan. Abort only
    // the CLIENT's SSE reader (the server run is decoupled now and finishes on
    // its own) and stop our re-attach poller. We deliberately do NOT clear the
    // localStorage session, so returning to the board re-attaches to it.
    if (this._state.planStream) {
      try { this._state.planStream.abort(); } catch { /* noop */ }
      this._state.planStream = null;
    }
    if (this._state.planPollHandle) { clearTimeout(this._state.planPollHandle); this._state.planPollHandle = null; }
    if (this._onQuickCreateKeydown) {
      window.removeEventListener('keydown', this._onQuickCreateKeydown);
      this._onQuickCreateKeydown = null;
    }
    this._quickCreateInstalled = false;
  },

  // ── helpers ─────────────────────────────────────────────────
  // Shared escaper — safe.js loads first, so VodouSafe is always present.
  _esc(s) {
    return window.VodouSafe.escapeHtml(s);
  },

  _priBucket(p) {
    if (p >= 80) return 'hi';
    if (p >= 50) return 'med';
    return 'lo';
  },

  _renderTime(ts) {
    if (!ts) return '—';
    try {
      const d = new Date(ts.replace(' ', 'T') + 'Z');
      return d.toLocaleString();
    } catch { return ts; }
  },

  _renderElapsed(start, end) {
    if (!start) return '';
    try {
      const s = new Date(start.replace(' ', 'T') + 'Z').getTime();
      const e = end ? new Date(end.replace(' ', 'T') + 'Z').getTime() : Date.now();
      const sec = Math.max(0, Math.round((e - s) / 1000));
      if (sec < 60) return `${sec}s`;
      if (sec < 3600) return `${Math.round(sec / 60)}m`;
      return `${Math.round(sec / 3600)}h`;
    } catch { return ''; }
  },
};

// Expose globally so the Board-chat back-link (chat.js `↗ card`) can open a
// task's drawer via window.BoardView._openDrawer(taskId).
if (typeof window !== 'undefined') window.BoardView = BoardView;
