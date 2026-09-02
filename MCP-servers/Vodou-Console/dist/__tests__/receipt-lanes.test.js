import { describe, it, expect } from 'vitest';
import { parseReceiptLanes } from '../turn-receipt.js';
// PLAN-CONTEXT-COORDINATION P7-0 — what the assembler writes is what a reload reads.
describe('turn_receipts.lanes round trip', () => {
    it('parses the JSON the assembler stores', () => {
        const stored = JSON.stringify([{ lane: 'bootstrap', chars: 23994 }, { lane: 'memory', chars: 812 }, { lane: 'tool_results', chars: 440 }]);
        expect(parseReceiptLanes(stored)).toEqual([
            { lane: 'bootstrap', chars: 23994 }, { lane: 'memory', chars: 812 }, { lane: 'tool_results', chars: 440 },
        ]);
    });
    it('a pre-088 row (NULL) and a torn write both render as no lanes, never as an error', () => {
        expect(parseReceiptLanes(null)).toEqual([]);
        expect(parseReceiptLanes('')).toEqual([]);
        expect(parseReceiptLanes('[{"lane":"memory","ch')).toEqual([]);
        expect(parseReceiptLanes('{"lane":"memory","chars":1}')).toEqual([]);
    });
    it('drops malformed entries instead of the whole row', () => {
        expect(parseReceiptLanes('[{"lane":"memory","chars":5},{"nope":1},{"lane":"x"}]')).toEqual([{ lane: 'memory', chars: 5 }]);
    });
});
import { noteTurnLanes, noteCachedPrompt, takeTurnLanes } from '../llm.js';
describe('a turn accumulates its lanes until the receipt takes them', () => {
    it('turn start replaces; assembler (prefixOnly) and cache hits append; take clears', () => {
        noteTurnLanes('c1', [{ lane: 'memory', chars: 10 }], true);
        noteCachedPrompt('c1', 38841);
        noteTurnLanes('c1', [{ lane: 'tool_results', chars: 440 }], false);
        expect(takeTurnLanes('c1')).toEqual([
            { lane: 'memory', chars: 10 }, { lane: 'system_prompt', chars: 38841, cached: true }, { lane: 'tool_results', chars: 440 },
        ]);
        expect(takeTurnLanes('c1')).toEqual([]);
    });
    it('the previous turn never leaks into the next: a new turn start replaces', () => {
        noteTurnLanes('c2', [{ lane: 'bootstrap', chars: 24170 }, { lane: 'memory', chars: 5 }], true);
        noteTurnLanes('c2', [{ lane: 'memory', chars: 7 }], true);
        expect(takeTurnLanes('c2')).toEqual([{ lane: 'memory', chars: 7 }]);
    });
    it('the parser keeps `cached` so a reloaded row can say the prompt was cached', () => {
        expect(parseReceiptLanes('[{"lane":"system_prompt","chars":3,"cached":true}]')).toEqual([{ lane: 'system_prompt', chars: 3, cached: true }]);
    });
});
import { turnTag, turnIdFor } from '../llm.js';
describe('P2 — the turn id reaches the child through the prompt', () => {
    it('no dispatch → no tag, and a tag is exactly one line the daemon can strip', () => {
        expect(turnIdFor('never-dispatched')).toBe('');
        expect(turnTag('never-dispatched')).toBe('');
    });
});
// P7a acceptance 1 — "nothing found" and "did not run" must not look the same.
// The state strings are the contract the renderer displays; pin them, and pin
// that every one of them is registered in lanes.toml (Rule 8's whole point).
import { readFileSync } from 'fs';
import { join } from 'path';
describe('P7a — the brainloader lane distinguishes did-not-run from found-nothing', () => {
    const src = readFileSync(join(__dirname, '../llm.ts'), 'utf-8');
    it('records a lane for every exit, and a skip carries its reason', () => {
        const block = src.slice(src.indexOf('const brainResult = await brainPromise;'), src.indexOf("lane: 'brainloader'") + 600);
        for (const state of ['not run (not needed)', 'not run (daemon auto-routed)', 'not run (recall fast path)', 'degraded (', 'no match', "'ran'"]) {
            expect(block).toContain(state);
        }
        expect(block).toContain("lane: 'brainloader'");
    });
    it('is registered in lanes.toml with a budget and a trust label', () => {
        const toml = readFileSync(join(__dirname, '../../../../lanes.toml'), 'utf-8');
        const stanza = toml.slice(toml.indexOf('name = "brainloader"'));
        expect(stanza).toMatch(/budget\s*=/);
        expect(stanza).toMatch(/trust\s*=/);
    });
});
// F8, inverted: a turn that sends NO live receipt must not come back from a
// reload carrying one.
//
// This was pinned as an ORDER — persist after the silence check — and the order
// had to change: the check ran before the lanes were known, so a turn using no
// memory was declared silent and returned null while seven lanes and 48,952
// characters sat unrecorded. A real turn, "what is my dog's name", answered
// correctly, with no receipt at all.
//
// The invariant is unchanged and still enforced; it moved from ORDERING to an
// EMPTINESS GUARD, which is the more honest place for it — "persist nothing when
// there is nothing" rather than "persist only after we have decided to speak".
// Pinned here so the next person who reorders these lines has to mean it.
describe('a silent turn persists no lanes', () => {
    const src = readFileSync(join(__dirname, '../turn-receipt.ts'), 'utf-8');
    const llm = readFileSync(join(__dirname, '../llm.ts'), 'utf-8');
    it('takes the lanes before the silence check, so they never leak into the next turn', () => {
        const take = src.indexOf('takeTurnLanes(convId)');
        const silent = src.indexOf('sending no receipt (silent by design)');
        expect(take).toBeGreaterThan(-1);
        expect(take).toBeLessThan(silent);
    });
    it('a turn is silent only when NO lane fired either', () => {
        // The bug in one line: silence was judged on memories/tools/skills alone,
        // which answers a different question than the one a receipt exists to answer.
        const guard = src.slice(src.indexOf('if (!memoriesUsed.length'), src.indexOf('silent by design)'));
        expect(guard, 'the silence check must consider lanes').toContain('!lanes.length');
    });
    it('persistTurnLanes writes nothing when there is nothing to write', () => {
        const fn = llm.slice(llm.indexOf('export function persistTurnLanes'));
        expect(fn.slice(0, fn.indexOf('UPDATE turn_receipts')), 'the emptiness guard is what keeps a silent turn silent')
            .toContain('if (!merged.length) return lanes;');
    });
    // PLAN-MEMORY-REACHES-AUTOMATION follow-up (2026-08-31). Found in the data,
    // not by inspection: `blog-morning` and `blog-evening` each held TWO rows for
    // one fire — the real turn (turn_id, 1 memory, lanes) and, minutes after
    // `turn/end`, a row with no turn_id, no lanes and memories_used=0.
    //
    // A phantom is indistinguishable from a turn that ran blind, and was counted
    // as one: it is the whole reason skill-console re-measured at 37%
    // zero-memory when the real figure for completed turns is ~0%.
    it('recordMemoriesInjected skips a receipt that asserts nothing', () => {
        const fn = llm.slice(llm.indexOf('function recordMemoriesInjected'));
        const guard = fn.slice(0, fn.indexOf('INSERT INTO turn_receipts'));
        expect(guard, 'no turn to join, no memories, no degraded reason = no claim, no row')
            .toContain('if (!turnId && memoryLines.length === 0 && !degraded)');
    });
    it('the skip is NOT "must have a turn id" — a real injection without one still records', () => {
        // Some callers legitimately have no turn id. Dropping their receipts would
        // hide real injection, which is the opposite defect. The guard has to
        // require ALL THREE to be absent.
        const fn = llm.slice(llm.indexOf('function recordMemoriesInjected'));
        const guard = fn.slice(0, fn.indexOf('INSERT INTO turn_receipts'));
        expect(guard).not.toContain('if (!turnId) return;');
        expect(guard, 'memories present must still write').toContain('memoryLines.length === 0');
        expect(guard, 'a degraded turn must still write').toContain('!degraded');
    });
});
// ── P9 (2026-08-28) ────────────────────────────────────────────────────────
// Found live, not by inspection: the first scoped turn after P9 produced a
// receipt with the `skill` lane twice. The CLI families assemble twice per turn
// — once for the system prompt, once for the user prefix — and the second pass
// re-noted lane 6. A receipt with two rows for one lane cannot be read: it does
// not say whether the skill ran twice or was counted twice.
describe('P9 — a turn has one row per lane', () => {
    it('appending a lane that is already present replaces it, last write wins', async () => {
        const { noteTurnLanes, takeTurnLanes } = await import('../llm.js');
        const conv = 'p9-dedupe-' + Math.random().toString(36).slice(2);
        noteTurnLanes(conv, [{ lane: 'memory', chars: 100 }, { lane: 'skill', chars: 41052 }], true);
        noteTurnLanes(conv, [{ lane: 'ground_truth', chars: 880 }, { lane: 'skill', chars: 41052 }], false);
        const lanes = takeTurnLanes(conv);
        const names = lanes.map(l => l.lane);
        expect(new Set(names).size, `duplicate lane rows: ${names.join(', ')}`).toBe(names.length);
        expect(names.sort()).toEqual(['ground_truth', 'memory', 'skill']);
    });
    it('a later record for the same lane wins on its fields', async () => {
        const { noteTurnLanes, takeTurnLanes } = await import('../llm.js');
        const conv = 'p9-lww-' + Math.random().toString(36).slice(2);
        noteTurnLanes(conv, [{ lane: 'tool_results', chars: 10 }], true);
        noteTurnLanes(conv, [{ lane: 'tool_results', chars: 999, state: 'ran' }], false);
        const lanes = takeTurnLanes(conv);
        expect(lanes).toHaveLength(1);
        expect(lanes[0].chars).toBe(999);
        expect(lanes[0].state).toBe('ran');
    });
});
