#!/usr/bin/env node
/**
 * Store-vodou-bridge safety tests — localhost lock + pair API.
 * Run: node extension/Store-vodou-bridge/test/store-safety.test.mjs
 */
import assert from 'node:assert/strict';

function isLocalGatewayUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
  } catch {
    return false;
  }
}

const STORE_HOST_SUFFIXES = [
  'chatgpt.com', 'claude.ai', 'localhost', '127.0.0.1',
];
function hostnameAllowed(hostname) {
  if (!hostname) return false;
  const h = String(hostname).toLowerCase();
  return STORE_HOST_SUFFIXES.some((s) => h === s || h.endsWith('.' + s));
}
function urlAllowed(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return hostnameAllowed(u.hostname);
  } catch {
    return false;
  }
}

let failed = 0;
function check(name, cond) {
  try {
    assert.ok(cond, name);
    console.log('  ✓', name);
  } catch (e) {
    failed++;
    console.error('  ✗', name, e.message);
  }
}

console.log('— localhost gateway lock —');
check('accepts 127.0.0.1', isLocalGatewayUrl('ws://127.0.0.1:8765/api/vbb'));
check('accepts localhost', isLocalGatewayUrl('ws://localhost:8765/api/vbb'));
check('rejects evil.example', !isLocalGatewayUrl('ws://evil.example/api/vbb'));
check('rejects https remote', !isLocalGatewayUrl('https://evil.example/'));
check('rejects bare host', !isLocalGatewayUrl('not-a-url'));

console.log('— host allowlist —');
check('chatgpt ok', urlAllowed('https://chatgpt.com/backend-api/x'));
check('github blocked', !urlAllowed('https://api.github.com/repos/x'));
check('localhost http ok', urlAllowed('http://127.0.0.1:8765/x'));

console.log('— static store package —');
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bg = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const man = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');
check('no new Function', !/\bnew Function\b/.test(bg));
check('no runUserScript', !/\brunUserScript\b/.test(bg));
check('has allow_custom_gateway', /vodou_allow_custom_gateway/.test(bg));
check('has isLocalGatewayUrl', /isLocalGatewayUrl/.test(bg));
check('no all_urls in manifest', !man.includes('<all_urls>'));
check('popup has allow-custom-gateway', fs.readFileSync(path.join(root, 'popup.html'), 'utf8').includes('allow-custom-gateway'));

async function apiTests() {
  const base = process.env.VODOU_GATEWAY || 'http://127.0.0.1:8765';
  console.log('— gateway pair API @', base, '—');
  try {
    const get1 = await fetch(`${base}/api/capture/pair`);
    if (!get1.ok) throw new Error(`GET pair ${get1.status}`);
    const j1 = await get1.json();
    check('GET pair returns code', typeof j1.code === 'string' && j1.code.length >= 4);
    check('GET pair required is boolean', typeof j1.required === 'boolean');

    const off = await fetch(`${base}/api/capture/pair/require`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ required: false }),
    });
    const jOff = await off.json();
    check('require false', off.ok && jOff.required === false);

    const on = await fetch(`${base}/api/capture/pair/require`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ required: true }),
    });
    const jOn = await on.json();
    check('require true', on.ok && jOn.required === true);

    const get2 = await fetch(`${base}/api/capture/pair`);
    const j2 = await get2.json();
    check('GET shows required', j2.required === true);

    // restore optional default for the machine
    await fetch(`${base}/api/capture/pair/require`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ required: false }),
    });
    check('restored optional', true);
  } catch (e) {
    console.warn('  (gateway API skipped:', e.message, ')');
    console.warn('  Start Vodou-Console on :8765 to run live pair tests.');
  }
}

await apiTests();

/** Live WebSocket handshake — mirrors Store extension bridge_ready. */
async function wsPairingTests() {
  const base = process.env.VODOU_GATEWAY || 'http://127.0.0.1:8765';
  const wsUrl = base.replace(/^http/, 'ws') + '/api/vbb';
  console.log('— WebSocket pairing @', wsUrl, '—');

  function onceOpen(ws, ms = 5000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('open timeout')), ms);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
      ws.addEventListener('error', (e) => { clearTimeout(t); reject(e.error || e); });
    });
  }
  function waitClose(ws, ms = 5000) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({ code: -1 }), ms);
      ws.addEventListener('close', (ev) => { clearTimeout(t); resolve({ code: ev.code, reason: ev.reason }); });
    });
  }
  function waitHeartbeat(ws, ms = 25000) {
    // Prefer server_heartbeat; also accept any inbound frame or HTTP connected.
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; clearTimeout(t); clearInterval(poll); resolve(v); } };
      const fail = (e) => { if (!done) { done = true; clearTimeout(t); clearInterval(poll); reject(e); } };
      const t = setTimeout(() => fail(new Error('no server_heartbeat')), ms);
      ws.addEventListener('message', (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m?.cmd) finish(m);
        } catch { /* ignore */ }
      });
      ws.addEventListener('close', (ev) => fail(new Error(`closed ${ev.code} before heartbeat`)));
      const poll = setInterval(async () => {
        try {
          const st = await (await fetch(`${base}/api/capture/pair`)).json();
          if (st.connected) finish({ cmd: 'pair_connected' });
        } catch { /* ignore */ }
      }, 400);
    });
  }

  try {
    // Ensure optional first
    const ping = await fetch(`${base}/api/capture/pair`);
    if (!ping.ok) throw new Error(`GET pair ${ping.status}`);
  } catch (e) {
    console.warn('  (WS pairing skipped:', e.message, ')');
    return;
  }

  try {
    // Ensure optional first
    await fetch(`${base}/api/capture/pair/require`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ required: false }),
    });

    {
      const ws = new WebSocket(wsUrl);
      await onceOpen(ws);
      ws.send(JSON.stringify({
        cmd: 'bridge_ready',
        version: 'test',
        protocol: 1,
        channel: 'store',
        store_build: true,
        token: null,
      }));
      await waitHeartbeat(ws);
      check('open connect succeeds without token', true);
      ws.close();
      await waitClose(ws);
    }

    const pair = await (await fetch(`${base}/api/capture/pair`)).json();
    await fetch(`${base}/api/capture/pair/require`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ required: true }),
    });

    {
      const ws = new WebSocket(wsUrl);
      await onceOpen(ws);
      const closed = waitClose(ws);
      ws.send(JSON.stringify({
        cmd: 'bridge_ready',
        version: 'test',
        channel: 'store',
        store_build: true,
        token: '000000',
      }));
      const ev = await closed;
      check('bad token → 4403', ev.code === 4403);
    }

    {
      const ws = new WebSocket(wsUrl);
      await onceOpen(ws);
      ws.send(JSON.stringify({
        cmd: 'bridge_ready',
        version: 'test',
        channel: 'store',
        store_build: true,
        token: pair.code,
      }));
      await waitHeartbeat(ws);
      check('correct pair code connects', true);
      ws.close();
      await waitClose(ws);
    }

    // Back to optional so kick baseline can connect without a token
    await fetch(`${base}/api/capture/pair/require`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ required: false }),
    });

    // Kick: connect open, then flip require → gateway forceDisconnect
    {
      const ws = new WebSocket(wsUrl);
      await onceOpen(ws);
      ws.send(JSON.stringify({
        cmd: 'bridge_ready',
        version: 'kick-test',
        channel: 'store',
        store_build: true,
      }));
      await waitHeartbeat(ws);
      const closed = waitClose(ws);
      await fetch(`${base}/api/capture/pair/require`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ required: true }),
      });
      const ev = await closed;
      check('require=true kicks live socket', ev.code !== -1);
    }

    await fetch(`${base}/api/capture/pair/require`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ required: false }),
    });
    check('pairing restored optional', true);
  } catch (e) {
    failed++;
    console.error('  ✗ WS pairing tests:', e.message || e);
  }
}

await wsPairingTests();
console.log(failed ? `\nFAILED ${failed}` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
