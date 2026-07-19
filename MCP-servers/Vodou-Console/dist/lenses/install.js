/**
 * Lens install / uninstall pipeline.
 *
 * PLAN-LENSES-MANAGEMENT §7 Phase 2 — given a git URL, clone the repo into
 * ~/.vodou/lenses/<id>/, validate the manifest, register it in
 * `installed_lenses`, hot-reload the registry. Uninstall is the inverse plus
 * cache + consent cleanup.
 *
 * No directory-side hash verification yet — that lands in Phase 4 with the
 * curated lenses-directory client. v2 installs are arbitrary-git-URL trust.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { getGatewayDb } from '../db.js';
import * as metadata from './metadata.js';
import { reloadRegistry, getRegistry } from './registry.js';
const USER_LENSES_DIR = process.env.VODOU_LENSES_DIR
    || path.join(homedir(), '.vodou', 'lenses');
function runGit(args, cwd, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
        const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        proc.stderr?.on('data', (d) => { stderr += d.toString(); });
        const timer = setTimeout(() => {
            try {
                proc.kill('SIGKILL');
            }
            catch { }
            reject(new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        proc.on('error', (e) => { clearTimeout(timer); reject(e); });
        proc.on('exit', (code) => {
            clearTimeout(timer);
            if (code === 0)
                resolve();
            else
                reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
        });
    });
}
/**
 * Read the manifest from a candidate lens dir without importing the module.
 * Two paths: a standalone manifest.json (canonical for community lenses) or
 * the manifest exported from index.js (built-ins, less common in installs).
 */
async function readManifestFromDir(dir) {
    const manifestJson = path.join(dir, 'manifest.json');
    if (fsSync.existsSync(manifestJson)) {
        const raw = await fs.readFile(manifestJson, 'utf8');
        return JSON.parse(raw);
    }
    // Fall back to importing index.js and reading mod.card.manifest
    const indexJs = path.join(dir, 'index.js');
    if (!fsSync.existsSync(indexJs)) {
        throw new Error(`lens dir ${dir} has no manifest.json or index.js`);
    }
    const url = 'file://' + indexJs + `?t=${Date.now()}`;
    const mod = await import(url);
    const card = mod?.card;
    if (!card?.manifest)
        throw new Error(`${indexJs} has no \`card.manifest\` export`);
    return card.manifest;
}
export async function installLensFromGit(git_url, version) {
    // 1. Resolve target dir. The lens id comes from manifest.type after clone.
    //    We clone into a temp dir first, read manifest, then rename to final id-named dir.
    await fs.mkdir(USER_LENSES_DIR, { recursive: true });
    const tmpDir = await fs.mkdtemp(path.join(USER_LENSES_DIR, '.install-'));
    try {
        // 2. Clone shallow.
        await runGit(['clone', '--depth=1', git_url, tmpDir]);
        if (version) {
            // Best-effort checkout of a tag/ref. Shallow clones may need --depth bump.
            try {
                await runGit(['fetch', '--depth=1', 'origin', version], tmpDir);
            }
            catch { }
            try {
                await runGit(['checkout', version], tmpDir);
            }
            catch { }
        }
        // 3. Read manifest.
        const manifest = await readManifestFromDir(tmpDir);
        const id = String(manifest.type || '').trim();
        if (!id || !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
            throw new Error(`manifest.type missing or invalid: ${JSON.stringify(manifest.type)}`);
        }
        // 4. Move to final location. If already exists, error — user must uninstall first.
        const finalDir = path.join(USER_LENSES_DIR, id);
        if (fsSync.existsSync(finalDir)) {
            throw new Error(`lens '${id}' already installed at ${finalDir}; uninstall first`);
        }
        await fs.rename(tmpDir, finalDir);
        const modulePath = path.join(finalDir, 'index.js');
        if (!fsSync.existsSync(modulePath)) {
            // try index.ts (vitest source-mode); won't run in production but tolerate
            const tsAlt = path.join(finalDir, 'index.ts');
            if (!fsSync.existsSync(tsAlt)) {
                await fs.rm(finalDir, { recursive: true, force: true });
                throw new Error(`lens '${id}' has no index.js at ${modulePath}`);
            }
        }
        // 5. Insert metadata row BEFORE reload so the registry's drift check has
        //    a frozen manifest to compare against.
        metadata.upsertOnInstall({
            id,
            version: String(manifest.version ?? 1),
            source: 'git',
            source_url: git_url,
            manifest_json: JSON.stringify(manifest),
            installed_at: Date.now(),
            enabled: 1,
            module_path: modulePath,
        });
        // 6. Hot reload. If reload fails to register the lens (drift, bad code, etc),
        //    roll back the DB row + fs so we don't leave a half-install.
        await reloadRegistry();
        const reg = getRegistry();
        if (!reg.has(id)) {
            // load failed — registry has health_status set to load_failed already
            const err = new Error(`lens '${id}' did not register after reload — check load errors`);
            try {
                metadata.remove(id);
            }
            catch { }
            try {
                await fs.rm(finalDir, { recursive: true, force: true });
            }
            catch { }
            throw err;
        }
        return {
            id,
            version: String(manifest.version ?? 1),
            module_path: modulePath,
            manifest,
        };
    }
    catch (err) {
        // Clean tmp dir if anything went wrong before rename.
        try {
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
        catch { }
        throw err;
    }
}
export async function uninstallLens(id, modulePath) {
    const db = getGatewayDb();
    // 1. Purge cache for this lens type.
    const cacheRes = db.prepare(`DELETE FROM lens_cache WHERE type = ?`).run(id);
    const cacheDeleted = Number(cacheRes.changes ?? 0);
    // 2. Revoke any active consents for this lens.
    const consentsRevoked = metadata.revokeConsent(id);
    // 3. Remove the metadata row.
    metadata.remove(id);
    // 4. Remove the on-disk module. modulePath is .../<id>/index.js — drop the parent dir.
    let fsRemoved = false;
    try {
        const dir = path.dirname(modulePath);
        // Sanity check: must be under USER_LENSES_DIR. Refuse anything else.
        const resolved = path.resolve(dir);
        if (!resolved.startsWith(path.resolve(USER_LENSES_DIR) + path.sep)) {
            throw new Error(`refusing to remove ${resolved} — outside user lenses dir`);
        }
        await fs.rm(resolved, { recursive: true, force: true });
        fsRemoved = true;
    }
    catch (e) {
        console.warn('[lenses] fs cleanup warning during uninstall:', e?.message || e);
    }
    // 5. Hot reload so the unregistered lens disappears from the registry.
    await reloadRegistry();
    return {
        id,
        cache_rows_deleted: cacheDeleted,
        consents_revoked: consentsRevoked,
        fs_removed: fsRemoved,
    };
}
