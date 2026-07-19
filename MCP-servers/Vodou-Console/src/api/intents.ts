/**
 * Intents API — CRUD for intent_mappings table
 */

import { Router, Request, Response } from 'express';
import { getDb } from '../db.js';

export const intentsRouter = Router();

// GET /api/intents — paginated list with optional filters
intentsRouter.get('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const offset = parseInt(req.query.offset as string) || 0;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const server = req.query.server as string;
    const search = req.query.search as string;

    let where = '';
    const params: any[] = [];

    if (server) {
      where += ' WHERE server_name = ?';
      params.push(server);
    }

    if (search) {
      where += where ? ' AND' : ' WHERE';
      where += ' (keyword LIKE ? OR tool_name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    const countRow = db.prepare(`SELECT COUNT(*) as total FROM intent_mappings${where}`).get(...params) as any;
    const total = countRow?.total || 0;

    const rows = db.prepare(
      `SELECT keyword, server_name, tool_name, priority, execution_type, requires_session, session_timeout, tool_parameters
       FROM intent_mappings${where}
       ORDER BY keyword ASC
       LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    // Get distinct server names for filter dropdown
    const servers = db.prepare(
      'SELECT DISTINCT server_name FROM intent_mappings ORDER BY server_name'
    ).all() as any[];

    res.json({
      intents: rows,
      total,
      offset,
      limit,
      servers: servers.map(s => s.server_name),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/intents — add new intent mapping
intentsRouter.post('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { keyword, server_name, tool_name, priority } = req.body;

    if (!keyword || !server_name) {
      res.status(400).json({ error: 'keyword and server_name are required' });
      return;
    }

    // Check for duplicate
    const existing = db.prepare('SELECT keyword FROM intent_mappings WHERE keyword = ?').get(keyword);
    if (existing) {
      res.status(409).json({ error: `Intent "${keyword}" already exists` });
      return;
    }

    db.prepare(
      `INSERT INTO intent_mappings (keyword, server_name, tool_name, priority)
       VALUES (?, ?, ?, ?)`
    ).run(keyword, server_name, tool_name || null, priority || 1);

    res.json({ success: true, keyword });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/intents/:keyword — update intent
intentsRouter.put('/:keyword', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { keyword } = req.params;
    const { server_name, tool_name, priority } = req.body;

    const existing = db.prepare('SELECT keyword FROM intent_mappings WHERE keyword = ?').get(keyword);
    if (!existing) {
      res.status(404).json({ error: `Intent "${keyword}" not found` });
      return;
    }

    const updates: string[] = [];
    const params: any[] = [];

    if (server_name !== undefined) { updates.push('server_name = ?'); params.push(server_name); }
    if (tool_name !== undefined) { updates.push('tool_name = ?'); params.push(tool_name); }
    if (priority !== undefined) { updates.push('priority = ?'); params.push(priority); }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    params.push(keyword);
    db.prepare(`UPDATE intent_mappings SET ${updates.join(', ')} WHERE keyword = ?`).run(...params);

    const updated = db.prepare('SELECT * FROM intent_mappings WHERE keyword = ?').get(keyword);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/intents/suggest — lightweight list of all keywords + skills for autocomplete
intentsRouter.get('/suggest', (req: Request, res: Response) => {
  try {
    const db = getDb();

    // Get all intent keywords with their server/tool info (deduplicated by keyword, highest priority wins)
    const intents = db.prepare(
      `SELECT keyword, server_name, tool_name, MAX(priority) as priority
       FROM intent_mappings
       GROUP BY keyword
       ORDER BY keyword`
    ).all() as { keyword: string; server_name: string; tool_name: string; priority: number }[];

    // Get active skills with names and descriptions
    const skills = db.prepare(
      `SELECT name, description FROM skills_registry WHERE is_active = 1 ORDER BY name`
    ).all() as { name: string; description: string }[];

    // Get active servers with their tool counts
    const servers = db.prepare(
      `SELECT s.name, s.health_status,
              (SELECT COUNT(*) FROM tools t WHERE t.server_id = s.id) as tool_count,
              (SELECT GROUP_CONCAT(t.name, ', ') FROM tools t WHERE t.server_id = s.id LIMIT 8) as tool_names
       FROM mcp_servers s WHERE s.active = 1 ORDER BY s.name`
    ).all() as { name: string; health_status: string; tool_count: number; tool_names: string }[];

    res.json({ intents, skills, servers });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/intents/tool-schema?server=X&tool=Y — get a tool's input schema
intentsRouter.get('/tool-schema', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const server = req.query.server as string;
    const tool = req.query.tool as string;

    if (!server || !tool) {
      res.status(400).json({ error: 'server and tool query params required' });
      return;
    }

    const row = db.prepare(
      `SELECT t.name, t.description, t.input_schema, s.name as server_name
       FROM tools t JOIN mcp_servers s ON t.server_id = s.id
       WHERE s.name = ? AND t.name = ?`
    ).get(server, tool) as any;

    if (!row) {
      res.status(404).json({ error: 'Tool not found' });
      return;
    }

    let schema = {};
    try { schema = JSON.parse(row.input_schema || '{}'); } catch {}

    res.json({
      tool: row.name,
      server: row.server_name,
      description: row.description,
      schema,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/intents/tools-by-server?server=X — get all tools for a server
intentsRouter.get('/tools-by-server', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const server = req.query.server as string;
    if (!server) {
      res.status(400).json({ error: 'server query param required' });
      return;
    }

    const rows = db.prepare(
      `SELECT t.name, t.description, t.input_schema
       FROM tools t JOIN mcp_servers s ON t.server_id = s.id
       WHERE s.name = ? ORDER BY t.name`
    ).all(server) as any[];

    res.json(rows.map(r => {
      let schema = {};
      try { schema = JSON.parse(r.input_schema || '{}'); } catch {}
      return { name: r.name, description: r.description, schema };
    }));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/intents/test — test intent routing for a phrase
intentsRouter.post('/test', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { query } = req.body;

    if (!query || typeof query !== 'string') {
      res.status(400).json({ error: 'query is required' });
      return;
    }

    const queryLower = query.toLowerCase();

    const allIntents = db.prepare(
      'SELECT keyword, server_name, tool_name, priority FROM intent_mappings ORDER BY priority DESC'
    ).all() as { keyword: string; server_name: string; tool_name: string; priority: number }[];

    const matches = allIntents.filter(i =>
      queryLower.includes(i.keyword.toLowerCase())
    );

    res.json({
      raw_query: query,
      matches: matches.map(m => ({
        keyword: m.keyword,
        server: m.server_name,
        tool: m.tool_name,
        priority: m.priority,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/intents/:keyword — remove intent
intentsRouter.delete('/:keyword', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { keyword } = req.params;

    const result = db.prepare('DELETE FROM intent_mappings WHERE keyword = ?').run(keyword);
    if (result.changes === 0) {
      res.status(404).json({ error: `Intent "${keyword}" not found` });
      return;
    }

    res.json({ success: true, deleted: keyword });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
