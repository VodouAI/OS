import path from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync } from 'fs';
import request from 'supertest';
import type { Express } from 'express';
import { describe, it, expect, beforeEach, afterAll, afterEach } from 'vitest';
import { closeGatewayDbOnly } from '../src/db.js';

// DNS-rebinding guard (src/index.ts). The gateway binds to 127.0.0.1 and CORS
// locks cross-origin *reads* to localhost, but neither stops DNS rebinding —
// a site that re-resolves its domain to 127.0.0.1 is "same-origin" to the
// browser and bypasses CORS. The only tell is the Host header (browsers set it
// from the URL; JS can't forge it). The guard rejects any non-local Host.
describe('DNS-rebinding Host guard', () => {
  let app: Express;
  let gatewayDbPath: string | undefined;

  beforeEach(async () => {
    closeGatewayDbOnly();
    if (gatewayDbPath && existsSync(gatewayDbPath)) {
      try { unlinkSync(gatewayDbPath); } catch { /* ignore */ }
    }
    gatewayDbPath = path.join(tmpdir(), `gw-hostguard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    process.env.GATEWAY_DB_PATH = gatewayDbPath;
    const { createGatewayApp } = await import('../src/index.js');
    app = createGatewayApp();
  });

  afterEach(() => { delete process.env.VODOU_GATEWAY_ALLOWED_HOSTS; });
  afterAll(() => { closeGatewayDbOnly(); });

  // /api/health is unauthenticated and side-effect-free — a stable probe for
  // the guard without depending on LLM config.
  const PROBE = '/api/health';

  it('allows a localhost Host (with port)', async () => {
    const r = await request(app).get(PROBE).set('Host', 'localhost:8765');
    expect(r.status).toBe(200);
  });

  it('allows 127.0.0.1 and [::1]', async () => {
    expect((await request(app).get(PROBE).set('Host', '127.0.0.1:8765')).status).toBe(200);
    expect((await request(app).get(PROBE).set('Host', '[::1]:8765')).status).toBe(200);
  });

  it('rejects a rebinding Host (attacker domain → 127.0.0.1)', async () => {
    const r = await request(app).get(PROBE).set('Host', 'evil.com:8765');
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/invalid Host header/i);
  });

  it('rejects a bare attacker domain and a lookalike subdomain', async () => {
    expect((await request(app).get(PROBE).set('Host', 'evil.com')).status).toBe(403);
    // not a suffix/substring match — localhost.evil.com must NOT pass
    expect((await request(app).get(PROBE).set('Host', 'localhost.evil.com')).status).toBe(403);
  });

  it('rejects the rebinding Host on a mutating route too (not just GETs)', async () => {
    const r = await request(app).post('/chat').set('Host', 'evil.com').send({ message: 'x' });
    expect(r.status).toBe(403);
  });

  it('honors VODOU_GATEWAY_ALLOWED_HOSTS for a trusted reverse proxy', async () => {
    process.env.VODOU_GATEWAY_ALLOWED_HOSTS = 'gw.internal.example';
    const { createGatewayApp } = await import('../src/index.js');
    const app2 = createGatewayApp();
    expect((await request(app2).get(PROBE).set('Host', 'gw.internal.example')).status).toBe(200);
    // still rejects anything not on the (default + env) list
    expect((await request(app2).get(PROBE).set('Host', 'evil.com')).status).toBe(403);
  });
});
