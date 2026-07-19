/**
 * Verifies migration 001 applies clean, is idempotent, builds the expected
 * schema, and the FTS5 triggers fire correctly.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { makeBoardDb, type BoardDbHandle } from './fixtures.js';

let handle: BoardDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

describe('migration 001 — kernel', () => {
  it('creates all 10 base tables + tasks_fts', () => {
    handle = makeBoardDb();
    const db = new DatabaseSync(handle.dbPath, { readOnly: true });
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    ).all().map((r: any) => r.name);

    expect(tables).toContain('boards');
    expect(tables).toContain('tasks');
    expect(tables).toContain('task_runs');
    expect(tables).toContain('task_events');
    expect(tables).toContain('task_comments');
    expect(tables).toContain('task_links');
    expect(tables).toContain('board_notify_subs');
    expect(tables).toContain('task_usage');
    expect(tables).toContain('board_approvals');
    expect(tables).toContain('gateway_in_app_inbox');
    expect(tables).toContain('board_metadata');
    expect(tables).toContain('tasks_fts');
    db.close();
  });

  it('seeds the default board row', () => {
    handle = makeBoardDb();
    const db = new DatabaseSync(handle.dbPath, { readOnly: true });
    const row = db.prepare(
      `SELECT id, display_name, is_current FROM boards WHERE id = 'default'`,
    ).get() as any;
    expect(row.id).toBe('default');
    expect(row.display_name).toBe('Default');
    expect(row.is_current).toBe(1);
    db.close();
  });

  it('rejects task_links self-link via CHECK constraint', () => {
    handle = makeBoardDb([{ id: 't_x', title: 'x', status: 'ready' }]);
    const db = new DatabaseSync(handle.dbPath);
    db.exec('PRAGMA trusted_schema = ON');
    expect(() =>
      db.prepare(`INSERT INTO task_links (parent_id, child_id) VALUES ('t_x', 't_x')`).run(),
    ).toThrow(/CHECK/);
    db.close();
  });

  it('FTS5 trigger fires on insert', () => {
    handle = makeBoardDb([
      { id: 't_fts1', title: 'launch announcement draft', body: 'four wow-moments', status: 'todo' },
      { id: 't_fts2', title: 'unrelated research task', body: 'separate body', status: 'todo' },
    ]);
    const db = new DatabaseSync(handle.dbPath, { readOnly: true });
    const matches = db.prepare(
      `SELECT task_id FROM tasks_fts WHERE tasks_fts MATCH 'launch'`,
    ).all() as any[];
    expect(matches).toHaveLength(1);
    expect(matches[0].task_id).toBe('t_fts1');
    db.close();
  });

  it('CAS claim is single-winner (atomic update)', () => {
    handle = makeBoardDb([{ id: 't_cas', title: 'cas test', status: 'ready' }]);
    const db = new DatabaseSync(handle.dbPath);
    db.exec('PRAGMA trusted_schema = ON');

    const claim = db.prepare(
      `UPDATE tasks SET claim_lock = ?, status = 'running'
       WHERE id = ? AND status = 'ready' AND claim_lock IS NULL`,
    );

    const r1 = claim.run('worker_1', 't_cas');
    expect(r1.changes).toBe(1);

    const r2 = claim.run('worker_2', 't_cas');
    expect(r2.changes).toBe(0);

    db.close();
  });

  it('is idempotent when re-applied', () => {
    handle = makeBoardDb();
    const db = new DatabaseSync(handle.dbPath);
    db.exec('PRAGMA trusted_schema = ON');
    const migrationSql = require('node:fs').readFileSync(
      require('node:path').resolve(__dirname, '..', 'migrations', '001_board_kernel.sql'),
      'utf-8',
    );
    expect(() => db.exec(migrationSql)).not.toThrow();
    db.close();
  });
});
