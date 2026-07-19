import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, existsSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  ensureRoot,
  sandboxWrite,
  sandboxRead,
  sandboxList,
  sandboxEdit,
  sandboxMultiEdit,
  SandboxError,
} from '../src/fs-sandbox.js';

const CTX = { conversationId: 'conv-test-1' };

let tmpBase: string;
let outsideDir: string;

beforeEach(() => {
  tmpBase = mkdtempSync(path.join(os.tmpdir(), 'fssbx-root-'));
  outsideDir = mkdtempSync(path.join(os.tmpdir(), 'fssbx-out-'));
  process.env.VODOU_FS_TOOLS_ROOT = tmpBase;
  delete process.env.VODOU_FS_TOOLS_MAX_BYTES;
  // Hermetic: assert SANDBOXED paths — don't inherit a machine .env with unsandboxed/flat on.
  delete process.env.VODOU_FS_TOOLS_UNSANDBOXED;
  delete process.env.VODOU_FS_TOOLS_FLAT_ROOT;
  delete process.env.VODOU_FS_TOOLS_UNSANDBOXED_ALLOW_PROTECTED;
  writeFileSync(path.join(outsideDir, 'secret.txt'), 'TOP SECRET');
});

afterEach(() => {
  delete process.env.VODOU_FS_TOOLS_ROOT;
  delete process.env.VODOU_FS_TOOLS_MAX_BYTES;
  rmSync(tmpBase, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SandboxError);
    expect((e as SandboxError).code).toBe(code);
    return;
  }
  throw new Error(`expected SandboxError(${code}) but no error thrown`);
}

describe('fs-sandbox — happy path', () => {
  it('write (create) → read round-trips, file lands under the per-conversation root', () => {
    const w = sandboxWrite(CTX, 'website/index.html', '<h1>hi</h1>');
    expect(w.created).toBe(true);
    expect(w.bytes).toBe('<h1>hi</h1>'.length);
    expect(w.path).toBe(path.join('website', 'index.html'));

    const root = ensureRoot(CTX);
    expect(existsSync(path.join(root, 'website', 'index.html'))).toBe(true);
    expect(readFileSync(path.join(root, 'website', 'index.html'), 'utf8')).toBe('<h1>hi</h1>');

    const r = sandboxRead(CTX, 'website/index.html');
    expect(r.content).toBe('<h1>hi</h1>');
    expect(r.truncated).toBe(false);
  });

  it('create refuses to clobber; overwrite + append work', () => {
    sandboxWrite(CTX, 'a.txt', 'one');
    expectCode(() => sandboxWrite(CTX, 'a.txt', 'two', 'create'), 'exists');
    sandboxWrite(CTX, 'a.txt', 'two', 'overwrite');
    expect(sandboxRead(CTX, 'a.txt').content).toBe('two');
    sandboxWrite(CTX, 'a.txt', '-three', 'append');
    expect(sandboxRead(CTX, 'a.txt').content).toBe('two-three');
  });

  it('list_dir reports entries with type + size', () => {
    sandboxWrite(CTX, 'docs/readme.md', 'hello');
    sandboxWrite(CTX, 'top.txt', 'x');
    const ls = sandboxList(CTX, '.');
    const names = ls.entries.map((e) => e.name).sort();
    expect(names).toEqual(['docs', 'top.txt']);
    const top = ls.entries.find((e) => e.name === 'top.txt')!;
    expect(top.type).toBe('file');
    expect(top.size).toBe(1);
    expect(ls.entries.find((e) => e.name === 'docs')!.type).toBe('dir');
  });

  it('edit replaces a unique match (literal — no $-expansion)', () => {
    sandboxWrite(CTX, 'f.txt', 'price is OLD dollars');
    const e = sandboxEdit(CTX, 'f.txt', 'OLD', '$5 & $&');
    expect(e.replacements).toBe(1);
    expect(sandboxRead(CTX, 'f.txt').content).toBe('price is $5 & $& dollars');
  });

  it('edit replace_all replaces every occurrence', () => {
    sandboxWrite(CTX, 'f.txt', 'a a a');
    const e = sandboxEdit(CTX, 'f.txt', 'a', 'b', true);
    expect(e.replacements).toBe(3);
    expect(sandboxRead(CTX, 'f.txt').content).toBe('b b b');
  });
});

describe('fs-sandbox — confinement (the boundary)', () => {
  it('rejects ../ traversal', () => {
    expectCode(() => sandboxWrite(CTX, '../escape.txt', 'x'), 'path_escape');
    expectCode(() => sandboxRead(CTX, '../../etc/passwd'), 'path_escape');
  });

  it('rejects absolute paths outside the root', () => {
    expectCode(() => sandboxWrite(CTX, '/etc/x', 'x'), 'path_escape');
    expectCode(() => sandboxRead(CTX, path.join(outsideDir, 'secret.txt')), 'path_escape');
  });

  it('rejects reads through a symlink that escapes the root', () => {
    const root = ensureRoot(CTX);
    symlinkSync(outsideDir, path.join(root, 'link')); // link -> outside dir
    // reading a file *through* the symlinked dir resolves outside → caught by realpath layer
    expectCode(() => sandboxRead(CTX, 'link/secret.txt'), 'symlink_escape');
  });

  it('rejects following a symlinked file (O_NOFOLLOW)', () => {
    const root = ensureRoot(CTX);
    symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(root, 'sneaky.txt'));
    expectCode(() => sandboxRead(CTX, 'sneaky.txt'), 'symlink_escape');
  });

  it('rejects writing onto an escaping symlink (no clobber-through-link)', () => {
    const root = ensureRoot(CTX);
    symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(root, 'sneaky.txt'));
    expectCode(() => sandboxWrite(CTX, 'sneaky.txt', 'pwned', 'overwrite'), 'symlink_escape');
    // the outside file must be untouched
    expect(readFileSync(path.join(outsideDir, 'secret.txt'), 'utf8')).toBe('TOP SECRET');
  });

  it('refuses to list a symlinked directory', () => {
    const root = ensureRoot(CTX);
    symlinkSync(outsideDir, path.join(root, 'link'));
    expectCode(() => sandboxList(CTX, 'link'), 'symlink_escape');
  });
});

describe('fs-sandbox — denylist (defense in depth)', () => {
  it('blocks .env, .git, *.db, binaries', () => {
    expectCode(() => sandboxWrite(CTX, '.env', 'x'), 'denied');
    expectCode(() => sandboxWrite(CTX, '.env.local', 'x'), 'denied');
    expectCode(() => sandboxWrite(CTX, '.git/config', 'x'), 'denied');
    expectCode(() => sandboxWrite(CTX, 'data/foo.db', 'x'), 'denied');
    expectCode(() => sandboxWrite(CTX, 'node_modules/p/index.js', 'x'), 'denied');
    expectCode(() => sandboxWrite(CTX, 'vodou-core', 'x'), 'denied');
  });

  it('denylist is case-insensitive (macOS/Windows FS fold case)', () => {
    expectCode(() => sandboxWrite(CTX, '.GIT/config', 'x'), 'denied');
    expectCode(() => sandboxWrite(CTX, 'NODE_MODULES/p.js', 'x'), 'denied');
    expectCode(() => sandboxWrite(CTX, '.ENV', 'x'), 'denied');
  });
});

describe('fs-sandbox — caps + edit errors + ctx', () => {
  it('rejects oversize writes', () => {
    process.env.VODOU_FS_TOOLS_MAX_BYTES = '16';
    expectCode(() => sandboxWrite(CTX, 'big.txt', 'x'.repeat(17)), 'too_large');
    sandboxWrite(CTX, 'ok.txt', 'x'.repeat(16)); // exactly at cap is fine
  });

  it('read truncates at max_bytes and flags it', () => {
    sandboxWrite(CTX, 'r.txt', '0123456789');
    const r = sandboxRead(CTX, 'r.txt', 4);
    expect(r.content).toBe('0123');
    expect(r.bytes).toBe(10);
    expect(r.truncated).toBe(true);
  });

  it('edit no-match and ambiguous-match are hard failures', () => {
    sandboxWrite(CTX, 'f.txt', 'a a a');
    expectCode(() => sandboxEdit(CTX, 'f.txt', 'zzz', 'q'), 'no_match');
    expectCode(() => sandboxEdit(CTX, 'f.txt', 'a', 'q'), 'ambiguous'); // 3 matches, replace_all=false
  });

  it('edit on a missing file is not_found', () => {
    expectCode(() => sandboxEdit(CTX, 'nope.txt', 'a', 'b'), 'not_found');
  });

  it('requires a conversation context', () => {
    expectCode(() => sandboxWrite({}, 'x.txt', 'y'), 'no_conversation');
  });

  it('isolates conversations (A cannot see B files)', () => {
    sandboxWrite({ conversationId: 'A' }, 'a-only.txt', 'secretA');
    const lsB = sandboxList({ conversationId: 'B' }, '.');
    expect(lsB.entries.map((e) => e.name)).not.toContain('a-only.txt');
  });
});

// Adversarial-review regressions (2026-06-04).
describe('fs-sandbox — review fixes', () => {
  it('#1: "." / ".." / padded-dot ids are confined to their own workspace, NOT collapsed to the tenant base', () => {
    // Pre-fix, ensureRoot(".") returned the tenant base (the PARENT of every
    // conversation), so a "." chat could list/read/overwrite siblings. Now the
    // segment is neutralized to a safe child dir, so "." is isolated like any id.
    sandboxWrite({ conversationId: 'victim' }, 'secret.md', 'TOP SECRET');
    for (const id of ['.', '..', '   .   ']) {
      const ls = sandboxList({ conversationId: id }, '.').entries.map((e) => e.name);
      expect(ls).not.toContain('victim'); // cannot enumerate sibling conversations
      expectCode(() => sandboxRead({ conversationId: id }, 'victim/secret.md'), 'not_found');
    }
    // victim's file is untouched
    expect(sandboxRead({ conversationId: 'victim' }, 'secret.md').content).toBe('TOP SECRET');
  });

  it('#7: edit is atomic — leaves a valid file and no leftover temp', () => {
    sandboxWrite(CTX, 'f.txt', 'hello world');
    sandboxEdit(CTX, 'f.txt', 'world', 'there');
    expect(sandboxRead(CTX, 'f.txt').content).toBe('hello there');
    // no .vodou-tmp.* artifacts left behind in the dir
    const names = sandboxList(CTX, '.').entries.map((e) => e.name);
    expect(names.some((n) => n.includes('vodou-tmp'))).toBe(false);
    expect(names).toContain('f.txt');
  });

  it('#11: edit refuses a binary (NUL-containing) file instead of corrupting it', () => {
    const root = ensureRoot(CTX);
    writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42, 0x00, 0x43]));
    expectCode(() => sandboxEdit(CTX, 'bin.dat', 'A', 'Z'), 'binary');
  });
});

describe('fs-sandbox — multi_edit (#1.2)', () => {
  it('applies multiple edits atomically to a confined file', () => {
    sandboxWrite(CTX, 'm.txt', 'alpha\nbeta\ngamma\n');
    const r = sandboxMultiEdit(CTX, 'm.txt', [
      { oldString: 'alpha', newString: 'A' },
      { oldString: 'gamma', newString: 'G' },
    ]);
    expect(r.totalReplacements).toBe(2);
    expect(sandboxRead(CTX, 'm.txt').content).toBe('A\nbeta\nG\n');
    // no temp artifacts left
    expect(sandboxList(CTX, '.').entries.some((e) => e.name.includes('vodou-tmp'))).toBe(false);
  });

  it('is atomic — a no-match in any edit leaves the file UNTOUCHED', () => {
    sandboxWrite(CTX, 'm2.txt', 'one\ntwo\n');
    expectCode(() => sandboxMultiEdit(CTX, 'm2.txt', [
      { oldString: 'one', newString: 'ONE' },
      { oldString: 'NOPE', newString: 'X' },
    ]), 'no_match');
    expect(sandboxRead(CTX, 'm2.txt').content).toBe('one\ntwo\n'); // unchanged
  });

  it('still confines (escaping path refused) and binary-guards', () => {
    expectCode(() => sandboxMultiEdit(CTX, '../escape.txt', [{ oldString: 'a', newString: 'b' }]), 'path_escape');
  });
});
