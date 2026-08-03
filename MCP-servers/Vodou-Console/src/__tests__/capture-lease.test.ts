import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';

// PLAN-ENGINE-GATED-CAPTURE P2 — the gateway's lease holder.
//
// Driven against a REAL unix socket standing in for the daemon, because the
// distinction this module exists to make — "the daemon said no" vs "the daemon
// said nothing" — lives in the socket layer, and a mock of `net` would assert the
// mock rather than the behaviour.
//
// The two must not behave alike:
//   * no answer      → keep the lease we hold until it actually expires, so a
//                      daemon restart mid-session is invisible.
//   * "no" answered  → drop it immediately; the account is the thing in question.

let sockDir: string;
let server: net.Server | null = null;
/** What the fake daemon replies with next; null = accept and say nothing (hang). */
let nextReply: unknown | null = null;

function startFakeDaemon(sockPath: string): Promise<void> {
  return new Promise((resolve) => {
    server = net.createServer((c) => {
      c.on('data', () => {
        if (nextReply === null) return;      // silence — exercises the timeout path
        c.write(JSON.stringify(nextReply) + '\n');
        c.end();
      });
      c.on('error', () => { /* client hung up */ });
    });
    server.listen(sockPath, () => resolve());
  });
}

async function freshModule() {
  vi.resetModules();                          // module-level lease state must not leak between tests
  vi.doMock('../db.js', () => ({ getProjectRoot: () => sockDir }));
  vi.doMock('../cli-portability.js', () => ({ sockConnectTarget: (p: string) => p }));
  return await import('../vbb/capture-lease.js');
}

const grant = (ttl = 1800) => ({
  ok: true,
  data: { granted: true, lease: { token: 'a'.repeat(64), expires_at: Math.floor(Date.now() / 1000) + ttl, ttl_secs: ttl, renew_after_secs: ttl / 2 } },
});

beforeEach(async () => {
  sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vodou-lease-'));
  fs.mkdirSync(path.join(sockDir, '.vodou'));
  await startFakeDaemon(path.join(sockDir, '.vodou', 'daemon.sock'));
  nextReply = null;
});

afterEach(async () => {
  await new Promise<void>((r) => { server ? server.close(() => r()) : r(); });
  server = null;
  fs.rmSync(sockDir, { recursive: true, force: true });
});

describe('capture lease (gateway side)', () => {
  it('a grant permits capture', async () => {
    const m = await freshModule();
    nextReply = grant();
    const s = await m.refreshLease();
    expect(s.granted).toBe(true);
    expect(s.reason).toBeNull();
    expect(m.captureAllowed()).toEqual({ ok: true, reason: null });
  });

  it('a refusal drops the lease immediately and keeps the typed code', async () => {
    const m = await freshModule();
    nextReply = grant();
    await m.refreshLease();
    expect(m.captureAllowed().ok).toBe(true);

    // The account went away. This is a verdict, not a blip — the remaining 29
    // minutes of the lease must NOT be honoured.
    nextReply = { ok: true, data: { granted: false, reason: 'invalid_credentials' } };
    const s = await m.refreshLease();
    expect(s.granted).toBe(false);
    expect(s.expiresAt).toBe(0);
    expect(m.captureAllowed()).toEqual({ ok: false, reason: 'invalid_credentials' });
  });

  it('an unreachable daemon does NOT drop a lease that is still valid', async () => {
    const m = await freshModule();
    nextReply = grant();
    await m.refreshLease();

    // Daemon goes away mid-session (restart, rebuild, swap).
    await new Promise<void>((r) => { server!.close(() => r()); });
    server = null;
    const s = await m.refreshLease();
    expect(s.granted).toBe(true);              // still inside the 30-minute TTL
    expect(m.captureAllowed().ok).toBe(true);  // a restart is invisible
  });

  it('an unreachable daemon DOES block once the lease has expired', async () => {
    const m = await freshModule();
    nextReply = grant(-1);                     // already expired on arrival
    await m.refreshLease();
    await new Promise<void>((r) => { server!.close(() => r()); });
    server = null;
    await m.refreshLease();
    expect(m.captureAllowed()).toEqual({ ok: false, reason: 'engine_unreachable' });
  });

  it('an engine too old to know the command is unreachable, not a refusal', async () => {
    // Refusing capture because the binary predates capture_lease would be a silent
    // downgrade dressed up as a policy decision.
    const m = await freshModule();
    nextReply = { ok: false, error: 'unknown command: capture_lease' };
    const s = await m.refreshLease();
    expect(s.granted).toBe(false);
    expect(m.captureAllowed().reason).toBe('engine_unreachable');
  });

  it('enforcement cannot be turned off', async () => {
    // It shipped dark behind VODOU_CAPTURE_REQUIRE_LEASE for the P4 soak and is now
    // hardcoded. Deleting a line from a user's .env needed no code edit and SURVIVED
    // UPGRADES — a worse bypass than patching the open check, which an install
    // overwrites. An env var may make this stricter, never looser.
    const m = await freshModule();
    process.env.VODOU_CAPTURE_REQUIRE_LEASE = '0';
    expect(m.enforcementOn()).toBe(true);
    delete process.env.VODOU_CAPTURE_REQUIRE_LEASE;
    expect(m.enforcementOn()).toBe(true);

    // …and a refusal is therefore actually applied.
    nextReply = { ok: true, data: { granted: false, reason: 'no_account' } };
    await m.refreshLease();
    expect(m.captureAllowed()).toEqual({ ok: false, reason: 'no_account' });
  });

  it('concurrent refreshes share one daemon round-trip', async () => {
    let connections = 0;
    await new Promise<void>((r) => { server!.close(() => r()); });
    server = net.createServer((c) => {
      connections++;
      c.on('data', () => { c.write(JSON.stringify(grant()) + '\n'); c.end(); });
      c.on('error', () => { /* ignore */ });
    });
    await new Promise<void>((r) => server!.listen(path.join(sockDir, '.vodou', 'daemon.sock'), () => r()));
    const m = await freshModule();
    await Promise.all([m.refreshLease(), m.refreshLease(), m.refreshLease()]);
    expect(connections).toBe(1);
  });

  it('captureAllowed never awaits — it must not add latency to a captured turn', async () => {
    const m = await freshModule();
    nextReply = grant();
    await m.refreshLease();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 1000; i++) m.captureAllowed();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(ms).toBeLessThan(50);
  });
});
