/**
 * ExecDesk Approval Queue — Phase 1 day 11 deliverable.
 *
 * Plan: PLANS/0.5.38/PLAN-SMB-EXEC-CONSOLE.md §0.7 #9
 *
 * Per-action approval gates. Defaults:
 *   - Tweets / LinkedIn posts: ON
 *   - Draft email to customer: ON
 *   - Internal artifacts (notes, drafts, reports): OFF
 *   - Anything CFO touches that exits the system: ON, hard-locked
 *
 * v0.1.0 ships the queue UI with localStorage persistence. Backend persistence
 * (gateway DB table `execdesk_approvals`) lands when the orchestrator does
 * (Phase 2). Until then, skills enqueue items via window.ExecDeskApproval.enqueue().
 */
const ExecDeskApprovalView = {
  STORAGE_KEY: 'execdesk-approval-queue',

  load() {
    try {
      return JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '[]');
    } catch { return []; }
  },

  save(items) {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(items));
    } catch {}
    this._notifyBadge(items.filter((i) => i.status === 'pending').length);
  },

  enqueue(item) {
    const items = this.load();
    items.unshift({
      id: `app_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      created_at: new Date().toISOString(),
      status: 'pending',
      ...item,
    });
    this.save(items);
  },

  _notifyBadge(pending) {
    document.querySelectorAll('.execdesk-approval-pending').forEach((el) => {
      el.dataset.count = pending > 0 ? String(pending) : '';
      el.style.display = pending > 0 ? '' : 'none';
    });
  },

  async render(el) {
    el.innerHTML = '';
    const items = this.load();

    const wrap = document.createElement('div');
    wrap.className = 'execdesk-home'; // reuse padding/max-width
    wrap.innerHTML = `
      <div style="margin-bottom:24px;">
        <h1 style="margin:0 0 6px; font-size:26px; font-weight:700;">Approval queue</h1>
        <p style="margin:0; color:#6b7280; font-size:14px;">
          Anything your team wants to publish externally or move money lands here first.
          Default-on for tweets, customer emails, and CFO outflows. Internal drafts skip the queue.
        </p>
      </div>
    `;

    // Stats row
    const stats = document.createElement('div');
    stats.style.cssText = 'display:flex; gap:12px; margin-bottom:20px;';
    const counts = {
      pending: items.filter((i) => i.status === 'pending').length,
      approved: items.filter((i) => i.status === 'approved').length,
      rejected: items.filter((i) => i.status === 'rejected').length,
    };
    stats.innerHTML = `
      <div class="execdesk-stat" style="background:#fef3c7; color:#92400e;">
        <div class="execdesk-stat-num">${counts.pending}</div><div class="execdesk-stat-label">Pending</div>
      </div>
      <div class="execdesk-stat" style="background:#d1fae5; color:#065f46;">
        <div class="execdesk-stat-num">${counts.approved}</div><div class="execdesk-stat-label">Approved</div>
      </div>
      <div class="execdesk-stat" style="background:#fee2e2; color:#991b1b;">
        <div class="execdesk-stat-num">${counts.rejected}</div><div class="execdesk-stat-label">Rejected</div>
      </div>
    `;
    wrap.appendChild(stats);

    // Items list
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'background:#f9fafb; padding:32px; border-radius:12px; text-align:center; color:#6b7280;';
      empty.innerHTML = `
        <div style="font-size:32px; margin-bottom:8px;">📭</div>
        <div style="font-weight:600; margin-bottom:4px;">No items in queue.</div>
        <div style="font-size:13px;">When your CMO drafts a tweet or your CFO triggers a payment, you'll see it here.</div>
        <button id="execdesk-seed-demo" style="margin-top:14px; background:#6366f1; color:#fff; border:none; padding:8px 14px; border-radius:8px; cursor:pointer; font-size:13px;">Add a demo item</button>
      `;
      empty.querySelector('#execdesk-seed-demo').addEventListener('click', () => {
        this.enqueue({
          source: 'execdesk-cmo',
          source_label: 'CMO',
          source_color: '#16a34a',
          action: 'twitter-post',
          title: 'Twitter thread — "5 lessons from our first $10k month"',
          summary: 'Draft of 7-tweet thread, target: D2C audience. CTA links to landing page.',
          payload_preview: '🧵 Lessons from our first $10k month as a D2C indie brand...\n\n1. Niche down hard...',
          gate_reason: 'External publish — default ON',
        });
        this.render(el);
      });
      wrap.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.style.cssText = 'display:flex; flex-direction:column; gap:12px;';
      for (const item of items) list.appendChild(this._renderItem(item, el));
      wrap.appendChild(list);
    }

    // Inject styles once
    if (!document.getElementById('execdesk-approval-styles')) {
      const s = document.createElement('style');
      s.id = 'execdesk-approval-styles';
      s.textContent = `
        body.execdesk-mode .execdesk-stat { padding:14px 18px; border-radius:10px; flex:1; }
        body.execdesk-mode .execdesk-stat-num { font-size:24px; font-weight:700; }
        body.execdesk-mode .execdesk-stat-label { font-size:12px; text-transform:uppercase; letter-spacing:0.5px; opacity:0.85; }
        body.execdesk-mode .execdesk-app-item { background:#fff; border-radius:12px; padding:16px 18px; box-shadow:0 1px 6px rgba(20,20,60,0.05); }
        body.execdesk-mode .execdesk-app-item-header { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
        body.execdesk-mode .execdesk-app-item-source { font-size:11px; padding:2px 8px; border-radius:999px; color:white; font-weight:700; letter-spacing:0.4px; }
        body.execdesk-mode .execdesk-app-item-action { font-size:11px; color:#6b7280; }
        body.execdesk-mode .execdesk-app-item-time { margin-left:auto; font-size:11px; color:#9ca3af; }
        body.execdesk-mode .execdesk-app-item-title { font-weight:600; margin-bottom:4px; color:#1a1a2e; }
        body.execdesk-mode .execdesk-app-item-summary { font-size:13px; color:#4b5563; margin-bottom:8px; }
        body.execdesk-mode .execdesk-app-item-preview { background:#f9fafb; padding:10px 12px; border-radius:8px; font-family:ui-monospace,monospace; font-size:12px; color:#374151; white-space:pre-wrap; max-height:120px; overflow:auto; margin-bottom:10px; }
        body.execdesk-mode .execdesk-app-item-gate { font-size:11px; color:#92400e; background:#fffbeb; padding:4px 10px; border-radius:6px; display:inline-block; margin-bottom:10px; }
        body.execdesk-mode .execdesk-app-item-actions { display:flex; gap:8px; }
        body.execdesk-mode .execdesk-app-btn { border:none; padding:8px 14px; border-radius:8px; font-weight:600; font-size:13px; cursor:pointer; }
        body.execdesk-mode .execdesk-app-btn-approve { background:#16a34a; color:#fff; }
        body.execdesk-mode .execdesk-app-btn-reject  { background:#fee2e2; color:#991b1b; }
        body.execdesk-mode .execdesk-app-btn-edit    { background:#f3f4f6; color:#374151; }
        body.execdesk-mode .execdesk-app-item.status-approved { opacity:0.65; }
        body.execdesk-mode .execdesk-app-item.status-rejected { opacity:0.55; }
      `;
      document.head.appendChild(s);
    }

    el.appendChild(wrap);
    this._notifyBadge(counts.pending);
  },

  _renderItem(item, parentEl) {
    const card = document.createElement('div');
    card.className = `execdesk-app-item status-${item.status}`;
    const created = new Date(item.created_at).toLocaleString();
    card.innerHTML = `
      <div class="execdesk-app-item-header">
        <span class="execdesk-app-item-source" style="background:${item.source_color || '#6b7280'};">${item.source_label || item.source || 'EXEC'}</span>
        <span class="execdesk-app-item-action">${item.action || ''}</span>
        <span class="execdesk-app-item-time">${created}</span>
      </div>
      <div class="execdesk-app-item-title">${item.title || '(no title)'}</div>
      <div class="execdesk-app-item-summary">${item.summary || ''}</div>
      ${item.payload_preview ? `<div class="execdesk-app-item-preview">${item.payload_preview}</div>` : ''}
      ${item.gate_reason ? `<div class="execdesk-app-item-gate">⚠️ ${item.gate_reason}</div>` : ''}
      ${item.status === 'pending' ? `
        <div class="execdesk-app-item-actions">
          <button class="execdesk-app-btn execdesk-app-btn-approve" data-action="approve">Approve</button>
          <button class="execdesk-app-btn execdesk-app-btn-reject" data-action="reject">Reject</button>
          <button class="execdesk-app-btn execdesk-app-btn-edit" data-action="edit">Edit</button>
        </div>
      ` : `<div style="font-size:12px; color:#6b7280;">Status: <strong>${item.status}</strong></div>`}
    `;

    card.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const items = this.load();
        const i = items.find((x) => x.id === item.id);
        if (!i) return;
        if (btn.dataset.action === 'approve') i.status = 'approved';
        if (btn.dataset.action === 'reject') i.status = 'rejected';
        if (btn.dataset.action === 'edit') {
          const newTitle = prompt('Edit title:', i.title);
          if (newTitle != null) i.title = newTitle;
        }
        this.save(items);
        this.render(parentEl);
      });
    });
    return card;
  },
};

window.ExecDeskApproval = ExecDeskApprovalView; // skills can call .enqueue() from anywhere

if (typeof Router !== 'undefined') {
  Router.register('/execdesk-approval', (el) => ExecDeskApprovalView.render(el), ExecDeskApprovalView);
}
