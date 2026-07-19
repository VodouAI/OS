/**
 * Memory API — browse, read, edit, search memory markdown files
 */

import { sockConnectTarget } from '../cli-portability.js';
import { Router, Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import net from 'net';
import { DatabaseSync } from 'node:sqlite';
import type { DB } from '../db.js';
import { getProjectRoot, getMemoryDb } from '../db.js';

const router = Router();

const WORKSPACE_DIR = '.vodou/workspace';
const DAILY_DIR = '.vodou/workspace/memory';

/**
 * Validate that a relative path resolves safely under allowed directories.
 * Returns the absolute path or null if invalid.
 */
function validateMemoryPath(relPath: string): string | null {
  if (!relPath || typeof relPath !== 'string') return null;
  if (!relPath.endsWith('.md')) return null;

  const root = getProjectRoot();
  const workspaceAbs = path.resolve(root, WORKSPACE_DIR);
  const resolved = path.resolve(root, relPath);

  // Must be a real subpath of .vodou/workspace/
  if (!resolved.startsWith(workspaceAbs + path.sep) && resolved !== workspaceAbs) {
    return null;
  }

  return resolved;
}

interface TreeNode {
  id: string;
  topic: string;
  direction?: 'right' | 'left';
  children?: TreeNode[];
  file_path?: string;
  file_type?: string;
  file_line?: number;
}

/**
 * Parse ## and ### headings from markdown content
 */
function parseHeadings(content: string): Array<{ level: number; text: string; line: number }> {
  const headings: Array<{ level: number; text: string; line: number }> = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m2 = lines[i].match(/^##\s+(.+)/);
    if (m2) {
      headings.push({ level: 2, text: m2[1].trim(), line: i + 1 });
      continue;
    }
    const m3 = lines[i].match(/^###\s+(.+)/);
    if (m3) {
      headings.push({ level: 3, text: m3[1].trim(), line: i + 1 });
    }
  }
  return headings;
}

// GET /api/memory/tree — build jsMind-compatible tree
router.get('/tree', async (req: Request, res: Response) => {
  try {
    const root = getProjectRoot();
    const workspacePath = path.join(root, WORKSPACE_DIR);
    const dailyPath = path.join(root, DAILY_DIR);

    const rootNode: TreeNode = {
      id: 'root',
      topic: 'Vodou Memory',
      children: [],
    };

    // --- Workspace files (branch right) ---
    const workspaceBranch: TreeNode = {
      id: 'workspace',
      topic: 'Workspace Files',
      direction: 'right',
      children: [],
    };

    try {
      const entries = await fs.readdir(workspacePath, { withFileTypes: true });
      const mdFiles = entries
        .filter(e => e.isFile() && e.name.endsWith('.md'))
        .sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of mdFiles) {
        const relPath = path.join(WORKSPACE_DIR, entry.name);
        const absPath = path.join(workspacePath, entry.name);
        const fileNode: TreeNode = {
          id: `ws_${entry.name}`,
          topic: entry.name.replace(/\.md$/, ''),
          file_path: relPath, file_type: 'workspace',
          children: [],
        };

        try {
          const content = await fs.readFile(absPath, 'utf-8');
          const headings = parseHeadings(content);

          let lastH2: TreeNode | null = null;
          for (const h of headings) {
            const hNode: TreeNode = {
              id: `ws_${entry.name}_h${h.line}`,
              topic: h.text,
              file_path: relPath, file_type: 'workspace', file_line: h.line,
            };
            if (h.level === 2) {
              hNode.children = [];
              lastH2 = hNode;
              fileNode.children!.push(hNode);
            } else if (h.level === 3 && lastH2) {
              lastH2.children!.push(hNode);
            } else {
              fileNode.children!.push(hNode);
            }
          }
        } catch {
          // skip unreadable files
        }

        workspaceBranch.children!.push(fileNode);
      }
    } catch {
      // workspace dir may not exist
    }

    rootNode.children!.push(workspaceBranch);

    // --- Daily logs (branch left) ---
    const dailyBranch: TreeNode = {
      id: 'daily',
      topic: 'Daily Logs',
      direction: 'left',
      children: [],
    };

    try {
      const entries = await fs.readdir(dailyPath, { withFileTypes: true });
      const dailyFiles = entries
        .filter(e => e.isFile() && e.name.endsWith('.md'))
        .sort((a, b) => b.name.localeCompare(a.name)); // newest first

      for (const entry of dailyFiles) {
        const relPath = path.join(DAILY_DIR, entry.name);
        const absPath = path.join(dailyPath, entry.name);
        const fileNode: TreeNode = {
          id: `dl_${entry.name}`,
          topic: entry.name.replace(/\.md$/, ''),
          file_path: relPath, file_type: 'daily',
          children: [],
        };

        try {
          const content = await fs.readFile(absPath, 'utf-8');
          const headings = parseHeadings(content);

          let lastH2: TreeNode | null = null;
          for (const h of headings) {
            const hNode: TreeNode = {
              id: `dl_${entry.name}_h${h.line}`,
              topic: h.text,
              file_path: relPath, file_type: 'daily', file_line: h.line,
            };
            if (h.level === 2) {
              hNode.children = [];
              lastH2 = hNode;
              fileNode.children!.push(hNode);
            } else if (h.level === 3 && lastH2) {
              lastH2.children!.push(hNode);
            } else {
              fileNode.children!.push(hNode);
            }
          }
        } catch {
          // skip unreadable
        }

        dailyBranch.children!.push(fileNode);
      }
    } catch {
      // daily dir may not exist
    }

    rootNode.children!.push(dailyBranch);

    res.json(rootNode);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// GET /api/memory/file?path=<rel> — read file content
router.get('/file', async (req: Request, res: Response) => {
  try {
    const relPath = req.query.path as string;
    const absPath = validateMemoryPath(relPath);
    if (!absPath) {
      res.status(403).json({ error: 'Invalid or disallowed path' });
      return;
    }

    // Verify resolved path is truly under workspace
    const realAbs = await fs.realpath(absPath);
    const workspaceReal = await fs.realpath(path.join(getProjectRoot(), WORKSPACE_DIR));
    if (!realAbs.startsWith(workspaceReal + path.sep) && realAbs !== workspaceReal) {
      res.status(403).json({ error: 'Path traversal blocked' });
      return;
    }

    const content = await fs.readFile(absPath, 'utf-8');
    res.type('text/plain').send(content);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// PUT /api/memory/file?path=<rel> — save edited content (with .bak backup)
router.put('/file', async (req: Request, res: Response) => {
  try {
    const relPath = req.query.path as string;
    const absPath = validateMemoryPath(relPath);
    if (!absPath) {
      res.status(403).json({ error: 'Invalid or disallowed path' });
      return;
    }

    const realAbs = await fs.realpath(absPath);
    const workspaceReal = await fs.realpath(path.join(getProjectRoot(), WORKSPACE_DIR));
    if (!realAbs.startsWith(workspaceReal + path.sep) && realAbs !== workspaceReal) {
      res.status(403).json({ error: 'Path traversal blocked' });
      return;
    }

    const content = typeof req.body === 'string' ? req.body : (req.body?.content ?? '');

    // Create .bak backup
    try {
      const existing = await fs.readFile(absPath, 'utf-8');
      await fs.writeFile(absPath + '.bak', existing, 'utf-8');
    } catch {
      // no existing file to backup
    }

    await fs.writeFile(absPath, content, 'utf-8');
    res.json({ ok: true, message: 'Saved' });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// GET /api/memory/search?q=<term> — full-text search across memory files
router.get('/search', async (req: Request, res: Response) => {
  try {
    const query = (req.query.q as string || '').trim();
    if (!query) {
      res.json([]);
      return;
    }

    const root = getProjectRoot();
    const workspacePath = path.join(root, WORKSPACE_DIR);
    const queryLower = query.toLowerCase();

    const results: Array<{
      path: string;
      type: string;
      file: string;
      line: number;
      text: string;
      heading: string;
    }> = [];

    async function searchDir(dir: string, type: string, relBase: string) {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            await searchDir(
              path.join(dir, entry.name),
              entry.name === 'memory' ? 'daily' : type,
              path.join(relBase, entry.name)
            );
            continue;
          }
          if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

          const filePath = path.join(dir, entry.name);
          const relPath = path.join(relBase, entry.name);

          try {
            const content = await fs.readFile(filePath, 'utf-8');
            const lines = content.split('\n');
            let currentHeading = '';

            for (let i = 0; i < lines.length; i++) {
              const headingMatch = lines[i].match(/^#{1,3}\s+(.+)/);
              if (headingMatch) {
                currentHeading = headingMatch[1].trim();
              }

              if (lines[i].toLowerCase().includes(queryLower)) {
                results.push({
                  path: relPath,
                  type,
                  file: entry.name,
                  line: i + 1,
                  text: lines[i].trim().substring(0, 200),
                  heading: currentHeading,
                });
              }
            }
          } catch {
            // skip unreadable
          }
        }
      } catch {
        // dir doesn't exist
      }
    }

    await searchDir(workspacePath, 'workspace', WORKSPACE_DIR);

    // Cap results
    res.json(results.slice(0, 100));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// GET /api/memory/timeline — daily logs with highlights for timeline view
router.get('/timeline', async (req: Request, res: Response) => {
  try {
    const root = getProjectRoot();
    const dailyPath = path.join(root, DAILY_DIR);
    const workspacePath = path.join(root, WORKSPACE_DIR);

    const days: Array<{
      date: string;
      path: string;
      size: number;
      headings: string[];
      highlights: string[];
      lineCount: number;
    }> = [];

    // Daily logs — strict YYYY-MM-DD.md filter. Janitor reports moved to
    // .vodou/workspace/janitor/ in v0.5.86, so the previous janitor-*.md
    // contamination is gone for fresh installs. This regex remains as a
    // backstop against future stray files (.bak files, archived folder names,
    // etc.) — the frontend builds the date label by parsing the filename as
    // a Date, and anything off-format renders "Invalid Date, Invalid Date".
    const DAILY_FILENAME = /^\d{4}-\d{2}-\d{2}\.md$/;
    try {
      const entries = await fs.readdir(dailyPath, { withFileTypes: true });
      const dailyFiles = entries
        .filter(e => e.isFile() && DAILY_FILENAME.test(e.name))
        .sort((a, b) => b.name.localeCompare(a.name));

      for (const entry of dailyFiles) {
        const absPath = path.join(dailyPath, entry.name);
        const relPath = path.join(DAILY_DIR, entry.name);
        try {
          const content = await fs.readFile(absPath, 'utf-8');
          const lines = content.split('\n');
          const stat = await fs.stat(absPath);
          const headings: string[] = [];
          const highlights: string[] = [];

          for (const line of lines) {
            const hMatch = line.match(/^##\s+(.+)/);
            if (hMatch) headings.push(hMatch[1].trim());

            // Extract bullet highlights (first 8 meaningful bullets)
            if (highlights.length < 8) {
              const bMatch = line.match(/^[-*]\s+(.{10,})/);
              if (bMatch) {
                highlights.push(bMatch[1].trim().substring(0, 160));
              }
            }
          }

          days.push({
            date: entry.name.replace(/\.md$/, ''),
            path: relPath,
            size: stat.size,
            headings,
            highlights,
            lineCount: lines.length,
          });
        } catch {
          // skip
        }
      }
    } catch {
      // no daily dir
    }

    // Workspace file summaries (not timeline entries, but context)
    const workspaceFiles: Array<{ name: string; path: string; size: number; modified: string }> = [];
    try {
      const entries = await fs.readdir(workspacePath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const absPath = path.join(workspacePath, entry.name);
        try {
          const stat = await fs.stat(absPath);
          workspaceFiles.push({
            name: entry.name,
            path: path.join(WORKSPACE_DIR, entry.name),
            size: stat.size,
            modified: stat.mtime.toISOString(),
          });
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }

    res.json({ days, workspaceFiles });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// POST /api/memory — pin content to today's daily log
router.post('/', async (req: Request, res: Response) => {
  try {
    const { content, source } = req.body;
    if (!content || typeof content !== 'string') {
      res.status(400).json({ error: 'content is required' });
      return;
    }

    const root = getProjectRoot();
    const dailyPath = path.join(root, DAILY_DIR);

    // Ensure daily directory exists
    await fs.mkdir(dailyPath, { recursive: true });

    // Today's log file
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const filePath = path.join(dailyPath, `${today}.md`);

    // Build the pin entry
    const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const entry = `\n\n## Pinned (${time})\n\n${content.trim()}\n`;

    // Append to today's log (creates if doesn't exist)
    await fs.appendFile(filePath, entry, 'utf-8');

    console.error(`[Memory] Pinned ${content.length} chars to ${filePath}`);
    res.json({ ok: true, path: filePath, date: today });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// ---------------------------------------------------------------------------
// Phase B (PLAN-UNIFIED-SCOPED-CONVERSATIONS) — scope-aware DB views
// ---------------------------------------------------------------------------

// GET /api/memory/scopes — distinct scopes present in memory_chunks (with counts)
router.get('/scopes', async (_req: Request, res: Response) => {
  try {
    const db = getMemoryDb();
    if (!db) { res.json([]); return; }
    const rows = db.prepare(
      "SELECT COALESCE(scope, 'web') AS scope, COUNT(*) AS count " +
      "FROM memory_chunks " +
      "WHERE archived = 0 OR archived IS NULL " +
      "GROUP BY COALESCE(scope, 'web') " +
      "ORDER BY count DESC"
    ).all();
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// GET /api/memory/chunks?scope=<raw>&limit=<n> — recent memory chunks filtered by scope
// Used by Memory page filter and Skills page per-persona "what does this agent remember?" panel.
router.get('/chunks', async (req: Request, res: Response) => {
  try {
    const db = getMemoryDb();
    if (!db) { res.json([]); return; }
    const scope = (req.query.scope as string || '').trim();
    const limit = Math.max(1, Math.min(100, parseInt((req.query.limit as string) || '20', 10) || 20));

    let sql = "SELECT id, path, text, COALESCE(scope, 'web') AS scope, chunk_tag, created_at, COALESCE(pinned, 0) AS pinned " +
              "FROM memory_chunks " +
              "WHERE (archived = 0 OR archived IS NULL) " +
              "AND text NOT LIKE '[SUPERSEDED]%' " +
              "AND text NOT LIKE '- [SUPERSEDED]%' ";
    const params: any[] = [];
    if (scope && scope !== 'all') {
      sql += "AND COALESCE(scope, 'web') = ? ";
      params.push(scope);
    }
    sql += "ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    const rows = db.prepare(sql).all(...params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// PLAN-MEMORY-VISIBILITY-UI Phase E (upgrade) — persistent pin toggle.
// Real pins set memory_chunks.pinned = 1; search.rs adds a +VODOU_MEMORY_PIN_BOOST
// (default 1.0) bonus so pinned chunks always surface on relevant queries.
// memory.db is opened read-only by getMemoryDb(); we use a short-lived RW handle.
function withWriteableMemoryDb<T>(fn: (db: DB) => T): T | null {
  const memPath = path.join(getProjectRoot(), 'memory.db');
  const db = new DatabaseSync(memPath, { timeout: 5000 });
  try {
    return fn(db);
  } finally {
    try { db.close(); } catch { /* noop */ }
  }
}

// chunk_id contains slashes (e.g. `memory/2026-04-28.md:169:abc123`) so we use a
// query param instead of a path param — Express only matches one path segment per :id.
// Path: POST /api/memory/pin?id=<chunk_id>   |   DELETE /api/memory/pin?id=<chunk_id>
router.post('/pin', (req: Request, res: Response) => {
  try {
    const id = (req.query.id as string || '').trim();
    if (!id) { res.status(400).json({ error: 'missing ?id query param' }); return; }
    const result = withWriteableMemoryDb((db) => {
      const r = db.prepare("UPDATE memory_chunks SET pinned = 1 WHERE id = ?").run(id);
      return { changes: r.changes };
    });
    if (!result || result.changes === 0) {
      res.status(404).json({ error: 'chunk not found', id });
      return;
    }
    res.json({ ok: true, id, pinned: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.delete('/pin', (req: Request, res: Response) => {
  try {
    const id = (req.query.id as string || '').trim();
    if (!id) { res.status(400).json({ error: 'missing ?id query param' }); return; }
    const result = withWriteableMemoryDb((db) => {
      const r = db.prepare("UPDATE memory_chunks SET pinned = 0 WHERE id = ?").run(id);
      return { changes: r.changes };
    });
    if (!result || result.changes === 0) {
      res.status(404).json({ error: 'chunk not found', id });
      return;
    }
    res.json({ ok: true, id, pinned: false });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// GET /api/memory/pinned — list all pinned chunks (for a future "Pinned" tab).
router.get('/pinned', (_req: Request, res: Response) => {
  try {
    const db = getMemoryDb();
    if (!db) { res.json([]); return; }
    const rows = db.prepare(
      "SELECT id, path, text, COALESCE(scope, 'web') AS scope, chunk_tag, created_at, pinned " +
      "FROM memory_chunks WHERE pinned = 1 ORDER BY created_at DESC"
    ).all();
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// PLAN-MEMORY-VISIBILITY-UI Phase B.1 — live ranked chunk search.
// Hits the daemon socket `cmd:'search'` so the Memory page UI can run the
// FULL ranking pipeline (vector + FTS + RRF + scope boost + reranker + tag bias)
// per keystroke, with score_breakdown attached to each result.
function callDaemonSearch(query: string, scope: string | null, top_k: number, fast: boolean = true): Promise<any> {
  const sockPath = path.join(getProjectRoot(), '.vodou', 'daemon.sock');
  const payload: any = { query, top_k, fast };
  if (scope) payload.scope = scope;
  const request = JSON.stringify({ cmd: 'search', payload }) + '\n';

  return new Promise((resolve) => {
    const c = net.createConnection({ path: sockConnectTarget(sockPath) }, () => {
      c.write(request);
      c.end();
    });
    c.setTimeout(5000);
    let data = '';
    c.on('data', (b) => { data += b.toString(); });
    c.on('end', () => {
      try {
        const resp = JSON.parse(data.trim());
        resolve(resp?.data?.results ?? []);
      } catch {
        resolve([]);
      }
    });
    c.on('error', () => resolve([]));
    c.on('timeout', () => { try { c.destroy(); } catch { /* noop */ } resolve([]); });
  });
}

router.get('/search-chunks', async (req: Request, res: Response) => {
  try {
    const q = ((req.query.q as string) || '').trim();
    if (!q) { res.json({ results: [] }); return; }
    const scope = ((req.query.scope as string) || '').trim() || null;
    const top_k = Math.max(1, Math.min(50, parseInt((req.query.top_k as string) || '10', 10) || 10));
    const tagFilter = ((req.query.tag as string) || '').trim().toUpperCase() || null;
    const since = ((req.query.since as string) || '').trim() || null; // ISO date

    let results: any[] = await callDaemonSearch(q, scope, top_k);

    // Cheap in-process post-filter for tag and date — small result set (≤50).
    if (tagFilter) {
      const wanted = tagFilter.split(',').map(t => t.trim()).filter(Boolean);
      results = results.filter(r => r.chunk_tag && wanted.includes(String(r.chunk_tag).toUpperCase()));
    }
    if (since) {
      results = results.filter(r => (r.created_at || '') >= since);
    }
    res.json({ query: q, scope, results });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// PLAN-RESEARCH-MEMORY-TAG §99.1 — tag-distribution telemetry.
// GET /api/memory/tag-distribution?days=7 — counts per chunk_tag over a window.
// Used by the Memory page UI to surface drift (e.g. [RESEARCH] catch-all overuse).
router.get('/tag-distribution', async (req: Request, res: Response) => {
  try {
    const db = getMemoryDb();
    if (!db) { res.json({ days: 0, total: 0, tags: [] }); return; }
    const days = Math.max(1, Math.min(365, parseInt((req.query.days as string) || '7', 10) || 7));
    const rows = db.prepare(
      "SELECT COALESCE(chunk_tag, 'UNTAGGED') AS tag, COUNT(*) AS count " +
      "FROM memory_chunks " +
      "WHERE (archived = 0 OR archived IS NULL) " +
      "AND text NOT LIKE '[SUPERSEDED]%' " +
      "AND text NOT LIKE '- [SUPERSEDED]%' " +
      "AND created_at >= datetime('now', ?) " +
      "GROUP BY COALESCE(chunk_tag, 'UNTAGGED') " +
      "ORDER BY count DESC"
    ).all(`-${days} days`) as Array<{ tag: string; count: number }>;
    const total = rows.reduce((s, r) => s + r.count, 0);
    const tags = rows.map(r => ({
      tag: r.tag,
      count: r.count,
      pct: total > 0 ? Math.round((r.count / total) * 1000) / 10 : 0,
    }));
    res.json({ days, total, tags });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

export { router as memoryRouter };
