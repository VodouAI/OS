/**
 * S-AUTH regression guard — PLAN-SECURITY-AUDIT-FINDINGS #3.
 *
 * These routes replace the running binary and spawn caller-named processes. If
 * any assertion here starts failing, an unauthenticated caller can reach them
 * again. Do not relax a case without re-reading
 * PLANS/0.6.21/PLAN-MASTER-EXECUTION-ORDER.md §0.5.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { requireAdmin, issueAdminCookie, getAdminToken, ADMIN_COOKIE } from '../src/admin-auth.js';

const TOKEN = 'a'.repeat(64);
let root: string;
let priorRoot: string | undefined;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vodou-admin-auth-'));
  fs.mkdirSync(path.join(root, '.vodou'), { recursive: true });
  fs.writeFileSync(path.join(root, '.vodou', 'console.token'), TOKEN + '\n');
  priorRoot = process.env.VODOU_PROJECT_PATH;
  process.env.VODOU_PROJECT_PATH = root;
  getAdminToken(true); // drop any cache from another test file
});

afterAll(() => {
  if (priorRoot === undefined) delete process.env.VODOU_PROJECT_PATH;
  else process.env.VODOU_PROJECT_PATH = priorRoot;
  getAdminToken(true);
  fs.rmSync(root, { recursive: true, force: true });
});

function fakeRes() {
  return {
    statusCode: null as number | null,
    body: null as any,
    cookies: [] as Array<{ name: string; value: string; opts: any }>,
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.body = b; return this; },
    cookie(n: string, v: string, o: any) { this.cookies.push({ name: n, value: v, opts: o }); return this; },
  };
}

function attempt(headers: Record<string, string>) {
  const req = { method: 'POST', originalUrl: '/api/system/update-install', headers } as any;
  const res = fakeRes();
  let reachedHandler = false;
  requireAdmin(req, res as any, () => { reachedHandler = true; });
  return { reachedHandler, status: res.statusCode, body: res.body };
}

describe('requireAdmin', () => {
  it('blocks a request with no credentials', () => {
    const r = attempt({});
    expect(r.reachedHandler).toBe(false);
    expect(r.status).toBe(401);
  });

  it('blocks a wrong token of the same length', () => {
    const r = attempt({ authorization: 'Bearer ' + 'b'.repeat(TOKEN.length) });
    expect(r.reachedHandler).toBe(false);
    expect(r.status).toBe(401);
  });

  it('blocks a wrong-length token without throwing (timingSafeEqual guard)', () => {
    const r = attempt({ authorization: 'Bearer short' });
    expect(r.reachedHandler).toBe(false);
    expect(r.status).toBe(401);
  });

  it('allows the correct bearer token (scripted owner use)', () => {
    const r = attempt({ authorization: 'Bearer ' + TOKEN });
    expect(r.reachedHandler).toBe(true);
    expect(r.status).toBeNull();
  });

  it('allows the correct cookie (what the console UI sends)', () => {
    const r = attempt({ cookie: `${ADMIN_COOKIE}=${TOKEN}` });
    expect(r.reachedHandler).toBe(true);
  });

  it('finds the cookie among other cookies', () => {
    const r = attempt({ cookie: `theme=dark; ${ADMIN_COOKIE}=${TOKEN}; tz=utc` });
    expect(r.reachedHandler).toBe(true);
  });

  it('is not fooled by a cookie whose name merely contains the real one', () => {
    const r = attempt({ cookie: `not_${ADMIN_COOKIE}=${TOKEN}` });
    expect(r.reachedHandler).toBe(false);
  });

  it('blocks a wrong cookie value', () => {
    const r = attempt({ cookie: `${ADMIN_COOKIE}=nope` });
    expect(r.reachedHandler).toBe(false);
  });

  it('picks up a rotated token without a gateway restart', () => {
    const rotated = 'c'.repeat(64);
    fs.writeFileSync(path.join(root, '.vodou', 'console.token'), rotated + '\n');
    expect(attempt({ authorization: 'Bearer ' + rotated }).reachedHandler).toBe(true);
    fs.writeFileSync(path.join(root, '.vodou', 'console.token'), TOKEN + '\n');
    getAdminToken(true);
  });

  it('fails CLOSED when the token was never provisioned', () => {
    const saved = process.env.VODOU_PROJECT_PATH;
    process.env.VODOU_PROJECT_PATH = path.join(os.tmpdir(), 'vodou-no-such-root');
    getAdminToken(true);
    const r = attempt({ authorization: 'Bearer ' + TOKEN });
    expect(r.reachedHandler).toBe(false);
    expect(r.status).toBe(503);
    process.env.VODOU_PROJECT_PATH = saved;
    getAdminToken(true);
  });
});

describe('issueAdminCookie', () => {
  it('sets an httpOnly, SameSite=Strict cookie carrying the real token', () => {
    const res = fakeRes();
    issueAdminCookie(res as any);
    expect(res.cookies).toHaveLength(1);
    expect(res.cookies[0].name).toBe(ADMIN_COOKIE);
    expect(res.cookies[0].value).toBe(TOKEN);
    expect(res.cookies[0].opts.httpOnly).toBe(true);
    expect(res.cookies[0].opts.sameSite).toBe('strict');
  });

  it('is a no-op when no token is provisioned (never sets an empty cookie)', () => {
    const saved = process.env.VODOU_PROJECT_PATH;
    process.env.VODOU_PROJECT_PATH = path.join(os.tmpdir(), 'vodou-no-such-root');
    getAdminToken(true);
    const res = fakeRes();
    issueAdminCookie(res as any);
    expect(res.cookies).toHaveLength(0);
    process.env.VODOU_PROJECT_PATH = saved;
    getAdminToken(true);
  });
});
