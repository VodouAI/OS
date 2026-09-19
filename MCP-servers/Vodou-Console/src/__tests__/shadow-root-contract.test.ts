/**
 * `useShadowRoot` must never hand back a directory it did not create.
 *
 * Every caller deletes what it gets:
 *
 *     const TMP = useShadowRoot('…');
 *     afterAll(() => rmSync(TMP, { recursive: true, force: true }));
 *
 * so the return value is an `rm -rf` target. The original no-clone path returned
 * `base` — and with `VODOU_PROJECT_PATH` unset, `base` is the REPO ROOT. On a
 * checkout whose root has no `vodou-core.db` (CI, a fresh clone, anyone who has
 * not run the engine yet) console-two, onboarding-timezone and
 * onboarding-missing-name would each have deleted the repository on the way out.
 * The only reason it never fired on a dev machine is that a dev machine's root
 * happens to hold a database.
 *
 * The second property is the one CI actually hit: the base can be GONE.
 * `vitest.globalSetup.ts` publishes its shadow root in `VODOU_PROJECT_PATH` and
 * `teardown()` removes it, so a suite importing outside that window inherits a
 * path to nothing. `readdirSync(base)` threw ENOENT at module load — before any
 * test ran and before any skip could fire — which is why all three suites
 * reported "no tests" rather than a failure anyone could read.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { useShadowRoot } from './_shadow-root.js';

const made: string[] = [];
const savedEnv = process.env.VODOU_PROJECT_PATH;

afterEach(() => {
  for (const d of made.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  if (savedEnv === undefined) delete process.env.VODOU_PROJECT_PATH;
  else process.env.VODOU_PROJECT_PATH = savedEnv;
});

function track(p: string): string { made.push(p); return p; }

describe('useShadowRoot never returns a directory it did not create', () => {
  it('returns its own temp dir when the base has no vodou-core.db', () => {
    // The destructive case: pre-fix this returned `base` itself.
    const base = track(mkdtempSync(path.join(tmpdir(), 'sr-base-')));
    writeFileSync(path.join(base, 'README.md'), 'a repo that must survive\n');
    process.env.VODOU_PROJECT_PATH = base;

    const got = track(useShadowRoot('contract-noclone'));

    expect(got).not.toBe(base);
    expect(path.basename(got)).toMatch(/^vodou-contract-noclone-/);
    // What the caller's afterAll would do — the base must be untouched by it.
    rmSync(got, { recursive: true, force: true });
    expect(existsSync(base), 'deleting the returned path must not delete the base').toBe(true);
    expect(existsSync(path.join(base, 'README.md'))).toBe(true);
  });

  it('returns its own temp dir when the base HAS a vodou-core.db', () => {
    const base = track(mkdtempSync(path.join(tmpdir(), 'sr-base-')));
    writeFileSync(path.join(base, 'vodou-core.db'), '');   // enough to be "a root"
    process.env.VODOU_PROJECT_PATH = base;

    const got = track(useShadowRoot('contract-clone'));

    expect(got).not.toBe(base);
    expect(process.env.VODOU_PROJECT_PATH).toBe(got);      // override adopted only here
  });

  it('survives a base that no longer exists, rather than throwing at import', () => {
    // The CI failure: globalSetup published a shadow root and teardown removed
    // it. Pre-fix this was ENOENT from readdirSync and the whole file collected
    // zero tests.
    const gone = mkdtempSync(path.join(tmpdir(), 'vodou-test-'));
    rmSync(gone, { recursive: true, force: true });
    process.env.VODOU_PROJECT_PATH = gone;

    let got = '';
    expect(() => { got = track(useShadowRoot('contract-gone')); }).not.toThrow();
    expect(existsSync(got)).toBe(true);
    expect(existsSync(path.join(got, '.vodou'))).toBe(true);   // still a usable root
  });

  it('gives the suite a private .vodou even when it mirrors a populated base', () => {
    const base = track(mkdtempSync(path.join(tmpdir(), 'sr-base-')));
    mkdirSync(path.join(base, '.vodou'));
    writeFileSync(path.join(base, '.vodou', 'live.txt'), 'must not be reachable\n');
    writeFileSync(path.join(base, 'somefile.txt'), 'mirrored\n');
    process.env.VODOU_PROJECT_PATH = base;

    const got = track(useShadowRoot('contract-private'));

    expect(existsSync(path.join(got, 'somefile.txt'))).toBe(true);          // mirrored
    expect(existsSync(path.join(got, '.vodou', 'live.txt'))).toBe(false);   // NOT mirrored
  });
});
