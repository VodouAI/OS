/**
 * Run record + durable execution (PLAN-GRAPH-SKILLS P0 — holes H3, H4, H20, H22).
 *
 * The behaviour under test is not "rows get written". It is: **after an
 * ungraceful death, does the system still tell the truth about what ran?**
 * Every assertion below is aimed at that.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  ensureGraphRunsTable,
  startRun,
  recordBranches,
  finishRun,
  reconcileInterruptedRuns,
  getRun,
  listRuns,
  summarizeRun,
  recipeHash,
  recordAsk,
  clearAsk,
  answerAsk,
  getPendingAsk,
  listPendingAsks,
  findLiveRunForConversation,
  groupIdOf,
  type BranchRecord,
  type PendingAsk,
} from '../graph-runs.js';

const FAN = [
  { id: 'calendar', server: 'google-calendar', tool: 'list-events', parallel_group: 'sources' },
  { id: 'mail', server: 'gmail', tool: 'messages_list', parallel_group: 'sources' },
  { id: 'slack', server: 'slack', tool: 'slack_search_messages', parallel_group: 'sources' },
  { id: 'j', kind: 'join', in: ['calendar', 'mail', 'slack'], min_success: 2 },
];

const running = (id: string): BranchRecord => ({ id, group: 'sources', state: 'running' });

describe('graph_runs — the run record', () => {
  beforeAll(() => ensureGraphRunsTable());

  it('records a run and derives counts from branch states, not from a caller-supplied number', () => {
    const runId = startRun({ skill: 'test-briefing', steps: FAN, surface: 'test' });
    recordBranches(runId, [running('calendar'), running('mail'), running('slack')]);
    recordBranches(runId, [
      { id: 'calendar', group: 'sources', state: 'ok', elapsed_ms: 2517 },
      { id: 'mail', group: 'sources', state: 'ok', elapsed_ms: 684 },
      { id: 'slack', group: 'sources', state: 'timeout', error: 'timed out after 30000ms' },
    ]);
    finishRun(runId, 'partial');

    const row = getRun(runId)!;
    expect(row).toBeTruthy();
    const counts = JSON.parse(row.counts_json);
    expect(counts).toEqual({ expected: 3, settled: 3, ok: 2, failed: 1 });
    expect(row.outcome).toBe('partial');
  });

  it('pins each run to the recipe that ran (H22) — editing the graph cannot rewrite history', () => {
    const a = recipeHash(FAN);
    const b = recipeHash([...FAN.slice(0, 3), { id: 'j', kind: 'join', in: ['calendar', 'mail'], min_success: 2 }]);
    expect(a).toHaveLength(16);
    expect(a).not.toBe(b);
    // Arguments vary run to run and must NOT change the identity of the graph.
    const withArgs = FAN.map((s) => ({ ...s, args: { when: Date.now() } }));
    expect(recipeHash(withArgs)).toBe(a);
  });

  it('keeps runs addressable per id, so two can be in flight at once (H4)', () => {
    const one = startRun({ skill: 'skill-one', steps: FAN, surface: 'test' });
    const two = startRun({ skill: 'skill-two', steps: FAN, surface: 'test' });
    expect(one).not.toBe(two);
    recordBranches(one, [{ id: 'a', state: 'ok' }]);
    recordBranches(two, [{ id: 'a', state: 'failed' }]);
    expect(JSON.parse(getRun(one)!.node_states_json)[0].state).toBe('ok');
    expect(JSON.parse(getRun(two)!.node_states_json)[0].state).toBe('failed');
    finishRun(one, 'complete');
    finishRun(two, 'failed');
  });

  describe('durable execution (H20) — a gateway killed mid-fan', () => {
    it('preserves which branches had already settled', () => {
      // Simulate the kill: branches recorded, run never finished, process gone.
      const runId = startRun({ skill: 'interrupted-briefing', steps: FAN, surface: 'test' });
      recordBranches(runId, [running('calendar'), running('mail'), running('slack')]);
      recordBranches(runId, [
        { id: 'calendar', group: 'sources', state: 'ok', elapsed_ms: 2517 },
        { id: 'mail', group: 'sources', state: 'ok', elapsed_ms: 684 },
      ]);
      // <-- SIGKILL here. No finishRun. This is what boot finds.

      const reconciled = reconcileInterruptedRuns();
      expect(reconciled).toBeGreaterThan(0);

      const row = getRun(runId)!;
      // The run does not vanish, and it does not claim to have completed.
      expect(row.outcome).toBe('failed');
      expect(row.cancelled_by).toBe('interrupted');
      expect(row.ended_at).toBeTruthy();

      // And it still names exactly what came back before the kill.
      const branches = JSON.parse(row.node_states_json) as BranchRecord[];
      const byId = Object.fromEntries(branches.map((b) => [b.id, b.state]));
      expect(byId.calendar).toBe('ok');
      expect(byId.mail).toBe('ok');
      expect(byId.slack).toBe('running'); // never came back — and says so
      expect(JSON.parse(row.counts_json).settled).toBe(2);
    });

    it('leaves finished runs alone', () => {
      const runId = startRun({ skill: 'already-done', steps: FAN, surface: 'test' });
      recordBranches(runId, [{ id: 'a', state: 'ok' }]);
      finishRun(runId, 'complete');
      reconcileInterruptedRuns();
      const row = getRun(runId)!;
      expect(row.outcome).toBe('complete');
      expect(row.cancelled_by).toBeNull();
    });
  });

  it('summarizes a run from its stored counts, never from prose', () => {
    const runId = startRun({ skill: 'summary-test', steps: FAN, surface: 'test' });
    recordBranches(runId, [
      { id: 'a', state: 'ok' },
      { id: 'b', state: 'ok' },
      { id: 'c', state: 'failed' },
    ]);
    finishRun(runId, 'partial');
    const s = summarizeRun(getRun(runId)!);
    expect(s).toContain('2/3');
    expect(s).toContain('partial');
  });

  it('lists runs newest-first and can filter by skill', () => {
    const rows = listRuns('summary-test', 5);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.skill === 'summary-test')).toBe(true);
  });
});

/**
 * A human node the run is parked on (PLAN-GRAPH-SKILLS §5.3, PLAN-GRAPH-FRONTEND
 * phase 0 item 2).
 *
 * The point of persisting the question on the RUN rather than in the
 * conversation is that a different surface can answer it. These test that
 * property, not that a column round-trips.
 */
/**
 * One invocation, several phases (PLAN-GRAPH-FRONTEND N2, decided 2026-08-25).
 *
 * `runId` is local to `executeSteps` and every menu answer starts a new one, so
 * a four-phase skill writes four rows for one thing the user ran once. Rows stay
 * phases and are GROUPED — no synthetic parent row, so nothing in the list is a
 * record of something that did not run.
 */
describe('graph_runs — phases of one invocation', () => {
  beforeAll(() => ensureGraphRunsTable());

  it('a first phase is its own group; later phases join it', () => {
    const conv = `conv_${Math.random().toString(36).slice(2)}`;
    const p1 = startRun({ skill: 'multi', steps: FAN, surface: 'web', conversationId: conv });
    const g = groupIdOf(getRun(p1)!);
    expect(g).toBe(p1); // the first phase IS the parent

    const p2 = startRun({ skill: 'multi', steps: FAN, surface: 'web', conversationId: conv, parentRunId: g });
    const p3 = startRun({ skill: 'multi', steps: FAN, surface: 'web', conversationId: conv, parentRunId: g });

    expect(groupIdOf(getRun(p2)!)).toBe(g);
    expect(groupIdOf(getRun(p3)!)).toBe(g);
    // Three rows, one invocation.
    const mine = listRuns('multi', 50).filter((r) => r.conversation_id === conv);
    expect(mine).toHaveLength(3);
    expect(new Set(mine.map(groupIdOf)).size).toBe(1);
  });

  it('a separate invocation is a separate group', () => {
    const conv = `conv_${Math.random().toString(36).slice(2)}`;
    const a = startRun({ skill: 'twice', steps: FAN, surface: 'web', conversationId: conv });
    const b = startRun({ skill: 'twice', steps: FAN, surface: 'web', conversationId: conv });
    expect(groupIdOf(getRun(a)!)).not.toBe(groupIdOf(getRun(b)!));
  });
});

describe('graph_ask — a run parked on a question', () => {
  beforeAll(() => ensureGraphRunsTable());

  /**
   * This suite writes to the LIVE gateway.db, and a parked ask is now ACTIONABLE
   * state: `GET /api/graph/asks` lists it and `POST .../answer` will try to
   * resume it. Nine fixture rows were sitting in the production list before this
   * hook existed. A test that leaves behind something a surface can act on is not
   * a test, it is a defect with a green tick next to it.
   */
  const created: string[] = [];
  afterAll(() => {
    for (const id of created) clearAsk(id);
  });
  const track = (id: string) => { created.push(id); return id; };

  const ask = (id: string): PendingAsk => ({
    askId: id,
    title: 'post to #daily?',
    options: [{ n: '1', label: 'Yes' }, { n: '2', label: 'No' }],
    type: 'menu',
    askedAt: Date.now(),
  });

  it('finds the parked run by CONVERSATION, which is how a menu layer with no run id reaches it', () => {
    const conv = `conv_${Math.random().toString(36).slice(2)}`;
    const runId = track(startRun({ skill: 'briefing', steps: FAN, surface: 'web', conversationId: conv }));
    recordAsk(runId, ask(`${runId}:0`));

    const found = findLiveRunForConversation(conv);
    expect(found?.run_id).toBe(runId);
    expect(getPendingAsk(runId)?.title).toBe('post to #daily?');
    expect(getPendingAsk(runId)?.options).toHaveLength(2);
  });

  it('lists every parked run, so a surface absent when the question was asked can still find it', () => {
    const conv = `conv_${Math.random().toString(36).slice(2)}`;
    const runId = track(startRun({ skill: 'listable', steps: FAN, surface: 'web', conversationId: conv }));
    recordAsk(runId, ask(`${runId}:0`));
    expect(listPendingAsks(50).some((r) => r.run_id === runId)).toBe(true);
  });

  it('re-asking overwrites, so a run can never be waiting on two answers at once', () => {
    const runId = track(startRun({ skill: 'reask', steps: FAN, surface: 'web', conversationId: 'c1' }));
    recordAsk(runId, ask('a:0'));
    recordAsk(runId, { ...ask('a:1'), title: 'second question' });
    expect(getPendingAsk(runId)?.title).toBe('second question');
    expect(listPendingAsks(50).filter((r) => r.run_id === runId)).toHaveLength(1);
  });

  it('a finished run holds no question — otherwise a stale menu is answerable forever', () => {
    const runId = track(startRun({ skill: 'ended', steps: FAN, surface: 'web', conversationId: 'c2' }));
    recordAsk(runId, ask(`${runId}:0`));
    expect(getPendingAsk(runId)).toBeTruthy();
    finishRun(runId, 'complete');
    expect(getPendingAsk(runId)).toBeNull();
  });

  it('a finished run is no longer the conversation\'s LIVE run', () => {
    const conv = `conv_${Math.random().toString(36).slice(2)}`;
    const runId = track(startRun({ skill: 'done', steps: FAN, surface: 'web', conversationId: conv }));
    expect(findLiveRunForConversation(conv)?.run_id).toBe(runId);
    finishRun(runId, 'complete');
    expect(findLiveRunForConversation(conv)).toBeUndefined();
  });

  /**
   * Found in LIVE data, not in a test: nine runs sat in the production pending
   * list, every one `failed`. `finishRun` clears the ask, but a run that DIES
   * never reaches finishRun — it is reconciled at the next boot, and the
   * question outlived the process that asked it. A dead run must be unable to
   * hold an answerable question no matter which clear was missed.
   */
  /**
   * The wall this whole state exists for. `executeSteps` closes a run when the
   * STEP LIST ends, and the `ask me:` node is presented afterwards by a layer
   * above — so a run waiting on a human was already `complete`, and the two
   * correct guards (find a live run; refuse a finished run a question) between
   * them made the question unreachable.
   */
  it('parks a finished run so it can hold a question, and stays findable', () => {
    const conv = `conv_${Math.random().toString(36).slice(2)}`;
    const runId = track(startRun({ skill: 'parks', steps: FAN, surface: 'web', conversationId: conv }));
    finishRun(runId, 'partial');                       // the steps ended
    expect(getRun(runId)!.outcome).toBe('partial');
    expect(findLiveRunForConversation(conv)).toBeUndefined();

    recordAsk(runId, ask(`${runId}:0`));               // ...then a human node

    expect(getRun(runId)!.outcome).toBe('parked');
    expect(findLiveRunForConversation(conv)?.run_id).toBe(runId);
    expect(getPendingAsk(runId)?.title).toBe('post to #daily?');
    expect(listPendingAsks(50).some((r) => r.run_id === runId)).toBe(true);
  });

  /**
   * A phase whose branches partly failed must not come back as `complete`
   * because somebody pressed a button.
   */
  /**
   * N14. After N13 moved sends behind the gate, a plan whose ONLY step is a send
   * has an empty `initial_steps` — nothing runs, no run opens, and the ask had
   * no run to attach to. The shape the gate most protects got the worst
   * approval UI: a prose menu instead of buttons.
   *
   * A parked run with no branches is not a defect. It is the truth: the work is
   * waiting for an answer and none of it has run.
   */
  it('a run parked before any step ran is still a run', () => {
    const conv = `conv_${Math.random().toString(36).slice(2)}`;
    const runId = track(startRun({ skill: 'all-gated', surface: 'web', conversationId: conv }));
    recordAsk(runId, ask(`${runId}:0`));

    const row = getRun(runId)!;
    expect(row.outcome).toBe('parked');
    expect(JSON.parse(row.node_states_json)).toEqual([]); // nothing ran, and it says so
    expect(getPendingAsk(runId)?.title).toBe('post to #daily?');
    expect(findLiveRunForConversation(conv)?.run_id).toBe(runId);
  });

  it('answering restores the outcome the run parked FROM', () => {
    const runId = track(startRun({ skill: 'restores', steps: FAN, surface: 'web', conversationId: 'c9' }));
    finishRun(runId, 'partial');
    recordAsk(runId, ask(`${runId}:0`));
    expect(getRun(runId)!.outcome).toBe('parked');

    answerAsk(runId);

    expect(getRun(runId)!.outcome).toBe('partial');
    expect(getPendingAsk(runId)).toBeNull();
  });

  /**
   * Parking must not become a way for a dead run to come back to life: a run
   * that DIES while parked stays dead, and `clearAsk` (what death uses) never
   * restores anything.
   */
  it('a run that dies while parked does not resurrect as its pre-park outcome', () => {
    const runId = track(startRun({ skill: 'dies-parked', steps: FAN, surface: 'web', conversationId: 'c10' }));
    finishRun(runId, 'complete');
    recordAsk(runId, ask(`${runId}:0`));
    finishRun(runId, 'cancelled');                     // the death
    expect(getRun(runId)!.outcome).toBe('cancelled');
    expect(getPendingAsk(runId)).toBeNull();
  });

  it('a run that DIED holds no answerable question, even with the column still set', () => {
    const conv = `conv_${Math.random().toString(36).slice(2)}`;
    const runId = track(startRun({ skill: 'died', steps: FAN, surface: 'web', conversationId: conv }));
    recordAsk(runId, ask(`${runId}:0`));
    expect(getPendingAsk(runId)).toBeTruthy();

    // Reconcile is what a boot does to a run whose process is gone.
    reconcileInterruptedRuns();

    expect(getRun(runId)!.outcome).not.toBe('running');
    expect(getPendingAsk(runId)).toBeNull();
    expect(listPendingAsks(50).some((r) => r.run_id === runId)).toBe(false);
  });

  it('answering clears it, so the same question cannot be answered twice from two surfaces', () => {
    const runId = track(startRun({ skill: 'once', steps: FAN, surface: 'web', conversationId: 'c3' }));
    recordAsk(runId, ask(`${runId}:0`));
    clearAsk(runId);
    expect(getPendingAsk(runId)).toBeNull();
  });
});
