import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

// PLAN-HISTORY-BACKFILL — adopt-in-place must reach rows the LIVE window cannot.
//
// Measured live 2026-08-09: a ChatGPT thread captured forward-only on 2026-07-25 was
// backfilled today. All 6 history turns inserted, and the 4 already present became
// duplicates — the precise failure adopt-in-place exists to prevent. Two independent
// reasons the claim could not fire on those rows:
//
//   1. `dedupe_key IS NOT NULL` — rows from before keyed capture carry NULL.
//   2. `created_at >= now - 600s` — they were 374 HOURS old.
//
// The live window is right for live capture and off by ~2000x for a feature whose
// entire purpose is old content. These tests pin the widened claim, and — just as
// importantly — pin that widening it did NOT make it eat genuine repeats.
//
// The claim is plain SQL, so it is exercised here as SQL against a real in-memory
// SQLite with the production schema shape. That keeps the test honest about SQLite
// semantics (partial unique index, NULL handling) rather than mocking them away.

const LIVE_CLAIM = `
  UPDATE gateway_messages
     SET dedupe_key = ?, source_msg_id = ?
   WHERE rowid = (
     SELECT rowid FROM gateway_messages
      WHERE conversation_id = ? AND role = ? AND content = ?
        AND dedupe_key IS NOT NULL
        AND (source_msg_id IS NULL OR source_msg_id = '')
        AND created_at >= datetime('now', ?)
      ORDER BY id DESC LIMIT 1)`;

const BACKFILL_CLAIM = `
  UPDATE gateway_messages
     SET dedupe_key = ?, source_msg_id = ?
   WHERE rowid = (
     SELECT rowid FROM gateway_messages
      WHERE conversation_id = ? AND role = ? AND content = ?
        AND (source_msg_id IS NULL OR source_msg_id = '')
      ORDER BY id DESC LIMIT 1)`;

const CONV = 'webcap:chatgpt:6a647473';

let db: DatabaseSync;

function insertOld(role: string, content: string, opts: { dedupeKey?: string | null; daysAgo: number }) {
  db.prepare(
    `INSERT INTO gateway_messages (conversation_id, role, content, created_at, dedupe_key, source_msg_id)
     VALUES (?, ?, ?, datetime('now', ?), ?, NULL)`,
  ).run(CONV, role, content, `-${opts.daysAgo} days`, opts.dedupeKey ?? null);
}

const claimBackfill = (key: string, src: string, role: string, content: string) =>
  Number(db.prepare(BACKFILL_CLAIM).run(key, src, CONV, role, content).changes || 0);

const claimLive = (key: string, src: string, role: string, content: string, win = 600) =>
  Number(db.prepare(LIVE_CLAIM).run(key, src, CONV, role, content, `-${win} seconds`).changes || 0);

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE gateway_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      dedupe_key TEXT, source_msg_id TEXT);
    CREATE UNIQUE INDEX idx_gw_messages_dedupe
      ON gateway_messages(dedupe_key) WHERE dedupe_key IS NOT NULL;`);
});

describe('backfill adopt-in-place', () => {
  it('reproduces the live bug: the LIVE claim cannot touch a 15-day-old unkeyed row', () => {
    insertOld('user', 'what is my cpu', { dedupeKey: null, daysAgo: 15 });
    expect(claimLive('id:m1', 'm1', 'user', 'what is my cpu')).toBe(0);
  });

  it('the backfill claim adopts it instead of leaving a duplicate behind', () => {
    insertOld('user', 'what is my cpu', { dedupeKey: null, daysAgo: 15 });
    expect(claimBackfill('id:m1', 'm1', 'user', 'what is my cpu')).toBe(1);
    const row = db.prepare('SELECT dedupe_key, source_msg_id FROM gateway_messages').get() as any;
    expect(row.dedupe_key).toBe('id:m1');
    expect(row.source_msg_id).toBe('m1');
    expect(db.prepare('SELECT COUNT(*) c FROM gateway_messages').get()).toEqual({ c: 1 });
  });

  it('adopts an old HASH-keyed row too (the original mixed-key case, aged out)', () => {
    insertOld('assistant', 'your cpu is fine', { dedupeKey: 'h:abc:123', daysAgo: 15 });
    expect(claimBackfill('id:m2', 'm2', 'assistant', 'your cpu is fine')).toBe(1);
  });

  it('never claims a row that already carries a provider id — id may not supersede id', () => {
    db.prepare(
      `INSERT INTO gateway_messages (conversation_id, role, content, dedupe_key, source_msg_id)
       VALUES (?, 'user', 'hello', 'id:first', 'first')`,
    ).run(CONV);
    expect(claimBackfill('id:second', 'second', 'user', 'hello')).toBe(0);
  });

  it('two genuine repeats of the same text claim two DIFFERENT rows, not one', () => {
    // The narrow window's safety argument was "identical turns inside the window are
    // already collapsed". Widening it must not start eating real repeats: each claim
    // requires source_msg_id IS NULL, so the second claim cannot re-take the first row.
    insertOld('user', 'yes', { dedupeKey: null, daysAgo: 20 });
    insertOld('user', 'yes', { dedupeKey: null, daysAgo: 20 });
    expect(claimBackfill('id:y1', 'y1', 'user', 'yes')).toBe(1);
    expect(claimBackfill('id:y2', 'y2', 'user', 'yes')).toBe(1);
    const rows = db.prepare('SELECT source_msg_id FROM gateway_messages ORDER BY id').all() as any[];
    expect(rows.map((r) => r.source_msg_id).sort()).toEqual(['y1', 'y2']);
    expect(rows).toHaveLength(2);
  });

  it('is scoped to the conversation — it cannot adopt an identical turn from another thread', () => {
    db.prepare(
      `INSERT INTO gateway_messages (conversation_id, role, content) VALUES ('webcap:chatgpt:OTHER', 'user', 'shared text')`,
    ).run();
    expect(claimBackfill('id:m3', 'm3', 'user', 'shared text')).toBe(0);
  });

  it('is scoped to the role — a user turn cannot adopt an assistant turn', () => {
    insertOld('assistant', 'same words', { dedupeKey: null, daysAgo: 15 });
    expect(claimBackfill('id:m4', 'm4', 'user', 'same words')).toBe(0);
  });

  it('a second backfill of the same transcript adopts nothing and inserts nothing', () => {
    insertOld('user', 'what is my cpu', { dedupeKey: null, daysAgo: 15 });
    expect(claimBackfill('id:m1', 'm1', 'user', 'what is my cpu')).toBe(1);
    // Re-open: same provider id arrives again. Nothing left to claim…
    expect(claimBackfill('id:m1', 'm1', 'user', 'what is my cpu')).toBe(0);
    // …and the insert that would follow is refused by the partial unique index.
    expect(() =>
      db.prepare(
        `INSERT INTO gateway_messages (conversation_id, role, content, dedupe_key, source_msg_id)
         VALUES (?, 'user', 'what is my cpu', 'id:m1', 'm1')`,
      ).run(CONV),
    ).toThrow();
    expect(db.prepare('SELECT COUNT(*) c FROM gateway_messages').get()).toEqual({ c: 1 });
  });
});
