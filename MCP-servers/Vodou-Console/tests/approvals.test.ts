import { describe, it, expect } from 'vitest';
import { createApproval, consumeApproval, pendingCount } from '../src/approvals.js';

const C = 'conv-appr-1';

describe('approvals store', () => {
  it('create → consume round-trips (single-use)', () => {
    const p = createApproval(C, 'write_file', { path: 'a.txt', content: 'x' }, 'file_write');
    expect(p.token).toBeTruthy();
    expect(p.toolName).toBe('write_file');
    const got = consumeApproval(C, p.token);
    expect(got?.input).toEqual({ path: 'a.txt', content: 'x' });
    // single-use: a second consume yields nothing
    expect(consumeApproval(C, p.token)).toBeNull();
  });

  it('consume with a wrong/unknown token or conversation → null', () => {
    const p = createApproval(C, 'bash', { command: 'ls' }, 'bash');
    expect(consumeApproval(C, 'not-the-token')).toBeNull();
    expect(consumeApproval('other-conv', p.token)).toBeNull();
    consumeApproval(C, p.token); // cleanup
  });

  it('expires after the TTL', () => {
    const t0 = 1_000_000;
    const p = createApproval('conv-ttl', 'write_file', {}, 'file_write', t0);
    // just before TTL: still there
    expect(consumeApproval('conv-ttl', p.token, t0 + 29 * 60 * 1000)).not.toBeNull();
    // recreate, then consume past TTL → gone
    const p2 = createApproval('conv-ttl', 'write_file', {}, 'file_write', t0);
    expect(consumeApproval('conv-ttl', p2.token, t0 + 31 * 60 * 1000)).toBeNull();
  });

  it('caps pendings per conversation (evicts oldest)', () => {
    const conv = 'conv-cap';
    const first = createApproval(conv, 'write_file', { n: 0 }, 'file_write', 1);
    for (let i = 1; i <= 25; i++) createApproval(conv, 'write_file', { n: i }, 'file_write', 1 + i);
    expect(pendingCount(conv)).toBeLessThanOrEqual(20);
    // the oldest was evicted
    expect(consumeApproval(conv, first.token)).toBeNull();
  });
});
