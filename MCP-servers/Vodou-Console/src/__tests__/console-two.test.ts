/**
 * Console Two P0 — gateway plumbing (PLANS/0.6.23/PLAN-CONSOLE-TWO-IMPL.md §7).
 *
 * Covers the four P0 vitest rows:
 *   1. /panel/ serves index.html + the density stylesheet link; `/` does not.
 *   2. /ext-session fails closed (no token / wrong token) and, with the right
 *      token, 302s to /panel/ carrying the Partitioned admin cookie.
 *   3. frame-ancestors CSP present on HTML requests, absent on JSON; 'self'
 *      when no ext id is recorded, allowlists the id when one is.
 *   4. Mounting is additive: a plain static-ish route registered after
 *      mountConsoleTwo still serves untouched (stands in for express.static).
 *
 * mountConsoleTwo is tested on a FRESH express app, not the full setupExpress —
 * the module's only contract with index.ts is "mount before static", which
 * test 4 exercises directly. The framed-destructive-action leg is the manual
 * P0 exit (PLANS/0.6.23/p0-harness/), not reproducible under node.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

// Throwaway DBs BEFORE any db.js import (same discipline as dock-grouping.test).
const TMP = mkdtempSync(path.join(tmpdir(), 'vodou-console-two-test-'));
process.env.GATEWAY_DB_PATH = path.join(TMP, 'gateway.db');
// admin-auth resolves <VODOU_PROJECT_PATH>/.vodou/console.token
// (admin-auth.ts tokenPath()); point the root at our tmp dir.
const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef';
process.env.VODOU_PROJECT_PATH = TMP;
mkdirSync(path.join(TMP, '.vodou'), { recursive: true });
writeFileSync(path.join(TMP, '.vodou', 'console.token'), ADMIN_TOKEN);

// A fake publicDir with a recognizable index.html.
const PUBLIC = path.join(TMP, 'public');
mkdirSync(path.join(PUBLIC, 'css'), { recursive: true });
writeFileSync(
  path.join(PUBLIC, 'index.html'),
  '<!doctype html><html><head><title>Vodou</title></head><body>console</body></html>',
);
mkdirSync(path.join(PUBLIC, 'two'), { recursive: true });
writeFileSync(
  path.join(PUBLIC, 'two', 'index.html'),
  '<!doctype html><html><head><title>Vodou</title></head><body id="shell-two">two</body></html>',
);

afterAll(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

let app: express.Express;
let setSetting: (k: string, v: string) => void;
let getAdminToken: (force?: boolean) => string | null;

beforeAll(async () => {
  ({ setSetting } = await import('../db.js'));
  ({ getAdminToken } = await import('../admin-auth.js'));
  const { mountConsoleTwo } = await import('../api/console-two.js');
  app = express();
  mountConsoleTwo(app, PUBLIC);
  // Stand-in for express.static — proves mounting is additive (row 4).
  app.get('/plain.json', (_req, res) => { res.json({ ok: true }); });
  app.get('/', (_req, res) => { res.type('html').send('<html>root</html>'); });
});

describe('/panel/', () => {
  it('serves index.html with the density stylesheet appended', async () => {
    const r = await request(app).get('/panel/').set('Accept', 'text/html');
    expect(r.status).toBe(200);
    expect(r.text).toContain('09-panel-density.css');
    expect(r.text).toContain('<title>Vodou</title>');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('does NOT leak the density link into other HTML routes', async () => {
    const r = await request(app).get('/').set('Accept', 'text/html');
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('09-panel-density.css');
  });
});

describe('/two/', () => {
  it('serves the shell (static index:false would otherwise 404 the directory)', async () => {
    for (const p of ['/two', '/two/']) {
      const r = await request(app).get(p).set('Accept', 'text/html');
      expect(r.status).toBe(200);
      expect(r.text).toContain('shell-two');
      expect(r.headers['cache-control']).toBe('no-store');
    }
  });
});

describe('/ext-session', () => {
  it('403s with no token provisioned or offered', async () => {
    const r = await request(app).get('/ext-session');
    expect(r.status).toBe(403);
  });

  it('403s on a wrong token', async () => {
    setSetting('bridge_token', '654321');
    const r = await request(app).get('/ext-session?t=000000');
    expect(r.status).toBe(403);
  });

  it('302s to /panel/ with a Partitioned SameSite=None admin cookie on the right token', async () => {
    setSetting('bridge_token', '654321');
    // Fail loudly if the admin token didn't provision — the cookie assertion
    // below would otherwise pass vacuously.
    expect(getAdminToken(true)).toBe(ADMIN_TOKEN);
    const r = await request(app).get('/ext-session?t=654321');
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/panel/');
    const cookies = ([] as string[]).concat(r.headers['set-cookie'] || []);
    const admin = cookies.find((c) => c.startsWith('vodou_admin='));
    expect(admin).toBeTruthy();
    expect(admin).toContain('SameSite=None');
    expect(admin).toContain('Partitioned');
    expect(admin).toContain('HttpOnly');
    expect(admin).toContain('Secure');
    expect(admin).toContain(ADMIN_TOKEN);
  });
});

describe('frame-ancestors CSP', () => {
  it("emits 'self' on HTML when no extension id is recorded", async () => {
    setSetting('bridge_ext_id', '');
    const r = await request(app).get('/').set('Accept', 'text/html');
    expect(r.headers['content-security-policy']).toBe("frame-ancestors 'self'");
  });

  it('allowlists the recorded extension id', async () => {
    setSetting('bridge_ext_id', 'ehlanbbiaeelnimkakfffehoahimkjjf');
    const r = await request(app).get('/panel/').set('Accept', 'text/html');
    expect(r.headers['content-security-policy']).toBe(
      "frame-ancestors 'self' chrome-extension://ehlanbbiaeelnimkakfffehoahimkjjf",
    );
  });

  it('does not touch non-HTML responses (row 4: additive mount)', async () => {
    const r = await request(app).get('/plain.json').set('Accept', 'application/json');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(r.headers['content-security-policy']).toBeUndefined();
  });
});
