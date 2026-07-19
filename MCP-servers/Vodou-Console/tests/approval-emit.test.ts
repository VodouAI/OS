import path from 'path';
import os from 'os';
import { mkdtempSync, rmSync, existsSync, unlinkSync } from 'fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { closeGatewayDbOnly, setSetting } from '../src/db.js';
import { executeOITool } from '../src/executor.js';
import type { StreamEvent } from '../src/llm.js';

// Bet #2 Phase 2b — when a gated tool is set to `ask`, executeOITool parks it and
// emits an `approval_requested` event (the frontend renders the approve/deny card
// from this). The event's args are SUMMARIZED so a large write payload doesn't bloat
// the card/wire. This guards both the emit and the summarization.
describe('approval_requested emit (Phase 2b)', () => {
  let gwDb: string;
  let fsRoot: string;

  beforeEach(() => {
    closeGatewayDbOnly();
    gwDb = path.join(os.tmpdir(), `gw-emit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    process.env.GATEWAY_DB_PATH = gwDb;
    fsRoot = mkdtempSync(path.join(os.tmpdir(), 'emit-fs-'));
    process.env.VODOU_FS_TOOLS_ROOT = fsRoot;
    process.env.VODOU_FS_TOOLS_ENABLED = '1';
    // Force file_write into `ask` via the global override the engine reads.
    setSetting('perm_file_write', 'ask');
  });

  afterEach(() => {
    closeGatewayDbOnly();
    delete process.env.VODOU_FS_TOOLS_ROOT;
    delete process.env.VODOU_FS_TOOLS_ENABLED;
    if (gwDb && existsSync(gwDb)) { try { unlinkSync(gwDb); } catch { /* */ } }
    try { rmSync(fsRoot, { recursive: true, force: true }); } catch { /* */ }
  });

  it('parks the write, emits approval_requested with a token + category, and does NOT write', async () => {
    const events: StreamEvent[] = [];
    const bigContent = 'X'.repeat(500);
    const r = await executeOITool(
      'write_file',
      { path: 'big.txt', content: bigContent },
      { conversationId: 'appr-emit-web', onEvent: (ev) => events.push(ev) },
    );

    // Not performed — caller is told to seek approval.
    expect(r.success).toBe(false);

    const ev = events.find((e) => e.type === 'approval_requested');
    expect(ev, 'an approval_requested event should be emitted').toBeTruthy();
    expect(ev!.toolName).toBe('write_file');
    expect(ev!.category).toBe('file_write');
    expect(typeof ev!.approvalToken).toBe('string');
    expect((ev!.approvalToken || '').length).toBeGreaterThan(8);

    // Args are summarized: the 500-char content is truncated, not sent whole.
    const content = (ev!.toolArgs as Record<string, unknown>)?.content as string;
    expect(content).toContain('…[500 chars]');
    expect(content.length).toBeLessThan(bigContent.length);
    // Short args (path) pass through untouched.
    expect((ev!.toolArgs as Record<string, unknown>)?.path).toBe('big.txt');

    // The file must NOT exist — the action was parked, not run.
    expect(existsSync(path.join(fsRoot, 'self', 'appr-emit-web', 'big.txt'))).toBe(false);
  });

  it('no onEvent channel → fails closed (no emit, not run)', async () => {
    const r = await executeOITool('write_file', { path: 'x.txt', content: 'hi' }, { conversationId: 'appr-emit-web2' });
    expect(r.success).toBe(false);
    expect(existsSync(path.join(fsRoot, 'self', 'appr-emit-web2', 'x.txt'))).toBe(false);
  });
});
