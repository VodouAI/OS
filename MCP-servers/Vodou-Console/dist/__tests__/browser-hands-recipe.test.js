import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { fillTemplate, pickTimes, getRecipe, findAll } from '../browser-hands/recipe.js';
import { startBrowserTask, handleBrowserReply, _useClient, _resetBrowserHands, _setNotify } from '../browser-hands/service.js';
import { getActiveTools } from '../tools.js';
// PLAN-BROWSER-HANDS §5: a recipe does the known path with ZERO model calls and
// hands the page to the loop, with a note, where it can't continue. The fake
// Resy below is built from real Resy pages captured 2026-09-28 (read-only):
// search results are links with the exact restaurant name, times are buttons
// "5:00 PM DINNER", a time opens "Complete Your Reservation" with Reserve Now.
const many = Array.from({ length: 11 }, (_, i) => `    uid=1_${20 + i} link "Other Place ${i}" url="https://resy.com/cities/new-york-ny/venues/other-${i}"`).join('\n');
const PAGES = {
    search: (withTarget = true) => `uid=1_0 RootWebArea "Resy search" url="https://resy.com/cities/new-york-ny/search?query=Via%20Della%20Pace"
  uid=1_1 main
${many}
${withTarget ? '    uid=1_99 link "Via Della Pace" url="https://resy.com/cities/new-york-ny/venues/via-della-pace?date=2026-10-07&seats=2"' : ''}`,
    venue: (times, loggedIn) => `uid=2_0 RootWebArea "Book Your Via Della Pace Reservation Now on Resy" url="https://resy.com/cities/new-york-ny/venues/via-della-pace?date=2026-10-07&seats=2"
  uid=2_1 banner "Main Resy"
    ${loggedIn ? 'uid=2_2 button "Profile"' : 'uid=2_2 button "Log in"'}
  uid=2_3 main
    uid=2_4 heading "Via Della Pace" level="1"
    uid=2_5 heading "Dinner" level="2"
${times.length ? times.map((t, i) => `    uid=2_${10 + i} button "${t} DINNER"`).join('\n') : '    uid=2_9 button "Notify for Dinner"\n    uid=2_8 StaticText "Sorry, we don\'t currently have any tables available for 2."'}`,
    dialog: (loggedIn) => `uid=3_0 RootWebArea "Via Della Pace Reservation Details" url="https://widgets.resy.com/"
  uid=3_1 dialog "Complete Your Reservation" modal
    uid=3_2 heading "Via Della Pace" level="2"
    uid=3_3 StaticText "Wed, Oct 7, 2026"
    uid=3_4 StaticText "7:15 PM"
    uid=3_5 StaticText "2 Guests, DINNER"
    ${loggedIn ? '' : 'uid=3_6 button "Log in"'}
    uid=3_7 button "Reserve Now"`,
    confirmed: `uid=4_0 RootWebArea "Reservation confirmed" url="https://resy.com/account/reservations"
  uid=4_1 heading "You're all set" level="1"`,
};
class FakeResy {
    o;
    exited = null;
    page = 'blank';
    calls = [];
    constructor(o = {}) {
        this.o = o;
    }
    text() {
        const times = this.o.times ?? ['5:00 PM', '6:45 PM', '7:15 PM', '8:30 PM', '9:45 PM', '10:00 PM'];
        if (this.page === 'search')
            return PAGES.search(this.o.searchHasTarget !== false);
        if (this.page === 'venue') {
            const v = PAGES.venue(times, this.o.loggedIn !== false);
            // Resy's "Dining Room / Bar Seat" layout: a hidden copy of each time comes first.
            return this.o.hiddenCopies ? v.replace('  uid=2_3 main', `  uid=2_3 main\n${times.map((t, i) => `    uid=2_${50 + i} button "${t} DINNER"`).join('\n')}`) : v;
        }
        if (this.page === 'dialog')
            return PAGES.dialog(this.o.loggedIn !== false);
        if (this.page === 'confirmed')
            return PAGES.confirmed;
        return 'uid=0_0 RootWebArea "" url="about:blank"';
    }
    async callTool(name, args) {
        this.calls.push({ name, args });
        if (name === 'new_page' || name === 'navigate_page') {
            this.page = /\/search\?/.test(String(args.url)) ? 'search' : 'venue';
            return { text: '## Pages\n1: about:blank\n2: x [selected]', images: [], isError: false };
        }
        if (name === 'take_snapshot')
            return { text: this.text(), images: [], isError: false };
        if (name === 'take_screenshot') {
            if (args.filePath)
                fs.writeFileSync(String(args.filePath), 'j');
            return { text: 'ok', images: [], isError: false };
        }
        if (name === 'click' && /^2_5\d$/.test(String(args.uid))) {
            return { text: `Error: Failed to interact with the element with uid ${args.uid}. The element did not become interactive within the configured timeout.`, images: [], isError: true };
        }
        if (name === 'click') {
            if (args.uid === '1_99')
                this.page = 'venue';
            else if (/^2_1\d$/.test(String(args.uid)))
                this.page = 'dialog';
            else if (args.uid === '3_7')
                this.page = 'confirmed';
        }
        return { text: 'ok', images: [], isError: false };
    }
    close() { }
    clicks() { return this.calls.filter((c) => c.name === 'click').map((c) => c.args.uid); }
}
const noModel = async () => { throw new Error('the model was called on a recipe path'); };
const SLOTS = { city: 'new-york-ny', restaurant: 'Via Della Pace', date: '2026-10-07', party_size: '2', time_window: '18:30-20:00' };
const saved = process.env.VODOU_BROWSER_HANDS;
let conv;
beforeEach(() => {
    process.env.VODOU_BROWSER_HANDS = '1';
    _resetBrowserHands();
    _setNotify(() => { });
    conv = `recipe-${Math.random().toString(36).slice(2)}`;
});
afterEach(() => { _resetBrowserHands(); if (saved === undefined)
    delete process.env.VODOU_BROWSER_HANDS;
else
    process.env.VODOU_BROWSER_HANDS = saved; });
const start = (fake, llm = noModel, slots = SLOTS) => {
    _useClient(fake, 's1');
    return startBrowserTask({ conversationId: conv, goal: 'Book Via Della Pace for 2 on Oct 7 around 7', startUrl: 'https://resy.com/', recipe: 'resy.com/book-table', slots }, llm);
};
describe('resy.com/book-table, end to end on a fake Resy, with no model at all', () => {
    it('search → venue → "which time?" → the pick → gate with the dialog\'s summary → yes → booked, with proof', async () => {
        const fake = new FakeResy();
        const q = await start(fake);
        expect(fake.calls[0]).toMatchObject({ name: 'new_page', args: { url: 'https://resy.com/cities/new-york-ny/search?query=Via%20Della%20Pace&date=2026-10-07&seats=2' } });
        // Times inside 18:30–20:00, nearest its middle first, shown in time order.
        expect(q.text).toBe('Via Della Pace has these times on 2026-10-07 for 2. Which one?\n1. 6:45 PM DINNER\n2. 7:15 PM DINNER');
        const g = await handleBrowserReply(conv, '2', noModel);
        expect(g?.text).toMatch(/^Book: "Reserve Now"/);
        expect(g?.text).toContain('7:15 PM');
        expect(g?.pictures).toHaveLength(1);
        expect(fake.clicks()).toEqual(['1_99', '2_12']); // 7:15 = the third time; Reserve Now NOT clicked yet
        const done = await handleBrowserReply(conv, 'yes', noModel);
        expect(done?.text).toBe('Done. Booked Via Della Pace: 7:15 PM DINNER on 2026-10-07 for 2.');
        expect(done?.pictures).toHaveLength(1);
        expect(fake.clicks()).toEqual(['1_99', '2_12', '3_7']);
    });
    it('a hidden duplicate of the time that won\'t take a click → the next copy is used, no fallback (live Resy layout)', async () => {
        const fake = new FakeResy({ hiddenCopies: true });
        await start(fake);
        const g = await handleBrowserReply(conv, '2', noModel);
        expect(g?.text).toMatch(/^Book: "Reserve Now"/);
        expect(fake.clicks()).toEqual(['1_99', '2_52', '2_12']); // hidden copy failed, visible one worked
    });
    it('finds the restaurant even when the snapshot filter hides it (12th link in its group)', async () => {
        const fake = new FakeResy();
        await start(fake);
        expect(fake.clicks()[0]).toBe('1_99');
    });
    it('no open tables → a plain answer and a screenshot, no question', async () => {
        const r = await start(new FakeResy({ times: [] }));
        expect(r.text).toBe('Done. Via Della Pace has no open tables for 2 on 2026-10-07 on Resy.');
        expect(r.pictures).toHaveLength(1);
    });
    it('open times, none in the window → says so and offers what IS open (never "no tables")', async () => {
        const r = await start(new FakeResy({ times: ['5:00 PM', '10:00 PM'] }));
        expect(r.text).toMatch(/^Nothing is open between 18:30 and 20:00\. Via Della Pace has these times/);
        expect(r.text).toContain('1. 5:00 PM DINNER\n2. 10:00 PM DINNER');
    });
    it('signed out → the RECIPE asks for sign-in (no model), then the loop signs in with the answer', async () => {
        const seen = [];
        const loop = async (prompt) => { seen.push(prompt); return '{"stuck":"test ends here"}'; };
        const fake = new FakeResy({ loggedIn: false, times: ['7:15 PM'] });
        const r = await start(fake, noModel);
        // One time in the window → picked without asking; then the Log in check asks.
        expect(fake.clicks()).toEqual(['1_99', '2_10']);
        expect(r.text).toMatch(/^Resy needs you signed in to book .* What's the phone number on your Resy account\?$/);
        await handleBrowserReply(conv, '555 0100', loop);
        expect(seen[0]).toMatch(/recipe stopped at step 9: Resy needs the person signed in before booking/);
        expect(seen[0]).toMatch(/the person answered: 555 0100/);
        expect(fake.clicks()).not.toContain('3_7'); // Reserve Now never clicked
    });
    it('the site changed (restaurant link not found) → the loop takes over from that page', async () => {
        const seen = [];
        const loop = async (prompt) => { seen.push(prompt); return '{"stuck":"test ends here"}'; };
        await start(new FakeResy({ searchHasTarget: false }), loop);
        expect(seen[0]).toMatch(/recipe stopped at step 2: expected link named like "Via Della Pace" and the page didn't show it/);
    });
    it('a recipe missing a required slot is not run half-filled: the loop does the errand', async () => {
        const seen = [];
        const loop = async (prompt) => { seen.push(prompt); return '{"stuck":"test ends here"}'; };
        const fake = new FakeResy();
        await start(fake, loop, { restaurant: 'Via Della Pace' });
        expect(fake.calls[0]).toMatchObject({ name: 'new_page', args: { url: 'https://resy.com/' } });
        expect(seen).toHaveLength(1);
    });
}, 20_000);
describe('recipe helpers', () => {
    it('fillTemplate encodes in URLs and escapes in patterns', () => {
        expect(fillTemplate('q={restaurant}', { restaurant: 'Chez L\'Ami & Co' }, 'url')).toBe("q=Chez%20L'Ami%20%26%20Co");
        expect(fillTemplate('^{x}$', { x: '7:15 PM (DINNER)' }, 'regex')).toBe('^7:15 PM \\(DINNER\\)$');
        // Regex quantifiers are not slots (this ate `{2}` from `\d{2}` and broke every time match).
        expect(fillTemplate('^\\d{1,2}:\\d{2} [AP]M', {}, 'regex')).toBe('^\\d{1,2}:\\d{2} [AP]M');
    });
    it('pickTimes keeps the window, nearest its middle, in time order', () => {
        const t = ['5:00 PM X', '6:45 PM X', '7:15 PM X', '7:30 PM X', '9:00 PM X'];
        expect(pickTimes(t, '19:00-20:00', 2)).toEqual(['7:15 PM X', '7:30 PM X']);
        expect(pickTimes(t, undefined, 2)).toEqual(['5:00 PM X', '6:45 PM X']);
        expect(pickTimes(['12:15 AM X', '12:30 PM X'], '12:00-13:00', 5)).toEqual(['12:30 PM X']);
    });
    it('findAll matches role and name, case-insensitively, in page order', () => {
        const snap = 'uid=1 link "via della pace"\nuid=2 button "Via Della Pace"\nuid=3 link "Via Della Pace Bis"';
        expect(findAll(snap, { role: 'link', name_matches: '{r}' }, { r: 'Via Della Pace' }).map((n) => n.uid)).toEqual(['1', '3']);
    });
});
describe('the tool offers the recipe (flag on)', () => {
    it('lists resy.com/book-table with its slots, and accepts recipe + slots', () => {
        const t = getActiveTools().find((x) => x.name === 'browser_task');
        expect(t.description).toContain('resy.com/book-table — Book a table on Resy');
        expect(t.description).toMatch(/city \(required/);
        expect(t.input_schema.properties.recipe.enum).toContain('resy.com/book-table');
        expect(getRecipe('resy.com/book-table')?.site.domains).toEqual(['resy.com']);
    });
});
