import { describe, it, expect } from 'vitest';
import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { getProjectRoot } from '../db.js';
import { daemonRequest } from '../daemon-client.js';

/**
 * An isolated test must not reach a LIVE process — not just a live database.
 *
 * The shadow root used to symlink `.vodou` whole, which made
 * `<shadow>/.vodou/daemon.sock` the real engine's socket. Every in-process
 * daemon call from a test went to production: graph-runs.test.ts alone left 14
 * fixture "parked questions" in the real Open loops list, a batch per full run.
 * The databases were cloned; the engine that writes them was not.
 *
 * Skipped when isolation is off (VODOU_TEST_NO_ISOLATION=1) — there is nothing
 * to assert then, and the run already says so loudly.
 */
const REAL_ROOT = process.env.VODOU_TEST_REAL_ROOT;

describe.skipIf(!REAL_ROOT)('test isolation reaches no live process', () => {
  it('runs against the shadow root, not the real one', () => {
    expect(path.resolve(getProjectRoot())).not.toBe(path.resolve(REAL_ROOT as string));
  });

  it('.vodou is a real directory in the shadow root, not a link to the live one', () => {
    expect(lstatSync(path.join(getProjectRoot(), '.vodou')).isSymbolicLink()).toBe(false);
  });

  it('holds a vodou-core.db, or the override is silently ignored', () => {
    // `db.ts` trusts VODOU_PROJECT_PATH only when the directory holds a
    // vodou-core.db. `clone()` skips a missing source, and `*.db` is gitignored,
    // so on CI and on a fresh checkout the shadow root came out EMPTY — the
    // override was ignored, db.ts fell back to the repo root and (opening
    // read-write) created a database there, after which it threw for every
    // later suite. 99 errors and 89 failed files on run 35135174149, none of
    // which named the real cause. The root must be a root, even when there was
    // nothing to copy into it; whether it has TABLES is hasLive()'s question,
    // not this one.
    expect(existsSync(path.join(getProjectRoot(), 'vodou-core.db'))).toBe(true);
  });

  it('carries no daemon or worker socket', () => {
    for (const sock of ['daemon.sock', 'worker.sock']) {
      expect(existsSync(path.join(getProjectRoot(), '.vodou', sock)), sock).toBe(false);
    }
  });

  it('a daemon request from an isolated test finds nothing listening', async () => {
    const r = await daemonRequest('status', {}, 2_000);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('down');
  });
});
