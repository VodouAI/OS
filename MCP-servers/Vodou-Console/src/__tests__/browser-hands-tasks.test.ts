import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore, routeReply, utc } from '../browser-hands/tasks.js';

// PLAN-BROWSER-HANDS §13.1/§13.2/§13.7: a browser errand spans turns; a gate is
// persisted, single, nonce-bound and consumed exactly once; "stop" always wins.

let db: DatabaseSync;
let clock: Date;
let store: TaskStore;
const CONV = 'workbench:channel:relay';
const GATE = { category: 'book' as const, target: 'button "Complete reservation"', summary: 'Book Sidecar, Sat 7:30, party of 4, on OpenTable?', tool: 'click', args: { pageId: 1, uid: '1_3' } };

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  clock = new Date('2026-09-28T19:00:00Z');
  store = new TaskStore(db, () => clock);
});

describe('browser tasks: one at a time, persisted', () => {
  it('a second errand returns the running one instead of starting another', () => {
    const a = store.create({ conversationId: CONV, goal: 'book a table' });
    const b = store.create({ conversationId: CONV, goal: 'order groceries' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.task.id).toBe(a.task.id);
  });
  it('a gate survives a "restart" (a fresh store on the same database)', () => {
    const { task } = store.create({ conversationId: CONV, goal: 'book' });
    const g = store.suspendAtGate(task.id, GATE);
    const after = new TaskStore(db, () => clock);
    const t = after.active(CONV)!;
    expect(t.status).toBe('suspended');
    expect(t.gate?.nonce).toBe(g.nonce);
    expect(t.gate?.summary).toBe(GATE.summary);
  });
  it('writes naive-UTC timestamps', () => {
    const { task } = store.create({ conversationId: CONV, goal: 'x' });
    expect(task.createdAt).toBe('2026-09-28 19:00:00');
    expect(utc(new Date('2026-01-02T03:04:05.678Z'))).toBe('2026-01-02 03:04:05');
  });
});

describe('gates: exactly once', () => {
  it('consumes once; a second consume (a double tap, a retry) gets nothing', () => {
    const { task } = store.create({ conversationId: CONV, goal: 'book' });
    const g = store.suspendAtGate(task.id, GATE);
    expect(store.consumeGate(task.id, g.nonce, 'approve')?.decision).toBe('approve');
    expect(store.consumeGate(task.id, g.nonce, 'approve')).toBeNull();
  });
  it('a stale nonce (an older gate) is refused', () => {
    const { task } = store.create({ conversationId: CONV, goal: 'book' });
    const old = store.suspendAtGate(task.id, GATE);
    store.consumeGate(task.id, old.nonce, 'approve'); // back to running
    const fresh = store.suspendAtGate(task.id, { ...GATE, summary: 'Book Sidecar, Sat 8:15?' });
    expect(store.consumeGate(task.id, old.nonce, 'approve')).toBeNull();
    expect(store.consumeGate(task.id, fresh.nonce, 'approve')).not.toBeNull();
  });
  it('a gate left unanswered lapses after its hold', () => {
    const { task } = store.create({ conversationId: CONV, goal: 'book' });
    const g = store.suspendAtGate(task.id, GATE, 10);
    clock = new Date(clock.getTime() + 11 * 60_000);
    expect(store.active(CONV)).toBeNull();
    expect(store.get(task.id)?.status).toBe('expired');
    expect(store.consumeGate(task.id, g.nonce, 'approve')).toBeNull();
  });
});

describe('routing replies before a normal turn', () => {
  it('"yes" / "no" answer a pending gate', () => {
    const { task } = store.create({ conversationId: CONV, goal: 'book' });
    store.suspendAtGate(task.id, GATE);
    expect(routeReply(store, CONV, 'yes')).toMatchObject({ kind: 'gate', decision: 'approve' });
    expect(routeReply(store, CONV, 'Nope')).toMatchObject({ kind: 'gate', decision: 'deny' });
  });
  it('"stop" always wins — even while the task is running, not queued behind it', () => {
    const { task } = store.create({ conversationId: CONV, goal: 'book' });
    expect(routeReply(store, CONV, 'stop')).toMatchObject({ kind: 'stop' });
    store.suspendAtGate(task.id, GATE);
    expect(routeReply(store, CONV, 'Cancel.')).toMatchObject({ kind: 'stop' });
  });
  it('a message while a task is running is "busy" (queued), not a new turn racing it', () => {
    store.create({ conversationId: CONV, goal: 'book' });
    expect(routeReply(store, CONV, 'also what is the weather')).toMatchObject({ kind: 'busy' });
  });
  it('a sentence is not a yes', () => {
    const { task } = store.create({ conversationId: CONV, goal: 'book' });
    store.suspendAtGate(task.id, GATE);
    expect(routeReply(store, CONV, 'yes but make it 8pm instead').kind).toBe('none');
  });
  it('a question takes a number or the option text', () => {
    const { task } = store.create({ conversationId: CONV, goal: 'book' });
    store.suspendAtQuestion(task.id, { kind: 'options', prompt: 'Which time?', options: ['6:45 PM', '7:30 PM', '8:15 PM'] });
    expect(routeReply(store, CONV, '2')).toMatchObject({ kind: 'option', choice: '7:30 PM', index: 1 });
    expect(routeReply(store, CONV, '8:15 pm')).toMatchObject({ kind: 'option', choice: '8:15 PM' });
    expect(routeReply(store, CONV, '9')).toMatchObject({ kind: 'none' });
  });
  it('no task → nothing to route', () => {
    expect(routeReply(store, CONV, 'yes').kind).toBe('none');
  });
});

describe('receipts', () => {
  it('records every step with its decision and outcome', () => {
    const { task } = store.create({ conversationId: CONV, goal: 'book' });
    store.recordStep(task.id, { idx: 0, tool: 'navigate_page', decision: 'allow', outcome: 'ok' });
    store.recordStep(task.id, { idx: 1, tool: 'click', target: 'button "Complete reservation"', decision: 'gate', outcome: 'gated' });
    store.finish(task.id, 'done', 'booked');
    expect(store.steps(task.id).map((s) => `${s.tool}:${s.decision}:${s.outcome}`)).toEqual(['navigate_page:allow:ok', 'click:gate:gated']);
    expect(store.get(task.id)?.status).toBe('done');
  });
});
