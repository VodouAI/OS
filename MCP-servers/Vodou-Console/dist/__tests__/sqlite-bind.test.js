/**
 * §7 S-4 — a bind failure must name the COLUMN, not a positional index.
 *
 * The bug this exists for (add_thought, §7.1) survived months because
 * "Provided value cannot be bound to SQLite parameter 2" is true, precise, and
 * useless. These tests pin the translation, including against a REAL node:sqlite
 * failure rather than a hand-thrown imitation.
 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { columnsForPlaceholders, withBindDiagnostics, bindSafe } from '../sqlite-bind.js';
describe('columnsForPlaceholders', () => {
    it('maps INSERT placeholders to columns in order', () => {
        const sql = `INSERT INTO thoughts (session_id, thought_number, thought_text, total_thoughts)
                 VALUES (?, ?, ?, ?)`;
        expect(columnsForPlaceholders(sql)).toEqual([
            'session_id', 'thought_number', 'thought_text', 'total_thoughts',
        ]);
    });
    it('handles INSERT OR IGNORE and quoted identifiers', () => {
        expect(columnsForPlaceholders('INSERT OR IGNORE INTO "t" (`a`, [b]) VALUES (?, ?)')).toEqual(['a', 'b']);
    });
    it('maps UPDATE … SET … WHERE, SET columns first', () => {
        const sql = 'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?';
        expect(columnsForPlaceholders(sql)).toEqual(['status', 'updated_at', 'id']);
    });
    it('ignores SET assignments that bind no placeholder', () => {
        // updated_at is a literal here — it must NOT consume a placeholder slot, or
        // every column after it is reported one position off.
        const sql = "UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?";
        expect(columnsForPlaceholders(sql)).toEqual(['status', 'id']);
    });
    it('maps SELECT … WHERE and strips table aliases', () => {
        expect(columnsForPlaceholders('SELECT * FROM memory_chunks c WHERE c.id = ? AND c.scope = ?'))
            .toEqual(['id', 'scope']);
    });
    it('returns [] rather than guessing on SQL it cannot parse', () => {
        expect(columnsForPlaceholders('PRAGMA table_info(x)')).toEqual([]);
    });
});
describe('withBindDiagnostics against a REAL node:sqlite bind failure', () => {
    const setup = () => {
        const db = new DatabaseSync(':memory:');
        db.exec(`CREATE TABLE thoughts (
               id INTEGER PRIMARY KEY,
               session_id TEXT NOT NULL,
               thought_number INTEGER NOT NULL,
               thought_text TEXT NOT NULL
             )`);
        return db;
    };
    it('names the column for the exact failure that hid add_thought for months', () => {
        const db = setup();
        const sql = 'INSERT INTO thoughts (session_id, thought_number, thought_text) VALUES (?, ?, ?)';
        const stmt = db.prepare(sql);
        const values = ['sess-1', undefined, 'some text'];
        // Baseline: node:sqlite's own message names only an index.
        let raw = '';
        try {
            stmt.run(...values);
        }
        catch (e) {
            raw = e.message;
        }
        expect(raw).toMatch(/parameter 2/);
        expect(raw).not.toMatch(/thought_number/);
        // With the guard: the column is in the message.
        expect(() => withBindDiagnostics(sql, values, () => stmt.run(...values)))
            .toThrow(/thought_number/);
        try {
            withBindDiagnostics(sql, values, () => stmt.run(...values));
        }
        catch (e) {
            const m = e.message;
            expect(m).toContain('parameter 2');
            expect(m).toContain('thought_number');
            expect(m).toContain('INSERT INTO thoughts');
            expect(m).toContain('received: undefined');
        }
    });
    it('passes a successful call straight through', () => {
        const db = setup();
        const sql = 'INSERT INTO thoughts (session_id, thought_number, thought_text) VALUES (?, ?, ?)';
        const stmt = db.prepare(sql);
        const r = withBindDiagnostics(sql, ['s', 1, 't'], () => stmt.run('s', 1, 't'));
        expect(r.changes).toBe(1);
    });
    it('never swallows an unrelated error', () => {
        const sql = 'INSERT INTO thoughts (session_id) VALUES (?)';
        expect(() => withBindDiagnostics(sql, ['x'], () => { throw new Error('disk I/O error'); }))
            .toThrow('disk I/O error');
    });
});
describe('bindSafe', () => {
    it('coerces undefined to null and leaves everything else alone', () => {
        const sql = 'INSERT INTO t (a, b, c) VALUES (?, ?, ?)';
        expect(bindSafe(sql, ['x', undefined, 0])).toEqual(['x', null, 0]);
    });
    it('preserves null, 0 and empty string — only undefined is coerced', () => {
        const sql = 'INSERT INTO t (a, b, c) VALUES (?, ?, ?)';
        expect(bindSafe(sql, [null, 0, ''])).toEqual([null, 0, '']);
    });
});
