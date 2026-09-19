import { describe, it, expect } from 'vitest';
import { upsertEnvCredentials, upsertContinuityIdentityEnv } from '../api/onboarding.js';

// The onboarding auth flow writes VODOU_TOKEN / VODOU_USER_ID into .env. The
// upsert must be idempotent (replace-in-place when present, append when absent)
// so repeated logins never duplicate or corrupt the file.
describe('upsertEnvCredentials (.env credential writer)', () => {
  it('appends both keys to an empty file', () => {
    const out = upsertEnvCredentials('', 'TOK1', 'USER1');
    expect(out).toContain('VODOU_TOKEN=TOK1');
    expect(out).toContain('VODOU_USER_ID=USER1');
    // exactly one of each
    expect(out.match(/^VODOU_TOKEN=/gm)?.length).toBe(1);
    expect(out.match(/^VODOU_USER_ID=/gm)?.length).toBe(1);
  });

  it('replaces existing keys in place (no duplication)', () => {
    const existing = 'FOO=bar\nVODOU_TOKEN=OLD\nVODOU_USER_ID=OLDU\nBAZ=qux\n';
    const out = upsertEnvCredentials(existing, 'NEW', 'NEWU');
    expect(out).toContain('VODOU_TOKEN=NEW');
    expect(out).toContain('VODOU_USER_ID=NEWU');
    expect(out).not.toContain('OLD');
    expect(out).not.toContain('OLDU');
    expect(out).toContain('FOO=bar');   // unrelated lines preserved
    expect(out).toContain('BAZ=qux');
    expect(out.match(/^VODOU_TOKEN=/gm)?.length).toBe(1); // still single
    expect(out.match(/^VODOU_USER_ID=/gm)?.length).toBe(1);
  });

  it('is idempotent — running twice yields the same result', () => {
    const once = upsertEnvCredentials('EXISTING=1\n', 'T', 'U');
    const twice = upsertEnvCredentials(once, 'T', 'U');
    expect(twice).toBe(once);
  });

  it('updates only the token when user id already matches', () => {
    const existing = 'VODOU_TOKEN=A\nVODOU_USER_ID=U\n';
    const out = upsertEnvCredentials(existing, 'B', 'U');
    expect(out.match(/^VODOU_TOKEN=B$/m)).toBeTruthy();
    expect(out.match(/^VODOU_USER_ID=U$/m)).toBeTruthy();
    expect(out.match(/^VODOU_USER_ID=/gm)?.length).toBe(1);
  });
});

/**
 * A missing name must not throw.
 *
 * Reported 2026-09-16 from a fresh install on an Intel Mac: the wizard's "Your
 * AI" step showed `Error: Cannot read properties of undefined (reading
 * 'replace')` with a Retry button. That string is this function's first line.
 *
 * The chain: the step strip lets you jump to any step, `_data` is never
 * rehydrated from the server (/status returns flags, not a profile), and
 * `userName` is only set by typing it in "About you" or by signing UP — so a
 * user who signed IN and clicked ahead posted /complete with no name. The
 * route's `if (!String(userName).trim())` guard could not catch it, because
 * `String(undefined)` is the truthy string "undefined". Execution reached here
 * and threw, and the wizard printed the TypeError verbatim.
 *
 * The signature says `string`; both callers reach it from a JSON body, where a
 * missing field is `undefined`. A type annotation is not a runtime guard.
 */
describe('upsertContinuityIdentityEnv (continuity identity writer)', () => {
  it('does not throw when the name is missing, and writes no name line', () => {
    const out = upsertContinuityIdentityEnv('VODOU_TOKEN=T\n', undefined, 'joe@example.com');
    expect(out).toContain('VODOU_USER_EMAIL=joe@example.com');
    expect(out).not.toMatch(/^VODOU_USER_NAME=/m);
    expect(out).not.toContain('undefined');
  });

  it('does not throw when the name is null', () => {
    const out = upsertContinuityIdentityEnv('VODOU_TOKEN=T\n', null as unknown as undefined, '');
    expect(out).not.toMatch(/^VODOU_USER_NAME=/m);
    expect(out).not.toContain('null');
  });

  it('writes the name when one is given, next to the credentials', () => {
    const out = upsertContinuityIdentityEnv('VODOU_TOKEN=T\nVODOU_USER_ID=U\n', 'Joe Tester', 'joe@example.com');
    expect(out).toMatch(/^VODOU_USER_NAME=Joe Tester$/m);
    expect(out).toMatch(/^VODOU_USER_EMAIL=joe@example.com$/m);
    expect(out.match(/^VODOU_USER_NAME=/gm)?.length).toBe(1);
  });

  it('flattens newlines in a pasted name rather than corrupting the file', () => {
    const out = upsertContinuityIdentityEnv('VODOU_TOKEN=T\n', 'Joe\nTester', '');
    expect(out).toMatch(/^VODOU_USER_NAME=Joe Tester$/m);
  });

  it('keeps an existing email when the form supplies none', () => {
    const existing = 'VODOU_TOKEN=T\nVODOU_USER_EMAIL=kept@example.com\n';
    const out = upsertContinuityIdentityEnv(existing, 'Joe', undefined);
    expect(out).toMatch(/^VODOU_USER_EMAIL=kept@example.com$/m);
    expect(out.match(/^VODOU_USER_EMAIL=/gm)?.length).toBe(1);
  });
});
