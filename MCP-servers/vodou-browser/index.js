#!/usr/bin/env node
// vodou-browser — PLAN-MEMORY-ON-EVERY-PAGE P7.
//
// The Vodou Bridge extension's packaged page tools, exposed as an MCP server so
// the brain, skills, AGENT_ACTIONS and `./vodou-core call vodou-browser <tool>`
// can read and act on the page the user is looking at — through the gateway
// (POST /api/vbb/tool), which relays to the extension over the bridge, which
// enforces per-site mode + access and writes a receipt to the panel's Activity
// tab. Nothing here touches Chrome directly.
//
// Deliberately dependency-free (JSON-RPC 2.0 over stdio, the MCP framing):
// MCP-servers/* dirs ship prebuilt node_modules and must never be npm-installed
// by name (see CLAUDE.md), and this server needs nothing but fetch.
'use strict';
const readline = require('node:readline');

const GATEWAY = (process.env.VODOU_GATEWAY_URL || process.env.VODOU_WEB_URL || 'http://127.0.0.1:8765').replace(/\/$/, '');
const SERVER_INFO = { name: 'vodou-browser', version: '0.1.0' };

const STATIC_TOOLS = [
  { name: 'tabs_list', description: 'List open http(s) browser tabs (id, url, title, active) in the user\'s Chrome (via the Vodou Bridge extension).', inputSchema: { type: 'object', properties: {} } },
  { name: 'tabs_open', description: 'Open a URL in a new browser tab; returns its tabId.', inputSchema: { type: 'object', properties: { url: { type: 'string' }, active: { type: 'boolean' } }, required: ['url'] } },
  { name: 'tabs_activate', description: 'Bring a browser tab to the front.', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] } },
  { name: 'page_read', description: 'Readable text of the page the user is looking at (or tabId). Requires that Vodou has access to that page (declared AI site, a site the user enabled, or a page the user right-clicked Vodou on).', inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, maxChars: { type: 'number' } } } },
  { name: 'page_model', description: 'The form model of the page: fillable fields with id, label, name, type, options. Never password/payment/code fields, never current values.', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } } },
  { name: 'page_insert', description: 'Insert text into the page\'s text box (focused editable, else the largest visible one). Never sends or submits.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, tabId: { type: 'number' } }, required: ['text'] } },
  { name: 'page_fill', description: 'Write values into form fields (by id/sel from page_model). Never submits.', inputSchema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, sel: { type: 'string' }, value: { type: 'string' } } } }, tabId: { type: 'number' } }, required: ['items'] } },
  { name: 'page_find', description: 'Find text on the page, scroll to it, return a snippet.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, tabId: { type: 'number' } }, required: ['text'] } },
  { name: 'page_save', description: 'File the page into the user\'s Vodou Library.', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } } },
];

async function gatewayTools() {
  try {
    const r = await fetch(GATEWAY + '/api/vbb/tools');
    const d = await r.json();
    if (r.ok && d && d.ok && Array.isArray(d.tools) && d.tools.length) return d.tools;
  } catch (_) { /* bridge down — advertise the static catalogue */ }
  return STATIC_TOOLS;
}

async function callTool(name, args) {
  const r = await fetch(GATEWAY + '/api/vbb/tool', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: name, args: args || {} }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d || !d.ok) {
    const why = (d && d.error) || ('HTTP ' + r.status);
    return { content: [{ type: 'text', text: `vodou-browser ${name} failed: ${why}` }], isError: true };
  }
  const res = d.result;
  const text = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
  return { content: [{ type: 'text', text }] };
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

// In-flight bookkeeping: stdin may close while a tool call is still awaiting
// the gateway; exit only when the pipeline has drained.
let inflight = 0; let ended = false;
const maybeExit = () => { if (ended && inflight === 0) process.exit(0); };
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  inflight++;
  try { await handle(msg); } finally { inflight--; maybeExit(); }
});
async function handle(msg) {
  const { id, method, params } = msg || {};
  const reply = (result) => { if (id !== undefined) send({ jsonrpc: '2.0', id, result }); };
  const fail = (code, message) => { if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code, message } }); };
  try {
    switch (method) {
      case 'initialize':
        reply({ protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: SERVER_INFO });
        break;
      case 'notifications/initialized':
      case 'initialized':
        break;                                     // notification — no reply
      case 'ping':
        reply({});
        break;
      case 'tools/list':
        reply({ tools: await gatewayTools() });
        break;
      case 'tools/call': {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        if (!name) { fail(-32602, 'tool name is required'); break; }
        reply(await callTool(String(name), args));
        break;
      }
      case 'resources/list': reply({ resources: [] }); break;
      case 'prompts/list': reply({ prompts: [] }); break;
      default:
        if (id !== undefined) fail(-32601, `method not found: ${method}`);
    }
  } catch (e) {
    fail(-32603, (e && e.message) || String(e));
  }
}
process.stdin.on('end', () => { ended = true; maybeExit(); });
console.error('[vodou-browser] MCP server on stdio → ' + GATEWAY + ' (Vodou Bridge tools)');
