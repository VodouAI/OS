-- PLAN-SEAMS-AND-SESSION-LOG P0d — one turn record.
--
-- `turn_events` began in gateway.db (TS-owned) because the gateway is what
-- assembles a turn. Within a day that produced two records of one turn which
-- had already drifted: three lanes the Console receipt could show that the log
-- could not, and eight the log held that the user could not see. Lane canon
-- rule 1 — two lanes get one identity and one arbiter — and the arbiter has to
-- be the side that outlives the other.
--
-- It moves here because a Cursor or Claude-Code session works with the gateway
-- stopped, and those turns must be recordable too. The gateway now sends ONE
-- batch per turn over the daemon socket; the batch boundary is the TURN, never
-- a count or a timer, because half a turn cannot derive.

CREATE TABLE IF NOT EXISTS turn_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id         TEXT    NOT NULL,
    conversation_id TEXT    NOT NULL,
    seq             INTEGER NOT NULL,
    at              TEXT    NOT NULL,
    kind            TEXT    NOT NULL,
    lane            TEXT,
    trust           TEXT,
    provider        TEXT,
    chars           INTEGER NOT NULL DEFAULT 0,
    ms              INTEGER,
    content_hash    TEXT    NOT NULL,
    payload         TEXT,
    payload_ref     TEXT,
    meta            TEXT,
    -- The producer: which surface assembled this turn. `gateway` today; `hook`
    -- (Cursor / Claude Code), `capture` (ChatGPT / Claude / Gemini) and `mcp`
    -- become callers of the same verb rather than separate integrations.
    source          TEXT    NOT NULL DEFAULT 'gateway',
    UNIQUE(turn_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_turn_events_turn ON turn_events(turn_id, seq);
CREATE INDEX IF NOT EXISTS idx_turn_events_conv ON turn_events(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_turn_events_at   ON turn_events(at);

-- Payloads stored once and referenced. A 24 KB bootstrap on 900 turns/day is
-- 21 MB/day copied otherwise.
CREATE TABLE IF NOT EXISTS turn_event_blobs (
    ref        TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    chars      INTEGER NOT NULL,
    payload    TEXT,
    first_seen TEXT NOT NULL
);
