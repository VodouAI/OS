/**
 * PLAN-HEARTBEAT-IS-THE-BRIEFING v2 P3 — the daily throttle existed in the
 * WebSocket handler for months and never had a test. Now it is a function.
 */
import { describe, it, expect } from 'vitest';
import { shouldDeliverNow } from '../heartbeat-delivery.js';

const T0 = Date.UTC(2026, 8, 10, 9, 0, 0);
const receipt = (msAgo: number) => JSON.stringify({ timestamp: new Date(T0 - msAgo).toISOString() });

describe('heartbeat delivery throttle', () => {
  it('the first delivery always goes', () => {
    expect(shouldDeliverNow(null, 'daily', T0)).toBe(true);
  });
  it('daily suppresses the other eleven 2-hour runs and lets the next day through', () => {
    expect(shouldDeliverNow(receipt(2 * 3_600_000), 'daily', T0)).toBe(false);
    expect(shouldDeliverNow(receipt(22 * 3_600_000), 'daily', T0)).toBe(false);
    expect(shouldDeliverNow(receipt(24 * 3_600_000), 'daily', T0)).toBe(true);
  });
  it('every_4h has its own window', () => {
    expect(shouldDeliverNow(receipt(3 * 3_600_000), 'every_4h', T0)).toBe(false);
    expect(shouldDeliverNow(receipt(4 * 3_600_000), 'every_4h', T0)).toBe(true);
  });
  it('an unreadable receipt or timestamp is no receipt', () => {
    expect(shouldDeliverNow('not json', 'daily', T0)).toBe(true);
    expect(shouldDeliverNow('{"timestamp":"never"}', 'daily', T0)).toBe(true);
  });
});
