/**
 * A fresh install must not be able to finish onboarding with no name — and if it
 * tries, it must get a sentence, not a stack trace.
 *
 * Reported 2026-09-16, fresh install on an Intel Mac: the "Your AI" step showed
 * `Error: Cannot read properties of undefined (reading 'replace')` over a Retry
 * button. Nothing about it was Intel, and nothing was in the engine log the
 * reporter sent — the throw was in the gateway, and the wizard printed the
 * server's message verbatim.
 *
 * The chain:
 *  1. `_renderProgress` makes every step dot clickable ("click any step to
 *     jump"), with no gate on the steps behind it.
 *  2. `_data` is never rehydrated: `/api/onboarding/status` returns flags
 *     (needsCredentials, llmConfigured, …), not a profile. `userName` is set
 *     ONLY by typing it in "About you" or by signing UP (`_stepCredentials`
 *     sets it from the signup payload).
 *  3. So someone who signed IN — credentials already in `.env`, first dot
 *     reading "Saved" — and clicked ahead to "Your AI" pressed Next with
 *     `_data.userName` undefined. `_stepAI` checked only `aiName`.
 *  4. `/complete`'s guard was `if (!String(userName).trim())`. `String(undefined)`
 *     is the string "undefined" — truthy — so the guard PASSED. USER.md was
 *     written with "Name: undefined", then `upsertContinuityIdentityEnv` ran
 *     `userName.replace(...)` and threw.
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
// shells out — work that outlives the request. Same containment the timezone
// suite documents: a private shadow root so those writes never reach the shared
// harness root (or, worse, the live one).
const TMP = useShadowRoot('obname-test');
process.env.GATEWAY_DB_PATH = path.join(TMP, 'gateway.db');
afterAll(() => { try {
    rmSync(TMP, { recursive: true, force: true });
}
catch { /* a late writer may still hold it */ } });
/** Load the shipped wizard with a DOM stub that hands back the listeners it binds. */
function loadWizard() {
    const tzSrc = readFileSync(path.join(CONSOLE_ROOT, 'public/js/timezone-zones.js'), 'utf8');
    const src = readFileSync(path.join(CONSOLE_ROOT, 'public/js/views/onboarding.js'), 'utf8');
    const sandbox = {
        console: { log() { }, error() { }, warn() { } },
        document: {
            getElementById: () => null, // no inputs on screen → _saveFields leaves _data alone
            querySelector: () => null,
            querySelectorAll: () => [],
            createElement: () => ({
                set textContent(v) { this._v = String(v ?? ''); },
                get innerHTML() { return this._v ?? ''; },
            }),
        },
        setTimeout, clearTimeout, setInterval, clearInterval,
        fetch: async () => ({ ok: false, json: async () => ({}) }),
        localStorage: { getItem: () => null, setItem() { }, removeItem() { } },
        Intl: {
            DateTimeFormat: function () { return { resolvedOptions: () => ({ timeZone: 'America/Detroit' }) }; },
            supportedValuesOf: undefined,
        },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(tzSrc + '\n' + src + '\n;globalThis.__OnboardingView = OnboardingView;', sandbox);
    return sandbox.__OnboardingView;
}
/**
 * A `body` whose querySelector returns a distinct recording element per selector,
 * so the click handler `_stepAI` binds to #ob-next can be invoked directly.
 */
function recordingBody() {
    const els = {};
    const make = (sel) => (els[sel] ??= {
        listeners: {},
        value: '',
        focus() { },
        classList: { add() { }, remove() { }, toggle() { } },
        addEventListener(ev, fn) { this.listeners[ev] = fn; },
        dataset: {},
    });
    return {
        els,
        body: { innerHTML: '', querySelector: (sel) => make(sel), querySelectorAll: () => [] },
    };
}
describe('the wizard will not finish without a name', () => {
    it('Next on "Your AI" with no name goes back to About you instead of posting', () => {
        const w = loadWizard();
        const { els, body } = recordingBody();
        let posted = false;
        w._data = {}; // signed IN, jumped ahead: nothing collected
        w._finish = () => { posted = true; };
        w._render = () => { };
        w._stepAI(body);
        els['#ob-next'].listeners.click();
        expect(posted).toBe(false); // the crash needed this POST to happen
        expect(w._step).toBe(2); // About you
        expect(w._returnNotice).toBeTruthy();
        expect(w._returnFocusId).toBe('ob-userName');
    });
    it('Next still finishes when a name was collected', () => {
        const w = loadWizard();
        const { els, body } = recordingBody();
        let posted = false;
        w._data = { userName: 'Joe Tester' };
        w._finish = () => { posted = true; };
        w._render = () => { };
        w._stepAI(body);
        els['#ob-next'].listeners.click();
        expect(posted).toBe(true);
        expect(w._returnNotice).toBeFalsy();
    });
});
describe('POST /api/onboarding/complete — a missing name is a 400, not a TypeError', () => {
    let app;
    let request;
    beforeAll(async () => {
        const express = (await import('express')).default;
        const { onboardingRouter } = await import('../api/onboarding.js');
        app = express();
        app.use(express.json());
        app.use('/api/onboarding', onboardingRouter);
        request = (await import('supertest')).default;
    });
    it('rejects a body with no userName', async () => {
        const res = await request(app).post('/api/onboarding/complete')
            .send({ aiName: 'VODOU', ownerEmail: 'joe@example.com' });
        expect(res.status).toBe(400);
        expect(String(res.body.error)).toContain('userName');
        // The shape of the bug: the guard let it through and the crash surfaced here.
        expect(JSON.stringify(res.body)).not.toContain('Cannot read properties');
    });
    it('rejects a null userName the same way', async () => {
        const res = await request(app).post('/api/onboarding/complete')
            .send({ userName: null, aiName: 'VODOU', ownerEmail: 'joe@example.com' });
        expect(res.status).toBe(400);
        expect(JSON.stringify(res.body)).not.toContain('Cannot read properties');
    });
    it('rejects a missing aiName for the same reason', async () => {
        const res = await request(app).post('/api/onboarding/complete')
            .send({ userName: 'Joe Tester', ownerEmail: 'joe@example.com' });
        expect(res.status).toBe(400);
        expect(String(res.body.error)).toContain('aiName');
    });
});
