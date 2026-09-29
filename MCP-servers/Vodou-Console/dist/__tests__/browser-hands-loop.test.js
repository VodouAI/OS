import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore, routeReply } from '../browser-hands/tasks.js';
import { Hands } from '../browser-hands/runner.js';
import { runLoop, buildPrompt } from '../browser-hands/loop.js';
// PLAN-BROWSER-HANDS §4 / §13.1: the loop drives one action at a time, suspends
// at a gate or a question (the turn ends there), and resumes on the reply.
const PAGES = {
    search: `uid=1_0 RootWebArea "Sidecar" url="https://www.opentable.com/r/sidecar"
  uid=1_1 main
    uid=1_2 button "6:45 PM"
    uid=1_3 button "7:30 PM"
    uid=1_4 button "8:15 PM"`,
    confirm: `uid=2_0 RootWebArea "Complete your reservation" url="https://www.opentable.com/booking/details"
  uid=2_1 dialog "Sidecar"
    uid=2_2 StaticText "Sat, Oct 4 · 7:30 PM · Party of 4"
    uid=2_3 button "Complete reservation"`,
    done: `uid=3_0 RootWebArea "Reservation confirmed" url="https://www.opentable.com/booking/confirmed"
  uid=3_1 heading "You're all set" level="1"`,
};
class Fake {
    page = 'search';
    clicks = [];
    async callTool(name, args) {
        if (name === 'new_page')
            return { text: '1: https://www.opentable.com/r/sidecar [selected]', images: [], isError: false };
        if (name === 'take_snapshot')
            return { text: PAGES[this.page], images: [], isError: false };
        if (name === 'take_screenshot') {
            if (args.filePath)
                fs.writeFileSync(String(args.filePath), 'j');
            return { text: 'ok', images: [], isError: false };
        }
        if (name === 'click') {
            this.clicks.push(String(args.uid));
            if (args.uid === '1_3')
                this.page = 'confirm';
            if (args.uid === '2_3')
                this.page = 'done';
        }
        return { text: 'ok', images: [], isError: false };
    }
}
/** A scripted model: answers in order, and records what it was shown. */
function scripted(answers) {
    const seen = [];
    const llm = async (prompt) => { seen.push(prompt); return answers.shift() ?? '{"stuck":"script ran out"}'; };
    return { llm, seen };
}
let store;
let fake;
let hands;
const CONV = 'c1';
beforeEach(() => {
    store = new TaskStore(new DatabaseSync(':memory:'));
    fake = new Fake();
    hands = new Hands(store, fake, { mediaDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bh-loop-')) });
});
async function start(goal = 'Book a table for 4 at Sidecar on Saturday around 7') {
    const { task } = store.create({ conversationId: CONV, goal, state: { allowedHosts: ['opentable.com'] } });
    await hands.open(task, 'https://www.opentable.com/r/sidecar');
    return task;
}
describe('browser-hands loop: the whole booking, across turns', () => {
    it('asks which time → suspends; "2" resumes; the book click suspends for yes; "yes" completes', async () => {
        let task = await start();
        // Turn 1: the model sees three times and asks.
        const t1 = scripted(['{"ask":"Sidecar has 6:45, 7:30 and 8:15 on Saturday. Which one?","options":["6:45 PM","7:30 PM","8:15 PM"]}']);
        const o1 = await runLoop(hands, store, task, t1.llm);
        expect(o1.kind).toBe('question');
        expect(o1.text).toContain('2. 7:30 PM');
        expect(store.active(CONV)?.status).toBe('suspended');
        // Turn 2: "2" → option 7:30; the model clicks it, then clicks Complete reservation → gate.
        const route = routeReply(store, CONV, '2');
        expect(route).toMatchObject({ kind: 'option', choice: '7:30 PM' });
        store.answerQuestion(task.id);
        task = store.get(task.id);
        task.state = { ...task.state, history: [...task.state.history, 'the person chose: 7:30 PM'] };
        const t2 = scripted(['{"do":{"tool":"click","args":{"uid":"1_3"}},"why":"7:30"}', '{"do":{"tool":"click","args":{"uid":"2_3"}},"why":"finish"}']);
        const o2 = await runLoop(hands, store, task, t2.llm);
        expect(o2.kind).toBe('gate');
        expect(o2.text).toContain('Sat, Oct 4 · 7:30 PM · Party of 4');
        expect(fake.clicks).toEqual(['1_3']); // Complete reservation NOT clicked yet
        // Turn 3: "yes" → the runner clicks once; the model sees the confirmation and says done.
        expect(routeReply(store, CONV, 'yes')).toMatchObject({ kind: 'gate', decision: 'approve' });
        task = store.active(CONV);
        const resumed = await hands.resumeGate(task, 'approve');
        expect(resumed.kind).toBe('done');
        task = store.get(task.id);
        const t3 = scripted(['{"done":"Booked Sidecar, Sat Oct 4 at 7:30 PM for 4"}']);
        const o3 = await runLoop(hands, store, task, t3.llm);
        expect(o3).toMatchObject({ kind: 'done', text: 'Booked Sidecar, Sat Oct 4 at 7:30 PM for 4' });
        expect(fake.clicks).toEqual(['1_3', '2_3']);
        expect(store.get(task.id)?.status).toBe('done');
    });
    it('the model only ever sees the LATEST page, not every page so far', async () => {
        const task = await start();
        const t = scripted(['{"do":{"tool":"click","args":{"uid":"1_3"}}}', '{"stuck":"test ends"}']);
        await runLoop(hands, store, task, t.llm);
        expect(t.seen[1]).toContain('Complete reservation');
        expect(t.seen[1]).not.toContain('6:45 PM'); // the old page is gone
        expect(t.seen[1]).toMatch(/1\. opened|click button "7:30 PM": ok/);
    });
    it('a repeated action with no progress stops as stuck, with a screenshot', async () => {
        const task = await start();
        const same = '{"do":{"tool":"hover","args":{"uid":"1_2"}}}';
        const o = await runLoop(hands, store, task, scripted([same, same, same, same]).llm);
        expect(o.kind).toBe('stuck');
        if (o.kind === 'stuck')
            expect(o.screenshot).toBeTruthy();
        expect(store.get(task.id)?.status).toBe('handed_over');
    });
    it('the step budget holds', async () => {
        const task = await start();
        const many = Array.from({ length: 50 }, (_, i) => `{"do":{"tool":"hover","args":{"uid":"${['1_2', '1_4'][i % 2]}"}}}`);
        const o = await runLoop(hands, store, task, scripted(many).llm, { maxSteps: 5 });
        expect(o.kind).toBe('stuck');
        expect(o.text).toMatch(/ran out of steps/);
    });
    it('a refused action is fed back to the model, not performed', async () => {
        const task = await start();
        const t = scripted(['{"do":{"tool":"navigate_page","args":{"url":"https://evil.example"}}}', '{"stuck":"end"}']);
        await runLoop(hands, store, task, t.llm);
        expect(t.seen[1]).toMatch(/navigate_page refused: evil\.example is not one of this task's sites/);
    });
    it('the prompt stays small: goal + history + one filtered page', async () => {
        const task = await start();
        expect(buildPrompt(task).length).toBeLessThan(2_000);
    });
});
