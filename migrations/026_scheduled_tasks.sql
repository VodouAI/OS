-- Migration 026: scheduled_tasks table for OI Autonomous Scheduler
-- Idempotent: safe to re-run on DBs where the table is missing despite
-- schema_version saying it was applied (recovers from prior empty-file bug).

CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    schedule TEXT NOT NULL,
    schedule_type TEXT NOT NULL DEFAULT 'cron',
    payload_type TEXT NOT NULL DEFAULT 'query',
    payload TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    one_shot INTEGER NOT NULL DEFAULT 0,
    next_run_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_run_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled ON scheduled_tasks(enabled);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run ON scheduled_tasks(next_run_at);
