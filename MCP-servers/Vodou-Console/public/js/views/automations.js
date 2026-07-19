/**
 * Automations view — cross-integration event-driven automations.
 * Mounted as a tab inside the Activity shell alongside Scheduled + History.
 *
 * Minimum viable UX:
 *  - List of automations with toggle / run-now / delete per row
 *  - "New automation" modal with trigger + actions + notify + interval
 *  - Schema-to-form renderer (shared mental model with scheduler's mcp_tool)
 *
 * Deferred polish (see Phase 3.4 in PLAN-INTEGRATION-HUB-PHASE-3.md):
 *  - Edit existing automation
 *  - Run-history drill-down per automation
 *  - Live preview of trigger output while building
 *  - Manual-id override when auto-extraction picks wrong field
 */
const AutomationsView = {
  destroy() {},

  /** Must match column count in _renderTable (detail row colspan). */
  _AUTOMATIONS_COL_COUNT: 10,

  // Connected integrations fetched once per mount; reused by every modal.
  _integrationsCache: null,
  // Tool lists per integration (fetched on demand).
  _toolsCache: {},

  async render(container) {
    container.innerHTML = '';
    container.appendChild(Components.pageHeader('Automations', 'Loading…'));
    container.appendChild(Components.loading());

    try {
      const data = await API.get('/api/automations');
      const rows = data.automations || [];
      container.innerHTML = '';

      const newBtn = document.createElement('button');
      newBtn.type = 'button';
      newBtn.className = 'btn btn-primary';
      newBtn.id = 'new-automation-btn';
      newBtn.textContent = '+ New automation';
      newBtn.addEventListener('click', () => this._openModal());

      const tagline = 'Like IFTTT or Zapier, but for your MCP tools';
      const sub =
        rows.length === 0
          ? tagline
          : `${tagline} · ${rows.length} automation${rows.length !== 1 ? 's' : ''}`;
      const hdr = Components.pageHeader('Automations', sub, newBtn);
      const titleHost = hdr.querySelector('.page-title');
      if (titleHost) {
        titleHost.appendChild(
          Components.helpTip(
            'Polls a trigger tool on an interval, diffs results against last run, and runs actions for each new event. Optional webhook. First run seeds state only (no duplicate blasts).'
          )
        );
      }
      container.appendChild(hdr);

      const wrap = document.createElement('div');
      wrap.id = 'automations-table-wrap';
      container.appendChild(wrap);

      this._renderTable(wrap, rows, container);
      this._applyFocusFromHash(container);
    } catch (err) {
      container.innerHTML = '';
      container.appendChild(Components.errorState('Failed to load automations: ' + err.message));
    }
  },

  _applyFocusFromHash(container) {
    try {
      const q = location.hash.includes('?') ? location.hash.split('?')[1] : '';
      const focusId = new URLSearchParams(q).get('focus');
      if (!focusId) return;
      const btn = container.querySelector(`.automation-expand-btn[data-id="${focusId}"]`);
      if (btn) {
        btn.click();
        btn.closest('tr')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } catch {
      /* non-fatal */
    }
  },

  _renderTable(wrap, rows, container) {
    wrap.innerHTML = '';

    if (rows.length === 0) {
      const emptyEl = Components.emptyState('No automations yet.');
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'btn btn-primary empty-state-action';
      addBtn.textContent = 'Create your first automation';
      addBtn.addEventListener('click', () => this._openModal());
      emptyEl.appendChild(document.createElement('br'));
      emptyEl.appendChild(addBtn);
      wrap.appendChild(emptyEl);
      return;
    }

    const table = document.createElement('table');
    table.className = 'data-table';
    const thead = document.createElement('thead');
    thead.innerHTML = `<tr>
      <th style="width:72px;"></th>
      <th>Name</th>
      <th>Trigger</th>
      <th>Actions</th>
      <th style="width:72px;">Every</th>
      <th style="width:100px;">Last run</th>
      <th style="width:100px;">Next run</th>
      <th style="width:72px;">Seen</th>
      <th style="width:80px;">On</th>
      <th style="width:200px;"></th>
    </tr>`;
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);

    for (const a of rows) {
      const tr = document.createElement('tr');
      tr.dataset.automationId = String(a.id);

      const trTrigger = a.trigger ? `${a.trigger.integration}.${a.trigger.tool}` : '—';
      const trActions =
        Array.isArray(a.actions) && a.actions.length > 0
          ? `${a.actions.length} step${a.actions.length > 1 ? 's' : ''}`
          : '(notify only)';
      const lastRun = a.last_run_at ? this._relTime(a.last_run_at) : 'never';
      const nextRun = a.next_run_at ? this._relTime(a.next_run_at) : '—';
      const seenCount =
        a.state && Array.isArray(a.state.last_seen_ids) ? a.state.last_seen_ids.length : 0;

      const td0 = document.createElement('td');
      const expandBtn = document.createElement('button');
      expandBtn.type = 'button';
      expandBtn.className = 'btn btn-sm automation-expand-btn';
      expandBtn.dataset.id = String(a.id);
      expandBtn.textContent = 'Runs';
      expandBtn.title = 'Show recent runs';
      td0.appendChild(expandBtn);

      const td1 = document.createElement('td');
      const nameRow = document.createElement('div');
      nameRow.className = 'flex-center gap-2';
      const nameStrong = document.createElement('span');
      nameStrong.className = 'font-600 text-primary-color';
      nameStrong.textContent = a.name;
      nameRow.appendChild(nameStrong);
      if (a.last_error) {
        const errBadge = Components.badge('error', 'error');
        errBadge.title = a.last_error;
        nameRow.appendChild(errBadge);
      }
      td1.appendChild(nameRow);
      if (a.description) {
        const sub = document.createElement('div');
        sub.className = 'secondary-text text-sm';
        sub.textContent = a.description;
        td1.appendChild(sub);
      }

      const td2 = document.createElement('td');
      const codeTrig = document.createElement('code');
      codeTrig.className = 'font-mono text-sm text-primary-color';
      codeTrig.textContent = trTrigger;
      td2.appendChild(codeTrig);

      const td3 = document.createElement('td');
      td3.className = 'secondary-text text-sm';
      td3.textContent = trActions;

      const td4 = document.createElement('td');
      td4.className = 'font-mono text-sm text-muted-color';
      td4.textContent = `${a.interval_minutes || 15}m`;

      const td5 = document.createElement('td');
      td5.className = 'secondary-text text-sm';
      td5.textContent = lastRun;

      const td6 = document.createElement('td');
      td6.className = 'secondary-text text-sm';
      td6.textContent = nextRun;

      const td7 = document.createElement('td');
      td7.className = 'secondary-text text-sm';
      td7.title = 'Events remembered to avoid re-firing';
      td7.textContent = String(seenCount) + (seenCount >= 500 ? ' (max)' : '');

      const td8 = document.createElement('td');
      const toggleWrap = Components.toggle(!!a.enabled, async (checked) => {
        try {
          await API.patch('/api/automations/' + a.id, { enabled: checked });
          Components.toast(checked ? 'Enabled' : 'Disabled', 'success');
        } catch (err) {
          Components.toast('Update failed: ' + err.message, 'error');
          const inp = toggleWrap.querySelector('input[type="checkbox"]');
          if (inp) inp.checked = !checked;
        }
      });
      td8.appendChild(toggleWrap);

      const td9 = document.createElement('td');
      const act = document.createElement('div');
      act.className = 'flex-center gap-2';

      const runBtn = document.createElement('button');
      runBtn.type = 'button';
      runBtn.className = 'btn btn-sm';
      runBtn.textContent = 'Run';
      runBtn.title = 'Queue for next worker tick (≤60s)';
      runBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          const r = await API.post('/api/automations/' + a.id + '/run', {});
          Components.toast('Queued for next tick (≤60s)', 'success');
          if (r && r.note) console.info('[automations]', r.note);
        } catch (err) {
          Components.toast('Queue failed: ' + err.message, 'error');
        }
      });

      const pinBtn = document.createElement('button');
      pinBtn.type = 'button';
      pinBtn.className = 'btn btn-sm btn-ghost pin-btn';
      pinBtn.dataset.id = String(a.id);
      pinBtn.dataset.name = a.name;
      pinBtn.textContent = 'Pin';
      const scope = `workbench:automation:${a.id}`;
      const refreshPin = () => {
        const on = typeof WorkbenchSurfaces !== 'undefined' && WorkbenchSurfaces.has(scope);
        pinBtn.classList.toggle('is-pinned', on);
        pinBtn.textContent = on ? 'Unpin' : 'Pin';
        pinBtn.title = on ? 'Remove from main chat tab row' : 'Pin to main chat tab row';
      };
      refreshPin();
      pinBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (typeof WorkbenchSurfaces === 'undefined') return;
        const willPin = !WorkbenchSurfaces.has(scope);
        if (willPin) {
          try {
            await API.post('/api/workbench/ensure', { scope, title: a.name });
          } catch (err) {
            Components.toast('Pin failed: ' + err.message, 'error');
            return;
          }
        }
        WorkbenchSurfaces.toggle({
          scope,
          title: a.name,
          icon: '\u26A1',
          kind: 'automation',
        });
        refreshPin();
        Components.toast(willPin ? `Pinned "${a.name}" to main chat` : `Unpinned "${a.name}"`, 'success');
      });

      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'btn btn-sm btn-ghost';
      resetBtn.textContent = 'Reset';
      resetBtn.title = 'Clear seen events — next run re-seeds (no actions)';
      resetBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await Components.confirmModal(
          `Reset seen events for "${a.name}"? The next run will re-seed (no actions fire) so you will not double-process historical events.`,
          { title: 'Reset automation state', confirmLabel: 'Reset state' }
        );
        if (!ok) return;
        try {
          await API.post('/api/automations/' + a.id + '/reset-state', {});
          Components.toast('State reset — next run will re-seed', 'success');
          await this._refresh(container);
        } catch (err) {
          Components.toast('Reset failed: ' + err.message, 'error');
        }
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn-sm scheduler-del-btn';
      delBtn.textContent = '\u2715';
      delBtn.title = 'Delete automation';
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await Components.confirmModal(
          `Delete automation "${a.name}"? This removes its run history.`,
          { title: 'Delete automation', confirmLabel: 'Delete', danger: true }
        );
        if (!ok) return;
        try {
          await API.del('/api/automations/' + a.id);
          Components.toast(`Deleted "${a.name}"`, 'success');
          await this._refresh(container);
        } catch (err) {
          Components.toast('Delete failed: ' + err.message, 'error');
        }
      });

      act.appendChild(runBtn);
      act.appendChild(pinBtn);
      act.appendChild(resetBtn);
      act.appendChild(delBtn);
      td9.appendChild(act);

      tr.appendChild(td0);
      tr.appendChild(td1);
      tr.appendChild(td2);
      tr.appendChild(td3);
      tr.appendChild(td4);
      tr.appendChild(td5);
      tr.appendChild(td6);
      tr.appendChild(td7);
      tr.appendChild(td8);
      tr.appendChild(td9);
      tbody.appendChild(tr);

      expandBtn.addEventListener('click', async () => {
        const existing = tr.nextElementSibling;
        if (existing && existing.classList.contains('automation-detail-row')) {
          existing.remove();
          expandBtn.textContent = 'Runs';
          expandBtn.title = 'Show recent runs';
          return;
        }
        expandBtn.textContent = 'Hide';
        expandBtn.title = 'Hide recent runs';
        const detailRow = document.createElement('tr');
        detailRow.className = 'automation-detail-row';
        const detailCell = document.createElement('td');
        detailCell.className = 'automation-detail-cell';
        detailCell.colSpan = this._AUTOMATIONS_COL_COUNT;
        detailCell.innerHTML =
          '<div class="loading-container"><div class="loading-spinner"></div></div>';
        detailRow.appendChild(detailCell);
        tr.parentNode.insertBefore(detailRow, tr.nextSibling);
        try {
          const detail = await API.get('/api/automations/' + a.id);
          detailCell.innerHTML = '';
          const inner = document.createElement('div');
          inner.className = 'automation-detail-inner';
          inner.innerHTML = this._renderDetail(detail);
          detailCell.appendChild(inner);
        } catch (err) {
          detailCell.innerHTML = `<div class="error-state">${escapeHtml(err.message)}</div>`;
        }
      });
    }

    wrap.appendChild(table);
  },

  async _refresh(container) {
    const wrap = document.getElementById('automations-table-wrap');
    if (!wrap || !container) return;
    try {
      const data = await API.get('/api/automations');
      const rows = data.automations || [];
      const subEl = container.querySelector('.page-header .page-subtitle');
      if (subEl) {
        subEl.textContent =
          rows.length === 0
            ? 'No automations yet'
            : `${rows.length} automation${rows.length !== 1 ? 's' : ''}`;
      }
      this._renderTable(wrap, rows, container);
      this._applyFocusFromHash(container);
    } catch (err) {
      wrap.innerHTML = '';
      wrap.appendChild(Components.errorState('Could not refresh: ' + err.message));
    }
  },

  _renderDetail(data) {
    const auto = data.automation || {};
    const runs = Array.isArray(data.runs) ? data.runs : [];
    const actCount = Array.isArray(auto.actions) ? auto.actions.length : 0;
    const actionsList =
      actCount > 0
        ? auto.actions
            .map(
              (x, i) =>
                `<div class="automation-detail-action-line"><strong>${i + 1}.</strong> <code class="font-mono text-sm">${escapeHtml(x.integration)}.${escapeHtml(x.tool)}</code></div>`
            )
            .join('')
        : '<p class="secondary-text text-sm">(notify only — no action chain)</p>';
    const evPath =
      auto.trigger && auto.trigger.event_id_path
        ? `<div class="scheduler-form-hint" style="margin-top:4px;">event_id_path: <code>${escapeHtml(auto.trigger.event_id_path)}</code></div>`
        : '';
    const notifyLine =
      auto.notify && auto.notify.url
        ? `<div class="scheduler-form-hint" style="margin-top:6px;">Notify: <code>${escapeHtml(auto.notify.url.substring(0, 72))}${auto.notify.url.length > 72 ? '…' : ''}</code></div>`
        : '';

    const header = `<div class="automation-detail-grid">
        <div>
          <div class="automation-detail-k">Trigger</div>
          <code class="font-mono text-sm text-primary-color">${escapeHtml(auto.trigger ? `${auto.trigger.integration}.${auto.trigger.tool}` : '—')}</code>
          ${evPath}
        </div>
        <div>
          <div class="automation-detail-k">Actions (${actCount})</div>
          ${actionsList}
          ${notifyLine}
        </div>
      </div>`;

    if (runs.length === 0) {
      return (
        header +
        '<p class="secondary-text text-sm" style="margin:0;padding:8px 0 0;">No runs yet. Use <strong>Run</strong> on the row above or wait for the next worker tick.</p>'
      );
    }

    const runsHtml = runs.slice(0, 10).map(r => this._renderRunBubbles(r, auto)).join('');

    return (
      header +
      `<div class="automation-detail-k" style="margin-bottom:8px;">Recent runs (last ${Math.min(runs.length, 10)})</div>` +
      `<div class="automation-run-feed">${runsHtml}</div>`
    );
  },

  /** Render one run as a pair of chat bubbles: trigger (system) + outcome (assistant). */
  _renderRunBubbles(r, auto) {
    const when = r.started_at ? this._relTime(r.started_at) : '?';
    const success = !!r.success;
    const events = r.events_matched || 0;
    const trigInt = auto && auto.trigger ? auto.trigger.integration : 'trigger';
    const trigTool = auto && auto.trigger ? auto.trigger.tool : '';

    // Trigger bubble — system-style, shows what the trigger returned
    const trigText = this._formatTriggerResult(r.trigger_result || '');
    const triggerBubble = `
      <div class="message" data-role="system" style="margin:8px 0;">
        <div class="msg-body">
          <div class="msg-header-row">
            <div class="msg-avatar system-av msg-avatar-initials-narrow">T</div>
            <div class="msg-header">
              <span class="msg-author system-name">${escapeHtml(trigInt)}.${escapeHtml(trigTool)}</span>
              <span class="msg-time">${escapeHtml(when)}</span>
            </div>
          </div>
          <div class="msg-content system-text" style="padding-left:var(--chat-msg-indent);font-size:12px;">${trigText}</div>
        </div>
      </div>`;

    // Outcome bubble — assistant-style, shows what happened (events, actions, error)
    const statusIcon = success ? '✓' : '✗';
    const statusColor = success ? 'var(--success)' : 'var(--error)';
    const noteLine = r.error
      ? `<div style="color:${statusColor};font-size:11px;margin-top:2px;">${escapeHtml(r.error)}</div>`
      : '';
    let actionsBlock = '';
    if (r.actions_result) {
      try {
        const parsed = JSON.parse(r.actions_result);
        if (Array.isArray(parsed) && parsed.length > 0) {
          actionsBlock = parsed.map((eventEntry, idx) => {
            const steps = Array.isArray(eventEntry.steps) ? eventEntry.steps : [];
            const stepsHtml = steps.map(s => {
              const ok = s.ok ? '✓' : '✗';
              const okColor = s.ok ? 'var(--success)' : 'var(--error)';
              const detail = s.ok
                ? `returned ${s.result_chars || 0} chars`
                : escapeHtml(String(s.error || 'failed').substring(0, 200));
              return `<div style="font-size:11px;margin:2px 0;"><span style="color:${okColor};">${ok}</span> Step ${s.step}: <code>${escapeHtml(s.integration || '')}.${escapeHtml(s.tool || '')}</code> — ${detail}</div>`;
            }).join('');
            return `<div style="margin-top:6px;"><div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Event ${idx + 1}</div>${stepsHtml}</div>`;
          }).join('');
        }
      } catch { /* leave blank */ }
    }
    const outcomeBubble = `
      <div class="message" data-role="assistant" style="margin:8px 0 16px;">
        <div class="msg-body">
          <div class="msg-header-row">
            <div class="msg-avatar assistant-av msg-avatar-initials-narrow" style="color:${statusColor};">${statusIcon}</div>
            <div class="msg-header">
              <span class="msg-author assistant-name">Outcome</span>
              <span class="msg-time">${escapeHtml(when)}</span>
            </div>
          </div>
          <div class="msg-content" style="padding-left:var(--chat-msg-indent);font-size:12px;">
            <strong>${events}</strong> new event${events === 1 ? '' : 's'} · ${success ? 'success' : 'failed'}
            ${noteLine}
            ${actionsBlock}
          </div>
        </div>
      </div>`;

    return triggerBubble + outcomeBubble;
  },

  /** Extract the most readable snippet from a trigger_result stdout dump. */
  _formatTriggerResult(raw) {
    if (!raw) return '<span style="color:var(--text-muted);">(no output captured)</span>';
    // Strip common CLI prefix: "⚡ Calling tool X on Y ...\n📤 Result:\n"
    let s = raw.replace(/^⚡[^\n]*\n(?:📤 Result:\n)?/, '');
    // Try to pretty-print if it's JSON
    try {
      const parsed = JSON.parse(s);
      // If content is nested under content[0].text as a JSON string, surface it
      if (parsed && Array.isArray(parsed.content) && parsed.content[0] && typeof parsed.content[0].text === 'string') {
        const inner = parsed.content[0].text;
        // Truncate to 600 chars for readability
        const display = inner.length > 600 ? inner.substring(0, 600) + '…' : inner;
        return `<pre style="margin:0;font-size:11px;white-space:pre-wrap;max-height:240px;overflow:auto;background:var(--bg-tertiary);padding:6px 8px;border-radius:4px;">${escapeHtml(display)}</pre>`;
      }
      const pretty = JSON.stringify(parsed, null, 2);
      const display = pretty.length > 600 ? pretty.substring(0, 600) + '\n…' : pretty;
      return `<pre style="margin:0;font-size:11px;white-space:pre-wrap;max-height:240px;overflow:auto;background:var(--bg-tertiary);padding:6px 8px;border-radius:4px;">${escapeHtml(display)}</pre>`;
    } catch {
      const display = s.length > 600 ? s.substring(0, 600) + '…' : s;
      return `<pre style="margin:0;font-size:11px;white-space:pre-wrap;max-height:240px;overflow:auto;background:var(--bg-tertiary);padding:6px 8px;border-radius:4px;">${escapeHtml(display)}</pre>`;
    }
  },

  _relTime(iso) {
    try {
      const d = new Date(iso.endsWith('Z') ? iso : iso.replace(' ', 'T') + 'Z');
      const diff = d.getTime() - Date.now();
      const abs = Math.abs(diff);
      const s = Math.round(abs / 1000);
      if (s < 60) return diff < 0 ? `${s}s ago` : `in ${s}s`;
      const m = Math.round(s / 60);
      if (m < 60) return diff < 0 ? `${m}m ago` : `in ${m}m`;
      const h = Math.round(m / 60);
      if (h < 48) return diff < 0 ? `${h}h ago` : `in ${h}h`;
      const day = Math.round(h / 24);
      return diff < 0 ? `${day}d ago` : `in ${day}d`;
    } catch { return iso; }
  },

  async _openModal() {
    // Prime integrations cache on first open
    if (!this._integrationsCache) {
      try {
        const data = await API.get('/api/oauth/status');
        this._integrationsCache = (data.providers || []).filter(p => p.connected && !p.blocked);
      } catch { this._integrationsCache = []; }
    }

    const overlay = document.createElement('div');
    overlay.className = 'scheduler-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'scheduler-modal';
    modal.style.maxWidth = '640px';
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    modal.innerHTML = `
      <h3 class="scheduler-modal-title">New automation</h3>

      <div class="scheduler-form-group">
        <label class="scheduler-form-label">Name</label>
        <input type="text" class="scheduler-form-input auto-name" placeholder="e.g. linear-close-notify" />
      </div>

      <div class="scheduler-form-group">
        <label class="scheduler-form-label">Description (optional)</label>
        <input type="text" class="scheduler-form-input auto-desc" placeholder="One sentence" />
      </div>

      <div class="scheduler-form-group">
        <label class="scheduler-form-label">Interval (minutes)</label>
        <input type="number" min="1" step="1" class="scheduler-form-input auto-interval" value="15" />
      </div>

      <div class="scheduler-form-group">
        <label class="scheduler-form-label">Trigger</label>
        <div class="scheduler-form-hint" style="margin-bottom:6px;">Runs on the interval above; compares output to the last run to find new events.</div>
        <div class="auto-trigger-host"></div>
      </div>

      <div class="scheduler-form-group auto-event-path-group">
        <label class="scheduler-form-label">Event ID path (optional)</label>
        <input type="text" class="scheduler-form-input auto-event-path" placeholder="e.g. issues.id" />
        <div class="scheduler-form-hint">Dotted path to each event&apos;s id. Leave blank to auto-detect.</div>
      </div>

      <div class="scheduler-form-group">
        <label class="scheduler-form-label">Actions</label>
        <div class="scheduler-form-hint" style="margin-bottom:6px;">One chain step per new event (after the trigger).</div>
        <div class="auto-actions-host"></div>
        <button type="button" class="btn btn-sm auto-add-action" style="margin-top:8px;">+ Add action</button>
      </div>

      <div class="scheduler-form-group">
        <label class="scheduler-form-label">Notify webhook URL (optional)</label>
        <input type="url" class="scheduler-form-input auto-notify-url" placeholder="https://hooks.slack.com/…" />
      </div>

      <div class="scheduler-form-group">
        <label class="scheduler-form-label">Notify text template (optional)</label>
        <input type="text" class="scheduler-form-input auto-notify-tpl" placeholder="{{trigger.title}}" />
      </div>

      <div class="scheduler-form-group automation-post-chat-row">
        <input type="checkbox" id="auto-post-to-chat" class="auto-post-to-chat" />
        <label for="auto-post-to-chat" class="automation-post-chat-label">
          <strong>Post to pinned chat tab when new events are found</strong>
          <span class="scheduler-form-hint" style="display:block;margin-top:4px;">
            Uses LLM tokens when ON. Manual runs from chat always post.
          </span>
        </label>
      </div>

      <div class="scheduler-btn-row">
        <button type="button" class="btn auto-cancel">Cancel</button>
        <button type="button" class="btn btn-primary auto-submit">Create automation</button>
      </div>`;

    // Build trigger section (one integration-tool-args picker)
    const triggerHost = modal.querySelector('.auto-trigger-host');
    const triggerCtx = this._mountStepPicker(triggerHost, { enableTemplates: false });

    // Build actions section — dynamic list
    const actionsHost = modal.querySelector('.auto-actions-host');
    const actionStates = []; // array of { getValues: fn, remove: fn }
    const addAction = () => {
      const slot = document.createElement('div');
      slot.style.cssText = 'border:1px solid var(--border-primary);border-radius:6px;padding:8px;margin-bottom:6px;position:relative;';
      const header = document.createElement('div');
      header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;';
      const label = document.createElement('span');
      label.style.cssText = 'font-size:11px;color:var(--text-muted);font-weight:600;';
      label.textContent = `Action ${actionStates.length + 1}`;
      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'btn btn-sm btn-ghost';
      rmBtn.textContent = '✕';
      rmBtn.title = 'Remove this action';
      header.appendChild(label); header.appendChild(rmBtn);
      slot.appendChild(header);
      const host = document.createElement('div');
      slot.appendChild(host);
      actionsHost.appendChild(slot);
      const state = this._mountStepPicker(host, { enableTemplates: true });
      const entry = {
        getValues: state.getValues,
        remove: () => { slot.remove(); const idx = actionStates.indexOf(entry); if (idx >= 0) actionStates.splice(idx, 1); this._relabelActions(actionsHost); },
      };
      rmBtn.addEventListener('click', entry.remove);
      actionStates.push(entry);
    };
    modal.querySelector('.auto-add-action').addEventListener('click', addAction);

    modal.querySelector('.auto-cancel').addEventListener('click', () => overlay.remove());
    modal.querySelector('.auto-submit').addEventListener('click', async () => {
      const name = modal.querySelector('.auto-name').value.trim();
      if (!name) { Components.toast('Name required', 'error'); return; }
      const interval_minutes = Math.max(1, Math.floor(Number(modal.querySelector('.auto-interval').value) || 15));
      const trig = triggerCtx.getValues();
      if (!trig.integration || !trig.tool) { Components.toast('Trigger integration and tool are required', 'error'); return; }
      const actions = actionStates.map(a => a.getValues()).filter(a => a.integration && a.tool);
      const notifyUrl = modal.querySelector('.auto-notify-url').value.trim();
      const notifyTpl = modal.querySelector('.auto-notify-tpl').value.trim();
      const notify = (notifyUrl || notifyTpl) ? { url: notifyUrl || undefined, template: notifyTpl || undefined } : null;
      const eventIdPath = modal.querySelector('.auto-event-path').value.trim();

      const postToChat = !!modal.querySelector('.auto-post-to-chat')?.checked;
      const body = {
        name,
        description: modal.querySelector('.auto-desc').value.trim() || undefined,
        trigger: {
          integration: trig.integration,
          tool: trig.tool,
          args: trig.args,
          event_id_path: eventIdPath || undefined,
        },
        actions: actions.map(a => ({ integration: a.integration, tool: a.tool, args: a.args })),
        notify,
        interval_minutes,
        post_to_chat: postToChat,
      };

      const btn = modal.querySelector('.auto-submit');
      btn.disabled = true; btn.textContent = 'Creating…';
      try {
        await API.post('/api/automations', body);
        Components.toast(`Automation "${name}" created`, 'success');
        overlay.remove();
        const container = document.getElementById('activity-tab-panel') || document.getElementById('main-content');
        if (container) await this._refresh(container);
      } catch (err) {
        Components.toast('Create failed: ' + err.message, 'error');
        btn.disabled = false; btn.textContent = 'Create automation';
      }
    });
  },

  _relabelActions(host) {
    host.querySelectorAll(':scope > div').forEach((slot, i) => {
      const lbl = slot.querySelector('span');
      if (lbl) lbl.textContent = `Action ${i + 1}`;
    });
  },

  /**
   * Mount one "integration → tool → args-form" picker into a host element.
   * Returns { getValues } that produces { integration, tool, args }.
   * When enableTemplates=true, the form description explains that {{trigger.X}}
   * and {{actionN.Y}} placeholders are allowed in string args.
   */
  _mountStepPicker(host, opts = {}) {
    host.innerHTML = `
      <select class="scheduler-form-input step-integration">
        <option value="">— pick integration —</option>
        ${this._integrationsCache.map(p => `<option value="${escapeAttr(p.id)}">${escapeHtml(p.name)} (${p.toolCount || 0} tools)</option>`).join('')}
      </select>
      <select class="scheduler-form-input step-tool" disabled style="margin-top:6px;">
        <option value="">Pick integration first</option>
      </select>
      <div class="step-desc" style="font-size:11px;color:var(--text-muted);margin:4px 0 8px;line-height:1.3;"></div>
      <div class="step-fields" style="display:flex;flex-direction:column;gap:6px;"></div>
      ${opts.enableTemplates ? '<div class="scheduler-form-hint">String fields may use <code>{{trigger.field}}</code> and <code>{{action1.field}}</code>.</div>' : ''}
    `;
    const intEl = host.querySelector('.step-integration');
    const toolEl = host.querySelector('.step-tool');
    const descEl = host.querySelector('.step-desc');
    const fieldsEl = host.querySelector('.step-fields');
    let readValues = () => ({});

    intEl.addEventListener('change', async () => {
      const id = intEl.value;
      toolEl.innerHTML = '<option value="">Loading…</option>';
      toolEl.disabled = true;
      descEl.textContent = '';
      fieldsEl.innerHTML = '';
      readValues = () => ({});
      if (!id) { toolEl.innerHTML = '<option value="">Pick integration first</option>'; return; }
      try {
        if (!this._toolsCache[id]) {
          const data = await API.get(`/api/tools?server=${encodeURIComponent(id)}`);
          this._toolsCache[id] = data.tools || [];
        }
        const tools = this._toolsCache[id];
        toolEl.innerHTML = '<option value="">— pick tool —</option>';
        for (const t of tools) {
          const o = document.createElement('option');
          o.value = t.name;
          o.textContent = t.name;
          o.dataset.description = t.description || '';
          o.dataset.schema = t.input_schema ? JSON.stringify(t.input_schema) : '';
          toolEl.appendChild(o);
        }
        toolEl.disabled = tools.length === 0;
      } catch (err) {
        toolEl.innerHTML = '<option value="">(failed to load)</option>';
      }
    });

    toolEl.addEventListener('change', () => {
      const opt = toolEl.options[toolEl.selectedIndex];
      if (!opt || !opt.value) { descEl.textContent = ''; fieldsEl.innerHTML = ''; readValues = () => ({}); return; }
      descEl.textContent = opt.dataset.description || '';
      let schema = null;
      try { schema = opt.dataset.schema ? JSON.parse(opt.dataset.schema) : null; } catch {}
      readValues = this._renderSchemaFields(schema, fieldsEl);
    });

    return {
      getValues: () => ({
        integration: intEl.value,
        tool: toolEl.value,
        args: readValues(),
      }),
    };
  },

  /** Identical logic to the scheduler's mcp_tool builder — DRY candidate for Phase 3.4. */
  _renderSchemaFields(schema, container) {
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
          blank.value = ''; blank.textContent = '(leave unset)'; ctrl.appendChild(blank);
        }
        for (const v of def.enum) {
          const o = document.createElement('option'); o.value = String(v); o.textContent = String(v); ctrl.appendChild(o);
        }
      } else if (def.type === 'boolean') {
        ctrl = document.createElement('select');
        for (const v of ['', 'true', 'false']) {
          const o = document.createElement('option'); o.value = v; o.textContent = v || '(unset)'; ctrl.appendChild(o);
        }
      } else if (def.type === 'number' || def.type === 'integer') {
        ctrl = document.createElement('input'); ctrl.type = 'number';
        if (def.type === 'integer') ctrl.step = '1';
        if (def.default !== undefined) ctrl.placeholder = 'default: ' + def.default;
      } else if (isJsonComposite) {
        ctrl = document.createElement('textarea'); ctrl.rows = 2;
        ctrl.style.fontFamily = "'SFMono-Regular', Menlo, monospace";
        ctrl.style.fontSize = '11px';
        ctrl.placeholder = def.type === 'array' ? '[]  (JSON)' : '{}  (JSON)';
      } else {
        ctrl = document.createElement('input'); ctrl.type = 'text';
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
          const n = Number(raw); if (Number.isFinite(n)) out[key] = n; continue;
        }
        if (def.type === 'array' || def.type === 'object') {
          try { out[key] = JSON.parse(raw); } catch { out[key] = raw; }
          continue;
        }
        out[key] = raw;
      }
      return out;
    };
  },
};

// Shared escaper — safe.js loads first, so VodouSafe is always present.
// (The old local escapeAttr double-escaped: `"` → `&quot;` → `&amp;quot;`.)
function escapeHtml(s) { return window.VodouSafe.escapeHtml(s); }
function escapeAttr(s) { return window.VodouSafe.escapeAttr(s); }

if (typeof window !== 'undefined') window.AutomationsView = AutomationsView;
