/**
 * PLAN-MEMORIES-ARE-FACTS-NOT-WORK-LOGS §4.2 — the TS age label agrees with the
 * engine's, case for case, on the one shared fixture.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ageLabel, ageLabelForRow, shortAge } from '../memory-age-label.js';
const FIXTURE = path.resolve(__dirname, '../../../../tests/fixtures/memory-ranking/age-labels.json');
describe('age labels — one rule on both sides of the seam', () => {
    afterEach(() => { delete process.env.VODOU_MEMORY_AGE_LABELS; });
    it('matches every case in the shared fixture', () => {
        const f = JSON.parse(readFileSync(FIXTURE, 'utf-8'));
        expect(f.cases.length).toBeGreaterThanOrEqual(15);
        for (const c of f.cases) {
            expect(ageLabel(c.tag, c.dated, c.until, f.today), JSON.stringify(c)).toBe(c.expect);
        }
    });
    it('short ages stay short', () => {
        expect(shortAge(0)).toBe('today');
        expect(shortAge(13)).toBe('13d ago');
        expect(shortAge(59)).toBe('8w ago');
        expect(shortAge(364)).toBe('12mo ago');
    });
    it('switches off, and a row with no date gets no label', () => {
        expect(ageLabelForRow({ chunk_tag: 'DONE' })).toBeNull();
        process.env.VODOU_MEMORY_AGE_LABELS = '0';
        expect(ageLabelForRow({ chunk_tag: 'DONE', created_at: '2020-01-01 00:00:00' })).toBeNull();
    });
});
