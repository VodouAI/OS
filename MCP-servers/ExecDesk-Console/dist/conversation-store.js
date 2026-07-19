/**
 * Conversation Persistence — SQLite-backed storage for chat history
 * Survives server restarts. Gateway owns its own DB (gateway.db).
 */
import { getGatewayDb } from './db.js';
/**
 * Ensure a conversation exists in the DB
 */
export function ensureConversation(conversationId, title, source, senderName) {
    const db = getGatewayDb();
    const existing = db.prepare('SELECT id FROM gateway_conversations WHERE id = ?').get(conversationId);
    if (!existing) {
        db.prepare('INSERT INTO gateway_conversations (id, title, source, sender_name) VALUES (?, ?, ?, ?)').run(conversationId, title || 'New Chat', source || 'web', senderName || null);
    }
    else if (source && source !== 'web') {
        // Update source/sender if not already set (first channel message tags it)
        db.prepare('UPDATE gateway_conversations SET source = ?, sender_name = COALESCE(sender_name, ?) WHERE id = ? AND (source IS NULL OR source = \'web\')').run(source, senderName ?? null, conversationId);
    }
}
/**
 * Save a message to the DB
 */
export function saveMessage(conversationId, role, content) {
    const db = getGatewayDb();
    ensureConversation(conversationId);
    db.prepare('INSERT INTO gateway_messages (conversation_id, role, content) VALUES (?, ?, ?)').run(conversationId, role, content);
    db.prepare('UPDATE gateway_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(conversationId);
}
/**
 * Load messages for a conversation
 */
export function loadMessages(conversationId) {
    const db = getGatewayDb();
    return db.prepare('SELECT id, conversation_id, role, content, created_at FROM gateway_messages WHERE conversation_id = ? ORDER BY id ASC').all(conversationId);
}
/**
 * Load all conversations (for listing/tabs)
 */
export function loadConversations() {
    const db = getGatewayDb();
    return db.prepare('SELECT id, title, source, sender_name, created_at, updated_at FROM gateway_conversations WHERE deleted_at IS NULL ORDER BY updated_at DESC').all();
}
/**
 * Get a single conversation by ID
 */
export function getConversation(conversationId) {
    const db = getGatewayDb();
    return db.prepare('SELECT id, title, source, sender_name, created_at, updated_at FROM gateway_conversations WHERE id = ?').get(conversationId);
}
/**
 * Update conversation title
 */
export function updateConversationTitle(conversationId, title) {
    const db = getGatewayDb();
    db.prepare('UPDATE gateway_conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(title, conversationId);
}
/**
 * Soft-delete a conversation (marks deleted_at, preserves data for recovery)
 */
export function deleteConversation(conversationId) {
    const db = getGatewayDb();
    db.prepare('UPDATE gateway_conversations SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(conversationId);
}
/**
 * Load the N most recent messages (paginated UI history only — NOT for LLM seeding).
 * Full-thread read: loadMessages(). llm.ts does not call either; the LLM uses the in-memory
 * ConversationManager built as turns run. (Vodou-Console cold-starts that manager from
 * gateway.db via hydrateLlmConversationFromDb → loadMessages.)
 */
export function loadRecentMessages(conversationId, limit) {
    const db = getGatewayDb();
    const rows = db.prepare('SELECT id, conversation_id, role, content, created_at FROM gateway_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?').all(conversationId, limit);
    return rows.reverse(); // Restore chronological order
}
/** Messages strictly older than `beforeId` (by row id), chronological order — for paginated UI history */
export function loadMessagesOlderThan(conversationId, beforeId, limit) {
    const db = getGatewayDb();
    const rows = db.prepare(`SELECT id, conversation_id, role, content, created_at FROM gateway_messages
     WHERE conversation_id = ? AND id < ?
     ORDER BY id DESC LIMIT ?`).all(conversationId, beforeId, limit);
    return rows.reverse();
}
export function hasMessagesOlderThan(conversationId, oldestLoadedId) {
    const db = getGatewayDb();
    const row = db.prepare('SELECT 1 as x FROM gateway_messages WHERE conversation_id = ? AND id < ? LIMIT 1').get(conversationId, oldestLoadedId);
    return !!row;
}
/**
 * Get message count for a conversation
 */
export function getMessageCount(conversationId) {
    const db = getGatewayDb();
    const row = db.prepare('SELECT COUNT(*) as count FROM gateway_messages WHERE conversation_id = ?').get(conversationId);
    return row?.count || 0;
}
// --- Skill State Persistence ---
const MAX_VODOU_CONTEXT_SIZE = 20_000; // 20KB cap for stored Vodou context
/**
 * Save active skill state for a conversation (upsert)
 */
export function saveSkillState(conversationId, skillName, oiContext, loadedAt) {
    const db = getGatewayDb();
    const cappedContext = oiContext && oiContext.length > MAX_VODOU_CONTEXT_SIZE
        ? oiContext.substring(0, MAX_VODOU_CONTEXT_SIZE)
        : oiContext;
    db.prepare(`INSERT INTO gateway_skill_state (conversation_id, skill_name, oi_context, loaded_at, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(conversation_id) DO UPDATE SET
       skill_name = excluded.skill_name,
       oi_context = excluded.oi_context,
       loaded_at = excluded.loaded_at,
       updated_at = CURRENT_TIMESTAMP`).run(conversationId, skillName, cappedContext, loadedAt);
}
/**
 * Load skill state for a conversation (returns null if none or expired)
 */
export function loadSkillState(conversationId) {
    const db = getGatewayDb();
    const row = db.prepare('SELECT skill_name, oi_context, loaded_at FROM gateway_skill_state WHERE conversation_id = ?').get(conversationId);
    if (!row)
        return null;
    // Expire if older than 30 minutes
    if (Date.now() - row.loaded_at > 1_800_000) {
        clearSkillState(conversationId);
        return null;
    }
    return row;
}
/**
 * Clear skill state for a conversation
 */
export function clearSkillState(conversationId) {
    const db = getGatewayDb();
    db.prepare('DELETE FROM gateway_skill_state WHERE conversation_id = ?').run(conversationId);
}
