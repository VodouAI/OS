/**
 * PLAN-RECEIPTS-BROWSE-TAB — the fixture parity gate.
 *
 * The three-shape verdict rule and the conversation_id→lane mapping each exist
 * twice (Rust grade_flow14 / TS receiptShape+receiptLaneGroup). This suite and
 * the Rust `fixture_parity` tests read the SAME fixtures/receipt-shapes.json;
 * a change to either implementation that the other doesn't mirror fails one of
 * them. Without this, the Receipts page and `flows --flow 14` could classify
 * the same receipt differently and both look right.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { receiptShape, receiptLaneGroup, browseReceipts, parseReceiptLanes } from '../turn-receipt.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'receipt-shapes.json'), 'utf-8'));
describe('receiptShape — the three verdicts, from the shared fixtures', () => {
    for (const f of FIX.shapes) {
        it(f.name, () => {
            expect(receiptShape(parseReceiptLanes(JSON.stringify(f.lanes)))).toBe(f.expected);
        });
    }
    it('no lanes at all is unrecorded — never a verdict', () => {
        expect(receiptShape(parseReceiptLanes(null))).toBe('unrecorded');
        expect(receiptShape(parseReceiptLanes(''))).toBe('unrecorded');
    });
    it('a non-memory lane proves nothing about memory', () => {
        // system_prompt ran fine; the memory family never did. This is the
        // blackout wearing a busy receipt.
        const lanes = parseReceiptLanes(JSON.stringify([
            { lane: 'system_prompt', chars: 11289 },
            { lane: 'hook_memory', chars: 0, ms: 1 },
        ]));
        expect(receiptShape(lanes)).toBe('never_ran');
    });
});
describe('receiptLaneGroup — the mapping, from the shared fixtures', () => {
    for (const f of FIX.lane_groups) {
        it(`${f.conversation_id} → ${f.expected}`, () => {
            expect(receiptLaneGroup(f.conversation_id)).toBe(f.expected);
        });
    }
});
describe('browseReceipts — the endpoint core', () => {
    const at = '2026-08-30 16:50:00';
    const mk = (cid, lanes, extra = {}) => ({
        at, conversation_id: cid,
        turn_id: extra.turn_id !== undefined ? extra.turn_id : 't-' + Math.random().toString(36).slice(2),
        memories_used: extra.memories_used ?? 0,
        degraded: extra.degraded ?? null,
        lanes: lanes === null ? null : JSON.stringify(lanes),
    });
    it('counts match hand-computation across all four buckets', () => {
        const { summary, rows } = browseReceipts([
            mk('workbench:skill-console:a', [{ lane: 'hook_memory', chars: 0, ms: 0 }]),
            mk('workbench:skill-console:a', [{ lane: 'memory', chars: 614, ms: 668, items: 2 }], { memories_used: 2 }),
            mk('vodou-heartbeat', [{ lane: 'memory', chars: 0, ms: 1862 }]),
            mk('conv-1', null, { turn_id: null }),
        ]);
        expect(summary['skill-console']).toEqual({ turns: 2, injected: 1, ran_empty: 0, never_ran: 1, unrecorded: 0 });
        expect(summary['heartbeat']).toEqual({ turns: 1, injected: 0, ran_empty: 1, never_ran: 0, unrecorded: 0 });
        expect(summary['interactive']).toEqual({ turns: 1, injected: 0, ran_empty: 0, never_ran: 0, unrecorded: 1 });
        expect(rows).toHaveLength(4);
        // items rides through; the pre-D-6 row keeps its null turn_id rather than a dead link.
        expect(rows[1].items).toBe(2);
        expect(rows[3].turn_id).toBeNull();
        expect(rows[3].shape).toBe('unrecorded');
    });
    it('problems=1 returns only never-ran and degraded rows — the eleven-silent-days filter', () => {
        const { rows, summary } = browseReceipts([
            mk('workbench:skill-console:a', [{ lane: 'hook_memory', chars: 0, ms: 0 }]),
            mk('workbench:skill-console:a', [{ lane: 'memory', chars: 614, ms: 668 }]),
            mk('conv-1', [{ lane: 'memory', chars: 100, ms: 50 }], { degraded: 'timeout' }),
        ], { problems: true });
        expect(rows).toHaveLength(2);
        expect(rows.map(r => r.shape).sort()).toEqual(['injected', 'never_ran']);
        // The summary still counts EVERYTHING — a filter narrows the list, never the truth.
        expect(summary['skill-console'].turns).toBe(2);
    });
    it('lane filter narrows rows, not the summary', () => {
        const { rows, summary } = browseReceipts([
            mk('workbench:skill-console:a', [{ lane: 'memory', chars: 10, ms: 50 }]),
            mk('vodou-heartbeat', [{ lane: 'memory', chars: 10, ms: 50 }]),
        ], { lane: 'heartbeat' });
        expect(rows).toHaveLength(1);
        expect(rows[0].lane_group).toBe('heartbeat');
        expect(Object.keys(summary).sort()).toEqual(['heartbeat', 'skill-console']);
    });
});
