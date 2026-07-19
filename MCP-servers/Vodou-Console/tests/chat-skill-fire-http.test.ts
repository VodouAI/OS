import path from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync } from 'fs';
import request from 'supertest';
import type { Express } from 'express';
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { closeGatewayDbOnly, getGatewayDb } from '../src/db.js';

vi.mock('../src/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm.js')>();
  return {
    ...actual,
    isConfigured: () => true,
    chat: vi.fn(async (_id: string, prompt: string, cb: (e: { type: string; content?: string; usage?: object }) => void) => {
      cb({ type: 'text', content: `SKILL_FIRE_MOCK:${String(prompt).substring(0, 300)}` });
      cb({ type: 'done', usage: {} });
    }),
  };
});

describe('POST /chat/skill-fire', () => {
  let app: Express;
  let gatewayDbPath: string | undefined;
  const prevSecret = process.env.VODOU_GATEWAY_SCHEDULER_SECRET;

  beforeEach(async () => {
    delete process.env.VODOU_GATEWAY_SCHEDULER_SECRET;
    closeGatewayDbOnly();
    if (gatewayDbPath && existsSync(gatewayDbPath)) {
      try {
        unlinkSync(gatewayDbPath);
      } catch {
        /* ignore */
      }
    }
    gatewayDbPath = path.join(tmpdir(), `gw-skill-fire-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    process.env.GATEWAY_DB_PATH = gatewayDbPath;

    const { chat } = await import('../src/llm.js');
    vi.mocked(chat).mockClear();

    const { createGatewayApp } = await import('../src/index.js');
    app = createGatewayApp();
  });

  afterEach(() => {
    if (prevSecret !== undefined) {
      process.env.VODOU_GATEWAY_SCHEDULER_SECRET = prevSecret;
    } else {
      delete process.env.VODOU_GATEWAY_SCHEDULER_SECRET;
    }
  });

  afterAll(() => {
    closeGatewayDbOnly();
    if (gatewayDbPath && existsSync(gatewayDbPath)) {
      try {
        unlinkSync(gatewayDbPath);
      } catch {
        /* ignore */
      }
    }
    if (prevSecret !== undefined) {
      process.env.VODOU_GATEWAY_SCHEDULER_SECRET = prevSecret;
    } else {
      delete process.env.VODOU_GATEWAY_SCHEDULER_SECRET;
    }
  });

  function seedSkill(opts: { name: string; convSuffix?: string; template?: string; isActive?: number }) {
    const db = getGatewayDb();
    const name = opts.name;
    const convId = `workbench:skill-console:${opts.convSuffix ?? name}`;
    const template = opts.template ?? `SF_PREFIX {{user_message}} SF_SUFFIX`;
    const isActive = opts.isActive ?? 1;
    db.prepare(
      `INSERT INTO skills_meta (name, display_name, prompt_template, principal_id, is_active) VALUES (?, ?, ?, ?, ?)`,
    ).run(name, `Display ${name}`, template, 'p-test', isActive);
    const row = db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number };
    db.prepare(`INSERT INTO skill_console_bindings (conversation_id, skill_id) VALUES (?, ?)`).run(convId, row.id);
    return { skillId: row.id as number, conversationId: convId };
  }

  it('returns 400 when skillId or conversationId is missing', async () => {
    const res = await request(app).post('/chat/skill-fire').send({ skillId: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('returns 403 when VODOU_GATEWAY_SCHEDULER_SECRET is set and header is wrong', async () => {
    process.env.VODOU_GATEWAY_SCHEDULER_SECRET = 'expected-secret';
    const { skillId, conversationId } = seedSkill({ name: 'sf-auth-skill' });

    const res = await request(app)
      .post('/chat/skill-fire')
      .set('X-Scheduler-Secret', 'wrong')
      .send({ skillId, conversationId });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/secret/i);
  });

  it('returns 403 when secret is set and header is absent', async () => {
    process.env.VODOU_GATEWAY_SCHEDULER_SECRET = 'expected-secret';
    const { skillId, conversationId } = seedSkill({ name: 'sf-no-header' });

    const res = await request(app).post('/chat/skill-fire').send({ skillId, conversationId });

    expect(res.status).toBe(403);
  });

  it('returns 200 with valid secret header and invokes chat() with rendered template', async () => {
    process.env.VODOU_GATEWAY_SCHEDULER_SECRET = 'expected-secret';
    const { skillId, conversationId } = seedSkill({
      name: 'sf-ok-skill',
      template: 'HELLO {{user_message}} TAIL',
    });

    const res = await request(app)
      .post('/chat/skill-fire')
      .set('X-Scheduler-Secret', 'expected-secret')
      .send({ skillId, conversationId });

    expect(res.status).toBe(200);
    expect(res.body.response).toContain('SKILL_FIRE_MOCK:');
    expect(res.body.response).toContain('HELLO ');
    expect(res.body.conversationId).toBe(conversationId);
    expect(res.body.skillId).toBe(skillId);

    const { chat } = await import('../src/llm.js');
    expect(vi.mocked(chat)).toHaveBeenCalled();
    const prompt = vi.mocked(chat).mock.calls[0][1] as string;
    expect(prompt).toContain('HELLO ');
    expect(prompt).toContain('TAIL');
  });

  it('allows request when scheduler secret env is unset (dev/smoke)', async () => {
    delete process.env.VODOU_GATEWAY_SCHEDULER_SECRET;
    const { skillId, conversationId } = seedSkill({ name: 'sf-open-skill' });

    const res = await request(app).post('/chat/skill-fire').send({ skillId, conversationId });

    expect(res.status).toBe(200);
    expect(res.body.response).toContain('SKILL_FIRE_MOCK:');
  });

  it('returns 404 when skillId does not match binding', async () => {
    const { conversationId } = seedSkill({ name: 'sf-mismatch-a' });
    const res = await request(app)
      .post('/chat/skill-fire')
      .send({ skillId: 999999, conversationId });

    expect(res.status).toBe(404);
    expect(String(res.body.error)).toMatch(/mismatch|no skill bound/i);
  });

  it('returns 409 when skill is disabled', async () => {
    const { skillId, conversationId } = seedSkill({ name: 'sf-disabled', isActive: 0 });

    const res = await request(app).post('/chat/skill-fire').send({ skillId, conversationId });

    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/disabled/i);
  });
});
