/**
 * THE GATE: a suite that reads vodou-core.db must say so through `_live.ts`.
 *
 * This branch has now shipped the same CI failure three times:
 *
 *   5d8120ea  two suites required runtime databases that CI cannot have
 *   8a6f8796  four suites needed a Rust binary the gateway job cannot have
 *   7a36769a  the SEAM suites queried `skills_registry` — 9 failures in 46s
 *
 * Every one was fixed where it was found. None of them left anything behind that
 * could catch the next author, so the next author wrote a fresh private guard
 * and CI went red again. That is the whole failure mode: a rule that lives only
 * in the memory of whoever last hit it.
 *
 * ## The rule
 *
 * `getDb()` is vodou-core.db. Its schema is owned by the Rust engine, the file
 * is matched by `.gitignore:46 *.db`, and it is therefore ABSENT from every
 * fresh checkout — CI, a new clone, a colleague's laptop. A test may absolutely
 * read it. What a test may not do is assume it is there.
 *
 * So: touch `getDb()` in a test, import `./_live.js`. The helper is how you say
 * "this needs live data" in a way that skips loudly instead of throwing
 * `no such table` sixty seconds into a CI run.
 *
 * `getGatewayDb()` is deliberately NOT gated. `initGatewaySchema()` creates its
 * tables on open, and dozens of suites legitimately point `GATEWAY_DB_PATH` at
 * their own temp file. Gating it would be noise, and a gate that cries wolf gets
 * an allowlist, and an allowlist is how a gate dies.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
const HERE = __dirname;
const CONSOLE_ROOT = path.resolve(HERE, '../..');
/** Every test file in the two directories vitest is configured to include. */
function testFiles() {
    const out = [];
    for (const dir of [HERE, path.join(CONSOLE_ROOT, 'tests')]) {
        let entries;
        try {
            entries = readdirSync(dir);
        }
        catch {
            continue;
        }
        for (const e of entries) {
            if (e.endsWith('.test.ts'))
                out.push(path.join(dir, e));
        }
    }
    return out;
}
/** Comments describe the rule; they must not be able to trip it. */
function code(file) {
    return readFileSync(file, 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
}
describe('live-db gate — a suite that needs runtime state must declare it', () => {
    it('every test touching getDb() goes through _live.ts', () => {
        const offenders = testFiles()
            .filter((f) => path.basename(f) !== 'live-db-gate.test.ts')
            .filter((f) => {
            const src = code(f);
            return /\bgetDb\s*\(\s*\)/.test(src) && !/from\s+['"]\.\/_live\.js['"]/.test(src);
        })
            .map((f) => path.relative(CONSOLE_ROOT, f));
        expect(offenders, 'These suites read vodou-core.db, which no fresh checkout has. Import ' +
            '`hasLive`/`skipNote` from `./_live.js` and gate the describe/it — do not ' +
            'guard inside the test body, because `prepare()` throws before it runs:\n  ' +
            offenders.join('\n  ')).toEqual([]);
    });
    it('the helper itself is not collected as a suite', () => {
        // `_live.ts`, not `_live.test.ts` — vitest's include is `**/*.test.ts`, so a
        // helper full of exported functions and no tests would otherwise fail the
        // run with "No test suite found".
        expect(testFiles().some((f) => path.basename(f).startsWith('_live'))).toBe(false);
    });
});
