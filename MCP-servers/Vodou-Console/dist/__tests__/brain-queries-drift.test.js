/**
 * PLAN-BRAIN-INTO-CONSOLE P0.2 — the Console's copy of the brain query layer
 * must not drift from the canonical one.
 *
 * `MCP-servers/brain/src/queries.ts` is the source of truth (the brain MCP
 * server and the standalone :8767 console both use it). The Console carries a
 * COPY at `src/brain/queries.ts` (house rule: servers stay standalone — copy,
 * don't link). The only allowed difference is the project-root derivation at
 * the top; everything from the `// ── Provenance` marker to EOF must be
 * byte-identical. Same for the vendored `db.ts`.
 *
 * If this fails: edit the brain copy, then `scripts/sync-brain-queries.sh`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_ROOT = path.resolve(HERE, '../..');
const BRAIN_ROOT = path.resolve(CONSOLE_ROOT, '../brain');
const MARKER = '// ── Provenance / trust';
function tail(file) {
    const s = readFileSync(file, 'utf8');
    const i = s.indexOf(MARKER);
    if (i < 0)
        throw new Error(`${file}: marker "${MARKER}" not found`);
    return s.slice(i);
}
describe('brain query layer: Console copy tracks brain/src/queries.ts', () => {
    it('queries.ts is identical from the Provenance marker to EOF', () => {
        const canonical = tail(path.join(BRAIN_ROOT, 'src', 'queries.ts'));
        const copy = tail(path.join(CONSOLE_ROOT, 'src', 'brain', 'queries.ts'));
        expect(copy).toBe(canonical);
    });
    it('the Console copy names its origin in the header', () => {
        const head = readFileSync(path.join(CONSOLE_ROOT, 'src', 'brain', 'queries.ts'), 'utf8').slice(0, 400);
        expect(head).toContain('COPY of MCP-servers/brain/src/queries.ts');
    });
    it('db.ts adapter is identical', () => {
        const canonical = readFileSync(path.join(BRAIN_ROOT, 'src', 'db.ts'), 'utf8');
        const copy = readFileSync(path.join(CONSOLE_ROOT, 'src', 'brain', 'db.ts'), 'utf8');
        expect(copy).toBe(canonical);
    });
});
