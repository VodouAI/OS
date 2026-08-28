/**
 * COHERENCE F28 — "A skill failed and I never heard about it."
 *
 * Delivery of SUCCESSFUL scheduled runs is sound: badge → Inbox → seen, since
 * F2. What had never been confirmed is that an errored, timed-out or empty run
 * reaches the user at all — and reading the code said it did not, twice:
 *
 *   1. The panel notification was gated on `sfText.trim().length > 0`, so a run
 *      that produced nothing said nothing. The logged `daily-competitor-intel,
 *      0 chars` incident therefore reached the user as complete silence,
 *      indistinguishable from a skill that never fired.
 *   2. The catch block logged to a file, recorded a chat failure and answered
 *      500 to the scheduler. None of those three is a surface a person looks at.
 *
 * The finding asked for an INDUCED failure rather than more source reading, and
 * that is what this file does: a real gateway app on a temp database, a real
 * HTTP fire, and an LLM mocked into each failure mode. The bridge is mocked only
 * so the frame can be caught — the code path producing it is the live one.
 *
 * A scheduled job whose failures are invisible is one a person stops trusting
 * and then stops using, which is worse than not having scheduled it.
 */

import path from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync } from 'fs';
import request from 'supertest';
import type { Express } from 'express';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { closeGatewayDbOnly, getGatewayDb } from '../src/db.js';

/** What the LLM does this run — each value is one real failure mode. */
let mode: 'text' | 'empty' | 'throw' = 'text';

vi.mock('../src/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm.js')>();
  return {
    ...actual,
    isConfigured: () => true,
    chat: vi.fn(async (_id: string, _prompt: string, cb: (e: { type: string; content?: string; usage?: object }) => void) => {
      if (mode === 'throw') throw new Error('provider exploded mid-turn');
      // A turn that completes having emitted no text: the 0-chars incident.
      if (mode === 'text') cb({ type: 'text', content: 'a real briefing' });
      cb({ type: 'done', usage: {} });
    }),
  };
});

/** Every frame the gateway tried to push at the panel. */
const pushed: Array<Record<string, unknown>> = [];
vi.mock('../src/vbb/bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/vbb/bridge.js')>();
  return {
    ...actual,
    bridgeNotifySkillResult: (payload: Record<string, unknown>) => { pushed.push(payload); },
  };
});

describe('a scheduled skill that fails reaches the user', () => {
  let app: Express;
  let gatewayDbPath: string | undefined;

  beforeEach(async () => {
    mode = 'text';
    pushed.length = 0;
    closeGatewayDbOnly();
    if (gatewayDbPath && existsSync(gatewayDbPath)) {
      try { unlinkSync(gatewayDbPath); } catch { /* ignore */ }
    }
    gatewayDbPath = path.join(tmpdir(), `gw-f28-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    process.env.GATEWAY_DB_PATH = gatewayDbPath;
    delete process.env.VODOU_GATEWAY_SCHEDULER_SECRET;
    const { createGatewayApp } = await import('../src/index.js');
    app = createGatewayApp();
  });

  afterAll(() => {
    closeGatewayDbOnly();
    if (gatewayDbPath && existsSync(gatewayDbPath)) {
      try { unlinkSync(gatewayDbPath); } catch { /* ignore */ }
    }
  });

  function seedSkill(name: string) {
    const db = getGatewayDb();
    const convId = `workbench:skill-console:${name}`;
    db.prepare(
      `INSERT INTO skills_meta (name, display_name, prompt_template, principal_id, is_active) VALUES (?, ?, ?, ?, ?)`,
    ).run(name, `Display ${name}`, 'ASK {{user_message}}', 'p-test', 1);
    const row = db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number };
    db.prepare(`INSERT INTO skill_console_bindings (conversation_id, skill_id) VALUES (?, ?)`).run(convId, row.id);
    return { skillId: row.id as number, conversationId: convId };
  }

  const fire = (s: { skillId: number; conversationId: string }, body: Record<string, unknown> = {}) =>
    request(app).post('/chat/skill-fire').send({ ...s, ...body });

  it('still delivers the good case, unchanged', async () => {
    const s = seedSkill('f28-ok');
    const res = await fire(s);
    expect(res.status).toBe(200);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].ok).toBe(true);
    expect(String(pushed[0].response)).toContain('a real briefing');
  });

  /** The `daily-competitor-intel, 0 chars` incident, induced. */
  it('tells the user when a run produced nothing', async () => {
    mode = 'empty';
    const s = seedSkill('f28-empty');
    const res = await fire(s);
    expect(res.status).toBe(200);
    expect(pushed, 'an empty run reached nobody — this is the silence F28 filed').toHaveLength(1);
    expect(pushed[0].ok).toBe(false);
    expect(String(pushed[0].response)).toMatch(/produced nothing/i);
    expect(String(pushed[0].display_name)).toContain('f28-empty');
  });

  it('tells the user when a run threw, and still answers the scheduler', async () => {
    mode = 'throw';
    const s = seedSkill('f28-throw');
    const res = await fire(s);
    // The 500 still goes back — the run row needs it. The person gets told TOO;
    // that was the whole gap.
    expect(res.status).toBe(500);
    expect(pushed, 'a thrown run reached nobody but a log file').toHaveLength(1);
    expect(pushed[0].ok).toBe(false);
    expect(String(pushed[0].response)).toMatch(/failed:/);
    expect(String(pushed[0].response)).toContain('provider exploded mid-turn');
  });

  it('keeps a rehearsal silent — a dry run must not ring the bell', async () => {
    mode = 'empty';
    const s = seedSkill('f28-dry');
    await fire(s, { dryRun: true });
    expect(pushed, 'a dry run notified the user').toHaveLength(0);
  });

  it('never lets the badge take the run down with it', async () => {
    // Fire-and-forget means fire-and-forget: if the push throws, the run stands.
    const bridge = await import('../src/vbb/bridge.js');
    const spy = vi.spyOn(bridge, 'bridgeNotifySkillResult').mockImplementation(() => {
      throw new Error('bridge is gone');
    });
    const s = seedSkill('f28-bridge-down');
    const res = await fire(s);
    expect(res.status).toBe(200);
    expect(res.body.response).toContain('a real briefing');
    spy.mockRestore();
  });
});
