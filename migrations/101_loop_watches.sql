-- PLAN-PROACTIVE-LOOPS P0c (2026-09-10) — the trigger half of the loop contract.
--
-- P0b said where findings DRAIN TO. This says what makes a check run at all,
-- and without it every loop defaults to the worst available trigger: a cron row
-- on a scheduler that already starts 102 of 339 weekly runs more than five
-- minutes late.
--
-- The scaling argument is the decisive one. Polling costs
-- O(loops x cadence x corpus): at 68,192 live chunks, loop #12 as a cron row is
-- another full scan competing for that scheduler. Watching costs O(events): the
-- same loop as an armed watch costs NOTHING while idle. Cron caps out around
-- five loops. Watches do not cap.
--
-- Deterministic id — sha256(loop_name | subject | trigger_kind)[..16] — is what
-- makes re-arming an `idle` deadman REPLACE rather than accumulate. The
-- alternative is one row per sighting, which is the timer storm this table
-- exists to avoid.
--
-- `payload_json` carries what the check needs, so firing does not send anyone
-- back to the database for context it already had at arming time.
CREATE TABLE IF NOT EXISTS loop_watches (
  id           TEXT PRIMARY KEY,
  loop_name    TEXT NOT NULL,
  subject      TEXT NOT NULL,      -- surface name, queue key, chunk id, day-bucket
  trigger_kind TEXT NOT NULL,      -- 'at' | 'event' | 'idle'
  fire_at      TEXT,               -- 'at'/'idle': naive UTC 'YYYY-MM-DD HH:MM:SS'
  event_kind   TEXT,               -- 'event': the transition to listen for
  payload_json TEXT,
  armed_at     TEXT NOT NULL,
  fired_at     TEXT,
  state        TEXT NOT NULL DEFAULT 'armed'  -- 'armed'|'fired'|'cancelled'|'superseded'
);
CREATE INDEX IF NOT EXISTS idx_loop_watches_due ON loop_watches(fire_at) WHERE state = 'armed';
CREATE INDEX IF NOT EXISTS idx_loop_watches_evt ON loop_watches(event_kind) WHERE state = 'armed';
-- Firing history, for the per-loop rate ceiling the registry declares.
CREATE INDEX IF NOT EXISTS idx_loop_watches_fired ON loop_watches(loop_name, fired_at);
