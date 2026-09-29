import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../browser-hands/tasks.js';
import { Hands } from '../browser-hands/runner.js';
import { runLoop } from '../browser-hands/loop.js';
import { cancelBrowserErrands } from '../browser-hands/cancel.js';
import { startBrowserTask, handleBrowserReply, sweepExpired, PHONE_CONVERSATION, _useClient, _resetBrowserHands, _setNotify, } from '../browser-hands/service.js';
// PLAN-BROWSER-HANDS H1b, the phone side: STOP reaches the errand (§13.7), a
// "yes" after a restart never clicks a page nobody saw (§13.2c), a waiting
// errand lapses out loud (§13.1).
const PAGES = {
    times: `uid=1_0 RootWebArea "Sidecar" url="https://resy.com/cities/ny/sidecar"
  uid=1_1 main
    uid=1_2 button "7:30 PM"`,
    confirm: `uid=2_0 RootWebArea "Complete your reservation" url="https://resy.com/book"
  uid=2_1 dialog "Sidecar"
    uid=2_2 StaticText "Sat, Oct 4 · 7:30 PM · Party of 4"
    uid=2_3 button "Reserve Now"`,
};
class FakeBrowser {
    exited = null;
    page = 'times';
    pages = new Map([[1, 'about:blank']]);
    calls = [];
    async callTool(name, args) {
        this.calls.push({ name, args });
        if (name === 'new_page') {
            const id = this.pages.size + 1;
            this.pages.set(id, String(args.url));
            this.page = 'times';
            return { text: `## Pages\n${[...this.pages].map(([k, u]) => `${k}: ${u}`).join('\n')} [selected]`, images: [], isError: false };
        }
        if (name === 'take_snapshot')
            return { text: PAGES[this.page], images: [], isError: false };
        if (name === 'take_screenshot') {
            if (args.filePath)
                fs.writeFileSync(String(args.filePath), 'j');
            return { text: 'ok', images: [], isError: false };
        }
        if (name === 'click' && args.uid === '1_2')
            this.page = 'confirm';
        return { text: 'ok', images: [], isError: false };
    }
    close() { }
}
const script = (answers) => async () => answers.shift() ?? '{"stuck":"script ran out"}';
const toReserve = ['{"do":{"tool":"click","args":{"uid":"1_2"}},"why":"pick 7:30"}', '{"do":{"tool":"click","args":{"uid":"2_3"}},"why":"reserve"}'];
const saved = process.env.VODOU_BROWSER_HANDS;
let fake;
let notes;
beforeEach(() => {
    process.env.VODOU_BROWSER_HANDS = '1';
    _resetBrowserHands();
    fake = new FakeBrowser();
    _useClient(fake, 'session-A');
    notes = [];
    _setNotify((t) => notes.push(t));
});
afterEach(() => {
    _resetBrowserHands();
    if (saved === undefined)
        delete process.env.VODOU_BROWSER_HANDS;
    else
        process.env.VODOU_BROWSER_HANDS = saved;
});
const conv = () => `phone-test-${Math.random().toString(36).slice(2)}`;
describe('STOP from the phone reaches the errand', () => {
    it('an errand waiting at a "yes" is ended, and its page closed', async () => {
        const c = conv();
        const r = await startBrowserTask({ conversationId: c, goal: 'book Sidecar', startUrl: 'https://resy.com/cities/ny/sidecar', sites: ['resy.com'] }, script([...toReserve]));
        expect(r.text).toContain('Reserve Now');
        expect(await cancelBrowserErrands(c)).toBe(true);
        expect(fake.calls.some((x) => x.name === 'close_page')).toBe(true);
        expect(await handleBrowserReply(c, 'yes', script([]))).toBeNull(); // nothing left to approve
        expect(fake.calls.filter((x) => x.name === 'click').map((x) => x.args.uid)).toEqual(['1_2']); // Reserve never clicked
    });
    it('a running loop stops before its next action', async () => {
        const c = conv();
        let calls = 0;
        const slowModel = async () => {
            calls++;
            if (calls === 1) {
                setTimeout(() => void cancelBrowserErrands(c), 0);
                await new Promise((r) => setTimeout(r, 20));
            }
            return toReserve[0];
        };
        const r = await startBrowserTask({ conversationId: c, goal: 'book', startUrl: 'https://resy.com/cities/ny/sidecar', sites: ['resy.com'] }, slowModel);
        expect(r.text).toBe('Stopped. Nothing else was done.');
        expect(fake.calls.filter((x) => x.name === 'click')).toHaveLength(0); // the answer that arrived after STOP was not acted on
    });
    it('with Browser Hands off, STOP touches nothing', async () => {
        delete process.env.VODOU_BROWSER_HANDS;
        expect(await cancelBrowserErrands(conv())).toBe(false);
    });
});
describe('a "yes" after Vodou restarted', () => {
    it('never clicks: the old gate is retired, the page reopened, and the person asked again', async () => {
        const c = conv();
        await startBrowserTask({ conversationId: c, goal: 'book Sidecar', startUrl: 'https://resy.com/cities/ny/sidecar', sites: ['resy.com'] }, script([...toReserve]));
        // Restart: a new browser process, whose page 2 is NOT the errand's page.
        fake = new FakeBrowser();
        _useClient(fake, 'session-B');
        const r = await handleBrowserReply(c, 'yes', script([...toReserve]));
        expect(r?.text).toMatch(/^\(Vodou restarted, so I reopened the page\.\)/);
        expect(r?.text).toContain('Reply yes'); // asked again
        const clicks = fake.calls.filter((x) => x.name === 'click').map((x) => x.args.uid);
        expect(clicks).toEqual(['1_2']); // redid the choice; "Reserve Now" waits for a NEW yes
        expect(fake.calls[0]).toMatchObject({ name: 'new_page', args: { url: 'https://resy.com/book' } }); // reopened the last page
    });
    it('stop after a restart never closes a page by its stale id', async () => {
        const c = conv();
        await startBrowserTask({ conversationId: c, goal: 'book', startUrl: 'https://resy.com/cities/ny/sidecar', sites: ['resy.com'] }, script([...toReserve]));
        fake = new FakeBrowser();
        _useClient(fake, 'session-B');
        await handleBrowserReply(c, 'stop', script([]));
        expect(fake.calls.some((x) => x.name === 'close_page')).toBe(false);
    });
});
describe('the store: a voided gate can never be approved', () => {
    it('voidGate retires the nonce; consumeGate with it then fails', () => {
        const s = new TaskStore(new DatabaseSync(':memory:'));
        const { task } = s.create({ conversationId: 'c', goal: 'g' });
        const g = s.suspendAtGate(task.id, { category: 'book', target: 'button "Reserve"', summary: 'Book?', tool: 'click', args: { uid: '2_3' } });
        expect(s.voidGate(task.id, g.nonce)?.decision).toBe('void');
        expect(s.consumeGate(task.id, g.nonce, 'approve')).toBeNull();
        expect(s.voidGate(task.id, g.nonce)).toBeNull();
    });
});
describe('a waiting errand lapses out loud', () => {
    it('the sweep expires it, closes its page, and texts the phone', async () => {
        const t0 = Date.now();
        await startBrowserTask({ conversationId: PHONE_CONVERSATION, goal: 'book Sidecar for 4', startUrl: 'https://resy.com/cities/ny/sidecar', sites: ['resy.com'] }, script([...toReserve]));
        const realNow = Date.now;
        Date.now = () => t0 + 11 * 60_000;
        const realDate = globalThis.Date;
        // TaskStore reads `new Date()`; move the clock by patching the constructor's default.
        globalThis.Date = class extends realDate {
            constructor(...a) { super(...(a.length ? a : [t0 + 11 * 60_000])); }
            static now() { return t0 + 11 * 60_000; }
        };
        try {
            expect(await sweepExpired()).toBeGreaterThanOrEqual(1); // earlier tests left errands waiting in the same gateway.db
        }
        finally {
            globalThis.Date = realDate;
            Date.now = realNow;
        }
        expect(notes.at(-1)).toMatch(/stopped waiting on your errand \(book Sidecar for 4\) — nothing was booked or sent/);
        expect(fake.calls.some((x) => x.name === 'close_page')).toBe(true);
    });
});
describe('progress texts', () => {
    it('the loop hands the model\'s one-line why to onProgress before each action', async () => {
        const s = new TaskStore(new DatabaseSync(':memory:'));
        const f = new FakeBrowser();
        const h = new Hands(s, f, { mediaDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bh-p-')) });
        const { task } = s.create({ conversationId: 'c', goal: 'g', state: { allowedHosts: ['resy.com'] } });
        await h.open(task, 'https://resy.com/cities/ny/sidecar');
        const seen = [];
        await runLoop(h, s, task, script([...toReserve]), { onProgress: (l) => seen.push(l) });
        expect(seen).toEqual(['pick 7:30', 'reserve']);
    });
});
