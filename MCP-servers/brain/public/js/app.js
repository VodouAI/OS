// BUILD COPY of MCP-servers/Vodou-Console/public/js/brain/app.js — edit there, then `npm run build` in MCP-servers/brain.
/* Brain mini console — memory constellation over /api/brain/*.
 * Vanilla JS + vendored D3 v7. Read-only by construction.
 * Signature: trust = luminosity (yours glows, captures dim, imports dimmer). */
(() => {
  'use strict';
  // PLAN-BRAIN-INTO-CONSOLE P1.3 — `VodouBrain.mount(root, opts)` returns a
  // handle; `destroy()` undoes every listener, timer and simulation so the
  // graph can mount inside the Console's #/memory route and unmount on
  // navigation. The standalone :8767 console calls the same function with
  // `embedded:false` (own header, ⌘K, ?layout= URL sync). Canonical copy:
  // MCP-servers/Vodou-Console/public/js/brain/app.js.
  //   opts.apiBase     graph READS (/api/brain/*): '' = same origin
  //   opts.gatewayBase  vault + conflict WRITES: '' = same origin (Console);
  //                     the standalone passes the gateway URL
  //   opts.embedded default true
  //   opts.layout   'constellation' | 'latest' | 'web' | 'chronicle'
  //   opts.node     a chunk / file / entity:<id> to focus on boot
  //   opts.onLayout (layout) => void — the host owns the URL
  //   opts.onOpenFile (path, line) => void — host can open the memory file for editing
  function mount(root, opts = {}) {
  const embedded = opts.embedded !== false;
  const apiBase = (opts.apiBase || '').replace(/\/$/, '');
  root.classList.add('brain-root');
  root.classList.toggle('embedded', embedded);
  root.innerHTML = globalThis.VodouBrainTemplate;
  // Everything registered through `on()` is torn down by destroy().
  const disposers = [];
  const on = (target, ev, fn, o) => {
    target.addEventListener(ev, fn, o);
    disposers.push(() => target.removeEventListener(ev, fn, o));
  };
  // Colours are baked into SVG attributes at render time (fill, stroke, the tag
  // hues resolved through css()). So a theme or palette change repaints the
  // chrome via CSS variables instantly and leaves the stars on the old palette
  // until something else happens to trigger a render — a visible half-swapped
  // view. Watch the attribute the shell actually flips and repaint from
  // `lastData`: no fetch, and it catches every path that changes it (Settings,
  // the shell toggle, the appearance file on reload).
  //
  // Embedded only. The standalone has its own theme button whose handler
  // already reloads the sky, and observing there would render it twice.
  if (embedded) {
    const themeWatch = new MutationObserver(() => { if (state.lastData) renderGraph(state.lastData); });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-palette'] });
    disposers.push(() => themeWatch.disconnect());
  }
  // Rule 7: a raw scope string never reaches the eye — vocabulary.js maps it.
  const scopeLabel = (s) => (globalThis.VodouVocabulary && globalThis.VodouVocabulary.scopeLabel
    ? globalThis.VodouVocabulary.scopeLabel(s) : String(s || ''));
  // A conflict card names its two sides; when the vocabulary can only say
  // "memory" for a side, the provenance class is the more useful word.
  const sideLabel = (scope, dflt) => { const l = scope ? scopeLabel(scope) : ''; return l && l !== 'memory' ? l : dflt; };

  // Tag hues — same family as the shipped Memory Atlas (memory-atlas.js TAG_HUES).
  const TAG_HUES = {
    DECISION: 258, ISSUE: 350, DEAD_END: 340, PREF: 200, DONE: 160,
    PLANNED: 210, GOTCHA: 28, METRIC: 190, PATTERN: 270, DEPENDENCY: 220,
    EXAMPLE: 45, RESEARCH: 230, UNTAGGED: 210,
  };
  // What a name IS, once the classifier has judged it (PLAN P3/P4). Hues are
  // deliberately far apart: the point of the web is telling people from products
  // at a glance, so those two must never be neighbours on the wheel.
  const KIND_HUES = {
    person: 145, org: 265, product: 205, project: 35, place: 175, event: 320,
    handle: 95, name: 210, not_an_entity: 0,
  };
  const KIND_LABEL = {
    person: 'People', org: 'Orgs', product: 'Products', project: 'Projects',
    place: 'Places', event: 'Events', handle: 'Handles', name: 'Unclassified',
    not_an_entity: 'Junk',
  };
  // P5 predicates, rendered as English. A typed edge is the difference between
  // "these two turn up together" and "she signed the thing he wrote".
  const PREDICATE_LABEL = {
    works_at: 'works at', founded: 'founded', member_of: 'member of',
    reports_to: 'reports to', met_with: 'met with', introduced: 'introduced',
    signed: 'signed', invested_in: 'invested in', advises: 'advises',
    located_in: 'in', built: 'built', uses: 'uses', depends_on: 'depends on',
    blocked_by: 'blocked by', part_of: 'part of', related_to: 'related to',
  };
  const predLabel = (p) => PREDICATE_LABEL[p] || (p || '').replace(/_/g, ' ');
  const css = (name) => getComputedStyle(root).getPropertyValue(name).trim();
  const kindColor = (kind) => {
    const hue = KIND_HUES[kind] ?? 210;
    if (kind === 'not_an_entity') return `hsl(0, 0%, 55%)`;
    return `hsl(${hue}, ${css('--tag-s') || '55%'}, ${css('--tag-l') || '62%'})`;
  };
  const tagColor = (tag) => {
    const hue = TAG_HUES[tag] ?? 210;
    const sat = tag === 'UNTAGGED' ? '12%' : css('--tag-s') || '55%';
    return `hsl(${hue}, ${sat}, ${css('--tag-l') || '62%'})`;
  };
  // Trust → luminosity. The one visual rule everything else defers to.
  const trustOpacity = (cls) => (cls === 'imported' ? 0.5 : cls === 'captured' ? 0.72 : 0.95);
  // Latest view: distance from the newest memory, in pixels and in brightness.
  // Ring 3 is the ordinary sky, pushed out and turned down until it reads as
  // weather rather than content — the point is that it's still THERE.
  // Ring 0 orbits rather than sits at zero: the core itself is pinned dead
  // centre by fx/fy, so a 0 radius here just piles the other 8 memories from
  // the same save on top of it and buries the star in its own siblings.
  const RING_R = [84, 200, 395, 900];
  const RING_ALPHA = [1, 0.95, 0.42, 0.1];
  const RING_PULL = [1, 0.62, 0.4, 0.14];
  const ringOf = (d) => (d && d.ring != null ? d.ring : 3);
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
    layout: 'constellation', // 'constellation' | 'latest' | 'web' | 'chronicle'
    latestSeed: null,   // memory the Latest view is centred on (null = the actual newest)
    latestNewestId: null, // the genuinely newest memory, as of the last load
    latestMeta: null,   // { topic, stars, created_at, … } for the crumb
    latestLive: true,   // follow new memories as they land
    webCenter: null,    // entity id the web is centred on (null = whole sky of names)
    webMin: 1,          // hide links weaker than N shared memories
    webDepth: 1,        // 1 = who they appear with · 2 = and who *those* appear with
    webBy: 'chunk',     // 'chunk' = named in the same memory · 'file' = same memory file (looser)
    webKinds: null,     // Set of kinds to show · null = server default (everything but junk)
    webTrail: [],       // [{ id, label }] — the path you walked through the web
    similar: false,     // overlay embedding-similarity edges (PLAN-MEMORY-GRAPH-SIMILARITY-EDGES)
    chronOrder: 'desc', // 'desc' newest-first | 'asc' oldest-first
    project: '',        // '' all · 'global' · project id
    host: '',           // '' all · 'none' (unstamped) · a bare host (P4 page axis)
    includeArchived: false,
    lastData: null,
    center: null,
    selected: null,
    overview: null,
    scopes: [],          // live scope rows (share-vault editor reuses them)
    shareVaults: [],     // named share vaults from the gateway (PLAN-MEMORY-VAULTS)
    vaultPreview: null,  // { name, total, ids:Set, paths:Set } — dims the sky
    vaultEditing: null,  // vault name being edited, or null for create
    matchIds: null,      // Set of chunk ids the RANKED search returned (handle.setFilter)
    matchPaths: null,    // their files, so a file node lights up with its memories
  };
  // Dated memory files (daily logs, monthly import digests) anchor the Chronicle spine.
  const dateOf = (p) => {
    const m = /(\d{4}-\d{2}(?:-\d{2})?)\.md$/.exec(p || '');
    return m ? m[1] : null;
  };
  const $ = (id) => root.querySelector('#b-' + id);
  root.dataset.layout = state.layout;   // boot value; setLayout keeps it current
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // memory.db stamps are UTC with no zone marker ("2026-08-04 06:34:37") —
  // Date.parse would read that as LOCAL and every age would be off by the
  // UTC offset, so the Z is pinned on before parsing. Date-only strings have
  // no zone to correct and stay NaN here — callers fall back to the raw text.
  const whenMs = (s) => {
    if (!s) return NaN;
    const iso = s.includes('T') ? s : s.replace(' ', 'T');
    if (!iso.includes('T')) return NaN;
    return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z');
  };
  // The LOCAL day a memory landed. Slicing the raw string filed every evening
  // memory under tomorrow — 10 PM here is past midnight UTC.
  const fmtDate = (s) => {
    const t = whenMs(s);
    if (!Number.isFinite(t)) return (s || '').slice(0, 10);
    const d = new Date(t), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const timeAgo = (s) => {
    const t = whenMs(s);
    if (!Number.isFinite(t)) return '';
    const m = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d === 1) return 'yesterday';
    if (d < 7) return `${d}d ago`;
    return fmtDate(s);
  };
  // Absolute stamp in the VIEWER's clock — the raw string is UTC, and a star
  // captioned 06:34 while you watched it land at 02:34 reads as someone
  // else's memory.
  const fmtWhen = (s) => {
    const t = whenMs(s);
    if (!Number.isFinite(t)) return (s || '').slice(0, 16).replace('T', ' ');
    const d = new Date(t), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const baseName = (p) => {
    const b = (p || '').split('/').pop().replace(/\.md$/, '');
    if ((p || '').includes('memory/imports/')) {
      const src = p.split('/')[2] || '';
      return `${src} · ${b}`;
    }
    return b;
  };

  async function api(route, params = {}) {
    const u = new URL(`${apiBase}/api/brain/${route}`, location.origin);
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
    host: state.host || undefined,
    archived: state.includeArchived ? 1 : undefined,
    sim: state.similar ? 1 : undefined,
  });

  // ── Graph ────────────────────────────────────────────────────────────────
  const svg = d3.select($('graph'));
  const zoomLayer = svg.append('g');
  const gLinks = zoomLayer.append('g');
  const gHits = zoomLayer.append('g');   // fat invisible lines — links are clickable in the web
  const gEdgeLabels = zoomLayer.append('g'); // P6: the predicate, written on the line
  const gNodes = zoomLayer.append('g');
  const gLabels = zoomLayer.append('g');
  let sim = null;
  let zoomBehavior = null;
  let nodeSel = null;
  let adjacency = new Map();   // node id → neighbour ids, rebuilt every render
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Soft glow for entities / pinned nodes.
  const defs = svg.append('defs');
  const glow = defs.append('filter').attr('id', 'glow').attr('x', '-80%').attr('y', '-80%').attr('width', '260%').attr('height', '260%');
  glow.append('feGaussianBlur').attr('stdDeviation', 3.2).attr('result', 'b');
  const gm = glow.append('feMerge');
  gm.append('feMergeNode').attr('in', 'b');
  gm.append('feMergeNode').attr('in', 'SourceGraphic');
  // The newest memory's corona. Stops are recoloured per render to whatever the
  // memory's tag colour is, so the star burns in its own hue.
  const coreBloom = defs.append('radialGradient').attr('id', 'core-bloom-grad');
  for (const [offset, op] of [['0%', 0.72], ['18%', 0.42], ['42%', 0.15], ['70%', 0.04], ['100%', 0]]) {
    coreBloom.append('stop').attr('offset', offset).attr('stop-opacity', op);
  }
  // P6 arrowhead. "Chad founded Vodou Inc" and its reverse are different claims,
  // so a typed edge has to show which way it reads.
  defs.append('marker')
    .attr('id', 'rel-arrow').attr('viewBox', '0 -5 10 10')
    .attr('refX', 10).attr('refY', 0)
    .attr('markerWidth', 5).attr('markerHeight', 5)
    .attr('orient', 'auto').attr('markerUnits', 'strokeWidth')
    .append('path').attr('d', 'M0,-4L9,0L0,4').attr('class', 'rel-arrow-head');

  function nodeRadius(d) {
    // In Latest, size carries ring: the newest memory is unmistakably the sun,
    // and the backdrop shrinks to specks so it can't compete for attention.
    if (state.layout === 'latest' && d.ring != null) {
      if (d.core && d.center) return 15;
      if (d.topic) return d.type === 'entity' ? 16 : 11;
      if (d.ring === 0) return d.type === 'entity' ? 12 : d.type === 'file' ? 10 : 7.5;
      if (d.ring === 1) return d.type === 'entity' ? 10 : 6;
      if (d.ring === 2) return d.type === 'entity' ? 7 : 4.2;
      return d.type === 'entity' ? 3.4 : Math.min(2 + Math.sqrt(d.n || 1) * 0.5, 5);
    }
    if (d.spine) return Math.min(4.5 + Math.sqrt(d.n || 1) * 1.35, 9);
    if (d.type === 'entity') return Math.min(7 + Math.sqrt(d.n || 1) * 1.8, 20);
    if (d.type === 'file') return Math.min(4.5 + Math.sqrt(d.n || 1) * 1.35, 24);
    if (d.type === 'doc') return Math.min(3 + Math.sqrt(d.n || 1) * 1.1, 10);
    return 4.5;
  }
  function nodeColor(d) {
    // In the web a star's colour carries its kind — the constellation keeps the
    // single accent, where entities are one node type among four.
    if (d.type === 'entity') return state.layout === 'web' ? kindColor(d.kind) : css('--accent');
    if (d.type === 'doc') return css('--text-muted');
    return tagColor(d.tag || 'UNTAGGED');
  }
  function nodeOpacity(d) {
    // Latest: ring dimming outranks TRUST. Distance from the newest memory is
    // what that view is about, so it owns the luminosity channel — against the
    // passive signals.
    const inRings = state.layout === 'latest' && d.ring != null;
    const base = inRings
      ? (d.type === 'entity' ? 1 : d.type === 'doc' ? 0.6 : trustOpacity(d.cls)) * RING_ALPHA[ringOf(d)]
      : (d.type === 'entity' ? 1 : d.type === 'doc' ? 0.55 : trustOpacity(d.cls));

    // An EXPLICIT filter is different: a vault preview or a search is the user
    // saying what the view is about, and it outranks the layout. Both checks
    // used to sit BELOW the Latest early-return, so in that layout clicking
    // "◉ preview this vault" changed not one pixel — an explicit action with no
    // feedback — and the search highlight had the same hole. In the rings the
    // filter now MULTIPLIES rather than replaces, so distance still reads while
    // non-matches fade. Found 2026-08-26, PLAN-BRAIN-CONSOLE-VERIFY §4.4.
    const missed = (flat) => (inRings ? base * 0.12 : flat);

    // Vault preview: members keep their luminosity, everything else fades —
    // "see exactly what leaves" before an export (PLAN-MEMORY-VAULTS V2).
    if (state.vaultPreview) {
      const vp = state.vaultPreview;
      const member = d.type === 'chunk' ? vp.ids.has(d.id)
        : d.type === 'file' ? vp.paths.has(d.id) || vp.paths.has(d.path)
        : false;
      if (!member) return missed(d.type === 'entity' ? 0.14 : 0.07);
    }
    // Search highlight. The ids come from the RANKED pipeline
    // (/api/memory/search-chunks); the graph only lights up what Recall found —
    // it never decides relevance itself. Migration 077's rule, kept literally.
    if (state.matchIds) {
      const hit = d.type === 'chunk' ? state.matchIds.has(d.id)
        : d.type === 'file' ? state.matchPaths.has(d.id) || state.matchPaths.has(d.path)
        : false;
      if (!hit) return missed(d.type === 'entity' ? 0.12 : 0.06);
    }
    return base;
  }
  const linkStyle = {
    mention:   { stroke: () => css('--link-gold'), width: (l) => Math.min(0.6 + l.w * 0.25, 2.4), dash: null },
    // In the web the co-mention edge IS the content, so it carries its weight
    // openly: thickness = how many memories name both. Elsewhere it stays a hint.
    comention: {
      // A typed edge (P5) earns the accent colour and a little more weight —
      // "founded" should not look like "happened to share a paragraph".
      stroke: (l) => (l.predicate ? css('--accent') : css('--link-gold')),
      width: (l) => (state.layout === 'web'
        ? Math.min((l.predicate ? 1.4 : 0.8) + Math.sqrt(l.w) * 1.15, 6)
        : 0.7),
      dash: () => (state.layout === 'web' ? null : '1,4'),
    },
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
    gHits.selectAll('*').remove();
    gEdgeLabels.selectAll('*').remove();
    gNodes.selectAll('*').remove();
    gLabels.selectAll('*').remove();

    const { width, height } = svg.node().getBoundingClientRect();

    // Chronicle layout: dated files pinned in date order down the left edge,
    // newest first; everything else floats to the right on the same links.
    const chronicle = state.layout === 'chronicle';
    // Web layout: names only, and the lines between them are the subject.
    const web = state.layout === 'web';
    // Latest layout: rings around the newest memory. Guarded on the data actually
    // carrying rings — focusing a node from inside Latest hands us a plain focus
    // graph, and laying THAT out radially would file every node under "the rest
    // of the sky" and fade the whole view to 10%.
    const latest = state.layout === 'latest' && nodes.some((n) => n.ring != null);
    const cx = width / 2, cy = height / 2;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const endRing = (e) => ringOf(typeof e === 'object' ? e : byId.get(e));
    const linkRing = (l) => Math.max(endRing(l.source), endRing(l.target));
    if (latest) {
      const core = nodes.find((n) => n.center && n.core) || nodes.find((n) => n.ring === 0);
      if (core) { core.fx = cx; core.fy = cy; }
      // The backdrop is PAINTED, not simulated. 1,200 ring-3 nodes relaxing at
      // 8ms a tick starve the very zoom animation this view is built around —
      // and they're scenery, so their exact positions carry no meaning. Pinning
      // them to a deterministic scatter buys the whole frame budget back, and a
      // sky that holds still is easier to read than one that keeps crawling.
      let seed = 9;
      const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      for (const n of nodes) {
        if (n.fx != null) continue;
        if (ringOf(n) === 3) {
          // Spread across the whole disc, not just an outer band: a backdrop
          // that only exists beyond the zoom isn't a backdrop, it's a thing you
          // scrolled away from. Faint stars BEHIND the focused rings are what
          // make this read as depth. sqrt() keeps the density even by area.
          const a = rnd() * Math.PI * 2;
          const r = RING_R[3] * (0.14 + 1.15 * Math.sqrt(rnd()));
          n.fx = n.x = cx + Math.cos(a) * r;
          n.fy = n.y = cy + Math.sin(a) * r * 0.8;    // wider than tall, like the canvas
        } else {
          const a = nodes.indexOf(n) * 2.399963;      // golden angle — no clumping
          n.x = cx + Math.cos(a) * (RING_R[ringOf(n)] || 1);
          n.y = cy + Math.sin(a) * (RING_R[ringOf(n)] || 1);
        }
      }
      // Resolve endpoints up front so the link force can be handed the inner
      // subset only — the tick handler still needs objects on every link.
      for (const l of links) {
        if (typeof l.source === 'string') l.source = byId.get(l.source) || l.source;
        if (typeof l.target === 'string') l.target = byId.get(l.target) || l.target;
      }
    }
    const simLinks = latest ? links.filter((l) => linkRing(l) < 3) : links;
    let chronBounds = null;
    if (chronicle) {
      const dated = nodes
        .filter((n) => n.type === 'file' && dateOf(n.path))
        .sort((a, b) => (state.chronOrder === 'desc'
          ? dateOf(b.path).localeCompare(dateOf(a.path))
          : dateOf(a.path).localeCompare(dateOf(b.path))));
      const top = 42;
      const gap = Math.max(26, Math.min(46, (height - top - 30) / Math.max(dated.length, 1)));
      dated.forEach((n, i) => { n.fx = 150; n.fy = top + i * gap; n.spine = true; });
      // Nothing exists outside the run of days. Without this, memories drifted
      // thousands of px above the newest date — floating in time before it.
      chronBounds = [top - 20, top + Math.max(dated.length - 1, 0) * gap + 20];
    }

    // In Latest the backdrop's threads are texture, not information: a ring-3
    // conflict drawn in 3px animated red outshouts the memory the whole view is
    // pointing at. Out there every line is the same hairline, whatever it means.
    const backdrop = (l) => latest && linkRing(l) === 3;
    const link = gLinks.selectAll('line').data(links).join('line')
      .attr('stroke', (l) => (backdrop(l) ? css('--link-dim') : (linkStyle[l.type] || linkStyle.ref).stroke(l)))
      .attr('stroke-width', (l) => (backdrop(l) ? 0.5 : (linkStyle[l.type] || linkStyle.ref).width(l)))
      .attr('stroke-dasharray', (l) => {
        if (backdrop(l)) return null;
        const dash = (linkStyle[l.type] || linkStyle.ref).dash;
        return typeof dash === 'function' ? dash(l) : dash;
      })
      .attr('class', (l) => (l.type === 'conflict' && !reduceMotion && !backdrop(l) ? 'link-conflict-anim' : null))
      // The arrow goes on whichever END the predicate points at — `from`/`to` are
      // stored against the pair, not against this link's source/target order.
      .attr('marker-end', (l) => (web && l.predicate && l.from === (l.source.id || l.source) ? 'url(#rel-arrow)' : null))
      .attr('marker-start', (l) => (web && l.predicate && l.from !== (l.source.id || l.source) ? 'url(#rel-arrow)' : null))
      .attr('stroke-opacity', (l) => linkOpacity(l));
    // A line is only as bright as its dimmest end — otherwise ring-3 threads
    // crossing the middle of the view read as connections to the star.
    function linkOpacity(l) {
      if (latest) return linkRing(l) === 3 ? 0.1 : RING_ALPHA[linkRing(l)] * (linkRing(l) <= 1 ? 0.85 : 0.5);
      return web ? Math.min(0.35 + l.w * 0.09, 0.9) : 0.65;
    }

    // P6 — the predicate, written along its edge. Only typed edges get one:
    // labelling every co-mention would bury the graph in the word "and".
    const edgeLabels = web
      ? gEdgeLabels.selectAll('text').data(links.filter((l) => l.predicate)).join('text')
          .attr('class', 'edge-label')
          .attr('text-anchor', 'middle')
          .text((l) => predLabel(l.predicate))
      : gEdgeLabels.selectAll('text').data([]).join('text');

    // Fat transparent twins: in the web every line is a button that opens the
    // memories behind it. A 1px stroke is unhittable; a 12px one is generous.
    const hit = web
      ? gHits.selectAll('line').data(links).join('line')
          .attr('stroke', 'transparent').attr('stroke-width', 8)
          .attr('cursor', 'pointer').attr('class', 'web-hit')
      : gHits.selectAll('line').data([]).join('line');

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
        // In the web, a transparent halo makes the star a real target: the edges
        // underneath are 8px of clickable line, and an 11px diamond loses that race.
        if (web) {
          g.append('circle').attr('r', r + 10).attr('fill', 'transparent')
            .attr('pointer-events', 'all');
        }
        const p = `M0,${-r} L${r * 0.3},${-r * 0.3} L${r},0 L${r * 0.3},${r * 0.3} L0,${r} L${-r * 0.3},${r * 0.3} L${-r},0 L${-r * 0.3},${-r * 0.3} Z`;
        g.append('path').attr('d', p)
          .attr('fill', nodeColor(d)).attr('fill-opacity', latest ? nodeOpacity(d) : 0.9)
          .attr('filter', latest && ringOf(d) > 1 ? null : 'url(#glow)');
      } else if (d.type === 'doc') {
        const r = nodeRadius(d);
        g.append('rect').attr('x', -r).attr('y', -r).attr('width', r * 2).attr('height', r * 2)
          .attr('rx', 1.5).attr('fill', nodeColor(d)).attr('fill-opacity', nodeOpacity(d));
      } else {
        g.append('circle').attr('r', nodeRadius(d))
          .attr('fill', nodeColor(d)).attr('fill-opacity', nodeOpacity(d))
          .attr('filter', (d.pinned || d.center) && !(latest && ringOf(d) > 1) ? 'url(#glow)' : null);
        // The accent ring marks "this is the selected one" everywhere else. On
        // the Latest core it's redundant with the corona and reads as chrome
        // bolted onto a star, so the glow does that job alone.
        if ((d.pinned || d.center) && !(latest && d.core && d.center)) {
          g.append('circle').attr('r', nodeRadius(d) + 3)
            .attr('fill', 'none').attr('stroke', css('--accent')).attr('stroke-width', 1.1)
            .attr('stroke-opacity', 0.85);
        }
      }
      // The newest memory burns rather than gets circled: a soft corona in its
      // own tag colour, an incandescent white centre, and a slow breath. Rings
      // drawn around a node read as UI chrome — a glow reads as the thing itself
      // being bright, which is what "this is the newest" should look like.
      if (latest && d.center && d.core) {
        const hot = nodeColor(d);
        svg.select('#core-bloom-grad').selectAll('stop')
          .attr('stop-color', hot);
        g.insert('circle', ':first-child')
          .attr('class', `core-bloom${reduceMotion ? '' : ' breathing'}`)
          .attr('r', nodeRadius(d) * 9.5)
          .attr('fill', 'url(#core-bloom-grad)')
          .attr('pointer-events', 'none');
        g.append('circle').attr('class', 'core-spark')
          .attr('r', nodeRadius(d) * 0.34)
          .attr('fill', '#fff').attr('pointer-events', 'none');
        // Say it on the canvas, not just in the breadcrumb — the whole view is
        // an argument about *this* memory, so the claim belongs next to it.
        const when = (state.latestMeta?.created_at || d.created_at || '');
        g.append('text').attr('class', 'core-caption')
          .attr('text-anchor', 'middle').attr('y', nodeRadius(d) + 20)
          .attr('pointer-events', 'none')
          .text(`${state.latestSeed && state.latestSeed !== state.latestNewestId
            ? 'FOCUSED' : 'NEWEST MEMORY'} · ${fmtWhen(when)}`);
      }
    });

    // Labels: all entities + the most substantial files/chunks; every spine date.
    const labelled = nodes.filter((d) =>
      // Latest reads inside-out: everything near the star is named, ring 2 keeps
      // only its names, and the backdrop stays wordless. 1,200 labels would bury
      // the very thing the view exists to point at.
      latest ? (ringOf(d) <= 1 || d.topic || (ringOf(d) === 2 && d.type === 'entity'))
      : web ? true              // a web of names is unreadable without the names
      : d.spine ? true
      // The chronicle band is far denser than the open sky, so naming all 1,061
      // entities there just stacks text on text. Only the recurring ones.
      : d.type === 'entity' ? (chronicle ? (d.n || 0) >= 4 || d.center : (d.n || 0) > 0 || d.center)
      : d.type === 'chunk' ? !!d.center
      : (d.n || 0) >= (d.type === 'file' ? 8 : 12) || d.center);
    const labels = gLabels.selectAll('text').data(labelled, (d) => d.id).join('text')
      .attr('class', (d) => (d.type === 'entity' ? 'entity-label' : 'node-label')
        + (latest && d.center && d.core ? ' core-label' : '')
        + (latest && d.topic ? ' topic-label' : ''))
      .attr('text-anchor', (d) => (d.spine ? 'end' : 'middle'))
      .attr('opacity', (d) => labelOpacity(d))
      .text((d) => {
        const cap = latest && ringOf(d) >= 2 ? 22 : latest && d.center ? 64 : 34;
        const t = d.type === 'entity' ? d.label
          : d.type === 'chunk' ? (d.label || '').slice(0, cap)
          : baseName(d.path);
        // Spine labels run leftward off the canvas. Monthly import digests are
        // dated too ("obsidian · extracted-2026-07"), and at chronicle zoom a
        // full one reaches past the edge and under the rail.
        const max = d.spine ? 18 : latest && d.center ? 66 : 36;
        return t.length > max ? t.slice(0, max - 1) + '…' : t;
      });
    function labelOpacity(d) {
      return latest ? Math.max(RING_ALPHA[ringOf(d)], ringOf(d) <= 2 ? 0.6 : 0) : 1;
    }
    // LIVE timestamps (Latest only): every memory in the spotlit neighborhood
    // wears its real age under the node — the rings say "how connected", the
    // ages say "how recent", and together they read as a timeline. A 30s
    // ticker at module level keeps the ages true while the tab sits open.
    const timeLabels = gLabels.selectAll('text.time-label')
      .data(latest
        ? nodes.filter((n) => n.type === 'chunk' && ringOf(n) <= 1 && n.created_at)
        : [], (d) => d.id)
      .join('text')
      .attr('class', 'time-label')
      .attr('text-anchor', 'middle')
      .text((d) => timeAgo(d.created_at));

    sim = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(simLinks).id((d) => d.id)
        // In the web, strength of the tie pulls the names together — clusters
        // (a project, a household, a deal) fall out of the layout on their own.
        .distance((l) => (web ? Math.max(52, 190 - l.w * 14)
          : latest ? (linkRing(l) === 3 ? 60 : 74)
          : l.type === 'mention' ? (chronicle ? 130 : 46) : l.type === 'comention' ? 90 : l.type === 'contains' ? 34 : 70))
        .strength((l) => (web ? Math.min(0.06 + l.w * 0.05, 0.55)
          // Ring membership decides position in Latest; links only nudge, or a
          // well-connected ring-2 node gets dragged into the middle of ring 1.
          : latest ? (linkRing(l) === 3 ? 0.12 : 0.06)
          // A day's memories have to stay beside that day. At 0.04 the link was
          // too weak to beat charge, so nodes drifted thousands of px from the
          // date that owns them and the chronicle stopped being chronological.
          : chronicle ? (l.type === 'contains' || l.type === 'mention' ? 0.5 : 0.08)
          : l.type === 'comention' ? 0.15 : l.type === 'contains' ? 0.7 : 0.35)))
      .force('charge', d3.forceManyBody().strength((d) => (web ? -420 - (d.n || 0) * 3
        : latest ? (ringOf(d) === 0 ? -700 : ringOf(d) === 1 ? -420 : ringOf(d) === 2 ? -200 : 0)
        // Chronicle repulsion is what blew the sprawl out to x=3139; the spine
        // gives the structure, so charge only needs to stop overlap.
        : d.type === 'entity' ? (chronicle ? -140 : -320) : (chronicle ? -34 : -110))))
      .force('collide', d3.forceCollide().radius((d) => nodeRadius(d)
        + (web ? 22 : latest ? (ringOf(d) <= 1 ? 26 : ringOf(d) === 2 ? 12 : 3)
          : chronicle && d.type === 'entity' ? 26 : 4)))
      // The ring IS the layout: each node is held at its own orbit, and the
      // pull weakens outward so the backdrop can still drift into a natural sky.
      .force('radial', latest
        ? d3.forceRadial((d) => RING_R[ringOf(d)], cx, cy).strength((d) => RING_PULL[ringOf(d)])
        : null)
      .force('center', chronicle || latest ? null : d3.forceCenter(width / 2, height / 2))
      // Chronicle spreads sideways into a band beside the spine; the link force
      // above owns the vertical, so a memory lands level with its own day.
      .force('x', d3.forceX((d, i) => (chronicle ? 350 + ((i * 149) % 250) : width / 2))
        .strength(chronicle ? 0.12 : latest ? 0 : 0.03))
      .force('y', d3.forceY((d) => (chronicle ? d.y : height / 2))
        .strength(chronicle ? 0 : latest ? 0 : 0.04))
      .on('tick', () => {
        if (chronicle) {
          for (const n of nodes) {
            if (n.spine) continue;
            if (n.x < 330) n.x = 330;
            if (chronBounds) n.y = Math.max(chronBounds[0], Math.min(chronBounds[1], n.y));
          }
        }
        link.attr('x1', (l) => l.source.x).attr('y1', (l) => l.source.y)
          .attr('x2', (l) => l.target.x).attr('y2', (l) => l.target.y);
        if (web) {
          hit.attr('x1', (l) => l.source.x).attr('y1', (l) => l.source.y)
            .attr('x2', (l) => l.target.x).attr('y2', (l) => l.target.y);
          edgeLabels.attr('transform', (l) => {
            const mx = (l.source.x + l.target.x) / 2;
            const my = (l.source.y + l.target.y) / 2;
            // Lie along the line, but never upside-down — a label the reader has
            // to tilt their head for is worse than no label.
            let deg = Math.atan2(l.target.y - l.source.y, l.target.x - l.source.x) * 180 / Math.PI;
            if (deg > 90 || deg < -90) deg += 180;
            return `translate(${mx},${my}) rotate(${deg})`;
          }).attr('dy', -3);
        }
        node.attr('transform', (d) => `translate(${d.x},${d.y})`);
        labels
          .attr('x', (d) => (d.spine ? d.x - nodeRadius(d) - 8 : d.x))
          .attr('y', (d) => (d.spine ? d.y + 3.5 : d.y - nodeRadius(d) - 5));
        timeLabels
          .attr('x', (d) => d.x)
          // The core's caption already owns +20, so its age sits a line below.
          .attr('y', (d) => d.y + nodeRadius(d) + (d.core && d.center ? 31 : 12));
      });
    if (reduceMotion) { sim.stop(); sim.tick(280); sim.on('tick')(); }
    // The web starts near-settled: 72 names take ~5s to spread, and a fit taken
    // en route zooms into a knot that then grows out of frame.
    // The web settles once, then holds still. A graph that keeps drifting for
    // five seconds is a graph you cannot click, and clicking is the whole point
    // here. Dragging a star restarts the simulation as usual.
    else if (web) { sim.tick(250); sim.on('tick')(); sim.stop(); }
    // Latest settles once and then holds absolutely still — the camera flight is
    // the animation here, and it can't share a frame budget with a live sim.
    else if (latest) { sim.tick(260); sim.on('tick')(); sim.stop(); }

    // Neighborhood highlight on hover
    const adj = adjacency = new Map();
    for (const l of links) {
      const s = l.source.id || l.source, t = l.target.id || l.target;
      (adj.get(s) || adj.set(s, new Set()).get(s)).add(t);
      (adj.get(t) || adj.set(t, new Set()).get(t)).add(s);
    }
    const tooltip = $('tooltip');
    const emphasize = (d) => {
      const near = adj.get(d.id) || new Set();
      node.attr('opacity', (o) => (o.id === d.id || near.has(o.id) ? 1 : 0.18));
      link.attr('stroke-opacity', (l) =>
        (l.source.id === d.id || l.target.id === d.id ? 0.95 : 0.06));
      labels.attr('opacity', (o) => (o.id === d.id || near.has(o.id) ? 1 : 0.15));
      timeLabels.attr('opacity', (o) => (o.id === d.id || near.has(o.id) ? 1 : 0.15));
    };
    // Latest rests spotlit: the newest memory and what it touches hold the
    // neighborhood highlight from the moment the sky renders, and leaving a
    // hover falls back HERE — the view is an argument about this memory, so
    // its connections are the resting state, not a hover reward.
    const coreNode = latest
      ? nodes.find((n) => n.core && n.center) || nodes.find((n) => ringOf(n) === 0)
      : null;
    const restState = () => {
      if (coreNode) { emphasize(coreNode); return; }
      node.attr('opacity', 1);
      link.attr('stroke-opacity', (l) => linkOpacity(l));
      labels.attr('opacity', (o) => labelOpacity(o));
      timeLabels.attr('opacity', 1);
    };
    node
      .on('mouseenter', (ev, d) => {
        emphasize(d);
        const meta = d.type === 'entity'
          ? `${esc(d.kind)} · ${d.n} mention${d.n === 1 ? '' : 's'}`
            + (web && d.degree != null ? ` · ${d.degree} connection${d.degree === 1 ? '' : 's'}` : '')
            + (web ? ' — double-click to centre the web here' : '')
          : d.type === 'doc' ? `cited ${d.n}×`
          : d.type === 'chunk' ? `${esc(d.tag)} · ${esc(CLS_LABEL[d.cls] || d.cls)} · ${fmtDate(d.created_at)}`
          : `${d.n} memories · ${esc(CLS_LABEL[d.cls] || d.cls)} · last ${fmtDate(d.last)}`;
        tooltip.innerHTML = `<div class="t-title">${esc(d.type === 'entity' ? d.label : d.type === 'chunk' ? (d.label || d.id) : baseName(d.path))}</div><div class="t-meta">${meta}</div>`;
        tooltip.hidden = false;
      })
      .on('mousemove', (ev) => {
        const wrap = root.querySelector('.canvas-wrap').getBoundingClientRect();
        tooltip.style.left = `${Math.min(ev.clientX - wrap.left + 14, wrap.width - 310)}px`;
        tooltip.style.top = `${ev.clientY - wrap.top + 12}px`;
      })
      .on('mouseleave', () => {
        restState();
        tooltip.hidden = true;
      })
      .on('click', (ev, d) => { ev.stopPropagation(); select(d); })
      .on('dblclick', (ev, d) => {
        ev.stopPropagation();
        // In the web, focusing a name re-centres the web on it — you keep walking
        // names. In Latest, it re-centres the rings on that memory, so you can
        // walk outward one star at a time. Everywhere else: focus neighbourhood.
        if (web && d.type === 'entity') centerWeb(d.eid ?? Number(String(d.id).slice(7)), d.label);
        else if (latest && d.type === 'chunk') recentreLatest(d.id);
        else focusOn(d.id);
      });
    if (coreNode) restState();

    // Edges: hover shows the strength, click reads the memories that made it.
    if (web) {
      const nameOf = (n) => (typeof n === 'object' ? n.label : n);
      // The label IS the star here — clicking the word does what clicking the
      // mark does. Chasing an 11px diamond to read about a person is a tax.
      labels.attr('cursor', 'pointer')
        .on('click', (ev, d) => { ev.stopPropagation(); select(d); })
        .on('dblclick', (ev, d) => { ev.stopPropagation(); centerWeb(d.eid ?? eidOf(d.id), d.label); });
      hit
        .on('mouseenter', (ev, l) => {
          link.attr('stroke-opacity', (o) => (o === l ? 1 : 0.08));
          edgeLabels.attr('opacity', (o) => (o === l ? 1 : 0.12));
          node.attr('opacity', (o) => (o.id === l.source.id || o.id === l.target.id ? 1 : 0.2));
          labels.attr('opacity', (o) => (o.id === l.source.id || o.id === l.target.id ? 1 : 0.15));
          const title = l.predicate
            ? `${esc(nameOf(l.from === l.source.id ? l.source : l.target))} <span class="pred">${esc(predLabel(l.predicate))}</span> ${esc(nameOf(l.from === l.source.id ? l.target : l.source))}`
            : `${esc(nameOf(l.source))} &amp; ${esc(nameOf(l.target))}`;
          tooltip.innerHTML = `<div class="t-title">${title}</div>`
            + `<div class="t-meta">${unit(l.w)} — click to read the memories</div>`;
          tooltip.hidden = false;
        })
        .on('mousemove', (ev) => {
          const wrap = root.querySelector('.canvas-wrap').getBoundingClientRect();
          tooltip.style.left = `${Math.min(ev.clientX - wrap.left + 14, wrap.width - 310)}px`;
          tooltip.style.top = `${ev.clientY - wrap.top + 12}px`;
        })
        .on('mouseleave', () => {
          link.attr('stroke-opacity', (o) => Math.min(0.35 + o.w * 0.09, 0.9));
          edgeLabels.attr('opacity', 1);
          node.attr('opacity', 1);
          labels.attr('opacity', 1);
          tooltip.hidden = true;
        })
        .on('click', (ev, l) => {
          ev.stopPropagation();
          showPair(eidOf(l.source.id), eidOf(l.target.id));
        });
    }

    zoomBehavior = d3.zoom().scaleExtent([0.25, 6])
      .on('zoom', (ev) => {
        zoomLayer.attr('transform', ev.transform);
        // Edge labels are 9px: at whole-sky zoom they are unreadable specks that
        // only add noise, so they fade in once you are close enough to read them.
        if (web) gEdgeLabels.attr('opacity', ev.transform.k < 1.1 ? 0 : Math.min((ev.transform.k - 1.1) * 3, 1));
      });
    if (web) gEdgeLabels.attr('opacity', 0);   // fit() lands below the threshold
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
    // Through cameraTo so a fit started in a background tab lands instead of
    // freezing part-way — same reason the other camera moves go through it.
    cameraTo(t, { duration: 450 });
  }

  function spotlight(id) {
    if (!nodeSel) return;
    const d = nodeSel.data().find((n) => n.id === id);
    if (!d) return;
    // In the Chronicle, gatherAround owns the camera — it frames the node AND
    // what it connects to, so snapping to the node alone would undo that.
    if (state.layout !== 'chronicle') {
      const { width, height } = svg.node().getBoundingClientRect();
      const t = d3.zoomIdentity.translate(width / 2 - 1.6 * d.x, height / 2 - 1.6 * d.y).scale(1.6);
      svg.transition().duration(reduceMotion ? 0 : 500).call(zoomBehavior.transform, t);
    }
    const g = nodeSel.filter((n) => n.id === id);
    const ring = g.append('circle').attr('r', nodeRadius(d) + 4)
      .attr('fill', 'none').attr('stroke', css('--accent')).attr('stroke-width', 2);
    ring.transition().duration(reduceMotion ? 0 : 900)
      .attr('r', nodeRadius(d) + 26).attr('stroke-opacity', 0).remove();
  }

  /** The zoom-in itself: open on the whole sky, then fly into the newest star.
   *  The wide first frame is the point — you have to SEE the sky you're diving
   *  into for the dive to mean anything. */
  /** Move the camera to `to`, optionally departing from `from`.
   *  A hidden tab gets no animation frames at all, so a flight started (or
   *  interrupted) there would freeze part-way and still be frozen when you look.
   *  Brain is routinely opened in a background tab: those paths land on the
   *  destination instead of somewhere en route. Named 'fly' so an incidental
   *  fit() — which owns the unnamed transition — can't cancel it mid-air. */
  function cameraTo(to, { from = null, delay = 0, duration = 1200 } = {}) {
    if (!zoomBehavior) return;
    if (reduceMotion || document.hidden) { svg.call(zoomBehavior.transform, to); return; }
    if (from) svg.call(zoomBehavior.transform, from);
    let flying = true;
    const bail = () => {
      if (!flying || !document.hidden) return;
      svg.interrupt('fly');
      svg.call(zoomBehavior.transform, to);
    };
    document.addEventListener('visibilitychange', bail);
    svg.transition('fly').delay(delay).duration(duration).ease(d3.easeCubicInOut)
      .call(zoomBehavior.transform, to)
      .on('end interrupt', () => {
        flying = false;
        document.removeEventListener('visibilitychange', bail);
      });
  }

  function flyToCore(id, { from = 0.3, to = 1.3 } = {}) {
    if (!nodeSel || !zoomBehavior) return;
    const d = nodeSel.data().find((n) => n.id === id) || nodeSel.data().find((n) => n.center);
    if (!d) return;
    const { width, height } = svg.node().getBoundingClientRect();
    const at = (k) => d3.zoomIdentity.translate(width / 2 - k * d.x, height / 2 - k * d.y).scale(k);
    cameraTo(at(to), { from: at(from), delay: 420, duration: 1500 });
  }

  /** Selecting a day in the Chronicle gathers what it touches.
   *  A day's memories can sit a thousand px away, so "select" used to mean
   *  "read it in the pane and take my word for what it connects to". This pulls
   *  the neighbours in beside the date, then frames them — the connections
   *  become something you look at rather than something you're told about. */
  function gatherAround(id) {
    if (state.layout !== 'chronicle' || !sim || !nodeSel) return;
    const center = nodeSel.data().find((n) => n.id === id);
    if (!center) return;
    const near = adjacency.get(id) || new Set();
    if (!near.size) { frameAround(id); return; }
    state.chronGathered = id;
    // Place them, then let physics tidy up — don't wait for physics to carry
    // them. A neighbour can start 4,000px away, and a positional force only
    // pulls while alpha lasts, so on a slow frame budget some never arrive and
    // "show me what this day connects to" quietly shows you half of it.
    let i = 0;
    for (const n of nodeSel.data()) {
      if (n.spine || !near.has(n.id)) continue;
      const a = i * 2.399963;                     // golden angle — no clumping
      const r = 34 + Math.sqrt(++i) * 24;
      n.x = center.x + GATHER_DX + Math.cos(a) * r;
      n.y = center.y + Math.sin(a) * r * 0.8;     // wider than tall, like the canvas
      n.vx = n.vy = 0;
    }
    // Fan them out beside the spine rather than onto it, so the date and its
    // label stay legible with the cluster next to them.
    sim.force('gatherX', d3.forceX(center.x + GATHER_DX).strength((d) => (near.has(d.id) && !d.spine ? 0.35 : 0)));
    sim.force('gatherY', d3.forceY(center.y).strength((d) => (near.has(d.id) && !d.spine ? 0.3 : 0)));
    sim.alpha(0.4).restart();
    frameAround(id);
  }
  const GATHER_DX = 230;   // where a gathered cluster lands, right of the spine

  /** Frame the region the cluster is being pulled INTO, not where it is now.
   *  Fitting the neighbours' current bounding box looks right and isn't: one
   *  entity that recurs across the whole timeline drags the box out to every
   *  date at once, and the camera pulls back to the same 8% it started at. The
   *  destination is known, so aim there and let them fly into frame. */
  function frameAround(id) {
    if (!nodeSel || !zoomBehavior) return;
    const center = nodeSel.data().find((n) => n.id === id);
    if (!center) return;
    const { width, height } = svg.node().getBoundingClientRect();
    // Left edge leaves room for the spine's labels, which hang off that side.
    const x0 = center.x - 190, x1 = center.x + GATHER_DX + 300;
    const y0 = center.y - 210, y1 = center.y + 210;
    const k = Math.max(0.5, Math.min(width / (x1 - x0), height / (y1 - y0), 2.2));
    cameraTo(d3.zoomIdentity
      .translate(width / 2 - k * ((x0 + x1) / 2), height / 2 - k * ((y0 + y1) / 2))
      .scale(k), { duration: 700 });
  }

  /** Chronicle opens at the top of the spine, not fitted to all of it.
   *  Fitting 170 days meant loading at 8% zoom — a legible wall of nothing.
   *  Land on the newest day at reading distance, with its memories in frame. */
  function flyToChronicleHead({ days = 16, animate = true } = {}) {
    if (!nodeSel || !zoomBehavior) return;
    const spine = nodeSel.data().filter((n) => n.spine).sort((a, b) => a.y - b.y);
    if (!spine.length) { fit(); return; }
    const { width, height } = svg.node().getBoundingClientRect();
    const gap = spine.length > 1 ? Math.abs(spine[1].y - spine[0].y) : 40;
    const k = Math.max(0.85, Math.min(height / (days * gap), 2.2));
    // Newest day, by date — the spine flips with the order button, so reading
    // "the top one" would fly to the oldest half the time.
    const head = spine.reduce((a, b) => ((dateOf(a.path) || '') >= (dateOf(b.path) || '') ? a : b));
    // Sit it near the leading edge so the days that follow are on screen too.
    const newestFirst = state.chronOrder === 'desc';
    // Dates are labelled to the LEFT of the spine, so the spine needs a margin
    // wide enough for "2026-08-01" at this zoom or the year gets clipped.
    const leftPad = Math.max(width * 0.27, 150);
    const to = d3.zoomIdentity
      .translate(leftPad - k * head.x, height * (newestFirst ? 0.17 : 0.83) - k * head.y)
      .scale(k);
    // No flight here. The zoom-in flourish belongs to Latest, which is *about*
    // arriving somewhere; Chronicle is a place you open, and animating it only
    // exposed the camera to being stranded mid-transition.
    if (!animate) { svg.call(zoomBehavior.transform, to); return; }
    cameraTo(to, { duration: 600 });
  }

  function latestCrumb() {
    const s = state.latestMeta;
    if (!s) return `<b>Latest</b> — the newest memory Vodou saved`;
    const when = fmtDate(s.created_at);
    const topic = s.topic
      ? (s.topic.type === 'entity' ? esc(s.topic.label) : esc(baseName(s.topic.label)))
      : null;
    const pinned = state.latestSeed && state.latestSeed !== state.latestNewestId;
    return `<b>${pinned ? 'Focus' : 'Latest'}</b> — ${pinned ? 'this memory' : `saved ${when}`}`
      + (topic ? `, filed under <b>${topic}</b>` : '')
      + (s.burst ? ` with ${s.burst} more from the same save` : '')
      + (s.starsBorrowed ? ` <span class="cap-note">(names borrowed from what it's related to — this memory names nobody)</span>` : '');
  }

  function crumbText() {
    if (state.layout === 'latest') return latestCrumb();
    if (state.layout === 'chronicle') {
      return `<b>Chronicle</b> — your memory day by day, ${state.chronOrder === 'desc' ? 'newest' : 'oldest'} at the top`;
    }
    if (state.layout === 'web') {
      const trail = state.webTrail.map((t, i) =>
        `<button class="trail-step" data-trail="${i}">${esc(t.label)}</button>`).join('<span class="trail-sep">›</span>');
      return state.webTrail.length
        ? `<b>Web</b> <span class="trail-sep">›</span> ${trail}`
        : `<b>Web of names</b> — who and what turn up in the same memories. Click a line to read why.`;
    }
    return `<b>Constellation</b> — every file, person &amp; source in one sky`;
  }
  /** Reload whichever sky is showing — filters apply to all of them. */
  const reloadSky = () => (state.layout === 'web' ? loadWebGraph()
    : state.layout === 'latest' ? loadLatestGraph()
    : loadOverviewGraph());
  const eidOf = (id) => parseInt(String(id).replace('entity:', ''), 10);
  /** undefined = let the server decide (everything but junk); otherwise an explicit list. */
  const kindsParam = () => (state.webKinds ? [...state.webKinds].join(',') || 'none' : undefined);

  /** Kind chips — the filter that turns "a web of names" into "a web of people".
   *  Counts come from the loaded graph, so a chip reads 0 when that kind is
   *  filtered out; the label is what it WOULD show, which is the useful number. */
  function renderKindChips(nodes) {
    const box = $('kindChips');
    if (!box) return;
    const counts = {};
    for (const n of nodes || []) if (n.type === 'entity') counts[n.kind] = (counts[n.kind] || 0) + 1;
    const known = ['person', 'org', 'product', 'project', 'place', 'event', 'handle', 'name', 'not_an_entity'];
    const shown = state.webKinds;
    box.innerHTML = known.map((k) => {
      const on = shown ? shown.has(k) : k !== 'not_an_entity';
      const n = counts[k] || 0;
      // Every kind always renders. Hiding zero-count chips sounds tidy and is a
      // trap: the moment you switch a kind OFF its count goes to 0, the chip
      // disappears, and you cannot switch it back on. A filter you can only turn
      // one way is a broken filter.
      return `<button class="chip ${on ? 'active' : ''}" data-kind="${k}" title="${esc(KIND_LABEL[k] || k)}">
        <span class="dot" style="background:${kindColor(k)}"></span>${esc(KIND_LABEL[k] || k)}${n ? ` <small>${n}</small>` : ''}
      </button>`;
    }).join('');
    box.querySelectorAll('[data-kind]').forEach((el) => el.addEventListener('click', () => {
      const k = el.dataset.kind;
      // First click materializes the implicit default so toggling is honest.
      if (!state.webKinds) state.webKinds = new Set(known.filter((x) => x !== 'not_an_entity'));
      if (state.webKinds.has(k)) state.webKinds.delete(k); else state.webKinds.add(k);
      reloadWeb();
    }));
  }
  // What a link's weight counts, in words — it changes with closeness.
  const unit = (n) => (state.webBy === 'chunk'
    ? `${n} memor${n === 1 ? 'y' : 'ies'} name them both`
    : `${n} file${n === 1 ? '' : 's'} name them both`);

  async function loadOverviewGraph() {
    state.mode = 'overview'; state.center = null;
    $('overviewBtn').hidden = true;
    $('crumb').innerHTML = crumbText();
    renderGraph(await api('graph', graphParams()));
    setTimeout(settleCamera, reduceMotion ? 30 : 700);
  }

  /** Constellation fits the whole sky; Chronicle opens on the newest day. */
  const settleCamera = () => (state.layout === 'chronicle'
    ? flyToChronicleHead({ animate: false })
    : fit());

  // ── Latest ───────────────────────────────────────────────────────────────
  /** One memory at the centre of everything it touches, with the ordinary sky
   *  still behind it. Similarity is always on here: "related" has to mean
   *  related by meaning, not just by who happened to be named. */
  async function loadLatestGraph({ gentle = false } = {}) {
    state.mode = 'overview'; state.center = null;
    $('overviewBtn').hidden = true;
    if (!gentle) $('crumb').innerHTML = `<b>Latest</b> — finding the newest memory…`;
    const data = await api('latest', { ...graphParams(), sim: 1, seed: state.latestSeed || undefined });
    if (!data.seed) {
      $('crumb').innerHTML = `<b>Latest</b> — nothing matches these filters`;
      renderGraph({ nodes: [], links: [] });
      return;
    }
    if (!state.latestSeed) state.latestNewestId = data.center;
    state.latestSeed = data.center;
    state.latestMeta = data.seed;
    $('crumb').innerHTML = latestCrumb();
    $('latestNewestBtn').hidden = state.latestSeed === state.latestNewestId;
    renderGraph(data);
    // A live swap is already a dissolve — re-flying from the whole sky on top of
    // that reads as a page reload every time you save a note.
    flyToCore(data.center, gentle ? { from: 1.12, to: 1.3 } : {});
    select({ id: data.center, type: 'chunk' });
  }

  /** Re-centre Latest on another memory — the same rings, a different star. */
  function recentreLatest(id) {
    state.latestSeed = id;
    loadLatestGraph();
  }

  // ── Live: the sky keeps up with memory as it lands ───────────────────────
  // The whole cost of "live" is one row every 20s — `latest-id` is a single
  // LIMIT 1 with no joins. The expensive part is the re-render, so that only
  // happens when the newest memory actually CHANGED, and only once per save:
  // extraction writes 8-10 memories in a burst, and a debounce collapses them.
  const LATEST_POLL_MS = 20000;
  const BURST_SETTLE_MS = 4000;
  let pollTimer = null, swapTimer = null, swapTried = null;

  function stopLatestPoll() {
    clearInterval(pollTimer); pollTimer = null;
    clearTimeout(swapTimer); swapTimer = null;
  }
  function startLatestPoll() {
    stopLatestPoll();
    if (!state.latestLive) return;
    pollTimer = setInterval(pollLatest, LATEST_POLL_MS);
  }

  async function pollLatest() {
    if (state.layout !== 'latest' || !state.latestLive) return;
    if (document.hidden) return;                     // no work for a tab nobody sees
    if (state.latestSeed !== state.latestNewestId) return;  // you walked somewhere; don't yank it
    try {
      const { id } = await api('latest-id', graphParams());
      if (!id || id === state.latestNewestId) return;
      // One attempt per id, ever. If `latest-id` and `latest` ever disagree —
      // a memory archived between the two calls, say — adopting never "takes"
      // and an unguarded poll would re-render the whole sky every 20s forever.
      if (id === swapTried) return;
      swapTried = id;
      clearTimeout(swapTimer);
      swapTimer = setTimeout(swapToLatest, BURST_SETTLE_MS);
    } catch { /* server blipped — the next tick tries again */ }
  }

  /** Dissolve the old sky, load the new one, dissolve back in. */
  async function swapToLatest() {
    if (state.layout !== 'latest' || document.hidden) return;
    const el = svg.node();
    el.classList.add('sky-fading');
    if (!reduceMotion) await new Promise((r) => setTimeout(r, 420));
    state.latestSeed = null;
    try {
      await loadLatestGraph({ gentle: true });
    } finally {
      el.classList.remove('sky-fading');
    }
  }

  // Coming back to the tab should show current state, not whatever was true
  // when you left it — and polling should not resume until you're looking.
  on(document, 'visibilitychange', () => {
    if (state.layout !== 'latest') return;
    if (document.hidden) stopLatestPoll();
    else { startLatestPoll(); pollLatest(); }
  });

  // The ages are LIVE: "4m ago" that still says "4m ago" an hour later is
  // worse than an absolute stamp. One cheap sweep; no-op when the Latest
  // layout (the only one that draws time labels) isn't on screen.
  const ageTicker = setInterval(() => {
    if (document.hidden) return;
    gLabels.selectAll('text.time-label').text((d) => timeAgo(d.created_at));
  }, 30000);

  // ── Web of names ─────────────────────────────────────────────────────────
  /** The whole sky of names, nobody at the centre. */
  async function loadWebGraph() {
    state.mode = 'overview'; state.center = null; state.webCenter = null; state.webTrail = [];
    $('overviewBtn').hidden = true;
    $('crumb').innerHTML = crumbText();
    const data = await api('entity-net', { ...graphParams(), min: state.webMin, by: state.webBy, kinds: kindsParam() });
    renderGraph(data);
    renderKindChips(data.nodes);
    setTimeout(fit, 40);   // the web pre-settles synchronously — fit what's already there
    // No silent caps: hitting the edge LIMIT means there are more, weaker links.
    if (data.edgesCapped) {
      $('crumb').innerHTML += ` · <span class="cap-note">showing the strongest ${data.edgeCap} links —`
        + ` raise “only links of” for fewer, stronger ties</span>`;
    } else if (data.truncated) {
      $('crumb').innerHTML += ` · <span class="cap-note">showing the ${data.nodes.length} best-connected names</span>`;
    }
    if (!data.nodes.length) {
      $('emptyState').hidden = false;
      $('emptyState').innerHTML = '<p>No two names share a memory under these filters.</p>'
        + '<p class="empty-sub">Lower “only links of” or widen the time window.</p>';
    }
  }

  /** Centre the web on one name: its neighbours, and how they connect to each other. */
  async function centerWeb(eid, label, { push = true } = {}) {
    if (!Number.isFinite(eid)) return;
    state.mode = 'local'; state.center = `entity:${eid}`; state.webCenter = eid;
    $('overviewBtn').hidden = false;
    const ego = await api('entity-ego', {
      ...graphParams(), id: eid, depth: state.webDepth, min: state.webMin, by: state.webBy,
      kinds: kindsParam(),
    });
    if (push) {
      const name = label || ego.entity?.canonical || `#${eid}`;
      const at = state.webTrail.findIndex((t) => t.id === eid);
      if (at >= 0) state.webTrail = state.webTrail.slice(0, at + 1);
      else state.webTrail = [...state.webTrail, { id: eid, label: name }];
    }
    $('crumb').innerHTML = crumbText();
    wireTrail();
    renderGraph(ego);
    setTimeout(fit, 40);
    renderConnections(ego);
  }

  function wireTrail() {
    $('crumb').querySelectorAll('[data-trail]').forEach((el) =>
      el.addEventListener('click', () => {
        const step = state.webTrail[Number(el.dataset.trail)];
        if (step) centerWeb(step.id, step.label);
      }));
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
    gatherAround(d.id);   // no-op outside the Chronicle
    $('readingEmpty').hidden = true;
    const pane = $('reading');
    pane.hidden = false;
    try {
      if (d.type === 'entity' || d.id.startsWith('entity:')) {
        // In the web, a name's *connections* are the story — the memory list is
        // one click further in. Everywhere else the memory list is the story.
        if (state.layout === 'web') {
          renderConnections(await api('entity-ego', {
            ...graphParams(), id: eidOf(d.id), depth: state.webDepth, min: state.webMin, by: state.webBy,
            kinds: kindsParam(),
          }));
          return;
        }
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
      <span class="prov-chip">${esc(scopeLabel(o.scope || ''))}</span>
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
      ${opts.onOpenFile ? `<button class="focus-btn" data-open-file="${esc(c.path)}" data-line="${c.start_line || ''}">✎ Edit in Facts</button>` : ''}
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
        ${c.siblings.map((s) => rowBtn(s.chunk_id, (s.preview || '').slice(0, 70), `${s.is_canonical ? 'canonical' : s.superseded_by ? 'superseded' : 'copy'} · ${esc(scopeLabel(s.scope))}`, css('--warn-text'))).join('')}</div>` : ''}
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
      ${opts.onOpenFile ? `<button class="focus-btn" data-open-file="${esc(f.path)}">✎ Edit in Facts</button>` : ''}
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

  /** Who this name appears with, strongest tie first — each row opens the proof. */
  function renderConnections(ego) {
    const e = ego.entity || {};
    const conns = ego.connections || [];
    const max = Math.max(1, ...conns.map((c) => c.w));
    state.selected = `entity:${e.id}`;
    $('readingEmpty').hidden = true;
    const pane = $('reading');
    pane.hidden = false;
    pane.innerHTML = `
      <div class="read-head">
        <div class="read-kind">✦ ${esc(e.kind || 'name')} · ${conns.length} connection${conns.length === 1 ? '' : 's'}</div>
        <div class="read-title">${esc(e.canonical || '')}</div>
        ${(e.aliases || []).length ? `<div class="rail-hint">also known as ${e.aliases.map(esc).join(', ')}</div>` : ''}
      </div>
      <button class="focus-btn" data-entity-read="${e.id}">☰ Read every memory that mentions ${esc(e.canonical || 'them')}</button>
      ${conns.length ? `<div class="read-sec"><h3>Turns up with</h3>
        <p class="rail-hint">Ranked by how often they turn up together (${state.webBy === 'chunk' ? 'in the very same memory' : 'in the same memory file'}). Click for the memories; ⤳ walks the web there.</p>
        ${conns.map((c) => `
          <div class="conn-row">
            <button class="conn-main" data-pair="${c.id}" title="${unit(c.w)} — read them">
              <span class="conn-name">${esc(c.canonical)}</span>
              <span class="conn-kind">${c.predicate
                ? `<b class="pred">${esc(c.centre_is_subject ? predLabel(c.predicate) : `${predLabel(c.predicate)} ←`)}</b>`
                : esc(c.kind)}</span>
              <span class="conn-bar"><i style="width:${Math.max(6, (c.w / max) * 100)}%"></i></span>
              <span class="conn-w">${c.w}</span>
            </button>
            <button class="conn-walk" data-walk="${c.id}" data-label="${esc(c.canonical)}" title="Centre the web on ${esc(c.canonical)}">⤳</button>
          </div>`).join('')}
      </div>` : `<p class="rail-hint">No other name shares a memory with this one under the current filters.</p>`}`;
    wireConnections(e.id, e.canonical);
  }

  function wireConnections(centerId, centerName) {
    const pane = $('reading');
    pane.querySelectorAll('[data-pair]').forEach((el) =>
      el.addEventListener('click', () => showPair(centerId, Number(el.dataset.pair))));
    pane.querySelectorAll('[data-walk]').forEach((el) =>
      el.addEventListener('click', () => centerWeb(Number(el.dataset.walk), el.dataset.label)));
    pane.querySelectorAll('[data-entity-read]').forEach((el) =>
      el.addEventListener('click', async () =>
        renderEntity(await api('entity', { id: el.dataset.entityRead }))));
    pane.querySelectorAll('[data-back-ego]').forEach((el) =>
      el.addEventListener('click', () => centerWeb(Number(el.dataset.backEgo), centerName, { push: false })));
  }

  /** The evidence behind one line: the memories that name both ends of it. */
  async function showPair(a, b) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return;
    const pane = $('reading');
    $('readingEmpty').hidden = true;
    pane.hidden = false;
    pane.innerHTML = '<p class="rail-hint">Reading the memories behind this link…</p>';
    const p = await api('entity-pair', { ...graphParams(), a, b, by: state.webBy });
    const shown = p.memories.length;
    pane.innerHTML = `
      <div class="read-head">
        <div class="read-kind">✦ shared memories</div>
        <div class="read-title">${esc(p.a?.canonical || a)} <span class="pair-amp">&amp;</span> ${esc(p.b?.canonical || b)}</div>
        <div class="rail-hint">${p.by === 'chunk'
          ? `${p.total} memor${p.total === 1 ? 'y' : 'ies'} name them both`
          : `${p.files} file${p.files === 1 ? '' : 's'} hold both names · ${p.total} memor${p.total === 1 ? 'y' : 'ies'} in them, the ones naming both first`
        }${shown < p.total ? ` — newest ${shown} shown` : ''}.</div>
      </div>
      ${state.webCenter ? `<button class="focus-btn" data-back-ego="${state.webCenter}">← Back to this name's connections</button>` : ''}
      <div class="read-sec">
        ${p.memories.map((m) => rowBtn(
          m.id,
          `${m.both ? '◆ ' : ''}${(m.preview || '').replace(/^#+\s*/gm, '').trim().slice(0, 84)}`,
          `${m.both ? 'names both · ' : ''}${baseName(m.path)} · ${m.chunk_tag || 'UNTAGGED'} · ${esc(CLS_LABEL[m.cls] || m.cls)} · ${fmtDate(m.created_at)}`,
          tagColor(m.chunk_tag || 'UNTAGGED'))).join('')}
      </div>`;
    wireReadingPane();
    wireConnections(a, p.a?.canonical);
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
    $('reading').querySelectorAll('[data-open-file]').forEach((el) =>
      el.addEventListener('click', () => opts.onOpenFile && opts.onOpenFile(el.dataset.openFile, el.dataset.line ? Number(el.dataset.line) : null)));
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
            `<div class="vault-scope"><span>${esc(scopeLabel(r.scope))}</span><span>${r.n}</span></div>`).join('')}
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
        reloadSky();
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
        reloadSky();
      }));
  }

  $('whenRow').querySelectorAll('.when-btn').forEach((el) =>
    el.addEventListener('click', () => {
      state.sinceDays = parseInt(el.dataset.days, 10);
      $('whenRow').querySelectorAll('.when-btn').forEach((b) => b.classList.toggle('active', b === el));
      reloadSky();
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
  // Prefer Console Appearance file (/api/appearance); fall back to local.
  (function bootTheme() {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  })();
  $('themeBtn').addEventListener('click', () => {
    // Session-local flip only — Console Appearance remains source of truth on reload.
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
    if (state.mode === 'overview') reloadSky();
    else if (state.layout === 'web') centerWeb(state.webCenter, null, { push: false });
    else focusOn(state.center);
    loadTimeline();
  });
  $('fitBtn').addEventListener('click', fit);
  $('overviewBtn').addEventListener('click', () => reloadSky());

  // Layout tabs — state, URL (?layout=), and rendering stay in sync.
  function setLayout(layout, { rerender = true } = {}) {
    const was = state.layout;
    state.layout = layout;
    root.dataset.layout = layout;   // CSS hangs the spotlight off this
    for (const [id, l] of [['segLatest', 'latest'], ['segConstellation', 'constellation'], ['segWeb', 'web'], ['segChronicle', 'chronicle']]) {
      $(id).classList.toggle('active', layout === l);
      $(id).setAttribute('aria-selected', layout === l);
    }
    if (opts.onLayout) opts.onLayout(layout);   // the host owns the URL (hash router / ?layout=)
    $('orderBtn').hidden = layout !== 'chronicle';
    $('webCtl').hidden = layout !== 'web';
    $('latestCtl').hidden = layout !== 'latest';
    if (layout === 'latest') startLatestPoll(); else stopLatestPoll();
    $('kindSec').hidden = layout !== 'web';
    if (state.mode === 'overview') $('crumb').innerHTML = crumbText();
    if (!rerender) return;
    // Web and Latest are different datasets, not different arrangements of the
    // same one — switching into or out of either has to refetch.
    if (layout === 'web') { loadWebGraph(); return; }
    if (layout === 'latest') { loadLatestGraph(); return; }
    if (was === 'web' || was === 'latest') { loadOverviewGraph(); return; }
    if (state.lastData) {
      renderGraph(state.lastData);
      setTimeout(settleCamera, reduceMotion ? 30 : 700);
    }
  }
  $('segLatest').addEventListener('click', () => {
    state.latestSeed = null;   // the tab always means "the newest", not wherever you walked to
    setLayout('latest');
  });
  $('latestNewestBtn').addEventListener('click', () => { state.latestSeed = null; loadLatestGraph(); });
  $('latestLiveBtn').addEventListener('click', () => {
    state.latestLive = !state.latestLive;
    $('latestLiveBtn').classList.toggle('on', state.latestLive);
    $('latestLiveBtn').textContent = state.latestLive ? '● Live' : '○ Paused';
    if (state.latestLive) { startLatestPoll(); pollLatest(); } else stopLatestPoll();
  });
  $('segConstellation').addEventListener('click', () => setLayout('constellation'));
  $('segWeb').addEventListener('click', () => setLayout('web'));
  $('segChronicle').addEventListener('click', () => setLayout('chronicle'));
  const reloadWeb = () => (state.webCenter
    ? centerWeb(state.webCenter, null, { push: false })
    : loadWebGraph());
  $('webMinSel').addEventListener('change', (ev) => {
    state.webMin = parseInt(ev.target.value, 10) || 1;
    reloadWeb();
  });
  $('webBySel').addEventListener('change', (ev) => {
    state.webBy = ev.target.value === 'chunk' ? 'chunk' : 'file';
    reloadWeb();
  });
  $('webDepthBtn').addEventListener('click', () => {
    state.webDepth = state.webDepth === 1 ? 2 : 1;
    $('webDepthBtn').textContent = state.webDepth === 1 ? '◎ One hop' : '◉ Two hops';
    $('webDepthBtn').classList.toggle('on', state.webDepth === 2);
    if (state.webCenter) centerWeb(state.webCenter, null, { push: false });
  });
  $('orderBtn').addEventListener('click', () => {
    state.chronOrder = state.chronOrder === 'desc' ? 'asc' : 'desc';
    $('orderBtn').textContent = state.chronOrder === 'desc' ? '↓ Newest first' : '↑ Oldest first';
    if (state.mode === 'overview') $('crumb').innerHTML = crumbText();
    if (state.lastData) {
      renderGraph(state.lastData);
      setTimeout(settleCamera, reduceMotion ? 30 : 700);
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

  // Embedded, ⌘K belongs to the Console's command palette (P2.5) and keys are
  // scoped to the graph; standalone keeps the document-wide bindings.
  on(embedded ? root : document, 'keydown', (ev) => {
    if (!embedded && (ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); switcher.hidden ? openSwitcher() : closeSwitcher(); }
    else if (ev.key === 'Escape') {
      if (!switcher.hidden) closeSwitcher();
      else if (!$('conflictsPanel').hidden) $('conflictsPanel').hidden = true;
      else if (state.mode === 'local') reloadSky();
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
            <div class="side-label">${esc(sideLabel(x.import_scope, 'imported'))} says</div>
            <div class="side-value">${esc(x.import_value)}</div>
            <div class="side-text">${esc((x.import_text || '').slice(0, 220))}</div>
          </button>
          <button class="conflict-side ${x.status === 'kept_native' ? 'winner' : ''}" data-open="${esc(x.native_chunk_id)}">
            <div class="side-label">${esc(sideLabel(x.native_scope, 'you'))} said</div>
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
          const out = await resolveConflict(el.dataset.resolve, el.dataset.keep);
          if (card) { card.classList.remove('open'); card.style.opacity = '0.5'; }
          // `already` — resolution CASCADES across same-value siblings, so
          // this card was resolved by an earlier click's cascade. Success,
          // not an error (it used to render as a blank "gateway HTTP 500").
          msg.textContent = out && out.already ? '✓ already resolved'
            : el.dataset.keep === 'dismiss' ? '✓ dismissed' : '✓ resolved';
          // Sweep cascade-resolved siblings off the board: any remaining card
          // for the same value-pair is now a stale button waiting to confuse.
          setTimeout(() => card && card.remove(), 1200);
          setTimeout(() => { try { $('conflictsBtn').click(); } catch (_) {} }, 1400);
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
    const tl = d3.select($('timeline'));
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
          const wrap = root.querySelector('.canvas-wrap').getBoundingClientRect();
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
  const GW = ((opts.gatewayBase ?? apiBase) || '').replace(/\/$/, '');   // '' = same origin (Console)
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
    // COHERENCE Rule 7 — a vault's rule is shown to a human, so the scopes in it
    // are named the way a person would name them. The rule STORES the raw scope
    // (the editor's chips carry it in data-v, and the resolver matches on it);
    // only this summary line is translated.
    if (r.scopes?.length) bits.push([...new Set(r.scopes.map(scopeLabel))].join(', '));
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
        root.appendChild(a);
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
        <span>${esc(scopeLabel(s))}</span>
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
    const wanted = opts.layout || 'latest';
    if (wanted === 'chronicle' || wanted === 'web' || wanted === 'latest') setLayout(wanted, { rerender: false });
    try {
      const [o, sc, projs, hosts] = await Promise.all([api('overview'), api('scopes'), api('projects'), api('hosts').catch(() => [])]);
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
        sel.addEventListener('change', () => { state.project = sel.value; reloadSky(); });
      }
      // P4 — the page axis: which site a memory came from (source_host).
      if (Array.isArray(hosts) && hosts.length) {
        const hs = $('hostSel');
        if (hs) {
          hs.hidden = false;
          hs.innerHTML = `<option value="">All sites</option>`
            + `<option value="none">No site (not from a page)</option>`
            + hosts.map((h) => `<option value="${esc(h.host)}">${esc(h.host)} (${h.n})</option>`).join('');
          hs.addEventListener('change', () => { state.host = hs.value; reloadSky(); });
        }
      }
      $('archivedChk').addEventListener('change', (ev) => {
        state.includeArchived = ev.target.checked;
        reloadSky();
        loadTimeline();
      });
      $('similarChk').addEventListener('change', async (ev) => {
        state.similar = ev.target.checked;
        // Reload whichever view is active so the similarity overlay applies live.
        if (state.mode === 'local' && state.center) await focusOn(state.center);
        else await reloadSky();
        // Confirm the overlay took effect with a live count in the breadcrumb.
        if (state.similar) {
          const n = (state.lastData?.links || []).filter((l) => l.type === 'similar').length;
          const el = $('crumb');
          if (el) el.innerHTML += ` · <span style="color:#2ec4b6">✦ ${n} similarity edge${n === 1 ? '' : 's'}</span>`;
        }
      });
      await reloadSky();
      await loadTimeline();
      if (opts.node) await focusOn(String(opts.node));
    } catch (err) {
      $('crumb').innerHTML = `<b>Brain couldn't reach memory.db</b> — ${esc(err.message)}`;
    }
  })();

  // ── Handle ───────────────────────────────────────────────────────────────
  function destroy() {
    stopLatestPoll();
    clearInterval(ageTicker);
    if (sim) { sim.stop(); sim = null; }
    for (const d of disposers.splice(0)) { try { d(); } catch (_) { /* already gone */ } }
    root.innerHTML = '';
    root.classList.remove('brain-root', 'embedded');
    delete root.dataset.layout;
  }
  return {
    destroy,
    setLayout: (layout) => setLayout(layout),
    focus: (id) => focusOn(String(id)),
    /** The contradiction review queue (same panel as the header button). */
    openConflicts: () => $('conflictsBtn').click(),
    /** Light up the memories a RANKED search returned. `ids` are chunk ids from
     *  /api/memory/search-chunks — the graph highlights, it never ranks
     *  (migration 077). Client-side: no query, no refetch, no round trip.
     *
     *  It used to pass `q` to the server as a graph filter. That was wrong twice:
     *  `queries.ts` matches `q` against the file PATH, so a content query hit
     *  nothing and silently blanked every file node (`q=lucy` and
     *  `q=zzzznotaword` returned byte-identical skies), and asking the graph to
     *  find things duplicates the ranker it is supposed to defer to. */
    setFilter: (_q, ids) => {
      const list = Array.isArray(ids) ? ids.filter(Boolean) : null;
      state.matchIds = list && list.length ? new Set(list) : null;
      state.matchPaths = state.matchIds ? new Set([...state.matchIds].map(chunkPath)) : null;
      if (state.lastData) renderGraph(state.lastData);
    },
    getState: () => ({ layout: state.layout, mode: state.mode, center: state.center, selected: state.selected }),
  };
  }
  globalThis.VodouBrain = { mount };
})();
