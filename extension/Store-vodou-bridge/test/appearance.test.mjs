// The panel's palette comes from Vodou, and this is what stops it drifting back.
//
// Three things are checked, and the third is the point:
//   1. theme.js behaviour — cache-first paint, gateway wins, mode is ours.
//   2. the generated copies are current (tokens.css from the Console file,
//      theme.js mirrored across all three builds).
//   3. no sidepanel.html has re-grown a local colour block. That hand-copied
//      :root is exactly how the panel ended up frozen on brand-dark for months
//      while the Console shipped 24 palettes.
//
// theme.js is a classic IIFE, so it is evaluated with `new Function` and a fake
// environment per test — that lets each case start from a clean document.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(EXT, '../..');
const BUILDS = ['vodou-bridge', 'Store-vodou-bridge', 'sideload-only-vodou-bridge']
  .map((b) => path.join(ROOT, 'extension', b));
const SRC = fs.readFileSync(path.join(EXT, 'theme.js'), 'utf8');

function makeEnv({ cached = null, prefersLight = false, gateway = null, gatewayFails = false } = {}) {
  const attrs = {};
  const store = { vodou_gateway_url: null };
  const local = { value: cached === null ? null : JSON.stringify(cached) };
  const env = {
    attrs,
    store,
    fetched: [],
    onChanged: [],
    window: {
      matchMedia: () => ({ matches: prefersLight, addEventListener() {}, addListener() {} }),
    },
    document: {
      readyState: 'complete',
      hidden: false,
      documentElement: {
        setAttribute: (k, v) => { attrs[k] = v; },
        getAttribute: (k) => attrs[k],
      },
      getElementById: () => null,
      addEventListener() {},
    },
    localStorage: {
      getItem: () => local.value,
      setItem: (_k, v) => { local.value = v; },
    },
    chrome: { storage: {
      local: {
        get: (_keys, cb) => cb(store),
        set: (o) => Object.assign(store, o),
      },
      onChanged: { addListener: (fn) => { env.onChanged.push(fn); } },
    } },
    getComputedStyle: () => ({ getPropertyValue: () => '#000' }),
    fetch: (url) => {
      env.fetched.push(url);
      if (gatewayFails) return Promise.reject(new Error('offline'));
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(gateway) });
    },
  };
  env.cache = local;
  return env;
}

function run(env) {
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'localStorage', 'chrome', 'fetch', 'getComputedStyle', SRC)(
    env.window, env.document, env.localStorage, env.chrome, env.fetch, env.getComputedStyle,
  );
  return new Promise((r) => setImmediate(() => setImmediate(r)));
}

test('paints from cache before the gateway answers', async () => {
  const env = makeEnv({ cached: { theme: 'light', palette: 'ritual' }, gatewayFails: true });
  // Synchronous: the attributes are set by the time run() has evaluated the file.
  const p = run(env);
  assert.equal(env.attrs['data-palette'], 'ritual');
  assert.equal(env.attrs['data-theme'], 'light');
  await p;
});

test('a dead gateway leaves the cached palette standing', async () => {
  const env = makeEnv({ cached: { theme: 'light', palette: 'ritual' }, gatewayFails: true });
  await run(env);
  assert.equal(env.attrs['data-palette'], 'ritual');
  assert.equal(env.attrs['data-theme'], 'light');
});

test('with no cache at all it is brand + dark, never blank', async () => {
  const env = makeEnv({ gatewayFails: true });
  await run(env);
  assert.equal(env.attrs['data-palette'], 'brand');
  assert.equal(env.attrs['data-theme'], 'dark');
});

// The bug this exists to prevent: the panel shipped defaulting to the browser's
// light/dark, the browser reported dark while the Console was on light, and the
// result was byte-for-byte the old hardcoded panel. Nothing appeared to happen.
test('by default light/dark comes from Vodou, not the browser', async () => {
  const env = makeEnv({ prefersLight: false, gateway: { theme: 'light', palette: 'brand' } });
  await run(env);
  assert.equal(env.attrs['data-theme'], 'light', 'Vodou is on light, so the panel is light');
});

test('a stored mode from the OLD default does not survive as a choice', async () => {
  // Every panel that ran the first build has {"mode":"browser"} cached. That was
  // the default talking, not the user, and it must not pin them to the old
  // behaviour forever.
  const env = makeEnv({
    cached: { theme: 'light', palette: 'brand', mode: 'browser' },
    prefersLight: false,
    gateway: { theme: 'light', palette: 'brand' },
  });
  await run(env);
  assert.equal(env.attrs['data-theme'], 'light');
  assert.equal(JSON.parse(env.cache.value).modeChoice, undefined,
    'an untouched default must not be written back as a choice');
});

test('ticking follow-the-browser is remembered, and then wins', async () => {
  const env = makeEnv({
    cached: { theme: 'dark', palette: 'brand', modeChoice: 'browser' },
    prefersLight: true,
    gateway: { theme: 'dark', palette: 'ritual' },
  });
  await run(env);
  assert.equal(env.attrs['data-palette'], 'ritual', 'palette still follows Vodou');
  assert.equal(env.attrs['data-theme'], 'light', 'mode follows the browser once chosen');
  assert.equal(JSON.parse(env.cache.value).modeChoice, 'browser');
});

test('the gateway wins over the cache', async () => {
  const env = makeEnv({
    cached: { theme: 'dark', palette: 'brand', mode: 'vodou' },
    gateway: { theme: 'light', palette: 'ocean' },
  });
  await run(env);
  assert.equal(env.attrs['data-palette'], 'ocean');
  assert.equal(env.attrs['data-theme'], 'light');
  assert.match(env.fetched[0], /^http:\/\/127\.0\.0\.1:8765\/api\/appearance$/);
});

test('the gateway cannot clobber a mode the user chose', async () => {
  const env = makeEnv({
    cached: { theme: 'dark', palette: 'brand', modeChoice: 'browser' },
    prefersLight: true,
    gateway: { theme: 'dark', palette: 'ritual' },
  });
  await run(env);
  assert.equal(JSON.parse(env.cache.value).modeChoice, 'browser');
});

test('a palette the panel does not ship falls back to brand', async () => {
  const env = makeEnv({ gateway: { theme: 'dark', palette: 'chartreuse' } });
  await run(env);
  assert.equal(env.attrs['data-palette'], 'brand');
});

test('the gateway is read from the configured URL, not a baked-in port', async () => {
  const env = makeEnv({ gateway: { theme: 'dark', palette: 'brand' } });
  env.store.vodou_gateway_url = 'ws://127.0.0.1:9911/api/vbb';
  await run(env);
  assert.equal(env.fetched[0], 'http://127.0.0.1:9911/api/appearance');
});

test('every palette the gateway can return is one tokens.css defines', () => {
  const css = fs.readFileSync(path.join(EXT, 'tokens.css'), 'utf8');
  const server = fs.readFileSync(
    path.join(ROOT, 'MCP-servers/Vodou-Console/src/api/appearance.ts'), 'utf8');
  const block = server.slice(server.indexOf('const PALETTES'), server.indexOf(']);'));
  const palettes = [...block.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.ok(palettes.length >= 24, `expected the full palette set, got ${palettes.length}`);
  for (const p of palettes) {
    assert.ok(css.includes(`[data-theme="dark"][data-palette="${p}"]`), `tokens.css missing dark ${p}`);
    assert.ok(css.includes(`[data-theme="light"][data-palette="${p}"]`), `tokens.css missing light ${p}`);
  }
  // theme.js validates against its own list; it must not be shorter than the server's.
  for (const p of palettes) assert.ok(SRC.includes(`'${p}'`), `theme.js missing palette ${p}`);
});

test('the generated copies are current', () => {
  execFileSync('python3', [path.join(ROOT, 'scripts/sync-ext-tokens.py'), '--check'], { cwd: ROOT });
});

test('no build has re-grown a local colour block', () => {
  for (const b of BUILDS) {
    const html = fs.readFileSync(path.join(b, 'sidepanel.html'), 'utf8');
    assert.ok(html.includes('<link rel="stylesheet" href="tokens.css">'), `${b}: tokens.css not linked`);
    assert.ok(html.includes('<script src="theme.js"></script>'), `${b}: theme.js not loaded`);
    // The tell-tale of a hand-copied palette. Panel-only vars (--c-here etc.)
    // and the two aliases are fine; a background/text/accent definition is not.
    for (const v of ['--bg-primary', '--text-primary', '--accent', '--border-primary']) {
      assert.ok(!new RegExp(`^\\s*${v}\\s*:`, 'm').test(html),
        `${b}: sidepanel.html defines ${v} — that copy belongs in tokens.css`);
    }
    assert.ok(!/prefers-color-scheme/.test(html.split('</style>')[0]),
      `${b}: light/dark is theme.js's job now, not a media query`);
  }
});

// The complaint that produced this lane: panel open beside the Console, change the
// palette, and nothing happens — because the panel only re-read on open.
test('an open panel repaints when the Console changes the palette', async () => {
  const env = makeEnv({ gateway: { theme: 'dark', palette: 'brand' } });
  await run(env);
  assert.equal(env.attrs['data-palette'], 'brand');
  assert.equal(env.onChanged.length, 1, 'no storage listener registered');

  // What background.js writes when the gateway pushes set_appearance.
  env.onChanged[0]({ vodou_appearance: { newValue: { theme: 'light', palette: 'ritual' } } }, 'local');
  assert.equal(env.attrs['data-palette'], 'ritual');
  assert.equal(env.attrs['data-theme'], 'light');
  assert.equal(JSON.parse(env.cache.value).palette, 'ritual', 'the new pick must survive a reopen');
});

test('a pushed change cannot override a mode the user chose', async () => {
  const env = makeEnv({
    cached: { theme: 'dark', palette: 'brand', modeChoice: 'browser' },
    prefersLight: true,
    gateway: { theme: 'dark', palette: 'brand' },
  });
  await run(env);
  env.onChanged[0]({ vodou_appearance: { newValue: { theme: 'dark', palette: 'ocean' } } }, 'local');
  assert.equal(env.attrs['data-palette'], 'ocean', 'palette follows the push');
  assert.equal(env.attrs['data-theme'], 'light', 'mode stays the browser\'s, as chosen');
});

test('the push lane does not echo back into chrome.storage', async () => {
  // storage.set inside an onChanged handler for the same key is a loop.
  const env = makeEnv({ gateway: { theme: 'dark', palette: 'brand' } });
  await run(env);
  const writes = [];
  env.chrome.storage.local.set = (o) => { writes.push(o); Object.assign(env.store, o); };
  env.onChanged[0]({ vodou_appearance: { newValue: { theme: 'light', palette: 'ritual' } } }, 'local');
  assert.equal(writes.length, 0, 'the handler wrote back to chrome.storage — that is the loop');
});

test('the gateway pushes appearance down the same bridge the panel already uses', () => {
  const bridge = fs.readFileSync(
    path.join(ROOT, 'MCP-servers/Vodou-Console/src/vbb/bridge.ts'), 'utf8');
  const api = fs.readFileSync(
    path.join(ROOT, 'MCP-servers/Vodou-Console/src/api/appearance.ts'), 'utf8');
  const bg = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
  assert.match(bridge, /'set_appearance'/, 'no set_appearance command on the gateway side');
  assert.match(api, /pushAppearance/, 'PUT /api/appearance does not push');
  assert.match(bg, /case 'set_appearance':/, 'the service worker ignores set_appearance');
  assert.match(bg, /vodou_appearance/, 'the push must land on the key theme.js watches');
});
