-- 080_mcp_clients.sql — per-client identity for MCP egress
-- (PLAN-MCP-EGRESS-MEMORY T2.1, 2026-08-05).
--
-- Before this, every attached client presented the SAME token (.vodou/console.token)
-- and the server carried ONE profile and ONE vault for all of them. Two clients could
-- not be scoped differently, nothing could be revoked without rotating the token every
-- client shares, and an audit log had no subject to name.
--
-- token_hash is a SHA-256 hex digest. The plaintext token is shown ONCE at mint time and
-- never stored: a registry that can hand back its own credentials is a second copy of
-- every secret in it. Hashing also removes the need for a constant-time compare on this
-- path — lookup is by digest, and a timing signal on a digest reveals nothing invertible.
--
-- revoked_at is a tombstone rather than a DELETE so a revoked client stays in `mcp
-- clients` output and in any audit trail that references it.

CREATE TABLE IF NOT EXISTS mcp_clients (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id    TEXT NOT NULL UNIQUE,
    label        TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    profile      TEXT NOT NULL DEFAULT 'memory',
    vault        TEXT NOT NULL DEFAULT 'portable',
    -- Naive UTC 'YYYY-MM-DD HH:MM:SS' per PLAN-TIME-CANON; compare with datetime(),
    -- render local at the display layer.
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT,
    revoked_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_mcp_clients_token ON mcp_clients(token_hash);
CREATE INDEX IF NOT EXISTS idx_mcp_clients_active ON mcp_clients(revoked_at);
