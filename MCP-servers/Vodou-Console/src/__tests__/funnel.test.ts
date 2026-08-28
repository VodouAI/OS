import { describe, it, expect, vi, beforeEach } from 'vitest';

// PLAN-EXECUTION-SHELF-FUNNEL §5 — the activation funnel.
//
// The property that matters most is FIRST-occurrence: a milestone records when the
// install first reached it and never moves. If a later call overwrote it, "time to
// activation" would silently become "time since last use" — a number that looks
// plausible, is always small, and is wrong. That is the failure this pins hardest.
//
// Second: markFunnel is called from hot paths (capture writes, inject responses).
// It must never throw. Instrumentation that can break the product it measures is
// worse than no instrumentation.

const store = new Map<string, string>();
vi.mock('../db.js', () => ({
  getSetting: (k: string) => (store.has(k) ? store.get(k)! : null),
  setSetting: (k: string, v: string) => { store.set(k, v); },
}));

const { markFunnel, getFunnel, getFunnelSummary, FUNNEL_STEPS } = await import('../funnel.js');

beforeEach(() => { store.clear(); vi.restoreAllMocks(); });

describe('funnel', () => {
  it('records a milestone with a timestamp', () => {
    markFunnel('install');
    expect(store.get('funnel.install')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps the FIRST timestamp — a later call must not overwrite it', () => {
    markFunnel('first_inject');
    const first = store.get('funnel.first_inject');
    // Any later occurrence of the same milestone…
    store.set('__probe', 'x');
    markFunnel('first_inject');
    expect(store.get('funnel.first_inject')).toBe(first);
  });

  it('never throws, even when storage is broken — hot paths must stay safe', async () => {
    vi.resetModules();
    vi.doMock('../db.js', () => ({
      getSetting: () => { throw new Error('db gone'); },
      setSetting: () => { throw new Error('db gone'); },
    }));
    const broken = await import('../funnel.js');
    expect(() => broken.markFunnel('first_capture')).not.toThrow();
    expect(() => broken.getFunnel()).not.toThrow();
  });

  it('reports every step, null until reached', () => {
    markFunnel('pair');
    const f = getFunnel();
    expect(Object.keys(f).sort()).toEqual([...FUNNEL_STEPS].sort());
    expect(f.pair).toBeTruthy();
    expect(f.first_inject).toBeNull();
  });

  it('activation is first_inject — the moment context reaches another AI', () => {
    markFunnel('install'); markFunnel('pair'); markFunnel('first_capture');
    expect(getFunnelSummary().activated).toBe(false);   // captured, but never carried
    markFunnel('first_inject');
    expect(getFunnelSummary().activated).toBe(true);
  });

  it('execution is receipt OR skill OR automation — the memory-PLUS-EXECUTION claim', () => {
    markFunnel('first_inject');
    expect(getFunnelSummary().executed).toBe(false);
    markFunnel('first_skill');
    expect(getFunnelSummary().executed).toBe(true);
  });

  it('does not enforce order — an out-of-sequence step is a finding, not a bug', () => {
    // Opening an old thread first: backfill before any live capture, no pairing yet.
    markFunnel('first_backfill');
    const s = getFunnelSummary();
    expect(s.reached).toEqual(['first_backfill']);
    expect(s.steps.pair).toBeNull();
    expect(s.steps.first_capture).toBeNull();
  });

  it('reached lists milestones in funnel order, not call order', () => {
    markFunnel('first_receipt');
    markFunnel('install');
    markFunnel('first_inject');
    expect(getFunnelSummary().reached).toEqual(['install', 'first_inject', 'first_receipt']);
  });
});

/**
 * The gap that made this necessary: `first_automation` is the milestone the
 * alpha release is defined against, it was declared in FUNNEL_STEPS, and no
 * line in the tree ever called markFunnel for it. The plans read "never fired"
 * as evidence the delivery flow was broken — the flow WAS broken, but a working
 * delivery would not have fired it either, because there was no writer.
 *
 * A funnel step with no producer is unfalsifiable: it reads "not reached"
 * forever, which is indistinguishable from a product that never works. So the
 * test is not on any one step — it is that every declared step has a writer.
 */
describe('every funnel step has a producer', () => {
  it('no step is declared without something that can mark it', async () => {
    const { readFileSync, readdirSync, statSync } = await import('fs');
    const { join, dirname } = await import('path');
    const { fileURLToPath } = await import('url');

    const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        if (e === 'node_modules' || e === '__tests__') continue;
        const full = join(dir, e);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts')) files.push(full);
      }
    };
    walk(srcDir);
    const corpus = files
      .filter((f) => !f.endsWith('funnel.ts'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');

    const orphans = FUNNEL_STEPS.filter(
      // 'pro' is marked by the billing path, which is not a funnel concern and
      // is asserted by the billing tests; everything else must be marked here.
      (step) => step !== 'pro' && !corpus.includes(`markFunnel('${step}')`),
    );
    expect(orphans).toEqual([]);
  });
});
