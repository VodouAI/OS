/**
 * A conversation that is being WRITTEN TO is not a deleted conversation.
 *
 * `ensureConversation` read `SELECT id` alone, so a soft-deleted row counted as
 * existing and every writer appended to the tombstone. Nothing could see it —
 * every list query and `vodou-core hosts` filter `deleted_at IS NULL`.
 *
 * Measured 2026-08-30 against the live gateway.db: **29,432 messages written
 * into conversations AFTER they were deleted** (claude-code-hook 19,192, cli
 * 7,408, telegram 725, slack 427), including the conversation in the open tab,
 * deleted 2026-05-21 and used continuously since.
 *
 * Runs against an IN-MEMORY database, not the real gateway.db. The other tests
 * in this suite write to the live 217 MB file; a test for a data-integrity bug
 * must not be a writer to the data it is reasoning about.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE gateway_conversations (
    id TEXT PRIMARY KEY, title TEXT, source TEXT, sender_name TEXT,
    principal_id TEXT, project_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME
  );
`);
vi.mock('../db.js', () => ({ getGatewayDb: () => db }));
vi.mock('../continuity.js', () => ({ getSelfPrincipal: () => null }));
const { ensureConversation, ensureImportedConversation, deleteConversation } = await import('../conversation-store.js');
const row = (id) => db.prepare('SELECT id, deleted_at FROM gateway_conversations WHERE id = ?').get(id);
describe('a tombstoned conversation that keeps receiving messages', () => {
    beforeEach(() => db.exec('DELETE FROM gateway_conversations'));
    it('is restored when written to again — the exact live case', () => {
        ensureConversation('workbench:channel:slack', 'Slack', 'slack', 'someone');
        deleteConversation('workbench:channel:slack');
        expect(row('workbench:channel:slack').deleted_at).toBeTruthy();
        // The next inbound Slack message. Before the fix this appended silently.
        ensureConversation('workbench:channel:slack', 'Slack', 'slack', 'someone');
        expect(row('workbench:channel:slack').deleted_at).toBeNull();
    });
    // The open tab was `source='web'` and soft-deleted 2026-05-21. An earlier
    // draft of the fix only revived non-web sources and would have missed it.
    it('applies to a plain web conversation too, not just channels', () => {
        ensureConversation('conv-1779068229014-3bph8h', 'Chat');
        deleteConversation('conv-1779068229014-3bph8h');
        ensureConversation('conv-1779068229014-3bph8h', 'Chat');
        expect(row('conv-1779068229014-3bph8h').deleted_at).toBeNull();
    });
    it('leaves a deleted conversation deleted when nothing writes to it', () => {
        ensureConversation('conv-quiet', 'Chat');
        deleteConversation('conv-quiet');
        expect(row('conv-quiet').deleted_at).toBeTruthy();
    });
    // The SECOND writer of this table. Latent when found — zero `import:%` rows
    // had messages after their delete — but a guard in one producer is not a
    // rule, and the other producer had 29,432 messages behind it.
    it('applies to the import writer too, which had the identical shape', () => {
        ensureImportedConversation('import:chatgpt:abc', 'import:chatgpt', 'Old chat');
        deleteConversation('import:chatgpt:abc');
        expect(row('import:chatgpt:abc').deleted_at).toBeTruthy();
        ensureImportedConversation('import:chatgpt:abc', 'import:chatgpt', 'Old chat');
        expect(row('import:chatgpt:abc').deleted_at).toBeNull();
    });
    it('does not disturb a live conversation', () => {
        ensureConversation('conv-live', 'Chat');
        ensureConversation('conv-live', 'Chat');
        expect(row('conv-live').deleted_at).toBeNull();
    });
});
