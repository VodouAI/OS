-- Migration 002 (board.db): Vodou Board — workflow templates (Phase 2 §3.5).
-- Idempotent. Adds 1 table + 1 index. References to core.principals are
-- resolved at apply-time the same way migration 001 handles them.

CREATE TABLE IF NOT EXISTS board_templates (
  id                       TEXT PRIMARY KEY,                  -- 'tmpl_' + 8 hex
  name                     TEXT NOT NULL UNIQUE,              -- 'ship-a-feature', 'pr-review-pipeline', …
  version                  TEXT NOT NULL DEFAULT '1.0.0',     -- semver, locked at task creation
  description              TEXT,
  stages_json              TEXT NOT NULL,                     -- JSON array: [{"key":"spec","assignee_default":"planner",…},…]
  created_by_principal_id  TEXT,                              -- soft FK to core.principals(id); NULL on system-seeded
  created_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
  archived_at              DATETIME,                          -- soft-delete

  -- Phase 2 v1 invariant: stages_json must parse to a non-empty array. SQLite
  -- can't enforce JSON structure, so this is validated in Rust at insert time.
  CHECK (length(stages_json) > 2)
);

CREATE INDEX IF NOT EXISTS idx_board_templates_active
  ON board_templates(name) WHERE archived_at IS NULL;
