-- PLAN-SKILL-LEARNING-LOOP Phase 4 — curriculum / self-practice.
-- The pending queue of practice tasks the curriculum miner drafts from real
-- FAILURE signals (failed/abandoned/corrected trajectories + timed-out/errored
-- routes). Rows sit 'pending' until the operator opts into autonomous execution
-- (VODOU_SKILL_CURRICULUM_AUTORUN=1), at which point up to N are run per pass.
-- gap_hash is the stable cluster identity so re-mining the same gap is idempotent.
CREATE TABLE IF NOT EXISTS skill_practice_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gap_hash TEXT NOT NULL UNIQUE,
    gap_label TEXT NOT NULL,
    practice_prompt TEXT NOT NULL,
    source_size INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending|enqueued|done|skipped
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    enqueued_at DATETIME,
    last_outcome TEXT
);
CREATE INDEX IF NOT EXISTS idx_practice_status ON skill_practice_queue(status);
