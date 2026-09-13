-- PLAN-PROACTIVE-LOOPS P0a + P0b (2026-09-10) — the two preconditions.
--
-- Numbered 100, not 099: a parallel session's `099_turn_replays_rubric.sql`
-- had already taken 099 and applied it to the live database. See the gate in
-- `database.rs`, which triggers on this migration's own objects being absent
-- as well as on the version counter, because the counter is shared.
-- No loop ships before both land.

-- ── P0a — punctuality becomes a graded axis ────────────────────────────────
--
-- `lateness_s` has been written to every run row and read by nothing. In one
-- 7-day window 49 runs graded `did_the_job` while starting more than five
-- minutes after they were due. A number nobody grades is a number nobody
-- fixes, so the verdict is now stored beside the measurement.
--
-- `lateness_graded = 0` is the honest default: a one-shot, a run-now fire, a
-- row with no `scheduled_for`, or the negative `lateness_s` the live table
-- carries from run-now fires (min -75,918 s) is recorded as explicitly
-- UNGRADED rather than quietly skipped. A row that was never asked the
-- question must not look like one that passed it.
ALTER TABLE scheduled_task_runs ADD COLUMN lateness_graded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduled_task_runs ADD COLUMN lateness_verdict TEXT;  -- 'on_time' | 'late' | NULL when ungraded

-- ── P0b — the shared drain ─────────────────────────────────────────────────
--
-- Four curation engines already run continuously and each invented its own
-- output path: the contradiction detector reaches a person through an
-- eprintln!, the janitor through a work_logs row, the hygiene grader through a
-- command nobody types, the entity graph through a click. This is the drain
-- that stops the fifth from inventing a sixth.
--
-- `id` is sha256(loop_name || '|' || subject || '|' || bucket)[..16], so an
-- hourly loop observing one persistent condition writes ONE row and bumps
-- last_seen/occurrences rather than accreting 24 rows a day.
--
-- `evidence_json` is NOT NULL and an empty object is rejected by the writer: a
-- finding that cannot show its numbers is not a finding. That rule is what
-- lets a briefing say "ChatGPT capture went quiet 8 days ago — 703 messages
-- before, 0 since" instead of "capture may be broken".
--
-- Timestamps are naive UTC 'YYYY-MM-DD HH:MM:SS' (PLANS/PLAN-TIME-CANON.md);
-- day identity is the LOCAL day, which is the bucket's job, not the column's.
CREATE TABLE IF NOT EXISTS loop_findings (
  id            TEXT PRIMARY KEY,
  loop_name     TEXT NOT NULL,
  severity      TEXT NOT NULL,                 -- 'info' | 'notice' | 'warn' | 'critical'
  subject       TEXT NOT NULL,                 -- surface name, chunk id, task name
  title         TEXT NOT NULL,                 -- one line, user-readable, no internal jargon
  detail        TEXT,
  evidence_json TEXT NOT NULL,                 -- the numbers that justify it; '{}' forbidden
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  occurrences   INTEGER NOT NULL DEFAULT 1,
  state         TEXT NOT NULL DEFAULT 'open',  -- 'open'|'acknowledged'|'resolved'|'expired'
  resolved_at   TEXT,
  resolution    TEXT                           -- 'auto' | 'user' | 'expired'
);
CREATE INDEX IF NOT EXISTS idx_loop_findings_open ON loop_findings(state, severity, last_seen DESC)
  WHERE state = 'open';
CREATE INDEX IF NOT EXISTS idx_loop_findings_loop ON loop_findings(loop_name, last_seen DESC);
