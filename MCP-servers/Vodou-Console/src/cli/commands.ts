/**
 * commands.ts — read-only slash-command data formatters shared by both CLI renderers.
 *
 * These return plain multi-line strings (the renderer decides how to print them: the TUI
 * splits into dim info blocks, --plain writes them straight to stdout). Backed by the same
 * SQLite the gateway uses (getDb → vodou-core.db: skills_registry / mcp_servers / tools)
 * and the conversation-recall FTS index. All queries are defensive — a slash command must
 * never throw into the input loop.
 */

import { execFileSync } from 'child_process';

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

/**
 * The canonical command list. ONE string, because there were two: the TUI
 * listed ten commands and `--plain`'s `/help` listed five — and `--plain` did
 * not merely under-document the other five, it did not implement them. Typing
 * `/skills` there sent the literal text to the model, which then improvised an
 * answer about skills instead of reading the registry. The TUI's own author had
 * written a guard against exactly that ("don't ship it to the LLM as a prompt")
 * and the sibling renderer never got it.
 *
 * Both renderers print this. A command added to one is now added to both, or it
 * is missing from this list and therefore from neither.
 */
export const CLI_HELP = [
  'commands:',
  '  /skills [filter]   list skills (or run one: /skills <name>)',
  '  /server            connected MCP servers + tool counts',
  '  /tools [server]    available tools',
  '  /search <query>    recall earlier messages in this conversation',
  '  /workflow <what>   plan multi-step work — see the steps before anything runs',
  '  /compress          summarize + continue in a fresh context',
  '  /model [name]      show or switch the model',
  '  /usage  /clear  /new  /exit        ·  Ctrl-C abort turn',
].join('\n');

/**
 * The read-only slash commands, dispatched once for both renderers.
 *
 * Returns the text to show, or `null` when `text` is not one of them — so a
 * caller can fall through to its own controller-specific commands (`/compress`,
 * running a named skill) and then to its unknown-command guard. Never throws:
 * each formatter already catches its own errors and returns a message.
 */
export function readOnlyCommand(text: string, conversationId: string): string | null {
  const t = text.trim();
  if (t === '/server' || t === '/servers') return listServersText();
  if (t.startsWith('/server ') || t.startsWith('/servers ')) {
    const name = t.slice(t.indexOf(' ') + 1).trim();
    return name ? listToolsText(name) : listServersText();
  }
  if (t === '/tools' || t.startsWith('/tools ')) {
    return listToolsText(t.slice('/tools'.length).trim() || undefined);
  }
  if (t === '/search' || t.startsWith('/search ')) {
    return searchText(conversationId, t.slice('/search'.length).trim());
  }
  if (t === '/skills') return listSkillsText();
  // `/skills <name>` RUNS a skill — that needs a turn, not a string, so it is
  // deliberately not handled here. Callers own it.
  return null;
}

/**
 * Is this slash something the SERVER handles inside `chat()`?
 *
 * The renderers guard against forwarding an unrecognised `/command` to the
 * model — correctly, since a typo should not become a prompt. But the guard was
 * written as "anything starting with / that I do not handle myself", and the
 * gateway has its own slash vocabulary that the CLI never knew about:
 *
 *   · `/workflow <sentence>` (and `/wf`) — added this cycle, builds a plan card.
 *     It works in the console chat and has NEVER worked in the CLI: the TUI's
 *     guard has eaten it since the day it shipped.
 *   · `/<skill-name>` — `chat()` reads any leading `/word` as an explicit skill
 *     invocation, so all 148 registered skills have a slash shortcut that the
 *     CLI was answering with "unknown command".
 *
 * So the guard now asks this first. Unknown-to-both still gets refused locally,
 * which is the case it was written for.
 *
 * On a database error this returns TRUE — pass it through and let the server
 * decide. Blocking a real skill because SQLite hiccuped is a worse failure than
 * a typo reaching the router, and the server already handles an unknown skill
 * by treating the word as an ordinary query.
 */
export function isServerSideCommand(text: string): boolean {
  const t = text.trim();
  if (/^\/(workflow|wf)\b/i.test(t)) return true;
  const m = t.match(/^\/([a-zA-Z0-9_-]+)(?:\s|$)/);
  if (!m) return false;
  try {
    const db = getDb();
    const row = db.prepare(
      `SELECT 1 FROM skills_registry WHERE COALESCE(is_active,1)=1 AND name = ? LIMIT 1`,
    ).get(m[1]);
    return !!row;
  } catch {
    return true;   // cannot tell → the server owns this list, not us
  }
}

/**
 * The model aliases to suggest for `/model`.
 *
 * Both renderers hardcoded `<sonnet|opus|haiku|...>`. That list was written
 * before Fable existed, so the CLI never offered the flagship — Chad read the
 * hint, typed `fable`, and got a hallucinated paragraph about an email workflow
 * because a bare word is a prompt, not a command. Third frozen list found in
 * this CLI today, after the banner date and the two `/help` texts.
 *
 * So ask the binary that actually accepts the value. `claude --help` documents
 * its own aliases ("Provide an alias for the latest model (e.g. 'fable',
 * 'opus', or 'sonnet')"), which means the hint tracks whatever the installed
 * Claude CLI supports instead of what someone typed once.
 *
 * Cached per process — this only runs on `/model` with no argument, but there
 * is no reason to spawn twice. Falls back to a static list that INCLUDES fable,
 * so even the fallback is not the stale one.
 */
let _modelAliases: string[] | null = null;
export function modelAliases(): string[] {
  if (_modelAliases) return _modelAliases;
  const fallback = ['fable', 'opus', 'sonnet', 'haiku'];
  try {
    const bin = process.env.CLAUDE_BIN || 'claude';
    const help = execFileSync(bin, ['--help'], { encoding: 'utf8', timeout: 5000 });
    // The --model paragraph runs until the next flag at the left margin.
    const para = /--model <model>([\s\S]*?)(?=\n\s{2}-)/.exec(help)?.[1] ?? '';
    const found = [...para.matchAll(/'([a-z][a-z0-9.-]*)'/g)]
      .map((m) => m[1])
      .filter((a) => !a.startsWith('claude-'));   // full names are not aliases
    _modelAliases = found.length ? [...new Set(found)] : fallback;
  } catch {
    _modelAliases = fallback;   // no binary, no PATH, no help — still not stale
  }
  return _modelAliases;
}

/** `/model` with no argument — what to suggest. */
export function modelHint(): string {
  return `switch with: /model <${modelAliases().join('|')}|…>`;
}

/**
 * Did the user type a bare model name, meaning `/model <that>`?
 *
 * The transcript that prompted this: `/model` printed the hint, Chad typed
 * `fable`, and it went to the model as a prompt — burning a turn and coming
 * back with confident nonsense about Gmail connectors. Suggesting the command
 * costs nothing and is not a guess: it only fires on an EXACT match against the
 * alias list, so ordinary prose can never trip it.
 */
export function bareModelName(text: string): string | null {
  const t = text.trim().toLowerCase();
  if (!/^[a-z][a-z0-9.-]*$/.test(t)) return null;
  return modelAliases().includes(t) ? t : null;
}
