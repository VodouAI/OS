import { describe, it, expect } from 'vitest';
import {
  scopeDenied, isLeak, filterMemoryContext, stripLeaks, type InjectPolicy,
} from '../src/inject-policy.js';

// PLAN-FACE-OWNS-SKILLS F2 — the external-disclosure policy, enforced gateway-side.
// The Face lanes replaced `vodou-core mem context` (which enforced this in Rust) with
// a chat() turn whose daemon recall is unfiltered, so Vodou's own dev/telemetry/
// skill-deliberation chunks could ride into a third-party composer.

const POLICY: InjectPolicy = {
  scope_deny: ['capture:ide:', 'skill', 'workbench:'],
  leak_needles: ['we should only include', "but that's a personal fact"],
};

describe('scopeDenied — must match inject_select.rs exactly', () => {
  it('treats a trailing colon as a PREFIX', () => {
    expect(scopeDenied('capture:ide:claude-code', POLICY)).toBe(true);
    expect(scopeDenied('workbench:automation:7', POLICY)).toBe(true);
  });
  it('treats a bare name as an EXACT match, not a prefix', () => {
    expect(scopeDenied('skill', POLICY)).toBe(true);
    // 'skills-registry' merely STARTS WITH 'skill' — Rust would not deny it, so
    // neither may we. A guard that over-denies quietly removes real memory.
    expect(scopeDenied('skills-registry', POLICY)).toBe(false);
  });
  it('allows the ordinary scopes the Face depends on', () => {
    for (const s of ['web', 'capture:web:chatgpt', 'import:mcp', 'manual']) {
      expect(scopeDenied(s, POLICY)).toBe(false);
    }
  });
});

describe('filterMemoryContext — drop denied chunks from the injected block', () => {
  const ctx = [
    '- [memory/2026-07-17.md] User\'s dog is named Lucy',
    '- [memory/ide.md] the extractor deliberated about which chunk to keep',
    '- [memory/2026-07-28.md] Chad is married with two boys',
  ].join('\n');
  const results = [
    { chunk_scope: 'web', text: "User's dog is named Lucy" },
    { chunk_scope: 'capture:ide:claude-code', text: 'the extractor deliberated about which chunk to keep' },
    { chunk_scope: 'web', text: 'Chad is married with two boys' },
  ];

  it('removes the denied-scope line and keeps the rest', () => {
    const out = filterMemoryContext(ctx, results, POLICY);
    expect(out.removed).toBe(1);
    expect(out.text).not.toMatch(/extractor deliberated/);
    expect(out.text).toMatch(/Lucy/);
    expect(out.text).toMatch(/two boys/);
    expect(out.scopes).toContain('capture:ide:claude-code');
  });

  it('removes a leaking chunk even when its scope is allowed', () => {
    const leaky = [{ chunk_scope: 'web', text: 'we should only include the useful bits' }];
    const out = filterMemoryContext('- [m.md] we should only include the useful bits', leaky, POLICY);
    expect(out.removed).toBe(1);
    expect(out.text.trim()).toBe('');
  });

  it('is a no-op when nothing is denied', () => {
    const out = filterMemoryContext(ctx, [results[0], results[2]], POLICY);
    expect(out.removed).toBe(0);
    expect(out.text).toBe(ctx);
  });

  it('survives missing/!empty debug without dropping the context', () => {
    expect(filterMemoryContext(ctx, null, POLICY).text).toBe(ctx);
    expect(filterMemoryContext(ctx, [], POLICY).text).toBe(ctx);
  });
});

describe('stripLeaks — last line of defence on outgoing text', () => {
  it('drops only the offending paragraph', () => {
    const t = 'Your CPU is an M1 Pro.\n\nwe should only include the useful bits\n\nRunning at 27%.';
    const out = stripLeaks(t, POLICY);
    expect(out).toMatch(/M1 Pro/);
    expect(out).toMatch(/27%/);
    expect(out).not.toMatch(/only include/);
  });
  it('leaves clean text untouched, and never returns empty for an all-leak answer', () => {
    expect(stripLeaks('All good.', POLICY)).toBe('All good.');
    // Rather than deliver nothing, keep it — an empty answer reads as a broken feature.
    expect(stripLeaks('we should only include the useful bits', POLICY).length).toBeGreaterThan(0);
  });
  it('is a no-op when the config lists no needles', () => {
    const p: InjectPolicy = { scope_deny: [], leak_needles: [] };
    expect(stripLeaks('anything at all', p)).toBe('anything at all');
  });
});
