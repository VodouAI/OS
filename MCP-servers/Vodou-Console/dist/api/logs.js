/**
 * Logs API — read-only access to work_logs
 */
import { Router } from 'express';
import { getDb } from '../db.js';
export const logsRouter = Router();
// GET /api/logs — paginated, filterable
logsRouter.get('/', (req, res) => {
    try {
        const db = getDb();
        const offset = parseInt(req.query.offset) || 0;
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const category = req.query.category;
        const search = req.query.search;
        // `exclude=tool_call,installation` — the History tab hides the two
        // categories that are 9 of every 10 rows so the scheduled runs show.
        // Server-side so the count and the pages agree with what is on screen.
        const exclude = String(req.query.exclude || '')
            .split(',').map((c) => c.trim()).filter(Boolean).slice(0, 20);
        let where = '';
        const params = [];
        if (category) {
            where += ' WHERE category = ?';
            params.push(category);
        }
        else if (exclude.length) {
            where += ` WHERE category NOT IN (${exclude.map(() => '?').join(',')})`;
            params.push(...exclude);
        }
        if (search) {
            where += where ? ' AND' : ' WHERE';
            where += ' message LIKE ?';
            params.push(`%${search}%`);
        }
        const countRow = db.prepare(`SELECT COUNT(*) as total FROM work_logs${where}`).get(...params);
        const total = countRow?.total || 0;
        const rows = db.prepare(`SELECT id, timestamp, message, category, source, agent_type, session_id, metadata
       FROM work_logs${where}
       ORDER BY timestamp DESC
       LIMIT ? OFFSET ?`).all(...params, limit, offset);
        // Get distinct categories for filter
        const categories = db.prepare('SELECT DISTINCT category FROM work_logs ORDER BY category').all();
        res.json({
            logs: rows,
            total,
            offset,
            limit,
            categories: categories.map(c => c.category),
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
