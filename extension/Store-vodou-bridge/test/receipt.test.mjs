// PLAN-INJECT-RECEIPT-UI — the label the user actually reads.
//
// The receipt is the product claim made visible: a retrieve-and-paste product has
// nothing to put here because it never did anything. So the wording rules matter as
// much as the plumbing, and the one that matters most is the SILENT case — a turn
// that used nothing must produce no badge at all, never "0 memories", which reads as
// a failure at exactly the moment the feature is meant to prove competence.
//
// COHERENCE F8 — this used to extract `receiptLabel` out of content.js's IIFE and
// eval it, because the rules lived inside that file. They live in receipt.js now,
// shared with the panel, so the test loads the real module instead of a copy of it
// lifted out by a brace-walker. The extraction is not missed: it could only ever
// grade the copy it happened to reach.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

// The module assigns to globalThis (loaded by <script> in the panel and by a
// content_scripts entry on the page), so it is executed rather than imported.
new Function(fs.readFileSync(path.join(ROOT, 'receipt.js'), 'utf8'))();
const receiptLabel = (r) => globalThis.VodouReceipt.label(r);

// Both consumers must be READING it, or the module is a fourth copy rather than
// the only one. This is the assertion that would have caught the original F8.
test('the panel and the in-page toast both read the shared module', () => {
  const panel = fs.readFileSync(path.join(ROOT, 'sidepanel.js'), 'utf8');
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  assert.ok(panel.includes('VodouReceipt.parts('), 'the panel builds its own summary line again');
  assert.ok(content.includes('VodouReceipt.label('), 'the in-page toast builds its own label again');
  // The rule itself must not reappear anywhere but receipt.js. Matched on the
  // tool/skill axes rather than the memory one: "N memories" is a phrase the
  // panel legitimately writes in four unrelated places (a repair count, a
  // forget confirmation), and a guard that goes red on those teaches people to
  // ignore it. Only the receipt pluralises tools and skills.
  for (const [name, src] of [['sidepanel.js', panel], ['content.js', content]]) {
    for (const axis of ["'tool' : 'tools'", "'skill' : 'skills'"]) {
      assert.ok(
        !src.includes(axis),
        `${name} restates the receipt's ${axis} rule — a turn that describes itself two ways IS the finding`,
      );
    }
  }
});

// The manifest has to load it into the page bundle, or content.js throws on a
// live third-party site where nothing else would catch it.
test('receipt.js is loaded in both worlds', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const bundle = manifest.content_scripts[0].js;
  assert.ok(bundle.includes('receipt.js'), 'receipt.js missing from the content_scripts bundle');
  assert.ok(
    bundle.indexOf('receipt.js') < bundle.indexOf('content.js'),
    'receipt.js must load BEFORE content.js — content scripts run in listed order',
  );
  const html = fs.readFileSync(path.join(ROOT, 'sidepanel.html'), 'utf8');
  assert.ok(html.includes('src="receipt.js"'), 'receipt.js missing from sidepanel.html');
});

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
