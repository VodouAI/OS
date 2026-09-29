import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveBrowser, launchArgs, launchEnv, cftExecutable, cdmEntry } from '../browser-hands/backend.js';
import { checkBrowser } from '../browser-hands/doctor.js';
// PLAN-BROWSER-HANDS §14: this must work on ANYONE's fresh install, on all
// three platforms, including machines with no Chrome.
const deps = (platform, present, extra = {}) => ({
    platform,
    env: { HOME: '/Users/x', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
    exists: (p) => present.includes(p),
    which: () => null,
    root: '/v',
    ...extra,
});
describe('browser resolution (§14.2): never depend on the person having Chrome', () => {
    it('macOS: Chrome when present', () => {
        expect(resolveBrowser(deps('darwin', ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']))?.kind).toBe('chrome');
    });
    it('macOS: falls back to Edge, then Brave, then Chromium', () => {
        expect(resolveBrowser(deps('darwin', ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']))?.kind).toBe('edge');
        expect(resolveBrowser(deps('darwin', ['/Users/x/Applications/Brave Browser.app/Contents/MacOS/Brave Browser']))?.kind).toBe('brave');
    });
    it('macOS: Safari-only machine resolves to nothing (absent → fetch Chrome for Testing)', () => {
        expect(resolveBrowser(deps('darwin', []))).toBeNull();
    });
    it('Vodou\'s own Chrome for Testing wins over what the person has', () => {
        const cft = cftExecutable('/v', 'darwin');
        expect(resolveBrowser(deps('darwin', [cft, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']))?.kind).toBe('chrome-for-testing');
    });
    it('Windows: Edge is enough (preinstalled on every Windows 10/11)', () => {
        expect(resolveBrowser(deps('win32', ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']))?.kind).toBe('edge');
        expect(resolveBrowser(deps('win32', ['C:\\Users\\x\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe']))?.kind).toBe('chrome');
    });
    it('Linux: finds browsers on PATH', () => {
        const d = deps('linux', ['/usr/bin/chromium'], { which: (n) => (n === 'chromium' ? '/usr/bin/chromium' : null) });
        expect(resolveBrowser(d)).toEqual({ path: '/usr/bin/chromium', kind: 'chromium' });
    });
});
describe('launch flags (§13.5, §13.6, §14.4)', () => {
    const a = launchArgs({ executablePath: '/c', profile: '/v/.vodou/browser-profile' });
    it('uses Vodou\'s own profile, never the shared ~/.cache default', () => {
        expect(a).toContain('--userDataDir=/v/.vodou/browser-profile');
        expect(a.join(' ')).not.toMatch(/\.cache/);
    });
    it('turns off Google usage statistics, CrUX and JavaScript evaluation', () => {
        for (const f of ['--usageStatistics=false', '--performanceCrux=false', '--javascriptEvaluation=false'])
            expect(a).toContain(f);
        const env = launchEnv({});
        expect(env.CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS).toBe('1');
        expect(env.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS).toBe('1');
    });
    it('switches off the network, performance, memory, emulation and PWA tool categories', () => {
        for (const c of ['Network', 'Performance', 'Memory', 'Emulation', 'Pwa'])
            expect(a).toContain(`--category${c}=false`);
    });
    it('makes small JPEG proofs on every platform (no macOS sips needed)', () => {
        expect(a).toContain('--screenshotFormat=jpeg');
        expect(a).toContain('--screenshotMaxWidth=1600');
    });
    it('is headed by default (OpenTable refuses headless); headless only when asked', () => {
        expect(a).not.toContain('--headless');
        expect(launchArgs({ executablePath: '/c', profile: '/p', headless: true, isolated: true })).toEqual(expect.arrayContaining(['--headless', '--isolated']));
    });
});
describe('the doctor (§14.3)', () => {
    const saved = [];
    const base = { save: (s) => saved.push(s), now: () => new Date('2026-09-28T19:00:00Z') };
    it('absent when there is no browser', async () => {
        const s = await checkBrowser({ ...base, resolve: () => null, entryExists: () => true, start: (() => { throw new Error('must not launch'); }) });
        expect(s.state).toBe('absent');
        expect(s.checkedAt).toBe('2026-09-28 19:00:00'); // naive UTC
    });
    it('degraded, with the reason, when the browser won\'t run', async () => {
        const s = await checkBrowser({ ...base, resolve: () => ({ path: '/c', kind: 'chrome' }), entryExists: () => true, start: (async () => { throw new Error('Target closed'); }) });
        expect(s.state).toBe('degraded');
        expect(s.reason).toMatch(/Target closed/);
    });
    it('degraded when the pinned server is missing from the install', async () => {
        const s = await checkBrowser({ ...base, resolve: () => ({ path: '/c', kind: 'chrome' }), entryExists: () => false, start: (() => { throw new Error('x'); }) });
        expect(s.state).toBe('degraded');
        expect(s.reason).toMatch(/not installed/);
    });
});
// The real thing, on this machine: launch the vendored 1.10.1 against whatever
// browser resolves, headless + throwaway profile. Skipped when either is missing.
const root = path.resolve(__dirname, '..', '..', '..', '..');
const real = resolveBrowser({ platform: process.platform, env: process.env, exists: (p) => { try {
        return fs.statSync(p).isFile();
    }
    catch {
        return false;
    } }, which: () => null, root });
describe.skipIf(!real || !fs.existsSync(cdmEntry(root)))('the doctor, live', () => {
    it('launches a real browser, reads a page, and reports ok with 21 tools', async () => {
        const { startBackend, profileDir } = await import('../browser-hands/backend.js');
        const saved = [];
        const s = await checkBrowser({
            resolve: () => real,
            entryExists: () => true,
            start: (o) => startBackend(o, process.execPath, root),
            save: (x) => saved.push(x),
            now: () => new Date(),
        });
        expect(s.state, s.reason).toBe('ok');
        expect(s.toolCount).toBe(21);
        expect(profileDir(root)).toMatch(/\.vodou[\\/]browser-profile$/);
    }, 90_000);
});
// processes.toml `browser-hands` (lane canon rule 3): the errand server
// publishes its pid while it runs and takes it back when it exits, so
// `vodou-core builds` / Flow 13 can find it without guessing at a name.
describe('the errand server is a registered process', () => {
    // A stand-in MCP server: answers `initialize`, then idles until stdin closes.
    const FAKE = `
    let b = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      b += d; let i;
      while ((i = b.indexOf('\\n')) >= 0) {
        const line = b.slice(0, i); b = b.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { serverInfo: { name: 'fake', version: '0' } } }) + '\\n');
      }
    });
    process.stdin.on('end', () => process.exit(0));
  `;
    const waitExit = async (c) => {
        for (let i = 0; i < 100 && !c.exited; i++)
            await new Promise((r) => setTimeout(r, 50));
    };
    it('writes .vodou/run/browser-hands.pid while running and removes it on exit', async () => {
        const { McpStdioClient } = await import('../browser-hands/mcp-stdio.js');
        const { pidFilePath } = await import('../browser-hands/backend.js');
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-pid-'));
        const pf = pidFilePath(tmp);
        expect(pf).toBe(path.join(tmp, '.vodou', 'run', 'browser-hands.pid'));
        const c = new McpStdioClient(process.execPath, ['-e', FAKE], process.env, pf);
        await c.start(10_000);
        expect(Number(fs.readFileSync(pf, 'utf8').trim())).toBeGreaterThan(0);
        c.close();
        await waitExit(c);
        expect(c.exited).not.toBeNull();
        expect(fs.existsSync(pf)).toBe(false);
        fs.rmSync(tmp, { recursive: true, force: true });
    }, 20_000);
    it('a throwaway server (no pid file, e.g. the doctor) never touches the errand server\'s file', async () => {
        const { McpStdioClient } = await import('../browser-hands/mcp-stdio.js');
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-pid-'));
        const pf = path.join(tmp, '.vodou', 'run', 'browser-hands.pid');
        fs.mkdirSync(path.dirname(pf), { recursive: true });
        fs.writeFileSync(pf, '424242\n');
        const c = new McpStdioClient(process.execPath, ['-e', FAKE], process.env);
        await c.start(10_000);
        c.close();
        await waitExit(c);
        expect(c.exited).not.toBeNull();
        expect(fs.readFileSync(pf, 'utf8').trim()).toBe('424242');
        fs.rmSync(tmp, { recursive: true, force: true });
    }, 20_000);
});
