import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { policyFetch, _resetPolicyForTests, getPolicyState } from './policy.js';
import http from 'node:http';

// Spin up tiny HTTP fixture servers per test
function makeServer(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as any;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => srv.close(),
      });
    });
  });
}

describe('policyFetch', () => {
  // These fixtures fetch from 127.0.0.1, which the SSRF egress guard blocks by
  // default. Opt into private egress for the duration of these tests.
  beforeEach(() => {
    _resetPolicyForTests();
    process.env.VODOU_ALLOW_PRIVATE_EGRESS = '1';
  });
  afterEach(() => {
    delete process.env.VODOU_ALLOW_PRIVATE_EGRESS;
  });

  it('fetches a simple URL and returns body + status', async () => {
    const server = await makeServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello');
    });
    try {
      const r = await policyFetch(server.url);
      expect(r.status).toBe(200);
      expect(r.body).toBe('hello');
      expect(r.truncated).toBe(false);
    } finally { server.close(); }
  });

  it('truncates body at max_body_bytes', async () => {
    const server = await makeServer((req, res) => {
      res.writeHead(200);
      res.end('x'.repeat(10000));
    });
    try {
      const r = await policyFetch(server.url, {}, { max_body_bytes: 100 });
      expect(r.body.length).toBe(100);
      expect(r.truncated).toBe(true);
    } finally { server.close(); }
  });

  it('follows redirects up to max_redirects', async () => {
    let hops = 0;
    const server = await makeServer((req, res) => {
      hops++;
      if (req.url === '/end') { res.writeHead(200); res.end('ok'); return; }
      res.writeHead(302, { location: '/end' });
      res.end();
    });
    try {
      const r = await policyFetch(server.url + '/start');
      expect(r.status).toBe(200);
      expect(r.body).toBe('ok');
      expect(hops).toBe(2);
    } finally { server.close(); }
  });

  it('rejects with TOO_MANY_REDIRECTS when exceeding the cap', async () => {
    let hits = 0;
    const server = await makeServer((req, res) => {
      hits++;
      res.writeHead(302, { location: `/${hits}` });
      res.end();
    });
    try {
      await expect(policyFetch(server.url, {}, { max_redirects: 3 })).rejects.toMatchObject({ code: 'TOO_MANY_REDIRECTS' });
    } finally { server.close(); }
  });

  it('rejects with TIMEOUT when the server is slow', async () => {
    const server = await makeServer((req, res) => {
      // Never respond — let the timeout fire
      setTimeout(() => { try { res.end(); } catch {} }, 1000);
    });
    try {
      await expect(policyFetch(server.url, {}, { timeout_ms: 50 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    } finally { server.close(); }
  });

  it('throttles per-host (second fetch waits for min interval)', async () => {
    const server = await makeServer((req, res) => { res.writeHead(200); res.end('ok'); });
    try {
      const t0 = Date.now();
      await policyFetch(server.url);
      await policyFetch(server.url);
      const elapsed = Date.now() - t0;
      // The per-host throttle is 250ms — second call should wait
      expect(elapsed).toBeGreaterThanOrEqual(200);
    } finally { server.close(); }
  });

  it('coexists with concurrent requests under the global cap', async () => {
    const server = await makeServer((req, res) => {
      setTimeout(() => { res.writeHead(200); res.end('ok'); }, 50);
    });
    try {
      const urls = ['/a', '/b', '/c', '/d'].map(p => server.url + p);
      const results = await Promise.all(urls.map(u => policyFetch(u)));
      for (const r of results) {
        expect(r.status).toBe(200);
      }
    } finally { server.close(); }
  });

  it('getPolicyState reports active counters after fetches', async () => {
    const state = getPolicyState();
    expect(state.active).toBeGreaterThanOrEqual(0);
    expect(state.waiting).toBeGreaterThanOrEqual(0);
  });
});
