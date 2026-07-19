#!/usr/bin/env node
/**
 * Quick MCP stdio test for Vodou-LLM-router.
 *   node test-router.mjs              — run default tests (route_query x2 + get_capabilities)
 *   node test-router.mjs "your query" — route a single query and print the decision
 */
import { spawn } from 'child_process';

const customQuery = process.argv[2];
const ROUTE_REQUEST_ID = 2;

const router = spawn('node', ['dist/index.js'], {
  cwd: process.cwd(),
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buffer = '';
let exitTimer = null;

function exitSoon() {
  if (exitTimer) return;
  exitTimer = setTimeout(() => {
    router.kill();
    process.exit(0);
  }, 100);
}

router.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.result !== undefined) {
        const r = msg.result;
        if (r.content) {
          const text = r.content.find(c => c.type === 'text')?.text;
          if (text) console.log(text);
          else console.log(JSON.stringify(r, null, 2));
        } else console.log(JSON.stringify(r, null, 2));
        if (customQuery && msg.id === ROUTE_REQUEST_ID) exitSoon();
      }
      if (msg.error) {
        console.error('Error:', msg.error);
        if (customQuery && msg.id === ROUTE_REQUEST_ID) exitSoon();
      }
    } catch (e) {
      console.log(line);
    }
  }
});

function send(obj) {
  router.stdin.write(JSON.stringify(obj) + '\n');
}

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0.0' },
  },
});

if (customQuery) {
  setTimeout(() => {
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({
      jsonrpc: '2.0',
      id: ROUTE_REQUEST_ID,
      method: 'tools/call',
      params: { name: 'route_query', arguments: { query: customQuery } },
    });
  }, 500);
  setTimeout(() => { router.kill(); process.exit(0); }, 60000);
} else {
  setTimeout(() => {
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'route_query', arguments: { query: "What's my CPU usage?" } },
    });
  }, 500);
  setTimeout(() => {
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'route_query', arguments: { query: 'I want to think through the pros and cons of microservices vs monolith' } },
    });
  }, 2500);
  setTimeout(() => {
    send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'get_capabilities', arguments: { format: 'summary' } },
    });
  }, 5500);
  setTimeout(() => { router.kill(); process.exit(0); }, 8500);
}
