/**
 * GW-3 — an unmatched /api route answered HTML.
 *
 * Express's default 404 renders an error PAGE, so a JSON client that hit a
 * typo'd or removed endpoint received `<!DOCTYPE html>…<pre>Cannot GET
 * /api/…</pre>` and died at JSON.parse with a complaint about an unexpected
 * `<`. That sends someone to debug their parser instead of their URL.
 *
 * Verified against the live gateway before the fix: `status=404
 * type=text/html`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
const servers = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r()))));
});
/** The gateway's shape: routes, the /api 404, then the error middleware. */
async function serve() {
    const app = express();
    app.get('/api/real', (_req, res) => { res.json({ ok: true }); });
    app.use('/api', (req, res) => {
        res.status(404).json({ ok: false, error: `no such endpoint: ${req.method} ${req.baseUrl}${req.path}` });
    });
    // Static-ish fallthrough for everything that is NOT /api.
    app.use((_req, res) => { res.status(404).type('html').send('<!DOCTYPE html><p>spa</p>'); });
    const server = http.createServer(app);
    servers.push(server);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${server.address().port}`;
}
describe('GW-3 — the API 404 speaks JSON', () => {
    it('answers JSON, not an HTML error page', async () => {
        const base = await serve();
        const res = await fetch(`${base}/api/definitely-not-a-real-route`);
        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toMatch(/application\/json/);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(body.error, 'names the method and path so the caller can see the typo').toContain('/definitely-not-a-real-route');
    });
    it('names the METHOD too — a GET on a POST-only route is the common case', async () => {
        const base = await serve();
        const body = await (await fetch(`${base}/api/real`, { method: 'POST' })).json();
        expect(body.error).toContain('POST');
    });
    it('does not swallow routes that DO exist', async () => {
        const base = await serve();
        const res = await fetch(`${base}/api/real`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
    });
    it('leaves non-/api paths to the app shell', async () => {
        // The single-page app serves its own routes from the static handler; an
        // API-shaped 404 there would break deep links.
        const base = await serve();
        const res = await fetch(`${base}/settings`);
        expect(res.headers.get('content-type')).toMatch(/html/);
    });
});
