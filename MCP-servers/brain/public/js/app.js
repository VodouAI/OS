/* Brain mini console — memory constellation over /api/brain/*.
 * Vanilla JS + vendored D3 v7. Read-only by construction.
 * Signature: trust = luminosity (yours glows, captures dim, imports dimmer). */
(() => {
  'use strict';

  // Tag hues — same family as the shipped Memory Atlas (memory-atlas.js TAG_HUES).
  const TAG_HUES = {
    DECISION: 258, ISSUE: 350, DEAD_END: 340, PREF: 200, DONE: 160,
    PLANNED: 210, GOTCHA: 28, METRIC: 190, PATTERN: 270, DEPENDENCY: 220,
    EXAMPLE: 45, RESEARCH: 230, UNTAGGED: 210,
  };
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const tagColor = (tag) => {
    const hue = TAG_HUES[tag] ?? 210;
    const sat = tag === 'UNTAGGED' ? '12%' : css('--tag-s') || '55%';
    return `hsl(${hue}, ${sat}, ${css('--tag-l') || '62%'})`;
  };
  // Trust → luminosity. The one visual rule everything else defers to.
  const trustOpacity = (cls) => (cls === 'imported' ? 0.5 : cls === 'captured' ? 0.72 : 0.95);
  const CLS_LABEL = { yours: 'Yours', captured: 'Auto-captured', imported: 'Imported' };
  const CLS_DESC = {
    yours: 'Said to Vodou directly — full trust',
    captured: 'Watched from your IDEs & apps',
    imported: 'One-time exports from other AIs',
  };

  const state = {
    cls: new Set(['yours', 'captured', 'imported']),
    tag: null,
    sinceDays: 0,
    mode: 'overview',   // 'overview' | 'local'
    layout: 'constellation', // 'constellation' | 'chronicle'
    similar: false,     // overlay embedding-similarity edges (PLAN-MEMORY-GRAPH-SIMILARITY-EDGES)
    chronOrder: 'desc', // 'desc' newest-first | 'asc' oldest-first
    project: '',        // '' all · 'global' · project id
    includeArchived: false,
    lastData: null,
    center: null,
    selected: null,
    overview: null,
    scopes: [],          // live scope rows (share-vault editor reuses them)
    shareVaults: [],     // named share vaults from the gateway (PLAN-MEMORY-VAULTS)
    vaultPreview: null,  // { name, total, ids:Set, paths:Set } — dims the sky
    vaultEditing: null,  // vault name being edited, or null for create
  };
  // Dated memory files (daily logs, monthly import digests) anchor the Chronicle spine.
  const dateOf = (p) => {
    const m = /(\d{4}-\d{2}(?:-\d{2})?)\.md$/.exec(p || '');
    return m ? m[1] : null;
  };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (s) => (s || '').slice(0, 10);
  const baseName = (p) => {
    const b = (p || '').split('/').pop().replace(/\.md$/, '');
    if ((p || '').includes('memory/imports/')) {
      const src = p.split('/')[2] || '';
      return `${src} · ${b}`;
    }
    return b;
  };

  async function api(route, params = {}) {
    const u = new URL(`/api/brain/${route}`, location.origin);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
    }
    const res = await fetch(u);
    if (!res.ok) throw new Error(`${route}: HTTP ${res.status}`);
    return res.json();
  }
  const graphParams = () => ({
    cls: state.cls.size === 3 ? undefined : [...state.cls].join(','),
    tag: state.tag || undefined,
    since_days: state.sinceDays || undefined,
    project: state.project || undefined,
    archived: state.includeArchived ? 1 : undefined,
    sim: state.similar ? 1 : undefined,
  });

  // ── Graph ────────────────────────────────────────────────────────────────
  const svg = d3.select('#graph');
  const zoomLayer = svg.append('g');
  const gLinks = zoomLayer.append('g');
  const gNodes = zoomLayer.append('g');
  const gLabels = zoomLayer.append('g');
  let sim = null;
  let zoomBehavior = null;
  let nodeSel = null;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Soft glow for entities / pinned nodes.
  const defs = svg.append('defs');
  const glow = defs.append('filter').attr('id', 'glow').attr('x', '-80%').attr('y', '-80%').attr('width', '260%').attr('height', '260%');
  glow.append('feGaussianBlur').attr('stdDeviation', 3.2).attr('result', 'b');
  const gm = glow.append('feMerge');
  gm.append('feMergeNode').attr('in', 'b');
  gm.append('feMergeNode').attr('in', 'SourceGraphic');

  function nodeRadius(d) {
    if (d.spine) return Math.min(4.5 + Math.sqrt(d.n || 1) * 1.35, 9);
    if (d.type === 'entity') return Math.min(7 + Math.sqrt(d.n || 1) * 1.8, 20);
    if (d.type === 'file') return Math.min(4.5 + Math.sqrt(d.n || 1) * 1.35, 24);
    if (d.type === 'doc') return Math.min(3 + Math.sqrt(d.n || 1) * 1.1, 10);
    return 4.5;
  }
  function nodeColor(d) {
    if (d.type === 'entity') return css('--accent');
    if (d.type === 'doc') return css('--text-muted');
    return tagColor(d.tag || 'UNTAGGED');
  }
  function nodeOpacity(d) {
    // Vault preview: members keep their luminosity, everything else fades —
    // "see exactly what leaves" before an export (PLAN-MEMORY-VAULTS V2).
    if (state.vaultPreview) {
      const vp = state.vaultPreview;
      const member = d.type === 'chunk' ? vp.ids.has(d.id)
        : d.type === 'file' ? vp.paths.has(d.id) || vp.paths.has(d.path)
        : false;
      if (!member) return d.type === 'entity' ? 0.14 : 0.07;
    }
    if (d.type === 'entity') return 1;
    if (d.type === 'doc') return 0.55;
    return trustOpacity(d.cls);
  }
  const linkStyle = {
    mention:   { stroke: () => css('--link-gold'), width: (l) => Math.min(0.6 + l.w * 0.25, 2.4), dash: null },
    comention: { stroke: () => css('--link-gold'), width: () => 0.7, dash: '1,4' },
    ref:       { stroke: () => css('--link-dim'), width: (l) => Math.min(0.6 + l.w * 0.3, 2.6), dash: null },
    contains:  { stroke: () => css('--link-dim'), width: () => 0.7, dash: null },
    conflict:  { stroke: () => css('--error'), width: (l) => Math.min(1.2 + l.w * 0.5, 3), dash: '5,3' },
    superseded:{ stroke: () => css('--warn-text'), width: () => 1.1, dash: '3,3' },
    // Similarity edges: bright teal, dashed, weighted by cosine. Deliberately
    // distinct from citation gold so the "connect by meaning" overlay pops.
    similar:   { stroke: () => '#2ec4b6', width: (l) => Math.min(1.0 + (l.w - 0.6) * 4, 3.4), dash: '4,3' },
  };

  function renderGraph(data) {
    state.lastData = data;
    const nodes = data.nodes.map((n) => ({ ...n }));
    const ids = new Set(nodes.map((n) => n.id));
    const links = data.links
      .filter((l) => ids.has(l.source) && ids.has(l.target))
      .map((l) => ({ ...l }));

    $('emptyState').hidden = nodes.length > 0;
    if (sim) sim.stop();
    gLinks.selectAll('*').remove();
    gNodes.selectAll('*').remove();
    gLabels.selectAll('*').remove();

    const { width, height } = svg.node().getBoundingClientRect();

    // Chronicle layout: dated files pinned in date order down the left edge,
    // newest first; everything else floats to the right on the same links.
    const chronicle = state.layout === 'chronicle';
    if (chronicle) {
      const dated = nodes
        .filter((n) => n.type === 'file' && dateOf(n.path))
        .sort((a, b) => (state.chronOrder === 'desc'
          ? dateOf(b.path).localeCompare(dateOf(a.path))
          : dateOf(a.path).localeCompare(dateOf(b.path))));
      const top = 42;
      const gap = Math.max(26, Math.min(46, (height - top - 30) / Math.max(dated.length, 1)));
      dated.forEach((n, i) => { n.fx = 150; n.fy = top + i * gap; n.spine = true; });
    }

    const link = gLinks.selectAll('line').data(links).join('line')
      .attr('stroke', (l) => (linkStyle[l.type] || linkStyle.ref).stroke(l))
      .attr('stroke-width', (l) => (linkStyle[l.type] || linkStyle.ref).width(l))
      .attr('stroke-dasharray', (l) => (linkStyle[l.type] || linkStyle.ref).dash)
      .attr('class', (l) => (l.type === 'conflict' && !reduceMotion ? 'link-conflict-anim' : null))
      .attr('stroke-opacity', 0.65);

    const node = gNodes.selectAll('g').data(nodes, (d) => d.id).join('g')
      .attr('cursor', 'pointer')
      .call(d3.drag()
        .on('start', (ev, d) => { if (!ev.active) sim.alphaTarget(0.25).restart(); d.fx = d.x; d.fy = d.y; })
        .on('drag', (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
        .on('end', (ev, d) => { if (!ev.active) sim.alphaTarget(0); if (!d.spine) { d.fx = null; d.fy = null; } }));
    nodeSel = node;

    node.each(function (d) {
      const g = d3.select(this);
      if (d.type === 'entity') {
        // four-point star — the veve mark
        const r = nodeRadius(d);
        const p = `M0,${-r} L${r * 0.3},${-r * 0.3} L${r},0 L${r * 0.3},${r * 0.3} L0,${r} L${-r * 0.3},${r * 0.3} L${-r},0 L${-r * 0.3},${-r * 0.3} Z`;
        g.append('path').attr('d', p)
          .attr('fill', nodeColor(d)).attr('fill-opacity', 0.9)
          .attr('filter', 'url(#glow)');
      } else if (d.type === 'doc') {
        const r = nodeRadius(d);
        g.append('rect').attr('x', -r).attr('y', -r).attr('width', r * 2).attr('height', r * 2)
          .attr('rx', 1.5).attr('fill', nodeColor(d)).attr('fill-opacity', nodeOpacity(d));
      } else {
        g.append('circle').attr('r', nodeRadius(d))
          .attr('fill', nodeColor(d)).attr('fill-opacity', nodeOpacity(d))
          .attr('filter', d.pinned || d.center ? 'url(#glow)' : null);
        if (d.pinned || d.center) {
          g.append('circle').attr('r', nodeRadius(d) + 3)
            .attr('fill', 'none').attr('stroke', css('--accent')).attr('stroke-width', 1.1)
            .attr('stroke-opacity', 0.85);
        }
      }
    });

    // Labels: all entities + the most substantial files/chunks; every spine date.
    const labelled = nodes.filter((d) =>
      d.spine ? true
      : d.type === 'entity' ? (d.n || 0) > 0 || d.center
      : d.type === 'chunk' ? !!d.center
      : (d.n || 0) >= (d.type === 'file' ? 8 : 12) || d.center);
    const labels = gLabels.selectAll('text').data(labelled, (d) => d.id).join('text')
      .attr('class', (d) => (d.type === 'entity' ? 'entity-label' : 'node-label'))
      .attr('text-anchor', (d) => (d.spine ? 'end' : 'middle'))
      .text((d) => {
        const t = d.type === 'entity' ? d.label
          : d.type === 'chunk' ? (d.label || '').slice(0, 34)
          : baseName(d.path);
        return t.length > 36 ? t.slice(0, 35) + '…' : t;
      });

    sim = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id((d) => d.id)
        .distance((l) => (l.type === 'mention' ? (chronicle ? 130 : 46) : l.type === 'comention' ? 90 : l.type === 'contains' ? 34 : 70))
        .strength((l) => (chronicle ? 0.04 : l.type === 'comention' ? 0.15 : l.type === 'contains' ? 0.7 : 0.35)))
      .force('charge', d3.forceManyBody().strength((d) => (d.type === 'entity' ? (chronicle ? -520 : -320) : -110)))
      .force('collide', d3.forceCollide().radius((d) => nodeRadius(d) + (chronicle && d.type === 'entity' ? 26 : 4)))
      .force('center', chronicle ? null : d3.forceCenter(width / 2, height / 2))
      .force('x', d3.forceX((d, i) => (chronicle ? 420 + ((i * 149) % Math.max(width * 0.5, 400)) : width / 2))
        .strength(chronicle ? 0.05 : 0.03))
      .force('y', d3.forceY(height / 2).strength(0.04))
      .on('tick', () => {
        if (chronicle) {
          for (const n of nodes) if (!n.spine && n.x < 330) n.x = 330;
        }
        link.attr('x1', (l) => l.source.x).attr('y1', (l) => l.source.y)
          .attr('x2', (l) => l.target.x).attr('y2', (l) => l.target.y);
        node.attr('transform', (d) => `translate(${d.x},${d.y})`);
        labels
          .attr('x', (d) => (d.spine ? d.x - nodeRadius(d) - 8 : d.x))
          .attr('y', (d) => (d.spine ? d.y + 3.5 : d.y - nodeRadius(d) - 5));
      });
    if (reduceMotion) { sim.stop(); sim.tick(280); sim.on('tick')(); }

    // Neighborhood highlight on hover
    const adj = new Map();
    for (const l of links) {
      const s = l.source.id || l.source, t = l.target.id || l.target;
      (adj.get(s) || adj.set(s, new Set()).get(s)).add(t);
      (adj.get(t) || adj.set(t, new Set()).get(t)).add(s);
    }
    const tooltip = $('tooltip');
    node
      .on('mouseenter', (ev, d) => {
        const near = adj.get(d.id) || new Set();
        node.attr('opacity', (o) => (o.id === d.id || near.has(o.id) ? 1 : 0.18));
        link.attr('stroke-opacity', (l) =>
          (l.source.id === d.id || l.target.id === d.id ? 0.95 : 0.06));
        labels.attr('opacity', (o) => (o.id === d.id || near.has(o.id) ? 1 : 0.15));
        const meta = d.type === 'entity'
          ? `${esc(d.kind)} · ${d.n} mention${d.n === 1 ? '' : 's'}`
          : d.type === 'doc' ? `cited ${d.n}×`
          : d.type === 'chunk' ? `${esc(d.tag)} · ${esc(CLS_LABEL[d.cls] || d.cls)} · ${fmtDate(d.created_at)}`
          : `${d.n} memories · ${esc(CLS_LABEL[d.cls] || d.cls)} · last ${fmtDate(d.last)}`;
        tooltip.innerHTML = `<div class="t-title">${esc(d.type === 'entity' ? d.label : d.type === 'chunk' ? (d.label || d.id) : baseName(d.path))}</div><div class="t-meta">${meta}</div>`;
        tooltip.hidden = false;
      })
      .on('mousemove', (ev) => {
        const wrap = document.querySelector('.canvas-wrap').getBoundingClientRect();
        tooltip.style.left = `${Math.min(ev.clientX - wrap.left + 14, wrap.width - 310)}px`;
        tooltip.style.top = `${ev.clientY - wrap.top + 12}px`;
      })
      .on('mouseleave', () => {
        node.attr('opacity', 1);
        link.attr('stroke-opacity', 0.65);
        labels.attr('opacity', 1);
        tooltip.hidden = true;
      })
      .on('click', (ev, d) => { ev.stopPropagation(); select(d); })
      .on('dblclick', (ev, d) => { ev.stopPropagation(); focusOn(d.id); });

    zoomBehavior = d3.zoom().scaleExtent([0.25, 6])
      .on('zoom', (ev) => zoomLayer.attr('transform', ev.transform));
    svg.call(zoomBehavior).on('dblclick.zoom', null);
  }

  function fit() {
    const b = zoomLayer.node().getBBox();
    if (!b.width || !b.height) return;
    const { width, height } = svg.node().getBoundingClientRect();
    const k = Math.min(width / (b.width + 90), height / (b.height + 90), 2.2);
    const t = d3.zoomIdentity
      .translate(width / 2 - k * (b.x + b.width / 2), height / 2 - k * (b.y + b.height / 2))
      .scale(k);
    svg.transition().duration(reduceMotion ? 0 : 450).call(zoomBehavior.transform, t);
  }

  function spotlight(id) {
    if (!nodeSel) return;
    const d = nodeSel.data().find((n) => n.id === id);
    if (!d) return;
    const { width, height } = svg.node().getBoundingClientRect();
    const t = d3.zoomIdentity.translate(width / 2 - 1.6 * d.x, height / 2 - 1.6 * d.y).scale(1.6);
    svg.transition().duration(reduceMotion ? 0 : 500).call(zoomBehavior.transform, t);
    const g = nodeSel.filter((n) => n.id === id);
    const ring = g.append('circle').attr('r', nodeRadius(d) + 4)
      .attr('fill', 'none').attr('stroke', css('--accent')).attr('stroke-width', 2);
    ring.transition().duration(reduceMotion ? 0 : 900)
      .attr('r', nodeRadius(d) + 26).attr('stroke-opacity', 0).remove();
  }

  function crumbText() {
    return state.layout === 'chronicle'
      ? `<b>Chronicle</b> — your memory day by day, ${state.chronOrder === 'desc' ? 'newest' : 'oldest'} at the top`
      : `<b>Constellation</b> — every file, person &amp; source in one sky`;
  }
  async function loadOverviewGraph() {
    state.mode = 'overview'; state.center = null;
    $('overviewBtn').hidden = true;
    $('crumb').innerHTML = crumbText();
    renderGraph(await api('graph', graphParams()));
    setTimeout(fit, reduceMotion ? 30 : 700);
  }

  async function focusOn(id) {
    state.mode = 'local'; state.center = id;
    $('overviewBtn').hidden = false;
    const label = id.startsWith('entity:') ? 'entity' : /:\d+:/.test(id) ? 'memory' : 'file';
    $('crumb').innerHTML = `<b>Focus</b> — the neighborhood of one ${label}`;
    renderGraph(await api('local', { id, sim: state.similar ? 1 : undefined }));
    setTimeout(fit, reduceMotion ? 30 : 700);
    select({ id, type: id.startsWith('entity:') ? 'entity' : /:\d+:/.test(id) ? 'chunk' : 'file' });
  }

  // ── Reading pane ─────────────────────────────────────────────────────────
  async function select(d) {
    state.selected = d.id;
    $('readingEmpty').hidden = true;
    const pane = $('reading');
    pane.hidden = false;
    try {
      if (d.type === 'entity' || d.id.startsWith('entity:')) {
        renderEntity(await api('entity', { id: d.id.replace('entity:', '') }));
      } else if (/:\d+:/.test(d.id)) {
        renderChunk(await api('node', { id: d.id }));
      } else if (d.type === 'doc') {
        pane.innerHTML = `
          <div class="read-head">
            <div class="read-kind">cited document</div>
            <div class="read-title mono">${esc(d.path || d.id)}</div>
          </div>
          <p class="rail-hint">A document your memories cite. Open it in your editor — the graph only tracks the citation.</p>`;
      } else {
        renderFile(await api('file', { path: d.id }), d);
      }
    } catch (err) {
      pane.innerHTML = `<p class="rail-hint">Couldn't load this memory: ${esc(err.message)}</p>`;
    }
  }

  const provChips = (o) => `
    <div class="prov">
      <span class="prov-chip ${o.cls === 'yours' ? 'gold' : ''}">${esc(CLS_LABEL[o.cls] || o.cls)}</span>
      <span class="prov-chip">trust ×${(o.trust ?? 1).toFixed(3).replace(/\.?0+$/, '')}</span>
      <span class="prov-chip mono">${esc(o.scope || '')}</span>
      ${o.pinned ? '<span class="prov-chip gold">★ pinned</span>' : ''}
      <span class="prov-chip">${fmtDate(o.created_at)}</span>
    </div>`;
  const rowBtn = (id, title, sub, color) => `
    <button class="link-row" data-open="${esc(id)}">
      <span class="dot" style="background:${color}"></span>${esc(title)}
      ${sub ? `<small>${esc(sub)}</small>` : ''}
    </button>`;

  function renderChunk(c) {
    const title = (c.text || '').replace(/^#+\s*/gm, '').trim().split('\n').find((l) => l.trim()) || c.id;
    let banners = '';
    if (c.group?.superseded_by) {
      banners += `<div class="banner superseded">Superseded — a newer or more trusted memory replaced this one. It ranks at ×0.4 until restored.</div>`;
    } else if (c.group?.is_canonical) {
      banners += `<div class="banner canonical">Canonical — elected the best copy of this fact among ${c.siblings.length + 1} near-duplicates.</div>`;
    }
    const openConf = (c.conflicts || []).filter((x) => x.status === 'open');
    if (openConf.length) {
      banners += `<div class="banner conflict">In conflict — another source disagrees about “${esc(openConf[0].slot)}”.</div>`;
    }
    $('reading').innerHTML = `
      <div class="read-head">
        <div class="read-kind"><span class="dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${tagColor(c.chunk_tag || 'UNTAGGED')}"></span>${esc(c.chunk_tag || 'UNTAGGED')} memory</div>
        <div class="read-title">${esc(title.slice(0, 140))}</div>
      </div>
      ${provChips(c)}
      <button class="focus-btn" data-focus="${esc(c.id)}">◉ Focus this memory's neighborhood</button>
      ${banners}
      <div class="read-body">${esc(c.text)}</div>
      <div class="read-sec"><h3>Where it lives</h3>
        ${rowBtn(c.path, baseName(c.path), `${c.path}:${c.start_line}`, css('--accent'))}
      </div>
      ${c.entities.length ? `<div class="read-sec"><h3>Who &amp; what it mentions</h3>
        ${c.entities.map((e) => rowBtn('entity:' + e.id, e.canonical, e.kind, css('--accent'))).join('')}</div>` : ''}
      ${c.refsOut.length ? `<div class="read-sec"><h3>It cites</h3>
        ${c.refsOut.slice(0, 12).map((r) => r.target
          ? rowBtn(r.target, r.target.split('/').pop(), r.kind, css('--text-muted'))
          : `<div class="link-row"><span class="dot" style="background:${css('--text-muted')}"></span>${esc(r.raw)} <small>${esc(r.kind)} (unresolved)</small></div>`).join('')}</div>` : ''}
      ${c.backlinks.length ? `<div class="read-sec"><h3>Cited by ${c.backlinks.length} memor${c.backlinks.length === 1 ? 'y' : 'ies'}</h3>
        ${c.backlinks.slice(0, 10).map((b) => rowBtn(b.id, (b.preview || '').slice(0, 70), `${baseName(b.path)} · ${fmtDate(b.created_at)}`, tagColor(b.chunk_tag || 'UNTAGGED'))).join('')}</div>` : ''}
      ${c.siblings.length ? `<div class="read-sec"><h3>Same fact, other copies</h3>
        ${c.siblings.map((s) => rowBtn(s.chunk_id, (s.preview || '').slice(0, 70), `${s.is_canonical ? 'canonical' : s.superseded_by ? 'superseded' : 'copy'} · ${esc(s.scope)}`, css('--warn-text'))).join('')}</div>` : ''}
      ${(c.conflicts || []).length ? `<div class="read-sec"><h3>Conflicts</h3>
        ${c.conflicts.map((x) => `
          <div class="conflict-card ${x.status === 'open' ? 'open' : ''}">
            <div class="conflict-slot">${esc(x.slot)} <span class="status-chip ${x.status === 'open' ? 'open' : ''}">${esc(x.status.replace('_', ' '))}</span></div>
            <div class="conflict-sides">
              <button class="conflict-side ${x.status === 'kept_import' ? 'winner' : ''}" data-open="${esc(x.import_chunk_id)}">
                <div class="side-label">imported says</div><div class="side-value">${esc(x.import_value)}</div></button>
              <button class="conflict-side ${x.status === 'kept_native' ? 'winner' : ''}" data-open="${esc(x.native_chunk_id)}">
                <div class="side-label">you said</div><div class="side-value">${esc(x.native_value)}</div></button>
            </div>
          </div>`).join('')}</div>` : ''}
      ${vaultChunkControls(c.id)}`;
    wireReadingPane();
    wireVaultChunkControls();
  }

  function renderFile(f, meta) {
    const chunks = f.chunks || [];
    $('reading').innerHTML = `
      <div class="read-head">
        <div class="read-kind">memory file · ${chunks.length} memories</div>
        <div class="read-title">${esc(baseName(f.path))}</div>
        <div class="rail-hint mono">${esc(f.path)}</div>
      </div>
      <button class="focus-btn" data-focus="${esc(f.path)}">◉ Focus this file's neighborhood</button>
      <div class="read-sec">
        ${chunks.map((c) => rowBtn(
          c.id,
          (c.text || '').replace(/^#+\s*/gm, '').trim().slice(0, 76),
          `${c.chunk_tag || 'UNTAGGED'} · ${fmtDate(c.created_at)}${c.pinned ? ' · ★' : ''}`,
          tagColor(c.chunk_tag || 'UNTAGGED'))).join('')}
      </div>`;
    wireReadingPane();
  }

  function renderEntity(e) {
    $('reading').innerHTML = `
      <div class="read-head">
        <div class="read-kind">✦ ${esc(e.kind)} · ${e.mentions.length} mentions</div>
        <div class="read-title">${esc(e.canonical)}</div>
        ${e.aliases.length ? `<div class="rail-hint">also known as ${e.aliases.map((a) => esc(a.display)).join(', ')}</div>` : ''}
      </div>
      <button class="focus-btn" data-focus="entity:${e.id}">◉ Focus everything about ${esc(e.canonical)}</button>
      <div class="read-sec"><h3>Every memory that mentions them</h3>
        ${e.mentions.map((m) => rowBtn(
          m.id, (m.preview || '').slice(0, 76),
          `${m.chunk_tag || 'UNTAGGED'} · ${esc(CLS_LABEL[m.cls] || m.cls)} · ${fmtDate(m.created_at)}`,
          tagColor(m.chunk_tag || 'UNTAGGED'))).join('')}
      </div>`;
    wireReadingPane();
  }

  function wireReadingPane() {
    $('reading').querySelectorAll('[data-open]').forEach((el) =>
      el.addEventListener('click', () => {
        const id = el.dataset.open;
        select({ id, type: id.startsWith('entity:') ? 'entity' : /:\d+:/.test(id) ? 'chunk' : 'file' });
        spotlight(id);
      }));
    $('reading').querySelectorAll('[data-focus]').forEach((el) =>
      el.addEventListener('click', () => focusOn(el.dataset.focus)));
  }

  // ── Left rail ────────────────────────────────────────────────────────────
  function renderVaults(scopes) {
    const byCls = { yours: [], captured: [], imported: [] };
    for (const s of scopes) (byCls[s.cls] || byCls.yours).push(s);
    const clsColor = { yours: css('--accent'), captured: 'hsl(190,55%,52%)', imported: 'hsl(258,40%,58%)' };
    $('vaults').innerHTML = ['yours', 'captured', 'imported'].map((cls) => {
      const rows = byCls[cls];
      const total = rows.reduce((a, r) => a + r.n, 0);
      const trust = rows[0]?.trust ?? (cls === 'yours' ? 1 : cls === 'captured' ? 0.925 : 0.85);
      const top = rows.slice(0, 4);
      return `
        <div class="vault ${state.cls.has(cls) ? '' : 'off'}" data-cls="${cls}">
          <div class="vault-top" role="checkbox" aria-checked="${state.cls.has(cls)}" tabindex="0">
            <span class="vault-dot" style="background:${clsColor[cls]}; opacity:${trustOpacity(cls)}"></span>
            <span class="vault-name">${CLS_LABEL[cls]}</span>
            <span class="vault-meta">${total} · ×${String(trust).replace(/(\.\d\d\d).*$/, '$1')}</span>
          </div>
          <div class="rail-hint" style="margin:4px 0 0 18px">${CLS_DESC[cls]}</div>
          ${top.length ? `<div class="vault-scopes">${top.map((r) =>
            `<div class="vault-scope"><span class="mono">${esc(r.scope)}</span><span>${r.n}</span></div>`).join('')}
            ${rows.length > 4 ? `<div class="vault-scope"><span>+${rows.length - 4} more sources</span></div>` : ''}</div>` : ''}
        </div>`;
    }).join('');
    $('vaults').querySelectorAll('.vault-top').forEach((el) => {
      const toggle = () => {
        const cls = el.closest('.vault').dataset.cls;
        if (state.cls.has(cls)) { if (state.cls.size > 1) state.cls.delete(cls); }
        else state.cls.add(cls);
        el.closest('.vault').classList.toggle('off', !state.cls.has(cls));
        el.setAttribute('aria-checked', state.cls.has(cls));
        loadOverviewGraph();
      };
      el.addEventListener('click', toggle);
      el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
    });
  }

  function renderTagChips(byTag) {
    $('tagChips').innerHTML = byTag.slice(0, 13).map((t) => `
      <button class="chip ${state.tag === t.tag ? 'active' : ''}" data-tag="${esc(t.tag)}">
        <span class="dot" style="background:${tagColor(t.tag)}"></span>${esc(t.tag)} <small>${t.n}</small>
      </button>`).join('');
    $('tagChips').querySelectorAll('.chip').forEach((el) =>
      el.addEventListener('click', () => {
        state.tag = state.tag === el.dataset.tag ? null : el.dataset.tag;
        renderTagChips(byTag);
        loadOverviewGraph();
      }));
  }

  $('whenRow').querySelectorAll('.when-btn').forEach((el) =>
    el.addEventListener('click', () => {
      state.sinceDays = parseInt(el.dataset.days, 10);
      $('whenRow').querySelectorAll('.when-btn').forEach((b) => b.classList.toggle('active', b === el));
      loadOverviewGraph();
    }));

  // ── Header / stats / theme ───────────────────────────────────────────────
  function renderStats(o) {
    $('hdrStats').innerHTML = `
      <span><b>${o.counts.chunks_live.toLocaleString()}</b> memories</span>
      <span><b>${o.counts.entities}</b> people &amp; things</span>
      <span><b>${o.counts.connections.toLocaleString()}</b> connections</span>`;
    const badge = $('conflictBadge');
    badge.hidden = o.counts.conflicts_open === 0;
    badge.textContent = o.counts.conflicts_open;
  }
  const THEME_KEY = 'vodou.theme';
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    $('themeBtn').textContent = t === 'dark' ? '☾' : '☀';
  }
  applyTheme(localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark');
  $('themeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
    if (state.mode === 'overview') loadOverviewGraph(); else focusOn(state.center);
    loadTimeline();
  });
  $('fitBtn').addEventListener('click', fit);
  $('overviewBtn').addEventListener('click', loadOverviewGraph);

  // Layout tabs — state, URL (?layout=), and rendering stay in sync.
  function setLayout(layout, { rerender = true } = {}) {
    state.layout = layout;
    for (const [id, l] of [['segConstellation', 'constellation'], ['segChronicle', 'chronicle']]) {
      $(id).classList.toggle('active', layout === l);
      $(id).setAttribute('aria-selected', layout === l);
    }
    const u = new URL(location.href);
    if (layout === 'chronicle') u.searchParams.set('layout', 'chronicle');
    else u.searchParams.delete('layout');
    history.replaceState(null, '', u);
    $('orderBtn').hidden = layout !== 'chronicle';
    if (state.mode === 'overview') $('crumb').innerHTML = crumbText();
    if (rerender && state.lastData) {
      renderGraph(state.lastData);
      setTimeout(fit, reduceMotion ? 30 : 700);
    }
  }
  $('segConstellation').addEventListener('click', () => setLayout('constellation'));
  $('segChronicle').addEventListener('click', () => setLayout('chronicle'));
  $('orderBtn').addEventListener('click', () => {
    state.chronOrder = state.chronOrder === 'desc' ? 'asc' : 'desc';
    $('orderBtn').textContent = state.chronOrder === 'desc' ? '↓ Newest first' : '↑ Oldest first';
    if (state.mode === 'overview') $('crumb').innerHTML = crumbText();
    if (state.lastData) {
      renderGraph(state.lastData);
      setTimeout(fit, reduceMotion ? 30 : 700);
    }
  });
  $('readingClose').addEventListener('click', () => {
    $('reading').hidden = true;
    $('readingEmpty').hidden = false;
  });

  // ── Quick switcher ───────────────────────────────────────────────────────
  const switcher = $('switcher');
  const swInput = $('switcherInput');
  const swResults = $('switcherResults');
  let swItems = [], swActive = 0, swTimer = null;

  function openSwitcher() { switcher.hidden = false; swInput.value = ''; swResults.innerHTML = '<div class="sw-empty">Type to search everything Vodou remembers.</div>'; swInput.focus(); }
  function closeSwitcher() { switcher.hidden = true; }
  $('searchBtn').addEventListener('click', openSwitcher);
  switcher.addEventListener('click', (ev) => { if (ev.target === switcher) closeSwitcher(); });

  swInput.addEventListener('input', () => {
    clearTimeout(swTimer);
    swTimer = setTimeout(async () => {
      const q = swInput.value.trim();
      if (!q) { swResults.innerHTML = '<div class="sw-empty">Type to search everything Vodou remembers.</div>'; swItems = []; return; }
      const { results } = await api('search', { q, limit: 14, archived: state.includeArchived ? 1 : undefined });
      swItems = results; swActive = 0;
      swResults.innerHTML = results.length ? results.map((r, i) => `
        <button class="sw-row ${i === 0 ? 'active' : ''}" data-i="${i}">
          <span class="dot" style="background:${tagColor(r.chunk_tag || 'UNTAGGED')};opacity:${trustOpacity(r.cls)}"></span>
          ${esc((r.snip || '').slice(0, 90))}
          <small>${esc(baseName(r.path))} · ${esc(CLS_LABEL[r.cls] || r.cls)} · ${fmtDate(r.created_at)}</small>
        </button>`).join('')
        : '<div class="sw-empty">No memories match. Vodou hasn\'t heard about this yet.</div>';
      swResults.querySelectorAll('.sw-row').forEach((el) =>
        el.addEventListener('click', () => pickSwitcher(parseInt(el.dataset.i, 10))));
    }, 140);
  });
  function pickSwitcher(i) {
    const r = swItems[i];
    if (!r) return;
    closeSwitcher();
    select({ id: r.id, type: 'chunk' });
    spotlight(r.path);
  }
  swInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      swActive = Math.max(0, Math.min(swItems.length - 1, swActive + (ev.key === 'ArrowDown' ? 1 : -1)));
      swResults.querySelectorAll('.sw-row').forEach((el, i) => el.classList.toggle('active', i === swActive));
      swResults.querySelectorAll('.sw-row')[swActive]?.scrollIntoView({ block: 'nearest' });
    } else if (ev.key === 'Enter') { pickSwitcher(swActive); }
  });

  document.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); switcher.hidden ? openSwitcher() : closeSwitcher(); }
    else if (ev.key === 'Escape') {
      if (!switcher.hidden) closeSwitcher();
      else if (!$('conflictsPanel').hidden) $('conflictsPanel').hidden = true;
      else if (state.mode === 'local') loadOverviewGraph();
    }
  });

  // ── Conflicts panel ──────────────────────────────────────────────────────
  $('conflictsBtn').addEventListener('click', async () => {
    const rows = await api('conflicts');
    $('conflictsList').innerHTML = rows.length ? rows.map((x) => `
      <div class="conflict-card ${x.status === 'open' ? 'open' : ''}">
        <div class="conflict-slot">${esc(x.slot)}
          <span class="status-chip ${x.status === 'open' ? 'open' : ''}">${esc(x.status.replace('_', ' '))}</span>
          <span class="vault-meta">similarity ${(x.cosine ?? 0).toFixed(2)} · ${fmtDate(x.created_at)}</span>
        </div>
        <div class="conflict-sides">
          <button class="conflict-side ${x.status === 'kept_import' ? 'winner' : ''}" data-open="${esc(x.import_chunk_id)}">
            <div class="side-label">${esc(x.import_scope || 'imported')} says</div>
            <div class="side-value">${esc(x.import_value)}</div>
            <div class="side-text">${esc((x.import_text || '').slice(0, 220))}</div>
          </button>
          <button class="conflict-side ${x.status === 'kept_native' ? 'winner' : ''}" data-open="${esc(x.native_chunk_id)}">
            <div class="side-label">${esc(x.native_scope || 'you')} said</div>
            <div class="side-value">${esc(x.native_value)}</div>
            <div class="side-text">${esc((x.native_text || '').slice(0, 220))}</div>
          </button>
        </div>
        ${x.status === 'open' ? `<div class="conflict-actions">
          <button class="ghost-btn" data-resolve="${esc(x.id)}" data-keep="import" title="Keep the imported line — the other side is superseded (reversible)">Keep imported</button>
          <button class="ghost-btn" data-resolve="${esc(x.id)}" data-keep="native" title="Keep your line — the imported side is superseded (reversible)">Keep yours</button>
          <button class="ghost-btn" data-resolve="${esc(x.id)}" data-keep="dismiss" title="False positive — clears this entry, changes no memory">Not a conflict</button>
          <span class="conflict-msg"></span>
        </div>` : ''}
      </div>`).join('')
      : '<div class="sw-empty">No conflicts — every source of your memory agrees.</div>';
    $('conflictsList').querySelectorAll('[data-open]').forEach((el) =>
      el.addEventListener('click', () => {
        $('conflictsPanel').hidden = true;
        select({ id: el.dataset.open, type: 'chunk' });
      }));
    $('conflictsList').querySelectorAll('[data-resolve]').forEach((el) =>
      el.addEventListener('click', async () => {
        const card = el.closest('.conflict-card');
        const actions = el.closest('.conflict-actions');
        const msg = actions.querySelector('.conflict-msg');
        actions.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        el.textContent = '…';
        try {
          await resolveConflict(el.dataset.resolve, el.dataset.keep);
          if (card) { card.classList.remove('open'); card.style.opacity = '0.5'; }
          msg.textContent = el.dataset.keep === 'dismiss' ? '✓ dismissed' : '✓ resolved';
          setTimeout(() => card && card.remove(), 1200);
        } catch (err) {
          msg.textContent = `✗ ${err.message || err}`;
          actions.querySelectorAll('button').forEach((b) => { b.disabled = false; });
          el.textContent = el.dataset.keep === 'import' ? 'Keep imported' : el.dataset.keep === 'native' ? 'Keep yours' : 'Not a conflict';
        }
      }));
    $('conflictsPanel').hidden = false;
  });
  $('conflictsClose').addEventListener('click', () => { $('conflictsPanel').hidden = true; });
  $('conflictsPanel').addEventListener('click', (ev) => { if (ev.target === $('conflictsPanel')) $('conflictsPanel').hidden = true; });

  // ── Timeline ─────────────────────────────────────────────────────────────
  async function loadTimeline() {
    const rows = await api('timeline', { days: 120, archived: state.includeArchived ? 1 : undefined });
    const tl = d3.select('#timeline');
    tl.selectAll('*').remove();
    if (!rows.length) return;
    const byDay = d3.group(rows, (r) => r.day);
    const days = [...byDay.keys()].sort();
    const W = $('timeline').getBoundingClientRect().width || 800;
    const H = 66, padB = 14;
    const x = d3.scaleBand().domain(days).range([0, W]).paddingInner(0.25);
    const maxN = d3.max(days, (d) => d3.sum(byDay.get(d), (r) => r.n)) || 1;
    const y = d3.scaleLinear().domain([0, maxN]).range([0, H - padB - 4]);
    const tooltip = $('tooltip');
    for (const day of days) {
      let acc = 0;
      const total = d3.sum(byDay.get(day), (r) => r.n);
      const g = tl.append('g').attr('class', 'tl-bar')
        .on('mouseenter', (ev) => {
          tooltip.innerHTML = `<div class="t-title">${day}</div><div class="t-meta">${total} memories — ${byDay.get(day).map((r) => `${r.tag} ${r.n}`).slice(0, 5).join(' · ')}</div>`;
          tooltip.hidden = false;
          const wrap = document.querySelector('.canvas-wrap').getBoundingClientRect();
          tooltip.style.left = `${Math.min(ev.clientX - wrap.left, wrap.width - 310)}px`;
          tooltip.style.top = `${wrap.height - 70}px`;
        })
        .on('mouseleave', () => { tooltip.hidden = true; })
        .on('click', () => {
          const p = `memory/${day}.md`;
          select({ id: p, type: 'file' });
          spotlight(p);
        });
      for (const r of [...byDay.get(day)].sort((a, b) => b.n - a.n)) {
        const h = y(r.n);
        g.append('rect')
          .attr('x', x(day)).attr('width', Math.max(x.bandwidth(), 1.5))
          .attr('y', H - padB - acc - h).attr('height', Math.max(h, 0.5))
          .attr('rx', 1).attr('fill', tagColor(r.tag)).attr('fill-opacity', 0.8);
        acc += h;
      }
    }
    const every = Math.ceil(days.length / 8);
    days.forEach((d, i) => {
      if (i % every !== 0) return;
      tl.append('text').attr('class', 'tl-axis')
        .attr('x', x(d)).attr('y', H - 2).text(d.slice(5));
    });
  }

  // ── Share vaults (PLAN-MEMORY-VAULTS V2) ─────────────────────────────────
  // Brain stays read-only over memory.db; every vault WRITE goes to the
  // gateway's /api/vaults (localhost cross-origin — CORS + CSRF both admit
  // 127.0.0.1 origins), which shells the Rust resolver. This UI never
  // computes membership itself.
  const GW = `${location.protocol}//${location.hostname}:8765`;
  async function gwApi(path, opts = {}) {
    const res = await fetch(`${GW}/api/vaults${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error || `gateway HTTP ${res.status}`);
    return body;
  }
  // Brain is read-only over memory.db; conflict resolution is a WRITE, so it
  // goes to the gateway's Rust resolver (same cross-origin path as vault edits).
  // keep: 'import' | 'native' | 'dismiss' (dismiss = false positive, no change).
  async function resolveConflict(id, keep) {
    const res = await fetch(`${GW}/api/import/contradictions/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keep }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error || `gateway HTTP ${res.status}`);
    return body;
  }

  // Chunk id `path:line:hash` → its file path (for dimming file nodes).
  const chunkPath = (id) => id.replace(/:\d+:[0-9a-f]+$/i, '');

  async function loadShareVaults() {
    try {
      const { vaults } = await gwApi('');
      state.shareVaults = vaults || [];
      renderShareVaults();
    } catch (err) {
      $('shareVaults').innerHTML =
        `<div class="rail-hint">Gateway offline — vault editing needs the main Vodou console running. (${esc(err.message)})</div>`;
    }
  }

  function ruleSummary(r) {
    const bits = [];
    if (r.scopes?.length) bits.push(r.scopes.join(', '));
    if (r.tags?.length) bits.push(r.tags.join('+'));
    if (r.since_days) bits.push(`last ${r.since_days}d`);
    if (r.include_imports) bits.push('incl. imports');
    return bits.length ? bits.join(' · ') : 'everything (minus imports)';
  }

  function renderShareVaults() {
    const vs = state.shareVaults;
    $('shareVaults').innerHTML = vs.length ? vs.map((v) => `
      <div class="svault ${state.vaultPreview?.name === v.name ? 'previewing' : ''}" data-name="${esc(v.name)}">
        <div class="svault-top">
          <span class="svault-name">${esc(v.name)}</span>
          <span class="svault-actions">
            <button class="sv-btn" data-act="preview" title="Light up exactly what this vault shares">◉</button>
            <button class="sv-btn" data-act="edit" title="Edit rules">✎</button>
            <button class="sv-btn" data-act="delete" title="Delete vault (memory untouched)">🗑</button>
          </span>
        </div>
        <div class="rail-hint svault-rules">${esc(ruleSummary(v.rules || {}))}</div>
      </div>`).join('')
      : '<div class="rail-hint">No share vaults yet.</div>';

    $('shareVaults').querySelectorAll('.sv-btn').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const name = btn.closest('.svault').dataset.name;
        const act = btn.dataset.act;
        try {
          if (act === 'preview') await previewVault(name);
          else if (act === 'edit') openVaultEditor(name);
          else if (act === 'delete') {
            if (!confirm(`Delete vault "${name}"? Your memory itself is untouched — only the vault definition goes.`)) return;
            await gwApi(`/${encodeURIComponent(name)}`, { method: 'DELETE' });
            if (state.vaultPreview?.name === name) clearVaultPreview();
            await loadShareVaults();
          }
        } catch (err) { alert(err.message); }
      });
    });
  }

  async function previewVault(name) {
    const { preview } = await gwApi(`/${encodeURIComponent(name)}/preview`);
    const ids = new Set(preview.ids || []);
    const paths = new Set([...ids].map(chunkPath));
    state.vaultPreview = { name, total: preview.total, ids, paths };
    $('vaultPreviewText').innerHTML =
      `<b>${esc(name)}</b> — ${preview.total} memor${preview.total === 1 ? 'y' : 'ies'} would be shared, nothing else`;
    $('vaultPreviewBar').hidden = false;
    renderShareVaults();
    // Re-render with members lit and the rest faded.
    if (state.lastData) renderGraph(state.lastData);
  }

  function clearVaultPreview() {
    state.vaultPreview = null;
    $('vaultPreviewBar').hidden = true;
    renderShareVaults();
    if (state.lastData) renderGraph(state.lastData);
  }
  $('vaultPreviewClear').addEventListener('click', clearVaultPreview);
  $('vaultPreviewExport').addEventListener('click', async () => {
    const vp = state.vaultPreview;
    if (!vp) return;
    const btn = $('vaultPreviewExport');
    btn.disabled = true;
    btn.textContent = 'Exporting…';
    try {
      const r = await gwApi(`/${encodeURIComponent(vp.name)}/export`, { method: 'POST', body: '{}' });
      // Pull a copy into ~/Downloads too (Content-Disposition: attachment —
      // the tab stays put). The durable copy remains in .vodou/exports/.
      if (r.download) {
        const a = document.createElement('a');
        a.href = `${GW}${r.download}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      const fname = (r.file || '').split('/').pop();
      $('vaultPreviewText').innerHTML =
        `<b>${esc(vp.name)}</b> exported ✓ — in your Downloads <span class="mono" title="Copy kept at ${esc(r.file)} — recipients import it via Brain → Sources">${esc(fname)}</span>`;
    } catch (err) {
      alert(`Export failed: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = '⇪ Export this vault';
    }
  });

  // Editor — scope/tag chips are populated from live data at open time.
  function openVaultEditor(name) {
    state.vaultEditing = name || null;
    const v = name ? state.shareVaults.find((x) => x.name === name) : null;
    const rules = v?.rules || {};
    $('vaultEditorTitle').textContent = v ? `Edit vault — ${v.name}` : 'New share vault';
    $('vfName').value = v?.name || '';
    $('vfName').disabled = !!v; // rename = delete + recreate (keeps overrides simple)
    $('vfSince').value = rules.since_days ? String(rules.since_days) : '';
    $('vfImports').checked = !!rules.include_imports;
    $('vfError').hidden = true;

    const scopeSet = new Set(rules.scopes || []);
    const scopePrefixes = [...new Set(state.scopes.map((s) => s.scope))].sort();
    $('vfScopes').innerHTML = scopePrefixes.map((s) => `
      <button class="chip ${scopeSet.has(s) ? 'active' : ''}" data-v="${esc(s)}" type="button">
        <span class="mono">${esc(s)}</span>
      </button>`).join('');
    const tagSet = new Set((rules.tags || []).map((t) => t.toUpperCase()));
    const tags = (state.overview?.byTag || []).map((t) => t.tag).filter((t) => t !== 'UNTAGGED');
    $('vfTags').innerHTML = tags.map((t) => `
      <button class="chip ${tagSet.has(t) ? 'active' : ''}" data-v="${esc(t)}" type="button">
        <span class="dot" style="background:${tagColor(t)}"></span>${esc(t)}
      </button>`).join('');
    for (const row of ['vfScopes', 'vfTags']) {
      $(row).querySelectorAll('.chip').forEach((el) =>
        el.addEventListener('click', () => el.classList.toggle('active')));
    }
    $('vaultEditor').hidden = false;
    if (!v) $('vfName').focus();
  }
  $('vaultNewBtn').addEventListener('click', () => openVaultEditor(null));
  $('vaultEditorClose').addEventListener('click', () => { $('vaultEditor').hidden = true; });
  $('vaultEditor').addEventListener('click', (ev) => { if (ev.target === $('vaultEditor')) $('vaultEditor').hidden = true; });

  $('vfSave').addEventListener('click', async () => {
    const name = $('vfName').value.trim();
    const rules = {
      scopes: [...$('vfScopes').querySelectorAll('.chip.active')].map((el) => el.dataset.v),
      tags: [...$('vfTags').querySelectorAll('.chip.active')].map((el) => el.dataset.v),
      since_days: $('vfSince').value ? Number($('vfSince').value) : null,
      include_imports: $('vfImports').checked,
    };
    try {
      if (state.vaultEditing) {
        await gwApi(`/${encodeURIComponent(state.vaultEditing)}`, { method: 'PUT', body: JSON.stringify({ rules }) });
      } else {
        await gwApi('', { method: 'POST', body: JSON.stringify({ name, rules }) });
      }
      $('vaultEditor').hidden = true;
      await loadShareVaults();
      await previewVault(state.vaultEditing || name); // show what the rules caught, immediately
    } catch (err) {
      $('vfError').textContent = err.message;
      $('vfError').hidden = false;
    }
  });

  /** Per-memory vault controls for the reading pane (include/exclude overrides). */
  function vaultChunkControls(chunkId) {
    if (!state.shareVaults.length) return '';
    return `
      <div class="read-sec vault-ctl"><h3>Share vaults</h3>
        <div class="vault-ctl-row">
          <select id="vcSel" class="rail-select">${state.shareVaults.map((v) =>
            `<option value="${esc(v.name)}">${esc(v.name)}</option>`).join('')}</select>
          <button class="ghost-btn" data-vc="include" data-chunk="${esc(chunkId)}" title="Force this memory INTO the vault">＋ add</button>
          <button class="ghost-btn" data-vc="exclude" data-chunk="${esc(chunkId)}" title="Force this memory OUT of the vault">－ keep out</button>
          <button class="ghost-btn" data-vc="clear" data-chunk="${esc(chunkId)}" title="Let the vault's rules decide again">rules decide</button>
        </div>
      </div>`;
  }
  function wireVaultChunkControls() {
    $('reading').querySelectorAll('[data-vc]').forEach((el) =>
      el.addEventListener('click', async () => {
        const name = $('reading').querySelector('#vcSel')?.value;
        if (!name) return;
        try {
          await gwApi(`/${encodeURIComponent(name)}/overrides`, {
            method: 'POST',
            body: JSON.stringify({ chunk_id: el.dataset.chunk, action: el.dataset.vc }),
          });
          el.textContent = '✓';
          setTimeout(() => { el.textContent = el.dataset.vc === 'include' ? '＋ add' : el.dataset.vc === 'exclude' ? '－ keep out' : 'rules decide'; }, 1200);
          if (state.vaultPreview?.name === name) await previewVault(name); // live re-dim
        } catch (err) { alert(err.message); }
      }));
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  (async function boot() {
    if (new URLSearchParams(location.search).get('layout') === 'chronicle') {
      setLayout('chronicle', { rerender: false });
    }
    try {
      const [o, sc, projs] = await Promise.all([api('overview'), api('scopes'), api('projects')]);
      state.overview = o;
      state.scopes = sc;
      renderStats(o);
      renderVaults(sc);
      loadShareVaults(); // gateway-backed; degrades to a hint if :8765 is down
      renderTagChips(o.byTag.filter((t) => t.tag !== 'UNTAGGED').concat(o.byTag.filter((t) => t.tag === 'UNTAGGED')));
      if (projs.some((p) => p.project !== 'global')) {
        const sel = $('projectSel');
        sel.hidden = false;
        sel.innerHTML = `<option value="">All projects</option>`
          + `<option value="global">Global memories only</option>`
          + projs.filter((p) => p.project !== 'global')
            .map((p) => `<option value="${esc(p.project)}">${esc(p.name || p.project)} (${p.n})</option>`).join('');
        sel.addEventListener('change', () => { state.project = sel.value; loadOverviewGraph(); });
      }
      $('archivedChk').addEventListener('change', (ev) => {
        state.includeArchived = ev.target.checked;
        loadOverviewGraph();
        loadTimeline();
      });
      $('similarChk').addEventListener('change', async (ev) => {
        state.similar = ev.target.checked;
        // Reload whichever view is active so the similarity overlay applies live.
        if (state.mode === 'local' && state.center) await focusOn(state.center);
        else await loadOverviewGraph();
        // Confirm the overlay took effect with a live count in the breadcrumb.
        if (state.similar) {
          const n = (state.lastData?.links || []).filter((l) => l.type === 'similar').length;
          const el = $('crumb');
          if (el) el.innerHTML += ` · <span style="color:#2ec4b6">✦ ${n} similarity edge${n === 1 ? '' : 's'}</span>`;
        }
      });
      await loadOverviewGraph();
      await loadTimeline();
    } catch (err) {
      $('crumb').innerHTML = `<b>Brain couldn't reach memory.db</b> — ${esc(err.message)}`;
    }
  })();
})();
