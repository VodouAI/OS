import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import { executeOITool } from '../src/executor.js';
import { getProjectRoot } from '../src/db.js';

// WS4 (PLAN-GATEWAY-STATE-LAYER) — truncate-with-handle / expand_result.
// Park a known blob in the stash dir, then drive the real built-in `expand_result`
// tool through executeOITool and assert: bounded window, offset pagination, query
// filter, and the not-found error path. (The cap→stash half is covered live by the
// catalog truncation; here we lock the retrieval contract.)

const STASH_DIR = path.join(getProjectRoot(), '.vodou', 'tool-results');
const ID = 'ws4-vitest-fixture';
const FILE = path.join(STASH_DIR, `${ID}.txt`);

// 20000 chars: 'L0000 ' style lines so query + window are both assertable.
const LINES = Array.from({ length: 2000 }, (_, i) => `L${String(i).padStart(4, '0')} ${i % 7 === 0 ? 'MATCHME token' : 'filler'}`);
const BLOB = LINES.join('\n');

beforeEach(() => {
  mkdirSync(STASH_DIR, { recursive: true });
  writeFileSync(FILE, BLOB);
});
afterEach(() => {
  rmSync(FILE, { force: true });
});

describe('WS4 expand_result', () => {
  it('returns a bounded first window with pagination metadata', async () => {
    const r = await executeOITool('expand_result', { id: ID }, { conversationId: 'ws4' });
    const j = JSON.parse(r.output);
    expect(j.offset).toBe(0);
    expect(j.total).toBe(BLOB.length);
    expect(j.content.length).toBe(8000);            // EXPAND_WINDOW
    expect(j.more).toBe(true);
    expect(j.next_offset).toBe(8000);
    expect(j.content.startsWith('L0000')).toBe(true);
  });

  it('paginates via offset and reports the final window', async () => {
    const tailOffset = BLOB.length - 100; // last 100 chars → below the 8000 window
    const r = await executeOITool('expand_result', { id: ID, offset: tailOffset }, { conversationId: 'ws4' });
    const j = JSON.parse(r.output);
    expect(j.offset).toBe(tailOffset);
    expect(j.content.length).toBe(100);
    expect(j.more).toBe(false);
    expect(j.next_offset).toBeUndefined();
    expect(j.content.endsWith('filler') || j.content.endsWith('token')).toBe(true);
  });

  it('a mid-blob offset still returns a full bounded window with more=true', async () => {
    const r = await executeOITool('expand_result', { id: ID, offset: 8000 }, { conversationId: 'ws4' });
    const j = JSON.parse(r.output);
    expect(j.content.length).toBe(8000);
    expect(j.more).toBe(true);
    expect(j.next_offset).toBe(16000);
  });

  it('query filter returns only matching lines, bounded', async () => {
    const r = await executeOITool('expand_result', { id: ID, query: 'MATCHME' }, { conversationId: 'ws4' });
    const j = JSON.parse(r.output);
    // every 7th of 2000 lines matches
    expect(j.matches).toBe(LINES.filter((l) => l.includes('MATCHME')).length);
    expect(j.content.includes('filler')).toBe(false);
  });

  it('missing/expired id returns a clean error, not a throw', async () => {
    const r = await executeOITool('expand_result', { id: 'no-such-id' }, { conversationId: 'ws4' });
    const j = JSON.parse(r.output);
    expect(j.error).toMatch(/not found or expired/);
  });

  it('rejects a blank id', async () => {
    const r = await executeOITool('expand_result', { id: '   ' }, { conversationId: 'ws4' });
    const j = JSON.parse(r.output);
    expect(j.error).toMatch(/id required/);
  });
});
