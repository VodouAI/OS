-- 095: connection_health — a connector's health is a ledger row with a reason, not a word.
--
-- PLAN-CONNECTIONS-THAT-STAY-ALIVE §3.1 (PLANS/0.6.31/04-…). Six of six OAuth
-- access tokens on the reference install were expired for two to four months
-- while `health_status` said "unhealthy" — one word for four different worlds
-- (never configured, expired-and-unrefreshable, expired-but-refreshable,
-- reachable-but-erroring). This row carries the STATE (a closed set, derived by
-- one pure function in src/connection_health.rs), the REASON in a sentence, and
-- the four pieces of evidence the state was derived from, so a reader can check
-- the verdict against its inputs.
--
-- One writer (the 5-minute OAuth sweep, after each pass, plus the grader on
-- demand); readers: `vodou-core connections`, `flows`, the chat-side 401
-- rewrite. `health_status` on mcp_servers is untouched — it stays the worker's
-- own boolean; this is the human-facing truth beside it.
--
-- No token values, no client secrets: reasons are classes and sentences.
-- Time canon: instants are naive UTC `YYYY-MM-DD HH:MM:SS`.
CREATE TABLE IF NOT EXISTS connection_health (
    server_id        INTEGER PRIMARY KEY REFERENCES mcp_servers(id) ON DELETE CASCADE,
    state            TEXT NOT NULL,
    reason           TEXT,
    cred_expires_at  TEXT,
    cred_lifetime_s  INTEGER,
    refresh_outcome  TEXT,
    last_ok_call_at  TEXT,
    last_err_call_at TEXT,
    probe_outcome    TEXT,
    probe_at         TEXT,
    computed_at      TEXT NOT NULL
);
