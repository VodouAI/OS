/**
 * P3 — one answer to "where is the gateway", on the TypeScript side.
 *
 * `src/gateway_url.rs` records what the absence of this costs: four answers that
 * disagreed, so an install whose gateway moved off 8765 had components looking
 * for it on two or three ports at once — and one user's OAuth reconnect could
 * never complete, because the link he was told to click was on a port his
 * gateway did not own.
 *
 * The gateway had the same disease and no cure: `WEB_PORT || '8765'` written out
 * across a dozen files, each a chance to disagree with `index.ts` — the only one
 * that matters, because it is the line that BINDS.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gatewayPort, gatewayBaseUrl, DEFAULT_WEB_PORT } from '../gateway-port.js';

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

describe('P3 — the gateway port has one source', () => {
  it('defaults to 8765, and agrees with the Rust default', () => {
    delete process.env.WEB_PORT;
    expect(gatewayPort()).toBe(8765);
    expect(DEFAULT_WEB_PORT).toBe(8765);
    const rust = readFileSync(join(__dirname, '../../../../src/gateway_url.rs'), 'utf-8');
    expect(rust, 'the two halves of the product must not disagree about the default')
      .toContain('const DEFAULT_WEB_PORT: u16 = 8765;');
  });

  it('honours WEB_PORT — the reason this exists', () => {
    process.env.WEB_PORT = '9123';
    expect(gatewayPort()).toBe(9123);
    expect(gatewayBaseUrl()).toBe('http://localhost:9123');
  });

  it('refuses nonsense rather than producing port NaN', () => {
    // `parseInt('' , 10)` is NaN, and a URL containing "NaN" fails in a way that
    // looks like a network problem rather than a config one.
    for (const bad of ['', '   ', 'abc', '0', '-1']) {
      process.env.WEB_PORT = bad;
      expect(gatewayPort(), `WEB_PORT=${JSON.stringify(bad)}`).toBe(8765);
    }
  });

  it('GATEWAY_BASE_URL wins, for a gateway that is not on this host', () => {
    process.env.WEB_PORT = '9123';
    process.env.GATEWAY_BASE_URL = 'https://vodou.example.com/';
    // Trailing slash trimmed: half the old call sites appended a path and half
    // did not, which is how `//api/...` reached a server.
    expect(gatewayBaseUrl()).toBe('https://vodou.example.com');
  });

  it('no runtime source resolves the port by hand any more', () => {
    // JSON fixtures, SSRF tests and prose comments are exempt: none of them is a
    // code path that reaches a gateway. Browser extensions and installers are
    // outside this package entirely and genuinely cannot read repo config.
    const files = ['index.ts', 'llm.ts', 'workflow-driver.ts', 'api/oauth.ts', 'api/onboarding.ts'];
    for (const f of files) {
      const body = readFileSync(join(__dirname, '..', f), 'utf-8');
      const offenders = body.split('\n')
        .map((l, i) => [l.split('//')[0], i + 1] as const)
        .filter(([code]) => /WEB_PORT\s*\|\|\s*['"]8765|localhost:8765/.test(code));
      expect(offenders.map(([, n]) => `${f}:${n}`),
        `${f} must ask gatewayPort()/gatewayBaseUrl()`).toEqual([]);
    }
  });
});
