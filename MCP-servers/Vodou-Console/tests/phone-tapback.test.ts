/**
 * /simple shows the tapback the PHONE got (Chad, 2026-09-26: "/simple needs
 * to match what is sent in the imessage app. right now it just does 👀").
 * The relay's reactions rotate, so the page can no longer recompute them: the
 * relay sends its pick down, the tunnel client passes it as `phoneReaction`,
 * and it is stored on the phone's message row and returned with history.
 */
import path from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync } from 'fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeGatewayDbOnly } from '../src/db.js';

let dbPath: string;
beforeAll(() => {
  closeGatewayDbOnly();
  dbPath = path.join(tmpdir(), `phone-tapback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  process.env.GATEWAY_DB_PATH = dbPath;
});
afterAll(() => {
  closeGatewayDbOnly();
  if (existsSync(dbPath)) { try { unlinkSync(dbPath); } catch { /* ignore */ } }
});

describe("the phone's tapback is stored with its text", () => {
  it('saved, returned with history; "" means none; NULL means an older row', async () => {
    const { saveMessage, setLastUserReaction, loadRecentMessages, ensureConversation } = await import('../src/conversation-store.js');
    const conv = 'workbench:channel:relay';
    ensureConversation(conv, 'Texts', 'relay');
    saveMessage(conv, 'user', 'an older text', 'Your phone');
    saveMessage(conv, 'user', 'thanks so much', 'Your phone');
    setLastUserReaction(conv, 'Your phone', '🥰');
    saveMessage(conv, 'assistant', 'Anytime.');
    saveMessage(conv, 'user', 'ok', 'Your phone');
    setLastUserReaction(conv, 'Your phone', '');
    const rows = loadRecentMessages(conv, 10).filter((m) => m.role === 'user');
    expect(rows.map((m) => [m.content, m.reaction])).toEqual([
      ['an older text', null],
      ['thanks so much', '🥰'],
      ['ok', ''],
    ]);
  });
});

describe('the tunnel client passes the relay\'s pick to /chat', () => {
  it('phoneReaction rides along; null becomes "" (none)', async () => {
    const { startTunnelClient } = await import('../src/tunnel/client.js');
    const chats: any[] = [];
    let n = 0;
    const fetchImpl = (async (url: any, init: any) => {
      const u = String(url);
      if (u.endsWith('/agent/poll')) {
        n++;
        if (n === 1) return new Response(JSON.stringify({ messages: [
          { id: 'a', text: 'thanks so much', reaction: '🥰' },
          { id: 'b', text: 'ok', reaction: null },
          { id: 'c', text: 'from an older relay' },
        ] }), { status: 200 });
        await new Promise((r) => setTimeout(r, 60));
        return new Response('{"messages":[]}', { status: 200 });
      }
      if (u.endsWith('/chat')) { chats.push(JSON.parse(init.body)); return new Response('{"response":"ok"}', { status: 200 }); }
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const c = startTunnelClient({ fetchImpl, log: () => {}, env: { VODOU_TUNNEL_ENABLED: '1', VODOU_RELAY_URL: 'https://relay.test', VODOU_TOKEN: 'c'.repeat(64), VODOU_USER_ID: '11111111-2222-4333-8444-555555555555' } as any });
    await new Promise((r) => setTimeout(r, 300));
    c.stop();
    expect(chats.map((b) => b.phoneReaction)).toEqual(['🥰', '', undefined]);
  });
});
