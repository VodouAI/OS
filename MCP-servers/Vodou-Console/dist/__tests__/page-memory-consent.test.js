/**
 * Page-memory consent — PLAN-MEMORY-ON-EVERY-PAGE P1 compliance bundle.
 *
 * The page-memory lane reads the ADDRESS AND TITLE OF WHATEVER TAB THE USER IS
 * VIEWING, on any host, and sends it to the local gateway. Chrome Web Store policy
 * requires prominent disclosure and affirmative consent before a practice like
 * that runs, and local-only processing does not exempt it (User-Data FAQ Q3).
 *
 * Source-level guards, same idiom as `backfill-consent.test.ts`, and for the same
 * reason: the failure mode is SILENT. Nothing breaks, no test goes red, the panel
 * simply starts reading tabs before anyone said yes — and the first party to
 * notice is a reviewer, or nobody.
 *
 * These assert the SHAPE of the gate, not the wording of the disclosure. Copy will
 * be rewritten; "the read cannot happen before the check" must not.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
const EXT = '../../../../extension/Store-vodou-bridge/';
const R = (f) => fs.readFileSync(new URL(EXT + f, import.meta.url), 'utf8');
const panelJs = R('sidepanel.js');
const panelHtml = R('sidepanel.html');
/** The page-memory IIFE only — so a gate somewhere else in the file cannot pass for this one. */
function pageMemModule() {
    const start = panelJs.indexOf('function initPageMem()');
    expect(start, 'initPageMem() has been renamed or removed — this whole file is now testing nothing').toBeGreaterThan(0);
    return panelJs.slice(start);
}
/**
 * The same module with comment-only lines blanked.
 *
 * Needed for the ORDERING test, which caught itself out: the comment above the
 * gate reads "the gate comes FIRST, before chrome.tabs.query", so a plain
 * indexOf found the call site's own DESCRIPTION 122 characters ahead of the gate
 * and reported the order backwards. Prose about a call is not the call — the same
 * trap that made `scripts/verify-cws-claims.py` count 6 executeScript sites in a
 * file with 7. Line-based and conservative: only lines that OPEN with a comment
 * are dropped, so nothing reaches inside a line of real code.
 */
function pageMemCode() {
    return pageMemModule()
        .split('\n')
        .map((l) => {
        const t = l.trimStart();
        return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') ? '' : l;
    })
        .join('\n');
}
describe('page-memory consent', () => {
    it('is OFF by default — the flag starts false and is never initialised true', () => {
        const mod = pageMemModule();
        expect(mod).toMatch(/let\s+enabled\s*=\s*false/);
        expect(mod, 'enabled must never be seeded from a default-true expression')
            .not.toMatch(/let\s+enabled\s*=\s*(true|!!\s*\(?\s*v\s*\[\s*PAGE_MEM_KEY\s*\]\s*\)?\s*\|\|\s*true)/);
    });
    it('checks consent BEFORE reading the tab, not after', () => {
        // Ordering is the whole control. A gate placed after chrome.tabs.query would
        // still have read the tab -- which is precisely the thing being consented to.
        const mod = pageMemCode();
        const gate = mod.indexOf('if (!enabled) return;');
        const read = mod.indexOf('chrome.tabs.query');
        expect(gate, 'the consent gate is gone from refresh()').toBeGreaterThan(0);
        expect(read).toBeGreaterThan(0);
        expect(gate, 'consent must be checked before chrome.tabs.query, not after').toBeLessThan(read);
    });
    it('asks before the first read, and records WHICH disclosure was shown', () => {
        const mod = pageMemModule();
        // A boolean cannot express "they agreed to the OLD wording", and the Aug-2026
        // CWS amendments require a changed practice to be re-disclosed to EXISTING
        // installs. So the stored value is a version and the comparison is `<`.
        expect(mod).toMatch(/DISCLOSURE_VERSION/);
        expect(mod).toMatch(/shown\s*<\s*DISCLOSURE_VERSION/);
    });
    it('renders the disclosure card unticked, with an explicit affirmative action', () => {
        expect(panelHtml).toMatch(/id="page-consent"/);
        expect(panelHtml).toMatch(/id="page-consent-yes"/);
        expect(panelHtml).toMatch(/id="page-consent-no"/);
        // `hidden` in the markup: the card is revealed by the storage check, so it
        // cannot flash on a panel whose owner already answered.
        expect(panelHtml).toMatch(/id="page-consent"[^>]*\shidden/);
        // No pre-ticked checkbox anywhere in the consent card -- affirmative consent
        // means the user acts, not that they fail to opt out.
        const card = panelHtml.slice(panelHtml.indexOf('id="page-consent"'));
        const cardEnd = card.indexOf('id="page-mem"');
        expect(card.slice(0, cardEnd)).not.toMatch(/checked/);
    });
    it('states what is read and where it goes, in the card and in Settings', () => {
        // Not a wording test: these two facts are the disclosure. If either stops
        // being stated, the disclosure is no longer prominent OR no longer complete.
        for (const [where, s] of [['card+settings', panelHtml]]) {
            expect(s, `${where} must say the tab's address is read`).toMatch(/address and title of the tab/i);
            expect(s, `${where} must say where it goes`).toMatch(/your own computer/i);
        }
    });
    it('promises no browsing history, which is only true while the lane is panel-only', () => {
        // The claim that makes this defensible is that nothing is recorded about pages
        // merely visited. If a passive/background lane is ever added, this assertion
        // should fail and force the copy -- and the privacy form -- to be revisited.
        expect(panelHtml).toMatch(/never recorded|nothing is recorded about pages/i);
        const bg = R('background.js');
        // sendActiveTab is the background tab lane and it MUST stay host-gated; it is
        // the reason the extension does not collect browsing history in the background.
        const sat = bg.slice(bg.indexOf('function sendActiveTab()'));
        expect(sat.slice(0, 1200), 'sendActiveTab must stay gated to declared hosts')
            .toMatch(/isSupportedTabHost/);
    });
    it('has a Settings toggle so consent is revocable', () => {
        expect(panelHtml).toMatch(/id="page-mem-enabled"/);
        expect(pageMemModule()).toMatch(/page-mem-enabled/);
    });
    it('turning it off stops the lane and clears what was shown', () => {
        const mod = pageMemModule();
        const off = mod.slice(mod.indexOf('function setEnabled'));
        expect(off).toMatch(/list\.innerHTML\s*=\s*''/);
        expect(off).toMatch(/box\.hidden\s*=\s*true/);
    });
});
