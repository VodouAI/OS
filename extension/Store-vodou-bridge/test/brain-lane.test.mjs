// Unit tests for the Brain-inject lane (PLAN-BRAIN-INJECT-LANE).
// Run: node --test extension/Store-vodou-bridge/test/brain-lane.test.mjs
//
// Same harness idea as capture-queue.test.mjs — evaluate the REAL shipped source so
// the tests fail if it drifts. We (1) behaviorally test the loop-strip substring fix
// by slicing stripInjected out of content.js and running it, and (2) make structural
// assertions on the wiring that is hard to evaluate outside a service worker / page.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const CONTENT = fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const BG = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const HTML = fs.readFileSync(new URL('../sidepanel.html', import.meta.url), 'utf8');
const PANEL = fs.readFileSync(new URL('../sidepanel.js', import.meta.url), 'utf8');

// ── 1. Behavioral: the loop-strip fix removes an APPENDED injected block ──────────
test('stripInjected removes an appended context block (substring, not prefix)', () => {
  const START = 'const STRIP_TTL_MS';
  const END = 'function stripInjected';
  const i = CONTENT.indexOf(START);
  const j = CONTENT.indexOf('\n    }', CONTENT.indexOf(END)); // end of the function body
  assert.ok(i >= 0 && j > i, 'stripInjected block not found');
  const block = CONTENT.slice(i, j + '\n    }'.length);

  // Wrap the sliced source in a factory that injects the closure vars it reads.
  // eslint-disable-next-line no-new-func
  const make = new Function('stripRegistry', `${block}; return stripInjected;`);
  const injected = 'Here is what you need to know: my dog is Rex.';
  const strip = make([{ text: injected, ts: Date.now() }]);

  // The composer APPENDS context after the user's draft (\n\n + block).
  const turns = [{ role: 'user', content: 'What should I name my new puppy?\n\n' + injected }];
  const out = strip(turns);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'What should I name my new puppy?');
  assert.ok(!out[0].content.includes('Rex'), 'appended injected block must be stripped');
});

test('stripInjected leaves an untouched turn unchanged', () => {
  const i = CONTENT.indexOf('const STRIP_TTL_MS');
  const j = CONTENT.indexOf('\n    }', CONTENT.indexOf('function stripInjected'));
  const block = CONTENT.slice(i, j + '\n    }'.length);
  // eslint-disable-next-line no-new-func
  const make = new Function('stripRegistry', `${block}; return stripInjected;`);
  const strip = make([]);
  const turns = [{ role: 'user', content: 'just a normal message' }];
  assert.equal(strip(turns)[0].content, 'just a normal message');
});

// ── 2. Structural: the strip uses indexOf, not the old startsWith prefix match ────
test('strip loop matches anywhere (indexOf), not just as a prefix', () => {
  assert.ok(/const at = c\.indexOf\(r\.text\)/.test(CONTENT), 'strip must use indexOf');
  // The old prefix-only check must be gone from the strip loop.
  assert.ok(!/if \(c\.startsWith\(r\.text\)\)/.test(CONTENT), 'old startsWith prefix check must be removed');
});

// ── 3. Structural: brain_result / chat_event are branched BEFORE handleCmd ────────
test('background demuxes brain_result and chat_event before the handleCmd fallthrough', () => {
  const brainAt = BG.indexOf("msg.cmd === 'brain_result'");
  const chatAt = BG.indexOf("msg.cmd === 'chat_event'");
  const handleAt = BG.indexOf('handleCmd(msg);');
  assert.ok(brainAt >= 0 && chatAt >= 0 && handleAt >= 0, 'branches present');
  assert.ok(brainAt < handleAt, 'brain_result branch must precede handleCmd');
  assert.ok(chatAt < handleAt, 'chat_event branch must precede handleCmd');
});

// ── 4. Structural: the long-lived panel Port name is stable ───────────────────────
// The panel-side connect() lands in Phase 3; here we lock the background contract.
test('background accepts a vodou-chat Port', () => {
  assert.ok(/port\.name !== 'vodou-chat'/.test(BG), 'background listens for vodou-chat');
  assert.ok(/chrome\.runtime\.onConnect\.addListener/.test(BG), 'onConnect listener present');
});

// ── 5. Structural: Brain mode requires an EXPLICIT opt-in (=== true) ──────────────
test('brainModeEnabled requires injectSettings.brain === true', () => {
  assert.ok(/injectSettings\.brain === true/.test(CONTENT), 'brain gate must be === true (opt-in)');
});

test('sidepanel exposes Brain mode as a plain toggle under the one site list', () => {
  assert.ok(HTML.includes('id="inject-brain"'), 'brain master checkbox present');
  // Its own 22-site grid was removed in the panel cleanup: one list (inject-sites)
  // says WHERE Vodou works, and these toggles say WHAT it does there.
  assert.ok(!HTML.includes('id="brain-sites"'), 'no separate brain site grid');
  assert.ok(/simpleToggle\('inject-brain'/.test(PANEL), 'panel wires it as a simple toggle');
});

// ── 6. Store-safety invariants unaffected: no network-rewrite un-stub ─────────────
test('the network-rewrite seam stays a stub (store build ships no body rewrite)', () => {
  const INJECT = fs.readFileSync(new URL('../inject.js', import.meta.url), 'utf8');
  assert.ok(/async function maybeInjectArgs\(args\)\s*\{\s*return args;\s*\}/.test(INJECT),
    'maybeInjectArgs must remain a stub returning args unchanged');
});
