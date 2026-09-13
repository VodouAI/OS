/**
 * Overriding VODOU_PROJECT_PATH in a suite must FAIL, not silently reach the
 * real database.
 *
 * `db.ts` trusts that variable only when the directory it names already holds a
 * `vodou-core.db`, and otherwise falls back to the derived repo root. For the
 * app that is right — a stale path from an iCloud "folder 2" copy must not send
 * it at a missing database. For a test it inverts: a suite points the variable
 * at an empty temp dir PRECISELY BECAUSE IT IS EMPTY, and the rule reads "empty"
 * as "invalid" and hands back production.
 *
 * On 2026-09-12 a suite did exactly that and its
 * `beforeEach(() => db.exec('DELETE FROM scheduled_tasks'))` wiped all 28 live
 * scheduled tasks. The redirect added to keep the test away from real data is
 * what put it on real data.
 *
 * Loaded in a child process: the resolution runs once at module load, so it
 * cannot be re-evaluated inside this one.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_ROOT = path.resolve(HERE, '../..');
const DIST_DB = path.join(CONSOLE_ROOT, 'dist/db.js');
const REAL_ROOT = path.resolve(CONSOLE_ROOT, '../..');
/** Import the built db.js in a fresh process with a chosen environment. */
function loadWith(env) {
    try {
        const out = execFileSync(process.execPath, ['-e', `import(${JSON.stringify(DIST_DB)}).then(() => console.log('LOADED'), e => { console.error(e.message); process.exit(3); })`], { env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { ok: out.includes('LOADED'), stderr: '' };
    }
    catch (e) {
        return { ok: false, stderr: String(e.stderr ?? e.message ?? '') };
    }
}
const haveRealDb = existsSync(path.join(REAL_ROOT, 'vodou-core.db'));
describe('VODOU_PROJECT_PATH pointing somewhere without a database', () => {
    it.skipIf(!haveRealDb)('under a test runner, REFUSES instead of falling back to the real db', () => {
        const empty = mkdtempSync(path.join(tmpdir(), 'vodou-noroot-'));
        const r = loadWith({ VODOU_PROJECT_PATH: empty, VITEST: '1' });
        expect(r.ok, 'loading should have thrown').toBe(false);
        expect(r.stderr).toContain('was IGNORED');
        expect(r.stderr).toContain('removes that isolation');
    });
    it('outside a test runner, falls back as before and says so out loud', () => {
        const empty = mkdtempSync(path.join(tmpdir(), 'vodou-noroot-'));
        const r = loadWith({ VODOU_PROJECT_PATH: empty, VITEST: undefined, NODE_ENV: 'production' });
        expect(r.ok, 'the app must still start — this is a warning, not a wall').toBe(true);
    });
    it('a shadow root WITH a database is trusted, which is what the harness builds', () => {
        const shadow = mkdtempSync(path.join(tmpdir(), 'vodou-shadow-'));
        writeFileSync(path.join(shadow, 'vodou-core.db'), '');
        const r = loadWith({ VODOU_PROJECT_PATH: shadow, VITEST: '1' });
        expect(r.ok, 'a cloned root must not trip the guard').toBe(true);
    });
    // Deliberately NOT a static "no suite may set VODOU_PROJECT_PATH" rule. Three
    // suites set it and never import `db.ts`, so they cannot trip the trap at all;
    // flagging them would make this a gate that cries wolf, and a gate that cries
    // wolf gets an allowlist. The runtime throw above fires at the exact moment the
    // override would have reached a real database, and it caught both genuine cases
    // (`console-two` and `onboarding-timezone`) the first time it ran.
});
