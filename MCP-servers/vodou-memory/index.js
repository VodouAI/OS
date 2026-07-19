#!/usr/bin/env node
// vodou-memory — PLAN-MEMORY-FOLLOWS-YOU Lane B.
//
// A zero-dependency stdio MCP server that gives ANY MCP-capable client
// (Cursor, VS Code / Visual Studio Copilot, JetBrains AI Assistant, Windsurf,
// Zed, Claude Desktop, …) vault-scoped access to your Vodou memory.
//
// Disclosure invariant: the vault is fixed at LAUNCH (--vault flag or
// VODOU_MEMORY_VAULT env, default "portable") and is NOT a tool argument —
// a prompt-injected agent cannot ask for a different vault. Search and
// context shells `vodou-core mem …` (the single formatter/resolver);
// `remember` posts into the gateway's manual-capture lane (capture trust
// tier, extractor-distilled — never a direct memory write).
//
// Zero deps on purpose: the MCP stdio surface we need (initialize,
// tools/list, tools/call over newline-delimited JSON-RPC) is ~150 lines,
// and no node_modules means nothing to vendor, prune, or npm-repair.

import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const VAULT = (argValue('--vault') || process.env.VODOU_MEMORY_VAULT || 'portable').trim();
const PROJECT_ROOT = process.env.VODOU_PROJECT_PATH || path.resolve(__dirname, '..', '..');
const VODOU_CORE = path.join(PROJECT_ROOT, 'vodou-core');
const GATEWAY_PORT = process.env.WEB_PORT || '8765';

// ── vodou-core shell ──────────────────────────────────────────────────────────
function core(args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    execFile(VODOU_CORE, args, { cwd: PROJECT_ROOT, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).slice(0, 500)));
      else resolve(stdout);
    });
  });
}

function gatewayPost(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port: GATEWAY_PORT, path: pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, timeout: 10000 },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          if (res.statusCode && res.statusCode < 300) resolve(out);
          else reject(new Error(`gateway ${res.statusCode}: ${out.slice(0, 300)}`));
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('gateway timeout')); });
    req.end(data);
  });
}

// ── Tools ─────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'memory_search',
    description:
      `Search the user's personal Vodou memory (vault-scoped: only the "${VAULT}" vault is visible). ` +
      'Returns ranked memory snippets. Use when you need facts, preferences, or past decisions about the user.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for' },
        top_k: { type: 'number', description: 'Max results (1-20, default 8)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_context',
    description:
      `Get a ready-to-use context block of the user's relevant personal memory (vault "${VAULT}" only) for a topic. ` +
      'Prefer this over memory_search when you just want background context to ground your answer.',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'Topic to gather context for' } },
      required: ['topic'],
    },
  },
  {
    name: 'remember',
    description:
      "Save a fact/preference/decision to the user's Vodou memory. It lands in the reviewed capture lane " +
      '(not written directly) — Vodou distils and ranks it like every other capture.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The fact to remember, one or two sentences' } },
      required: ['text'],
    },
  },
];

async function callTool(name, args) {
  if (name === 'memory_search') {
    const topK = Math.min(Math.max(Number(args.top_k) || 8, 1), 20);
    const out = await core(['mem', 'search', String(args.query || ''), '--vault', VAULT, '--top-k', String(topK), '--json']);
    const data = JSON.parse(out);
    const rows = (data.results || []).map((r, i) => `${i + 1}. [${(r.score ?? 0).toFixed(3)}] ${r.text}`.slice(0, 500));
    return rows.length ? rows.join('\n') : `(no "${VAULT}" vault memory matched)`;
  }
  if (name === 'memory_context') {
    const out = await core(['mem', 'context', String(args.topic || ''), '--vault', VAULT, '--json']);
    const data = JSON.parse(out);
    return data.context || `(no "${VAULT}" vault memory matched)`;
  }
  if (name === 'remember') {
    const text = String(args.text || '').trim();
    if (text.length < 2) throw new Error('text required');
    await gatewayPost('/api/capture/remember', { text, source: 'mcp' });
    return 'Saved to the Vodou capture lane — it will be distilled into memory.';
  }
  throw new Error(`unknown tool: ${name}`);
}

// ── Newline-delimited JSON-RPC over stdio ─────────────────────────────────────
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'vodou-memory', version: '0.1.0' },
    } });
    return;
  }
  if (method === 'notifications/initialized' || String(method || '').startsWith('notifications/')) return;
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    pending++;
    try {
      const text = await callTool(params?.name, params?.arguments || {});
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true } });
    } finally {
      pending--;
      maybeExit();
    }
    return;
  }
  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});

// Exit only once stdin is closed AND every in-flight tool call has replied —
// a hard exit on 'close' would kill piped one-shot sessions mid-call.
let pending = 0;
let stdinClosed = false;
function maybeExit() {
  if (stdinClosed && pending === 0) process.exit(0);
}
rl.on('close', () => { stdinClosed = true; maybeExit(); });
