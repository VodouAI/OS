/**
 * Connect → Browser — one row per capture site, graded.
 * PLAN-CAPTURE-GRADED-PER-SITE §3.6 (PLANS/0.6.31/01-…).
 *
 * Reads /api/capture/sites, which shells to `vodou-core capture --json` so the
 * console and the CLI print the SAME verdict for the same row. This file
 * renders; it never grades. The verdict words are translated through one map
 * before they reach the page, per the coherence rule that a raw enum never
 * lands in textContent.
 */
const BrowserCaptureView = {
  _days: 7,

  VERDICT: {
    alive: { label: 'Capturing', cls: 'ok', help: 'You used it this window and the gateway stored what you sent.' },
    broken: { label: 'Broken', cls: 'error', help: 'You sent messages here and nothing was stored. This is the row to act on.' },
    'broken (adapter drift)': { label: 'Broken — site changed', cls: 'error', help: 'Requests were seen that no capture adapter recognised. The site moved its endpoints.' },
    idle: { label: 'Open, nothing sent', cls: 'default', help: 'A tab was open but no message was sent — reading an old thread, probably.' },
    unknown: { label: 'Not visited', cls: 'default', help: 'You did not open this site in the window. That is a fact about you, not the site.' },
    disabled: { label: 'Disabled', cls: 'default', help: 'Capture is switched off for this site by policy.' },
    unmeasured: { label: 'Unmeasured', cls: 'default', help: 'No per-site heartbeat has reached this gateway yet.' },
  },

  destroy() {},

  async render(container) {
    container.innerHTML = '';
    container.appendChild(Components.pageHeader('Browser capture', 'Which sites the extension is actually capturing on'));
    container.appendChild(Components.loading());

    let data;
    try {
      const r = await fetch('/api/capture/sites?days=' + encodeURIComponent(this._days), { cache: 'no-store' });
      const body = await r.json();
      if (!r.ok || !body.ok) throw new Error((body.error && body.error.message) || ('HTTP ' + r.status));
      data = body.data;
    } catch (err) {
      container.innerHTML = '';
      container.appendChild(Components.pageHeader('Browser capture', 'Which sites the extension is actually capturing on'));
      container.appendChild(Components.errorState('Could not read the capture table: ' + err.message));
      return;
    }
    container.innerHTML = '';

    const alive = data.rows.filter((x) => x.verdict === 'alive').length;
    const visited = data.rows.filter((x) => x.visited).length;
    const sub = data.measured
      ? `${alive} capturing of ${visited} visited in the last ${data.window_days} days`
      : `Unmeasured — needs extension build ${data.min_ext_build} or newer connected to this gateway`;
    const header = Components.pageHeader('Browser capture', sub);
    header.querySelector('.page-title').appendChild(
      Components.helpTip('Every site the extension declares, graded from what it reported and what the gateway stored. "Not visited" is not a fault.')
    );
    container.appendChild(header);

    // Controls: window
    const bar = document.createElement('div');
    bar.className = 'logs-controls';
    const sel = document.createElement('select');
    sel.className = 'logs-control-select';
    for (const d of [3, 7, 14, 30]) {
      const o = document.createElement('option');
      o.value = String(d); o.textContent = 'Last ' + d + ' days';
      if (d === this._days) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => { this._days = Number(sel.value) || 7; this.render(container); });
    bar.appendChild(sel);
    if (!data.measured) {
      const note = document.createElement('span');
      note.className = 'text-secondary';
      note.textContent = 'Until a newer extension connects, only the "last capture" column is evidence.';
      bar.appendChild(note);
    }
    container.appendChild(bar);

    const V = this.VERDICT;
    const columns = [
      { label: 'Site', render: (r) => { const s = document.createElement('span'); s.textContent = r.label; s.title = r.capture; return s; } },
      { label: 'Status', render: (r) => {
          const v = V[r.verdict] || { label: r.verdict, cls: 'default', help: '' };
          const b = Components.badge(v.label, v.cls);
          b.title = v.help;
          return b;
        } },
      { label: 'Last capture', render: (r) => { const s = document.createElement('span'); s.className = 'mono'; s.textContent = r.history === 'never' ? 'never' : r.history; return s; } },
      { label: 'Ever', render: (r) => String(r.turns_ever) },
      { label: 'Window', render: (r) => String(r.turns_window) },
      { label: 'Seen / stored', render: (r) => data.measured ? `${r.seen} / ${r.stored}` : '—' },
      { label: 'Misses', render: (r) => data.measured ? String(r.miss_unmatched + r.miss_empty) : '—' },
      { label: 'Build / note', render: (r) => {
          const s = document.createElement('span');
          s.className = 'text-secondary';
          const bits = [];
          if (r.ext_build) bits.push(r.ext_build);
          if (r.note) bits.push(r.note);
          if (r.verdict.startsWith('broken') && r.miss_sig) bits.push('last miss ' + r.miss_sig);
          s.textContent = bits.join(' · ');
          return s;
        } },
    ];
    const order = { broken: 0, 'broken (adapter drift)': 0, alive: 1, idle: 2, disabled: 3, unknown: 4, unmeasured: 5 };
    const rows = data.rows.slice().sort((a, b) => {
      const d = (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9);
      if (d) return d;
      return (b.turns_ever || 0) - (a.turns_ever || 0);
    });
    const wrap = document.createElement('div');
    wrap.style.overflowX = 'auto';
    wrap.appendChild(Components.table(columns, rows));
    container.appendChild(wrap);

    const foot = document.createElement('p');
    foot.className = 'text-secondary';
    foot.textContent = 'Same table on the command line: vodou-core capture. A red row here exits 2 there.';
    container.appendChild(foot);
  },
};
