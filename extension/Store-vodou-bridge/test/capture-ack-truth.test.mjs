// The capture ack must report what was WRITTEN, not what was handed over.
//
// Observed live 2026-08-09: re-opening a backfilled Claude thread re-sent all 4
// turns, the gateway wrote 0 (every turn collapsed on its provider id — dedup
// working exactly as designed), and the page console printed
// "4 turn(s) STORED by Vodou ✓". Nothing was stored.
//
// That is this codebase's recurring failure shape, already written down twice in
// these files: **a success message may only be printed by the layer that can
// observe the success.** The content script knows only that it relayed a batch;
// the insert count exists solely in the gateway's `capture_ack`, which used to
// stop at background.js. These tests pin the three links of that chain so the
// claim can't drift back to being a guess.
//
// Run: node --test extension/Store-vodou-bridge/test/capture-ack-truth.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const BG = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const CONTENT = fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const INJECT = fs.readFileSync(new URL('../inject.js', import.meta.url), 'utf8');

test('the page no longer claims "STORED" from the relay result', () => {
  assert.ok(
    !/turn\(s\) STORED by Vodou/.test(INJECT),
    'inject.js still prints "STORED by Vodou" on the relay ack — that is the claim no layer there can back up',
  );
  assert.ok(
    /relayed to Vodou/.test(INJECT),
    'the relay ack should say what it actually knows: the batch was relayed',
  );
});

test('background forwards the gateway\'s real insert count to the tab', () => {
  assert.ok(
    /vodou_capture_stored/.test(BG),
    'background.js must forward a vodou_capture_stored message when capture_ack lands',
  );
  // It must send the gateway's number, not the batch length.
  assert.ok(
    /stored:\s*Number\(msg\.stored\)/.test(BG),
    'the forwarded count must come from the gateway ack (msg.stored), not from the batch',
  );
});

test('background captures the batch BEFORE clearing it, or the tab id is gone', () => {
  // lastSentBatch is nulled inside the same handler; reading tabId afterwards
  // would always be null and the page would never be corrected.
  const i = BG.indexOf("msg.cmd === 'capture_ack'");
  assert.ok(i > 0, 'capture_ack handler not found');
  const block = BG.slice(i, i + 2000);
  const capture = block.indexOf('const ackedBatch = lastSentBatch');
  const clear = block.indexOf('lastSentBatch = null');
  assert.ok(capture >= 0, 'the batch must be captured into a local before it is cleared');
  assert.ok(capture < clear, 'the batch must be captured BEFORE lastSentBatch is nulled');
});

test('content script relays the write result to the page', () => {
  assert.ok(
    /vodou_capture_stored/.test(CONTENT) && /vodou-netcap-stored/.test(CONTENT),
    'content.js must translate vodou_capture_stored into a page message',
  );
});

test('the page distinguishes saved / partly-new / nothing-new', () => {
  assert.ok(/already had/.test(INJECT), 'a partly-deduped batch should say how many were already held');
  assert.ok(/nothing new/.test(INJECT), 'a fully-deduped batch should say nothing new, not report a failure');
});

test('stored=0 is not phrased as an error — dedup working must not read as breakage', () => {
  // Scope to the write-result branch ONLY. A slice by character count runs past it
  // into the relay-ack branch below, which warns legitimately on real failures —
  // and a guard that fires on the wrong code is worse than none, because it reports
  // safety it never checked.
  const i = INJECT.indexOf("d.source === 'vodou-netcap-stored'");
  assert.ok(i > 0, 'write-result branch not found');
  const end = INJECT.indexOf('return;', i);
  assert.ok(end > i, 'could not find the end of the write-result branch');
  const block = INJECT.slice(i, end);
  assert.ok(/nothing new/.test(block), 'sanity: the extracted block is the right one');
  assert.ok(
    !/console\.(warn|error)/.test(block),
    'the write-result branch must not warn: zero stored is the healthy re-open case',
  );
});
