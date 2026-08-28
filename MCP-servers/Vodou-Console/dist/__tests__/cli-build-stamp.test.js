/**
 * The CLI banner must report something that is TRUE when it is read.
 *
 * It used to say `build 2026-06-21h` — a literal typed once and shown to every
 * CLI user for the ten releases that followed (0.6.12 → 0.6.26). Nobody lied on
 * purpose; the string simply had no way to become wrong loudly. It is the same
 * defect the coherence guard already names for a displayed `*_count` that
 * nothing writes: it does not decay visibly, it just stops being true, and the
 * only person positioned to notice is the reader who least expects to check.
 *
 * Two things are pinned here:
 *   1. the shipped source contains no hardcoded date-shaped build literal, and
 *   2. the resolver actually prefers the install manifest, then Cargo.toml, then
 *      a real build date — and never invents a version.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLAIN_TS = path.resolve(HERE, '../cli/renderers/plain.ts');
describe('the CLI banner build stamp', () => {
    it('has no hardcoded date literal left in the renderer', () => {
        const src = readFileSync(PLAIN_TS, 'utf8');
        // The exact shape that rotted: a quoted YYYY-MM-DD, with or without a
        // trailing letter ('2026-06-21h'). Comments are stripped first so the
        // history above this test can quote it without tripping it.
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const frozen = code.match(/['"]\d{4}-\d{2}-\d{2}[a-z]?['"]/g) ?? [];
        expect(frozen, 'A date literal in the banner is a value nothing updates. Derive it from '
            + 'update-manifest.json / Cargo.toml / the dist mtime instead — see resolveCliBuild().').toEqual([]);
    });
    it('reports the real version, and says so as a version', async () => {
        // Running from the dev checkout: no update-manifest.json, so this exercises
        // the Cargo.toml tier against the version actually being built.
        const { CLI_BUILD } = await import('../cli/renderers/plain.js');
        const cargo = readFileSync(path.resolve(HERE, '../../../..', 'Cargo.toml'), 'utf8');
        const want = /^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
        expect(want, 'Cargo.toml must carry a version for this test to mean anything').toBeTruthy();
        expect(CLI_BUILD).toBe(`v${want}`);
    });
    it('never returns an empty or placeholder stamp', async () => {
        const { CLI_BUILD } = await import('../cli/renderers/plain.js');
        expect(CLI_BUILD.trim().length).toBeGreaterThan(1);
        expect(CLI_BUILD).not.toMatch(/undefined|null|0\.0\.0/);
    });
});
