import { describe, it, expect, afterEach } from 'vitest';
import { assertEgressAllowed, SsrfBlockedError } from './ssrf.js';
async function blocked(url) {
    try {
        await assertEgressAllowed(url);
        return false;
    }
    catch (e) {
        return e instanceof SsrfBlockedError;
    }
}
describe('assertEgressAllowed', () => {
    afterEach(() => { delete process.env.VODOU_ALLOW_PRIVATE_EGRESS; });
    it('blocks non-http(s) schemes', async () => {
        expect(await blocked('file:///etc/passwd')).toBe(true);
        expect(await blocked('gopher://x/')).toBe(true);
        expect(await blocked('ftp://host/')).toBe(true);
    });
    it('blocks loopback and unspecified', async () => {
        expect(await blocked('http://127.0.0.1/')).toBe(true);
        expect(await blocked('http://127.5.6.7:8765/api')).toBe(true);
        expect(await blocked('http://0.0.0.0/')).toBe(true);
        expect(await blocked('http://[::1]/')).toBe(true);
        expect(await blocked('http://localhost/')).toBe(true);
    });
    it('blocks cloud metadata + link-local', async () => {
        expect(await blocked('http://169.254.169.254/latest/meta-data/')).toBe(true);
        expect(await blocked('http://metadata.google.internal/')).toBe(true);
    });
    it('blocks RFC1918 private ranges', async () => {
        expect(await blocked('http://10.0.0.5/')).toBe(true);
        expect(await blocked('http://172.16.0.1/')).toBe(true);
        expect(await blocked('http://192.168.1.1/')).toBe(true);
    });
    it('blocks CGNAT and IPv4-mapped IPv6 loopback', async () => {
        expect(await blocked('http://100.64.0.1/')).toBe(true);
        expect(await blocked('http://[::ffff:127.0.0.1]/')).toBe(true);
    });
    it('blocks userinfo in URL', async () => {
        expect(await blocked('http://user:pass@example.com/')).toBe(true);
    });
    it('allows a public IP literal (no DNS needed)', async () => {
        await expect(assertEgressAllowed('https://8.8.8.8/')).resolves.toBeUndefined();
        await expect(assertEgressAllowed('https://1.1.1.1/')).resolves.toBeUndefined();
    });
    it('escape hatch allows private when VODOU_ALLOW_PRIVATE_EGRESS=1', async () => {
        process.env.VODOU_ALLOW_PRIVATE_EGRESS = '1';
        await expect(assertEgressAllowed('http://127.0.0.1:8765/')).resolves.toBeUndefined();
        // ...but scheme allowlist still applies
        expect(await blocked('file:///etc/passwd')).toBe(true);
    });
});
