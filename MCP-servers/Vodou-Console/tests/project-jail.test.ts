import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { sandboxWrite, sandboxRead, SandboxError } from '../src/fs-sandbox.js';
import { enterProjectContext } from '../src/project-context.js';

// PLAN-PROJECT-FS-JAIL — alpha bug 2026-07-09: chatting inside a gateway project
// could read anywhere on disk ("re-index" walked into ~/Pictures). Two enforcement
// layers under test here:
//   1. fs-sandbox 'project' mode (API-provider tools): unsandboxed turns with an
//      active non-Default project confine absolute paths to project root + tmp.
//   2. scripts/project-jail-hook.cjs (claude-cli PreToolUse hook): blocks native
//      Read/Write/Glob/Grep outside the jail and Bash commands referencing home
//      paths outside it.

const __dir = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dir, '..', 'scripts', 'project-jail-hook.cjs');

const CTX = { conversationId: 'jail-test-1' };
let projRoot: string;
let outside: string;

beforeEach(() => {
  // Project root + outside dir live under HOME, not tmpdir — the jail deliberately
  // allows the system temp dir as scratch space, so tmp-based fixtures can't
  // exercise the boundary. (Hidden dirs, removed in afterEach.)
  projRoot = mkdtempSync(path.join(os.homedir(), '.vodou-test-jail-proj-'));
  // A second real dir OUTSIDE the project (stands in for ~/Pictures).
  outside = mkdtempSync(path.join(os.homedir(), '.vodou-test-jail-outside-'));
  process.env.VODOU_FS_TOOLS_UNSANDBOXED = '1';
  delete process.env.VODOU_FS_TOOLS_ROOT;
  delete process.env.VODOU_PROJECT_FS_JAIL;
});

afterEach(() => {
  enterProjectContext({}); // clear project context for the next test
  delete process.env.VODOU_FS_TOOLS_UNSANDBOXED;
  delete process.env.VODOU_PROJECT_FS_JAIL;
  for (const d of [projRoot, outside]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  }
});

describe('fs-sandbox project mode (API-provider tools)', () => {
  it('confines absolute paths outside the project root', () => {
    enterProjectContext({ root: projRoot, projectId: 'proj_x' });
    writeFileSync(path.join(outside, 'photo.jpg'), 'not-for-you');
    expect(() => sandboxRead(CTX, path.join(outside, 'photo.jpg')))
      .toThrowError(/outside this project's folder/);
    try {
      sandboxRead(CTX, path.join(outside, 'photo.jpg'));
    } catch (e) {
      expect((e as SandboxError).code).toBe('project_escape');
    }
  });

  it('blocks ..-relative escape out of the project root', () => {
    enterProjectContext({ root: projRoot, projectId: 'proj_x' });
    expect(() => sandboxWrite(CTX, '../escape.txt', 'x', 'create'))
      .toThrowError(/outside this project's folder/);
  });

  it('allows relative and absolute paths INSIDE the project root', () => {
    enterProjectContext({ root: projRoot, projectId: 'proj_x' });
    const w = sandboxWrite(CTX, 'notes/inside.txt', 'hello', 'create');
    expect(w.path).toBe(path.join('notes', 'inside.txt'));
    const r = sandboxRead(CTX, path.join(projRoot, 'notes', 'inside.txt'));
    expect(r.content).toBe('hello');
  });

  it('still allows the system temp dir (scratch space)', () => {
    enterProjectContext({ root: projRoot, projectId: 'proj_x' });
    const scratch = path.join(os.tmpdir(), `jail-scratch-${Date.now()}.txt`);
    const w = sandboxWrite(CTX, scratch, 'tmp-ok', 'create');
    expect(w.bytes).toBe(6);
    rmSync(scratch, { force: true });
  });

  it('no active project → historical unsandboxed behavior (regression guard)', () => {
    // enterWith bindings can leak across sibling tests — clear inside THIS test's context.
    enterProjectContext({});
    writeFileSync(path.join(outside, 'free.txt'), 'free');
    const r = sandboxRead(CTX, path.join(outside, 'free.txt'));
    expect(r.content).toBe('free');
  });

  it('VODOU_PROJECT_FS_JAIL=0 kill switch restores unsandboxed inside a project', () => {
    process.env.VODOU_PROJECT_FS_JAIL = '0';
    enterProjectContext({ root: projRoot, projectId: 'proj_x' });
    writeFileSync(path.join(outside, 'free2.txt'), 'free2');
    expect(sandboxRead(CTX, path.join(outside, 'free2.txt')).content).toBe('free2');
  });
});

function runHook(input: unknown, env: Record<string, string>): { status: number | null; stderr: string } {
  const base: Record<string, string> = { ...process.env } as Record<string, string>;
  delete base.VODOU_PROJECT_JAIL_ROOT;
  delete base.VODOU_INSTALL_ROOT;
  delete base.VODOU_PROJECT_FS_JAIL;
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(input),
    env: { ...base, ...env },
    encoding: 'utf8',
  });
  return { status: r.status, stderr: r.stderr || '' };
}

describe('project-jail-hook.cjs (claude-cli PreToolUse boundary)', () => {
  it('allows everything when no jail root is set', () => {
    const r = runHook({ tool_name: 'Read', tool_input: { file_path: os.homedir() + '/Pictures/x.jpg' } }, {});
    expect(r.status).toBe(0);
  });

  it('blocks Read of a home path outside the project', () => {
    const target = path.join(os.homedir(), 'Pictures', 'IMG_0001.jpg');
    const r = runHook(
      { tool_name: 'Read', tool_input: { file_path: target }, cwd: projRoot },
      { VODOU_PROJECT_JAIL_ROOT: projRoot },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Vodou project isolation/);
  });

  it('allows Read inside the project (relative and absolute)', () => {
    mkdirSync(path.join(projRoot, 'src'), { recursive: true });
    writeFileSync(path.join(projRoot, 'src', 'a.ts'), 'x');
    for (const p of ['src/a.ts', path.join(projRoot, 'src', 'a.ts')]) {
      const r = runHook(
        { tool_name: 'Read', tool_input: { file_path: p }, cwd: projRoot },
        { VODOU_PROJECT_JAIL_ROOT: projRoot },
      );
      expect(r.status).toBe(0);
    }
  });

  it('blocks Glob with an absolute pattern outside the project', () => {
    const r = runHook(
      { tool_name: 'Glob', tool_input: { pattern: path.join(os.homedir(), '**', '*.jpg') }, cwd: projRoot },
      { VODOU_PROJECT_JAIL_ROOT: projRoot },
    );
    expect(r.status).toBe(2);
  });

  it('blocks Grep outside the project, allows tmp scratch', () => {
    const blocked = runHook(
      { tool_name: 'Grep', tool_input: { pattern: 'foo', path: outside }, cwd: projRoot },
      { VODOU_PROJECT_JAIL_ROOT: projRoot },
    );
    const tmpOk = runHook(
      { tool_name: 'Grep', tool_input: { pattern: 'foo', path: os.tmpdir() }, cwd: projRoot },
      { VODOU_PROJECT_JAIL_ROOT: projRoot },
    );
    expect(blocked.status).toBe(2);
    expect(tmpOk.status).toBe(0);
  });

  it('blocks Bash commands referencing home paths outside the project', () => {
    for (const cmd of ['ls ~/Pictures', 'cat $HOME/Documents/secret.txt', `find ${os.homedir()}/Desktop -type f`]) {
      const r = runHook(
        { tool_name: 'Bash', tool_input: { command: cmd }, cwd: projRoot },
        { VODOU_PROJECT_JAIL_ROOT: projRoot },
      );
      expect(r.status, cmd).toBe(2);
      expect(r.stderr).toMatch(/Vodou project isolation/);
    }
  });

  it('allows normal Bash commands with no home references', () => {
    for (const cmd of ['git status', 'npm test', 'ls -la src/', 'node script.js']) {
      const r = runHook(
        { tool_name: 'Bash', tool_input: { command: cmd }, cwd: projRoot },
        { VODOU_PROJECT_JAIL_ROOT: projRoot },
      );
      expect(r.status, cmd).toBe(0);
    }
  });

  it('allows Bash referencing the install root (vodou-core tool access)', () => {
    const install = mkdtempSync(path.join(os.homedir(), '.jail-install-'));
    try {
      const r = runHook(
        { tool_name: 'Bash', tool_input: { command: `${install}/vodou-core call gmail list '{}'` }, cwd: projRoot },
        { VODOU_PROJECT_JAIL_ROOT: projRoot, VODOU_INSTALL_ROOT: install },
      );
      expect(r.status).toBe(0);
    } finally {
      rmSync(install, { recursive: true, force: true });
    }
  });

  it('honors the VODOU_PROJECT_FS_JAIL=0 kill switch', () => {
    const r = runHook(
      { tool_name: 'Read', tool_input: { file_path: path.join(os.homedir(), 'Pictures', 'x.jpg') }, cwd: projRoot },
      { VODOU_PROJECT_JAIL_ROOT: projRoot, VODOU_PROJECT_FS_JAIL: '0' },
    );
    expect(r.status).toBe(0);
  });

  it('symlink inside the project pointing outside is caught', () => {
    const link = path.join(projRoot, 'sneaky');
    try {
      // Point at the `outside` dir the setup already created (exists on every
      // platform, and lives outside the jail). `~/Documents` was macOS-only —
      // on a Linux CI runner it doesn't exist, so the symlink dangled,
      // realpathSync couldn't resolve it, and the escape went uncaught (exit 0).
      symlinkSync(outside, link);
    } catch { return; } // symlink not permitted → skip
    const r = runHook(
      { tool_name: 'Read', tool_input: { file_path: 'sneaky/notes.txt' }, cwd: projRoot },
      { VODOU_PROJECT_JAIL_ROOT: projRoot },
    );
    expect(r.status).toBe(2);
  });
});
