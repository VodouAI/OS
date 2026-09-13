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
  const dir = mkdtempSync(path.join(tmpdir(), `vodou-${label}-`));
  const fresh = new Set(['.vodou', ...priv]);
  for (const entry of readdirSync(base)) {
    if (fresh.has(entry)) continue;
    try { symlinkSync(path.join(base, entry), path.join(dir, entry)); } catch { /* skip */ }
  }
  for (const entry of fresh) mkdirSync(path.join(dir, entry), { recursive: true });

  if (!existsSync(path.join(dir, 'vodou-core.db'))) {
    // No clone to inherit — a fresh checkout or CI. Leaving the override in
    // place would make `db.ts` ignore it and reach for a database that is not
    // there either; clearing it keeps the harness's own resolution.
    return base;
  }
  process.env.VODOU_PROJECT_PATH = dir;
  return dir;
}
