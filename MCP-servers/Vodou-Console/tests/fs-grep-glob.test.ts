import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  ensureRoot,
  sandboxWrite,
  sandboxRead,
  sandboxGrep,
  sandboxGlob,
  sandboxStat,
  sandboxTree,
  SandboxError,
} from '../src/fs-sandbox.js';

const CTX = { conversationId: 'conv-test-grep' };

let tmpBase: string;
let outsideDir: string;

beforeEach(() => {
  tmpBase = mkdtempSync(path.join(os.tmpdir(), 'fsgg-root-'));
  outsideDir = mkdtempSync(path.join(os.tmpdir(), 'fsgg-out-'));
  process.env.VODOU_FS_TOOLS_ROOT = tmpBase;
  delete process.env.VODOU_FS_TOOLS_FLAT_ROOT;
  delete process.env.VODOU_FS_TOOLS_UNSANDBOXED;
  delete process.env.VODOU_FS_TOOLS_UNSANDBOXED_ALLOW_PROTECTED;
  writeFileSync(path.join(outsideDir, 'secret.txt'), 'TOP SECRET');
  writeFileSync(path.join(outsideDir, 'id.key'), 'PRIVATE KEY');
});

afterEach(() => {
  delete process.env.VODOU_FS_TOOLS_ROOT;
  delete process.env.VODOU_FS_TOOLS_FLAT_ROOT;
  delete process.env.VODOU_FS_TOOLS_UNSANDBOXED;
  delete process.env.VODOU_FS_TOOLS_UNSANDBOXED_ALLOW_PROTECTED;
  rmSync(tmpBase, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

function expectCode(fn: () => unknown, code: string) {
  try { fn(); } catch (e) {
    expect(e).toBeInstanceOf(SandboxError);
    expect((e as SandboxError).code).toBe(code);
    return;
  }
  throw new Error(`expected SandboxError(${code}) but no error thrown`);
}

// Build a small workspace tree for the read tools.
function seed() {
  sandboxWrite(CTX, 'src/app.ts', 'import x\nconst foo = 1\nfoo()\n// foo again\n');
  sandboxWrite(CTX, 'src/util.ts', 'export const bar = 2\n');
  sandboxWrite(CTX, 'src/nested/deep.ts', 'const foo = 3\n');
  sandboxWrite(CTX, 'README.md', '# title\nfoo in docs\n');
  sandboxWrite(CTX, 'data.json', '{"foo": true}\n');
}

describe('grep', () => {
  it('returns EVERY matching line (not first-per-file)', () => {
    seed();
    const r = sandboxGrep(CTX, 'foo');
    // app.ts has 3 'foo' lines, nested/deep.ts 1, README 1, data.json 1 = 6
    expect(r.matchCount).toBe(6);
    const appHits = r.matches.filter((m) => m.file === 'src/app.ts');
    expect(appHits.length).toBe(3);
    expect(appHits[0].line).toBe(2);
  });

  it('context lines included before/after', () => {
    seed();
    const r = sandboxGrep(CTX, 'foo()', { context: 1 });
    const hit = r.matches.find((m) => m.file === 'src/app.ts');
    expect(hit?.before).toEqual(['const foo = 1']);
    expect(hit?.after).toEqual(['// foo again']);
  });

  it('glob filter restricts which files are searched', () => {
    seed();
    const r = sandboxGrep(CTX, 'foo', { glob: '**/*.ts' });
    expect(r.matches.every((m) => m.file.endsWith('.ts'))).toBe(true);
    expect(r.matches.some((m) => m.file === 'README.md')).toBe(false);
  });

  it('regex mode', () => {
    seed();
    const r = sandboxGrep(CTX, 'co(n)st', { regex: true });
    expect(r.matchCount).toBeGreaterThan(0);
    expect(r.matches.every((m) => /const/.test(m.text))).toBe(true);
  });

  it('maxPerFile caps hits per file', () => {
    seed();
    const r = sandboxGrep(CTX, 'foo', { maxPerFile: 1 });
    expect(r.matches.filter((m) => m.file === 'src/app.ts').length).toBe(1);
  });

  it('refuses an absolute path (sandboxed)', () => {
    expectCode(() => sandboxGrep(CTX, 'x', { path: '/etc' }), 'path_escape');
  });
});

describe('glob', () => {
  it('** crosses directories; *.ts at root does not', () => {
    seed();
    const all = sandboxGlob(CTX, '**/*.ts');
    const paths = all.files.map((f) => f.path).sort();
    expect(paths).toEqual(['src/app.ts', 'src/nested/deep.ts', 'src/util.ts']);

    const rootOnly = sandboxGlob(CTX, '*.ts');
    expect(rootOnly.files.length).toBe(0); // no .ts directly at workspace root
  });

  it('brace alternation', () => {
    seed();
    const r = sandboxGlob(CTX, '**/*.{md,json}');
    const paths = r.files.map((f) => f.path).sort();
    expect(paths).toEqual(['README.md', 'data.json']);
  });

  it('pattern is relative to the given path', () => {
    seed();
    const r = sandboxGlob(CTX, '*.ts', { path: 'src' });
    expect(r.files.map((f) => f.path).sort()).toEqual(['src/app.ts', 'src/util.ts']);
  });

  it('reports size + mtime, no file bodies', () => {
    seed();
    const r = sandboxGlob(CTX, '**/app.ts');
    expect(r.files[0].size).toBeGreaterThan(0);
    expect(typeof r.files[0].mtimeMs).toBe('number');
  });
});

describe('file_stat', () => {
  it('file: type/size/lineCount', () => {
    sandboxWrite(CTX, 'a.txt', 'l1\nl2\nl3\n');
    const s = sandboxStat(CTX, 'a.txt');
    expect(s).toMatchObject({ exists: true, type: 'file', lineCount: 3 });
    expect(s.size).toBe('l1\nl2\nl3\n'.length);
  });

  it('directory: type dir, no lineCount', () => {
    sandboxWrite(CTX, 'd/x.txt', 'hi');
    const s = sandboxStat(CTX, 'd');
    expect(s.type).toBe('dir');
    expect(s.lineCount).toBeUndefined();
  });

  it('missing path: exists=false (no throw)', () => {
    const s = sandboxStat(CTX, 'nope.txt');
    expect(s).toEqual({ path: 'nope.txt', exists: false });
  });

  it('binary file: no lineCount', () => {
    const root = ensureRoot(CTX);
    writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]));
    const s = sandboxStat(CTX, 'bin.dat');
    expect(s.type).toBe('file');
    expect(s.lineCount).toBeUndefined();
  });

  it('refuses absolute escape', () => {
    expectCode(() => sandboxStat(CTX, '/etc/hosts'), 'path_escape');
  });
});

describe('directory_tree', () => {
  it('depth bound limits descent', () => {
    seed();
    const shallow = sandboxTree(CTX, { depth: 1 });
    // depth 1 = entries directly under root only (no src/nested/deep.ts)
    expect(shallow.entries.some((e) => e.path === 'src/nested/deep.ts')).toBe(false);
    expect(shallow.entries.some((e) => e.path === 'src')).toBe(true);

    const deep = sandboxTree(CTX, { depth: 5 });
    expect(deep.entries.some((e) => e.path === 'src/nested/deep.ts')).toBe(true);
  });

  it('maxEntries truncates', () => {
    seed();
    const r = sandboxTree(CTX, { depth: 10, maxEntries: 2 });
    expect(r.truncated).toBe(true);
    expect(r.entries.length).toBeLessThanOrEqual(2);
  });

  it('entries carry type + depth, sorted', () => {
    seed();
    const r = sandboxTree(CTX, { depth: 10 });
    const sorted = [...r.entries].sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(r.entries).toEqual(sorted);
    expect(r.entries.find((e) => e.path === 'src')?.type).toBe('dir');
    expect(r.entries.find((e) => e.path === 'src/app.ts')?.type).toBe('file');
  });
});

describe('flat-root mode', () => {
  it('VODOU_FS_TOOLS_FLAT_ROOT=1 → root IS the base (no per-conv nesting)', () => {
    process.env.VODOU_FS_TOOLS_FLAT_ROOT = '1';
    const root = ensureRoot(CTX);
    expect(root).toBe(require('fs').realpathSync(tmpBase));
    sandboxWrite(CTX, 'x.txt', 'flat');
    expect(existsSync(path.join(tmpBase, 'x.txt'))).toBe(true);
  });

  it('flat mode needs no conversation id', () => {
    process.env.VODOU_FS_TOOLS_FLAT_ROOT = '1';
    expect(() => ensureRoot({})).not.toThrow();
  });

  it('flat mode is STILL confined (escape refused)', () => {
    process.env.VODOU_FS_TOOLS_FLAT_ROOT = '1';
    expectCode(() => sandboxRead(CTX, '/etc/hosts'), 'path_escape');
    expectCode(() => sandboxRead(CTX, '../../etc/hosts'), 'path_escape');
  });
});

describe('unsandboxed-local mode', () => {
  it('honored for single-user: absolute path OUTSIDE the base reads fine', () => {
    process.env.VODOU_FS_TOOLS_UNSANDBOXED = '1';
    const r = sandboxRead(CTX, path.join(outsideDir, 'secret.txt'));
    expect(r.content).toBe('TOP SECRET');
  });

  it('denylist STILL bites unconfined (protected file type)', () => {
    process.env.VODOU_FS_TOOLS_UNSANDBOXED = '1';
    expectCode(() => sandboxRead(CTX, path.join(outsideDir, 'id.key')), 'denied');
  });

  it('allow-protected opt-out lifts the denylist', () => {
    process.env.VODOU_FS_TOOLS_UNSANDBOXED = '1';
    process.env.VODOU_FS_TOOLS_UNSANDBOXED_ALLOW_PROTECTED = '1';
    const r = sandboxRead(CTX, path.join(outsideDir, 'id.key'));
    expect(r.content).toBe('PRIVATE KEY');
  });

  it('KILL-SWITCH: ignored when a real tenant is supplied (cloud) → confinement restored', () => {
    process.env.VODOU_FS_TOOLS_UNSANDBOXED = '1';
    const cloudCtx = { conversationId: 'c1', tenantId: 'acme-corp' };
    // With a real tenant, unsandboxed is NOT honored → the absolute escape is refused.
    expectCode(() => sandboxRead(cloudCtx, path.join(outsideDir, 'secret.txt')), 'path_escape');
  });

  it('relative paths still resolve under the base in unsandboxed mode', () => {
    process.env.VODOU_FS_TOOLS_UNSANDBOXED = '1';
    sandboxWrite(CTX, 'rel.txt', 'hello');
    expect(existsSync(path.join(tmpBase, 'rel.txt'))).toBe(true);
    expect(sandboxRead(CTX, 'rel.txt').content).toBe('hello');
  });
});

describe('read-tool denylist parity (no secret leak via the walk)', () => {
  // Regression: grep/glob/search must NOT surface a protected file's name/contents
  // that read_file refuses — even unsandboxed over a real tree.
  function seedSecrets(dir: string) {
    writeFileSync(path.join(dir, 'app.ts'), 'const API_KEY = 1\nfoo()\n');
    writeFileSync(path.join(dir, '.env'), 'API_KEY=sk-SECRET\n');
    writeFileSync(path.join(dir, 'priv.key'), 'SECRET key material\n');
    mkdirSync(path.join(dir, '.ssh'), { recursive: true });
    writeFileSync(path.join(dir, '.ssh', 'id_rsa'), 'SECRET rsa\n');
  }

  it('unsandboxed grep skips .env / *.key / .ssh (only app.ts matches)', () => {
    process.env.VODOU_FS_TOOLS_UNSANDBOXED = '1';
    seedSecrets(outsideDir);
    const r = sandboxGrep(CTX, 'SECRET|API_KEY|foo', { path: outsideDir, regex: true });
    expect(r.matches.every((m) => !/\.env|\.key|\.ssh/.test(m.file))).toBe(true);
    expect(r.matches.some((m) => m.file.endsWith('app.ts'))).toBe(true);
  });

  it('unsandboxed glob does not list protected files', () => {
    process.env.VODOU_FS_TOOLS_UNSANDBOXED = '1';
    seedSecrets(outsideDir);
    const r = sandboxGlob(CTX, '**/*', { path: outsideDir });
    expect(r.files.every((f) => !/\.env|\.key|id_rsa/.test(f.path))).toBe(true);
  });

  it('ALLOW_PROTECTED opt-out lets the walk see protected files', () => {
    process.env.VODOU_FS_TOOLS_UNSANDBOXED = '1';
    process.env.VODOU_FS_TOOLS_UNSANDBOXED_ALLOW_PROTECTED = '1';
    seedSecrets(outsideDir);
    const r = sandboxGrep(CTX, 'SECRET', { path: outsideDir, regex: true });
    expect(r.matches.some((m) => m.file.endsWith('.env') || m.file.endsWith('priv.key'))).toBe(true);
  });

  it('sandboxed: a .env written into the workspace is also skipped by grep', () => {
    sandboxWrite(CTX, 'app.ts', 'const K = 1\nSECRET marker\n');
    // write a .env directly into the per-conv root (sandboxWrite would refuse the name)
    const root = ensureRoot(CTX);
    writeFileSync(path.join(root, '.env'), 'SECRET=leak\n');
    const r = sandboxGrep(CTX, 'SECRET');
    expect(r.matches.every((m) => !m.file.endsWith('.env'))).toBe(true);
    expect(r.matches.some((m) => m.file === 'app.ts')).toBe(true);
  });
});
