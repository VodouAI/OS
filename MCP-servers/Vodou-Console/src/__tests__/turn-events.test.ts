/**
 * PLAN-SEAMS-AND-SESSION-LOG P0 — "model-visible ⟺ logged", as tests.
 *
 * Two halves, and the second is the one that matters:
 *   - the GATE: the emitters live where the seam is, the kind set is closed, and
 *     nothing writes the table directly;
 *   - the DERIVE: events rebuild the request, and the privacy rules hold on the
 *     way in. A log that stored the owner's MEMORY.md for a guest turn would be
 *     a worse bug than the one this plan set out to fix.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  TURN_EVENT_KINDS, initTurnEventsSchema, configureTurnEvents, emitTurnEvent,
  deriveRequest, recordedRequestHash, pruneTurnEvents, sha256,
} from '../turn-events.js';

const llm = readFileSync(path.resolve(__dirname, '../llm.ts'), 'utf-8');

// The placement rule under test is the assembler's own; the derive must not own
// a second copy. Mirrored here only to drive the pure function in isolation.
const place = (p: { staticPrefix: string; injected: string; userPrefix: string; userMessage: string }) => {
  const system = p.injected ? p.staticPrefix + '\n\n---\n\n' + p.injected : p.staticPrefix;
  const user = p.userPrefix ? p.userPrefix + '\n\n' + p.userMessage : p.userMessage;
  return system + '\n\n===USER===\n\n' + user;
};

function freshDb() {
  const db = new DatabaseSync(':memory:');
  initTurnEventsSchema(db);
  return db;
}

describe('P0 gate — the log is emitted from the seam, not sprinkled', () => {
  it('the event kind set is closed and every emitted literal is in it', () => {
    const emitted = new Set([...llm.matchAll(/kind:\s*'([a-z/]+)'/g)].map((m) => m[1]));
    const known = new Set<string>(TURN_EVENT_KINDS);
    const unknown = [...emitted].filter((k) => !known.has(k));
    expect(unknown, `event kinds in llm.ts with no TurnEventKind member: ${unknown.join(', ')}`).toEqual([]);
  });

  it('exactly one place hashes the request', () => {
    // Five providers call `noteRequest`; there must be ONE implementation of it.
    // Two would mean two definitions of "what was sent", which is the disease.
    expect((llm.match(/kind:\s*'request'/g) ?? []).length, "emitters of the 'request' event").toBe(1);
    expect((llm.match(/export function noteRequest\(/g) ?? []).length).toBe(1);
    expect((llm.match(/noteRequest\(conversationId/g) ?? []).length, 'provider call sites').toBeGreaterThanOrEqual(4);
  });

  it('inject events come from the lane accumulator, not from each push site', () => {
    expect((llm.match(/kind:\s*'inject'/g) ?? []).length).toBe(1);
  });

  it('nothing writes turn_events directly outside the module', () => {
    for (const f of ['llm.ts', 'index.ts', 'db.ts']) {
      const src = readFileSync(path.resolve(__dirname, '..', f), 'utf-8');
      expect(/INSERT\s+INTO\s+turn_events/i.test(src), `${f} writes turn_events directly`).toBe(false);
    }
  });

  it('the assembler and the deriver share one placement rule', () => {
    // The extraction is the point: a second copy would let the log agree with a
    // request nobody sent.
    expect((llm.match(/export function placeAssembled\(/g) ?? []).length).toBe(1);
    expect(llm).toMatch(/placeAssembled\(\{ staticPrefix, injected, userPrefix: '' \}\)/);
  });
});

describe('P0 — events rebuild the request', () => {
  let db: ReturnType<typeof freshDb>;
  let guest = false;
  beforeEach(() => {
    db = freshDb();
    guest = false;
    configureTurnEvents({
      db: () => db,
      isGuest: () => guest,
      redact: (t) => (t.includes('SECRETNEEDLE') ? t.replaceAll('SECRETNEEDLE', '[redacted]') : t),
      trustOf: (lane) => ({ memory: 'owner', ground_truth: 'owner', tool_results: 'tool' }[lane]),
    });
  });

  it('derives the request from inject + user/message, and the hash matches', () => {
    const t = 'turn-1';
    emitTurnEvent({ turnId: t, conversationId: 'c', kind: 'turn/start' });
    emitTurnEvent({ turnId: t, conversationId: 'c', kind: 'user/message', payload: 'what is my dog called?', meta: { slot: 'userMessage' } });
    emitTurnEvent({ turnId: t, conversationId: 'c', kind: 'inject', lane: 'bootstrap', payload: 'BOOTSTRAP', payloadRef: 'bootstrap:abc', meta: { slot: 'staticPrefix' } });
    emitTurnEvent({ turnId: t, conversationId: 'c', kind: 'inject', lane: 'ground_truth', payload: 'branch: main', meta: { slot: 'injected' } });
    emitTurnEvent({ turnId: t, conversationId: 'c', kind: 'inject', lane: 'memory', payload: 'the dog is Lucy', payloadRef: 'memory:xyz', meta: { slot: 'injected' } });

    const expected = place({
      staticPrefix: 'BOOTSTRAP', injected: 'branch: main\n\nthe dog is Lucy',
      userPrefix: '', userMessage: 'what is my dog called?',
    });
    emitTurnEvent({ turnId: t, conversationId: 'c', kind: 'request', payload: expected });

    const d = deriveRequest(db, t, place)!;
    expect(d.complete).toBe(true);
    expect(d.text).toBe(expected);
    expect(d.hash).toBe(recordedRequestHash(db, t));
    expect(d.lanes.map((l) => l.lane)).toEqual(['bootstrap', 'ground_truth', 'memory']);
    expect(d.lanes.find((l) => l.lane === 'ground_truth')!.trust, 'trust travels with the event').toBe('owner');
  });

  it('an injector that skips the seam makes the derive DISAGREE — the whole point', () => {
    const t = 'turn-2';
    emitTurnEvent({ turnId: t, conversationId: 'c', kind: 'user/message', payload: 'hi', meta: { slot: 'userMessage' } });
    emitTurnEvent({ turnId: t, conversationId: 'c', kind: 'inject', lane: 'memory', payload: 'known', meta: { slot: 'injected' } });
    // …and something downstream appended text nobody registered.
    const actuallySent = place({ staticPrefix: '', injected: 'known', userPrefix: '', userMessage: 'hi' })
      + '\n\n## Workbench instructions\nsomething nobody logged';
    emitTurnEvent({ turnId: t, conversationId: 'c', kind: 'request', payload: actuallySent });

    const d = deriveRequest(db, t, place)!;
    expect(d.hash).not.toBe(recordedRequestHash(db, t));
  });

  it('a bootstrap payload is stored once and referenced, not copied per turn', () => {
    for (const t of ['a', 'b', 'c']) {
      emitTurnEvent({ turnId: t, conversationId: 'conv', kind: 'inject', lane: 'bootstrap', payload: 'THE 24KB MANUAL', payloadRef: 'bootstrap:same', meta: { slot: 'staticPrefix' } });
    }
    const blobs = db.prepare('SELECT count(*) n FROM turn_event_blobs').get() as { n: number };
    const inline = db.prepare('SELECT count(*) n FROM turn_events WHERE payload IS NOT NULL').get() as { n: number };
    expect(blobs.n, 'one blob for three turns').toBe(1);
    expect(inline.n, 'no per-turn copy of the manual').toBe(0);
    // …and it still derives
    emitTurnEvent({ turnId: 'a', conversationId: 'conv', kind: 'user/message', payload: 'q', meta: { slot: 'userMessage' } });
    expect(deriveRequest(db, 'a', place)!.text).toContain('THE 24KB MANUAL');
  });
});

describe('P0 — the privacy rules hold on the way in', () => {
  let db: ReturnType<typeof freshDb>;
  let guest = false;
  beforeEach(() => {
    db = freshDb();
    guest = false;
    configureTurnEvents({
      db: () => db,
      isGuest: () => guest,
      redact: (t) => (t.includes('SECRETNEEDLE') ? t.replaceAll('SECRETNEEDLE', '[redacted]') : t),
      trustOf: () => undefined,
    });
  });

  it('a guest turn stores hashes only — never the owner MEMORY.md', () => {
    guest = true;
    emitTurnEvent({ turnId: 'g', conversationId: 'guestconv', kind: 'inject', lane: 'memory', payload: "the owner's private notes" });
    const row = db.prepare('SELECT payload, content_hash, meta FROM turn_events').get() as any;
    expect(row.payload, 'a guest turn must store no text').toBeNull();
    expect(row.content_hash, 'the hash is still taken, so derive can still be checked')
      .toBe(sha256("the owner's private notes"));
    expect(JSON.parse(row.meta).redacted).toBe('guest');
  });

  it('a leak needle is redacted but the hash is of the ORIGINAL', () => {
    emitTurnEvent({ turnId: 'l', conversationId: 'c', kind: 'inject', lane: 'memory', payload: 'x SECRETNEEDLE y' });
    const row = db.prepare('SELECT payload, content_hash, meta FROM turn_events').get() as any;
    expect(row.payload).toBe('x [redacted] y');
    expect(row.content_hash).toBe(sha256('x SECRETNEEDLE y'));
    expect(JSON.parse(row.meta).redacted).toBe('leak_needle');
  });

  it('a write failure never fails the turn', () => {
    configureTurnEvents({
      db: () => { throw new Error('database is locked'); },
      isGuest: () => false, redact: (t) => t, trustOf: () => undefined,
    });
    expect(() => emitTurnEvent({ turnId: 'x', conversationId: 'c', kind: 'turn/start' })).not.toThrow();
  });

  it('an unidentified turn is not logged (it could never be derived)', () => {
    emitTurnEvent({ turnId: '', conversationId: 'c', kind: 'turn/start' });
    expect((db.prepare('SELECT count(*) n FROM turn_events').get() as any).n).toBe(0);
  });

  it('retention nulls payloads and keeps the hashes', () => {
    emitTurnEvent({ turnId: 'r', conversationId: 'c', kind: 'inject', lane: 'memory', payload: 'old text' });
    // 30 days ago: past the 14-day payload cutoff, inside the 90-day hash window.
    // (A date beyond 90 days is DELETED, not nulled — which is the intended
    // behaviour and is what the first version of this test got wrong.)
    const d30 = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
    db.prepare('UPDATE turn_events SET at = ?').run(d30);
    pruneTurnEvents(db, 14);
    const row = db.prepare('SELECT payload, content_hash, chars FROM turn_events').get() as any;
    expect(row.payload).toBeNull();
    expect(row.content_hash).toBe(sha256('old text'));
    expect(row.chars).toBe('old text'.length);
    // and a derive over a pruned turn must say so rather than claim success
    emitTurnEvent({ turnId: 'r', conversationId: 'c', kind: 'user/message', payload: 'q', meta: { slot: 'userMessage' } });
    expect(deriveRequest(db, 'r', place)!.complete).toBe(false);
  });
});

describe('P0 — the census number', () => {
  it('reports unlogged bytes rather than a bare mismatch', () => {
    const db = freshDb();
    configureTurnEvents({ db: () => db, isGuest: () => false, redact: (t) => t, trustOf: () => undefined });
    const t = 'census';
    emitTurnEvent({ turnId: t, conversationId: 'c', kind: 'user/message', payload: 'hi', meta: { slot: 'userMessage' } });
    emitTurnEvent({ turnId: t, conversationId: 'c', kind: 'inject', lane: 'memory', payload: 'known', meta: { slot: 'injected' } });
    const sent = place({ staticPrefix: '', injected: 'known', userPrefix: '', userMessage: 'hi' }) + 'XXXXXXXXXX';
    emitTurnEvent({ turnId: t, conversationId: 'c', kind: 'request', payload: sent });
    const d = deriveRequest(db, t, place)!;
    expect(d.verdict).toBe('unlogged');
    expect(d.unloggedChars, 'bytes no lane accounts for').toBe(10);
  });

  it('a pruned turn answers unknown, never ok', () => {
    const db = freshDb();
    configureTurnEvents({ db: () => db, isGuest: () => false, redact: (t) => t, trustOf: () => undefined });
    emitTurnEvent({ turnId: 'p', conversationId: 'c', kind: 'user/message', payload: 'hi', meta: { slot: 'userMessage' } });
    emitTurnEvent({ turnId: 'p', conversationId: 'c', kind: 'inject', lane: 'memory', payload: 'gone', meta: { slot: 'injected' } });
    db.prepare("UPDATE turn_events SET payload = NULL WHERE lane = 'memory'").run();
    expect(deriveRequest(db, 'p', place)!.verdict).toBe('unknown');
  });
});
