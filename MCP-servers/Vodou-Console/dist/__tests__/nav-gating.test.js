import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
/**
 * PLAN-ALPHA F6 — nav gating.
 *
 * 27 view files and 31 nav links at equal visual weight mean a stranger cannot
 * find the path through the product. The gate hides developer surfaces by
 * default. The property that must NOT break is that nothing is actually removed:
 * every route still resolves, so deep links and bookmarks keep working. This is
 * about which doors are visible, not which exist.
 */
const pub = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const html = readFileSync(join(pub, 'index.html'), 'utf8');
const shellCss = readFileSync(join(pub, 'css', '05-shell.css'), 'utf8');
describe('nav gating', () => {
    it('marks the developer surfaces', () => {
        // If this drops to zero the gate is inert and the nav silently reverts.
        expect((html.match(/data-nav-tier="dev"/g) ?? []).length).toBeGreaterThanOrEqual(5);
    });
    it('keeps the everyday path always visible', () => {
        // Chat, Memory, Messaging, Apps, Skills and Settings must never be gated —
        // hiding those would hide the product rather than the developer surface.
        for (const href of ['#/chat', '#/memory', '#/messaging', '#/apps',
            '#/capabilities?tab=skills', '#/settings?tab=model']) {
            const at = html.indexOf(`href="${href}"`);
            expect(at, `${href} missing from nav`).toBeGreaterThan(-1);
            const tagStart = html.lastIndexOf('<', at);
            const tag = html.slice(tagStart, html.indexOf('>', at) + 1);
            expect(tag.includes('data-nav-tier'), `${href} must not be gated`).toBe(false);
        }
    });
    it('hides by DEFAULT — the attribute must be opt-in', () => {
        // `html:not([data-show-everything="1"])` means absent → hidden. If this were
        // inverted, a fresh install would show everything and the step would be a no-op.
        expect(shellCss).toContain('html:not([data-show-everything="1"]) [data-nav-tier="dev"]');
        expect(shellCss).toMatch(/display:\s*none/);
    });
    it('paints the gate before CSS to avoid a flash of the dev surfaces', () => {
        const gateAt = html.indexOf("localStorage.getItem('vodou-show-everything')");
        const firstCss = html.indexOf('<link rel="stylesheet"');
        expect(gateAt).toBeGreaterThan(-1);
        if (firstCss > -1)
            expect(gateAt).toBeLessThan(firstCss);
    });
    it('reconciles against the server, which is the source of truth', () => {
        // localStorage is only a paint-timing mirror; it can be stale across
        // browsers or a cleared profile.
        expect(html).toContain("fetch('/api/settings')");
        expect(html).toContain("s['ui.show_everything']");
    });
    it('REMOVES NO ROUTES — every gated destination still has a view', () => {
        const registered = readFileSync(join(pub, 'index.html'), 'utf8');
        for (const route of ['#/board', '#/lenses', '#/builder', '#/terminal']) {
            expect(registered.includes(`href="${route}"`), `${route} link was deleted`).toBe(true);
        }
    });
});
