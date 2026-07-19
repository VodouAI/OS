import path from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync, existsSync, readFileSync, unlinkSync } from 'fs';
import request from 'supertest';
import type { Express } from 'express';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { closeGatewayDbOnly } from '../src/db.js';
import { createApproval } from '../src/approvals.js';

// /chat/approve resumes a parked `ask` tool. We seed a pending directly (exactly what
// executeOITool's ask-branch does) and POST the token — the endpoint should run the
// tool (bypassing the ask-check; the FS enablement gate still applies) and write the file.
describe('POST /chat/approve (Bet #2 Phase 2)', () => {
  let app: Express;
  let gwDb: string;
  let fsRoot: string;

  beforeEach(async () => {
    closeGatewayDbOnly();
    gwDb = path.join(tmpdir(), `gw-appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    process.env.GATEWAY_DB_PATH = gwDb;
    fsRoot = mkdtempSync(path.join(tmpdir(), 'appr-fs-'));
    process.env.VODOU_FS_TOOLS_ROOT = fsRoot;
    process.env.VODOU_FS_TOOLS_ENABLED = '1';
    // Hermetic: this test asserts the SANDBOXED (per-conv) path `<root>/self/<conv>/…`,
    // so it must not inherit UNSANDBOXED/FLAT mode from the machine .env (same fix as
    // fs-executor-e2e / fs-sandbox — see the test mode-var inheritance gotcha).
    delete process.env.VODOU_FS_TOOLS_UNSANDBOXED;
    delete process.env.VODOU_FS_TOOLS_FLAT_ROOT;
    delete process.env.VODOU_FS_TOOLS_UNSANDBOXED_ALLOW_PROTECTED;
    const { createGatewayApp } = await import('../src/index.js');
    app = createGatewayApp();
  });

  afterAll(() => {
    closeGatewayDbOnly();
    delete process.env.VODOU_FS_TOOLS_ROOT;
    delete process.env.VODOU_FS_TOOLS_ENABLED;
    for (const p of [gwDb]) if (p && existsSync(p)) { try { unlinkSync(p); } catch { /* */ } }
    try { rmSync(fsRoot, { recursive: true, force: true }); } catch { /* */ }
  });

  it('400 without conversationId/token', async () => {
    const res = await request(app).post('/chat/approve').send({});
    expect(res.status).toBe(400);
  });

  it('404 for an unknown/expired token', async () => {
    const res = await request(app).post('/chat/approve').send({ conversationId: 'c1', token: 'nope' });
    expect(res.status).toBe(404);
  });

  it('approve → runs the parked write_file and the file lands confined', async () => {
    const conv = 'appr-web-1';
    const p = createApproval(conv, 'write_file', { path: 'note.txt', content: 'approved!' }, 'file_write');
    const res = await request(app).post('/chat/approve').send({ conversationId: conv, token: p.token, decision: 'approve' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, decision: 'approve', toolName: 'write_file', success: true });
    expect(readFileSync(path.join(fsRoot, 'self', conv, 'note.txt'), 'utf8')).toBe('approved!');
    // single-use: re-approving the same token now 404s
    const again = await request(app).post('/chat/approve').send({ conversationId: conv, token: p.token });
    expect(again.status).toBe(404);
  });

  it('deny → discards without running the tool', async () => {
    const conv = 'appr-web-2';
    const p = createApproval(conv, 'write_file', { path: 'denied.txt', content: 'x' }, 'file_write');
    const res = await request(app).post('/chat/approve').send({ conversationId: conv, token: p.token, decision: 'deny' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, decision: 'deny' });
    expect(existsSync(path.join(fsRoot, 'self', conv, 'denied.txt'))).toBe(false);
  });
});
