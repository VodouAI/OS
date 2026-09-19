/**
 * A private PROJECT ROOT for a suite that writes outside the databases.
 *
 * `vitest.globalSetup.ts` already shadows the three databases — it symlinks
 * every entry of the real root and overwrites the `.db` names with clones. That
 * covers a suite whose writes land in SQLite. It does NOT cover a suite that
 * writes files: `.vodou/workspace` in the shadow root is a symlink to the real
 * one, so a route that renders a workspace writes into the live tree.
 *
 * The tempting fix — `process.env.VODOU_PROJECT_PATH = mkdtempSync(...)` — is
 * the trap `db.ts` documents and `project-root-fallback.test.ts` now guards.
 * An empty directory holds no `vodou-core.db`, so the override is IGNORED and
 * the REAL database is used. On 2026-09-12 a suite did that and its
 * `beforeEach` DELETE wiped all 28 live scheduled tasks.
 *
 * So: build a root that is a root. Symlink what the harness gives us — which
 * includes its CLONED `vodou-core.db`, so the override is honoured — and give
 * the suite its own `.vodou` to write into.
 *
 * Call it BEFORE importing anything that reads the root; `db.ts` resolves once,
 * at module load.
 */
import { mkdtempSync, mkdirSync, readdirSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Point `VODOU_PROJECT_PATH` at a private root and return it. `private` names
 * directories the suite gets fresh rather than symlinked (`.vodou` always).
 */
export function useShadowRoot(label: string, priv: string[] = []): string {
  const base = process.env.VODOU_PROJECT_PATH
    || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');
  // ALWAYS a directory this function created. Every caller deletes what it gets
  // back — `rmSync(TMP, { recursive: true, force: true })` in `afterAll` — so
  // returning anything else is an `rm -rf` of somebody else's tree. The old
  // no-clone path returned `base`, and with VODOU_PROJECT_PATH unset `base` is
  // the REPO ROOT: on a checkout with no vodou-core.db (CI, a fresh clone) these
  // three suites would have deleted the repository. This machine escaped only
  // because its repo root happens to hold a database. That is the same trap as
  // the 2026-09-12 incident in the header, pointed the other way.
  const dir = mkdtempSync(path.join(tmpdir(), `vodou-${label}-`));
  const fresh = new Set(['.vodou', ...priv]);

  // The base can be GONE. `vitest.globalSetup.ts` publishes its shadow root in
  // VODOU_PROJECT_PATH and `teardown()` rmSyncs it, and a suite that imports
  // outside that window (or a runner where setup bailed) inherits a path to
  // nothing. `readdirSync` then threw ENOENT at import — before any test ran,
  // before any skip could fire — which is how onboarding-missing-name,
  // onboarding-timezone and console-two all failed in CI with "no tests".
  // Nothing to mirror is not an error: the suite gets a bare private root.
  if (existsSync(base)) {
    for (const entry of readdirSync(base)) {
      if (fresh.has(entry)) continue;
      try { symlinkSync(path.join(base, entry), path.join(dir, entry)); } catch { /* skip */ }
    }
  }
  for (const entry of fresh) mkdirSync(path.join(dir, entry), { recursive: true });

  if (!existsSync(path.join(dir, 'vodou-core.db'))) {
    // No clone to inherit — a fresh checkout or CI. Setting the override would
    // make `db.ts` ignore it (it trusts the variable only when the directory
    // holds a vodou-core.db) so leave the harness's own resolution alone. The
    // caller still gets its private, deletable directory to write into.
    return dir;
  }
  process.env.VODOU_PROJECT_PATH = dir;
  return dir;
}
