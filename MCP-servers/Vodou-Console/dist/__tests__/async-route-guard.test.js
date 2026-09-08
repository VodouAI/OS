/**
 * CO-2 — a rejected async handler must answer, not hang.
 *
 * The failure this covers is not "returns the wrong status"; it is "returns
 * NOTHING". A scheduled skill_run whose skill could not be prepared burned the
 * scheduler's whole 1800s client budget and was then filed `unknown` — a
 * deterministic failure recorded as ignorance, holding a valve slot for half an
 * hour. So every case here asserts against a real server with a real socket and
 * a deadline, because a test that only inspects a response object cannot tell
 * "500" from "never".
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import { catchAsyncRouteFaults } from '../async-route-guard.js';
const servers = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r()))));
});
/** Start an app on an ephemeral port and return its base URL. */
async function serve(app) {
    const server = http.createServer(app);
    servers.push(server);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    return `http://127.0.0.1:${addr.port}`;
}
/** A request that FAILS if the server does not answer — the actual bug. */
async function get(url, timeoutMs = 3000) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ac.signal });
        return { status: res.status, body: await res.text() };
    }
    catch (e) {
        if (e.name === 'AbortError') {
            throw new Error(`the server never answered ${url} within ${timeoutMs}ms — this is the CO-2 hang`);
        }
        throw e;
    }
    finally {
        clearTimeout(t);
    }
}
/** The gateway's shape: routes, then the guard, then GW-11's error middleware. */
function buildApp(register) {
    const app = express();
    register(app);
    const wrapped = catchAsyncRouteFaults(app);
    app.use((err, _req, res, _next) => {
        if (res.headersSent) {
            try {
                res.end();
            }
            catch { /* gone */ }
            return;
        }
        res.status(500).json({ ok: false, error: err?.message || String(err) });
    });
    return { app, wrapped };
}
describe('CO-2 — async route faults answer instead of hanging', () => {
    it('WITHOUT the guard, a rejected async handler never answers', async () => {
        // The baseline. If this ever starts passing, Express began awaiting
        // handlers and the guard can go — but it must be proven, not assumed.
        const app = express();
        app.get('/boom', ((_req, _res) => {
            const p = (async () => { throw new Error('skill could not be prepared'); })();
            // Attach a no-op catch, and ONLY for the process's benefit.
            //
            // This test demonstrates the bug on purpose, which means it creates a
            // genuinely unhandled rejection — and vitest counts one of those as an
            // Errors: 1 that makes `npm test` EXIT 1 while printing "1472 passed".
            // A suite that is green in its own summary and red to CI is worse than a
            // failing test, because the summary is what people read.
            //
            // The catch does not weaken the assertion by even a little: Express 4
            // ignores a handler's return value, so nothing here makes it answer the
            // request. That is the entire claim below, and it still holds.
            p.catch(() => { });
            return p;
        }));
        app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
        const base = await serve(app);
        await expect(get(`${base}/boom`, 800)).rejects.toThrow(/never answered/);
    });
    it('WITH the guard, the same handler answers 500 and names the cause', async () => {
        const { app } = buildApp((a) => {
            a.get('/boom', async () => { throw new Error('skill could not be prepared'); });
        });
        const base = await serve(app);
        const r = await get(`${base}/boom`);
        expect(r.status).toBe(500);
        expect(r.body).toContain('skill could not be prepared');
    });
    it('covers handlers inside a mounted Router, not just app-level ones', async () => {
        // 154 of the gateway's async handlers live in routers under /api.
        const { app } = buildApp((a) => {
            const r = express.Router();
            r.post('/fire', async () => { throw new Error('router lane threw'); });
            a.use('/api/skill', r);
        });
        const base = await serve(app);
        const res = await fetch(`${base}/api/skill/fire`, { method: 'POST' });
        expect(res.status).toBe(500);
        expect(await res.text()).toContain('router lane threw');
    });
    it('covers a router mounted inside another router', async () => {
        const { app } = buildApp((a) => {
            const inner = express.Router();
            inner.get('/deep', async () => { throw new Error('nested threw'); });
            const outer = express.Router();
            outer.use('/inner', inner);
            a.use('/outer', outer);
        });
        const base = await serve(app);
        const r = await get(`${base}/outer/inner/deep`);
        expect(r.status).toBe(500);
        expect(r.body).toContain('nested threw');
    });
    it('leaves working routes exactly as they were', async () => {
        const { app } = buildApp((a) => {
            a.get('/ok', async (_req, res) => { res.json({ ok: true, v: 1 }); });
            a.get('/sync', (_req, res) => { res.json({ ok: true, v: 2 }); });
        });
        const base = await serve(app);
        expect(JSON.parse((await get(`${base}/ok`)).body)).toEqual({ ok: true, v: 1 });
        expect(JSON.parse((await get(`${base}/sync`)).body)).toEqual({ ok: true, v: 2 });
    });
    it('a fault does not take the server down — the next request still works', async () => {
        // The GW-11 property, re-asserted through the async path it did not cover.
        const { app } = buildApp((a) => {
            a.get('/boom', async () => { throw new Error('one bad request'); });
            a.get('/ok', async (_req, res) => { res.json({ alive: true }); });
        });
        const base = await serve(app);
        expect((await get(`${base}/boom`)).status).toBe(500);
        expect(JSON.parse((await get(`${base}/ok`)).body)).toEqual({ alive: true });
    });
    it('does NOT wrap error middleware, which Express identifies by arity', async () => {
        // Wrapping a 4-arity handler silently demotes it to an ordinary handler
        // that never runs on an error — the failure would be a hang again, one
        // layer further on.
        let errorMiddlewareRan = false;
        const app = express();
        app.get('/boom', async () => { throw new Error('x'); });
        app.use((err, _req, res, _next) => {
            errorMiddlewareRan = true;
            res.status(500).json({ error: err.message });
        });
        catchAsyncRouteFaults(app); // after the error middleware, on purpose
        const base = await serve(app);
        expect((await get(`${base}/boom`)).status).toBe(500);
        expect(errorMiddlewareRan, 'the 4-arity handler still ran').toBe(true);
    });
    it('a mid-stream fault ends the response instead of throwing headers-sent', async () => {
        const { app } = buildApp((a) => {
            a.get('/half', async (_req, res) => {
                res.write('partial');
                throw new Error('died mid-stream');
            });
        });
        const base = await serve(app);
        const r = await get(`${base}/half`);
        expect(r.status).toBe(200); // headers already went out
        expect(r.body).toContain('partial'); // and the socket was closed, not left open
    });
    it('is idempotent — a second call does not double-wrap', async () => {
        const { app, wrapped } = buildApp((a) => {
            a.get('/boom', async () => { throw new Error('once'); });
        });
        expect(wrapped).toBeGreaterThan(0);
        expect(catchAsyncRouteFaults(app), 'nothing left to wrap').toBe(0);
        const base = await serve(app);
        expect((await get(`${base}/boom`)).status).toBe(500);
    });
    it('reports how many handlers it covered, so a drop is visible', async () => {
        const { wrapped } = buildApp((a) => {
            a.get('/a', async (_q, s) => { s.end(); });
            a.get('/b', async (_q, s) => { s.end(); });
        });
        // express.json etc. are not mounted here, so this counts our two plus
        // whatever Express installs by default — never zero.
        expect(wrapped).toBeGreaterThanOrEqual(2);
    });
});
