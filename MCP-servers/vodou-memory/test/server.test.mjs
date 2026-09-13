/**
 * MS-8 — `vodou-memory` ships, is default-active, and had zero tests.
 *
 * It is the surface any MCP-capable client (Cursor, Copilot, JetBrains,
 * Windsurf, Zed, Claude Desktop) uses to read the user's memory, so the thing
 * worth pinning is not that it answers — it is the DISCLOSURE INVARIANT its own
 * header states: the vault is fixed at LAUNCH (`--vault` / VODOU_MEMORY_VAULT)
 * and is not a tool argument, so a prompt-injected agent cannot ask for a
 * different one. That claim is a comment until something checks it.
 *
 * Driven over real stdio JSON-RPC, not by importing internals: this is a
 * protocol server, and a test that calls its functions proves nothing about the
 * protocol (curl-is-not-a-client, applied to ourselves). `vodou-core` is stubbed
 * with a script that records its argv, so the test can see WHICH vault was
 * actually passed rather than trusting the code path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js');

/** A project root whose `vodou-core` records argv and prints a canned result. */
function stubRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'vodou-memory-test-'));
  const log = path.join(root, 'argv.log');
  writeFileSync(path.join(root, 'vodou-core'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n` +
    `echo '{"results":[{"score":0.9,"text":"a remembered fact"}],"context":"ctx"}'\n`);
  chmodSync(path.join(root, 'vodou-core'), 0o755);
  return { root, log };
}

/** Send `requests` to a fresh server and collect its replies. */
function rpc(requests, { vault, root } = {}) {
  return new Promise((resolve, reject) => {
    const args = vault ? ['--vault', vault] : [];
    const child = spawn(process.execPath, [SERVER, ...args], {
      env: { ...process.env, VODOU_PROJECT_PATH: root, WEB_PORT: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', reject);
    child.on('close', () => {
      resolve(out.split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    });
    for (const r of requests) child.stdin.write(JSON.stringify(r) + '\n');
    child.stdin.end();
    setTimeout(() => child.kill('SIGKILL'), 8000).unref?.();
  });
}

test('speaks the MCP handshake and lists exactly its three tools', async () => {
  const { root } = stubRoot();
  const replies = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ], { root });
  const init = replies.find((r) => r.id === 1);
  assert.ok(init?.result, 'initialize must return a result');
  const list = replies.find((r) => r.id === 2);
  const names = (list.result.tools || []).map((t) => t.name).sort();
  assert.deepEqual(names, ['entities_lookup', 'memory_context', 'memory_search', 'remember']);
});

test('no tool accepts a vault argument — the invariant, not the comment', async () => {
  const { root } = stubRoot();
  const [, list] = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ], { root });
  for (const t of list.result.tools) {
    const props = Object.keys(t.inputSchema?.properties || {});
    assert.ok(!props.some((p) => /vault/i.test(p)),
      `${t.name} exposes a vault-shaped parameter (${props.join(',')}) — a prompt-injected agent could ask for another vault`);
  }
});

test('a vault passed as a tool argument is IGNORED; the launch vault is used', async () => {
  const { root, log } = stubRoot();
  await rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'memory_search', arguments: { query: 'x', vault: 'someone-elses-vault' } } },
  ], { vault: 'launch-vault', root });
  const argv = existsSync(log) ? readFileSync(log, 'utf8') : '';
  assert.match(argv, /--vault launch-vault/, 'the launch vault must be the one queried');
  assert.ok(!/someone-elses-vault/.test(argv), 'a vault from tool arguments reached vodou-core');
});

test('top_k is clamped to 1..20 rather than passed through', async () => {
  const { root, log } = stubRoot();
  await rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'memory_search', arguments: { query: 'x', top_k: 9999 } } },
  ], { vault: 'v', root });
  assert.match(readFileSync(log, 'utf8'), /--top-k 20/);
});

test('an unknown tool is an error reply, not a dead server', async () => {
  const { root } = stubRoot();
  const replies = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'rm_rf', arguments: {} } },
    { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
  ], { root });
  const bad = replies.find((r) => r.id === 2);
  assert.ok(bad, 'the bad call must be answered at all');
  // Still serving afterwards — one bad call must not take the session down.
  assert.ok(replies.find((r) => r.id === 3)?.result, 'server stopped answering after a bad tool');
});

test('a malformed line does not kill the session', async () => {
  const { root } = stubRoot();
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, VODOU_PROJECT_PATH: root, WEB_PORT: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stdin.write('{ this is not json\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }) + '\n');
  child.stdin.end();
  await new Promise((r) => child.on('close', r));
  const lines = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.find((l) => l.id === 7)?.result, 'a garbage line ended the session');
});
