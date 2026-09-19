/**
 * Docs API — markdown under docs/, OpenAPI spec, explorer manifest (derived from OpenAPI).
 */
import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '../db.js';
import { explorerManifestFromOpenApi } from './openapi-utils.js';
const router = Router();
function gatewayOpenApiCandidates(projectRoot) {
    // Released archives strip src/ — keep dist/api/gateway-openapi.json as the
    // canonical shipped location and fall back to src/api/... in dev where
    // src/ exists. Build script copies the file into dist/ during packaging.
    return [
        path.join(projectRoot, 'MCP-servers', 'Vodou-Console', 'dist', 'api', 'gateway-openapi.json'),
        path.join(projectRoot, 'MCP-servers', 'Vodou-Console', 'src', 'api', 'gateway-openapi.json'),
    ];
}
async function loadGatewayOpenApi(projectRoot) {
    let lastErr;
    for (const p of gatewayOpenApiCandidates(projectRoot)) {
        try {
            const raw = await fs.readFile(p, 'utf-8');
            return JSON.parse(raw);
        }
        catch (e) {
            lastErr = e;
        }
    }
    throw lastErr ?? new Error('gateway-openapi.json not found in dist/ or src/');
}
function getDocsRoot() {
    return path.join(getProjectRoot(), 'docs');
}
/** The one path outside `docs/` this router will serve: the operating manual at
 *  the install root (P3). A named exception, not a widened guard — every other
 *  path is still confined to `docs/`. */
const MANUAL_PATH = '::manual';
function manualFile() {
    return path.join(getProjectRoot(), 'AGENTS.md');
}
/** List all markdown files in docs/ recursively */
router.get('/files', async (_req, res) => {
    try {
        const docsRoot = getDocsRoot();
        const files = [];
        async function walk(dir, prefix) {
            let entries;
            try {
                entries = await fs.readdir(dir);
            }
            catch {
                return;
            }
            for (const entry of entries) {
                const full = path.join(dir, entry);
                let stat;
                try {
                    stat = await fs.stat(full);
                }
                catch {
                    continue;
                }
                if (stat.isDirectory()) {
                    await walk(full, prefix ? `${prefix}/${entry}` : entry);
                }
                else if (entry.endsWith('.md')) {
                    const rel = prefix ? `${prefix}/${entry}` : entry;
                    const category = prefix || 'root';
                    const name = entry.replace('.md', '').replace(/-/g, ' ').replace(/_/g, ' ');
                    files.push({ path: rel, name, category });
                }
            }
        }
        await walk(docsRoot, '');
        // PLAN-MEMORY-PAGE-SAYS-WHAT-IT-IS P3 — the operating manual lives at the
        // install ROOT, not under docs/: it ships in the release archive and the
        // updater refreshes it. It used to appear on the Memory page's chip row
        // only because that row listed a directory, which invited people to edit a
        // manual as if it were their memory. Here is where a manual belongs.
        try {
            const manual = path.join(getProjectRoot(), 'AGENTS.md');
            await fs.stat(manual);
            files.unshift({ path: MANUAL_PATH, name: 'Operating manual (AGENTS.md)', category: 'root' });
        }
        catch { /* no manual installed — say nothing rather than link a 404 */ }
        res.json({ files });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
/** Get content of a specific markdown file */
router.get('/file', async (req, res) => {
    try {
        const filePath = req.query.path;
        if (!filePath)
            return res.status(400).json({ error: 'path required' });
        if (filePath === MANUAL_PATH) {
            const content = await fs.readFile(manualFile(), 'utf-8');
            res.json({ content, path: filePath });
            return;
        }
        // Security: only allow paths within docs/
        const docsRoot = getDocsRoot();
        const resolved = path.resolve(docsRoot, filePath);
        if (!resolved.startsWith(docsRoot)) {
            return res.status(403).json({ error: 'forbidden' });
        }
        const content = await fs.readFile(resolved, 'utf-8');
        res.json({ content, path: filePath });
    }
    catch (err) {
        res.status(404).json({ error: 'file not found' });
    }
});
/** OpenAPI 3 — canonical spec, generated from the route registrations: `npm run gen:gateway-openapi` after adding or moving a route. */
router.get('/openapi.json', async (_req, res) => {
    try {
        const spec = await loadGatewayOpenApi(getProjectRoot());
        res.type('application/json').json(spec);
    }
    catch {
        res.status(404).json({ error: 'openapi spec not found — run npm run gen:gateway-openapi in Vodou-Console' });
    }
});
/** Legacy explorer shape — derived from OpenAPI for dashboard Try-It UI */
router.get('/manifest', async (_req, res) => {
    try {
        const spec = await loadGatewayOpenApi(getProjectRoot());
        res.json(explorerManifestFromOpenApi(spec));
    }
    catch {
        res.status(404).json({ error: 'openapi spec not found' });
    }
});
export { router as docsRouter };
