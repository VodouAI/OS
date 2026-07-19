/**
 * Vodou Board JWT auth middleware (Day-8).
 *
 * Verifies HS256 bearer tokens minted by the Rust dispatcher (src/board/jwt.rs).
 * The shared signing key lives in vodou-core.db::board_config.write_token_key_b64
 * — same row both sides read. No IPC. The key never leaves the local box.
 *
 * Behavior:
 *   - VODOU_BOARD_REQUIRE_JWT unset  → missing/invalid header is allowed
 *     (backward compat for CLI + dashboard during Phase-1 rollout). When a
 *     valid token IS present, req.principal_id is still populated.
 *   - VODOU_BOARD_REQUIRE_JWT=1      → missing/expired/tampered/wrong-task
 *     tokens return 401.
 *
 * Task-id binding: the middleware reads `:id` from req.params and rejects
 * tokens whose claim doesn't match. Routes without an :id param skip that
 * check (mint/dispatch endpoints).
 *
 * Key cache: 60s in-memory cache to avoid hammering vodou-core.db every
 * request. Cleared lazily on TTL.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const KEY_CACHE_TTL_MS = 60_000;
const CONFIG_KEY_NAME = 'write_token_key_b64';
let cachedKey = null;
let cachedAt = 0;
function projectRoot() {
    const envRoot = process.env.VODOU_PROJECT_PATH;
    if (envRoot && existsSync(path.join(envRoot, 'vodou-core.db')))
        return envRoot;
    return path.resolve(import.meta.dirname ?? __dirname, '../../..');
}
function loadKey() {
    const now = Date.now();
    if (cachedKey && now - cachedAt < KEY_CACHE_TTL_MS)
        return cachedKey;
    const corePath = path.join(projectRoot(), 'vodou-core.db');
    if (!existsSync(corePath))
        return null;
    let conn = null;
    try {
        conn = new DatabaseSync(corePath, { readOnly: true, timeout: 5000 });
        const row = conn
            .prepare('SELECT value FROM board_config WHERE key = ?')
            .get(CONFIG_KEY_NAME);
        if (!row?.value)
            return null;
        // Rust mints with URL_SAFE_NO_PAD; tolerate standard b64 too.
        const b64 = row.value;
        const buf = b64UrlDecode(b64);
        cachedKey = buf;
        cachedAt = now;
        return buf;
    }
    catch (e) {
        console.error('[board.auth] loadKey failed:', e.message);
        return null;
    }
    finally {
        try {
            conn?.close();
        }
        catch { /* ignore */ }
    }
}
function b64UrlDecode(s) {
    // Convert URL-safe → standard, pad to length%4
    const std = s.replace(/-/g, '+').replace(/_/g, '/');
    const pad = std.length % 4 === 0 ? '' : '='.repeat(4 - (std.length % 4));
    return Buffer.from(std + pad, 'base64');
}
function verifyToken(token, expectedTaskId) {
    const parts = token.split('.');
    if (parts.length !== 3)
        throw new Error('malformed JWT (parts != 3)');
    const [headerB64, payloadB64, sigB64] = parts;
    const headerRaw = b64UrlDecode(headerB64).toString('utf8');
    const header = JSON.parse(headerRaw);
    if (header.alg !== 'HS256')
        throw new Error('unsupported alg (need HS256)');
    const key = loadKey();
    if (!key)
        throw new Error('signing key unavailable (board_config missing)');
    const signingInput = `${headerB64}.${payloadB64}`;
    const expected = crypto.createHmac('sha256', key).update(signingInput).digest();
    const given = b64UrlDecode(sigB64);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
        throw new Error('signature mismatch');
    }
    const claims = JSON.parse(b64UrlDecode(payloadB64).toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp < now)
        throw new Error(`token expired (exp=${claims.exp} now=${now})`);
    if (expectedTaskId && claims.task_id !== expectedTaskId) {
        throw new Error(`task_id mismatch: token=${claims.task_id} url=${expectedTaskId}`);
    }
    return claims;
}
/**
 * Express middleware. Apply to write routes. Reads:
 *   - Authorization: Bearer <token>
 *   - req.params.id (task id, optional)
 *
 * On success, populates req.principal_id from the claim.
 * On failure: 401 if VODOU_BOARD_REQUIRE_JWT=1, else next() (header allowed
 * to be absent during Phase-1 rollout).
 */
export function boardJwtMiddleware(req, res, next) {
    const required = process.env.VODOU_BOARD_REQUIRE_JWT === '1';
    const hdr = (req.headers.authorization ?? '').trim();
    if (!hdr) {
        if (required) {
            res.status(401).json({ error: 'missing Authorization: Bearer header' });
            return;
        }
        next();
        return;
    }
    if (!hdr.toLowerCase().startsWith('bearer ')) {
        if (required) {
            res.status(401).json({ error: 'malformed Authorization header (need Bearer)' });
            return;
        }
        next();
        return;
    }
    const token = hdr.slice(7).trim();
    const expectedTaskId = req.params?.id ?? null;
    try {
        const claims = verifyToken(token, expectedTaskId);
        req.principal_id = claims.principal_id;
        req.board_run_id = claims.run_id;
        next();
    }
    catch (e) {
        const msg = e.message;
        if (required) {
            res.status(401).json({ error: `jwt verify failed: ${msg}` });
            return;
        }
        // Backward-compat: log + allow through.
        console.warn('[board.auth] token present but invalid (allowed; set VODOU_BOARD_REQUIRE_JWT=1 to enforce):', msg);
        next();
    }
}
export function _clearKeyCacheForTests() {
    cachedKey = null;
    cachedAt = 0;
}
