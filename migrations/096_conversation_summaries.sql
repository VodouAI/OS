-- 096: conversation_summaries — the thread that lasts months carries its
-- decisions, not its transcript.
--
-- PLAN-LONG-CONVERSATION-CONTINUITY §3.2 (PLANS/0.6.31/02-…), built as P3-first:
-- the daemon's extraction cycle is the ONE writer (src/conversation_summary.rs,
-- on the extraction provider, like every janitorial lane); the gateway's three
-- history assemblers only READ this table. That is why it lives here in
-- vodou-core.db (daemon-owned) rather than gateway.db as the plan first wrote:
-- cross-store identity is resolved through the owner (lane canon rule 4).
--
-- Keyed by COUNT, not message id: the gateway's in-memory conversation carries
-- no gateway_messages ids, so a reader can only say "the first N text-bearing
-- messages are folded"; `covered_through_msg_id` is kept for the checkable
-- claim (§3.4 — which transcript slice `source_hash` names).
--
-- summary_json is the §3.1 object: decisions[], open_asks[], entities[],
-- last_state, every item with the transcript line it was folded from.
-- `dropped_items` counts what the deterministic honesty filter removed;
-- `judge_ok`/`judge_total` are the sampled fact-in-source verdicts (§3.4).
-- Time canon: updated_at is a naive-UTC instant.
CREATE TABLE IF NOT EXISTS conversation_summaries (
    conversation_id        TEXT PRIMARY KEY,
    covered_through_msg_id INTEGER NOT NULL,
    covered_count          INTEGER NOT NULL,
    summary_json           TEXT NOT NULL,
    text                   TEXT NOT NULL,
    chars                  INTEGER NOT NULL,
    model                  TEXT NOT NULL,
    source_hash            TEXT NOT NULL,
    dropped_items          INTEGER NOT NULL DEFAULT 0,
    judge_ok               INTEGER,
    judge_total            INTEGER,
    updated_at             TEXT NOT NULL
);
