import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BaseDefaults, GovernorInputs, TierTable } from '../src/cost-profile.js';

// Hermetic project root for the executor e2e below. The cap-consult test needs
// list_available_tools to return a catalog larger than the 500-char profile cap —
// CI has no vodou-core.db at all (catalog → short "no tools cached" message → no
// truncation → red), and locally the test must not depend on (or touch) the real
// DB. db.ts resolves VODOU_PROJECT_PATH at module load and honors it only when
// vodou-core.db already exists there, so: create + seed the scratch DB first,
// point the env at it, THEN import the modules that pull db.js.
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'cogs-gov-'));
{
  const d = new DatabaseSync(path.join(SCRATCH, 'vodou-core.db'));
  d.exec(`
    CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, name TEXT, active INTEGER DEFAULT 1, health_status TEXT);
    CREATE TABLE tools (id INTEGER PRIMARY KEY, server_id INTEGER, name TEXT, description TEXT, enabled INTEGER DEFAULT 1);
  `);
  d.prepare("INSERT INTO mcp_servers (id, name, active, health_status) VALUES (1, 'seed-server', 1, 'healthy')").run();
  const ins = d.prepare('INSERT INTO tools (server_id, name, description) VALUES (1, ?, ?)');
  for (let i = 0; i < 40; i++) {
    ins.run(`seeded_tool_${String(i).padStart(2, '0')}`, `Deterministic catalog filler tool ${i} so the truncation cap test has >500 chars to cut`);
  }
  d.close();
}
process.env.VODOU_PROJECT_PATH = SCRATCH;

const {
  deriveCostProfile, classifyTier, DEFAULT_TIER_TABLE,
  setCostProfile, getCostProfile, clearCostProfile, governorEnabled,
  __clearAllCostProfilesForTest,
} = await import('../src/cost-profile.js');
const { executeOITool } = await import('../src/executor.js');

// COGS Governor (PLANS/0.6.5/PLAN-COGS-GOVERNOR.md): the cost envelope derived from the quota
// signal, and the knob-consult wiring. Pure logic is fully deterministic; the executor consult
// is exercised end-to-end through executeOITool.

const BASE: BaseDefaults = {
  stablePrefix: true, rollingSummary: true,
  maxToolIterations: 10, maxTokens: 8096, turnTokenBudget: 0, toolResultCap: 16000,
};
const q = (over: Partial<GovernorInputs>): GovernorInputs => ({
  managed: true, planId: 'pro', status: 'ok', degraded: false,
  tokensRemaining: 100, monthlyTokenLimit: 100, ...over,
});

describe('COGS governor — deriveCostProfile (tiers)', () => {
  it('paid + ok → base defaults (NEVER tightens the healthy path)', () => {
    const p = deriveCostProfile(q({ planId: 'pro', status: 'ok' }), BASE);
    expect(p).toMatchObject({ maxToolIterations: 10, maxTokens: 8096, turnTokenBudget: 0, toolResultCap: 16000, rollingSummary: true });
    expect(p.label).toBe('pro:ok');
  });

  it('free → tight envelope', () => {
    const p = deriveCostProfile(q({ planId: 'free', monthlyTokenLimit: 0 }), BASE);
    expect(p.maxToolIterations).toBe(5);
    expect(p.turnTokenBudget).toBe(80_000);
    expect(p.toolResultCap).toBe(8_000);
    expect(p.maxTokens).toBe(4_096);
    expect(p.rollingSummary).toBe(false);
    expect(p.label).toBe('free:free');
  });

  it('warning (near limit, any plan) → glide-path', () => {
    const p = deriveCostProfile(q({ planId: 'pro', status: 'warning' }), BASE);
    expect(p.maxToolIterations).toBe(6);
    expect(p.turnTokenBudget).toBe(120_000);
    expect(p.toolResultCap).toBe(10_000);
    expect(p.rollingSummary).toBe(false);
    expect(p.label).toBe('pro:warning');
  });

  it('low (paid, <15% remaining) → mid envelope', () => {
    const p = deriveCostProfile(q({ planId: 'pro', status: 'ok', tokensRemaining: 5, monthlyTokenLimit: 100 }), BASE);
    expect(p.maxToolIterations).toBe(8);
    expect(p.turnTokenBudget).toBe(180_000);
    expect(p.label).toBe('pro:low');
  });

  it('degraded (transient/outage) → base, never punished', () => {
    const p = deriveCostProfile(q({ planId: 'free', status: 'warning', degraded: true }), BASE);
    expect(p).toMatchObject({ maxToolIterations: 10, turnTokenBudget: 0, toolResultCap: 16000 });
    expect(p.label).toBe('degraded');
  });

  it('unmanaged (BYOK) → base', () => {
    const p = deriveCostProfile(q({ managed: false }), BASE);
    expect(p).toMatchObject({ maxToolIterations: 10, turnTokenBudget: 0 });
    expect(p.label).toBe('unmanaged');
  });

  it('stablePrefix is NEVER tier-varied (caching is a pure win)', () => {
    for (const status of ['ok', 'warning', 'exceeded'] as const) {
      expect(deriveCostProfile(q({ status }), BASE).stablePrefix).toBe(BASE.stablePrefix);
      expect(deriveCostProfile(q({ ...{ stablePrefix: false } as any, status }), { ...BASE, stablePrefix: false }).stablePrefix).toBe(false);
    }
  });

  it('honors a custom tier table (env-override mechanism)', () => {
    const table: TierTable = { ...DEFAULT_TIER_TABLE, free: { maxToolIterations: 2, turnTokenBudget: 1000 } };
    const p = deriveCostProfile(q({ planId: 'free', monthlyTokenLimit: 0 }), BASE, table);
    expect(p.maxToolIterations).toBe(2);
    expect(p.turnTokenBudget).toBe(1000);
    expect(p.toolResultCap).toBe(BASE.toolResultCap); // unspecified knob falls back to base
  });
});

describe('COGS governor — server envelope (Option B) precedence', () => {
  it('server envelope wins over the tier table, per knob', () => {
    const p = deriveCostProfile(q({ planId: 'free', monthlyTokenLimit: 0, serverEnvelope: { maxToolIterations: 3, turnTokenBudget: 50000 } }), BASE);
    expect(p.maxToolIterations).toBe(3);     // from server envelope
    expect(p.turnTokenBudget).toBe(50000);   // from server envelope
    expect(p.toolResultCap).toBe(8000);      // omitted → free-tier default
    expect(p.label).toBe('free:free+env');
  });

  it('applies to a paid ok turn too (packages own their envelope)', () => {
    const p = deriveCostProfile(q({ planId: 'pro', status: 'ok', serverEnvelope: { rollingSummary: false, toolResultCap: 12000 } }), BASE);
    expect(p.rollingSummary).toBe(false);
    expect(p.toolResultCap).toBe(12000);
    expect(p.maxToolIterations).toBe(10);    // omitted → base (ok tier)
    expect(p.label).toBe('pro:ok+env');
  });

  it('ignores non-number/bool and missing keys (falls back)', () => {
    const p = deriveCostProfile(q({ planId: 'free', monthlyTokenLimit: 0, serverEnvelope: { maxToolIterations: 'lots' as any, maxTokens: null as any } }), BASE);
    expect(p.maxToolIterations).toBe(5);     // bad value → free default
    expect(p.maxTokens).toBe(4096);          // null → free default
  });

  it('degraded / unmanaged still ignore the server envelope (base)', () => {
    expect(deriveCostProfile(q({ degraded: true, serverEnvelope: { maxToolIterations: 1 } }), BASE).maxToolIterations).toBe(10);
    expect(deriveCostProfile(q({ managed: false, serverEnvelope: { maxToolIterations: 1 } }), BASE).maxToolIterations).toBe(10);
  });
});

describe('COGS governor — classifyTier boundaries', () => {
  it('exceeded folds into warning (tighten), free needs no allowance', () => {
    expect(classifyTier(q({ status: 'exceeded' }))).toBe('warning');
    expect(classifyTier(q({ planId: 'free', monthlyTokenLimit: 0 }))).toBe('free');
    expect(classifyTier(q({ planId: 'pro', tokensRemaining: 14, monthlyTokenLimit: 100 }))).toBe('low');  // 14% < 15%
    expect(classifyTier(q({ planId: 'pro', tokensRemaining: 50, monthlyTokenLimit: 100 }))).toBe('ok');
  });
});

describe('COGS governor — profile map + flag', () => {
  beforeEach(() => __clearAllCostProfilesForTest());
  afterEach(() => { __clearAllCostProfilesForTest(); delete process.env.VODOU_COGS_GOVERNOR; });

  it('set/get/clear roundtrip; get(undefined) → undefined', () => {
    expect(getCostProfile('c1')).toBeUndefined();
    setCostProfile('c1', deriveCostProfile(q({ planId: 'free', monthlyTokenLimit: 0 }), BASE));
    expect(getCostProfile('c1')?.label).toBe('free:free');
    expect(getCostProfile(undefined)).toBeUndefined();
    clearCostProfile('c1');
    expect(getCostProfile('c1')).toBeUndefined();
  });

  it('governorEnabled reflects VODOU_COGS_GOVERNOR', () => {
    delete process.env.VODOU_COGS_GOVERNOR; expect(governorEnabled()).toBe(false);
    process.env.VODOU_COGS_GOVERNOR = '1'; expect(governorEnabled()).toBe(true);
  });
});

describe('COGS governor — executor cap consult (end-to-end)', () => {
  beforeEach(() => __clearAllCostProfilesForTest());
  afterEach(() => __clearAllCostProfilesForTest());

  it('a profile toolResultCap lowers the inline truncation for a real tool result', async () => {
    const conv = 'gov-cap-test';
    setCostProfile(conv, { ...deriveCostProfile(q({ planId: 'free', monthlyTokenLimit: 0 }), BASE), toolResultCap: 500 });
    const r = await executeOITool('list_available_tools', {}, { conversationId: conv });
    // catalog is large; with a 500-char profile cap it must truncate + emit the expand handle.
    expect(r.output.includes('call expand_result with id=')).toBe(true);
    expect(r.output).toMatch(/showing first 500 of \d+ chars/);
  });

  it('with NO profile, the base 16000 cap applies (no governor effect)', async () => {
    const r = await executeOITool('list_available_tools', {}, { conversationId: 'gov-none' });
    // either under base cap (no truncation) or truncated at 16000 — never at a smaller governor cap
    if (r.output.includes('truncated')) expect(r.output).toMatch(/showing first 16000 of/);
  });
});
