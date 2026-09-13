// sites.json — the site registry, rendered for readers that cannot load sites.js.
// PLAN-CAPTURE-GRADED-PER-SITE §3.5.
//
// `vodou-core capture` is Rust and cannot evaluate sites.js. Rather than a second
// hand-kept list (the disease this whole plan exists to grade), the registry is
// RENDERED to extension/sites.json from the Store build's sites.js — the one Chad
// sideloads and the one strangers install (§8 decision 3). sites.test.mjs asserts
// the rendered file is current, so a registry edit that forgets to re-render
// fails the test rather than quietly grading against yesterday's list.
//
// The file lives at extension/sites.json — the extension ROOT, not inside a
// build folder — so it ships in no extension package and the ext-version-guard
// has nothing to say about it.
//
//   node extension/Store-vodou-bridge/test/gen-sites-json.mjs          # write
//   node extension/Store-vodou-bridge/test/gen-sites-json.mjs --check  # exit 1 if stale

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SOURCE = join(HERE, '..', 'sites.js');
export const TARGET = join(HERE, '..', '..', 'sites.json');

/** Render the registry: one object per site, only the fields a grader needs. */
export function render(src = readFileSync(SOURCE, 'utf8')) {
  const ctx = { globalThis: null };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const sites = ctx.VODOU_SITES;
  if (!Array.isArray(sites) || !sites.length) throw new Error('sites.js evaluated to no VODOU_SITES');
  const rows = sites.map((s) => ({
    key: s.key,
    label: s.label,
    capture: s.capture || s.key,
    mechanism: s.mechanism || 'composer',
    // A `save` block means the DOM extractor was verified against a real chat;
    // the network adapter is a separate lane and is not what this flag says.
    has_save: !!(s.save && s.save.user),
    host: String(s.host && s.host.source ? s.host.source : ''),
  }));
  return JSON.stringify({
    generated_from: 'extension/Store-vodou-bridge/sites.js',
    generator: 'extension/Store-vodou-bridge/test/gen-sites-json.mjs',
    sites: rows,
  }, null, 2) + '\n';
}

export function current() {
  return existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : '';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const want = render();
  if (process.argv.includes('--check')) {
    if (current() !== want) {
      console.error(`${TARGET} is stale — run: node ${process.argv[1]}`);
      process.exit(1);
    }
    console.log('sites.json is current');
  } else {
    writeFileSync(TARGET, want);
    console.log(`wrote ${TARGET} (${JSON.parse(want).sites.length} sites)`);
  }
}
