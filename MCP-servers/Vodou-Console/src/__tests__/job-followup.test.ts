/**
 * PLAN-JOB-FOLLOWUP — a background job that outlives its turn still reports back.
 *
 * The bug this covers, from live data (gateway.db msg 76728 / vodou-core.db
 * `job_PBaNzG47WZHL`): a chat turn started a detached `blog-morning` job, signed
 * off with "Watcher armed on pid 3854; I'll read the exit code straight out of
 * the log when it lands and report…", and ended. The job exited rc=0 seven
 * minutes later. Nothing ever reached the conversation, because the `claude -p`
 * subprocess that made the promise had already died.
 *
 * These tests drive the real module against a real (throwaway) pair of SQLite
 * files — the arming path, the polling path, and the receipt — rather than
 * asserting on a re-implementation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Both DB paths must be redirected BEFORE db.js is imported: it resolves them
// at first connection and caches the handle.
const TMP = mkdtempSync(path.join(tmpdir(), 'vodou-jobwatch-'));
process.env.GATEWAY_DB_PATH = path.join(TMP, 'gateway.db');
writeFileSync(path.join(TMP, 'vodou-core.db'), '');
process.env.VODOU_PROJECT_PATH = TMP;

const { getGatewayDb } = await import('../db.js');
const jw = await import('../job-followup.js');
// P4 — the promise heuristic moved to reply-shape.ts (shared with the panel
// lane's narration guard); the behaviour it gates still lives here.
const { promisesFollowup } = await import('../reply-shape.js');

// The module under test reads vodou-core.db through db.js's `getDb()`, which
// VODOU_PROJECT_PATH above has pointed at the throwaway file. This suite owns
// that file, so it writes `script_jobs` through its OWN handle rather than
// calling `getDb()` — which would read as "needs live runtime data" to
// live-db-gate.test.ts, and it does not: it builds every row it asserts on.
const coreDb = new DatabaseSync(path.join(TMP, 'vodou-core.db'));

afterAll(() => {
  jw.stopJobWatcher();
  try { coreDb.close(); } catch { /* best-effort */ }
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

beforeAll(() => {
  coreDb.exec(`
    CREATE TABLE IF NOT EXISTS script_jobs (
      job_id TEXT PRIMARY KEY, server_name TEXT, script_name TEXT, command TEXT,
      working_directory TEXT, status TEXT, exit_code INTEGER, pid INTEGER,
      started_at TEXT DEFAULT CURRENT_TIMESTAMP, completed_at TEXT,
      output_file TEXT, error_file TEXT
    );
  `);
});

function insertJob(id: string, status: string, extra: Partial<Record<string, unknown>> = {}): void {
  coreDb.prepare(
    `INSERT OR REPLACE INTO script_jobs
       (job_id, script_name, status, exit_code, pid, started_at, completed_at, output_file, error_file)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    (extra.script_name as string) ?? 'blog-morning',
    status,
    (extra.exit_code as number) ?? null,
    3854,
    (extra.started_at as string) ?? '2026-08-27 17:59:00',
    (extra.completed_at as string) ?? null,
    (extra.output_file as string) ?? null,
    (extra.error_file as string) ?? null,
  );
}

beforeEach(() => {
  getGatewayDb().exec('DELETE FROM job_watches');
  coreDb.exec('DELETE FROM script_jobs');
});

// ---------------------------------------------------------------------------

describe('promise detection', () => {
  it('recognises the sign-offs that actually shipped', () => {
    // Verbatim tails from gateway.db assistant turns.
    expect(promisesFollowup(
      "Watcher armed on pid 3854; I'll read the exit code straight out of the log when it lands and report in the exit-code vocabulary.",
    )).toBe(true);
    expect(promisesFollowup('Core build + all the new tests, still compiling in the background; I\'ll report when they land.')).toBe(true);
    expect(promisesFollowup('Watching it in the background.')).toBe(true);
  });

  it('does not fire on an ordinary answer', () => {
    expect(promisesFollowup('Pushed as `20312219`. That is the whole change.')).toBe(false);
    expect(promisesFollowup('The exit code was 0 and the draft is on disk.')).toBe(false);
  });
});

describe('naive-UTC parsing (PLAN-TIME-CANON)', () => {
  it('reads a SQLite CURRENT_TIMESTAMP as UTC, not local', () => {
    // The `-240m -55s` elapsed the console kept reporting came from parsing
    // these instants as local time. 17:59:00Z is exactly 1_787_162_340_000.
    expect(jw.parseNaiveUtc('2026-08-27 17:59:00')).toBe(Date.UTC(2026, 7, 27, 17, 59, 0));
    expect(jw.parseNaiveUtc(null)).toBeNull();
    expect(jw.parseNaiveUtc('not a date')).toBeNull();
  });
});

describe('arming', () => {
  it('arms a watch for a job that is still running when the turn ends', () => {
    insertJob('job_PBaNzG47WZHL', 'running');
    jw.noteToolResult('conv-1', 'Background job started: job_PBaNzG47WZHL');
    jw.noteAssistantText('conv-1', "Watcher armed on pid 3854; I'll report when it lands.");
    jw.armWatches('conv-1');

    const row = getGatewayDb().prepare('SELECT * FROM job_watches WHERE job_id = ?').get('job_PBaNzG47WZHL') as any;
    expect(row).toBeTruthy();
    expect(row.kind).toBe('job');
    expect(row.conversation_id).toBe('conv-1');
    expect(row.promised).toBe(1);
    expect(row.notified_at).toBeNull();
  });

  it('does not arm a job that already finished inside the turn', () => {
    insertJob('job_alreadydone1', 'completed', { exit_code: 0, completed_at: '2026-08-27 18:00:00' });
    jw.noteToolResult('conv-2', 'jobId: job_alreadydone1');
    jw.noteAssistantText('conv-2', 'Done — rc=0.');
    jw.armWatches('conv-2');

    const rows = getGatewayDb().prepare('SELECT * FROM job_watches').all();
    expect(rows.length).toBe(0);
  });

  it('says so out loud when a tool-running turn promises a follow-up with nothing armed', () => {
    const posted: Array<[string, string]> = [];
    jw.setJobSurfaceImpl((c, m) => { posted.push([c, m]); });

    jw.noteToolResult('conv-3', 'no job here');           // the turn DID run tools
    jw.noteAssistantText('conv-3', "I'll report back when it finishes.");
    jw.armWatches('conv-3');

    expect(posted.length).toBe(1);
    expect(posted[0][0]).toBe('conv-3');
    expect(posted[0][1]).toMatch(/Nothing was armed/i);
  });

  it('calls out a background shell, which cannot report at all', () => {
    // P2, measured: 18 of 676 recorded gateway turns used run_in_background.
    // That shell is a child of the process answering the user, so it dies with
    // the turn and its output never reaches gateway state — there is nothing to
    // watch. The only honest move is to say so and name the lane that works.
    const posted: Array<[string, string]> = [];
    jw.setJobSurfaceImpl((c, m) => { posted.push([c, m]); });

    jw.noteToolStart('conv-bg', 'Bash', {
      command: 'bash scripts/blog/backfill-syndication.sh --refresh --live',
      run_in_background: true,
    });
    jw.noteToolResult('conv-bg', 'started');
    jw.noteAssistantText('conv-bg', 'Kicked it off.');
    jw.armWatches('conv-bg');

    expect(posted.length).toBe(1);
    expect(posted[0][1]).toMatch(/background shell was started/i);
    expect(posted[0][1]).toContain('backfill-syndication.sh');
    expect(posted[0][1]).toMatch(/script executor/i);
  });

  it('leaves a foreground Bash call alone', () => {
    const posted: Array<[string, string]> = [];
    jw.setJobSurfaceImpl((c, m) => { posted.push([c, m]); });

    jw.noteToolStart('conv-fg', 'Bash', { command: 'ls -la' });
    jw.noteToolResult('conv-fg', 'total 0');
    jw.noteAssistantText('conv-fg', 'Empty directory.');
    jw.armWatches('conv-fg');

    expect(posted.length).toBe(0);
  });

  it('stays quiet in the ambient lane, where "when it lands" means the user\'s typing', () => {
    // Measured over 3000 real gateway turns: the biggest block of would-be
    // false positives is `brainctx:` — the Face reacting to a half-typed
    // message. Verbatim from gateway.db: "When it lands complete, I'll respond
    // to the whole thing at once, not another fragment." Nobody asked that turn
    // for anything; a warning there is noise.
    const posted: Array<[string, string]> = [];
    jw.setJobSurfaceImpl((c, m) => { posted.push([c, m]); });

    const conv = 'brainctx:web:session';
    jw.noteToolResult(conv, 'memory lookup done');
    jw.noteAssistantText(conv, "When it lands complete, I'll respond to the whole thing at once, not another fragment.");
    jw.armWatches(conv);

    expect(posted.length).toBe(0);
    expect(jw.isAmbientLane(conv)).toBe(true);
    expect(jw.isAmbientLane('workbench:skill-console:blog-morning')).toBe(false);
    expect(jw.isAmbientLane('conv-123')).toBe(false);
  });

  it('stays quiet when the same words are small talk in a no-tool turn', () => {
    const posted: Array<[string, string]> = [];
    jw.setJobSurfaceImpl((c, m) => { posted.push([c, m]); });

    jw.noteAssistantText('conv-4', "Sure — I'll let you know.");
    jw.armWatches('conv-4');

    expect(posted.length).toBe(0);
  });
});

describe('delivery', () => {
  it('posts a receipt and fires ONE follow-up turn when the job lands', async () => {
    const posted: Array<[string, string]> = [];
    const reports: Array<[string, string]> = [];
    jw.setJobSurfaceImpl((c, m) => { posted.push([c, m]); });
    jw.setJobReportImpl(async (c, p) => { reports.push([c, p]); });

    const outFile = path.join(TMP, 'job.out');
    writeFileSync(outFile, 'wrote content/blog/2026-08-27-post.md\n');

    insertJob('job_PBaNzG47WZHL', 'running');
    jw.noteToolResult('conv-5', 'Background job started: job_PBaNzG47WZHL');
    jw.noteAssistantText('conv-5', "I'll read the exit code when it lands and report.");
    jw.armWatches('conv-5');

    // Still running → nothing delivered, watch stays open.
    expect(await jw.pollJobWatches()).toBe(0);
    expect(posted.length).toBe(0);

    insertJob('job_PBaNzG47WZHL', 'completed', {
      exit_code: 0, completed_at: '2026-08-27 18:06:29', output_file: outFile,
    });

    expect(await jw.pollJobWatches()).toBe(1);
    expect(posted.length).toBe(1);
    expect(posted[0][1]).toContain('rc=0');
    expect(posted[0][1]).toContain('blog-morning');
    expect(posted[0][1]).toMatch(/7m 29s/);           // 17:59:00Z → 18:06:29Z
    expect(reports.length).toBe(1);
    expect(reports[0][1]).toContain('job_PBaNzG47WZHL');
    expect(reports[0][1]).toContain('wrote content/blog');

    // The watch is closed — a second pass must not re-deliver.
    expect(await jw.pollJobWatches()).toBe(0);
    expect(posted.length).toBe(1);
    expect(reports.length).toBe(1);
  });

  it('shows the job\'s real output, not the wrapper\'s banners', async () => {
    // The wrapper writes `--- Job … Started/Finished ---` into BOTH files, so
    // "stderr is non-empty" is true of every job. The first version of the
    // receipt preferred stderr on that basis and printed two banners while
    // hiding the output entirely — found by reading a real job's files
    // (job_-6-Lu0Bv4PtX), not by any test.
    const posted: Array<[string, string]> = [];
    jw.setJobSurfaceImpl((c, m) => { posted.push([c, m]); });
    jw.setJobReportImpl(async () => { /* not exercised here */ });

    const out = path.join(TMP, 'banner.out');
    const err = path.join(TMP, 'banner.err');
    writeFileSync(out, [
      '--- Job job_bannercheck Started: 2026-08-27T22:50:02Z ---',
      'Command: sleep 12; echo hi',
      'Working Directory: /tmp/vodou-qa/project',
      '',
      'probe finished at 22:50:01',
      '',
      '--- Job job_bannercheck Finished with code 0: 2026-08-27T22:50:14Z ---',
    ].join('\n'));
    writeFileSync(err, [
      '--- Job job_bannercheck Started: 2026-08-27T22:50:02Z ---',
      '',
      '--- Job job_bannercheck Finished with code 0: 2026-08-27T22:50:14Z ---',
    ].join('\n'));

    insertJob('job_bannercheck', 'running', { output_file: out, error_file: err });
    jw.noteToolResult('conv-9', 'job_bannercheck');
    jw.noteAssistantText('conv-9', 'Started it.');
    jw.armWatches('conv-9');
    insertJob('job_bannercheck', 'completed', {
      exit_code: 0, completed_at: '2026-08-27 18:00:40', output_file: out, error_file: err,
    });

    expect(await jw.pollJobWatches()).toBe(1);
    expect(posted[0][1]).toContain('probe finished at 22:50:01');
    expect(posted[0][1]).not.toContain('--- Job');
    expect(posted[0][1]).not.toContain('stderr:');        // markers-only stderr is not output
  });

  it('delivers a receipt but no LLM turn when nothing was promised', async () => {
    const posted: Array<[string, string]> = [];
    const reports: Array<[string, string]> = [];
    jw.setJobSurfaceImpl((c, m) => { posted.push([c, m]); });
    jw.setJobReportImpl(async (c, p) => { reports.push([c, p]); });

    insertJob('job_quietrunner', 'running', { script_name: 'nightly' });
    jw.noteToolResult('conv-6', 'jobId: job_quietrunner');
    jw.noteAssistantText('conv-6', 'Started the nightly.');
    jw.armWatches('conv-6');

    insertJob('job_quietrunner', 'failed', {
      script_name: 'nightly', exit_code: 4, completed_at: '2026-08-27 18:02:00',
    });

    expect(await jw.pollJobWatches()).toBe(1);
    expect(posted.length).toBe(1);
    expect(posted[0][1]).toContain('rc=4');
    expect(posted[0][1]).toContain('⛔');
    expect(reports.length).toBe(0);
  });
});

describe('the general case — a bare background process, any provider', () => {
  it('watches a still-alive pid the reply named, and reports when it exits', async () => {
    const posted: Array<[string, string]> = [];
    const reports: Array<[string, string]> = [];
    jw.setJobSurfaceImpl((c, m) => { posted.push([c, m]); });
    jw.setJobReportImpl(async (c, p) => { reports.push([c, p]); });

    // A real child we control, so "alive" and "exited" are facts, not mocks.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    expect(jw.pidAlive(pid)).toBe(true);

    jw.noteToolResult('conv-7', 'no job id in here');
    jw.noteAssistantText('conv-7', `Kicked the build off in the background. Watcher armed on pid ${pid}; I'll report when it lands.`);
    jw.armWatches('conv-7');

    const row = getGatewayDb().prepare('SELECT * FROM job_watches WHERE pid = ?').get(pid) as any;
    expect(row?.kind).toBe('pid');
    expect(await jw.pollJobWatches()).toBe(0);      // still running

    child.kill('SIGKILL');
    await new Promise<void>((r) => child.on('exit', () => r()));

    expect(await jw.pollJobWatches()).toBe(1);
    expect(posted[0][1]).toContain(`pid ${pid}`);
    expect(posted[0][1]).toMatch(/exited/i);
    expect(reports.length).toBe(1);
    expect(reports[0][1]).toMatch(/no exit code/i);
  });

  it('ignores a pid that is merely mentioned, with no promise attached', () => {
    jw.setJobSurfaceImpl(() => { /* noop */ });
    jw.noteToolResult('conv-8', 'ps output: 1234 node');
    jw.noteAssistantText('conv-8', 'The daemon is running as pid 1234. That is all.');
    jw.armWatches('conv-8');
    expect(getGatewayDb().prepare('SELECT COUNT(*) AS n FROM job_watches').get() as any).toMatchObject({ n: 0 });
  });
});
