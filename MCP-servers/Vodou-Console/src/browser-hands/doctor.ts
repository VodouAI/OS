/**
 * Browser Hands doctor (PLAN-BROWSER-HANDS §14.3): can THIS install run
 * Vodou's browser? Graded like every other flow — no evidence is `unknown`,
 * never `ok`.
 *
 *   ok        a browser was found, launched, and returned a page snapshot
 *   degraded  a browser was found but failed to launch or snapshot (the reason says why)
 *   absent    no Chromium-family browser and no Vodou-fetched Chrome for Testing
 *   unknown   never checked
 *
 * The check runs headless with a throwaway profile against about:blank, so it
 * never flashes a window on the person's screen and never touches Vodou's real
 * profile. Errand starters and relay routing read the stored result.
 */
import * as fs from 'fs';
import { getSetting, setSetting } from '../db.js';
import { resolveBrowser, startBackend, profileDir, cdmEntry, CDM_VERSION, type ResolvedBrowser } from './backend.js';

export const STATUS_SETTING = 'browser_hands_status';

export interface BrowserStatus {
  state: 'ok' | 'degraded' | 'absent' | 'unknown';
  browser: ResolvedBrowser | null;
  serverVersion: string | null;
  toolCount: number | null;
  reason: string;
  checkedAt: string | null;
  ms: number | null;
}

export function readStatus(): BrowserStatus {
  const raw = getSetting(STATUS_SETTING);
  if (raw) { try { return JSON.parse(raw) as BrowserStatus; } catch { /* fall through */ } }
  return { state: 'unknown', browser: null, serverVersion: null, toolCount: null, reason: 'never checked', checkedAt: null, ms: null };
}

export interface CheckDeps {
  resolve: () => ResolvedBrowser | null;
  entryExists: () => boolean;
  start: typeof startBackend;
  save: (s: BrowserStatus) => void;
  now: () => Date;
}

const defaultDeps = (): CheckDeps => ({
  resolve: () => resolveBrowser(),
  entryExists: () => fs.existsSync(cdmEntry()),
  start: startBackend,
  save: (s) => setSetting(STATUS_SETTING, JSON.stringify(s)),
  now: () => new Date(),
});

export async function checkBrowser(deps: CheckDeps = defaultDeps()): Promise<BrowserStatus> {
  const t0 = Date.now();
  const at = deps.now().toISOString().replace('T', ' ').slice(0, 19); // naive UTC, the time canon
  const done = (s: Omit<BrowserStatus, 'checkedAt' | 'ms'>): BrowserStatus => {
    const full = { ...s, checkedAt: at, ms: Date.now() - t0 };
    deps.save(full);
    return full;
  };
  if (!deps.entryExists()) {
    return done({ state: 'degraded', browser: null, serverVersion: null, toolCount: null, reason: `chrome-devtools-mcp ${CDM_VERSION} is not installed (MCP-servers/chrome-devtools-mcp: run a plain npm install there)` });
  }
  const browser = deps.resolve();
  if (!browser) {
    return done({ state: 'absent', browser: null, serverVersion: null, toolCount: null, reason: 'no Chrome, Edge, Brave or Chromium found, and Vodou has not fetched its own browser yet' });
  }
  let client: Awaited<ReturnType<typeof startBackend>> | null = null;
  try {
    client = await deps.start({ executablePath: browser.path, profile: profileDir(), headless: true, isolated: true });
    const tools = await client.listTools();
    const page = await client.callTool('new_page', { url: 'about:blank', timeout: 20_000 }, 45_000);
    if (page.isError) throw new Error(page.text.slice(0, 200) || 'new_page failed');
    const m = page.text.match(/^(\d+):.*\[selected\]/m) || page.text.match(/^(\d+):/m);
    const snap = await client.callTool('take_snapshot', { pageId: m ? Number(m[1]) : 1 }, 30_000);
    if (snap.isError || !/RootWebArea/.test(snap.text)) throw new Error('no page snapshot came back');
    const info = (client as unknown as { serverInfo?: { version: string } }).serverInfo;
    return done({ state: 'ok', browser, serverVersion: info?.version ?? CDM_VERSION, toolCount: tools.length, reason: `launched ${browser.kind} and read a page` });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return done({ state: 'degraded', browser, serverVersion: null, toolCount: null, reason: `found ${browser.kind} but it did not run: ${why.slice(0, 240)}` });
  } finally {
    client?.close();
  }
}
