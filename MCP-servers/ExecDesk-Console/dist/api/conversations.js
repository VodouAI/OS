/**
 * Conversations API — browse past conversation sessions
 */
import { Router } from 'express';
import { getDb } from '../db.js';
export const conversationsRouter = Router();
// GET /api/conversations — list recent sessions
conversationsRouter.get('/', (req, res) => {
    try {
        const db = getDb();
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const offset = parseInt(req.query.offset) || 0;
        let sessions = [];
        let total = 0;
        try {
            const countRow = db.prepare('SELECT COUNT(*) as total FROM conversation_sessions').get();
            total = countRow?.total || 0;
            sessions = db.prepare(`SELECT session_id, start_time, end_time, total_interactions, session_type
         FROM conversation_sessions
         ORDER BY start_time DESC
         LIMIT ? OFFSET ?`).all(limit, offset);
        }
        catch {
            // Table may not exist
        }
        res.json({ sessions, total, offset, limit });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// GET /api/conversations/:id — full conversation with entries
conversationsRouter.get('/:id', (req, res) => {
    try {
        const db = getDb();
        const sessionId = req.params.id;
        let session = null;
        let entries = [];
        try {
            session = db.prepare('SELECT session_id, start_time, end_time, total_interactions, session_type FROM conversation_sessions WHERE session_id = ?').get(sessionId);
        }
        catch { }
        if (!session) {
            res.status(404).json({ error: 'Session not found' });
            return;
        }
        try {
            entries = db.prepare(`SELECT interaction_type, user_query, ai_response, tool_results, execution_time_ms, created_at
         FROM conversation_entries
         WHERE session_id = ?
         ORDER BY created_at ASC`).all(sessionId);
        }
        catch {
            // Table may not exist
        }
        res.json({ session, entries });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
