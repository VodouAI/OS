/**
 * Shared test fixtures — builds a fresh board.db in a temp file, seeds it,
 * sets the env vars so getReadDb() finds it, then exposes the path for cleanup.
 *
 * Each test file imports `makeBoardDb()` and tears down at the end.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const MIGRATION_PATH = path.resolve(__dirname, '..', 'migrations', '001_board_kernel.sql');

export interface BoardDbHandle {
  dir: string;
  dbPath: string;
  cleanup: () => void;
}

export interface SeedTask {
  id: string;
  board_id?: string;
  title: string;
  body?: string;
  status: string;
  assignee?: string | null;
  priority?: number;
  workspace?: string;
}

export function makeBoardDb(seeds: SeedTask[] = []): BoardDbHandle {
  const dir = mkdtempSync(path.join(tmpdir(), 'vodou-board-test-'));
  const dbPath = path.join(dir, 'board.db');
  const migrationSql = readFileSync(MIGRATION_PATH, 'utf-8');

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA trusted_schema = ON');
  db.exec(migrationSql);

  if (seeds.length) {
    const insert = db.prepare(
      `INSERT INTO tasks (id, board_id, title, body, status, assignee, priority, workspace)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.exec('BEGIN');
    try {
      for (const r of seeds) {
        insert.run(
          r.id,
          r.board_id ?? 'default',
          r.title,
          r.body ?? null,
          r.status,
          r.assignee ?? null,
          r.priority ?? 50,
          r.workspace ?? 'scratch',
        );
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  db.close();

  // Configure the env vars the production code reads
  process.env.VODOU_BOARD_DB = dbPath;
  process.env.VODOU_PROJECT_PATH = dir;
  // Note: getReadDb() memoizes its connection. Tests use `pool: 'forks'`
  // (vitest.config.ts) so each test FILE gets its own process — the cache
  // is fresh per file. Within a file, tests share the same memoized handle;
  // we use dynamic imports with cache-busting query strings to force a
  // fresh module + connection where needed.

  return {
    dir,
    dbPath,
    cleanup: () => {
      delete process.env.VODOU_BOARD_DB;
      delete process.env.VODOU_PROJECT_PATH;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    },
  };
}
