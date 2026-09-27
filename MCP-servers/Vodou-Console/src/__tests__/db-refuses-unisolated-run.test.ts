/**
 * A test run whose isolation never happened must not reach a real database.
 *
 * On 2026-09-19/20 a bare `npx vitest run` resolved a different vitest that skips
 * vitest.globalSetup.ts, and the gateway suites wrote 404 fixture messages into
 * the live gateway.db. db.ts now refuses to load under a test runner unless the
 * global setup published VODOU_TEST_REAL_ROOT (or isolation was disabled on
 * purpose). These cases re-import db.ts fresh against a throwaway root — never
 * the real one — with each combination of those signals.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const KEYS = ['VODOU_PROJECT_PATH', 'VODOU_TEST_REAL_ROOT', 'VODOU_TEST_NO_ISOLATION'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let root: string | null = null;

function fakeRoot(): string {
  root = mkdtempSync(path.join(tmpdir(), 'vodou-db-guard-'));
  writeFileSync(path.join(root, 'vodou-core.db'), '');   // "a real database is reachable"
  return root;
}

async function loadDb(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  vi.resetModules();
  return import('../db.js');
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  vi.resetModules();
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe('db.ts refuses a test run that was never isolated', () => {
  it('no global setup (VODOU_TEST_REAL_ROOT unset) → refuses to load', async () => {
    await expect(loadDb({ VODOU_PROJECT_PATH: fakeRoot() })).rejects.toThrow(/test isolation did not run/);
  });

  it('global setup ran (VODOU_TEST_REAL_ROOT set) → loads', async () => {
    const r = fakeRoot();
    await expect(loadDb({ VODOU_PROJECT_PATH: r, VODOU_TEST_REAL_ROOT: r })).resolves.toBeDefined();
  });

  it('isolation disabled on purpose (VODOU_TEST_NO_ISOLATION=1) → loads', async () => {
    await expect(loadDb({ VODOU_PROJECT_PATH: fakeRoot(), VODOU_TEST_NO_ISOLATION: '1' })).resolves.toBeDefined();
  });

  it('this run itself is isolated — the guard would have fired otherwise', () => {
    expect(saved.VODOU_TEST_REAL_ROOT, 'vitest.globalSetup.ts did not run for this suite').toBeTruthy();
  });
});
