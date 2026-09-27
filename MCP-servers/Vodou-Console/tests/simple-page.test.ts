/**
 * M2b (PLAN-MVP-CHAT-TO-LOCAL §13/§14) — HTTP boundary for the simple chat.
 *
 * /simple is the front door most people get; /connect?code= is how a fresh
 * install binds to the account with no password and no pasted key. What is
 * pinned here:
 *
 *  - both pages are actually served (a missing file would 404 the whole MVP
 *    flow at its first step),
 *  - GET /connect has NO side effects — the exchange happens only via
 *    POST /api/onboarding/connect-device, which keeps vodou-auth's CSRF
 *    defenses (JSON-only, localhost Origin), because a GET that swapped
 *    credentials could be fired cross-site from any web page,
 *  - a malformed code is refused before any network call to app.vodou.ai.
 */
import path from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync } from 'fs';
import request from 'supertest';
import type { Express } from 'express';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeGatewayDbOnly } from '../src/db.js';

let app: Express;
let gatewayDbPath: string | undefined;

beforeAll(async () => {
  closeGatewayDbOnly();
  gatewayDbPath = path.join(tmpdir(), `simple-http-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  process.env.GATEWAY_DB_PATH = gatewayDbPath;
  const { createGatewayApp } = await import('../src/index.js');
  app = createGatewayApp();
});

afterAll(() => {
  closeGatewayDbOnly();
  if (gatewayDbPath && existsSync(gatewayDbPath)) {
    try { unlinkSync(gatewayDbPath); } catch { /* ignore */ }
  }
});

describe('the simple chat pages (HTTP boundary)', () => {
  it('GET /simple serves the chat page, uncached', async () => {
    const res = await request(app).get('/simple');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.text).toContain('ws-bus.js');           // it speaks the gateway's own socket
    expect(res.text).toContain('href="/"');            // the Advanced link to the Console
    // M3b — ONE thread: the page shares the phone's conversation, so a text
    // sent from Messages appears here live and vice-versa. A per-browser
    // random id here would quietly re-split what M3b unified.
    expect(res.text).toContain("var convId = 'workbench:channel:relay'");
    expect(res.text).toContain('channel_user_message'); // phone-originated texts render as the person's own bubbles
    // Messages fidelity: tailed runs and the single "Delivered" receipt.
    expect(res.text).toContain('.bubble.tail');
    expect(res.text).toContain("receiptEl.textContent = fromPhone ? 'Read' : 'Delivered'");
    // Message text is only ever set as text nodes — never innerHTML — so a
    // reply (or a texted message) can't inject markup into the page.
    expect(res.text).not.toMatch(/b\.innerHTML|streamEl\.innerHTML/);
    // Tapbacks + threaded-reply connectors are drawn only for texts FROM
    // THE PHONE, recognised by the gateway's sender label.
    expect(res.text).toContain('function relayReaction');
    expect(res.text).toContain(".tapback");
    // Pictures and files: drawn from the attachment note, attachable here.
    expect(res.text).toContain('function splitAttachments');
    expect(res.text).toContain('id="attachItem"');
    expect(res.text).toContain("fetch('/api/files/upload'");
    expect(res.text).toContain('keep: true'); // attachments kept in Vodou's own media folder
    expect(res.text).toContain(".row.threaded .curve");
    // After a gateway restart the socket reconnects bound to the DEFAULT
    // conversation; the page must re-select the text thread or every live
    // event (phone texts, reminders) is dropped until a refresh.
    expect(res.text).toMatch(/case '_ws_status':[\s\S]{0,1200}switch_conversation/);
  });

  it('"Your phone" is ONE label across the tunnel client, the gateway save, and the page', async () => {
    // Three places spell it: the tunnel client sends it as senderName, the
    // gateway stores it as sender_label on relay turns, and /simple reads it
    // back to know which bubbles came from the phone. A rename in one place
    // silently drops every tapback and thread connector after a reload.
    const fsMod = await import('fs');
    const pathMod = await import('path');
    const root = pathMod.resolve(__dirname, '..');
    const client = fsMod.readFileSync(pathMod.join(root, 'src/tunnel/client.ts'), 'utf8');
    const gateway = fsMod.readFileSync(pathMod.join(root, 'src/index.ts'), 'utf8');
    const page = fsMod.readFileSync(pathMod.join(root, 'public/simple/index.html'), 'utf8');
    expect(client).toContain("senderName: 'Your phone'");
    expect(gateway).toContain("source === 'relay' ? 'Your phone'");
    expect(page).toContain("var PHONE_LABEL = 'Your phone'");
  });

  it('GET /connect serves the landing page and performs NO exchange itself', async () => {
    const res = await request(app).get('/connect?code=' + 'a'.repeat(48));
    expect(res.status).toBe(200);
    expect(res.text).toContain('/api/onboarding/connect-device'); // the page POSTs; the GET only renders
  });

  it('POST connect-device refuses a malformed code before touching the network', async () => {
    const res = await request(app)
      .post('/api/onboarding/connect-device')
      .set('Content-Type', 'application/json')
      .send({ code: 'not-a-code' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/malformed/i);
  });

  it('POST connect-device keeps the vodou-auth CSRF defenses', async () => {
    // An HTML form cannot send application/json → 415 blocks form CSRF.
    const asForm = await request(app)
      .post('/api/onboarding/connect-device')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('code=abc');
    expect(asForm.status).toBe(415);
    // A cross-site Origin is refused even with the right content type.
    const crossSite = await request(app)
      .post('/api/onboarding/connect-device')
      .set('Content-Type', 'application/json')
      .set('Origin', 'https://evil.example')
      .send({ code: 'a'.repeat(48) });
    expect(crossSite.status).toBe(403);
  });

  it('/connect/ping answers the install page across Private Network Access', async () => {
    // Chrome PNA: a public https page may only fetch localhost when the LOCAL
    // server approves the preflight. Both the preflight and the GET must carry
    // the PNA + CORS headers, scoped to the install page's origin — and the
    // body must be empty (204): the probe may learn "alive", nothing more.
    const pre = await request(app)
      .options('/connect/ping')
      .set('Origin', 'https://app.vodou.ai')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Private-Network', 'true');
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-private-network']).toBe('true');
    expect(pre.headers['access-control-allow-origin']).toBe('https://app.vodou.ai');

    const ping = await request(app).get('/connect/ping').set('Origin', 'https://app.vodou.ai');
    expect(ping.status).toBe(204);
    expect(ping.headers['access-control-allow-origin']).toBe('https://app.vodou.ai');
    expect(ping.text || '').toBe('');
  });

  it('GET /api/onboarding/status carries ownerEmail for the conversational setup', async () => {
    const res = await request(app).get('/api/onboarding/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ownerEmail');
  });
});
