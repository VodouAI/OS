-- Migration 003 (board.db): add the 'plan' status to tasks (the Board Planner's
-- staging column, rendered in front of Triage).
--
-- SQLite can't ALTER a CHECK constraint, so the tasks table is rebuilt. The
-- migration runner DISABLES foreign_keys during application (src/board/migrate.rs)
-- and re-verifies with foreign_key_check afterward — this matters because with FK
-- enforcement on, `DROP TABLE tasks` performs an implicit cascade-DELETE that would
-- wipe every child row (task_runs / task_events / task_comments / task_links /
-- gateway_in_app_inbox). With FK off, rows are copied table-to-table and preserved.
--
-- The three tasks_fts sync triggers are dropped automatically with the old table
-- and recreated below. tasks_fts itself is untouched, so existing FTS rows stay
-- consistent (the direct INSERT … SELECT does not fire INSERT triggers — tasks_new
-- has none yet, so no duplicate FTS entries are produced).
--
-- Applied once via the schema_version gate; never re-run.

CREATE TABLE tasks_new (
  id                          TEXT PRIMARY KEY,
  board_id                    TEXT NOT NULL DEFAULT 'default'
                              REFERENCES boards(id),
  tenant_id                   TEXT NOT NULL DEFAULT 'self',
  title                       TEXT NOT NULL,
  body                        TEXT,
  status                      TEXT NOT NULL DEFAULT 'todo'
                              CHECK (status IN ('plan','triage','todo','ready','running',
                                                'blocked','done','archived','pending_approval')),
  assignee                    TEXT,
  assignee_principal_id       TEXT,
  priority                    INTEGER NOT NULL DEFAULT 50,
  parents_json                TEXT,
  skills_json                 TEXT,
  workspace                   TEXT NOT NULL DEFAULT 'scratch'
                              CHECK (workspace IN ('scratch','worktree') OR workspace LIKE 'dir:/%'),
  current_run_id              TEXT,
  claim_lock                  TEXT,
  claim_expires_at            DATETIME,
  worker_pid                  INTEGER,
  max_runtime_seconds         INTEGER,
  max_retries                 INTEGER,
  consecutive_failures        INTEGER DEFAULT 0,
  hallucination_gate_strikes  INTEGER DEFAULT 0,
  last_heartbeat_at           DATETIME,
  last_failure_error          TEXT,
  idempotency_key             TEXT,
  workflow_template_id        TEXT,
  workflow_template_version   TEXT,
  current_step_key            TEXT,
  requires_approval_on        TEXT,
  budget_tokens_cap           INTEGER,
  budget_usd_cap              REAL,
  budget_usd_soft_cap         REAL,
  budget_runtime_seconds_cap  INTEGER,
  budget_soft_warned          INTEGER DEFAULT 0,
  model_override              TEXT,
  intent_embedding            BLOB,
  created_by_principal_id     TEXT,
  created_at                  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at                  DATETIME DEFAULT CURRENT_TIMESTAMP,
  source_conversation_id      TEXT,
  source_channel              TEXT,
  UNIQUE (board_id, idempotency_key)
);

-- Column order is identical to the original table, so SELECT * is safe.
INSERT INTO tasks_new SELECT * FROM tasks;

DROP TABLE tasks;

ALTER TABLE tasks_new RENAME TO tasks;

-- Recreate the named indexes (autoindexes for the PK + UNIQUE are rebuilt with the table).
CREATE INDEX IF NOT EXISTS idx_tasks_board_status     ON tasks(board_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee         ON tasks(assignee);
CREATE INDEX IF NOT EXISTS idx_tasks_status_ready     ON tasks(status) WHERE status = 'ready';
CREATE INDEX IF NOT EXISTS idx_tasks_claim_lock       ON tasks(claim_lock) WHERE claim_lock IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_tenant           ON tasks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tasks_pending_approval ON tasks(status) WHERE status = 'pending_approval';

-- Recreate the FTS sync triggers (dropped together with the old table).
CREATE TRIGGER IF NOT EXISTS tasks_fts_insert AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts(task_id, title, body) VALUES (new.id, new.title, COALESCE(new.body, ''));
END;

CREATE TRIGGER IF NOT EXISTS tasks_fts_update AFTER UPDATE OF title, body ON tasks BEGIN
  DELETE FROM tasks_fts WHERE task_id = old.id;
  INSERT INTO tasks_fts(task_id, title, body) VALUES (new.id, new.title, COALESCE(new.body, ''));
END;

CREATE TRIGGER IF NOT EXISTS tasks_fts_delete AFTER DELETE ON tasks BEGIN
  DELETE FROM tasks_fts WHERE task_id = old.id;
END;
