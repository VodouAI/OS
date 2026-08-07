#!/usr/bin/env node
// Vodou-Recall MCP Server
// PLAN-LONG-CONVO-RECALL.md Phase 4 — exposes the same FTS5 conversation
// recall path as scripts/convo-recall.mjs, but via the MCP protocol so that
// API-based providers (Anthropic API, OpenAI, OpenRouter, Ollama) can call
// it as a native tool. claude-cli already gets the Bash invocation path
// injected into its system prompt; this server is for everything else.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// dist/index.js → ../../.. = project root (one level shallower than scripts/)
const projectRoot = path.resolve(__dirname, '..', '..', '..');
const dbPath = process.env.GATEWAY_DB_PATH?.trim()
  || path.join(projectRoot, 'MCP-servers', 'Vodou-Console', 'gateway.db');
const coreDbPath = process.env.VODOU_CORE_DB?.trim()
  || path.join(projectRoot, 'vodou-core.db');
const vodouCorePath = process.env.VODOU_CORE_PATH?.trim()
  || path.join(projectRoot, 'vodou-core');
const taskLedgerPath = process.env.VODOU_TASK_LEDGER?.trim()
  || path.join(projectRoot, '.vodou', 'workspace', 'task_ledger.json');

const server = new Server(
  { name: 'Vodou-Recall', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

const TOOLS: Tool[] = [
  {
    name: 'search_conversation',
    description:
      "Full-text search a conversation's prior turns via FTS5 (bm25 ranked). " +
      'Use when the user references something discussed earlier that you do not ' +
      'have in your current context window. Returns matching turns scoped strictly ' +
      'to one conversation_id. Lower rank = more relevant. Do NOT call on every ' +
      'prompt — only when context is genuinely insufficient.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: 'The conversation_id to search within (required for scoping).',
        },
        query: {
          type: 'string',
          description: 'Free-form text. Hyphens/colons/quotes are auto-sanitized.',
        },
        max_results: {
          type: 'integer',
          description: 'Max hits to return. Default 5, max 25.',
          minimum: 1,
          maximum: 25,
        },
      },
      required: ['conversation_id', 'query'],
    },
  },
  {
    name: 'search_memory',
    description:
      'Semantic + FTS5 search across the user\'s durable memory (memory.db chunks: ' +
      'daily logs, extracted facts, decisions, preferences). Use when the user ' +
      'asks "what did we decide about X", "remember when…", or anything that ' +
      'requires recalling earlier context beyond the current conversation. ' +
      'Returns ranked chunks with path + score + text excerpt. Uses the same ' +
      'daemon pipeline (FTS5 + vector + reranker + scope boost) as the per-turn ' +
      'memory injection — high confidence in relevance.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Free-form natural language query.',
        },
        top_k: {
          type: 'integer',
          description: 'Max chunks to return. Default 5, max 20.',
          minimum: 1,
          maximum: 20,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_store',
    description:
      'Save a new durable fact into memory (scope import:mcp). Use for stable facts, ' +
      'decisions, and preferences — NOT ephemeral task state, and NOT corrections. ' +
      'For fixing a false memory use memory_correct instead. ALWAYS pass a tag: ' +
      'the tag governs disclosure to other AI surfaces — untagged facts are ' +
      'floor-gated until a background pass classifies them. Personal facts about ' +
      'the user (family, spouse, kids, pets, home, birthday, contact info) MUST ' +
      'be tagged IDENTITY.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The fact to remember (one clear sentence).' },
        tag: {
          type: 'string',
          description:
            'Category tag — pass one whenever possible. IDENTITY for personal facts about the user ' +
            '(family, spouse, kids, pets, home); PREF for lasting preferences; ' +
            'DECISION | DONE | PLANNED | ISSUE | GOTCHA | METRIC | PATTERN | DEPENDENCY | EXAMPLE | RESEARCH otherwise.',
        },
        project: { type: 'string', description: 'Optional project id to scope this memory to.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'memory_correct',
    description:
      'Correct a wrong memory: stores the right fact and soft-supersedes the wrong chunk(s) ' +
      '(invalid_at + fact_groups) so recall hides the loser. Use when the user says a prior ' +
      'fact was wrong ("Dr. Smith is my sleep doctor, NOT my dog\'s vet"). Prefer chunk_id from ' +
      'search_memory when available; otherwise pass a distinctive wrong snippet (min 8 chars). ' +
      'Works on native and import-scoped chunks. Import losers also get source-line strip + DB delete.',
    inputSchema: {
      type: 'object',
      properties: {
        right: {
          type: 'string',
          description: 'The corrected fact (one clear sentence).',
        },
        wrong: {
          type: 'string',
          description:
            'Distinctive text from the wrong memory (min 8 chars). Required unless chunk_id is set.',
        },
        chunk_id: {
          type: 'string',
          description: 'Exact chunk id to supersede (from search_memory / memory_get).',
        },
        tag: {
          type: 'string',
          description: 'Optional category tag for the stored correction.',
        },
      },
      required: ['right'],
    },
  },
  {
    name: 'memory_reject',
    description:
      'Forget an import/capture-scoped memory chunk (hard delete + strip source line). ' +
      'Cannot delete native daily-log memory — use memory_correct to supersede those. ' +
      'Pass chunk_id from search_memory, or a distinctive snippet (min 6 chars).',
    inputSchema: {
      type: 'object',
      properties: {
        chunk_id: {
          type: 'string',
          description: 'Exact chunk id to reject (preferred).',
        },
        snippet: {
          type: 'string',
          description: 'Distinctive text from the import/capture chunk (min 6 chars) if no chunk_id.',
        },
      },
      required: [],
    },
  },
  {
    name: 'memory_pin',
    description:
      'Pin a memory chunk so it ranks higher on relevant queries (memory_chunks.pinned=1). ' +
      'Same as the Memory UI pin toggle. Pass chunk_id from search_memory.',
    inputSchema: {
      type: 'object',
      properties: {
        chunk_id: { type: 'string', description: 'Chunk id to pin.' },
      },
      required: ['chunk_id'],
    },
  },
  {
    name: 'memory_unpin',
    description:
      'Unpin a memory chunk (pinned=0). Use before correcting a wrongly pinned fact if ' +
      'auto-supersede is blocked by the pin.',
    inputSchema: {
      type: 'object',
      properties: {
        chunk_id: { type: 'string', description: 'Chunk id to unpin.' },
      },
      required: ['chunk_id'],
    },
  },
  {
    name: 'memory_get',
    description:
      'PLAN-UNIVERSAL-MEMORY Phase 6 — fetch memory verbatim by chunk id or file path / ' +
      'path-prefix (exact retrieval, no ranking). Use to read back the full text of a ' +
      'specific memory after search_memory, or to list everything under a path like ' +
      '"memory/imports/claude". Distinct from search_memory (which ranks by relevance).',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'A chunk id (path:line:hash) or a file path / path-prefix.' },
      },
      required: ['key'],
    },
  },
  {
    name: 'get_current_work',
    description:
      'Deterministic snapshot of what the user is currently working on: recent ' +
      'human-logged work entries (excludes scheduler/tool-call noise), open ' +
      'heartbeat tasks, and recent user prompts from the gateway. Use when the ' +
      'user asks "what are we working on", "what\'s in flight", "what\'s open" — ' +
      'returns structured JSON the LLM can summarize directly. No fuzzy ranking.',
    inputSchema: {
      type: 'object',
      properties: {
        work_log_limit: {
          type: 'integer',
          description: 'Max recent work_logs entries. Default 10, max 50.',
          minimum: 1,
          maximum: 50,
        },
      },
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

interface RecallHit {
  id: number;
  role: string;
  content: string;
  created_at: string;
  rank: number;
}

const MAX_SNIPPET = 800;

function sanitizeFtsQuery(raw: string): string {
  const cleaned = raw.replace(/["()*^:]/g, ' ').replace(/-/g, ' ').toLowerCase();
  return cleaned
    .split(/[\s,;.!?]+/)
    .filter((t) => t.length >= 2)
    .slice(0, 8)
    .map((t) => `"${t}"`)
    .join(' ');
}

interface MemoryHit {
  path: string;
  score: number;
  tag: string | null;
  scope: string | null;
  created_at: string;
  text: string;
}

function searchMemory(query: string, topK: number): { results: MemoryHit[]; count: number; note?: string } {
  if (!existsSync(vodouCorePath)) {
    return { results: [], count: 0, note: `vodou-core binary not found at ${vodouCorePath}` };
  }
  try {
    const result = spawnSync(
      vodouCorePath,
      ['mem', 'search', query, '--top-k', String(topK), '--json'],
      { cwd: projectRoot, encoding: 'utf-8', timeout: 10_000 },
    );
    if (result.error) {
      return { results: [], count: 0, note: `spawn failed: ${result.error.message}` };
    }
    if (result.status !== 0) {
      const errSnip = (result.stderr || '').slice(0, 200);
      return { results: [], count: 0, note: `vodou-core exit ${result.status}: ${errSnip}` };
    }
    const parsed = JSON.parse(result.stdout) as { results?: Array<Record<string, unknown>> };
    const raw = Array.isArray(parsed.results) ? parsed.results : [];
    const results: MemoryHit[] = raw.map((r) => {
      const text = typeof r.text === 'string' ? r.text : '';
      return {
        path: String(r.path ?? ''),
        score: typeof r.score === 'number' ? r.score : 0,
        tag: (r.chunk_tag as string | null) ?? null,
        scope: (r.chunk_scope as string | null) ?? null,
        created_at: String(r.created_at ?? ''),
        text: text.length > MAX_SNIPPET ? text.slice(0, MAX_SNIPPET) + '…' : text,
      };
    });
    return { results, count: results.length };
  } catch (e) {
    return { results: [], count: 0, note: `search_memory failed: ${(e as Error).message}` };
  }
}

/** Run a `vodou-core mem …` subcommand expecting `--json`; return parsed output. */
function runCoreMem(args: string[]): { ok: boolean; data?: unknown; note?: string } {
  if (!existsSync(vodouCorePath)) {
    return { ok: false, note: `vodou-core binary not found at ${vodouCorePath}` };
  }
  const res = spawnSync(vodouCorePath, args, { cwd: projectRoot, encoding: 'utf-8', timeout: 15_000 });
  if (res.error) return { ok: false, note: `spawn failed: ${res.error.message}` };
  if (res.status !== 0) {
    // mem correct/reject often print structured JSON then exit non-zero on bail —
    // prefer that payload over a bare exit note.
    try {
      const data = JSON.parse((res.stdout || '').trim());
      if (data && typeof data === 'object') {
        return {
          ok: Boolean((data as { ok?: boolean }).ok),
          data,
          note: typeof (data as { error?: string }).error === 'string'
            ? (data as { error: string }).error
            : `vodou-core exit ${res.status}`,
        };
      }
    } catch {
      /* fall through */
    }
    return { ok: false, note: `vodou-core exit ${res.status}: ${(res.stderr || res.stdout || '').slice(0, 300)}` };
  }
  try {
    return { ok: true, data: JSON.parse(res.stdout) };
  } catch {
    return { ok: true, data: { text: res.stdout.trim() } };
  }
}

/** PLAN-UNIVERSAL-MEMORY Phase 6 — write a fact into the brain (scope import:mcp). */
function memoryStore(text: string, tag?: string, project?: string): { ok: boolean; data?: unknown; note?: string } {
  const cmd = ['mem', 'store', text, '--json'];
  if (tag && tag.trim()) cmd.push('--tag', tag.trim());
  if (project && project.trim()) cmd.push('--project', project.trim());
  return runCoreMem(cmd);
}

/** Soft-correct: store right fact + supersede wrong chunk(s). */
function memoryCorrect(
  right: string,
  wrong?: string,
  chunkId?: string,
  tag?: string,
): { ok: boolean; data?: unknown; note?: string } {
  const cmd = ['mem', 'correct', right, '--json'];
  if (chunkId && chunkId.trim()) cmd.push('--chunk-id', chunkId.trim());
  else if (wrong && wrong.trim()) cmd.push('--wrong', wrong.trim());
  else return { ok: false, note: 'memory_correct requires wrong or chunk_id' };
  if (tag && tag.trim()) cmd.push('--tag', tag.trim());
  return runCoreMem(cmd);
}

/** Forget import/capture chunk — shells mem reject. */
function memoryReject(
  chunkId?: string,
  snippet?: string,
): { ok: boolean; data?: unknown; note?: string } {
  const cmd = ['mem', 'reject', '--json'];
  if (chunkId && chunkId.trim()) cmd.push('--chunk-id', chunkId.trim());
  else if (snippet && snippet.trim()) cmd.push(snippet.trim());
  else return { ok: false, note: 'memory_reject requires chunk_id or snippet' };
  return runCoreMem(cmd);
}

/** Pin / unpin — shells mem pin|unpin. */
function memorySetPinned(
  chunkId: string,
  pinned: boolean,
): { ok: boolean; data?: unknown; note?: string } {
  const id = chunkId.trim();
  if (!id) return { ok: false, note: 'chunk_id is required' };
  return runCoreMem(['mem', pinned ? 'pin' : 'unpin', id, '--json']);
}

/** PLAN-UNIVERSAL-MEMORY Phase 6 — verbatim read-back by chunk id or path/prefix. */
function memoryGet(key: string): { ok: boolean; data?: unknown; note?: string } {
  return runCoreMem(['mem', 'get', key, '--json']);
}

interface WorkLogEntry { timestamp: string; category: string; message: string }
interface OpenTask { text: string; stale_runs: number; last_seen_run?: number }
interface RecentPrompt { created_at: string; content: string }

function getCurrentWork(workLogLimit: number): {
  recent_work_logs: WorkLogEntry[];
  open_tasks: OpenTask[];
  recent_user_prompts: RecentPrompt[];
  note?: string;
} {
  const out: {
    recent_work_logs: WorkLogEntry[];
    open_tasks: OpenTask[];
    recent_user_prompts: RecentPrompt[];
    note?: string;
  } = { recent_work_logs: [], open_tasks: [], recent_user_prompts: [] };
  const notes: string[] = [];

  // 1. Recent human-logged work (skip scheduler / tool_call / installation noise)
  if (existsSync(coreDbPath)) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(coreDbPath, { readOnly: true, timeout: 5000 });
      const rows = db.prepare(`
        SELECT timestamp, category, message
          FROM work_logs
         WHERE category NOT IN ('scheduler', 'tool_call', 'installation')
         ORDER BY timestamp DESC
         LIMIT ?
      `).all(workLogLimit) as unknown as WorkLogEntry[];
      out.recent_work_logs = rows.map((r) => ({
        timestamp: r.timestamp,
        category: r.category,
        message: r.message.length > 300 ? r.message.slice(0, 300) + '…' : r.message,
      }));
    } catch (e) {
      notes.push(`work_logs query failed: ${(e as Error).message}`);
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  } else {
    notes.push(`vodou-core.db not found at ${coreDbPath}`);
  }

  // 2. Open heartbeat tasks
  if (existsSync(taskLedgerPath)) {
    try {
      const raw = readFileSync(taskLedgerPath, 'utf-8');
      const parsed = JSON.parse(raw) as { tasks?: Array<Record<string, unknown>> };
      const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      out.open_tasks = tasks
        .filter((t) => t.status === 'open')
        .map((t) => ({
          text: String(t.text ?? ''),
          stale_runs: typeof t.stale_runs === 'number' ? t.stale_runs : 0,
          last_seen_run: typeof t.last_seen_run === 'number' ? t.last_seen_run : undefined,
        }))
        .slice(0, 15);
    } catch (e) {
      notes.push(`task_ledger parse failed: ${(e as Error).message}`);
    }
  }

  // 3. Recent user prompts from gateway
  if (existsSync(dbPath)) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
      const rows = db.prepare(`
        SELECT created_at, content
          FROM gateway_messages
         WHERE role = 'user'
         ORDER BY id DESC
         LIMIT 5
      `).all() as unknown as RecentPrompt[];
      out.recent_user_prompts = rows.map((r) => ({
        created_at: r.created_at,
        content: r.content.length > 200 ? r.content.slice(0, 200) + '…' : r.content,
      }));
    } catch (e) {
      notes.push(`gateway recent prompts failed: ${(e as Error).message}`);
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }

  if (notes.length > 0) out.note = notes.join('; ');
  return out;
}

function searchConversation(convId: string, rawQuery: string, max: number): { results: RecallHit[]; count: number; note?: string } {
  if (!existsSync(dbPath)) {
    return { results: [], count: 0, note: `gateway.db not found at ${dbPath}` };
  }
  const fts = sanitizeFtsQuery(rawQuery);
  if (!fts) return { results: [], count: 0, note: 'query had no scorable tokens' };
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
  } catch (e) {
    return { results: [], count: 0, note: `failed to open gateway.db: ${(e as Error).message}` };
  }
  try {
    const rows = db.prepare(`
      SELECT m.id, m.role, m.content, m.created_at, bm25(gateway_messages_fts) AS rank
        FROM gateway_messages_fts f
        JOIN gateway_messages m ON m.id = f.rowid
       WHERE f.content MATCH ?
         AND m.conversation_id = ?
       ORDER BY rank ASC
       LIMIT ?
    `).all(fts, convId, max) as unknown as RecallHit[];
    const trimmed = rows.map((r) => ({
      ...r,
      content: r.content.length > MAX_SNIPPET ? r.content.slice(0, MAX_SNIPPET) + '…' : r.content,
    }));
    return { results: trimmed, count: trimmed.length };
  } catch (e) {
    return { results: [], count: 0, note: `FTS5 query failed: ${(e as Error).message}` };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (!args) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'No arguments provided' }) }],
      isError: true,
    };
  }
  try {
    switch (name) {
      case 'search_conversation': {
        const convId = String((args as Record<string, unknown>).conversation_id || '');
        const query = String((args as Record<string, unknown>).query || '');
        const maxRaw = Number((args as Record<string, unknown>).max_results ?? 5);
        const max = Math.min(Math.max(Number.isFinite(maxRaw) ? maxRaw : 5, 1), 25);
        if (!convId || !query) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'conversation_id and query are required' }) }],
            isError: true,
          };
        }
        const out = searchConversation(convId, query, max);
        return { content: [{ type: 'text', text: JSON.stringify(out) }] };
      }
      case 'search_memory': {
        const query = String((args as Record<string, unknown>).query || '');
        const topKRaw = Number((args as Record<string, unknown>).top_k ?? 5);
        const topK = Math.min(Math.max(Number.isFinite(topKRaw) ? topKRaw : 5, 1), 20);
        if (!query) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'query is required' }) }],
            isError: true,
          };
        }
        const out = searchMemory(query, topK);
        return { content: [{ type: 'text', text: JSON.stringify(out) }] };
      }
      case 'memory_store': {
        const text = String((args as Record<string, unknown>).text || '').trim();
        if (!text) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'text is required' }) }], isError: true };
        }
        const tag = String((args as Record<string, unknown>).tag || '').trim() || undefined;
        const project = String((args as Record<string, unknown>).project || '').trim() || undefined;
        const r = memoryStore(text, tag, project);
        return r.ok
          ? { content: [{ type: 'text', text: JSON.stringify(r.data) }] }
          : { content: [{ type: 'text', text: JSON.stringify({ error: r.note }) }], isError: true };
      }
      case 'memory_correct': {
        const right = String((args as Record<string, unknown>).right || '').trim();
        if (!right) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'right is required' }) }], isError: true };
        }
        const wrong = String((args as Record<string, unknown>).wrong || '').trim() || undefined;
        const chunkId = String((args as Record<string, unknown>).chunk_id || '').trim() || undefined;
        const tag = String((args as Record<string, unknown>).tag || '').trim() || undefined;
        if (!wrong && !chunkId) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'wrong or chunk_id is required' }) }],
            isError: true,
          };
        }
        const r = memoryCorrect(right, wrong, chunkId, tag);
        return r.ok
          ? { content: [{ type: 'text', text: JSON.stringify(r.data) }] }
          : { content: [{ type: 'text', text: JSON.stringify({ error: r.note }) }], isError: true };
      }
      case 'memory_reject': {
        const chunkId = String((args as Record<string, unknown>).chunk_id || '').trim() || undefined;
        const snippet = String((args as Record<string, unknown>).snippet || '').trim() || undefined;
        if (!chunkId && !snippet) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'chunk_id or snippet is required' }) }],
            isError: true,
          };
        }
        const r = memoryReject(chunkId, snippet);
        return r.ok
          ? { content: [{ type: 'text', text: JSON.stringify(r.data) }] }
          : { content: [{ type: 'text', text: JSON.stringify({ error: r.note }) }], isError: true };
      }
      case 'memory_pin':
      case 'memory_unpin': {
        const chunkId = String((args as Record<string, unknown>).chunk_id || '').trim();
        if (!chunkId) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'chunk_id is required' }) }], isError: true };
        }
        const r = memorySetPinned(chunkId, name === 'memory_pin');
        return r.ok
          ? { content: [{ type: 'text', text: JSON.stringify(r.data) }] }
          : { content: [{ type: 'text', text: JSON.stringify({ error: r.note }) }], isError: true };
      }
      case 'memory_get': {
        const key = String((args as Record<string, unknown>).key || '').trim();
        if (!key) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'key is required' }) }], isError: true };
        }
        const r = memoryGet(key);
        return r.ok
          ? { content: [{ type: 'text', text: JSON.stringify(r.data) }] }
          : { content: [{ type: 'text', text: JSON.stringify({ error: r.note }) }], isError: true };
      }
      case 'get_current_work': {
        const limitRaw = Number((args as Record<string, unknown>).work_log_limit ?? 10);
        const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 10, 1), 50);
        const out = getCurrentWork(limit);
        return { content: [{ type: 'text', text: JSON.stringify(out) }] };
      }
      default:
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `unknown tool: ${name}` }) }],
          isError: true,
        };
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message }) }],
      isError: true,
    };
  }
});

process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('🔎 Vodou-Recall MCP Server running on stdio');
}

runServer().catch((error) => {
  console.error('Fatal error running server:', error);
  process.exit(1);
});
