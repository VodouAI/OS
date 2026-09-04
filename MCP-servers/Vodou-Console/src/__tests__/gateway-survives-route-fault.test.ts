/**
 * GW-11 (ALPHA-READINESS §9 D) — a broken route must not take the server down.
 *
 * Proven with Export into a read-only directory at audit time: one EACCES from
 * one async handler reached process.on('unhandledRejection'), which called
 * process.exit(1), and chat, memory, channels, the scheduler and every open
 * WebSocket died with it.
 *
 * Two halves, tested separately because either one alone leaves a hole:
 *   1. the terminal error middleware turns a route fault into a 500 for the one
 *      caller who caused it (without it, the request hangs);
 *   2. the process-level handler no longer exits, so anything that still slips
 *      past the middleware is survivable.
 */

import { describe, it, expect } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';

/** The middleware exactly as index.ts registers it. */
function mountTerminalErrorMiddleware(app: express.Express) {
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const msg = err?.message || String(err);
    if (res.headersSent) { try { res.end(); } catch { /* gone */ } return; }
    res.status(500).json({ ok: false, error: msg, hint: 'This request failed; the gateway is still running. See the gateway log for the stack.' });
  });
}

describe('GW-11 — one bad route is one bad response', () => {
  it('answers 500 for a synchronous throw instead of hanging', async () => {
    const app = express();
    app.get('/boom', () => { throw new Error('EACCES: permission denied'); });
    app.get('/fine', (_q, s) => { s.json({ ok: true }); });
    mountTerminalErrorMiddleware(app);

    const bad = await request(app).get('/boom');
    expect(bad.status).toBe(500);
    expect(bad.body.error).toContain('EACCES');

    // The server is still answering — the whole point.
    const good = await request(app).get('/fine');
    expect(good.status).toBe(200);
    expect(good.body.ok).toBe(true);
  });

  it('answers 500 for an async handler that rejects, when the route forwards to next()', async () => {
    const app = express();
    app.get('/boom-async', async (_q, _s, next) => {
      try { await Promise.reject(new Error('read-only file system')); }
      catch (e) { next(e); }
    });
    mountTerminalErrorMiddleware(app);
    const res = await request(app).get('/boom-async');
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('read-only');
  });

  it('does not try to re-send when a response already started streaming', async () => {
    const app = express();
    app.get('/half', (_q, s) => {
      s.status(200);
      s.write('partial');
      // Something fails after the headers are out.
      throw new Error('failed mid-stream');
    });
    mountTerminalErrorMiddleware(app);
    const res = await request(app).get('/half');
    // No ERR_HTTP_HEADERS_SENT crash; the connection simply ends.
    expect(res.status).toBe(200);
    expect(res.text).toContain('partial');
  });

  it("the shipped index.ts no longer exits the process on an unhandled rejection", async () => {
    // Read the source rather than fork a gateway: the contract is one line, and
    // a test that spawned a real server to prove it does not die would be both
    // slow and flaky. The assertion is on the handler body, not a grep for the
    // word 'exit' — uncaughtException legitimately still exits.
    const fs = await import('node:fs');
    const url = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, '..', 'index.ts'), 'utf8');
    // Anchor on the REGISTRATION, not the phrase: the phrase also appears in a
    // comment above the error middleware, and the first draft of this test
    // asserted against that comment instead of the handler.
    const start = src.indexOf("process.on('unhandledRejection', (reason)");
    expect(start).toBeGreaterThan(-1);
    // Bound the slice at the handler's own closing `});` — a fixed character
    // window ran past it into main().catch(), whose process.exit(1) is correct
    // and unrelated, and the test failed on someone else's line.
    const end = src.indexOf('\n  });', start);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).toContain('server STAYS UP');
    // The only exit left in that handler is the opt-in strict-dev one.
    const exits = body.split('process.exit(1)').length - 1;
    expect(exits).toBeLessThanOrEqual(1);
    expect(body).toContain('VODOU_STRICT_REJECTIONS');
  });
});
