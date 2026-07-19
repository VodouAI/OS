import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { sandboxWrite, sandboxReadLines, sandboxSearch } from '../src/fs-sandbox.js';

// #1.6 (SWE-agent ACI) — windowed line-numbered read + summarized search.
const CTX = { conversationId: 'aci-test-1' };
let tmpBase: string;

beforeEach(() => {
  tmpBase = mkdtempSync(path.join(os.tmpdir(), 'aci-'));
  process.env.VODOU_FS_TOOLS_ROOT = tmpBase;
  delete process.env.VODOU_FS_TOOLS_MAX_BYTES;
});
afterEach(() => {
  delete process.env.VODOU_FS_TOOLS_ROOT;
  try { rmSync(tmpBase, { recursive: true, force: true }); } catch { /* */ }
});

describe('sandboxReadLines — windowed read', () => {
  it('returns the whole small file, line-numbered, with honest metadata', () => {
    sandboxWrite(CTX, 'a.txt', 'one\ntwo\nthree\n', 'create');
    const r = sandboxReadLines(CTX, 'a.txt');
    expect(r.totalLines).toBe(3);
    expect(r.startLine).toBe(1);
    expect(r.endLine).toBe(3);
    expect(r.truncated).toBe(false);
    expect(r.content).toBe('     1\tone\n     2\ttwo\n     3\tthree');
  });

  it('windows with offset/limit and signals more-below via truncated', () => {
    const body = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
    sandboxWrite(CTX, 'b.txt', body, 'create');
    const r = sandboxReadLines(CTX, 'b.txt', { offset: 3, limit: 2 });
    expect(r.startLine).toBe(3);
    expect(r.endLine).toBe(4);
    expect(r.content).toBe('     3\tline3\n     4\tline4');
    expect(r.totalLines).toBe(10);
    expect(r.truncated).toBe(true); // lines 5-10 remain
  });

  it('offset past EOF returns an empty window, not an error', () => {
    sandboxWrite(CTX, 'c.txt', 'x\ny', 'create');
    const r = sandboxReadLines(CTX, 'c.txt', { offset: 99 });
    expect(r.content).toBe('');
    expect(r.totalLines).toBe(2);
  });

  it('the line-number gutter matches the applier-stripped shape (round-trips with edit)', () => {
    sandboxWrite(CTX, 'd.txt', 'alpha\nbeta', 'create');
    const first = sandboxReadLines(CTX, 'd.txt').content.split('\n')[0];
    // edit-applier stripLineNumberPrefixes: /^\s*\d+\s*(?:[:|\t]|│)\s?/
    expect(first).toMatch(/^\s*\d+\t/);
  });
});

describe('sandboxSearch — summarized search', () => {
  beforeEach(() => {
    sandboxWrite(CTX, 'src/foo.ts', 'const TARGET = 1;\nother line', 'create');
    sandboxWrite(CTX, 'src/bar.ts', 'no match here', 'create');
    sandboxWrite(CTX, 'nested/baz.ts', 'has TARGET again', 'create');
  });

  it('returns files-with-a-match (first line + line no), not full content', () => {
    const r = sandboxSearch(CTX, 'TARGET');
    expect(r.fileCount).toBe(2);
    expect(r.matches.map((m) => m.file).sort()).toEqual(['nested/baz.ts', 'src/foo.ts']);
    const foo = r.matches.find((m) => m.file === 'src/foo.ts')!;
    expect(foo.line).toBe(1);
    expect(foo.text).toBe('const TARGET = 1;');
    expect(r.truncated).toBe(false);
  });

  it('is case-insensitive substring by default', () => {
    expect(sandboxSearch(CTX, 'target').fileCount).toBe(2);
  });

  it('supports regex mode', () => {
    const r = sandboxSearch(CTX, 'TARGET\\s*=', { regex: true });
    expect(r.matches.map((m) => m.file)).toEqual(['src/foo.ts']);
  });

  it('scopes to a subpath', () => {
    const r = sandboxSearch(CTX, 'TARGET', { path: 'nested' });
    expect(r.matches.map((m) => m.file)).toEqual(['nested/baz.ts']);
  });

  it('skips binary files (NUL byte)', () => {
    sandboxWrite(CTX, 'bin.dat', 'TARGET' + String.fromCharCode(0) + 'binary', 'create');
    const r = sandboxSearch(CTX, 'TARGET');
    expect(r.matches.find((m) => m.file === 'bin.dat')).toBeUndefined();
  });

  it('rejects an empty query', () => {
    expect(() => sandboxSearch(CTX, '')).toThrow();
  });
});
