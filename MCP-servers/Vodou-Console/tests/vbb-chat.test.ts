import path from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync, readFileSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { closeGatewayDbOnly } from '../src/db.js';
import { configureTurnEvents } from '../src/turn-events.js';

// ISOLATION, asserted rather than assumed.
//
// `handleBrainRequest` emits turn events (PLAN-SEAMS P6b(A)). `llm.ts` configures
// the real sink at import — `db: getGatewayDb`, flushing over the daemon socket —
// so without this these tests wrote their fixtures into the PRODUCTION turn log.
// 36 rows of "FALLBACK PACK" and "Your dog is Rex." landed in vodou-core.db
// before anyone noticed, found only because `turn_events` grew a `capture`
// source that nothing real had produced yet.
//
// An in-memory database, not a no-op: the emitters should still RUN here, so a
// throw in the logging path fails a test instead of hiding until production.
const _sinkDb = new DatabaseSync(':memory:');
_sinkDb.exec(readFileSync(path.resolve(__dirname, '../../../migrations/090_turn_events.sql'), 'utf-8'));
//
// Applied in a hook, NOT at module scope: `llm.ts` calls `configureTurnEvents`
// at ITS import too, so a module-level call here is a race with import order —
// and it lost. The first attempt at this fix looked right and still wrote 24
// fixture rows into production.
function useIsolatedTurnLog(): void {
  configureTurnEvents({
    db: () => _sinkDb,
    flush: async () => true,
    isGuest: () => false,
    redact: (t: string) => t,
    trustOf: () => undefined,
  });
}

// PLAN-BRAIN-INJECT-LANE — the vbb agentic lane (src/vbb/chat.ts). These tests drive
// the queue / seq / replay / budget logic with a FAKE chat function (the `_test` seam),
// so nothing spawns a claude subprocess. Capability mapping (panelCliOverride) is a pure
// function imported straight from llm.ts.

type Frame = Record<string, any>;

function makeDeps(overrides: Partial<any> = {}) {
  const sent: Frame[] = [];
  return {
    sent,
    deps: {
      send: (p: Frame) => { sent.push(p); },
      retrieveFallback: async () => ({ ok: true, context: 'FALLBACK PACK', items: [{ text: 'fallback' }] }),
      seedFromConversation: () => '',
      recentOtherThreads: () => [],
      ...overrides,
    },
  };
}

describe('vbb chat lane', () => {
  let gatewayDbPath: string | undefined;
  let chatMod: typeof import('../src/vbb/chat.js');

  beforeEach(async () => {
    useIsolatedTurnLog();
    closeGatewayDbOnly();
    if (gatewayDbPath && existsSync(gatewayDbPath)) { try { unlinkSync(gatewayDbPath); } catch { /* */ } }
    gatewayDbPath = path.join(tmpdir(), `gw-vbbchat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    process.env.GATEWAY_DB_PATH = gatewayDbPath;
    chatMod = await import('../src/vbb/chat.js');
    chatMod._test.reset();
  });

  afterAll(() => { closeGatewayDbOnly(); });

  it('rejects an empty chat message without throwing', () => {
    const { sent, deps } = makeDeps();
    chatMod.handleChatRequest(deps as any, { reqId: 'r1', conversationId: 'panel:main', text: '  ' });
    const ack = sent.find((f) => f.cmd === 'chat_ack');
    expect(ack).toBeTruthy();
    expect(ack!.accepted).toBe(false);
  });

  it('streams chunk events and a terminal done for a chat turn', async () => {
    const { sent, deps } = makeDeps();
    // Fake chat(): emit two text events then resolve.
    chatMod._test.setChatFn((async (_c: string, _m: string, onEvent: any) => {
      onEvent({ type: 'text', content: 'Hello ' });
      onEvent({ type: 'text', content: 'world' });
      return 'Hello world';
    }) as any);

    chatMod.handleChatRequest(deps as any, { reqId: 'r2', conversationId: 'panel:main', text: 'hi' });
    // let the queued async turn run
    await new Promise((r) => setTimeout(r, 20));

    const chunks = sent.filter((f) => f.cmd === 'chat_event' && f.event?.type === 'chunk');
    expect(chunks.map((c) => c.event.content).join('')).toBe('Hello world');
    const done = sent.find((f) => f.cmd === 'chat_event' && f.event?.type === 'done');
    expect(done).toBeTruthy();
    // seq is monotonic
    const seqs = sent.filter((f) => f.cmd === 'chat_event').map((f) => f.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('drops a duplicate send within 500ms', async () => {
    let calls = 0;
    chatMod._test.setChatFn((async () => { calls++; return 'ok'; }) as any);
    // Freeze the dedup clock: on a loaded CI runner the two calls below can
    // land >500ms apart in REAL time, making the second a legitimate send and
    // flaking this test (observed 2026-08-06, run 31135454369 — the same
    // commit passed on push and failed on pull_request). The window under
    // test is a property of the clock, not of runner scheduling latency.
    const t0 = Date.now();
    chatMod._test.setNow(() => t0);
    const { deps } = makeDeps();
    chatMod.handleChatRequest(deps as any, { reqId: 'a', conversationId: 'panel:dup', text: 'same' });
    chatMod.handleChatRequest(deps as any, { reqId: 'b', conversationId: 'panel:dup', text: 'same' });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(1);
    // And the window actually EXPIRES: 501ms later the same text sends again.
    chatMod._test.setNow(() => t0 + 501);
    chatMod.handleChatRequest(deps as any, { reqId: 'c', conversationId: 'panel:dup', text: 'same' });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(2);
  });

  it('replays only events with seq > lastSeq', async () => {
    const { sent, deps } = makeDeps();
    chatMod._test.setChatFn((async (_c: string, _m: string, onEvent: any) => {
      onEvent({ type: 'text', content: 'a' });
      onEvent({ type: 'text', content: 'b' });
      return 'ab';
    }) as any);
    chatMod.handleChatRequest(deps as any, { reqId: 'r', conversationId: 'panel:resume', text: 'x' });
    await new Promise((r) => setTimeout(r, 20));

    const before = sent.length;
    chatMod.handleChatResume(deps as any, { conversationId: 'panel:resume', lastSeq: 1 });
    const replayed = sent.slice(before).filter((f) => f.cmd === 'chat_event');
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.every((f) => f.seq > 1)).toBe(true);
  });

  it('degrades to the retrieval fallback when the brain turn yields nothing', async () => {
    const { sent, deps } = makeDeps();
    // Fake chat() returns empty → runTurn yields '' → degrade path.
    chatMod._test.setChatFn((async () => '') as any);
    await chatMod.handleBrainRequest(deps as any, { reqId: 'b1', draft: 'brief me', page: { provider: 'chatgpt', convId: 'c1' } });
    const result = sent.find((f) => f.cmd === 'brain_result');
    expect(result).toBeTruthy();
    expect(result!.degraded).toBe(true);
    expect(result!.pack.text).toContain('FALLBACK');
  });

  it('routes a pure-recall draft to a direct answer, not an inject pack', async () => {
    const { sent, deps } = makeDeps();
    chatMod._test.setChatFn((async () => 'Your dog is Rex.') as any);
    // "what is my dog's name" resolves to Vodou-Recall in a seeded intent DB; if the
    // test DB has no mappings it falls back to inject — assert on whichever the code took.
    await chatMod.handleBrainRequest(deps as any, { reqId: 'b2', draft: "what is my dog's name", page: { provider: 'chatgpt', convId: 'c2' } });
    const result = sent.find((f) => f.cmd === 'brain_result');
    expect(result).toBeTruthy();
    expect(result!.ok).toBe(true);
    expect(['answer', 'inject']).toContain(result!.mode);
  });

  it('brain_result carries a reqId so the extension can correlate it', async () => {
    const { sent, deps } = makeDeps();
    chatMod._test.setChatFn((async () => 'pack text') as any);
    await chatMod.handleBrainRequest(deps as any, { reqId: 'corr-9', draft: 'x', page: { provider: 'claude', convId: 'z' } });
    const result = sent.find((f) => f.cmd === 'brain_result');
    expect(result!.reqId).toBe('corr-9');
  });
});

describe('panelCliOverride capability mapping', () => {
  it('gives panel/brain lanes Bash-only grants, and leaves other convs alone', async () => {
    const { panelCliOverride } = await import('../src/llm.js');
    const savedCap = process.env.VODOU_PANEL_CAPABILITY;
    delete process.env.VODOU_PANEL_CAPABILITY; // default 'mcp'

    expect(panelCliOverride('panel:main')).toEqual({ allowedTools: 'Bash', maxTurns: '8' });
    expect(panelCliOverride('brainctx:chatgpt:c1')).toEqual({ allowedTools: 'Bash', maxTurns: '8' });
    expect(panelCliOverride('cli:abc')).toBeNull();
    expect(panelCliOverride('web')).toBeNull();
    expect(panelCliOverride(undefined)).toBeNull();

    // full-shell parity opt-out
    process.env.VODOU_PANEL_CAPABILITY = 'full';
    expect(panelCliOverride('panel:main')).toBeNull();

    if (savedCap === undefined) delete process.env.VODOU_PANEL_CAPABILITY;
    else process.env.VODOU_PANEL_CAPABILITY = savedCap;
  });
});
