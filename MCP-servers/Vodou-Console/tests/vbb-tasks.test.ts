import path from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync } from 'fs';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { closeGatewayDbOnly } from '../src/db.js';

// PLAN-VODOU-TASKS-CHANNEL Phase 1 — the async job spine. The whole point is that
// dispatch NEVER blocks: it acks immediately and the agentic turn runs in the
// background, streaming per-JOB events and delivering a result when done.
// Driven with a fake chatFn (the `_test` seam) so nothing spawns a subprocess.

type Frame = Record<string, any>;

function makeDeps() {
  const sent: Frame[] = [];
  return {
    sent,
    deps: {
      send: (p: Frame) => { sent.push(p); },
      retrieveFallback: async () => ({ ok: true, context: 'FALLBACK', items: [] }),
      seedFromConversation: () => '',
      recentOtherThreads: () => [],
    },
  };
}
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('vbb task lane (async job spine)', () => {
  let gatewayDbPath: string | undefined;
  let mod: typeof import('../src/vbb/chat.js');

  beforeEach(async () => {
    closeGatewayDbOnly();
    if (gatewayDbPath && existsSync(gatewayDbPath)) { try { unlinkSync(gatewayDbPath); } catch { /* */ } }
    gatewayDbPath = path.join(tmpdir(), `gw-vbbtasks-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    process.env.GATEWAY_DB_PATH = gatewayDbPath;
    mod = await import('../src/vbb/chat.js');
    mod._test.reset();
  });

  afterAll(() => { closeGatewayDbOnly(); });

  it('acks IMMEDIATELY — before the turn runs (the async contract)', () => {
    const { sent, deps } = makeDeps();
    let started = false;
    mod._test.setChatFn((async () => { started = true; return 'done'; }) as any);

    mod.handleTaskDispatch(deps as any, { reqId: 'r1', draft: 'do a thing', page: { provider: 'chatgpt', convId: 'c1' } });

    const ack = sent.find((f) => f.cmd === 'task_ack');
    expect(ack).toBeTruthy();
    expect(ack!.accepted).toBe(true);
    expect(ack!.jobId).toBeTruthy();
    // The ack is synchronous with dispatch; the turn has not produced anything yet.
    expect(sent.find((f) => f.cmd === 'task_done')).toBeUndefined();
    void started;
  });

  it('streams per-job events then delivers task_done with the result', async () => {
    const { sent, deps } = makeDeps();
    mod._test.setChatFn((async (_c: string, _m: string, onEvent: any) => {
      onEvent({ type: 'text', content: 'the ' });
      onEvent({ type: 'text', content: 'answer' });
      return 'the answer';
    }) as any);

    mod.handleTaskDispatch(deps as any, { reqId: 'r2', draft: 'q', page: { provider: 'chatgpt', convId: 'c2' } });
    await settle();

    const evts = sent.filter((f) => f.cmd === 'task_event');
    expect(evts.length).toBeGreaterThan(0);
    // every event carries the jobId and a monotonic per-job seq
    const jobId = sent.find((f) => f.cmd === 'task_ack')!.jobId;
    expect(evts.every((e) => e.jobId === jobId)).toBe(true);
    const seqs = evts.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

    const done = sent.find((f) => f.cmd === 'task_done');
    expect(done).toBeTruthy();
    expect(done!.ok).toBe(true);
    expect(done!.result.text).toBe('the answer');
  });

  it('carries draftAtDispatch back so delivery can verify the composer (no clobber)', async () => {
    const { sent, deps } = makeDeps();
    mod._test.setChatFn((async () => 'ok') as any);
    mod.handleTaskDispatch(deps as any, { reqId: 'r3', draft: 'my draft', page: { provider: 'x', convId: 'y' }, deliver: 'both' });
    await settle();
    const done = sent.find((f) => f.cmd === 'task_done');
    expect(done!.draftAtDispatch).toBe('my draft');
    expect(done!.deliver).toBe('both');
  });

  it('sets the heavy hint once a tool fires (pill → Tasks card)', async () => {
    const { sent, deps } = makeDeps();
    mod._test.setChatFn((async (_c: string, _m: string, onEvent: any) => {
      onEvent({ type: 'tool_call_start', toolName: 'get_cpu_info', serverName: 'mcp-monitor' });
      onEvent({ type: 'tool_call_end', toolName: 'get_cpu_info', success: true });
      return 'M1 Pro';
    }) as any);
    mod.handleTaskDispatch(deps as any, { reqId: 'r4', draft: 'cpu?', page: { provider: 'x', convId: 'h' } });
    await settle();
    const done = sent.find((f) => f.cmd === 'task_done');
    expect(done!.heavy).toBe(true);
    expect(done!.result.tools_run).toContain('get_cpu_info');
  });

  it('rejects an empty task without starting work', () => {
    const { sent, deps } = makeDeps();
    mod.handleTaskDispatch(deps as any, { reqId: 'r5', draft: '   ', page: {} });
    const ack = sent.find((f) => f.cmd === 'task_ack');
    expect(ack!.accepted).toBe(false);
  });

  it('task_list hydrates the panel with recent jobs', async () => {
    const { sent, deps } = makeDeps();
    mod._test.setChatFn((async () => 'a') as any);
    mod.handleTaskDispatch(deps as any, { reqId: 'd1', draft: 'first task', page: { provider: 'p', convId: 'a' } });
    await settle();
    mod.handleTaskList(deps as any, { reqId: 'L1' });
    const list = sent.find((f) => f.cmd === 'task_list_result');
    expect(list).toBeTruthy();
    expect(list!.jobs.length).toBeGreaterThan(0);
    expect(list!.jobs[0].title).toContain('first task');
    expect(list!.jobs[0].status).toBe('done');
  });

  it('task_status replays only events past lastSeq (panel reconnect)', async () => {
    const { sent, deps } = makeDeps();
    mod._test.setChatFn((async (_c: string, _m: string, onEvent: any) => {
      onEvent({ type: 'text', content: 'a' });
      onEvent({ type: 'text', content: 'b' });
      return 'ab';
    }) as any);
    mod.handleTaskDispatch(deps as any, { reqId: 'd2', draft: 't', page: { provider: 'p', convId: 'b' } });
    await settle();
    const jobId = sent.find((f) => f.cmd === 'task_ack')!.jobId;

    const before = sent.length;
    mod.handleTaskStatus(deps as any, { reqId: 'S1', jobId, lastSeq: 1 });
    const replayed = sent.slice(before).filter((f) => f.cmd === 'task_event');
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.every((f) => f.seq > 1)).toBe(true);
  });

  it('cancel stops a queued/running job and reports it', async () => {
    const { sent, deps } = makeDeps();
    mod._test.setChatFn((async () => { await settle(200); return 'late'; }) as any);
    mod.handleTaskDispatch(deps as any, { reqId: 'd3', draft: 'long one', page: { provider: 'p', convId: 'c' } });
    const jobId = sent.find((f) => f.cmd === 'task_ack')!.jobId;
    mod.handleTaskCancel(deps as any, { jobId });
    const done = sent.find((f) => f.cmd === 'task_done' && f.cancelled);
    expect(done).toBeTruthy();
    expect(mod._test.jobs.get(jobId)!.status).toBe('cancelled');
  });

  it('serializes two tasks on the SAME page, runs different pages in parallel', async () => {
    const { sent, deps } = makeDeps();
    let concurrent = 0, maxConcurrent = 0;
    mod._test.setChatFn((async () => {
      concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      await settle(40);
      concurrent--;
      return 'x';
    }) as any);

    // same page (same convId) → must serialize
    mod.handleTaskDispatch(deps as any, { reqId: 'p1', draft: 'one', page: { provider: 'chatgpt', convId: 'same' } });
    mod.handleTaskDispatch(deps as any, { reqId: 'p2', draft: 'two', page: { provider: 'chatgpt', convId: 'same' } });
    await settle(200);
    expect(maxConcurrent).toBe(1);
    expect(sent.filter((f) => f.cmd === 'task_done' && f.ok).length).toBe(2); // both still complete
  });
});

describe('cleanForDelivery — never inject gateway debug scaffolding', () => {
  it('strips the Raw Vodou Results collapsible (renders fine in the console, is JSON garbage in a composer)', async () => {
    const { cleanForDelivery } = await import('../src/vbb/chat.js');
    const withDebug = '<details><summary>🔍 Raw Vodou Results (422 chars, 78ms)</summary>\n\n```\n{"core_count":10}\n```\n</details>\n\nYour CPU is an Apple M1 Pro.';
    expect(cleanForDelivery(withDebug)).toBe('Your CPU is an Apple M1 Pro.');
  });
  it('leaves a clean answer untouched', async () => {
    const { cleanForDelivery } = await import('../src/vbb/chat.js');
    expect(cleanForDelivery('Just the answer.')).toBe('Just the answer.');
  });
});

describe('looksLikeNarration — make an invisible failure visible', () => {
  it('flags a narration reply after heavy tool work', async () => {
    const { looksLikeNarration } = await import('../src/vbb/chat.js');
    expect(looksLikeNarration('Now the synthesis thought (5).', true)).toBe(true);
    expect(looksLikeNarration('Let me add thought 3', true)).toBe(true);
  });
  it('never flags a genuinely short answer, or a light turn', async () => {
    const { looksLikeNarration } = await import('../src/vbb/chat.js');
    expect(looksLikeNarration('Apple M1 Pro, 10 cores @ 3.2 GHz.', true)).toBe(false);
    expect(looksLikeNarration('Now that I check, your CPU is an M1 Pro with 10 cores running at 3.2GHz and about 35% utilised right now, which is normal for background work.', true)).toBe(false);
    expect(looksLikeNarration('Now the synthesis thought (5).', false)).toBe(false); // no tools ran
  });
});

describe('task_list carries the FULL result, not a preview', () => {
  it('a rehydrated card can show the whole answer', async () => {
    const { _test, handleTaskDispatch, handleTaskList } = await import('../src/vbb/chat.js');
    _test.reset();
    const long = 'X'.repeat(1200);
    _test.setChatFn((async () => long) as any);
    const sent: any[] = [];
    const deps = {
      send: (p: any) => sent.push(p),
      retrieveFallback: async () => ({ ok: false, context: '', items: [] }),
      seedFromConversation: () => '', recentOtherThreads: () => [],
    };
    handleTaskDispatch(deps as any, { reqId: 'x', draft: 'long one', page: { provider: 'p', convId: 'long' } });
    await new Promise((r) => setTimeout(r, 40));
    handleTaskList(deps as any, { reqId: 'L' });
    const job = sent.find((f) => f.cmd === 'task_list_result')!.jobs[0];
    // The panel rebuilds cards from this on every reconnect — a 240-char slice left a
    // stub cut mid-word with no way to reach the rest.
    expect(job.result.text.length).toBe(1200);
    expect(job.resultPreview).toBeUndefined();
  });
});
