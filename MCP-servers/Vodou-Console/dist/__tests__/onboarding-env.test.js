import { describe, it, expect } from 'vitest';
import { upsertEnvCredentials } from '../api/onboarding.js';
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
        expect(out).toContain('FOO=bar'); // unrelated lines preserved
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
