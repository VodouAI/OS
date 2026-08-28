/**
 * PLAN-OAUTH-SWEEP-EVIDENCE P0 — a credential write must clear the sweep's verdict.
 *
 * The regression this pins: `servers.ts` OAuth callback used
 * `ON CONFLICT … DO UPDATE SET credential_value=…, expires_at=…` and nothing else.
 * Unlisted columns are PRESERVED, so `refresh_failures` (31) and a four-month-old
 * `refresh_last_error` survived a successful reconnect — the card read "Reconnect
 * required" forever, and reconnecting could never fix it.
 *
 * This is a SOURCE test on purpose (the same shape as context-assembler-gate): the
 * live path needs a real OAuth provider, so what CI can hold is "every writer that
 * can touch an oauth row resets the verdict", enforced on the SQL text. The live
 * reconnect is PLAN-TRUTHFUL-TURN-VERIFY §W1 / the OAuth plan's own P0 gate.
 *
 * A second bug found while auditing the five writers, pinned here so it cannot
 * return: the npx-fallback env-var writer named columns that do not exist on
 * `server_credentials` (server_name/key/value), so any `POST /api/servers/install`
 * with `env` threw AFTER the server row was inserted — a 500 on a half-done install.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(SRC, f), 'utf8');

/** Every `INSERT INTO server_credentials … ON CONFLICT … DO UPDATE SET …` body in a file. */
function upsertBodies(src: string): string[] {
  const out: string[] = [];
  const re = /INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+server_credentials([\s\S]*?)`/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

describe('credential writers clear the sweep verdict (OAUTH-SWEEP P0)', () => {
  const FILES = ['api/servers.ts', 'api/oauth.ts'];

  it('every server_credentials upsert resets refresh_failures and refresh_last_error', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      for (const body of upsertBodies(read(f))) {
        // `INSERT OR REPLACE` rewrites the whole row, so DEFAULT 0 / NULL apply.
        if (/INSERT\s+OR\s+REPLACE/i.test(body)) continue;
        if (!/ON\s+CONFLICT/i.test(body)) continue;
        const resetsCount = /refresh_failures\s*=\s*0/i.test(body);
        const resetsError = /refresh_last_error\s*=\s*NULL/i.test(body);
        if (!resetsCount || !resetsError) {
          offenders.push(`${f}: ${body.replace(/\s+/g, ' ').trim().slice(0, 90)}…`);
        }
      }
    }
    expect(offenders, `upserts that preserve a stale verdict:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('no writer names a column server_credentials does not have', () => {
    // The real schema (vodou-core.db). server_name/key/value are the 2026 bug.
    const REAL = new Set([
      'id', 'server_id', 'credential_type', 'credential_value', 'env_var_name',
      'header_name', 'header_format', 'source', 'created_at', 'updated_at',
      'expires_at', 'refresh_failures', 'refresh_last_error',
    ]);
    const bad: string[] = [];
    for (const f of FILES) {
      const src = read(f);
      const re = /INTO\s+server_credentials\s*\(([^)]*)\)/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        for (const col of m[1].split(',').map((c) => c.trim()).filter(Boolean)) {
          if (!REAL.has(col)) bad.push(`${f}: unknown column "${col}"`);
        }
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('the Rust writer states why INSERT OR REPLACE is load-bearing', () => {
    // src/database.rs save_server_credential relies on OR REPLACE to reset the
    // verdict via column defaults. A future "modernise to ON CONFLICT" cleanup
    // would break it silently, so the reason must be written down next to it.
    const rust = readFileSync(join(SRC, '../../../src/database.rs'), 'utf8');
    const i = rust.indexOf('pub fn save_server_credential');
    expect(i, 'save_server_credential not found').toBeGreaterThan(-1);
    const window = rust.slice(Math.max(0, i - 1200), i + 400);
    expect(window).toMatch(/refresh_failures/);
    expect(window).toMatch(/refresh_last_error/);
  });
});
