/**
 * G5 of PLAN-INVITE-ROLLOUT — "keep my Mac awake on power".
 *
 * The failure it prevents: someone texts Vodou, their Mac is asleep, and they
 * get the cloud's "your computer looks offline" instead of their own Vodou —
 * or, before APP #59, silence ("hello?? are you frozen" is the screenshot the
 * rollout plan fears most). A Mac on its charger can simply stay awake.
 *
 * How: macOS's own `caffeinate -s`, which holds a "prevent system sleep"
 * assertion that is honoured ONLY while on AC power — on battery the Mac
 * sleeps exactly as it always did, so this can't drain a laptop in a bag. The
 * display still sleeps (no -d), so the screen isn't left lit. `-w <gateway
 * pid>` ties it to this gateway: when the gateway exits, for any reason,
 * caffeinate exits with it, so it can never outlive Vodou or be orphaned. No
 * admin password (unlike `pmset`), nothing written to system settings.
 *
 * Not covered, and said so in the UI: closing a laptop's lid still sleeps it
 * (macOS forces that unless an external display is attached).
 *
 * Windows and Linux (PLAN-BROWSER-HANDS §14.7, "work on anyone's system"): no
 * caffeinate, so a tiny helper with the same three promises — AC power only,
 * dies with the gateway, needs no admin rights:
 *   - Windows: a hidden PowerShell loop that calls SetThreadExecutionState
 *     (ES_CONTINUOUS|ES_SYSTEM_REQUIRED) while PowerLineStatus is Online and
 *     clears it on battery, re-checking every 30 s, and exits when the gateway's
 *     pid is gone (an execution state dies with its thread, so nothing lingers).
 *   - Linux: a `sh` loop that, while on mains power (/sys/class/power_supply
 *     type Mains, online=1; no Mains supply = a desktop = always), takes a
 *     31-second `systemd-inhibit --what=sleep` every 30 s. Each inhibitor ends on
 *     its own, so neither a gateway crash nor unplugging can leave one behind.
 *     Unsupported where systemd-inhibit is missing.
 *
 * State: gateway setting `keep_awake_on_power` = '1' | '0'; absent = never
 * asked (the /simple offer shows once). Registered in processes.toml
 * (`keep-awake`, owner: gateway, optional), found through its pid file
 * `.vodou/run/keep-awake.pid` — written while it runs, removed when it stops.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFileSync } from 'child_process';
import { getSetting, setSetting, getProjectRoot } from './db.js';
export const KEEP_AWAKE_SETTING = 'keep_awake_on_power';
const defaultDeps = () => ({
    platform: process.platform,
    pid: process.pid,
    spawnImpl: (cmd, args) => spawn(cmd, args, { stdio: 'ignore', windowsHide: true }),
    get: getSetting,
    set: setSetting,
    powerSource: () => powerSourceFor(process.platform),
    log: (...a) => console.error('[keep-awake]', ...a),
    pidFile: () => path.join(getProjectRoot(), '.vodou', 'run', 'keep-awake.pid'),
    hasInhibit: () => {
        try {
            execFileSync('which', ['systemd-inhibit'], { stdio: 'ignore', timeout: 3000 });
            return true;
        }
        catch {
            return false;
        }
    },
});
function powerSourceFor(platform) {
    try {
        if (platform === 'darwin') {
            const out = execFileSync('/usr/bin/pmset', ['-g', 'batt'], { encoding: 'utf8', timeout: 3000 });
            if (/'AC Power'/.test(out))
                return 'ac';
            if (/'Battery Power'/.test(out))
                return 'battery';
        }
        else if (platform === 'win32') {
            const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
                'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
            if (/Online/.test(out))
                return 'ac';
            if (/Offline/.test(out))
                return 'battery';
        }
        else if (platform === 'linux') {
            const dir = '/sys/class/power_supply';
            const mains = fs.readdirSync(dir).filter((d) => { try {
                return fs.readFileSync(path.join(dir, d, 'type'), 'utf8').trim() === 'Mains';
            }
            catch {
                return false;
            } });
            if (!mains.length)
                return 'ac'; // a desktop: always on mains
            return mains.some((d) => { try {
                return fs.readFileSync(path.join(dir, d, 'online'), 'utf8').trim() === '1';
            }
            catch {
                return false;
            } }) ? 'ac' : 'battery';
        }
    }
    catch { /* unknown */ }
    return null;
}
/** The helper that holds the machine awake, per platform. Exported for tests. */
export function keepAwakeCommand(platform, gatewayPid) {
    if (platform === 'darwin')
        return { cmd: '/usr/bin/caffeinate', args: ['-s', '-w', String(gatewayPid)] };
    if (platform === 'win32') {
        // -EncodedCommand (UTF-16LE base64): a multi-line script survives Windows
        // argument quoting intact, which a -Command string with quotes does not.
        const ps = [
            "$ErrorActionPreference = 'SilentlyContinue'",
            "Add-Type -Namespace Vodou -Name Power -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(int f);'",
            'Add-Type -AssemblyName System.Windows.Forms',
            `while (Get-Process -Id ${gatewayPid}) {`,
            "  if ([System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus -ne 'Offline') {",
            // int, not uint: PowerShell reads 0x80000001 as a NEGATIVE Int32, and passing it
            // to a uint parameter throws — the same bits go through an int unchanged.
            '    [void][Vodou.Power]::SetThreadExecutionState(0x80000001)',
            '  } else {',
            '    [void][Vodou.Power]::SetThreadExecutionState(0x80000000)',
            '  }',
            '  Start-Sleep -Seconds 30',
            '}',
        ].join('\r\n');
        return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')] };
    }
    if (platform === 'linux') {
        const sh = [
            'P=$1',
            'while kill -0 "$P" 2>/dev/null; do',
            '  ac=1; m=0',
            '  for d in /sys/class/power_supply/*; do',
            '    [ "$(cat "$d/type" 2>/dev/null)" = Mains ] || continue',
            '    [ $m = 0 ] && ac=0; m=1',
            '    [ "$(cat "$d/online" 2>/dev/null)" = 1 ] && ac=1',
            '  done',
            '  [ $ac = 1 ] && systemd-inhibit --what=sleep --who=Vodou --why="Answering your texts while plugged in" --mode=block sleep 31 >/dev/null 2>&1 &',
            '  sleep 30',
            'done',
        ].join('\n');
        return { cmd: '/bin/sh', args: ['-c', sh, 'vodou-keep-awake', String(gatewayPid)] };
    }
    return null;
}
/** How the UI names this machine: "keep this Mac / PC / computer awake". */
export function deviceWord(platform) {
    return platform === 'darwin' ? 'Mac' : platform === 'win32' ? 'PC' : 'computer';
}
function writePid(pid) {
    if (!pid)
        return;
    try {
        const f = deps.pidFile();
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, `${pid}\n`);
    }
    catch { /* the registry then reads it as absent; keep-awake still works */ }
}
function clearPid() {
    try {
        fs.unlinkSync(deps.pidFile());
    }
    catch { /* not there */ }
}
let child = null;
let deps = defaultDeps();
/** Tests only: swap the wires and forget any running child. */
export function _setKeepAwakeDeps(d) {
    child = null;
    deps = d ? { ...defaultDeps(), ...d } : defaultDeps();
}
export function keepAwakeSupported() {
    if (deps.platform === 'darwin' || deps.platform === 'win32')
        return true;
    return deps.platform === 'linux' && deps.hasInhibit();
}
/** true / false once chosen; null = never asked. */
export function keepAwakeChoice() {
    const v = deps.get(KEEP_AWAKE_SETTING);
    return v === '1' ? true : v === '0' ? false : null;
}
export function keepAwakeRunning() {
    return !!child && child.exitCode === null && !child.killed;
}
/** Make reality match the setting: start or stop the one caffeinate. Idempotent. */
export function applyKeepAwake() {
    const want = keepAwakeSupported() && keepAwakeChoice() === true;
    if (want && !keepAwakeRunning()) {
        try {
            const h = keepAwakeCommand(deps.platform, deps.pid);
            const c = deps.spawnImpl(h.cmd, h.args);
            child = c;
            writePid(c.pid);
            c.on?.('exit', () => { if (child === c) {
                child = null;
                clearPid();
            } });
            c.on?.('error', (e) => { deps.log(`could not start ${h.cmd}:`, e.message); if (child === c) {
                child = null;
                clearPid();
            } });
            deps.log(`on — this ${deviceWord(deps.platform)} stays awake while plugged in`);
        }
        catch (e) {
            deps.log('could not start keep-awake:', e instanceof Error ? e.message : String(e));
            child = null;
        }
    }
    else if (!want && child) {
        try {
            child.kill();
        }
        catch { /* already gone */ }
        child = null;
        clearPid();
        deps.log('off');
    }
    else if (!want) {
        // A pid file left by a gateway that died while keep-awake was on (its
        // caffeinate died with it, via -w). Nothing runs now; say so.
        clearPid();
    }
}
/** Record the person's choice and apply it. */
export function setKeepAwake(enabled) {
    deps.set(KEEP_AWAKE_SETTING, enabled ? '1' : '0');
    applyKeepAwake();
}
export function keepAwakeStatus() {
    const supported = keepAwakeSupported();
    return {
        supported,
        enabled: keepAwakeChoice(),
        running: keepAwakeRunning(),
        power: supported ? deps.powerSource() : null,
        device: deviceWord(deps.platform),
    };
}
