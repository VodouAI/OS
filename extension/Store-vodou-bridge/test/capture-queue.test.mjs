// Unit tests for the capture retry queue in background.js
// (PLAN-ENGINE-GATED-CAPTURE P0).
// Run: node --test extension/Store-vodou-bridge/test/capture-queue.test.mjs
//
// The queue exists because a captured turn used to be DROPPED whenever the bridge
// was down, and permanently: inject.js records a turn in `postedOnce` at send
// time, so the natural re-fetch that would have recovered it was suppressed as a
// duplicate of something that had never been stored.
//
// Same harness idea as parsers.test.mjs — evaluate the real shipped source against
// stubs rather than re-implementing it here, so these tests fail if the source
// drifts. We slice the queue block out of background.js (the rest of that file is
// a service worker that cannot be evaluated outside a worker) and hand it fakes
// for `chrome.storage.local` and the socket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const BG = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const START = '// ---------- Capture retry queue (PLAN-ENGINE-GATED-CAPTURE P0) ----------';
// Prefix only. This used to match the full banner including its parenthetical,
// so retiring the popup renamed the banner to "(in-page button)" and every test
// in this file failed with "queue block not found" — a comment edit reading as a
// broken retry queue.
const END = '// ---------- Capture trigger';

function harness() {
  const i = BG.indexOf(START);
  const j = BG.indexOf(END, i);
  assert.ok(i >= 0 && j > i, 'queue block not found in background.js');
  const store = {};
  const chrome = {
    storage: {
      local: {
        async get(k) { return k in store ? { [k]: store[k] } : {}; },
        async set(o) { Object.assign(store, o); },
      },
    },
  };
  const sent = [];
  const quiet = { log() {}, warn() {} };
  const body = 'let ws = null;\n' + BG.slice(i, j) +
    '\nreturn { queueCapture, flushCaptureQueue, readCaptureQueue, clearQueuedFor, unmarkInFlight, setWs: (v) => { ws = v; } };';
  const api = new Function('chrome', 'console', 'WebSocket', body)(chrome, quiet, { OPEN: 1 });
  return { api, store, sent, openSocket: { readyState: 1, send: (s) => sent.push(JSON.parse(s)) } };
}

const batch = (n, extra = {}) => ({
  provider: 'zai', conversationId: 'c' + n, url: 'https://chat.z.ai/c/c' + n,
  turns: [{ role: 'user', content: 'q' + n }], at: Date.now(), ...extra,
});

test('a batch survives being held', async () => {
  const h = harness();
  assert.equal(await h.api.queueCapture(batch(1)), true);
  const q = await h.api.readCaptureQueue();
  assert.equal(q.length, 1);
  assert.equal(q[0].turns[0].content, 'q1');
  assert.equal(q[0].url, 'https://chat.z.ai/c/c1');   // the feed link survives the round trip
});

test('concurrent holds do not clobber each other', async () => {
  // The read-modify-write is serialised by a promise chain. Without it, batches
  // queued in the same tick each read the same empty queue and the last write wins
  // — losing captures, which is the exact failure the queue exists to prevent.
  const h = harness();
  await Promise.all([1, 2, 3, 4, 5].map((n) => h.api.queueCapture(batch(n))));
  const q = await h.api.readCaptureQueue();
  assert.equal(q.length, 5);
  assert.deepEqual(q.map((x) => x.conversationId), ['c1', 'c2', 'c3', 'c4', 'c5']);
});

test('the queue is bounded by count, oldest dropped first', async () => {
  const h = harness();
  for (let n = 1; n <= 105; n++) await h.api.queueCapture(batch(n));
  const q = await h.api.readCaptureQueue();
  assert.equal(q.length, 100);
  assert.equal(q[0].conversationId, 'c6');     // the five oldest went
  assert.equal(q[99].conversationId, 'c105');  // the newest stayed
});

test('the queue is bounded by bytes', async () => {
  const h = harness();
  const fat = (n) => batch(n, { turns: [{ role: 'user', content: 'x'.repeat(300000) }] });
  for (let n = 1; n <= 6; n++) await h.api.queueCapture(fat(n));
  const q = await h.api.readCaptureQueue();
  assert.ok(JSON.stringify(q).length <= 1000000, 'queue exceeded its byte cap');
  assert.ok(q.length < 6, 'nothing was dropped despite the byte cap');
  assert.equal(q[q.length - 1].conversationId, 'c6'); // newest always kept
});

test('flush replays in order but keeps batches until they are acked', async () => {
  // capture_turn is fire-and-forget, so a replay can still be REFUSED. Dropping on
  // send lost exactly the turns this queue protects — reachable only once
  // enforcement made refusals possible.
  const h = harness();
  for (let n = 1; n <= 3; n++) await h.api.queueCapture(batch(n));
  h.api.setWs(h.openSocket);
  await h.api.flushCaptureQueue();
  assert.deepEqual(h.sent.map((m) => m.conversationId), ['c1', 'c2', 'c3']);
  assert.equal(h.sent[0].cmd, 'capture_turn');
  assert.equal(h.sent[0].url, 'https://chat.z.ai/c/c1');
  const q = await h.api.readCaptureQueue();
  assert.equal(q.length, 3, 'sent is not stored — nothing may be dropped before an ack');
  assert.ok(q.every((i) => i.sentAt), 'each sent batch should be marked in flight');
});

test('an ack removes the batches for that conversation', async () => {
  const h = harness();
  for (let n = 1; n <= 3; n++) await h.api.queueCapture(batch(n));
  h.api.setWs(h.openSocket);
  await h.api.flushCaptureQueue();
  await h.api.clearQueuedFor('c2');
  assert.deepEqual((await h.api.readCaptureQueue()).map((i) => i.conversationId), ['c1', 'c3']);
});

test('a refusal puts everything in flight back up for retry', async () => {
  const h = harness();
  await h.api.queueCapture(batch(1));
  h.api.setWs(h.openSocket);
  await h.api.flushCaptureQueue();
  assert.ok((await h.api.readCaptureQueue())[0].sentAt, 'precondition: in flight');
  await h.api.unmarkInFlight();
  const q = await h.api.readCaptureQueue();
  assert.equal(q.length, 1);
  assert.equal(q[0].sentAt, undefined, 'a refusal is not an ack');
  // …and it goes again on the next drain.
  h.sent.length = 0;
  await h.api.flushCaptureQueue();
  assert.deepEqual(h.sent.map((m) => m.conversationId), ['c1']);
});

test('an in-flight batch is not resent every drain', async () => {
  const h = harness();
  await h.api.queueCapture(batch(1));
  h.api.setWs(h.openSocket);
  await h.api.flushCaptureQueue();
  h.sent.length = 0;
  await h.api.flushCaptureQueue();   // heartbeat, 30s later
  assert.deepEqual(h.sent, [], 'must wait for the verdict rather than spam the gateway');
});

test('flush with no socket keeps everything', async () => {
  const h = harness();
  await h.api.queueCapture(batch(1));
  await h.api.flushCaptureQueue();            // ws is still null
  assert.equal((await h.api.readCaptureQueue()).length, 1);
});

test('a socket that dies mid-drain keeps everything, sent or not', async () => {
  const h = harness();
  for (let n = 1; n <= 3; n++) await h.api.queueCapture(batch(n));
  let calls = 0;
  h.api.setWs({ readyState: 1, send() { if (++calls > 1) throw new Error('closed'); h.sent.push({}); } });
  await h.api.flushCaptureQueue();
  const left = await h.api.readCaptureQueue();
  // c1 went out but was never acked, and the socket died before c2/c3 got out.
  // None of them are known-stored, so none may be dropped.
  assert.deepEqual(left.map((x) => x.conversationId), ['c1', 'c2', 'c3']);
  assert.ok(left[0].sentAt, 'c1 is in flight');
  assert.equal(left[1].sentAt, undefined, 'c2 never left');
});

test('stale batches are dropped rather than replayed', async () => {
  // The gateway's fallback dedup (no provider message id) is time-bucketed, so a
  // day-old resend can no longer be recognised as the same turn — replaying it
  // would duplicate rather than restore.
  const h = harness();
  await h.api.queueCapture(batch(1, { at: Date.now() - 25 * 60 * 60 * 1000 }));
  await h.api.queueCapture(batch(2));
  h.api.setWs(h.openSocket);
  await h.api.flushCaptureQueue();
  assert.deepEqual(h.sent.map((m) => m.conversationId), ['c2']);
  const q = await h.api.readCaptureQueue();
  assert.deepEqual(q.map((i) => i.conversationId), ['c2'], 'the stale one is gone; the sent one waits for its ack');
});

test('a storage failure reports false rather than pretending to hold', async () => {
  const h = harness();
  const i = BG.indexOf(START), j = BG.indexOf(END, i);
  const broken = new Function('chrome', 'console', 'WebSocket',
    'let ws = null;\n' + BG.slice(i, j) + '\nreturn { queueCapture };')(
    { storage: { local: { async get() { return {}; }, async set() { throw new Error('QUOTA_BYTES'); } } } },
    { log() {}, warn() {} }, { OPEN: 1 });
  assert.equal(await broken.queueCapture(batch(1)), false);
});
