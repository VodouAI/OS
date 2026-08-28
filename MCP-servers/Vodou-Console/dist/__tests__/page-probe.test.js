// PLAN-MEMORY-ON-EVERY-PAGE P3 — the badge lane's gateway half.
import { describe, it, expect, beforeEach, vi } from 'vitest';
const settings = vi.hoisted(() => new Map());
vi.mock('../db.js', () => ({
    getProjectRoot: () => '/tmp/vodou-page-probe-test',
    getSetting: (k) => settings.get(k) ?? null,
    setSetting: (k, v) => { settings.set(k, v); },
}));
const { probePage, _resetPageProbeCache } = await import('../vbb/page-probe.js');
beforeEach(() => _resetPageProbeCache());
describe('page_probe', () => {
    it('counts exact, site and document hits, and carries a label from the best tier', async () => {
        const r = await probePage('https://en.wikipedia.org/wiki/Long-term_memory?utm_source=x', 'Long-term memory - Wikipedia', {
            match: async () => ({ ok: true, page: [{ text: '- page:x | LTM splits into explicit and implicit' }, { text: 'b' }], site: [{ text: 'c' }], docs: [{ name: 'Long-term memory - Wikipedia' }], site_docs: [] }),
            title: async () => ({ hit: true, label: 'memory overlaps' }),
        });
        expect(r).toMatchObject({ hit: true, exact: 2, site: 1, docs: 1, pageDocs: 1, about: true });
        expect(r.label).toBe('LTM splits into explicit and implicit');
    });
    it('is a miss with nothing stamped and no title overlap', async () => {
        const r = await probePage('https://example.com/nothing', 'Nothing here', {
            match: async () => ({ ok: true, page: [], site: [], docs: [], site_docs: [] }),
            title: async () => ({ hit: false }),
        });
        expect(r).toEqual({ hit: false, exact: 0, site: 0, docs: 0, pageDocs: 0, about: false, label: undefined });
    });
    it('degrades to a miss when the daemon is down, never throws', async () => {
        const r = await probePage('https://example.com/a', 'A', {
            match: async () => null,
            title: async () => { throw new Error('down'); },
        });
        expect(r.hit).toBe(false);
    });
    it('answers a non-http page as a miss without asking anyone', async () => {
        let asked = 0;
        const r = await probePage('chrome://extensions', 'Extensions', { match: async () => { asked++; return null; }, title: async () => { asked++; return { hit: false }; } });
        expect(r.hit).toBe(false);
        expect(asked).toBe(0);
    });
    it('serves a repeat from cache — a tab-switching burst costs one round-trip', async () => {
        let asked = 0;
        const deps = { match: async () => { asked++; return { ok: true, page: [{ text: 'x' }], site: [], docs: [], site_docs: [] }; }, title: async () => ({ hit: false }) };
        await probePage('https://example.com/p', 'P', deps);
        await probePage('https://example.com/p#frag', 'P', deps);
        expect(asked).toBe(1);
    });
});
