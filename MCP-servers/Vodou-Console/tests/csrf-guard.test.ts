import path from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync } from 'fs';
import request from 'supertest';
import type { Express } from 'express';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { closeGatewayDbOnly } from '../src/db.js';

// CSRF / cross-site write guard (src/index.ts; PLAN-GATEWAY-CSRF-HARDENING.md).
// CORS blocks cross-origin reads and the Host guard blocks rebinding reads, but
// a visited page can still FIRE a no-cors POST that runs a chat turn / tools.
// The guard rejects mutating requests that look cross-site (non-localhost Origin,
// or Sec-Fetch-Site: cross-site/same-site) while allowing the gateway's own
// same-origin UI and Origin-less local callers (curl, channel relays, /v1 SDKs).
describe('CSRF / cross-site write guard', () => {
  let app: Express;
  let gatewayDbPath: string | undefined;

  beforeEach(async () => {
    closeGatewayDbOnly();
    if (gatewayDbPath && existsSync(gatewayDbPath)) {
      try { unlinkSync(gatewayDbPath); } catch { /* ignore */ }
    }
    gatewayDbPath = path.join(tmpdir(), `gw-csrf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    process.env.GATEWAY_DB_PATH = gatewayDbPath;
    const { createGatewayApp } = await import('../src/index.js');
    app = createGatewayApp();
  });

  afterAll(() => { closeGatewayDbOnly(); });

  // A mutating route that exists regardless of LLM config. /clear returns 200
  // and is side-effect-light; the guard runs before the handler either way.
  const MUTATING = '/clear';

  it('rejects a cross-site Origin on a POST', async () => {
    const r = await request(app).post(MUTATING).set('Host', 'localhost:8765').set('Origin', 'https://evil.com').send({});
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/cross-site/i);
  });

  it('rejects Sec-Fetch-Site: cross-site even with no Origin', async () => {
    const r = await request(app).post(MUTATING).set('Host', 'localhost:8765').set('Sec-Fetch-Site', 'cross-site').send({});
    expect(r.status).toBe(403);
  });

  it('allows the gateway’s own same-origin UI (localhost Origin)', async () => {
    const r = await request(app).post(MUTATING).set('Host', 'localhost:8765').set('Origin', 'http://localhost:8765').send({});
    expect(r.status).not.toBe(403);
  });

  it('allows an Origin-less local caller (curl / channel relay / SDK)', async () => {
    const r = await request(app).post(MUTATING).set('Host', 'localhost:8765').send({});
    expect(r.status).not.toBe(403);
  });

  it('allows Sec-Fetch-Site: same-origin (UI fetch)', async () => {
    const r = await request(app).post(MUTATING).set('Host', 'localhost:8765')
      .set('Origin', 'http://localhost:8765').set('Sec-Fetch-Site', 'same-origin').send({});
    expect(r.status).not.toBe(403);
  });

  it('does NOT guard safe methods (GET passes the CSRF layer)', async () => {
    const r = await request(app).get('/api/health').set('Host', 'localhost:8765').set('Origin', 'https://evil.com');
    // CSRF guard only fires on mutating methods; GET is not 403 from it.
    expect(r.status).not.toBe(403);
  });

  it('protects the otherwise-open /v1 OpenAI-compat API from a cross-site POST', async () => {
    const r = await request(app).post('/v1/chat/completions').set('Host', 'localhost:8765')
      .set('Origin', 'https://evil.com').send({ model: 'x', messages: [] });
    expect(r.status).toBe(403);
  });
});
