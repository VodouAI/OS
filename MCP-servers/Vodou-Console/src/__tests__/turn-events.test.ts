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
  TURN_EVENT_KINDS, configureTurnEvents, emitTurnEvent,
  deriveRequest, recordedRequestHash, pruneTurnEvents, sha256, flushTurnEvents,
} from '../turn-events.js';

const llm = readFileSync(path.resolve(__dirname, '../llm.ts'), 'utf-8');

// The placement rule under test is the assembler's own; the derive must not own
// a second copy. Mirrored here only to drive the pure function in isolation.
const place = (p: { staticPrefix: string; injected: string; userPrefix: string; userMessage: string }) => {
  const system = p.injected ? p.staticPrefix + '\n\n---\n\n' + p.injected : p.staticPrefix;
  const user = p.userPrefix ? p.userPrefix + '\n\n' + p.userMessage : p.userMessage;
  return system + '\n\n===USER===\n\n' + user;
};

/**
 * The REAL migration, not a copy of it. P0d moved the schema into the engine
 * (`migrations/090_turn_events.sql`), and a test that re-declared the table here
 * would grade a shape the product does not have — which is exactly how the first
 * run of this suite failed, with `no column named source`.
 */
function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(path.resolve(__dirname, '../../../../migrations/090_turn_events.sql'), 'utf-8'));
  return db;
}

/**
 * P0d — writes are no longer direct: a turn's events are buffered and sent to
 * the engine in ONE batch at the turn boundary. `sink` is the daemon's half of
 * that, in-process, so the assertions in this file keep testing what they always
 * tested. `emit` delivers immediately because these tests assert row-by-row;
 * the batch boundary itself is asserted separately, in the P0d block.
 */
function sink(db: ReturnType<typeof freshDb>) {
  return async ({ events, blobs }: { events: unknown[]; blobs: unknown[] }) => {
    for (const b of blobs as Array<Record<string, unknown>>) {
      db.prepare(`INSERT INTO turn_event_blobs (ref, kind, chars, payload, first_seen)
                  VALUES (?,?,?,?,?) ON CONFLICT(ref) DO NOTHING`)
        .run(b.ref as string, b.kind as string, b.chars as number, (b.payload as string) ?? null, b.first_seen as string);
    }
    for (const e of events as Array<Record<string, unknown>>) {
      // Mirrors `Database::insert_turn_events`: a turn has ONE end. The case
      // that produced two came from two DISPATCHES — two batches — so the
      // in-batch check cannot see it and the invariant lives with the writer.
      if (e.kind === 'turn/end') {
        const seen = db.prepare(`SELECT count(*) n FROM turn_events WHERE turn_id = ? AND kind = 'turn/end'`)
          .get(e.turn_id as string) as { n: number };
        if (seen.n > 0) continue;
      }
      db.prepare(`INSERT OR IGNORE INTO turn_events
        (turn_id, conversation_id, seq, at, kind, lane, trust, provider, chars, ms, content_hash, payload, payload_ref, meta, source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(e.turn_id as string, e.conversation_id as string, e.seq as number, e.at as string, e.kind as string,
             (e.lane as string) ?? null, (e.trust as string) ?? null, (e.provider as string) ?? null,
             (e.chars as number) ?? 0, (e.ms as number) ?? null, e.content_hash as string,
             (e.payload as string) ?? null, (e.payload_ref as string) ?? null, (e.meta as string) ?? null,
             (e.source as string) ?? 'gateway');
    }
    return true;
  };
}
/** emit + deliver, so a test can read the row on the next line. */
function emit(e: Parameters<typeof emitTurnEvent>[0]) {
  emitTurnEvent(e);
  void flushTurnEvents(e.turnId);
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

  it('inject events come from an accumulator, never from a push site', () => {
    // TWO emitters by design, not one: the assembler's lanes are known only to
    // the lane accumulator (the assembler runs up to three times per turn), and
    // the user body's lanes are known only at `noteRequest`, where the final
    // prompt exists to take offsets against. What must NOT happen is a third
    // one inside a provider — that is the sprinkling this gate exists to stop,
    // and it is how the seven unregistered injectors accumulated in the first
    // place. So: exactly two, and both inside the two named helpers.
    const emitters = [...llm.matchAll(/kind:\s*'inject'/g)].map((m) => m.index ?? 0);
    // THREE by design. `emitInjectEvents` owns the assembler's lanes (only the
    // accumulator sees the final set — the assembler runs up to three times a
    // turn); `noteRequest` owns the user body's (only there does the final
    // prompt exist to take offsets against); and the BrainLoader site owns the
    // router, which produces no text of its own so neither of the others has
    // anything to log for it (P0d §27.4) — yet "did the router run" is one of
    // the most useful facts on a turn. A FOURTH inside a provider is the
    // sprinkling this gate exists to stop.
    expect(emitters.length, "emitters of the 'inject' event").toBe(3);
    const inside = (fn: string, at: number) => {
      const start = llm.indexOf(fn);
      return start >= 0 && at > start && at < start + 3000;
    };
    for (const at of emitters) {
      const ok = inside('function emitInjectEvents(', at)
        || inside('export function noteRequest(', at)
        || llm.slice(Math.max(0, at - 900), at).includes('P0d §27.4');
      expect(ok, `an inject emitter at char ${at} is outside the three named helpers`).toBe(true);
    }
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
      db: () => db, flush: sink(db),
      isGuest: () => guest,
      redact: (t) => (t.includes('SECRETNEEDLE') ? t.replaceAll('SECRETNEEDLE', '[redacted]') : t),
      trustOf: (lane) => ({ memory: 'owner', ground_truth: 'owner', tool_results: 'tool' }[lane]),
    });
  });

  it('derives the request from inject + user/message, and the hash matches', () => {
    const t = 'turn-1';
    emit({ turnId: t, conversationId: 'c', kind: 'turn/start' });
    emit({ turnId: t, conversationId: 'c', kind: 'user/message', payload: 'what is my dog called?', meta: { slot: 'userMessage' } });
    emit({ turnId: t, conversationId: 'c', kind: 'inject', lane: 'bootstrap', payload: 'BOOTSTRAP', payloadRef: 'bootstrap:abc', meta: { slot: 'staticPrefix' } });
    emit({ turnId: t, conversationId: 'c', kind: 'inject', lane: 'ground_truth', payload: 'branch: main', meta: { slot: 'injected' } });
    emit({ turnId: t, conversationId: 'c', kind: 'inject', lane: 'memory', payload: 'the dog is Lucy', payloadRef: 'memory:xyz', meta: { slot: 'injected' } });

    const expected = place({
      staticPrefix: 'BOOTSTRAP', injected: 'branch: main\n\nthe dog is Lucy',
      userPrefix: '', userMessage: 'what is my dog called?',
    });
    emit({ turnId: t, conversationId: 'c', kind: 'request', payload: expected });

    const d = deriveRequest(db, t, place)!;
    expect(d.complete).toBe(true);
    expect(d.text).toBe(expected);
    expect(d.hash).toBe(recordedRequestHash(db, t));
    expect(d.lanes.map((l) => l.lane)).toEqual(['bootstrap', 'ground_truth', 'memory']);
    expect(d.lanes.find((l) => l.lane === 'ground_truth')!.trust, 'trust travels with the event').toBe('owner');
  });

  it('an injector that skips the seam makes the derive DISAGREE — the whole point', () => {
    const t = 'turn-2';
    emit({ turnId: t, conversationId: 'c', kind: 'user/message', payload: 'hi', meta: { slot: 'userMessage' } });
    emit({ turnId: t, conversationId: 'c', kind: 'inject', lane: 'memory', payload: 'known', meta: { slot: 'injected' } });
    // …and something downstream appended text nobody registered.
    const actuallySent = place({ staticPrefix: '', injected: 'known', userPrefix: '', userMessage: 'hi' })
      + '\n\n## Workbench instructions\nsomething nobody logged';
    emit({ turnId: t, conversationId: 'c', kind: 'request', payload: actuallySent });

    const d = deriveRequest(db, t, place)!;
    expect(d.hash).not.toBe(recordedRequestHash(db, t));
  });

  it('a bootstrap payload is stored once and referenced, not copied per turn', () => {
    for (const t of ['a', 'b', 'c']) {
      emit({ turnId: t, conversationId: 'conv', kind: 'inject', lane: 'bootstrap', payload: 'THE 24KB MANUAL', payloadRef: 'bootstrap:same', meta: { slot: 'staticPrefix' } });
    }
    const blobs = db.prepare('SELECT count(*) n FROM turn_event_blobs').get() as { n: number };
    const inline = db.prepare('SELECT count(*) n FROM turn_events WHERE payload IS NOT NULL').get() as { n: number };
    expect(blobs.n, 'one blob for three turns').toBe(1);
    expect(inline.n, 'no per-turn copy of the manual').toBe(0);
    // …and it still derives
    emit({ turnId: 'a', conversationId: 'conv', kind: 'user/message', payload: 'q', meta: { slot: 'userMessage' } });
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
      db: () => db, flush: sink(db),
      isGuest: () => guest,
      redact: (t) => (t.includes('SECRETNEEDLE') ? t.replaceAll('SECRETNEEDLE', '[redacted]') : t),
      trustOf: () => undefined,
    });
  });

  it('a guest turn stores hashes only — never the owner MEMORY.md', () => {
    guest = true;
    emit({ turnId: 'g', conversationId: 'guestconv', kind: 'inject', lane: 'memory', payload: "the owner's private notes" });
    const row = db.prepare('SELECT payload, content_hash, meta FROM turn_events').get() as any;
    expect(row.payload, 'a guest turn must store no text').toBeNull();
    expect(row.content_hash, 'the hash is still taken, so derive can still be checked')
      .toBe(sha256("the owner's private notes"));
    expect(JSON.parse(row.meta).redacted).toBe('guest');
  });

  it('a leak needle is redacted but the hash is of the ORIGINAL', () => {
    emit({ turnId: 'l', conversationId: 'c', kind: 'inject', lane: 'memory', payload: 'x SECRETNEEDLE y' });
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
    emit({ turnId: '', conversationId: 'c', kind: 'turn/start' });
    expect((db.prepare('SELECT count(*) n FROM turn_events').get() as any).n).toBe(0);
  });

  it('retention nulls payloads and keeps the hashes', () => {
    emit({ turnId: 'r', conversationId: 'c', kind: 'inject', lane: 'memory', payload: 'old text' });
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
    emit({ turnId: 'r', conversationId: 'c', kind: 'user/message', payload: 'q', meta: { slot: 'userMessage' } });
    expect(deriveRequest(db, 'r', place)!.complete).toBe(false);
  });
});

describe('P0c — the API families send an array, not a string', () => {
  it('two identical messages are BOTH kept — a userBody piece is positional', async () => {
    // The lane dedupe exists for the assembler's double pass on the SYSTEM side.
    // Applied to user-body pieces it drops one of a pair of identical messages —
    // a conversation that says "ok" twice — and the derive then rebuilds a prompt
    // shorter than the one sent, inventing a gap that never existed.
    //
    // `emitTurnEvent` + one `flushTurnEvents`, not the `emit` helper: the dedupe
    // lives in the per-turn BUFFER, so a helper that flushes after every event
    // cannot exercise it at all — the first row is already gone when the second
    // arrives. (Written with `emit` first, and it passed for the wrong reason.)
    const db = freshDb();
    configureTurnEvents({ db: () => db, flush: sink(db), isGuest: () => false, redact: (t) => t, trustOf: () => undefined });
    emitTurnEvent({ turnId: 'apidup', conversationId: 'c', kind: 'inject', lane: 'api_user', payload: 'ok', meta: { slot: 'userBody', offset: 0 } });
    emitTurnEvent({ turnId: 'apidup', conversationId: 'c', kind: 'inject', lane: 'api_user', payload: 'ok', meta: { slot: 'userBody', offset: 40 } });
    // the system side must still collapse — that is what the guard was for
    emitTurnEvent({ turnId: 'apidup', conversationId: 'c', kind: 'inject', lane: 'memory', payload: 'same', meta: { slot: 'injected' } });
    emitTurnEvent({ turnId: 'apidup', conversationId: 'c', kind: 'inject', lane: 'memory', payload: 'same', meta: { slot: 'injected' } });
    await flushTurnEvents('apidup');

    const count = (lane: string) => (db.prepare(
      "SELECT count(*) AS n FROM turn_events WHERE turn_id='apidup' AND lane = ?").get(lane) as { n: number }).n;
    expect(count('api_user'), 'both user-body pieces survive').toBe(2);
    expect(count('memory'), 'the system-side double assemble still collapses').toBe(1);
  });

  it('the rendered pieces concatenate to exactly the rendering', async () => {
    // The deriver joins user-body pieces with NOTHING, so each piece must be a
    // verbatim slice. If the role markers were scaffolding BETWEEN pieces they
    // would show up as "bytes no lane accounts for" — the census lying in the
    // other direction, about text that is our own formatting.
    const { renderMessagePieces } = await import('../llm.js');
    const { rendered, pieces } = renderMessagePieces([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'system', content: 'late memory' },
      { role: 'user', content: 'third' },
    ]);
    expect(pieces.map((p) => p.text).join(''), 'pieces tile the rendering exactly').toBe(rendered);
    expect(pieces.map((p) => p.lane))
      .toEqual(['api_user', 'api_assistant', 'api_late_context', 'api_user']);
    // Non-string content (vision parts, tool payloads) is rendered as its shape.
    const { rendered: r2 } = renderMessagePieces([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    expect(r2).toContain('[{"type":"text","text":"hi"}]');
  });
});

describe('P0 — the census number', () => {
  it('reports unlogged bytes rather than a bare mismatch', () => {
    const db = freshDb();
    configureTurnEvents({ db: () => db, flush: sink(db), isGuest: () => false, redact: (t) => t, trustOf: () => undefined });
    const t = 'census';
    emit({ turnId: t, conversationId: 'c', kind: 'user/message', payload: 'hi', meta: { slot: 'userMessage' } });
    emit({ turnId: t, conversationId: 'c', kind: 'inject', lane: 'memory', payload: 'known', meta: { slot: 'injected' } });
    const sent = place({ staticPrefix: '', injected: 'known', userPrefix: '', userMessage: 'hi' }) + 'XXXXXXXXXX';
    emit({ turnId: t, conversationId: 'c', kind: 'request', payload: sent });
    const d = deriveRequest(db, t, place)!;
    expect(d.verdict).toBe('unlogged');
    expect(d.unloggedChars, 'bytes no lane accounts for').toBe(10);
  });

  it('a leak-needle redaction is UNKNOWN, never counted as unlogged bytes', () => {
    // The census number means "text the model was told that the registry cannot
    // name." A redaction is the opposite: the registry named it and policy chose
    // not to keep it. Counting one as the other inflates the only number Flow 12
    // reports, and it did — a real turn read `unlogged, 154 chars` where nothing
    // was unlogged at all.
    //
    // `guest` and `policy` null the payload and were already caught by the
    // completeness check. `leak_needle` stores the CLEANED text — shorter and
    // non-null — so it walked straight past it.
    const db = freshDb();
    const NEEDLE = 'not in this conversation';
    configureTurnEvents({
      db: () => db, flush: sink(db), isGuest: () => false,
      // The real binding drops the offending paragraph and keeps the rest.
      redact: (t) => t.split('\n\n').filter((p) => !p.includes(NEEDLE)).join('\n\n'),
      trustOf: () => undefined,
    });
    const t = 'needle';
    const full = `a clean paragraph\n\nand one that says ${NEEDLE} here`;
    emit({ turnId: t, conversationId: 'c', kind: 'user/message', payload: 'hi', meta: { slot: 'userMessage' } });
    emit({ turnId: t, conversationId: 'c', kind: 'inject', lane: 'memory', payload: full, meta: { slot: 'injected' } });
    emit({ turnId: t, conversationId: 'c', kind: 'request',
      payload: place({ staticPrefix: '', injected: full, userPrefix: '', userMessage: 'hi' }) });

    const row = db.prepare("SELECT payload, content_hash, meta FROM turn_events WHERE lane = 'memory'")
      .get() as { payload: string; content_hash: string; meta: string };
    expect(row.payload, 'the needle paragraph is gone from what is stored').not.toContain(NEEDLE);
    expect(JSON.parse(row.meta).redacted).toBe('leak_needle');
    expect(row.content_hash, 'the hash is of the ORIGINAL, so it stays comparable').toBe(sha256(full));

    const d = deriveRequest(db, t, place)!;
    expect(d.verdict, 'withheld text can only be hash-compared').toBe('unknown');
    expect(d.unloggedChars, 'a redaction is not a registry gap').toBe(0);
  });

  it('a pruned turn answers unknown, never ok', () => {
    const db = freshDb();
    configureTurnEvents({ db: () => db, flush: sink(db), isGuest: () => false, redact: (t) => t, trustOf: () => undefined });
    emit({ turnId: 'p', conversationId: 'c', kind: 'user/message', payload: 'hi', meta: { slot: 'userMessage' } });
    emit({ turnId: 'p', conversationId: 'c', kind: 'inject', lane: 'memory', payload: 'gone', meta: { slot: 'injected' } });
    db.prepare("UPDATE turn_events SET payload = NULL WHERE lane = 'memory'").run();
    expect(deriveRequest(db, 'p', place)!.verdict).toBe('unknown');
  });
});

// The route that renders "show me what it saw" must never present an empty box:
// a withheld payload has to say WHY, or a viewer cannot tell "we chose not to
// keep this" from "nothing was sent". Pinned as pure logic because the string is
// the privacy promise the user reads.
describe('P0 — a withheld payload explains itself', () => {
  const withheldFor = (meta: Record<string, unknown>, text: string | null) =>
    meta.redacted === 'guest' ? 'not stored (guest turn — the log keeps hashes only)'
    : meta.redacted === 'policy' ? 'withheld by inject-policy'
    : text === null ? 'payload expired (VODOU_TURN_LOG_DAYS)'
    : null;

  it('names the reason for every way text can be absent', () => {
    expect(withheldFor({ redacted: 'guest' }, null)).toMatch(/guest turn/);
    expect(withheldFor({ redacted: 'policy' }, null)).toMatch(/inject-policy/);
    expect(withheldFor({}, null)).toMatch(/expired/);
    expect(withheldFor({}, 'the actual text'), 'present text is not withheld').toBeNull();
  });

  it('a redacted-but-present payload is still shown (the needle is gone, the rest is not)', () => {
    expect(withheldFor({ redacted: 'leak_needle' }, 'x [redacted] y')).toBeNull();
  });
});

describe('P0b — a turn has one end', () => {
  it('a second turn/end for the same turn is ignored', () => {
    const db = freshDb();
    configureTurnEvents({ db: () => db, flush: sink(db), isGuest: () => false, redact: (t) => t, trustOf: () => undefined });
    // Two SEPARATE batches — which is the case that produced two ends: two
    // dispatches, each with its own buffer. The in-batch check cannot see across
    // them, so the invariant lives with the writer of record (the daemon's
    // insert); the sink below mirrors it.
    emit({ turnId: 'once', conversationId: 'c', kind: 'turn/end', meta: { outcome: 'ok', chars: 2908 } });
    emit({ turnId: 'once', conversationId: 'c', kind: 'turn/end', meta: { outcome: 'ok', chars: 2 } });
    const rows = db.prepare("SELECT meta FROM turn_events WHERE kind = 'turn/end'").all() as any[];
    expect(rows).toHaveLength(1);
    // the FIRST end wins — it is the one that actually belongs to this turn
    expect(JSON.parse(rows[0].meta).chars).toBe(2908);
  });
});

describe('P0b — mismatch is not the same as unlogged', () => {
  const setup = () => {
    const db = freshDb();
    configureTurnEvents({ db: () => db, flush: sink(db), isGuest: () => false, redact: (t) => t, trustOf: () => undefined });
    return db;
  };
  it('same length, different bytes → mismatch (the log is WRONG, not incomplete)', () => {
    const db = setup();
    emit({ turnId: 'mm', conversationId: 'c', kind: 'user/message', payload: 'hi', meta: { slot: 'userMessage' } });
    emit({ turnId: 'mm', conversationId: 'c', kind: 'inject', lane: 'memory', payload: 'AAAA', meta: { slot: 'injected' } });
    const sent = place({ staticPrefix: '', injected: 'BBBB', userPrefix: '', userMessage: 'hi' });
    emit({ turnId: 'mm', conversationId: 'c', kind: 'request', payload: sent });
    const d = deriveRequest(db, 'mm', place)!;
    expect(d.unloggedChars, 'nothing is MISSING').toBe(0);
    expect(d.verdict, 'so it is not "unlogged" — it is wrong').toBe('mismatch');
  });
  it('longer request → unlogged, with the count', () => {
    const db = setup();
    emit({ turnId: 'ul', conversationId: 'c', kind: 'user/message', payload: 'hi', meta: { slot: 'userMessage' } });
    const sent = place({ staticPrefix: '', injected: '', userPrefix: '', userMessage: 'hi' }) + 'ZZZZZ';
    emit({ turnId: 'ul', conversationId: 'c', kind: 'request', payload: sent });
    const d = deriveRequest(db, 'ul', place)!;
    expect(d.verdict).toBe('unlogged');
    expect(d.unloggedChars).toBe(5);
  });
});

describe('P0b — inline lanes are named but not placed twice', () => {
  it('an inline piece is recorded and does NOT re-enter the derived request', () => {
    const db = freshDb();
    configureTurnEvents({ db: () => db, flush: sink(db), isGuest: () => false, redact: (t) => t, trustOf: () => undefined });
    const t = 'inline';
    // history covers the whole user body, INCLUDING the page fence inside it
    emit({ turnId: t, conversationId: 'c', kind: 'inject', lane: 'history', payload: 'ask\n\n[[page fence]]', meta: { slot: 'userBody', offset: 0 } });
    emit({ turnId: t, conversationId: 'c', kind: 'inject', lane: 'page_context', payload: '[[page fence]]', meta: { slot: 'none', offset: 5, inside: 'user body' } });
    const sent = place({ staticPrefix: '', injected: '', userPrefix: '', userMessage: 'ask\n\n[[page fence]]' });
    emit({ turnId: t, conversationId: 'c', kind: 'request', payload: sent });
    const d = deriveRequest(db, t, place)!;
    // placing page_context again would have made the request longer than it was
    expect(d.verdict).toBe('match');
    expect(d.text).toBe(sent);
    // …and it is still readable in the log
    const row = db.prepare("SELECT payload FROM turn_events WHERE lane = 'page_context'").get() as any;
    expect(row.payload).toBe('[[page fence]]');
  });
});

describe('P0d — a lane contributes once per turn, unless its bytes differ', () => {
  it('the same lane emitting the same bytes twice is deduped', async () => {
    const db = freshDb(); configureTurnEvents({ db: () => db, flush: sink(db), isGuest: () => false, redact: (t) => t, trustOf: () => undefined });
    // `emitTurnEvent`, not `emit` — ONE batch, which is the production shape: a
    // turn's events accumulate in a single buffer and are sent at the turn
    // boundary. The dedupe lives in that buffer, so a helper that flushes after
    // every event cannot exercise it (the first row is already gone when the
    // second arrives). Getting that wrong is how this test first failed.
    emitTurnEvent({ turnId: 'dup', conversationId: 'c', kind: 'inject', lane: 'tool_results', payload: 'RESULT', meta: { slot: 'userPrefix' } });
    emitTurnEvent({ turnId: 'dup', conversationId: 'c', kind: 'inject', lane: 'tool_results', payload: 'RESULT', meta: { slot: 'userPrefix' } });
    emitTurnEvent({ turnId: 'dup', conversationId: 'c', kind: 'user/message', payload: 'q', meta: { slot: 'userMessage' } });
    await flushTurnEvents('dup');
    const n = db.prepare("SELECT count(*) n FROM turn_events WHERE lane='tool_results'").get() as { n: number };
    expect(n.n, 'the same bytes twice is one contribution').toBe(1);
    // …and the derive no longer places it twice
    expect(deriveRequest(db, 'dup', place)!.text).toBe(place({ staticPrefix: '', injected: '', userPrefix: 'RESULT', userMessage: 'q' }));
  });

  it('the same lane emitting DIFFERENT bytes keeps both', async () => {
    const db = freshDb(); configureTurnEvents({ db: () => db, flush: sink(db), isGuest: () => false, redact: (t) => t, trustOf: () => undefined });
    // channel_envelope really is two pieces: the opening tag and the rules.
    emitTurnEvent({ turnId: 'two', conversationId: 'c', kind: 'inject', lane: 'channel_envelope', payload: '<open>', meta: { slot: 'none' } });
    emitTurnEvent({ turnId: 'two', conversationId: 'c', kind: 'inject', lane: 'channel_envelope', payload: '</close><rules>', meta: { slot: 'none' } });
    await flushTurnEvents('two');
    const n = db.prepare("SELECT count(*) n FROM turn_events WHERE lane='channel_envelope'").get() as { n: number };
    expect(n.n, 'two different pieces are two contributions').toBe(2);
  });
});

// ── PLAN-SEAMS P6b(A) — the cross-vendor inject leaves a record ──────────────
//
// The turn log had exactly two sources, `gateway` and `hook`, so the one lane
// the product is sold on — Vodou's memory reaching ChatGPT — was invisible. The
// composer inject is deliberately unfenced, and the extension strips those same
// bytes back out of the capture, so nothing durable held them.
describe('P6b — a turn event carries the surface that produced it', () => {
  let db: ReturnType<typeof freshDb>;
  beforeEach(() => {
    db = freshDb();
    configureTurnEvents({
      db: () => db, flush: sink(db),
      isGuest: () => false, redact: (t) => t, trustOf: () => undefined,
    });
  });

  it('defaults to gateway, so every existing caller is unchanged', () => {
    emit({ turnId: 'g1', conversationId: 'c', kind: 'turn/start' });
    const row = db.prepare('SELECT source FROM turn_events').get() as { source: string };
    expect(row.source).toBe('gateway');
  });

  it('records `capture` for a cross-vendor inject', () => {
    emit({
      turnId: 'capture:chatgpt:1', conversationId: 'brainctx:chatgpt:x', kind: 'inject',
      lane: 'memory', payload: 'the pack', provider: 'chatgpt', source: 'capture',
      meta: { slot: 'none', from: 'composer inject' },
    });
    const row = db.prepare('SELECT source, lane, provider, meta FROM turn_events').get() as any;
    expect(row.source).toBe('capture');
    expect(row.lane).toBe('memory');
    expect(row.provider).toBe('chatgpt');
    // `slot: none` keeps it out of the derive — it is a CONTRIBUTION to a request
    // assembled by ChatGPT, not a placement in one Vodou built. Same reason the
    // daemon's hook row carries it.
    expect(JSON.parse(row.meta).slot).toBe('none');
  });

  it('a capture turn ends `partial`, never ok — there is no request to compare', () => {
    emit({ turnId: 'capture:chatgpt:2', conversationId: 'c', kind: 'turn/start', source: 'capture' });
    emit({
      turnId: 'capture:chatgpt:2', conversationId: 'c', kind: 'turn/end', source: 'capture',
      meta: { outcome: 'ok', partial: true, derive: 'partial' },
    });
    const row = db
      .prepare("SELECT meta FROM turn_events WHERE kind = 'turn/end'")
      .get() as { meta: string };
    const meta = JSON.parse(row.meta);
    expect(meta.derive).toBe('partial');
    expect(meta.partial).toBe(true);
  });

  it('the privacy rules apply to a capture turn like any other', () => {
    configureTurnEvents({
      db: () => db, flush: sink(db),
      isGuest: () => true, redact: (t) => t, trustOf: () => undefined,
    });
    emit({
      turnId: 'capture:chatgpt:3', conversationId: 'c', kind: 'inject', lane: 'memory',
      payload: "the owner's private notes", source: 'capture',
    });
    const row = db.prepare('SELECT payload, meta FROM turn_events').get() as any;
    expect(row.payload, 'a guest inject into a third-party model stores no text').toBeNull();
    expect(JSON.parse(row.meta).redacted).toBe('guest');
  });
});

