/**
 * COHERENCE F27 — "It says it saved the chat. Did it actually learn anything?"
 *
 * The panel's activity feed says *"Saved 6 messages from ChatGPT to memory"* and
 * stops. Whether those messages became anything has never been answerable, so
 * "saved, nothing worth keeping" and "saved, extraction failed" are the same
 * sentence to a user. The live case that made this concrete: 5 Character.AI
 * conversations produced 0 chunks, which is CORRECT — roleplay holds no durable
 * facts — and indistinguishable from a silent failure.
 *
 * What this file guards is not the counting. It is the FOURTH state.
 *
 * `memory_chunks.source_ref` — the conversation a memory came from — only began
 * being written on 2026-08-18: in the live corpus every capture chunk after that
 * instant carries one and every chunk before it carries none (2,008 vs 8,263).
 * A yield built naively on that column would report every July conversation as
 * "nothing worth keeping" while its memories sit in the corpus. That is a
 * confident lie, and strictly worse than the silence being fixed — it is the
 * same defect as the finding, pointed the other way.
 *
 * So the cutover is derived from the data rather than hardcoded, and anything
 * older than it answers `unknown`, which the panel renders as nothing at all.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
// One in-memory stand-in per store; the module reads all three.
let memDb;
let gwDb;
let coreDb;
vi.mock('../db.js', () => ({
    getMemoryDb: () => memDb,
    getGatewayDb: () => gwDb,
    getDb: () => coreDb,
    getSetting: () => null,
    setSetting: () => { },
    getProjectRoot: () => '/tmp',
}));
const { conversationYields } = await import('../api/memory-capture.js');
/** The instant provenance stamping began in the live corpus. */
const STAMPED_FROM = '2026-08-18 03:59:20';
const WATERMARK = 1000;
beforeEach(() => {
    memDb = new DatabaseSync(':memory:');
    memDb.exec('CREATE TABLE memory_chunks (id TEXT, source_ref TEXT, created_at TEXT)');
    gwDb = new DatabaseSync(':memory:');
    gwDb.exec('CREATE TABLE gateway_conversations (id TEXT PRIMARY KEY, updated_at TEXT)');
    gwDb.exec('CREATE TABLE gateway_messages (id INTEGER PRIMARY KEY, conversation_id TEXT)');
    coreDb = new DatabaseSync(':memory:');
    coreDb.exec('CREATE TABLE metadata (key TEXT, value TEXT)');
    coreDb.prepare('INSERT INTO metadata VALUES (?, ?)').run('gateway_memory_last_id', String(WATERMARK));
    // A chunk from the stamping era, so a cutover exists to compare against.
    memDb.prepare('INSERT INTO memory_chunks VALUES (?, ?, ?)').run('seed', 'other:conv', STAMPED_FROM);
});
function conversation(id, updatedAt, lastMessageId) {
    gwDb.prepare('INSERT INTO gateway_conversations VALUES (?, ?)').run(id, updatedAt);
    gwDb.prepare('INSERT INTO gateway_messages VALUES (?, ?)').run(lastMessageId, id);
}
function chunks(convId, n) {
    for (let i = 0; i < n; i++) {
        memDb.prepare('INSERT INTO memory_chunks VALUES (?, ?, ?)').run(`c${convId}${i}`, convId, '2026-08-20 10:00:00');
    }
}
describe('what came of a saved conversation', () => {
    it('counts the memories a conversation actually produced', () => {
        conversation('capture:web:chatgpt:a', '2026-08-20 10:00:00', 900);
        chunks('capture:web:chatgpt:a', 3);
        expect(conversationYields(['capture:web:chatgpt:a'])).toEqual({
            'capture:web:chatgpt:a': { memories: 3, state: 'yielded' },
        });
    });
    it('says "nothing worth keeping" only for a chat that was actually read', () => {
        // Read (below the watermark), after stamping began, and no chunks: the
        // Character.AI case. This is the one state that makes a zero trustworthy.
        conversation('capture:web:characterai:b', '2026-08-20 10:00:00', 900);
        expect(conversationYields(['capture:web:characterai:b'])['capture:web:characterai:b'])
            .toEqual({ memories: 0, state: 'none' });
    });
    it('does not call an unread conversation empty', () => {
        conversation('capture:web:chatgpt:c', '2026-08-20 10:00:00', WATERMARK + 5);
        expect(conversationYields(['capture:web:chatgpt:c'])['capture:web:chatgpt:c'])
            .toEqual({ memories: 0, state: 'pending' });
    });
    /** The assertion this file exists for. */
    it('refuses to judge a conversation older than provenance stamping', () => {
        conversation('capture:web:chatgpt:july', '2026-07-20 10:00:00', 900);
        expect(conversationYields(['capture:web:chatgpt:july'])['capture:web:chatgpt:july'], 'a July chat has no source_ref by construction — calling it empty is a lie').toEqual({ memories: 0, state: 'unknown' });
    });
    it('derives the cutover from the data, never a hardcoded date', () => {
        // Wipe every stamped chunk: nothing can be judged, so nothing claims to be.
        memDb.exec('DELETE FROM memory_chunks');
        conversation('capture:web:chatgpt:d', '2026-08-20 10:00:00', 900);
        expect(conversationYields(['capture:web:chatgpt:d'])['capture:web:chatgpt:d'].state).toBe('unknown');
        // And with stamping demonstrably older than the chat, the same chat is judged.
        memDb.prepare('INSERT INTO memory_chunks VALUES (?, ?, ?)').run('s', 'x:y', '2026-01-01 00:00:00');
        expect(conversationYields(['capture:web:chatgpt:d'])['capture:web:chatgpt:d'].state).toBe('none');
    });
    it('never claims anything about a conversation it cannot find', () => {
        expect(conversationYields(['nope:missing'])['nope:missing']).toEqual({ memories: 0, state: 'unknown' });
    });
    it('answers a batch in one pass and ignores junk input', () => {
        conversation('a:1', '2026-08-20 10:00:00', 900);
        chunks('a:1', 2);
        conversation('a:2', '2026-08-20 10:00:00', 901);
        const out = conversationYields(['a:1', 'a:2', '', null, 'a:1']);
        expect(Object.keys(out).sort()).toEqual(['a:1', 'a:2']);
        expect(out['a:1'].memories).toBe(2);
        expect(out['a:2'].state).toBe('none');
    });
    it('is empty for an empty request rather than scanning the corpus', () => {
        expect(conversationYields([])).toEqual({});
    });
});
