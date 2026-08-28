import { describe, it, expect, afterEach } from 'vitest';
import { assembleContext, fitMemoryToBudget, fitToolResultsToBudget, laneBudgetTok, tokensOf } from '../llm.js';

// PLAN-CONTEXT-COORDINATION P4 — a fixed per-turn budget with declared priorities,
// and EVERY eviction on the lane record. Silent truncation is the failure being fixed.
const chunk = (i: number) => `- [memory/2026-08-${String(i).padStart(2, '0')}.md] fact number ${i} with enough words to cost tokens`;
const memory = ['### Relevant Memories', '> ranked, top first', '', ...Array.from({ length: 40 }, (_, i) => chunk(i + 1))].join('\n');

afterEach(() => {
  delete process.env.VODOU_CONTEXT_BUDGET_TOTAL;
  delete process.env.VODOU_CONTEXT_BUDGET_MEMORY;
  delete process.env.VODOU_CONTEXT_BUDGET_TOOL_RESULTS;
  delete process.env.VODOU_CONTEXT_BUDGET_SKILL;
});

describe('budget precedence: env > setting > default', () => {
  it('defaults are the plan table and env overrides them', () => {
    expect(laneBudgetTok('memory')).toBe(2000);
    expect(laneBudgetTok('tool_results')).toBe(1500);
    process.env.VODOU_CONTEXT_BUDGET_MEMORY = '120';
    expect(laneBudgetTok('memory')).toBe(120);
    process.env.VODOU_CONTEXT_BUDGET_MEMORY = 'nonsense';
    expect(laneBudgetTok('memory')).toBe(2000);
  });
});

describe('memory: lowest-ranked chunks go first, the header survives', () => {
  it('keeps the top of the ranking and reports what it dropped', () => {
    const fit = fitMemoryToBudget(memory, 150);
    expect(fit.text.startsWith('### Relevant Memories\n> ranked, top first')).toBe(true);
    expect(fit.text).toContain(chunk(1));
    expect(fit.text).not.toContain(chunk(40));
    expect(fit.evictedChunks).toBeGreaterThan(0);
    expect(fit.evictedTok).toBeGreaterThan(0);
    expect(tokensOf(fit.text)).toBeLessThanOrEqual(150);
    // order preserved: chunk 2 after chunk 1
    expect(fit.text.indexOf(chunk(1))).toBeLessThan(fit.text.indexOf(chunk(2)));
  });
  it('under budget is untouched — no eviction to report', () => {
    expect(fitMemoryToBudget(memory, 100_000)).toEqual({ text: memory, evictedTok: 0, evictedChunks: 0 });
  });
});

describe('tool results: cut with a marker the model can read', () => {
  it('says how much it omitted', () => {
    const big = Array.from({ length: 400 }, (_, i) => `row ${i}: ${'x'.repeat(40)}`).join('\n');
    const fit = fitToolResultsToBudget(big, 200);
    expect(fit.text).toMatch(/\[\d+ lines omitted — context budget 200 tok\]$/);
    expect(fit.evictedTok).toBeGreaterThan(0);
    expect(tokensOf(fit.text)).toBeLessThanOrEqual(220);
  });
});

describe('assembleContext carries evictions on the lane record', () => {
  it('memory over budget → evicted_tok on the memory lane; tool_results over budget → marker in userPrefix', async () => {
    process.env.VODOU_CONTEXT_BUDGET_MEMORY = '150';
    process.env.VODOU_CONTEXT_BUDGET_TOOL_RESULTS = '100';
    const big = Array.from({ length: 200 }, (_, i) => `row ${i}: ${'y'.repeat(40)}`).join('\n');
    const a = await assembleContext({ conversationId: 'p4-conv-1', memoryContext: memory, oiResults: big, lensesEnabled: false, prefixOnly: true });
    const mem = a.lanes.find(l => l.lane === 'memory')!;
    expect(mem.evicted_tok).toBeGreaterThan(0);
    expect(mem.state).toBe('ran');                       // partially injected, not dropped whole
    const tr = a.lanes.find(l => l.lane === 'tool_results')!;
    expect(tr.evicted_tok).toBeGreaterThan(0);
    expect(a.userPrefix).toContain('lines omitted — context budget 100 tok');
    expect(a.injected).toContain(chunk(1));
  });
  it('a skill is never cut — over budget it is marked and logged, injected whole', async () => {
    process.env.VODOU_CONTEXT_BUDGET_SKILL = '50';
    const skill = '# SKILL: big\n' + 'step '.repeat(500);
    const a = await assembleContext({ conversationId: 'p4-conv-2', memoryContext: '', oiResults: skill, lensesEnabled: false, prefixOnly: true });
    const sk = a.lanes.find(l => l.lane === 'skill')!;
    expect(sk.state).toBe('over_budget');
    expect(sk.evicted_tok).toBeUndefined();
    expect(a.userPrefix).toContain('step step step');
  });
  it('under budget: no evicted_tok, no state — the record is quiet when nothing happened', async () => {
    const a = await assembleContext({ conversationId: 'p4-conv-3', memoryContext: '### Relevant Memories\n' + chunk(1), oiResults: 'cpu: 12%', lensesEnabled: false, prefixOnly: true });
    for (const l of a.lanes) { expect(l.evicted_tok).toBeUndefined(); expect(l.state).toBeUndefined(); }
  });
});

// Folded in from a parallel session's unmerged context-budget.ts (2026-08-27):
// four behaviours it got right that the first shipped cut did not.
describe('folded from the parallel P4 draft', () => {
  it('an unknown lane is UNBUDGETED, not zero — a missing table entry must not evict a lane whole', () => {
    expect(laneBudgetTok('some_future_lane')).toBe(Infinity);
  });
  it('an explicit 0 means off, and is not quietly restored to the default', () => {
    process.env.VODOU_CONTEXT_BUDGET_MEMORY = '0';
    expect(laneBudgetTok('memory')).toBe(0);
  });
  it('the memory eviction is announced in the text the MODEL reads', () => {
    const mem = ['### Relevant Memories', ...Array.from({ length: 40 }, (_, i) => `- [m/${i}.md] fact ${i} padded out with several words`)].join('\n');
    const fit = fitMemoryToBudget(mem, 120);
    expect(fit.text).toMatch(/\[\d+ lower-ranked memor(y|ies) evicted — context budget 120 tok\]$/);
  });
  it('the turn total squeezes lane 6, which is the lane priority says is evicted first', async () => {
    process.env.VODOU_CONTEXT_BUDGET_TOTAL = '400';
    process.env.VODOU_CONTEXT_BUDGET_MEMORY = '300';
    const mem = ['### Relevant Memories', ...Array.from({ length: 30 }, (_, i) => `- [m/${i}.md] fact ${i} padded out with several words`)].join('\n');
    const big = Array.from({ length: 300 }, (_, i) => `row ${i}: ${'z'.repeat(40)}`).join('\n');
    const a = await assembleContext({ conversationId: 'p4-total', memoryContext: mem, oiResults: big, lensesEnabled: false, prefixOnly: true });
    // memory took its cap; lane 6 got only what the 400-tok turn total had left
    const memTok = tokensOf(a.injected);
    const lane6Tok = tokensOf(a.userPrefix);
    expect(memTok).toBeLessThanOrEqual(300);
    expect(lane6Tok).toBeLessThan(400 - memTok + 60);   // + the label's own words
    delete process.env.VODOU_CONTEXT_BUDGET_TOTAL;
  });
});
