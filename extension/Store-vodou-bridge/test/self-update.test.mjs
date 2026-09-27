// Web Store update delivery (self-update.js) and install-type reporting.
//
// The worker holds a WebSocket open, which keeps it alive, so Chrome's "install
// the update when the worker unloads" could wait for a browser restart. These
// pin the behaviour that replaces that wait — and the guards that stop it from
// ever reloading mid-work, looping, or double-hooking fetch in open tabs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(EXT, '../..');
const SRC = fs.readFileSync(path.join(EXT, 'self-update.js'), 'utf8');
const BG = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');

function load({ installType = 'normal', idle = () => true, check = { status: 'no_update' }, manifest, disk = null } = {}) {
  const ctx = { globalThis: null };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const U = ctx.VodouSelfUpdate;
  const env = {
    t: 1_000_000,
    timers: [],
    reloads: 0,
    store: {},
    injected: [],
    checks: 0,
    fetches: 0,
  };
  U.configure({
    runtime: {
      requestUpdateCheck: async () => { env.checks++; if (check instanceof Error) throw check; return check; },
      reload: () => { env.reloads++; },
      getURL: (p) => `chrome-extension://abc/${p}`,
      getManifest: () => manifest || {
        version: '0.5.97.86',
        content_scripts: [
          { js: ['bridge-nonce.js'], matches: ['https://chatgpt.com/*'] },
          { js: ['sites.js', 'receipt.js', 'content.js'], matches: ['https://chatgpt.com/*', 'https://claude.ai/*'] },
          { js: ['inject.js'], world: 'MAIN', matches: ['https://main-world-only.example/*'] },
        ],
      },
    },
    management: { getSelf: async () => (installType instanceof Error ? Promise.reject(installType) : { installType }) },
    storage: {
      get: async (k) => ({ [k]: env.store[k] }),
      set: async (o) => { Object.assign(env.store, o); },
      remove: async (k) => { delete env.store[k]; },
    },
    tabs: { query: async (q) => { env.queried = q.url; return [{ id: 1 }, { id: 2 }, { id: null }]; } },
    scripting: { executeScript: async (o) => { if (o.target.tabId === 2) throw new Error('discarded'); env.injected.push(o); } },
    fetch: async (url, opts) => {
      env.fetches++;
      env.fetchOpts = opts;
      const d = typeof disk === 'function' ? disk(env.fetches) : disk;
      if (d instanceof Error) throw d;
      return { json: async () => (typeof d === 'string' ? { version: d } : d) };
    },
    isIdle: () => idle(),
    now: () => env.t,
    setTimeout: (fn, ms) => { env.timers.push({ fn, ms }); },
  });
  const runTimers = async () => { const ts = env.timers.splice(0); for (const x of ts) await x.fn(); };
  return { U, env, runTimers };
}

const flush = () => new Promise((r) => setImmediate(r));

test('learns the install type; unknown stays null, never guessed', async () => {
  assert.equal(await load({ installType: 'normal' }).U.learnInstallType(), 'normal');
  assert.equal(await load({ installType: 'development' }).U.learnInstallType(), 'development');
  assert.equal(await load({ installType: new Error('no management') }).U.learnInstallType(), null);
});

test('an unpacked copy answers the nudge without calling Chrome', async () => {
  const { U, env } = load({ installType: 'development' });
  await U.learnInstallType();
  const r = await U.checkNow();
  assert.equal(r.status, 'not_store_install');
  assert.equal(env.checks, 0, 'requestUpdateCheck must not be called for an unpacked copy');
});

test('policy (admin) and installer-registered (sideload) copies are Chrome-updated too, so they check', async () => {
  for (const installType of ['admin', 'sideload']) {
    const { U, env } = load({ installType, check: { status: 'no_update' } });
    await U.learnInstallType();
    assert.equal((await U.checkNow()).status, 'no_update', installType);
    assert.equal(env.checks, 1, `${installType} must ask Chrome`);
  }
  const { U, env } = load({ installType: 'other' });
  await U.learnInstallType();
  assert.equal((await U.checkNow()).status, 'not_store_install');
  assert.equal(env.checks, 0, 'other is not claimed as updatable');
});

test('a store install checks; update_available reloads once idle and leaves a marker', async () => {
  const { U, env } = load({ check: { status: 'update_available', version: '0.5.97.88' } });
  await U.learnInstallType();
  const r = await U.checkNow();
  assert.equal(r.status, 'update_available');
  await flush();
  assert.equal(env.reloads, 1);
  assert.deepEqual(
    { from: env.store[U.MARKER_KEY].from, to: env.store[U.MARKER_KEY].to, source: env.store[U.MARKER_KEY].source },
    { from: '0.5.97.86', to: '0.5.97.88', source: 'gateway' },
  );
});

test('no_update and throttled do not reload', async () => {
  for (const status of ['no_update', 'throttled']) {
    const { U, env } = load({ check: { status } });
    await U.learnInstallType();
    assert.equal((await U.checkNow()).status, status);
    await flush();
    assert.equal(env.reloads, 0, `${status} must not reload`);
  }
});

test('a rejected check is reported, not thrown', async () => {
  const { U } = load({ check: new Error('offline') });
  await U.learnInstallType();
  const r = await U.checkNow();
  assert.equal(r.status, 'error');
});

test('waits while busy, then reloads when idle', async () => {
  let busy = true;
  const { U, env, runTimers } = load({ idle: () => !busy });
  assert.equal(U.scheduleReload('0.5.97.88', 'chrome'), true);
  await flush();
  assert.equal(env.reloads, 0, 'must not reload while work is in flight');
  assert.equal(env.timers.length, 1);
  assert.equal(env.timers[0].ms, U.POLL_MS);
  await runTimers(); await flush();
  assert.equal(env.reloads, 0);
  busy = false;
  await runTimers(); await flush();
  assert.equal(env.reloads, 1);
});

test('one reload at a time — a second schedule is refused', async () => {
  const { U } = load({ idle: () => false });
  assert.equal(U.scheduleReload('0.5.97.88', 'chrome'), true);
  assert.equal(U.scheduleReload('0.5.97.88', 'gateway'), false);
});

test('still busy after GIVE_UP_MS: stops trying, never reloads, never loops', async () => {
  const { U, env, runTimers } = load({ idle: () => false });
  U.scheduleReload('0.5.97.88', 'chrome');
  await flush();
  env.t += U.GIVE_UP_MS;
  await runTimers(); await flush();
  assert.equal(env.reloads, 0);
  assert.equal(env.timers.length, 0, 'no further timers after giving up');
  assert.equal(U.pending(), null, 'a later update can schedule again');
});

test('the marker is reported exactly once', async () => {
  const { U, env } = load();
  env.store[U.MARKER_KEY] = { from: '0.5.97.86', to: '0.5.97.88' };
  assert.equal((await U.takeMarker()).from, '0.5.97.86');
  assert.equal(await U.takeMarker(), null);
});

test('after an update, re-arms ONLY the proven isolated-world pair — never inject.js', async () => {
  const { U, env } = load();
  const r = await U.reinjectOpenTabs();
  assert.deepEqual([...U.REINJECT_FILES], ['sites.js', 'content.js']);
  for (const call of env.injected) {
    assert.deepEqual([...call.files], ['sites.js', 'content.js']);
    assert.ok(!call.files.includes('inject.js'), 'inject.js lives in MAIN world and survives a reload — re-injecting double-hooks fetch');
  }
  assert.ok(!env.queried.includes('https://main-world-only.example/*'), 'MAIN-world matches are not re-armed');
  assert.deepEqual({ tabs: r.tabs, injected: r.injected }, { tabs: 3, injected: 1 },
    'tab without id skipped, a refusing tab tolerated');
});

// ── An unpacked copy reloads onto newer files in its folder ─────────────────
test('versions compare numerically — 0.5.97.100 is newer than 0.5.97.75', () => {
  const { U } = load();
  assert.equal(U.cmpVersion('0.5.97.100', '0.5.97.75'), 1);
  assert.equal(U.cmpVersion('0.5.97.75', '0.5.97.75'), 0);
  assert.equal(U.cmpVersion('0.5.97.74', '0.5.97.75'), -1);
  assert.equal(U.cmpVersion('garbage', '0.5.97.75'), null);
});

test('unpacked copy: newer manifest on disk → confirmed after the settle wait → reload, marker says disk', async () => {
  const { U, env, runTimers } = load({ installType: 'development', disk: '0.5.97.90' });
  await U.learnInstallType();
  const r = await U.checkDiskVersion();
  assert.equal(r.status, 'update_available');
  assert.equal(r.version, '0.5.97.90');
  assert.equal(env.fetchOpts.cache, 'no-store', 'must read the folder, not a cached copy');
  await flush();
  assert.equal(env.reloads, 0, 'never reload on the first sighting — the folder may be mid-copy');
  assert.equal(env.timers[0].ms, U.DISK_SETTLE_MS);
  await runTimers(); await flush();
  assert.equal(env.reloads, 1);
  assert.equal(env.store[U.MARKER_KEY].source, 'disk');
});

test('unpacked copy: a folder that changes or vanishes during the settle wait is not reloaded onto', async () => {
  // First read sees the new version mid-copy; the re-read fails (swap in progress).
  const { U, env, runTimers } = load({ installType: 'development', disk: (n) => (n === 1 ? '0.5.97.90' : new Error('gone')) });
  await U.learnInstallType();
  await U.checkDiskVersion();
  await runTimers(); await flush();
  assert.equal(env.reloads, 0);
});

test('unpacked copy: repeated checks during the settle wait start one confirmation, not many', async () => {
  const { U, env } = load({ installType: 'development', disk: '0.5.97.90' });
  await U.learnInstallType();
  await U.checkDiskVersion(); await U.checkDiskVersion(); await U.checkDiskVersion();
  assert.equal(env.timers.length, 1);
});

test('unpacked copy: same or OLDER on disk never reloads — no downgrades, no loops', async () => {
  for (const disk of ['0.5.97.86', '0.5.97.80']) {
    const { U, env } = load({ installType: 'development', disk });
    await U.learnInstallType();
    assert.equal((await U.checkDiskVersion()).status, 'no_update', disk);
    await flush();
    assert.equal(env.reloads, 0, `${disk} on disk must not reload a running 0.5.97.86`);
  }
});

test('unpacked copy: unreadable or garbage manifest does nothing', async () => {
  const a = load({ installType: 'development', disk: new Error('mid-swap') });
  await a.U.learnInstallType();
  assert.equal((await a.U.checkDiskVersion()).status, 'error');
  const b = load({ installType: 'development', disk: { version: 'not-a-version' } });
  await b.U.learnInstallType();
  assert.equal((await b.U.checkDiskVersion()).status, 'no_update');
  await flush();
  assert.equal(a.env.reloads + b.env.reloads, 0);
});

test('a Web Store copy never reads its folder — Chrome owns its updates', async () => {
  const { U, env } = load({ installType: 'normal', disk: '0.5.97.99' });
  await U.learnInstallType();
  assert.equal((await U.checkDiskVersion()).status, 'not_unpacked');
  assert.equal(env.fetches, 0);
  assert.equal(env.reloads, 0);
});

// ── background.js wiring, source-pinned ─────────────────────────────────────
test('background.js imports self-update.js statically, like the other helpers', () => {
  assert.match(BG, /import '\.\/self-update\.js';/);
});

test('bridge_ready carries install_type and a once-only updated_from', () => {
  assert.match(BG, /install_type: VodouSelfUpdate\.getInstallType\(\)/);
  assert.match(BG, /updated_from: lastSelfUpdate \? lastSelfUpdate\.from : undefined/);
  assert.match(BG, /lastSelfUpdate = null; \/\/ reported once/);
  // Declared before any reader, so the handshake cannot hit the TDZ and fail.
  assert.ok(BG.indexOf('let lastSelfUpdate = null;') < BG.indexOf('updated_from: lastSelfUpdate'));
});

test('check_update is dispatched, and Chrome\'s own update event schedules a reload', () => {
  assert.match(BG, /case 'check_update':[\s\S]{0,400}VodouSelfUpdate\.checkNow\(\)/);
  assert.match(BG, /chrome\.runtime\.onUpdateAvailable\.addListener/);
  assert.match(BG, /details\.reason !== 'update'[\s\S]{0,120}reinjectOpenTabs\(\)/);
});

test('an unpacked copy checks its folder on every connect and every 15 minutes', () => {
  assert.match(BG, /fetch: \(url, opts\) => fetch\(url, opts\)/);
  assert.match(BG, /console\.warn\('\[vbb\] bridge_ready send failed:', err\);\s*\}[\s\S]{0,400}VodouSelfUpdate\.checkDiskVersion\(\)/);
  assert.match(BG, /chrome\.alarms\.create\(DISK_VERSION_ALARM, \{ periodInMinutes: 15 \}\)/);
  assert.match(BG, /alarm\.name === DISK_VERSION_ALARM\) VodouSelfUpdate\.checkDiskVersion\(\)/);
});

test('idle means nothing awaiting an answer and no unacked batch', () => {
  for (const s of ['pendingCaptures.size === 0', 'pendingContexts.size === 0', 'pendingProbes.size === 0',
    'pendingBrain.size === 0', 'lastSentBatch === null']) {
    assert.ok(BG.includes(s), `isIdle must check ${s}`);
  }
});

test('the two unpacked-only builds report install_type on bridge_ready too', () => {
  for (const b of ['vodou-bridge', 'sideload-only-vodou-bridge']) {
    const src = fs.readFileSync(path.join(ROOT, 'extension', b, 'background.js'), 'utf8');
    const i = src.indexOf("cmd: 'bridge_ready'");
    assert.ok(i > 0, `${b}: bridge_ready`);
    // Generated from this build since 2026-09-23 (scripts/build-sideload-bridge.py),
    // so they learn it the same way: the shared self-update module.
    assert.match(src.slice(i, i + 1500), /install_type: VodouSelfUpdate\.getInstallType\(\),/, `${b}: install_type on bridge_ready`);
    assert.ok(fs.existsSync(path.join(ROOT, 'extension', b, 'self-update.js')), `${b}: ships self-update.js`);
  }
});
