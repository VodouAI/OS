-- 093 — PLAN-AUTOMATIONS-WATCH-WHAT-VODOU-KNOWS P2: a skill action is one LLM
-- turn per event, so a run is capped. Events past the cap are deferred to the
-- next run (kept out of last_seen_ids; the feed cursor is held at the last
-- processed item), never dropped.
ALTER TABLE automations ADD COLUMN max_events_per_run INTEGER DEFAULT 5;
