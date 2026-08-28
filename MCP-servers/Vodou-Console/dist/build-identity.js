/**
 * COHERENCE F14 — which build is this gateway running?
 *
 * The Rust side answers this for the daemon and the worker
 * (`src/build_identity.rs`); this is the same answer for the third long-lived
 * process. The gateway is the one that wedged on 2026-08-20, and the one whose
 * source has twice outrun its build — and until now nothing it served could
 * say which `dist/` was actually in memory.
 *
 * Stamped once at import time, which is process start. Reading the mtime later
 * would describe whatever `tsc` wrote since, and report a stale process as
 * current — the exact failure this exists to catch.
 *
 * Time canon: stamps are naive UTC; a reader renders them local.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
function naiveUtc(d) {
    return d.toISOString().slice(0, 19).replace('T', ' ');
}
function stampOf(p) {
    try {
        const st = fs.statSync(p);
        return { size: st.size, mtime: naiveUtc(st.mtime) };
    }
    catch {
        return null;
    }
}
/** Newest mtime under a directory, or null when it isn't there (a shipped install). */
function newestUnder(dir, exts, depth = 0) {
    if (depth > 4)
        return null;
    let newest = null;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return null;
    }
    for (const e of entries) {
        if (e.name === 'node_modules' || e.name.startsWith('.'))
            continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            const sub = newestUnder(p, exts, depth + 1);
            if (sub && (!newest || sub > newest))
                newest = sub;
        }
        else if (exts.some((x) => e.name.endsWith(x))) {
            const s = stampOf(p);
            if (s && (!newest || s.mtime > newest))
                newest = s.mtime;
        }
    }
    return newest;
}
const here = path.dirname(fileURLToPath(import.meta.url));
/** dist/ when running the build, src/ when running from ts-node — either way, our own file. */
const entry = path.join(here, 'index.js');
const projectDir = path.resolve(here, '..');
const bootStamp = stampOf(entry);
const bootedAt = naiveUtc(new Date());
const srcNewest = newestUnder(path.join(projectDir, 'src'), ['.ts', '.tsx']);
let version = '0.0.0-unknown';
try {
    version = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8')).version ?? version;
}
catch {
    /* a shipped install may not carry package.json */
}
/**
 * The gateway's identity. `staleOnDisk` is evaluated per call — it is the one
 * field that can change while we run, and it is the whole point.
 */
export function gatewayBuild() {
    const now = stampOf(entry);
    const staleOnDisk = !!bootStamp && !!now && (now.size !== bootStamp.size || now.mtime !== bootStamp.mtime);
    return {
        version,
        entry,
        size: bootStamp?.size ?? null,
        mtime: bootStamp?.mtime ?? null,
        startedAt: bootedAt,
        pid: process.pid,
        node: process.version,
        staleOnDisk,
        srcNewest,
        srcTouchedAfterBuild: !!srcNewest && !!bootStamp && srcNewest > bootStamp.mtime,
    };
}
/** The same verdict as sentences, for any surface that shows hints to a person. */
export function gatewayBuildHints(b = gatewayBuild()) {
    const hints = [];
    if (b.staleOnDisk) {
        hints.push(`The gateway is running a build that is no longer on disk — it loaded ${b.entry} as it stood at ${b.mtime}, and something rebuilt it since. Restart the gateway to serve what you just built.`);
    }
    if (b.srcTouchedAfterBuild) {
        hints.push(`The console's newest source file is dated after the build this process loaded — src/ at ${b.srcNewest}, dist at ${b.mtime}. mtime moves on a checkout as well as on an edit, so this is a prompt rather than a verdict: rebuild and restart before concluding that the code you are reading is the code that is running.`);
    }
    return hints;
}
