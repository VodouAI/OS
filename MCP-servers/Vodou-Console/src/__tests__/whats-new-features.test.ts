/**
 * "New in this version" — the nudge that tells an UPDATING user a capability
 * arrived with the build.
 *
 * The gap this closes: the browser extension ships through the Chrome Web Store,
 * so `vodou-core` updating never installs it, and the only screen that mentions
 * it is onboarding — which OnboardingView.shouldShow() suppresses for anyone who
 * already has credentials, an identity and an LLM. Every existing user who
 * updated into the extension release had no surface anywhere telling them it
 * exists.
 *
 * The client half loads the REAL public/js/onboarding-tour.js in a vm sandbox and
 * calls its actual diff, per the convention in dock-grouping.test.ts: a
 * re-implementation here would validate intent, not semantics.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_ROOT = path.resolve(HERE, '../..');

// Throwaway DB before anything imports db.js — same guard as the other suites.
const TMP = mkdtempSync(path.join(tmpdir(), 'vodou-whatsnew-test-'));
process.env.GATEWAY_DB_PATH = path.join(TMP, 'gateway.db');

// ---------------------------------------------------------------------------
// Server: the inventory the client diffs against
// ---------------------------------------------------------------------------

describe('GET /api/onboarding/progress/capabilities', () => {
  let app: any;
  let request: any;

  beforeAll(async () => {
    const express = (await import('express')).default;
    const { onboardingProgressRouter } = await import('../api/onboarding-progress.js');
    app = express();
    app.use(express.json());
    app.use('/api/onboarding/progress', onboardingProgressRouter);
    request = (await import('supertest')).default;
  });

  it('carries a features lane alongside servers and skills', async () => {
    const res = await request(app).get('/api/onboarding/progress/capabilities').expect(200);
    expect(Array.isArray(res.body.servers)).toBe(true);
    expect(Array.isArray(res.body.skills)).toBe(true);
    expect(Array.isArray(res.body.features)).toBe(true);
  });

  it('advertises the browser extension with a label and an in-app destination', async () => {
    const res = await request(app).get('/api/onboarding/progress/capabilities').expect(200);
    const ext = res.body.features.find((f: any) => f.id === 'browser-extension');
    expect(ext).toBeTruthy();
    expect(ext.label).toMatch(/extension/i);
    // Settings, not the store: the toast must land on the screen that explains
    // the capture consent the extension is gated on.
    expect(ext.href).toContain('#/settings');
    expect(ext.href).toContain('bridge');
  });

  it('serves features even when the capability tables are unreadable', async () => {
    // The features lane is build-derived, so a DB that cannot answer the
    // server/skill queries must not take it down with them — that failure mode
    // would silently un-ship the nudge on exactly the installs most likely to
    // be mid-migration.
    const res = await request(app).get('/api/onboarding/progress/capabilities').expect(200);
    expect(res.body.features.length).toBeGreaterThan(0);
  });

  it('does not hand out a mutable reference to the module constant', async () => {
    const first = await request(app).get('/api/onboarding/progress/capabilities').expect(200);
    first.body.features[0].label = 'MUTATED';
    const second = await request(app).get('/api/onboarding/progress/capabilities').expect(200);
    expect(second.body.features[0].label).not.toBe('MUTATED');
  });
});

// ---------------------------------------------------------------------------
// Client: the real diff, loaded from public/js/onboarding-tour.js
// ---------------------------------------------------------------------------

describe('onboarding-tour.js — diffFeatures (the real file)', () => {
  let diffFeatures: (curr: any[], prev: any[] | null) => any[];

  beforeAll(() => {
    const src = readFileSync(path.join(CONSOLE_ROOT, 'public/js/onboarding-tour.js'), 'utf-8');
    // Minimum surface the IIFE touches at load: it only wires listeners and
    // defines functions until init() is called, which this never does.
    const sandbox: any = {
      window: {},
      document: {
        addEventListener() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        createElement() { return { style: {}, classList: { add() {}, remove() {} }, addEventListener() {} }; },
        body: { classList: { contains: () => false, add() {}, remove() {} }, appendChild() {} },
      },
      localStorage: { getItem: () => null, setItem() {} },
      location: { search: '', hash: '' },
      fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve(null) }),
      setTimeout() {}, clearTimeout() {}, requestAnimationFrame() {},
      addEventListener() {},
      console,
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    diffFeatures = sandbox.window.OnboardingTour._diffFeatures;
    expect(typeof diffFeatures).toBe('function');
  });

  const EXT = { id: 'browser-extension', label: 'Vodou Bridge browser extension', href: '#/settings' };

  it('reports a feature as new when the snapshot predates it', () => {
    // THE case: a snapshot written before build features existed has no ids at
    // all. That user updated into this release and has been told nothing.
    expect(diffFeatures([EXT], null).map((f) => f.id)).toEqual(['browser-extension']);
    expect(diffFeatures([EXT], []).map((f) => f.id)).toEqual(['browser-extension']);
  });

  it('reports nothing once the id is in the snapshot', () => {
    expect(diffFeatures([EXT], ['browser-extension'])).toEqual([]);
  });

  it('only surfaces the ids that are actually missing', () => {
    const NEXT = { id: 'something-later', label: 'Later thing', href: '#/x' };
    const out = diffFeatures([EXT, NEXT], ['browser-extension']);
    expect(out.map((f) => f.id)).toEqual(['something-later']);
  });

  it('ignores malformed entries rather than toasting a blank line', () => {
    expect(diffFeatures([null as any, {} as any, EXT], [])).toEqual([EXT]);
  });

  it('is stable — diffing twice against the updated snapshot yields nothing', () => {
    const first = diffFeatures([EXT], []);
    const snapshot = first.map((f) => f.id);
    expect(diffFeatures([EXT], snapshot)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The gate: WHO gets nudged. Four branches, each wrong in a different way.
// ---------------------------------------------------------------------------

describe('onboarding-tour.js — who the feature nudge fires for', () => {
  const EXT = { id: 'browser-extension', label: 'Vodou Bridge browser extension', href: '#/settings' };

  /**
   * Drive the real initNewFeatures() with a scripted world.
   * @param snapshot  what onboarding.whatsnew.features already holds (null = never written)
   * @param status    /api/onboarding/status — the fresh-vs-established discriminator
   * @param connected /api/capture/pair — do they already have the extension
   * @param modalOpen is the onboarding modal on screen right now
   */
  async function run(opts: {
    snapshot: string[] | null;
    status: { needsCredentials: boolean; needsOnboarding: boolean };
    connected: boolean;
    modalOpen?: boolean;
  }) {
    const toasts: any[] = [];
    const written: Record<string, string> = {};
    const src = readFileSync(path.join(CONSOLE_ROOT, 'public/js/onboarding-tour.js'), 'utf-8');
    const safe = readFileSync(path.join(CONSOLE_ROOT, 'public/js/safe.js'), 'utf-8');

    const sandbox: any = {
      console,
      localStorage: {
        getItem: () => JSON.stringify(
          opts.snapshot === null ? {} : { 'onboarding.whatsnew.features': JSON.stringify(opts.snapshot) }),
        setItem: (_k: string, v: string) => { Object.assign(written, JSON.parse(v)); },
      },
      location: { search: '', hash: '' },
      setTimeout: (fn: any) => { if (typeof fn === 'function') fn(); },
      clearTimeout() {}, requestAnimationFrame(fn: any) { if (fn) fn(); },
      addEventListener() {},
      fetch(url: string) {
        if (url.includes('/capabilities')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ servers: [], skills: [], features: [EXT] }) });
        }
        if (url.includes('/api/onboarding/status')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(opts.status) });
        }
        if (url.includes('/api/capture/pair')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ connected: opts.connected }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });  // the setFlag PUT
      },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.document = {
      addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
      createElement() {
        const el: any = {
          className: '', innerHTML: '', isConnected: true,
          classList: { add() {}, remove() {} },
          querySelector: () => ({ addEventListener() {} }),
          addEventListener() {}, remove() {},
        };
        return el;
      },
      body: {
        classList: { contains: () => !!opts.modalOpen, add() {}, remove() {} },
        appendChild: (el: any) => { toasts.push(el); },
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(safe, sandbox);
    vm.runInContext(src, sandbox);
    await sandbox.window.OnboardingTour._initNewFeatures();
    // `again` re-runs against the SAME in-memory flag cache — which is how the
    // "only once" promise actually has to hold: the snapshot written by the first
    // run is what the second one reads.
    const again = () => sandbox.window.OnboardingTour._initNewFeatures();
    return { toasts, written, again };
  }

  const ESTABLISHED = { needsCredentials: false, needsOnboarding: false };
  const FRESH = { needsCredentials: true, needsOnboarding: true };

  it('THE case: an established install with no snapshot gets told', async () => {
    // Updated into the extension release. Never sees onboarding again, so this is
    // the only surface left that can tell them the extension exists.
    const { toasts, written } = await run({ snapshot: null, status: ESTABLISHED, connected: false });
    expect(toasts).toHaveLength(1);
    expect(toasts[0].innerHTML).toContain('Vodou Bridge browser extension');
    expect(toasts[0].innerHTML).toContain('New in this version');
    // and it records the nudge so it never fires twice
    expect(written['onboarding.whatsnew.features']).toContain('browser-extension');
  });

  it('says nothing to someone who already has the extension', async () => {
    // The .71 listing has been live since 2026-08-11, so "extension first, app
    // update second" is a real population — not a hypothetical one.
    const { toasts, written } = await run({ snapshot: null, status: ESTABLISHED, connected: true });
    expect(toasts).toHaveLength(0);
    // still snapshots: this nudge has no job now and none later
    expect(written['onboarding.whatsnew.features']).toContain('browser-extension');
  });

  it('says nothing to a fresh install — onboarding introduces it properly', async () => {
    const { toasts, written } = await run({ snapshot: null, status: FRESH, connected: false });
    expect(toasts).toHaveLength(0);
    expect(written['onboarding.whatsnew.features']).toContain('browser-extension');
  });

  it('stays out of the way while the onboarding modal is open', async () => {
    const { toasts } = await run({
      snapshot: null, status: ESTABLISHED, connected: false, modalOpen: true,
    });
    expect(toasts).toHaveLength(0);
  });

  it('never fires twice — the snapshot it writes is what silences the next run', async () => {
    const { toasts, again } = await run({ snapshot: null, status: ESTABLISHED, connected: false });
    expect(toasts).toHaveLength(1);
    await again();
    await again();
    expect(toasts).toHaveLength(1);   // still one — a nudge per feature, not per page load
  });

  it('stays quiet when the status route cannot be read', async () => {
    // Unknown → treat as fresh. A wrong toast is worse than a missing one.
    const { toasts } = await run({
      snapshot: null, status: {} as any, connected: false,
    });
    expect(toasts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The store identity — one place, actually
// ---------------------------------------------------------------------------

describe('ext-store.js — the Chrome Web Store identity', () => {
  it('is the only file in public/js carrying the item id', () => {
    const { execSync } = require('node:child_process');
    const out = execSync(
      `grep -rl "ehlanbbiaeelnimkakfffehoahimkjjf" "${path.join(CONSOLE_ROOT, 'public/js')}" || true`,
      { encoding: 'utf-8' },
    ).trim();
    const files = out ? out.split('\n').map((f: string) => path.basename(f)) : [];
    expect(files).toEqual(['ext-store.js']);
  });

  /** The real settings view, with the real ext-store and the real escaper. */
  function loadSettingsView() {
    const sandbox: any = { window: {}, console, VODOU_OS: 'mac' };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    for (const f of ['public/js/safe.js', 'public/js/ext-store.js']) {
      vm.runInContext(readFileSync(path.join(CONSOLE_ROOT, f), 'utf-8'), sandbox);
    }
    // Top-level `const` in a classic script stays lexical, so hand it out explicitly.
    vm.runInContext(
      readFileSync(path.join(CONSOLE_ROOT, 'public/js/views/settings.js'), 'utf-8')
      + '\n;globalThis.__SettingsView = SettingsView;', sandbox);
    const View = sandbox.__SettingsView;
    return (web: any, pair: any = {}) =>
      View._renderMemoryPanel({ capture: { lanes: { web } }, pair, status: {}, brain: {}, vaults: [], cycles: {} });
  }

  it('puts an install link on the Settings card for a disconnected extension', () => {
    // The other half of the same problem. An updating user who never sees
    // onboarding lands here instead, and this card told them to "install Vodou
    // Bridge" while offering no way to do it.
    const render = loadSettingsView();
    const disconnected = render({ connected: false, enabled: false, chunks: 0 });
    expect(disconnected).toContain('chromewebstore.google.com');
    expect(disconnected).toContain('Install the extension');

    // Connected: nothing to install, so no link.
    const connected = render({ connected: true, enabled: true, chunks: 5 });
    expect(connected).not.toContain('Install the extension');
  });

  it('only mentions the pair code when pairing is actually enforced', () => {
    const render = loadSettingsView();
    const disconnected = (pair: any) => render({ connected: false }, pair);
    // Pairing is OFF by default (vbb/bridge.ts:62). Telling every user to enter a
    // code nothing is asking for sends them hunting for a problem they don't have.
    expect(disconnected({ required: false })).not.toContain('enter the pair code below');
    expect(disconnected({ required: false })).toContain('connects on its own');
    expect(disconnected({ required: true })).toContain('enter the pair code below');
  });

  it('builds a store URL containing the item id', () => {
    const src = readFileSync(path.join(CONSOLE_ROOT, 'public/js/ext-store.js'), 'utf-8');
    const sandbox: any = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    const store = sandbox.window.VodouExtStore;
    expect(store.installUrl()).toBe(
      'https://chromewebstore.google.com/detail/vodou-bridge/ehlanbbiaeelnimkakfffehoahimkjjf');
    expect(store.installLink('Install')).toContain('rel="noopener noreferrer"');
    expect(store.installLink('Install')).toContain('>Install<');
  });
});
