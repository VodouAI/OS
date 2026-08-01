// PLAN-ENGINE-GATED-CAPTURE P3a — the refusal codes cross THREE languages:
// Rust mints them (src/capture_lease.rs), TypeScript relays them
// (vbb/capture-lease.ts, which adds engine_unreachable), and this JavaScript turns
// them into the sentence a user reads.
//
// A code with no message renders as "Vodou could not confirm your account" — the
// engine_error fallback — which is wrong for, say, no_account and sends the user
// to the wrong fix. Nothing in any compiler checks that, so check it here.
//
// Run: node --test extension/vodou-bridge/test/lease-messages.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const BG = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');

// The Rust and TypeScript sides are read from the MONOREPO. In the open-source tree
// the Rust engine is not present (it is the one proprietary component), so this file
// would throw ENOENT and the published suite would fail on a fresh clone — which is a
// terrible first impression for a repo whose whole pitch is "read the source".
//
// Missing engine source = skip the cross-language assertions with a stated reason.
// Present = enforce them exactly as before. The JS-only checks always run.
const readIfPresent = (rel) => {
  try { return fs.readFileSync(new URL(rel, import.meta.url), 'utf8'); }
  catch { return null; }
};
const RUST = readIfPresent('../../../src/capture_lease.rs');
const TS = readIfPresent('../../../MCP-servers/Vodou-Console/src/vbb/capture-lease.ts');
const CROSS_LANG = RUST !== null && TS !== null;
const crossLangOpts = CROSS_LANG
  ? {}
  : { skip: 'engine source not in this tree (open-source checkout) — JS-side checks still run' };

/** The keys of LEASE_MESSAGE in background.js. */
function messageCodes() {
  const i = BG.indexOf('const LEASE_MESSAGE = {');
  assert.ok(i >= 0, 'LEASE_MESSAGE not found in background.js');
  const body = BG.slice(i, BG.indexOf('};', i));
  return new Set([...body.matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]));
}

/** The codes Denial::code() can return in Rust. */
function rustCodes() {
  const i = RUST.indexOf('pub fn code(self)');
  assert.ok(i >= 0, 'Denial::code not found');
  const body = RUST.slice(i, RUST.indexOf('\n    }', i));
  return new Set([...body.matchAll(/=>\s*"([a-z_]+)"/g)].map((m) => m[1]));
}

/** The codes the gateway's LeaseReason union can produce. */
function gatewayCodes() {
  const i = TS.indexOf('export type LeaseReason');
  assert.ok(i >= 0, 'LeaseReason not found');
  const body = TS.slice(i, TS.indexOf(';', i));
  return new Set([...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
}

test('every Rust denial code is a code the gateway can relay', crossLangOpts, () => {
  const missing = [...rustCodes()].filter((c) => !gatewayCodes().has(c));
  assert.deepEqual(missing, [], `gateway LeaseReason is missing: ${missing.join(', ')}`);
});

test('every code the gateway can emit has a user-facing message', crossLangOpts, () => {
  const msgs = messageCodes();
  const missing = [...gatewayCodes()].filter((c) => !msgs.has(c));
  assert.deepEqual(missing, [],
    `LEASE_MESSAGE has no text for: ${missing.join(', ')} — those would fall back to the wrong explanation`);
});

test('no orphan messages for codes nothing can send', crossLangOpts, () => {
  // A message for a code that cannot arrive is dead text that reads as coverage.
  const orphans = [...messageCodes()].filter((c) => !gatewayCodes().has(c));
  assert.deepEqual(orphans, [], `LEASE_MESSAGE has text for codes nothing emits: ${orphans.join(', ')}`);
});

test('a refusal is described as held, never as lost', () => {
  // The whole point of P3a: the turns are already in the retry queue. Wording that
  // implies loss is worse than no message at all.
  for (const [code, text] of Object.entries(
    Object.fromEntries([...messageCodes()].map((c) => {
      const m = BG.match(new RegExp(`^\\s{2}${c}:\\s*(?:'([^']*)'|"([^"]*)")`, 'm'));
      return [c, (m && (m[1] ?? m[2])) || ''];
    })),
  )) {
    assert.ok(/held|hold/i.test(text), `${code} does not say the turns are held: "${text}"`);
    assert.ok(!/lost|couldn't save|failed to save/i.test(text), `${code} implies loss: "${text}"`);
  }
});

// Was "the popup renders a hold…" and read popup.js. The popup was retired (the
// toolbar icon opens the side panel now) and the file deleted, so this test threw
// ENOENT — the one failure in the suite, and it looked like a lease-protocol bug
// rather than a stale path. The rendering itself moved intact to controls.js,
// which the side panel shares, so the assertion is still the right one.
test('the panel renders a hold distinctly from a failure', () => {
  const UI = fs.readFileSync(new URL('../controls.js', import.meta.url), 'utf8');
  assert.match(UI, /e\.ok && e\.held/, 'panel does not branch on the held flag');
  assert.match(UI, /Holding /, 'panel has no hold wording');
});
