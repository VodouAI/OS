import path from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync } from 'fs';
import request from 'supertest';
import type { Express } from 'express';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { closeGatewayDbOnly } from '../src/db.js';

vi.mock('../src/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm.js')>();
  return {
    ...actual,
    isConfigured: () => true,
    rawLLMCallStrict: vi.fn(async () =>
      JSON.stringify({
        display_name: 'Competitor digest',
        name: 'competitor-digest',
        prompt_template:
          'Summarize competitor releases. User: {{user_message}}',
        schedule_cron: '0 9 * * *',
      }),
    ),
  };
});

describe('POST /api/skill-console/draft', () => {
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
    gatewayDbPath = path.join(tmpdir(), `gw-draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    process.env.GATEWAY_DB_PATH = gatewayDbPath;

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

  it('is registered (not 404) and returns JSON when LLM is configured', async () => {
    const r = await request(app)
      .post('/api/skill-console/draft')
      .set('Content-Type', 'application/json')
      .send({ idea: 'Daily summary of competitors Cowork Openclaw Hermes' });
    expect(r.status).not.toBe(404);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('name');
    expect(r.body).toHaveProperty('prompt_template');
    expect(String(r.body.prompt_template)).toMatch(/user_message/i);
  });
});
