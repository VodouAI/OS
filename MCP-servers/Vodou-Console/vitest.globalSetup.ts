/**
 * Every test run gets its OWN databases, cloned from the real ones.
 *
 * WHY. Two consecutive full runs failed on DIFFERENT files — `graph-plan` once,
 * then `conversation-restore` + `library-e2e` — and every one passes standalone.
 * Failures that ROTATE are not three flaky tests; they are contention on shared
 * state. Eleven test files write to the live gateway.db / vodou-core.db, and on
 * 2026-08-30 one of them put 36 fixture rows into the production turn log the
 * moment an emitter was added to a hot path (SEAMS §55).
 *
 * A red in a suite like that is ambiguous, and an ambiguous red is one people
 * stop reading.
 *
 * WHY CLONE RATHER THAN MOCK. Tests here assert on REAL registry contents —
 * `graph-plan` expects `google-calendar` / `list-events` to resolve, `library-e2e`
 * needs actual documents. An empty fixture database would fail them for the
 * wrong reason. They need the real data and must not be able to change it.
 *
 * WHY IT IS AFFORDABLE. The three files are 837 MB together, far too much to
 * copy per run. On APFS `cp -c` is a COPY-ON-WRITE clone: measured at **6 ms for
 * the 545 MB memory.db**, sharing blocks until something writes. Each run gets a
 * private, complete, instantaneous copy. Where clonefile is unavailable the flag
 * fails and we fall back to a real copy — slower, still correct — and if even
 * that fails we say so loudly and run against the live files rather than
 * silently pretending to be isolated.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, copyFileSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = path.resolve(__dirname, '../..');
// The WAL and shared-memory sidecars matter: a database cloned without its -wal
// can be missing its newest committed rows.
const SUFFIXES = ['', '-wal', '-shm'];
// Shadowed by a clone, never symlinked — these are the files tests may write.
//
// The SIDECARS matter as much as the database. The first version listed only
// the bare names, so `vodou-core.db-wal` and `-shm` were symlinked to the LIVE
// files; `cp -c` then refused ("are identical") and the shadow root held a real
// database beside somebody else's WAL. SQLite could not open it (error 14), the
// suites that need it silently SKIPPED rather than failed — and a write that
// had landed would have gone straight through the symlink into production.
const DB_STEMS = ['vodou-core.db', 'memory.db'];
const isDbFile = (name: string) => DB_STEMS.some((d) => name === d || name.startsWith(d + '-'));

let dir: string | null = null;

function clone(src: string, dst: string): void {
  for (const s of SUFFIXES) {
    if (!existsSync(src + s)) continue;
    try {
      execFileSync('cp', ['-c', src + s, dst + s], { stdio: 'ignore' });
    } catch {
      copyFileSync(src + s, dst + s); // no clonefile here — copy for real
    }
  }
}

export function setup(): void {
  if (process.env.VODOU_TEST_NO_ISOLATION === '1') {
    console.error(
      '[test-isolation] DISABLED by VODOU_TEST_NO_ISOLATION — writing to the LIVE databases',
    );
    return;
  }
  try {
    dir = mkdtempSync(path.join(tmpdir(), 'vodou-test-'));

    // A SHADOW ROOT, not a bare directory of databases.
    //
    // `VODOU_PROJECT_PATH` is the PROJECT ROOT, not a database location. Setting
    // it to a directory holding only clones made things worse, not better: 10
    // failures instead of 2, because `skill-kind-p2` compares the registry
    // against `skills/` on disk and correctly reported all 148 rows as orphans.
    // The database moved and everything else the root provides did not.
    //
    // So: symlink every entry of the real root, then overwrite the three
    // database names with clones. Reads see the whole project; writes to a
    // database land in a private copy. Costs one symlink per top-level entry.
    for (const entry of readdirSync(REPO)) {
      if (isDbFile(entry)) continue;               // cloned below — sidecars too
      try { symlinkSync(path.join(REPO, entry), path.join(dir, entry)); } catch { /* skip */ }
    }
    // The console's own gateway.db lives inside a symlinked directory, so it
    // cannot be shadowed in place — GATEWAY_DB_PATH points at the clone instead.
    clone(path.join(REPO, 'MCP-servers/Vodou-Console/gateway.db'), path.join(dir, 'gateway.db'));
    clone(path.join(REPO, 'vodou-core.db'), path.join(dir, 'vodou-core.db'));
    clone(path.join(REPO, 'memory.db'), path.join(dir, 'memory.db'));

    // `db.ts` reads both. It trusts VODOU_PROJECT_PATH only when the directory
    // actually holds a vodou-core.db — which the clone does.
    // Published for `vitest.setupFile.ts`: a few files drive the LIVE gateway on
    // :8765, a process started long before this run and using the real
    // databases. Isolating only the test half of such a test splits it — see
    // that file for the failure this caused and why it cannot be sandboxed.
    process.env.VODOU_TEST_REAL_ROOT = REPO;
    process.env.VODOU_TEST_REAL_GATEWAY_DB = path.join(REPO, 'MCP-servers/Vodou-Console/gateway.db');
    process.env.VODOU_PROJECT_PATH = dir;
    process.env.GATEWAY_DB_PATH = path.join(dir, 'gateway.db');
    console.error(`[test-isolation] cloned databases → ${dir}`);
  } catch (e) {
    // Loud, never silent. A run that BELIEVES it is isolated and is not is worse
    // than one that knows it is not.
    console.error('[test-isolation] FAILED to clone — tests will hit the LIVE databases:', e);
    dir = null;
  }
}

export function teardown(): void {
  if (dir) rmSync(dir, { recursive: true, force: true });
}
