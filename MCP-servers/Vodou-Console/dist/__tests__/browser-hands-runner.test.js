import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../browser-hands/tasks.js';
import { Hands, composeSummary, summaryDetails } from '../browser-hands/runner.js';
// PLAN-BROWSER-HANDS §6 / §13.2: the runner is the only path from a decision to
// a browser action. A fake browser plays a booking page.
const SEARCH = `## Latest page snapshot
uid=1_0 RootWebArea "Sidecar - OpenTable" url="https://www.opentable.com/r/sidecar"
  uid=1_1 main
    uid=1_2 button "7:30 PM"
    uid=1_3 textbox "Password"`;
const CONFIRM = (time) => `## Latest page snapshot
uid=2_0 RootWebArea "Complete your reservation" url="https://www.opentable.com/booking/details"
  uid=2_1 dialog "Sidecar"
    uid=2_2 StaticText "Sat, Oct 4 · ${time} · Party of 4"
    uid=2_3 button "Complete reservation"`;
const DONE = `## Latest page snapshot
uid=3_0 RootWebArea "Reservation confirmed" url="https://www.opentable.com/booking/confirmed"
  uid=3_1 heading "You're all set" level="1"`;
class FakeBrowser {
    page = SEARCH;
    calls = [];
    onClick = {};
    failNext = null;
    async callTool(name, args) {
        this.calls.push({ name, args });
        if (this.failNext === name) {
            this.failNext = null;
            return { text: 'Error: timed out', images: [], isError: true };
        }
        if (name === 'new_page')
            return { text: '## Pages\n1: about:blank\n2: https://www.opentable.com/r/sidecar [selected]', images: [], isError: false };
        if (name === 'take_snapshot')
            return { text: this.page, images: [], isError: false };
        if (name === 'take_screenshot') {
            if (args.filePath)
                fs.writeFileSync(String(args.filePath), 'jpeg');
            return { text: 'saved', images: [], isError: false };
        }
        if (name === 'click')
            this.onClick[String(args.uid)]?.();
        return { text: 'ok', images: [], isError: false };
    }
}
let store;
let fake;
let hands;
const CONV = 'workbench:channel:relay';
beforeEach(() => {
    store = new TaskStore(new DatabaseSync(':memory:'));
    fake = new FakeBrowser();
    fake.onClick['1_2'] = () => { fake.page = CONFIRM('7:30 PM'); };
    fake.onClick['2_3'] = () => { fake.page = DONE; };
    hands = new Hands(store, fake, { mediaDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bh-media-')) });
});
async function startAtConfirm() {
    const { task } = store.create({ conversationId: CONV, goal: 'book Sidecar', state: { allowedHosts: ['opentable.com'] } });
    await hands.open(task, 'https://www.opentable.com/r/sidecar');
    expect(task.state.pageId).toBe(2);
    const r = await hands.act(task, 'click', { uid: '1_2' }); // pick 7:30 — not consequential
    expect(r.kind).toBe('done');
    return task;
}
describe('browser-hands runner', () => {
    it('a booking click stops for a yes, with a code-written summary and a screenshot', async () => {
        const task = await startAtConfirm();
        const r = await hands.act(task, 'click', { uid: '2_3' });
        expect(r.kind).toBe('gated');
        if (r.kind !== 'gated')
            return;
        expect(r.gate.summary).toBe('Book: "Complete reservation" — Sat, Oct 4 · 7:30 PM · Party of 4 (on www.opentable.com). Reply yes to go ahead, or no.');
        expect(r.gate.screenshot && fs.existsSync(r.gate.screenshot)).toBe(true);
        expect(fake.calls.filter((c) => c.name === 'click' && c.args.uid === '2_3')).toHaveLength(0); // NOT clicked
        expect(store.active(CONV)?.status).toBe('suspended');
    });
    it('yes: re-checks the page, clicks once, and the task sees the confirmation', async () => {
        let task = await startAtConfirm();
        await hands.act(task, 'click', { uid: '2_3' });
        task = store.active(CONV);
        const r = await hands.resumeGate(task, 'approve');
        expect(r.kind).toBe('done');
        expect(fake.calls.filter((c) => c.name === 'click' && c.args.uid === '2_3')).toHaveLength(1);
        if (r.kind === 'done')
            expect(r.obs.snapshot).toContain("You're all set");
        // a second "yes" (a double tap) does nothing
        expect((await hands.resumeGate(store.get(task.id), 'approve')).kind).toBe('stale');
        expect(fake.calls.filter((c) => c.name === 'click' && c.args.uid === '2_3')).toHaveLength(1);
    });
    it('if the page changed after the summary, it asks again instead of clicking', async () => {
        let task = await startAtConfirm();
        await hands.act(task, 'click', { uid: '2_3' });
        fake.page = CONFIRM('8:15 PM'); // the site swapped the time before the person replied
        task = store.active(CONV);
        const r = await hands.resumeGate(task, 'approve');
        expect(r.kind).toBe('gated');
        if (r.kind === 'gated')
            expect(r.gate.summary).toContain('8:15 PM');
        expect(fake.calls.filter((c) => c.name === 'click' && c.args.uid === '2_3')).toHaveLength(0);
    });
    it('no: nothing is clicked', async () => {
        let task = await startAtConfirm();
        await hands.act(task, 'click', { uid: '2_3' });
        task = store.active(CONV);
        const r = await hands.resumeGate(task, 'deny');
        expect(r.kind).toBe('done');
        expect(fake.calls.filter((c) => c.name === 'click' && c.args.uid === '2_3')).toHaveLength(0);
    });
    it('an error on the approved click never retries blindly', async () => {
        let task = await startAtConfirm();
        await hands.act(task, 'click', { uid: '2_3' });
        task = store.active(CONV);
        fake.failNext = 'click';
        const r = await hands.resumeGate(task, 'approve');
        expect(r.kind).toBe('done');
        if (r.kind === 'done')
            expect(r.obs.note).toMatch(/check the page for a confirmation/);
        expect(fake.calls.filter((c) => c.name === 'click' && c.args.uid === '2_3')).toHaveLength(1);
    });
    it('refuses the password field, off-site navigation and evaluate_script — and records why', async () => {
        const { task } = store.create({ conversationId: CONV, goal: 'x', state: { allowedHosts: ['opentable.com'] } });
        await hands.open(task, 'https://www.opentable.com/r/sidecar');
        expect((await hands.act(task, 'fill', { uid: '1_3', value: 'hunter2' })).kind).toBe('refused');
        expect((await hands.act(task, 'navigate_page', { url: 'https://evil.example' })).kind).toBe('refused');
        expect((await hands.act(task, 'evaluate_script', { function: '() => 1' })).kind).toBe('refused');
        expect(fake.calls.some((c) => c.name === 'fill' || c.name === 'evaluate_script')).toBe(false);
        expect(store.steps(task.id).filter((s) => s.decision === 'refuse')).toHaveLength(3);
    });
    it('the proof screenshot is found where the server SAYS it saved it (1.10.1 renames the extension)', async () => {
        const { task } = store.create({ conversationId: CONV, goal: 'look', state: { allowedHosts: ['opentable.com'] } });
        await hands.open(task, 'https://www.opentable.com/r/sidecar');
        fake.callTool = async (name, args) => {
            if (name !== 'take_screenshot')
                return { text: 'ok', images: [], isError: false };
            const actual = String(args.filePath).replace(/\.[a-z]+$/, '.renamed.jpeg');
            fs.writeFileSync(actual, 'jpeg');
            return { text: `Took a screenshot of the current page's viewport.\nSaved screenshot to ${actual}.`, images: [], isError: false };
        };
        const shot = await hands.proof(task);
        expect(shot).toMatch(/\.renamed\.jpeg$/);
        expect(fs.existsSync(shot)).toBe(true);
    });
    it('stop closes the page and ends the task', async () => {
        const task = await startAtConfirm();
        await hands.stop(task);
        expect(store.get(task.id)?.status).toBe('stopped');
        expect(fake.calls.some((c) => c.name === 'close_page')).toBe(true);
    });
});
describe('summaries are composed from the page, not by the model', () => {
    it('reads the dialog text', () => {
        expect(summaryDetails(CONFIRM('7:30 PM'))).toEqual(['Sat, Oct 4 · 7:30 PM · Party of 4']);
    });
    it('falls back to the page title', () => {
        expect(composeSummary('spend', { uid: 'x', role: 'button', name: 'Place order', attrs: '' }, 'uid=1_0 RootWebArea "Checkout - Instacart"', 'instacart.com'))
            .toBe('Pay: "Place order" — Checkout - Instacart (on instacart.com). Reply yes to go ahead, or no.');
    });
    it('no element and no dialog: names the action and uses the title, never the page\'s first stray text', () => {
        // Live on Resy 2026-09-28 this read "Submit: this step — 2026".
        const page = 'uid=1_0 RootWebArea "Via Della Pace - Resy"\n  uid=1_1 StaticText "2026"\n  uid=1_2 textbox "Phone number" focused';
        expect(composeSummary('submit', null, page, 'resy.com', 'key Enter in textbox "Phone number"'))
            .toBe('Submit: pressing Enter in textbox "Phone number" — Via Della Pace - Resy (on resy.com). Reply yes to go ahead, or no.');
    });
});
