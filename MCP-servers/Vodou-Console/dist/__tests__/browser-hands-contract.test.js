import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { decide, nodesFromSnapshot, classifyTarget, ALLOWED_TOOLS, REFUSED_TOOLS } from '../browser-hands/contract.js';
// PLAN-BROWSER-HANDS §6.1 / §13.5: every browser call is allowed, refused, or
// stopped for a fresh "yes". These are the rules the hands layer enforces on
// every provider; the model can't talk its way past them.
const OT = fs.readFileSync(path.join(__dirname, 'fixtures', 'browser-hands', 'opentable-home.snapshot.txt'), 'utf8');
function ctx(snapshot, allowedHosts = ['opentable.com'], extra = {}) {
    const { nodes, focusedUid } = nodesFromSnapshot(snapshot);
    return { nodes, focusedUid, allowedHosts, ...extra };
}
const BOOKING = [
    'uid=1_0 RootWebArea "Complete your reservation"',
    '  uid=1_1 dialog "Sidecar"',
    '    uid=1_2 StaticText "Sat, Oct 4 · 7:30 PM · Party of 4"',
    '    uid=1_3 button "Complete reservation"',
    '    uid=1_4 button "Back"',
    '  uid=1_5 textbox "Password"',
    '  uid=1_6 textbox "Card number"',
    '  uid=1_7 textbox "Special requests"',
    '  uid=1_8 link "Place order"',
    '  uid=1_9 link "Book now"',
    '  uid=1_10 checkbox "I agree to be charged a $25 no-show fee"',
    '  uid=1_11 searchbox "Location, Restaurant, or Cuisine" focused',
    '  uid=1_12 button "Cancel reservation"',
].join('\n');
describe('browser-hands contract: the allow-list', () => {
    it('refuses the dangerous tools by name, with a reason', () => {
        for (const t of ['evaluate_script', 'click_at', 'type_text', 'upload_file', 'get_network_request', 'list_network_requests', 'get_console_message']) {
            const d = decide(t, {}, ctx(BOOKING));
            expect(d.kind, t).toBe('refuse');
        }
    });
    it('refuses anything not on the list, even a tool a future server version adds', () => {
        expect(decide('screencast_start', {}, ctx(BOOKING)).kind).toBe('refuse');
        expect(decide('install_extension', {}, ctx(BOOKING)).kind).toBe('refuse');
    });
    it('allow-list and refuse-list never overlap', () => {
        for (const t of Object.keys(REFUSED_TOOLS))
            expect(ALLOWED_TOOLS.has(t)).toBe(false);
    });
});
describe('browser-hands contract: navigation', () => {
    it('stays on the task\'s sites', () => {
        expect(decide('navigate_page', { pageId: 1, url: 'https://www.opentable.com/r/sidecar' }, ctx(BOOKING)).kind).toBe('allow');
        const off = decide('navigate_page', { pageId: 1, url: 'https://evil.example/phish' }, ctx(BOOKING));
        expect(off.kind).toBe('refuse');
    });
    it('blocks non-http schemes (chrome:, file:, javascript:, data:)', () => {
        for (const url of ['chrome://settings', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi']) {
            expect(decide('navigate_page', { pageId: 1, url }, ctx(BOOKING, [])).kind, url).toBe('refuse');
        }
    });
    it('lets a login step pass through identity providers only', () => {
        const g = 'https://accounts.google.com/o/oauth2/auth';
        expect(decide('navigate_page', { pageId: 1, url: g }, ctx(BOOKING)).kind).toBe('refuse');
        expect(decide('navigate_page', { pageId: 1, url: g }, ctx(BOOKING, ['opentable.com'], { inLoginStep: true })).kind).toBe('allow');
    });
    it('strips initScript and never auto-accepts "leave page?"', () => {
        const d = decide('navigate_page', { pageId: 1, url: 'https://www.opentable.com/', initScript: 'steal()' }, ctx(BOOKING));
        expect(d.kind).toBe('allow');
        if (d.kind === 'allow') {
            expect(d.args.initScript).toBeUndefined();
            expect(d.args.handleBeforeUnload).toBe('dismiss');
        }
    });
});
describe('browser-hands contract: gates', () => {
    const c = ctx(BOOKING);
    it('stops "Complete reservation" as a booking', () => {
        const d = decide('click', { pageId: 1, uid: '1_3' }, c);
        expect(d).toMatchObject({ kind: 'gate', category: 'book' });
    });
    it('lets a plain "Back" through', () => {
        expect(decide('click', { pageId: 1, uid: '1_4' }, c).kind).toBe('allow');
    });
    it('gates a link only for the strongest verbs', () => {
        expect(decide('click', { pageId: 1, uid: '1_8' }, c)).toMatchObject({ kind: 'gate', category: 'spend' }); // Place order
        expect(decide('click', { pageId: 1, uid: '1_9' }, c).kind).toBe('allow'); // Book now (opens the restaurant page)
    });
    it('gates cancelling', () => {
        expect(decide('click', { pageId: 1, uid: '1_12' }, c)).toMatchObject({ kind: 'gate', category: 'cancel' });
    });
    it('treats ticking a consequential checkbox as a gated click', () => {
        expect(decide('fill', { pageId: 1, uid: '1_10', value: 'true' }, c).kind).toBe('gate');
    });
    it('gates Enter unless the focused field is a search box', () => {
        expect(decide('press_key', { pageId: 1, key: 'Enter' }, c).kind).toBe('allow'); // searchbox focused
        const c2 = ctx(BOOKING.replace(' focused', ''), ['opentable.com'], { focusedUid: '1_7' });
        expect(decide('press_key', { pageId: 1, key: 'Enter' }, c2).kind).toBe('gate');
    });
    it('accepting a dialog is gated; dismissing is not', () => {
        expect(decide('handle_dialog', { action: 'accept' }, c).kind).toBe('gate');
        expect(decide('handle_dialog', { action: 'dismiss' }, c).kind).toBe('allow');
    });
    it('a click must reference the latest snapshot', () => {
        expect(decide('click', { pageId: 1, uid: '9_99' }, c).kind).toBe('refuse');
    });
});
describe('browser-hands contract: secrets', () => {
    const c = ctx(BOOKING);
    it('the model never fills a password or a card number', () => {
        expect(decide('fill', { pageId: 1, uid: '1_5', value: 'hunter2' }, c).kind).toBe('refuse');
        expect(decide('fill', { pageId: 1, uid: '1_6', value: '4111111111111111' }, c).kind).toBe('refuse');
        expect(decide('fill_form', { pageId: 1, elements: [{ uid: '1_7', value: 'window seat' }, { uid: '1_5', value: 'x' }] }, c).kind).toBe('refuse');
    });
    it('ordinary fields fill freely', () => {
        expect(decide('fill', { pageId: 1, uid: '1_7', value: 'Window seat please' }, c).kind).toBe('allow');
    });
});
describe('browser-hands contract: on the real OpenTable homepage', () => {
    const c = ctx(OT);
    it('nothing on the homepage needs a yes to open or pick', () => {
        const find = (re) => [...c.nodes.values()].find((n) => re.test(`${n.role} "${n.name}"`));
        for (const re of [/^button "Sep 28"$/, /^combobox "Time selector"$/, /^button "search"$/]) {
            const n = find(re);
            expect(n, String(re)).toBeTruthy();
            expect(classifyTarget(n), String(re)).toBeNull();
        }
    });
});
