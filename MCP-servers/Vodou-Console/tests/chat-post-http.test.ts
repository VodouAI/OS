import path from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync } from 'fs';
import request from 'supertest';
import type { Express } from 'express';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { closeGatewayDbOnly, getGatewayDb } from '../src/db.js';

vi.mock('../src/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm.js')>();
  return {
    ...actual,
    isConfigured: () => true,
    chat: vi.fn(async (_id: string, prompt: string, cb: (e: { type: string; content?: string; usage?: object }) => void) => {
      cb({ type: 'text', content: `MOCK:${String(prompt).substring(0, 200)}` });
      cb({ type: 'done', usage: {} });
    }),
  };
});

describe('POST /chat (HTTP boundary)', () => {
  let app: Express;
  let gatewayDbPath: string | undefined;

  beforeEach(async () => {
    closeGatewayDbOnly();
    if (gatewayDbPath && existsSync(gatewayDbPath)) {
      try {
        unlinkSync(gatewayDbPath);
      } catch {
        /* ignore */
      }
    }
    gatewayDbPath = path.join(tmpdir(), `gw-http-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    process.env.GATEWAY_DB_PATH = gatewayDbPath;

    const { chat } = await import('../src/llm.js');
    vi.mocked(chat).mockClear();

    const { createGatewayApp } = await import('../src/index.js');
    app = createGatewayApp();
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
  });

  it('returns 400 when message is empty', async () => {
    const res = await request(app).post('/chat').send({ message: '   ' });
    expect(res.status).toBe(400);
  });

  it('invokes chat() for a generic conversation', async () => {
    const res = await request(app).post('/chat').send({ message: 'hello' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ response: expect.stringContaining('MOCK:hello') });
    const { chat } = await import('../src/llm.js');
    expect(vi.mocked(chat)).toHaveBeenCalled();
    const firstCall = vi.mocked(chat).mock.calls[0];
    expect(firstCall[1]).toBe('hello');
  });

  it('skill-bound tab: renders prompt_template then calls chat()', async () => {
    const db = getGatewayDb();
    db.prepare(
      `INSERT INTO skills_meta (name, display_name, prompt_template, principal_id) VALUES (?, ?, ?, ?)`,
    ).run('http-skill', 'HTTP Skill', 'PREFIX {{user_message}} SUFFIX', 'p1');
    const row = db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number };
    db.prepare(`INSERT INTO skill_console_bindings (conversation_id, skill_id) VALUES (?, ?)`).run(
      'workbench:skill-console:http-skill',
      row.id,
    );

    const res = await request(app)
      .post('/chat')
      .send({ conversationId: 'workbench:skill-console:http-skill', message: 'hello' });

    expect(res.status).toBe(200);
    expect(res.body.response).toContain('PREFIX hello SUFFIX');

    const { chat } = await import('../src/llm.js');
    expect(vi.mocked(chat)).toHaveBeenCalledWith(
      'workbench:skill-console:http-skill',
      'PREFIX hello SUFFIX',
      expect.any(Function),
      expect.any(Object),
    );
  });
});
