// PLAN-INJECT-RECEIPT-UI — the label the user actually reads.
//
// The receipt is the product claim made visible: a retrieve-and-paste product has
// nothing to put here because it never did anything. So the wording rules matter as
// much as the plumbing, and the one that matters most is the SILENT case — a turn
// that used nothing must produce no badge at all, never "0 memories", which reads as
// a failure at exactly the moment the feature is meant to prove competence.
//
// receiptLabel lives inside content.js's IIFE (not exported — it renders onto
// third-party pages), so this test extracts the function source and evaluates it in
// isolation rather than loading the whole content script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = path.join(HERE, '..', 'content.js');

function loadReceiptLabel() {
  const src = fs.readFileSync(CONTENT, 'utf8');
  const start = src.indexOf('function receiptLabel(');
  assert.ok(start > 0, 'receiptLabel not found in content.js — did it get renamed?');
  // Walk braces to the function's end so the extraction survives edits above/below.
  let depth = 0, i = src.indexOf('{', start), end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > 0, 'could not find the end of receiptLabel');
  return new Function(`${src.slice(start, end)}; return receiptLabel;`)();
}

const receiptLabel = loadReceiptLabel();

test('silent when the turn used nothing — no badge, never "0 memories"', () => {
  assert.equal(receiptLabel(null), '');
  assert.equal(receiptLabel(undefined), '');
  assert.equal(receiptLabel({ memories: { used: 0 }, tools: [], skills: [] }), '');
});

test('the money frame: memories · tools · skills', () => {
  assert.equal(
    receiptLabel({ memories: { used: 4 }, tools: ['a', 'b'], skills: ['weekly-brief'] }),
    '4 memories · 2 tools · 1 skill',
  );
});

test('singular vs plural on every axis', () => {
  assert.equal(receiptLabel({ memories: { used: 1 }, tools: ['a'], skills: ['s'] }),
    '1 memory · 1 tool · 1 skill');
  assert.equal(receiptLabel({ memories: { used: 2 }, tools: ['a', 'b'], skills: ['s', 't'] }),
    '2 memories · 2 tools · 2 skills');
});

test('zero segments are omitted, not printed as 0', () => {
  assert.equal(receiptLabel({ memories: { used: 3 }, tools: [], skills: [] }), '3 memories');
  assert.equal(receiptLabel({ memories: { used: 0 }, tools: ['x'], skills: [] }), '1 tool');
  assert.equal(receiptLabel({ memories: { used: 0 }, tools: [], skills: ['s'] }), '1 skill');
});

test('a malformed receipt degrades to silence rather than throwing on a live page', () => {
  assert.equal(receiptLabel({}), '');
  assert.equal(receiptLabel({ memories: null, tools: null, skills: null }), '');
  assert.equal(receiptLabel({ memories: { used: 2 }, tools: 'not-an-array' }), '2 memories');
});
