import path from 'path';
import os from 'os';
import { existsSync, unlinkSync } from 'fs';
import request from 'supertest';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { closeGatewayDbOnly, setSetting } from '../src/db.js';

// First-run EULA click-wrap (legal/LEGAL-REVIEW-NOTES.md): Step-0 connect
// endpoints must 400 without acceptance — the frontend checkbox is not the
// gate, gateway_settings.eula_accepted_at is. Only the rejection paths are
// exercised here: the success path of save-credentials writes the real .env.
describe('onboarding EULA gate', () => {
  let gwDb: string;

  beforeEach(() => {
    closeGatewayDbOnly();
    gwDb = path.join(os.tmpdir(), `gw-eula-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    process.env.GATEWAY_DB_PATH = gwDb;
  });

  afterEach(() => {
    closeGatewayDbOnly();
    delete process.env.GATEWAY_DB_PATH;
    for (const suffix of ['', '-wal', '-shm']) {
      const f = gwDb + suffix;
      if (existsSync(f)) { try { unlinkSync(f); } catch { /* */ } }
    }
  });

  it('status reports eulaAccepted=false on a fresh install, true once recorded', async () => {
    const { createGatewayApp } = await import('../src/index.js');
    const app = createGatewayApp();

    const fresh = await request(app).get('/api/onboarding/status');
    expect(fresh.status).toBe(200);
    expect(fresh.body.eulaAccepted).toBe(false);

    setSetting('eula_accepted_at', '2026-06-10T00:00:00.000Z');
    const after = await request(app).get('/api/onboarding/status');
    expect(after.body.eulaAccepted).toBe(true);
  });

  it('save-credentials 400s without acceptance and never reaches the env write', async () => {
    const { createGatewayApp } = await import('../src/index.js');
    const app = createGatewayApp();

    const res = await request(app)
      .post('/api/onboarding/save-credentials')
      .send({ token: 'tok_x', userId: 'user_x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/EULA/);
  });

  it('vodou-auth 400s without acceptance before contacting app.vodou.ai', async () => {
    const { createGatewayApp } = await import('../src/index.js');
    const app = createGatewayApp();

    const res = await request(app)
      .post('/api/onboarding/vodou-auth')
      .set('Content-Type', 'application/json')
      .send({ mode: 'signin', email: 'a@b.c', password: 'pw' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/EULA/);
  });

  it('endpoints pass the gate once acceptance is recorded (no eulaAccepted in payload needed)', async () => {
    const { createGatewayApp } = await import('../src/index.js');
    const app = createGatewayApp();
    setSetting('eula_accepted_at', '2026-06-10T00:00:00.000Z');

    // Missing-token validation now fires — proves the request got PAST the gate.
    const res = await request(app)
      .post('/api/onboarding/save-credentials')
      .send({ token: '', userId: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/token is required/);
  });
});
