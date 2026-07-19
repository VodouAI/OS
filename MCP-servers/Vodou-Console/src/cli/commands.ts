/**
 * commands.ts — read-only slash-command data formatters shared by both CLI renderers.
 *
 * These return plain multi-line strings (the renderer decides how to print them: the TUI
 * splits into dim info blocks, --plain writes them straight to stdout). Backed by the same
 * SQLite the gateway uses (getDb → vodou-core.db: skills_registry / mcp_servers / tools)
 * and the conversation-recall FTS index. All queries are defensive — a slash command must
 * never throw into the input loop.
 */

import { getDb } from '../db.js';
import { searchConversationMessages } from '../conversation-store.js';

type Row = Record<string, unknown>;
const oneLine = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** `/skills [filter]` — active skills from the registry. */
export function listSkillsText(filter?: string): string {
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT name, COALESCE(description,'') AS description
         FROM skills_registry
        WHERE COALESCE(is_active,1)=1 ${filter ? 'AND name LIKE ?' : ''}
        ORDER BY name`
    ).all(...(filter ? [`%${filter}%`] : [])) as Row[];
    if (!rows.length) return filter ? `no skills match "${filter}"` : 'no skills registered';
    const lines = rows.map((r) => `  ${r.name}${r.description ? ' — ' + oneLine(r.description, 68) : ''}`);
    return [`skills (${rows.length}):`, ...lines, `run one with:  /skills <name>`].join('\n');
  } catch (e) { return `/skills failed: ${(e as Error).message}`; }
}

/** `/server` — MCP servers with active flag, health, and tool counts. */
export function listServersText(): string {
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT s.name AS name, COALESCE(s.active,1) AS active,
              COALESCE(s.health_status,'') AS health,
              (SELECT COUNT(*) FROM tools t WHERE t.server_id = s.id AND COALESCE(t.enabled,1)=1) AS tools
         FROM mcp_servers s
        ORDER BY active DESC, s.name`
    ).all() as Row[];
    if (!rows.length) return 'no MCP servers registered';
    const active = rows.filter((r) => Number(r.active) !== 0).length;
    const lines = rows.map((r) => {
      const mark = Number(r.active) !== 0 ? '●' : '○';
      const h = r.health && r.health !== 'healthy' ? ` (${r.health})` : '';
      return `  ${mark} ${r.name}  ${r.tools} tools${h}`;
    });
    return [`MCP servers (${active}/${rows.length} active):`, ...lines].join('\n');
  } catch (e) { return `/server failed: ${(e as Error).message}`; }
}

/** `/tools [server]` — tool names, grouped by server (optionally filtered). */
export function listToolsText(server?: string): string {
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT s.name AS server, t.name AS tool
         FROM tools t JOIN mcp_servers s ON t.server_id = s.id
        WHERE COALESCE(t.enabled,1)=1 ${server ? 'AND s.name LIKE ?' : ''}
        ORDER BY s.name, t.name`
    ).all(...(server ? [`%${server}%`] : [])) as Row[];
    if (!rows.length) return server ? `no tools on a server matching "${server}"` : 'no tools';
    const byServer = new Map<string, string[]>();
    for (const r of rows) {
      const k = String(r.server);
      if (!byServer.has(k)) byServer.set(k, []);
      byServer.get(k)!.push(String(r.tool));
    }
    // A specific server query wants the FULL list; the all-servers dump caps per server to
    // avoid flooding (899 tools across 39 servers).
    const cap = server ? Infinity : 12;
    const out = [`tools (${rows.length}${server ? ` on ~${server}` : ''}):`];
    for (const [srv, tools] of byServer) {
      out.push(`  ${srv} (${tools.length}): ${tools.slice(0, cap).join(', ')}${tools.length > cap ? ` …+${tools.length - cap}` : ''}`);
    }
    return out.join('\n');
  } catch (e) { return `/tools failed: ${(e as Error).message}`; }
}

/** `/search <query>` — FTS recall over THIS conversation's messages (Vodou-Recall). */
export function searchText(conversationId: string, query: string): string {
  if (!query.trim()) return 'usage: /search <query>';
  try {
    const hits = searchConversationMessages(conversationId, query, 8);
    if (!hits.length) return `no matches for "${query}" in this conversation`;
    const lines = hits.map((h) => `  [${h.role === 'user' ? 'you' : 'vodou'}] ${oneLine(h.content, 88)}`);
    return [`recall — ${hits.length} hit(s) for "${query}":`, ...lines].join('\n');
  } catch (e) { return `/search failed: ${(e as Error).message}`; }
}
