/**
 * Engines-agree guard (PLAN-GRAPH-SKILLS P0).
 *
 * `src/workflow-driver.ts::computeJoin` and `src/graph_group.rs::compute_join`
 * are two implementations of one contract. This suite and the Rust test
 * `graph_group::tests::join_arithmetic_matches_the_shared_fixture` read the SAME
 * fixture file, so a change that makes one engine report a different number than
 * the other fails in both places rather than in a user's morning briefing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { computeJoin } from '../workflow-driver.js';
const FIXTURE = path.join(__dirname, '../../../../tests/fixtures/graph-skills/join-arithmetic.json');
describe('join arithmetic parity with the CLI engine', () => {
    const doc = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    it('reads the shared fixture (a missing fixture must fail loudly, not vacuously pass)', () => {
        expect(doc.cases.length).toBeGreaterThan(0);
    });
    for (const c of doc.cases) {
        it(`${c.name} — ${c.why}`, () => {
            const got = computeJoin(c.join_id, c.in, c.branches, c.min_success);
            expect(got.ok).toBe(c.expect.ok);
            expect(got.settled).toBe(c.expect.settled);
            expect(got.expected).toBe(c.expect.expected);
            expect(got.met).toBe(c.expect.met);
            // The sentence itself is the contract: it is what the user reads.
            expect(got.line).toBe(c.expect.line);
        });
    }
});
