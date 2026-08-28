/**
 * item 14 — a graph run must be traceable to the board task that caused it.
 *
 * The defect: `startRun` ACCEPTED a `boardTaskId` and its INSERT never named the
 * column, so the parameter was silently discarded. Measured 2026-08-26 on the
 * live table: 0 of 1221 runs carried a `board_task_id`, and no run had ever
 * recorded `surface: 'board'`. The field existed everywhere except the database,
 * which made the wiring look finished.
 *
 * A type check cannot catch this — the parameter type was correct. Only reading
 * back what was written catches it, so that is what this does.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startRun } from '../graph-runs.js';
import { getGatewayDb } from '../db.js';

describe('graph run board identity', () => {
  // Every run this file creates, so it can remove them again.
  //
  // `startRun` writes through `getGatewayDb()`, which is the REAL gateway.db —
  // there is no test double for it. Left alone, this suite deposits permanent
  // fake rows (`task_abc123`, skills `s1`/`s2`) into the live run history, where
  // they are indistinguishable from work the user actually did. The Board drawer
  // would then show a graph run for a task that never existed.
  const created: string[] = [];
  const track = (runId: string) => { created.push(runId); return runId; };

  beforeAll(() => { track(startRun({ skill: 'warmup' })); });

  afterAll(() => {
    if (!created.length) return;
    try {
      const del = getGatewayDb().prepare('DELETE FROM graph_runs WHERE run_id = ?');
      for (const id of created) del.run(id);
    } catch (err) {
      console.error('[test] could not clean up graph_runs rows:', err);
    }
  });

  const read = (runId: string) =>
    getGatewayDb()
      .prepare('SELECT skill, surface, board_task_id FROM graph_runs WHERE run_id = ?')
      .get(runId) as { skill: string; surface: string; board_task_id: string | null } | undefined;

  it('persists the board task id it was given', () => {
    const runId = track(startRun({ skill: 'board-skill', surface: 'board', boardTaskId: 'task_abc123' }));
    const row = read(runId);
    expect(row, 'run row was not written at all').toBeDefined();
    expect(row!.board_task_id, 'boardTaskId was accepted and discarded').toBe('task_abc123');
    expect(row!.surface).toBe('board');
  });

  it('leaves board_task_id null when none is given, rather than inventing one', () => {
    const runId = track(startRun({ skill: 'web-skill' }));
    const row = read(runId);
    expect(row!.board_task_id).toBeNull();
    expect(row!.surface).toBe('web');
  });

  it('finds runs by board task, and only that task’s runs', async () => {
    const { listRunsForBoardTask } = await import('../graph-runs.js');
    const mine = `task_${Math.random().toString(36).slice(2)}`;
    const other = `task_${Math.random().toString(36).slice(2)}`;
    const a = track(startRun({ skill: 's1', surface: 'board', boardTaskId: mine }));
    track(startRun({ skill: 's2', surface: 'board', boardTaskId: other }));

    const found = listRunsForBoardTask(mine);
    expect(found.map((r) => r.run_id)).toContain(a);
    expect(found.every((r) => r.run_id !== undefined)).toBe(true);
    expect(listRunsForBoardTask(other).map((r) => r.run_id)).not.toContain(a);
  });

  it('returns [] for a task that caused no graph run', async () => {
    const { listRunsForBoardTask } = await import('../graph-runs.js');
    expect(listRunsForBoardTask('task_that_never_ran_anything')).toEqual([]);
  });
});
