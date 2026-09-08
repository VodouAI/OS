/**
 * GW-9 — the child-process registry had ZERO production callers.
 *
 * It was written to end the 425-orphan incident, shaped deliberately after the
 * Rust `child_registry.rs` so the repo would hold one idea about child processes
 * rather than two — and then wired to nothing across 98 spawn sites. Measured
 * 2026-08-29 while the audit was running: two channels servers parentless for
 * fifteen hours.
 *
 * Its own test file covered the module in isolation, which is exactly how a
 * registry can be green and dead at the same time. What was missing is a check
 * that anything CALLS it. That is what this file is.
 *
 * `runCore` is the registration point: it is the shared `vodou-core` spawner, so
 * one call site covers every caller of it, and `vodou-core` processes are what
 * the incident was actually made of.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
const SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
function productionCallers(symbol) {
    const hits = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name !== '__tests__')
                    walk(p);
                continue;
            }
            if (!e.name.endsWith('.ts') || e.name === 'child-registry.ts')
                continue;
            const body = fs.readFileSync(p, 'utf8');
            // A call, not the import line and not a comment mentioning it.
            const called = body.split('\n').some((l) => {
                const t = l.trim();
                if (t.startsWith('//') || t.startsWith('*') || t.startsWith('import '))
                    return false;
                return new RegExp('(?<![\\w.])' + symbol + '\\(').test(l);
            });
            if (called)
                hits.push(path.relative(SRC, p));
        }
    };
    walk(SRC);
    return hits.sort();
}
describe('GW-9 — the child registry is actually wired', () => {
    it('registerChild has at least one production caller', () => {
        const callers = productionCallers('registerChild');
        expect(callers.length, 'the registry is dead again — no production code registers a child').toBeGreaterThan(0);
        // Named, so moving the registration is a deliberate edit to this test too.
        expect(callers).toContain(path.join('api', 'memory-capture.ts'));
    });
    it('the shared vodou-core spawner is the one that registers', () => {
        // Registering per-call-site would leave the other callers of runCore
        // untracked; registering INSIDE it is what makes one change cover them.
        const body = fs.readFileSync(path.join(SRC, 'api', 'memory-capture.ts'), 'utf8');
        const at = body.indexOf('export function runCore(');
        expect(at, 'runCore moved — re-point this check').toBeGreaterThan(-1);
        const fn = body.slice(at, at + 3000);
        expect(fn).toMatch(/registerChild\(execFile\(/);
    });
    it('activeChildren is exposed, so "what are we running" is answerable', () => {
        // The third verb. A registry nothing can read is a registry nobody trusts.
        const callers = productionCallers('activeChildren');
        expect(callers.length, 'activeChildren has no reader — the question is still unanswerable').toBeGreaterThan(0);
    });
});
