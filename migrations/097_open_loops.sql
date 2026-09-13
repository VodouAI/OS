-- PLAN-COMMITMENTS-LANE P0 (2026-09-10). Shared with PLAN-LOOPS-THAT-READ-THE-RECEIPTS P4:
-- one table of unfinished things, four kinds. This plan owns the DDL; PLAN-LOOPS
-- adds producers for the other three kinds over this same table.
--
-- A row here is NOT a memory chunk. It never enters memory_chunks, MEMORY.md,
-- recall, or any inject lane except the one registered bootstrap line (P3).
-- Instants are naive UTC `YYYY-MM-DD HH:MM:SS` (PLAN-TIME-CANON). `due_at` is
-- NULL when no date was stated — never guessed.
CREATE TABLE IF NOT EXISTS open_loops (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,            -- parked_ask | blocked_verifier | disputed_fact | commitment
  ref          TEXT,                     -- commitment: json {what, party, direction, due_text, due_precision, confidence, tz_source}
  source_turn  TEXT,                     -- turn_id (turn_events) or gateway message id
  host_opened  TEXT NOT NULL,            -- hosts.toml name, or `hook` when the hook side cannot tell which IDE
  opened_at    TEXT NOT NULL,            -- naive UTC
  due_at       TEXT,                     -- naive UTC, NULL = undated
  closed_at    TEXT,
  closed_by    TEXT,                     -- reply:<platform> | report:<turn_id> | button | cli | drop
  snoozes      TEXT                      -- json array of {at, until}; appended, never edited
);
CREATE INDEX IF NOT EXISTS idx_open_loops_open ON open_loops(kind, closed_at, due_at);
CREATE INDEX IF NOT EXISTS idx_open_loops_source ON open_loops(source_turn);

-- The lane's cursor over turn_events.id, and the two counters the grader needs
-- to say `unmeasured` honestly (a lane that has never looked at 100 turns has
-- no business reporting "0 commitments" as ok).
CREATE TABLE IF NOT EXISTS commitment_lane_state (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  last_event_id  INTEGER NOT NULL DEFAULT 0,
  turns_seen     INTEGER NOT NULL DEFAULT 0,
  calls          INTEGER NOT NULL DEFAULT 0,
  last_cycle_at  TEXT
);
INSERT OR IGNORE INTO commitment_lane_state (id) VALUES (1);
