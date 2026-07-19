import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { executeOITool } from '../src/executor.js';

// End-to-end through the REAL tool sink (executeOITool): flag gate → web-chat gate →
// fs-sandbox confinement → write. This is the "is it actually wired + enabled" check
// that the unit suites approximate piece-by-piece.

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'fs-e2e-'));
  process.env.VODOU_FS_TOOLS_ROOT = root;
  process.env.VODOU_FS_TOOLS_ENABLED = '1';
  // Hermetic: these assert SANDBOXED (per-conv) paths — don't inherit a machine .env
  // that has unsandboxed/flat mode enabled.
  delete process.env.VODOU_FS_TOOLS_UNSANDBOXED;
  delete process.env.VODOU_FS_TOOLS_FLAT_ROOT;
  delete process.env.VODOU_FS_TOOLS_UNSANDBOXED_ALLOW_PROTECTED;
});

afterEach(() => {
  delete process.env.VODOU_FS_TOOLS_ROOT;
  delete process.env.VODOU_FS_TOOLS_ENABLED;
  rmSync(root, { recursive: true, force: true });
});

describe('executeOITool — FS tools end-to-end (flag on)', () => {
  it('write_file → file lands under the per-conversation workspace', async () => {
    const r = await executeOITool('write_file', { path: 'website/index.html', content: '<h1>hi</h1>' }, { conversationId: 'e2e-web' });
    expect(r.success).toBe(true);
    // file exists on disk under <root>/self/e2e-web/website/index.html
    const onDisk = path.join(root, 'self', 'e2e-web', 'website', 'index.html');
    expect(existsSync(onDisk)).toBe(true);
    expect(readFileSync(onDisk, 'utf8')).toBe('<h1>hi</h1>');
  });

  it('edit_file then read_file round-trips through the sink', async () => {
    await executeOITool('write_file', { path: 'f.txt', content: 'hello world' }, { conversationId: 'e2e-web' });
    const e = await executeOITool('edit_file', { path: 'f.txt', old_string: 'world', new_string: 'there' }, { conversationId: 'e2e-web' });
    expect(e.success).toBe(true);
    const rd = await executeOITool('read_file', { path: 'f.txt' }, { conversationId: 'e2e-web' });
    expect(rd.success).toBe(true);
    expect(rd.output).toContain('hello there');
  });

  it('multi_edit applies atomically through the sink', async () => {
    await executeOITool('write_file', { path: 'm.txt', content: 'a\nb\nc\n' }, { conversationId: 'e2e-web' });
    const r = await executeOITool('multi_edit', { path: 'm.txt', edits: [
      { old_string: 'a', new_string: 'A' },
      { old_string: 'c', new_string: 'C' },
    ] }, { conversationId: 'e2e-web' });
    expect(r.success).toBe(true);
    expect(readFileSync(path.join(root, 'self', 'e2e-web', 'm.txt'), 'utf8')).toBe('A\nb\nC\n');
  });

  it('read_file windows a file (offset/limit, line-numbered) through the sink (#1.6)', async () => {
    const body = Array.from({ length: 8 }, (_, i) => `row${i + 1}`).join('\n');
    await executeOITool('write_file', { path: 'big.txt', content: body }, { conversationId: 'e2e-web' });
    const r = await executeOITool('read_file', { path: 'big.txt', offset: 2, limit: 3 }, { conversationId: 'e2e-web' });
    expect(r.success).toBe(true);
    const out = JSON.parse(r.output);
    expect(out.startLine).toBe(2);
    expect(out.endLine).toBe(4);
    expect(out.content).toContain('     2\trow2');
    expect(out.truncated).toBe(true); // rows 5-8 remain
  });

  it('search_files returns matching files (summarized) through the sink (#1.6)', async () => {
    await executeOITool('write_file', { path: 'x/one.txt', content: 'find NEEDLE here' }, { conversationId: 'e2e-web' });
    await executeOITool('write_file', { path: 'x/two.txt', content: 'nothing relevant' }, { conversationId: 'e2e-web' });
    const r = await executeOITool('search_files', { query: 'NEEDLE' }, { conversationId: 'e2e-web' });
    expect(r.success).toBe(true);
    const out = JSON.parse(r.output);
    expect(out.fileCount).toBeGreaterThanOrEqual(1);
    expect(out.matches.some((m: { file: string }) => m.file.endsWith('one.txt'))).toBe(true);
  });

  it('GATE: a workbench (skill-fire) conversation cannot use FS tools even with the flag on', async () => {
    const r = await executeOITool('write_file', { path: 'x.txt', content: 'nope' }, { conversationId: 'workbench:skill:demo' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not available/i);
    expect(existsSync(path.join(root, 'self', 'workbench:skill:demo', 'x.txt'))).toBe(false);
  });

  it('GATE: confinement still holds — an escaping path is refused', async () => {
    const r = await executeOITool('write_file', { path: '../escape.txt', content: 'x' }, { conversationId: 'e2e-web' });
    expect(r.success).toBe(false);
  });

  it('FLAG OFF: FS tools are not executable even if somehow called', async () => {
    delete process.env.VODOU_FS_TOOLS_ENABLED;
    const r = await executeOITool('write_file', { path: 'y.txt', content: 'x' }, { conversationId: 'e2e-web' });
    expect(r.success).toBe(false);
  });
});
