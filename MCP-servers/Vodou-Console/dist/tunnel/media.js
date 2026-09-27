/**
 * Pictures texted to the Vodou line, made into ordinary channel attachments.
 *
 * Chad, 2026-09-26: "images aren't working through the imessage ... it just
 * asked me to send some screenshots so i did. nothing happened." The relay
 * dropped any text without words; it now forwards Sendblue's `media_url`s, and
 * this downloads each one to a local file so the turn gets the same
 * `attachments: [{ url: <local path>, ... }]` every other channel (WhatsApp,
 * Telegram) hands /chat — which resolves it through channelAttachments.ts
 * (roots, secret denylist, size caps) and lets the model actually see it.
 *
 * Where: Vodou's own media folder (textedMediaDir → media-store.ts), kept
 * across restarts and always allowed by the attachment resolver.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { vodouMediaDir } from '../media-store.js';
const TYPES = {
    'image/jpeg': { ext: 'jpg', type: 'image' },
    'image/jpg': { ext: 'jpg', type: 'image' },
    'image/png': { ext: 'png', type: 'image' },
    'image/gif': { ext: 'gif', type: 'image' },
    'image/webp': { ext: 'webp', type: 'image' },
    'image/heic': { ext: 'heic', type: 'image' },
    'image/heif': { ext: 'heif', type: 'image' },
    'application/pdf': { ext: 'pdf', type: 'document' },
    // Plain text the model reads as a document (channelAttachments.ts
    // isPlainTextDocument). Word/Excel are NOT here: nothing can read them
    // yet, and a clear "can't read that" beats a silent half-answer.
    'text/plain': { ext: 'txt', type: 'document' },
    'text/markdown': { ext: 'md', type: 'document' },
    'text/csv': { ext: 'csv', type: 'document' },
    'application/json': { ext: 'json', type: 'document' },
};
/**
 * Where texted media is written: Vodou's own media folder (media-store.ts),
 * which survives a restart and is always allowed by channelAttachments.ts.
 * It used to be CHANNEL_MEDIA_ROOTS / the OS temp dir, and macOS clears /tmp.
 */
export function textedMediaDir(_env = process.env) {
    return vodouMediaDir('texted');
}
/**
 * Download each https media URL (the relay only forwards Sendblue's own), cap
 * the size, keep only types the model can read, and write it to disk. Never
 * throws: a picture that cannot be fetched is counted in `failed` so the turn
 * can say so instead of answering as if nothing had been sent.
 */
export async function saveTextedMedia(urls, opts = {}) {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const env = opts.env ?? process.env;
    const maxBytes = opts.maxBytes ?? (parseInt(String(env.CHANNEL_DOCUMENT_MAX_BYTES || ''), 10) || 15 * 1024 * 1024);
    const dir = opts.dir ?? textedMediaDir(env);
    const attachments = [];
    let failed = 0;
    for (const url of urls.slice(0, 10)) {
        try {
            if (!/^https:\/\//i.test(url))
                throw new Error('not https');
            const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
            if (!res.ok)
                throw new Error(`http ${res.status}`);
            const mime = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
            const known = TYPES[mime] ?? TYPES[guessFromUrl(url)];
            if (!known)
                throw new Error(`unsupported type ${mime || '?'}`);
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length === 0 || buf.length > maxBytes)
                throw new Error(`size ${buf.length}`);
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            const file = path.join(dir, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${known.ext}`);
            fs.writeFileSync(file, buf, { mode: 0o600 });
            const jpeg = known.ext === 'heic' || known.ext === 'heif' ? heicToJpeg(file) : null;
            if (jpeg) {
                attachments.push({ url: jpeg, filename: path.basename(jpeg), mimeType: 'image/jpeg', type: 'image' });
            }
            else {
                attachments.push({ url: file, filename: path.basename(file), mimeType: mime && TYPES[mime] ? mime : mimeFor(known.ext), type: known.type });
            }
        }
        catch (e) {
            failed++;
            console.error('[tunnel] texted media not saved:', e instanceof Error ? e.message : String(e));
        }
    }
    return { attachments, failed };
}
/**
 * iPhone camera photos arrive as HEIC, which no desktop browser draws — /simple
 * showed Chad's three photos of his boys as file chips (2026-09-26) — and not
 * every model accepts. On macOS, `sips` (built in) converts to JPEG, capped at
 * 2048 px so a 4032 px photo stays under the vision size limit. Returns the
 * JPEG path (the HEIC is removed), or null to keep the original: not macOS,
 * sips missing, or it failed — the model can often still read the HEIC.
 */
export function heicToJpeg(file) {
    if (process.platform !== 'darwin')
        return null;
    const out = file.replace(/\.(heic|heif)$/i, '.jpg');
    try {
        execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', '-Z', '2048', file, '--out', out], { timeout: 20_000, stdio: 'ignore' });
        if (!fs.existsSync(out) || fs.statSync(out).size === 0)
            return null;
        fs.chmodSync(out, 0o600);
        try {
            fs.unlinkSync(file);
        }
        catch { /* the JPEG is what's used */ }
        return out;
    }
    catch (e) {
        console.error('[tunnel] HEIC → JPEG failed, keeping the original:', e instanceof Error ? e.message : String(e));
        return null;
    }
}
function guessFromUrl(url) {
    const ext = (url.split('?')[0].match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
    return mimeFor(ext);
}
function mimeFor(ext) {
    return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf',
        txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json' }[ext] || '';
}
