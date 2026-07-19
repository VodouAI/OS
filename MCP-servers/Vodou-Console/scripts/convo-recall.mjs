#!/usr/bin/env node
// PLAN-LONG-CONVO-RECALL.md Phase 4 — claude-cli-callable convo recall tool.
// Usage:  node MCP-servers/Vodou-Console/scripts/convo-recall.mjs <conversation_id> "<query>" [limit]
// Output: JSON {results:[{id,role,content,created_at,rank}], count}
//
// Requires Node 24 — FTS5 ships in node:sqlite there. On Node 22 the FTS5
// table doesn't exist and the query errors out; we return an empty-with-error
// payload so the LLM can keep going.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

function out(obj, code = 0) {
  console.log(JSON.stringify(obj));
  process.exit(code);
}
function fail(msg) { out({ error: msg, results: [], count: 0 }, 1); }

const [, , convId, query, limitRaw] = process.argv;
if (!convId || !query) fail('usage: convo-recall.mjs <conversation_id> "<query>" [limit]');
const limit = Math.min(Math.max(parseInt(limitRaw || '5', 10) || 5, 1), 25);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..', '..');
const dbPath = process.env.GATEWAY_DB_PATH?.trim()
  || path.join(projectRoot, 'MCP-servers', 'Vodou-Console', 'gateway.db');

if (!existsSync(dbPath)) fail(`gateway.db not found at ${dbPath}`);

let db;
try { db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 }); }
catch (e) { fail(`failed to open gateway.db: ${e.message}`); }

// Sanitize for FTS5: strip metacharacters that get parsed as operators
// ('-', ':', '*', '^', parens, double-quotes), tokenize on whitespace+punct,
// drop tokens <2 chars, quote each token to escape residual oddness, then AND.
const cleaned = query.replace(/["()*^:]/g, ' ').replace(/-/g, ' ').toLowerCase();
const tokens = cleaned.split(/[\s,;.!?]+/).filter((t) => t.length >= 2).slice(0, 8).map((t) => `"${t}"`);
const ftsQuery = tokens.join(' ');
if (!ftsQuery) out({ results: [], count: 0, note: 'query had no scorable tokens after sanitize' });

let rows;
try {
  rows = db.prepare(`
    SELECT m.id, m.role, m.content, m.created_at, bm25(gateway_messages_fts) AS rank
      FROM gateway_messages_fts f
      JOIN gateway_messages m ON m.id = f.rowid
     WHERE f.content MATCH ?
       AND m.conversation_id = ?
     ORDER BY rank ASC
     LIMIT ?
  `).all(ftsQuery, convId, limit);
} catch (e) { fail(`FTS5 query failed (need Node 24): ${e.message}`); }

const MAX_SNIPPET = 800;
const results = rows.map((r) => ({
  id: r.id,
  role: r.role,
  created_at: r.created_at,
  rank: r.rank,
  content: r.content.length > MAX_SNIPPET ? r.content.slice(0, MAX_SNIPPET) + '…' : r.content,
}));
out({ results, count: results.length });
