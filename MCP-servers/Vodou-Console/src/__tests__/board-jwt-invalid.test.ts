/**
 * SEC-7 — a presented-but-invalid Board token was waved through.
 *
 * The middleware had one branch for two different situations:
 *   - NO Authorization header — a Phase-1 client that predates tokens. Allowing
 *     that is deliberate backward compatibility.
 *   - A header that IS present and does not verify — expired, tampered, bound
 *     to a different task. That is an attack or a broken caller, and it was
 *     allowed too, with only a console.warn, unless VODOU_BOARD_REQUIRE_JWT=1.
 *
 * The compat surface is the missing header. A bad token is never backward
 * compatibility, because a legacy client does not send one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardJwtMiddleware } from '../api/board-auth.js';
import type { Request, Response, NextFunction } from 'express';

function run(authorization?: string, requireJwt = false) {
  const prev = process.env.VODOU_BOARD_REQUIRE_JWT;
  if (requireJwt) process.env.VODOU_BOARD_REQUIRE_JWT = '1';
  else delete process.env.VODOU_BOARD_REQUIRE_JWT;

  const req = { headers: authorization ? { authorization } : {}, params: {} } as unknown as Request;
  let status: number | null = null;
  let body: unknown = null;
  const res = {
    status(c: number) { status = c; return this; },
    json(b: unknown) { body = b; return this; },
  } as unknown as Response;
  let nexted = false;
  boardJwtMiddleware(req, res, (() => { nexted = true; }) as NextFunction);

  if (prev === undefined) delete process.env.VODOU_BOARD_REQUIRE_JWT;
  else process.env.VODOU_BOARD_REQUIRE_JWT = prev;
  return { status, body, nexted };
}

describe('SEC-7 — a bad token is refused, a missing one is compat', () => {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('refuses a tampered token even with enforcement OFF', () => {
    const r = run('Bearer not.a.real.token');
    expect(r.status, 'this was the hole — it used to call next()').toBe(401);
    expect(r.nexted).toBe(false);
  });

  it('refuses a malformed Authorization scheme even with enforcement OFF', () => {
    const r = run('Basic dXNlcjpwYXNz');
    expect(r.status).toBe(401);
    expect(r.nexted).toBe(false);
  });

  it('still allows a MISSING header when enforcement is off — the real compat case', () => {
    // A Phase-1 client sends nothing at all. Breaking this would break the
    // rollout the allowance exists for.
    const r = run(undefined, false);
    expect(r.nexted).toBe(true);
    expect(r.status).toBeNull();
  });

  it('refuses a missing header when enforcement is ON', () => {
    const r = run(undefined, true);
    expect(r.status).toBe(401);
    expect(r.nexted).toBe(false);
  });

  it('a bad token is refused with enforcement ON too — the flag only governs absence', () => {
    expect(run('Bearer nope', true).status).toBe(401);
  });
});
