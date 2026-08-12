// The "your Vodou app is too old" sentence — the one an operator sees when the
// Chrome Web Store has pushed them a feature their desktop app does not have.
//
// This is not a cosmetic string. The store updates everyone at once and the
// desktop does not follow, so a raw "HTTP 404" is the single most likely failure
// for any feature we add here — and it reads as a broken extension rather than an
// app that needs updating. It lived inside background.js as libraryError() with
// "the Library" hardcoded into it; the moment the side panel needed the same
// sentence, a second copy was the obvious wrong answer.
//
// Run: node extension/Store-vodou-bridge/test/gateway-errors.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../gateway-errors.js', import.meta.url), 'utf8');
const BG = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const PANEL = fs.readFileSync(new URL('../sidepanel.js', import.meta.url), 'utf8');
const PANEL_HTML = fs.readFileSync(new URL('../sidepanel.html', import.meta.url), 'utf8');

/** Load the helper the way the two surfaces do: for its globalThis side effect. */
function load(fetchImpl) {
  const sandbox = { fetch: fetchImpl, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return sandbox.VodouGatewayError;
}

const okHealth = () => Promise.resolve({ ok: true });
const noHealth = () => Promise.reject(new Error('ECONNREFUSED'));

test('404 from a reachable gateway means the app is too old', async () => {
  const E = load(okHealth);
  const msg = await E.describe(new Error('HTTP 404'), 404, 'the Library', 'http://127.0.0.1:8765');
  assert.match(msg, /too old for the Library/);
  assert.match(msg, /update Vodou/);
});

test('the feature name is a parameter, not baked in', async () => {
  const E = load(okHealth);
  const msg = await E.describe(new Error('HTTP 404'), 404, 'document matching', 'http://127.0.0.1:8765');
  assert.match(msg, /too old for document matching/);
  assert.doesNotMatch(msg, /Library/);
});

test('404 with NOTHING answering /health does not tell the user to update', async () => {
  // Something else on :8765, or Vodou not running at all. "Update Vodou" would
  // send them to do a thing that cannot help.
  const E = load(noHealth);
  const msg = await E.describe(new Error('HTTP 404'), 404, 'the Library', 'http://127.0.0.1:8765');
  assert.doesNotMatch(msg, /too old/);
  assert.match(msg, /cannot reach Vodou/);
});

test('/health answering non-2xx is treated as not-Vodou', async () => {
  const E = load(() => Promise.resolve({ ok: false, status: 502 }));
  const msg = await E.describe(new Error('HTTP 404'), 404, 'the Library', 'http://127.0.0.1:8765');
  assert.match(msg, /cannot reach Vodou/);
});

test('501 is treated the same as 404', async () => {
  const E = load(okHealth);
  assert.equal(E.isMissingRoute(501), true);
  assert.equal(E.isMissingRoute(404), true);
});

test('statuses that are NOT about a missing route pass the real error through', async () => {
  const E = load(okHealth);
  for (const status of [400, 413, 500, 503, undefined]) {
    const msg = await E.describe(new Error('that URL is not a document'), status, 'the Library', 'http://x');
    assert.equal(msg, 'that URL is not a document', `status ${status} should pass through`);
  }
});

test('a non-Error rejection still yields a string, not "[object Object]" of nothing', async () => {
  const E = load(okHealth);
  assert.equal(await E.describe('plain string failure', 500, 'the Library', 'http://x'), 'plain string failure');
});

test('long messages are truncated so a toast cannot become a wall of text', async () => {
  const E = load(okHealth);
  const msg = await E.describe(new Error('x'.repeat(500)), 500, 'the Library', 'http://x');
  assert.equal(msg.length, 160);
});

// ── wiring: both surfaces must actually use it ──────────────────────────────

test('background.js no longer carries its own copy of the sentence', () => {
  assert.ok(!/function libraryError/.test(BG), 'libraryError() should be gone');
  assert.ok(!/too old for the Library/.test(BG), 'the sentence should live in gateway-errors.js only');
  assert.ok(/import '\.\/gateway-errors\.js'/.test(BG), 'must be a STATIC import in the module worker');
  // Both library call sites route through the shared helper.
  const uses = BG.match(/VodouGatewayError\.describe/g) || [];
  assert.equal(uses.length, 2, `expected both library callers to use it, found ${uses.length}`);
});

test('the side panel loads the helper and uses it on a missing route', () => {
  assert.ok(/<script src="gateway-errors\.js"><\/script>/.test(PANEL_HTML),
    'sidepanel.html must load it before sidepanel.js');
  assert.ok(PANEL_HTML.indexOf('gateway-errors.js') < PANEL_HTML.indexOf('sidepanel.js'),
    'load order matters — the global must exist before the panel runs');
  assert.ok(/VodouGatewayError\?\.isMissingRoute/.test(PANEL),
    'the doc-match 404 path must classify rather than silently hide');
});

test('the panel says it once, not on every tab change', () => {
  // refresh() runs per tab switch and the condition is permanent until the user
  // updates — repeating it on every tab would be its own bug.
  assert.ok(/toldAppTooOld/.test(PANEL), 'must latch the notice');
  assert.ok(/toldAppTooOld = true/.test(PANEL), 'must set the latch when shown');
});
