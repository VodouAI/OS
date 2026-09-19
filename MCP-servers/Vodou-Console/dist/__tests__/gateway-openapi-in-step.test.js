/**
 * The API Explorer documents every route the gateway registers.
 *
 * Its spec was hand-written and nothing compared it with the code. Measured
 * 2026-09-15: 73 documented operations against 428 registered, and 9 of the 73
 * named a method or path no route served — the explorer's "Try it" sent people
 * to 404s. `docs.ts` pointed at a generator script that did not exist.
 *
 * This runs the generator's own drift check, so the test and the fix command
 * cannot disagree about what "documented" means. It fails in both directions:
 * a new route with no spec entry, and a spec entry whose route was removed or
 * renamed. It also fails when the dist/ copy (served first) lags src/.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as url from 'node:url';
const PKG = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
describe('gateway OpenAPI spec is in step with the routes', () => {
    it('every registered route is documented, and every documented route exists', () => {
        const r = spawnSync(process.execPath, [path.join(PKG, 'scripts', 'gen-gateway-openapi.mjs'), '--check'], {
            cwd: PKG,
            encoding: 'utf8',
        });
        expect(r.status, `${r.stderr}\n${r.stdout}`).toBe(0);
    });
});
