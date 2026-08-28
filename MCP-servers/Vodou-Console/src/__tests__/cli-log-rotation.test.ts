/**
 * CLI session-log pruning.
 *
 * One file per session with nothing pruning them left 289 files and 14MB in
 * `.vodou/workspace/`, a month after the last CLI session. The risk in fixing
 * that is not the accumulation — it is a delete loop that removes the wrong
 * thing, so these tests are mostly about what it must NOT touch.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pruneOldSessionLogs } from '../cli/quiet.js';

let dir: string;
const OLD = Date.now() - 30 * 24 * 60 * 60 * 1000;
const NEW = Date.now() - 60 * 60 * 1000;

function write(name: string, when: number): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'x');
  fs.utimesSync(p, new Date(when), new Date(when));
  return p;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vodou-clilogs-'));
  delete process.env.VODOU_CLI_LOG_RETAIN_DAYS;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.VODOU_CLI_LOG_RETAIN_DAYS;
});

describe('pruneOldSessionLogs', () => {
  it('deletes session logs past the window and keeps recent ones', () => {
    const old = write('cli-111.log', OLD);
    const recent = write('cli-222.log', NEW);
    pruneOldSessionLogs(dir, path.join(dir, 'cli-999.log'));
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
  });

  it('never deletes the log this session is writing, however old the mtime looks', () => {
    // A long-running session's file can age past the window while still open.
    const mine = write('cli-333.log', OLD);
    pruneOldSessionLogs(dir, mine);
    expect(fs.existsSync(mine)).toBe(true);
  });

  it('touches nothing that is not a cli session log', () => {
    // `.vodou/workspace/` holds memory, state and run records. A prefix/suffix
    // slip here would delete real data, which is why this is not a glob.
    const keepers = [
      write('MEMORY.md', OLD),
      write('workflow_state.json', OLD),
      write('agent_next_steps.json', OLD),
      write('cli-notes.txt', OLD),
      write('other-444.log', OLD),
      write('precli-555.log', OLD),
    ];
    pruneOldSessionLogs(dir, path.join(dir, 'cli-999.log'));
    for (const k of keepers) expect(fs.existsSync(k), k).toBe(true);
  });

  it('is disabled by 0, and by anything that is not a positive number', () => {
    for (const v of ['0', '-1', 'never', '']) {
      const old = write('cli-666.log', OLD);
      process.env.VODOU_CLI_LOG_RETAIN_DAYS = v;
      pruneOldSessionLogs(dir, path.join(dir, 'cli-999.log'));
      expect(fs.existsSync(old), `retain=${v} must not prune`).toBe(true);
      fs.unlinkSync(old);
    }
  });

  it('honours a custom window', () => {
    const twoDaysOld = write('cli-777.log', Date.now() - 2 * 24 * 60 * 60 * 1000);
    process.env.VODOU_CLI_LOG_RETAIN_DAYS = '1';
    pruneOldSessionLogs(dir, path.join(dir, 'cli-999.log'));
    expect(fs.existsSync(twoDaysOld)).toBe(false);
  });

  it('never throws on a missing or unreadable directory', () => {
    // It runs before anything else in the process; a broken prune must not be
    // the reason a session fails to start.
    expect(() => pruneOldSessionLogs(path.join(dir, 'nope'), 'x')).not.toThrow();
  });
});
