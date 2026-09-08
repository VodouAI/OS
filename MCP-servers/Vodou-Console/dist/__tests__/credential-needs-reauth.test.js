/**
 * SEC-4 — a credential the engine cannot decrypt reaches the user as "reconnect
 * required", not as a healthy row.
 *
 * The bug: the AES key for stored credentials WAS the rotatable cloud account
 * token, so reconnecting a Vodou account turned every stored OAuth credential
 * into `""`. The engine now encrypts under a local key (`enc:v2:`) and MARKS any
 * legacy row it can no longer read (`needs_reauth`, migration 091). This pins the
 * gateway half: the card must believe the mark.
 *
 * `getRefreshState` is the one place that decides "can this self-heal?" — an
 * `expired` access token with a usable refresh token is deliberately NOT alarming,
 * so a credential that can never refresh has to be caught here or it hides forever.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { getRefreshState } from '../api/oauth.js';
function mkDb(withColumns) {
    const db = new DatabaseSync(':memory:');
    db.exec(`
    CREATE TABLE server_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL,
      credential_type TEXT NOT NULL,
      credential_value TEXT,
      refresh_failures INTEGER NOT NULL DEFAULT 0,
      refresh_last_error TEXT
      ${withColumns ? ', needs_reauth INTEGER NOT NULL DEFAULT 0, needs_reauth_reason TEXT, needs_reauth_at TEXT' : ''}
    );
    CREATE TABLE oauth_configs (id INTEGER PRIMARY KEY, server_id INTEGER, client_id TEXT);
  `);
    db.prepare("INSERT INTO server_credentials (server_id, credential_type, credential_value) VALUES (1, 'oauth_refresh_token', 'x')").run();
    db.prepare("INSERT INTO server_credentials (server_id, credential_type, credential_value) VALUES (1, 'oauth_access_token', 'y')").run();
    db.prepare("INSERT INTO oauth_configs (server_id, client_id) VALUES (1, 'client-abc')").run();
    return db;
}
describe('SEC-4: needs_reauth reaches the connection card', () => {
    let db;
    beforeEach(() => {
        db = mkDb(true);
    });
    it('a healthy row is still usable', () => {
        expect(getRefreshState(db, 1)).toEqual({ usable: true, error: null });
    });
    it('a marked row is unusable and carries the engine\'s own reason', () => {
        db.prepare("UPDATE server_credentials SET needs_reauth = 1, needs_reauth_reason = ? WHERE credential_type = 'oauth_refresh_token'").run('encrypted with the Vodou account token in use when it was saved; that token has since changed');
        const state = getRefreshState(db, 1);
        expect(state.usable).toBe(false);
        // The reason is passed through verbatim — the engine knows why, the gateway
        // does not, and paraphrasing here is how a cause becomes "something failed".
        expect(state.error).toContain('token has since changed');
    });
    it('a marked row with no reason still says what to do', () => {
        db.prepare("UPDATE server_credentials SET needs_reauth = 1 WHERE credential_type = 'oauth_access_token'").run();
        expect(getRefreshState(db, 1).error).toMatch(/reconnect required/i);
    });
    it('the verdict outranks the inferred signals', () => {
        // 0 failures, no error, a client_id present — every inferred check says fine.
        db.prepare("UPDATE server_credentials SET needs_reauth = 1, needs_reauth_reason = 'unreadable' WHERE credential_type = 'oauth_refresh_token'").run();
        expect(getRefreshState(db, 1)).toEqual({ usable: false, error: 'unreadable' });
    });
    it('a pre-091 install falls back to the old inference instead of throwing', () => {
        // The failure mode this guards: treating "no such column" as a hard error
        // would break the card on every install that has not upgraded yet.
        const old = mkDb(false);
        expect(getRefreshState(old, 1)).toEqual({ usable: true, error: null });
        old.prepare("UPDATE server_credentials SET refresh_failures = 5 WHERE credential_type = 'oauth_access_token'").run();
        expect(getRefreshState(old, 1).usable).toBe(false);
    });
});
