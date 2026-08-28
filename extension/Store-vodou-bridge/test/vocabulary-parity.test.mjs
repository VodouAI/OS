// COHERENCE Phase 2 — the mirror must not rot quietly.
//
// `vocabulary.js` mirrors `src/memory/provenance.rs`. A mirror is only worth
// having if something notices when it stops matching, and the failure mode is
// silent by nature: nobody reads two implementations side by side, they read
// the one they are editing. So this runs BOTH over the scope vocabulary that
// actually exists in the corpus, plus the edges, and fails on any disagreement.
//
// It is also why the JS file may be edited freely: change it, run this, and
// the test tells you whether you drifted from core. Without that, "keep them in
// sync" is a note in a comment, which is the thing Phase 2 exists to stop.
//
// Skips itself when the release binary is absent, so a checkout with no build
// does not fail — but it is a real cross-language check when it runs.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const BIN = path.join(ROOT, 'target/release/vodou-core');
const HAVE_BIN = fs.existsSync(BIN);

await import('../vocabulary.js');
const V = globalThis.VodouVocabulary;

/**
 * Every prefix shape the corpus contains, plus the ones that only appear at
 * boundaries. Dynamic segments are included because `pretty_source` is where a
 * mirror is likeliest to drift — a product name added to one side only.
 */
const SCOPES = [
  '', 'web', 'skill', 'gateway', 'pinned', 'tenant', 'channel',
  'doc', 'doc:body', 'pinned:decisions', 'tenant:acme',
  'channel:slack', 'channel:telegram', 'channel:unknown-thing',
  'workbench', 'workbench:channel:telegram', 'workbench:skill-console:daily-competitor-intel',
  'workbench:skill-console:morning-briefing', 'workbench:integration:Vodou-Board',
  'workbench:something-new', 'web:not-the-default-bucket',
  'capture', 'capture:manual:httpbinorg', 'capture:web:chatgpt', 'capture:web:characterai',
  'capture:web:duckai', 'capture:web:t3chat', 'capture:web:lechat', 'capture:web:metaai',
  'capture:web:youcom', 'capture:web:huggingchat', 'capture:web:notebooklm',
  'capture:web:openrouter', 'capture:web:aistudio', 'capture:web:deepseek',
  'capture:ide:claude-code', 'capture:ide:claudecode', 'capture:ide:openclaw',
  'capture:web:some-brand-new-site', 'capture:ide:cursor',
  'import:obsidian', 'import:chatgpt', 'import:some_tool',
  'nonsense', 'nonsense:thing', '   ', 'WEB', 'skill:extra:segments',
];

const rustLabel = (scope) =>
  execFileSync(BIN, ['vocab', scope], { encoding: 'utf8' }).replace(/\n$/, '');

test('the JS mirror agrees with core on every scope shape', { skip: !HAVE_BIN && 'no release binary' }, () => {
  const disagreements = [];
  for (const s of SCOPES) {
    const js = V.scopeLabel(s);
    const rs = rustLabel(s);
    if (js !== rs) disagreements.push(`${JSON.stringify(s)}: js=${JSON.stringify(js)} rust=${JSON.stringify(rs)}`);
  }
  assert.deepEqual(
    disagreements, [],
    'vocabulary.js has drifted from src/memory/provenance.rs — the mirror is the ' +
    'thing Phase 2 built, so fix the mirror (or core) rather than this list:\n  ' +
    disagreements.join('\n  '),
  );
});

test('no translation ever leaks a schema word, in either language', () => {
  for (const s of SCOPES) {
    const out = V.scopeLabel(s);
    assert.ok(!out.includes(':'), `${s} leaked a scope shape: ${out}`);
    for (const jargon of ['workbench', 'gateway:', 'tenant', 'scope']) {
      assert.ok(
        !out.toLowerCase().includes(jargon),
        `${s} leaked the internal word ${JSON.stringify(jargon)}: ${out}`,
      );
    }
  }
});

test('the largest label in the corpus is not a falsehood', () => {
  // 22,674 chunks carried `web`, which never meant "from the web" — it is the
  // no-token default, written to the daily logs.
  assert.equal(V.scopeLabel('web'), 'your notes');
});

test('an unrecognised scope is still a memory, never the raw key', () => {
  for (const s of ['nonsense', 'nonsense:thing', 'a:b:c:d', 'ZZZ']) {
    assert.equal(V.scopeLabel(s), 'memory', `${s} did not fall back cleanly`);
  }
});

test('the console copy is byte-identical to the extension copy', () => {
  // Two deploy units, one file. A copy that is allowed to differ is two files,
  // and two files is the drift this module exists to end.
  const a = fs.readFileSync(path.join(ROOT, 'extension/Store-vodou-bridge/vocabulary.js'), 'utf8');
  const b = fs.readFileSync(path.join(ROOT, 'MCP-servers/Vodou-Console/public/js/vocabulary.js'), 'utf8');
  assert.equal(a, b, 'the console copy of vocabulary.js has diverged — copy it across, do not patch one side');
});
