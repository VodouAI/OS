/**
 * PLAN-MEMORY-VISIBILITY-UI Phases C/D — shared chunk-result row component.
 *
 * Renders a single memory chunk with:
 *   - tag chip + scope chip
 *   - text snippet
 *   - provenance footer (path · created_at · model)
 *   - inline chevron expansion that reveals the score breakdown table
 *   - Pin button (Phase E) — wires to existing POST /api/memory
 *
 * Used by both the Memory page (live search results) and the Chat "see why"
 * modal — single source of truth for chunk rendering.
 *
 * window.MemoryRow.render(chunk, opts) → HTMLElement
 */
(function (global) {
  'use strict';

  // Shared escaper — safe.js loads first, so VodouSafe is always present.
  function escapeHtml(s) { return window.VodouSafe.escapeHtml(s); }

  function formatDate(iso) {
    if (!iso) return '';
    return iso.length >= 16 ? iso.slice(0, 16).replace('T', ' ') : iso;
  }

  function fmtScore(n) {
    if (n === null || n === undefined) return '—';
    const v = Number(n);
    if (!isFinite(v)) return '—';
    return v.toFixed(4);
  }

  // PLAN-CONTINUITY-PRIMITIVE Phase 4 — JS mirror of `parse_surface_from_scope`
  // in src/continuity/recall.rs. Both forms must stay in lock-step.
  // Returns the surface key (e.g. 'telegram', 'claude-code-hook') or null when
  // the scope is file-indexed / skill / project (those don't have a surface).
  function parseSurfaceFromScope(scope) {
    if (typeof scope !== 'string' || !scope) return null;
    const parts = scope.split(':');
    if (parts.length < 3 || parts[0] !== 'workbench') return null;
    if (parts[1] !== 'surface' && parts[1] !== 'channel') return null;
    const tail = parts.slice(2).join(':');
    return tail || null;
  }
  // Expose for chat.js modal rollup.
  global.MemoryRow_parseSurfaceFromScope = parseSurfaceFromScope;

  function buildBreakdownTable(b) {
    if (!b) {
      const empty = document.createElement('div');
      empty.className = 'memrow-breakdown-empty';
      empty.textContent = 'No breakdown available (FTS-only fallback or pre-debug result).';
      return empty;
    }
    const wrap = document.createElement('div');
    wrap.className = 'memrow-breakdown';
    const rows = [
      ['cosine', b.cosine, b.cosine === null || b.cosine === undefined ? 'FTS-only path (no embedding)' : ''],
      ['rrf_base', b.rrf_base, 'pre-recency RRF accumulator'],
      ['recency', b.recency, '+= w_recency × recency_weight(days)'],
      ['category', b.category, '+= w_category × category_weight'],
      ['signal_bonus', b.signal_bonus, b.signal_bonus > 0 ? 'vector + FTS both hit' : 'one signal only'],
      ['reranker', b.reranker_logit, b.reranker_logit === null || b.reranker_logit === undefined ? 'reranker not fired' : 'sigmoid-normalized'],
      ['scope_boost', b.scope_boost, b.scope_boost > 1 ? `×${Number(b.scope_boost).toFixed(2)} (in-scope match)` : '×1 (no boost)'],
      ['tag_bias', b.tag_bias, b.tag_bias > 0 ? '+ additive bias' : 'neutral'],
    ];
    const tbl = document.createElement('table');
    tbl.className = 'memrow-breakdown-table';
    for (const [name, val, note] of rows) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      td1.className = 'memrow-bd-name';
      td1.textContent = name;
      const td2 = document.createElement('td');
      td2.className = 'memrow-bd-val';
      td2.textContent = name === 'scope_boost' && val ? `×${Number(val).toFixed(2)}` : fmtScore(val);
      const td3 = document.createElement('td');
      td3.className = 'memrow-bd-note';
      td3.textContent = note || '';
      tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
      tbl.appendChild(tr);
    }
    // Final score row (highlighted)
    const finalTr = document.createElement('tr');
    finalTr.className = 'memrow-bd-final';
    const finalLabel = document.createElement('td');
    finalLabel.textContent = 'final';
    const finalVal = document.createElement('td');
    finalVal.textContent = fmtScore(b.final_score);
    const finalNote = document.createElement('td');
    finalNote.textContent = '= SearchResult.score';
    finalTr.appendChild(finalLabel); finalTr.appendChild(finalVal); finalTr.appendChild(finalNote);
    tbl.appendChild(finalTr);
    wrap.appendChild(tbl);
    return wrap;
  }

  function render(chunk, opts) {
    opts = opts || {};
    const row = document.createElement('div');
    row.className = 'memrow';
    row.dataset.chunkId = chunk.chunk_id || chunk.id || '';

    const head = document.createElement('div');
    head.className = 'memrow-head';

    // Chevron toggle
    const chevron = document.createElement('button');
    chevron.className = 'memrow-chevron';
    chevron.type = 'button';
    chevron.textContent = '▶';
    chevron.title = 'Expand score breakdown';
    chevron.setAttribute('aria-expanded', 'false');

    // Tag chip
    if (chunk.chunk_tag) {
      const tag = document.createElement('span');
      tag.className = 'memrow-tag memrow-tag-' + String(chunk.chunk_tag).toLowerCase();
      tag.textContent = '[' + chunk.chunk_tag + ']';
      head.appendChild(chevron);
      head.appendChild(tag);
    } else {
      head.appendChild(chevron);
    }

    // Provenance chip. COHERENCE F7/F41 — this used to print the raw scope and
    // special-case `web` out of the way, which is the tell: `web` was hidden
    // because it read as a lie, not because it was uninteresting. Translating
    // it says the true thing ("your notes"), so nothing needs hiding.
    if (chunk.chunk_scope) {
      const scope = document.createElement('span');
      scope.className = 'memrow-scope';
      scope.textContent = globalThis.VodouVocabulary.scopeLabel(chunk.chunk_scope);
      head.appendChild(scope);
    }

    // Score
    const score = document.createElement('span');
    score.className = 'memrow-score';
    score.textContent = fmtScore(chunk.score);
    score.title = 'final score';
    head.appendChild(score);

    // Pin (Phase E — persistent pin via memory_chunks.pinned column).
    // Pinned chunks get a large additive search boost so they always surface
    // on relevant queries. Toggle via POST/DELETE /api/memory/chunks/:id/pin.
    if (opts.allowPin !== false) {
      const pin = document.createElement('button');
      pin.className = 'memrow-pin';
      pin.type = 'button';
      // Reflect current state (pinned can be 0/1 from sqlite or true/false).
      let isPinned = !!chunk.pinned;
      const refresh = function () {
        pin.textContent = isPinned ? '📍' : '📌';
        pin.title = isPinned ? 'Pinned — click to unpin' : 'Pin: surface this chunk on relevant queries';
        pin.classList.toggle('memrow-pin-done', isPinned);
      };
      refresh();
      pin.addEventListener('click', async function (e) {
        e.stopPropagation();
        const chunkId = chunk.chunk_id || chunk.id;
        if (!chunkId) {
          if (typeof Components !== 'undefined' && Components.toast) {
            Components.toast('Pin failed: missing chunk id', 'error');
          }
          return;
        }
        const path = '/api/memory/pin?id=' + encodeURIComponent(chunkId);
        try {
          if (isPinned) {
            await API.del(path);
            isPinned = false;
            if (typeof Components !== 'undefined' && Components.toast) {
              Components.toast('Unpinned', 'info');
            }
          } else {
            await API.post(path, {});
            isPinned = true;
            if (typeof Components !== 'undefined' && Components.toast) {
              Components.toast('Pinned — will surface on relevant queries', 'success');
            }
          }
          refresh();
        } catch (err) {
          if (typeof Components !== 'undefined' && Components.toast) {
            Components.toast('Pin toggle failed: ' + (err.message || err), 'error');
          }
        }
      });
      head.appendChild(pin);
    }

    // PLAN-BRAIN-INTO-CONSOLE P2.3 — the same memory, as a point of light.
    if (opts.allowMap !== false && (chunk.chunk_id || chunk.id)) {
      const map = document.createElement('a');
      map.className = 'memrow-map';
      map.textContent = '\u2726';
      map.title = 'Show in map — focus this memory\'s neighborhood';
      map.href = '#/memory?tab=map&node=' + encodeURIComponent(chunk.chunk_id || chunk.id);
      map.addEventListener('click', function (e) { e.stopPropagation(); });
      head.appendChild(map);
    }

    row.appendChild(head);

    // Text body
    const body = document.createElement('div');
    body.className = 'memrow-body';
    body.textContent = String(chunk.text || '').slice(0, 600);
    row.appendChild(body);

    // Provenance footer
    const foot = document.createElement('div');
    foot.className = 'memrow-foot';
    const parts = [];
    if (chunk.path) parts.push(chunk.path);
    if (chunk.created_at) parts.push(formatDate(chunk.created_at));
    foot.textContent = parts.join(' · ');
    row.appendChild(foot);

    // PLAN-CONTINUITY-PRIMITIVE Phase 4 — `↳ recalled from <surface>` line.
    // Rendered only when the chunk's scope parses to a surface (workbench:surface:*
    // or workbench:channel:*). File-indexed chunks (chunk_scope='web') and skill
    // / project scopes silently render nothing — that's the spec.
    const surface = parseSurfaceFromScope(chunk.chunk_scope);
    if (surface) {
      const cont = document.createElement('div');
      cont.className = 'memrow-continuity';
      cont.textContent = '↳ recalled from ' + surface;
      cont.title = 'continuity primitive — chunk_scope: ' + chunk.chunk_scope;
      row.appendChild(cont);
    }

    // Breakdown panel (initially hidden)
    const panel = document.createElement('div');
    panel.className = 'memrow-breakdown-panel';
    panel.style.display = 'none';
    let expanded = false;
    chevron.addEventListener('click', function (e) {
      e.stopPropagation();
      expanded = !expanded;
      chevron.textContent = expanded ? '▼' : '▶';
      chevron.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      if (expanded && !panel.firstChild) {
        panel.appendChild(buildBreakdownTable(chunk.score_breakdown));
      }
      panel.style.display = expanded ? 'block' : 'none';
    });
    row.appendChild(panel);

    return row;
  }

  global.MemoryRow = { render: render, escapeHtml: escapeHtml, formatDate: formatDate };
})(window);
