/**
 * Scheduler View — table with add/toggle/remove
 */
function normalizeSchedulerTasks(raw) {
  if (Array.isArray(raw)) return raw;
  return raw?.tasks ?? [];
}

const SchedulerView = {
  /** Must match column count in _renderTable (9 cols). */
  _SCHEDULER_COL_COUNT: 9,
  _HISTORY_ROW_CLASS: 'scheduler-task-history-row',
  /** Bumps on each History open so stale in-flight fetches do not insert a second panel. */
  _historyOpenGen: 0,

  _closeAllSchedulerHistoryRows(tbody) {
    if (!tbody) return;
    tbody.querySelectorAll('tr.' + this._HISTORY_ROW_CLASS).forEach((el) => el.remove());
  },

  async render(container) {
    container.appendChild(Components.pageHeader('Scheduled', 'Manage scheduled tasks'));
    container.appendChild(Components.loading());

    try {
      // Fetch tasks + projects together so we can scope user tasks per project.
      const [tasks, projectsResp] = await Promise.all([
        API.get('/api/scheduler').then(normalizeSchedulerTasks),
        API.get('/api/projects').catch(() => ({ projects: [] })),
      ]);
      this._projects = projectsResp.projects || [];
      container.innerHTML = '';

      const enabledCount = tasks.filter(t => t.enabled).length;
      const schedHeader = Components.pageHeader(
        'Scheduled',
        `${enabledCount} enabled / ${tasks.length} total`
      );
      schedHeader.querySelector('.page-title').appendChild(
        Components.helpTip('Automated tasks that run on a timer \u2014 backups, health checks, or any command you want to repeat.')
      );
      container.appendChild(schedHeader);

      // Add button + project scope filter
      const addBar = document.createElement('div');
      addBar.className = 'scheduler-add-bar';
      const addBtn = document.createElement('button');
      addBtn.className = 'btn';
      addBtn.textContent = '+ Add Task';
      addBtn.addEventListener('click', () => this._showAddForm());
      addBar.appendChild(addBtn);
      addBar.appendChild(this._scopeBar());
      container.appendChild(addBar);

      // Table
      const tableWrap = document.createElement('div');
      tableWrap.id = 'scheduler-table-wrap';
      container.appendChild(tableWrap);

      this._renderScoped(tableWrap, tasks);

    } catch (err) {
      container.innerHTML = '';
      container.appendChild(Components.errorState('Failed to load scheduler: ' + err.message));
    }
  },

  _renderTable(wrap, tasks) {
    wrap.innerHTML = '';

    if (tasks.length === 0) {
      const emptyEl = Components.emptyState('No scheduled tasks yet.');
      const addBtn = document.createElement('button');
      addBtn.className = 'btn btn-primary empty-state-action';
      addBtn.textContent = 'Create your first automated task';
      addBtn.classList.add('scheduler-empty-action');
      addBtn.addEventListener('click', () => this._showAddForm());
      emptyEl.appendChild(document.createElement('br'));
      emptyEl.appendChild(addBtn);
      wrap.appendChild(emptyEl);
      return;
    }

    const table = Components.table(
      [
        { label: '', width: '32px', render: (t) => Components.statusDot(!!t.enabled) },
        { label: 'Name', render: (t) => {
          const span = document.createElement('span');
          span.className = 'font-600 text-primary-color';
          span.textContent = t.name;
          return span;
        }},
        { label: 'Schedule', render: (t) => {
          const span = document.createElement('span');
          // An unscheduled skill console has no schedule to print, and a blank
          // cell reads as "loading" or "unknown". Say the actual consequence:
          // this thing exists and will never fire on its own.
          if (t.unscheduled) {
            span.className = 'text-sm scheduler-unscheduled';
            span.textContent = 'No schedule — won’t run on its own';
            span.title = 'Created without a schedule. Open its tab to run it by hand, or recreate it with a schedule to automate it.';
            return span;
          }
          span.className = 'font-mono text-sm text-primary-color';
          span.textContent = t.schedule;
          return span;
        }},
        { label: 'Type', width: '90px', render: (t) => {
          if (t.unscheduled) return Components.badge('manual', 'muted');
          return Components.badge(t.schedule_type, 'default');
        }},
        { label: 'Enabled', width: '70px', render: (t) => {
          // Unscheduled consoles have id === null on purpose — every row action
          // addresses /api/scheduler/:id, so offering a control that would fire
          // at `/api/scheduler/null/toggle` is worse than offering nothing.
          if (t.unscheduled) {
            const dash = document.createElement('span');
            dash.className = 'text-muted-color';
            dash.textContent = '—';
            dash.title = 'Nothing to enable — this has no schedule.';
            return dash;
          }
          return Components.toggle(!!t.enabled, async (checked) => {
            try {
              await API.post(`/api/scheduler/${t.id}/toggle`);
              t.enabled = checked ? 1 : 0;
              Components.toast(`${t.name} ${checked ? 'enabled' : 'disabled'}`, 'success');
            } catch (e) {
              Components.toast('Toggle failed: ' + e.message, 'error');
            }
          });
        }},
        { label: 'Payload', render: (t) => {
          const span = document.createElement('span');
          span.className = 'font-mono text-sm text-muted-color';
          span.textContent = (t.payload || '').substring(0, 60) + ((t.payload || '').length > 60 ? '...' : '');
          span.title = t.payload || '';
          return span;
        }},
        { label: 'Last Run', width: '140px', render: (t) => {
          const span = document.createElement('span');
          span.className = 'secondary-text text-sm';
          span.textContent = t.last_run_at ? this._formatTime(t.last_run_at) : 'never';
          return span;
        }},
        { label: 'Next Run', width: '140px', render: (t) => {
          const span = document.createElement('span');
          span.className = 'secondary-text text-sm';
          span.textContent = t.next_run_at ? this._formatTime(t.next_run_at) : '—';
          return span;
        }},
        { label: '', width: '170px', render: (t) => {
          const wrap = document.createElement('div');
          wrap.className = 'flex-center gap-2';

          // Read-only row: no id means Run/History/Delete have nothing to
          // address. Offer the one thing that IS actionable — open its tab.
          if (t.unscheduled) {
            const openBtn = document.createElement('button');
            openBtn.className = 'task-history-toggle';
            openBtn.textContent = 'Open tab';
            openBtn.title = 'Open this skill’s console tab and run it by hand';
            openBtn.disabled = !t.conversation_id;
            openBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              if (t.conversation_id) location.hash = '#/chat';
            });
            wrap.appendChild(openBtn);
            return wrap;
          }

          const runBtn = document.createElement('button');
          runBtn.className = 'task-history-toggle';
          runBtn.textContent = 'Run';
          runBtn.title = t.enabled ? 'Queue this task to run now' : 'Enable task first';
          if (!t.enabled) runBtn.disabled = true;
          runBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!t.enabled) {
              Components.toast(`"${t.name}" is disabled. Enable it first.`, 'error');
              return;
            }
            runBtn.disabled = true;
            const prev = runBtn.textContent;
            runBtn.textContent = 'Queued...';
            try {
              await API.post(`/api/scheduler/${t.id}/run`);
              Components.toast(`"${t.name}" queued to run now`, 'success');
              await this._refreshTable();
            } catch (err) {
              Components.toast('Run now failed: ' + err.message, 'error');
              runBtn.disabled = false;
              runBtn.textContent = prev;
            }
          });
          wrap.appendChild(runBtn);

          const histBtn = document.createElement('button');
          histBtn.className = 'task-history-toggle';
          histBtn.textContent = 'History';
          histBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            this._showTaskHistory(t, histBtn);
          });
          wrap.appendChild(histBtn);

          // Move-to-project (P2) — user tasks only, when projects exist.
          if (!t.is_system && (this._projects || []).length > 0) {
            const sel = document.createElement('select');
            sel.className = 'scheduler-project-select';
            sel.title = 'Move this task to a project';
            const opts = [{ id: 'proj_default', name: 'Default' }]
              .concat(this._projects.filter((p) => p.id !== 'proj_default'));
            for (const p of opts) {
              const o = document.createElement('option');
              o.value = p.id;
              o.textContent = p.name;
              if ((t.project_id || 'proj_default') === p.id) o.selected = true;
              sel.appendChild(o);
            }
            sel.addEventListener('click', (e) => e.stopPropagation());
            sel.addEventListener('change', async (e) => {
              e.stopPropagation();
              try {
                await API.put(`/api/scheduler/${t.id}/project`, { project_id: sel.value });
                t.project_id = sel.value;
                Components.toast(`Moved "${t.name}" to ${this._projectName(sel.value)}`, 'success');
                this._refreshTable();
              } catch (err) {
                Components.toast('Move failed: ' + err.message, 'error');
              }
            });
            wrap.appendChild(sel);
          }

          const delBtn = document.createElement('button');
          delBtn.className = 'btn btn-sm';
          delBtn.textContent = '\u2715';
          delBtn.classList.add('scheduler-del-btn');
          delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const ok = await Components.confirmModal(
              `Remove "${t.name}" from the schedule? This cannot be undone.`,
              { title: 'Delete scheduled task', confirmLabel: 'Delete', danger: true }
            );
            if (ok) {
              try {
                await API.del(`/api/scheduler/${t.id}`);
                Components.toast(`"${t.name}" deleted`, 'success');
                if (window.refreshSidebarCounts) window.refreshSidebarCounts();
                this._refreshTable();
              } catch (err) {
                Components.toast('Delete failed: ' + err.message, 'error');
              }
            }
          });
          wrap.appendChild(delBtn);

          return wrap;
        }},
      ],
      tasks
    );
    wrap.appendChild(table);
  },

  // ───────── per-project scoping (PLAN-PROJECT-SCOPED-DOCK Phase 2) ─────────
  _projects: [],
  // PLAN-UNIFIED-PROJECT-SCOPE P4 — this was the FOURTH private copy of the same
  // question, which is the exact thing that plan exists to eliminate. It now reads
  // through ProjectScope, so the dock's "Show all projects" and the Scheduler's
  // agree by construction instead of by coincidence. The local field survives only
  // as a fallback for when the module fails to load.
  _showAllProjectsFallback: false,
  get _showAllProjects() {
    return (window.ProjectScope && window.ProjectScope.showAll()) || this._showAllProjectsFallback;
  },
  set _showAllProjects(v) {
    if (window.ProjectScope) { window.ProjectScope.setShowAll(!!v); return; }
    this._showAllProjectsFallback = !!v;
  },

  // PLAN-UNIFIED-PROJECT-SCOPE §2.6 — delegate; ProjectScope is the sole reader.
  _activeProjectId() {
    return (window.ProjectScope && window.ProjectScope.active())
      || localStorage.getItem('vodou.activeProject') || 'proj_default';
  },
  _projectName(id) {
    if (!id || id === 'proj_default') return 'Default';
    const p = (this._projects || []).find((x) => x.id === id);
    return p ? p.name : id;
  },
  _projectColor(id) {
    if (!id || id === 'proj_default') return '#6b7280';
    const p = (this._projects || []).find((x) => x.id === id);
    return p ? (p.color || '#6b7280') : '#6b7280';
  },

  /** "Showing: <project> ▾  [ ] All projects" filter control. */
  _scopeBar() {
    const bar = document.createElement('div');
    bar.className = 'scheduler-scope-bar';
    const active = this._activeProjectId();
    const chip = document.createElement('span');
    chip.className = 'project-chip';
    chip.style.background = this._projectColor(active);
    const label = document.createElement('span');
    label.className = 'scheduler-scope-label';
    label.textContent = this._showAllProjects ? 'All projects' : this._projectName(active);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'task-history-toggle';
    toggle.textContent = this._showAllProjects ? 'Show active project' : 'Show all projects';
    toggle.addEventListener('click', () => {
      this._showAllProjects = !this._showAllProjects;
      this.render(document.getElementById('main-content'));
    });
    bar.append(document.createTextNode('Showing: '), chip, label, toggle);
    return bar;
  },

  /** Split system vs user tasks, filter user tasks by the active project, and
   *  render two sections (project tasks + an always-visible System group). */
  _renderScoped(wrap, allTasks) {
    wrap.innerHTML = '';
    const systemTasks = allTasks.filter((t) => t.is_system);
    let userTasks = allTasks.filter((t) => !t.is_system);
    if (!this._showAllProjects) {
      const active = this._activeProjectId();
      userTasks = userTasks.filter((t) => (t.project_id || 'proj_default') === active);
    }

    const userWrap = document.createElement('div');
    if (userTasks.length === 0) {
      const note = this._showAllProjects
        ? 'No user tasks yet.'
        : `No tasks in ${this._projectName(this._activeProjectId())} yet. New tasks you create here are scoped to this project.`;
      userWrap.appendChild(Components.emptyState(note));
    } else {
      this._renderTable(userWrap, userTasks);
    }
    wrap.appendChild(userWrap);

    if (systemTasks.length > 0) {
      const details = document.createElement('details');
      details.className = 'scheduler-system-group';
      const summary = document.createElement('summary');
      summary.textContent = `System (${systemTasks.length}) — shared brain maintenance, not project-scoped`;
      details.appendChild(summary);
      const sysWrap = document.createElement('div');
      this._renderTable(sysWrap, systemTasks);
      details.appendChild(sysWrap);
      wrap.appendChild(details);
    }
  },

  _formatTime(ts) {
    if (!ts) return '—';
    try {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return ts;
      const now = new Date();
      const diff = now - d;
      if (diff > 0 && diff < 86400000) {
        const mins = Math.floor(diff / 60000);
        if (mins < 60) return `${mins}m ago`;
        return `${Math.floor(mins / 60)}h ago`;
      }
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return ts;
    }
  },

  async _refreshTable() {
    try {
      const tasks = normalizeSchedulerTasks(await API.get('/api/scheduler'));
      const wrap = document.getElementById('scheduler-table-wrap');
      if (wrap) this._renderScoped(wrap, tasks);
    } catch (err) {
      Components.toast('Refresh failed: ' + err.message, 'error');
    }
  },

  async _showTaskHistory(task, toggleBtn) {
    const dataRow = toggleBtn.closest('tr');
    if (!dataRow || !dataRow.parentElement) return;

    // Close if this row already has an open history panel (next sibling tr)
    const next = dataRow.nextElementSibling;
    if (next && next.classList.contains(this._HISTORY_ROW_CLASS)) {
      next.remove();
      return;
    }

    const tbody = dataRow.parentElement;
    this._historyOpenGen += 1;
    const gen = this._historyOpenGen;
    this._closeAllSchedulerHistoryRows(tbody);

    try {
      const data = await API.get(`/api/scheduler/${task.id}/history`);
      if (gen !== this._historyOpenGen) return;
      if (!document.contains(dataRow)) return;
      this._closeAllSchedulerHistoryRows(tbody);
      const section = document.createElement('div');
      section.className = 'task-history-section';

      // Task meta info
      const meta = document.createElement('div');
      meta.className = 'task-history-meta';
      const parts = [];
      if (data.last_run_at) parts.push(`Last run: ${this._formatTime(data.last_run_at)}`);
      if (data.next_run_at) parts.push(`Next: ${this._formatTime(data.next_run_at)}`);
      if (data.history) parts.push(`${data.history.length} log entries`);
      meta.textContent = parts.join(' \u2022 ');
      section.appendChild(meta);

      // History entries
      if (data.history && data.history.length > 0) {
        const entries = document.createElement('div');
        entries.className = 'task-history-entries';
        for (const entry of data.history.slice(0, 5)) {
          const line = document.createElement('div');
          line.className = 'task-history-entry';
          const dot = document.createElement('span');
          const status = (entry.metadata || '').includes('error') || (entry.message || '').includes('fail') ? 'error' : 'success';
          dot.className = 'task-history-dot ' + status;
          line.appendChild(dot);
          const ts = document.createElement('span');
          ts.className = 'task-history-ts';
          ts.textContent = this._formatTime(entry.timestamp);
          line.appendChild(ts);
          const msg = document.createElement('span');
          msg.className = 'task-history-msg';
          msg.textContent = (entry.message || '').substring(0, 120);
          msg.title = entry.message || '';
          line.appendChild(msg);
          entries.appendChild(line);
        }
        section.appendChild(entries);
      } else {
        const noHistory = document.createElement('div');
        noHistory.className = 'task-history-empty';
        noHistory.textContent = 'No execution history found';
        section.appendChild(noHistory);
      }

      const historyRow = document.createElement('tr');
      historyRow.className = this._HISTORY_ROW_CLASS;
      const td = document.createElement('td');
      td.className = 'scheduler-history-cell';
      td.colSpan = this._SCHEDULER_COL_COUNT;
      td.appendChild(section);
      historyRow.appendChild(td);
      dataRow.insertAdjacentElement('afterend', historyRow);
    } catch (err) {
      Components.toast('Failed to load history: ' + err.message, 'error');
    }
  },

  _showAddForm() {
    const overlay = document.createElement('div');
    overlay.className = 'scheduler-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'scheduler-modal';

    const heading = document.createElement('h3');
    heading.className = 'scheduler-modal-title';
    heading.textContent = 'Add Scheduled Task';
    modal.appendChild(heading);

    const fields = [
      { name: 'name', label: 'Name', placeholder: 'e.g. daily-backup' },
      { name: 'schedule_preset', label: 'Schedule', type: 'select', options: ['Every hour', 'Every 4 hours', 'Daily at 9:00 AM', 'Daily at midnight', 'Weekly (Monday 9:00 AM)', 'Custom...'] },
      { name: 'schedule', label: 'Custom Schedule', placeholder: 'e.g. every 4h, at 09:00, 0 */6 * * *', hidden: true },
      { name: 'schedule_type', label: 'Type', type: 'select', options: ['every', 'cron', 'at', 'in'] },
      // payload_type options are fetched from /api/scheduler/types after the modal mounts
      { name: 'payload_type', label: 'Payload type', type: 'select', options: ['query'] },
      { name: 'payload', label: 'Payload', type: 'textarea', placeholder: "e.g. oi 'cpu memory'" },
    ];

    const presetMap = {
      'Every hour': { schedule: 'every 1h', type: 'every' },
      'Every 4 hours': { schedule: 'every 4h', type: 'every' },
      'Daily at 9:00 AM': { schedule: 'at 09:00', type: 'at' },
      'Daily at midnight': { schedule: 'at 00:00', type: 'at' },
      'Weekly (Monday 9:00 AM)': { schedule: '0 9 * * 1', type: 'cron' },
    };

    const inputs = {};
    for (const f of fields) {
      const group = document.createElement('div');
      group.className = 'scheduler-form-group';
      if (f.hidden) group.classList.add('is-hidden');
      group.dataset.field = f.name;

      const label = document.createElement('label');
      label.className = 'scheduler-form-label';
      label.textContent = f.label;
      group.appendChild(label);

      let input;
      if (f.type === 'select') {
        input = document.createElement('select');
        for (const opt of f.options) {
          const o = document.createElement('option');
          o.value = opt;
          o.textContent = opt;
          input.appendChild(o);
        }
      } else if (f.type === 'textarea') {
        input = document.createElement('textarea');
        input.rows = 3;
        input.placeholder = f.placeholder || '';
        input.style.fontFamily = "'SFMono-Regular', Menlo, monospace";
        input.style.fontSize = '12px';
        input.style.resize = 'vertical';
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.placeholder = f.placeholder || '';
      }
      input.className = 'scheduler-form-input';
      group.appendChild(input);
      inputs[f.name] = input;

      // Small hint line below the payload textarea — updated by payload_type
      if (f.name === 'payload') {
        const hint = document.createElement('div');
        hint.className = 'scheduler-form-hint';
        hint.style.cssText = 'font-size:11px;color:var(--text-muted);margin-top:4px;line-height:1.3;';
        group.appendChild(hint);
        inputs.payload_hint_el = hint;
      }

      modal.appendChild(group);
    }

    // mcp_tool builder — cascading pickers (integration → tool) + form
    // rendered from the tool's input_schema. Sits between the payload_type
    // dropdown and the raw payload textarea; hidden unless mcp_tool is
    // selected. When visible, the raw textarea becomes read-only preview.
    const builder = document.createElement('div');
    builder.className = 'scheduler-form-group mcp-tool-builder is-hidden';
    builder.dataset.field = 'mcp_tool_builder';
    builder.innerHTML = `
      <label class="scheduler-form-label">Integration</label>
      <select class="scheduler-form-input mcp-builder-integration">
        <option value="">Loading connected apps…</option>
      </select>
      <label class="scheduler-form-label" style="margin-top:8px;">Tool</label>
      <select class="scheduler-form-input mcp-builder-tool" disabled>
        <option value="">Pick an integration first</option>
      </select>
      <div class="mcp-builder-desc" style="font-size:11px;color:var(--text-muted);margin:4px 0 8px;line-height:1.3;"></div>
      <div class="mcp-builder-fields" style="display:flex;flex-direction:column;gap:6px;"></div>
      <label class="scheduler-form-label" style="margin-top:10px;">Notify webhook URL <span style="font-weight:400;color:var(--text-muted);font-size:10px;">(optional)</span></label>
      <input type="url" class="scheduler-form-input mcp-builder-notify" placeholder="https://hooks.slack.com/services/… or any incoming-webhook URL" />
      <div style="font-size:10px;color:var(--text-muted);margin-top:2px;line-height:1.3;">POSTs &#123;task, server, tool, success, outcome, result, text&#125; JSON to this URL after each run. Works with Slack / Discord / Zapier incoming webhooks.</div>
    `;
    // Insert the builder right after the payload_type group
    const payloadGroup = modal.querySelector('[data-field="payload"]');
    if (payloadGroup && payloadGroup.parentElement) {
      payloadGroup.parentElement.insertBefore(builder, payloadGroup);
    }
    const intSelect  = builder.querySelector('.mcp-builder-integration');
    const toolSelect = builder.querySelector('.mcp-builder-tool');
    const descEl     = builder.querySelector('.mcp-builder-desc');
    const fieldsEl   = builder.querySelector('.mcp-builder-fields');
    const notifyInput = builder.querySelector('.mcp-builder-notify');

    // Helper — render JSON-Schema into form fields; returns a `readValues()` fn
    function renderSchemaFields(schema, container) {
      container.innerHTML = '';
      if (!schema || schema.type !== 'object' || !schema.properties) {
        container.innerHTML = '<div style="font-size:11px;color:var(--text-muted);">No input parameters required.</div>';
        return () => ({});
      }
      const required = new Set(schema.required || []);
      const controls = {};
      for (const [key, def] of Object.entries(schema.properties)) {
        const wrap = document.createElement('div');
        const lab = document.createElement('label');
        lab.className = 'scheduler-form-label';
        lab.style.cssText = 'font-size:11px;';
        lab.textContent = key + (required.has(key) ? ' *' : '') + (def.type ? '  (' + (Array.isArray(def.type) ? def.type.join('|') : def.type) + ')' : '');
        wrap.appendChild(lab);

        let ctrl;
        const isJsonComposite = def.type === 'array' || def.type === 'object';
        if (def.enum && Array.isArray(def.enum)) {
          ctrl = document.createElement('select');
          if (!required.has(key)) {
            const blank = document.createElement('option');
            blank.value = '';
            blank.textContent = '(leave unset)';
            ctrl.appendChild(blank);
          }
          for (const v of def.enum) {
            const o = document.createElement('option');
            o.value = String(v);
            o.textContent = String(v);
            ctrl.appendChild(o);
          }
        } else if (def.type === 'boolean') {
          ctrl = document.createElement('select');
          for (const v of ['', 'true', 'false']) {
            const o = document.createElement('option');
            o.value = v;
            o.textContent = v || '(unset)';
            ctrl.appendChild(o);
          }
        } else if (def.type === 'number' || def.type === 'integer') {
          ctrl = document.createElement('input');
          ctrl.type = 'number';
          if (def.type === 'integer') ctrl.step = '1';
          if (def.default !== undefined) ctrl.placeholder = 'default: ' + def.default;
        } else if (isJsonComposite) {
          ctrl = document.createElement('textarea');
          ctrl.rows = 2;
          ctrl.style.fontFamily = "'SFMono-Regular', Menlo, monospace";
          ctrl.style.fontSize = '11px';
          ctrl.placeholder = def.type === 'array' ? '[]  (JSON)' : '{}  (JSON)';
        } else {
          ctrl = document.createElement('input');
          ctrl.type = 'text';
          if (def.default !== undefined) ctrl.placeholder = 'default: ' + def.default;
        }
        ctrl.className = 'scheduler-form-input';
        wrap.appendChild(ctrl);

        if (def.description) {
          const hint = document.createElement('div');
          hint.style.cssText = 'font-size:10px;color:var(--text-muted);margin-top:2px;line-height:1.3;';
          hint.textContent = def.description;
          wrap.appendChild(hint);
        }
        controls[key] = { ctrl, def };
        container.appendChild(wrap);
      }

      return () => {
        const out = {};
        for (const [key, { ctrl, def }] of Object.entries(controls)) {
          const raw = (ctrl.value ?? '').trim();
          if (raw === '') continue;
          if (def.type === 'boolean') { out[key] = raw === 'true'; continue; }
          if (def.type === 'number' || def.type === 'integer') {
            const n = Number(raw);
            if (Number.isFinite(n)) out[key] = n;
            continue;
          }
          if (def.type === 'array' || def.type === 'object') {
            try { out[key] = JSON.parse(raw); } catch { out[key] = raw; }
            continue;
          }
          out[key] = raw;
        }
        return out;
      };
    }

    let currentReadValues = () => ({});
    const serializeBuilder = () => {
      const server = intSelect.value;
      const tool = toolSelect.value;
      if (!server || !tool) return null;
      const payload = { server, tool, args: currentReadValues() };
      const notifyUrl = (notifyInput.value || '').trim();
      if (notifyUrl) payload.notify_on_result = notifyUrl;
      return payload;
    };
    const syncPayloadTextarea = () => {
      const payload = serializeBuilder();
      if (payload && inputs.payload) {
        inputs.payload.value = JSON.stringify(payload, null, 2);
      }
    };
    // Debounced sync whenever the user edits any builder field
    builder.addEventListener('input', () => syncPayloadTextarea(), true);
    builder.addEventListener('change', () => syncPayloadTextarea(), true);

    // Load connected apps lazily — only when mcp_tool first selected
    let appsLoaded = false;
    async function loadConnectedApps() {
      if (appsLoaded) return;
      appsLoaded = true;
      try {
        const data = await API.get('/api/oauth/status');
        const connected = (data.providers || []).filter(p => p.connected && !p.blocked);
        intSelect.innerHTML = '<option value="">— pick an integration —</option>';
        for (const p of connected) {
          const o = document.createElement('option');
          o.value = p.id;
          o.textContent = `${p.name} (${p.toolCount || 0} tools)`;
          intSelect.appendChild(o);
        }
      } catch (err) {
        console.warn('[scheduler] failed to load connected apps:', err);
        intSelect.innerHTML = '<option value="">(failed to load)</option>';
      }
    }

    intSelect.addEventListener('change', async () => {
      const id = intSelect.value;
      toolSelect.innerHTML = '<option value="">Loading…</option>';
      toolSelect.disabled = true;
      descEl.textContent = '';
      fieldsEl.innerHTML = '';
      currentReadValues = () => ({});
      if (!id) { toolSelect.innerHTML = '<option value="">Pick an integration first</option>'; return; }
      try {
        const data = await API.get(`/api/tools?server=${encodeURIComponent(id)}`);
        const tools = data.tools || [];
        toolSelect.innerHTML = '<option value="">— pick a tool —</option>';
        for (const t of tools) {
          const o = document.createElement('option');
          o.value = t.name;
          o.textContent = t.name;
          o.dataset.description = t.description || '';
          o.dataset.schema = t.input_schema ? JSON.stringify(t.input_schema) : '';
          toolSelect.appendChild(o);
        }
        toolSelect.disabled = tools.length === 0;
      } catch (err) {
        console.warn('[scheduler] failed to load tools for', id, err);
        toolSelect.innerHTML = '<option value="">(failed to load)</option>';
      }
    });

    toolSelect.addEventListener('change', () => {
      const opt = toolSelect.options[toolSelect.selectedIndex];
      if (!opt || !opt.value) {
        descEl.textContent = '';
        fieldsEl.innerHTML = '';
        currentReadValues = () => ({});
        return;
      }
      descEl.textContent = opt.dataset.description || '';
      let schema = null;
      try { schema = opt.dataset.schema ? JSON.parse(opt.dataset.schema) : null; } catch {}
      currentReadValues = renderSchemaFields(schema, fieldsEl);
      syncPayloadTextarea();
    });

    // Fetch payload types from the API, replace the static dropdown options,
    // and update the payload placeholder/hint + builder visibility when the
    // user switches type.
    (async () => {
      try {
        const types = await API.get('/api/scheduler/types');
        if (!types || typeof types !== 'object' || !inputs.payload_type) return;
        inputs.payload_type.innerHTML = '';
        for (const id of Object.keys(types)) {
          const o = document.createElement('option');
          o.value = id;
          o.textContent = id;
          o.title = types[id].description || '';
          inputs.payload_type.appendChild(o);
        }
        const applyHint = () => {
          const t = types[inputs.payload_type.value];
          if (!t) return;
          if (inputs.payload) inputs.payload.placeholder = t.payloadHint || '';
          if (inputs.payload_hint_el) inputs.payload_hint_el.textContent = t.description || '';
          // Toggle the builder: visible only when mcp_tool; raw payload
          // textarea stays as a live preview / advanced-mode fallback.
          const isMcp = inputs.payload_type.value === 'mcp_tool';
          builder.classList.toggle('is-hidden', !isMcp);
          if (isMcp) loadConnectedApps();
        };
        inputs.payload_type.addEventListener('change', applyHint);
        applyHint();
      } catch (err) {
        console.warn('[scheduler] failed to load payload types:', err);
      }
    })();

    // Wire up schedule preset
    if (inputs.schedule_preset) {
      inputs.schedule_preset.addEventListener('change', () => {
        const val = inputs.schedule_preset.value;
        const customGroup = modal.querySelector('[data-field="schedule"]');
        if (val === 'Custom...') {
          if (customGroup) customGroup.classList.remove('is-hidden');
          inputs.schedule.value = '';
          inputs.schedule.focus();
        } else {
          if (customGroup) customGroup.classList.add('is-hidden');
          const preset = presetMap[val];
          if (preset) {
            inputs.schedule.value = preset.schedule;
            inputs.schedule_type.value = preset.type;
          }
        }
      });
      // Initialize with first preset
      const firstPreset = presetMap[inputs.schedule_preset.value];
      if (firstPreset) {
        inputs.schedule.value = firstPreset.schedule;
        inputs.schedule_type.value = firstPreset.type;
      }
    }

    // One-shot checkbox
    const checkGroup = document.createElement('div');
    checkGroup.className = 'scheduler-check-group';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'one-shot-check';
    const checkLabel = document.createElement('label');
    checkLabel.htmlFor = 'one-shot-check';
    checkLabel.className = 'scheduler-check-label';
    checkLabel.textContent = 'One-shot (run once then disable)';
    checkGroup.appendChild(checkbox);
    checkGroup.appendChild(checkLabel);
    modal.appendChild(checkGroup);

    // "Show as dock tab" — surface this task as an automated skill console tab
    // (first dock group, alongside Heartbeat/Board) so its runs are visible and
    // results render into the tab instead of being discarded. Default on for
    // the user-facing `query` type; the backend ignores it for other types.
    const surfaceGroup = document.createElement('div');
    surfaceGroup.className = 'scheduler-check-group';
    const surfaceCheck = document.createElement('input');
    surfaceCheck.type = 'checkbox';
    surfaceCheck.id = 'surface-tab-check';
    surfaceCheck.checked = true;
    const surfaceLabel = document.createElement('label');
    surfaceLabel.htmlFor = 'surface-tab-check';
    surfaceLabel.className = 'scheduler-check-label';
    surfaceLabel.textContent = 'Show as dock tab (results render in a tab)';
    surfaceGroup.appendChild(surfaceCheck);
    surfaceGroup.appendChild(surfaceLabel);
    modal.appendChild(surfaceGroup);

    const btnRow = document.createElement('div');
    btnRow.className = 'scheduler-btn-row';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => overlay.remove());
    btnRow.appendChild(cancelBtn);

    const submitBtn = document.createElement('button');
    submitBtn.className = 'btn btn-primary';
    submitBtn.textContent = 'Add Task';
    submitBtn.addEventListener('click', async () => {
      const form = {
        name: inputs.name.value.trim(),
        schedule: inputs.schedule.value.trim(),
        schedule_type: inputs.schedule_type.value,
        payload_type: inputs.payload_type ? inputs.payload_type.value : 'query',
        payload: inputs.payload.value.trim(),
        one_shot: checkbox.checked,
        surface: surfaceCheck.checked,
        // New tasks inherit the active project (P2); System tasks aren't created here.
        project_id: this._activeProjectId(),
      };
      if (!form.name || !form.schedule || !form.payload) {
        Components.toast('Name, schedule, and payload are required', 'error');
        return;
      }
      // Client-side sanity: mcp_tool payloads must be JSON with server + tool
      if (form.payload_type === 'mcp_tool') {
        try {
          const p = JSON.parse(form.payload);
          if (!p || typeof p !== 'object' || !p.server || !p.tool) {
            Components.toast('mcp_tool payload needs {"server":"...","tool":"...","args":{...}}', 'error');
            return;
          }
        } catch {
          Components.toast('mcp_tool payload must be valid JSON', 'error');
          return;
        }
      }
      submitBtn.disabled = true;
      submitBtn.textContent = 'Adding...';
      try {
        const created = await API.post('/api/scheduler', form);
        // The server now tells us whether the schedule actually registered.
        // It used to always look like success, so a task that would never fire
        // got the same green toast as one that would.
        if (created && created.warning) {
          Components.toast(created.warning, 'error');
        } else {
          Components.toast(`Task "${form.name}" added`, 'success');
        }
        if (window.refreshSidebarCounts) window.refreshSidebarCounts();
        overlay.remove();
        this._refreshTable();
      } catch (err) {
        Components.toast('Add failed: ' + err.message, 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Add Task';
      }
    });
    btnRow.appendChild(submitBtn);
    modal.appendChild(btnRow);

    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    setTimeout(() => inputs.name.focus(), 50);
  },
};

// Re-filter the Scheduled view live when the active project changes, but only
// while it's actually mounted (PLAN-PROJECT-SCOPED-DOCK Phase 2).
window.addEventListener('project:changed', () => {
  if (document.getElementById('scheduler-table-wrap')) {
    SchedulerView._showAllProjects = false;
    const main = document.getElementById('main-content');
    if (main) SchedulerView.render(main);
  }
});
