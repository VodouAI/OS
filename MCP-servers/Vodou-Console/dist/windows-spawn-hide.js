// windows-spawn-hide — on Windows, default `windowsHide: true` for EVERY
// child_process call so background helpers (vodou-core.exe ensure/probes/tool
// calls, MCP server subprocesses, hook spawns) don't flash phantom console
// windows. One patch covers all ~97 spawn/exec sites.
//
// MUST be imported FIRST in index.ts, before anything that spawns. On non-Windows
// this is a no-op. Uses createRequire so we mutate the CJS child_process exports
// that the ESM `import { spawn } from 'child_process'` named bindings alias
// (Node exposes CJS named exports as live bindings — mutating them here is
// reflected at every call site).
import { createRequire } from 'module';
if (process.platform === 'win32') {
    const require = createRequire(import.meta.url);
    const cp = require('child_process');
    const wrap = (orig) => function (...args) {
        // Locate the options object: scan from the end, skipping a trailing
        // callback; stop at an args array (means no options were passed).
        let optIdx = -1;
        for (let i = args.length - 1; i >= 1; i--) {
            const a = args[i];
            if (typeof a === 'function')
                continue; // callback
            if (Array.isArray(a))
                break; // args array reached → no options
            if (a && typeof a === 'object') {
                optIdx = i;
                break;
            }
        }
        if (optIdx >= 0) {
            if (args[optIdx].windowsHide === undefined) {
                args[optIdx] = { ...args[optIdx], windowsHide: true };
            }
        }
        else {
            const cbIdx = args.findIndex((a) => typeof a === 'function');
            const opts = { windowsHide: true };
            if (cbIdx >= 0)
                args.splice(cbIdx, 0, opts);
            else
                args.push(opts);
        }
        return orig.apply(this, args);
    };
    for (const m of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
        if (typeof cp[m] === 'function')
            cp[m] = wrap(cp[m]);
    }
}
