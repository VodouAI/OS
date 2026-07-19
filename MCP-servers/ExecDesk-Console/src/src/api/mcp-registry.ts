/**
 * Read-only access to mcp-registry/data/registry.db for dashboard UX.
 */
import { existsSync } from 'fs';
import path from 'path';
import { Router, type Request, type Response } from 'express';
import Database from 'better-sqlite3';
import { getProjectRoot } from '../db.js';

export const mcpRegistryRouter = Router();

type RawRow = {
  id: number;
  mcp_url: string;
  source: string;
  registry_name: string | null;
  jtitle: string | null;
  jname: string | null;
};

function displayName(r: RawRow): string {
  const t = r.jtitle || r.jname || r.registry_name;
  if (t) return t;
  try {
    return new URL(r.mcp_url).hostname;
  } catch {
    return r.mcp_url;
  }
}

/** GET /api/mcp-registry/dcr-targets — rows with dcr_advertised (local catalog snapshot) */
mcpRegistryRouter.get('/dcr-targets', (_req: Request, res: Response) => {
  const dbPath = path.join(getProjectRoot(), 'mcp-registry', 'data', 'registry.db');
  if (!existsSync(dbPath)) {
    res.json({
      ok: true,
      available: false,
      rows: [] as unknown[],
      hint: 'Create the catalog from the repo: cd mcp-registry && npm run import-official (then probe-metadata / probe-dcr as needed).',
    });
    return;
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, timeout: 8000 });
    db.pragma('busy_timeout = 8000');
    // Skip rows with NULL or invalid JSON — one malformed row used to 500 the
    // whole endpoint because `json_extract()` throws mid-query. `json_valid()`
    // is part of SQLite's JSON1 extension (enabled by default in better-sqlite3).
    const raw = db
      .prepare(
        `SELECT id, mcp_url, source, registry_name,
            json_extract(raw_server_json, '$.server.title') AS jtitle,
            json_extract(raw_server_json, '$.server.name') AS jname
         FROM targets
         WHERE dcr_advertised = 1
           AND (raw_server_json IS NULL OR json_valid(raw_server_json) = 1)
         ORDER BY lower(COALESCE(
           json_extract(raw_server_json, '$.server.title'),
           json_extract(raw_server_json, '$.server.name'),
           registry_name,
           mcp_url
         ))`,
      )
      .all() as RawRow[];

    // Count how many rows we had to skip (for telemetry / troubleshooting)
    const badCount = (db
      .prepare(
        `SELECT COUNT(*) AS n FROM targets
         WHERE dcr_advertised = 1
           AND raw_server_json IS NOT NULL
           AND json_valid(raw_server_json) = 0`,
      )
      .get() as { n: number }).n;
    if (badCount > 0) {
      console.warn(`[mcp-registry] dcr-targets: skipped ${badCount} row(s) with malformed raw_server_json`);
    }

    const rows = raw.map((r) => {
      const dn = displayName(r);
      const needle = `${dn} ${r.mcp_url} ${r.registry_name || ''} ${r.source}`.toLowerCase();
      return {
        id: r.id,
        mcp_url: r.mcp_url,
        source: r.source,
        registry_name: r.registry_name,
        display_name: dn,
        server_name: `mcreg_${r.id}`,
        needle,
      };
    });

    res.json({ ok: true, available: true, count: rows.length, rows, skipped_malformed: badCount });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
});
