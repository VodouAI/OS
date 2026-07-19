import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  __setRollingSummaryForTest,
  __clearRollingSummariesForTest,
  __rollingSummaryForTest,
} from '../src/llm.js';

// WS5 (PLAN-GATEWAY-STATE-LAYER): rolling-summary read/cache/fallback contract.
// We exercise the SYNCHRONOUS read path (no provider key needed); the background LLM
// refresh is fire-and-forget and not asserted here.

const older = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `msg ${i}` }));

beforeEach(() => __clearRollingSummariesForTest());
afterEach(() => {
  __clearRollingSummariesForTest();
  delete process.env.VODOU_ROLLING_SUMMARY;
});

describe('WS5 rollingSummaryFor', () => {
  it('flag OFF → naive summary (legacy behavior, byte-identical shape)', () => {
    delete process.env.VODOU_ROLLING_SUMMARY;
    const out = __rollingSummaryForTest('c1', older(20));
    expect(out).toContain('[Conversation Summary');
    expect(out).not.toContain('## Earlier in this conversation');
  });

  it('flag ON, no cached summary yet → naive fallback for THIS turn', () => {
    process.env.VODOU_ROLLING_SUMMARY = '1';
    const out = __rollingSummaryForTest('c2', older(20));
    expect(out).toContain('[Conversation Summary'); // falls back until the first refresh lands
  });

  it('flag ON + cached LLM summary → returns it under the "Earlier in this conversation" header', () => {
    process.env.VODOU_ROLLING_SUMMARY = '1';
    __setRollingSummaryForTest('c3', 'User is migrating the gateway to a stable cache prefix; chose bootstrap-once.', 20);
    const out = __rollingSummaryForTest('c3', older(20));
    expect(out.startsWith('## Earlier in this conversation')).toBe(true);
    expect(out).toContain('bootstrap-once');
    expect(out).not.toContain('[Conversation Summary'); // naive NOT used when a real summary exists
  });

  it('flag OFF ignores any cached summary (pure legacy path)', () => {
    delete process.env.VODOU_ROLLING_SUMMARY;
    __setRollingSummaryForTest('c4', 'cached text that must be ignored', 20);
    const out = __rollingSummaryForTest('c4', older(20));
    expect(out).toContain('[Conversation Summary');
    expect(out).not.toContain('cached text');
  });

  it('flag ON but no conversationId → naive fallback (cannot key the cache)', () => {
    process.env.VODOU_ROLLING_SUMMARY = '1';
    const out = __rollingSummaryForTest(undefined, older(20));
    expect(out).toContain('[Conversation Summary');
  });
});
