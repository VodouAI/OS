/**
 * Browser Hands: fetch Chrome for Testing when the computer has no Chromium-family
 * browser (PLAN-BROWSER-HANDS §14.2, decision 2: "fetch on the first errand with a
 * notice").
 *
 * Pinned per release: a version and OUR OWN sha256 per platform. Google's feed
 * (known-good-versions-with-downloads.json) lists URLs but no hashes, so the hashes
 * below were computed by streaming each zip on 2026-09-28; a download that doesn't
 * match is deleted and never extracted. Bump all of them together.
 *
 * Extraction, per platform, by what is guaranteed to be there:
 *   - macOS: `ditto -x -k` (keeps the .app's framework symlinks and code signature);
 *   - Windows 10+: the built-in `tar.exe` (bsdtar reads zip);
 *   - Linux: `unzip` if installed, else the small extractor below (node:zlib;
 *     keeps symlinks and the executable bit, which Python's zipfile would drop).
 * The result lands in `.vodou/browser/chrome/` so `cftExecutable()` finds it.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { execFileSync } from 'child_process';
import { getProjectRoot } from '../db.js';
import { cftExecutable } from './backend.js';

export const CFT_VERSION = '154.0.8037.57';

/** platform key → [sha256, bytes]. Computed 2026-09-28 by streaming each zip. */
export const CFT_PINS: Record<string, { sha256: string; bytes: number }> = {
  'mac-arm64': { sha256: '0e6b3439469c1b8b95b2e89c72ea29f7af00fb2c28a8878358a0b6002b6d3a64', bytes: 191_429_663 },
  'mac-x64':   { sha256: 'f6c0dff4662f1ffb01f63f9de3888ea95e4c634870a8b9f55e6d2208ba29a8a9', bytes: 201_976_957 },
  'win64':     { sha256: '676f51fb82608330db5510ffba53d9e2762d3d7a99464afce54f9e9e25ad6bf7', bytes: 205_808_814 },
  'linux64':   { sha256: 'ceee2972074d441ea7c4ba8bcc0eaab77e7e87680f6653d73d3065851fe10302', bytes: 196_223_440 },
};

export function cftPlatform(platform: string = process.platform, arch: string = process.arch): string | null {
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (platform === 'win32') return arch === 'x64' || arch === 'arm64' ? 'win64' : null;
  if (platform === 'linux') return arch === 'x64' ? 'linux64' : null; // no pinned linux-arm64 yet
  return null;
}

export function cftUrl(plat: string, version = CFT_VERSION): string {
  return `https://storage.googleapis.com/chrome-for-testing-public/${version}/${plat}/chrome-${plat}.zip`;
}

export type FetchResult =
  | { ok: true; path: string; bytes: number; ms: number }
  | { ok: false; reason: string };

export interface FetchDeps {
  fetch: typeof fetch;
  platform: string;
  arch: string;
  root: string;
  run: (cmd: string, args: string[]) => void;
  has: (cmd: string) => boolean;
}

const defaultDeps = (): FetchDeps => ({
  fetch: globalThis.fetch,
  platform: process.platform,
  arch: process.arch,
  root: getProjectRoot(),
  run: (cmd, args) => { execFileSync(cmd, args, { stdio: 'ignore', timeout: 5 * 60_000 }); },
  has: (cmd) => {
    try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore', timeout: 3000 }); return true; } catch { return false; }
  },
});

let inFlight: Promise<FetchResult> | null = null;

/** Fetch + verify + extract, once (concurrent callers share one download). */
export function fetchChromeForTesting(deps: FetchDeps = defaultDeps(), pins = CFT_PINS): Promise<FetchResult> {
  if (!inFlight) inFlight = doFetch(deps, pins).finally(() => { inFlight = null; });
  return inFlight;
}

async function doFetch(deps: FetchDeps, pins: typeof CFT_PINS): Promise<FetchResult> {
  const t0 = Date.now();
  const plat = cftPlatform(deps.platform, deps.arch);
  if (!plat) return { ok: false, reason: `no Chrome for Testing build is pinned for ${deps.platform}/${deps.arch}` };
  const pin = pins[plat];
  if (!pin) return { ok: false, reason: `no pinned hash for ${plat}` };
  const exe = cftExecutable(deps.root, deps.platform);
  if (fs.existsSync(exe)) return { ok: true, path: exe, bytes: 0, ms: 0 };

  const base = path.join(deps.root, '.vodou', 'browser');
  fs.mkdirSync(base, { recursive: true });
  const zip = path.join(base, `chrome-${plat}.zip.part`);
  const staging = path.join(base, `.extract-${process.pid}`);
  try {
    const res = await deps.fetch(cftUrl(plat));
    if (!res.ok || !res.body) return { ok: false, reason: `download failed (HTTP ${res.status})` };
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(zip);
    let bytes = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      bytes += chunk.length;
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
    }
    await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
    const got = hash.digest('hex');
    if (got !== pin.sha256) {
      fs.rmSync(zip, { force: true });
      return { ok: false, reason: `the download didn't match its pinned checksum (got ${got.slice(0, 12)}…), so it was deleted` };
    }

    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    if (deps.platform === 'darwin') deps.run('/usr/bin/ditto', ['-x', '-k', zip, staging]);
    else if (deps.platform === 'win32') deps.run(path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', staging]);
    else if (deps.has('unzip')) deps.run('unzip', ['-q', zip, '-d', staging]);
    else extractZip(zip, staging);

    // The zip holds one folder, chrome-<plat>/ → rename it to chrome/.
    const inner = path.join(staging, `chrome-${plat}`);
    const dest = path.join(base, 'chrome');
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(fs.existsSync(inner) ? inner : staging, dest);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(zip, { force: true });
    if (!fs.existsSync(exe)) return { ok: false, reason: 'the browser unpacked but its program file is missing' };
    return { ok: true, path: exe, bytes, ms: Date.now() - t0 };
  } catch (e) {
    fs.rmSync(zip, { force: true });
    fs.rmSync(staging, { recursive: true, force: true });
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * A minimal zip extractor (stored + deflate, no zip64, no encryption) that keeps
 * unix modes and symlinks. Only for Linux without `unzip`. Refuses any entry that
 * would land outside `dest` (zip-slip).
 */
export function extractZip(zipPath: string, dest: string): number {
  const buf = fs.readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('zip64 archives are not supported');
  const root = path.resolve(dest);
  let n = 0;
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const ext = buf.readUInt32LE(p + 38);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;

    const target = path.resolve(root, name);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`unsafe path in zip: ${name}`);
    const mode = (ext >>> 16) & 0xffff;
    if (name.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); continue; }
    const lnl = buf.readUInt16LE(local + 26);
    const lxl = buf.readUInt16LE(local + 28);
    const start = local + 30 + lnl + lxl;
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) throw new Error(`unsupported compression ${method} for ${name}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if ((mode & 0o170000) === 0o120000) {
      const link = data.toString('utf8');
      const resolved = path.resolve(path.dirname(target), link);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error(`unsafe symlink in zip: ${name}`);
      fs.rmSync(target, { force: true });
      fs.symlinkSync(link, target);
    } else {
      fs.writeFileSync(target, data, { mode: (mode & 0o777) || 0o644 });
    }
    n++;
  }
  return n;
}
