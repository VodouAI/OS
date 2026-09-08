-- 091 — SEC-4 / RE-4: a credential that cannot be read is not an empty credential.
--
-- The AES key for `server_credentials.credential_value` used to be
-- SHA-256(VODOU_TOKEN) — the rotatable cloud account token. Reconnecting a Vodou
-- account therefore destroyed every stored OAuth credential, and the read path
-- returned "" for each one, so the failure reached the user as "Gmail stopped
-- working" with nothing connecting it to the reconnect.
--
-- credential_crypto.rs now encrypts under a local data key (.vodou/credential.key,
-- enc:v2:) that nothing rotates. These columns carry the other half: a row whose
-- legacy enc:v1: value can no longer be decrypted is MARKED, not silently emptied.
--
-- needs_reauth        1 = the stored value is unrecoverable; the server must be
--                     reconnected / the key re-entered.
-- needs_reauth_reason human-readable cause, shown to the operator verbatim.
-- needs_reauth_at     when it was first detected (naive UTC, PLAN-TIME-CANON).

ALTER TABLE server_credentials ADD COLUMN needs_reauth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE server_credentials ADD COLUMN needs_reauth_reason TEXT;
ALTER TABLE server_credentials ADD COLUMN needs_reauth_at TEXT;

CREATE INDEX IF NOT EXISTS idx_server_credentials_needs_reauth
    ON server_credentials(needs_reauth) WHERE needs_reauth = 1;
