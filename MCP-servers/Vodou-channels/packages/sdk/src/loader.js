import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { pathToFileURL } from 'url';
function getChannelsInstallDir() {
    const home = process.env.HOME || process.env.USERPROFILE || '~';
    return join(home, '.vodou', 'channels', 'node_modules');
}
export async function discoverChannels() {
    const loaded = [];
    const installDir = getChannelsInstallDir();
    let scopes;
    try {
        scopes = await readdir(installDir);
    }
    catch {
        return loaded;
    }
    for (const scope of scopes) {
        if (scope.startsWith('.'))
            continue;
        const scopeDir = join(installDir, scope);
        let pkgs;
        try {
            pkgs = await readdir(scopeDir);
        }
        catch {
            continue;
        }
        for (const pkg of pkgs) {
            if (!pkg.startsWith('channel-'))
                continue;
            const pkgDir = join(scopeDir, pkg);
            try {
                const pkgJson = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf-8'));
                const entryRel = pkgJson.main || 'dist/index.js';
                const entryUrl = pathToFileURL(join(pkgDir, entryRel)).href;
                const mod = await import(entryUrl);
                const ChannelClass = mod.default;
                if (!ChannelClass)
                    continue;
                const instance = new ChannelClass();
                if (typeof instance.manifest !== 'function')
                    continue;
                loaded.push({
                    manifest: instance.manifest(),
                    instance,
                    packageName: `${scope}/${pkg}`,
                });
            }
            catch (e) {
                console.error(`[channel-loader] Failed to load ${scope}/${pkg}:`, e);
            }
        }
    }
    return loaded;
}
//# sourceMappingURL=loader.js.map