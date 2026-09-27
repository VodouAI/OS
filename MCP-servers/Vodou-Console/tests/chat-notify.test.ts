/**
 * POST /chat/notify — the engine's 'notify' reminders land here at fire time.
 *
 * Pinned: the answer is HONEST about the phone (with the tunnel off here, it
 * must say delivered:false with a reason — never a delivered:true that
 * reached nobody, which is the failure the scheduler's run ledger exists to
 * catch); the reminder is still written into the /simple thread; no text is
 * a 400; and the scheduler secret is enforced when one is configured.
 */
import path from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync } from 'fs';
import request from 'supertest';
import type { Express } from 'express';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { closeGatewayDbOnly } from '../src/db.js';

let app: Express;
let gatewayDbPath: string | undefined;
const savedSecret = process.env.VODOU_GATEWAY_SCHEDULER_SECRET;

beforeAll(async () => {
  closeGatewayDbOnly();
  gatewayDbPath = path.join(tmpdir(), `chat-notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  process.env.GATEWAY_DB_PATH = gatewayDbPath;
  delete process.env.VODOU_GATEWAY_SCHEDULER_SECRET;
  const { createGatewayApp } = await import('../src/index.js');
  app = createGatewayApp();
});

afterEach(() => { delete process.env.VODOU_GATEWAY_SCHEDULER_SECRET; });

afterAll(() => {
  if (savedSecret !== undefined) process.env.VODOU_GATEWAY_SCHEDULER_SECRET = savedSecret;
  closeGatewayDbOnly();
  if (gatewayDbPath && existsSync(gatewayDbPath)) {
    try { unlinkSync(gatewayDbPath); } catch { /* ignore */ }
  }
});

describe('POST /chat/notify (scheduled reminders)', () => {
  it('tunnel off: honest not-delivered, with a reason, still shown in the thread', async () => {
    const res = await request(app).post('/chat/notify').send({ text: '⏰ Time to leave for the dentist.' });
    expect(res.status).toBe(200);
    expect(res.body.delivered).toBe(false);
    expect(res.body.reason).toMatch(/tunnel is off/);
    expect(res.body.shownInThread).toBe(true);
  });

  it('no text is refused', async () => {
    const res = await request(app).post('/chat/notify').send({ text: '   ' });
    expect(res.status).toBe(400);
  });

  it('the scheduler secret is enforced when configured', async () => {
    process.env.VODOU_GATEWAY_SCHEDULER_SECRET = 's'.repeat(40);
    const bad = await request(app).post('/chat/notify').send({ text: 'x' });
    expect(bad.status).toBe(403);
    const good = await request(app).post('/chat/notify').set('X-Scheduler-Secret', 's'.repeat(40)).send({ text: 'x' });
    expect(good.status).toBe(200);
  });
});
