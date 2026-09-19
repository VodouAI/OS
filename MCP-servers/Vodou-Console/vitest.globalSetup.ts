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
import { mkdtempSync, existsSync, rmSync, copyFileSync, readdirSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs';
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

/**
 * `.vodou` is linked ENTRY BY ENTRY, minus its sockets — never as one symlink.
 *
 * The databases were never the only door into production. `.vodou/daemon.sock`
 * is the live engine, and it writes the live `vodou-core.db` on its own. With
 * `.vodou` symlinked whole, `<shadow>/.vodou/daemon.sock` WAS that socket, so
 * every in-process `daemonRequest` a test made reached the real daemon — the
 * cloned databases isolated the test's own writes and nothing the engine did on
 * its behalf. Found 2026-09-14 in the Open loops tab: 14 "post to #daily?"
 * parked questions from `graph-runs.test.ts` fixtures (`parks`, `died`, `reask`,
 * …), one batch per full run, none of whose runs exist in the live graph_runs.
 * Sixteen call sites open that socket, so the fix is here rather than in each.
 *
 * Without a socket an isolated test sees the daemon as DOWN, which every caller
 * already handles (it is the `kind: 'down'` fallback). Lock and pid files stay
 * linked on purpose: anything that tries `daemon ensure` from a test then finds
 * the live lock held and stands down, instead of starting a second engine
 * against the clones that teardown would orphan.
 */
function shadowDotVodou(root: string): void {
  const src = path.join(REPO, '.vodou');
  if (!existsSync(src)) return;
  const dst = path.join(root, '.vodou');
  mkdirSync(dst);
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (e.isSocket()) continue;
    try { symlinkSync(path.join(src, e.name), path.join(dst, e.name)); } catch { /* skip */ }
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
      if (entry === '.vodou') continue;            // linked below, without its sockets
      try { symlinkSync(path.join(REPO, entry), path.join(dir, entry)); } catch { /* skip */ }
    }
    shadowDotVodou(dir);
    // The console's own gateway.db lives inside a symlinked directory, so it
    // cannot be shadowed in place — GATEWAY_DB_PATH points at the clone instead.
    clone(path.join(REPO, 'MCP-servers/Vodou-Console/gateway.db'), path.join(dir, 'gateway.db'));
    clone(path.join(REPO, 'vodou-core.db'), path.join(dir, 'vodou-core.db'));
    clone(path.join(REPO, 'memory.db'), path.join(dir, 'memory.db'));

    // A root without a vodou-core.db is not a root.
    //
    // `clone()` skips silently when the source is missing — which is EVERY CI
    // runner and every fresh clone, because `*.db` is gitignored. The shadow
    // root then came out with no database while this function still announced
    // "cloned databases" and pointed VODOU_PROJECT_PATH at it. `db.ts` trusts
    // that variable only when the directory holds a vodou-core.db, so it
    // IGNORED the override, fell back to the repo root and — opening
    // read-write — CREATED an empty database there. From that moment
    // `existsSync(DERIVED_ROOT/vodou-core.db)` was true, so db.ts threw for
    // every later suite: measured 2026-09-16 on run 35135174149, 99 occurrences
    // and 89 failed test files on a runner that never had a database at all.
    // The first suite to call getDb() poisoned the rest of the run.
    //
    // An empty file is enough. SQLite opens it, `hasLive()` (_live.ts) sees no
    // tables so suites needing real data skip instead of exploding, and every
    // write lands here rather than in the repo root. Only vodou-core.db needs
    // this: memory.db and thinking.db open read-only inside try/catch and
    // return null when absent, and gateway.db is created + schema-initialised
    // on demand.
    const seeded = !existsSync(path.join(dir, 'vodou-core.db'));
    if (seeded) writeFileSync(path.join(dir, 'vodou-core.db'), '');

    // `db.ts` reads both. It trusts VODOU_PROJECT_PATH only when the directory
    // actually holds a vodou-core.db — which the clone, or the seed above, does.
    // Published for `vitest.setupFile.ts`: a few files drive the LIVE gateway on
    // :8765, a process started long before this run and using the real
    // databases. Isolating only the test half of such a test splits it — see
    // that file for the failure this caused and why it cannot be sandboxed.
    process.env.VODOU_TEST_REAL_ROOT = REPO;
    process.env.VODOU_TEST_REAL_GATEWAY_DB = path.join(REPO, 'MCP-servers/Vodou-Console/gateway.db');
    process.env.VODOU_PROJECT_PATH = dir;
    process.env.GATEWAY_DB_PATH = path.join(dir, 'gateway.db');
    // Say which it was. "cloned databases" printed on a runner that cloned
    // nothing is the reassurance that kept this hidden: the line looked like
    // proof of isolation while the root it named held no database.
    console.error(
      seeded
        ? `[test-isolation] no vodou-core.db to clone (gitignored — CI or a fresh checkout); ` +
          `seeded an EMPTY one → ${dir}. Suites needing real data skip via hasLive().`
        : `[test-isolation] cloned databases → ${dir}`,
    );
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
