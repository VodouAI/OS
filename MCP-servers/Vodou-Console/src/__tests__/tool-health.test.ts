/**
 * §7 S-5 — the runtime invariant. `add_thought` returned isError on 100% of calls
 * for months and nothing noticed, because nothing counted.
 *
 * The design decision under test is CONSECUTIVE-vs-rate: a tool that fails 30% of
 * the time is usually doing its job (bad input, missing record, expired token). A
 * tool that has failed its last N calls with no success in between is broken.
 * Getting that wrong makes this either blind or noisy.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordToolResult,
  unhealthyTools,
  toolHealthSummary,
  allToolHealth,
  _resetToolHealth,
  UNHEALTHY_AFTER,
} from '../tool-health.js';

describe('tool health (S-5)', () => {
  beforeEach(() => _resetToolHealth());

  it('says nothing until a tool crosses the threshold', () => {
    for (let i = 0; i < UNHEALTHY_AFTER - 1; i++) {
      recordToolResult('Vodou-Enhanced-Thinking', 'add_thought', false, 'bind error');
    }
    expect(toolHealthSummary().ok).toBe(true);
    expect(unhealthyTools()).toHaveLength(0);
  });

  it('flags the add_thought shape: every call an error', () => {
    for (let i = 0; i < UNHEALTHY_AFTER; i++) {
      recordToolResult('Vodou-Enhanced-Thinking', 'add_thought', false, 'cannot be bound to SQLite parameter 2');
    }
    const s = toolHealthSummary();
    expect(s.ok).toBe(false);
    expect(s.unhealthy[0].tool).toBe('Vodou-Enhanced-Thinking::add_thought');
    expect(s.unhealthy[0].consecutiveFailures).toBe(UNHEALTHY_AFTER);
    expect(s.unhealthy[0].lastError).toContain('parameter 2');
    expect(s.unhealthy[0].since).toBeTruthy();
  });

  it('a FLAKY tool never trips it — one success resets the run', () => {
    // The distinction that keeps this from crying wolf.
    for (let i = 0; i < 40; i++) {
      recordToolResult('tavily', 'search', i % 4 !== 0);   // fails 75% of the time
    }
    expect(toolHealthSummary().ok).toBe(true);
  });

  it('recovers when the tool starts working again', () => {
    for (let i = 0; i < UNHEALTHY_AFTER + 3; i++) recordToolResult('srv', 'tool', false, 'boom');
    expect(toolHealthSummary().ok).toBe(false);
    recordToolResult('srv', 'tool', true);
    expect(toolHealthSummary().ok).toBe(true);
    expect(unhealthyTools()).toHaveLength(0);
  });

  it('tracks tools independently — one broken tool does not condemn the rest', () => {
    for (let i = 0; i < UNHEALTHY_AFTER; i++) recordToolResult('a', 'broken', false, 'x');
    for (let i = 0; i < 20; i++) recordToolResult('b', 'fine', true);
    const s = toolHealthSummary();
    expect(s.unhealthy).toHaveLength(1);
    expect(s.unhealthy[0].tool).toBe('a::broken');
    expect(s.tracked).toBe(2);
  });

  it('keeps lifetime totals even after recovery', () => {
    for (let i = 0; i < 3; i++) recordToolResult('s', 't', false, 'e');
    recordToolResult('s', 't', true);
    const e = allToolHealth().find((x) => x.tool === 't')!;
    expect(e.totalCalls).toBe(4);
    expect(e.totalFailures).toBe(3);
    expect(e.consecutiveFailures).toBe(0);
  });

  it('ranks the worst offender first', () => {
    for (let i = 0; i < UNHEALTHY_AFTER; i++) recordToolResult('a', 'mild', false, 'x');
    for (let i = 0; i < UNHEALTHY_AFTER * 3; i++) recordToolResult('b', 'severe', false, 'x');
    expect(unhealthyTools()[0].tool).toBe('severe');
  });
});
