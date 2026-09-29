import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findPicturesToSend, pictureForText, pathsIn } from '../tunnel/outbound-pictures.js';
import { startTunnelClient } from '../tunnel/client.js';
// Pictures BACK to the phone. Chad, 2026-09-26, by text: "Screenshot my
// computer" → "I took it, but I can't text pictures back yet … It's saved on
// your Mac in /tmp/vodou-shots." What is pinned: which files a turn texts back
// (named in the answer, or made during the turn), which it must NOT (old files
// a tool merely listed, old files in a named folder), and that the reply
// carries them — with the words alone if an older relay refuses the size.
// Smallest valid PNG (1×1).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const flush = (ms) => new Promise((r) => setTimeout(r, ms));
let dir;
const old = (p) => { const t = new Date(Date.now() - 3600_000); fs.utimesSync(p, t, t); };
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vodou-pics-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
describe('which pictures a turn texts back', () => {
    it('reads paths out of prose, trimming sentence punctuation, never URLs', () => {
        expect(pathsIn('Saved it to /tmp/a b.png. Also (/tmp/c.jpg), and https://x.com/d.png')).toEqual(['/tmp/a', '/tmp/c.jpg']);
        expect(pathsIn('on your Desktop: ~/Desktop/x.png')).toEqual([path.join(os.homedir(), 'Desktop/x.png')]);
    });
    it('a picture the answer names is sent, however old', () => {
        const p = path.join(dir, 'kids.jpg');
        fs.writeFileSync(p, PNG);
        old(p);
        expect(findPicturesToSend(`Here it is: ${p}`, [], Date.now())).toEqual([p]);
    });
    it('a folder the answer names sends only its newest picture made THIS turn', () => {
        const start = Date.now();
        const stale = path.join(dir, 'yesterday.png');
        fs.writeFileSync(stale, PNG);
        old(stale);
        expect(findPicturesToSend(`It's saved on your Mac in ${dir}.`, [], start)).toEqual([]);
        const fresh = path.join(dir, 'shot.png');
        fs.writeFileSync(fresh, PNG);
        expect(findPicturesToSend(`It's saved on your Mac in ${dir}.`, [], start)).toEqual([fresh]);
    });
    it('a tool result path is sent only if the file was made during the turn', () => {
        const start = Date.now();
        const listed = path.join(dir, 'old-photo.png');
        fs.writeFileSync(listed, PNG);
        old(listed);
        const shot = path.join(dir, 'screen.png');
        fs.writeFileSync(shot, PNG);
        const toolCalls = [{ name: 'shell', result: `${listed}\n${shot}\n/nope/missing.png` }];
        expect(findPicturesToSend('Done.', toolCalls, start)).toEqual([shot]);
    });
    it('never more than three, never a non-picture, never twice', () => {
        const files = [1, 2, 3, 4].map((i) => { const p = path.join(dir, `s${i}.png`); fs.writeFileSync(p, PNG); return p; });
        const txt = path.join(dir, 'notes.txt');
        fs.writeFileSync(txt, 'x');
        const got = findPicturesToSend(`${files.join(' ')} ${files[0]} ${txt}`, [], Date.now());
        expect(got).toEqual(files.slice(0, 3));
    });
    it('turns a picture into base64 the relay accepts; refuses a non-image', () => {
        const p = path.join(dir, 'a.png');
        fs.writeFileSync(p, PNG);
        const b64 = pictureForText(p, { platform: 'linux' });
        expect(Buffer.from(b64, 'base64').equals(PNG)).toBe(true);
        const fake = path.join(dir, 'fake.png');
        fs.writeFileSync(fake, 'not really a png');
        expect(pictureForText(fake, { platform: 'linux' })).toBeNull();
    });
    it.skipIf(process.platform !== 'darwin')('on macOS, converts to a JPEG with sips', () => {
        const p = path.join(dir, 'a.png');
        fs.writeFileSync(p, PNG);
        const buf = Buffer.from(pictureForText(p), 'base64');
        expect([buf[0], buf[1], buf[2]]).toEqual([0xff, 0xd8, 0xff]);
    });
});
describe('the reply carries the pictures', () => {
    const env = {
        VODOU_TUNNEL_ENABLED: '1', VODOU_RELAY_URL: 'https://relay.test',
        VODOU_TOKEN: 'c'.repeat(64), VODOU_USER_ID: '11111111-2222-4333-8444-555555555555',
    };
    function run(replyStatuses, chatBody) {
        const seen = { replies: [] };
        let delivered = false;
        const fetchImpl = (async (url, init) => {
            const u = String(url);
            if (u.endsWith('/agent/poll')) {
                if (!delivered) {
                    delivered = true;
                    return new Response(JSON.stringify({ messages: [{ id: 'm1', text: 'Screenshot my computer', ts: 'now' }] }), { status: 200 });
                }
                await flush(60);
                return new Response(JSON.stringify({ messages: [] }), { status: 200 });
            }
            if (u.endsWith('/chat')) {
                // The "screenshot" is taken during the turn.
                fs.writeFileSync(path.join(dir, 'shot.png'), PNG);
                return new Response(JSON.stringify(chatBody(dir)), { status: 200 });
            }
            if (u.endsWith('/agent/reply')) {
                seen.replies.push(JSON.parse(init.body));
                return new Response('{}', { status: replyStatuses[seen.replies.length - 1] ?? 200 });
            }
            throw new Error(`unexpected fetch ${u}`);
        });
        return { seen, client: startTunnelClient({ fetchImpl, env, log: () => { } }) };
    }
    it('a screenshot the turn took goes up with the words', async () => {
        const { seen, client } = run([200], (d) => ({ response: `Here's your screen. ${d}/shot.png`, toolCalls: [] }));
        try {
            await flush(200);
            expect(seen.replies).toHaveLength(1);
            expect(seen.replies[0].text).toMatch(/Here's your screen/);
            expect(seen.replies[0].images).toHaveLength(1);
        }
        finally {
            client.stop();
        }
    });
    it('an answer with no picture sends no images field', async () => {
        const { seen, client } = run([200], () => ({ response: 'Two meetings, both after lunch.' }));
        try {
            await flush(200);
            expect(seen.replies[0].images).toBeUndefined();
        }
        finally {
            client.stop();
        }
    });
    it('an older relay that refuses the size (413) still gets the words', async () => {
        const { seen, client } = run([413, 200], (d) => ({ response: `Saved in ${d}.` }));
        try {
            await flush(200);
            expect(seen.replies).toHaveLength(2);
            expect(seen.replies[0].images).toHaveLength(1);
            expect(seen.replies[1].images).toBeUndefined();
            expect(seen.replies[1].text).toBe(seen.replies[0].text);
        }
        finally {
            client.stop();
        }
    });
});
