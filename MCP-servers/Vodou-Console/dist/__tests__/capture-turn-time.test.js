import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
// E12 (PLAN-MEMORY-EVENT-TIME) — a captured turn keeps the provider's OWN
// creation time when its API gave us one.
//
// The netcap parsers already read each message's real time to SORT the transcript
// (ChatGPT `create_time`, a float epoch; Claude `created_at`, an ISO string) and
// then dropped it when building `turns`. Arrival time is the right default for a
// LIVE turn — it arrives as it is sent — and wrong for a BACKFILL, where a whole
// historic transcript relayed today would be dated to now. `capture_turn` batches
// are explicitly flagged `backfill` for exactly this reason.
//
// Exercised as SQL against a real in-memory SQLite with the production column
// shape, in the style of backfill-adopt.test.ts: the behaviour under test IS the
// conditional INSERT, so mocking it away would test nothing.
const SCHEMA = `
  CREATE TABLE gateway_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    principal_id TEXT, sender_label TEXT, skill_name TEXT,
    dedupe_key TEXT, source_msg_id TEXT, model TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`;
const WITH_TIME = 'INSERT INTO gateway_messages (conversation_id, role, content, principal_id, sender_label, skill_name, dedupe_key, source_msg_id, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const WITHOUT_TIME = 'INSERT INTO gateway_messages (conversation_id, role, content, principal_id, sender_label, skill_name, dedupe_key, source_msg_id, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
/** The bridge's validation gate, mirrored (bridge.ts::handleCaptureTurn). */
const STORED_FORM = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
describe('E12 — captured turns keep the provider API timestamp', () => {
    let db;
    beforeEach(() => {
        db = new DatabaseSync(':memory:');
        db.exec(SCHEMA);
    });
    it('stores the provider time verbatim when the turn carries one', () => {
        db.prepare(WITH_TIME).run('c1', 'user', 'hello', null, null, null, null, null, null, '2024-03-14 09:30:00');
        const row = db.prepare('SELECT created_at FROM gateway_messages WHERE conversation_id = ?').get('c1');
        expect(row.created_at).toBe('2024-03-14 09:30:00');
    });
    it('falls back to arrival time when the turn carries none', () => {
        db.prepare(WITHOUT_TIME).run('c2', 'user', 'hello', null, null, null, null, null, null);
        const row = db.prepare('SELECT created_at FROM gateway_messages WHERE conversation_id = ?').get('c2');
        expect(row.created_at).toBeTruthy();
        // Within a minute of now — i.e. the CURRENT_TIMESTAMP default, unchanged.
        const age = Date.now() - Date.parse(String(row.created_at).replace(' ', 'T') + 'Z');
        expect(Math.abs(age)).toBeLessThan(60_000);
    });
    it('keeps a backfilled transcript in its own era, not the relay moment', () => {
        // The regression: six historic turns relayed in one batch today.
        const times = [
            '2024-03-14 09:30:00', '2024-03-14 09:31:07', '2024-03-14 09:33:41',
            '2024-03-15 11:02:00', '2024-03-15 11:04:12', '2024-03-15 11:09:55',
        ];
        for (const [i, t] of times.entries()) {
            db.prepare(WITH_TIME).run('c3', i % 2 ? 'assistant' : 'user', `turn ${i}`, null, null, null, null, null, null, t);
        }
        const rows = db.prepare('SELECT created_at FROM gateway_messages WHERE conversation_id = ? ORDER BY id').all('c3');
        const distinct = new Set(rows.map((r) => r.created_at));
        // The whole point: turns must not collapse to a single instant.
        expect(distinct.size).toBe(6);
        expect(rows[0].created_at).toBe('2024-03-14 09:30:00');
        expect(rows[5].created_at).toBe('2024-03-15 11:09:55');
        // And none of them landed in the present.
        const newest = Math.max(...rows.map((r) => Date.parse(String(r.created_at).replace(' ', 'T') + 'Z')));
        expect(Date.now() - newest).toBeGreaterThan(30 * 24 * 3600 * 1000);
    });
    describe('bridge validation — the value arrives from a page-injected script', () => {
        it('accepts the normalized stored form', () => {
            expect(STORED_FORM.test('2024-03-14 09:30:00')).toBe(true);
        });
        it('rejects shapes that would poison the column', () => {
            for (const bad of [
                '2024-03-14T09:30:00Z', // ISO — not the stored form
                '2024-03-14', // date only
                '', // empty
                'now', // prose
                "2024-03-14 09:30:00'; DROP--", // injection-shaped
                '0000-00-00 00:00:00 ', // trailing space
            ]) {
                expect(STORED_FORM.test(bad), `must reject ${JSON.stringify(bad)}`).toBe(false);
            }
        });
        it('a rejected value means fallback, never a failed capture', () => {
            const raw = '2024-03-14T09:30:00Z';
            const turnCreatedAt = STORED_FORM.test(raw) ? raw : null;
            expect(turnCreatedAt).toBeNull();
            // Null routes to the no-time INSERT, which still stores the turn.
            db.prepare(WITHOUT_TIME).run('c4', 'user', 'still stored', null, null, null, null, null, null);
            const n = db.prepare('SELECT COUNT(*) AS n FROM gateway_messages WHERE conversation_id = ?').get('c4');
            expect(n.n).toBe(1);
        });
    });
});
