import { describe, it, expect, beforeEach, vi } from 'vitest';
const settings = vi.hoisted(() => new Map());
vi.mock('../db.js', () => ({
    getSetting: (k) => settings.get(k) ?? null,
    setSetting: (k, v) => { settings.set(k, v); },
}));
const m = await import('../page-site-mode.js');
beforeEach(() => settings.clear());
describe('page-site-mode', () => {
    it('sensitive hosts default to off; everything else to collect', () => {
        for (const h of ['chase.com', 'www.wellsfargo.com', 'secure.bankofamerica.com', 'mychart.example.org', 'accounts.google.com', 'login.microsoftonline.com', 'irs.gov', 'my.1password.com', 'firstnational-bank.com'])
            expect(m.getSiteMode(h).mode, h).toBe('off');
        for (const h of ['en.wikipedia.org', 'chatgpt.com', 'github.com', 'notion.so', 'httpbin.org'])
            expect(m.getSiteMode(h)).toMatchObject({ mode: 'collect', source: 'default' });
    });
    it('a user rule wins over sensitive, applies to subdomains, and null clears it', () => {
        m.setSiteMode('Chase.com', 'suggest');
        expect(m.getSiteMode('www.chase.com')).toMatchObject({ mode: 'suggest', source: 'user', ruleHost: 'chase.com' });
        expect(m.getSiteMode('secure.chase.com').mode).toBe('suggest');
        m.setSiteMode('secure.chase.com', 'off');
        expect(m.getSiteMode('secure.chase.com')).toMatchObject({ mode: 'off', ruleHost: 'secure.chase.com' });
        m.setSiteMode('chase.com', null);
        expect(m.getSiteMode('www.chase.com')).toMatchObject({ mode: 'off', source: 'sensitive' });
        expect(m.listSiteModes()).toEqual([{ host: 'secure.chase.com', mode: 'off' }]);
    });
    it('rejects junk hosts and junk modes', () => {
        expect(() => m.setSiteMode('not a host', 'off')).toThrow();
        expect(() => m.setSiteMode('example.com', 'loud')).toThrow();
    });
    it('the global default can be changed', () => {
        settings.set('memory.page.default_mode', 'suggest');
        expect(m.getSiteMode('example.com')).toMatchObject({ mode: 'suggest', source: 'default' });
    });
});
