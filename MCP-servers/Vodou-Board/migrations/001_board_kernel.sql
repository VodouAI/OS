-- ─────────────────────────────────────────────────────────────────────────────
-- Vodou Board — migration 001 — kernel
-- Target: board.db (NOT vodou-core.db).
-- Idempotent. Adds 10 tables + 25 indexes + 1 FTS5 virtual table.
-- References to core.tenants / core.principals resolve via ATTACH DATABASE
-- in the connection-init step (see src/board/db.rs::BoardDatabase::open).
-- Cross-DB FK enforcement is OFF (SQLite limitation); integrity probe runs
-- at boot to catch dangling refs.
--
-- Author: PLANS/0.5.78/PLAN-VODOU-BOARD-MULTI-AGENT-KANBAN.md §4.1 +
--         AUDIT-AND-UX-ADDENDUM-2026-05-12.md §3
--
-- IMPORTANT: BoardDatabase::open MUST also set `PRAGMA trusted_schema = ON;`
-- on every connection so the FTS5 sync triggers below can fire on inserts/
-- updates/deletes. Without this pragma, you'll get "unsafe use of virtual
-- table" errors on every INSERT INTO tasks. This is a SQLite ≥3.31 default.
-- ─────────────────────────────────────────────────────────────────────────────

-- Required for FTS5 triggers in this schema (see header note).
PRAGMA trusted_schema = ON;

-- ─────────────────── boards ──────────────────
CREATE TABLE IF NOT EXISTS boards (
  id              TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  description     TEXT,
  icon            TEXT,
  tenant_id       TEXT NOT NULL DEFAULT 'self',
  is_current      INTEGER NOT NULL DEFAULT 0,
  archived_at     DATETIME,
  -- Phase 4 federation (forward-compat)
  federation_host TEXT,
  federation_key_id TEXT,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_boards_tenant  ON boards(tenant_id);
CREATE INDEX IF NOT EXISTS idx_boards_current ON boards(is_current) WHERE is_current = 1;

INSERT OR IGNORE INTO boards (id, display_name, is_current)
  VALUES ('default', 'Default', 1);

-- ─────────────────── tasks ───────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id                          TEXT PRIMARY KEY,         -- 't_' + 8 hex chars (4.3B space)
  board_id                    TEXT NOT NULL DEFAULT 'default'
                              REFERENCES boards(id),
  tenant_id                   TEXT NOT NULL DEFAULT 'self',
  title                       TEXT NOT NULL,
  body                        TEXT,
  status                      TEXT NOT NULL DEFAULT 'todo'
                              CHECK (status IN ('triage','todo','ready','running',
                                                'blocked','done','archived','pending_approval')),
  assignee                    TEXT,
  assignee_principal_id       TEXT,                     -- set on first claim; refs core.principals
  priority                    INTEGER NOT NULL DEFAULT 50,
  parents_json                TEXT,                     -- denormalized; task_links is canonical
  skills_json                 TEXT,                     -- per-task pinned skills
  workspace                   TEXT NOT NULL DEFAULT 'scratch'
                              CHECK (workspace IN ('scratch','worktree') OR workspace LIKE 'dir:/%'),
  current_run_id              TEXT,                     -- FK to task_runs.id; NULL = no active run
  claim_lock                  TEXT,                     -- worker_id while claimed
  claim_expires_at            DATETIME,                 -- claim TTL
  worker_pid                  INTEGER,                  -- set on spawn, cleared on reap
  max_runtime_seconds         INTEGER,                  -- per-task runtime cap; NULL = default
  max_retries                 INTEGER,                  -- Hermes v0.13.0 parity; NULL = default
  consecutive_failures        INTEGER DEFAULT 0,        -- Hermes parity (circuit breaker counter)
  hallucination_gate_strikes  INTEGER DEFAULT 0,        -- Hermes v0.13.0 hallucination gate
  last_heartbeat_at           DATETIME,                 -- per-claim liveness
  last_failure_error          TEXT,                     -- surfaces in dashboard run history
  idempotency_key             TEXT,                     -- webhook dedup
  -- Phase 2: workflow templates (forward-compat columns)
  workflow_template_id        TEXT,
  workflow_template_version   TEXT,                     -- pinned at task creation
  current_step_key            TEXT,
  requires_approval_on        TEXT,                     -- JSON array of transition labels
  -- Phase 3: budgets
  budget_tokens_cap           INTEGER,
  budget_usd_cap              REAL,
  budget_usd_soft_cap         REAL,
  budget_runtime_seconds_cap  INTEGER,
  budget_soft_warned          INTEGER DEFAULT 0,
  -- Phase 3: model override
  model_override              TEXT,
  -- Phase 3: auto-assignment routing
  intent_embedding            BLOB,                     -- 384-dim f32 (e5-small-v2)
  -- Origin
  created_by_principal_id     TEXT,                     -- refs core.principals
  created_at                  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at                  DATETIME DEFAULT CURRENT_TIMESTAMP,
  source_conversation_id      TEXT,
  source_channel              TEXT,                     -- 'web' | 'cli' | 'slash' | 'channel:…' | 'webhook'
  UNIQUE (board_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_tasks_board_status   ON tasks(board_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee       ON tasks(assignee);
CREATE INDEX IF NOT EXISTS idx_tasks_status_ready   ON tasks(status) WHERE status = 'ready';
CREATE INDEX IF NOT EXISTS idx_tasks_claim_lock     ON tasks(claim_lock) WHERE claim_lock IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_tenant         ON tasks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tasks_pending_approval ON tasks(status) WHERE status = 'pending_approval';

-- ─────────────────── task_runs ───────────────
CREATE TABLE IF NOT EXISTS task_runs (
  id              TEXT PRIMARY KEY,                     -- 'r_' + ULID
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_no      INTEGER NOT NULL,
  profile         TEXT,                                 -- assignee at claim time
  step_key        TEXT,                                 -- workflow template stage at claim time
  worker_pid      INTEGER,
  started_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  ended_at        DATETIME,
  outcome         TEXT
                  CHECK (outcome IN ('completed','blocked','crashed','timed_out',
                                     'spawn_failed','gave_up','reclaimed','budget_exceeded')),
  summary         TEXT,
  metadata_json   TEXT,
  error           TEXT,
  tokens_used     INTEGER DEFAULT 0,
  usd_spent       REAL DEFAULT 0,
  log_path        TEXT,
  UNIQUE (task_id, attempt_no)
);

CREATE INDEX IF NOT EXISTS idx_task_runs_task    ON task_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_outcome ON task_runs(outcome);

-- ─────────────────── task_events ─────────────
CREATE TABLE IF NOT EXISTS task_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id       TEXT REFERENCES task_runs(id),
  kind         TEXT NOT NULL,
  payload_json TEXT,
  actor        TEXT,                                    -- 'system' | 'worker:<assignee>' | 'human:<principal>' | 'webhook:<id>'
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, id);
CREATE INDEX IF NOT EXISTS idx_task_events_kind ON task_events(kind);
CREATE INDEX IF NOT EXISTS idx_task_events_run  ON task_events(run_id) WHERE run_id IS NOT NULL;

-- ─────────────────── task_comments ───────────
CREATE TABLE IF NOT EXISTS task_comments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  body                TEXT NOT NULL,
  author_principal_id TEXT,                             -- refs core.principals
  author_label        TEXT,                             -- fallback when author is webhook/system
  in_reply_to         INTEGER REFERENCES task_comments(id),
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, id);

-- ─────────────────── task_links ──────────────
CREATE TABLE IF NOT EXISTS task_links (
  parent_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  child_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (parent_id, child_id),
  CHECK (parent_id != child_id)
);

CREATE INDEX IF NOT EXISTS idx_task_links_parent ON task_links(parent_id);
CREATE INDEX IF NOT EXISTS idx_task_links_child  ON task_links(child_id);

-- ─────────────────── board_notify_subs ───────
CREATE TABLE IF NOT EXISTS board_notify_subs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id               TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  delivery_target       TEXT NOT NULL,                  -- 'channel:telegram:12345:7' | 'inapp:principal:…' | 'webhook:url'
  last_event_id         INTEGER DEFAULT 0,
  consecutive_failures  INTEGER DEFAULT 0,
  created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (task_id, delivery_target)
);

CREATE INDEX IF NOT EXISTS idx_board_notify_subs_task   ON board_notify_subs(task_id);
CREATE INDEX IF NOT EXISTS idx_board_notify_subs_target ON board_notify_subs(delivery_target);

-- ─────────────────── task_usage (audit-correction 2026-05-12) ──────────────
-- Per-task cost ledger. Replaces the proposed `ALTER TABLE usage_log` since
-- vodou-core has no usage_log (usage_tracker.rs is EC2-only). Board-local
-- only; never sent off-device.
CREATE TABLE IF NOT EXISTS task_usage (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id           TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id            TEXT REFERENCES task_runs(id),
  model             TEXT NOT NULL,                      -- 'claude-sonnet-4-20250514', 'gpt-4o', …
  provider          TEXT NOT NULL,                      -- 'anthropic' | 'openai' | …
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  usd_estimate      REAL NOT NULL DEFAULT 0,
  latency_ms        INTEGER,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_task_usage_task ON task_usage(task_id);
CREATE INDEX IF NOT EXISTS idx_task_usage_run  ON task_usage(run_id) WHERE run_id IS NOT NULL;

-- ─────────────────── board_approvals (audit-correction 2026-05-12) ─────────
-- Purpose-built approval rows. core.user_approvals is FK-bound to mcp_servers
-- and can't carry board transitions.
CREATE TABLE IF NOT EXISTS board_approvals (
  id                       TEXT PRIMARY KEY,            -- 'a_' + 8 hex
  task_id                  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  transition_label         TEXT NOT NULL,               -- 'ready→running' | 'running→done' | …
  requested_at             DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at               DATETIME,
  decision                 TEXT CHECK (decision IN ('pending','approved','rejected','expired'))
                           DEFAULT 'pending',
  decided_at               DATETIME,
  decided_by_principal_id  TEXT,                        -- refs core.principals
  decided_via              TEXT,                        -- 'dashboard' | 'channel:telegram' | 'webhook' | 'cli'
  reason                   TEXT,
  notified_targets_json    TEXT                         -- which subs we paged on request
);

CREATE INDEX IF NOT EXISTS idx_board_approvals_task     ON board_approvals(task_id);
CREATE INDEX IF NOT EXISTS idx_board_approvals_pending  ON board_approvals(decision) WHERE decision = 'pending';

-- ─────────────────── gateway_in_app_inbox (audit-correction 2026-05-12) ────
-- Dashboard bell-icon delivery target. Lightweight; scoped to board events.
CREATE TABLE IF NOT EXISTS gateway_in_app_inbox (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT NOT NULL,                           -- refs core.principals
  kind         TEXT NOT NULL,                           -- 'board_event' | 'approval_request' | 'mention'
  task_id      TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  payload_json TEXT NOT NULL,
  read_at      DATETIME,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_inbox_unread ON gateway_in_app_inbox(principal_id, read_at)
  WHERE read_at IS NULL;

-- ─────────────────── tasks_fts (Phase 2 search index, lands now for board_ask) ──
-- Mirrors title + body for FTS5 retrieval. Triggers keep it in sync.
CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
  task_id UNINDEXED,
  title,
  body,
  tokenize = 'porter unicode61'
);

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

-- ─────────────────── board_metadata (KV for board-local install state) ─────
CREATE TABLE IF NOT EXISTS board_metadata (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Seed install marker so we can detect first-run later.
INSERT OR IGNORE INTO board_metadata (key, value)
  VALUES ('install_at', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
