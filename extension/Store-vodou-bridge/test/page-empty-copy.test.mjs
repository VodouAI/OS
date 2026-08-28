// COHERENCE F31 — the empty page card must read YOUNG, not BROKEN.
//
// Page identity fills forward and cannot be backfilled, so a brand-new user who
// has just granted a privacy-sensitive permission is shown an empty card. That
// emptiness is the expected first state, but it is indistinguishable from a
// broken feature — and since page memories only accrue while the lane is ON, an
// emptiness that reads as failure discourages the very grant that would end it.
//
// The failure mode this file exists to prevent is subtle and was nearly shipped:
// paintSite treats an ABSENT mode as 'collect' (it shows the note field on that
// assumption), so a strict `mode === 'collect'` test here would show the
// "not saving on this site" copy to every user whose payload omits the field —
// telling the majority the exact opposite of the truth, and pointing them at a
// control they do not need.
//
// pageEmptyCopy lives inside sidepanel.js's IIFE (not exported), so this test
// extracts the function source and evaluates it in isolation, following the
// convention set by receipt.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PANEL = path.join(HERE, '..', 'sidepanel.js');

function loadPageEmptyCopy() {
  const src = fs.readFileSync(PANEL, 'utf8');
  const start = src.indexOf('function pageEmptyCopy(');
  assert.ok(start > 0, 'pageEmptyCopy not found in sidepanel.js — did it get renamed?');
  // Walk braces to the function's end so the extraction survives edits around it.
  let depth = 0, i = src.indexOf('{', start), end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > 0, 'could not find the end of pageEmptyCopy');
  return new Function(`${src.slice(start, end)}; return pageEmptyCopy;`)();
}

const pageEmptyCopy = loadPageEmptyCopy();

test('collect mode points at the note field that is actually on screen', () => {
  const copy = pageEmptyCopy('collect');
  assert.match(copy, /fills as you go/i, 'must say the emptiness is temporary');
  assert.match(copy, /note below/i, 'must point at the note field, which IS rendered in collect mode');
});

test('an ABSENT mode is treated as collect, matching paintSite', () => {
  // The regression guard. Both of these reach the note field in the real panel,
  // so both must get the copy that points at it.
  assert.equal(pageEmptyCopy(undefined), pageEmptyCopy('collect'));
  assert.equal(pageEmptyCopy(''), pageEmptyCopy('collect'));
});

test('suggest-only mode points at the site control, not a hidden field', () => {
  const copy = pageEmptyCopy('suggest');
  assert.doesNotMatch(copy, /note below/i,
    'the note field is hidden when the site is not collectable — pointing at it would be a lie');
  assert.match(copy, /suggest \+ collect/i, 'must name the control that changes the outcome');
});

test('no branch reads as a failure', () => {
  for (const mode of ['collect', 'suggest', undefined]) {
    const copy = pageEmptyCopy(mode);
    assert.doesNotMatch(copy, /error|failed|unable|sorry|problem/i,
      `"${mode}" copy must not read as a fault — empty here is the expected first state`);
    // Every branch owes the reader a next action, per the empty-state rule.
    assert.match(copy, /below/i, `"${mode}" copy must point somewhere actionable`);
  }
});
