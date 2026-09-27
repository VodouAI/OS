// The two sideload builds are GENERATED from this one (scripts/build-sideload-bridge.py).
//
// They used to be hand-kept copies and rotted twice: by 2026-09-23 they were
// missing eight files, thousands of lines of background.js / content.js, and
// sideload-only's own parser suite was 30/35 red — while the packer's drift
// check, which only diffed inject.js, reported "31 lines". The packer is also
// the wrong place for the only check: it runs when someone ships, not when
// someone changes this build.
//
// So this suite asks the generator directly. A change to the Store build that
// is committed without regenerating fails HERE, with the command to run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('the sideload builds are exactly the Store build + extension/sideload-overlay', () => {
  const r = spawnSync('python3', [join(ROOT, 'scripts', 'build-sideload-bridge.py'), '--check'], {
    encoding: 'utf8',
  });
  assert.equal(r.error, undefined, `could not run the generator: ${r.error}`);
  assert.equal(
    r.status, 0,
    `${r.stdout}${r.stderr}\nRun: python3 scripts/build-sideload-bridge.py — and commit both sideload folders.`,
  );
});

// The overlay is APPENDED to this build's background.js, which Chrome loads as an
// ES module — and a module rejects a second top-level declaration of the same
// name, so the whole service worker fails to start. A plain `node --check` parses
// it as a script and passes. The first cut of the overlay shipped exactly that
// (a duplicate extractor_webConversation); this is the check that caught it.
for (const b of ['vodou-bridge', 'sideload-only-vodou-bridge']) {
  test(`${b}: background.js parses as the ES module Chrome loads`, () => {
    const src = readFileSync(join(ROOT, 'extension', b, 'background.js'), 'utf8');
    const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: src, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });
}
