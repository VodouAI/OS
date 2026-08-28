/**
 * COHERENCE F39 — "It told me the system was overloaded. I ran one command."
 *
 * `/api/library/match` prefers the warm daemon and falls back to a cold
 * `mem library match` process. The fallback is deliberate — the daemon being
 * down must cost latency, never correctness — but it had no coalescing, no cap
 * and no backoff, and the panel fires this endpoint on every tab activation.
 *
 * So one slow daemon lane became a chain nobody could see from any single
 * surface: a 15s timeout per request, then a cold matcher per request loading
 * the very embedder and cross-encoder the daemon was busy with, several at
 * once, until the VODOU_MAX_PROCESSES valve saturated and refused an unrelated
 * `./do "log: …"` — dropping that work log and blaming the innocent caller.
 *
 * The distinction these tests exist to pin is BUSY vs DOWN. They need opposite
 * responses, and treating them alike is what turned a slow lane into a fork
 * storm. A dead daemon means the cold path is the only path. A busy daemon
 * means the cold path is actively harmful.
 */

import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach, vi } from 'vitest';

/** What the daemon does this run. */
let daemonResult: { ok: boolean; kind?: string; reason?: string; data?: unknown } = { ok: false, kind: 'down', reason: 'socket error (ENOENT)' };
/** Every cold `mem library match` spawn the route attempted. */
let coldSpawns = 0;
/** A gate the cold matcher waits on, so concurrency is observed, not inferred. */
let coldGate: Promise<void> | null = null;
let openGate: () => void = () => {};
const holdCold = () => { coldGate = new Promise<void>((r) => { openGate = r; }); };

vi.mock('../daemon-client.js', () => ({
  daemonRequest: vi.fn(async () => daemonResult),
}));

vi.mock('../api/memory-capture.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/memory-capture.js')>();
  return {
    ...actual,
    runCore: vi.fn(async (args: string[]) => {
      if (!args.includes('match')) return { status: 0, stdout: '[]', stderr: '' };
      coldSpawns += 1;
      if (coldGate) await coldGate;
      return { status: 0, stdout: JSON.stringify([{ source_id: 1, display_name: 'MSA.pdf', kind: 'pdf', score: 0.95, card: 'a card' }]), stderr: '' };
    }),
  };
});

let app: Express;

beforeEach(async () => {
  coldSpawns = 0;
  coldGate = null;
  openGate = () => {};
  vi.resetModules();
  const { mountLibrary } = await import('../api/library.js');
  app = express();
  app.use(express.json());
  mountLibrary(app, '/tmp');
});

const match = (query: string) => request(app).post('/api/library/match').send({ query, topK: 3 });

/**
 * Start a request and actually PUT IT IN FLIGHT.
 *
 * supertest's `Test` is lazy: it does not call `.end()` until something
 * subscribes, so `const p = match(q)` sends nothing. A concurrency test written
 * without this reads as a 30s timeout, because the request it thought was
 * running had not been sent and the one it awaited blocked on the gate.
 */
const inFlight = (query: string) => match(query).then((r) => r);

describe('a busy daemon is not a dead daemon', () => {
  it('falls back to the cold matcher when the daemon is DOWN', async () => {
    daemonResult = { ok: false, kind: 'down', reason: 'socket error (ENOENT)' };
    const res = await match('what is this contract');
    expect(res.status).toBe(200);
    expect(coldSpawns, 'a dead daemon must still be answered — that is the whole point of the fallback').toBe(1);
    // D18a — the response SAYS it fell back. The e2e suite asserts on this
    // field instead of inferring the path from latency.
    expect(res.body.served_by).toBe('cli');
  });

  /** The finding, in one assertion. */
  it('does NOT fork a cold matcher when the daemon is merely BUSY', async () => {
    daemonResult = { ok: false, kind: 'busy', reason: 'timed out at 15000ms' };
    const res = await match('what is this contract');
    expect(res.status).toBe(200);
    expect(res.body.matches).toEqual([]);
    expect(res.body.served_by).toBe('none');
    expect(res.body.reason).toMatch(/timed out/);
    expect(
      coldSpawns,
      'forked a cold matcher at a daemon that is alive and slow — this is the fork storm F39 filed',
    ).toBe(0);
  });

  it('keeps backing off for the cooldown, not just for the one request', async () => {
    daemonResult = { ok: false, kind: 'busy', reason: 'timed out at 15000ms' };
    await match('first query');
    // The daemon now looks dead to a naive caller; the cooldown must still hold,
    // because a lane that was contended a moment ago usually still is.
    daemonResult = { ok: false, kind: 'down', reason: 'socket error (ENOENT)' };
    await match('second query');
    expect(coldSpawns, 'the cooldown expired instantly, so a slow lane still fork-storms').toBe(0);
  });

  it('never runs two cold matchers at once', async () => {
    daemonResult = { ok: false, kind: 'down', reason: 'socket error (ENOENT)' };
    holdCold();
    const inflight = inFlight('slow query');
    await new Promise((r) => setTimeout(r, 30));
    try {
      // A different query, so coalescing cannot be what saves us — only the cap.
      await match('a completely different query');
      expect(coldSpawns, 'two cold matchers ran at once; each loads the embedder AND the cross-encoder').toBe(1);
    } finally {
      // Always release, or a failed assertion leaves the suite hanging on a
      // gate nobody opens — which is how this test first read as a timeout.
      openGate();
      await inflight;
    }
  });

  it('coalesces concurrent identical queries into one process', async () => {
    daemonResult = { ok: false, kind: 'down', reason: 'socket error (ENOENT)' };
    holdCold();
    const a = inFlight('same question');
    await new Promise((r) => setTimeout(r, 30));
    const b = inFlight('same question');
    await new Promise((r) => setTimeout(r, 30));
    openGate();
    await Promise.all([a, b]);
    expect(coldSpawns, 'the panel fires on every tab activation — identical queries must share one spawn').toBe(1);
  });
});
