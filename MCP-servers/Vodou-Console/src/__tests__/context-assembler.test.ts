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
    expect(a.lanes.map((l: { lane: string }) => l.lane)).toEqual(['memory', 'tool_results']);
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
