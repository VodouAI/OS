/**
 * MCP Servers API — list, detail, enable/disable, test, remove
 */

import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { getDb, getProjectRoot } from '../db.js';
import { freshEnv } from '../executor.js';
import path from 'path';
import crypto from 'crypto';
import http from 'http';

const router = Router();

// Sentinel for auto-generated intent rows. Distinguishes them from user-
// curated rows that may also happen to have a low priority. Auto-intents that
// cease to point at a real tool (because the MCP server's tool list shrank)
// are pruned on every populate run.
const AUTO_INTENT_PRIORITY = 40;

/**
 * Auto-populate "/<server> <tool>" intent mappings for every tool of a server,
 * AND prune any auto-intent rows that no longer point to a current tool.
 *
 * Idempotent. Pure-add for unchanged tool lists; pure-prune when a tool is
 * removed; mix when both happen on a re-connect.
 *
 *  - Inserts use INSERT OR IGNORE on the keyword PK — never overwrites
 *    user-curated rows.
 *  - Deletes ONLY target rows with `priority = AUTO_INTENT_PRIORITY` — never
 *    touches user-curated rows even if the tool name overlaps.
 *  - Deletes ONLY target rows whose tool_name is NOT in the current tools
 *    table for this server.
 *
 * Returns counts: { inserted, skipped, deleted, total }.
 */
function populateAutoIntents(serverName: string): {
  inserted: number;
  skipped: number;
  deleted: number;
  total: number;
} {
  const db = getDb();
  const server = db.prepare('SELECT id FROM mcp_servers WHERE name = ?').get(serverName) as
    | { id: number }
    | undefined;
  if (!server) return { inserted: 0, skipped: 0, deleted: 0, total: 0 };

  const tools = db
    .prepare('SELECT name FROM tools WHERE server_id = ?')
    .all(server.id) as Array<{ name: string }>;
  const currentToolNames = new Set(tools.map(t => t.name));

  // ── PRUNE: drop auto-intent rows for tools that no longer exist ────────
  // We only touch rows tagged with AUTO_INTENT_PRIORITY so user-curated rows
  // (priority 80+) for the same server stay intact even if their tool is now
  // missing — that's a different signal that the user might want to act on.
  let deleted = 0;
  const existingAuto = db
    .prepare(
      `SELECT keyword, tool_name FROM intent_mappings
        WHERE server_name = ? AND priority = ?`
    )
    .all(serverName, AUTO_INTENT_PRIORITY) as Array<{ keyword: string; tool_name: string | null }>;
  const deleteStmt = db.prepare(
    `DELETE FROM intent_mappings
      WHERE keyword = ? AND server_name = ? AND priority = ?`
  );
  for (const row of existingAuto) {
    if (!row.tool_name) continue;
    if (!currentToolNames.has(row.tool_name)) {
      const result = deleteStmt.run(row.keyword, serverName, AUTO_INTENT_PRIORITY);
      deleted += Number(result.changes);
    }
  }

  // ── INSERT: add keyword variants for every current tool ────────────────
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO intent_mappings (keyword, server_name, tool_name, priority)
     VALUES (?, ?, ?, ?)`
  );
  let inserted = 0;
  let skipped = 0;
  for (const t of tools) {
    const variants = [
      `${serverName} ${t.name}`,        // "google-calendar list-events"
      `${serverName}-${t.name}`,        // "google-calendar-list-events"
      `${serverName}.${t.name}`,        // "google-calendar.list-events" (MCP-style refs)
      `/${serverName} ${t.name}`,       // explicit slash form
    ];
    for (const kw of variants) {
      const result = insertStmt.run(kw, serverName, t.name, AUTO_INTENT_PRIORITY);
      if (result.changes > 0) inserted++;
      else skipped++;
    }
  }

  return { inserted, skipped, deleted, total: tools.length };
}

function worstServerHealth(servers: { active?: number; health_status?: string | null }[]): 'ok' | 'warn' | 'error' {
  let w: 'ok' | 'warn' | 'error' = 'ok';
  for (const s of servers) {
    if (!s.active) continue;
    const h = (s.health_status || '').toLowerCase();
    if (h === 'unhealthy' || h === 'failed' || h === 'error') w = 'error';
    else if (h && h !== 'healthy' && w !== 'error') w = 'warn';
  }
  return w;
}

// GET /api/servers — list all servers with tool counts + sidebar health summary
router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const servers = db.prepare(`
      SELECT
        s.id, s.name, s.command, s.args, s.active, s.health_status,
        s.description, s.connection_type, s.lifecycle_type,
        s.last_health_check, s.created_at,
        (SELECT COUNT(*) FROM tools t WHERE t.server_id = s.id) as tool_count,
        (SELECT COUNT(*) FROM intent_mappings im WHERE im.server_name = s.name) as intent_count
      FROM mcp_servers s
      ORDER BY s.active DESC, s.name
    `).all() as { active?: number; health_status?: string | null }[];

    res.json({
      servers,
      worst_server_health: worstServerHealth(servers),
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// POST /api/servers/refresh-health — run vodou-core health-check to update health_status for all servers
// POST /api/servers/populate-auto-intents — backfill intents for all existing servers
router.post('/populate-auto-intents', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const servers = db.prepare('SELECT name FROM mcp_servers WHERE active = 1').all() as Array<{ name: string }>;
    const results: Record<string, { inserted: number; skipped: number; deleted: number; total: number }> = {};
    let totalInserted = 0;
    let totalDeleted = 0;
    for (const s of servers) {
      try {
        results[s.name] = populateAutoIntents(s.name);
        totalInserted += results[s.name].inserted;
        totalDeleted += results[s.name].deleted;
      } catch (err) {
        console.error(`[populateAutoIntents] ${s.name}: failed —`, err);
      }
    }
    res.json({ success: true, totalInserted, totalDeleted, perServer: results });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/servers/:name/populate-auto-intents — backfill for one server
router.post('/:name/populate-auto-intents', (req: Request, res: Response) => {
  try {
    const result = populateAutoIntents(req.params.name);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/refresh-health', (req: Request, res: Response) => {
  const root = getProjectRoot();
  const bt4Path = path.join(root, 'vodou-core');
  const proc = spawn(bt4Path, ['health-check'], { cwd: root });
  let stderr = '';
  const timeoutMs = 60000;
  const timeoutId = setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch {}
  }, timeoutMs);
  const cleanup = () => {
    clearTimeout(timeoutId);
    try { proc.kill('SIGKILL'); } catch {}
  };
  req.on('close', cleanup);
  req.on('aborted', cleanup);
  proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
  proc.on('close', (code) => {
    clearTimeout(timeoutId);
    if (code === 0) {
      res.json({ ok: true, message: 'Health check complete' });
    } else {
      res.status(500).json({ ok: false, error: stderr.trim() || `health-check exited ${code}` });
    }
  });
  proc.on('error', (err) => {
    clearTimeout(timeoutId);
    res.status(500).json({ ok: false, error: err.message });
  });
});

// GET /api/servers/search — search MCP registry for servers
router.get('/search', async (req: Request, res: Response) => {
  const query = (req.query.q as string || '').trim();
  if (!query) {
    res.status(400).json({ error: 'q parameter is required' });
    return;
  }

  const limit = parseInt(req.query.limit as string || '10', 10);

  try {
    // Fetch directly from official MCP registry API
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    let allServers: any[] = [];

    // Use registry's search parameter for server-side filtering
    const url = `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(query)}`;
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`Registry returned ${resp.status}`);
    const data = await resp.json() as any;

    const servers = (data.servers || []) as any[];
    for (const entry of servers) {
      const srv = entry.server || entry;
      // Determine install type
      let install_type = 'manual';
      let install_method = 'Manual installation required';
      let remote_url: string | undefined;
      let environment_variables: any[] = [];

      if (srv.packages && srv.packages.length > 0) {
        const pkg = srv.packages[0];
        const regType = pkg.registryType || pkg.registry_type || '';
        if (regType === 'npm') {
          install_type = 'npm';
          install_method = `NPM: ${pkg.identifier}`;
        } else if (regType === 'pypi') {
          install_type = 'pypi';
          install_method = `PyPI: ${pkg.identifier}`;
        } else {
          install_type = regType || 'package';
          install_method = `${regType}: ${pkg.identifier}`;
        }
        // Collect env vars from all packages
        for (const p of srv.packages) {
          if (p.environmentVariables) {
            environment_variables.push(...p.environmentVariables);
          }
        }
      } else if (srv.remotes && srv.remotes.length > 0) {
        install_type = 'remote';
        remote_url = srv.remotes[0].url;
        install_method = `Remote: ${remote_url} (${srv.remotes[0].type || 'http'})`;
      } else if (srv.repository?.url) {
        install_type = 'git';
        install_method = `Git: ${srv.repository.url}`;
      }

      allServers.push({
        name: srv.name,
        description: srv.description || '',
        tags: [],
        rating: (srv as any).rating ?? 0,
        downloads: 0,
        install_method,
        install_type,
        remote_url,
        environment_variables,
        packages: srv.packages || [],
        repository: srv.repository || null,
      });
    }

    clearTimeout(timeout);

    // Deduplicate by name (keep latest version)
    const seen = new Map<string, any>();
    for (const s of allServers) {
      seen.set(s.name, s); // Last one wins (latest version)
    }
    const results = Array.from(seen.values()).slice(0, limit);

    res.json({ results, query });
  } catch (err: any) {
    const bt4Path = path.join(getProjectRoot(), 'vodou-core');
    const proc = spawn(bt4Path, ['search', query, '--limit', String(limit)], { cwd: getProjectRoot() });
    const SEARCH_TIMEOUT_MS = 30000;
    const killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
    }, SEARCH_TIMEOUT_MS);

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      clearTimeout(killTimer);
      const output = stdout + stderr;
      const results: any[] = [];
      const blocks = output.split(/(?=\d+\.\s+📦)/);
      for (const block of blocks) {
        const nameMatch = block.match(/\d+\.\s+📦\s+(.+)/);
        if (!nameMatch) continue;

        const descMatch = block.match(/📝\s+(.+)/);
        const tagsMatch = block.match(/🏷️\s+Tags:\s+(.+)/);
        const installMatch = block.match(/🔧\s+Install:\s+(.+)/);

        results.push({
          name: nameMatch[1].trim(),
          description: descMatch ? descMatch[1].trim() : '',
          tags: tagsMatch ? tagsMatch[1].trim().split(/,\s*/) : [],
          install_method: installMatch ? installMatch[1].trim() : 'unknown',
          install_type: 'unknown',
          environment_variables: [],
        });
      }

      res.json({ results, query });
    });

    proc.on('error', (err2) => {
      clearTimeout(killTimer);
      res.status(500).json({ error: err2.message });
    });
  }
});

// POST /api/servers/install — auto-install from registry
router.post('/install', (req: Request, res: Response) => {
  const { name, asName, install_type, remote_url, env } = req.body;
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  // Remote servers: save directly to DB as HTTP connection (no live connect attempt —
  // the server may require OAuth/auth that isn't configured yet)
  if (install_type === 'remote' && remote_url) {
    try {
      const db = getDb();
      // Derive a clean server name: "com.figma.mcp/mcp" → "figma"
      // Try domain-style first segment, then fall back to last segment
      let serverName = asName || name;
      if (!asName) {
        const parts = name.split('/');
        const domain = parts[0] || '';
        const domainParts = domain.split('.');
        // "com.figma.mcp" → pick the meaningful middle part (not com/io/org, not generic "mcp"/"server")
        const generic = new Set(['com', 'io', 'org', 'dev', 'ai', 'net', 'mcp', 'server', 'app']);
        const meaningful = domainParts.filter((p: string) => p.length > 1 && !generic.has(p.toLowerCase()));
        serverName = meaningful[0] || parts.pop() || name;
      }

      // Build connection config with transport hint
      const connectionConfig: any = {
        url: remote_url,
        transport: remote_url.includes('/sse') ? 'sse' : 'http',
      };

      // Store env vars in connection config if provided
      if (env && typeof env === 'object' && Object.keys(env).length > 0) {
        connectionConfig.environment = env;
      }

      // Upsert into mcp_servers (inactive until user enables + auth under Capabilities → Tools)
      db.prepare(`
        INSERT INTO mcp_servers (name, command, args, connection_type, connection_config, description, health_status, install_method, active)
        VALUES (?, ?, '[]', 'http', ?, ?, 'unknown', 'remote', 0)
        ON CONFLICT(name) DO UPDATE SET
          command = excluded.command,
          connection_type = excluded.connection_type,
          connection_config = excluded.connection_config,
          description = excluded.description,
          install_method = excluded.install_method
      `).run(serverName, remote_url, JSON.stringify(connectionConfig), name);

      res.json({ success: true, name: serverName, output: `Registered ${serverName} as HTTP remote server` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
    return;
  }

  // Strategy: try vodou-core install first (full wiring: connect, discover tools,
  // create intents, generate extractors). If it fails (name not in its registry),
  // fall back to npx registration for npm packages.

  const bt4Path = path.join(getProjectRoot(), 'vodou-core');
  const cliArgs = ['install', name];
  if (asName) cliArgs.push('--as-name', asName);

  const procEnv = { ...freshEnv() } as Record<string, string>;
  if (env && typeof env === 'object') {
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === 'string') procEnv[k] = v;
    }
  }

  const proc = spawn(bt4Path, cliArgs, { cwd: getProjectRoot(), env: procEnv });
  const INSTALL_TIMEOUT_MS = 120000;
  const killTimer = setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch {}
  }, INSTALL_TIMEOUT_MS);
  const cleanup = () => {
    clearTimeout(killTimer);
    try { proc.kill('SIGKILL'); } catch {}
  };
  req.on('close', cleanup);
  req.on('aborted', cleanup);

  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
  proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

  proc.on('close', (code) => {
    clearTimeout(killTimer);
    if (code === 0) {
      res.json({ success: true, name, output: stdout.trim() || stderr.trim() });
      return;
    }

    // vodou-core install failed — fall back to npx registration for npm packages
    if (install_type === 'npm') {
      try {
        const db = getDb();
        const serverName = asName || name.replace(/^@/, '').replace(/\//g, '-');

        db.prepare(`
          INSERT INTO mcp_servers (name, command, args, description, health_status, install_method, active)
          VALUES (?, 'npx', ?, ?, 'unknown', 'npm', 1)
          ON CONFLICT(name) DO UPDATE SET
            command = 'npx',
            args = excluded.args,
            description = excluded.description,
            install_method = 'npm',
            active = 1
        `).run(serverName, JSON.stringify(['--yes', name + '@latest']), name);

        // Store env vars if provided
        if (env && typeof env === 'object' && Object.keys(env).length > 0) {
          for (const [k, v] of Object.entries(env)) {
            if (typeof v === 'string') {
              db.prepare(`
                INSERT OR REPLACE INTO server_credentials (server_name, key, value)
                VALUES (?, ?, ?)
              `).run(serverName, k, v);
            }
          }
        }

        res.json({ success: true, name: serverName, output: `Registered ${serverName} (npx --yes ${name}@latest)` });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
      return;
    }

    // Not npm — report the failure
    res.status(500).json({
      error: `Install failed (exit ${code})`,
      output: stderr.trim() || stdout.trim(),
    });
  });

  proc.on('error', (err) => {
    clearTimeout(killTimer);
    res.status(500).json({ error: err.message });
  });
});

// POST /api/servers/scan — scan a GitHub repo for MCP server info
router.post('/scan', (req: Request, res: Response) => {
  const { url } = req.body;
  if (!url) {
    res.status(400).json({ error: 'url is required' });
    return;
  }

  const bt4Path = path.join(getProjectRoot(), 'vodou-core');
  const proc = spawn(bt4Path, ['scan', url, '--format', 'json'], { cwd: getProjectRoot() });
  const SCAN_TIMEOUT_MS = 60000;
  const killTimer = setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch {}
  }, SCAN_TIMEOUT_MS);
  const cleanup = () => {
    clearTimeout(killTimer);
    try { proc.kill('SIGKILL'); } catch {}
  };
  req.on('close', cleanup);
  req.on('aborted', cleanup);

  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
  proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

  proc.on('close', (code) => {
    clearTimeout(killTimer);
    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const scanResult = JSON.parse(jsonMatch[0]);
        res.json({ success: true, ...scanResult });
      } catch {
        res.json({ success: code === 0, output: stdout.trim() || stderr.trim() });
      }
    } else {
      res.json({ success: code === 0, output: stdout.trim() || stderr.trim() });
    }
  });

  proc.on('error', (err) => {
    clearTimeout(killTimer);
    res.status(500).json({ error: err.message });
  });
});

// GET /api/servers/:name/dependents — impact analysis for a server
router.get('/:name/dependents', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const serverName = req.params.name;

    const intents = db.prepare(
      'SELECT keyword, tool_name FROM intent_mappings WHERE server_name = ?'
    ).all(serverName) as { keyword: string; tool_name: string }[];

    const skills = db.prepare(
      "SELECT name FROM skills_registry WHERE is_active = 1 AND required_tools LIKE '%' || ? || '%'"
    ).all(serverName) as { name: string }[];

    const scheduledTasks = db.prepare(
      "SELECT name FROM scheduled_tasks WHERE payload LIKE '%' || ? || '%'"
    ).all(serverName) as { name: string }[];

    res.json({
      server: serverName,
      intents: intents.map(i => ({ keyword: i.keyword, tool: i.tool_name })),
      skills: skills.map(s => s.name),
      scheduled_tasks: scheduledTasks.map(t => t.name),
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// GET /api/servers/:name — server detail with tools and intents
router.get('/:name', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const server = db.prepare(`
      SELECT * FROM mcp_servers WHERE name = ?
    `).get(req.params.name) as any;

    if (!server) {
      res.status(404).json({ error: 'Server not found' });
      return;
    }

    const tools = db.prepare(`
      SELECT id, name, description, input_schema, timeout_seconds
      FROM tools WHERE server_id = ?
      ORDER BY name
    `).all(server.id);

    const intents = db.prepare(`
      SELECT keyword, tool_name, priority, tool_parameters
      FROM intent_mappings WHERE server_name = ?
      ORDER BY priority DESC, keyword
    `).all(req.params.name);

    // Skills that use this server
    const skills = db.prepare(`
      SELECT name, description, is_active
      FROM skills_registry
      WHERE required_tools LIKE ?
      ORDER BY name
    `).all(`%"${req.params.name}"%`);

    // Credentials (mask values for security)
    let credentials: any[] = [];
    try {
      credentials = db.prepare(`
        SELECT id, credential_type, env_var_name, header_name, header_format, source,
               CASE WHEN credential_value IS NOT NULL THEN '••••••••' ELSE NULL END as credential_value,
               created_at, updated_at, expires_at
        FROM server_credentials WHERE server_id = ?
        ORDER BY credential_type
      `).all(server.id);
    } catch { /* table may not exist */ }

    // OAuth config
    let oauth_config: any = null;
    try {
      oauth_config = db.prepare(`
        SELECT id, authorization_endpoint, token_endpoint,
               CASE WHEN client_id IS NOT NULL THEN '••••••••' ELSE NULL END as client_id,
               provider_name, created_at
        FROM oauth_configs WHERE server_id = ?
      `).get(server.id) || null;
    } catch { /* table may not exist */ }

    res.json({ ...server, tools, intents, skills, credentials, oauth_config });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// POST /api/servers/:name/enable
router.post('/:name/enable', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const result = db.prepare('UPDATE mcp_servers SET active = 1 WHERE name = ?').run(req.params.name);
    if (result.changes === 0) {
      res.status(404).json({ error: 'Server not found' });
      return;
    }
    res.json({ success: true, message: `${req.params.name} enabled` });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// POST /api/servers/:name/disable
router.post('/:name/disable', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const result = db.prepare('UPDATE mcp_servers SET active = 0 WHERE name = ?').run(req.params.name);
    if (result.changes === 0) {
      res.status(404).json({ error: 'Server not found' });
      return;
    }
    res.json({ success: true, message: `${req.params.name} disabled` });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// POST /api/servers/:name/test — run vodou-core test <name>
router.post('/:name/test', (req: Request, res: Response) => {
  const bt4Path = path.join(getProjectRoot(), 'vodou-core');
  const proc = spawn(bt4Path, ['test', req.params.name], { cwd: getProjectRoot() });

  let stdout = '';
  let stderr = '';
  let responded = false;
  const TEST_TIMEOUT_MS = 15000;
  const killTimer = setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch {}
    respond({
      success: false,
      output: 'Connection timed out (15s). Server may require authentication — check the Authentication panel.',
      exitCode: -1,
    });
  }, TEST_TIMEOUT_MS);
  const killChild = () => {
    try { proc.kill('SIGKILL'); } catch {}
  };
  req.on('close', () => { clearTimeout(killTimer); killChild(); });
  req.on('aborted', () => { clearTimeout(killTimer); killChild(); });

  const respond = (data: any) => {
    if (responded) return;
    responded = true;
    clearTimeout(killTimer);
    res.json(data);
  };

  proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
  proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

  proc.on('close', (code) => {
    respond({
      success: code === 0,
      output: stdout.trim() || stderr.trim(),
      exitCode: code,
    });
  });

  proc.on('error', (err) => {
    if (!responded) {
      responded = true;
      clearTimeout(killTimer);
      res.status(500).json({ error: err.message });
    }
  });
});

// POST /api/servers — add (connect) a new MCP server
router.post('/', (req: Request, res: Response) => {
  const { name, type, command, args, env, url, apiKey } = req.body;

  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const bt4Path = path.join(getProjectRoot(), 'vodou-core');
  let cliArgs: string[];

  if (type === 'http') {
    if (!url) {
      res.status(400).json({ error: 'url is required for HTTP servers' });
      return;
    }
    cliArgs = ['connect', name, '--url', url];
    if (apiKey) {
      cliArgs.push('--api-key', apiKey);
    }
  } else {
    // STDIO (default)
    if (!command) {
      res.status(400).json({ error: 'command is required for STDIO servers' });
      return;
    }
    cliArgs = ['connect', name, command];
    // Collect user args
    let userArgs: string[] = [];
    if (args && Array.isArray(args)) {
      userArgs = args;
    } else if (args && typeof args === 'string') {
      // Split space-separated args string
      userArgs = args.split(/\s+/).filter((a: string) => a);
    }
    // Inject `--` separator if any user arg starts with `-` so clap stops parsing them
    // as vodou-core flags (e.g., npx's `-y`). Avoid double-separator if the preset
    // author already included one.
    const needsSeparator = userArgs.some(a => a.startsWith('-')) && !userArgs.includes('--');
    if (needsSeparator) cliArgs.push('--');
    cliArgs.push(...userArgs);
  }

  // Build environment with any extra vars
  const procEnv = { ...freshEnv() } as Record<string, string>;
  if (env && typeof env === 'object') {
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === 'string') procEnv[k] = v;
    }
  }

  const proc = spawn(bt4Path, cliArgs, { cwd: getProjectRoot(), env: procEnv });
  let procExited = false;
  const CONNECT_TIMEOUT_MS = 60000;
  const killTimer = setTimeout(() => {
    if (!procExited) { try { proc.kill('SIGKILL'); } catch {} }
  }, CONNECT_TIMEOUT_MS);
  // Only kill on real client abort — req.on('close') fires too eagerly in
  // modern Node (after body consumption) and would SIGKILL a still-running
  // connect process, surfacing as a spurious 500 with `exit null`.
  req.on('aborted', () => {
    clearTimeout(killTimer);
    if (!procExited) { try { proc.kill('SIGKILL'); } catch {} }
  });

  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
  proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

  proc.on('close', (code) => {
    procExited = true;
    clearTimeout(killTimer);
    if (code === 0) {
      // Auto-populate "/<server> <tool>" intent mappings for the new server.
      // Failure here must NOT break the connect response — log + continue.
      let autoIntents: { inserted: number; skipped: number; deleted: number; total: number } | null = null;
      try {
        autoIntents = populateAutoIntents(name);
        console.error(
          `[populateAutoIntents] ${name}: +${autoIntents.inserted} inserted, ` +
          `${autoIntents.skipped} skipped, -${autoIntents.deleted} pruned ` +
          `(${autoIntents.total} tools current)`
        );
      } catch (err) {
        console.error(`[populateAutoIntents] ${name}: failed —`, err);
      }
      res.json({
        success: true,
        name,
        output: stdout.trim() || stderr.trim(),
        autoIntents,
      });
    } else {
      res.status(500).json({
        error: `Connect failed (exit ${code})`,
        output: stderr.trim() || stdout.trim(),
      });
    }
  });

  proc.on('error', (err) => {
    procExited = true;
    clearTimeout(killTimer);
    res.status(500).json({ error: err.message });
  });
});

// DELETE /api/servers/:name — remove server with full cleanup
router.delete('/:name', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const serverName = req.params.name;
    const server = db.prepare('SELECT id FROM mcp_servers WHERE name = ?').get(serverName) as any;
    if (!server) {
      res.status(404).json({ error: 'Server not found' });
      return;
    }

    // Cascade: remove tools, intents, parameter_rules, id_mappings
    const toolsDeleted = db.prepare('DELETE FROM tools WHERE server_id = ?').run(server.id).changes;
    const intentsDeleted = db.prepare('DELETE FROM intent_mappings WHERE server_name = ?').run(serverName).changes;
    const rulesDeleted = db.prepare('DELETE FROM parameter_rules WHERE server_name = ?').run(serverName).changes;
    const idMappingsDeleted = db.prepare('DELETE FROM id_mappings WHERE server_name = ?').run(serverName).changes;
    db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(server.id);

    // Clean extractors.toml entries for this server
    let extractorsRemoved = 0;
    try {
      const extractorsPath = path.join(getProjectRoot(), 'extractors.toml');
      const content = readFileSync(extractorsPath, 'utf-8');
      const prefix = `"${serverName}::`;
      const lines = content.split('\n');
      const filtered = lines.filter(line => !line.trimStart().startsWith(prefix));
      extractorsRemoved = lines.length - filtered.length;
      if (extractorsRemoved > 0) {
        writeFileSync(extractorsPath, filtered.join('\n'), 'utf-8');
      }
    } catch { /* extractors.toml may not exist — that's fine */ }

    // Check for skills that reference this server (warn, don't delete)
    const warnings: string[] = [];
    try {
      const skills = db.prepare(
        "SELECT name FROM skills_registry WHERE is_active = 1 AND required_tools LIKE '%' || ? || '%'"
      ).all(serverName) as { name: string }[];
      for (const s of skills) {
        warnings.push(`Skill '${s.name}' references this server in required_tools`);
      }
    } catch { /* skills_registry may not exist */ }

    res.json({
      success: true,
      message: `${serverName} removed`,
      cleaned: {
        tools: toolsDeleted,
        intents: intentsDeleted,
        parameterRules: rulesDeleted,
        idMappings: idMappingsDeleted,
        extractors: extractorsRemoved,
      },
      warnings,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// GET /api/servers/:name/credentials — list credentials for a server
router.get('/:name/credentials', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT id FROM mcp_servers WHERE name = ?').get(req.params.name) as any;
    if (!server) { res.status(404).json({ error: 'Server not found' }); return; }

    const credentials = db.prepare(`
      SELECT id, credential_type, env_var_name, header_name, header_format, source,
             CASE WHEN credential_value IS NOT NULL THEN '••••••••' ELSE NULL END as credential_value,
             created_at, updated_at, expires_at
      FROM server_credentials WHERE server_id = ?
      ORDER BY credential_type
    `).all(server.id);

    res.json(credentials);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// POST /api/servers/:name/credentials — add or update a credential
router.post('/:name/credentials', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT id FROM mcp_servers WHERE name = ?').get(req.params.name) as any;
    if (!server) { res.status(404).json({ error: 'Server not found' }); return; }

    const { credential_type, credential_value, env_var_name, header_name, header_format, source } = req.body;
    if (!credential_type) {
      res.status(400).json({ error: 'credential_type is required' });
      return;
    }

    // Defaults per credential type
    const defaults: Record<string, { header: string; format: string }> = {
      api_key: { header: 'X-API-Key', format: '{token}' },
      bearer_token: { header: 'Authorization', format: 'Bearer {token}' },
      oauth_access_token: { header: 'Authorization', format: 'Bearer {token}' },
      env_var: { header: 'X-API-Key', format: '{token}' },
    };
    const def = defaults[credential_type] || { header: 'Authorization', format: '{token}' };

    db.prepare(`
      INSERT INTO server_credentials (server_id, credential_type, credential_value, env_var_name, header_name, header_format, source, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(server_id, credential_type) DO UPDATE SET
        credential_value = excluded.credential_value,
        env_var_name = excluded.env_var_name,
        header_name = excluded.header_name,
        header_format = excluded.header_format,
        source = excluded.source,
        updated_at = datetime('now')
    `).run(
      server.id,
      credential_type,
      credential_value || null,
      env_var_name || null,
      header_name || def.header,
      header_format || def.format,
      source || (env_var_name ? 'env' : 'database'),
    );

    res.json({ success: true, message: `Credential ${credential_type} saved` });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// DELETE /api/servers/:name/credentials/:type — remove a credential
router.delete('/:name/credentials/:type', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT id FROM mcp_servers WHERE name = ?').get(req.params.name) as any;
    if (!server) { res.status(404).json({ error: 'Server not found' }); return; }

    const result = db.prepare('DELETE FROM server_credentials WHERE server_id = ? AND credential_type = ?')
      .run(server.id, req.params.type);

    if (result.changes === 0) {
      res.status(404).json({ error: 'Credential not found' });
      return;
    }
    res.json({ success: true, message: `Credential ${req.params.type} removed` });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// POST /api/servers/:name/oauth — save OAuth config (client ID + secret)
router.post('/:name/oauth', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT id, name FROM mcp_servers WHERE name = ?').get(req.params.name) as any;
    if (!server) { res.status(404).json({ error: 'Server not found' }); return; }

    const { client_id, client_secret, authorization_endpoint, token_endpoint, redirect_uri, scope } = req.body;
    if (!client_id || !client_secret) {
      res.status(400).json({ error: 'client_id and client_secret are required' });
      return;
    }

    db.prepare(`
      INSERT INTO oauth_configs (server_id, client_id, client_secret, authorization_endpoint, token_endpoint, redirect_uri, scope, provider_name, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(server_id) DO UPDATE SET
        client_id = excluded.client_id,
        client_secret = excluded.client_secret,
        authorization_endpoint = excluded.authorization_endpoint,
        token_endpoint = excluded.token_endpoint,
        redirect_uri = excluded.redirect_uri,
        scope = excluded.scope,
        updated_at = datetime('now')
    `).run(
      server.id,
      client_id,
      client_secret,
      authorization_endpoint || '',
      token_endpoint || '',
      redirect_uri || 'http://localhost:8080/callback',
      scope || null,
      server.name,
    );

    res.json({ success: true, message: 'OAuth config saved' });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// POST /api/servers/:name/oauth/authorize — full OAuth flow in Node.js (no CLI dependency)
router.post('/:name/oauth/authorize', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT id, name FROM mcp_servers WHERE name = ?').get(req.params.name) as any;
    if (!server) { res.status(404).json({ error: 'Server not found' }); return; }

    const oauthConfig = db.prepare('SELECT * FROM oauth_configs WHERE server_id = ?').get(server.id) as any;
    if (!oauthConfig || !oauthConfig.client_id) {
      res.status(400).json({ error: 'No OAuth config found. Save Client ID and Secret first.' });
      return;
    }

    if (!oauthConfig.authorization_endpoint || !oauthConfig.token_endpoint) {
      res.status(400).json({ error: 'OAuth endpoints not configured. Set authorization and token URLs.' });
      return;
    }

    // Generate PKCE code verifier and challenge (RFC 7636)
    const codeVerifier = crypto.randomBytes(64).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');

    // Use the redirect_uri from OAuth config (must match what's registered in the provider's app).
    // Fall back to finding an available port if no redirect_uri is configured.
    const configuredRedirect = oauthConfig.redirect_uri || '';
    let redirectUri: string;
    let callbackPort: number;

    if (configuredRedirect && configuredRedirect.includes('localhost')) {
      // Extract port from configured redirect URI
      const redirectUrl = new URL(configuredRedirect);
      callbackPort = parseInt(redirectUrl.port, 10) || 8080;
      redirectUri = configuredRedirect;
    } else {
      // No configured redirect — find an available port
      callbackPort = await new Promise<number>((resolve, reject) => {
        const srv = http.createServer();
        srv.listen(0, '127.0.0.1', () => {
          const addr = srv.address() as any;
          srv.close(() => resolve(addr.port));
        });
        srv.on('error', reject);
      });
      redirectUri = `http://localhost:${callbackPort}/callback`;
    }

    // Build authorization URL
    const authParams = new URLSearchParams({
      response_type: 'code',
      client_id: oauthConfig.client_id,
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    // Allow request body to override scope (e.g., when PRM-discovered scope is invalid)
    const effectiveScope = req.body.scope || oauthConfig.scope;
    if (effectiveScope) authParams.set('scope', effectiveScope);
    const authUrl = `${oauthConfig.authorization_endpoint}?${authParams.toString()}`;

    // Start local callback server and wait for the authorization code
    const codePromise = new Promise<string>((resolve, reject) => {
      const callbackServer = http.createServer((req2, res2) => {
        const url = new URL(req2.url || '', `http://localhost:${callbackPort}`);
        if (url.pathname !== '/callback') {
          res2.writeHead(404);
          res2.end('Not found');
          return;
        }

        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          res2.writeHead(200, { 'Content-Type': 'text/html' });
          res2.end('<html><body><h2>Authorization Failed</h2><p>' + error + '</p><p>You can close this tab.</p></body></html>');
          callbackServer.close();
          reject(new Error('OAuth error: ' + error));
          return;
        }

        if (returnedState !== state) {
          res2.writeHead(400, { 'Content-Type': 'text/html' });
          res2.end('<html><body><h2>Invalid State</h2><p>CSRF validation failed.</p></body></html>');
          callbackServer.close();
          reject(new Error('CSRF state mismatch'));
          return;
        }

        if (!code) {
          res2.writeHead(400, { 'Content-Type': 'text/html' });
          res2.end('<html><body><h2>No Code</h2><p>No authorization code received.</p></body></html>');
          callbackServer.close();
          reject(new Error('No authorization code'));
          return;
        }

        res2.writeHead(200, { 'Content-Type': 'text/html' });
        res2.end('<html><body style="font-family:system-ui;text-align:center;padding:60px;"><h2>✅ Authorized!</h2><p>You can close this tab and return to Vodou.</p></body></html>');
        callbackServer.close();
        resolve(code);
      });

      callbackServer.listen(callbackPort, '127.0.0.1');

      // 5-minute timeout
      setTimeout(() => {
        callbackServer.close();
        reject(new Error('Timed out waiting for authorization (5 min)'));
      }, 300000);
    });

    // Open the browser
    const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(openCmd, [authUrl], { detached: true, stdio: 'ignore' }).unref();

    // Wait for the authorization code
    const code = await codePromise;

    // Exchange code for tokens
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: oauthConfig.client_id,
      client_secret: oauthConfig.client_secret,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });

    const tokenResp = await fetch(oauthConfig.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString(),
    });

    if (!tokenResp.ok) {
      const errText = await tokenResp.text();
      res.json({ success: false, error: `Token exchange failed (${tokenResp.status}): ${errText}` });
      return;
    }

    const tokens = await tokenResp.json() as any;
    const accessToken = tokens.access_token;
    const refreshToken = tokens.refresh_token;
    const expiresIn = tokens.expires_in;

    if (!accessToken) {
      res.json({ success: false, error: 'No access_token in response' });
      return;
    }

    // Store access token
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;
    db.prepare(`
      INSERT INTO server_credentials (server_id, credential_type, credential_value, header_name, header_format, source, expires_at, updated_at)
      VALUES (?, 'oauth_access_token', ?, 'Authorization', 'Bearer {token}', 'oauth', ?, datetime('now'))
      ON CONFLICT(server_id, credential_type) DO UPDATE SET
        credential_value = excluded.credential_value,
        header_name = excluded.header_name,
        header_format = excluded.header_format,
        source = excluded.source,
        expires_at = excluded.expires_at,
        updated_at = datetime('now')
    `).run(server.id, accessToken, expiresAt);

    // Store refresh token if provided
    if (refreshToken) {
      db.prepare(`
        INSERT INTO server_credentials (server_id, credential_type, credential_value, source, updated_at)
        VALUES (?, 'oauth_refresh_token', ?, 'oauth', datetime('now'))
        ON CONFLICT(server_id, credential_type) DO UPDATE SET
          credential_value = excluded.credential_value,
          updated_at = datetime('now')
      `).run(server.id, refreshToken);
    }

    res.json({ success: true, output: 'Authorization complete! Access token saved.' });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

// DELETE /api/servers/:name/oauth — remove OAuth config
router.delete('/:name/oauth', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT id FROM mcp_servers WHERE name = ?').get(req.params.name) as any;
    if (!server) { res.status(404).json({ error: 'Server not found' }); return; }

    const result = db.prepare('DELETE FROM oauth_configs WHERE server_id = ?').run(server.id);
    if (result.changes === 0) {
      res.status(404).json({ error: 'No OAuth config found' });
      return;
    }
    res.json({ success: true, message: 'OAuth config removed' });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

export { router as serversRouter };
