/**
 * Reusable UI components for the dashboard
 */

// Prefer the shared escaper (safe.js → window.VodouSafe); fall back if absent.
const _esc = (s) =>
  (typeof window !== 'undefined' && window.VodouSafe && window.VodouSafe.escapeHtml)
    ? window.VodouSafe.escapeHtml(s)
    : String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Collect focusable descendants for the modal focus trap.
const _focusables = (root) =>
  Array.prototype.slice.call(root.querySelectorAll(
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter((el) => el.offsetParent !== null || el === document.activeElement);

const Components = {
  /**
   * Create a page header with title and optional action buttons
   */
  pageHeader(title, subtitle, actions, opts) {
    const header = document.createElement('div');
    header.className = 'page-header';

    const left = document.createElement('div');
    const allowHtml = !!(opts && opts.html);
    const h2 = document.createElement('h2');
    h2.className = 'page-title';
    if (allowHtml) h2.innerHTML = title == null ? '' : String(title);
    else h2.textContent = title == null ? '' : String(title);
    left.appendChild(h2);
    if (subtitle) {
      const sub = document.createElement('span');
      sub.className = 'page-subtitle';
      if (allowHtml) sub.innerHTML = String(subtitle);
      else sub.textContent = String(subtitle);
      left.appendChild(sub);
    }

    header.appendChild(left);

    if (actions) {
      const right = document.createElement('div');
      right.className = 'page-actions';
      right.appendChild(actions);
      header.appendChild(right);
    }

    return header;
  },

  /**
   * Status dot (green/red/yellow)
   */
  statusDot(status) {
    const dot = document.createElement('span');
    dot.className = 'status-dot-indicator';
    if (status === 'healthy' || status === true || status === 1) {
      dot.classList.add('status-ok');
    } else if (status === 'degraded' || status === 'warning') {
      dot.classList.add('status-warn');
    } else {
      dot.classList.add('status-err');
    }
    return dot;
  },

  /**
   * Toggle switch
   */
  toggle(checked, onChange) {
    const label = document.createElement('label');
    label.className = 'toggle-switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    const slider = document.createElement('span');
    slider.className = 'toggle-slider';
    label.appendChild(input);
    label.appendChild(slider);
    return label;
  },

  /**
   * Badge with count
   */
  badge(text, variant) {
    const span = document.createElement('span');
    span.className = `badge badge-${variant || 'default'}`;
    span.textContent = text;
    return span;
  },

  /**
   * Simple confirm dialog
   */
  async confirm(message) {
    return window.confirm(message);
  },

  /**
   * In-app confirm modal (works where window.confirm is blocked or easy to miss).
   * @param {string} message
   * @param {{ title?: string, confirmLabel?: string, cancelLabel?: string, danger?: boolean }} [options]
   * @returns {Promise<boolean>}
   */
  confirmModal(message, options) {
    const o = options || {};
    const title = o.title || 'Confirm';
    const confirmLabel = o.confirmLabel || 'OK';
    const cancelLabel = o.cancelLabel || 'Cancel';
    const danger = !!o.danger;
    return new Promise((resolve) => {
      const prevFocus = document.activeElement;
      const overlay = document.createElement('div');
      overlay.style.cssText =
        'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1100;';
      const modal = document.createElement('div');
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-label', title);
      modal.style.cssText =
        'background:var(--bg-secondary);border:1px solid var(--border-primary);border-radius:8px;padding:24px;width:420px;max-width:90vw;';
      modal.addEventListener('click', (e) => e.stopPropagation());

      const h = document.createElement('div');
      h.style.cssText = 'font-weight:600;color:var(--text-primary);margin-bottom:12px;font-size:16px;';
      h.textContent = title;

      const p = document.createElement('div');
      p.style.cssText = 'color:var(--text-secondary);font-size:14px;line-height:1.45;white-space:pre-wrap;';
      p.textContent = message;

      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:20px;';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn btn-sm';
      cancelBtn.textContent = cancelLabel;

      const okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.className = danger ? 'btn btn-sm' : 'btn btn-primary btn-sm';
      if (danger) {
        okBtn.style.cssText = 'background:var(--error);color:#fff;border-color:var(--error);';
      }
      okBtn.textContent = confirmLabel;

      function finish(val) {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        if (prevFocus && typeof prevFocus.focus === 'function') {
          try { prevFocus.focus(); } catch (_) {}
        }
        resolve(val);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); finish(false); return; }
        if (e.key === 'Tab') {
          const items = _focusables(modal);
          if (!items.length) return;
          const first = items[0];
          const last = items[items.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault(); last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault(); first.focus();
          }
        }
      }

      cancelBtn.addEventListener('click', () => finish(false));
      okBtn.addEventListener('click', () => finish(true));
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) finish(false);
      });
      document.addEventListener('keydown', onKey, true);

      btnRow.appendChild(cancelBtn);
      btnRow.appendChild(okBtn);
      modal.appendChild(h);
      modal.appendChild(p);
      modal.appendChild(btnRow);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      (danger ? cancelBtn : okBtn).focus();
    });
  },

  /**
   * Styled destructive confirm — drop-in replacement for window.confirm on
   * delete/disable/etc. Red confirm button, Cancel focused first.
   * @param {string} message
   * @param {{ title?: string, confirmLabel?: string, cancelLabel?: string }} [opts]
   * @returns {Promise<boolean>}
   */
  dangerConfirm(message, opts) {
    const o = opts || {};
    return this.confirmModal(message, {
      title: o.title || 'Are you sure?',
      confirmLabel: o.confirmLabel || 'Delete',
      cancelLabel: o.cancelLabel || 'Cancel',
      danger: true,
    });
  },

  /**
   * Generic sheet modal — used by Apps + Messaging detail views.
   * Opens a centered modal with icon + title + subtitle header, scrollable body,
   * and a sticky footer for action buttons. Returns a `{ close, body, footer, overlay }`
   * handle so callers can inject dynamic content after open, or force-close from code.
   *
   * @param {{
   *   iconHtml?: string, title: string, subtitle?: string,
   *   sizeClass?: 'modal-content-sm'|'modal-content-lg'|'',
   *   onClose?: () => void, closeOnBackdrop?: boolean,
   * }} opts
   */
  openModal(opts) {
    const o = opts || {};
    const prevFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay modal-overlay-blur';

    const content = document.createElement('div');
    content.className = 'modal-content modal-sheet ' + (o.sizeClass || '');
    content.setAttribute('role', 'dialog');
    content.setAttribute('aria-modal', 'true');
    if (o.title) content.setAttribute('aria-label', o.title);
    content.addEventListener('click', (e) => e.stopPropagation());

    const header = document.createElement('div');
    header.className = 'modal-header modal-sheet-header';
    const headerLeft = document.createElement('div');
    headerLeft.className = 'modal-sheet-header-left';
    if (o.iconHtml) {
      const ic = document.createElement('div');
      ic.className = 'modal-sheet-icon';
      ic.innerHTML = o.iconHtml;
      headerLeft.appendChild(ic);
    }
    const headerText = document.createElement('div');
    headerText.className = 'modal-sheet-header-text';
    const titleEl = document.createElement('div');
    titleEl.className = 'modal-title';
    titleEl.textContent = o.title || '';
    headerText.appendChild(titleEl);
    if (o.subtitle) {
      const sub = document.createElement('div');
      sub.className = 'modal-sheet-subtitle';
      sub.innerHTML = o.subtitle;
      headerText.appendChild(sub);
    }
    headerLeft.appendChild(headerText);
    header.appendChild(headerLeft);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'modal-sheet-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
    header.appendChild(closeBtn);
    content.appendChild(header);

    const body = document.createElement('div');
    body.className = 'modal-body modal-sheet-body';
    content.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'modal-footer modal-sheet-footer';
    content.appendChild(footer);

    overlay.appendChild(content);

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.classList.add('modal-sheet-closing');
      if (prevFocus && typeof prevFocus.focus === 'function') {
        try { prevFocus.focus(); } catch (_) {}
      }
      setTimeout(() => {
        overlay.remove();
        if (typeof o.onClose === 'function') {
          try { o.onClose(); } catch (_) {}
        }
      }, 140);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'Tab') {
        const items = _focusables(content);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      }
    }

    closeBtn.addEventListener('click', close);
    if (o.closeOnBackdrop !== false) {
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    }
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
      overlay.classList.add('modal-sheet-open');
      const items = _focusables(content);
      (items[0] || closeBtn).focus();
    });

    return { overlay, content, header, body, footer, close };
  },

  /**
   * Loading spinner
   */
  loading() {
    const div = document.createElement('div');
    div.className = 'loading-container';
    div.innerHTML = '<div class="loading-spinner"></div>';
    return div;
  },

  /**
   * Help tooltip — small ? circle with hover tooltip
   */
  helpTip(text) {
    const el = document.createElement('span');
    el.className = 'help-tip';
    el.setAttribute('data-tooltip', text);
    el.textContent = '?';
    return el;
  },

  /**
   * Empty state message with optional action button
   */
  emptyState(message, actionLabel, actionHref) {
    const div = document.createElement('div');
    div.className = 'empty-state';
    div.textContent = message;
    if (actionLabel) {
      const btn = document.createElement('a');
      btn.className = 'btn btn-primary empty-state-action';
      btn.textContent = actionLabel;
      if (actionHref) btn.href = actionHref;
      div.appendChild(document.createElement('br'));
      div.appendChild(btn);
    }
    return div;
  },

  /**
   * Error message
   */
  errorState(message) {
    const div = document.createElement('div');
    div.className = 'error-state';
    div.textContent = message;
    return div;
  },

  /**
   * Create a data table
   */
  table(columns, rows, options) {
    const table = document.createElement('table');
    table.className = 'data-table';

    // Header
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const col of columns) {
      const th = document.createElement('th');
      th.textContent = col.label;
      if (col.width) th.style.width = col.width;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Body
    const tbody = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');
      if (options?.onRowClick) {
        tr.classList.add('clickable');
        tr.addEventListener('click', (e) => {
          // Don't trigger row click if clicking a button/toggle inside
          if (e.target.closest('button, label.toggle-switch, a')) return;
          options.onRowClick(row);
        });
      }
      for (const col of columns) {
        const td = document.createElement('td');
        if (col.render) {
          const content = col.render(row);
          if (content instanceof HTMLElement) {
            td.appendChild(content);
          } else {
            td.innerHTML = content;
          }
        } else {
          td.textContent = row[col.key] ?? '';
        }
        td.className = col.className || '';
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    return table;
  },

  /**
   * Pagination controls
   */
  pagination(offset, limit, total, onPageChange) {
    const div = document.createElement('div');
    div.className = 'pagination';

    const page = Math.floor(offset / limit) + 1;
    const totalPages = Math.ceil(total / limit);

    const prevBtn = document.createElement('button');
    prevBtn.className = 'btn btn-sm';
    prevBtn.textContent = 'Prev';
    prevBtn.disabled = page <= 1;
    prevBtn.addEventListener('click', () => onPageChange(offset - limit));

    const info = document.createElement('span');
    info.className = 'pagination-info';
    info.textContent = `Page ${page} of ${totalPages} (${total} total)`;

    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn btn-sm';
    nextBtn.textContent = 'Next';
    nextBtn.disabled = page >= totalPages;
    nextBtn.addEventListener('click', () => onPageChange(offset + limit));

    div.appendChild(prevBtn);
    div.appendChild(info);
    div.appendChild(nextBtn);

    return div;
  },

  /**
   * Toast notification
   */
  toast(message, type) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type || 'info'}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  },

  /**
   * Toast with an action button (e.g. "Chat closed" + "Undo").
   * onAction fires at most once; the toast dismisses on click or after timeoutMs.
   */
  toastAction(message, actionLabel, onAction, timeoutMs = 8000) {
    const toast = document.createElement('div');
    toast.className = 'toast toast-info toast-with-action';
    const text = document.createElement('span');
    text.textContent = message;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action-btn';
    btn.textContent = actionLabel;
    toast.appendChild(text);
    toast.appendChild(btn);
    document.body.appendChild(toast);

    let done = false;
    const dismiss = () => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    };
    btn.addEventListener('click', () => {
      if (done) return;
      done = true;
      dismiss();
      onAction();
    });
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => { if (!done) { done = true; dismiss(); } }, timeoutMs);
  },

  /**
   * Run an async action with button in-flight state: disables the button,
   * swaps its label to a busy variant (with spinner), restores in finally.
   * Re-entrancy guard via data-inflight. Returns asyncFn's resolved value.
   *
   * @param {HTMLButtonElement} btn
   * @param {() => Promise<any>} asyncFn
   * @param {{ label?: string }} [opts]  busy label (default derived from button text)
   */
  async withInflight(btn, asyncFn, opts) {
    const o = opts || {};
    if (!btn) return asyncFn();
    if (btn.dataset.inflight === '1') return;
    btn.dataset.inflight = '1';
    const prevHtml = btn.innerHTML;
    const wasDisabled = btn.disabled;
    btn.disabled = true;
    btn.classList.add('is-inflight');
    const busy = o.label || (btn.textContent.trim() ? btn.textContent.trim() + '…' : 'Working…');
    btn.innerHTML = '<span class="loading-spinner loading-spinner-inline"></span>' + _esc(busy);
    try {
      return await asyncFn();
    } finally {
      btn.innerHTML = prevHtml;
      btn.disabled = wasDisabled;
      btn.classList.remove('is-inflight');
      delete btn.dataset.inflight;
    }
  },
};
