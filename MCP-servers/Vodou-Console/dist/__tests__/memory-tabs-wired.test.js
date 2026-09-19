import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Every tab the Memory page SHOWS must also be one it LISTENS to.
 *
 * memory.js builds each tab button, appends it to the strip, and then wires
 * click handlers from a separate `allTabs` array. The two lists are written by
 * hand, so a new tab can be appended and never added to `allTabs`: it renders,
 * looks like every other tab, and does nothing when clicked. Review shipped that
 * way (PLAN-LOOPS P2) and was reachable only through a #/memory?tab=review deep
 * link until 2026-09-14.
 */
const SRC = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/js/views/memory.js'), 'utf8');
const appended = [...SRC.matchAll(/tabs\.appendChild\((\w+Tab)\)/g)].map((m) => m[1]);
const wiredLine = SRC.match(/const allTabs = \[([^\]]*)\]/);
const wired = wiredLine ? wiredLine[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
describe('Memory page tabs', () => {
    it('finds the strip and the handler list it is checking', () => {
        // A source test that matches nothing passes by agreeing with nothing.
        expect(appended.length).toBeGreaterThanOrEqual(8);
        expect(wiredLine, 'const allTabs = [...] not found in memory.js').not.toBeNull();
    });
    it('every tab in the strip has a click handler', () => {
        const unwired = appended.filter((t) => !wired.includes(t));
        expect(unwired, `shown but not clickable: ${unwired.join(', ')}`).toEqual([]);
    });
    it('every tab key can also be deep-linked', () => {
        // #/memory?tab=<key> is validated against a hand-written list too.
        const keys = [...SRC.matchAll(/(\w+Tab)\.dataset\.tab = '([a-z]+)'/g)]
            .filter((m) => appended.includes(m[1]))
            .map((m) => m[2]);
        const linkable = SRC.match(/activate\(\[([^\]]*)\]\.includes\(asked\)/);
        expect(linkable, 'deep-link list not found').not.toBeNull();
        const allowed = [...linkable[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
        // `timeline` is the fallback, so it needs no entry.
        const missing = keys.filter((k) => k !== 'timeline' && !allowed.includes(k));
        expect(missing, `tabs a link cannot open: ${missing.join(', ')}`).toEqual([]);
    });
});
