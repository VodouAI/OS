/**
 * PLAN-RECEIPTS-BROWSE-TAB P1 — the turn receipt, as a component.
 *
 * Extracted VERBATIM from chat.js `_showTurnReceipt` (the ~150-line body after
 * mount resolution) so the Memory → Receipts tab and chat render ONE receipt
 * UI instead of two. chat.js keeps only its mount-point lookup and delegates
 * here; this file owns the DOM. (Console Two has its own renderer at
 * public/two/chat.js — a separate surface, deliberately out of scope.)
 *
 * window.TurnReceiptView.build(receipt) → HTMLElement | null
 *   receipt: { memories, tools, skills, degraded, lanes, ms, vault, project,
 *              stack, turnId } — the shape buildReceipt/receiptsForTurns emit.
 *
 * textContent throughout — memory items are user data, tool names come off the
 * wire. Neither is ever markup.
 */
(function (global) {
  'use strict';

  function build(receipt) {
    if (!receipt) return null;

    const mem = (receipt.memories && receipt.memories.used) || 0;
    const tools = (receipt.tools || []).length;
    const skills = (receipt.skills || []).length;
    const parts = [];
    if (mem) parts.push('Memory ' + mem);
    if (tools) parts.push('tool' + (tools === 1 ? '' : 's') + ' ' + tools);
    if (skills) parts.push('skill' + (skills === 1 ? '' : 's') + ' ' + skills);
    if (receipt.degraded) parts.push('degraded');
    // P4/P7a — silent truncation is the failure being fixed: an eviction earns a
    // place in the SUMMARY, before anyone expands anything.
    const lanes = Array.isArray(receipt.lanes) ? receipt.lanes : [];
    const evictedTok = lanes.reduce((n, l) => n + ((l && l.evicted_tok) || 0), 0);
    if (evictedTok) parts.push(evictedTok + ' tok evicted');
    if (receipt.ms) parts.push((receipt.ms / 1000).toFixed(1) + 's');
    // PLAN-PROJECT-VAULTS §4.5 — name the disclosure boundary when there IS one.
    // Only guest turns have a vault; on an owner turn there is no limit to state,
    // and printing one would imply a restriction that does not exist.
    if (receipt.vault) parts.unshift('vault ' + receipt.vault);
    // A turn can inject forty-nine thousand characters across seven lanes and
    // still use no memory, no tool and no skill — "what is my dog's name",
    // answered correctly, was exactly that. With nothing in the summary the
    // whole receipt returns here and the Context rows never render. Only when
    // nothing else earned a place: this is the empty case, not a redesign.
    if (!parts.length && lanes.length) parts.push('Context ' + lanes.length);
    if (!parts.length) return null;

    const box = document.createElement('details');
    box.className = 'chat-turn-receipt';
    const sum = document.createElement('summary');
    sum.textContent = parts.join(' · ');
    box.appendChild(sum);

    const detail = document.createElement('div');
    detail.className = 'chat-turn-receipt-detail';
    const line = (label, items) => {
      if (!items || !items.length) return;
      const row = document.createElement('div');
      row.textContent = label + ': ' + items.join(', ');
      detail.appendChild(row);
    };
    line('Skills', receipt.skills);
    line('Tools', receipt.tools);
    line('Memories', (receipt.memories && receipt.memories.items) || []);
    // P4 — which run composition this turn ran in (stacks.toml). Rendered ONLY
    // beside the Context rows, and only when the gateway sent one. Deliberately
    // NOT a per-lane `off (stack)` marker — see SEAMS §48 (the data refuted it).
    if (lanes.length && typeof receipt.stack === 'string' && receipt.stack) {
      const st = document.createElement('div');
      st.className = 'chat-turn-receipt-stack';
      st.textContent = 'Stack: ' + receipt.stack;
      detail.appendChild(st);
    }
    // P7a — Context block: one row per injected lane, `name · state · chars · ms`.
    // `not run` and `no match` are deliberately distinct from an absent row.
    if (lanes.length) {
      const head = document.createElement('div');
      head.textContent = 'Context:';
      detail.appendChild(head);
      for (const l of lanes) {
        if (!l || typeof l.lane !== 'string') continue;
        const row = document.createElement('div');
        row.className = 'chat-turn-receipt-lane';
        const bits = [l.lane.replace(/_/g, ' '), l.state || 'ran'];
        if (l.chars) bits.push(l.chars.toLocaleString() + ' chars');
        // b90c4144 — the memory lane says how many memories it held; chars
        // alone over-claims (the block carries Presence/Suggested Skill too).
        if (l.items != null) bits.push(l.items + (l.items === 1 ? ' memory' : ' memories'));
        if (l.evicted_tok) bits.push(l.evicted_tok + ' tok evicted');
        if (l.ms != null) bits.push(l.ms + ' ms');
        row.textContent = '  ' + bits.join(' · ');
        // P0 — "show me what it saw". Only offered when the turn is identified
        // (older turns have no id) and the lane actually carried text.
        if (receipt.turnId && l.chars) {
          const show = document.createElement('button');
          show.type = 'button';
          show.className = 'chat-turn-receipt-show';
          show.textContent = 'show';
          let pre = null;
          show.addEventListener('click', async () => {
            if (pre) { pre.remove(); pre = null; show.textContent = 'show'; return; }
            show.disabled = true; show.textContent = '…';
            pre = document.createElement('pre');
            pre.className = 'chat-turn-receipt-body';
            try {
              const r = await fetch('/api/turn/' + encodeURIComponent(receipt.turnId)
                + '/lane/' + encodeURIComponent(l.lane));
              const d = await r.json();
              // Never an empty box: a withheld payload says why it is withheld.
              pre.textContent = d.withheld
                ? d.withheld + ' — ' + (d.chars || 0).toLocaleString() + ' chars, sha ' + (d.hash || '')
                : (d.text || '(empty)');
              if (d.trust && !d.withheld) pre.dataset.trust = d.trust;
            } catch (e) {
              pre.textContent = 'could not read the turn log: ' + (e && e.message ? e.message : e);
            }
            row.appendChild(pre);
            show.disabled = false; show.textContent = 'hide';
          });
          row.appendChild(document.createTextNode(' '));
          row.appendChild(show);
        }
        detail.appendChild(row);
      }
    }
    if (receipt.memories && receipt.memories.total) {
      const row = document.createElement('div');
      row.textContent = 'Drawn from ' + receipt.memories.total.toLocaleString() + ' stored memories';
      detail.appendChild(row);
    }
    if (receipt.degraded) {
      const row = document.createElement('div');
      // COHERENCE F42 — the field is `stage` now; `scope` is the deprecated
      // alias, still read so a NEWER panel keeps working against an OLDER
      // gateway.
      const dg = receipt.degraded;
      // COHERENCE-INTENTIONAL: moved verbatim from chat.js. `stage` here is a
      // pipeline stage ("context"/"rerank") — already a human word, not the
      // memory-scope taxonomy scopeLabel translates; `.scope` is F42's
      // deprecated alias read for old gateways, not a raw scope displayed.
      row.textContent = 'Degraded: ' + (dg.stage || dg.scope || 'context') + ' / ' + dg.reason;
      detail.appendChild(row);
    }
    if (receipt.vault) {
      const row = document.createElement('div');
      row.textContent = 'Answered from vault: ' + receipt.vault;
      detail.appendChild(row);
    }
    if (receipt.project) {
      const row = document.createElement('div');
      row.textContent = 'Project: ' + receipt.project;
      detail.appendChild(row);
    }
    if (detail.childElementCount) box.appendChild(detail);
    return box;
  }

  global.TurnReceiptView = { build };
})(window);
