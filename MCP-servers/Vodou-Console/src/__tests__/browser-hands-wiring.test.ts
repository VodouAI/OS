import { describe, it, expect, afterEach } from 'vitest';
import { getActiveTools, getTool, VODOU_TOOLS } from '../tools.js';
import { browserHandsEnabled } from '../browser-hands/flag.js';
import { startBrowserTask, handleBrowserReply, tryBrowserHandsReply, takeBrowserHandsToolCalls } from '../browser-hands/service.js';
import * as fs from 'fs';
import * as path from 'path';

// PLAN-BROWSER-HANDS: off unless VODOU_BROWSER_HANDS=1, and OFF MEANS NOTHING
// CHANGED — the tool surface is byte-identical and the approval path is untouched.

const saved = process.env.VODOU_BROWSER_HANDS;
afterEach(() => { if (saved === undefined) delete process.env.VODOU_BROWSER_HANDS; else process.env.VODOU_BROWSER_HANDS = saved; });

describe('the flag', () => {
  it('reads 1 / true / on, nothing else', () => {
    for (const v of ['1', 'true', 'on', 'ON']) expect(browserHandsEnabled({ VODOU_BROWSER_HANDS: v } as any)).toBe(true);
    for (const v of ['', '0', 'false', 'yes']) expect(browserHandsEnabled({ VODOU_BROWSER_HANDS: v } as any)).toBe(false);
    expect(browserHandsEnabled({} as any)).toBe(false);
  });
});

describe('tool surface', () => {
  it('flag off: identical to today (no browser_task anywhere)', () => {
    delete process.env.VODOU_BROWSER_HANDS;
    expect(getActiveTools()).toBe(VODOU_TOOLS);
    expect(getActiveTools().some((t) => t.name === 'browser_task')).toBe(false);
  });
  it('flag on: browser_task is offered, with goal + start_url required', () => {
    process.env.VODOU_BROWSER_HANDS = '1';
    const t = getActiveTools().find((x) => x.name === 'browser_task');
    expect(t).toBeTruthy();
    expect((t!.input_schema as any).required).toEqual(['goal', 'start_url']);
    expect(getTool('browser_task')?.name).toBe('browser_task');
  });
});

describe('the reply hook never interferes when there is no errand', () => {
  it('flag off: nothing is routed, a "yes" falls through to approvals.ts as before', async () => {
    delete process.env.VODOU_BROWSER_HANDS;
    expect(await handleBrowserReply('conv-x', 'yes')).toBeNull();
    expect(await tryBrowserHandsReply('yes', 'conv-x')).toBeNull();
  });
  it('flag on but no task: still null', async () => {
    process.env.VODOU_BROWSER_HANDS = '1';
    expect(await tryBrowserHandsReply('yes', `conv-none-${Date.now()}`)).toBeNull();
    expect(takeBrowserHandsToolCalls('conv-none')).toEqual([]);
  });
  it('flag off: the tool itself declines politely', async () => {
    delete process.env.VODOU_BROWSER_HANDS;
    const r = await startBrowserTask({ conversationId: 'c', goal: 'book', startUrl: 'https://www.opentable.com/' });
    expect(r.text).toMatch(/not switched on/);
  });
});

describe('index.ts wiring (a static check: the hook sits first in tryApprovalReply)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
  it('checks the browser errand before approvals.ts', () => {
    const fn = src.slice(src.indexOf('async function tryApprovalReply'), src.indexOf('async function tryApprovalReply') + 800);
    expect(fn.indexOf('tryBrowserHandsReply')).toBeGreaterThan(0);
    expect(fn.indexOf('tryBrowserHandsReply')).toBeLessThan(fn.indexOf('parseApprovalReply'));
  });
  it('hands gate/proof screenshots to the phone in the early-return toolCalls', () => {
    expect(src).toMatch(/toolCalls: takeBrowserHandsToolCalls\(convId\)/);
  });
});
