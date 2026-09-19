/**
 * Memory View — tabbed: Facts | Map | Imports
 *
 * PLAN-BRAIN-INTO-CONSOLE (PLANS/0.6.28): Memory and Brain are one surface.
 *   Facts   — the daily logs, searchable, editable (was "Timeline")
 *   Map     — the memory graph that used to live on :8767 (VodouBrain.mount)
 *   Imports — unchanged
 * The CDN mind map and the hidden Atlas are gone; the graph
 * supersedes both. Deep links: #/memory?tab=map&layout=chronicle&node=<id>.
 */

const MemoryView = {
  _searchTimer: null,
  _currentPath: null,
  _editing: false,
  _activeTab: 'timeline',
  _brain: null,          // VodouBrain handle while the Map tab is mounted

  /** Called by the router on navigation and by render() on re-entry — the D3
   *  simulation, its timers and document listeners must not outlive the tab. */
  destroy() {
    this._unmountBrain();
    clearTimeout(this._searchTimer);
    clearTimeout(this._liveSearchTimer);
  },

  _unmountBrain() {
    if (this._brain) {
      try { this._brain.destroy(); } catch (e) { console.error('[memory] brain destroy', e); }
      this._brain = null;
    }
  },

  /** Query part of #/memory?… — the hash router owns the hash, so no #anchor. */
  _hashParams() {
    const h = location.hash || '';
    return new URLSearchParams(h.includes('?') ? h.slice(h.indexOf('?') + 1) : '');
  },
  /** Reflect tab/layout/node in the URL without a hashchange (no re-render). */
  _syncHash(patch) {
    const q = this._hashParams();
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '' || (k === 'layout' && v === 'constellation') || (k === 'tab' && v === 'timeline')) q.delete(k);
      else q.set(k, v);
    }
    const qs = q.toString();
    history.replaceState(null, '', `${location.pathname}${location.search}#/memory${qs ? '?' + qs : ''}`);
  },

  async render(container) {
    container.innerHTML = '';
    this.destroy();
    this._currentPath = null;
    this._editing = false;

    // Page header with tabs
    const headerRow = document.createElement('div');
    headerRow.className = 'memory-header-row';

    const title = document.createElement('h2');
    title.className = 'page-title';
    title.textContent = 'Memory';
    title.appendChild(Components.helpTip("Vodou's brain \u2014 files where it stores what it learns about you, your projects, and past conversations."));
    headerRow.appendChild(title);

    // Quick link to extraction settings \u2014 most users find their way to /#/memory
    // when they want to tune what gets remembered, not /#/settings.
    const settingsLink = document.createElement('a');
    settingsLink.href = '#/settings?tab=memory';
    settingsLink.className = 'memory-header-settings-link';
    settingsLink.textContent = '\u2699 Extraction settings';
    settingsLink.title = 'Memory extraction sources, backend, benchmarks';
    settingsLink.style.cssText = 'margin-left:auto;font-size:12px;color:var(--text-muted);text-decoration:none;padding:4px 10px;border:1px solid var(--border-primary);border-radius:4px;';
    headerRow.appendChild(settingsLink);

    const tabs = document.createElement('div');
    tabs.className = 'memory-tabs';

    const timelineTab = document.createElement('button');
    timelineTab.className = 'memory-tab';
    timelineTab.textContent = 'Facts';
    timelineTab.title = 'Everything Vodou remembers, as text — search, read, edit, pin';
    timelineTab.dataset.tab = 'timeline';   // kept as `timeline` so old deep links resolve

    const mapTab = document.createElement('button');
    mapTab.className = 'memory-tab';
    mapTab.textContent = '\u2726 Map';
    mapTab.title = 'The same memory as a graph — constellation, chronicle, web of names, conflicts';
    mapTab.dataset.tab = 'map';

    // PLAN-BRAIN-INTO-CONSOLE P2.1 — the contradiction review queue, on the map.
    const conflictsTab = document.createElement('button');
    conflictsTab.className = 'memory-tab';
    conflictsTab.textContent = 'Conflicts';
    conflictsTab.title = 'Where one source of your memory disagrees with another — keep one side, or dismiss';
    conflictsTab.dataset.tab = 'conflicts';

    // PLAN-RECEIPTS-BROWSE-TAB P2 — every receipt, one page. Facts answers
    // "what do you remember"; this answers "did any of it reach the AI?"
    const receiptsTab = document.createElement('button');
    receiptsTab.className = 'memory-tab';
    receiptsTab.textContent = 'Receipts';
    receiptsTab.title = 'What actually reached the AI, per turn, across every conversation — including the scheduled ones nobody opens';
    receiptsTab.dataset.tab = 'receipts';

    // PLAN-UNIVERSAL-MEMORY Phase 5 — Imports management tab (jobs, capture, review).
    const importsTab = document.createElement('button');
    importsTab.className = 'memory-tab';
    importsTab.textContent = 'Imports';
    importsTab.dataset.tab = 'imports';

    // §4.5.2 — the Pinned tab. `GET /api/memory/pinned` has existed since the
    // day it was written, with the comment "for a future 'Pinned' tab". This is
    // that tab. It is direct CRUD on pins with no diffing and no render in the
    // loop, which is exactly the surface you want when the edit-to-pin path
    // itself is broken — defence in depth, not decoration.
    const pinnedTab = document.createElement('button');
    pinnedTab.className = 'memory-tab';
    pinnedTab.textContent = 'Pinned';
    pinnedTab.title = 'The facts you told Vodou to always keep. Ranking cannot demote a pin, so these outrank everything else in every session.';
    pinnedTab.dataset.tab = 'pinned';

    // PLAN-PEOPLE-PAGES P0 — the Names tab. memory.db has resolved every
    // person, organisation and project in the corpus since WEB-OF-NAMES
    // shipped; the map draws them as stars. This is the list of who matters
    // this week and a page that reads as a person rather than a graph.
    //
    // Labelled "Names", not "People": two of the top six rows are usually
    // organisations, so "People" undersells it, and "People & things" leans on
    // a weak noun in a row of one-word nouns (Facts, Pinned, Map, Conflicts,
    // Receipts, Imports). "Names" is the product's own word — the map layout
    // is "Web of names" — and it is the honest superset. The tab KEY stays
    // `people` so every existing `#/memory?tab=people…` deep link still
    // resolves; only the word changes.
    const peopleTab = document.createElement('button');
    peopleTab.className = 'memory-tab';
    peopleTab.textContent = 'Names';
    peopleTab.title = 'Every name your memory has resolved — people, orgs, projects — ranked by who matters this week, each with a page';
    peopleTab.dataset.tab = 'people';

    // PLAN-LOOPS-THAT-READ-THE-RECEIPTS P2 — the two queues the use ledger
    // produces. It sits beside Conflicts because it asks the same kind of
    // question: two sources disagree there, and here the evidence disagrees
    // with a fact's standing. Nothing on this tab deletes anything.
    const reviewTab = document.createElement('button');
    reviewTab.className = 'memory-tab';
    reviewTab.textContent = 'Review';
    reviewTab.title = 'Facts that are load-bearing in the prompt and never load-bearing in an answer, and facts you have corrected more than once';
    reviewTab.dataset.tab = 'review';

    tabs.appendChild(timelineTab);
    tabs.appendChild(pinnedTab);
    tabs.appendChild(peopleTab);
    tabs.appendChild(mapTab);
    tabs.appendChild(conflictsTab);
    tabs.appendChild(reviewTab);
    tabs.appendChild(receiptsTab);
    tabs.appendChild(importsTab);
    headerRow.appendChild(tabs);
    container.appendChild(headerRow);

    // PLAN-MEMORY-VISIBILITY-UI Phase C — live search panel above tabs.
    // Available regardless of which tab is active. Wrapped in try/catch so any
    // failure here can't block the Timeline/MindMap render below.
    try {
      this._renderLiveSearchPanel(container);
    } catch (err) {
      console.error('[memory] live search panel render failed:', err);
    }

    // Tab content area
    const tabContent = document.createElement('div');
    tabContent.id = 'memory-tab-content';
    container.appendChild(tabContent);

    // Tab click handlers
    const self = this;
    // Every tab appended above must be here, or it renders and does nothing when
    // clicked — Review did exactly that from P2 until 2026-09-14 (reachable only
    // by a #/memory?tab=review deep link). memory-tabs-wired.test.ts holds this.
    const allTabs = [timelineTab, pinnedTab, peopleTab, mapTab, conflictsTab, reviewTab, receiptsTab, importsTab];
    function activate(name) {
      allTabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
      self._showTab(name, tabContent);
    }
    allTabs.forEach((tab) => tab.addEventListener('click', () => {
      self._syncHash({ tab: tab.dataset.tab, layout: null, node: null, lane: null, q: null, entity: null });
      activate(tab.dataset.tab);
    }));

    // Default tab: the deep link if there is one (#/memory?tab=map…), else Facts.
    const asked = this._hashParams().get('tab');
    activate(['map', 'imports', 'conflicts', 'receipts', 'pinned', 'people', 'review'].includes(asked) ? asked : 'timeline');
  },

  _showTab(name, container) {
    this._unmountBrain();
    this._activeTab = name;
    // The live-search strip (tag sparkline + query box + tag/date chips) is a
    // TEXT search over the same memories. On the Map it is redundant twice over
    // — the graph has ⌘K and the left rail already carries kind, vault and date
    // filters — and it costs the graph ~200px of the viewport it needs most.
    // Hidden, not removed: Facts, Receipts and Imports still lead with it.
    const strip = document.getElementById('memory-live-search-panel');
    if (strip) strip.hidden = (name === 'map' || name === 'conflicts' || name === 'pinned' || name === 'people' || name === 'review');
    if (name === 'pinned') return this._renderPinned(container);
    if (name === 'people') return this._renderPeople(container);
    if (name === 'map') return this._renderMap(container);
    if (name === 'conflicts') return this._renderMap(container, { conflicts: true });
    if (name === 'review') return this._renderReview(container);
    if (name === 'imports') return this._renderImports(container);
    if (name === 'receipts') return this._renderReceipts(container);
    return this._renderTimeline(container);
  },

  // ===== PEOPLE TAB — PLAN-PEOPLE-PAGES P0/P1/P4/P5 =====
  //
  // Two columns that stretch (brief §5.9): the ranked list on the left, one
  // page on the right. Both read `/api/memory/entities*`, which the gateway
  // answers by asking the daemon — the same Rust `page()` the CLI and the MCP
  // lookup tool use. Nothing here computes; it only translates: kinds and
  // predicates through VodouVocabulary (coherence: no raw enum reaches the
  // eye), hosts through scopeLabel, facts through the shared MemoryRow.
  _peopleKind: '',

  /**
   * PLAN-LOOPS P2 — Review. Two queues, both of which ASK.
   *
   * The counters come from `memory_chunk_use`: what happened to each fact after
   * it was shown to a model. A fact here is not wrong and is not scheduled for
   * anything; it is a fact whose evidence and whose standing have drifted
   * apart, and the only action is one a person takes.
   */
  async _renderReview(container) {
    container.innerHTML = '';
    container.appendChild(Components.pageHeader('Review', 'Loading\u2026'));
    container.appendChild(Components.loading());

    let d;
    try {
      d = await API.get('/api/memory/queues');
    } catch (e) {
      container.innerHTML = '';
      container.appendChild(Components.pageHeader('Review', 'Could not read the ledger'));
      const err = document.createElement('div');
      err.className = 'empty-state';
      // "Nothing to review" and "could not look" are different answers.
      err.textContent = `The engine did not answer (${(e && e.message) || 'unknown'}). That is not "nothing to review" \u2014 it is "could not look".`;
      container.appendChild(err);
      return;
    }

    const load = (d && d.load_bearing) || [];
    const disputed = (d && d.disputed) || [];
    container.innerHTML = '';
    container.appendChild(Components.pageHeader(
      'Review',
      (load.length + disputed.length) === 0
        ? 'Nothing to review. Facts earn their place by being used.'
        : `${load.length} never confirmed \u00b7 ${disputed.length} disputed`,
    ));

    const section = (title, why, rows, emptyLine) => {
      const h = document.createElement('h3');
      h.textContent = title;
      h.style.cssText = 'margin:18px 0 4px;font-size:14px;';
      container.appendChild(h);
      const sub = document.createElement('div');
      sub.className = 'muted';
      sub.style.cssText = 'font-size:12px;margin-bottom:8px;';
      sub.textContent = why;
      container.appendChild(sub);
      if (!rows.length) {
        const e = document.createElement('div');
        e.className = 'empty-state';
        e.textContent = emptyLine;
        container.appendChild(e);
        return;
      }
      for (const r of rows.slice(0, 50)) {
        const card = document.createElement('div');
        card.className = 'card';
        card.style.cssText = 'padding:10px 12px;margin-bottom:6px;';
        const t = document.createElement('div');
        t.style.cssText = 'word-break:break-word;margin-bottom:4px;';
        t.textContent = r.text || '(the fact behind this row is gone)';
        const m = document.createElement('div');
        m.className = 'muted';
        m.style.cssText = 'font-size:12px;';
        m.textContent = `shown ${r.injected}\u00d7 \u00b7 quoted back ${r.cited}\u00d7 \u00b7 corrected ${r.corrected}\u00d7`;
        card.appendChild(t);
        card.appendChild(m);
        container.appendChild(card);
      }
      if (rows.length > 50) {
        const more = document.createElement('div');
        more.className = 'muted';
        more.style.cssText = 'font-size:12px;';
        more.textContent = `+${rows.length - 50} more`;
        container.appendChild(more);
      }
    };

    section(
      'Load-bearing, never confirmed',
      'Shown to a model at least ten times, never once quoted back, and older than ninety days. One citation is enough to keep a fact off this list.',
      load,
      'Nothing. Every fact that gets shown often is also getting used.',
    );
    section(
      'Disputed',
      'You have corrected this more than once. Each of these is also an open loop, so it will meet you at your next session.',
      disputed,
      'Nothing. No fact has been corrected more than once.',
    );

    const foot = document.createElement('div');
    foot.className = 'muted';
    foot.style.cssText = 'margin-top:18px;font-size:12px;';
    foot.textContent = 'Nothing here is demoted or deleted. Correct a fact in chat, or run `vodou-core mem queues` for the same two lists.';
    container.appendChild(foot);
  },

  async _renderPeople(container) {
    container.innerHTML = '<div class="loading-container"><div class="loading-spinner"></div></div>';
    const E = globalThis.VodouEntityVocabulary;
    let data;
    try {
      data = await API.get('/api/memory/entities?limit=200');
    } catch (e) {
      container.innerHTML = '<div class="error-state">Could not load people: ' + this._escapeHtml(e.message || String(e)) + '</div>';
      return;
    }
    const all = Array.isArray(data?.entities) ? data.entities : [];
    container.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'people-wrap';
    container.appendChild(wrap);

    // ── left: the list ──
    const left = document.createElement('div');
    left.className = 'people-list-col';
    wrap.appendChild(left);

    const intro = document.createElement('p');
    intro.className = 'settings-note';
    intro.textContent = all.length
      ? 'Ranked by who matters this week — the same recency steps the ranker uses, so two mentions on Tuesday outrank forty in March.'
      : 'No names yet. Vodou resolves names from your memory once a day; run `vodou-core mem entities scan` to do it now.';
    left.appendChild(intro);

    const chips = document.createElement('div');
    chips.className = 'people-kinds';
    const kindChoices = [['', 'All'], ['person', E.KIND_LABEL.person], ['org', E.KIND_LABEL.org], ['project', E.KIND_LABEL.project]];
    for (const [k, label] of kindChoices) {
      const b = document.createElement('button');
      b.className = 'memory-chip' + (this._peopleKind === k ? ' active' : '');
      b.textContent = label;
      b.addEventListener('click', () => { this._peopleKind = k; this._renderPeople(container); });
      chips.appendChild(b);
    }
    left.appendChild(chips);

    const list = document.createElement('div');
    list.className = 'people-list';
    left.appendChild(list);

    // ── right: the page ──
    const detail = document.createElement('div');
    detail.className = 'people-detail';
    wrap.appendChild(detail);

    const rows = this._peopleKind ? all.filter((r) => r.kind === this._peopleKind) : all;
    const asked = parseInt(this._hashParams().get('entity') || '', 10);
    let selected = Number.isFinite(asked) ? asked : (rows[0] ? rows[0].id : null);

    const select = (id, push) => {
      selected = id;
      for (const el of list.querySelectorAll('.people-row')) el.classList.toggle('active', Number(el.dataset.id) === id);
      if (push) this._syncHash({ entity: id });
      this._renderPeopleDetail(detail, id);
    };

    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'people-empty';
      empty.textContent = 'Nothing of this kind has a live mention.';
      list.appendChild(empty);
    }
    for (const r of rows) {
      const row = document.createElement('button');
      row.className = 'people-row' + (r.id === selected ? ' active' : '');
      row.dataset.id = String(r.id);
      const name = document.createElement('span');
      name.className = 'people-row-name';
      name.textContent = r.canonical;
      const kind = document.createElement('span');
      kind.className = 'people-kind';
      kind.textContent = E.kindLabel(r.kind, true);
      const meta = document.createElement('span');
      meta.className = 'people-row-meta';
      meta.textContent = `${r.mentions} · ${r.last_at ? String(r.last_at).slice(0, 10) : '—'}`;
      meta.title = `${r.mentions} mention${r.mentions === 1 ? '' : 's'}${r.last_at ? ', last ' + r.last_at : ''}`;
      row.append(name, kind, meta);
      row.addEventListener('click', () => select(r.id, true));
      list.appendChild(row);
    }

    if (selected != null) this._renderPeopleDetail(detail, selected);
    else detail.innerHTML = '<div class="people-empty">Pick a name to open its page.</div>';
  },

  async _renderPeopleDetail(pane, id) {
    pane.innerHTML = '<div class="loading-container"><div class="loading-spinner"></div></div>';
    const V = globalThis.VodouVocabulary;
    const E = globalThis.VodouEntityVocabulary;
    let p;
    try {
      p = await API.get('/api/memory/entities/' + encodeURIComponent(id));
    } catch (e) {
      pane.innerHTML = '<div class="error-state">Could not load this page: ' + this._escapeHtml(e.message || String(e)) + '</div>';
      return;
    }
    pane.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'people-detail-head';
    const h = document.createElement('h3');
    h.textContent = p.canonical;
    const kind = document.createElement('span');
    kind.className = 'people-kind';
    kind.textContent = E.kindLabel(p.kind, true);
    const mapLink = document.createElement('a');
    mapLink.className = 'btn btn-sm';
    mapLink.href = '#/memory?tab=map&layout=web&node=' + encodeURIComponent('entity:' + p.id);
    mapLink.textContent = 'Open on map';
    mapLink.title = 'The same name as a graph — who it turns up with';
    head.append(h, kind, mapLink);
    pane.appendChild(head);

    if (p.aliases && p.aliases.length) {
      const al = document.createElement('div');
      al.className = 'people-aliases';
      al.textContent = 'Also: ' + p.aliases.join(', ');
      pane.appendChild(al);
    }

    const stats = document.createElement('div');
    stats.className = 'people-stats';
    const total = p.mentions?.total ?? 0;
    stats.textContent = `${total} mention${total === 1 ? '' : 's'}` + (p.mentions?.last_at ? ` · last ${String(p.mentions.last_at).slice(0, 16)}` : '');
    pane.appendChild(stats);

    const hosts = Object.entries(p.mentions?.by_host || {}).sort((a, b) => b[1] - a[1]);
    if (hosts.length) {
      const hs = document.createElement('div');
      hs.className = 'people-hosts';
      for (const [host, n] of hosts) {
        const c = document.createElement('span');
        c.className = 'memory-chip';
        c.textContent = `${V.scopeLabel(host)} · ${n}`;
        c.title = host;
        hs.appendChild(c);
      }
      pane.appendChild(hs);
    }

    // ── P6: add a memory about this name ──
    //
    // The page stays a view: this writes nothing to memory.db itself. The text
    // goes into the reviewed capture lane (`POST /api/capture/remember`, the
    // same door `remember` / vc_remember use), extraction distils and tags it,
    // and the daily entity scan links it to this page by the name in it — so
    // the name is put into the text when the person left it out.
    const addWrap = document.createElement('div');
    addWrap.className = 'people-add';
    const addInput = document.createElement('input');
    addInput.type = 'text';
    addInput.className = 'form-input';
    addInput.placeholder = `Add a memory about ${p.canonical}\u2026`;
    addInput.setAttribute('aria-label', `Add a memory about ${p.canonical}`);
    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-sm btn-primary';
    addBtn.textContent = 'Remember';
    const addNote = document.createElement('div');
    addNote.className = 'people-panel-note';
    addNote.textContent = 'Goes through the capture lane: it is distilled and tagged, and appears here after the next daily name scan.';
    const submitAdd = async () => {
      let text = addInput.value.trim();
      if (text.length < 4) { Components.toast('Too short to remember', 'warning'); return; }
      const names = [p.canonical, ...(p.aliases || [])].map((n) => String(n).toLowerCase());
      if (!names.some((n) => text.toLowerCase().includes(n))) text = `${p.canonical}: ${text}`;
      addBtn.disabled = true;
      try {
        await API.post('/api/capture/remember', { text, source: 'people-page' });
        addInput.value = '';
        Components.toast(`Saved to the capture lane \u2014 it reaches ${p.canonical}'s page after the next name scan`, 'success');
      } catch (e) {
        Components.toast('Could not save: ' + (e.message || e), 'error');
      } finally {
        addBtn.disabled = false;
      }
    };
    addBtn.addEventListener('click', submitAdd);
    addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAdd(); });
    addWrap.append(addInput, addBtn);
    pane.appendChild(addWrap);
    pane.appendChild(addNote);

    // ── relations (P4) ──
    const rel = document.createElement('section');
    rel.className = 'people-section';
    const rh = document.createElement('h4');
    rh.textContent = 'Connections';
    rel.appendChild(rh);
    if (!p.relations || !p.relations.length) {
      const none = document.createElement('div');
      none.className = 'people-panel-note';
      none.textContent = 'No typed connection judged yet — co-mentions are on the map.';
      rel.appendChild(none);
    } else {
      const ul = document.createElement('ul');
      ul.className = 'people-relations';
      for (const r of p.relations) {
        const li = document.createElement('li');
        li.className = 'people-relation';
        const pred = document.createElement('span');
        pred.className = 'pred';
        pred.textContent = r.direction === 'out' ? `${E.predicateLabel(r.predicate)} → ` : `← ${E.predicateLabel(r.predicate)} `;
        const other = document.createElement('a');
        other.href = '#/memory?tab=people&entity=' + encodeURIComponent(r.other_id);
        other.textContent = r.other_canonical;
        other.addEventListener('click', (ev) => {
          ev.preventDefault();
          this._syncHash({ entity: r.other_id });
          const container = document.getElementById('memory-tab-content');
          if (container) this._renderPeople(container);
        });
        const okind = document.createElement('span');
        okind.className = 'people-kind';
        okind.textContent = E.kindLabel(r.other_kind, true);
        li.append(pred, other, ' ', okind);
        if (r.evidence_chunk_id) {
          const ev = document.createElement('a');
          ev.className = 'people-evidence';
          ev.href = '#/memory?tab=map&layout=web&node=' + encodeURIComponent(r.evidence_chunk_id);
          ev.textContent = 'evidence';
          ev.title = r.evidence_chunk_id;
          li.append(' · ', ev);
        }
        ul.appendChild(li);
      }
      rel.appendChild(ul);
    }
    pane.appendChild(rel);

    // ── open loops (P5) — `unmeasured` is a state, not an empty list ──
    const loops = document.createElement('section');
    loops.className = 'people-section';
    const lh = document.createElement('h4');
    lh.textContent = 'You promised';
    loops.appendChild(lh);
    const ol = p.open_loops || { state: 'unmeasured', items: [] };
    if (ol.state !== 'ok') {
      const note = document.createElement('div');
      note.className = 'people-panel-note';
      note.textContent = ol.state === 'unmeasured'
        ? 'Unmeasured — ' + (ol.note || 'commitments are not extracted yet') + '.'
        : `Unknown${ol.note ? ' — ' + ol.note : ''}.`;
      loops.appendChild(note);
    } else if (!ol.items.length) {
      const none = document.createElement('div');
      none.className = 'people-panel-note';
      none.textContent = 'No open commitment involving this name.';
      loops.appendChild(none);
    } else {
      const ul = document.createElement('ul');
      ul.className = 'people-relations';
      for (const it of ol.items) {
        const li = document.createElement('li');
        li.textContent = `${it.direction === 'owed_to_me' ? 'They owe you' : 'You owe'}: ${it.what}` + (it.due_text ? ` (${it.due_text})` : '');
        ul.appendChild(li);
      }
      loops.appendChild(ul);
    }
    pane.appendChild(loops);

    // ── facts — the shared row, superseded ones struck, never hidden ──
    const facts = document.createElement('section');
    facts.className = 'people-section';
    const fh = document.createElement('h4');
    fh.textContent = `What you know (${(p.facts || []).length})`;
    facts.appendChild(fh);
    if (!p.facts || !p.facts.length) {
      const none = document.createElement('div');
      none.className = 'people-panel-note';
      none.textContent = 'No live fact mentions this name.';
      facts.appendChild(none);
    }
    for (const f of (p.facts || [])) {
      const rowEl = window.MemoryRow.render({
        id: f.chunk_id,
        chunk_id: f.chunk_id,
        // A fact is stored as the markdown bullet it was written as; on a
        // page (not a log) the bullet is noise.
        text: String(f.text || '').replace(/^\s*[-*]\s+/, ''),
        path: f.path,
        chunk_tag: f.tag,
        chunk_scope: f.scope,
        created_at: f.valid_at || f.created_at,
      }, { allowPin: false });
      if (f.invalid_at) {
        rowEl.classList.add('people-fact-superseded');
        rowEl.title = 'Superseded ' + f.invalid_at;
      }
      facts.appendChild(rowEl);
    }
    pane.appendChild(facts);
  },

  // ===== PINNED TAB — PLAN-CONTEXT-THAT-MAINTAINS-ITSELF §4.5.2 =====
  //
  // Every pin, with add / edit / delete / re-section, straight against the
  // corpus. No diff, no render in the loop: when the primary hatch (edit-to-pin
  // in the file viewer) is broken, this is the one that still works.
  _pinSections: ['Boundaries', 'Identity', 'Preferences', 'Decisions', 'Notes', 'Heartbeat'],

  async _renderPinned(container) {
    container.innerHTML = '<div class="loading-container"><div class="loading-spinner"></div></div>';
    let rows = [];
    try {
      rows = await API.get('/api/memory/pinned');
    } catch (e) {
      container.innerHTML = '<div class="error-state">Could not load pins: ' + this._escapeHtml(e.message || String(e)) + '</div>';
      return;
    }
    container.innerHTML = '';

    const intro = document.createElement('p');
    intro.className = 'settings-note';
    intro.textContent = rows.length
      ? 'These outrank everything else in every session. Ranking cannot demote a pin — only you can remove one.'
      : 'Nothing is pinned yet. A pin is a fact you want in every session, in your words.';
    container.appendChild(intro);

    // ── add ──
    const addRow = document.createElement('div');
    addRow.className = 'settings-row';
    addRow.classList.add('memory-pin-add');
    const sectionSel = document.createElement('select');
    sectionSel.className = 'form-select';
    for (const sec of this._pinSections) {
      const o = document.createElement('option');
      o.value = sec; o.textContent = sec;
      sectionSel.appendChild(o);
    }
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-input';
    input.placeholder = 'A fact worth repeating in every session\u2026';
    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-sm btn-primary';
    addBtn.textContent = 'Pin it';
    const submit = async () => {
      const text = input.value.trim();
      if (text.length < 4) { Components.toast('Too short to pin', 'warning'); return; }
      addBtn.disabled = true;
      try {
        await API.post('/api/memory/pin', { text, section: sectionSel.value });
        input.value = '';
        Components.toast('Pinned', 'success');
        this._renderPinned(container);
      } catch (e) {
        Components.toast('Could not pin: ' + (e.message || e), 'error');
        addBtn.disabled = false;
      }
    };
    addBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    addRow.append(sectionSel, input, addBtn);
    container.appendChild(addRow);

    if (!rows.length) return;

    // ── list, grouped by the section the render will put them under ──
    const bySection = new Map();
    for (const r of rows) {
      const sec = this._sectionForTag(r.chunk_tag);
      if (!bySection.has(sec)) bySection.set(sec, []);
      bySection.get(sec).push(r);
    }
    for (const sec of this._pinSections) {
      const list = bySection.get(sec);
      if (!list || !list.length) continue;
      const h = document.createElement('h3');
      h.className = 'section-title';
      h.textContent = sec;
      container.appendChild(h);

      for (const r of list) {
        const row = document.createElement('div');
        row.className = 'memory-pin-row';

        const text = document.createElement('div');
        text.className = 'memory-pin-text';
        text.textContent = r.text;
        row.appendChild(text);

        const move = document.createElement('select');
        move.className = 'form-select';
        move.classList.add('memory-pin-move');
        move.title = 'Move to another section';
        for (const s2 of this._pinSections) {
          const o = document.createElement('option');
          o.value = s2; o.textContent = s2;
          if (s2 === sec) o.selected = true;
          move.appendChild(o);
        }
        move.addEventListener('change', async () => {
          try {
            // Re-pin under the new section, then drop the old row: one pin, one
            // section, and the id is derived from the text so this is stable.
            await API.post('/api/memory/pin', { text: r.text, section: move.value });
            await API.del('/api/memory/pin?id=' + encodeURIComponent(r.id));
            Components.toast('Moved to ' + move.value, 'success');
            this._renderPinned(container);
          } catch (e) {
            Components.toast('Move failed: ' + (e.message || e), 'error');
          }
        });
        row.appendChild(move);

        const del = document.createElement('button');
        del.className = 'btn btn-sm';
        del.textContent = 'Unpin';
        del.addEventListener('click', async () => {
          del.disabled = true;
          try {
            await API.del('/api/memory/pin?id=' + encodeURIComponent(r.id));
            Components.toast('Unpinned', 'success');
            this._renderPinned(container);
          } catch (e) {
            Components.toast('Unpin failed: ' + (e.message || e), 'error');
            del.disabled = false;
          }
        });
        row.appendChild(del);

        container.appendChild(row);
      }
    }
  },

  /// Mirrors `render.rs::section_for_tag` — the same four buckets, so the tab
  /// groups pins exactly as the packet will render them.
  _sectionForTag(tag) {
    switch (String(tag || '').toUpperCase()) {
      case 'BOUNDARY': return 'Boundaries';
      case 'HEARTBEAT': return 'Heartbeat';
      case 'IDENTITY': return 'Identity';
      case 'PREF': return 'Preferences';
      case 'DECISION': return 'Decisions';
      default: return 'Notes';
    }
  },

  // ===== RECEIPTS TAB — PLAN-RECEIPTS-BROWSE-TAB P2 =====
  // Flow 14 rendered for humans on top; every receipt, day-grouped, below.
  // The verdicts come from the SERVER (`/api/receipts` → browseReceipts, the
  // fixture-gated twin of the Rust grader) — this file renders, never judges.
  // `q` narrows rows to one conversation by name — the bridge from a History
  // row ("receipt" on a scheduled run) until the two tables share a turn id.
  _receiptsState: { days: 7, lane: '', problems: false, q: '' },

  async _renderReceipts(container) {
    container.innerHTML = '';
    const st = this._receiptsState;
    // Deep link: #/memory?tab=receipts&lane=skill-console&q=blog-freshness
    const hp = this._hashParams();
    if (hp.has('lane')) st.lane = hp.get('lane') || '';
    if (hp.has('q')) st.q = hp.get('q') || '';
    const root = document.createElement('div');
    root.className = 'receipts-root';
    container.appendChild(root);

    // Human names for the lane GROUPS (static labels, not raw enums; per-row
    // conversation names go through scopeLabel, the sanctioned path).
    const GROUP_LABEL = {
      'skill-console': 'Scheduled skills',
      'channel': 'Channels',
      'heartbeat': 'Heartbeat',
      'workbench:other': 'Other workbench',
      'interactive': 'Chat',
    };
    const groupLabel = (g) => GROUP_LABEL[g] || g;

    // ── controls ──
    const bar = document.createElement('div');
    bar.className = 'receipts-controls';
    const daysSel = document.createElement('select');
    for (const d of [3, 7, 14]) {
      const o = document.createElement('option');
      o.value = String(d); o.textContent = 'Last ' + d + ' days';
      if (d === st.days) o.selected = true;
      daysSel.appendChild(o);
    }
    const laneSel = document.createElement('select');
    const allOpt = document.createElement('option');
    allOpt.value = ''; allOpt.textContent = 'All lanes';
    laneSel.appendChild(allOpt);
    for (const g of Object.keys(GROUP_LABEL)) {
      const o = document.createElement('option');
      o.value = g; o.textContent = groupLabel(g);
      if (g === st.lane) o.selected = true;
      laneSel.appendChild(o);
    }
    const probLabel = document.createElement('label');
    probLabel.className = 'receipts-problems-toggle';
    const probCb = document.createElement('input');
    probCb.type = 'checkbox';
    probCb.checked = st.problems;
    probLabel.appendChild(probCb);
    probLabel.appendChild(document.createTextNode(' problems only'));
    probLabel.title = 'Only turns whose memory search never ran, or that degraded — the ones the 11-day blackout was made of';
    bar.appendChild(daysSel);
    bar.appendChild(laneSel);
    bar.appendChild(probLabel);
    if (st.q) {
      const chip = document.createElement('span');
      chip.className = 'receipts-filter-chip';
      chip.appendChild(document.createTextNode('only ' + st.q + ' '));
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.textContent = '\u00d7';
      clear.title = 'Show every conversation again';
      clear.addEventListener('click', () => {
        st.q = '';
        this._syncHash({ q: null });
        this._renderReceipts(container);
      });
      chip.appendChild(clear);
      bar.appendChild(chip);
    }
    root.appendChild(bar);
    const rerender = () => {
      st.days = Number(daysSel.value) || 7;
      st.lane = laneSel.value;
      st.problems = probCb.checked;
      this._syncHash({ lane: st.lane || null });
      this._renderReceipts(container);
    };
    daysSel.addEventListener('change', rerender);
    laneSel.addEventListener('change', rerender);
    probCb.addEventListener('change', rerender);

    const body = document.createElement('div');
    body.className = 'receipts-body';
    body.textContent = 'Reading receipts…';
    root.appendChild(body);

    let data;
    try {
      const q = new URLSearchParams({ days: String(st.days) });
      if (st.lane) q.set('lane', st.lane);
      if (st.problems) q.set('problems', '1');
      const r = await fetch('/api/receipts?' + q.toString(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      data = await r.json();
    } catch (e) {
      body.textContent = 'Could not read receipts: ' + (e && e.message ? e.message : e);
      return;
    }
    body.innerHTML = '';

    // ── coverage strip ──
    const strip = document.createElement('div');
    strip.className = 'receipts-strip';
    const groups = Object.keys(data.summary || {}).sort();
    if (!groups.length) {
      const empty = document.createElement('div');
      empty.className = 'receipts-empty';
      empty.textContent = 'No receipts in the last ' + data.window_days + ' days.';
      body.appendChild(empty);
      return;
    }
    for (const g of groups) {
      const s = data.summary[g];
      const row = document.createElement('div');
      row.className = 'receipts-strip-row';
      const name = document.createElement('span');
      name.className = 'receipts-strip-name';
      name.textContent = groupLabel(g);
      const barEl = document.createElement('span');
      barEl.className = 'receipts-strip-bar';
      const graded = s.injected + s.ran_empty + s.never_ran;
      const seg = (n, cls) => {
        if (!n) return;
        const el = document.createElement('span');
        el.className = 'receipts-seg ' + cls;
        el.style.flexGrow = String(n);
        barEl.appendChild(el);
      };
      seg(s.injected, 'receipts-seg-injected');
      seg(s.ran_empty, 'receipts-seg-empty');
      seg(s.never_ran, 'receipts-seg-neverran');
      seg(s.unrecorded, 'receipts-seg-unrecorded');
      const counts = document.createElement('span');
      counts.className = 'receipts-strip-counts';
      const bits = [s.turns + ' turns', '● ' + s.injected + ' with memories', '○ ' + s.ran_empty + ' found nothing'];
      if (s.never_ran) bits.push('✕ ' + s.never_ran + ' never ran');
      if (s.unrecorded) bits.push(s.unrecorded + ' before lane tracking');
      counts.textContent = bits.join(' · ');
      if (graded === 0 && s.unrecorded) row.classList.add('receipts-strip-unknown');
      row.appendChild(name);
      row.appendChild(barEl);
      row.appendChild(counts);
      strip.appendChild(row);
    }
    body.appendChild(strip);

    // ── day-grouped list ──
    // `at` is naive UTC (time canon): parse as UTC, render local, group by the
    // LOCAL day — substr grouping here has already faked a regression once.
    const parseUtc = (at) => new Date(at.replace(' ', 'T') + 'Z');
    const list = document.createElement('div');
    list.className = 'receipts-list';
    let lastDay = '';
    const shapeText = (row) => {
      if (row.shape === 'never_ran') return 'never ran';
      if (row.shape === 'unrecorded') return 'recorded before lane tracking';
      if (row.shape === 'ran_empty') return 'looked, nothing matched';
      const n = row.items != null ? row.items : row.memories_used;
      return n + (n === 1 ? ' memory' : ' memories');
    };
    const needle = st.q.toLowerCase();
    const rows = needle
      ? (data.rows || []).filter((r) => String(r.conversation_id || '').toLowerCase().includes(needle))
      : (data.rows || []);
    for (const row of rows) {
      const d = parseUtc(row.at);
      const day = window.VodouTime._fmt(d, { weekday: 'long', month: 'short', day: 'numeric' }, '');
      if (day !== lastDay) {
        lastDay = day;
        const h = document.createElement('div');
        h.className = 'receipts-day';
        h.textContent = day;
        list.appendChild(h);
      }
      const el = document.createElement('div');
      el.className = 'receipts-row receipts-shape-' + row.shape;
      const head = document.createElement('div');
      head.className = 'receipts-row-head';
      const time = document.createElement('span');
      time.className = 'receipts-row-time mono';
      time.textContent = window.VodouTime.time(d);
      const conv = document.createElement('span');
      conv.className = 'receipts-row-conv';
      // scopeLabel knows workbench ids ("the X skill", channel names); its
      // fallback word is 'memory', which is TRUE of a chunk scope and false of
      // a conversation — a bare chat id or vodou-heartbeat gets the group name.
      const pretty = globalThis.VodouVocabulary.scopeLabel(row.conversation_id);
      conv.textContent = pretty === 'memory' ? groupLabel(row.lane_group) : pretty;
      const what = document.createElement('span');
      what.className = 'receipts-row-what';
      const wb = [shapeText(row)];
      if (row.chars) wb.push(row.chars.toLocaleString() + ' chars');
      if (row.ms != null) wb.push(row.ms + ' ms');
      if (row.degraded) wb.push('degraded: ' + row.degraded);
      what.textContent = wb.join(' · ');
      head.appendChild(time);
      head.appendChild(conv);
      head.appendChild(what);
      // A scheduled skill's turn has a twin in Activity → History (the run
      // itself: did it fire, what tool it called). Same name-bridge as the
      // other direction; History searches its messages for the task name.
      const skillName = /^workbench:skill-console:(.+)$/.exec(String(row.conversation_id || ''));
      if (skillName) {
        const runs = document.createElement('a');
        runs.className = 'receipts-row-runs';
        runs.href = '#/activity?tab=history&q=' + encodeURIComponent(skillName[1]);
        runs.textContent = 'runs';
        runs.title = 'The scheduled runs of this skill (Activity \u2192 History)';
        runs.addEventListener('click', (e) => e.stopPropagation());
        head.appendChild(runs);
      }
      if (row.shape === 'never_ran' || row.degraded) {
        const warn = document.createElement('span');
        warn.className = 'receipts-row-warn';
        warn.textContent = '⚠';
        head.appendChild(warn);
      }
      el.appendChild(head);
      // Expand: the SAME receipt component chat renders — one definition.
      head.addEventListener('click', () => {
        const open = el.querySelector('.chat-turn-receipt');
        if (open) { open.remove(); return; }
        if (!globalThis.TurnReceiptView) return;
        const box = globalThis.TurnReceiptView.build({
          turnId: row.turn_id || undefined,   // pre-D-6 rows are unjoinable: no bytes links
          memories: { used: row.items != null ? row.items : row.memories_used },
          lanes: row.lanes,
          degraded: row.degraded ? { reason: row.degraded } : undefined,
        });
        if (box) { box.open = true; el.appendChild(box); }
      });
      list.appendChild(el);
    }
    if (!rows.length) {
      const none = document.createElement('div');
      none.className = 'receipts-empty';
      none.textContent = st.q ? 'No receipts for ' + st.q + ' in this window.'
        : st.problems ? 'No problem turns in this window — that is the good outcome.' : 'No receipts match this filter.';
      list.appendChild(none);
    }
    if (data.capped) {
      const cap = document.createElement('div');
      cap.className = 'receipts-empty';
      cap.textContent = 'Showing the newest 500 receipts — narrow the window for older ones.';
      list.appendChild(cap);
    }
    body.appendChild(list);
  },

  // ===== MAP TAB — the memory graph (PLAN-BRAIN-INTO-CONSOLE P1) =====
  // VodouBrain (js/brain/app.js) is the same module the standalone :8767
  // console runs; here it mounts into this container with the gateway's own
  // /api/brain/* routes. The host owns the URL: layout and focused node live
  // in the hash so a link to a view is a link to that view.
  async _renderMap(container, { conflicts = false } = {}) {
    container.innerHTML = '';
    if (!globalThis.VodouBrain || !globalThis.VodouBrainTemplate || typeof d3 === 'undefined') {
      container.innerHTML = '<div class="error-state">Map module not loaded — <code>js/brain/app.js</code>, <code>js/brain/brain-template.js</code> and <code>vendor/d3.min.js</code> must be included before <code>views/memory.js</code>.</div>';
      return;
    }
    // Probe once so a gateway without the graph routes explains itself instead
    // of drawing an empty sky (the routes mount in src/index.ts; until that
    // build is running here, the standalone console still has the graph).
    let probe;
    try { probe = await fetch('/api/brain/overview', { cache: 'no-store' }); } catch (_) { probe = null; }
    if (!probe || !probe.ok) {
      const code = probe ? probe.status : 'offline';
      container.innerHTML = `
        <div class="memory-map-unavailable">
          <p><b>The memory graph isn't served by this gateway build yet</b> <span class="mono">(/api/brain/overview → ${code})</span>.</p>
          <p>Restart Vodou on a build that mounts the graph routes — or, while the standalone console is running,
             <a href="http://127.0.0.1:8767/" target="_blank" rel="noopener">open it in its own tab ↗</a>.</p>
        </div>`;
      return;
    }
    const root = document.createElement('div');
    root.className = 'brain-root embedded';
    container.appendChild(root);
    const q = this._hashParams();
    this._brain = globalThis.VodouBrain.mount(root, {
      embedded: true,
      apiBase: '',
      layout: q.get('layout') || undefined,
      node: q.get('node') || undefined,
      onLayout: (layout) => this._syncHash({ layout }),
      // P2.2 — node → fact: open the file in Facts, scrolled to the line.
      onOpenFile: (path, line) => {
        // The graph's paths are workspace-relative (memory/2026-08-25.md); the
        // file API takes repo-relative (.vodou/workspace/memory/…).
        const apiPath = path.startsWith('.vodou/') ? path : '.vodou/workspace/' + path;
        location.hash = '#/memory?file=' + encodeURIComponent(apiPath) + (line ? '&line=' + line : '');
      },
      // A summary read in a side panel is a dead end; the point of reading it is
      // usually the next question. This carries it into a real chat tab so the
      // thread continues where the graph stops.
      onChat: (summary) => this._summaryToChat(summary),
    });
    if (conflicts) this._brain.openConflicts();
  },

  /** Map → Chat handoff. The graph produced a summary; this opens a NEW chat
   *  tab that IS that summary. A fresh tab on purpose — dropping this into
   *  whatever conversation happened to be open would bury it and pollute that
   *  thread's memory scope.
   *
   *  The summary is seeded SERVER-side as the assistant's opening message before
   *  the tab is switched to, in that order, for two reasons. It has to be in
   *  `loadMessages` history or the next turn assembles context with no idea what
   *  the thread is about. And `_switchTab` fires `switch_conversation` the moment
   *  it runs, so a tab opened first would get an empty `history` reply back that
   *  wipes anything rendered into the DOM in the meantime. Seed, then open, then
   *  the normal history path renders it. */
  async _summaryToChat(s) {
    if (!s || typeof ChatView === 'undefined' || typeof ChatView._generateTabId !== 'function') {
      if (typeof Components !== 'undefined') Components.toast('Chat is not loaded yet — reload and try again.', 'error');
      return;
    }
    const title = (s.title || 'this memory').slice(0, 120);
    // Same id shape ChatView._addTab mints, so nothing downstream can tell this
    // conversation from one started in the chat view.
    const conversationId = 'conv-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
    const projectId = typeof ChatView._getActiveProjectId === 'function'
      ? ChatView._getActiveProjectId() : null;

    try {
      const res = await fetch('/api/brain/summarize/to-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId, projectId,
          title, subtitle: s.subtitle || '', summary: s.summary || '',
          model: s.model || '', sourceCount: (s.sources || []).length,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error((body && body.error) || ('HTTP ' + res.status));
      }
    } catch (err) {
      console.error('[memory] summary handoff seed failed', err);
      if (typeof Components !== 'undefined') Components.toast('Could not open the summary in chat: ' + err.message, 'error');
      return;
    }

    // Build the tab by hand rather than _addTab() — that mints its own
    // conversation id, and the seed above already claimed one.
    const tab = {
      id: ChatView._generateTabId(),
      title: title.length > 28 ? title.slice(0, 27) + '\u2026' : title,
      conversationId,
      projectId,
    };
    ChatView._tabs.push(tab);
    try { ChatView._saveTabs(); ChatView._renderTabs(); } catch (_) { /* cosmetic */ }
    location.hash = '#/chat';
    // The route change swaps the visible container; switch once it is up so the
    // history reply renders into a chat that is actually on screen.
    setTimeout(() => {
      try { ChatView._switchTab(tab.id); }
      catch (err) { console.error('[memory] summary handoff switch failed', err); }
    }, 120);
  },

  // ===== PHASE C — Live search panel =====
  // Wired to /api/memory/search-chunks which hits the daemon's debug-enabled
  // ranking pipeline. Each result row uses MemoryRow for consistent rendering
  // with the chat "see why" modal.
  _liveSearchState: { q: '', scope: '', tags: new Set(), since: '' },
  _liveSearchTimer: null,
  // Monotonic counter so an earlier slow daemon response can't clobber a
  // later fast one. The fire ID is captured at request time and compared at
  // response time; mismatched IDs bail out before rendering.
  _liveSearchFireId: 0,

  _renderLiveSearchPanel(parent) {
    const panel = document.createElement('div');
    panel.id = 'memory-live-search-panel';
    panel.style.padding = '12px 16px';
    panel.style.borderBottom = '1px solid var(--border-subtle, rgba(255,255,255,0.08))';

    // Sparkline (tag distribution over last 7 days)
    const spark = document.createElement('div');
    spark.id = 'memory-tag-sparkline';
    spark.style.marginBottom = '12px';
    panel.appendChild(spark);
    setTimeout(() => this._renderTagSparkline(spark), 0);

    // Search input
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'memory-live-search-input';
    input.placeholder = 'Search memories — semantic + keyword (live ranked)...';
    input.id = 'memory-live-search-input';
    input.addEventListener('input', () => {
      this._liveSearchState.q = input.value;
      clearTimeout(this._liveSearchTimer);
      // 350ms debounce — long enough that mid-typing keystrokes don't fire
      // intermediate searches with partial queries; short enough to feel live.
      this._liveSearchTimer = setTimeout(() => this._fireLiveSearch(), 350);
    });
    panel.appendChild(input);

    // Filter chips: tag, scope, date range
    const chipsRow = document.createElement('div');
    chipsRow.className = 'memory-filter-chips';
    chipsRow.id = 'memory-filter-chips';
    panel.appendChild(chipsRow);
    setTimeout(() => this._renderFilterChips(chipsRow), 0);

    // Results panel
    const results = document.createElement('div');
    results.className = 'memory-live-results';
    results.id = 'memory-live-results';
    panel.appendChild(results);

    parent.appendChild(panel);
  },

  async _renderTagSparkline(container) {
    container.innerHTML = '';
    let data;
    try {
      data = await API.get('/api/memory/tag-distribution?days=7');
    } catch { return; }
    if (!data || !data.tags || !data.tags.length) return;
    const max = Math.max(...data.tags.map(t => t.count));
    const wrap = document.createElement('div');
    wrap.className = 'memory-sparkline';
    for (const t of data.tags) {
      const bar = document.createElement('div');
      bar.className = 'memory-sparkline-bar';
      bar.title = `${t.tag} · ${t.count} (${t.pct}%)`;
      const fill = document.createElement('div');
      fill.className = 'memory-sparkline-bar-fill';
      const h = max > 0 ? Math.round((t.count / max) * 50) : 0;
      fill.style.height = h + 'px';
      const label = document.createElement('div');
      label.className = 'memory-sparkline-bar-label';
      label.textContent = t.tag.length > 8 ? t.tag.slice(0, 7) + '…' : t.tag;
      bar.appendChild(fill);
      bar.appendChild(label);
      bar.addEventListener('click', () => {
        if (t.tag === 'UNTAGGED') return;
        const tags = this._liveSearchState.tags;
        if (tags.has(t.tag)) tags.delete(t.tag); else tags.add(t.tag);
        this._renderFilterChips(document.getElementById('memory-filter-chips'));
        this._fireLiveSearch();
      });
      wrap.appendChild(bar);
    }
    container.appendChild(wrap);
  },

  async _renderFilterChips(container) {
    if (!container) return;
    container.innerHTML = '';
    const allTags = ['DONE','PLANNED','ISSUE','PREF','DECISION','GOTCHA','DEAD_END','METRIC','PATTERN','DEPENDENCY','EXAMPLE','RESEARCH','IDENTITY','DIGEST'];
    for (const tag of allTags) {
      const chip = document.createElement('span');
      chip.className = 'memory-chip' + (this._liveSearchState.tags.has(tag) ? ' memory-chip-active' : '');
      chip.textContent = tag;
      chip.addEventListener('click', () => {
        if (this._liveSearchState.tags.has(tag)) this._liveSearchState.tags.delete(tag);
        else this._liveSearchState.tags.add(tag);
        chip.classList.toggle('memory-chip-active');
        this._fireLiveSearch();
      });
      container.appendChild(chip);
    }
    // Date range
    const dateLabel = document.createElement('span');
    dateLabel.style.marginLeft = '12px';
    dateLabel.style.color = 'var(--content-muted)';
    dateLabel.style.fontSize = '11px';
    dateLabel.textContent = 'date:';
    container.appendChild(dateLabel);
    const presets = [['all',''],['today',new Date().toISOString().slice(0,10)],['7d', new Date(Date.now()-7*86400000).toISOString().slice(0,10)],['30d', new Date(Date.now()-30*86400000).toISOString().slice(0,10)]];
    for (const [name, since] of presets) {
      const chip = document.createElement('span');
      chip.className = 'memory-chip' + (this._liveSearchState.since === since ? ' memory-chip-active' : '');
      chip.textContent = name;
      chip.addEventListener('click', () => {
        this._liveSearchState.since = since;
        this._renderFilterChips(container);
        this._fireLiveSearch();
      });
      container.appendChild(chip);
    }
  },

  async _fireLiveSearch() {
    const out = document.getElementById('memory-live-results');
    if (!out) return;
    const q = this._liveSearchState.q.trim();
    // P2.4 — an empty box clears the map highlight immediately; a query lights it
    // up only once the RANKED results are in (below), never from the raw words.
    if (!q) {
      if (this._brain) { try { this._brain.setFilter('', null); } catch (_) { /* graph mid-load */ } }
      out.innerHTML = '';
      return;
    }
    // Race-condition guard: capture this fire's ID. If a later keystroke
    // fires while we're awaiting, it will increment the counter and our
    // response will be discarded.
    const myFire = ++this._liveSearchFireId;
    out.innerHTML = '<div class="memory-live-results-meta">searching…</div>';
    const params = new URLSearchParams();
    params.set('q', q);
    params.set('top_k', '20');
    if (this._liveSearchState.scope) params.set('scope', this._liveSearchState.scope);
    if (this._liveSearchState.tags.size > 0) params.set('tag', [...this._liveSearchState.tags].join(','));
    if (this._liveSearchState.since) params.set('since', this._liveSearchState.since);
    let data;
    try {
      data = await API.get('/api/memory/search-chunks?' + params.toString());
    } catch (err) {
      if (myFire !== this._liveSearchFireId) return;
      out.innerHTML = '<div class="memory-live-results-meta">search error: ' + (err.message || err) + '</div>';
      return;
    }
    // Stale response — a newer search has fired since this one started.
    if (myFire !== this._liveSearchFireId) return;
    out.innerHTML = '';
    const meta = document.createElement('div');
    meta.className = 'memory-live-results-meta';
    // COHERENCE F41 — this printed `· scope=web` verbatim: the schema word AND
    // the raw value, in the same breath. The filter is still exactly one scope;
    // it is just named the way the person picked it from the dropdown.
    meta.textContent = `${(data.results || []).length} chunks · q="${q}"` + (this._liveSearchState.scope ? ` · from ${globalThis.VodouVocabulary.scopeLabel(this._liveSearchState.scope)}` : '') + (this._liveSearchState.tags.size ? ` · tags=${[...this._liveSearchState.tags].join(',')}` : '');
    out.appendChild(meta);
    if (!(data.results || []).length) {
      const empty = document.createElement('div');
      empty.className = 'memory-search-empty';
      empty.textContent = 'No matches.';
      out.appendChild(empty);
      return;
    }
    for (const chunk of data.results) {
      out.appendChild(window.MemoryRow.render(chunk, { allowPin: true }));
    }
    // P2.4 — light up exactly what the ranker returned. Ids, not words: the graph
    // highlights Recall's answer and never computes its own.
    if (this._brain) {
      try {
        this._brain.setFilter(q, data.results.map((c) => c.chunk_id || c.id).filter(Boolean));
      } catch (_) { /* graph unmounted mid-search */ }
    }
  },

  // ===== IMPORTS TAB (PLAN-UNIVERSAL-MEMORY Phase 5) =====
  // Management surface for imported memory: job list (status/counts), capture +
  // backfill actions, and the sanitizer review queue. All data/actions come from
  // the /api/import/* endpoints; this is pure presentation.
  async _renderImports(container) {
    container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:12px 4px;max-width:900px;';
    container.appendChild(wrap);

    const muted = 'color:var(--text-muted);font-size:12px;';
    const btnCss = 'font-size:12px;padding:5px 10px;border:1px solid var(--border-primary);border-radius:4px;background:var(--bg-elevated,#222);color:var(--text-primary,#e5e5e5);cursor:pointer;';
    const primaryCss = btnCss + 'border-color:#16a34a;';

    // ── Action bar ────────────────────────────────────────────────────────────
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px;';
    const captureBtn = document.createElement('button');
    captureBtn.style.cssText = primaryCss;
    captureBtn.textContent = '🧠 Capture the open chat';
    captureBtn.title = 'Import the ChatGPT/Claude conversation in your active browser tab (needs the Vodou Bridge extension).';
    const backfillBtn = document.createElement('button');
    backfillBtn.style.cssText = btnCss;
    backfillBtn.textContent = '⤵ Backfill all ChatGPT';
    backfillBtn.title = 'Paginate your whole ChatGPT history via the bridge (~1 chat / 1.5s). The only export path for ChatGPT Team.';
    const status = document.createElement('span');
    status.style.cssText = muted;
    actions.append(captureBtn, backfillBtn, status);
    wrap.appendChild(actions);

    const self = this;
    async function runAction(btn, label, fn) {
      const prev = btn.textContent;
      btn.disabled = true;
      status.textContent = label + '…';
      try {
        const r = await fn();
        status.textContent = (r && r.error) ? ('✗ ' + r.error) : '✓ ' + label + ' done';
        await self._loadImportJobs(jobsBox);
        await self._loadFlagged(reviewBox);
      } catch (e) {
        status.textContent = '✗ ' + (e.message || label + ' failed');
      } finally {
        btn.disabled = false;
        btn.textContent = prev;
      }
    }
    // Background extraction: capture returns as soon as the chat is landed; the
    // daemon distills memory from it. (extract:'now' would run the LLM inside the
    // request and blow the client timeout on longer chats.) 60s covers slow fetches.
    captureBtn.addEventListener('click', () => runAction(captureBtn, 'Capture', () => API.post('/api/import/capture', { extract: 'background' }, { timeout: 60000 })));
    backfillBtn.addEventListener('click', () => {
      if (!confirm('Backfill your entire ChatGPT history? This walks every conversation (~1/1.5s) and can take a while.')) return;
      runAction(backfillBtn, 'Backfill', () => API.post('/api/import/backfill', { source: 'chatgpt', extract: 'background' }, { timeout: 0 }));
    });

    // ── Jobs section ──────────────────────────────────────────────────────────
    const jobsHead = document.createElement('h3');
    jobsHead.textContent = 'Import jobs';
    jobsHead.style.cssText = 'font-size:14px;margin:6px 0;';
    wrap.appendChild(jobsHead);
    const jobsBox = document.createElement('div');
    wrap.appendChild(jobsBox);

    // ── Contradictions section (PLAN-UNIVERSAL-MEMORY-V2 #3-lite) ────────────
    const conHead = document.createElement('h3');
    conHead.textContent = 'Contradictions';
    conHead.style.cssText = 'font-size:14px;margin:22px 0 6px;display:flex;align-items:center;gap:10px;';
    conHead.appendChild(Components.helpTip('Places where your imported AI history disagrees with current memory — same fact, different value. You decide which wins: the losing line is superseded (demoted in search, reversible via mem dedup clear) — nothing is deleted.'));
    const scanBtn = document.createElement('button');
    scanBtn.textContent = '🔍 Scan history vs memory';
    scanBtn.title = 'Pair imported chunks with similar current memory and LLM-judge conflicts. Already-judged pairs are skipped, so re-scans are cheap.';
    scanBtn.style.cssText = btnCss;
    conHead.appendChild(scanBtn);
    wrap.appendChild(conHead);
    const conBox = document.createElement('div');
    wrap.appendChild(conBox);
    scanBtn.addEventListener('click', () => runAction(scanBtn, 'Scan', async () => {
      const r = await API.post('/api/import/contradictions/scan', {}, { timeout: 0 });
      await self._loadContradictions(conBox);
      return r;
    }));

    // ── Review queue section ──────────────────────────────────────────────────
    const reviewHead = document.createElement('h3');
    reviewHead.textContent = 'Review queue';
    reviewHead.style.cssText = 'font-size:14px;margin:22px 0 6px;';
    reviewHead.appendChild(Components.helpTip('Lines the sanitizer flagged as possible prompt-injection in imported memory. They were KEPT, not dropped — reject to delete the chunk.'));
    wrap.appendChild(reviewHead);
    const reviewBox = document.createElement('div');
    wrap.appendChild(reviewBox);

    await this._loadImportJobs(jobsBox);
    await this._loadContradictions(conBox);
    await this._loadFlagged(reviewBox);
  },

  async _loadContradictions(box) {
    box.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">Loading…</div>';
    let rows = [];
    try {
      const data = await API.get('/api/import/contradictions');
      rows = (data && data.contradictions) || [];
    } catch (e) {
      box.innerHTML = '<div style="color:#f87171;font-size:12px;">Failed to load contradictions: ' + (e.message || e) + '</div>';
      return;
    }
    if (rows.length === 0) {
      box.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">No open contradictions. Run a scan after importing history.</div>';
      return;
    }
    box.innerHTML = '';
    const self = this;
    rows.forEach((c) => {
      const row = document.createElement('div');
      row.style.cssText = 'padding:10px 12px;border:1px solid rgba(168,85,247,.4);border-radius:6px;margin-bottom:8px;background:rgba(168,85,247,.06);';
      const slot = document.createElement('div');
      slot.style.cssText = 'font-size:12px;font-weight:600;margin-bottom:6px;';
      slot.innerHTML = '⚡ ' + self._escape(c.slot || 'conflicting fact') +
        (c.sources > 1 ? ' <span style="font-weight:400;color:var(--text-muted);">· found in ' + c.sources + ' places (resolving fixes all)</span>' : '');
      row.appendChild(slot);
      const sides = document.createElement('div');
      sides.style.cssText = 'font-size:12px;display:flex;flex-direction:column;gap:3px;margin-bottom:8px;';
      const impVal = c.import_value || (c.import_text || '').slice(0, 140);
      const natVal = c.native_value || (c.native_text || '').slice(0, 140);
      sides.innerHTML =
        '<div>📜 <span style="color:var(--text-muted);">your ' + self._escape((c.import_scope || 'import').replace('import:', '')) + ' history says:</span> ' + self._escape(impVal) + '</div>' +
        '<div>🧠 <span style="color:var(--text-muted);">current memory says:</span> ' + self._escape(natVal) + '</div>';
      row.appendChild(sides);
      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:8px;';
      const mkBtn = (label, keep, title) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.title = title;
        b.style.cssText = 'font-size:11px;padding:4px 10px;border:1px solid var(--border-primary);border-radius:4px;background:transparent;color:var(--text-primary,#e5e5e5);cursor:pointer;';
        b.addEventListener('click', async () => {
          btns.querySelectorAll('button').forEach((x) => { x.disabled = true; });
          b.textContent = '…';
          try {
            await API.post('/api/import/contradictions/' + encodeURIComponent(c.id) + '/resolve', { keep });
            row.style.opacity = '0.45';
            const msg = keep === 'dismiss'
              ? 'dismissed — not a conflict (nothing changed)'
              : 'kept ' + (keep === 'native'
                  ? 'current memory — import line superseded (demoted in search, reversible)'
                  : 'history — memory line superseded (demoted in search, reversible)');
            sides.innerHTML += '<div style="color:#4ade80;">✓ ' + msg + '</div>';
            setTimeout(() => row.remove(), 1600);
          } catch (e) {
            Components.toast('Resolve failed: ' + (e.message || e), 'error');
            btns.querySelectorAll('button').forEach((x) => { x.disabled = false; });
            b.textContent = label;
          }
        });
        return b;
      };
      btns.appendChild(mkBtn('🧠 Keep memory', 'native', 'Current memory wins — the imported line is superseded (demoted in search, reversible)'));
      btns.appendChild(mkBtn('📜 Keep history', 'import', 'History wins — the current-memory line is superseded (demoted in search, reversible)'));
      btns.appendChild(mkBtn('✕ Not a conflict', 'dismiss', 'False positive — clears this entry, changes no memory'));
      row.appendChild(btns);
      box.appendChild(row);
    });
  },

  _importBadge(scopeOrSource) {
    const b = document.createElement('span');
    b.textContent = scopeOrSource;
    b.style.cssText = 'font-size:11px;padding:1px 7px;border-radius:10px;background:rgba(99,102,241,.18);color:#a5b4fc;border:1px solid rgba(99,102,241,.35);';
    return b;
  },

  async _loadImportJobs(box) {
    box.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">Loading…</div>';
    let jobs = [];
    try {
      const data = await API.get('/api/import/jobs');
      jobs = (data && data.jobs) || [];
    } catch (e) {
      box.innerHTML = '<div style="color:#f87171;font-size:12px;">Failed to load jobs: ' + (e.message || e) + '</div>';
      return;
    }
    if (jobs.length === 0) {
      box.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">No imports yet. Import an export with <code>mem import</code>, or capture the open chat above.</div>';
      return;
    }
    box.innerHTML = '';
    const self = this;
    jobs.forEach((j) => {
      const undone = j.status === 'undone';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border-primary);border-radius:6px;margin-bottom:6px;flex-wrap:wrap;' +
        (undone ? 'opacity:0.5;' : '');
      row.appendChild(this._importBadge('import:' + (j.source || '?')));
      const meta = document.createElement('div');
      meta.style.cssText = 'flex:1;min-width:200px;font-size:12px;';
      const counts = (j.conv_count ? j.conv_count + ' conv · ' : '') + (j.msg_count || 0) + ' msg';
      const statusColor = undone ? '#f87171' : (j.status === 'done' ? '#4ade80' : 'var(--text-muted)');
      meta.innerHTML = '<div><strong>' + (j.id || '') + '</strong> · <span style="color:' + statusColor + '">' + (j.status || '') + '</span></div>' +
        '<div style="color:var(--text-muted)">' + counts + (j.created_at ? ' · ' + j.created_at : '') + '</div>';
      row.appendChild(meta);

      // Undone jobs have nothing left to act on — no buttons, just the dimmed row.
      if (!undone) {
        const extractBtn = document.createElement('button');
        extractBtn.textContent = 'Extract';
        extractBtn.title = 'Distil memory from this import now';
        extractBtn.style.cssText = 'font-size:11px;padding:4px 8px;border:1px solid var(--border-primary);border-radius:4px;background:transparent;color:var(--text-primary,#e5e5e5);cursor:pointer;';
        extractBtn.addEventListener('click', async () => {
          extractBtn.disabled = true; extractBtn.textContent = '…';
          try {
            const r = await API.post('/api/import/jobs/' + encodeURIComponent(j.id) + '/extract', {}, { timeout: 0 });
            if (r && r.output) meta.innerHTML += '<div style="color:#4ade80;">✓ ' + self._escape(r.output) + '</div>';
          }
          catch (e) { Components.toast('Extract failed: ' + (e.message || e), 'error'); }
          finally { setTimeout(() => self._loadImportJobs(box), 1200); }
        });

        const undoBtn = document.createElement('button');
        undoBtn.textContent = 'Undo';
        undoBtn.title = 'Remove this source’s imported memory (coarse — all imports from this source)';
        undoBtn.style.cssText = 'font-size:11px;padding:4px 8px;border:1px solid #7f1d1d;border-radius:4px;background:transparent;color:#f87171;cursor:pointer;';
        undoBtn.addEventListener('click', async () => {
          if (!confirm('Undo import "' + j.id + '"? This removes its imported memory (coarse: all ' + j.source + ' imports).')) return;
          undoBtn.disabled = true; undoBtn.textContent = '…';
          try {
            const r = await API.del('/api/import/jobs/' + encodeURIComponent(j.id));
            // Immediate confirmation, then refresh (which will show the row dimmed/undone).
            row.style.opacity = '0.5';
            meta.innerHTML += '<div style="color:#4ade80;">✓ ' + self._escape((r && r.output) || 'Import undone — memory removed.') + '</div>';
          }
          catch (e) { Components.toast('Undo failed: ' + (e.message || e), 'error'); }
          finally { setTimeout(() => self._loadImportJobs(box), 1500); }
        });

        row.append(extractBtn, undoBtn);
      }
      box.appendChild(row);
    });
  },

  async _loadFlagged(box) {
    box.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">Loading…</div>';
    let flagged = [];
    try {
      const data = await API.get('/api/import/flagged');
      flagged = (data && data.flagged) || [];
    } catch (e) {
      box.innerHTML = '<div style="color:#f87171;font-size:12px;">Failed to load review queue: ' + (e.message || e) + '</div>';
      return;
    }
    if (flagged.length === 0) {
      box.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">Nothing flagged. 🎉</div>';
      return;
    }
    box.innerHTML = '';
    const self = this;
    flagged.forEach((f) => {
      // Flagged line is "path:line — snippet"; the snippet after " — " is what we match.
      const line = String(f.line || '');
      const snippet = line.includes(' — ') ? line.split(' — ').slice(1).join(' — ') : line;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid rgba(245,158,11,.35);border-radius:6px;margin-bottom:6px;background:rgba(245,158,11,.06);';
      const txt = document.createElement('div');
      txt.style.cssText = 'flex:1;font-size:12px;';
      txt.innerHTML = '<span style="color:#fbbf24;">⚠</span> <code style="font-size:11px;">' + self._escape(line) + '</code>';
      row.appendChild(txt);
      const keepBtn = document.createElement('button');
      keepBtn.textContent = 'Keep';
      keepBtn.style.cssText = 'font-size:11px;padding:4px 8px;border:1px solid var(--border-primary);border-radius:4px;background:transparent;color:var(--text-muted);cursor:pointer;';
      keepBtn.addEventListener('click', () => { row.remove(); });
      const rejectBtn = document.createElement('button');
      rejectBtn.textContent = 'Reject';
      rejectBtn.style.cssText = 'font-size:11px;padding:4px 8px;border:1px solid #7f1d1d;border-radius:4px;background:transparent;color:#f87171;cursor:pointer;';
      rejectBtn.addEventListener('click', async () => {
        rejectBtn.disabled = true; rejectBtn.textContent = '…';
        // Strip leading quotes/space and match on a shorter core — the full flagged
        // line can span multiple chunks (chunks are ≤600 chars), so a shorter anchor
        // is far likelier to be contained in one chunk's text.
        const anchor = snippet.replace(/^["'\s]+/, '').slice(0, 80).trim();
        try {
          const r = await API.post('/api/import/flagged/reject', { snippet: anchor });
          const n = (r && r.removed) || 0;
          row.style.opacity = '0.45';
          txt.innerHTML += n > 0
            ? ' <span style="color:#4ade80;">✓ removed ' + n + ' chunk(s)</span>'
            : ' <span style="color:var(--text-muted);">— not in indexed memory (deduped / not chunked); dismissed</span>';
          // Reviewed either way — clear it from the queue.
          setTimeout(() => row.remove(), 1400);
        } catch (e) {
          Components.toast('Reject failed: ' + (e.message || e), 'error');
          rejectBtn.disabled = false; rejectBtn.textContent = 'Reject';
        }
      });
      keepBtn.title = 'Dismiss — keep this imported memory as-is';
      rejectBtn.title = 'Delete the imported chunk(s) containing this text (import-scoped only)';
      row.append(keepBtn, rejectBtn);
      box.appendChild(row);
    });
  },

  // Shared escaper — safe.js loads first, so VodouSafe is always present.
  _escape(s) {
    return window.VodouSafe.escapeHtml(s);
  },

  // ===== TIMELINE TAB =====
  async _renderTimeline(container) {
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'memory-timeline-wrapper';

    // Loading
    wrapper.appendChild(Components.loading());
    container.appendChild(wrapper);

    try {
      const data = await API.get('/api/memory/timeline');
      wrapper.innerHTML = '';

      // P2.2 — #/memory?file=<path>&line=<n> (from the map's "Edit in Facts").
      const want = this._hashParams();
      if (want.get('file')) {
        const line = parseInt(want.get('line') || '', 10);
        this._syncHash({ file: null, line: null });
        setTimeout(() => this._showFileViewer(want.get('file'), wrapper, Number.isFinite(line) ? line : null), 0);
      }

      if (data.days.length === 0) {
        wrapper.innerHTML = '<div class="empty-state">No daily memory logs found</div>';
        return;
      }

      // Workspace files summary bar
      if (data.workspaceFiles && data.workspaceFiles.length > 0) {
        const wsBar = document.createElement('div');
        wsBar.className = 'memory-tl-workspace-bar';
        const wsLabel = document.createElement('span');
        wsLabel.className = 'memory-tl-workspace-label';
        wsLabel.textContent = 'Workspace Files';
        wsBar.appendChild(wsLabel);
        const wsChips = document.createElement('div');
        wsChips.className = 'memory-tl-workspace-chips';
        // P3/gate 6 — the row is "what the daemon regenerates", not "every .md in
        // a folder". AGENTS.md is the operating manual: one document at the
        // install root, refreshed with the binary, read from Help → Docs. It was
        // only ever here because this listed the directory — and a directory
        // listing also puts a chip on anything a user happens to drop in the
        // workspace, inviting them to edit a file no session will ever read.
        // Leftovers from an older install are `vodou-core workspace retire`'s
        // job, which names each file's old reader; a dimmed chip cannot.
        for (const f of data.workspaceFiles.filter((x) => x.generated)) {
          const chip = document.createElement('span');
          chip.className = 'memory-tl-ws-chip';
          chip.textContent = f.name.replace(/\.md$/, '');
          // P9 — a chip is an invitation to edit. Say what editing would do.
          if (f.generated) {
            chip.classList.add('is-generated');
            chip.title = f.path + ' \u00b7 generated \u2014 rewritten by the daemon every minute; pin or unpin, do not type into it';
            // P4 — the page-level face of gate 14. A renderer that stopped is
            // invisible in the file (the banner stays fresh-looking), so the
            // chip carries the age of the last run and reddens on the same
            // thresholds `vodou-core flows --flow 18` uses.
            const bound = Number(f.freshness_secs) || 60;
            const age = Math.max(0, Math.round((Date.now() - new Date(f.modified).getTime()) / 1000));
            const ago = age < 120 ? age + 's' : age < 7200 ? Math.floor(age / 60) + 'm' : age < 172800 ? Math.floor(age / 3600) + 'h' : Math.floor(age / 86400) + 'd';
            const stamp = document.createElement('span');
            stamp.className = 'memory-tl-ws-age';
            stamp.textContent = ago;
            chip.appendChild(stamp);
            if (age > bound * 10) {
              chip.classList.add('is-stale-red');
              chip.title += ' \u00b7 its renderer last ran ' + ago + ' ago \u2014 it has stopped; check the daemon (`vodou-core flows --flow 18`)';
            } else if (age > bound * 2) {
              chip.classList.add('is-stale-warn');
              chip.title += ' \u00b7 its renderer last ran ' + ago + ' ago \u2014 a missed tick';
            } else {
              chip.title += ' \u00b7 last rendered ' + ago + ' ago';
            }
          } else if (f.retired || f.injected === false) {
            chip.classList.add('is-retired');
            chip.title = f.path + ' \u00b7 retired \u2014 nothing reads this file any more; `vodou-core workspace retire` archives it';
          } else {
            chip.title = f.path;
          }
          chip.addEventListener('click', () => this._showFileViewer(f.path, wrapper));
          wsChips.appendChild(chip);
        }
        wsBar.appendChild(wsChips);
        wrapper.appendChild(wsBar);
      }

      // Timeline
      const timeline = document.createElement('div');
      timeline.className = 'memory-timeline';

      for (const day of data.days) {
        const card = document.createElement('div');
        card.className = 'memory-tl-card';

        // Date header
        const dateRow = document.createElement('div');
        dateRow.className = 'memory-tl-date-row';

        const dot = document.createElement('div');
        dot.className = 'memory-tl-dot';
        dateRow.appendChild(dot);

        const dateLabel = document.createElement('div');
        dateLabel.className = 'memory-tl-date';
        const d = new Date(day.date + 'T12:00:00');
        const dayName = window.VodouTime._fmt(d, { weekday: 'short' }, '');
        const monthDay = window.VodouTime.date(d);
        dateLabel.textContent = dayName + ', ' + monthDay;
        dateRow.appendChild(dateLabel);

        const meta = document.createElement('div');
        meta.className = 'memory-tl-meta';
        meta.textContent = day.lineCount + ' lines \u00B7 ' + this._formatSize(day.size);
        dateRow.appendChild(meta);

        card.appendChild(dateRow);

        // Headings as section chips
        if (day.headings.length > 0) {
          const headingsRow = document.createElement('div');
          headingsRow.className = 'memory-tl-headings';
          // 0.6.31 — a day with many extraction runs repeats the same heading
          // dozens of times ("Run log", "Gateway extraction" × 40). One chip per
          // distinct heading, with a count when it repeats; order of first
          // appearance is kept.
          const counts = new Map();
          for (const h of day.headings) counts.set(h, (counts.get(h) || 0) + 1);
          for (const [h, n] of counts) {
            const chip = document.createElement('span');
            chip.className = 'badge badge-accent';
            chip.classList.add('memory-tl-chip');
            chip.textContent = n > 1 ? h + ' \u00d7' + n : h;
            if (n > 1) chip.title = n + ' sections titled \u201c' + h + '\u201d';
            headingsRow.appendChild(chip);
          }
          card.appendChild(headingsRow);
        }

        // Highlights (bullet points)
        if (day.highlights.length > 0) {
          const highlightsEl = document.createElement('div');
          highlightsEl.className = 'memory-tl-highlights';
          for (const hl of day.highlights) {
            const item = document.createElement('div');
            item.className = 'memory-tl-highlight';
            item.textContent = hl;
            highlightsEl.appendChild(item);
          }
          card.appendChild(highlightsEl);
        }

        // Click to view full file
        card.addEventListener('click', () => this._showFileViewer(day.path, wrapper));
        card.classList.add('memory-tl-card-clickable');

        timeline.appendChild(card);
      }

      wrapper.appendChild(timeline);
    } catch (err) {
      wrapper.innerHTML = '';
      wrapper.appendChild(Components.errorState('Failed to load timeline: ' + err.message));
    }
  },

  _formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  },

  /// The three generated files (PLAN-MEMORY-PAGE-SAYS-WHAT-IT-IS P2). A thing
  /// that can only be pinned should look like a thing you pin — not a document
  /// with an Edit button whose save is silently a diff.
  _generatedKind(filePath) {
    const base = String(filePath || '').split('/').pop();
    if (base === 'MEMORY.md') return 'memory';
    if (base === 'TOOLS.md' || base === 'HEARTBEAT.md') return base;
    return null;
  },

  async _showFileViewer(filePath, parentEl, line) {
    // Show file in a modal overlay
    const overlay = document.createElement('div');
    overlay.className = 'memory-file-overlay';

    const modal = document.createElement('div');
    modal.className = 'memory-file-modal';

    // Modal header
    const header = document.createElement('div');
    header.className = 'memory-editor-header';
    header.classList.add('memory-editor-header-modal');

    const titleSpan = document.createElement('span');
    titleSpan.className = 'memory-editor-title';
    titleSpan.textContent = filePath.split('/').pop().replace(/\.md$/, '');
    header.appendChild(titleSpan);

    const pathSpan = document.createElement('span');
    pathSpan.className = 'memory-editor-path';
    pathSpan.textContent = filePath;
    header.appendChild(pathSpan);

    const btnRow = document.createElement('div');
    btnRow.className = 'memory-editor-actions';

    const kind = this._generatedKind(filePath);

    // P2 — a generated file gets no Edit button. MEMORY.md gets "Add a memory"
    // and, for people who think in files, a small "Edit as text" that previews
    // what the save would do before doing it. TOOLS.md and HEARTBEAT.md are
    // read-only; HEARTBEAT points at its pins.
    let editBtn = null, addBtn = null, rawLink = null;
    if (kind === 'memory') {
      addBtn = document.createElement('button');
      addBtn.className = 'btn btn-sm btn-primary';
      addBtn.textContent = '+ Add a memory';
      btnRow.appendChild(addBtn);
      rawLink = document.createElement('button');
      rawLink.className = 'btn btn-sm memory-raw-edit-link';
      rawLink.textContent = 'Edit as text';
      rawLink.title = 'Advanced: edit the rendering as text. You will see exactly what the save would pin, unpin, or mark wrong before it happens.';
      btnRow.appendChild(rawLink);
    } else if (kind === 'HEARTBEAT.md') {
      const pinsBtn = document.createElement('a');
      pinsBtn.className = 'btn btn-sm';
      pinsBtn.textContent = 'Edit heartbeat pins';
      pinsBtn.href = '#/memory?tab=pinned';
      pinsBtn.addEventListener('click', () => overlay.remove());
      btnRow.appendChild(pinsBtn);
    } else if (kind === null) {
      editBtn = document.createElement('button');
      editBtn.className = 'btn btn-sm';
      editBtn.textContent = 'Edit';
      btnRow.appendChild(editBtn);
    }

    // P2.3 — fact → node.
    const mapBtn = document.createElement('a');
    mapBtn.className = 'btn btn-sm';
    mapBtn.textContent = '✦ Map';
    mapBtn.title = 'Show this file in the memory map';
    mapBtn.href = '#/memory?tab=map&node=' + encodeURIComponent(filePath.replace(/^\.vodou\/workspace\//, ''));
    mapBtn.addEventListener('click', () => overlay.remove());
    btnRow.appendChild(mapBtn);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-sm';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => overlay.remove());
    btnRow.appendChild(closeBtn);

    header.appendChild(btnRow);
    modal.appendChild(header);

    // Content area
    const contentArea = document.createElement('div');
    contentArea.className = 'memory-editor-viewer memory-editor-viewer-modal';
    contentArea.innerHTML = '<div class="loading-container"><div class="loading-spinner"></div></div>';
    modal.appendChild(contentArea);

    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);

    const reopen = () => { overlay.remove(); this._showFileViewer(filePath, parentEl); };

    // ── §4.3/Q4 — which text is on screen, and what it may be diffed against ──
    //
    // MEMORY.md on disk is the GLOBAL snapshot; a session receives a per-project
    // rendering. Showing one and hashing the other makes every save a 409, so a
    // generated file is loaded through /api/memory/render and carries the
    // base_hash of the exact text displayed — and, since P2, the provenance of
    // every line, which is what the per-line actions are built from.
    let baseHash = null;
    let bullets = [];
    try {
      let content;
      if (kind === 'memory') {
        const r = await API.get('/api/memory/render');
        content = r.markdown;
        baseHash = r.base_hash;
        bullets = Array.isArray(r.bullets) ? r.bullets : [];
        pathSpan.textContent = filePath + ' · generated · rewrites itself every minute';
        pathSpan.title = 'Rendered from memory.db. Pin, unpin, move, or mark a line wrong — those change what every session sees. Typing into the file does not.';
      } else {
        const res = await fetch('/api/memory/file?path=' + encodeURIComponent(filePath));
        if (!res.ok) throw new Error(await res.text() || 'Failed to load');
        content = await res.text();
        if (kind === 'TOOLS.md') {
          pathSpan.textContent = filePath + ' · generated from the commands this binary has · changes when Vodou updates';
        } else if (kind === 'HEARTBEAT.md') {
          pathSpan.textContent = filePath + ' · generated · edit your Heartbeat pins, not this file';
        }
      }
      contentArea.innerHTML = this._renderMarkdown(content);
      if (line) {
        // setTimeout, not requestAnimationFrame: rAF never fires in a hidden
        // tab, and a deep link opened in the background would land unmarked.
        setTimeout(() => {
          // A chunk's start_line can be a blank or fence line the renderer
          // skipped — take the nearest rendered block at or before it.
          let el = null, best = -1;
          contentArea.querySelectorAll('[data-line]').forEach((n) => {
            const ln = Number(n.dataset.line);
            if (ln <= line && ln > best) { best = ln; el = n; }
          });
          if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('memory-line-hit'); }
        }, 0);
      }

      if (kind === 'memory') {
        this._decorateMemoryLines(contentArea, bullets, content, () => baseHash, filePath, reopen);
        addBtn.addEventListener('click', () => this._toggleAddMemoryBox(contentArea, reopen));
        rawLink.addEventListener('click', () => {
          this._rawEditWithPreview(contentArea, content, () => baseHash, (h) => { baseHash = h; }, filePath, overlay, rawLink, addBtn);
        });
      }

      // Edit button handler — plain files only (daily logs). Generated files
      // have no Edit button; see _rawEditWithPreview for the advanced path.
      if (editBtn) editBtn.addEventListener('click', () => {
        contentArea.innerHTML = '';
        const textarea = document.createElement('textarea');
        textarea.className = 'memory-editor-textarea';
        textarea.classList.add('memory-editor-textarea-modal');
        textarea.value = content;
        contentArea.appendChild(textarea);

        editBtn.textContent = 'Save';
        editBtn.replaceWith(editBtn.cloneNode(true));
        const newEditBtn = header.querySelector('.btn.btn-sm');
        newEditBtn.textContent = 'Save';
        newEditBtn.addEventListener('click', async () => {
          newEditBtn.disabled = true;
          newEditBtn.textContent = 'Saving...';
          try {
            const resp = await API.put(
              '/api/memory/file?path=' + encodeURIComponent(filePath),
              { content: textarea.value }
            );
            Components.toast(resp && resp.receipt ? resp.receipt : 'Saved', 'success');
            overlay.remove();
          } catch (e) {
            Components.toast('Save failed: ' + (e.message || e), 'error');
            newEditBtn.disabled = false;
            newEditBtn.textContent = 'Save';
          }
        });
        textarea.focus();
      });
    } catch (err) {
      contentArea.innerHTML = '<div class="error-state">Failed to load: ' + err.message + '</div>';
    }
  },

  /// P2 — the actions a line can take, decided by where it came from:
  ///   a pin              → Unpin · Move to…
  ///   a profile line or a ranked memory → Pin this · Mark wrong
  ///   a "where we left off" line → nothing (it is a log, not a fact)
  /// The line's provenance is matched by its text, normalised the way
  /// `diff_curated` normalises it, so an action lands on the chunk the
  /// renderer actually used.
  _decorateMemoryLines(contentArea, bullets, markdown, getBaseHash, filePath, reopen) {
    const norm = (t) => String(t || '').trim().replace(/^[-*]\s+/, '').trim();
    const byText = new Map();
    for (const b of bullets) byText.set(norm(b.text), b);
    contentArea.querySelectorAll('.md-list-item').forEach((el) => {
      const key = norm(el.textContent);
      const b = byText.get(key);
      if (!b) return;
      const isPin = !!b.pinned || String(b.chunk_id).startsWith('pin-');
      const isLog = b.chunk_id === 'continuity';
      if (isLog) { el.classList.add('md-line-log'); el.title = 'From the work log — a receipt, not a fact. Nothing to pin.'; return; }
      el.classList.add('md-line-actionable');
      // Wrap the text so flex can put the actions at the right edge instead of
      // letting them wrap under a long line.
      const textWrap = document.createElement('span');
      textWrap.className = 'md-line-text';
      while (el.firstChild) textWrap.appendChild(el.firstChild);
      el.appendChild(textWrap);
      const acts = document.createElement('span');
      acts.className = 'md-line-actions';
      const mk = (label, title, cls) => {
        const btn = document.createElement('button');
        btn.className = 'btn btn-xs ' + (cls || '');
        btn.textContent = label; btn.title = title;
        acts.appendChild(btn);
        return btn;
      };
      if (isPin) {
        mk('Unpin', 'Stop showing this line to every session').addEventListener('click', async (ev) => {
          ev.stopPropagation();
          try { await API.del('/api/memory/pin?id=' + encodeURIComponent(b.chunk_id)); Components.toast('Unpinned', 'success'); reopen(); }
          catch (e) { Components.toast('Unpin failed: ' + (e.message || e), 'error'); }
        });
        const move = document.createElement('select');
        move.className = 'form-select md-line-move';
        move.title = 'Move to another section';
        const cur = this._pinSections.includes(b.section) ? b.section : 'Notes';
        // The resting label is the ACTION, not the current value — a select that
        // reads "Boundaries" looks like a label nobody can use.
        const head = document.createElement('option');
        head.value = cur; head.textContent = 'Move\u2026'; head.selected = true;
        move.appendChild(head);
        for (const sName of this._pinSections) {
          if (sName === cur) continue;
          const o = document.createElement('option'); o.value = sName; o.textContent = sName;
          move.appendChild(o);
        }
        move.addEventListener('click', (ev) => ev.stopPropagation());
        move.addEventListener('change', async () => {
          try {
            await API.post('/api/memory/pin', { text: b.text, section: move.value });
            await API.del('/api/memory/pin?id=' + encodeURIComponent(b.chunk_id));
            Components.toast('Moved to ' + move.value, 'success'); reopen();
          } catch (e) { Components.toast('Move failed: ' + (e.message || e), 'error'); }
        });
        acts.appendChild(move);
      } else {
        const section = this._pinSections.includes(b.section) ? b.section : 'Notes';
        mk('Pin this', 'Keep this line in every session, in your words, under ' + section).addEventListener('click', async (ev) => {
          ev.stopPropagation();
          try { await API.post('/api/memory/pin', { text: b.text, section }); Components.toast('Pinned under ' + section, 'success'); reopen(); }
          catch (e) { Components.toast('Pin failed: ' + (e.message || e), 'error'); }
        });
        const wrong = mk('Mark wrong', 'This fact is wrong — stop showing it. Reversible from the Conflicts tab.', 'md-line-wrong');
        wrong.addEventListener('click', (ev) => {
          ev.stopPropagation();
          // Inline confirmation, not a dialog: one sentence, two buttons, and
          // the way back named — a dialog is something people learn to click through.
          acts.innerHTML = '';
          // While confirming, the row stacks: the question must not squeeze the
          // fact it is asking about into a four-word column.
          el.classList.add('md-line-confirming');
          const q = document.createElement('span');
          q.className = 'md-line-confirm';
          q.textContent = 'Marks this fact wrong for every session. Undo from the Conflicts tab. ';
          acts.appendChild(q);
          const yes = mk('Mark wrong', '', 'md-line-wrong');
          const no = mk('Keep', '');
          no.addEventListener('click', (ev2) => { ev2.stopPropagation(); reopen(); });
          yes.addEventListener('click', async (ev2) => {
            ev2.stopPropagation();
            yes.disabled = true;
            // A one-line diff through the same adopt-or-409 path the text editor
            // uses: the render minus this line. Reject on an auto-selected line,
            // never a delete — the chunk is invalidated, the Conflicts tab lists it.
            const lines = markdown.split('\n');
            const idx = lines.findIndex((l) => norm(l) === key && /^\s*[-*]\s/.test(l));
            if (idx < 0) { Components.toast('Could not find that line in the current render — it may have moved. Reloading.', 'warning'); reopen(); return; }
            lines.splice(idx, 1);
            try {
              const resp = await API.put('/api/memory/file?path=' + encodeURIComponent(filePath), { content: lines.join('\n'), base_hash: getBaseHash() });
              Components.toast(resp && resp.receipt ? resp.receipt : 'Marked wrong', 'success');
              reopen();
            } catch (e) {
              if (e && e.status === 409) { Components.toast('MEMORY.md was re-rendered just now — reloaded, try again', 'warning'); reopen(); }
              else Components.toast('Could not mark it wrong: ' + (e.message || e), 'error');
            }
          });
        });
      }
      el.appendChild(acts);
    });
  },

  /// P2 — "Add a memory": the same POST the Pinned tab uses, at the top of the
  /// file, so the first thing a person reaches for is the thing that works.
  _toggleAddMemoryBox(contentArea, reopen) {
    const existing = contentArea.querySelector('.memory-add-box');
    if (existing) { existing.remove(); return; }
    const box = document.createElement('div');
    box.className = 'memory-add-box';
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'form-input'; input.placeholder = 'Something every session should know, in your words';
    input.maxLength = 500;
    const sel = document.createElement('select');
    sel.className = 'form-select';
    for (const sName of this._pinSections) { const o = document.createElement('option'); o.value = sName; o.textContent = sName; if (sName === 'Notes') o.selected = true; sel.appendChild(o); }
    const add = document.createElement('button'); add.className = 'btn btn-sm btn-primary'; add.textContent = 'Pin it';
    const submit = async () => {
      const text = input.value.trim();
      if (text.length < 4) { input.focus(); return; }
      add.disabled = true;
      try { await API.post('/api/memory/pin', { text, section: sel.value }); Components.toast('Pinned under ' + sel.value, 'success'); reopen(); }
      catch (e) { Components.toast('Pin failed: ' + (e.message || e), 'error'); add.disabled = false; }
    };
    add.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    box.appendChild(input); box.appendChild(sel); box.appendChild(add);
    contentArea.prepend(box);
    input.focus();
  },

  /// P2 — the advanced path. The textarea is the old editor; the difference is
  /// that Save first asks the daemon what the save WOULD do and shows it —
  /// "will pin 2 · mark 1 wrong · 2 lines ignored" with the ignored lines named —
  /// and only the second click applies exactly that. Editing after a preview
  /// resets it: the preview is of THIS text, not of some text.
  _rawEditWithPreview(contentArea, content, getBaseHash, setBaseHash, filePath, overlay, rawLink, addBtn) {
    contentArea.innerHTML = '';
    const note = document.createElement('div');
    note.className = 'memory-raw-note';
    note.textContent = 'Only bullet lines under a "## Section" heading become pins. Anything else you type is ignored, and the preview will name it.';
    contentArea.appendChild(note);
    const textarea = document.createElement('textarea');
    textarea.className = 'memory-editor-textarea memory-editor-textarea-modal';
    textarea.value = content;
    contentArea.appendChild(textarea);
    addBtn.hidden = true;
    rawLink.textContent = 'Preview';
    rawLink.classList.add('btn-primary');
    let previewed = false;
    let previewBanner = null;
    textarea.addEventListener('input', () => {
      if (previewed) { previewed = false; rawLink.textContent = 'Preview'; if (previewBanner) { previewBanner.remove(); previewBanner = null; } }
    });
    const fresh = rawLink.cloneNode(true);
    rawLink.replaceWith(fresh);
    fresh.addEventListener('click', async () => {
      fresh.disabled = true;
      try {
        if (!previewed) {
          const p = await API.post('/api/memory/file/preview?path=' + encodeURIComponent(filePath), { content: textarea.value, base_hash: getBaseHash() });
          if (previewBanner) previewBanner.remove();
          previewBanner = document.createElement('div');
          previewBanner.className = 'memory-preview-banner';
          const head = document.createElement('div');
          head.className = 'memory-preview-head';
          head.textContent = 'This save would: ' + (p.receipt || 'no changes');
          previewBanner.appendChild(head);
          if (Array.isArray(p.ignored) && p.ignored.length) {
            const ul = document.createElement('ul');
            ul.className = 'memory-preview-ignored';
            for (const ln of p.ignored) { const li = document.createElement('li'); li.textContent = ln; ul.appendChild(li); }
            const cap = document.createElement('div');
            cap.className = 'memory-preview-cap';
            cap.textContent = 'Ignored — not a bullet under a heading (put it under a "## Section" as "- …" to pin it):';
            previewBanner.appendChild(cap);
            previewBanner.appendChild(ul);
          }
          contentArea.insertBefore(previewBanner, textarea);
          const nothing = !((p.counts && (p.counts.added || p.counts.removed || p.counts.rejected || p.counts.moved)));
          previewed = !nothing;
          fresh.textContent = nothing ? 'Nothing to apply' : 'Apply: ' + p.receipt;
        } else {
          fresh.textContent = 'Applying...';
          const resp = await API.put('/api/memory/file?path=' + encodeURIComponent(filePath), { content: textarea.value, base_hash: getBaseHash() });
          Components.toast(resp && resp.receipt ? resp.receipt : 'Applied', 'success');
          overlay.remove();
          this._showFileViewer(filePath, null);
          return;
        }
      } catch (e) {
        if (e && e.status === 409 && e.data && e.data.error === 'stale_base') {
          setBaseHash(e.data.base_hash || getBaseHash());
          const mine = textarea.value;
          const banner = document.createElement('div');
          banner.className = 'error-state memory-stale-banner';
          banner.textContent = e.data.message || 'MEMORY.md changed while you were editing.';
          contentArea.insertBefore(banner, textarea);
          textarea.value = (e.data.current || '') +
            '\n\n<!-- ---- your edit, not yet applied — move your changes above this line ---- -->\n' +
            mine;
          previewed = false; fresh.textContent = 'Preview';
          Components.toast('Re-render happened first — your text is kept below the marker', 'warning');
        } else if (e && e.status === 409) {
          Components.toast((e.data && e.data.message) || e.message, 'warning');
        } else {
          Components.toast('Failed: ' + (e.message || e), 'error');
        }
      } finally {
        fresh.disabled = false;
      }
    });
    textarea.focus();
  },

  _renderMarkdown(content) {
    const lines = content.split('\n');
    let html = '';
    let inCode = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      if (line.startsWith('```')) {
        if (inCode) {
          html += '</code></pre>';
          inCode = false;
        } else {
          html += '<pre data-line="' + lineNum + '"><code>';
          inCode = true;
        }
        continue;
      }

      if (inCode) {
        html += this._escapeHtml(line) + '\n';
        continue;
      }

      if (line.match(/^#{1,3}\s/)) {
        const level = line.match(/^(#+)/)[1].length;
        const text = line.replace(/^#+\s+/, '');
        html += '<h' + (level + 1) + ' data-line="' + lineNum + '">' + this._escapeHtml(text) + '</h' + (level + 1) + '>';
      } else if (line.match(/^[-*]\s/)) {
        html += '<div class="md-list-item" data-line="' + lineNum + '">' + this._escapeHtml(line) + '</div>';
      } else if (line.trim() === '') {
        html += '<br>';
      } else {
        html += '<p data-line="' + lineNum + '">' + this._escapeHtml(line) + '</p>';
      }
    }

    if (inCode) html += '</code></pre>';
    return html;
  },

  // Shared escaper — null-safe, and covers quotes (old copy didn't).
  _escapeHtml(str) {
    return window.VodouSafe.escapeHtml(str);
  },
};
