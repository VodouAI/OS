import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { currentExecWorld, _resetExecWorldCache } from '../exec-world.js';

// PLAN-SEAMS P4 item 5 — the exec seam reads the stack's declared world before
// falling back to the path heuristic, and the environment still wins.
const saved = {
  VODOU_EXEC_WORLD: process.env.VODOU_EXEC_WORLD,
  VODOU_STACK: process.env.VODOU_STACK,
  VODOU_PROJECT_PATH: process.env.VODOU_PROJECT_PATH,
};
function restore() {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}
afterAll(restore);

// A fixture root whose path does NOT trip the lab heuristic (no "vodou" in it).
const root = mkdtempSync(path.join(tmpdir(), 'execworld-fixture-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(
  path.join(root, 'stacks.toml'),
  `schema_version = 1
# exec_world  — local | lab; a comment mentioning exec_world = "lab" must not count
[stacks.web]
processes = ["daemon"]
exec_world = "local"
[stacks.lab]
processes = ["daemon"]
exec_world = "lab"
[stacks.broken]
exec_world = "orbital"
`,
);

describe('currentExecWorld', () => {
  beforeEach(() => {
    restore();
    delete process.env.VODOU_EXEC_WORLD;
    delete process.env.VODOU_STACK;
    process.env.VODOU_PROJECT_PATH = root;
    _resetExecWorldCache();
  });

  it('reads the stack\'s declared world from stacks.toml', () => {
    process.env.VODOU_STACK = 'lab';
    expect(currentExecWorld()).toBe('lab');
    _resetExecWorldCache();
    process.env.VODOU_STACK = 'web';
    expect(currentExecWorld()).toBe('local');
  });

  it('the process environment wins over the stack declaration', () => {
    process.env.VODOU_STACK = 'lab';
    process.env.VODOU_EXEC_WORLD = 'local';
    expect(currentExecWorld()).toBe('local');
    process.env.VODOU_EXEC_WORLD = 'lab';
    process.env.VODOU_STACK = 'web';
    expect(currentExecWorld()).toBe('lab');
  });

  it('an unknown or malformed world in the env or the registry is ignored, not trusted', () => {
    process.env.VODOU_EXEC_WORLD = 'orbital';
    process.env.VODOU_STACK = 'web';
    expect(currentExecWorld()).toBe('local');
    _resetExecWorldCache();
    delete process.env.VODOU_EXEC_WORLD;
    process.env.VODOU_STACK = 'broken';
    // the stanza's world is not a world → fall through to the heuristic, which
    // says local for this fixture path
    expect(currentExecWorld()).toBe('local');
  });

  it('falls back to the path heuristic when the stack is undeclared or unknown', () => {
    delete process.env.VODOU_STACK;
    expect(currentExecWorld()).toBe('local');
    process.env.VODOU_STACK = 'not-a-stack';
    expect(currentExecWorld()).toBe('local');
    // the broken-lab tell, with no stack at all
    delete process.env.VODOU_STACK;
    process.env.VODOU_PROJECT_PATH = '/tmp/vodou-broken-lab-1234';
    _resetExecWorldCache();
    expect(currentExecWorld()).toBe('lab');
  });

  it('a missing registry is silent and the heuristic still answers', () => {
    process.env.VODOU_PROJECT_PATH = path.join(root, 'nowhere');
    process.env.VODOU_STACK = 'lab';
    _resetExecWorldCache();
    expect(currentExecWorld()).toBe('local');
  });
});
