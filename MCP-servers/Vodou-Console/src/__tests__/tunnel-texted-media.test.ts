import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startTunnelClient, phoneSafeUserText } from '../tunnel/client.js';
import { textedMediaDir, saveTextedMedia } from '../tunnel/media.js';
import { execFileSync } from 'child_process';

// Chad, 2026-09-26: "images aren't working through the imessage ... i sent
// some screenshots. nothing happened." A picture texted to the line must reach
// the local turn as a real file attachment — and one that can't be fetched must
// be SAID, never silently dropped.

const flush = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const env = {
  VODOU_TUNNEL_ENABLED: '1', VODOU_RELAY_URL: 'https://relay.test',
  VODOU_TOKEN: 'c'.repeat(64), VODOU_USER_ID: '11111111-2222-4333-8444-555555555555',
} as NodeJS.ProcessEnv;

function wires(message: any, media: Record<string, { status: number; type: string; body: Buffer }>) {
  const seen = { chats: [] as any[], replies: [] as any[] };
  let delivered = false;
  const fetchImpl = (async (url: any, init: any) => {
    const u = String(url);
    if (u.endsWith('/agent/poll')) {
      if (!delivered) { delivered = true; return new Response(JSON.stringify({ messages: [message] }), { status: 200 }); }
      await flush(80);
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    }
    if (media[u]) { const m = media[u]; return new Response(new Uint8Array(m.body), { status: m.status, headers: { 'content-type': m.type } }); }
    if (u.includes('127.0.0.1') && u.endsWith('/chat')) {
      seen.chats.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ response: 'That error is a missing semicolon.' }), { status: 200 });
    }
    if (u.endsWith('/agent/reply')) { seen.replies.push(JSON.parse(init.body)); return new Response('{"ok":true}', { status: 200 }); }
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

describe('texted pictures reach the turn', () => {
  it('a picture-only text becomes a local file attachment on /chat, and gets answered', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'texted-'));
    const url = 'https://cdn.sendblue.test/a/screenshot.png';
    const { seen, fetchImpl } = wires({ id: 'm1', text: '', media: [url], ts: 'now' }, { [url]: { status: 200, type: 'image/png', body: PNG } });
    const c = startTunnelClient({ fetchImpl, env, log: () => {}, mediaDir: dir });
    await flush(250); c.stop();
    expect(seen.chats).toHaveLength(1);
    const att = seen.chats[0].attachments;
    expect(att).toHaveLength(1);
    expect(att[0]).toMatchObject({ mimeType: 'image/png', type: 'image' });
    expect(att[0].url.startsWith(dir)).toBe(true);
    expect(fs.readFileSync(att[0].url).equals(PNG)).toBe(true);
    expect(seen.replies[0]).toMatchObject({ id: 'm1', text: 'That error is a missing semicolon.' });
  });

  it('words and several pictures travel together as one turn', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'texted-'));
    const a = 'https://cdn.sendblue.test/a.png', b = 'https://cdn.sendblue.test/b.jpg';
    const { seen, fetchImpl } = wires({ id: 'm2', text: 'what is wrong here?', media: [a, b] }, {
      [a]: { status: 200, type: 'image/png', body: PNG }, [b]: { status: 200, type: 'image/jpeg', body: PNG },
    });
    const c = startTunnelClient({ fetchImpl, env, log: () => {}, mediaDir: dir });
    await flush(250); c.stop();
    expect(seen.chats[0].message).toBe('what is wrong here?');
    expect(seen.chats[0].attachments.map((x: any) => x.mimeType)).toEqual(['image/png', 'image/jpeg']);
  });

  it('a picture that cannot be downloaded is SAID to the model, not dropped', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'texted-'));
    const url = 'https://cdn.sendblue.test/gone.png';
    const { seen, fetchImpl } = wires({ id: 'm3', text: '', media: [url] }, { [url]: { status: 404, type: 'text/plain', body: Buffer.from('no') } });
    const c = startTunnelClient({ fetchImpl, env, log: () => {}, mediaDir: dir });
    await flush(250); c.stop();
    expect(seen.chats[0].attachments).toBeUndefined();
    expect(seen.chats[0].message).toMatch(/texted a picture or file that could not be opened/);
  });

  it('only https, only readable types, and a size cap', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'texted-'));
    const fetchImpl = (async (u: any) => {
      if (String(u).includes('video')) return new Response(new Uint8Array(PNG), { status: 200, headers: { 'content-type': 'video/mp4' } });
      if (String(u).includes('huge')) return new Response(new Uint8Array(2048), { status: 200, headers: { 'content-type': 'image/png' } });
      return new Response(new Uint8Array(PNG), { status: 200, headers: { 'content-type': 'image/png' } });
    }) as unknown as typeof fetch;
    const r = await saveTextedMedia(['http://plain.test/a.png', 'https://x.test/video.mp4', 'https://x.test/huge.png', 'https://x.test/ok.png'], { fetchImpl, dir, maxBytes: 1024 });
    expect(r.failed).toBe(3);
    expect(r.attachments).toHaveLength(1);
  });

  it("texted pictures are kept in Vodou's own media folder, and the resolver allows it even under a strict allowlist", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vmedia-'));
    const prev = { ...process.env };
    process.env.VODOU_MEDIA_DIR = root;
    process.env.CHANNEL_MEDIA_STRICT = '1';
    process.env.CHANNEL_MEDIA_ROOTS = '/somewhere/else';
    try {
      expect(textedMediaDir()).toBe(path.join(root, 'texted'));
      const url = 'https://cdn.sendblue.test/keep.png';
      const fetchImpl = (async () => new Response(new Uint8Array(PNG), { status: 200, headers: { 'content-type': 'image/png' } })) as unknown as typeof fetch;
      const r = await saveTextedMedia([url], { fetchImpl });
      expect(r.attachments[0].url.startsWith(fs.realpathSync(root)) || r.attachments[0].url.startsWith(root)).toBe(true);
      const { resolveChannelMediaPath } = await import('../channelAttachments.js');
      expect(resolveChannelMediaPath(r.attachments[0].url)).not.toBeNull();
      // …while anything outside it and outside the roots is still refused.
      const stray = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stray-')), 'x.png');
      fs.writeFileSync(stray, PNG);
      expect(resolveChannelMediaPath(stray)).toBeNull();
    } finally {
      for (const k of ['VODOU_MEDIA_DIR', 'CHANNEL_MEDIA_STRICT', 'CHANNEL_MEDIA_ROOTS']) {
        if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
      }
    }
  });
});

describe('what the phone sees of a desk-typed message with files', () => {
  it('attachment notes become "(sent a picture)", never a local path', () => {
    const note = (n: string, t: string) => `[Channel attachment: ${n} local_path=/private/tmp/vodou-drop-1-${n} mime=image/png type=${t}]`;
    expect(phoneSafeUserText(`look at this\n\n${note('a.png', 'image')}`)).toBe('look at this (sent a picture)');
    expect(phoneSafeUserText(`${note('a.png', 'image')}\n${note('b.png', 'image')}\n${note('c.pdf', 'document')}`)).toBe('(sent 2 pictures) (sent a file)');
    expect(phoneSafeUserText('just words')).toBe('just words');
    expect(phoneSafeUserText(note('a.png', 'image'))).not.toMatch(/tmp/);
  });
});

describe('texted text files are read too', () => {
  it('txt / csv come through as documents; Word does not', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'texted-'));
    const types: Record<string, string> = { 'notes.txt': 'text/plain', 'data.csv': 'text/csv', 'doc.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    const fetchImpl = (async (u: any) => new Response(new Uint8Array(Buffer.from('a,b\n1,2')), { status: 200, headers: { 'content-type': types[String(u).split('/').pop()!] } })) as unknown as typeof fetch;
    const r = await saveTextedMedia(Object.keys(types).map((n) => `https://cdn.sendblue.test/${n}`), { fetchImpl, dir });
    expect(r.attachments.map((a) => [a.mimeType, a.type])).toEqual([['text/plain', 'document'], ['text/csv', 'document']]);
    expect(r.failed).toBe(1);
  });
});

describe('iPhone HEIC photos become JPEG (browsers cannot draw HEIC)', () => {
  it.skipIf(process.platform !== 'darwin')('a texted HEIC is saved as a JPEG the page and the model can use', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'texted-'));
    // A real HEIC, made by the same built-in tool from a tiny PNG.
    const png = path.join(dir, 'src.png');
    fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a0000000d4948445200000010000000100806000000' + '1ff3ff610000001549444154789c63fccf400a60a2400c0c0c1800000f1a02a9d5e0c7e10000000049454e44ae426082', 'hex'));
    const heic = path.join(dir, 'src.heic');
    execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', png, '--out', heic], { stdio: 'ignore' });
    const bytes = fs.readFileSync(heic);
    const fetchImpl = (async () => new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/heic' } })) as unknown as typeof fetch;
    const out = path.join(dir, 'out');
    const r = await saveTextedMedia(['https://cdn.sendblue.test/IMG_0001.heic'], { fetchImpl, dir: out });
    expect(r.failed).toBe(0);
    expect(r.attachments[0]).toMatchObject({ mimeType: 'image/jpeg', type: 'image' });
    expect(r.attachments[0].url.endsWith('.jpg')).toBe(true);
    expect(fs.readFileSync(r.attachments[0].url).subarray(0, 2).toString('hex')).toBe('ffd8'); // a JPEG
    expect(fs.readdirSync(out).filter((f) => f.endsWith('.heic'))).toEqual([]);
  });
});

describe('attachments are never promised as unsaved (2026-09-26)', () => {
  it('tells the model the files are on this computer, once, and the phone mirror hides it', async () => {
    const { appendChannelAttachmentHints, ATTACHMENTS_SAVED_NOTE } = await import('../channelAttachments.js');
    const { phoneSafeUserText } = await import('../tunnel/client.js');
    const metas = [1, 2].map((n) => ({ url: `/private/tmp/vodou-texted-media/p${n}.jpg`, filename: `p${n}.jpg`, mimeType: 'image/jpeg', type: 'image' as const }));
    const out = appendChannelAttachmentHints('These are my boys', metas);
    expect(out.split(ATTACHMENTS_SAVED_NOTE).length - 1).toBe(1);
    expect(out).toMatch(/Never tell the sender a file was not saved/);
    expect(appendChannelAttachmentHints('hi', [])).toBe('hi');
    expect(phoneSafeUserText(out)).toBe('These are my boys (sent 2 pictures)');
  });
});
