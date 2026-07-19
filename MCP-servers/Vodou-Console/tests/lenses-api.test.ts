/**
 * HTTP integration tests for the Cards API.
 * Uses supertest against createGatewayApp() — same pattern as chat-post-http.test.ts.
 */
import path from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync } from 'fs';
import request from 'supertest';
import type { Express } from 'express';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { closeGatewayDbOnly } from '../src/db.js';
import { ensureRegistryLoaded } from '../src/lenses/registry.js';

let app: Express;
let gatewayDbPath: string | undefined;

async function freshApp() {
  closeGatewayDbOnly();
  if (gatewayDbPath && existsSync(gatewayDbPath)) {
    try { unlinkSync(gatewayDbPath); } catch { /* ignore */ }
  }
  gatewayDbPath = path.join(tmpdir(), `cards-http-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  process.env.GATEWAY_DB_PATH = gatewayDbPath;
  const { createGatewayApp } = await import('../src/index.js');
  return createGatewayApp();
}

describe('/api/lenses/* (HTTP boundary)', () => {
  beforeAll(async () => {
    // Filesystem scan once for the whole suite
    await ensureRegistryLoaded();
  });
  beforeEach(async () => {
    app = await freshApp();
  });

  afterAll(() => {
    closeGatewayDbOnly();
    if (gatewayDbPath && existsSync(gatewayDbPath)) {
      try { unlinkSync(gatewayDbPath); } catch { /* ignore */ }
    }
  });

  it('GET /api/lenses/status returns registered count + bridge state', async () => {
    const res = await request(app).get('/api/lenses/status');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // 10 cards now (5 MVP + 4 new + snippet.url fallback)
    expect(res.body.data.registered).toBeGreaterThanOrEqual(10);
    expect(res.body.data.bridge).toBeDefined();
    expect(res.body.data.bridge.connected).toBe(false);
  });

  it('POST /api/lenses/reload re-scans and returns count', async () => {
    const res = await request(app).post('/api/lenses/reload');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.loaded).toBeGreaterThanOrEqual(10);
  });

  it('GET /api/lenses/manifests excludes debug cards', async () => {
    const res = await request(app).get('/api/lenses/manifests');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const types = res.body.data.map((m: any) => m.type);
    expect(types).not.toContain('debug.echo');
    expect(types).toContain('recipe.allrecipes');
    expect(types).toContain('github.pr');
  });

  it('POST /api/lenses/fetch with unknown type returns UNKNOWN_TYPE', async () => {
    const res = await request(app)
      .post('/api/lenses/fetch')
      .send({ type: 'does.not.exist' });
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('UNKNOWN_TYPE');
  });

  it('POST /api/lenses/fetch missing type returns VALIDATION_FAILED', async () => {
    const res = await request(app).post('/api/lenses/fetch').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('POST /api/lenses/fetch debug.echo returns the payload', async () => {
    const res = await request(app)
      .post('/api/lenses/fetch')
      .send({ type: 'debug.echo', payload: { ping: 'pong' } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.render_model.payload.ping).toBe('pong');
    expect(res.body.data.render_model.kind).toBe('echo');
  });

  it('POST /api/lenses/fetch validates source_url for recipe.allrecipes', async () => {
    const res = await request(app)
      .post('/api/lenses/fetch')
      .send({ type: 'recipe.allrecipes', source_url: 'https://other-site.com/recipe/x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('POST /api/lenses/fetch map.directions synthesizes embed URL', async () => {
    const res = await request(app)
      .post('/api/lenses/fetch')
      .send({
        type: 'map.directions',
        payload: { origin: 'Detroit, MI', destination: 'Grand Rapids, MI', mode: 'driving' },
      });
    expect(res.status).toBe(200);
    expect(res.body.data.render_model.embed_url).toContain('maps.google.com');
    expect(res.body.data.render_model.embed_url).toContain('Detroit');
    expect(res.body.data.render_model.mode).toBe('driving');
  });

  it('POST /api/lenses/action returns BRIDGE_REQUIRED when bridge missing', async () => {
    // In tests the bridge is never connected. Bridge-requiring actions
    // surface that explicitly so the UI can show "Install Vodou Bridge".
    const res = await request(app)
      .post('/api/lenses/action')
      .send({
        type: 'github.pr',
        action_id: 'approve',
        source_url: 'https://github.com/foo/bar/pull/1',
        consent_granted: true, // even with consent, no bridge = no action
      });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('BRIDGE_REQUIRED');
    expect(res.body.error.detail.card_type).toBe('github.pr');
    expect(res.body.error.detail.action_id).toBe('approve');
  });

  it('POST /api/lenses/action with unknown card returns UNKNOWN_TYPE', async () => {
    const res = await request(app)
      .post('/api/lenses/action')
      .send({
        type: 'does.not.exist',
        action_id: 'foo',
        source_url: 'https://x.com',
      });
    expect(res.status).toBe(404);
  });

  it('GET /api/lenses/preview returns matching cards for a URL', async () => {
    const res = await request(app)
      .get('/api/lenses/preview')
      .query({ url: 'https://www.allrecipes.com/recipe/12345/grandma-pie' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const types = res.body.data.map((m: any) => m.type);
    expect(types).toContain('recipe.allrecipes');
  });
});
