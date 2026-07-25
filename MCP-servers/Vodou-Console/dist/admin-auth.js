/**
 * Admin-route authentication for destructive gateway routes.
 *
 * PLAN-MASTER-EXECUTION-ORDER item 1 (S-AUTH) / PLAN-SECURITY-AUDIT-FINDINGS #3.
 *
 * The problem: `POST /api/system/update-install|update-rollback|
 * update-components-apply` replace or downgrade the running binary with a
 * caller-controlled `--select`, and `POST /api/servers` + `/api/servers/install`
 * interpolate caller argv into `vodou-core connect` / `npx --yes`. All five were
 * loopback-gated only, never authenticated.
 *
 * The CSRF guard (index.ts) already blocks browser-originated cross-site writes
 * (`Origin` / `Sec-Fetch-Site` are browser-set and unforgeable), so a malicious
 * *webpage* could not reach these. What remained is **Origin-less local callers**
 * — curl, a shell script, an npm postinstall — which that guard trusts by design.
 * Given `npm install` inside `MCP-servers/` is a documented workflow, that's a
 * real path to binary replacement.
 *
 * The fix, per the "restrict identity, not capability" rule: prove the caller is
 * the owner. Nothing the owner can do becomes impossible — the console UI keeps
 * working with zero user-visible change, and scripted owner use keeps working by
 * sending the token it already has on disk.
 *
 * Secret: the per-install `.vodou/console.token` that `vodou-core`'s daemon
 * already provisions on first start (`src/api_http/mod.rs` → `ensure_console_token`,
 * mode 0600) and that this gateway already uses as a Bearer token when calling
 * core's internal API (`core-sdk.ts`, `core-client.ts`). Reusing it means no
 * second secret scheme to provision, rotate, or document.
 *
 * Two accepted proofs:
 *   1. `Authorization: Bearer <console.token>` — scripted/CLI owner use.
 *   2. Cookie `vodou_admin=<console.token>` — set httpOnly + SameSite=Strict when
 *      the gateway serves its own UI shell, so the browser replays it on
 *      same-origin fetches automatically. No frontend change, and the value is
 *      never readable from page JS (httpOnly), so console XSS cannot exfiltrate it.
 *
 * Threat-model honesty: a same-user local process can read `.vodou/console.token`
 * itself. This does not stop an attacker who already knows to look there — it
 * stops the blind, drive-by POST to localhost, which is the actual observed shape
 * of postinstall/script compromise. Raising that bar is the goal; claiming more
 * would be dishonest.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
export const ADMIN_COOKIE = 'vodou_admin';
/** Same resolution as core-sdk.ts / core-client.ts — keep these in agreement. */
function tokenPath() {
    const root = process.env.VODOU_PROJECT_PATH || process.cwd();
    return path.join(root, '.vodou', 'console.token');
}
let cached = null;
/**
 * Read the per-install admin secret. Cached, because this sits on request paths.
 * `force` re-reads from disk — used on a failed compare so a rotated token starts
 * working without a gateway restart.
 */
export function getAdminToken(force = false) {
    if (cached && !force)
        return cached;
    try {
        const value = fs.readFileSync(tokenPath(), 'utf-8').trim();
        cached = value || null;
        return cached;
    }
    catch {
        cached = null;
        return null;
    }
}
/** Constant-time compare that tolerates unequal lengths without leaking them. */
function tokenMatches(candidate, expected) {
    const a = Buffer.from(candidate);
    const b = Buffer.from(expected);
    if (a.length !== b.length)
        return false;
    return crypto.timingSafeEqual(a, b);
}
/** Minimal cookie parse — avoids adding a dependency to a vendored node_modules. */
function cookieValue(header, name) {
    if (!header)
        return null;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1)
            continue;
        if (part.slice(0, eq).trim() !== name)
            continue;
        try {
            return decodeURIComponent(part.slice(eq + 1).trim());
        }
        catch {
            return part.slice(eq + 1).trim();
        }
    }
    return null;
}
function presentedToken(req) {
    const auth = req.headers.authorization;
    if (auth && /^Bearer\s+/i.test(auth)) {
        const value = auth.replace(/^Bearer\s+/i, '').trim();
        if (value)
            return value;
    }
    return cookieValue(req.headers.cookie, ADMIN_COOKIE);
}
/**
 * Attach the admin cookie when serving the UI shell, so the console's existing
 * `fetch` calls (same-origin, credentials default) authenticate with no frontend
 * change. No-op when the token has not been provisioned yet.
 */
export function issueAdminCookie(res) {
    const token = getAdminToken();
    if (!token)
        return;
    res.cookie(ADMIN_COOKIE, token, {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        // No `secure`: the gateway is plain http on loopback.
    });
}
/**
 * Express middleware for destructive routes.
 *
 * Fails CLOSED when the token has not been provisioned — that state means the
 * daemon has never started, in which case binary-update and server-connect could
 * not do anything useful anyway. The 503 says exactly how to fix it.
 */
export function requireAdmin(req, res, next) {
    const expected = getAdminToken();
    if (!expected) {
        console.error(`[admin-auth] DENY ${req.method} ${req.originalUrl}: no admin token at ${tokenPath()} — ` +
            `start the Vodou daemon once to provision it.`);
        res.status(503).json({
            error: 'admin token not provisioned',
            detail: 'Start the Vodou daemon once so it can create .vodou/console.token, then retry.',
        });
        return;
    }
    const presented = presentedToken(req);
    if (presented && tokenMatches(presented, expected)) {
        next();
        return;
    }
    // Rotation tolerance: re-read once before rejecting, in case the token changed
    // under a long-lived gateway process.
    if (presented) {
        const fresh = getAdminToken(true);
        if (fresh && tokenMatches(presented, fresh)) {
            next();
            return;
        }
    }
    console.error(`[admin-auth] DENY ${req.method} ${req.originalUrl}: ` +
        `${presented ? 'invalid admin token' : 'no admin token presented'} ` +
        `(ua=${String(req.headers['user-agent'] || 'none').slice(0, 60)})`);
    res.status(401).json({
        error: 'admin authentication required',
        detail: 'This route replaces binaries or spawns processes. Send Authorization: Bearer <contents of .vodou/console.token>, ' +
            'or use the Vodou console UI (which authenticates automatically).',
    });
}
