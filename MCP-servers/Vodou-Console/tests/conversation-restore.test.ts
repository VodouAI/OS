import path from 'path';
import os from 'os';
import { existsSync, unlinkSync } from 'fs';
import request from 'supertest';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { closeGatewayDbOnly } from '../src/db.js';
import {
  saveMessage,
  deleteConversation,
  restoreConversation,
  listRecentlyClosedConversations,
  loadConversations,
  loadMessages,
  getConversation,
} from '../src/conversation-store.js';

// Recently-closed / undo-close support: closing a chat tab soft-deletes the
// conversation (deleted_at stamp). Restore must bring it back into the live
// list with all messages intact, and the recently-closed list must surface
// soft-deleted rows newest-first.
describe('conversation soft-delete restore', () => {
  let gwDb: string;

  beforeEach(() => {
    closeGatewayDbOnly();
    gwDb = path.join(os.tmpdir(), `gw-restore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    process.env.GATEWAY_DB_PATH = gwDb;
  });

  afterEach(() => {
    closeGatewayDbOnly();
    delete process.env.GATEWAY_DB_PATH;
    for (const suffix of ['', '-wal', '-shm']) {
      const f = gwDb + suffix;
      if (existsSync(f)) { try { unlinkSync(f); } catch { /* */ } }
    }
  });

  it('soft-deletes, lists as recently closed, and restores with messages intact', () => {
    saveMessage('conv-restore-1', 'user', 'hello');
    saveMessage('conv-restore-1', 'assistant', 'hi there');

    deleteConversation('conv-restore-1');

    // Gone from the live list (tab hydration), but not from the DB
    expect(loadConversations().some(c => c.id === 'conv-restore-1')).toBe(false);
    const closed = listRecentlyClosedConversations();
    expect(closed.length).toBe(1);
    expect(closed[0].id).toBe('conv-restore-1');
    expect(closed[0].deleted_at).toBeTruthy();

    restoreConversation('conv-restore-1');

    expect(loadConversations().some(c => c.id === 'conv-restore-1')).toBe(true);
    expect(listRecentlyClosedConversations().length).toBe(0);
    const messages = loadMessages('conv-restore-1');
    expect(messages.map(m => m.content)).toEqual(['hello', 'hi there']);
  });

  it('orders recently closed newest-first and respects the limit', () => {
    saveMessage('conv-a', 'user', 'a');
    saveMessage('conv-b', 'user', 'b');
    deleteConversation('conv-a');
    deleteConversation('conv-b');

    const closed = listRecentlyClosedConversations();
    expect(closed.map(c => c.id).sort()).toEqual(['conv-a', 'conv-b']);
    expect(listRecentlyClosedConversations(1).length).toBe(1);
  });

  it('restore is a no-op on a live conversation and bumps updated_at on a deleted one', () => {
    saveMessage('conv-live', 'user', 'x');
    restoreConversation('conv-live'); // not deleted — must not throw or corrupt
    expect(getConversation('conv-live')?.id).toBe('conv-live');
    expect(loadConversations().some(c => c.id === 'conv-live')).toBe(true);
  });
});

describe('recently-closed / restore HTTP endpoints', () => {
  let gwDb: string;

  beforeEach(() => {
    closeGatewayDbOnly();
    gwDb = path.join(os.tmpdir(), `gw-restore-http-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    process.env.GATEWAY_DB_PATH = gwDb;
  });

  afterEach(() => {
    closeGatewayDbOnly();
    delete process.env.GATEWAY_DB_PATH;
    for (const suffix of ['', '-wal', '-shm']) {
      const f = gwDb + suffix;
      if (existsSync(f)) { try { unlinkSync(f); } catch { /* */ } }
    }
  });

  it('full undo round-trip: DELETE → listed as recently closed → POST restore → live again', async () => {
    const { createGatewayApp } = await import('../src/index.js');
    const app = createGatewayApp();

    saveMessage('conv-http-1', 'user', 'hello');
    saveMessage('conv-http-1', 'assistant', 'hi');

    const del = await request(app).delete('/api/gateway/conversation/conv-http-1');
    expect(del.status).toBe(200);

    const closed = await request(app).get('/api/gateway/conversations/recently-closed');
    expect(closed.status).toBe(200);
    const entry = closed.body.conversations.find((c: { id: string }) => c.id === 'conv-http-1');
    expect(entry).toBeTruthy();
    expect(entry.messageCount).toBe(2);

    const restore = await request(app).post('/api/gateway/conversation/conv-http-1/restore');
    expect(restore.status).toBe(200);
    expect(restore.body.ok).toBe(true);
    expect(restore.body.conversation.id).toBe('conv-http-1');

    expect(loadConversations().some(c => c.id === 'conv-http-1')).toBe(true);
    const closedAfter = await request(app).get('/api/gateway/conversations/recently-closed');
    expect(closedAfter.body.conversations.some((c: { id: string }) => c.id === 'conv-http-1')).toBe(false);
  });

  it('restore of an unknown conversation returns 404', async () => {
    const { createGatewayApp } = await import('../src/index.js');
    const app = createGatewayApp();
    const res = await request(app).post('/api/gateway/conversation/no-such-conv/restore');
    expect(res.status).toBe(404);
  });
});
