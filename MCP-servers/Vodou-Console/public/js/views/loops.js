/**
 * Open loops — what you promised and what you are owed.
 * PLAN-COMMITMENTS-LANE P3. Mounted as a tab inside the Activity shell.
 *
 * One rule shapes this view: a loop closes because a PERSON said so. Nothing
 * here infers completion, and the three buttons are the same three words the
 * channel reply accepts, applied by the same code in the engine.
 */
const LoopsView = {
  destroy() {},

  _kindLabel(kind) {
    // Never render a raw enum (coherence-guard Rule 1): a scope or kind the
    // user did not choose is a word only we understand.
    return {
      commitment: 'Promise',
      parked_ask: 'Parked question',
      blocked_verifier: 'Blocked check',
      disputed_fact: 'Disputed fact',
    }[kind] || 'Open item';
  },

  /**
   * One sentence per kind. "You said you would …" is only true of a promise:
   * on a parked question it read "You said you would post to #daily?", which is
   * neither something you said nor something you would do.
   */
  _title(kind, r, owed) {
    const what = r.what || '—';
    if (kind === 'parked_ask') return `Waiting on your answer: ${what}`;
    if (kind === 'blocked_verifier') return what;   // already a sentence: "<skill> stopped: …"
    if (kind === 'disputed_fact') return `Disputed: ${what}`;
    return owed
      ? `${r.party ? r.party : 'Someone'} owes you: ${what}`
      : `You said you would ${what}${r.party ? ` (for ${r.party})` : ''}`;
  },

  /** naive-UTC `YYYY-MM-DD HH:MM:SS` → local, the way the time canon says. */
  _due(dueAt) {
    if (!dueAt) return { text: 'no date', cls: 'muted' };
    const d = new Date(dueAt.replace(' ', 'T') + 'Z');
    if (Number.isNaN(d.getTime())) return { text: 'no date', cls: 'muted' };
    const days = Math.round((d - new Date()) / 86400000);
    const when = window.VodouTime.dateTime(d, '');
    if (days < 0) return { text: `overdue · ${when}`, cls: 'danger' };
    if (days === 0) return { text: `today · ${when}`, cls: 'warn' };
    return { text: when, cls: '' };
  },

  async render(container) {
    container.innerHTML = '';
    container.appendChild(Components.pageHeader('Open loops', 'Loading…'));
    container.appendChild(Components.loading());

    let data;
    try {
      data = await API.get('/api/loops?open=1');
    } catch (e) {
      container.innerHTML = '';
      container.appendChild(Components.pageHeader('Open loops', 'Could not read the ledger'));
      // A failed read is not "nothing to do" — say which it is.
      const err = document.createElement('div');
      err.className = 'empty-state';
      err.textContent = `The engine did not answer (${(e && e.message) || 'unknown'}). Your promises are still recorded — this view could not read them.`;
      container.appendChild(err);
      return;
    }

    const rows = (data && data.loops) || [];
    container.innerHTML = '';
    const sub = rows.length === 0
      ? 'Nothing open. Promises are picked up from what you say, on any surface.'
      : `${rows.length} open · closed only when you say so`;
    container.appendChild(Components.pageHeader('Open loops', sub));

    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No open loops. When you say “I’ll send Steve the deck Friday”, it lands here and reminds you on Friday.';
      container.appendChild(empty);
      return;
    }

    const list = document.createElement('div');
    list.className = 'loops-list';
    for (const l of rows) list.appendChild(this._row(l, container));
    container.appendChild(list);
  },

  _row(l, container) {
    const r = l.ref || {};
    const owed = r.direction === 'owed_to_me';
    const due = this._due(l.due_at);

    const row = document.createElement('div');
    row.className = 'card loops-row';
    row.style.cssText = 'display:flex;gap:12px;align-items:flex-start;justify-content:space-between;padding:12px 14px;margin-bottom:8px;';

    const left = document.createElement('div');
    left.style.cssText = 'min-width:0;flex:1;';

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;margin-bottom:2px;word-break:break-word;';
    title.textContent = this._title(l.kind, r, owed);
    left.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'muted';
    meta.style.cssText = 'font-size:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;';
    meta.appendChild(Components.badge(this._kindLabel(l.kind), 'default'));
    const dueEl = document.createElement('span');
    dueEl.textContent = due.text;
    if (due.cls === 'danger') dueEl.style.color = 'var(--danger, #c0392b)';
    if (due.cls === 'warn') dueEl.style.color = 'var(--warn, #b8860b)';
    meta.appendChild(dueEl);
    if (l.host_opened) {
      const from = document.createElement('span');
      from.textContent = `from ${l.host_opened}`;
      meta.appendChild(from);
    }
    if (Array.isArray(l.snoozes) && l.snoozes.length) {
      const sn = document.createElement('span');
      sn.textContent = `snoozed ${l.snoozes.length}×`;
      meta.appendChild(sn);
    }
    left.appendChild(meta);

    // A completion report is EVIDENCE, never a verdict — the person confirms.
    if (r.close_reported && r.close_reported.evidence) {
      const ask = document.createElement('div');
      ask.style.cssText = 'margin-top:6px;font-size:12px;padding:6px 8px;border-radius:6px;background:var(--surface-2,#f4f4f5);';
      ask.textContent = `You mentioned: “${String(r.close_reported.evidence).slice(0, 140)}” — did you finish it?`;
      left.appendChild(ask);
    }

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;';
    const act = (label, action, cls) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn ${cls || ''}`;
      b.textContent = label;
      b.addEventListener('click', async () => {
        let when = '';
        if (action === 'snooze') {
          when = window.prompt('Snooze until when? (2h · tomorrow · friday)', 'tomorrow') || '';
          if (!when.trim()) return;
        }
        b.disabled = true;
        try {
          await API.post(`/api/loops/${l.id}/${action}`, { when });
          await this.render(container);
        } catch (e) {
          b.disabled = false;
          // The engine's refusal is the message worth showing ("I don't know
          // when 'blorp' is"), not a generic failure.
          alert((e && e.message) || 'Could not apply that.');
        }
      });
      return b;
    };
    actions.appendChild(act('Done', 'done', 'btn-primary'));
    actions.appendChild(act('Snooze', 'snooze'));
    actions.appendChild(act('Drop', 'drop'));

    row.appendChild(left);
    row.appendChild(actions);
    return row;
  },
};
