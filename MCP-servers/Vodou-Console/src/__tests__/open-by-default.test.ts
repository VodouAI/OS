/**
 * ALPHA-READINESS §9 bundle A — the two open-by-default gates (SEC-5, SEC-3).
 *
 * Both were deliberate choices, both shipped as "recommended, commented out",
 * and neither had a test that could fail. These are the tests that fail if the
 * defaults drift back:
 *
 *   SEC-5  a third-party-reachable channel with no allowlist and no enforce
 *          flag must NOT start — with the flag off and no list,
 *          channel-allowlist.ts classifies every sender as the owner.
 *   SEC-3  once an extension has paired, the bridge WS upgrade must reject any
 *          other extension origin, and must reject an empty Origin outright.
 *
 * Both are asserted in BOTH directions: the refusal AND the legitimate path it
 * must not break, because a gate that only ever says no is indistinguishable
 * from a broken feature (and gets bypassed for exactly that reason).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import request from 'supertest';
import WebSocket from 'ws';

const TMP = mkdtempSync(path.join(tmpdir(), 'vodou-open-default-test-'));
process.env.GATEWAY_DB_PATH = path.join(TMP, 'gateway.db');
process.env.VODOU_PROJECT_PATH = TMP;
mkdirSync(path.join(TMP, '.vodou', 'channels'), { recursive: true });
// db.ts only honours VODOU_PROJECT_PATH when <root>/vodou-core.db EXISTS
// (src/db.ts:25) — otherwise it silently derives the real repo root. Without
// this file the suite reads the operator's live .vodou/channels/*.json and
// grades against whatever they happen to have configured. An isolated harness
// has to prove its isolation, so the assertion below does.
writeFileSync(path.join(TMP, 'vodou-core.db'), '');

const CHANNELS_DIR = path.join(TMP, '.vodou', 'channels');
const writeAllowlist = (channel: string, cfg: unknown) =>
  writeFileSync(path.join(CHANNELS_DIR, `${channel}-allowlist.json`), JSON.stringify(cfg));

let app: express.Express;

beforeAll(async () => {
  const { channelsRouter, __test_projectRoot } = await import('../api/channels.js') as any;
  // Isolation assertion — see the note by the vodou-core.db touch above.
  if (typeof __test_projectRoot === 'function') {
    expect(__test_projectRoot()).toBe(TMP);
  }
  app = express();
  app.use(express.json());
  app.use('/api/channels', channelsRouter);
});

afterAll(() => { rmSync(TMP, { recursive: true, force: true }); });

beforeEach(() => { delete process.env.VODOU_CHANNEL_ALLOWLIST_ENFORCE; });

describe('SEC-5 — a channel does not go live open to everyone', () => {
  it('refuses telegram when no allowlist exists and enforcement is off', async () => {
    const res = await request(app).post('/api/channels/standalone/start').send({ channels: ['telegram'] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('allowlist_required');
    expect(res.body.channels).toContain('telegram');
  });

  it('refuses when the file exists but the list is empty', async () => {
    writeAllowlist('discord', { mode: 'on', senders: [] });
    const res = await request(app).post('/api/channels/standalone/start').send({ channels: ['discord'] });
    expect(res.status).toBe(409);
    expect(res.body.channels).toContain('discord');
  });

  it('refuses when senders exist but mode is off — an off list allows everyone', async () => {
    writeAllowlist('slack', { mode: 'off', senders: [{ id: 'U123' }] });
    const res = await request(app).post('/api/channels/standalone/start').send({ channels: ['slack'] });
    expect(res.status).toBe(409);
  });

  it('does NOT refuse whatsapp — it only acts on the owner\'s own messages', async () => {
    const res = await request(app).post('/api/channels/standalone/start').send({ channels: ['whatsapp'] });
    expect(res.status).not.toBe(409);
  });

  it('does NOT refuse when the enforce flag is on — that state is fail-closed, and is how you find your own id', async () => {
    process.env.VODOU_CHANNEL_ALLOWLIST_ENFORCE = '1';
    const res = await request(app).post('/api/channels/standalone/start').send({ channels: ['telegram'] });
    expect(res.status).not.toBe(409);
  });

  it('does NOT refuse a properly configured channel', async () => {
    writeAllowlist('teams', { mode: 'on', senders: [{ id: 'me@example.com', name: 'Owner' }] });
    const res = await request(app).post('/api/channels/standalone/start').send({ channels: ['teams'] });
    expect(res.status).not.toBe(409);
  });
});

describe('SEC-3 — the bridge WS belongs to the paired extension', () => {
  const PAIRED = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const OTHER  = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    const { setSetting } = await import('../db.js');
    const { mountBridgeWss } = await import('../vbb/ws.js');
    setSetting('bridge_ext_id', PAIRED);
    server = http.createServer((_q, s) => { s.statusCode = 200; s.end('ok'); });
    mountBridgeWss(server);
    await new Promise<void>(r => server.listen(0, () => r()));
    port = (server.address() as any).port;
  });

  afterAll(() => { server?.close(); });

  const dial = (origin?: string) => new Promise<'open' | 'refused'>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/vbb`,
      origin === undefined ? {} : { origin } as any);
    const done = (v: 'open' | 'refused') => { try { ws.close(); } catch { /* already gone */ } resolve(v); };
    ws.on('open', () => done('open'));
    ws.on('error', () => done('refused'));
    setTimeout(() => done('refused'), 4000);
  });

  it('admits the paired extension', async () => {
    expect(await dial(`chrome-extension://${PAIRED}`)).toBe('open');
  });

  it('refuses a DIFFERENT installed extension — the whole point of SEC-3', async () => {
    expect(await dial(`chrome-extension://${OTHER}`)).toBe('refused');
  });

  it('refuses an empty Origin — that is a script, not a browser extension', async () => {
    expect(await dial(undefined)).toBe('refused');
  });

  it('refuses a plain web origin', async () => {
    expect(await dial('https://evil.example')).toBe('refused');
  });
});
