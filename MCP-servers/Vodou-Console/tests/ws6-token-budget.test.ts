import { describe, it, expect } from 'vitest';
import { shouldCutForBudget } from '../src/llm.js';

// WS6 (PLAN-GATEWAY-STATE-LAYER): hard per-turn token-ceiling cut decision.
describe('WS6 shouldCutForBudget', () => {
  it('disabled when budget <= 0 (default / opt-in)', () => {
    expect(shouldCutForBudget(999_999, 0, 5)).toBe(false);
    expect(shouldCutForBudget(999_999, -1, 5)).toBe(false);
  });

  it('never cuts before the first tool round (iterations must be > 0)', () => {
    expect(shouldCutForBudget(500_000, 100_000, 0)).toBe(false);
    expect(shouldCutForBudget(500_000, 100_000, 1)).toBe(true);
  });

  it('cuts only once cumulative exceeds the budget', () => {
    expect(shouldCutForBudget(100_000, 100_000, 3)).toBe(false); // equal → not over
    expect(shouldCutForBudget(100_001, 100_000, 3)).toBe(true);
  });

  it('typical runaway: 250k budget catches the ~273k balloon after a few rounds', () => {
    expect(shouldCutForBudget(33_000, 250_000, 1)).toBe(false);
    expect(shouldCutForBudget(264_000, 250_000, 8)).toBe(true);
  });
});
