/**
 * POST /api/board/tasks/clear must delete tasks from ONE board.
 *
 * Found 2026-08-16 while auditing board_id coverage for
 * PLANS/0.6.26/PLAN-UNIFIED-PROJECT-SCOPE.md. Every other board route filters
 * on board_id — `GET /` has taken `?board=` since Phase 1 — but the bulk clear
 * ran `DELETE ... WHERE status IN (...)` across the whole table.
 *
 * With one board that is invisible. The moment a second board exists (which is
 * exactly what the project-scoped board work introduces) it is silent
 * cross-board data loss: "Clear done" on board A hard-deletes board B's
 * finished tasks, runs, comments and events via deleteTaskCascade, with no undo
 * and no confirmation naming board B.
 *
 * These tests are written against the DESTRUCTIVE path deliberately — the whole
 * point is that the blast radius is bounded, so asserting "the other board's
 * rows still exist" is the only assertion that means anything.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_ROOT = path.resolve(HERE, '../..');
const REPO_ROOT = path.resolve(CONSOLE_ROOT, '../..');

// Both DBs must be redirected BEFORE anything imports db.js — the paths are
// read at first connection. board.ts also pulls in projects-store (gateway.db).
const TMP = mkdtempSync(path.join(tmpdir(), 'vodou-board-clear-'));
process.env.GATEWAY_DB_PATH = path.join(TMP, 'gateway.db');
process.env.VODOU_BOARD_DB = path.join(TMP, 'board.db');

afterAll(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

let app: any;
let request: any;

/** Build a real board.db from the shipped kernel migration — not a hand-rolled
 *  subset, so deleteTaskCascade's child tables genuinely exist. */
function initBoardDb(): void {
  const sql = readFileSync(
    path.join(REPO_ROOT, 'MCP-servers/Vodou-Board/migrations/001_board_kernel.sql'),
    'utf8'
  );
  const db = new DatabaseSync(process.env.VODOU_BOARD_DB!);
  db.exec('PRAGMA trusted_schema = ON');
  db.exec(sql);
  db.close();
}

function boardDb(): InstanceType<typeof DatabaseSync> {
  return new DatabaseSync(process.env.VODOU_BOARD_DB!);
}

/** Two projects' boards plus the legacy 'default' board, each with finished and
 *  unfinished work, so a leak in any direction is visible. */
function seed(): void {
  const db = boardDb();
  db.exec(`INSERT OR IGNORE INTO boards (id, display_name) VALUES
             ('default','Default'), ('proj_aaa','Project A'), ('proj_bbb','Project B')`);
  const ins = db.prepare(
    'INSERT INTO tasks (id, board_id, tenant_id, title, status) VALUES (?,?,?,?,?)'
  );
  const rows: Array<[string, string, string]> = [
    ['t_a_done', 'proj_aaa', 'A finished',  'done'],
    ['t_a_arch', 'proj_aaa', 'A archived',  'archived'],
    ['t_a_todo', 'proj_aaa', 'A in flight', 'todo'],
    ['t_b_done', 'proj_bbb', 'B finished',  'done'],
    ['t_b_arch', 'proj_bbb', 'B archived',  'archived'],
    ['t_b_todo', 'proj_bbb', 'B in flight', 'todo'],
    ['t_d_done', 'default',  'D finished',  'done'],
    ['t_d_todo', 'default',  'D in flight', 'todo'],
  ].map(([id, board, title, ...rest]) => [id, board, title, ...rest] as any);
  for (const [id, board_id, title, status] of rows as any) {
    ins.run(id, board_id, 'self', title, status);
  }
  db.close();
}

function idsRemaining(): string[] {
  const db = boardDb();
  const rows = db.prepare('SELECT id FROM tasks ORDER BY id').all() as { id: string }[];
  db.close();
  return rows.map((r) => r.id);
}

function wipeTasks(): void {
  const db = boardDb();
  db.exec('DELETE FROM tasks');
  db.close();
}

beforeAll(async () => {
  initBoardDb();
  const express = (await import('express')).default;
  const { boardRouter } = await import('../api/board.js');
  app = express();
  app.use(express.json());
  app.use('/api/board', boardRouter);
  request = (await import('supertest')).default;
});

beforeEach(() => {
  wipeTasks();
  seed();
});

describe('POST /api/board/tasks/clear — board scoping', () => {
  it('clears ONLY the named board and leaves every other board intact', async () => {
    const res = await request(app)
      .post('/api/board/tasks/clear')
      .send({ statuses: ['done', 'archived'], board_id: 'proj_aaa' })
      .expect(200);

    expect(res.body.deleted).toBe(2);
    expect(res.body.board_id).toBe('proj_aaa');

    // THE assertion: B and default are untouched.
    expect(idsRemaining()).toEqual([
      't_a_todo',            // A's unfinished work survives (status filter)
      't_b_arch', 't_b_done', 't_b_todo',   // B fully intact
      't_d_done', 't_d_todo',               // default fully intact
    ]);
  });

  it('clearing one project board does not touch the other project board', async () => {
    await request(app).post('/api/board/tasks/clear')
      .send({ statuses: ['done', 'archived'], board_id: 'proj_aaa' }).expect(200);
    await request(app).post('/api/board/tasks/clear')
      .send({ statuses: ['done', 'archived'], board_id: 'proj_bbb' }).expect(200);

    // Both cleared independently; default still holds its finished task.
    expect(idsRemaining()).toEqual(['t_a_todo', 't_b_todo', 't_d_done', 't_d_todo']);
  });

  it('defaults to the legacy `default` board when board_id is omitted', async () => {
    // Backward compatibility: this is the exact pre-fix call the shipped client
    // made. On a single-board install every task carries board_id 'default'
    // (migration 001 column default), so behavior there is unchanged.
    const res = await request(app)
      .post('/api/board/tasks/clear')
      .send({ statuses: ['done', 'archived'] })
      .expect(200);

    expect(res.body.deleted).toBe(1);          // only t_d_done
    expect(res.body.board_id).toBe('default');
    expect(idsRemaining()).toContain('t_a_done');
    expect(idsRemaining()).toContain('t_b_done');
  });

  it('an unknown board deletes nothing at all', async () => {
    const before = idsRemaining();
    const res = await request(app)
      .post('/api/board/tasks/clear')
      .send({ statuses: ['done', 'archived'], board_id: 'proj_does_not_exist' })
      .expect(200);

    expect(res.body.deleted).toBe(0);
    expect(idsRemaining()).toEqual(before);
  });

  it('still rejects an all-invalid status list without deleting anything', async () => {
    const before = idsRemaining();
    await request(app)
      .post('/api/board/tasks/clear')
      .send({ statuses: ['bogus'], board_id: 'proj_aaa' })
      .expect(400);
    expect(idsRemaining()).toEqual(before);
  });

  it('honours an explicit status list within the board scope', async () => {
    const res = await request(app)
      .post('/api/board/tasks/clear')
      .send({ statuses: ['todo'], board_id: 'proj_aaa' })
      .expect(200);

    expect(res.body.deleted).toBe(1);
    expect(idsRemaining()).not.toContain('t_a_todo');
    expect(idsRemaining()).toContain('t_a_done');   // wrong status, untouched
    expect(idsRemaining()).toContain('t_b_todo');   // wrong board, untouched
  });
});
