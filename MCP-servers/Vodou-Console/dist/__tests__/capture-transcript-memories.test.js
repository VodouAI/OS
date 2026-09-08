/**
 * GW-7 — the three capture routes had no client, and one of them could not have
 * had a working one.
 *
 * `/api/capture/{conversations,conversation/:id/transcript,forget}` were all
 * registered, guarded, and called by nothing: no surface could list what the
 * browser bridge had captured, read one back, or delete what it became. For a
 * product whose pitch is local-first capture, that is the wrong half of the
 * promise.
 *
 * Wiring the UI exposed a real gap rather than just a missing screen. `/forget`
 * takes a **chunk_id** (`path:line:hash`), not a conversation id, and nothing
 * returned chunk ids — the transcript gave you messages and the list gave you a
 * COUNT of memories. So "read what was captured" and "delete what it became"
 * could not be joined by any client, however well written.
 *
 * The transcript now returns the chunks themselves. These tests pin the parts a
 * privacy surface cannot get wrong:
 *
 *   · the id is exactly the shape `mem reject --chunk-id` parses;
 *   · an ARCHIVED chunk is not offered (rejecting it already archived it, and
 *     offering to forget it again would be a button that lies);
 *   · a conversation with no distillation reports an empty list, not an absent
 *     field — the client renders "nothing distilled yet", which is a different
 *     sentence from "no data";
 *   · a memory.db that cannot be read still returns the transcript, because the
 *     transcript is the part the user asked for.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
let memDb;
let gwDb;
let coreDb;
vi.mock('../db.js', () => ({
    getMemoryDb: () => { if (memDb === null)
        throw new Error('memory.db unavailable'); return memDb; },
    getGatewayDb: () => gwDb,
    getDb: () => coreDb,
    getSetting: () => null,
    setSetting: () => { },
    getProjectRoot: () => '/tmp',
}));
const { memoryCaptureRouter } = await import('../api/memory-capture.js');
const CONV = 'capture-conv-1';
function seed() {
    gwDb = new DatabaseSync(':memory:');
    gwDb.exec(`
    CREATE TABLE gateway_conversations (id TEXT PRIMARY KEY, title TEXT, source TEXT,
      created_at TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE gateway_messages (id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT, role TEXT, content TEXT, created_at TEXT);
    INSERT INTO gateway_conversations VALUES
      ('${CONV}', 'A ChatGPT chat', 'capture:web:chatgpt', '2026-09-01 10:00:00', '2026-09-01 10:05:00', NULL),
      ('private-1', 'A private Vodou chat', 'web', '2026-09-01 10:00:00', '2026-09-01 10:05:00', NULL);
    INSERT INTO gateway_messages (conversation_id, role, content, created_at) VALUES
      ('${CONV}', 'user', 'what is my flight number', '2026-09-01 10:00:00'),
      ('${CONV}', 'assistant', 'BA294', '2026-09-01 10:01:00');
  `);
    memDb = new DatabaseSync(':memory:');
    memDb.exec(`
    CREATE TABLE memory_chunks (id INTEGER PRIMARY KEY, path TEXT, start_line INTEGER,
      hash TEXT, text TEXT, created_at TEXT, archived INTEGER DEFAULT 0, source_ref TEXT);
    INSERT INTO memory_chunks (path, start_line, hash, text, created_at, archived, source_ref) VALUES
      ('memory/2026-09-01.md', 42, 'fdb92068aaaa', 'Flight BA294', '2026-09-01 10:02:00', 0, '${CONV}'),
      ('memory/2026-09-01.md', 99, 'deadbeefbbbb', 'Already rejected', '2026-09-01 10:03:00', 1, '${CONV}');
  `);
    coreDb = new DatabaseSync(':memory:');
    coreDb.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);
}
async function get(path) {
    const app = express();
    app.use('/api/capture', memoryCaptureRouter);
    const server = app.listen(0);
    const port = server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}${path}`);
        const text = await res.text();
        let body;
        try {
            body = JSON.parse(text);
        }
        catch {
            body = text;
        }
        return { status: res.status, body };
    }
    finally {
        await new Promise((r) => server.close(() => r()));
    }
}
describe('GW-7 — a captured transcript carries the chunk ids /forget needs', () => {
    beforeEach(seed);
    it('returns the messages AND the memories, with forgettable ids', async () => {
        const { status, body } = await get(`/api/capture/conversation/${CONV}/transcript`);
        expect(status).toBe(200);
        expect(body.messages).toHaveLength(2);
        expect(body.memories).toHaveLength(1);
        // Exactly the shape `mem reject --chunk-id` parses: path:line:hash8.
        expect(body.memories[0].chunk_id).toBe('memory/2026-09-01.md:42:fdb92068');
        expect(body.memories[0].text).toBe('Flight BA294');
    });
    it('does not offer to forget an already-archived chunk', async () => {
        // `mem reject` archives. Listing one again would be a button that cannot
        // do anything, on the screen where the user is trying to remove things.
        const { body } = await get(`/api/capture/conversation/${CONV}/transcript`);
        const ids = body.memories.map((m) => m.chunk_id);
        expect(ids.some((i) => i.includes('deadbeef'))).toBe(false);
    });
    it('reports an empty list, not a missing field, when nothing was distilled', async () => {
        memDb.exec(`DELETE FROM memory_chunks`);
        const { body } = await get(`/api/capture/conversation/${CONV}/transcript`);
        expect(Array.isArray(body.memories)).toBe(true);
        expect(body.memories).toHaveLength(0);
        // The transcript itself must survive: "nothing distilled" is not "no data".
        expect(body.messages).toHaveLength(2);
    });
    it('still returns the transcript when memory.db cannot be read', async () => {
        memDb = null; // the mock throws, as a missing/locked store would
        const { status, body } = await get(`/api/capture/conversation/${CONV}/transcript`);
        expect(status).toBe(200);
        expect(body.messages).toHaveLength(2);
        expect(body.memories).toEqual([]);
    });
    it('still refuses a conversation that is not a capture', async () => {
        // The guard this route already had, re-pinned: the new field must not have
        // widened it into a way to read a private Vodou chat.
        const { status, body } = await get('/api/capture/conversation/private-1/transcript');
        expect(status).toBe(403);
        expect(body.error).toMatch(/not a captured conversation/);
    });
    it('lists captured conversations and excludes private ones', async () => {
        const { status, body } = await get('/api/capture/conversations?limit=50');
        expect(status).toBe(200);
        expect(body.conversations.map((c) => c.id)).toEqual([CONV]);
        expect(body.conversations[0].memories).toBe(1);
    });
});
