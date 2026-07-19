#!/usr/bin/env node
// brain mini console — a single-purpose localhost web server for navigating
// Vodou's memory. GET-only JSON API + static UI; the DB is opened read-only,
// so this surface cannot mutate memory. Binds 127.0.0.1 with a Host-header
// guard (same DNS-rebinding defense the gateway shipped 2026-06-13).
//
//   node dist/serve.js            → http://127.0.0.1:8767
//   BRAIN_PORT=9000 node dist/serve.js

import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as Q from './queries.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'public');
export const PORT = parseInt(process.env.BRAIN_PORT || '8767', 10);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function hostAllowed(req: http.IncomingMessage): boolean {
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(s);
}

function parseFilters(u: URL): Q.Filters {
  const cls = u.searchParams.get('cls');
  const tag = u.searchParams.get('tag');
  const since = u.searchParams.get('since_days');
  const q = u.searchParams.get('q');
  const project = u.searchParams.get('project');
  return {
    cls: cls ? (cls.split(',').filter((c) => ['yours', 'captured', 'imported'].includes(c)) as Q.VaultClass[]) : undefined,
    tag: tag || undefined,
    sinceDays: since ? parseInt(since, 10) : undefined,
    includeArchived: u.searchParams.get('archived') === '1',
    q: q || undefined,
    project: project || undefined,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (!hostAllowed(req)) return json(res, 403, { error: 'forbidden host' });
    if (req.method !== 'GET') return json(res, 405, { error: 'read-only surface: GET only' });
    const u = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
    const p = u.pathname;

    if (p.startsWith('/api/brain/')) {
      const route = p.slice('/api/brain/'.length);
      switch (route) {
        case 'overview': return json(res, 200, Q.overview());
        case 'scopes': return json(res, 200, Q.scopes());
        case 'graph': return json(res, 200, Q.graphOverview(
          parseFilters(u),
          parseInt(u.searchParams.get('max_files') || '200', 10),
          40,
          u.searchParams.get('sim') === '1',
        ));
        case 'local': {
          const id = u.searchParams.get('id');
          if (!id) return json(res, 400, { error: 'id required' });
          return json(res, 200, Q.localGraph(
            id,
            parseInt(u.searchParams.get('limit') || '120', 10),
            u.searchParams.get('sim') === '1',
          ));
        }
        case 'similar': {
          const id = u.searchParams.get('id');
          if (!id) return json(res, 400, { error: 'id required' });
          return json(res, 200, {
            neighbors: Q.similarChunks(id, {
              topK: parseInt(u.searchParams.get('k') || '6', 10),
              minCos: u.searchParams.has('tau') ? parseFloat(u.searchParams.get('tau')!) : undefined,
              sameScopeOnly: u.searchParams.get('same_scope') === '1',
            }),
          });
        }
        case 'node': {
          const id = u.searchParams.get('id');
          if (!id) return json(res, 400, { error: 'id required' });
          const detail = Q.nodeDetail(id);
          return detail ? json(res, 200, detail) : json(res, 404, { error: 'not found' });
        }
        case 'file': {
          const fp = u.searchParams.get('path');
          if (!fp) return json(res, 400, { error: 'path required' });
          return json(res, 200, Q.fileDetail(fp));
        }
        case 'entity': {
          const id = parseInt(u.searchParams.get('id') || '', 10);
          if (!Number.isFinite(id)) return json(res, 400, { error: 'id required' });
          const detail = Q.entityDetail(id);
          return detail ? json(res, 200, detail) : json(res, 404, { error: 'not found' });
        }
        case 'entities': return json(res, 200, Q.entities());
        case 'projects': return json(res, 200, Q.projects());
        case 'search': {
          const q = u.searchParams.get('q') || '';
          return json(res, 200, {
            results: Q.search(q, parseInt(u.searchParams.get('limit') || '20', 10),
              u.searchParams.get('archived') === '1'),
          });
        }
        case 'timeline': return json(res, 200, Q.timeline(
          parseInt(u.searchParams.get('days') || '90', 10),
          u.searchParams.get('archived') === '1',
        ));
        case 'conflicts': return json(res, 200, Q.conflicts(u.searchParams.get('status') || undefined));
        default: return json(res, 404, { error: 'unknown route' });
      }
    }

    // Static UI
    let rel = p === '/' ? '/index.html' : p;
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir)) return json(res, 403, { error: 'forbidden' });
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(body);
    } catch {
      json(res, 404, { error: 'not found' });
    }
  } catch (err) {
    console.error('[brain-serve] error:', err);
    json(res, 500, { error: String(err instanceof Error ? err.message : err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[brain-serve] Brain console on http://127.0.0.1:${PORT} (read-only)`);
});

process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));
