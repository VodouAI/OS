import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { fetchChromeForTesting, extractZip, cftPlatform, cftUrl, CFT_PINS, CFT_VERSION } from '../browser-hands/fetch-browser.js';
import { cftExecutable, resolveBrowser } from '../browser-hands/backend.js';
import { openaiCompatVisionEnabled } from '../channelAttachments.js';
// PLAN-BROWSER-HANDS §14.2: a computer with no Chromium gets Chrome for Testing,
// pinned and checksum-verified, on the first errand. Proven live 2026-09-28 on
// macOS arm64 (191 MB, 51 s, launched and read a page) and the Linux fallback
// extractor matched `unzip` byte-for-byte on the real linux64 zip (301 files,
// same exec bits). These tests pin the logic without the network.
/** A tiny zip writer (stored or deflated), enough to exercise extractZip. */
function makeZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const e of entries) {
        const raw = Buffer.from(e.data ?? '');
        const body = e.deflate ? zlib.deflateRawSync(raw) : raw;
        const name = Buffer.from(e.name);
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(20, 4);
        lh.writeUInt16LE(e.deflate ? 8 : 0, 8);
        lh.writeUInt32LE(body.length, 18);
        lh.writeUInt32LE(raw.length, 22);
        lh.writeUInt16LE(name.length, 26);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0);
        ch.writeUInt16LE(0x0314, 4);
        ch.writeUInt16LE(20, 6);
        ch.writeUInt16LE(e.deflate ? 8 : 0, 10);
        ch.writeUInt32LE(body.length, 20);
        ch.writeUInt32LE(raw.length, 24);
        ch.writeUInt16LE(name.length, 28);
        ch.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38);
        ch.writeUInt32LE(offset, 42);
        locals.push(lh, name, body);
        centrals.push(ch, name);
        offset += 30 + name.length + body.length;
    }
    const cd = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
}
let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-fetch-')); });
describe('extractZip (the Linux-without-unzip fallback)', () => {
    it('keeps the executable bit, deflated content, directories and symlinks', () => {
        const z = path.join(tmp, 'a.zip');
        fs.writeFileSync(z, makeZip([
            { name: 'chrome-linux64/', mode: 0o040755 },
            { name: 'chrome-linux64/chrome', data: '#!/bin/sh\necho hi\n', mode: 0o100755, deflate: true },
            { name: 'chrome-linux64/README', data: 'x'.repeat(5000), deflate: true },
            { name: 'chrome-linux64/latest', data: 'chrome', mode: 0o120777 },
        ]));
        const out = path.join(tmp, 'out');
        expect(extractZip(z, out)).toBe(3);
        const exe = path.join(out, 'chrome-linux64', 'chrome');
        expect(fs.readFileSync(exe, 'utf8')).toContain('echo hi');
        expect(fs.statSync(exe).mode & 0o111).not.toBe(0);
        expect(fs.readFileSync(path.join(out, 'chrome-linux64', 'README'), 'utf8')).toHaveLength(5000);
        expect(fs.readlinkSync(path.join(out, 'chrome-linux64', 'latest'))).toBe('chrome');
    });
    it('refuses zip-slip paths and symlinks that point outside', () => {
        const a = path.join(tmp, 'slip.zip');
        fs.writeFileSync(a, makeZip([{ name: '../evil', data: 'x' }]));
        expect(() => extractZip(a, path.join(tmp, 'o1'))).toThrow(/unsafe path/);
        const b = path.join(tmp, 'link.zip');
        fs.writeFileSync(b, makeZip([{ name: 'l', data: '/etc/passwd', mode: 0o120777 }]));
        expect(() => extractZip(b, path.join(tmp, 'o2'))).toThrow(/unsafe symlink/);
    });
});
describe('fetchChromeForTesting', () => {
    const body = Buffer.from('pretend this is chrome');
    const good = { 'mac-arm64': { sha256: crypto.createHash('sha256').update(body).digest('hex'), bytes: body.length } };
    const deps = (over = {}) => {
        const runs = [];
        return {
            runs,
            fetch: (async () => new Response(body)),
            platform: 'darwin', arch: 'arm64', root: tmp,
            // "ditto" = lay out what the real zip holds
            run: (cmd, args) => {
                runs.push([cmd, ...args]);
                const dest = args[args.length - 1];
                const exe = path.join(dest, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
                fs.mkdirSync(path.dirname(exe), { recursive: true });
                fs.writeFileSync(exe, 'bin');
            },
            has: () => true,
            ...over,
        };
    };
    it('downloads, verifies, unpacks with ditto on macOS, and resolveBrowser then finds it', async () => {
        const d = deps();
        const r = await fetchChromeForTesting(d, good);
        expect(r).toMatchObject({ ok: true, path: cftExecutable(tmp, 'darwin') });
        expect(d.runs[0][0]).toBe('/usr/bin/ditto');
        expect(fs.readdirSync(path.join(tmp, '.vodou', 'browser'))).toEqual(['chrome']); // no .part, no staging left
        const b = resolveBrowser({ platform: 'darwin', env: {}, exists: (p) => fs.existsSync(p), which: () => null, root: tmp });
        expect(b?.kind).toBe('chrome-for-testing');
    });
    it('a checksum mismatch deletes the download and never unpacks it', async () => {
        const d = deps({ fetch: (async () => new Response('tampered')) });
        const r = await fetchChromeForTesting(d, good);
        expect(r.ok).toBe(false);
        if (!r.ok)
            expect(r.reason).toMatch(/pinned checksum/);
        expect(d.runs).toHaveLength(0);
        expect(fs.readdirSync(path.join(tmp, '.vodou', 'browser'))).toEqual([]);
    });
    it('an HTTP failure or an unpinned platform is a plain reason, not a throw', async () => {
        const r1 = await fetchChromeForTesting(deps({ fetch: (async () => new Response('no', { status: 404 })) }), good);
        expect(r1).toMatchObject({ ok: false, reason: 'download failed (HTTP 404)' });
        const r2 = await fetchChromeForTesting(deps({ platform: 'linux', arch: 'arm64' }), good);
        expect(r2.ok).toBe(false);
    });
    it('two errands at once share one download', async () => {
        let calls = 0;
        const d = deps({ fetch: (async () => { calls++; return new Response(body); }) });
        const [a, b] = await Promise.all([fetchChromeForTesting(d, good), fetchChromeForTesting(d, good)]);
        expect(a.ok && b.ok).toBe(true);
        expect(calls).toBe(1);
    });
});
describe('the pins', () => {
    it('every platform we map to has a pinned hash, and URLs point at the pinned version', () => {
        for (const [p, a] of [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64'], ['linux', 'x64']]) {
            const plat = cftPlatform(p, a);
            expect(CFT_PINS[plat]?.sha256).toMatch(/^[0-9a-f]{64}$/);
            expect(cftUrl(plat)).toContain(`/${CFT_VERSION}/${plat}/chrome-${plat}.zip`);
        }
    });
});
describe('vision on the hosted proxy (§13.4)', () => {
    it('llm.vodou.ai and the configured proxy URL send images', () => {
        expect(openaiCompatVisionEnabled('https://llm.vodou.ai/v1/chat')).toBe(true);
        const saved = process.env.VODOU_LLM_PROXY_URL;
        process.env.VODOU_LLM_PROXY_URL = 'https://proxy.example.test/v1/chat';
        try {
            expect(openaiCompatVisionEnabled('https://proxy.example.test/v1/chat')).toBe(true);
        }
        finally {
            if (saved === undefined)
                delete process.env.VODOU_LLM_PROXY_URL;
            else
                process.env.VODOU_LLM_PROXY_URL = saved;
        }
        expect(openaiCompatVisionEnabled('https://api.deepseek.com/v1/chat/completions')).toBe(false);
    });
});
