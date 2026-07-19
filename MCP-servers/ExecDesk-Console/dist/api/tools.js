/**
 * Tools API — execute MCP tools and discover available tools/schemas
 *
 * Part of the Orchestration API (PLAN-12).
 * Wraps vodou-core CLI commands via executor.ts spawning pattern.
 */
import { Router } from 'express';
import path from 'path';
import { getDb, getProjectRoot } from '../db.js';
import { runVodouCore } from '../executor.js';
const router = Router();
const VC_PATH = () => process.env.VC_PATH || process.env.BT4_PATH || path.join(getProjectRoot(), 'vodou-core');
const TIMEOUT = parseInt(process.env.TOOL_TIMEOUT || '120000', 10);
/**
 * POST /api/tools/call — Execute a specific MCP tool
 *
 * Body: { server: string, tool: string, args?: object }
 * Response: { success, result, duration_ms, error? }
 */
router.post('/call', async (req, res) => {
    const { server, tool, args } = req.body;
    if (!server || !tool) {
        res.status(400).json({ error: 'server and tool are required' });
        return;
    }
    const startTime = Date.now();
    try {
        const result = await runVodouCore(server, tool, args || {});
        res.json({
            success: true,
            result,
            duration_ms: Date.now() - startTime,
        });
    }
    catch (error) {
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
            duration_ms: Date.now() - startTime,
        });
    }
});
/**
 * GET /api/tools — List all tools across all servers
 *
 * Query params:
 *   ?server=name    — filter by server
 *   ?search=term    — search tool names/descriptions
 */
router.get('/', (req, res) => {
    try {
        const db = getDb();
        const serverFilter = req.query.server;
        const search = req.query.search;
        let query = `
      SELECT
        t.name, t.description, t.input_schema,
        s.name as server_name, s.health_status as server_health
      FROM tools t
      JOIN mcp_servers s ON t.server_id = s.id
      WHERE COALESCE(s.active, 1) != 0
    `;
        const params = [];
        if (serverFilter) {
            query += ' AND s.name = ?';
            params.push(serverFilter);
        }
        if (search) {
            query += ' AND (t.name LIKE ? OR t.description LIKE ?)';
            params.push(`%${search}%`, `%${search}%`);
        }
        query += ' ORDER BY s.name, t.name';
        const tools = db.prepare(query).all(...params);
        res.json({
            count: tools.length,
            tools: tools.map(t => ({
                name: t.name,
                description: t.description,
                server: t.server_name,
                server_health: t.server_health,
                input_schema: t.input_schema ? JSON.parse(t.input_schema) : null,
            })),
        });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
/**
 * GET /api/tools/:toolName/schema — Get JSON Schema for a specific tool
 */
router.get('/:toolName/schema', (req, res) => {
    try {
        const db = getDb();
        const toolName = req.params.toolName;
        const tool = db.prepare(`
      SELECT t.name, t.description, t.input_schema, s.name as server_name
      FROM tools t
      JOIN mcp_servers s ON t.server_id = s.id
      WHERE t.name = ? AND COALESCE(s.active, 1) != 0
      LIMIT 1
    `).get(toolName);
        if (!tool) {
            res.status(404).json({ error: `Tool '${toolName}' not found` });
            return;
        }
        res.json({
            name: tool.name,
            description: tool.description,
            server: tool.server_name,
            input_schema: tool.input_schema ? JSON.parse(tool.input_schema) : null,
        });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
export { router as toolsRouter };
