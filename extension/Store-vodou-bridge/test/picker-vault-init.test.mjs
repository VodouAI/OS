// The panel's Memory search went out as all_memory=false for weeks.
//
// COHERENCE F42 renamed `picker.scope` → `picker.vault` at every READ but left
// the initialiser as `scope: 'all'`, so until someone touched the vault dropdown
// `picker.vault` was undefined. search() computes `all = picker.vault === 'all'`
// → false, and the gateway searched only the default vault. Facts that live in
// the vault (a spouse's name) still came back, so it looked like it worked;
// anything else ("What do you know about <person>?") returned unrelated noise
// at 0%, under a status line reading `15 in vault "undefined"`.
//
// This pins the one invariant that failed: the picker's initial state must
// define every field search()/render() branch on, and the vault must start at
// 'all' — the dropdown's own first option.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../sidepanel.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../sidepanel.html', import.meta.url), 'utf8');

function pickerInit() {
  const m = src.match(/const picker = \{([\s\S]*?)\n\};/);
  assert.ok(m, 'picker initialiser not found in sidepanel.js');
  return m[1];
}

test('picker starts with vault = "all", not undefined', () => {
  assert.match(pickerInit(), /^\s*vault:\s*'all'\s*,/m);
});

test('every picker.<field> the panel reads is declared in the initialiser', () => {
  const init = pickerInit();
  const read = new Set([...src.replace(/^\s*\/\/.*$/gm, "").matchAll(/\bpicker\.(\w+)\b/g)].map((m) => m[1]));
  const missing = [...read].filter((f) => !new RegExp(`^\\s*${f}\\s*:`, 'm').test(init));
  assert.deepEqual(missing, [], `picker fields read but never initialised: ${missing.join(', ')}`);
});

test('the initial vault matches the dropdown\'s default option', () => {
  const opt = html.match(/<select id="vault-select"[^>]*>\s*<option value="([^"]+)"/);
  assert.ok(opt, 'vault-select default option not found');
  assert.equal(opt[1], 'all');
});
