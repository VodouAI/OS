/**
 * Console Two — gateway-side plumbing (PLANS/0.6.23/PLAN-CONSOLE-TWO.md §3,
 * code spec in PLAN-CONSOLE-TWO-IMPL.md §2).
 *
 * Three additive pieces, all mounted BEFORE express.static so they see requests
 * first. Nothing here changes behavior for existing routes or callers:
 *
 *  (a) frame-ancestors CSP on HTML responses. The gateway previously sent NO
 *      frame guard, so any website could frame the console (and read nothing,
 *      but click-jack plenty). This CLOSES that hole while allowlisting our own
 *      extension, whose id is recorded at bridge pair time (`bridge_ext_id`).
 *  (b) GET /panel/ — serves public/index.html verbatim plus ONE extra
 *      stylesheet link (09-panel-density.css). Same-origin with the SPA, so
 *      every fetch/WS the framed console makes behaves exactly as at `/`.
 *      The desktop console never loads that CSS — `/` is untouched.
 *  (c) GET /ext-session — the SameSite=Strict escape hatch. Framed under a
 *      chrome-extension:// top-level, the Strict admin cookie is NOT sent, so
 *      requireAdmin routes would 403 inside the panel only. This route
 *      re-issues the SAME admin token as None+Secure+Partitioned (CHIPS),
 *      gated on the bridge pairing token, then 302s to /panel/ (the URL
 *      fragment survives the redirect, so `#/memory` etc. land intact).
 */
import * as fs from 'fs';
import * as path from 'path';
import { getSetting } from '../db.js';
import { ADMIN_COOKIE, getAdminToken } from '../admin-auth.js';
export function mountConsoleTwo(app, publicDir) {
    // ── (a) frame-ancestors CSP ────────────────────────────────────────────────
    app.use((req, res, next) => {
        if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html')) {
            let extId = null;
            try {
                extId = getSetting('bridge_ext_id');
            }
            catch { /* DB not up yet — default to 'self' */ }
            // Vodou One frames the memory map in its Brain tray
            // (PLAN-BRAIN-STANDALONE-RETIRE §3). It is a first-party surface on this
            // machine that already proxies this gateway's API, and without it here the
            // frame is blocked SILENTLY — a dead panel, no console error, nothing in
            // the network tab that reads as a refusal. Loopback only, and only the
            // port One actually runs on, so this widens the policy by exactly one
            // origin we already ship. Kept in sync with `VODOU_ONE_PORT`.
            const onePort = parseInt(process.env.VODOU_ONE_PORT || '8768', 10) || 8768;
            const oneOrigins = [`http://127.0.0.1:${onePort}`, `http://localhost:${onePort}`];
            const ancestors = [
                `'self'`,
                ...(extId ? [`chrome-extension://${extId}`] : []),
                ...oneOrigins,
            ].join(' ');
            res.setHeader('Content-Security-Policy', `frame-ancestors ${ancestors}`);
        }
        next();
    });
    // ── (b) /panel/ — density-shimmed console ─────────────────────────────────
    app.get(['/panel', '/panel/'], (_req, res) => {
        const indexPath = path.join(publicDir, 'index.html');
        let html;
        try {
            html = fs.readFileSync(indexPath, 'utf8');
        }
        catch {
            res.status(500).json({ error: 'public/index.html missing — reinstall Vodou' });
            return;
        }
        res.type('html').set('Cache-Control', 'no-store').send(html.replace('</head>', '<link rel="stylesheet" href="/css/09-panel-density.css"></head>'));
    });
    // ── (b2) /two/ — the Console Two shell ────────────────────────────────────
    // express.static mounts with `index: false` (deliberately — see index.ts), so
    // /two/ would not resolve to its index.html without this. Assets under
    // /two/*.js|css are served by static as normal files.
    app.get(['/two', '/two/'], (_req, res) => {
        res.set('Cache-Control', 'no-store')
            .sendFile(path.join(publicDir, 'two', 'index.html'));
    });
    // ── (c) /ext-session — partitioned admin cookie for the framed panel ──────
    app.get('/ext-session', (req, res) => {
        const offered = String(req.query.t || '');
        let expected = null;
        try {
            expected = getSetting('bridge_token');
        }
        catch {
            expected = null;
        }
        if (!expected || !offered || offered !== expected) {
            // Same fail-closed posture as pairing itself: no token provisioned means
            // the bridge has never paired, and nothing should be framing us yet.
            res.status(403).json({ error: 'pairing token required' });
            return;
        }
        const token = getAdminToken();
        if (token) {
            // Written as a raw header (not res.cookie): `Partitioned` needs to be in
            // the string regardless of cookie-lib version, and the explicit string is
            // easier to audit. `Secure` is valid — Chrome treats http://127.0.0.1 as
            // a secure (trustworthy) context. Same name as issueAdminCookie, so the
            // partitioned copy and the Strict copy carry the same value and either
            // satisfies requireAdmin.
            res.append('Set-Cookie', `${ADMIN_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned`);
        }
        res.redirect(302, '/panel/');
    });
}
