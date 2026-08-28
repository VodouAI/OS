/**
 * item 16 — the shape classifier.
 *
 * The corpus test at the bottom is the one that matters. Every fixture here was
 * written by me and can only prove the code does what I already believed; the
 * corpus is 49 skills nobody wrote for this test, and it is what caught both
 * real bugs: option `"1"` being hardcoded, and menu-only skills being reported
 * as empty.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { classifyShape, shapeLabel, shapeGlyph } from '../graph-topology.js';
const step = (id, extra = {}) => ({ id, server: 's', tool: 'get_thing', ...extra });
describe('classifyShape', () => {
    it('calls a lone step single, and two in a row a chain', () => {
        expect(classifyShape({ initial_steps: [step('a')] }).shape).toBe('single');
        expect(classifyShape({ initial_steps: [step('a'), step('b')] }).shape).toBe('chain');
    });
    it('calls a shared parallel_group a fan, and reports its width', () => {
        const s = classifyShape({
            initial_steps: [step('a', { parallel_group: 'g' }), step('b', { parallel_group: 'g' }), step('c')],
        });
        expect(s.shape).toBe('fan');
        expect(s.widest).toBe(2);
        expect(s.steps).toBe(3);
    });
    it('a fan carrying a verifier is fan+check', () => {
        const s = classifyShape({
            initial_steps: [
                step('a', { parallel_group: 'g' }),
                step('b', { parallel_group: 'g' }),
                { id: 'v', kind: 'verifier', checks: [{ rule: 'must cite', check: 'cites' }] },
            ],
        });
        expect(s.shape).toBe('fan+check');
        expect(s.checks).toBe(1);
    });
    it('a loop outranks everything — its cost is not bounded by step count', () => {
        const s = classifyShape({
            initial_steps: [step('a', { parallel_group: 'g' }), step('b', { parallel_group: 'g', loop: 6 })],
        });
        expect(s.shape).toBe('cycle');
        expect(s.loops).toBe(1);
    });
    it('loop:1 is not a cycle — it runs once', () => {
        expect(classifyShape({ initial_steps: [step('a', { loop: 1 }), step('b')] }).shape).toBe('chain');
    });
    it('a join is bookkeeping, not work — it never inflates the step count', () => {
        const s = classifyShape({
            initial_steps: [
                step('a', { parallel_group: 'g' }),
                step('b', { parallel_group: 'g' }),
                { id: 'j', kind: 'join', in: ['a', 'b'], min_success: 2 },
            ],
        });
        expect(s.steps).toBe(2);
    });
    /** N13/N14: a fully gated recipe has an EMPTY initial_steps. */
    it('sees work held behind a gate — initial_steps empty is not an empty skill', () => {
        const s = classifyShape({
            initial_steps: [],
            stopping_points: [{ id: 'g', title: 'Send it?', options: { '1': { steps: [step('send', { tool: 'send_email', side_effecting: true })] } } }],
        });
        expect(s.shape).toBe('single');
        expect(s.gated).toBe(true);
        expect(s.sideEffecting).toBe(true);
    });
    /** The corpus bug: hand-authored skills number their options freely. */
    it('reads steps from options other than "1"', () => {
        const s = classifyShape({
            stopping_points: [{ id: 'p', title: 'Pick', options: { '2': { steps: [step('a'), step('b')] }, '3': { steps: [step('c')] } } }],
        });
        expect(s.shape).toBe('chain');
        expect(s.steps).toBe(2); // the richest branch, not the union of 3
    });
    it('a menu with no tool steps is a menu, not an empty skill', () => {
        const s = classifyShape({ stopping_points: [{ id: 'p', title: 'Pick', options: { '1': { label: 'A' }, '2': { label: 'B' } } }] });
        expect(s.shape).toBe('menu');
    });
    it('a skeleton with nothing in it is empty', () => {
        expect(classifyShape({ _skeleton: true, stopping_points: [] }).shape).toBe('empty');
    });
    it('never throws on junk — the catalog must render whatever is on disk', () => {
        for (const junk of [null, undefined, 42, 'nope', [], { initial_steps: 'not-an-array' }, { stopping_points: [null] }]) {
            expect(() => classifyShape(junk)).not.toThrow();
        }
    });
    it('every shape has a label and a glyph', () => {
        const all = ['empty', 'menu', 'single', 'chain', 'fan', 'fan+check', 'cycle'];
        for (const s of all) {
            expect(shapeLabel(s).length).toBeGreaterThan(0);
            expect(shapeGlyph(s).length).toBeGreaterThan(0);
        }
    });
});
describe('the real skill corpus', () => {
    const root = path.resolve(__dirname, '../../../..');
    const files = execSync(`find ${root}/skills -name actions.json`, { encoding: 'utf8' })
        .trim().split('\n').filter(Boolean);
    it('has skills to classify at all (a corpus test that finds nothing proves nothing)', () => {
        expect(files.length).toBeGreaterThan(20);
    });
    it('classifies every skill on disk without throwing', () => {
        for (const f of files) {
            let a;
            try {
                a = JSON.parse(readFileSync(f, 'utf8'));
            }
            catch {
                continue;
            }
            expect(() => classifyShape(a)).not.toThrow();
        }
    });
    it('agrees with ground truth: a skill with tool steps is never empty or menu', () => {
        let withSteps = 0;
        for (const f of files) {
            let a;
            try {
                a = JSON.parse(readFileSync(f, 'utf8'));
            }
            catch {
                continue;
            }
            const hasSteps = Boolean(a.initial_steps?.length) || (a.stopping_points ?? []).some((sp) => Object.values(sp?.options ?? {}).some((o) => o?.steps?.length));
            const shape = classifyShape(a).shape;
            if (hasSteps) {
                withSteps += 1;
                expect(shape, `${f} has steps but classified ${shape}`).not.toBe('empty');
                expect(shape, `${f} has steps but classified ${shape}`).not.toBe('menu');
            }
            else {
                expect(shape, `${f} has no steps but classified ${shape}`).toMatch(/^(empty|menu)$/);
            }
        }
        expect(withSteps).toBeGreaterThan(10);
    });
});
