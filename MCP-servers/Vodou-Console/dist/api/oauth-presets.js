/**
 * OAuth/API-key preset catalog for the Apps hub.
 *
 * **This module is now a LOADER.** Preset definitions live as JSON
 * files in `../../presets/` — one file per provider. Community contributors
 * can add a new app via a GitHub PR against `VodouAI/Apps`
 * that touches only JSON files. No TypeScript edits, no gateway rebuild.
 *
 * Auth paths, evaluated in this order per preset:
 *   Path 0 — Local stdio MCP — no OAuth; gateway runs `vodou-core connect …` with command + args (e.g. npx)
 *   Path 1 — DCR (Dynamic Client Registration, RFC 7591) — zero config, handled by vodou-core
 *   Path 2 — API key / Personal Access Token — one paste from user
 *   Path 3 — Manual OAuth app — user creates OAuth app in provider console (legacy fallback)
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
/**
 * Minimal runtime validation — rejects obviously broken files. Full schema
 * validation lives in the CI workflow (`.github/workflows/validate.yml`) of
 * the `VodouAI/Apps` repo, which uses ajv. We don't ship ajv in the
 * gateway runtime because (a) PR CI already caught issues before bundling
 * and (b) runtime files are under our control via the release build.
 */
function isValidPreset(raw) {
    if (!raw || typeof raw !== 'object')
        return false;
    const p = raw;
    if (typeof p.id !== 'string' || !/^[a-z][a-z0-9-]{1,30}$/.test(p.id))
        return false;
    if (typeof p.name !== 'string' || typeof p.icon !== 'string')
        return false;
    if (typeof p.description !== 'string')
        return false;
    if (typeof p.mcpUrl !== 'string')
        return false;
    if (p.mcpTransport !== 'sse' && p.mcpTransport !== 'http' && p.mcpTransport !== 'stdio')
        return false;
    const cat = p.category;
    if (cat !== 'Design & Dev' && cat !== 'Productivity' && cat !== 'Finance & Infra' && cat !== 'Custom')
        return false;
    return true;
}
function loadPresets() {
    const dirname = path.dirname(fileURLToPath(import.meta.url));
    // dist/api/oauth-presets.js → presets dir is at ../../presets (gateway root)
    const presetsDir = path.resolve(dirname, '..', '..', 'presets');
    if (!fs.existsSync(presetsDir)) {
        console.error('[presets] Directory not found:', presetsDir);
        console.error('[presets] Release build should have cloned VodouAI/Apps here.');
        return {};
    }
    const presets = {};
    const files = fs.readdirSync(presetsDir)
        .filter((f) => f.endsWith('.json') && !f.startsWith('_'));
    for (const file of files) {
        try {
            const raw = JSON.parse(fs.readFileSync(path.join(presetsDir, file), 'utf8'));
            if (!isValidPreset(raw)) {
                console.error(`[presets] ${file} failed minimal validation — skipped`);
                continue;
            }
            if (presets[raw.id]) {
                console.error(`[presets] Duplicate id '${raw.id}' (first wins; ${file} skipped)`);
                continue;
            }
            // Expected filename = <id>.json — warn if mismatch (legal but confusing)
            const expected = `${raw.id}.json`;
            if (file !== expected) {
                console.error(`[presets] Filename mismatch: '${file}' should be '${expected}'`);
            }
            presets[raw.id] = raw;
        }
        catch (err) {
            console.error(`[presets] Failed to parse ${file}:`, err.message);
        }
    }
    console.error(`[presets] Loaded ${Object.keys(presets).length} presets from ${presetsDir}`);
    return presets;
}
export const PRESETS = loadPresets();
/** UI + API routing: which app auth flow applies */
export function presetAuthPath(p) {
    if (p.localStdio)
        return 'localStdio';
    if (p.userSuppliedUrl)
        return 'userUrl';
    if (p.dcrSupported)
        return 'dcr';
    if (p.apiKeyOnly)
        return 'apiKey';
    return 'manual';
}
/** Resolve an api-key value for a preset from env OR stored value. Env takes precedence. */
export function resolveApiKey(preset) {
    if (!preset.apiKeyEnv)
        return null;
    const v = process.env[preset.apiKeyEnv];
    return v && v.trim() ? v.trim() : null;
}
