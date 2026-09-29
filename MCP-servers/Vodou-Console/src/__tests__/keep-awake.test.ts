import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  _setKeepAwakeDeps, applyKeepAwake, setKeepAwake, keepAwakeStatus, keepAwakeRunning, KEEP_AWAKE_SETTING,
} from '../keep-awake.js';

// G5 (PLAN-INVITE-ROLLOUT): "keep my Mac awake on power". What is pinned:
// caffeinate is started ONLY on a Mac and ONLY when the person said yes, with
// -s (AC power only — never drains a laptop) and -w <gateway pid> (it dies
// with the gateway); exactly one runs however often it's applied; saying no
// stops it; never-asked is reported as null so /simple offers once; and the
// pid file processes.toml reads is written while it runs and removed after.

class FakeChild extends EventEmitter {
  pid = 4242; exitCode: number | null = null; killed = false;
  kill() { this.killed = true; this.exitCode = 0; this.emit('exit', 0); return true; }
}

let store: Record<string, string>;
let spawned: Array<{ cmd: string; args: string[]; child: FakeChild }>;
let dir: string;
const pidFile = () => path.join(dir, 'run', 'keep-awake.pid');

function wire(platform = 'darwin', hasInhibit = true) {
  _setKeepAwakeDeps({
    platform, pid: 777,
    spawnImpl: (cmd, args) => { const child = new FakeChild(); spawned.push({ cmd, args, child }); return child as any; },
    get: (k) => store[k] ?? null,
    set: (k, v) => { store[k] = v; },
    powerSource: () => 'ac',
    log: () => {},
    pidFile,
    hasInhibit: () => hasInhibit,
  });
}

beforeEach(() => {
  store = {}; spawned = [];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vodou-awake-'));
  wire();
});
afterEach(() => { _setKeepAwakeDeps(null); fs.rmSync(dir, { recursive: true, force: true }); });

describe('keep this computer awake while plugged in', () => {
  it('never asked → reported as null (the /simple offer shows), nothing started', () => {
    applyKeepAwake();
    expect(spawned).toHaveLength(0);
    expect(keepAwakeStatus()).toEqual({ supported: true, enabled: null, running: false, power: 'ac', device: 'Mac' });
  });

  it('yes → one caffeinate: AC-power-only (-s), tied to the gateway (-w pid)', () => {
    setKeepAwake(true);
    expect(store[KEEP_AWAKE_SETTING]).toBe('1');
    expect(spawned).toHaveLength(1);
    expect(spawned[0].cmd).toBe('/usr/bin/caffeinate');
    expect(spawned[0].args).toEqual(['-s', '-w', '777']);
    expect(spawned[0].args).not.toContain('-d'); // the screen still sleeps
    expect(keepAwakeRunning()).toBe(true);
    expect(fs.readFileSync(pidFile(), 'utf8').trim()).toBe('4242');
  });

  it('applying again (every boot, every toggle) never starts a second one', () => {
    setKeepAwake(true); applyKeepAwake(); setKeepAwake(true);
    expect(spawned).toHaveLength(1);
  });

  it('no → stops it and removes the pid file', () => {
    setKeepAwake(true);
    setKeepAwake(false);
    expect(store[KEEP_AWAKE_SETTING]).toBe('0');
    expect(spawned[0].child.killed).toBe(true);
    expect(keepAwakeRunning()).toBe(false);
    expect(fs.existsSync(pidFile())).toBe(false);
    expect(keepAwakeStatus().enabled).toBe(false);
  });

  it('if caffeinate dies on its own, the next apply restarts it', () => {
    setKeepAwake(true);
    spawned[0].child.exitCode = 1; spawned[0].child.emit('exit', 1);
    expect(keepAwakeRunning()).toBe(false);
    applyKeepAwake();
    expect(spawned).toHaveLength(2);
  });

  it('a pid file left by a dead gateway is cleared when keep-awake is off', () => {
    fs.mkdirSync(path.dirname(pidFile()), { recursive: true });
    fs.writeFileSync(pidFile(), '999\n');
    store[KEEP_AWAKE_SETTING] = '0';
    applyKeepAwake();
    expect(fs.existsSync(pidFile())).toBe(false);
  });

  // PLAN-BROWSER-HANDS §14.7: Windows and Linux too. The helpers themselves were
  // run for real on 2026-09-28 — the Linux loop in a container (inhibits every
  // tick on mains, none on battery, exits with the gateway's pid), the PowerShell
  // script parsed by pwsh — see the H1d commit message.
  it('Windows → a hidden PowerShell helper holding ES_SYSTEM_REQUIRED only off battery, tied to the gateway pid', () => {
    wire('win32');
    store[KEEP_AWAKE_SETTING] = '1';
    applyKeepAwake();
    expect(spawned[0].cmd).toBe('powershell.exe');
    expect(spawned[0].args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand']);
    const script = Buffer.from(spawned[0].args[5], 'base64').toString('utf16le');
    expect(script).toContain('while (Get-Process -Id 777)');
    expect(script).toContain("PowerLineStatus -ne 'Offline'");
    expect(script).toContain('SetThreadExecutionState(int f)'); // int: 0x80000001 is a negative Int32 in PowerShell
    expect(keepAwakeStatus()).toMatchObject({ supported: true, running: true, device: 'PC' });
  });

  it('Linux with systemd-inhibit → a sh loop of short inhibitors, tied to the gateway pid', () => {
    wire('linux');
    store[KEEP_AWAKE_SETTING] = '1';
    applyKeepAwake();
    expect(spawned[0].cmd).toBe('/bin/sh');
    expect(spawned[0].args[0]).toBe('-c');
    expect(spawned[0].args[1]).toMatch(/systemd-inhibit --what=sleep .* sleep 31/);
    expect(spawned[0].args.slice(2)).toEqual(['vodou-keep-awake', '777']);
    expect(keepAwakeStatus()).toMatchObject({ device: 'computer' });
  });

  it('Linux without systemd-inhibit, or another OS → unsupported, never spawns even if the setting says yes', () => {
    for (const [platform, inhibit] of [['linux', false], ['freebsd', true]] as const) {
      spawned = [];
      wire(platform, inhibit);
      store[KEEP_AWAKE_SETTING] = '1';
      applyKeepAwake();
      expect(spawned).toHaveLength(0);
      expect(keepAwakeStatus()).toMatchObject({ supported: false, running: false, power: null });
    }
  });
});

describe('/simple asks once and never swallows an approval "yes"', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'simple', 'index.html'), 'utf8');
  it('offers after setup and on the next visit for people set up before, once per browser', () => {
    expect(html).toMatch(/loadAwake\(\)\.then\(function \(st\) \{ if \(st && st\.supported && st\.enabled === null\) offerAwake\(\); \}\)/);
    expect(html).toMatch(/vodou\.simple\.awakeAsked/);
  });
  it('anything new in the thread cancels the question before a "yes" can be read as its answer', () => {
    expect(html).toMatch(/\(chunk\|channel_user_message\|approval_requested\)\$\/\.test\(ev\.type\)\) awakeOffer = false/);
  });
  it('the + menu switch exists, hidden until the gateway says it is supported', () => {
    expect(html).toMatch(/id="awakeItem"[^>]*hidden/);
  });
});
