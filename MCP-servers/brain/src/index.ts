#!/usr/bin/env node
// brain MCP Server — memory-brain navigation for the Vodou system.
//
// Read-only tools over memory.db (chunks, entities, refs, fact groups,
// contradictions) plus a launcher for the Brain mini console web UI.
// Ranked semantic search stays with the daemon pipeline (Vodou-Recall's
// search_memory / `vodou-core mem search`); this server is the *navigation*
// surface: graph, provenance, backlinks, conflicts, timeline.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Q from './queries.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRAIN_PORT = parseInt(process.env.BRAIN_PORT || '8767', 10);
const BRAIN_URL = `http://127.0.0.1:${BRAIN_PORT}`;

const server = new Server(
  { name: 'brain', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

const TOOLS: Tool[] = [
  {
    name: 'brain_overview',
    description:
      "Snapshot of the user's memory brain: live/archived chunk counts, files, " +
      'entities, connection counts, open conflicts, superseded facts, and the ' +
      'distribution by provenance class (yours / captured / imported) and by tag. ' +
      'Use first to orient before navigating.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'brain_graph',
    description:
      'The memory constellation as JSON nodes+links: memory files, entities, and ' +
      'cited docs, with edges for entity mentions, citations, co-mentions, and ' +
      'conflicts. Same data the Brain console draws. Filter by provenance class, ' +
      'tag, or recency.',
    inputSchema: {
      type: 'object',
      properties: {
        cls: {
          type: 'string',
          description: "Comma list of provenance classes to include: 'yours,captured,imported'. Default all.",
        },
        tag: { type: 'string', description: 'Filter to one tag, e.g. DECISION | GOTCHA | PREF.' },
        since_days: { type: 'integer', description: 'Only chunks created in the last N days.' },
        max_files: { type: 'integer', description: 'Cap on file nodes (default 200).' },
        project: { type: 'string', description: "Project filter: 'global' for NULL-scoped only, or a project_id." },
        archived: { type: 'boolean', description: 'Include archived chunks (default false).' },
      },
    },
  },
  {
    name: 'brain_local',
    description:
      'Local neighborhood graph around one node (Obsidian-style local graph). ' +
      'id may be a chunk id (path:line:hash8), a memory file path, or entity:<n>. ' +
      'Returns the node plus its linked chunks/entities/docs and conflict/supersession edges.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Chunk id, file path, or entity:<n>.' },
        limit: { type: 'integer', description: 'Max neighbors (default 120).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'brain_similar',
    description:
      'Embedding-similarity neighbors of one memory chunk (PLAN-MEMORY-GRAPH-SIMILARITY-EDGES). ' +
      'Top-K most semantically similar chunks by cosine over stored embeddings — the ' +
      '"more like this" / cross-source association the citation graph misses. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Source chunk id (path:line:hash8).' },
        k: { type: 'integer', description: 'Max neighbors (default 6).' },
        tau: { type: 'number', description: 'Minimum cosine floor (default 0.65).' },
        same_scope_only: {
          type: 'boolean',
          description: 'Only same-class neighbors (yours/captured/imported).',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'brain_node',
    description:
      'Fully hydrated detail for one memory chunk: full text, provenance (scope, ' +
      'trust multiplier, class), entities, outgoing citations, backlinks, fact-group ' +
      'supersession status, and any contradictions it is party to.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Chunk id (path:line:hash8).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'brain_search',
    description:
      'Fast FTS5 (bm25) search over live memory chunks — the quick-switcher search. ' +
      'Returns id/path/tag/scope/trust + snippet. For ranked semantic recall use ' +
      "Vodou-Recall's search_memory instead; this one is for navigation/typeahead.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-form text; sanitized for FTS5.' },
        limit: { type: 'integer', description: 'Max results (default 20, max 50).', minimum: 1, maximum: 50 },
        archived: { type: 'boolean', description: 'Also search archived (janitor-retired) history. Default false.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'brain_entities',
    description:
      'All resolved entities (people / orgs / handles) with mention counts and ' +
      'collapsed aliases — the hubs of the memory graph.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'brain_conflicts',
    description:
      'Memory contradictions queue: pairs of chunks asserting different values for ' +
      'the same slot (imported vs native and beyond), with status ' +
      '(open | kept_native | kept_import | no_conflict). Resolution happens via ' +
      '`vodou-core mem contradictions resolve` — this view is read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: "Filter: 'open' (default: all, open first)." },
      },
    },
  },
  {
    name: 'brain_timeline',
    description: 'Memory creation timeline: per-day counts by tag for the last N days.',
    inputSchema: {
      type: 'object',
      properties: { days: { type: 'integer', description: 'Window in days (default 90).' } },
    },
  },
  {
    name: 'open_brain_console',
    description:
      'Start (if needed) the Brain mini console — the interactive memory ' +
      'navigation web UI (constellation graph, vaults, quick switcher, timeline, ' +
      'conflicts) at ' + BRAIN_URL + '. Returns the URL. Pass open:true to also ' +
      'open it in the browser — do that ONLY when the user explicitly asked to ' +
      'see/open the console.',
    // `open` is deliberately NOT declared in the schema: the parameter engine
    // auto-fills EVERY declared boolean with true (parameter_engine.rs:1586),
    // so declaring it would re-arm the tab storm on generated-args routes. The
    // handler still honors an explicit {"open": true} (intent tool_parameters
    // are passed verbatim, and LLMs can pass it from the description above).
    inputSchema: { type: 'object', properties: {} },
  },
];

async function consoleRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BRAIN_URL}/api/brain/overview`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function openBrainConsole(openBrowser: boolean): Promise<string> {
  if (!(await consoleRunning())) {
    const child = spawn(process.execPath, [path.join(__dirname, 'serve.js')], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await consoleRunning()) break;
    }
  }
  // Browser tab is OPT-IN (open:true). The daemon's prompt-hook auto-router
  // calls tools with generated `{}` args on any prompt that semantically
  // matches — with an unconditional `open` here, that meant new 8767 tabs in
  // pairs all day (2026-07-12 incident). Automation gets the URL; only an
  // explicit user ask opens a tab.
  if (openBrowser && process.platform === 'darwin') {
    spawn('open', [BRAIN_URL], { detached: true, stdio: 'ignore' }).unref();
  }
  return BRAIN_URL;
}

const asText = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    switch (name) {
      case 'brain_overview':
        return asText(Q.overview());
      case 'brain_graph':
        return asText(Q.graphOverview(
          {
            cls: typeof args.cls === 'string'
              ? (args.cls.split(',').filter((c: string) => ['yours', 'captured', 'imported'].includes(c)) as Q.VaultClass[])
              : undefined,
            tag: typeof args.tag === 'string' ? args.tag : undefined,
            sinceDays: typeof args.since_days === 'number' ? args.since_days : undefined,
            project: typeof args.project === 'string' && args.project ? args.project : undefined,
            includeArchived: args.archived === true,
          },
          typeof args.max_files === 'number' ? args.max_files : 200,
        ));
      case 'brain_local': {
        if (typeof args.id !== 'string' || !args.id) return { ...asText({ error: 'id is required' }), isError: true };
        return asText(Q.localGraph(args.id, typeof args.limit === 'number' ? args.limit : 120, args.include_similar === true));
      }
      case 'brain_similar': {
        if (typeof args.id !== 'string' || !args.id) return { ...asText({ error: 'id is required' }), isError: true };
        return asText({
          neighbors: Q.similarChunks(args.id, {
            topK: typeof args.k === 'number' ? args.k : 6,
            minCos: typeof args.tau === 'number' ? args.tau : undefined,
            sameScopeOnly: args.same_scope_only === true,
          }),
        });
      }
      case 'brain_node': {
        if (typeof args.id !== 'string' || !args.id) return { ...asText({ error: 'id is required' }), isError: true };
        const detail = Q.nodeDetail(args.id);
        return detail ? asText(detail) : { ...asText({ error: 'chunk not found: ' + args.id }), isError: true };
      }
      case 'brain_search': {
        if (typeof args.query !== 'string' || !args.query.trim()) {
          return { ...asText({ error: 'query is required' }), isError: true };
        }
        const limit = Math.min(Math.max(typeof args.limit === 'number' ? args.limit : 20, 1), 50);
        return asText({ results: Q.search(args.query, limit, args.archived === true) });
      }
      case 'brain_entities':
        return asText(Q.entities());
      case 'brain_conflicts':
        return asText(Q.conflicts(typeof args.status === 'string' && args.status ? args.status : undefined));
      case 'brain_timeline':
        return asText(Q.timeline(typeof args.days === 'number' ? args.days : 90));
      case 'open_brain_console': {
        const openBrowser = (args as { open?: unknown }).open === true;
        const url = await openBrainConsole(openBrowser);
        return asText({
          ok: true,
          url,
          opened: openBrowser,
          hint: openBrowser
            ? 'Brain console is a read-only surface over memory.db.'
            : 'Console is running — share the URL. A browser tab opens only with open:true (explicit user ask).',
        });
      }
      default:
        return { ...asText({ error: `unknown tool: ${name}` }), isError: true };
    }
  } catch (err) {
    console.error(`[brain] ${name} failed:`, err);
    return { ...asText({ error: String(err instanceof Error ? err.message : err) }), isError: true };
  }
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[brain] MCP server on stdio (memory.db read-only)');
}

process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

runServer().catch((err) => {
  console.error('[brain] fatal:', err);
  process.exit(1);
});
