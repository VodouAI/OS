/**
 * Route API — query intent routing without full chat overhead
 *
 * Part of the Orchestration API (PLAN-12).
 * Lightweight endpoint to see what tools/skills a query would match
 * without triggering a full BrainLoader chat response.
 */

import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { getDb, getProjectRoot } from '../db.js';
import { freshEnv } from '../executor.js';

const router = Router();

const VC_PATH = () => process.env.VC_PATH || process.env.BT4_PATH || path.join(getProjectRoot(), 'vodou-core');
const ROUTE_TIMEOUT = 15000; // 15s — routing should be fast

/**
 * POST /api/route — Route a query to matching tools/skills
 *
 * Body: { query: string }
 * Response: { matched: boolean, type: 'tools'|'skill'|'none', matches: [...], raw_output: string }
 */
router.post('/', async (req: Request, res: Response) => {
  const { query } = req.body;

  if (!query) {
    res.status(400).json({ error: 'query is required' });
    return;
  }

  const startTime = Date.now();

  try {
    const result = await routeQuery(query);
    res.json({
      ...result,
      duration_ms: Date.now() - startTime,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
      duration_ms: Date.now() - startTime,
    });
  }
});

/**
 * GET /api/route/intents — List all intent mappings (useful for debugging routing)
 *
 * Query params:
 *   ?server=name   — filter by server
 *   ?search=term   — search trigger phrases
 */
router.get('/intents', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const serverFilter = req.query.server as string | undefined;
    const search = req.query.search as string | undefined;

    let query = `
      SELECT im.keyword, im.server_name, im.tool_name,
             im.priority, im.execution_type
      FROM intent_mappings im
      WHERE 1=1
    `;
    const params: string[] = [];

    if (serverFilter) {
      query += ' AND im.server_name = ?';
      params.push(serverFilter);
    }

    if (search) {
      query += ' AND im.keyword LIKE ?';
      params.push(`%${search}%`);
    }

    query += ' ORDER BY im.priority DESC, im.server_name, im.tool_name';

    const intents = db.prepare(query).all(...params);
    res.json({
      count: intents.length,
      intents,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/**
 * Run vodou-core brain "query" and parse the output into structured matches
 */
function routeQuery(query: string): Promise<{
  matched: boolean;
  type: 'tools' | 'skill' | 'none';
  matches: Array<{ server: string; tool: string }>;
  skill?: string;
  raw_output: string;
}> {
  return new Promise((resolve) => {
    const proc = spawn(VC_PATH(), ['brain', query], {
      cwd: getProjectRoot(),
      env: freshEnv(),
      timeout: ROUTE_TIMEOUT,
      killSignal: 'SIGKILL',
    });

    let stdout = '';
    let stderr = '';

    const timeoutId = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      resolve({ matched: false, type: 'none', matches: [], raw_output: 'Routing timed out' });
    }, ROUTE_TIMEOUT);

    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      const output = stdout.trim();

      if (!output) {
        resolve({ matched: false, type: 'none', matches: [], raw_output: stderr || '' });
        return;
      }

      // Check for skill match: "SKILL: skill-name" or "SKILL:skill-name"
      const skillMatch = output.match(/SKILL:\s*(\S+)/);
      if (skillMatch) {
        resolve({
          matched: true,
          type: 'skill',
          matches: [],
          skill: skillMatch[1],
          raw_output: output,
        });
        return;
      }

      // Parse tool matches from various output formats:
      // - "server::tool_name" format (BrainLoader routing lines)
      // - "Called tool 'X' on server 'Y'" format (execution log lines)
      // - "Orchestrated Execution Complete" (parallel execution happened)
      const toolMatches: Array<{ server: string; tool: string }> = [];

      for (const line of output.split('\n')) {
        // Format: server::tool_name
        const colonMatch = line.match(/([A-Za-z0-9_-]+)::([A-Za-z0-9_-]+)/);
        if (colonMatch) {
          const pair = { server: colonMatch[1], tool: colonMatch[2] };
          if (!toolMatches.some(m => m.server === pair.server && m.tool === pair.tool)) {
            toolMatches.push(pair);
          }
        }
        // Format: Called tool 'X' on server 'Y'
        const callMatch = line.match(/Called tool '([^']+)' on server '([^']+)'/);
        if (callMatch) {
          const pair = { server: callMatch[2], tool: callMatch[1] };
          if (!toolMatches.some(m => m.server === pair.server && m.tool === pair.tool)) {
            toolMatches.push(pair);
          }
        }
      }

      // Also detect orchestrated execution
      const orchestrated = output.includes('Orchestrated Execution Complete') ||
                           output.includes('orchestrated steps');

      if (toolMatches.length > 0 || orchestrated) {
        resolve({
          matched: true,
          type: 'tools',
          matches: toolMatches,
          raw_output: output,
        });
        return;
      }

      resolve({ matched: false, type: 'none', matches: [], raw_output: output });
    });

    proc.on('error', () => {
      clearTimeout(timeoutId);
      resolve({ matched: false, type: 'none', matches: [], raw_output: 'vodou-core not available' });
    });
  });
}

export { router as routeRouter };
