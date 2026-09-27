// capture-heartbeat.js — the per-site tallies that ride on bridge_health.
// PLAN-CAPTURE-GRADED-PER-SITE P1/P3.
//
// Two things are pinned here, and the second is the one that matters:
//
//   1. The accumulator itself: keyed by the sites.js `capture` name, drains to
//      null when nothing happened (so an idle worker adds nothing to the frame),
//      and resets on drain.
//   2. The page shim REPORTS a miss. inject.js already breadcrumbed "no adapter
//      matched a chat-looking request" and "adapter matched, parsed zero turns"
//      to the console, where nobody reads them. P3 turns those two lines into
//      messages the worker can count. This test drives emit() with a fake
//      request in the parser harness and asserts the miss message is posted —
//      the drift-fixture proof the plan's P3 gate asks for, without a browser.
//
// Run: node --test extension/Store-vodou-bridge/test/capture-heartbeat.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadInjectWithWindow } from './parser-harness.mjs';

const SITES = fs.readFileSync(new URL('../sites.js', import.meta.url), 'utf8');
const HB = fs.readFileSync(new URL('../capture-heartbeat.js', import.meta.url), 'utf8');
const BG = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const CONTENT = fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8');

function fresh() {
  const ctx = { globalThis: null };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SITES, ctx);
  vm.runInContext(HB, ctx);
  return ctx.VodouCaptureHeartbeat;
}

test('resolves a hostname to the capture name, not the key, for the six that differ', () => {
  const H = fresh();
  assert.equal(H.siteFor('chat.mistral.ai'), 'lechat');
  assert.equal(H.siteFor('duck.ai'), 'duckai');
  assert.equal(H.siteFor('chatgpt.com'), 'chatgpt');
  assert.equal(H.siteFor('example.com'), null, 'an unsupported host is null, never a guess');
});

test('drains to null when nothing happened, and resets after a drain', () => {
  const H = fresh();
  assert.equal(H.drain(), null);
  H.noteVisited('chatgpt');
  H.noteSeen('chatgpt', 2);
  H.noteStored('chatgpt', 2);
  const first = H.drain();
  // The cell was created inside a vm context, so its Object prototype is that
  // realm's; strict deepEqual compares prototypes. Compare the data.
  assert.deepEqual(JSON.parse(JSON.stringify(first.chatgpt)), {
    visited: 1, turns_seen: 2, turns_stored: 2, miss_unmatched: 0, miss_empty: 0, matched_sig: '', miss_sig: '', disabled: 0,
  });
  assert.equal(H.drain(), null, 'the second drain must be empty — the worker sends deltas, the gateway sums');
});

test('a miss counts by kind and keeps only a short endpoint signature', () => {
  const H = fresh();
  H.noteVisited('perplexity');
  H.noteMiss('perplexity', 'unmatched', '/rest/sse/' + 'x'.repeat(400));
  H.noteMiss('perplexity', 'empty', '/rest/sse/perplexity_ask');
  const d = H.drain();
  assert.equal(d.perplexity.miss_unmatched, 1);
  assert.equal(d.perplexity.miss_empty, 1);
  assert.ok(d.perplexity.miss_sig.length <= 200);
  assert.equal(d.perplexity.turns_seen, 0);
});

test('a blank site name is ignored rather than filed under ""', () => {
  const H = fresh();
  H.noteSeen('', 5);
  H.noteSeen(null, 5);
  assert.equal(H.drain(), null);
});

// ── P3: the page shim reports drift, it does not just log it ────────────────
test('inject.js posts a miss when a chat-looking request matches no adapter', () => {
  const posted = [];
  const { P } = loadInjectWithWindow(new URL('../inject.js', import.meta.url), {
    postMessage(m) { posted.push(m); },
    location: { href: 'https://www.perplexity.ai/search/x', hostname: 'www.perplexity.ai' },
  });
  // The nonce handshake gates postNetcap; hand the shim a nonce the way
  // bridge-nonce.js would, then drive the tap with an endpoint no adapter owns.
  P.__acceptNonce('test-nonce');
  P.emit('https://www.perplexity.ai/api/renamed-chat-endpoint', '{"nothing":true}', '');
  const miss = posted.find((m) => m && m.source === 'vodou-netcap-miss');
  assert.ok(miss, 'a chat-looking request with no adapter must post a vodou-netcap-miss message, not only a console line');
  assert.equal(miss.kind, 'unmatched');
  assert.equal(miss.nonce, 'test-nonce', 'the miss rides the same nonce as a capture, so content.js can trust it');
  assert.ok(!/\?/.test(miss.path), 'the signature is a path, never a query string');
});

test('inject.js posts an "empty" miss when an adapter matches and parses nothing', () => {
  const posted = [];
  const { P } = loadInjectWithWindow(new URL('../inject.js', import.meta.url), {
    postMessage(m) { posted.push(m); },
    location: { href: 'https://chatgpt.com/c/abc', hostname: 'chatgpt.com' },
  });
  P.__acceptNonce('test-nonce');
  // A real ChatGPT endpoint with a body the parser understands as "not a turn".
  P.emit('https://chatgpt.com/backend-api/conversation', 'data: {"v":"garbage"}\n\n', '{}');
  const miss = posted.find((m) => m && m.source === 'vodou-netcap-miss' && m.kind === 'empty');
  assert.ok(miss, 'a matched adapter that yields zero turns must report an "empty" miss');
  assert.equal(typeof miss.provider, 'string');
});

// ── The worker and the content script carry the signal, source-pinned ───────
test('content.js relays a nonce-checked miss to the worker', () => {
  assert.match(CONTENT, /vodou-netcap-miss/, 'content.js must listen for the miss message');
  assert.match(CONTENT, /net_capture_miss/, 'content.js must forward it as net_capture_miss');
});

test('background.js counts seen, stored, visited and misses, and drains onto bridge_health', () => {
  assert.match(BG, /import '\.\/capture-heartbeat\.js'/, 'the accumulator must be a static import, like sites.js');
  assert.match(BG, /VodouCaptureHeartbeat\.noteSeen\(/);
  assert.match(BG, /VodouCaptureHeartbeat\.noteStored\(/);
  assert.match(BG, /VodouCaptureHeartbeat\.noteVisited\(/);
  assert.match(BG, /VodouCaptureHeartbeat\.noteMiss\(/);
  assert.match(BG, /VodouCaptureHeartbeat\.drain\(\)/, 'bridge_health must carry the drained tallies');
});
