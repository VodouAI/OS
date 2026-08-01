// PLAN-CAPTURE-FEED P2 — the generic model sniff.
//
// The plan assumed six adapters already parsed the model name. None did. Rather
// than write six per-provider parsers (six more wire formats to keep alive, and
// live payloads for only one of them), the sniff reads the keys providers
// actually use out of the body we already hold.
//
// The bar it has to clear: an ABSENT chip is honest, a WRONG one is not. These
// fixtures are taken from real payloads captured 2026-07-28, plus the shapes most
// likely to produce a false positive.
//
// Run: node --test extension/Store-vodou-bridge/test/model-sniff.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadParsers } from './parser-harness.mjs';

// inject.js no longer exports its parsers to the page (fdbee668) — the harness
// restores that seam inside the test process only.
const { sniffModel } = loadParsers(new URL('../inject.js', import.meta.url));

test('real ChatGPT stream metadata — captured 2026-07-28', () => {
  // Trimmed from an actual /backend-api/f/conversation SSE tail.
  const body = `data: {"type": "server_ste_metadata", "metadata": {"plan_type": "plus",
    "model_slug": "gpt-5-6-thinking", "default_model_slug": "gpt-5-6-thinking",
    "thinking_effort": "standard"}, "conversation_id": "6a68e7b4"}`;
  assert.equal(sniffModel(body), 'gpt-5-6-thinking');
});

test('real ChatGPT conversation snapshot — captured 2026-07-28', () => {
  const body = `{"title":"Vodou Capture Licence Risk","default_model_slug":"gpt-5-6-thinking",
    "mapping":{"x":{"message":{"metadata":{"model_slug":"gpt-5-6-thinking"}}}}}`;
  assert.equal(sniffModel(body), 'gpt-5-6-thinking');
});

test('the most-repeated model wins over a one-off mention', () => {
  // Streams repeat the RESOLVED model on many frames; a single mention is usually
  // the account default rather than what actually answered.
  const body = `{"default_model_slug":"gpt-4o",
    "a":{"model_slug":"gpt-5-6-thinking"},
    "b":{"model_slug":"gpt-5-6-thinking"},
    "c":{"model_slug":"gpt-5-6-thinking"}}`;
  assert.equal(sniffModel(body), 'gpt-5-6-thinking');
});

test('other providers\' key spellings', () => {
  assert.equal(sniffModel('{"model":"claude-sonnet-5"}'), 'claude-sonnet-5');
  assert.equal(sniffModel('{"model_id":"deepseek-chat"}'), 'deepseek-chat');
  assert.equal(sniffModel('{"modelName":"Qwen3-235B"}'), 'Qwen3-235B');
  assert.equal(sniffModel('{"model_name":"llama-4-maverick"}'), 'llama-4-maverick');
});

test('absent rather than wrong — nothing to find means null', () => {
  assert.equal(sniffModel('{"items":[],"cursor":null}'), null);
  assert.equal(sniffModel(''), null);
  assert.equal(sniffModel(null), null);
  assert.equal(sniffModel('not json at all'), null);
});

test('placeholders are not models', () => {
  // "auto" and "default" are what a provider sends when the USER has not chosen.
  for (const junk of ['auto', 'default', 'null', 'none', 'true', 'system', 'chat']) {
    assert.equal(sniffModel(`{"model":"${junk}"}`), null, `"${junk}" was accepted as a model`);
  }
});

test('a uuid in a model field is an id, not a model', () => {
  assert.equal(sniffModel('{"model":"6a68e7b4-c408-83ea-a391-46812eacc144"}'), null);
});

test('prose is not a model', () => {
  // Guards against matching a sentence that happens to sit under a "model" key.
  assert.equal(sniffModel('{"model":"the  model  answered  the  question"}'), null);
});

test('a huge body is skipped rather than scanned', () => {
  // Capture must never add measurable latency to someone\'s chat.
  const huge = '{"model":"gpt-5"}' + 'x'.repeat(2_100_000);
  assert.equal(sniffModel(huge), null);
});

test('repeated calls do not interfere — the regex is stateful', () => {
  // A /g regex carries lastIndex between calls; forgetting to reset it makes the
  // SECOND call on the same input return nothing.
  const body = '{"model_slug":"gpt-5-6-thinking"}';
  assert.equal(sniffModel(body), 'gpt-5-6-thinking');
  assert.equal(sniffModel(body), 'gpt-5-6-thinking', 'stateful regex leaked between calls');
});
