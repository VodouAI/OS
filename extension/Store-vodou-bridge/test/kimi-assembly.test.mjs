// Kimi block-assembly tests.
// Run: node --test extension/Store-vodou-bridge/test/kimi-assembly.test.mjs
//
// The store build deliberately does NOT expose window.__vodouNetCapParsers (that
// export handed ~30 parser functions to every page it ran on), so these tests
// cannot use the sideload build's harness. Instead the assembler is lifted out of
// inject.js by source and evaluated in isolation — which also keeps the test
// honest: it exercises the shipped text, not a copy that can drift.
//
// What is under test is the one decision that determines whether a captured reply
// is the answer or a fragment of it: whether a block frame's content REPLACES what
// has accumulated or is APPENDED to it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../inject.js', import.meta.url), 'utf8');

function grab(startRe, endMarker) {
  const i = src.search(startRe);
  assert.ok(i >= 0, 'could not find ' + startRe + ' in inject.js');
  const j = src.indexOf(endMarker, i);
  assert.ok(j >= 0, 'could not find end of ' + startRe);
  return src.slice(i, j + endMarker.length);
}

const ctx = vm.createContext({ console });
vm.runInContext(
  grab(/ {2}function scanJsonObjects/, '\n  }') + '\n' +
  grab(/ {2}const KIMI_SKIP_FIELDS/, '\n') + '\n' +
  grab(/ {2}function kimiAssembleBlocks/, '\n  }') + '\n' +
  'globalThis.scanJsonObjects = scanJsonObjects;' +
  'globalThis.kimiAssembleBlocks = kimiAssembleBlocks;',
  ctx,
);

const REPLY =
  'I only know what was saved from our earlier conversation: that a "Vodou" system ' +
  'was described to Kimi on 26 July 2026, with canary code of the kind you provide.';

const chunk = (text, size) => {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
};

// `mode` is what the content IS (delta vs cumulative); `op` is what the frame CLAIMS.
// They are independent on purpose — the failure being guarded is a wire that sends
// deltas without labelling them 'append'.
function body({ op, mode, size = 6, roleLabel = null, stale = false, field = 'text' }) {
  const frames = [
    { chat: { id: 'chat-abc' } },
    { message: { id: 'chat-abc', role: 'system' } },
    { message: { id: 'msg-777', ...(roleLabel ? { role: roleLabel } : {}) } },
  ];
  const chunks = chunk(REPLY, size);
  let acc = '';
  let half = '';
  chunks.forEach((d, i) => {
    acc += d;
    if (i === Math.floor(chunks.length / 2)) half = acc;
    const f = { block: { id: '2', messageId: 'msg-777', [field]: { content: mode === 'delta' ? d : acc } } };
    if (op) f.op = op;
    frames.push(f);
    if (stale && i === chunks.length - 1 && half) {
      const f2 = { block: { id: '2', messageId: 'msg-777', [field]: { content: half } } };
      if (op) f2.op = op;
      frames.push(f2);
    }
  });
  return frames.map((f) => JSON.stringify(f)).join('\n');
}

const assemble = (b) => [...ctx.kimiAssembleBlocks(ctx.scanJsonObjects(b)).values()].join('');

test('op:append + deltas — the documented wire', () => {
  assert.equal(assemble(body({ op: 'append', mode: 'delta', roleLabel: 'assistant' })), REPLY);
});

test('op:set + cumulative snapshots', () => {
  assert.equal(assemble(body({ op: 'set', mode: 'cumulative', roleLabel: 'assistant' })), REPLY);
});

// The 2026-07-31 live failure. Before the shape-based rule this returned a single
// delta per block, and the spliced result was stored as a successful capture.
test('unlabelled deltas still assemble in full', () => {
  assert.equal(assemble(body({ op: null, mode: 'delta' })), REPLY);
});

test('unlabelled deltas of uneven size assemble in full', () => {
  assert.equal(assemble(body({ op: null, mode: 'delta', size: 17 })), REPLY);
});

test('a frame labelled set that actually carries a delta', () => {
  assert.equal(assemble(body({ op: 'set', mode: 'delta', roleLabel: 'assistant' })), REPLY);
});

// Order-independence: a replayed earlier snapshot must never shorten the answer.
test('a stale re-send of an earlier snapshot does not shrink the reply', () => {
  assert.equal(assemble(body({ op: null, mode: 'cumulative', stale: true })), REPLY);
});

// ── Frame scanning over Connect/gRPC length prefixes ────────────────────────
// Each frame is preceded by a flag byte and a 4-byte big-endian length, and those
// bytes are DATA: a length of 123 emits '{', 125 emits '}'. A stray '{' opens an
// object that a later stray '}' closes, and the scanner used to jump past the whole
// balanced-but-unparseable span — discarding every real frame inside it.
//
// Measured on kimi.com 2026-07-31: 82% byte coverage and a single swallowed span of
// 10,459 bytes, which is why replies arrived as coherent runs with the middles gone.
const prefix = (len) =>
  String.fromCharCode(0, (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255);
const tokFrame = (n) => JSON.stringify({ op: 'append', block: { id: '4', text: { content: 'tok' + n + ' ' } } });

function framedBody(lengthFor) {
  let s = '';
  for (let n = 0; n < 60; n++) s += prefix(lengthFor(n, tokFrame(n).length)) + tokFrame(n);
  return s;
}
const scanned = (s) => ctx.scanJsonObjects(s)
  .filter((f) => f.block && f.block.text)
  .map((f) => f.block.text.content).join('');
const allToks = [...Array(60).keys()].map((n) => 'tok' + n + ' ').join('');

test('length prefixes that are ordinary bytes do not lose frames', () => {
  assert.equal(scanned(framedBody((n, len) => len)), allToks);
});

// The real failure. Before the fix this returned 30 of 60 frames with tokens 10-39
// missing as one contiguous run — the same splice shape seen in the stored replies.
test("a '{' length byte closed by a later '}' length byte swallows nothing", () => {
  const body = framedBody((n, len) => (n === 10 ? 123 : n === 40 ? 125 : len));
  assert.equal(scanned(body), allToks);
});

test('several swallowing prefix pairs across one body all recover', () => {
  const body = framedBody((n, len) => (n % 20 === 10 ? 123 : n % 20 === 15 ? 125 : len));
  assert.equal(scanned(body), allToks);
});

// Reasoning must not ride along into memory as though it were the reply.
test('think blocks are excluded from the assembled text', () => {
  const b = body({ op: 'append', mode: 'delta', roleLabel: 'assistant', field: 'think' });
  assert.equal(assemble(b), '');
});

// The census walks every block frame to total string bytes by key path. It runs on
// EVERY successful Kimi capture, so a shape it cannot handle would break capture
// rather than diagnose it — the exact inversion a diagnostic must never cause.
test('the census survives exotic block shapes without disturbing the turns', async () => {
  const { loadParsers } = await import('./parser-harness.mjs');
  const P = loadParsers(new URL('../inject.js', import.meta.url));

  const frames = [
    { chat: { id: 'chat-1' } },
    { message: { id: 'msg-9' } },
    { op: 'append', block: { id: '1', messageId: 'msg-9', text: { content: 'the answer' } } },
    // Shapes the adapter does not read: nested, arrayed, null, and self-referential
    // depth. The walk is depth-capped, so none of these may throw or hang.
    { op: 'append', block: { id: '1', messageId: 'msg-9', segment: { markdown: '**bold**' } } },
    { op: 'append', block: { id: '1', messageId: 'msg-9', spans: [{ text: ' span' }, null] } },
    { op: 'append', block: { id: '1', messageId: 'msg-9', deep: { a: { b: { c: { d: { e: { f: 'far' } } } } } } } },
    { op: 'append', block: { id: '1', messageId: 'msg-9', nothing: null } },
  ];
  const req = JSON.stringify({ message: { role: 'user', blocks: [{ text: { content: 'q' } }] } });
  const out = P.parseKimi(frames.map((f) => JSON.stringify(f)).join('\n'), 'https://www.kimi.com/chat/chat-1', req);

  const wire = JSON.parse(JSON.stringify(out.turns));
  assert.deepEqual(wire, [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'the answer', id: 'msg-9' },
  ]);
});
