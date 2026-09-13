/**
 * A fresh install must finish onboarding with `user.timezone` SET.
 *
 * It did not. The chain, measured 2026-09-12 on an install whose
 * `gateway_settings` had no `user.timezone` row at all:
 *
 *  1. The redesigned wizard's Step 1 hint told the user their timezone was
 *     "asked in your first chat". The first chat is the nine-question
 *     interview in `src/interview.rs`, and it never asks.
 *  2. `_detectTimezone()` — `Intl.DateTimeFormat().resolvedOptions().timeZone`,
 *     carrying a comment saying nobody should ever TYPE a zone because the
 *     machine knows — was defined and never called. `public/classic` still has
 *     it wired to a real `#ob-timezone` input; the redesign dropped the input
 *     and orphaned the helper.
 *  3. So `_data.timezone` stayed undefined, `/complete`'s
 *     `if (tzClean && isValidTimezone(tzClean))` never fired, and every install
 *     ran on the host zone forever — right on a laptop, wrong in a container,
 *     on a server, or on a machine that travels.
 *  4. `/complete` then wrote the key a SECOND time with a bare `.trim()`, so
 *     the validated write was overwritten by an unvalidated one.
 *
 * Both halves are driven for real: the shipped `onboarding.js` in a vm sandbox,
 * and the shipped `/complete` route over supertest.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { useShadowRoot } from './_shadow-root.js';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_ROOT = path.resolve(HERE, '../..');

// This file drives the REAL `/complete` route, which builds a workspace and
// talks to the daemon — work that outlives the request. Pointed at the shared
// harness root it wrote into `vodou-test-*` while the global teardown was
// removing it, and every OTHER test file's run ended in ENOTEMPTY. So this file
// owns its own root: the blast radius of a side-effecting route stays inside
// the directory that invited it. Both vars are set before anything imports
// db.js, which resolves them at first connection.
// A SHADOW ROOT, not an empty directory. `mkdtempSync` alone was the trap:
// `db.ts` ignores a VODOU_PROJECT_PATH that holds no vodou-core.db and uses the
// REAL one instead, which is how this suite's earlier `beforeEach` DELETE wiped
// 28 live scheduled tasks on 2026-09-12. `useShadowRoot` symlinks the harness's
// CLONED databases in and keeps `.vodou` private, so the route's workspace
// writes stay here and its database writes land in the clone.
const TMP = useShadowRoot('obtz-test');
process.env.GATEWAY_DB_PATH = path.join(TMP, 'gateway.db');
afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* a late writer may still hold it; never fail the suite over cleanup */ } });

/**
 * Load the shipped wizard with a browser whose zone is `zone`, and with NO
 * `#ob-timezone` element — the redesign's real DOM.
 */
function loadWizard(zone: string | null, opts: { listable?: boolean; intlBroken?: boolean } = {}): any {
  const tzSrc = readFileSync(path.join(CONSOLE_ROOT, 'public/js/timezone-zones.js'), 'utf8');
  const src = readFileSync(path.join(CONSOLE_ROOT, 'public/js/views/onboarding.js'), 'utf8');
  // Zones a healthy browser recognises. `_timezoneValidatorWorks` probes `UTC`
  // and a nonsense name, so both must behave like the real Intl.
  const KNOWN = new Set(['UTC', 'America/Detroit', 'Asia/Tokyo', ...(zone ? [zone] : [])]);
  const sandbox: any = {
    console: { log() {}, error() {}, warn() {} },
    document: {
      getElementById: () => null,
      querySelector: () => ({ addEventListener() {}, focus() {}, value: '', classList: { add() {}, remove() {} } }),
      querySelectorAll: () => [],
      // `_esc` builds a div and reads back innerHTML; a stub that never
      // transcribes textContent makes every escaped value the empty string and
      // silently empties the <option> labels under test.
      createElement: () => ({ set textContent(v: string) { (this as any)._v = String(v ?? ''); }, get innerHTML() { return (this as any)._v ?? ''; } }),
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => ({ ok: false }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    Intl: {
      DateTimeFormat: function (_l?: any, o?: any) {
        // `intlBroken` models the browser this fallback exists for: one whose
        // Intl can neither name the zone nor recognise any zone. A validator
        // built on it rejects every answer, so the wizard must not use it.
        if (opts.intlBroken) throw new RangeError('Invalid time zone');
        if (o && o.timeZone && !KNOWN.has(o.timeZone)) throw new RangeError('Invalid time zone');
        return { resolvedOptions: () => ({ timeZone: zone }) };
      },
      // ES2022. A browser too old to name its own zone is usually too old to
      // list them, which is why the field degrades to a text box.
      supportedValuesOf: opts.listable ? (_k: string) => ['America/Detroit', 'Asia/Tokyo', 'UTC'] : undefined,
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(tzSrc + '\n' + src + '\n;globalThis.__OnboardingView = OnboardingView;', sandbox);
  return sandbox.__OnboardingView;
}

/** `_stepUser` binds #ob-back / #ob-next after writing innerHTML. */
function stepBody(): any {
  const el = { addEventListener() {}, focus() {}, value: '', classList: { add() {}, remove() {} } };
  return { innerHTML: '', querySelector: () => el, querySelectorAll: () => [] };
}

describe('the wizard sends a timezone nobody had to type', () => {
  it('adopts the browser zone even though no #ob-timezone input exists', () => {
    const w = loadWizard('America/Detroit');
    w._data = {};
    w._saveFields();
    expect(w._data.timezone).toBe('America/Detroit');
  });

  it('leaves it unset when the browser cannot say, rather than guessing', () => {
    // An unset zone keeps `tz_source` at `host`, which is exactly what the
    // commitments timezone nudge watches for. A guess would silence it.
    const w = loadWizard(null);
    w._data = {};
    w._saveFields();
    expect(w._data.timezone).toBeFalsy();
  });

  it('never overwrites a zone the user already chose', () => {
    const w = loadWizard('America/Detroit');
    w._data = { timezone: 'Asia/Tokyo' };
    w._saveFields();
    expect(w._data.timezone).toBe('Asia/Tokyo');
  });

  it('the Step 1 hint no longer claims the first chat asks for a timezone', () => {
    // src/interview.rs owns the nine questions and none is about a timezone;
    // the hint promised otherwise for as long as the redesign has shipped.
    const tzSrc = readFileSync(path.join(CONSOLE_ROOT, 'public/js/timezone-zones.js'), 'utf8');
  const src = readFileSync(path.join(CONSOLE_ROOT, 'public/js/views/onboarding.js'), 'utf8');
    const hint = src.split('\n').find((l) => l.includes('onboarding-hint') && l.includes('asked in your first chat')) || '';
    expect(hint).not.toMatch(/timezone[^.]*asked in your first chat/);
    expect(hint).toContain('read from this browser');
  });
});

describe('POST /api/onboarding/complete — one key, one writer, one guard', () => {
  let app: any;
  let request: any;
  let getSetting: any;

  beforeAll(async () => {
    const db = await import('../db.js');
    getSetting = db.getSetting;
    const express = (await import('express')).default;
    const { onboardingRouter } = await import('../api/onboarding.js');
    app = express();
    app.use(express.json());
    app.use('/api/onboarding', onboardingRouter);
    request = (await import('supertest')).default;
  });

  it('stores a valid zone the wizard detected', async () => {
    await request(app).post('/api/onboarding/complete')
      .send({ userName: 'Chad', callThem: 'Chad', ownerEmail: 'a@b.c', timezone: 'America/Detroit' });
    expect(getSetting('user.timezone')).toBe('America/Detroit');
  });

  it('refuses a zone that is not a zone — the second, unguarded write is gone', async () => {
    // Before the fix a bare `setSetting(String(timezone).trim())` ran AFTER the
    // validated one, so this landed verbatim in the canonical key.
    await request(app).post('/api/onboarding/complete')
      .send({ userName: 'Chad', callThem: 'Chad', ownerEmail: 'a@b.c', timezone: 'Eastern' });
    expect(getSetting('user.timezone')).not.toBe('Eastern');
  });
});

describe('when the browser cannot say, onboarding ASKS — and will not proceed without it', () => {
  it('renders no timezone field at all when detection worked', () => {
    // A question whose answer is already known is friction that teaches people
    // to click past questions.
    const w = loadWizard('America/Detroit');
    w._data = {};
    expect(w._timezoneNeedsAsking()).toBe(false);
    expect(w._timezoneField()).toBe('');
  });

  it('renders a REQUIRED field when detection came back empty', () => {
    const w = loadWizard(null);
    w._data = {};
    expect(w._timezoneNeedsAsking()).toBe(true);
    const html = w._timezoneField();
    expect(html).toContain('id="ob-timezone"');
    expect(html).toContain('required');
    expect(html).toContain('ob-required');
  });

  it('is always the Settings dropdown — a curated list even when the browser cannot enumerate zones', () => {
    // The first draft of this field degraded to a free-text box, which is the
    // exact control Settings replaced: a typo does not fail, it silently
    // reverts the whole system to the host clock.
    const listable = loadWizard(null, { listable: true });
    listable._data = {};
    expect(listable._timezoneField()).toContain('<select');
    expect(listable._timezoneField()).toContain('America/Detroit');

    const bare = loadWizard(null);
    bare._data = {};
    const html = bare._timezoneField();
    expect(html).toContain('<select');
    expect(html).not.toContain('<input');
    expect(html).toContain('America/Detroit'); // from the shared fallback list
  });

  it('marks nothing chosen until the person chooses, so unanswered is not "the first row"', () => {
    const w = loadWizard(null, { listable: true });
    w._data = {};
    const html = w._timezoneField();
    expect(html).toMatch(/<option value=""[^>]*selected/);
  });

  it('does not validate with an Intl that rejects everything — that is a door with no key', () => {
    // The browser this field exists for may have an Intl so broken it refuses
    // `UTC`. Validating with it would reject every answer the person gives.
    const broken = loadWizard(null, { intlBroken: true });
    expect(broken._timezoneValidatorWorks()).toBe(false);
    const working = loadWizard('America/Detroit');
    expect(working._timezoneValidatorWorks()).toBe(true);
  });

  it('the Step 1 hint says the field is there when it is, and not when it is not', () => {
    const asked = loadWizard(null);
    asked._data = {};
    const body: any = stepBody();
    asked._stepUser(body);
    expect(body.innerHTML).toContain('could not tell me');
    expect(body.innerHTML).toContain('id="ob-timezone"');

    const silent = loadWizard('America/Detroit');
    silent._data = {};
    const body2: any = stepBody();
    silent._stepUser(body2);
    expect(body2.innerHTML).toContain('read from this browser');
    expect(body2.innerHTML).not.toContain('id="ob-timezone"');
  });
});

describe('the timezone control is spelled once', () => {
  // Settings grew the good dropdown; onboarding grew a second, worse one.
  // Neither view may own the list, the offsets or the fallback again.
  const VIEWS = ['public/js/views/settings.js', 'public/js/views/onboarding.js'];

  it('neither view re-implements the zone list, the offsets or the fallback', () => {
    for (const rel of VIEWS) {
      const body = readFileSync(path.join(CONSOLE_ROOT, rel), 'utf8')
        .split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
      for (const needle of ['supportedValuesOf', 'longOffset', 'FALLBACK_ZONES']) {
        expect(body, `${rel} re-implements ${needle}`).not.toContain(needle);
      }
    }
  });

  it('both views render their select through the one module', () => {
    for (const rel of VIEWS) {
      const body = readFileSync(path.join(CONSOLE_ROOT, rel), 'utf8');
      expect(body, `${rel} does not call the shared control`).toContain('VodouTimezone.selectHtml');
    }
  });

  it('the page loads the module before the views that call it', () => {
    const html = readFileSync(path.join(CONSOLE_ROOT, 'public/index.html'), 'utf8');
    const mod = html.indexOf('/js/timezone-zones.js');
    expect(mod, 'timezone-zones.js is not loaded at all').toBeGreaterThan(-1);
    for (const v of ['/js/views/settings.js', '/js/views/onboarding.js']) {
      expect(mod, `loaded after ${v}`).toBeLessThan(html.indexOf(v));
    }
  });
});
