-- ─────────────────────────────────────────────────────────────────────────────
-- vodou-core.db — migration 070 — board_config
-- KV settings for the Vodou Board dispatcher + JWT signing key.
-- Lives in vodou-core.db (not gateway.db) because gateway.db has no migration
-- runner; vodou-core.db has the working runner at src/database.rs::ensure_migrations().
-- The Node gateway reads this via getDb() — same connection as everything else.
--
-- Audit-corrected 2026-05-13 (PLANS/0.5.78 audit pass 2). Originally proposed
-- as a gateway.db migration; reverted.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS board_config (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Default values, idempotent. The HMAC key (write_token_key_b64) is generated
-- at first dispatcher boot by src/board/jwt.rs — NOT seeded here.
INSERT OR IGNORE INTO board_config (key, value) VALUES
    ('dispatch_interval_secs',          '30'),
    ('max_parallel_per_tick',           '5'),
    ('claim_ttl_secs',                  '900'),
    ('circuit_breaker_limit',           '5'),
    ('default_max_runtime_secs',        '1800'),
    ('default_max_retries',             '3'),
    ('approval_ttl_secs',               '86400'),
    ('blocker_investigation_enabled',   '0'),
    ('onboarding_seen',                 '0'),
    ('memory_injection_top_k',          '8'),
    ('memory_injection_min_cosine',     '0.35');

COMMIT;
