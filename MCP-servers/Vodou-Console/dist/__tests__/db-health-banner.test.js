/**
 * DI-2 (ALPHA-READINESS §9 D) — the damaged-database banner.
 *
 * gateway.db has corrupted itself three times with no identified cause. The
 * gateway has reported `dbHealthy` on /health the whole time and NOTHING in the
 * UI read it, so the only observable symptom of "messages are being lost" was
 * messages quietly not being there.
 *
 * This is the visibility half of DI-2 and deliberately not the automatic
 * fail-over half — recovery for a corruption of unknown cause risks masking the
 * signal that would identify it (§9.3).
 *
 * The script is plain browser JS, so it is exercised the way a browser does:
 * a real DOM, a stubbed fetch, and the module's own polling. Four claims, and
 * the last two are the ones that decide whether people trust it:
 *   · dbHealthy:false raises the banner
 *   · dbHealthy:true keeps it down
 *   · a MISSING field (an older gateway) does not raise it — otherwise every
 *     older install shows a red data-loss warning that is not true
 *   · recovery lowers it again
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
/**
 * A MINIMAL DOM SHIM — and it is worth being blunt about what that means.
 *
 * This package has no jsdom, and CLAUDE.md forbids `npm install <name>` inside
 * MCP-servers/* (the vendored @vodou/* links get pruned). So this stubs exactly
 * the seven DOM calls the banner makes. What that buys: the REAL shipped file
 * runs, and its user-facing copy and show/hide decisions are asserted. What it
 * does NOT buy: proof that the element renders, stacks above the app, or is
 * readable. Those need a browser; see §9.2.
 */
function installDomShim() {
    const nodes = new Map();
    const mkEl = () => {
        const el = {
            id: '', hidden: false, innerHTML: '', style: { cssText: '' },
            attrs: {},
            handlers: {},
            setAttribute(k, v) { this.attrs[k] = v; },
            getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
            // The banner delegates its click handling to the container, because the
            // poll rewrites innerHTML and would discard a handler bound to the button.
            addEventListener(ev, fn) { this.handlers[ev] = fn; },
            get textContent() { return String(this.innerHTML).replace(/<[^>]*>/g, ''); },
        };
        return el;
    };
    const doc = {
        _handlers: {},
        createElement: () => mkEl(),
        getElementById: (id) => nodes.get(id) || null,
        addEventListener(ev, fn) { this._handlers[ev] = fn; },
        body: { appendChild: (el) => { nodes.set(el.id, el); return el; } },
    };
    globalThis.document = doc;
    return { doc, nodes };
}
const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', '..', 'public', 'js', 'shell', 'db-health-banner.js');
/** Run the IIFE against the current jsdom document, returning its DOMContentLoaded handler. */
/**
 * The script's DOMContentLoaded handler is synchronous — it calls its async
 * tick() without returning the promise, and then arms a setInterval. So a test
 * must (a) let the microtask queue drain before asserting, and (b) neutralise
 * the interval, or vitest hangs on a timer that outlives the test.
 */
async function flush() { for (let i = 0; i < 8; i++)
    await Promise.resolve(); }
function loadBanner(doc) {
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = () => 0; // the poll is driven by hand below
    // eslint-disable-next-line no-new-func
    new Function(fs.readFileSync(SCRIPT, 'utf8'))();
    globalThis.setInterval = realSetInterval;
    const onReady = doc._handlers['DOMContentLoaded'];
    if (!onReady)
        throw new Error('script registered no DOMContentLoaded handler');
    return async () => { onReady(); await flush(); };
}
const banner = () => globalThis.document.getElementById('vodou-db-health-banner');
/**
 * Click the dismiss (or reopen) control the way the delegated handler sees it —
 * an event whose target answers `data-db-health`.
 */
function clickControl(act) {
    const el = banner();
    const onClick = el && el.handlers && el.handlers['click'];
    if (!onClick)
        throw new Error('banner registered no click handler');
    onClick({ target: { getAttribute: (k) => (k === 'data-db-health' ? act : null) } });
}
function stubHealth(body) {
    globalThis.fetch = vi.fn(async () => ({
        ok: true, json: async () => body,
    }));
}
describe('DI-2 — the database-damage banner', () => {
    let doc;
    beforeEach(() => { ({ doc } = installDomShim()); });
    afterEach(() => { delete globalThis.document; });
    it('raises the banner when the gateway reports dbHealthy:false', async () => {
        stubHealth({ status: 'ok', dbHealthy: false, db: { ok: false, reason: 'quick_check: row 4 missing from index' } });
        await loadBanner(doc)();
        const el = banner();
        expect(el).not.toBeNull();
        expect(el.hidden).toBe(false);
        expect(el.textContent).toContain('may not be saved');
        // The operator needs to know WHERE to look, not just that something is wrong.
        expect(el.innerHTML).toContain('[db-health]');
        // And must not be told their memory files are gone — they are not.
        expect(el.textContent).toContain('memory files on disk are unaffected');
        // The gateway's own reason is carried through, not swallowed.
        expect(el.textContent).toContain('row 4 missing from index');
        // Announced as an alert so a screen reader does not miss data loss.
        expect(el.attrs.role).toBe('alert');
    });
    it('stays down when the database is healthy', async () => {
        stubHealth({ status: 'ok', dbHealthy: true, db: { ok: true } });
        await loadBanner(doc)();
        const el = banner();
        expect(el === null || el.hidden).toBeTruthy();
    });
    it('stays down when the field is ABSENT — an older gateway is not a damaged one', async () => {
        // Inferring corruption from a missing field would put a red data-loss
        // warning on every install running an older gateway build.
        stubHealth({ status: 'ok' });
        await loadBanner(doc)();
        const el = banner();
        expect(el === null || el.hidden).toBeTruthy();
    });
    it('stays down when /health itself is unreachable — that is a different problem', async () => {
        globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
        await loadBanner(doc)();
        const el = banner();
        expect(el === null || el.hidden).toBeTruthy();
    });
    /**
     * DISMISSAL (2026-09-04). The alarm that day was CORRECT and stayed up for
     * hours of legitimate diagnosis, on every tab, with no way to move it aside.
     * A warning you cannot put down gets routed around — people stop opening the
     * console, which is this banner's own failure mode reached from the far side.
     *
     * The line these tests hold: it may be put DOWN, never turned into NOTHING.
     */
    describe('the dismiss control', () => {
        const damaged = (reason) => stubHealth({ status: 'ok', dbHealthy: false, db: { ok: false, reason } });
        it('offers a labelled dismiss button', async () => {
            damaged('quick_check: row 4 missing from index');
            await loadBanner(doc)();
            expect(banner().innerHTML).toContain('data-db-health="dismiss"');
            // A real button, so it is reachable and pressable from the keyboard.
            expect(banner().innerHTML).toContain('<button type="button"');
            expect(banner().innerHTML).toContain('aria-label="Dismiss this warning"');
        });
        it('collapses to a chip rather than disappearing', async () => {
            damaged('quick_check: row 4 missing from index');
            await loadBanner(doc)();
            clickControl('dismiss');
            const el = banner();
            expect(el.hidden, 'a data-loss alarm must never become nothing').toBe(false);
            expect(el.textContent).toContain('Database damaged');
            expect(el.textContent).not.toContain('may not be saved'); // the bar is out of the way
            expect(el.innerHTML).toContain('data-db-health="expand"'); // and reopenable
        });
        it('stays collapsed while the verdict is unchanged', async () => {
            damaged('quick_check: row 4 missing from index');
            const ready = loadBanner(doc);
            await ready();
            clickControl('dismiss');
            await ready(); // the next poll, same verdict
            expect(banner().textContent).toContain('Database damaged');
            expect(banner().textContent).not.toContain('may not be saved');
        });
        /**
         * The one that matters. On 2026-09-04 the error moved from `2nd reference to
         * page 56933` to `Rowid 687194767425 out of order` under the same latched
         * flag — a second, different fault. A dismissal of the first must not
         * silently cover the second.
         */
        it('reopens itself when the verdict changes', async () => {
            damaged('Tree 44 page 44599 cell 0: 2nd reference to page 56933');
            const ready = loadBanner(doc);
            await ready();
            clickControl('dismiss');
            expect(banner().textContent).toContain('Database damaged');
            damaged('Tree 44 page 44599 cell 291: Rowid 687194767425 out of order');
            await ready();
            expect(banner().textContent, 'a new fault is not covered by the old shrug').toContain('may not be saved');
            expect(banner().textContent).toContain('687194767425');
        });
        it('comes back expanded when damage returns after a recovery', async () => {
            let reason = 'quick_check: row 4 missing from index';
            globalThis.fetch = vi.fn(async () => ({
                ok: true,
                json: async () => (reason === null
                    ? { status: 'ok', dbHealthy: true }
                    : { status: 'ok', dbHealthy: false, db: { ok: false, reason } }),
            }));
            const ready = loadBanner(doc);
            await ready();
            clickControl('dismiss');
            reason = null; // repaired
            await ready();
            expect(banner().hidden).toBe(true);
            reason = 'quick_check: row 4 missing from index'; // and damaged again
            await ready();
            expect(banner().hidden).toBe(false);
            expect(banner().textContent, 'returning damage is news, not a repeat').toContain('may not be saved');
        });
    });
    it('lowers the banner again when the database recovers', async () => {
        let healthy = false;
        globalThis.fetch = vi.fn(async () => ({
            ok: true, json: async () => ({ status: 'ok', dbHealthy: healthy }),
        }));
        const ready = loadBanner(doc);
        await ready();
        expect(banner().hidden).toBe(false);
        healthy = true;
        await ready(); // the next poll, driven directly
        expect(banner().hidden).toBe(true);
    });
});
