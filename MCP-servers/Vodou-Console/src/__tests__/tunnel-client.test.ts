import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startTunnelClient, tunnelEnabled, tunnelNotifyPhone, announceTunnelOnNextPoll } from '../tunnel/client.js';
import { onBrowserCancel } from '../browser-hands/cancel.js';

// M3a (PLAN-VODOU-LOCAL-TUNNEL messaging lane) — the gateway's long-poll
// client, with every wire injected. What is pinned:
//   a polled message becomes a LOCAL turn via this gateway's own POST /chat
//   with source 'relay' (the channel envelope path — fenced, memory, skills,
//   approvals all apply), and the turn's final text goes back up as the reply;
//   a failed local turn still answers UP (a snag notice), never silence;
//   a 401 from the relay pauses instead of retry-storming auth.

const flush = (ms: number) => new Promise((r) => setTimeout(r, ms));

function wires(overrides: { chatStatus?: number; chatBody?: any } = {}) {
  const seen: { polls: number; chats: any[]; replies: any[]; notifies: any[] } = { polls: 0, chats: [], replies: [], notifies: [] };
  let delivered = false;
  const fetchImpl = (async (url: any, init: any) => {
    const u = String(url);
    if (u.endsWith('/agent/poll')) {
      seen.polls++;
      if (!delivered) {
        delivered = true;
        return new Response(JSON.stringify({ messages: [{ id: 'm1', text: 'what is on my calendar', ts: 'now' }] }), { status: 200 });
      }
      await flush(80); // later polls hold briefly, like the relay
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    }
    if (u.includes('127.0.0.1') && u.endsWith('/chat')) {
      seen.chats.push(JSON.parse(init.body));
      return new Response(JSON.stringify(overrides.chatBody ?? { response: 'Two meetings, both after lunch.' }), { status: overrides.chatStatus ?? 200 });
    }
    if (u.endsWith('/agent/reply')) {
      seen.replies.push({ auth: init.headers.Authorization, ...JSON.parse(init.body) });
      return new Response('{"ok":true}', { status: 200 });
    }
    if (u.endsWith('/agent/notify')) {
      seen.notifies.push({ auth: init.headers.Authorization, ...JSON.parse(init.body) });
      return new Response('{"ok":true}', { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const env = {
  VODOU_TUNNEL_ENABLED: '1',
  VODOU_RELAY_URL: 'https://relay.test',
  VODOU_TOKEN: 'c'.repeat(64),
  VODOU_USER_ID: '11111111-2222-4333-8444-555555555555',
} as NodeJS.ProcessEnv;

describe('tunnel client (messaging lane)', () => {
  it('is ON unless VODOU_TUNNEL_ENABLED turns it off (a fresh install never opted in)', () => {
    expect(tunnelEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    for (const off of ['0', 'false', 'no', 'off', ' OFF ']) {
      expect(tunnelEnabled({ VODOU_TUNNEL_ENABLED: off } as NodeJS.ProcessEnv)).toBe(false);
    }
    expect(tunnelEnabled({ VODOU_TUNNEL_ENABLED: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(tunnelEnabled({ VODOU_TUNNEL_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('a STOP (cancel) abandons the running turn and drops the queued ones — nothing is answered', async () => {
    // 2026-09-28: a bare "Stop" is also how people halt a long task; the relay
    // opts them out AND tells the laptop to cancel.
    const seen = { chats: [] as string[], replies: [] as any[], aborted: false };
    let batch = 0;
    const fetchImpl = (async (url: any, init: any) => {
      const u = String(url);
      if (u.endsWith('/agent/poll')) {
        batch++;
        if (batch === 1) return new Response(JSON.stringify({ messages: [{ id: 'm1', text: 'research flights', ts: 'now' }, { id: 'm2', text: 'and hotels', ts: 'now' }] }), { status: 200 });
        if (batch === 2) { await flush(60); return new Response(JSON.stringify({ messages: [{ id: 'c1', cancel: true, ts: 'now' }] }), { status: 200 }); }
        await flush(40);
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      if (u.endsWith('/chat')) {
        seen.chats.push(JSON.parse(init.body).message);
        // A long local turn that honours its abort signal, like the real one.
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 500);
          init.signal?.addEventListener('abort', () => { clearTimeout(t); seen.aborted = true; reject(new DOMException('aborted', 'AbortError')); });
        });
        return new Response(JSON.stringify({ response: 'Here are flights.' }), { status: 200 });
      }
      if (u.endsWith('/agent/reply')) { seen.replies.push(JSON.parse(init.body)); return new Response('{"ok":true}', { status: 200 }); }
      throw new Error(`unexpected fetch ${u}`);
    }) as unknown as typeof fetch;
    // Browser Hands (§13.7): aborting /chat can't stop an errand already driving
    // a browser, or one waiting on a "yes" — STOP must reach it directly too.
    const errandStops: string[] = [];
    onBrowserCancel(async (conv) => { errandStops.push(conv); return true; });
    const client = startTunnelClient({ fetchImpl, env, log: () => {} });
    try {
      await flush(700);
      expect(seen.chats).toEqual(['research flights']); // "and hotels" was dropped, never run
      expect(seen.aborted).toBe(true);                   // the running turn was aborted
      expect(seen.replies).toEqual([]);                  // nothing answered — not even a snag notice
      expect(errandStops).toEqual(['workbench:channel:relay']);
    } finally { client.stop(); onBrowserCancel(null); }
  });

  describe('"your Mac is connected" hello', () => {
    const helloWires = (status = 200) => {
      const seen = { hellos: [] as any[], polls: 0 };
      const fetchImpl = (async (url: any, init: any) => {
        const u = String(url);
        if (u.endsWith('/agent/hello')) { seen.hellos.push({ auth: init.headers.Authorization, ...JSON.parse(init.body) }); return new Response('{"ok":true}', { status }); }
        if (u.endsWith('/agent/poll')) { seen.polls++; await flush(30); return new Response(JSON.stringify({ messages: [] }), { status: 200 }); }
        throw new Error(`unexpected fetch ${u}`);
      }) as unknown as typeof fetch;
      return { seen, fetchImpl };
    };
    const marker = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hello-')), 'run', 'tunnel-hello-sent');

    it('a Mac that never said hello says it once on its first start, with its name, then remembers', async () => {
      const m = marker();
      const w = helloWires();
      const client = startTunnelClient({ fetchImpl: w.fetchImpl, env, log: () => {}, helloMarker: m });
      try {
        await flush(150);
        expect(w.seen.hellos).toHaveLength(1);
        expect(w.seen.hellos[0].auth).toBe(`Bearer ${env.VODOU_TOKEN}:${env.VODOU_USER_ID}`);
        expect(typeof w.seen.hellos[0].label).toBe('string');
        expect(fs.existsSync(m)).toBe(true);
        expect(w.seen.polls).toBeGreaterThan(1); // …and it went on polling
      } finally { client.stop(); }
      // A restart with the marker present is quiet.
      const w2 = helloWires();
      const again = startTunnelClient({ fetchImpl: w2.fetchImpl, env, log: () => {}, helloMarker: m });
      try { await flush(100); expect(w2.seen.hellos).toHaveLength(0); } finally { again.stop(); }
    });

    it('connecting an account announces again, even on a Mac that said hello before', async () => {
      const m = marker();
      fs.mkdirSync(path.dirname(m), { recursive: true }); fs.writeFileSync(m, 'earlier');
      const w = helloWires();
      const client = startTunnelClient({ fetchImpl: w.fetchImpl, env, log: () => {}, helloMarker: m });
      try {
        await flush(80);
        expect(w.seen.hellos).toHaveLength(0);
        announceTunnelOnNextPoll(); // what "Connect this computer" calls
        await flush(120);
        expect(w.seen.hellos).toHaveLength(1);
      } finally { client.stop(); }
    });

    it('a relay error is tried once, never looped', async () => {
      const m = marker();
      const w = helloWires(500);
      const client = startTunnelClient({ fetchImpl: w.fetchImpl, env, log: () => {}, helloMarker: m });
      try {
        await flush(200);
        expect(w.seen.hellos).toHaveLength(1);
        expect(fs.existsSync(m)).toBe(false);
      } finally { client.stop(); }
    });

    it('with no account connected it waits quietly — no hello, no poll', async () => {
      const w = helloWires();
      const client = startTunnelClient({ fetchImpl: w.fetchImpl, env: { VODOU_RELAY_URL: 'https://relay.test' } as NodeJS.ProcessEnv, log: () => {}, helloMarker: marker() });
      try { await flush(100); expect([w.seen.hellos.length, w.seen.polls]).toEqual([0, 0]); } finally { client.stop(); }
    });
  });

  it('keeps polling while a long turn runs, and still answers in order', async () => {
    // 2026-09-26: a 2-minute task stopped the poll loop; after 35s the relay
    // thought the laptop was gone and sent new texts to the demo instead.
    const seen = { polls: 0, chats: [] as string[], replies: [] as any[] };
    let batch = 0;
    const fetchImpl = (async (url: any, init: any) => {
      const u = String(url);
      if (u.endsWith('/agent/poll')) {
        seen.polls++;
        batch++;
        if (batch === 1) return new Response(JSON.stringify({ messages: [{ id: 'm1', text: 'slow task', ts: 'now' }] }), { status: 200 });
        if (batch === 2) return new Response(JSON.stringify({ messages: [{ id: 'm2', text: 'quick one', ts: 'now' }] }), { status: 200 });
        await flush(40);
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      if (u.endsWith('/chat')) {
        const msg = JSON.parse(init.body).message;
        seen.chats.push(msg);
        if (msg === 'slow task') await flush(300);
        return new Response(JSON.stringify({ response: `done: ${msg}` }), { status: 200 });
      }
      if (u.endsWith('/agent/reply')) { seen.replies.push(JSON.parse(init.body)); return new Response('{"ok":true}', { status: 200 }); }
      throw new Error(`unexpected fetch ${u}`);
    }) as unknown as typeof fetch;
    const client = startTunnelClient({ fetchImpl, env, log: () => {} });
    try {
      await flush(150); // the slow turn is still running
      expect(seen.polls).toBeGreaterThanOrEqual(3);     // …and polling carried on
      expect(seen.chats).toEqual(['slow task']);        // one local turn at a time
      await flush(400);
      expect(seen.replies.map((r) => r.id)).toEqual(['m1', 'm2']); // in order
      expect(seen.replies[1].text).toBe('done: quick one');
    } finally { client.stop(); }
  });

  for (const [label, chatStatus, chatBody, expectNotify] of [
    ['a real answer the relay lost (restart / window closed) is delivered via notify', 200, { response: 'Playing Prince now.' }, true],
    ['a snag notice the relay lost is NOT re-sent', 500, { error: 'boom' }, false],
  ] as const) {
    it(label, async () => {
      // 2026-09-26: a relay deploy mid-task answered this computer's reply with
      // 410 and "Spotify's up front now…" never reached the phone.
      const seen = { replies: 0, notifies: [] as any[] };
      let delivered = false;
      const fetchImpl = (async (url: any, init: any) => {
        const u = String(url);
        if (u.endsWith('/agent/poll')) {
          if (!delivered) { delivered = true; return new Response(JSON.stringify({ messages: [{ id: 'm1', text: 'play Prince', ts: 'now' }] }), { status: 200 }); }
          await flush(60); return new Response(JSON.stringify({ messages: [] }), { status: 200 });
        }
        if (u.endsWith('/chat')) return new Response(JSON.stringify(chatBody), { status: chatStatus });
        if (u.endsWith('/agent/reply')) { seen.replies++; return new Response('{"error":"unknown or expired message id"}', { status: 410 }); }
        if (u.endsWith('/agent/notify')) { seen.notifies.push(JSON.parse(init.body)); return new Response('{"ok":true}', { status: 200 }); }
        throw new Error(`unexpected fetch ${u}`);
      }) as unknown as typeof fetch;
      const client = startTunnelClient({ fetchImpl, env, log: () => {} });
      try {
        await flush(200);
        expect(seen.replies).toBe(1);
        if (expectNotify) {
          expect(seen.notifies).toEqual([{ user_text: '', reply_text: 'Playing Prince now.' }]);
        } else {
          expect(seen.notifies).toEqual([]);
        }
      } finally { client.stop(); }
    });
  }

  it('a polled text runs as a local relay-channel turn and the answer rides back up', async () => {
    const { seen, fetchImpl } = wires();
    const client = startTunnelClient({ fetchImpl, env, log: () => {} });
    try {
      await flush(150);
      expect(seen.chats.length).toBe(1);
      // The turn is a CHANNEL turn on this gateway: fenced untrusted content,
      // memory, skills, and the text yes/no approval lane all apply because
      // this is the same POST /chat every channel uses.
      expect(seen.chats[0]).toMatchObject({
        message: 'what is on my calendar',
        conversationId: 'workbench:channel:relay',
        source: 'relay',
      });
      expect(seen.replies.length).toBe(1);
      expect(seen.replies[0]).toMatchObject({ id: 'm1', text: 'Two meetings, both after lunch.' });
      expect(seen.replies[0].auth).toBe(`Bearer ${'c'.repeat(64)}:11111111-2222-4333-8444-555555555555`);
      expect(seen.polls).toBeGreaterThanOrEqual(1);
    } finally { client.stop(); }
  });

  it('a failed local turn still answers up — a snag notice, never silence', async () => {
    const { seen, fetchImpl } = wires({ chatStatus: 500, chatBody: { error: 'LLM not configured' } });
    const client = startTunnelClient({ fetchImpl, env, log: () => {} });
    try {
      await flush(150);
      expect(seen.replies.length).toBe(1);
      expect(seen.replies[0].text).toMatch(/snag/i);
      expect(seen.replies[0].text).toMatch(/LLM not configured/);
    } finally { client.stop(); }
  });

  it('a 401 from the relay pauses the loop instead of hammering auth', async () => {
    let polls = 0;
    // Counts POLLS: a first-start hello (also refused here) is a separate, single call.
    const fetchImpl = (async (url: any) => { if (String(url).endsWith('/agent/poll')) polls++; return new Response('{}', { status: 401 }); }) as unknown as typeof fetch;
    const client = startTunnelClient({ fetchImpl, env, log: () => {} });
    try {
      await flush(250);
      expect(polls).toBe(1); // one attempt, then the 5-minute pause — no storm
    } finally { client.stop(); }
  });
});

describe('tunnel client — upstream push (M3b mirror)', () => {
  it('mirrors a page-typed turn up to the relay, and goes quiet once stopped', async () => {
    const { seen, fetchImpl } = wires();
    const client = startTunnelClient({ fetchImpl, env, log: () => {} });
    try {
      tunnelNotifyPhone('what did we ship today', 'M2b and the tunnel.');
      await flush(60);
      expect(seen.notifies.length).toBe(1);
      expect(seen.notifies[0]).toMatchObject({ user_text: 'what did we ship today', reply_text: 'M2b and the tunnel.' });
      expect(seen.notifies[0].auth).toBe(`Bearer ${'c'.repeat(64)}:11111111-2222-4333-8444-555555555555`);
      // Empty reply never fires a mirror (nothing to say = nothing to send).
      tunnelNotifyPhone('q', '   ');
      await flush(40);
      expect(seen.notifies.length).toBe(1);
    } finally { client.stop(); }
    // After stop, the mirror is a no-op — a dangling reference must not
    // resurrect network calls from a dead client.
    tunnelNotifyPhone('late', 'too late');
    await flush(40);
    expect(seen.notifies.length).toBe(1);
  });
});
