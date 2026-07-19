import { spawn, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getProjectRoot } from '../db.js';
export const LLAMACPP_PORT = parseInt(process.env.VODOU_LLAMACPP_PORT || '11436', 10);
const BASE_URL = `http://127.0.0.1:${LLAMACPP_PORT}`;
// Module-singleton view of the running server (best-effort; pid file is the truth).
let _running = null;
function pidFilePath() {
    return path.join(getProjectRoot(), '.vodou', 'run', 'llama-server.pid');
}
function logFilePath() {
    return path.join(getProjectRoot(), '.vodou', 'llama-server.log');
}
/** Resolve the llama-server binary: vendored (pinned/codesigned) → PATH.
 *  Reversed vs llmfit — here the vendored artifact is the known-good one and a
 *  random PATH copy is a compat risk. */
export function resolveLlamaServerBin() {
    const isWin = process.platform === 'win32';
    const binName = isWin ? 'llama-server.exe' : 'llama-server';
    const vendored = path.join(getProjectRoot(), 'vendor', 'llamacpp', binName);
    if (fs.existsSync(vendored))
        return vendored;
    // PATH fallback (dev boxes without a bundle who `brew install llama.cpp`).
    try {
        const probe = execSync(`${isWin ? 'where' : 'which'} ${binName}`, { stdio: 'pipe', timeout: 3000 }).toString().trim();
        if (probe)
            return isWin ? probe.split(/\r?\n/)[0] : probe;
    }
    catch { /* not on PATH */ }
    return null;
}
/** Read the pid file → the pid if that process is alive, else null (and clean up). */
function readLivePid() {
    try {
        const raw = fs.readFileSync(pidFilePath(), 'utf-8').trim();
        const pid = parseInt(raw, 10);
        if (!pid)
            return null;
        process.kill(pid, 0); // throws if not alive
        return pid;
    }
    catch {
        return null;
    }
}
async function probeHealth(timeoutMs = 2500) {
    try {
        const resp = await fetch(BASE_URL + '/health', { signal: AbortSignal.timeout(timeoutMs) });
        if (resp.ok)
            return 'ok'; // 200 → model loaded, ready
        if (resp.status === 503)
            return 'loading'; // still loading / downloading weights
        return 'down';
    }
    catch {
        return 'down';
    }
}
/** Stop the running server (pid-file kill). Idempotent.
 *  llama-server releases the port on SIGTERM but can take several seconds to
 *  fully exit (flushing) — so escalate to SIGKILL if it's still alive, matching
 *  the gateway's own SIGTERM→SIGKILL teardown discipline (425-process rule). */
export async function stopLlamaServer() {
    const pid = readLivePid();
    if (pid) {
        try {
            process.kill(pid, 'SIGTERM');
        }
        catch { }
        // Grace, then SIGKILL if it hasn't exited.
        for (let i = 0; i < 6; i++) {
            await new Promise((r) => setTimeout(r, 500));
            try {
                process.kill(pid, 0);
            }
            catch {
                break;
            } // gone
            if (i === 5) {
                try {
                    process.kill(pid, 'SIGKILL');
                }
                catch { }
            }
        }
    }
    try {
        fs.rmSync(pidFilePath(), { force: true });
    }
    catch { }
    _running = null;
    return !!pid;
}
/**
 * Ensure a server is running for `modelRef`. Singleton: if a different model is
 * loaded, stop it first. Returns the post-spawn state. Does NOT block on a full
 * weight download — the readiness endpoint reports `downloading`/`starting`.
 */
export async function startLlamaServer(modelRef) {
    const bin = resolveLlamaServerBin();
    if (!bin)
        return 'no_binary';
    if (!modelRef)
        return 'starting';
    // Already serving the requested model?
    const health = await probeHealth();
    const livePid = readLivePid();
    if (livePid && _running && _running.modelRef === modelRef && health === 'ok')
        return 'ready';
    // Different model (or stale) → tear down before starting the new one.
    if (livePid && (!_running || _running.modelRef !== modelRef)) {
        await stopLlamaServer();
    }
    else if (livePid && health !== 'down') {
        // Same model, currently loading/downloading — don't double-spawn.
        return health === 'loading' ? 'downloading' : 'ready';
    }
    const root = getProjectRoot();
    fs.mkdirSync(path.join(root, '.vodou', 'run'), { recursive: true });
    const logFd = fs.openSync(logFilePath(), 'a');
    // Bind loopback ONLY — never LAN-exposed (gateway security boundary).
    const child = spawn(bin, ['-hf', modelRef, '--port', String(LLAMACPP_PORT), '--host', '127.0.0.1'], { stdio: ['ignore', logFd, logFd], detached: true, cwd: root });
    child.unref();
    if (child.pid) {
        fs.writeFileSync(pidFilePath(), String(child.pid));
        _running = { pid: child.pid, modelRef };
    }
    // Brief re-probe: first run downloads weights (503) → report downloading.
    await new Promise((r) => setTimeout(r, 1500));
    const after = await probeHealth();
    if (after === 'ok')
        return 'ready';
    if (after === 'loading')
        return 'downloading';
    return 'starting';
}
/** Readiness handler for `case 'llamacpp'` in the settings readiness route. */
export async function llamacppReadiness(settings, provider, res) {
    // 1. Already serving?
    const health = await probeHealth();
    if (health === 'ok') {
        res.json({ ready: true, provider, status: 'ready', message: 'Vodou Local (llama.cpp) is running' });
        return;
    }
    const bin = resolveLlamaServerBin();
    const modelRef = settings.llamacpp_model || '';
    // 2. Binary missing (dev checkout, no fetch run).
    if (!bin) {
        res.json({
            ready: false, provider, status: 'unavailable',
            message: 'llama.cpp not bundled. Dev checkout: run scripts/fetch-llamacpp.sh',
        });
        return;
    }
    // 3. No model selected yet.
    if (!modelRef) {
        res.json({ ready: false, provider, status: 'unconfigured', message: 'Pick a model for Vodou Local, then refresh.' });
        return;
    }
    // 4. Currently loading/downloading (server up, /health 503).
    if (health === 'loading') {
        res.json({ ready: false, provider, status: 'downloading', message: `Loading ${modelRef}… (first run downloads weights)`, action: 'llamacpp_loading' });
        return;
    }
    // 5. Binary + model present, server down → start it.
    const state = await startLlamaServer(modelRef);
    if (state === 'ready') {
        res.json({ ready: true, provider, status: 'ready', message: 'Vodou Local (llama.cpp) started', action: 'started_llamacpp' });
    }
    else if (state === 'downloading') {
        res.json({ ready: false, provider, status: 'downloading', message: `Downloading ${modelRef} from HuggingFace… refresh in a bit`, action: 'started_llamacpp' });
    }
    else if (state === 'no_binary') {
        res.json({ ready: false, provider, status: 'unavailable', message: 'llama.cpp not bundled. Run scripts/fetch-llamacpp.sh' });
    }
    else {
        res.json({ ready: false, provider, status: 'starting', message: 'Vodou Local is starting up… refresh in a few seconds', action: 'started_llamacpp' });
    }
}
// ─── Downloaded-model cache management ───────────────────────────────────────
// `-hf` weights land in the HuggingFace hub cache (~/.cache/huggingface/hub/
// models--<org>--<repo>), which is SHARED with Vodou's other HF models (BGE
// reranker/embeddings). So we only ever touch entries whose repo name carries
// the `GGUF` marker — llama.cpp downloads — and never the non-GGUF models.
// The cache never self-prunes; this powers the card's size readout + clear button.
function hubCacheDir() {
    const hfHome = process.env.HF_HOME || process.env.HUGGINGFACE_HUB_CACHE;
    if (process.env.HF_HUB_CACHE)
        return process.env.HF_HUB_CACHE;
    if (hfHome)
        return path.join(hfHome, 'hub');
    return path.join(os.homedir(), '.cache', 'huggingface', 'hub');
}
function dirSizeBytes(p) {
    let total = 0;
    let entries;
    try {
        entries = fs.readdirSync(p, { withFileTypes: true });
    }
    catch {
        return 0;
    }
    for (const e of entries) {
        const full = path.join(p, e.name);
        try {
            if (e.isDirectory())
                total += dirSizeBytes(full);
            else if (e.isFile())
                total += fs.statSync(full).size;
            // symlinks (HF blobs are symlinked from snapshots) are followed via the
            // blobs dir walk; don't double-count — statSync on the link target is skipped
            // for isFile() checks above since Dirent.isFile() is false for symlinks.
        }
        catch { /* skip unreadable */ }
    }
    return total;
}
/** GGUF model dirs in the hub cache (llama.cpp downloads only). */
function listGgufModelDirs() {
    const hub = hubCacheDir();
    let entries;
    try {
        entries = fs.readdirSync(hub);
    }
    catch {
        return [];
    }
    return entries
        .filter((n) => n.startsWith('models--') && /gguf/i.test(n))
        .map((n) => {
        const dir = path.join(hub, n);
        // HF cache dir → readable repo id: models--org--repo → org/repo
        const name = n.replace(/^models--/, '').replace(/--/g, '/');
        return { name, dir, bytes: dirSizeBytes(dir) };
    });
}
function humanBytes(b) {
    if (b < 1024)
        return `${b} B`;
    const u = ['KB', 'MB', 'GB', 'TB'];
    let v = b / 1024, i = 0;
    while (v >= 1024 && i < u.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}
/** Cache readout for the card: per-model + total (GGUF downloads only). */
export function getModelCacheInfo() {
    const dirs = listGgufModelDirs();
    const totalBytes = dirs.reduce((s, d) => s + d.bytes, 0);
    return {
        totalBytes,
        totalHuman: humanBytes(totalBytes),
        models: dirs.map((d) => ({ name: d.name, sizeHuman: humanBytes(d.bytes) })),
    };
}
/** Delete downloaded GGUF weights. Stops the server first (loaded model holds
 *  open file handles). Only removes GGUF-marked dirs — never shared HF models. */
export async function clearModelCache() {
    await stopLlamaServer(); // release file handles before rm
    const dirs = listGgufModelDirs();
    const cleared = [];
    let freedBytes = 0;
    for (const d of dirs) {
        try {
            fs.rmSync(d.dir, { recursive: true, force: true });
            cleared.push(d.name);
            freedBytes += d.bytes;
        }
        catch { /* skip; report what succeeded */ }
    }
    return { cleared, freedBytes };
}
