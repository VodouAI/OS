/**
 * Lens scaffold — generate a starter lens module from a URL hint.
 *
 * PLAN-LENSES-MANAGEMENT §4 + Phase 5 — CLI-only stub generator. Given an
 * id like "recipe.foobar" and a sample URL, writes a minimum-viable lens
 * module to `~/.vodou/lenses/<id>/` with:
 *   - manifest.json — claims the URL host's pattern, declares Apache-2.0, etc.
 *   - index.js     — fetches the URL via cheerio, returns title-only stub
 *   - README.md    — instructions for the author
 *
 * The stub installs immediately (registry picks it up on reload) so authors
 * can iterate. Visual click-to-label scaffolding slips to 0.5.90.
 */
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import * as metadata from './metadata.js';
import { reloadRegistry } from './registry.js';
const USER_LENSES_DIR = process.env.VODOU_LENSES_DIR
    || path.join(homedir(), '.vodou', 'lenses');
function hostnameOf(url) {
    try {
        return new URL(url).hostname;
    }
    catch {
        return 'example.com';
    }
}
export async function scaffoldLensStub(id, url) {
    await fs.mkdir(USER_LENSES_DIR, { recursive: true });
    const dir = path.join(USER_LENSES_DIR, id);
    if (fsSync.existsSync(dir)) {
        throw new Error(`scaffold target ${dir} already exists`);
    }
    await fs.mkdir(dir, { recursive: true });
    const host = hostnameOf(url);
    const pattern = `${host.replace(/^www\./, '*.')}/**`;
    const manifest = {
        type: id,
        version: 1,
        motive: `TODO: one-sentence description of what ${id} extracts from ${host}.`,
        url_patterns: [pattern, host + '/**'],
        ttl_seconds: 3600,
        requires: {
            network_domains: [host.replace(/^www\./, '')],
            runs_js: false,
            paths: ['cheerio'],
            cookie_scope: 'ephemeral',
        },
        icon: '🔍',
        category: 'misc',
        author: '@you',
        license: 'Apache-2.0',
        extracts: ['title'],
    };
    const manifestPath = path.join(dir, 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    const indexJs = `// ${id} — scaffolded stub. Author: replace this with real extraction logic.
//
// The fetch() function receives a URL + FetchCtx and returns a render-model
// object. Whatever you return must include every field declared in
// manifest.extracts (currently just \`title\`).

export const card = {
  manifest: ${JSON.stringify(manifest, null, 2).replace(/\n/g, '\n  ')},
  validate(model) {
    return typeof model?.title === 'string' && model.title.length > 0;
  },
  async fetch(url, ctx) {
    const { body } = await ctx.fetchStatic(url);
    const $ = ctx.cheerio(body);
    return {
      title: $('h1').first().text().trim() || $('title').text().trim() || '(no title)',
      // TODO: extract more fields. Update manifest.extracts to match.
    };
  },
};
`;
    const indexPath = path.join(dir, 'index.js');
    await fs.writeFile(indexPath, indexJs, 'utf8');
    const readme = `# ${id}

Scaffolded by \`vodou-core lenses scaffold ${id} ${url}\`.

## Next steps

1. Open \`index.js\` and replace the \`fetch\` function with real extraction.
2. Add fields to \`manifest.extracts\` for every field you return.
3. Test with the gateway: open http://localhost:8765, paste a URL matching
   \`${pattern}\`, and the lens should render.
4. When it's solid, publish to a public GitHub repo and submit a PR to
   [github.com/VodouAI/lenses-directory](https://github.com/VodouAI/lenses-directory).

## License

Apache-2.0 (default for lenses; change in \`manifest.json\` if you mean something else).
`;
    const readmePath = path.join(dir, 'README.md');
    await fs.writeFile(readmePath, readme, 'utf8');
    // Register as a local install so it shows up in the sidebar immediately.
    metadata.upsertOnInstall({
        id,
        version: '1',
        source: 'local',
        source_url: null,
        manifest_json: JSON.stringify(manifest),
        installed_at: Date.now(),
        enabled: 1,
        module_path: indexPath,
    });
    await reloadRegistry();
    return { id, dir, files: [manifestPath, indexPath, readmePath] };
}
