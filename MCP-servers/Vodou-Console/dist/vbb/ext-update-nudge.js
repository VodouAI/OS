/**
 * Asking Chrome which Vodou Bridge version is current — the gateway's half.
 *
 * Chrome checks the Web Store for extension updates every few hours and installs
 * one when the extension's service worker next unloads. The bridge's worker holds
 * a WebSocket to this gateway, and an open socket keeps a worker alive, so an
 * approved update could wait for a browser restart. The extension now applies
 * updates itself once idle (extension/Store-vodou-bridge/self-update.js); this
 * module asks it to have Chrome check.
 *
 * Chrome is the source of truth for a copy it updates: it asks Google's update
 * server directly. So the gateway asks Chrome hourly for every such copy, and
 * keeps the answer (bridge.ts recordChromeUpdate) for extension-version.ts to
 * prefer over app.vodou.ai's record. That record was a person remembering to run
 * a script on the day Google approved a build — it read 0.5.97.78 while the store
 * served 0.5.97.86. Asking Chrome needs nothing new on any server (standing rule:
 * remote servers at the bare minimum). The record stays for what only Vodou can
 * say: the minimum-supported floor, and "latest" for unpacked copies.
 *
 * Only a copy Chrome updates is asked — install type `normal`, `admin` or
 * `sideload`. An unpacked copy (`development`), or a bridge too old to report
 * its install type, is never sent the command: the old ones would not recognise
 * it, and nothing Chrome does can update an unpacked copy.
 *
 * At most hourly for a given installed version (Chrome answers `throttled` to
 * frequent checks), and again as soon as the installed version changes — after an
 * update the previous answer described the previous version.
 */
import { extensionVersionStatus, CHROME_UPDATED_INSTALL_TYPES, } from '../api/extension-version.js';
import { bridgeCheckUpdate, bridgeRecordChromeUpdate } from './bridge.js';
export const ASK_INTERVAL_MS = 60 * 60 * 1000;
const TICK_MS = 60 * 60 * 1000;
/** The last ask this process made: when, and about which installed version. */
let lastAsk = null;
let ticker = null;
/** Pure: should the connected bridge be asked to have Chrome check now? */
export function shouldAskChrome(s, last, now) {
    if (s.channel !== 'store')
        return false;
    if (s.install_type === null || !CHROME_UPDATED_INSTALL_TYPES.has(s.install_type))
        return false;
    if (!s.installed)
        return false;
    if (last === null)
        return true;
    if (last.forVersion !== s.installed)
        return true; // a different version is a new question
    return now - last.at >= ASK_INTERVAL_MS;
}
const LIVE = {
    status: () => extensionVersionStatus(),
    check: () => bridgeCheckUpdate(),
    record: (r) => bridgeRecordChromeUpdate(r),
    now: () => Date.now(),
};
/**
 * Ask if warranted, and keep Chrome's answer. Returns the answer, or null when
 * nothing was asked. Never throws: a missed ask only means Chrome's own schedule.
 */
export async function maybeAskChrome(reason, deps = LIVE) {
    let s;
    try {
        s = deps.status();
    }
    catch {
        return null;
    }
    const now = deps.now();
    if (!shouldAskChrome(s, lastAsk, now))
        return null;
    lastAsk = { at: now, forVersion: s.installed };
    let r = null;
    try {
        r = await deps.check();
    }
    catch {
        r = null;
    }
    try {
        deps.record(r);
    }
    catch { /* keeping the answer is best-effort */ }
    const said = r?.status === 'update_available' ? `update_available → v${r.version ?? '?'}` : (r?.status ?? 'no answer');
    console.log(`[vbb] asked Chrome for a bridge update (${reason}), have v${s.installed}: ${said}`);
    return r;
}
/**
 * Re-ask hourly while the gateway runs. Idempotent; the timer never holds the
 * process open.
 */
export function startAskTicker() {
    if (ticker)
        return;
    ticker = setInterval(() => { void maybeAskChrome('tick'); }, TICK_MS);
    ticker.unref?.();
}
/** Tests only. */
export function _resetAskState() {
    lastAsk = null;
    if (ticker) {
        clearInterval(ticker);
        ticker = null;
    }
}
