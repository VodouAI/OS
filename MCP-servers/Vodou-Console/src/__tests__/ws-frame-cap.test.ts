/**
 * GW-13 — both WebSocket servers accepted 100 MiB frames.
 *
 * That is `ws`'s default `maxPayload`, and neither server overrode it. A single
 * client could hand the gateway a 100 MB frame and it would be buffered whole
 * before any application code saw it — memory exhaustion an unauthenticated
 * peer triggers by connecting and typing.
 *
 * Driven through a real `ws` server and a real client, because the property is
 * the library's behaviour at the frame boundary, not a constant we chose.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

const CAP = 4 * 1024 * 1024;

async function serve(maxPayload?: number): Promise<string> {
  const server = http.createServer();
  const wss = new WebSocketServer({ server, ...(maxPayload ? { maxPayload } : {}) });
  wss.on('connection', (ws) => { ws.on('message', () => ws.send('ack')); ws.on('error', () => {}); });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** Send `bytes` and report whether the server accepted or closed on us. */
function send(url: string, bytes: number): Promise<'accepted' | 'rejected'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const done = (v: 'accepted' | 'rejected') => { try { ws.close(); } catch { /* gone */ } resolve(v); };
    ws.on('open', () => ws.send(Buffer.alloc(bytes, 0x61)));
    ws.on('message', () => done('accepted'));
    ws.on('close', (code) => done(code === 1009 ? 'rejected' : 'rejected'));
    ws.on('error', () => done('rejected'));
    setTimeout(() => done('rejected'), 4000);
  });
}

describe('GW-13 — oversized frames are refused', () => {
  it('a frame over the cap is rejected', async () => {
    const url = await serve(CAP);
    expect(await send(url, CAP + 1024)).toBe('rejected');
  });

  it('ordinary traffic still passes', async () => {
    // The cap has to be generous enough for what actually crosses these
    // sockets — chat turns, capture payloads, control messages.
    const url = await serve(CAP);
    expect(await send(url, 64 * 1024)).toBe('accepted');
    expect(await send(url, 1024 * 1024)).toBe('accepted');
  });

  it('WITHOUT a cap the same oversized frame is accepted — the default', async () => {
    // The baseline. If `ws` ever changes its default this flips and the cap
    // can be reconsidered, but it must be proven, not assumed.
    const url = await serve();
    expect(await send(url, CAP + 1024)).toBe('accepted');
  });

  it('both servers set maxPayload in source', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url2 = await import('node:url');
    const here = path.dirname(url2.fileURLToPath(import.meta.url));
    for (const f of [path.join(here, '..', 'index.ts'), path.join(here, '..', 'vbb', 'ws.ts')]) {
      const src = fs.readFileSync(f, 'utf8');
      expect(src, `${path.basename(f)} must cap its WebSocketServer`).toMatch(/new WebSocketServer\(\{[^}]*maxPayload/);
    }
  });
});
