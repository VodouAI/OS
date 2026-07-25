/**
 * GET/PUT /api/appearance — shared theme + palette for Console ↔ Brain ↔ One.
 * Persists to .vodou/workspace/appearance.json (local-first sync).
 */
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { getProjectRoot } from '../db.js';
export const appearanceRouter = Router();
const PALETTES = new Set([
    'brand', 'ritual', 'ember', 'moss', 'ocean', 'crimson', 'violet', 'rose',
    'graphite', 'glacier', 'espresso', 'saffron', 'blush', 'lilac', 'mint',
    'powder', 'seafoam', 'peach', 'lime', 'cobalt', 'magenta', 'tangerine',
    'burgundy', 'olive',
]);
function appearancePath() {
    return path.join(getProjectRoot(), '.vodou', 'workspace', 'appearance.json');
}
function normalize(raw) {
    const o = (raw && typeof raw === 'object') ? raw : {};
    const theme = o.theme === 'light' ? 'light' : 'dark';
    const palette = typeof o.palette === 'string' && PALETTES.has(o.palette) ? o.palette : 'brand';
    return { theme, palette };
}
function readAppearance() {
    try {
        const raw = JSON.parse(fs.readFileSync(appearancePath(), 'utf8'));
        return normalize(raw);
    }
    catch {
        return { theme: 'dark', palette: 'brand' };
    }
}
function writeAppearance(next) {
    const dir = path.dirname(appearancePath());
    fs.mkdirSync(dir, { recursive: true });
    const payload = {
        theme: next.theme,
        palette: next.palette,
        updated_at: new Date().toISOString(),
    };
    fs.writeFileSync(appearancePath(), JSON.stringify(payload, null, 2) + '\n', 'utf8');
}
/** GET /api/appearance */
appearanceRouter.get('/', (_req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.json(readAppearance());
});
/** PUT /api/appearance — body: { theme?, palette? } */
appearanceRouter.put('/', (req, res) => {
    try {
        const cur = readAppearance();
        const next = normalize({
            theme: req.body?.theme ?? cur.theme,
            palette: req.body?.palette ?? cur.palette,
        });
        writeAppearance(next);
        res.json(next);
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
