/**
 * When the gateway asks the bridge to have Chrome check the Web Store.
 *
 * Chrome is the source of truth for a copy it updates, so the ask no longer waits
 * for app.vodou.ai's record to say "behind" — that record lagged the store by
 * eight versions. The rule, each part a real failure if dropped:
 *   · only channel store AND a Chrome-updated install type — an unpacked copy
 *     cannot be updated by Chrome, and a bridge older than install_type does not
 *     know the `check_update` command;
 *   · at most hourly per installed version — Chrome answers `throttled` to
 *     frequent checks — but again at once when the version changes, since the
 *     previous answer described the previous version;
 *   · every answer is handed on to be kept;
 *   · never throws — a missed ask only means Chrome's own schedule.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { shouldAskChrome, maybeAskChrome, _resetAskState, ASK_INTERVAL_MS, } from '../vbb/ext-update-nudge.js';
const status = (over = {}) => ({
    installed: '0.5.97.86',
    channel: 'store',
    latest: null,
    latest_source: null,
    update_available: false,
    unsupported: false,
    self_updating: true,
    install_type: 'normal',
    download_url: null,
    release_notes: [],
    ...over,
});
describe('shouldAskChrome', () => {
    const T = 10 * ASK_INTERVAL_MS;
    it('asks a Web Store install even when the server record says nothing is newer', () => {
        // The point of asking Chrome: the record can be stale in either direction.
        expect(shouldAskChrome(status({ update_available: false, latest: null }), null, T)).toBe(true);
    });
    it('asks admin and sideload installs — Chrome updates those too', () => {
        expect(shouldAskChrome(status({ install_type: 'admin' }), null, T)).toBe(true);
        expect(shouldAskChrome(status({ install_type: 'sideload' }), null, T)).toBe(true);
    });
    it('never asks an unpacked copy, an unknown install type, or other', () => {
        expect(shouldAskChrome(status({ install_type: 'development' }), null, T)).toBe(false);
        expect(shouldAskChrome(status({ install_type: null }), null, T)).toBe(false);
        expect(shouldAskChrome(status({ install_type: 'other' }), null, T)).toBe(false);
    });
    it('never asks a full (sideload-only) build', () => {
        expect(shouldAskChrome(status({ channel: 'full' }), null, T)).toBe(false);
    });
    it('the first ask does not depend on what the clock reads', () => {
        expect(shouldAskChrome(status(), null, 0)).toBe(true);
    });
    it('waits the full interval for the same installed version', () => {
        const last = { at: T, forVersion: '0.5.97.86' };
        expect(shouldAskChrome(status(), last, T + ASK_INTERVAL_MS - 1)).toBe(false);
        expect(shouldAskChrome(status(), last, T + ASK_INTERVAL_MS)).toBe(true);
    });
    it('asks again at once when the installed version changed — e.g. right after an update', () => {
        const last = { at: T, forVersion: '0.5.97.86' };
        expect(shouldAskChrome(status({ installed: '0.5.97.88' }), last, T + 1)).toBe(true);
    });
});
describe('maybeAskChrome', () => {
    beforeEach(() => _resetAskState());
    const make = (s, answer, start = 1_000_000) => {
        let t = start;
        let cur = s;
        const calls = { check: 0, recorded: [] };
        const d = {
            status: () => cur,
            check: async () => { calls.check++; return answer(); },
            record: (r) => { calls.recorded.push(r); },
            now: () => t,
        };
        return { d, calls, advance: (ms) => { t += ms; }, set: (n) => { cur = n; } };
    };
    it('asks once, hands the answer on to be kept, and returns it', async () => {
        const { d, calls } = make(status(), async () => ({ status: 'update_available', version: '0.5.97.88' }));
        const r = await maybeAskChrome('test', d);
        expect(calls.check).toBe(1);
        expect(calls.recorded).toEqual([{ status: 'update_available', version: '0.5.97.88' }]);
        expect(r).toEqual({ status: 'update_available', version: '0.5.97.88' });
    });
    it('a reconnect storm asks once, not once per connect', async () => {
        const { d, calls, advance } = make(status(), async () => ({ status: 'no_update' }));
        await maybeAskChrome('connect', d);
        advance(60_000);
        await maybeAskChrome('connect', d);
        await maybeAskChrome('connect', d);
        expect(calls.check).toBe(1);
        advance(ASK_INTERVAL_MS);
        await maybeAskChrome('tick', d);
        expect(calls.check).toBe(2);
    });
    it('after the bridge updates itself, the new version is asked about straight away', async () => {
        const h = make(status(), async () => ({ status: 'no_update' }));
        await maybeAskChrome('connect', h.d);
        h.advance(60_000);
        h.set(status({ installed: '0.5.97.88' }));
        await maybeAskChrome('connect', h.d);
        expect(h.calls.check).toBe(2);
    });
    it('asks nothing when not warranted', async () => {
        const { d, calls } = make(status({ install_type: 'development' }), async () => ({ status: 'x' }));
        expect(await maybeAskChrome('test', d)).toBeNull();
        expect(calls.check).toBe(0);
        expect(calls.recorded).toEqual([]);
    });
    it('never throws — not when the status read fails, the check rejects, or keeping fails', async () => {
        const throwingStatus = { status: () => { throw new Error('db locked'); }, check: async () => null, record: () => { }, now: () => 1 };
        await expect(maybeAskChrome('test', throwingStatus)).resolves.toBeNull();
        _resetAskState();
        const { d } = make(status(), async () => { throw new Error('bridge gone'); });
        await expect(maybeAskChrome('test', d)).resolves.toBeNull();
        _resetAskState();
        const bad = { ...d, check: async () => ({ status: 'no_update' }), record: () => { throw new Error('x'); } };
        await expect(maybeAskChrome('test', bad)).resolves.toEqual({ status: 'no_update' });
    });
});
