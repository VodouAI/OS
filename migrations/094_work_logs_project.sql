-- PLAN-CONTEXT-THAT-MAINTAINS-ITSELF P4 (follow-on, 2026-09-09).
-- "Where we left off" must be project-scoped so a session in repo B never reads
-- repo A's open loops. work_logs had no project column, so the block shipped
-- global-only with a test enforcing that a scoped packet got nothing. This is
-- the column that lets it be scoped. NULL = the writer could not resolve a
-- project (the CLI outside any registered root); those rows stay global.
ALTER TABLE work_logs ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_work_logs_project_ts ON work_logs(project_id, timestamp DESC);
