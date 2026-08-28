// PLAN-BRIDGE-BRAIN-LINK §3.3 — the panel's `brain` link, decided without a browser.
//
// The compatibility contract has three cases and one of them only exists in the
// field: a gateway too old to send `brain_standalone` at all. That case cannot be
// exercised by loading the extension against the gateway on this machine, which is
// exactly why it needs a fixture instead of a manual check.
//
// Run: node --test extension/Store-vodou-bridge/test/brain-link.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// brain-link.js is a plain panel script (globalThis export, like vocabulary.js).
// Evaluate it here rather than importing, so the shipped file needs no module syntax.
const src = fs.readFileSync(new URL('../brain-link.js', import.meta.url), 'utf8');
new Function(src).call(globalThis);
const { brainLinkFor } = globalThis.VodouBrainLink;

const LOCAL = 'ws://127.0.0.1:8765/api/vbb';

test('flag true — the install runs the standalone twin, so the link is the twin', () => {
  assert.equal(
    brainLinkFor({ brain_standalone: true, brain_port: 8767, gateway_url: LOCAL }, LOCAL),
    'http://127.0.0.1:8767/',
  );
});

test('flag false — a modern gateway saying "no twin here": the map is in the console', () => {
  assert.equal(
    brainLinkFor({ brain_standalone: false, brain_port: 8767, gateway_url: LOCAL }, LOCAL),
    'http://127.0.0.1:8765/#/memory?tab=map',
  );
});

test('flag ABSENT + a brain_port — an old gateway, whose twin was always on (option B)', () => {
  // Absent is not false. The opt-in guard arrived in the same commit that moved the
  // graph into the console, so a gateway that never heard the question was running
  // :8767. Sending these users to #/memory?tab=map lands them on a Memory page with
  // no Map tab — nothing 404s, and the link does not do what it says.
  assert.equal(
    brainLinkFor({ brain_port: 8767, gateway_url: LOCAL }, LOCAL),
    'http://127.0.0.1:8767/',
  );
});

test('flag absent and NO brain_port — nothing to point at, so the console route', () => {
  assert.equal(
    brainLinkFor({ gateway_url: LOCAL }, LOCAL),
    'http://127.0.0.1:8765/#/memory?tab=map',
  );
});

test('a tunnelled gateway keeps ITS host — never loopback', () => {
  const remote = 'ws://vodou.example.com:9000/api/vbb';
  assert.equal(
    brainLinkFor({ brain_standalone: false, gateway_url: remote }, remote),
    'http://vodou.example.com:9000/#/memory?tab=map',
  );
  assert.equal(
    brainLinkFor({ brain_standalone: true, brain_port: 8767, gateway_url: remote }, remote),
    'http://vodou.example.com:8767/',
  );
});

test('no status at all — falls back to the panel default rather than throwing', () => {
  assert.equal(brainLinkFor(null, LOCAL), 'http://127.0.0.1:8765/#/memory?tab=map');
  assert.doesNotThrow(() => brainLinkFor(null, undefined));
});
