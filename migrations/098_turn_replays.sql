-- PLAN-LOOPS-THAT-READ-THE-RECEIPTS P3 (2026-09-10) — counterfactual replay.
--
-- "What did your memory change?" answered by measurement rather than belief:
-- take a turn that actually happened, run it again with the memory lane
-- REMOVED, and ask a judge whether the answer changed in a way the person
-- would notice.
--
-- This table outlives the payloads it was derived from. `VODOU_TURN_LOG_DAYS`
-- (14) nulls request/reply text and keeps hashes, so a view over turn_events
-- would reset every fortnight and the weekly number would never accumulate.
CREATE TABLE IF NOT EXISTS turn_replays (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id      TEXT NOT NULL,
  ablated_lane TEXT NOT NULL,              -- 'memory' today; doc_attach / budget later
  changed      TEXT NOT NULL,              -- yes | no | unknown  (never a guess)
  judge        TEXT,                       -- the judge's own words, trimmed
  provider     TEXT,                       -- which model answered, for cost and for doubt
  at           TEXT NOT NULL,              -- naive UTC, time canon
  UNIQUE(turn_id, ablated_lane)
);
CREATE INDEX IF NOT EXISTS idx_turn_replays_at ON turn_replays(at);
