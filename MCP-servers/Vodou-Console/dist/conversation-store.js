/**
 * Conversation Persistence — SQLite-backed storage for chat history
 * Survives server restarts. Gateway owns its own DB (gateway.db).
 *
 * PLAN-CONTINUITY-PRIMITIVE Phase 1 — every gateway_messages INSERT carries
 * principal_id (the install-owner's principal). The id is read once from
 * vodou-core.db and cached in-process. External callers (npm channel
 * packages) use the HTTP endpoint POST /api/v2/channels/turns instead of
 * importing this module directly.
 */
import { getDb, getGatewayDb } from './db.js';
/**
 * Lazy-cached install-owner principal id. Read once from vodou-core.db on
 * first access. Returns null if the principal isn't seeded yet (pre-
 * `vodou-core continuity init`); the caller falls back to NULL principal_id
 * which is recovered later by the gateway_extractor backfill.
 */
let cachedSelfPrincipalId;
function getSelfPrincipalId() {
    if (cachedSelfPrincipalId !== undefined)
        return cachedSelfPrincipalId;
    try {
        const row = getDb()
            .prepare("SELECT id FROM principals WHERE is_self = 1 AND merged_into IS NULL LIMIT 1")
            .get();
        if (row?.id) {
            cachedSelfPrincipalId = row.id; // cache positive only — retry on miss
            return row.id;
        }
    }
    catch {
        // Table doesn't exist yet (pre-migration 068) or DB error — fall through
    }
    return null;
}
/**
 * Ensure a conversation exists in the DB
 */
export function ensureConversation(conversationId, title, source, senderName, projectId) {
    const db = getGatewayDb();
    const existing = db.prepare('SELECT id FROM gateway_conversations WHERE id = ?').get(conversationId);
    if (!existing) {
        const principalId = getSelfPrincipalId();
        // project_id set at creation only (NULL = Default project). An existing
        // conversation's project is never reassigned by a later message.
        db.prepare('INSERT INTO gateway_conversations (id, title, source, sender_name, principal_id, project_id) VALUES (?, ?, ?, ?, ?, ?)').run(conversationId, title || 'New Chat', source || 'web', senderName || null, principalId, projectId ?? null);
    }
    else if (source && source !== 'web') {
        // Update source/sender if not already set (first channel message tags it)
        db.prepare('UPDATE gateway_conversations SET source = ?, sender_name = COALESCE(sender_name, ?) WHERE id = ? AND (source IS NULL OR source = \'web\')').run(source, senderName ?? null, conversationId);
    }
    // Unified Slack workbench: refresh tab title + last speaker on every inbound message.
    if (conversationId === 'workbench:channel:slack' && source === 'slack' && senderName?.trim()) {
        const sn = senderName.trim();
        const t = ('Slack · ' + sn).substring(0, 120);
        db.prepare('UPDATE gateway_conversations SET title = ?, sender_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(t, sn, conversationId);
    }
}
/**
 * Save a message to the DB.
 *
 * PLAN-CONTINUITY-PRIMITIVE Phase 1 — every row gets principal_id populated
 * from the cached self-principal lookup. If the principal isn't seeded yet
 * (pre-`continuity init`), principal_id stays NULL and gets backfilled by
 * the gateway extractor's principal_id sync on the next extraction cycle
 * (no data loss; identical user-visible behavior).
 */
export function saveMessage(conversationId, role, content, senderLabel, skillName) {
    try {
        const db = getGatewayDb();
        ensureConversation(conversationId);
        const principalId = getSelfPrincipalId();
        const label = senderLabel && String(senderLabel).trim() ? String(senderLabel).trim().substring(0, 200) : null;
        // Phase 6: tag skill-emitted turns so the hydrator can strip them after uninstall.
        const skill = skillName && String(skillName).trim() ? String(skillName).trim().substring(0, 120) : null;
        db.prepare('INSERT INTO gateway_messages (conversation_id, role, content, principal_id, sender_label, skill_name) VALUES (?, ?, ?, ?, ?, ?)').run(conversationId, role, content, principalId, label, skill);
        db.prepare('UPDATE gateway_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(conversationId);
    }
    catch (e) {
        // P1-5: chat-history persistence failures were swallowed by ~20 empty
        // `catch {}` sites at the call sites (and un-wrapped calls could crash a
        // handler). Log centrally here so a gateway.db write error (locked, disk
        // full, schema drift) is never silent, then re-throw to preserve the
        // existing throw contract — callers that wrap keep swallowing, but the
        // failure is now visible in the log.
        console.error(`[conversation-store] saveMessage FAILED (conv=${conversationId} role=${role}): ${e.message}`);
        throw e;
    }
}
/**
 * Phase 6: mark all turns emitted by a (just-uninstalled) skill as excluded
 * from future LLM context. The rows stay in the DB for audit/transcript but
 * the conversation hydrator skips them when building the message array for
 * the next LLM call — so the model doesn't pattern-match against menus from
 * a skill that no longer exists.
 *
 * Returns the number of rows marked.
 */
export function excludeSkillMessagesFromContext(skillName, opts) {
    if (!skillName || !skillName.trim())
        return 0;
    const db = getGatewayDb();
    // First: clean exact-tag matches (forward-looking, where saveMessage tagged the row)
    const tagRes = db.prepare('UPDATE gateway_messages SET excluded_from_context = 1 WHERE skill_name = ? AND excluded_from_context = 0').run(skillName.trim());
    let total = Number(tagRes.changes ?? 0);
    // Optional retroactive cleanup: assistant turns whose content contains a
    // distinctive signature (e.g., the skill's stopping-point menu title).
    // This handles existing poisoned conversations where saveMessage didn't
    // tag the row because the schema hadn't shipped yet.
    if (opts?.contentPattern && opts.contentPattern.trim().length >= 4) {
        const pat = '%' + opts.contentPattern.trim().replace(/[%_]/g, (m) => '\\' + m) + '%';
        const sigRes = db.prepare("UPDATE gateway_messages SET excluded_from_context = 1, skill_name = COALESCE(skill_name, ?) WHERE role = 'assistant' AND excluded_from_context = 0 AND content LIKE ? ESCAPE '\\'").run(skillName.trim(), pat);
        total += Number(sigRes.changes ?? 0);
    }
    return total;
}
/**
 * Load messages for a conversation. By default skips messages tagged with a
 * skill that has since been uninstalled (excluded_from_context = 1). Pass
 * `includeExcluded: true` for transcript/audit views that need everything.
 */
export function loadMessages(conversationId, options) {
    const db = getGatewayDb();
    const where = options?.includeExcluded
        ? 'conversation_id = ?'
        : 'conversation_id = ? AND (excluded_from_context IS NULL OR excluded_from_context = 0)';
    return db.prepare(`SELECT id, conversation_id, role, content, created_at, sender_label FROM gateway_messages WHERE ${where} ORDER BY id ASC`).all(conversationId);
}
/**
 * Load all conversations (for listing/tabs).
 *
 * PLAN-UNIVERSAL-MEMORY Phase 0 — imported conversation corpora land in
 * gateway_conversations with `source = 'import:<src>'`. A multi-year ChatGPT
 * archive is thousands of conversations; surfacing them here would drown the
 * tab strip. Default-exclude them; the Imports UI (Phase 5) passes
 * `{ includeImports: true }` (or uses loadImportedConversations) when it wants them.
 */
export function loadConversations(opts) {
    const db = getGatewayDb();
    // Imports AND captures (capture:web:*, capture:ide:*) are raw memory-source
    // buffers, not chats — they belong in the Sources panel + Brain constellation,
    // not the conversation dock. Excluded by default; messaging channels, board,
    // skills, and real chats keep their normal source and stay. Opt back in for
    // surfaces that genuinely list capture rows.
    const importFilter = opts?.includeImports ? '' : " AND source NOT LIKE 'import:%'";
    const captureFilter = opts?.includeCaptures ? '' : " AND source NOT LIKE 'capture:%'";
    return db.prepare(`SELECT id, title, source, sender_name, created_at, updated_at, project_id FROM gateway_conversations WHERE deleted_at IS NULL${importFilter}${captureFilter} ORDER BY updated_at DESC`).all();
}
/**
 * PLAN-GATEWAY-PROJECTS — conversations belonging to a project. 'proj_default'
 * (or a null/empty id) also includes legacy conversations with project_id IS NULL.
 * Imported conversations are excluded by default (see loadConversations).
 */
export function loadConversationsByProject(projectId, opts) {
    const db = getGatewayDb();
    const isDefault = !projectId || projectId === 'proj_default';
    const importFilter = opts?.includeImports ? '' : " AND source NOT LIKE 'import:%'";
    // Captures are memory sources, not project chats — keep them out of every
    // project's conversation list (Sources/Brain own them). See loadConversations.
    const captureFilter = opts?.includeCaptures ? '' : " AND source NOT LIKE 'capture:%'";
    const where = (isDefault
        ? "deleted_at IS NULL AND (project_id IS NULL OR project_id = 'proj_default')"
        : 'deleted_at IS NULL AND project_id = ?') + importFilter + captureFilter;
    const stmt = db.prepare(`SELECT id, title, source, sender_name, created_at, updated_at, project_id FROM gateway_conversations WHERE ${where} ORDER BY updated_at DESC`);
    return (isDefault ? stmt.all() : stmt.all(projectId));
}
/**
 * PLAN-UNIVERSAL-MEMORY Phase 0 — list ONLY imported conversations, newest first,
 * for the Console "Imports" tab. `sourceFilter` narrows to one source
 * (e.g. 'chatgpt' → source = 'import:chatgpt'); omit for all imports.
 */
export function loadImportedConversations(sourceFilter) {
    const db = getGatewayDb();
    if (sourceFilter && sourceFilter.trim()) {
        return db.prepare('SELECT id, title, source, sender_name, created_at, updated_at, project_id FROM gateway_conversations WHERE deleted_at IS NULL AND source = ? ORDER BY updated_at DESC').all(`import:${sourceFilter.trim()}`);
    }
    return db.prepare("SELECT id, title, source, sender_name, created_at, updated_at, project_id FROM gateway_conversations WHERE deleted_at IS NULL AND source LIKE 'import:%' ORDER BY updated_at DESC").all();
}
/**
 * PLAN-UNIVERSAL-MEMORY — insert an imported message with an EXPLICIT created_at
 * (the imported turn's original timestamp), which the normal saveMessage() path
 * can't do because gateway_messages.created_at defaults to CURRENT_TIMESTAMP.
 * Used by the single-conversation capture lane (Phase 4); the bulk export lane
 * writes gateway.db directly from Rust. `conversationId` must already be an
 * `import:<source>:<orig-uuid>` id ensured via ensureImportedConversation().
 * FTS triggers fire on this INSERT automatically — no extra maintenance needed.
 */
export function saveImportedMessage(conversationId, role, content, createdAt, senderLabel) {
    const db = getGatewayDb();
    const principalId = getSelfPrincipalId();
    const label = senderLabel && String(senderLabel).trim() ? String(senderLabel).trim().substring(0, 200) : null;
    db.prepare('INSERT INTO gateway_messages (conversation_id, role, content, created_at, principal_id, sender_label) VALUES (?, ?, ?, ?, ?, ?)').run(conversationId, role, content, createdAt, principalId, label);
    db.prepare('UPDATE gateway_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(conversationId);
}
/**
 * PLAN-UNIVERSAL-MEMORY — ensure an imported conversation row exists with its
 * `import:<source>` provenance intact. Unlike ensureConversation(), this never
 * runs the "first channel message overwrites a 'web' row" dance — imported ids
 * are deterministic (`import:<source>:<orig-uuid>`) and never collide with web
 * conversations, so the source must be written verbatim and left alone.
 */
export function ensureImportedConversation(conversationId, source, title, projectId) {
    const db = getGatewayDb();
    const existing = db.prepare('SELECT id FROM gateway_conversations WHERE id = ?').get(conversationId);
    if (!existing) {
        const principalId = getSelfPrincipalId();
        db.prepare('INSERT INTO gateway_conversations (id, title, source, principal_id, project_id) VALUES (?, ?, ?, ?, ?)').run(conversationId, title || 'Imported chat', source, principalId, projectId ?? null);
    }
}
/**
 * Get a single conversation by ID
 */
export function getConversation(conversationId) {
    const db = getGatewayDb();
    return db.prepare('SELECT id, title, source, sender_name, created_at, updated_at, project_id FROM gateway_conversations WHERE id = ?').get(conversationId);
}
/**
 * Update conversation title
 */
export function updateConversationTitle(conversationId, title) {
    const db = getGatewayDb();
    db.prepare('UPDATE gateway_conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(title, conversationId);
}
/** Re-home a conversation under a project (PLAN-PROJECT-SCOPED-DOCK Phase 2).
 *  Used when a scheduled skill-console is created while a project is active so
 *  its dock tab follows that project. proj_default → NULL (the Default home). */
export function setConversationProject(conversationId, projectId) {
    const db = getGatewayDb();
    const pid = !projectId || projectId === 'proj_default' ? null : projectId;
    db.prepare('UPDATE gateway_conversations SET project_id = ? WHERE id = ?').run(pid, conversationId);
}
/**
 * Soft-delete a conversation (marks deleted_at, preserves data for recovery)
 */
export function deleteConversation(conversationId) {
    const db = getGatewayDb();
    db.prepare('UPDATE gateway_conversations SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(conversationId);
}
/**
 * Restore a soft-deleted conversation. Bumps updated_at so the conversation
 * passes the 7-day window the WS connect handler uses when hydrating tabs.
 */
export function restoreConversation(conversationId) {
    const db = getGatewayDb();
    db.prepare('UPDATE gateway_conversations SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(conversationId);
}
/**
 * Recently closed (soft-deleted) conversations, most recently closed first —
 * powers the tab strip's "Recently closed" restore menu.
 */
export function listRecentlyClosedConversations(limit = 20) {
    const db = getGatewayDb();
    return db.prepare('SELECT id, title, source, sender_name, created_at, updated_at, deleted_at FROM gateway_conversations WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ?').all(limit);
}
/**
 * Load the N most recent messages (paginated UI history only — NOT for LLM seeding).
 * LLM seeding: hydrateLlmConversationFromDb() calls loadMessages() when the in-memory manager is empty.
 */
export function loadRecentMessages(conversationId, limit) {
    const db = getGatewayDb();
    const rows = db.prepare('SELECT id, conversation_id, role, content, created_at, sender_label FROM gateway_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?').all(conversationId, limit);
    return rows.reverse(); // Restore chronological order
}
/** Messages strictly older than `beforeId` (by row id), chronological order — for paginated UI history */
export function loadMessagesOlderThan(conversationId, beforeId, limit) {
    const db = getGatewayDb();
    const rows = db.prepare(`SELECT id, conversation_id, role, content, created_at, sender_label FROM gateway_messages
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
/**
 * FTS5 search over this conversation's messages, strictly scoped by
 * conversation_id. Returns hits ranked by bm25 (lower = more relevant).
 * Requires Node 24 — FTS5 lives in the Node-bundled SQLite there.
 *
 * `query` is passed through to FTS5; the caller should pre-sanitize obvious
 * problem chars (parens, double quotes) or wrap a phrase in `"..."`. Empty
 * result is a valid signal — let the LLM see "no matches" and move on.
 */
/**
 * Sanitize a free-form query string for FTS5 MATCH. FTS5 treats `-`, `:`,
 * `*`, `^`, parens, and double quotes as special — passing claude's raw
 * query "narwhal-quasar-7783" will yield `no such column: quasar`. We:
 *   1. strip FTS5 metacharacters
 *   2. split on whitespace+punctuation into tokens
 *   3. drop tokens <2 chars, lowercase, cap at 8
 *   4. quote each token to escape any residual oddness and AND them
 */
export function sanitizeFtsQuery(raw) {
    const cleaned = raw
        .replace(/["()*^:]/g, ' ')
        .replace(/-/g, ' ')
        .toLowerCase();
    const tokens = cleaned.split(/[\s,;.!?]+/)
        .filter((t) => t.length >= 2)
        .slice(0, 8)
        .map((t) => `"${t}"`);
    return tokens.join(' ');
}
export function searchConversationMessages(conversationId, query, limit = 5) {
    if (!query || !query.trim())
        return [];
    const fts = sanitizeFtsQuery(query);
    if (!fts)
        return [];
    const db = getGatewayDb();
    const safeLimit = Math.min(Math.max(limit, 1), 25);
    try {
        const rows = db.prepare(`
      SELECT m.id, m.role, m.content, m.created_at, bm25(gateway_messages_fts) AS rank
        FROM gateway_messages_fts f
        JOIN gateway_messages m ON m.id = f.rowid
       WHERE f.content MATCH ?
         AND m.conversation_id = ?
       ORDER BY rank ASC
       LIMIT ?
    `).all(fts, conversationId, safeLimit);
        return rows;
    }
    catch (e) {
        console.error(`[convo-recall] FTS5 search failed (need Node 24): ${e.message}`);
        return [];
    }
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
