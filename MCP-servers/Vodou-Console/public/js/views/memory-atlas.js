/**
 * Memory Atlas — D3 radial / vertical tree over memory_chunks.
 * PLAN: PLANS/0.5.46/MEMORY-ATLAS-D3-MINDMAP.md
 *
 * window.MemoryAtlas.init(container, { API }) → destroy()
 */
(function (global) {
  'use strict';

  const D3_URL = 'https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js';
  const LS_VELOCITY = 'atlas_velocity';
  const LS_HIDE_DONE = 'atlas_hide_done';
  const LS_MAX_PER_TAG = 'atlas_max_per_tag';
  const LS_DATA_MODE = 'atlas_data_mode';
  const GRAPH_LINE_MAX = 44;
  const FILE_LABEL_MAX = 40;
  const TAG_HUES = {
    DECISION: 258,
    ISSUE: 350,
    DEAD_END: 340,
    PREF: 200,
    DONE: 160,
    PLANNED: 210,
    GOTCHA: 28,
    METRIC: 190,
    PATTERN: 270,
    DEPENDENCY: 220,
    EXAMPLE: 45,
    RESEARCH: 230,
    UNTAGGED: 200,
  };

  function ensureD3() {
    if (global.d3) return Promise.resolve(global.d3);
    return global.lazyScript(D3_URL).then(() => global.d3);
  }

  function reducedMotion() {
    return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function effectiveVelocity(saved) {
    if (reducedMotion()) return 'calm';
    if (saved === 'pulse' || saved === 'calm') return saved;
    return 'flash';
  }

  function chunkLabel(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > 72 ? t.slice(0, 70) + '…' : t || '(empty)';
  }

  /** Remove stacked leading [TAG] prefixes for cleaner graph lines. */
  function stripLeadingBrackets(text) {
    let t = String(text || '').replace(/\s+/g, ' ').trim();
    for (let i = 0; i < 8 && /^\[[^\]]+\]\s*/.test(t); i++) {
      t = t.replace(/^\[[^\]]+\]\s*/, '').trim();
    }
    return t || '·';
  }

  function graphChunkLine(text, maxLen) {
    const t = stripLeadingBrackets(text);
    return t.length > maxLen ? t.slice(0, maxLen - 1) + '…' : t;
  }

  function groupChunksByTag(chunks) {
    const byTag = new Map();
    for (const c of chunks) {
      const tag = (c.chunk_tag || 'UNTAGGED').toUpperCase();
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(c);
    }
    return byTag;
  }

  /** Root → one pill per tag with count only (no chunk leaves). */
  function buildTagOverview(chunks, hideDone) {
    const byTag = groupChunksByTag(chunks);
    const tagChildren = [];
    for (const [tag, list] of byTag) {
      if (hideDone && tag === 'DONE') continue;
      tagChildren.push({
        id: 'tag:' + tag,
        type: 'tag',
        tag,
        label: tag + ' · ' + list.length,
        count: list.length,
        overview: true,
        children: [],
      });
    }
    tagChildren.sort(function (a, b) {
      return a.tag.localeCompare(b.tag);
    });
    return {
      id: 'root',
      type: 'root',
      label: 'Memory',
      children: tagChildren,
    };
  }

  /** Root → chunk leaves for one tag (pinned first, then recency). */
  function buildDrillFlat(chunks, tag, maxPerTag) {
    const byTag = groupChunksByTag(chunks);
    const full = byTag.get(String(tag).toUpperCase()) || [];
    const list = full
      .slice()
      .sort(function (a, b) {
        const pb = b.pinned ? 1 : 0;
        const pa = a.pinned ? 1 : 0;
        if (pb !== pa) return pb - pa;
        return String(b.created_at || '').localeCompare(String(a.created_at || ''));
      })
      .slice(0, maxPerTag);
    return {
      id: 'root',
      type: 'root',
      label: 'Memory',
      drillTag: tag,
      totalInTag: full.length,
      children: list.map(function (ch) {
        return {
          id: ch.chunk_id || ch.id,
          type: 'chunk',
          label: graphChunkLine(ch.text, GRAPH_LINE_MAX),
          tip: stripLeadingBrackets(ch.text).slice(0, 400),
          data: ch,
        };
      }),
    };
  }

  function normalizeChunk(row) {
    return {
      chunk_id: row.id,
      id: row.id,
      path: row.path,
      text: row.text,
      chunk_scope: row.scope,
      scope: row.scope,
      chunk_tag: row.chunk_tag || 'UNTAGGED',
      created_at: row.created_at,
      pinned: row.pinned,
      score: row.score,
      score_breakdown: row.score_breakdown,
    };
  }

  function tagStroke(tag) {
    const h = TAG_HUES[tag] ?? TAG_HUES.UNTAGGED;
    return 'hsl(' + h + ', 70%, 58%)';
  }

  function truncateTopic(s, maxLen) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > maxLen ? t.slice(0, maxLen - 1) + '…' : t || '·';
  }

  /** Which main branch (jsMind left/right) a node belongs to. */
  function armSide(d) {
    let n = d;
    while (n) {
      if (n.data && n.data.id === 'workspace') return 1;
      if (n.data && n.data.id === 'daily') return -1;
      n = n.parent;
    }
    return 0;
  }

  function fileNodeVisualKind(d) {
    const x = d.data;
    if (!x || x.id === 'root') return 'root';
    if (x.id === 'workspace' || x.id === 'daily') return 'arm';
    if (x.file_line != null) return 'heading';
    return 'file';
  }

  /** Limits so d3.tree is not forced to pack hundreds of leaves into one box. */
  function pruneFileTreeForAtlas(root) {
    const MAX_DAILY_FILES = 28;
    const MAX_WORKSPACE_FILES = 20;
    const MAX_HEADINGS_PER_FILE = 12;

    function go(n) {
      if (!n) return null;
      const o = {
        id: n.id,
        topic: n.topic,
        file_path: n.file_path,
        file_type: n.file_type,
        file_line: n.file_line,
        direction: n.direction,
      };
      let ch = (n.children || []).slice();
      if (n.id === 'daily') ch = ch.slice(0, MAX_DAILY_FILES);
      if (n.id === 'workspace') ch = ch.slice(0, MAX_WORKSPACE_FILES);
      if (n.file_path && ch.length && ch.every(function (c) { return c.file_line != null; })) {
        ch = ch.slice(0, MAX_HEADINGS_PER_FILE);
      }
      if (ch.length) o.children = ch.map(go).filter(Boolean);
      return o;
    }
    return go(root);
  }

  /**
   * @param {HTMLElement} container
   * @param {{ API: { get: Function } }} opts
   */
  function init(container, opts) {
    const API = opts && opts.API;
    if (!API) {
      console.error('[MemoryAtlas] missing API');
      return function () {};
    }

    let d3 = null;
    let destroyed = false;
    let zoomBehavior = null;
    let zoomG = null;
    let svgNode = null;
    let innerW = 800;
    let innerH = 640;
    let layoutMode = 'radial'; // 'radial' | 'tree'
    let velocity = effectiveVelocity(global.localStorage.getItem(LS_VELOCITY));
    let chunks = [];
    let hierarchyRoot = null;
    let focusId = null;
    let filterQ = '';
    let specularSeen = new Set();
    let rafId = 0;
    let breatheT = 0;
    const scopeRef = { current: '' };
    let drillTag = null;
    let hideDone = global.localStorage.getItem(LS_HIDE_DONE) !== '0';
    const maxTiers = [4, 8, 12, 20];
    let maxPerTag = parseInt(global.localStorage.getItem(LS_MAX_PER_TAG) || '8', 10) || 8;
    if (maxTiers.indexOf(maxPerTag) < 0) maxPerTag = 8;
    let dataMode = global.localStorage.getItem(LS_DATA_MODE) === 'tags' ? 'tags' : 'files';
    let fileTreeData = null;

    const wrap = document.createElement('div');
    wrap.className = 'memory-atlas memory-atlas--' + velocity;
    wrap.id = 'memory-atlas-root';

    // --- Background layers ---
    const bg = document.createElement('div');
    bg.className = 'memory-atlas-bg';
    bg.innerHTML =
      '<div class="memory-atlas-aurora" aria-hidden="true">' +
      '<span class="memory-atlas-aurora-blob memory-atlas-aurora-a"></span>' +
      '<span class="memory-atlas-aurora-blob memory-atlas-aurora-b"></span>' +
      '<span class="memory-atlas-aurora-blob memory-atlas-aurora-c"></span>' +
      '</div>' +
      '<div class="memory-atlas-grid" aria-hidden="true"></div>' +
      '<div class="memory-atlas-grain" aria-hidden="true"></div>' +
      '<div class="memory-atlas-vignette" aria-hidden="true"></div>';

    const ignite = document.createElement('div');
    ignite.className = 'memory-atlas-ignite';
    ignite.setAttribute('aria-hidden', 'true');

    const shock = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    shock.setAttribute('class', 'memory-atlas-shockwave');
    shock.setAttribute('aria-hidden', 'true');
    const shockCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    shockCircle.setAttribute('cx', '50%');
    shockCircle.setAttribute('cy', '50%');
    shockCircle.setAttribute('r', '4');
    shock.appendChild(shockCircle);

    // --- Toolbar ---
    const toolbar = document.createElement('div');
    toolbar.className = 'memory-atlas-toolbar';

    const brand = document.createElement('div');
    brand.className = 'memory-atlas-brand';
    brand.innerHTML = '<span class="memory-atlas-brand-orb" title="Atlas">🔮</span><span>Atlas</span>';
    toolbar.appendChild(brand);

    const dataSeg = document.createElement('div');
    dataSeg.className = 'memory-atlas-seg memory-atlas-seg-data';
    dataSeg.setAttribute('role', 'group');
    dataSeg.setAttribute('aria-label', 'Data source');
    const btnTopics = document.createElement('button');
    btnTopics.type = 'button';
    btnTopics.className = 'memory-atlas-seg-btn' + (dataMode === 'files' ? ' active' : '');
    btnTopics.textContent = 'Topics';
    btnTopics.title = 'Same tree as Mind Map tab — workspace files + daily logs';
    const btnTags = document.createElement('button');
    btnTags.type = 'button';
    btnTags.className = 'memory-atlas-seg-btn' + (dataMode === 'tags' ? ' active' : '');
    btnTags.textContent = 'Tags';
    btnTags.title = 'Chunk tags from memory DB';
    dataSeg.appendChild(btnTopics);
    dataSeg.appendChild(btnTags);
    toolbar.appendChild(dataSeg);

    const layoutSeg = document.createElement('div');
    layoutSeg.className = 'memory-atlas-seg';
    layoutSeg.setAttribute('role', 'group');
    layoutSeg.setAttribute('aria-label', 'Layout');
    const btnRadial = document.createElement('button');
    btnRadial.type = 'button';
    btnRadial.className = 'memory-atlas-seg-btn active';
    btnRadial.textContent = 'Radial';
    const btnTree = document.createElement('button');
    btnTree.type = 'button';
    btnTree.className = 'memory-atlas-seg-btn';
    btnTree.textContent = 'Tree';
    layoutSeg.appendChild(btnRadial);
    layoutSeg.appendChild(btnTree);
    toolbar.appendChild(layoutSeg);

    const velSeg = document.createElement('div');
    velSeg.className = 'memory-atlas-seg memory-atlas-seg-velocity';
    velSeg.setAttribute('role', 'group');
    velSeg.setAttribute('aria-label', 'Motion');
    [['flash', 'Flash'], ['pulse', 'Pulse'], ['calm', 'Calm']].forEach(([key, lab]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'memory-atlas-seg-btn' + (velocity === key ? ' active' : '');
      b.textContent = lab;
      b.dataset.vel = key;
      velSeg.appendChild(b);
    });
    toolbar.appendChild(velSeg);

    const scopeSel = document.createElement('select');
    scopeSel.className = 'memory-atlas-scope';
    scopeSel.title = 'Scope';
    scopeSel.innerHTML = '<option value="">All scopes</option>';
    toolbar.appendChild(scopeSel);

    const btnBack = document.createElement('button');
    btnBack.type = 'button';
    btnBack.className = 'btn btn-sm memory-atlas-back';
    btnBack.textContent = '← Tags';
    btnBack.title = 'Back to tag overview';
    btnBack.style.display = 'none';
    toolbar.appendChild(btnBack);

    const drillNote = document.createElement('span');
    drillNote.className = 'memory-atlas-drill-note';
    drillNote.setAttribute('aria-live', 'polite');
    toolbar.appendChild(drillNote);

    const hideDoneLabel = document.createElement('label');
    hideDoneLabel.className = 'memory-atlas-hide-done';
    const hideDoneCb = document.createElement('input');
    hideDoneCb.type = 'checkbox';
    hideDoneCb.checked = hideDone;
    hideDoneLabel.appendChild(hideDoneCb);
    hideDoneLabel.appendChild(document.createTextNode(' hide DONE'));
    toolbar.appendChild(hideDoneLabel);

    const maxSel = document.createElement('select');
    maxSel.className = 'memory-atlas-max-sel';
    maxSel.title = 'Max memories when a tag is open';
    [[4, '4 open'], [8, '8 open'], [12, '12 open'], [20, '20 open']].forEach(function ([n, lab]) {
      const o = document.createElement('option');
      o.value = String(n);
      o.textContent = lab;
      if (n === maxPerTag) o.selected = true;
      maxSel.appendChild(o);
    });
    toolbar.appendChild(maxSel);

    const searchIn = document.createElement('input');
    searchIn.type = 'search';
    searchIn.className = 'memory-atlas-filter';
    searchIn.placeholder = 'Filter nodes…';
    searchIn.setAttribute('aria-label', 'Filter graph');
    toolbar.appendChild(searchIn);

    const btnReset = document.createElement('button');
    btnReset.type = 'button';
    btnReset.className = 'btn btn-sm memory-atlas-btn-reset';
    btnReset.textContent = 'Reset view';
    toolbar.appendChild(btnReset);

    const btnReload = document.createElement('button');
    btnReload.type = 'button';
    btnReload.className = 'btn btn-sm';
    btnReload.textContent = 'Reload';
    toolbar.appendChild(btnReload);

    // --- Main + SVG ---
    const main = document.createElement('div');
    main.className = 'memory-atlas-main';

    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'memory-atlas-canvas-wrap';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'memory-atlas-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Memory map');
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML =
      '<linearGradient id="atlas-grad-root" x1="0%" y1="0%" x2="100%" y2="100%">' +
      '<stop offset="0%" stop-color="var(--atlas-recall, #5eead4)"/>' +
      '<stop offset="100%" stop-color="var(--atlas-attention, #fbbf24)"/>' +
      '</linearGradient>' +
      '<radialGradient id="atlas-grad-node-chunk" cx="28%" cy="22%" r="75%">' +
      '<stop offset="0%" stop-color="rgba(255,255,255,0.14)"/>' +
      '<stop offset="45%" stop-color="rgba(255,255,255,0.02)"/>' +
      '<stop offset="100%" stop-color="rgba(0,0,0,0.08)"/>' +
      '</radialGradient>' +
      '<filter id="atlas-glow-soft" x="-40%" y="-40%" width="180%" height="180%">' +
      '<feGaussianBlur stdDeviation="4" result="b"/>' +
      '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>' +
      '</filter>' +
      '<filter id="atlas-glow-strong" x="-50%" y="-50%" width="200%" height="200%">' +
      '<feGaussianBlur stdDeviation="8" result="b"/>' +
      '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>' +
      '</filter>';

    const zoomLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    zoomLayer.setAttribute('class', 'memory-atlas-zoom-layer');
    const gGrid = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    gGrid.setAttribute('class', 'memory-atlas-svg-grid');
    const gLinks = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    gLinks.setAttribute('class', 'memory-atlas-links');
    const gNodes = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    gNodes.setAttribute('class', 'memory-atlas-nodes');
    zoomLayer.appendChild(gGrid);
    zoomLayer.appendChild(gLinks);
    zoomLayer.appendChild(gNodes);

    svg.appendChild(defs);
    svg.appendChild(zoomLayer);
    canvasWrap.appendChild(bg);
    canvasWrap.appendChild(ignite);
    canvasWrap.appendChild(shock);
    canvasWrap.appendChild(svg);

    // Minimap
    const mini = document.createElement('div');
    mini.className = 'memory-atlas-minimap';
    const miniSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    miniSvg.setAttribute('class', 'memory-atlas-minimap-svg');
    const miniG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const miniVp = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    miniVp.setAttribute('class', 'memory-atlas-minimap-vp');
    miniSvg.appendChild(miniG);
    miniSvg.appendChild(miniVp);
    mini.appendChild(miniSvg);
    canvasWrap.appendChild(mini);

    // Hover card
    const hoverCard = document.createElement('div');
    hoverCard.className = 'memory-atlas-hover-card';
    hoverCard.setAttribute('hidden', '');
    canvasWrap.appendChild(hoverCard);

    // Rail
    const rail = document.createElement('aside');
    rail.className = 'memory-atlas-rail';
    rail.setAttribute('aria-label', 'Detail');
    rail.innerHTML =
      '<div class="memory-atlas-rail-head">' +
      '<span class="memory-atlas-rail-title">Memory chunk</span>' +
      '<button type="button" class="memory-atlas-rail-close btn btn-sm" aria-label="Close panel">×</button>' +
      '</div>' +
      '<div class="memory-atlas-rail-body"></div>';
    const railBody = rail.querySelector('.memory-atlas-rail-body');
    const railClose = rail.querySelector('.memory-atlas-rail-close');
    const railTitle = rail.querySelector('.memory-atlas-rail-title');

    main.appendChild(canvasWrap);
    main.appendChild(rail);

    wrap.appendChild(toolbar);
    wrap.appendChild(main);
    container.appendChild(wrap);

    let hoverTimer = null;
    let hoverLeaveTimer = null;

    function measure() {
      const r = canvasWrap.getBoundingClientRect();
      innerW = Math.max(400, r.width);
      innerH = Math.max(360, Math.min(r.height, global.innerHeight - 220));
      svg.setAttribute('width', String(innerW));
      svg.setAttribute('height', String(innerH));
      svg.setAttribute('viewBox', '0 0 ' + innerW + ' ' + innerH);
    }

    function runIgnition() {
      if (velocity === 'calm' || reducedMotion()) return;
      ignite.classList.add('memory-atlas-ignite--on');
      setTimeout(function () {
        ignite.classList.remove('memory-atlas-ignite--on');
      }, 200);
    }

    function playSearchNova() {
      if (velocity === 'calm' || reducedMotion()) return;
      shock.classList.remove('memory-atlas-shockwave--on');
      void shock.offsetWidth;
      shock.classList.add('memory-atlas-shockwave--on');
      setTimeout(function () {
        shock.classList.remove('memory-atlas-shockwave--on');
      }, 520);
    }

    function setVelocity(v) {
      const pick = v === 'pulse' || v === 'calm' || v === 'flash' ? v : 'flash';
      if (!reducedMotion()) global.localStorage.setItem(LS_VELOCITY, pick);
      velocity = effectiveVelocity(pick);
      wrap.className = 'memory-atlas memory-atlas--' + velocity;
      velSeg.querySelectorAll('.memory-atlas-seg-btn').forEach(function (btn, idx) {
        const keys = ['flash', 'pulse', 'calm'];
        btn.classList.toggle('active', keys[idx] === velocity);
      });
    }

    function nodeMatchesFilter(h) {
      if (!filterQ.trim()) return true;
      const q = filterQ.trim().toLowerCase();
      const node = h.data;
      let blob = '';
      if (node.type === 'chunk' && node.data) {
        const ch = node.data;
        blob = (ch.text || '') + (ch.path || '') + (ch.chunk_tag || '');
      } else if (node.type === 'tag') {
        blob = (node.tag || '') + (node.label || '') + (node.count != null ? String(node.count) : '');
      } else if (node.topic || node.file_path) {
        blob = (node.topic || '') + (node.file_path || '') + (node.label || '');
      } else {
        blob = (node.label || '') + (node.type || '');
      }
      return blob.toLowerCase().indexOf(q) >= 0;
    }

    function subtreeHasMatch(d) {
      if (nodeMatchesFilter(d)) return true;
      if (!d.children) return false;
      return d.children.some(subtreeHasMatch);
    }

    function paintRail(chunk) {
      rail.classList.add('is-open');
      if (railTitle) railTitle.textContent = 'Memory chunk';
      railBody.innerHTML = '';
      if (global.MemoryRow && chunk) {
        railBody.appendChild(global.MemoryRow.render(chunk, { allowPin: true }));
      } else if (chunk) {
        const p = document.createElement('pre');
        p.className = 'memory-atlas-rail-fallback';
        p.textContent = JSON.stringify(chunk, null, 2);
        railBody.appendChild(p);
      }
    }

    function paintFileRail(meta) {
      rail.classList.add('is-open');
      if (railTitle) railTitle.textContent = 'Memory file';
      railBody.innerHTML = '';
      const h = document.createElement('div');
      h.className = 'memory-atlas-file-rail-head';
      h.textContent = meta.topic || 'File';
      railBody.appendChild(h);
      const pathRow = document.createElement('div');
      pathRow.className = 'memory-atlas-file-rail-path';
      pathRow.textContent = meta.file_path || '';
      railBody.appendChild(pathRow);
      const pre = document.createElement('pre');
      pre.className = 'memory-atlas-file-preview';
      pre.textContent = 'Loading…';
      railBody.appendChild(pre);
      if (!meta.file_path) {
        pre.textContent = 'No file path on this node.';
        return;
      }
      fetch('/api/memory/file?path=' + encodeURIComponent(meta.file_path))
        .then(function (r) {
          if (!r.ok) throw new Error(r.statusText);
          return r.text();
        })
        .then(function (text) {
          const lines = text.split('\n');
          const line = meta.file_line != null ? Math.max(1, meta.file_line) : 1;
          const start = Math.max(0, line - 6);
          pre.textContent = lines.slice(start, start + 48).join('\n');
        })
        .catch(function (e) {
          pre.textContent = 'Could not load file: ' + (e.message || e);
        });
    }

    function closeRail() {
      rail.classList.remove('is-open');
    }

    function worldXY(d) {
      if (dataMode === 'files') return [d.px, d.py];
      if (layoutMode === 'radial') {
        const cx = innerW / 2;
        const cy = innerH / 2;
        return [d.px + cx, d.py + cy];
      }
      return [d.px, d.py];
    }

    function syncToolbarForDataMode() {
      const files = dataMode === 'files';
      layoutSeg.style.display = files ? 'none' : '';
      scopeSel.style.display = files ? 'none' : '';
      hideDoneLabel.style.display = files ? 'none' : '';
      maxSel.style.display = files ? 'none' : '';
      if (files) {
        btnBack.style.display = 'none';
        drillNote.textContent = '';
        drillNote.style.display = 'none';
        searchIn.placeholder = 'Filter topics & paths…';
      } else {
        searchIn.placeholder = drillTag ? 'Filter in this tag…' : 'Filter tags…';
      }
    }

    /**
     * Layout workspace and daily as two separate d3 trees (each gets full vertical
     * breadth for siblings). Maps positions back onto the main hierarchy by id.
     */
    function applySplitArmLayout() {
      const cx = innerW / 2;
      const cy = innerH / 2;
      const gap = 100;
      const breadthSpan = Math.max(520, innerH - 100);
      const depthSpan = Math.max(220, innerW / 2 - gap - 80);

      const childWs = (hierarchyRoot.children || []).find(function (c) {
        return c.data.id === 'workspace';
      });
      const childDl = (hierarchyRoot.children || []).find(function (c) {
        return c.data.id === 'daily';
      });
      if (!childWs || !childDl) {
        const margin = { top: 48, left: 56, right: 56, bottom: 48 };
        d3.tree()
          .size([innerW - margin.left - margin.right, innerH - margin.top - margin.bottom])
          (hierarchyRoot);
        hierarchyRoot.each(function (d) {
          d.px = d.x + margin.left;
          d.py = d.y + margin.top;
        });
        return;
      }

      const treeFn = d3.tree().size([breadthSpan, depthSpan]).separation(function (a, b) {
        return a.parent === b.parent ? 1.45 : 1.65;
      });

      const hWs = d3.hierarchy(childWs.data);
      const hDl = d3.hierarchy(childDl.data);
      treeFn(hWs);
      treeFn(hDl);

      function centerSubtreeScratch(hSub, targetCy) {
        let mn = Infinity;
        let mx = -Infinity;
        hSub.each(function (d) {
          mn = Math.min(mn, d._scratchPy);
          mx = Math.max(mx, d._scratchPy);
        });
        if (!isFinite(mn)) return;
        const mid = (mn + mx) / 2;
        const off = targetCy - mid;
        hSub.each(function (d) {
          d._scratchPy += off;
        });
      }

      hDl.each(function (d) {
        d._scratchPx = cx - gap - d.y;
        d._scratchPy = d.x + 60;
      });
      centerSubtreeScratch(hDl, cy);

      hWs.each(function (d) {
        d._scratchPx = cx + gap + d.y;
        d._scratchPy = d.x + 60;
      });
      centerSubtreeScratch(hWs, cy);

      const pos = {};
      pos[hierarchyRoot.data.id] = { px: cx, py: cy };
      hDl.each(function (d) {
        pos[d.data.id] = { px: d._scratchPx, py: d._scratchPy };
      });
      hWs.each(function (d) {
        pos[d.data.id] = { px: d._scratchPx, py: d._scratchPy };
      });

      hierarchyRoot.each(function (d) {
        const p = pos[d.data.id];
        if (p) {
          d.px = p.px;
          d.py = p.py;
        }
      });
    }

    function resetCamera() {
      if (!d3 || !zoomBehavior || !svgNode) return;
      d3.select(svgNode)
        .transition()
        .duration(reducedMotion() ? 100 : 420)
        .ease(d3.easeCubicOut)
        .call(zoomBehavior.transform, d3.zoomIdentity);
    }

    function fitBounds(bounds, pad) {
      pad = pad == null ? 48 : pad;
      if (!d3 || !zoomBehavior || !svgNode || !bounds) return;
      const w = bounds[1][0] - bounds[0][0];
      const h = bounds[1][1] - bounds[0][1];
      if (w < 4 || h < 4) return resetCamera();
      const k = Math.min((innerW - pad * 2) / w, (innerH - pad * 2) / h, 2.5);
      const tx = innerW / 2 - k * (bounds[0][0] + bounds[1][0]) / 2;
      const ty = innerH / 2 - k * (bounds[0][1] + bounds[1][1]) / 2;
      d3.select(svgNode)
        .transition()
        .duration(reducedMotion() ? 100 : 400)
        .ease(d3.easeCubicOut)
        .call(zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
    }

    function collectBounds(d, acc) {
      const [x, y] = worldXY(d);
      acc[0][0] = Math.min(acc[0][0], x);
      acc[0][1] = Math.min(acc[0][1], y);
      acc[1][0] = Math.max(acc[1][0], x);
      acc[1][1] = Math.max(acc[1][1], y);
      if (d.children) d.children.forEach(function (c) {
        collectBounds(c, acc);
      });
    }

    function renderGraph() {
      if (destroyed || !d3) return;
      measure();
      zoomLayer.querySelectorAll('.memory-atlas-particle').forEach(function (n) {
        n.remove();
      });
      d3.select(gLinks).selectAll('*').remove();
      d3.select(gNodes).selectAll('*').remove();
      d3.select(gGrid).selectAll('*').remove();
      gLinks.removeAttribute('transform');
      gNodes.removeAttribute('transform');

      syncToolbarForDataMode();

      let layoutUsesRadial = false;
      let linkGen = null;

      if (dataMode === 'files') {
        if (!fileTreeData || !fileTreeData.children || !fileTreeData.children.length) {
          const fo = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
          fo.setAttribute('x', String(innerW / 2 - 180));
          fo.setAttribute('y', String(innerH / 2 - 70));
          fo.setAttribute('width', '360');
          fo.setAttribute('height', '160');
          fo.innerHTML =
            '<div xmlns="http://www.w3.org/1999/xhtml" class="memory-atlas-empty">' +
            '<p class="memory-atlas-empty-title">No topic tree</p>' +
            '<p class="memory-atlas-empty-hint">Open the Mind Map tab once or reload — same API as workspace + daily logs.</p>' +
            '</div>';
          gNodes.appendChild(fo);
          return;
        }
        hierarchyRoot = d3.hierarchy(pruneFileTreeForAtlas(fileTreeData));
        hierarchyRoot.each(function (d) {
          d.data.label = truncateTopic(d.data.topic || d.data.id || '', FILE_LABEL_MAX + Math.min(12, d.depth * 2));
        });
        applySplitArmLayout();
      } else {
        if (!chunks.length) {
          const fo = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
          fo.setAttribute('x', String(innerW / 2 - 160));
          fo.setAttribute('y', String(innerH / 2 - 80));
          fo.setAttribute('width', '320');
          fo.setAttribute('height', '200');
          fo.innerHTML =
            '<div xmlns="http://www.w3.org/1999/xhtml" class="memory-atlas-empty">' +
            '<div class="memory-atlas-empty-stars" aria-hidden="true">✦ · ✧ · ✦</div>' +
            '<p class="memory-atlas-empty-title">No memories in this slice</p>' +
            '<p class="memory-atlas-empty-hint">Try another scope or capture more in chat — chunks appear here.</p>' +
            '</div>';
          gNodes.appendChild(fo);
          return;
        }

        let treeData;
        if (drillTag) {
          treeData = buildDrillFlat(chunks, drillTag, maxPerTag);
          btnBack.style.display = '';
          const shown = (treeData.children && treeData.children.length) || 0;
          const tot = treeData.totalInTag != null ? treeData.totalInTag : shown;
          drillNote.textContent = drillTag + ' — showing ' + shown + (tot > shown ? ' of ' + tot : '');
          drillNote.style.display = 'inline';
          searchIn.placeholder = 'Filter in this tag…';
        } else {
          treeData = buildTagOverview(chunks, hideDone);
          btnBack.style.display = 'none';
          drillNote.textContent = '';
          drillNote.style.display = 'none';
          searchIn.placeholder = 'Filter tags…';
        }

        if (!treeData.children.length) {
          if (drillTag) {
            btnBack.style.display = '';
            drillNote.textContent = drillTag + ' — empty';
            drillNote.style.display = 'inline';
          }
          const fo = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
          fo.setAttribute('x', String(innerW / 2 - 180));
          fo.setAttribute('y', String(innerH / 2 - 70));
          fo.setAttribute('width', '360');
          fo.setAttribute('height', '180');
          const hint = drillTag
            ? 'No chunks for this tag in the loaded slice. Try “← Tags” or reload.'
            : hideDone
              ? 'Uncheck “hide DONE” or pick a scope with other tags.'
              : 'Try another scope or capture more in chat.';
          fo.innerHTML =
            '<div xmlns="http://www.w3.org/1999/xhtml" class="memory-atlas-empty">' +
            '<p class="memory-atlas-empty-title">Nothing to draw here</p>' +
            '<p class="memory-atlas-empty-hint">' +
            hint +
            '</p></div>';
          gNodes.appendChild(fo);
          return;
        }

        hierarchyRoot = d3.hierarchy(treeData);

        let proj;
        if (layoutMode === 'radial') {
          layoutUsesRadial = true;
          const radius = Math.min(innerW, innerH) / 2 - 72;
          const cx = innerW / 2;
          const cy = innerH / 2;
          gLinks.setAttribute('transform', 'translate(' + cx + ',' + cy + ')');
          gNodes.setAttribute('transform', 'translate(' + cx + ',' + cy + ')');
          d3.tree()
            .size([2 * Math.PI, radius])
            .separation(function (a, b) {
              return a.parent === b.parent ? 1.3 : 1.65;
            })(hierarchyRoot);
          proj = function (d) {
            const a = d.x - Math.PI / 2;
            return [d.y * Math.cos(a), d.y * Math.sin(a)];
          };
          linkGen = d3
            .linkRadial()
            .angle(function (d) {
              return d.x;
            })
            .radius(function (d) {
              return d.y;
            });
        } else {
          const margin = { top: 40, right: 24, bottom: 24, left: 24 };
          const tw = innerW - margin.left - margin.right;
          const th = innerH - margin.top - margin.bottom;
          d3.tree()
            .size([tw, th])
            .separation(function (a, b) {
              return a.parent === b.parent ? 1.12 : 1.32;
            })(hierarchyRoot);
          proj = function (d) {
            return [d.x + margin.left, d.y + margin.top];
          };
          linkGen = d3.linkVertical().x(function (d) {
            return d.x;
          }).y(function (d) {
            return d.y;
          });
        }

        hierarchyRoot.each(function (d) {
          const p = proj(d);
          d.px = p[0];
          d.py = p[1];
        });
      }

      const dur = reducedMotion() ? 0 : velocity === 'flash' ? 14 : 10;
      const maxStagger = reducedMotion() ? 0 : velocity === 'flash' ? 200 : 120;

      const links = hierarchyRoot.links().map(function (l) {
        if (dataMode === 'files') {
          return {
            source: l.source,
            target: l.target,
            d: d3.linkHorizontal()({
              source: { x: l.source.px, y: l.source.py },
              target: { x: l.target.px, y: l.target.py },
            }),
          };
        }
        if (layoutUsesRadial) {
          return { source: l.source, target: l.target, d: linkGen(l) };
        }
        return {
          source: l.source,
          target: l.target,
          d: d3.linkVertical()({
            source: { x: l.source.px, y: l.source.py },
            target: { x: l.target.px, y: l.target.py },
          }),
        };
      });

      const linkJoin = d3.select(gLinks).selectAll('path').data(links);
      linkJoin
        .enter()
        .append('path')
        .attr('class', 'memory-atlas-link')
        .attr('d', function (l) {
          return l.d;
        })
        .attr('stroke', function (l) {
          if (dataMode === 'files') {
            const id = l.target.data.id || '';
            if (id === 'workspace') return 'hsl(217, 85%, 62%)';
            if (id === 'daily') return 'hsl(160, 55%, 48%)';
            if (l.target.data.file_line != null) return 'rgba(148, 163, 184, 0.55)';
            return 'rgba(148, 163, 184, 0.4)';
          }
          let tag = l.target.data.tag || '';
          if (l.target.data.type === 'chunk' && l.target.data.data) {
            tag = l.target.data.data.chunk_tag || tag || 'UNTAGGED';
          }
          const col = l.target.data.type === 'chunk' ? tagStroke(String(tag || 'UNTAGGED')) : 'rgba(148,163,184,0.35)';
          return col;
        })
        .attr('opacity', 0.35)
        .transition()
        .delay(function (_, i) {
          return Math.min(i * dur, maxStagger);
        })
        .duration(reducedMotion() ? 0 : 400)
        .attr('opacity', 0.55);

      const nodeJoin = d3
        .select(gNodes)
        .selectAll('g.memory-atlas-node')
        .data(hierarchyRoot.descendants(), function (d) {
          return d.data.id;
        });

      const nodeEnter = nodeJoin
        .enter()
        .append('g')
        .attr('class', function (d) {
          if (dataMode === 'files') {
            return 'memory-atlas-node memory-atlas-file--' + fileNodeVisualKind(d);
          }
          let c = 'memory-atlas-node memory-atlas-node--' + (d.data.type || 'chunk');
          if (d.data.data && d.data.data.pinned) c += ' memory-atlas-node--pinned';
          return c;
        })
        .attr('transform', function (d) {
          return 'translate(' + d.px + ',' + d.py + ')';
        })
        .attr('opacity', 0)
        .attr('transform', function (d) {
          return 'translate(' + d.px + ',' + d.py + ') scale(0.92)';
        });

      nodeEnter
        .transition()
        .delay(function (d) {
          return Math.min(d.depth * (velocity === 'flash' ? 18 : 12), maxStagger);
        })
        .duration(reducedMotion() ? 0 : 220)
        .ease(d3.easeCubicOut)
        .attr('opacity', function (d) {
          return subtreeHasMatch(d) ? 1 : 0.12;
        })
        .attr('transform', function (d) {
          return 'translate(' + d.px + ',' + d.py + ') scale(1)';
        });

      nodeEnter.each(function (d) {
        const g = d3.select(this);
        if (dataMode === 'files') {
          const kind = fileNodeVisualKind(d);
          if (kind === 'root') {
            const ring = g.append('circle').attr('r', 40).attr('class', 'memory-atlas-root-ring');
            ring.attr('fill', 'none').attr('stroke', 'url(#atlas-grad-root)').attr('stroke-width', 2);
            g.append('circle').attr('r', 30).attr('class', 'memory-atlas-root-core');
            g.append('text').attr('class', 'memory-atlas-root-glyph').attr('text-anchor', 'middle').attr('dy', '0.35em').text('◎');
            g.append('text')
              .attr('class', 'memory-atlas-root-label')
              .attr('y', 52)
              .attr('text-anchor', 'middle')
              .text(truncateTopic(d.data.topic || 'Memory', 22));
          } else if (kind === 'arm') {
            const isWs = d.data.id === 'workspace';
            const w = Math.max(132, 14 + String(d.data.label || '').length * 6.5);
            g.append('title').text(isWs ? 'Workspace markdown (same as Mind Map)' : 'Daily logs (newest first)');
            g.append('rect')
              .attr('class', 'memory-atlas-mm-arm-bg')
              .attr('x', -w / 2)
              .attr('y', -18)
              .attr('width', w)
              .attr('height', 36)
              .attr('rx', 10);
            g.append('rect')
              .attr('x', -w / 2)
              .attr('y', -18)
              .attr('width', 4)
              .attr('height', 36)
              .attr('rx', 2)
              .attr('fill', isWs ? 'hsl(217, 85%, 58%)' : 'hsl(160, 55%, 45%)');
            g.append('text')
              .attr('class', 'memory-atlas-mm-arm-text')
              .attr('text-anchor', 'middle')
              .attr('dy', '0.35em')
              .text(String(d.data.label || ''));
          } else if (kind === 'heading') {
            const w = Math.max(96, 8 + String(d.data.label || '').length * 5.5);
            g.append('title').text((d.data.topic || '') + (d.data.file_path ? '\n' + d.data.file_path : ''));
            g.append('rect')
              .attr('class', 'memory-atlas-mm-heading-bg')
              .attr('x', -w / 2)
              .attr('y', -12)
              .attr('width', w)
              .attr('height', 24)
              .attr('rx', 6);
            g.append('text')
              .attr('class', 'memory-atlas-mm-heading-text')
              .attr('text-anchor', 'middle')
              .attr('dy', '0.35em')
              .text(String(d.data.label || ''));
          } else {
            const w = Math.max(108, 10 + String(d.data.label || '').length * 6);
            g.append('title').text((d.data.topic || '') + (d.data.file_path ? '\n' + d.data.file_path : ''));
            g.append('rect')
              .attr('class', 'memory-atlas-mm-file-bg')
              .attr('x', -w / 2)
              .attr('y', -16)
              .attr('width', w)
              .attr('height', 32)
              .attr('rx', 8);
            g.append('text')
              .attr('class', 'memory-atlas-mm-file-text')
              .attr('text-anchor', 'middle')
              .attr('dy', '0.35em')
              .text(String(d.data.label || ''));
          }
          return;
        }

        const type = d.data.type;
        if (type === 'root') {
          const ring = g.append('circle').attr('r', 44).attr('class', 'memory-atlas-root-ring');
          ring.attr('fill', 'none').attr('stroke', 'url(#atlas-grad-root)').attr('stroke-width', 2);
          if (!reducedMotion()) {
            const L = 2 * Math.PI * 44;
            ring.attr('stroke-dasharray', L).attr('stroke-dashoffset', L).transition().duration(600).ease(d3.easeCubicOut).attr('stroke-dashoffset', 0);
          }
          g.append('circle').attr('r', 32).attr('class', 'memory-atlas-root-core');
          g.append('text').attr('class', 'memory-atlas-root-glyph').attr('text-anchor', 'middle').attr('dy', '0.35em').text('M');
          g.append('text').attr('class', 'memory-atlas-root-label').attr('y', 58).attr('text-anchor', 'middle').text('Memory');
        } else if (type === 'tag') {
          const w = Math.max(100, 10 + String(d.data.label || '').length * 6.5);
          g.append('title').text(
            d.data.overview
              ? String(d.data.count) + ' memories — click to browse (max ' + maxPerTag + ' shown)'
              : String(d.data.label || d.data.tag)
          );
          g.append('rect').attr('class', 'memory-atlas-tag-bg').attr('x', -w / 2).attr('y', -18).attr('width', w).attr('height', 36).attr('rx', 10);
          g.append('rect')
            .attr('class', 'memory-atlas-tag-stripe')
            .attr('x', -w / 2)
            .attr('y', -18)
            .attr('width', 4)
            .attr('height', 36)
            .attr('fill', tagStroke(d.data.tag));
          g.append('text').attr('class', 'memory-atlas-tag-label').attr('text-anchor', 'middle').attr('dy', '0.35em').text(String(d.data.label || ''));
          if (d.data.overview) g.classed('memory-atlas-node--drillable', true);
        } else {
          const w = 168;
          const line = String(d.data.label || '');
          const tip = d.data.tip || line;
          g.append('title').text(tip);
          g.append('rect')
            .attr('class', 'memory-atlas-chunk-card')
            .attr('x', -w / 2)
            .attr('y', -20)
            .attr('width', w)
            .attr('height', 40)
            .attr('rx', 10)
            .attr('fill', 'url(#atlas-grad-node-chunk)');
          g.append('text')
            .attr('class', 'memory-atlas-chunk-text')
            .attr('text-anchor', 'middle')
            .attr('y', 4)
            .attr('x', 0)
            .text(line);
        }
      });

      // Interaction on merged selection
      const nodeMerge = nodeEnter.merge(nodeJoin);
      nodeMerge
        .on('mouseenter', function (event, d) {
          if (dataMode === 'files') {
            clearTimeout(hoverLeaveTimer);
            hoverTimer = setTimeout(function () {
              const kind = fileNodeVisualKind(d);
              hoverCard.innerHTML =
                '<div class="memory-atlas-hover-inner"><strong>' +
                escapeHtml(kind) +
                '</strong><p>' +
                escapeHtml(truncateTopic(d.data.topic, 140)) +
                '</p><span class="memory-atlas-hover-meta">' +
                escapeHtml(d.data.file_path || '') +
                (d.data.file_line != null ? ' · line ' + d.data.file_line : '') +
                '</span></div>';
              hoverCard.removeAttribute('hidden');
              const rect = canvasWrap.getBoundingClientRect();
              hoverCard.style.left = Math.min(rect.width - 300, event.clientX - rect.left + 12) + 'px';
              hoverCard.style.top = Math.min(rect.height - 160, event.clientY - rect.top + 12) + 'px';
            }, 280);
            return;
          }
          if (d.data.type !== 'chunk' || !d.data.data) return;
          clearTimeout(hoverLeaveTimer);
          hoverTimer = setTimeout(function () {
            const ch = d.data.data;
            hoverCard.innerHTML =
              '<div class="memory-atlas-hover-inner"><strong>' +
              escapeHtml(ch.chunk_tag || '') +
              '</strong><p>' +
              escapeHtml(chunkLabel(ch.text)) +
              '</p><span class="memory-atlas-hover-meta">' +
              escapeHtml((ch.path || '') + ' · ' + (ch.created_at || '').slice(0, 16)) +
              '</span></div>';
            hoverCard.removeAttribute('hidden');
            const rect = canvasWrap.getBoundingClientRect();
            hoverCard.style.left = Math.min(rect.width - 300, event.clientX - rect.left + 12) + 'px';
            hoverCard.style.top = Math.min(rect.height - 160, event.clientY - rect.top + 12) + 'px';
          }, 280);
        })
        .on('mouseleave', function () {
          clearTimeout(hoverTimer);
          hoverLeaveTimer = setTimeout(function () {
            hoverCard.setAttribute('hidden', '');
          }, 100);
        })
        .on('click', function (event, d) {
          event.stopPropagation();
          focusId = d.data.id;
          if (dataMode === 'files') {
            if (d.data.file_path) {
              paintFileRail({
                topic: d.data.topic,
                file_path: d.data.file_path,
                file_line: d.data.file_line,
              });
            } else {
              closeRail();
            }
            nodeMerge.classed('memory-atlas-node--sel', function (n) {
              return n.data.id === d.data.id;
            });
            if (velocity === 'flash' && !reducedMotion() && d.data.file_path) {
              const w = worldXY(d);
              burstParticles(w[0], w[1]);
            }
            return;
          }
          if (d.data.type === 'tag' && d.data.overview) {
            drillTag = d.data.tag;
            closeRail();
            renderGraph();
            return;
          }
          if (d.data.type === 'chunk' && d.data.data) paintRail(d.data.data);
          else closeRail();
          nodeMerge.classed('memory-atlas-node--sel', function (n) {
            return n.data.id === d.data.id;
          });
          if (velocity === 'flash' && !reducedMotion()) {
            const w = worldXY(d);
            burstParticles(w[0], w[1]);
          }
        })
        .on('dblclick', function (event, d) {
          event.stopPropagation();
          const acc = [
            [Infinity, Infinity],
            [-Infinity, -Infinity],
          ];
          collectBounds(d, acc);
          if (acc[0][0] !== Infinity) fitBounds(acc, 56);
          wrap.classList.add('memory-atlas--focus');
          setTimeout(function () {
            wrap.classList.remove('memory-atlas--focus');
          }, velocity === 'calm' ? 0 : 400);
        });

      // Specular sweep (once per node id per session)
      nodeMerge.each(function (d) {
        const id = d.data.id;
        if (specularSeen.has(id)) return;
        specularSeen.add(id);
        if (velocity === 'calm' || reducedMotion()) return;
        this.classList.add('memory-atlas-node--spec');
        const self = this;
        setTimeout(function () {
          self.classList.remove('memory-atlas-node--spec');
        }, 360);
      });

      updateMinimap();
      runIgnition();
      resetCamera();
    }

    // Shared escaper — safe.js loads first, so VodouSafe is always present.
    function escapeHtml(s) { return window.VodouSafe.escapeHtml(s); }

    function burstParticles(x, y) {
      if (!zoomLayer || velocity === 'calm') return;
      const n = velocity === 'pulse' ? 6 : 16;
      const circles = [];
      for (let i = 0; i < n; i++) {
        const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        c.setAttribute('class', 'memory-atlas-particle');
        c.setAttribute('cx', String(x));
        c.setAttribute('cy', String(y));
        c.setAttribute('r', String(1.5 + Math.random() * 2));
        const ang = Math.random() * Math.PI * 2;
        const dist = 28 + Math.random() * 40;
        c.style.setProperty('--dx', String(Math.cos(ang) * dist));
        c.style.setProperty('--dy', String(Math.sin(ang) * dist));
        zoomLayer.appendChild(c);
        circles.push(c);
      }
      setTimeout(function () {
        circles.forEach(function (c) {
          try {
            c.remove();
          } catch (e) { /* noop */ }
        });
      }, 240);
    }

    function updateMinimap() {
      if (!hierarchyRoot) return;
      const pts = [];
      hierarchyRoot.each(function (d) {
        const w = worldXY(d);
        pts.push({ x: w[0], y: w[1], t: d.data.type });
      });
      if (!pts.length) return;
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      pts.forEach(function (p) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      });
      const pad = 20;
      const bw = maxX - minX + pad * 2;
      const bh = maxY - minY + pad * 2;
      const ms = 168;
      const s = Math.min(ms / bw, ms / bh, 3);
      miniG.setAttribute('transform', 'translate(8,8) scale(' + s + ') translate(' + (-minX + pad) + ',' + (-minY + pad) + ')');
      miniG.innerHTML = '';
      pts.forEach(function (p) {
        const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        r.setAttribute('x', p.x - 2);
        r.setAttribute('y', p.y - 2);
        r.setAttribute('width', p.t === 'chunk' ? 3 : 5);
        r.setAttribute('height', p.t === 'chunk' ? 3 : 5);
        r.setAttribute('fill', p.t === 'root' ? 'var(--atlas-recall)' : 'rgba(148,163,184,0.7)');
        miniG.appendChild(r);
      });
    }

    function onZoom(event) {
      zoomG.setAttribute('transform', event.transform);
      if (!d3 || !svgNode) return;
      const t = event.transform;
      const k = t.k;
      const tx = t.x;
      const ty = t.y;
      const miniPad = 8;
      const ms = 168 - miniPad * 2;
      miniVp.setAttribute('x', String(miniPad + (-tx / k) * (ms / innerW) * 0.25));
      miniVp.setAttribute('y', String(miniPad + (-ty / k) * (ms / innerH) * 0.25));
      miniVp.setAttribute('width', String((innerW / k / innerW) * ms * 0.35));
      miniVp.setAttribute('height', String((innerH / k / innerH) * ms * 0.35));
    }

    async function loadScopes() {
      try {
        const rows = await API.get('/api/memory/scopes');
        const cur = scopeSel.value;
        scopeSel.innerHTML = '<option value="">All scopes</option>';
        (rows || []).forEach(function (r) {
          const o = document.createElement('option');
          o.value = r.scope;
          o.textContent = r.scope + ' (' + r.count + ')';
          scopeSel.appendChild(o);
        });
        scopeSel.value = cur || '';
      } catch (e) {
        /* noop */
      }
    }

    async function loadChunks() {
      drillTag = null;
      try {
        const lim = 120;
        const q = scopeRef.current ? '?scope=' + encodeURIComponent(scopeRef.current) + '&limit=' + lim : '?limit=' + lim;
        const rows = await API.get('/api/memory/chunks' + q);
        chunks = (rows || []).map(normalizeChunk);
      } catch (e) {
        chunks = [];
        console.error('[MemoryAtlas]', e);
      }
      renderGraph();
    }

    async function loadFileTree() {
      drillTag = null;
      try {
        fileTreeData = await API.get('/api/memory/tree');
      } catch (e) {
        fileTreeData = null;
        console.error('[MemoryAtlas] tree', e);
      }
      renderGraph();
    }

    async function loadActiveData() {
      if (dataMode === 'files') {
        await loadFileTree();
      } else {
        await loadChunks();
      }
    }

    function setDataModeButtons() {
      btnTopics.classList.toggle('active', dataMode === 'files');
      btnTags.classList.toggle('active', dataMode === 'tags');
    }

    function onResize() {
      if (destroyed) return;
      renderGraph();
    }

    function destroy() {
      destroyed = true;
      global.removeEventListener('resize', onResize);
      if (rafId) cancelAnimationFrame(rafId);
      clearTimeout(hoverTimer);
      clearTimeout(hoverLeaveTimer);
      if (zoomBehavior && svgNode) d3.select(svgNode).on('.zoom', null);
      wrap.remove();
    }

    btnRadial.addEventListener('click', function () {
      layoutMode = 'radial';
      btnRadial.classList.add('active');
      btnTree.classList.remove('active');
      renderGraph();
    });
    btnTree.addEventListener('click', function () {
      layoutMode = 'tree';
      btnTree.classList.add('active');
      btnRadial.classList.remove('active');
      renderGraph();
    });

    velSeg.addEventListener('click', function (e) {
      const t = e.target;
      if (!t || !t.dataset || !t.dataset.vel) return;
      setVelocity(t.dataset.vel);
    });

    scopeSel.addEventListener('change', function () {
      scopeRef.current = scopeSel.value || '';
      if (dataMode === 'tags') loadChunks();
    });

    dataSeg.addEventListener('click', function (e) {
      const btn = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!btn) return;
      if (btn === btnTopics) {
        if (dataMode === 'files') return;
        dataMode = 'files';
        global.localStorage.setItem(LS_DATA_MODE, 'files');
        setDataModeButtons();
        layoutMode = 'tree';
        btnTree.classList.add('active');
        btnRadial.classList.remove('active');
        loadFileTree();
        return;
      }
      if (btn === btnTags) {
        if (dataMode === 'tags') return;
        dataMode = 'tags';
        global.localStorage.setItem(LS_DATA_MODE, 'tags');
        setDataModeButtons();
        loadChunks();
      }
    });

    searchIn.addEventListener('input', function () {
      filterQ = searchIn.value;
      playSearchNova();
      if (!d3) return;
      d3.select(gNodes)
        .selectAll('g.memory-atlas-node')
        .transition()
        .duration(180)
        .attr('opacity', function (d) {
          return subtreeHasMatch(d) ? 1 : 0.08;
        });
      d3.select(gLinks)
        .selectAll('path')
        .transition()
        .duration(180)
        .attr('opacity', function (l) {
          return subtreeHasMatch(l.target) ? 0.55 : 0.06;
        });
    });

    btnBack.addEventListener('click', function () {
      drillTag = null;
      closeRail();
      renderGraph();
    });

    hideDoneCb.addEventListener('change', function () {
      hideDone = !!hideDoneCb.checked;
      global.localStorage.setItem(LS_HIDE_DONE, hideDone ? '1' : '0');
      drillTag = null;
      renderGraph();
    });

    maxSel.addEventListener('change', function () {
      maxPerTag = parseInt(maxSel.value, 10) || 8;
      global.localStorage.setItem(LS_MAX_PER_TAG, String(maxPerTag));
      if (drillTag) renderGraph();
    });

    btnReset.addEventListener('click', resetCamera);
    btnReload.addEventListener('click', loadActiveData);
    railClose.addEventListener('click', closeRail);

    global.addEventListener('resize', onResize);

    ensureD3()
      .then(function (lib) {
        d3 = lib;
        if (destroyed) return;
        svgNode = svg;
        zoomG = zoomLayer;
        zoomBehavior = d3
          .zoom()
          .scaleExtent([0.15, 4])
          .on('zoom', onZoom);
        d3.select(svg).call(zoomBehavior);
        loadScopes();
        setDataModeButtons();
        loadActiveData();
      })
      .catch(function (e) {
        canvasWrap.innerHTML = '<div class="error-state">Failed to load D3: ' + (e.message || e) + '</div>';
      });

    return destroy;
  }

  global.MemoryAtlas = { init: init, ensureD3: ensureD3 };
})(window);
