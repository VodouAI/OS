-- Migration 086 — outcome state for scheduled runs, and receipts for retrieval.
--
-- WHY: nothing in this system could distinguish "did the job" from "ran without
-- crashing". A scheduled run's entire record was one free-text line in
-- work_logs: `ok (skill_id=7, 0 chars)`. Zero bytes and 4,539 bytes were both
-- `ok`. On 2026-08-17 `vodou-channel-finder` failed four consecutive runs while
-- logging `ok`, and it surfaced only because the LLM in the chat tab said so.
--
-- The second column that matters is `scheduled_for`. The scheduler selects
-- `next_run_at <= now` and then OVERWRITES next_run_at with the following slot,
-- so after a run there was no record of when it was supposed to fire. Measured
-- 2026-08-18: morning-briefing (cron `5 13 * * *`) last ran at 15:24 — 2h19m
-- late — and reported success. For a product whose proposition is "it tells you
-- what matters each morning", a briefing arriving mid-afternoon is the product
-- being wrong while claiming to be right. Lateness is a column, not a diff.
--
-- Times are naive UTC 'YYYY-MM-DD HH:MM:SS' per PLANS/PLAN-TIME-CANON.md, so
-- they compare with datetime() and date-guard.py will reject RFC3339 here.

CREATE TABLE IF NOT EXISTS scheduled_task_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id       INTEGER NOT NULL,
    task_name     TEXT    NOT NULL,
    scheduled_for TEXT,              -- the next_run_at this fire was FOR (NULL for run-now)
    started_at    TEXT    NOT NULL,
    finished_at   TEXT,
    -- 'running' | 'did_the_job' | 'could_not' | 'degraded' | 'deferred'
    -- 'deferred' = the process safety valve skipped a DUE task; nothing was
    -- started, so the row is terminal on insert. Added 2026-08-19 after a
    -- deferral was found to leave no trace at all beyond a larger lateness_s.
    -- A row left at 'running' with no finished_at is a run that was killed
    -- mid-flight (SIGTERM from a parallel restart has done exactly this), which
    -- is information the old free-text log could not represent at all.
    status        TEXT    NOT NULL,
    reason        TEXT,              -- why, for could_not / degraded
    output_chars  INTEGER,
    delivered_to  TEXT,              -- 'telegram:123' | 'console' | NULL
    delivery_ok   INTEGER,           -- 1 | 0 | NULL (none configured — distinct from failed)
    lateness_s    INTEGER,           -- started_at - scheduled_for
    meta          TEXT               -- JSON: skill_id, tools declared vs called, …
);

CREATE INDEX IF NOT EXISTS idx_str_task    ON scheduled_task_runs(task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_str_status  ON scheduled_task_runs(status, started_at);

-- Retrieval receipts.
--
-- Memory is injected into the PROMPT at dispatch time and kept only in process
-- memory (llm.ts recordMemoriesInjected / getLastMemoryUsed). Nothing durable
-- records that it happened: of 41,428 stored user turns, 67 contain a
-- "Relevant Memories" block, and those are leakage into stored text rather than
-- a count of retrievals. So the central retention claim — "it remembers you" —
-- could not be demonstrated from data at rest, not to a user and not to us.
CREATE TABLE IF NOT EXISTS turn_receipts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    turn_id         TEXT,
    at              TEXT NOT NULL,
    memories_used   INTEGER NOT NULL DEFAULT 0,
    memory_ids      TEXT,            -- JSON array
    degraded        TEXT             -- NULL | 'timeout' | 'socket_error' | 'conn-refused'
);

CREATE INDEX IF NOT EXISTS idx_turn_receipts_conv ON turn_receipts(conversation_id, at);
