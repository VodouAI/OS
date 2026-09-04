/**
 * Skills View — searchable, category-grouped list with toggle
 */
const SkillsView = {
  expandedSkill: null,
  allSkills: [],
  searchQuery: '',
  // item 17 — 'all' | 'wide' | 'checks' | 'scheduled'. Never persisted: a filter
  // that survives a reload looks like an empty skill list.
  shapeFilter: 'all',
  // Phase 6 reorg (kind-first):
  //   activeTab: 'subagents' | 'workflows' | 'mine'
  //   collapsedSubgroups: keyed `${tab}:${subgroupKey}`
  activeTab: 'workflows',
  collapsedSubgroups: {},

  _healthData: null,
  _workflowSkills: new Set(),
  _standingAgents: [],

  /**
   * PLAN-ALPHA F5 — "Standing agents": the skills_meta rows, with last outcome.
   *
   * Shows what a stranger opening this page most needs: which agents exist, when
   * they next fire, where they deliver, and whether the last run actually worked.
   * "Worked" is the run-outcome vocabulary from step 3 — before it, a 0-byte run
   * and a real briefing were both logged `ok`, so this row could not have been
   * drawn honestly at all.
   */
  _buildStandingAgents() {
    // 0.6.31 — one tab among peers (Workflows · SubAgent Personas · My Skills ·
    // Standing agents · Needs review); the tab names the section, so there is
    // no page header here. The page-level search filters this list too.
    const items = this._filterStanding();
    if (!items.length) return Components.emptyState(this.searchQuery ? 'No standing agents match.' : 'No standing agents yet.');

    const section = document.createElement('div');
    section.className = 'standing-agents';

    const list = document.createElement('div');
    list.className = 'standing-agents-list';

    const STATUS_LABEL = {
      did_the_job: ['ok', 'var(--success, #2e7d32)'],
      degraded: ['degraded', 'var(--warning, #ed6c02)'],
      could_not: ['failed', 'var(--danger, #c62828)'],
      deferred: ['deferred', 'var(--muted, #757575)'],
      running: ['running', 'var(--muted, #757575)'],
      unknown: ['unknown', 'var(--muted, #757575)'],
    };

    for (const a of items) {
      const row = document.createElement('div');
      row.className = 'standing-agent-row';

      const title = document.createElement('div');
      title.className = 'standing-agent-title';
      title.textContent = a.displayName || a.name;
      if (!a.isActive) {
        const off = document.createElement('span');
        off.className = 'badge';
        off.textContent = 'disabled';
        title.appendChild(off);
      }
      row.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'standing-agent-meta';
      const bits = [];
      if (a.scheduleCron) bits.push(`cron ${a.scheduleCron}`);
      // The two records disagreeing is worth showing, not smoothing over: it
      // means the schedule someone configured is not the schedule that runs.
      if (a.scheduleCronMismatch) {
        bits.push(`\u26a0 skills_meta says ${a.scheduleCronMismatch}`);
      }
      if (a.nextRunAt) bits.push(`next ${a.nextRunAt}`);
      bits.push(a.deliveryMode === 'console'
        ? 'delivers to console'
        : `delivers to ${a.deliveryTarget || a.deliveryMode}`);
      if (a.declaredTools && a.declaredTools.length) {
        bits.push(`${a.declaredTools.length} declared tool(s)`);
      }
      meta.textContent = bits.join(' \u00b7 ');
      row.appendChild(meta);

      const last = document.createElement('div');
      last.className = 'standing-agent-last';
      if (!a.lastRun) {
        // Distinct from a failure, and worth saying: an agent that has never run
        // reads as broken if the row is left blank.
        last.textContent = 'no run recorded yet';
      } else {
        const [label, color] = STATUS_LABEL[a.lastRun.status] || [a.lastRun.status, 'var(--muted, #757575)'];
        const dot = document.createElement('span');
        dot.className = 'standing-agent-status';
        dot.textContent = label;
        dot.style.color = color;
        last.appendChild(dot);
        const detail = [];
        if (a.lastRun.startedAt) detail.push(a.lastRun.startedAt);
        if (a.lastRun.outputChars !== null && a.lastRun.outputChars !== undefined) {
          detail.push(`${a.lastRun.outputChars} chars`);
        }
        if (a.lastRun.deliveryOk === false) detail.push('NOT delivered');
        if (a.lastRun.latenessS !== null && a.lastRun.latenessS !== undefined && a.lastRun.latenessS > 60) {
          detail.push(`${a.lastRun.latenessS}s late`);
        }
        if (a.lastRun.reason) detail.push(a.lastRun.reason);
        if (detail.length) {
          const d = document.createElement('span');
          d.className = 'standing-agent-detail';
          d.textContent = ' \u2014 ' + detail.join(' \u00b7 ');
          last.appendChild(d);
        }
      }
      row.appendChild(last);

      if (a.conversationId) {
        const open = document.createElement('button');
        open.className = 'btn btn-sm';
        open.textContent = 'Open';
        open.addEventListener('click', () => {
          if (typeof Router !== 'undefined' && Router.navigate) {
            Router.navigate(`/chat?c=${encodeURIComponent(a.conversationId)}`);
          } else {
            window.location.hash = `#/chat?c=${encodeURIComponent(a.conversationId)}`;
          }
        });
        row.appendChild(open);
      }

      list.appendChild(row);
    }

    section.appendChild(list);
    return section;
  },

  // 'workflows' | 'subagents' | 'mine' show the registry list; 'standing' and
  // 'review' are the two peers that used to be blocks stacked above it.
  LIST_TABS: ['subagents', 'workflows', 'mine'],
  _isListTab() { return this.LIST_TABS.includes(this.activeTab); },

  async render(container) {
    this._container = container;
    // The Capabilities tab bar already says "Skills"; no second title.
    container.innerHTML = '';
    container.appendChild(Components.loading());

    // Deep link: #/capabilities?tab=skills&kind=review (the review badge, ⌘K).
    const q = location.hash.includes('?') ? location.hash.split('?')[1] : '';
    const kind = new URLSearchParams(q).get('kind');
    if (kind && ['subagents', 'workflows', 'mine', 'standing', 'review'].includes(kind)) this.activeTab = kind;

    try {
      const [skills, healthData, workflows, standing, shapes] = await Promise.all([
        API.get('/api/skills'),
        API.get('/api/skills/health').catch(() => ({ healthy: [], broken: [] })),
        API.get('/api/workflows').catch(() => ({ skills: [] })),
        // PLAN-ALPHA F5 — the skills_meta lane. This view read only /api/skills
        // (skills_registry), so the four standing agents the product is actually
        // about were invisible here. Two skill systems, one view.
        API.get('/api/skill-console/list').catch(() => ({ items: [] })),
        // item 16/17 — the shape of each skill's compiled graph. Optional by
        // design: an install with no actions.json anywhere still renders, it
        // just shows no glyphs.
        API.get('/api/graph/shapes').catch(() => ({ items: [] })),
      ]);
      this._standingAgents = (standing && standing.items) || [];
      this.allSkills = skills;
      this._healthData = healthData;
      // Track which skills have executable workflows (actions.json)
      this._workflowSkills = new Set((workflows.skills || []).map(w => w.name));
      // Keyed by skill name — the same identity every other view uses.
      this._shapes = new Map(((shapes && shapes.items) || []).map(i => [i.skill, i]));
      container.innerHTML = '';

      // An install with no registry skills but running agents must still show
      // the agents: land on the Standing agents tab instead of an empty list.
      if (this.allSkills.length === 0 && this._standingAgents.length && this._isListTab()) {
        this.activeTab = 'standing';
      }

      // Sticky unit: sub-tabs + controls + column bar. Flush at the top of the
      // scrollport (10-pages.css); the page title is the Capabilities tab.
      const stickyHeader = document.createElement('div');
      stickyHeader.className = 'skills-sticky-header';

      // Tab bar — kind-first taxonomy plus the two peers
      stickyHeader.appendChild(this._buildTabBar());

      const controlsRow = this._buildControls();
      const actions = controlsRow.querySelector('.skills-actions');

      // Add "+ New Skill" button to controls
      const newBtn = document.createElement('button');
      newBtn.className = 'btn btn-primary';
      newBtn.textContent = '+ New skill';
      newBtn.addEventListener('click', () => {
        if (typeof SkillRunner !== 'undefined') {
          SkillRunner.open('create-a-skill');
        } else {
          this._showCreateModal(container);
        }
      });
      // 0.6.31 — the "Automated skill" nav row became a button on the page it
      // belongs to (brief §4). Same handler the nav row had: the wizard lives
      // in Chat, so route there first when needed.
      const autoBtn = document.createElement('button');
      autoBtn.type = 'button';
      autoBtn.className = 'btn';
      autoBtn.textContent = '+ Automated skill';
      autoBtn.title = 'Create a Skill Console \u2014 its own chat tab, optional schedule';
      autoBtn.addEventListener('click', () => {
        if (typeof ChatView === 'undefined' || typeof ChatView._openNewSkillConsoleWizard !== 'function') return;
        if (location.hash.split('?')[0] !== '#/chat') {
          window.location.hash = '#/chat';
          setTimeout(() => ChatView._openNewSkillConsoleWizard(), 30);
        } else {
          ChatView._openNewSkillConsoleWizard();
        }
      });
      actions.appendChild(autoBtn);
      // One primary per viewport: the create action.
      actions.appendChild(newBtn);

      stickyHeader.appendChild(controlsRow);

      // Column header (part of sticky block; list tabs only)
      const colHeader = document.createElement('div');
      colHeader.className = 'skills-col-header';
      colHeader.innerHTML = `
        <span class="skills-col skills-col-toggle"></span>
        <span class="skills-col skills-col-name">Name</span>
        <span class="skills-col skills-col-uses">Apps</span>
        <span class="skills-col skills-col-edit">Options</span>
      `;
      stickyHeader.appendChild(colHeader);

      container.appendChild(stickyHeader);

      // Collapse all sub-groups by default (on first load)
      if (Object.keys(this.collapsedSubgroups).length === 0) {
        for (const s of this.allSkills) {
          const t = this._getTab(s);
          this.collapsedSubgroups[`${t}:${this._getSubgroup(s, t)}`] = true;
        }
      }

      // Skills list container
      const listWrap = document.createElement('div');
      listWrap.id = 'skills-list-wrap';
      container.appendChild(listWrap);

      this._renderList(listWrap);

    } catch (err) {
      container.innerHTML = '';
      container.appendChild(Components.errorState('Failed to load skills: ' + err.message));
    }
  },

  _pendingReview() { return (this.allSkills || []).filter(s => s.awaiting_review); },
  _filterStanding() {
    const items = this._standingAgents || [];
    if (!this.searchQuery) return items;
    const q = this.searchQuery;
    return items.filter(a => ((a.displayName || '') + ' ' + (a.name || '')).toLowerCase().includes(q));
  },
  _filterReview() {
    const items = this._pendingReview();
    if (!this.searchQuery) return items;
    const q = this.searchQuery;
    return items.filter(s => ((s.name || '') + ' ' + (s.description || '')).toLowerCase().includes(q));
  },

  // Needs review — autonomous PROPOSE→VERIFY→PROMOTE drafts awaiting a human
  // decision. Drafts are inert (never route) until promoted here. 0.6.31: a
  // tab beside the list tabs instead of an accent-bordered box above it; the
  // rows and their actions (Verify / Promote / Discard) are unchanged.
  _buildReviewList() {
    const pending = this._filterReview();
    const panel = document.createElement('div');
    panel.className = 'skills-review-panel';
    if (pending.length === 0) {
      panel.appendChild(Components.emptyState(this.searchQuery ? 'No proposed skills match.' : 'Nothing waiting for review.'));
      return panel;
    }

    const sub = document.createElement('div');
    sub.className = 'skills-review-note';
    sub.textContent = 'Vodou proposed these from your recurring workflows. They are inert (never route) until you promote them.';
    panel.appendChild(sub);

    for (const s of pending) {
      const vs = s.verify_status || 'not verified';
      const ready = s.verify_status === 'pass';
      const row = document.createElement('div');
      row.className = 'skills-review-row';

      const info = document.createElement('div');
      info.className = 'skills-review-info';
      const verifyCls = ready ? ' is-pass' : (s.verify_status === 'fail' ? ' is-fail' : '');
      const curric = s.curriculum_born
        ? ` <span class="skills-review-curriculum" title="self-practiced \u2014 human promotion required">[curriculum]</span>`
        : '';
      info.innerHTML = `<div class="skills-review-name">${this._esc(s.name)}${curric}` +
        `<span class="skills-review-verify${verifyCls}">verify: ${this._esc(vs)}</span></div>` +
        `<div class="skills-review-desc">${this._esc(s.description || '')}</div>`;
      row.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'skills-review-actions';
      if (!ready) {
        actions.appendChild(this._reviewBtn('Verify', 'btn-secondary', () => this._skillAction(s.name, 'verify')));
      }
      if (ready) {
        actions.appendChild(this._reviewBtn('Promote', 'btn-primary', () => this._skillAction(s.name, 'promote')));
      }
      actions.appendChild(this._reviewBtn('Discard', 'btn-secondary', () => {
        if (confirm(`Deprecate draft "${s.name}"? It will be discarded.`)) this._skillAction(s.name, 'deprecate');
      }));
      row.appendChild(actions);
      panel.appendChild(row);
    }
    return panel;
  },

  _reviewBtn(label, cls, onClick) {
    const b = document.createElement('button');
    b.className = 'btn ' + cls;
    b.textContent = label;
    b.addEventListener('click', async () => {
      b.disabled = true; const orig = b.textContent; b.textContent = '…';
      try { await onClick(); } finally { b.disabled = false; b.textContent = orig; }
    });
    return b;
  },

  async _skillAction(name, action) {
    try {
      const r = await API.post(`/api/skills/${encodeURIComponent(name)}/${action}`, {});
      if (typeof Components !== 'undefined' && Components.toast) {
        Components.toast(r && r.ok ? `${action} ✓ ${name}` : `${action} failed: ${(r && r.output) || 'see logs'}`,
          r && r.ok ? 'success' : 'error');
      } else {
        alert((r && r.output) || `${action} done`);
      }
    } catch (e) {
      alert(`${action} failed: ${e.message}`);
    }
    if (window.refreshSkillsReviewBadge) window.refreshSkillsReviewBadge();
    if (this._container) this.render(this._container); // refresh the view
  },

  // Shared escaper — safe.js loads first, so VodouSafe is always present.
  _esc(s) { return window.VodouSafe.escapeHtml(s); },

  // Path-based category (kept for backwards compat in modal pickers / filters)
  _getCategory(skill) {
    const dir = skill.directory_path || skill.file_path || '';
    const match = dir.match(/skills\/(.+?)\/[^/]+\/?$/);
    if (match) return match[1];
    const match2 = dir.match(/skills\/([^/]+)/);
    if (match2) return match2[1];
    const parts = dir.replace(/\/$/, '').split('/').filter(Boolean);
    if (parts.length >= 2) return parts.slice(0, -1).join('/');
    if (parts.length === 1) return parts[0];
    return 'other';
  },

  // Top-level tab a skill belongs to (kind-first taxonomy).
  // Each skill lands in exactly one of: 'subagents' | 'workflows' | 'mine'.
  _getTab(skill) {
    const dir = (skill.directory_path || skill.file_path || '').replace(/^skills\//, '');
    const top = dir.split('/')[0] || '';
    if (top === 'my-skills') return 'mine';
    if (skill.kind === 'subagent' || top === 'agents') return 'subagents';
    return 'workflows';
  },

  // Sub-group within an active tab (rendered as collapsible section)
  _getSubgroup(skill, tab) {
    const dir = (skill.directory_path || skill.file_path || '').replace(/^skills\//, '');
    const parts = dir.split('/').filter(Boolean);
    if (tab === 'subagents') {
      // agents/<dept>/<name>  → <dept>; agents/<name> → general
      if (parts[0] === 'agents' && parts.length >= 3) return parts[1];
      return 'general';
    }
    if (tab === 'workflows') {
      // Group by source: built-in (subgroup by top dir like vodou-core/templates),
      // catalog/imported/forked stay as their own subgroup.
      const src = this._getSource(skill);
      if (src === 'catalog') return 'catalog';
      if (src === 'imported') return 'imported';
      if (src === 'forked') return 'forked';
      // built-in: bucket by top dir
      if (parts[0] === 'vodou-core') return 'vodou-core';
      if (parts[0] === 'templates') return 'templates';
      if (parts[0] === 'community') return 'community';
      return 'other';
    }
    return 'all'; // mine — flat
  },

  // Defensive client-side fallback if server hasn't shipped `source` yet.
  _getSource(skill) {
    if (skill.source) return skill.source;
    const dir = (skill.directory_path || skill.file_path || '').replace(/^skills\//, '');
    const top = dir.split('/')[0] || '';
    if (top === 'catalog') return 'catalog';
    if (top === 'imported' || top === 'installed') return 'imported';
    if (top === 'forks') return 'forked';
    if (top === 'my-skills') return 'mine';
    return 'built-in';
  },

  // Effective kind — server may not return one for legacy rows; infer from path.
  _getKind(skill) {
    if (skill.kind) return skill.kind;
    const tab = this._getTab(skill);
    return tab === 'subagents' ? 'subagent' : 'workflow';
  },

  _getSubgroupLabel(tab, sg) {
    if (tab === 'subagents') {
      const labels = {
        engineering: 'Engineering', design: 'Design', marketing: 'Marketing',
        product: 'Product', 'project-management': 'Project Management',
        'studio-operations': 'Studio Operations', testing: 'Testing',
        fundraising: 'Fundraising', general: 'General',
      };
      return labels[sg] || sg.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
    if (tab === 'workflows') {
      const labels = {
        'vodou-core': 'Vodou Core', templates: 'Templates', community: 'Community',
        catalog: 'Catalog (installed)', imported: 'Imported', forked: 'Forked',
        other: 'Other',
      };
      return labels[sg] || sg;
    }
    return 'My Skills';
  },

  _getCategoryLabel(cat) {
    const labels = {
      'agents/engineering': 'Engineering',
      'agents/design': 'Design',
      'agents/marketing': 'Marketing',
      'agents/product': 'Product',
      'agents/project-management': 'Project Management',
      'agents/studio-operations': 'Studio Operations',
      'agents/testing': 'Testing',
      'vodou-core': 'Vodou Core',
      'vodou-core/walk-through': 'Walkthroughs',
      'vodou-core/walk-through copy': 'Walkthroughs',
      'community': 'Community',
      'my-skills': 'My Skills',
    };
    return labels[cat] || cat.split('/').pop().replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  },

  _getAllCategories() {
    const cats = new Set();
    for (const s of this.allSkills) {
      cats.add(this._getCategory(s));
    }
    return [...cats].sort();
  },

  _buildControls() {
    const bar = document.createElement('div');
    bar.className = 'skills-controls';

    // Search
    const search = document.createElement('input');
    search.type = 'text';
    search.placeholder = 'Search skills...';
    search.value = this.searchQuery;
    search.className = 'skills-control-input';
    let searchTimeout;
    search.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        this.searchQuery = search.value.toLowerCase();
        const wrap = document.getElementById('skills-list-wrap');
        if (wrap) this._renderList(wrap);
      }, 200);
    });
    bar.appendChild(search);

    // item 17 — shape filter chips. Rendered ONLY when the shapes lane returned
    // something a chip could match; a filter that can never select anything is
    // worse than no filter, because it reads as "you have none of these" when
    // the truth is "nothing was measured".
    // Only shapes for skills THIS LIST can actually show.
    //
    // `/api/graph/shapes` scans the filesystem; the list renders from
    // `/api/skills`, which is the registry. A skill on disk but not yet
    // registered appears in the first and not the second — so availability
    // computed from the raw shapes made the chip render and then match nothing
    // ("0 of 9 · No skills in this section yet"), which is precisely the
    // empty-filter case the comment below claims to prevent. Caught by opening
    // the page, not by any test.
    const listed = new Set((this.allSkills || []).map(s => s.name));
    const shapes = this._shapes ? [...this._shapes.values()].filter(x => listed.has(x.skill)) : [];
    const chipDefs = [
      { key: 'all', label: 'all', hint: 'Every skill', avail: () => true },
      { key: 'wide', label: 'wide', hint: 'Runs more than one thing at once', avail: () => shapes.some(x => x.widest > 1) },
      { key: 'checks', label: 'with checks', hint: 'Has a check: step that can reject the result', avail: () => shapes.some(x => x.checks > 0) },
      { key: 'scheduled', label: 'scheduled', hint: 'Runs on a schedule', avail: () => shapes.some(x => x.scheduled) },
    ].filter(c => c.avail());

    if (chipDefs.length > 1) {
      const chipWrap = document.createElement('div');
      chipWrap.className = 'skills-shape-filters';
      for (const def of chipDefs) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'skills-shape-chip' + ((this.shapeFilter || 'all') === def.key ? ' active' : '');
        chip.textContent = def.label;
        chip.title = def.hint;
        chip.addEventListener('click', () => {
          this.shapeFilter = def.key;
          for (const c of chipWrap.querySelectorAll('.skills-shape-chip')) c.classList.remove('active');
          chip.classList.add('active');
          const wrap = document.getElementById('skills-list-wrap');
          if (wrap) this._renderList(wrap);
        });
        chipWrap.appendChild(chip);
      }
      bar.appendChild(chipWrap);
    }

    // Count display (kept; tab bar replaces the category dropdown)
    const countLabel = document.createElement('span');
    countLabel.id = 'skills-filter-count';
    countLabel.className = 'skills-filter-count';
    bar.appendChild(countLabel);

    // Actions, right-aligned. One primary (+ New skill, appended by render()).
    const actions = document.createElement('div');
    actions.className = 'skills-actions';

    const catalogBtn = document.createElement('button');
    catalogBtn.className = 'btn';
    catalogBtn.textContent = 'Browse catalog';
    catalogBtn.title = 'Install skills from the public Vodou catalog';
    catalogBtn.addEventListener('click', () => this._openCatalogModal());
    actions.appendChild(catalogBtn);

    const importBtn = document.createElement('button');
    importBtn.className = 'btn';
    importBtn.textContent = 'Import…';
    importBtn.title = 'Import a skill from a URL or local path';
    importBtn.addEventListener('click', () => this._openImportModal());
    actions.appendChild(importBtn);

    bar.appendChild(actions);
    return bar;
  },

  // Top-level tab bar — splits skills into SubAgent Personas / Workflows / My Skills
  _buildTabBar() {
    const counts = { subagents: 0, workflows: 0, mine: 0 };
    for (const s of this.allSkills) counts[this._getTab(s)]++;
    const pending = this._pendingReview().length;
    const tabs = [
      { id: 'workflows', label: 'Workflows', count: counts.workflows },
      { id: 'subagents', label: 'SubAgent Personas', count: counts.subagents },
      { id: 'mine', label: 'My Skills', count: counts.mine },
      { id: 'standing', label: 'Standing agents', count: (this._standingAgents || []).length },
      { id: 'review', label: 'Needs review', count: pending, queue: pending > 0 },
    ];
    const bar = document.createElement('div');
    bar.className = 'settings-tab-bar skills-kind-tab-bar';
    bar.setAttribute('role', 'tablist');
    for (const t of tabs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'settings-tab' + (t.id === this.activeTab ? ' active' : '');
      btn.dataset.kindTab = t.id;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', t.id === this.activeTab ? 'true' : 'false');
      btn.textContent = t.label;
      const n = document.createElement('span');
      n.className = 'skills-tab-count' + (t.queue ? ' is-queue' : '');
      n.textContent = String(t.count);
      btn.appendChild(n);
      btn.addEventListener('click', () => {
        this.activeTab = t.id;
        bar.querySelectorAll('.settings-tab').forEach(b => {
          const on = b.dataset.kindTab === t.id;
          b.classList.toggle('active', on);
          b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        const wrap = document.getElementById('skills-list-wrap');
        if (wrap) this._renderList(wrap);
      });
      bar.appendChild(btn);
    }
    return bar;
  },

  // Shape chips and the column header only mean something for the registry list.
  _syncHeaderForTab() {
    const root = this._container || document;
    const list = this._isListTab();
    const chips = root.querySelector('.skills-shape-filters');
    if (chips) chips.hidden = !list;
    const col = root.querySelector('.skills-col-header');
    if (col) col.hidden = !list;
  },

  async _openCatalogModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.55); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); display: flex; align-items: center; justify-content: center; z-index: 1000;';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.cssText = 'max-width: 720px; max-height: 85vh; display: flex; flex-direction: column; background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: 8px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); width: 90vw;';

    const header = document.createElement('div');
    header.className = 'modal-header';
    header.style.flexShrink = '0';
    header.innerHTML = '<h3>Vodou Skills Catalog</h3>';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => overlay.remove());
    header.appendChild(closeBtn);
    modal.appendChild(header);

    const body = document.createElement('div');
    body.className = 'modal-body';
    body.style.cssText = 'overflow-y: auto; flex: 1 1 auto; min-height: 0;';
    body.innerHTML = '<p>Loading…</p>';
    modal.appendChild(body);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    try {
      const data = await API.get('/api/skills/catalog');
      body.innerHTML = '';

      // Filter input
      const filterInput = document.createElement('input');
      filterInput.type = 'text';
      filterInput.placeholder = 'Filter by name, summary, or tag…';
      filterInput.className = 'skills-control-input';
      filterInput.style.width = '100%';
      filterInput.style.marginBottom = '1rem';
      body.appendChild(filterInput);

      const list = document.createElement('div');
      list.className = 'catalog-list';
      body.appendChild(list);

      const renderList = () => {
        const q = filterInput.value.toLowerCase().trim();
        list.innerHTML = '';
        const filtered = data.entries.filter(e => {
          if (!q) return true;
          const hay = `${e.id} ${e.skill_name} ${e.summary} ${(e.tags || []).join(' ')}`.toLowerCase();
          return hay.includes(q);
        });
        if (filtered.length === 0) {
          list.innerHTML = '<p style="color: var(--text-muted)">No matches.</p>';
          return;
        }
        for (const entry of filtered) {
          const card = document.createElement('div');
          card.className = 'catalog-card';
          card.style.cssText = 'border: 1px solid var(--border); border-radius: 6px; padding: 0.75rem; margin-bottom: 0.5rem;';
          const titleRow = document.createElement('div');
          titleRow.style.cssText = 'display: flex; justify-content: space-between; align-items: center;';
          const title = document.createElement('strong');
          title.textContent = entry.id + (entry.installed ? '  ✓ installed' : '');
          if (entry.installed) title.style.color = 'var(--success, #2a7)';
          titleRow.appendChild(title);

          const buttonRow = document.createElement('div');
          buttonRow.style.cssText = 'display: flex; gap: 0.4rem; flex-wrap: wrap; justify-content: flex-end;';

          const detailsBtn = document.createElement('button');
          detailsBtn.className = 'btn';
          detailsBtn.textContent = 'Details';
          detailsBtn.addEventListener('click', () => this._toggleDetails(card, entry));
          buttonRow.appendChild(detailsBtn);

          // Fork + Update buttons (only for installed catalog skills)
          if (entry.installed) {
            const forkBtn = document.createElement('button');
            forkBtn.className = 'btn';
            forkBtn.textContent = 'Fork';
            forkBtn.title = 'Copy this skill to skills/forks/ for local edits while preserving upstream baseline';
            forkBtn.addEventListener('click', async () => {
              forkBtn.disabled = true;
              forkBtn.textContent = 'Forking…';
              const oldErr = card.querySelector('.catalog-card-error');
              if (oldErr) oldErr.remove();
              try {
                await API.post('/api/skills/fork', { name: entry.skill_name });
                forkBtn.textContent = 'Forked ✓';
              } catch (err) {
                let msg = err.message || String(err);
                try { const p = JSON.parse(msg); msg = `${p.error || 'Failed'}${p.stderr ? '\n\n' + p.stderr : ''}${p.stdout ? '\n\n' + p.stdout : ''}`.trim(); } catch {}
                const errBox = document.createElement('div');
                errBox.className = 'catalog-card-error';
                errBox.style.cssText = 'margin-top: 0.4rem; padding: 0.4rem 0.6rem; background: rgba(220,50,50,0.1); border-left: 3px solid #c33; color: #c44; font-size: 0.85em; white-space: pre-wrap;';
                errBox.textContent = msg;
                card.appendChild(errBox);
                forkBtn.disabled = false;
                forkBtn.textContent = 'Fork';
              }
            });
            buttonRow.appendChild(forkBtn);

            const updateBtn = document.createElement('button');
            updateBtn.className = 'btn';
            updateBtn.textContent = 'Check for updates';
            updateBtn.title = '3-way merge upstream changes into this fork';
            updateBtn.addEventListener('click', async () => {
              updateBtn.disabled = true;
              updateBtn.textContent = 'Checking…';
              const oldErr = card.querySelector('.catalog-card-error');
              if (oldErr) oldErr.remove();
              const oldOut = card.querySelector('.catalog-card-output');
              if (oldOut) oldOut.remove();
              try {
                const r = await API.post('/api/skills/update', { name: entry.skill_name });
                const out = document.createElement('pre');
                out.className = 'catalog-card-output';
                out.style.cssText = 'margin-top: 0.4rem; padding: 0.5rem; background: var(--bg-tertiary); border-radius: 4px; font-size: 0.8em; white-space: pre-wrap; max-height: 200px; overflow-y: auto;';
                out.textContent = r.stdout || 'no output';
                card.appendChild(out);
                updateBtn.textContent = 'Check for updates';
                updateBtn.disabled = false;
              } catch (err) {
                let msg = err.message || String(err);
                try { const p = JSON.parse(msg); msg = `${p.error || 'Failed'}${p.stderr ? '\n\n' + p.stderr : ''}${p.stdout ? '\n\n' + p.stdout : ''}`.trim(); } catch {}
                const errBox = document.createElement('div');
                errBox.className = 'catalog-card-error';
                errBox.style.cssText = 'margin-top: 0.4rem; padding: 0.4rem 0.6rem; background: rgba(220,50,50,0.1); border-left: 3px solid #c33; color: #c44; font-size: 0.85em; white-space: pre-wrap;';
                errBox.textContent = msg;
                card.appendChild(errBox);
                updateBtn.disabled = false;
                updateBtn.textContent = 'Check for updates';
              }
            });
            buttonRow.appendChild(updateBtn);
          }

          const installBtn = document.createElement('button');
          installBtn.className = 'btn ' + (entry.installed ? '' : 'btn-primary');
          installBtn.textContent = entry.installed ? 'Uninstall' : 'Install';
          installBtn.addEventListener('click', async () => {
            installBtn.disabled = true;
            installBtn.textContent = entry.installed ? 'Uninstalling…' : 'Installing…';
            // Clear any prior inline error
            const oldErr = card.querySelector('.catalog-card-error');
            if (oldErr) oldErr.remove();
            try {
              if (entry.installed) {
                await API.post('/api/skills/uninstall', { name: entry.skill_name });
              } else {
                await API.post('/api/skills/install', { id: entry.id });
              }
              entry.installed = !entry.installed;
              renderList();
            } catch (err) {
              const errBox = document.createElement('div');
              errBox.className = 'catalog-card-error';
              errBox.style.cssText = 'margin-top: 0.4rem; padding: 0.4rem 0.6rem; background: rgba(220,50,50,0.1); border-left: 3px solid #c33; color: #c44; font-size: 0.85em; white-space: pre-wrap;';
              // api.js throws Error(text) where text is the JSON body — pretty-print if parseable
              let msg = err.message || String(err);
              try {
                const parsed = JSON.parse(msg);
                msg = `${parsed.error || 'Failed'}${parsed.stderr ? '\n\n' + parsed.stderr : ''}${parsed.stdout ? '\n\n' + parsed.stdout : ''}`.trim();
              } catch { /* not JSON, use raw */ }
              errBox.textContent = msg;
              card.appendChild(errBox);
              installBtn.disabled = false;
              installBtn.textContent = entry.installed ? 'Uninstall' : 'Install';
            }
          });
          buttonRow.appendChild(installBtn);
          titleRow.appendChild(buttonRow);

          card.appendChild(titleRow);

          const summary = document.createElement('div');
          summary.style.cssText = 'color: var(--text-muted); margin-top: 0.25rem; font-size: 0.9em;';
          summary.textContent = entry.summary || '';
          card.appendChild(summary);

          if (entry.tags && entry.tags.length) {
            const tags = document.createElement('div');
            tags.style.cssText = 'margin-top: 0.4rem; font-size: 0.8em; color: var(--text-muted);';
            tags.textContent = 'tags: ' + entry.tags.join(', ');
            card.appendChild(tags);
          }
          list.appendChild(card);
        }
      };

      filterInput.addEventListener('input', renderList);
      renderList();

      const footer = document.createElement('div');
      footer.style.cssText = 'margin-top: 1rem; font-size: 0.85em; color: var(--text-muted); display: flex; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem;';
      const meta = document.createElement('span');
      meta.textContent = `${data.total} skills · catalog v${data.catalog_version} · updated ${data.updated_at}`;
      footer.appendChild(meta);

      // Best-effort: derive a GitHub repo URL from the catalog index URL.
      const repoUrl = (data.catalog_url || '')
        .replace('https://raw.githubusercontent.com/', 'https://github.com/')
        .replace(/\/main\/index\.json.*$/, '')
        .replace(/\/index\.json.*$/, '');
      if (repoUrl && repoUrl.startsWith('https://github.com/')) {
        const link = document.createElement('a');
        link.href = repoUrl;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'Catalog repo on GitHub →';
        link.style.color = 'var(--accent, #4af)';
        footer.appendChild(link);
      }
      body.appendChild(footer);
    } catch (err) {
      body.innerHTML = `<p style="color: var(--error)">Failed to load catalog: ${err.message || err}</p>`;
    }
  },

  async _toggleDetails(card, entry) {
    let panel = card.querySelector('.catalog-card-details');
    if (panel) {
      panel.remove();
      return;
    }
    panel = document.createElement('div');
    panel.className = 'catalog-card-details';
    panel.style.cssText = 'margin-top: 0.6rem; padding: 0.6rem; background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: 4px; font-size: 0.85em;';
    panel.innerHTML = '<em>Loading SKILL.md…</em>';
    card.appendChild(panel);

    try {
      // Fetch the raw SKILL.md from the catalog at the pinned ref
      const src = entry.source || {};
      const repo = (src.url || '').replace('https://github.com/', 'https://raw.githubusercontent.com/');
      const url = `${repo}/${src.ref || 'main'}/${src.path_in_repo || ''}/SKILL.md`;
      const resp = await fetch(url + `?_=${Date.now()}`);
      if (!resp.ok) {
        panel.innerHTML = `<span style="color: var(--error)">HTTP ${resp.status} for ${url}</span>`;
        return;
      }
      const text = await resp.text();

      // Strip frontmatter for body display, render frontmatter as a meta block
      let frontmatter = '';
      let bodyText = text;
      if (text.startsWith('---')) {
        const end = text.indexOf('\n---', 4);
        if (end >= 0) {
          frontmatter = text.slice(4, end).trim();
          bodyText = text.slice(end + 4).replace(/^\s+/, '');
        }
      }

      panel.innerHTML = '';
      const meta = document.createElement('pre');
      meta.style.cssText = 'background: var(--code-bg); padding: 0.5rem; border-radius: 4px; max-height: 180px; overflow-y: auto; font-size: 0.8em; margin: 0 0 0.5rem 0;';
      meta.textContent = frontmatter;
      panel.appendChild(meta);

      const reqMcp = (entry.requires_mcp || []).join(', ');
      if (reqMcp) {
        const r = document.createElement('div');
        r.style.cssText = 'margin: 0.4rem 0; font-size: 0.85em;';
        r.innerHTML = `<strong>requires_mcp:</strong> ${reqMcp}`;
        panel.appendChild(r);
      }

      const sha = document.createElement('div');
      sha.style.cssText = 'margin: 0.2rem 0; font-size: 0.8em; color: var(--text-muted); font-family: monospace;';
      sha.textContent = `sha256: ${(entry.sha256 || '').slice(0, 16)}…`;
      panel.appendChild(sha);

      const previewHeader = document.createElement('div');
      previewHeader.style.cssText = 'margin-top: 0.6rem; font-weight: 600;';
      previewHeader.textContent = 'Body preview';
      panel.appendChild(previewHeader);

      const preview = document.createElement('pre');
      preview.style.cssText = 'background: var(--bg-tertiary); padding: 0.5rem; border-radius: 4px; max-height: 240px; overflow-y: auto; font-size: 0.8em; white-space: pre-wrap; margin: 0.3rem 0 0 0;';
      preview.textContent = bodyText.slice(0, 1500) + (bodyText.length > 1500 ? '\n\n…(truncated)' : '');
      panel.appendChild(preview);
    } catch (err) {
      panel.innerHTML = `<span style="color: var(--error)">Failed to load: ${err.message || err}</span>`;
    }
  },

  _openImportModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.55); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); display: flex; align-items: center; justify-content: center; z-index: 1000;';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.cssText = 'max-width: 560px; width: 90vw; background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: 8px; box-shadow: 0 20px 60px rgba(0,0,0,0.5);';

    modal.innerHTML = `
      <div class="modal-header">
        <h3>Import a skill</h3>
      </div>
      <div class="modal-body">
        <p style="color: var(--text-muted)">Paste a URL to a SKILL.md, or a local path to a directory containing one. Auto-detects Vodou-native, Hermes, Claude Code commands/agents, and raw markdown.</p>
        <input type="text" id="import-source-input" placeholder="https://… or /path/to/skill" class="skills-control-input" style="width: 100%; margin: 0.75rem 0;">
        <div class="modal-actions" style="display: flex; gap: 0.5rem; justify-content: flex-end;">
          <button class="btn" id="import-cancel-btn">Cancel</button>
          <button class="btn btn-primary" id="import-submit-btn">Import</button>
        </div>
        <pre id="import-output" style="display: none; margin-top: 1rem; padding: 0.75rem; background: var(--bg-tertiary); border-radius: 4px; font-size: 0.85em; overflow-x: auto; max-height: 200px;"></pre>
      </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const input = modal.querySelector('#import-source-input');
    const submitBtn = modal.querySelector('#import-submit-btn');
    const cancelBtn = modal.querySelector('#import-cancel-btn');
    const output = modal.querySelector('#import-output');
    cancelBtn.addEventListener('click', () => overlay.remove());
    input.focus();

    const submit = async () => {
      const source = input.value.trim();
      if (!source) return;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Importing…';
      output.style.display = 'block';
      output.textContent = '…';
      try {
        const result = await API.post('/api/skills/import', { source });
        output.textContent = result.stdout || JSON.stringify(result, null, 2);
        submitBtn.textContent = 'Done';
      } catch (err) {
        output.textContent = `Error: ${err.message || err}`;
        submitBtn.disabled = false;
        submitBtn.textContent = 'Import';
      }
    };
    submitBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  },

  _filterSkills() {
    const showExecDesk = document.body.classList.contains('execdesk-mode')
      || localStorage.getItem('skills-show-execdesk') === '1';
    return this.allSkills.filter(s => {
      if (this._getTab(s) !== this.activeTab) return false;
      // Mitigation #2 of PLAN §0.10.8: hide execdesk-* skills from default Vodou Skills view.
      // Visible when (a) build is execdesk-mode, or (b) user toggles "Show ExecDesk skills".
      const isExecDesk = (s.name && s.name.startsWith('execdesk-'))
        || (s.metadata && s.metadata.vodou && s.metadata.vodou.category === 'execdesk');
      if (isExecDesk && !showExecDesk) return false;
      if (this.searchQuery) {
        const q = this.searchQuery;
        const haystack = (s.name + ' ' + (s.description || '') + ' ' + (s.required_tools || '')).toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      // item 17 — shape filter. `all` is the default and never filters.
      if (this.shapeFilter && this.shapeFilter !== 'all') {
        const sh = this._shapes && this._shapes.get(s.name);
        if (!sh) return false;
        if (this.shapeFilter === 'wide' && !(sh.widest > 1)) return false;
        if (this.shapeFilter === 'checks' && !(sh.checks > 0)) return false;
        if (this.shapeFilter === 'scheduled' && !sh.scheduled) return false;
      }
      return true;
    });
  },

  _renderList(wrap) {
    wrap.innerHTML = '';
    this._syncHeaderForTab();
    const countEl = document.getElementById('skills-filter-count');

    if (this.activeTab === 'standing') {
      const all = (this._standingAgents || []).length;
      const shown = this._filterStanding().length;
      if (countEl) {
        countEl.textContent = shown === all
          ? `${(this._standingAgents || []).filter(i => i.isActive).length} active`
          : `${shown} of ${all}`;
      }
      wrap.appendChild(this._buildStandingAgents());
      return;
    }
    if (this.activeTab === 'review') {
      const all = this._pendingReview().length;
      const shown = this._filterReview().length;
      if (countEl) countEl.textContent = shown === all ? '' : `${shown} of ${all}`;
      wrap.appendChild(this._buildReviewList());
      return;
    }

    // Health warning banner — about active registry skills, so list tabs only.
    if (this._healthData && this._healthData.broken && this._healthData.broken.length > 0) {
      const banner = document.createElement('div');
      banner.className = 'skills-health-banner';
      banner.textContent = '\u26A0 ' + this._healthData.broken.length + ' active skill' +
        (this._healthData.broken.length > 1 ? 's have' : ' has') + ' disabled dependencies';
      wrap.appendChild(banner);
    }

    const filtered = this._filterSkills();

    // Update count — relative to the active tab
    const tabTotal = this.allSkills.filter(s => this._getTab(s) === this.activeTab).length;
    if (countEl) {
      countEl.textContent = filtered.length === tabTotal ? '' : `${filtered.length} of ${tabTotal}`;
    }

    if (filtered.length === 0) {
      wrap.appendChild(Components.emptyState(this.allSkills.length === 0
        ? 'No skills registered. Skills are added automatically when you install servers.'
        : 'No skills in this section yet.'));
      return;
    }

    // 'mine' renders flat — no sub-grouping
    if (this.activeTab === 'mine') {
      const list = document.createElement('div');
      list.className = 'skills-category-list';
      for (const skill of filtered) list.appendChild(this._createRow(skill));
      wrap.appendChild(list);
      return;
    }

    // Group by sub-group within the active tab
    const groups = {};
    for (const s of filtered) {
      const sg = this._getSubgroup(s, this.activeTab);
      if (!groups[sg]) groups[sg] = [];
      groups[sg].push(s);
    }
    const sortedCats = Object.keys(groups).sort();

    for (const cat of sortedCats) {
      const section = document.createElement('div');
      section.className = 'skills-category-section';
      const sgKey = `${this.activeTab}:${cat}`;

      // Category header (clickable to collapse)
      const catHeader = document.createElement('div');
      catHeader.className = 'skills-category-header';
      const collapsed = !!this.collapsedSubgroups[sgKey];

      const arrow = document.createElement('span');
      arrow.className = 'skills-category-arrow';
      arrow.textContent = collapsed ? '\u25B6' : '\u25BC';
      catHeader.appendChild(arrow);

      const catLabel = document.createElement('span');
      catLabel.className = 'skills-category-label';
      catLabel.textContent = this._getSubgroupLabel(this.activeTab, cat);
      catHeader.appendChild(catLabel);

      const catCount = document.createElement('span');
      catCount.className = 'skills-category-count';
      catCount.textContent = groups[cat].length;
      catHeader.appendChild(catCount);

      catHeader.addEventListener('click', () => {
        this.collapsedSubgroups[sgKey] = !this.collapsedSubgroups[sgKey];
        this._renderList(wrap);
      });

      section.appendChild(catHeader);

      // Skill rows (hidden if collapsed)
      if (!collapsed) {
        const list = document.createElement('div');
        list.className = 'skills-category-list';

        for (const skill of groups[cat]) {
          list.appendChild(this._createRow(skill));
        }

        section.appendChild(list);
      }

      wrap.appendChild(section);
    }
  },

  _createRow(skill) {
    const row = document.createElement('div');
    row.className = 'skill-row' + (skill.is_active ? '' : ' inactive');
    row.dataset.name = skill.name;

    // Toggle
    const toggle = Components.toggle(!!skill.is_active, async (checked) => {
      try {
        const result = await API.post(`/api/skills/${skill.name}/toggle`);
        skill.is_active = result.is_active;
        row.className = 'skill-row' + (result.is_active ? '' : ' inactive');
        Components.toast(`${skill.name} ${result.is_active ? 'activated' : 'deactivated'}`, 'success');
      } catch (e) {
        Components.toast('Toggle failed: ' + e.message, 'error');
      }
    });
    row.appendChild(toggle);

    // Name + description
    const info = document.createElement('div');
    info.className = 'skill-row-info';

    const name = document.createElement('span');
    name.className = 'skill-row-name';
    name.textContent = skill.name;
    info.appendChild(name);

    if (skill.description) {
      const desc = document.createElement('span');
      desc.className = 'skill-row-desc';
      desc.textContent = skill.description.substring(0, 100) + (skill.description.length > 100 ? '...' : '');
      info.appendChild(desc);
    }

    // Kind + source badges (kind-first taxonomy)
    const kind = this._getKind(skill);
    const source = this._getSource(skill);
    const kindBadge = document.createElement('span');
    kindBadge.className = `skill-badge skill-badge-kind-${kind}`;
    kindBadge.textContent = kind;
    kindBadge.title = kind === 'subagent' ? 'Delegate-able sub-agent persona' : 'Interactive guided workflow';
    name.appendChild(kindBadge);

    const srcBadge = document.createElement('span');
    srcBadge.className = `skill-badge skill-badge-source-${source}`;
    srcBadge.textContent = source;
    srcBadge.title = `Source: ${source}`;
    name.appendChild(srcBadge);

    // Actions.json badge — present when the skill has a deterministic workflow
    if (this._workflowSkills.has(skill.name)) {
      const wfBadge = document.createElement('span');
      wfBadge.className = 'skill-badge skill-badge-actions';
      wfBadge.textContent = '⚡actions';
      wfBadge.title = 'Has actions.json — executable via /api/skills/run-steps';
      name.appendChild(wfBadge);
    }

    // item 17 — shape glyph. Read from recorded state (`actions.json` on disk
    // and the scheduler table), never from a model's description of the skill.
    const shape = this._shapes && this._shapes.get(skill.name);
    if (shape && shape.shape !== 'empty') {
      const shBadge = document.createElement('span');
      shBadge.className = `skill-badge skill-badge-shape skill-badge-shape-${shape.shape.replace('+', '-')}`;
      shBadge.textContent = `${shape.glyph} ${shape.label}`;
      const bits = [`${shape.steps} step${shape.steps === 1 ? '' : 's'}`];
      if (shape.widest > 1) bits.push(`${shape.widest} at once`);
      if (shape.checks) bits.push(`${shape.checks} check${shape.checks === 1 ? '' : 's'}`);
      if (shape.loops) bits.push(`${shape.loops} repeating`);
      if (shape.gated) bits.push('stops to ask before it sends');
      shBadge.title = bits.join(' · ');
      name.appendChild(shBadge);
    }

    // Scheduled skills say when they last ran — item 15's one-liner, on the row
    // that already exists rather than a second list to keep in sync.
    if (shape && shape.scheduled) {
      const schBadge = document.createElement('span');
      schBadge.className = 'skill-badge skill-badge-scheduled' + (shape.scheduleEnabled ? '' : ' inactive');
      schBadge.textContent = `⏱ ${shape.scheduled}`;
      schBadge.title = shape.lastRunAt
        ? `${shape.scheduleEnabled ? 'Scheduled' : 'Paused'} · last ran ${shape.lastRunAt} · ${shape.runCount} run${shape.runCount === 1 ? '' : 's'}`
        : `${shape.scheduleEnabled ? 'Scheduled' : 'Paused'} · never run yet`;
      name.appendChild(schBadge);
    }

    // Health warning badge
    if (this._healthData && this._healthData.broken) {
      const broken = this._healthData.broken.find(b => b.name === skill.name);
      if (broken) {
        const warn = document.createElement('span');
        warn.className = 'skill-warning-badge';
        warn.title = 'Needs server' + (broken.servers_missing.length > 1 ? 's' : '') + ': ' + broken.servers_missing.join(', ');
        warn.textContent = '\u26A0 ' + broken.servers_missing.join(', ');
        info.appendChild(warn);
      }
    }

    row.appendChild(info);

    // Uses badges
    try {
      const servers = JSON.parse(skill.required_tools || '[]');
      if (servers.length > 0) {
        const uses = document.createElement('div');
        uses.className = 'skill-row-uses';
        for (const s of servers.slice(0, 3)) {
          uses.appendChild(Components.badge(s, 'default'));
        }
        if (servers.length > 3) {
          uses.appendChild(Components.badge('+' + (servers.length - 3), 'default'));
        }
        row.appendChild(uses);
      }
    } catch {}

    // Button group
    const btnGroup = document.createElement('div');
    btnGroup.className = 'skills-row-actions';

    // Run in Panel button — opens skill in floating SkillRunner
    if (typeof SkillRunner !== 'undefined') {
      const panelBtn = document.createElement('button');
      panelBtn.className = 'btn btn-sm';
      panelBtn.textContent = 'Run in Panel';
      panelBtn.title = 'Run interactively in floating panel';
      panelBtn.classList.add('skills-action-btn');
      panelBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        SkillRunner.open(skill.name);
      });
      btnGroup.appendChild(panelBtn);

      // Run in Chat — only on subagent personas. Free-form chat scoped to the
      // persona's SKILL.md as system prompt; no actions.json menu.
      if (kind === 'subagent') {
        const agentBtn = document.createElement('button');
        agentBtn.className = 'btn btn-sm';
        agentBtn.textContent = 'Run in Chat';
        agentBtn.title = 'Open a free-form chat scoped to this persona’s system prompt';
        agentBtn.classList.add('skills-action-btn');
        agentBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          // Persona uses the unified scoped-conversation path (mirrors how
          // channels and integrations work). Stable conversationId =
          // workbench:skill:<name> means revisits resume; memory bucketed by
          // scope; tab persists across reloads.
          const scope = 'workbench:skill:' + skill.name;
          try {
            // Idempotent server-side conversation create.
            await API.post('/api/workbench/ensure', { scope, title: skill.name });
            // Surface as a tab. ScopedWorkbench.mount auto-surfaces when
            // mounted, but we add here too so the tab appears even if the
            // user navigates to #/chat directly (no double-add — .add is no-op
            // when the scope already exists).
            if (typeof WorkbenchSurfaces !== 'undefined') {
              WorkbenchSurfaces.add({
                scope, title: skill.name, icon: '🧑', kind: 'workbench',
              });
            }
            // Expand the Apps tier in the chat tab strip so the new tab is
            // visible — defaults to collapsed otherwise. Same localStorage key
            // the chat view uses (_tabTierLsKeyApps).
            try { localStorage.setItem('vodou-tab-tier-apps-collapsed', '0'); } catch {}
            // Auto-switch to the new tab once ChatView is mounted. The
            // surface entry was just added; ChatView's onChange listener has
            // already re-rendered. The tab id derives from the convId per
            // _appendSurfacedWorkbenchTab. Switch synchronously when ChatView
            // is in scope; otherwise the route change below will pick it up
            // via the active-tab persistence we set here.
            const tabId = 'tab-wb-' + scope.replace(/[^a-zA-Z0-9_-]/g, '_');
            // First-open detection: send an auto-greet so the persona
            // introduces itself instead of leaving the user at a blank chat.
            // localStorage flag prevents re-greeting on every reopen.
            const greetKey = 'vodou-persona-greeted-' + scope;
            const isFirstOpen = !localStorage.getItem(greetKey);
            try {
              if (typeof ChatView !== 'undefined' && typeof ChatView._switchTab === 'function') {
                // Also write the chat-tabs localStorage so a fresh ChatView
                // (cold load) restores to this tab as active.
                const saved = JSON.parse(localStorage.getItem('vodou-chat-tabs') || '{"tabs":[]}');
                saved.activeTabId = tabId;
                localStorage.setItem('vodou-chat-tabs', JSON.stringify(saved));
                // Defer the _switchTab until after the route change so
                // the chat container is visible. After the switch settles,
                // fire the auto-greet for first-time persona opens.
                setTimeout(() => {
                  try {
                    ChatView._switchTab(tabId);
                    if (isFirstOpen && typeof ChatView.sendMessage === 'function') {
                      // Same opener the SkillRunner panel uses. The chat()
                      // handler routes this to chatWithSkill when scope is
                      // workbench:skill:* — SKILL.md becomes the complete
                      // system prompt with the panel's deterministic
                      // "display overview + first stopping point + STOP"
                      // rules. Result: matches the panel UX exactly.
                      setTimeout(() => {
                        try {
                          ChatView.sendMessage("Let's begin. Start the skill from the top.");
                          localStorage.setItem(greetKey, '1');
                        } catch {}
                      }, 200);
                    }
                  } catch {}
                }, 60);
              }
            } catch {}
          } catch (err) {
            if (typeof Components !== 'undefined') {
              Components.toast('Failed to open persona: ' + (err.message || err), 'error');
            }
            return;
          }
          // Navigate to the chat with the workbench tab pre-selected. ChatView
          // reads WorkbenchSurfaces on render; the new tab will be visible.
          window.location.hash = '#/chat';
        });
        btnGroup.appendChild(agentBtn);

        // Phase B: per-persona "what does this agent remember?" panel.
        // Shows recent memory_chunks where scope = workbench:skill:<name>.
        const memBtn = document.createElement('button');
        memBtn.className = 'btn btn-sm skills-action-btn';
        memBtn.textContent = 'Memories';
        memBtn.title = 'View what this agent remembers from past conversations';
        memBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const scope = 'workbench:skill:' + skill.name;
          let rows = [];
          try {
            rows = await API.get('/api/memory/chunks?scope=' + encodeURIComponent(scope) + '&limit=20');
          } catch (err) {
            Components.toast('Failed to load memories: ' + (err.message || err), 'error');
            return;
          }
          const modal = Components.openModal({
            title: skill.name + ' — Memories',
            subtitle: 'scope:&nbsp;<code>workbench:skill:' + window.VodouSafe.escapeHtml(skill.name) + '</code>',
          });
          modal.body.style.maxHeight = '60vh';
          modal.body.style.overflow = 'auto';
          if (!rows.length) {
            modal.body.innerHTML = '<p style="opacity:.7">No memories yet for this persona. Have a few conversations with <code>Run in Chat</code> and they\'ll appear here.</p>';
          } else {
            const list = document.createElement('div');
            list.style.display = 'flex';
            list.style.flexDirection = 'column';
            list.style.gap = '8px';
            for (const r of rows) {
              const item = document.createElement('div');
              item.style.borderLeft = '3px solid var(--accent, #6c8cff)';
              item.style.padding = '6px 10px';
              item.style.background = 'var(--bg-elevated, rgba(255,255,255,0.03))';
              const when = (r.created_at || '').slice(0, 10);
              const meta = document.createElement('div');
              meta.style.fontSize = '11px';
              meta.style.opacity = '.65';
              meta.textContent = (r.path || '') + (when ? ' · ' + when : '');
              const txt = document.createElement('div');
              txt.style.fontSize = '13px';
              txt.style.whiteSpace = 'pre-wrap';
              txt.textContent = String(r.text || '').slice(0, 400);
              item.appendChild(meta);
              item.appendChild(txt);
              list.appendChild(item);
            }
            modal.body.appendChild(list);
          }
        });
        btnGroup.appendChild(memBtn);
      }
    }

    // Edit button
    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-sm';
    editBtn.textContent = 'Edit';
    editBtn.classList.add('skills-action-btn');
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._showEditModal(skill.name);
    });
    btnGroup.appendChild(editBtn);

    // Delete button — soft-delete via uninstall (archive + prune triggers).
    // Built-in skills are gated behind a stronger confirmation since they
    // ship with Vodou and a typo'd delete is a real loss.
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-sm skills-action-btn skill-delete-btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.title = source === 'built-in'
      ? 'Archive this built-in skill (recoverable from archive/disabled-skills/)'
      : 'Archive this skill and remove its triggers';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._confirmDelete(skill, source);
    });
    btnGroup.appendChild(deleteBtn);

    // Builder button hidden for now — visual workflow editor still labeled (Demo);
    // accessible via #/builder/<skill> for power users who want to try it.
    // Re-add when builder reaches v1.0 quality.

    row.appendChild(btnGroup);

    // Click row for detail
    row.addEventListener('click', (e) => {
      if (e.target.closest('label.toggle-switch, button')) return;
      this._showEditModal(skill.name);
    });

    return row;
  },

  /**
   * Confirm + execute a skill deletion via POST /api/skills/uninstall.
   * Soft-delete: the dir is moved to archive/disabled-skills/<name>/,
   * skills_registry row is removed, and intent_mappings auto-trigger
   * rows are pruned (priority < 80; user-curated rows preserved).
   */
  _confirmDelete(skill, source) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.55); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); display: flex; align-items: center; justify-content: center; z-index: 1000;';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.cssText = 'max-width: 520px; width: 90vw; background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: 8px; box-shadow: 0 20px 60px rgba(0,0,0,0.5);';

    const isBuiltIn = source === 'built-in';
    modal.innerHTML = `
      <div class="modal-header">
        <h3>Delete ${skill.name}?</h3>
      </div>
      <div class="modal-body">
        <p style="margin: 0 0 0.75rem 0;">This will:</p>
        <ul style="margin: 0 0 0.75rem 1.25rem; line-height: 1.6;">
          <li>Move <code>skills/${skill.directory_path || skill.name}/</code> → <code>archive/disabled-skills/</code></li>
          <li>Remove its row from <code>skills_registry</code></li>
          <li>Delete <strong>all</strong> <code>intent_mappings</code> rows pointing at this skill — including user-curated rows at any priority</li>
        </ul>
        <p style="color: var(--text-muted); font-size: 0.9em; margin: 0 0 0.5rem 0;">The skill directory stays under <code>archive/</code> and can be restored manually if needed.</p>
        ${isBuiltIn ? '<p style="color: #d8a; font-size: 0.9em; margin: 0.5rem 0 0 0;"><strong>Note:</strong> this is a built-in skill that ships with Vodou. Deleting it won&#39;t affect other installs but will leave your local set incomplete until reinstalled or restored from archive.</p>' : ''}
        <div class="modal-actions" style="display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1rem;">
          <button class="btn" id="skill-del-cancel">Cancel</button>
          <button class="btn btn-danger" id="skill-del-confirm" style="background: #c33; color: #fff;">${isBuiltIn ? 'Delete anyway' : 'Delete'}</button>
        </div>
        <pre id="skill-del-output" style="display: none; margin-top: 1rem; padding: 0.5rem; background: var(--bg-tertiary); border-radius: 4px; font-size: 0.8em; max-height: 160px; overflow-y: auto; white-space: pre-wrap;"></pre>
      </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    modal.querySelector('#skill-del-cancel').addEventListener('click', () => overlay.remove());
    const confirmBtn = modal.querySelector('#skill-del-confirm');
    const output = modal.querySelector('#skill-del-output');
    confirmBtn.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Deleting…';
      output.style.display = 'block';
      output.textContent = '…';
      try {
        const r = await API.post('/api/skills/uninstall', { name: skill.name });
        output.textContent = (r.stdout || 'Deleted.').trim();
        if (typeof Components !== 'undefined') Components.toast(`Deleted ${skill.name}`, 'success');
        // Remove from local state and re-render
        this.allSkills = this.allSkills.filter(s => s.name !== skill.name);
        const wrap = document.getElementById('skills-list-wrap');
        if (wrap) this._renderList(wrap);
        // Refresh tab counts
        const oldTabBar = document.querySelector('.skills-kind-tab-bar');
        if (oldTabBar) oldTabBar.replaceWith(this._buildTabBar());
        setTimeout(() => overlay.remove(), 600);
      } catch (err) {
        let msg = err.message || String(err);
        try {
          const p = JSON.parse(msg);
          msg = `${p.error || 'Failed'}${p.stderr ? '\n\n' + p.stderr : ''}${p.stdout ? '\n\n' + p.stdout : ''}`.trim();
        } catch {}
        output.textContent = msg;
        confirmBtn.disabled = false;
        confirmBtn.textContent = isBuiltIn ? 'Delete anyway' : 'Delete';
      }
    });
  },

  _showCreateModal(container) {
    const overlay = document.createElement('div');
    overlay.className = 'skills-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'skills-modal skills-modal-sm';

    const heading = document.createElement('h3');
    heading.className = 'skills-modal-title';
    heading.textContent = 'Create New Skill';
    modal.appendChild(heading);

    const fields = [
      { name: 'name', label: 'Skill Name', placeholder: 'e.g. deploy-workflow' },
      { name: 'description', label: 'Description', placeholder: 'What does this skill do?' },
      { name: 'category', label: 'Category', type: 'select', options: ['my-skills', 'vodou-core', 'community'] },
    ];

    const inputs = {};
    for (const f of fields) {
      const group = document.createElement('div');
      group.className = 'skills-form-group';

      const label = document.createElement('label');
      label.className = 'skills-form-label';
      label.textContent = f.label;
      group.appendChild(label);

      let input;
      if (f.type === 'select') {
        input = document.createElement('select');
        for (const opt of f.options) {
          const o = document.createElement('option');
          o.value = opt;
          o.textContent = opt.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          input.appendChild(o);
        }
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.placeholder = f.placeholder || '';
      }
      input.className = 'skills-form-input';
      group.appendChild(input);
      inputs[f.name] = input;
      modal.appendChild(group);
    }

    const btnRow = document.createElement('div');
    btnRow.className = 'skills-modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => overlay.remove());
    btnRow.appendChild(cancelBtn);

    const createBtn = document.createElement('button');
    createBtn.className = 'btn btn-primary';
    createBtn.textContent = 'Create';
    createBtn.addEventListener('click', async () => {
      const name = inputs.name.value.trim();
      if (!name) { Components.toast('Skill name is required', 'error'); return; }
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        Components.toast('Name can only contain letters, numbers, hyphens, underscores', 'error');
        return;
      }

      createBtn.disabled = true;
      createBtn.textContent = 'Creating...';
      try {
        await API.post('/api/skills', {
          name,
          description: inputs.description.value.trim(),
          category: inputs.category.value,
        });
        Components.toast(`Skill "${name}" created`, 'success');
        overlay.remove();
        if (window.refreshSidebarCounts) window.refreshSidebarCounts();
        // Re-render the view
        this.render(container);
      } catch (e) {
        Components.toast('Create failed: ' + e.message, 'error');
        createBtn.disabled = false;
        createBtn.textContent = 'Create';
      }
    });
    btnRow.appendChild(createBtn);
    modal.appendChild(btnRow);

    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    setTimeout(() => inputs.name.focus(), 50);
  },

  async _showEditModal(skillName) {
    const overlay = document.createElement('div');
    overlay.className = 'skills-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'skills-modal skills-modal-lg';

    const heading = document.createElement('h3');
    heading.className = 'skills-modal-title skills-modal-title-tight';
    heading.textContent = 'Edit: ' + skillName;
    modal.appendChild(heading);

    // Skill info summary
    const skill = this.allSkills.find(s => s.name === skillName);
    if (skill?.description) {
      const descEl = document.createElement('p');
      descEl.className = 'skills-modal-desc';
      descEl.textContent = skill.description;
      modal.appendChild(descEl);
    }

    const textarea = document.createElement('textarea');
    textarea.className = 'skills-editor-textarea';
    textarea.placeholder = 'Loading...';
    modal.appendChild(textarea);

    const btnRow = document.createElement('div');
    btnRow.className = 'skills-modal-actions skills-modal-actions-tight';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => overlay.remove());
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      try {
        await API.put(`/api/skills/${encodeURIComponent(skillName)}/content`, { content: textarea.value });
        Components.toast('Saved', 'success');
        overlay.remove();
      } catch (e) {
        Components.toast('Save failed: ' + (e.message || e), 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
    });
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(saveBtn);
    modal.appendChild(btnRow);

    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);

    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(skillName)}/content`);
      if (!res.ok) throw new Error(await res.text() || 'Failed to load');
      textarea.value = await res.text();
      textarea.placeholder = '';
    } catch (err) {
      textarea.placeholder = '';
      Components.toast('Failed to load skill: ' + err.message, 'error');
    }
  },
};


// ─── Sidebar populator — top-level Skills nav group ───────────────────────
// Mirrors apps.js pattern: fetch active skills on boot, render as nested
// nav items under the Skills <details>. Click → SkillRunner.open(name).
(function _initSkillsSidebar() {
  // Shared escaper — safe.js loads first, so VodouSafe is always present.
  function escapeHtml(s) { return window.VodouSafe.escapeHtml(s); }

  // Open a skill in the chat tab — same flow as the per-row "Run in Chat" button.
  // Stable convId workbench:skill:<name> so revisits resume; memory bucketed by
  // scope; tab persists across reloads.
  async function openSkillInChat(skillName) {
    if (!skillName) return;
    const scope = "workbench:skill:" + skillName;
    try {
      // Idempotent server-side conversation ensure
      if (typeof API !== "undefined" && API.post) {
        await API.post("/api/workbench/ensure", { scope, title: skillName });
      } else {
        await fetch("/api/workbench/ensure", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope, title: skillName }),
        });
      }
      if (typeof WorkbenchSurfaces !== "undefined") {
        WorkbenchSurfaces.add({ scope, title: skillName, icon: "🧑", kind: "workbench" });
      }
      try { localStorage.setItem("vodou-tab-tier-apps-collapsed", "0"); } catch {}
      const tabId = "tab-wb-" + scope.replace(/[^a-zA-Z0-9_-]/g, "_");
      const greetKey = "vodou-persona-greeted-" + scope;
      const isFirstOpen = !localStorage.getItem(greetKey);
      try {
        const saved = JSON.parse(localStorage.getItem("vodou-chat-tabs") || '{"tabs":[]}');
        saved.activeTabId = tabId;
        localStorage.setItem("vodou-chat-tabs", JSON.stringify(saved));
      } catch {}
      window.location.hash = "#/chat";
      // Defer switch + first-open auto-greet until ChatView mounts
      setTimeout(() => {
        try {
          if (typeof ChatView !== "undefined" && typeof ChatView._switchTab === "function") {
            ChatView._switchTab(tabId);
            if (isFirstOpen && typeof ChatView.sendMessage === "function") {
              setTimeout(() => {
                try {
                  ChatView.sendMessage("Let's begin. Start the skill from the top.");
                  localStorage.setItem(greetKey, "1");
                } catch {}
              }, 200);
            }
          }
        } catch {}
      }, 100);
    } catch (err) {
      console.error("[skills sidebar] openSkillInChat failed:", err);
      if (typeof Components !== "undefined" && Components.toast) {
        Components.toast("Failed to open skill: " + (err.message || err), "error");
      }
    }
  }

  async function renderSidebarSkills() {
    const container = document.getElementById("nav-skills-items");
    if (!container) return;
    try {
      // Per-project dock filter — show only the skills curated for the active
      // project (server returns all when the project is Default/uncurated).
      // PLAN-UNIFIED-PROJECT-SCOPE §2.6 — delegate; ProjectScope is the sole reader.
      const activeProject = (window.ProjectScope && window.ProjectScope.active())
        || localStorage.getItem("vodou.activeProject") || "proj_default";
      const r = await fetch("/api/skills?project=" + encodeURIComponent(activeProject));
      if (!r.ok) return;
      const data = await r.json();
      const all = Array.isArray(data) ? data : (data.skills || []);
      // Active skills only, alphabetised, capped at 30 for sidebar sanity.
      const visible = all
        .filter(s => s && s.name && s.is_active !== 0 && !String(s.name).startsWith("execdesk-"))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .slice(0, 30);
      if (visible.length === 0) {
        container.innerHTML = "";
        return;
      }
      const rows = visible.map(s => {
        const name = String(s.name);
        const friendly = name.replace(/-/g, " ").replace(/\w/g, c => c.toUpperCase());
        return `<button type="button" class="nav-item nav-item-skill" data-skill="${escapeHtml(name)}" title="${escapeHtml(s.description || name)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          <span class="nav-skill-name">${escapeHtml(friendly)}</span>
        </button>`;
      }).join("");
      container.innerHTML = `<div class="nav-skills-heading">Active skills</div>` + rows;
      container.querySelectorAll("button[data-skill]").forEach(btn => {
        btn.addEventListener("click", async () => {
          const n = btn.dataset.skill;
          await openSkillInChat(n);
        });
      });
    } catch (err) {
      console.error("[skills sidebar] failed:", err);
    }
  }

  function init() {
    if (!document.getElementById("nav-skills-items")) return;
    renderSidebarSkills();
    // Re-fetch when skills are mutated (toggle/install/uninstall) — view triggers a custom event.
    window.addEventListener("skills:changed", renderSidebarSkills);
    // Re-filter the dock when the active project changes (PLAN-PROJECT-SCOPED-DOCK).
    window.addEventListener("project:changed", renderSidebarSkills);
    // Periodic refresh as a safety net (every 60s; cheap call).
    setInterval(renderSidebarSkills, 60_000);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
