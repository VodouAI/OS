/**
 * Pictures going BACK to the phone — the other half of tunnel/media.ts.
 *
 * Chad, 2026-09-26, by text: "Screenshot my computer" → "I took it, but I
 * can't text pictures back yet, only receive them. It's saved on your Mac in
 * /tmp/vodou-shots." The turn produced the picture; nothing carried it out.
 * /chat's answer is text only (every channel's is), so the tunnel client finds
 * the pictures itself, after the turn:
 *
 *   - A picture path the ANSWER mentions — the texting-style rider tells the
 *     model that naming a file's full path texts it (texting-style.ts). Any
 *     age: "text me the photo on my Desktop" is a real ask.
 *   - A folder the answer mentions ("saved in /tmp/vodou-shots"): its newest
 *     picture, if it was made during THIS turn — so naming a folder never
 *     sends something old from it.
 *   - A picture path in a TOOL RESULT, only if the file was made during this
 *     turn (a screenshot tool reporting where it saved). An `ls` that lists
 *     old photos must not text them.
 *
 * Only real images (by extension, then converted and re-checked), at most
 * three, and only ever to the account owner's own phone (the relay sends a
 * tunnel reply to the number the text came from).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
const IMAGE_EXT = /\.(png|jpe?g|gif|heic|heif|webp|tiff?)$/i;
// An absolute or ~ path, ending at whitespace/quote/bracket. Trailing sentence
// punctuation is trimmed after the match.
const PATH_RE = /(?:^|[\s("'`[<])((?:~|\/)(?:[^\s"'`<>()[\]]+))/g;
const MAX_PICTURES = 3;
/** Under the relay's 5 MB per-picture cap, with room for base64's growth. */
const MAX_SEND_BYTES = 4.5 * 1024 * 1024;
function expand(p) {
    return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}
/** Absolute paths mentioned in a piece of text (expanded, punctuation-trimmed). */
export function pathsIn(text) {
    const out = [];
    for (const m of String(text || '').matchAll(PATH_RE)) {
        const p = expand(m[1].replace(/[.,;:!?]+$/, ''));
        if (p.length > 1)
            out.push(p);
    }
    return out;
}
function statOf(p) {
    try {
        return fs.statSync(p);
    }
    catch {
        return null;
    }
}
/**
 * The files to text back for one turn, newest-relevant first, at most three.
 * `turnStartMs` is when the turn began; "made during this turn" allows a small
 * clock slack.
 */
export function findPicturesToSend(replyText, toolCalls, turnStartMs) {
    const since = turnStartMs - 2_000;
    const picked = [];
    const add = (p) => { if (!picked.includes(p) && picked.length < MAX_PICTURES)
        picked.push(p); };
    for (const p of pathsIn(replyText)) {
        const st = statOf(p);
        if (!st)
            continue;
        if (st.isFile() && IMAGE_EXT.test(p))
            add(p);
        else if (st.isDirectory()) {
            let newest = null;
            try {
                for (const name of fs.readdirSync(p)) {
                    if (!IMAGE_EXT.test(name))
                        continue;
                    const full = path.join(p, name);
                    const s = statOf(full);
                    if (s?.isFile() && s.mtimeMs >= since && (!newest || s.mtimeMs > newest.t))
                        newest = { p: full, t: s.mtimeMs };
                }
            }
            catch { /* unreadable folder: nothing from it */ }
            if (newest)
                add(newest.p);
        }
    }
    for (const call of toolCalls ?? []) {
        const text = typeof call?.result === 'string' ? call.result : '';
        for (const p of pathsIn(text)) {
            if (!IMAGE_EXT.test(p))
                continue;
            const st = statOf(p);
            if (st?.isFile() && st.mtimeMs >= since)
                add(p);
        }
    }
    return picked;
}
function isSendableImage(buf) {
    if (buf.length < 12)
        return false;
    const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    const png = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const gif = /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'));
    return jpeg || png || gif;
}
/**
 * One picture, ready for the relay: base64 of a JPEG/PNG/GIF under
 * MAX_SEND_BYTES, or null. On macOS a picture is converted with `sips` (built
 * in) to a JPEG capped at 2048 px — a Retina screenshot PNG is 5–10 MB, too big
 * to text, and webp/heic/tiff aren't sendable as-is. Elsewhere, a file that is
 * already a small JPEG/PNG/GIF goes as it is.
 */
export function pictureForText(file, opts = {}) {
    const platform = opts.platform ?? process.platform;
    try {
        if (platform === 'darwin') {
            const out = path.join(os.tmpdir(), `vodou-out-${crypto.randomBytes(6).toString('hex')}.jpg`);
            try {
                execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '-Z', '2048', file, '--out', out], { timeout: 20_000, stdio: 'ignore' });
                const buf = fs.readFileSync(out);
                if (buf.length <= MAX_SEND_BYTES && isSendableImage(buf))
                    return buf.toString('base64');
            }
            catch { /* fall through to the file as it is */ }
            finally {
                try {
                    fs.unlinkSync(out);
                }
                catch { /* never created */ }
            }
        }
        const buf = fs.readFileSync(file);
        return buf.length <= MAX_SEND_BYTES && isSendableImage(buf) ? buf.toString('base64') : null;
    }
    catch {
        return null;
    }
}
