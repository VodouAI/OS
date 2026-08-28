/**
 * PLAN-CONTEXT-COORDINATION P8/P0 — assembleContext behaviour.
 *
 * The §3.2 bug this guards: the strip "tool results are already in
 * <active_context>" ran whenever oiResults was non-empty — including when
 * oiResults was a REPLAYED measurement from a previous turn. Then a fresh
 * daemon auto-route landed in memoryContext, got stripped as "duplicate", and
 * the model saw the stale reading. P0 makes replay skills-only, so a non-empty
 * oiResults is THIS turn's output and the strip's premise is always true.
 */
import { describe, it, expect } from 'vitest';
import { assembleContext } from '../llm.js';
const FRESH = '### Vodou Tool Results (auto-routed)\n\ncpu: 12%';
const conv = 'test:asm-' + process.pid;
describe('assembleContext', () => {
    it('fresh tool output rides in userPrefix inside <active_context>, and the duplicate is stripped from memory', async () => {
        const a = await assembleContext({ conversationId: conv, memoryContext: 'facts\n\n' + FRESH, oiResults: 'cpu: 12%', lensesEnabled: false, prefixOnly: true });
        expect(a.userPrefix).toContain('<active_context>\ncpu: 12%\n</active_context>');
        expect(a.injected).toBe('facts');
        expect(a.systemPrompt.endsWith('\n\n---\n\nfacts')).toBe(true);
        expect(a.lanes.map((l) => l.lane)).toEqual(['memory', 'tool_results']);
    });
    it('§3.2: an auto-routed measurement with NO active_context is never stripped', async () => {
        const a = await assembleContext({ conversationId: conv, memoryContext: 'facts\n\n' + FRESH, oiResults: '', lensesEnabled: false, prefixOnly: true });
        expect(a.injected).toContain('cpu: 12%');
        expect(a.userPrefix).toBe('');
    });
    it('a skill is labelled as instructions; headless changes the label, not the wrap', async () => {
        const skill = '# SKILL: deep-think\n1. think';
        const menu = await assembleContext({ conversationId: conv, memoryContext: '', oiResults: skill, lensesEnabled: false, prefixOnly: true });
        const head = await assembleContext({ conversationId: conv, memoryContext: '', oiResults: skill, lensesEnabled: false, prefixOnly: true, headless: true });
        expect(menu.userPrefix).toMatch(/Display the first stopping point menu and STOP/);
        expect(head.userPrefix).toMatch(/running HEADLESS/);
        expect(menu.lanes[0].lane).toBe('skill');
    });
    it("legacy lane-6 style reproduces the API family's historical wrap", async () => {
        const a = await assembleContext({ conversationId: conv, memoryContext: '', oiResults: 'x', lensesEnabled: false, prefixOnly: true, lane6Style: 'legacy' });
        expect(a.userPrefix).toMatch(/^(<oi_results>|OI execution results:)/);
        expect(a.userPrefix).not.toContain('<active_context>');
    });
    it('the frozen prefix never contains memory (STABLE_PREFIX placement)', async () => {
        const a = await assembleContext({ conversationId: conv, memoryContext: 'volatile-facts', oiResults: '', lensesEnabled: false, prefixOnly: true });
        expect(a.staticPrefix).not.toContain('volatile-facts');
        expect(a.injected).toBe('volatile-facts');
    });
});
// ── P9 (PLAN-CONTEXT-COORDINATION §20.3, 2026-08-28) ────────────────────────
// The three side doors, as behaviour. The gate test proves the copies are gone;
// these prove the seam does what the copies did, plus records it.
describe('P9 — the side doors, closed', () => {
    it('a skill turn is assembled here and leaves a skill lane', async () => {
        const { assembleContext } = await import('../llm.js');
        const conv = 'p9-skill-' + Math.random().toString(36).slice(2);
        const a = await assembleContext({
            conversationId: conv, memoryContext: 'remembered: the dog is Lucy',
            oiResults: '', lensesEnabled: false,
            skillSystemPromptOverride: '--- SKILL CONTENT ---\nstep 1\n--- END SKILL ---',
        });
        // byte shape preserved from the five copies: memory, ---, skill prompt
        expect(a.systemPrompt).toBe('remembered: the dog is Lucy\n\n---\n\n--- SKILL CONTENT ---\nstep 1\n--- END SKILL ---');
        const names = a.lanes.map(l => l.lane);
        expect(names).toContain('skill');
        expect(names).toContain('memory');
        // and the receipt can tell it apart from a turn that ran nothing
        expect(a.lanes.find(l => l.lane === 'skill').state).toBe('ran');
    });
    it('ground truth is its own lane and is not charged to memory', async () => {
        const { assembleContext } = await import('../llm.js');
        const conv = 'p9-gt-' + Math.random().toString(36).slice(2);
        const gt = '─── VODOU GROUND TRUTH ───\nbranch: main';
        const a = await assembleContext({
            conversationId: conv, memoryContext: 'a memory chunk', oiResults: '',
            lensesEnabled: false, groundTruth: gt, groundTruthPlacement: 'system',
        });
        const mem = a.lanes.find(l => l.lane === 'memory');
        const gtLane = a.lanes.find(l => l.lane === 'ground_truth');
        expect(gtLane, 'ground_truth must be recorded').toBeTruthy();
        expect(gtLane.chars).toBe(gt.length);
        // the mis-attribution this phase ends: memory's chars are memory's alone
        expect(mem.chars).toBe('a memory chunk'.length);
        // and it is placed AHEAD of memory, where "THIS BLOCK WINS" belongs
        expect(a.injected.indexOf(gt)).toBeLessThan(a.injected.indexOf('a memory chunk'));
    });
    it('ground truth rides the user prefix for the CLI families', async () => {
        const { assembleContext } = await import('../llm.js');
        const conv = 'p9-gtu-' + Math.random().toString(36).slice(2);
        const a = await assembleContext({
            conversationId: conv, memoryContext: '', oiResults: '', lensesEnabled: false,
            prefixOnly: true, groundTruth: 'branch: main', groundTruthPlacement: 'user',
        });
        expect(a.userPrefix).toContain('<vodou_ground_truth>');
        expect(a.injected, 'must not also be in the system prompt').not.toContain('branch: main');
        expect(a.lanes.find(l => l.lane === 'ground_truth').state).toBe('ran (user prompt)');
    });
    it('scope and workbench instructions are lanes with a budget', async () => {
        const { assembleContext } = await import('../llm.js');
        const conv = 'p9-scope-' + Math.random().toString(36).slice(2);
        const scope = { raw: 'workbench:integration:testco', type: 'integration', id: 'testco' };
        const a = await assembleContext({
            conversationId: conv, memoryContext: '', oiResults: '', lensesEnabled: false, scope,
        });
        const names = a.lanes.map((l) => l.lane);
        expect(names, 'the scope suffix must be recorded').toContain('scope');
        // the suffix is really in the prompt, not just on the receipt
        expect(a.systemPrompt.length).toBeGreaterThan(a.staticPrefix.length);
    });
});
