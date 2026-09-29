/**
 * Browser Hands backend 2 (PLAN-BROWSER-HANDS §3.3, §13.6, §14.2): Vodou's own
 * browser — Chrome (or Edge/Brave/Chromium, or a Vodou-fetched Chrome for
 * Testing) launched by Vodou with ITS OWN profile, driven through a pinned,
 * vendored chrome-devtools-mcp.
 *
 * Measured 2026-09-28 (probe against chrome-devtools-mcp 1.10.1):
 *   - OpenTable refuses HEADLESS Chrome (net::ERR_HTTP2_PROTOCOL_ERROR) and loads
 *     in a normal window, so backend 2 runs headed (a real window).
 *   - The server's default profile (~/.cache/chrome-devtools-mcp/chrome-profile)
 *     is shared with any other chrome-devtools-mcp on the machine; a second
 *     launch fails "The browser is already running". Vodou's lives under .vodou/.
 *   - It sends usage statistics to Google and checks npm for updates unless told
 *     not to; both are off here (flags + env).
 *   - With the flags below it exposes 21 tools (59 by default); evaluate_script
 *     is gone at the source.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { getProjectRoot } from '../db.js';
import { McpStdioClient } from './mcp-stdio.js';
export const CDM_VERSION = '1.10.1';
const defaultDeps = () => ({
    platform: process.platform,
    env: process.env,
    exists: (p) => { try {
        return fs.statSync(p).isFile();
    }
    catch {
        return false;
    } },
    which: (name) => {
        try {
            return execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).split(/\r?\n/)[0].trim() || null;
        }
        catch {
            return null;
        }
    },
    root: getProjectRoot(),
});
/** Where a Vodou-fetched Chrome for Testing lives (§14.2). */
export function cftExecutable(root, platform) {
    const base = path.join(root, '.vodou', 'browser');
    if (platform === 'darwin')
        return path.join(base, 'chrome', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
    if (platform === 'win32')
        return path.join(base, 'chrome', 'chrome.exe');
    return path.join(base, 'chrome', 'chrome');
}
/** Find a Chromium-family browser. Order: Vodou's own Chrome for Testing, then what the person has. */
export function resolveBrowser(deps = defaultDeps()) {
    const { platform, env, exists, which, root } = deps;
    const cft = cftExecutable(root, platform);
    if (exists(cft))
        return { path: cft, kind: 'chrome-for-testing' };
    const cands = [];
    if (platform === 'darwin') {
        const apps = ['/Applications', path.join(env.HOME || os.homedir(), 'Applications')];
        for (const a of apps) {
            cands.push({ path: `${a}/Google Chrome.app/Contents/MacOS/Google Chrome`, kind: 'chrome' });
            cands.push({ path: `${a}/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`, kind: 'edge' });
            cands.push({ path: `${a}/Brave Browser.app/Contents/MacOS/Brave Browser`, kind: 'brave' });
            cands.push({ path: `${a}/Chromium.app/Contents/MacOS/Chromium`, kind: 'chromium' });
        }
    }
    else if (platform === 'win32') {
        const pf = env.ProgramFiles || 'C:\\Program Files';
        const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        const local = env.LOCALAPPDATA || path.join(env.USERPROFILE || 'C:\\Users\\Default', 'AppData', 'Local');
        for (const b of [pf, pf86, local])
            cands.push({ path: path.win32.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe'), kind: 'chrome' });
        for (const b of [pf86, pf])
            cands.push({ path: path.win32.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), kind: 'edge' });
        for (const b of [pf, local])
            cands.push({ path: path.win32.join(b, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), kind: 'brave' });
    }
    else {
        for (const [name, kind] of [['google-chrome', 'chrome'], ['google-chrome-stable', 'chrome'], ['microsoft-edge', 'edge'], ['brave-browser', 'brave'], ['chromium', 'chromium'], ['chromium-browser', 'chromium']]) {
            const p = which(name);
            if (p)
                cands.push({ path: p, kind });
        }
    }
    return cands.find((c) => exists(c.path)) ?? null;
}
/**
 * Where the errand server's pid is published while it runs (processes.toml
 * `browser-hands`). The Chrome it drives is its child and exits with it.
 */
export function pidFilePath(root = getProjectRoot()) {
    return path.join(root, '.vodou', 'run', 'browser-hands.pid');
}
export function profileDir(root = getProjectRoot()) {
    return path.join(root, '.vodou', 'browser-profile');
}
/** The vendored, pinned chrome-devtools-mcp entry point. */
export function cdmEntry(root = getProjectRoot()) {
    return path.join(root, 'MCP-servers', 'chrome-devtools-mcp', 'node_modules', 'chrome-devtools-mcp', 'build', 'src', 'bin', 'chrome-devtools-mcp.js');
}
/** The exact flags. Kept in one place so the preset, the seed registration and this agree (§14.5). */
export function launchArgs(o) {
    const a = [
        `--executablePath=${o.executablePath}`,
        o.isolated ? '--isolated' : `--userDataDir=${o.profile}`,
        '--usageStatistics=false',
        '--performanceCrux=false',
        '--javascriptEvaluation=false',
        '--categoryPerformance=false',
        '--categoryNetwork=false',
        '--categoryMemory=false',
        '--categoryEmulation=false',
        '--categoryPwa=false',
        '--screenshotFormat=jpeg',
        '--screenshotQuality=80',
        '--screenshotMaxWidth=1600',
        '--screenshotMaxHeight=4000',
        '--redactNetworkHeaders=true',
    ];
    if (o.headless)
        a.push('--headless');
    for (const p of o.allowedUrlPatterns ?? [])
        a.push(`--allowedUrlPattern=${p}`);
    return a;
}
export function launchEnv(base = process.env) {
    return {
        ...base,
        CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
        CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
    };
}
/** Start chrome-devtools-mcp for backend 2. The browser itself opens on the first page call. */
export async function startBackend(o, node = process.execPath, root = getProjectRoot()) {
    fs.mkdirSync(o.profile, { recursive: true, mode: 0o700 });
    try {
        fs.chmodSync(o.profile, 0o700);
    }
    catch { /* best effort on Windows */ }
    // Only the errand server (Vodou's real profile) is a registered process; the
    // doctor's isolated, throwaway check is not, and must not clobber its pid.
    const client = new McpStdioClient(node, [cdmEntry(root), ...launchArgs(o)], launchEnv(), o.isolated ? undefined : pidFilePath(root));
    await client.start();
    return client;
}
